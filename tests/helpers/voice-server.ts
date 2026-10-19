import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { NativeServer } from "./native-server.js";

export interface VoiceFault {
  handshake?: "accept" | "upgrade" | "connection" | "reject" | "stall";
  rawFrame?: Buffer;
  closeAfterBytes?: number;
  pauseMs?: number;
  ignoreClose?: boolean;
  closeAfterStop?: boolean;
  closeAfterEof?: boolean;
  onFirstAudio?: () => void;
}
// Independent RFC6455 receiver: never imports the production client/codec.
interface VoiceSession {
  pcm: Buffer[];
  times: number[];
  closed: boolean;
  closeAcknowledged: boolean;
  receivedEof: boolean;
  pong: Buffer[];
  errors: string[];
  pause(): void;
  resume(): void;
  floodPings(count: number, finalPayload: Buffer): Promise<void>;
}
export async function startVoiceServer(remote: NativeServer) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const faults: VoiceFault[] = [];
  const sessions: VoiceSession[] = [];
  const violations: string[] = [];
  const server = createServer(
    {
      key: await readFile(new URL("../fixtures/localhost-key.pem", import.meta.url)),
      cert: await readFile(new URL("../fixtures/localhost-cert.pem", import.meta.url)),
    },
    (_req, res) => {
      res.writeHead(400);
      res.end();
    },
  );
  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }
  function frame(opcode: number, payload = Buffer.alloc(0)) {
    if (payload.length > 125) throw new Error("Fixture control payload too large");
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const fault = faults.shift() ?? {};
    // Only shutdown-dependency faults retain their response side after EOF.
    // Normal receivers must also finish connections aborted mid-frame, where
    // no complete WS close frame remains for the parser to acknowledge.
    socket.allowHalfOpen = !!(fault.closeAfterStop || fault.closeAfterEof || fault.ignoreClose);
    if (
      req.url !== "/" ||
      req.method !== "GET" ||
      req.httpVersion !== "1.1" ||
      req.headers["x-api-key"] !== "0987654321" ||
      req.headers["x-client-token"] !== remote.state.currentToken ||
      !remote.state.tokenValid ||
      !remote.state.paired ||
      !remote.state.recording ||
      req.headers["sec-websocket-version"] !== "13"
    ) {
      violations.push("Invalid authenticated recording upgrade");
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (fault.handshake === "stall") return;
    if (fault.handshake === "reject") {
      socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        `Upgrade: ${fault.handshake === "upgrade" ? "incorrect" : "websocket"}\r\n` +
        `Connection: ${fault.handshake === "connection" ? "keep-alive" : "Upgrade"}\r\n` +
        `Sec-WebSocket-Accept: ${fault.handshake === "accept" ? "incorrect" : accept}\r\n\r\n`,
    );
    remote.state.voiceTransitions.push("wss");
    const stopCount =
      remote.requests.filter((request) => request.path === "/v1/FireTV/voiceCommand?action=stop")
        .length + 1;
    const session: VoiceSession = {
      pcm: [],
      times: [],
      closed: false,
      closeAcknowledged: false,
      receivedEof: false,
      pong: [],
      errors: [],
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      async floodPings(count, finalPayload) {
        // Small independent wire batches stay below the client's inbound frame bound.
        // Await the server write callback so the fixture itself cannot build an unbounded queue.
        for (let base = 0; base < count; base += 32) {
          const frames: Buffer[] = [];
          for (let i = base; i < Math.min(base + 32, count); i++) {
            const payload = Buffer.alloc(125, 0x61);
            payload.writeUInt32BE(i);
            frames.push(frame(9, payload));
          }
          await new Promise<void>((resolve, reject) => {
            socket.write(Buffer.concat(frames), (error) => (error ? reject(error) : resolve()));
          });
        }
        await new Promise<void>((resolve, reject) => {
          socket.write(frame(9, finalPayload), (error) => (error ? reject(error) : resolve()));
        });
      },
    };
    sessions.push(session);
    let pending = Buffer.from(head);
    let bytes = 0;
    socket.on("end", () => {
      session.receivedEof = true;
    });
    socket.on("close", () => {
      session.closed = true;
    });
    function parse(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const first = pending[0]!;
        const second = pending[1]!;
        let size = second & 127;
        let offset = 2;
        if (size === 126) {
          if (pending.length < 4) return;
          size = pending.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) {
          if (pending.length < 10) return;
          const big = pending.readBigUInt64BE(2);
          if (big > 65536n) {
            session.errors.push("Oversize client frame");
            socket.destroy();
            return;
          }
          size = Number(big);
          offset = 10;
        }
        const opcode = first & 15;
        if (
          !(second & 128) ||
          first & 0x70 ||
          !(first & 128) ||
          size > 65536 ||
          (opcode >= 8 && size > 125)
        ) {
          session.errors.push("Malformed/unmasked client frame");
          socket.destroy();
          return;
        }
        if (pending.length < offset + 4 + size) return;
        const mask = pending.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.alloc(size);
        for (let i = 0; i < size; i++) payload[i] = pending[offset + i]! ^ mask[i % 4]!;
        pending = pending.subarray(offset + size);
        if (opcode === 2) {
          if (!remote.state.recording) session.errors.push("Audio outside recording");
          if (size === 0 || size % 2) session.errors.push("Invalid PCM frame length");
          session.pcm.push(payload);
          session.times.push(performance.now());
          bytes += size;
          if (session.pcm.length === 1) fault.onFirstAudio?.();
          if (fault.closeAfterBytes !== undefined && bytes >= fault.closeAfterBytes)
            socket.destroy();
        } else if (opcode === 8) {
          remote.state.voiceTransitions.push("close");
          session.closed = true;
          if (!fault.ignoreClose) {
            const acknowledge = () => {
              if (socket.destroyed) return;
              session.closeAcknowledged = true;
              socket.end(frame(8, payload));
            };
            const afterEof = () => {
              if (fault.closeAfterEof && !session.receivedEof) socket.once("end", acknowledge);
              else acknowledge();
            };
            if (fault.closeAfterStop) {
              // Model receivers whose WebSocket shutdown depends on the HTTP control
              // channel. Never acknowledge early merely because a timer elapsed.
              void remote
                .waitForRequest("/v1/FireTV/voiceCommand?action=stop", stopCount)
                .then(afterEof, () => {
                  session.errors.push("HTTP stop never arrived before close acknowledgement");
                  socket.destroy();
                });
            } else afterEof();
          }
        } else if (opcode === 9) socket.write(frame(10, payload));
        else if (opcode === 10) session.pong.push(payload);
        else {
          session.errors.push("Unexpected client opcode");
          socket.destroy();
        }
      }
    }
    socket.on("data", parse);
    if (head.length) {
      pending = Buffer.alloc(0);
      parse(head);
    }
    socket.write(frame(9, Buffer.from("alive")));
    if (fault.rawFrame) socket.write(fault.rawFrame);
    if (fault.pauseMs) {
      socket.pause();
      later(() => socket.resume(), fault.pauseMs);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    sessions,
    faults,
    violations,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
