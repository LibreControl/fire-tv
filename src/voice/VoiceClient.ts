import { FireTvError } from "../transport/http.js";
import { VoiceSocket } from "../transport/websocket.js";

interface VoiceOptions {
  host: string;
  port: number;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  command: (
    action: "start" | "stop",
    signal: AbortSignal,
    token: string,
    generation: number,
  ) => Promise<unknown>;
}

interface Session {
  controller: AbortController;
  token: string;
  generation: number;
  failure?: FireTvError;
  socket?: VoiceSocket;
  ready: boolean;
  started: Promise<void>;
  streams: Promise<void>;
  cleanup?: Promise<void>;
}

const cancelled = () => new FireTvError("Fire TV voice operation cancelled", "cancelled");

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const finish = (error?: FireTvError): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => finish(cancelled());
    const timer = setTimeout(() => finish(), Math.max(0, ms));
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One explicitly owned recording session; cleanup is independent of the command queue. */
export class VoiceClient {
  private session?: Session;
  constructor(private readonly options: VoiceOptions) {}

  start(token: string, generation: number): Promise<void> {
    if (this.session)
      return Promise.reject(new FireTvError("Fire TV voice is already active", "state"));
    const session: Session = {
      controller: new AbortController(),
      token,
      generation,
      ready: false,
      started: Promise.resolve(),
      streams: Promise.resolve(),
    };
    this.session = session;
    session.started = this.open(session, token);
    return session.started.catch(async (error: unknown) => {
      try {
        await this.cleanup(session);
      } catch {
        /* Preserve the start failure. */
      }
      throw error;
    });
  }

  private async open(session: Session, token: string): Promise<void> {
    await this.options.command(
      "start",
      session.controller.signal,
      session.token,
      session.generation,
    );
    if (session.controller.signal.aborted) throw cancelled();
    const socket = await VoiceSocket.open({
      host: this.options.host,
      port: this.options.port,
      clientToken: token,
      rejectUnauthorized: this.options.rejectUnauthorized,
      timeoutMs: this.options.timeoutMs,
      signal: session.controller.signal,
    });
    session.socket = socket;
    socket.onFailure = (error) => {
      session.failure = error;
      void this.cleanup(session).catch(() => undefined);
    };
    if (session.controller.signal.aborted) throw cancelled();
    session.ready = true;
  }

  stream(samples: Uint8Array): Promise<void> {
    if (!(samples instanceof Uint8Array) || !samples.byteLength || samples.byteLength % 2 !== 0) {
      return Promise.reject(
        new FireTvError("Voice PCM must contain nonempty complete 16-bit samples", "state"),
      );
    }
    const session = this.session;
    if (!session?.ready || session.controller.signal.aborted) {
      return Promise.reject(new FireTvError("Fire TV voice is not ready", "state"));
    }
    const operation = session.streams.then(async () => {
      const signal = session.controller.signal;
      if (signal.aborted) throw cancelled();
      for (let offset = 0; offset < samples.byteLength; offset += 3200) {
        if (signal.aborted) throw cancelled();
        const end = Math.min(offset + 3200, samples.byteLength);
        await session.socket!.writePcm(samples.subarray(offset, end), signal);
        // Rebase after every completed write so stalls never cause catch-up bursts.
        // Include the final short quantum's duration; don't signal completion early.
        await delay((end - offset) / 32, signal);
      }
    });
    const result = operation.catch(async (error: unknown) => {
      try {
        await this.cleanup(session);
      } catch {
        /* Preserve the original sanitized failure. */
      }
      throw session.failure ?? error;
    });
    session.streams = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stop(): Promise<void> {
    if (!this.session)
      return Promise.reject(new FireTvError("Fire TV voice is not active", "state"));
    return this.cleanup(this.session);
  }

  cancel(): Promise<void> {
    return this.session ? this.cleanup(this.session) : Promise.resolve();
  }

  private cleanup(session: Session): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.ready = false;
    session.controller.abort();
    session.cleanup = (async () => {
      // A cancelled HTTP start must settle before stop is sent, even if its response was lost.
      try {
        await session.started;
      } catch {
        /* Recording may still have started remotely. */
      }
      // Initiate the close handshake before stop, but do not await its acknowledgement:
      // some receivers only acknowledge the WebSocket close after the HTTP stop.
      // Both operations must settle before releasing ownership or allowing a retry.
      const [closed, stopped] = await Promise.allSettled([
        session.socket?.close(),
        this.options.command(
          "stop",
          new AbortController().signal,
          session.token,
          session.generation,
        ),
      ]);
      if (stopped.status === "rejected") {
        const error: unknown = stopped.reason;
        if (
          error instanceof FireTvError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          // Revoked credentials cannot stop this recording; release the unusable local owner.
          if (this.session === session) this.session = undefined;
        } else {
          // Keep uncertain recording ownership for an explicit stop/disconnect, never an automatic retry.
          session.cleanup = undefined;
        }
        throw error;
      }
      if (this.session === session) this.session = undefined;
      if (closed.status === "rejected") throw closed.reason;
    })();
    return session.cleanup;
  }
}
