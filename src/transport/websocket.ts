import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import type { Duplex } from "node:stream";
import { FireTvError } from "./http.js";

interface VoiceSocketOptions {
  host: string;
  port: number;
  clientToken: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  signal: AbortSignal;
}

const failure = (code: "network" | "protocol" | "cancelled" | "timeout") =>
  new FireTvError(`Fire TV voice transport ${code}`, code);
const LIMIT = 64 * 1024;

/** Narrow RFC6455 client: TLS, masked writes, bounded inbound metadata/control frames. */
export class VoiceSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private fragmented = false;
  private messageBytes = 0;
  private ended = false;
  private closing = false;
  private error?: FireTvError;
  private readonly pending = new Set<(error: FireTvError) => void>();
  private pongWriting = false;
  private pendingPong?: Buffer;
  private closeResolve?: () => void;
  private closeReject?: (error: FireTvError) => void;
  private closeTimer?: NodeJS.Timeout;
  private closePromise?: Promise<void>;
  onFailure?: (error: FireTvError) => void;

  private constructor(
    private readonly socket: Duplex,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }

  static open(options: VoiceSocketOptions): Promise<VoiceSocket> {
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(failure("cancelled"));
        return;
      }
      const key = randomBytes(16).toString("base64");
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      let settled = false;
      const req = https.request({
        hostname: options.host,
        port: options.port,
        path: "/",
        method: "GET",
        agent: false,
        rejectUnauthorized: options.rejectUnauthorized,
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": key,
          "x-api-key": "0987654321",
          "x-client-token": options.clientToken,
        },
      });
      const finish = (error?: FireTvError, socket?: VoiceSocket): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        if (error) {
          req.destroy();
          reject(error);
        } else resolve(socket!);
      };
      const abort = (): void => finish(failure("cancelled"));
      const timer = setTimeout(() => finish(failure("timeout")), options.timeoutMs);
      options.signal.addEventListener("abort", abort, { once: true });
      req.on("error", () => finish(failure("network")));
      req.on("response", (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        finish(new FireTvError(`Fire TV voice upgrade rejected (${status})`, "http", status));
      });
      req.on("upgrade", (response, socket, head) => {
        if (settled) {
          socket.destroy();
          return;
        }
        if (
          response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== "websocket" ||
          !response.headers.connection
            ?.toLowerCase()
            .split(/\s*,\s*/)
            .includes("upgrade") ||
          response.headers["sec-websocket-accept"] !== accept ||
          response.headers["sec-websocket-extensions"] !== undefined ||
          response.headers["sec-websocket-protocol"] !== undefined
        ) {
          socket.destroy();
          finish(failure("protocol"));
          return;
        }
        const client = new VoiceSocket(socket, options.timeoutMs);
        if (head.length) client.onData(head);
        if (client.error) {
          finish(client.error);
          return;
        }
        finish(undefined, client);
      });
      req.end();
    });
  }

  private readonly onError = (): void => this.terminate(failure("network"));
  private readonly onEnd = (): void => {
    if (!this.ended) this.terminate(failure("network"));
  };

  private terminate(error?: FireTvError): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error ?? failure("network");
    this.pendingPong = undefined;
    clearTimeout(this.closeTimer);
    for (const fail of this.pending) fail(this.error);
    this.pending.clear();
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("end", this.onEnd);
    this.socket.removeListener("close", this.onEnd);
    // Destroy without an error argument: no unhandled late socket error event.
    this.socket.destroy();
    this.buffer = Buffer.alloc(0);
    if (error) this.closeReject?.(error);
    else this.closeResolve?.();
    if (error) this.onFailure?.(error);
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.ended) return;
    if (this.buffer.length + chunk.length > LIMIT + 14) {
      this.terminate(failure("protocol"));
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const opcode = first & 15;
      const fin = (first & 128) !== 0;
      let length = second & 127;
      let offset = 2;
      if ((first & 112) !== 0 || (second & 128) !== 0 || ![0, 1, 2, 8, 9, 10].includes(opcode)) {
        this.terminate(failure("protocol"));
        return;
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
        if (length < 126) {
          this.terminate(failure("protocol"));
          return;
        }
      } else if (length === 127) {
        // No useful voice metadata should require a 64-bit frame length.
        this.terminate(failure("protocol"));
        return;
      }
      if (length > LIMIT || (opcode >= 8 && (!fin || length > 125))) {
        this.terminate(failure("protocol"));
        return;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 8) {
        if (length === 1) {
          this.terminate(failure("protocol"));
          return;
        }
        if (length >= 2) {
          const code = payload.readUInt16BE(0);
          if (
            code < 1000 ||
            code >= 5000 ||
            [1004, 1005, 1006, 1015].includes(code) ||
            (code >= 1016 && code < 3000)
          ) {
            this.terminate(failure("protocol"));
            return;
          }
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
          } catch {
            this.terminate(failure("protocol"));
            return;
          }
        }
        if (!this.closing) {
          this.closing = true;
          this.pendingPong = undefined;
          // Acknowledge the peer's close, but an unsolicited close is still failed delivery.
          void this.writeFrame(8, payload).then(
            () => this.terminate(failure("network")),
            () => this.terminate(failure("network")),
          );
          return;
        }
        this.terminate();
        return;
      }
      if (opcode === 9) {
        this.queuePong(payload);
      } else if (opcode < 8) {
        if ((opcode === 0) !== this.fragmented) {
          this.terminate(failure("protocol"));
          return;
        }
        this.messageBytes += length;
        if (this.messageBytes > LIMIT) {
          this.terminate(failure("protocol"));
          return;
        }
        this.fragmented = !fin;
        if (fin) this.messageBytes = 0;
      }
    }
  };

  private queuePong(payload: Buffer): void {
    if (this.ended || this.closing) return;
    // RFC6455 permits replying only to the latest unacknowledged ping.
    // Copy at most 125 bytes rather than retaining an entire inbound buffer.
    this.pendingPong = Buffer.from(payload);
    if (this.pongWriting) return;
    this.pongWriting = true;
    void this.flushPongs();
  }

  private async flushPongs(): Promise<void> {
    try {
      while (!this.ended && !this.closing && this.pendingPong !== undefined) {
        const payload = this.pendingPong;
        this.pendingPong = undefined;
        await this.writeFrame(10, payload);
      }
    } catch (error) {
      this.terminate(error as FireTvError);
    } finally {
      this.pendingPong = undefined;
      this.pongWriting = false;
    }
  }

  private writeFrame(opcode: number, payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.ended) return Promise.reject(this.error ?? failure("network"));
    if (signal?.aborted) return Promise.reject(failure("cancelled"));
    if (payload.length > LIMIT || this.pending.size >= 16) {
      const error = failure("protocol");
      this.terminate(error);
      return Promise.reject(error);
    }
    const offset = payload.length < 126 ? 6 : 8;
    const frame = Buffer.allocUnsafe(offset + payload.length);
    frame[0] = 128 | opcode;
    frame[1] = 128 | (payload.length < 126 ? payload.length : 126);
    if (offset === 8) frame.writeUInt16BE(payload.length, 2);
    randomBytes(4).copy(frame, offset - 4);
    for (let i = 0; i < payload.length; i++)
      frame[offset + i] = payload[i]! ^ frame[offset - 4 + (i % 4)]!;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: FireTvError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(fail);
        if (error) reject(error);
        else resolve();
      };
      const fail = (error: FireTvError): void => finish(error);
      const abort = (): void => finish(failure("cancelled"));
      const timer = setTimeout(() => {
        finish(failure("timeout"));
        this.terminate(failure("timeout"));
      }, this.timeoutMs);
      this.pending.add(fail);
      signal?.addEventListener("abort", abort, { once: true });
      // Completion callback is the backpressure boundary; only one audio quantum is outstanding.
      try {
        this.socket.write(frame, (error) => {
          if (error) this.terminate(failure("network"));
          finish(error ? failure("network") : undefined);
        });
      } catch {
        this.terminate(failure("network"));
        finish(failure("network"));
      }
    });
  }

  writePcm(payload: Uint8Array, signal: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(failure("cancelled"));
    return this.writeFrame(2, payload, signal);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.ended) return Promise.resolve();
    this.closing = true;
    this.pendingPong = undefined;
    this.closePromise = new Promise((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
      this.closeTimer = setTimeout(() => this.terminate(failure("timeout")), this.timeoutMs);
      void this.writeFrame(8, Buffer.from([3, 232]))
        .then(() => {
          // Fire TV needs the recording's write-side EOF as well as the close
          // frame. Flush the frame first, then half-close TLS while continuing
          // to read the peer's acknowledgement under the existing deadline.
          if (!this.ended) this.socket.end();
        })
        .catch((error: unknown) =>
          this.terminate(error instanceof FireTvError ? error : failure("network")),
        );
    });
    return this.closePromise;
  }
}
