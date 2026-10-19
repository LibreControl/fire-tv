import { FireTvError, jsonObject, request } from "./transport/http.js";
import { VoiceClient } from "./voice/VoiceClient.js";
import type {
  FireTvDeviceConfig,
  FireTvHeldKeyName,
  FireTvKeyboardState,
  FireTvKeyName,
  FireTvPairingResult,
  FireTvPairingSession,
  FireTvProperties,
  FireTvStatus,
} from "./types.js";

const heldActions: Record<FireTvHeldKeyName, string> = {
  up: "dpad_up",
  down: "dpad_down",
  left: "dpad_left",
  right: "dpad_right",
  select: "select",
};

function isHeld(key: string): key is FireTvHeldKeyName {
  return Object.hasOwn(heldActions, key);
}

function tokenValid(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && /^[\x20-\x7e]+$/.test(token);
}

function statusFrom(value: Record<string, unknown>): FireTvStatus {
  if (
    typeof value.osVersion !== "string" ||
    typeof value.platformType !== "string" ||
    typeof value.turnstileVersion !== "string"
  ) {
    throw new FireTvError("Invalid Fire TV status response", "protocol");
  }
  return {
    osVersion: value.osVersion,
    platformType: value.platformType,
    turnstileVersion: value.turnstileVersion,
  };
}

function keyboardFrom(value: Record<string, unknown>): FireTvKeyboardState {
  if (
    typeof value.state !== "string" ||
    (value.mode !== null && typeof value.mode !== "string") ||
    (value.text !== null && typeof value.text !== "string")
  ) {
    throw new FireTvError("Invalid Fire TV keyboard response", "protocol");
  }
  return { state: value.state, mode: value.mode, text: value.text };
}

/** Native remote protocol client. Commands are never retried automatically. */
export class FireTvDevice {
  readonly host: string;
  readonly id: string;
  readonly name: string;
  private readonly config: FireTvDeviceConfig;
  private clientToken?: string;
  private connected = false;
  private generation = 0;
  private controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private readonly sessions = new Set<FireTvPairingSession>();
  private held?: FireTvHeldKeyName;
  private readonly voice: VoiceClient;

  constructor(config: FireTvDeviceConfig) {
    if (
      typeof config.host !== "string" ||
      !config.host ||
      /[\s/\\?#@]/.test(config.host) ||
      (config.protocol !== undefined && config.protocol !== "http" && config.protocol !== "https")
    ) {
      throw new FireTvError("Invalid Fire TV host or protocol", "state");
    }
    for (const port of [config.port, config.dialPort, config.voicePort]) {
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new FireTvError("Invalid Fire TV port", "state");
      }
    }
    if (
      config.timeoutMs !== undefined &&
      (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2147483647)
    ) {
      throw new FireTvError("Invalid Fire TV timeout", "state");
    }
    if (config.clientToken !== undefined && !tokenValid(config.clientToken)) {
      throw new FireTvError("Invalid Fire TV credential", "state");
    }
    this.config = { ...config };
    this.host = config.host.replace(/^\[|\]$/g, "");
    this.id = config.id ?? `${this.host}:${config.port ?? 8080}`;
    this.name = config.name ?? this.host;
    this.clientToken = config.clientToken;
    this.voice = new VoiceClient({
      host: this.host,
      port: config.voicePort ?? 9090,
      rejectUnauthorized: config.rejectUnauthorized ?? false,
      timeoutMs: config.timeoutMs ?? 5000,
      command: (action, signal, token, generation) =>
        this.remote(
          `/v1/FireTV/voiceCommand?action=${action}`,
          "POST",
          undefined,
          signal,
          true,
          token,
          generation,
        ),
    });
  }

  private invalidate(cancelVoice = true): void {
    this.connected = false;
    if (cancelVoice) void this.voice.cancel().catch(() => undefined);
    this.held = undefined;
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    // New lifecycle operations do not wait for the old queue to settle.
    this.queue = Promise.resolve();
  }

  private async remote(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    signal = this.controller.signal,
    authenticated = true,
    token = this.clientToken,
    generation = this.generation,
  ): Promise<string> {
    try {
      return await request({
        host: this.host,
        port: this.config.port ?? 8080,
        protocol: this.config.protocol ?? "https",
        rejectUnauthorized: this.config.rejectUnauthorized ?? false,
        timeoutMs: this.config.timeoutMs ?? 5000,
        path,
        method,
        body,
        signal,
        clientToken: authenticated ? token : undefined,
      });
    } catch (error) {
      if (
        authenticated &&
        token !== undefined &&
        token === this.clientToken &&
        generation === this.generation &&
        error instanceof FireTvError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        this.clientToken = undefined;
        this.invalidate();
      }
      throw error;
    }
  }

  private enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    requireConnected = true,
  ): Promise<T> {
    if (requireConnected && !this.connected) {
      return Promise.reject(new FireTvError("Fire TV is not connected", "state"));
    }
    const generation = this.generation;
    const signal = this.controller.signal;
    const result = this.queue.then(async () => {
      if (generation !== this.generation || signal.aborted) {
        throw new FireTvError("Fire TV operation cancelled", "cancelled");
      }
      if (requireConnected && !this.connected) {
        throw new FireTvError("Fire TV is not connected", "state");
      }
      return operation(signal);
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  connect(): Promise<void> {
    return this.enqueue(async (signal) => {
      if (!this.clientToken) throw new FireTvError("Fire TV pairing is required", "state");
      statusFrom(jsonObject(await this.remote("/v1/FireTV/status", "GET", undefined, signal)));
      if (signal.aborted) throw new FireTvError("Fire TV operation cancelled", "cancelled");
      this.connected = true;
    }, false);
  }

  async disconnect(): Promise<void> {
    const voiceCleanup = this.voice.cancel();
    this.invalidate();
    await Promise.all([
      voiceCleanup.catch(() => undefined),
      ...[...this.sessions].map((session) => session.close()),
    ]);
  }

  /** Start authenticated recording and establish the owned WSS audio transport. */
  voiceStart(): Promise<void> {
    if (!this.connected || !this.clientToken) {
      return Promise.reject(new FireTvError("Fire TV is not connected", "state"));
    }
    const token = this.clientToken;
    const generation = this.generation;
    return this.voice.start(token, generation).catch((error: unknown) => {
      // HTTP bookends invalidate in remote(); WSS denial belongs to this captured lifecycle too.
      if (
        token === this.clientToken &&
        generation === this.generation &&
        error instanceof FireTvError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        this.clientToken = undefined;
        // start() has already attempted cleanup; don't automatically retry an uncertain stop.
        this.invalidate(false);
      }
      throw error;
    });
  }

  /** Stream raw mono 16000 Hz signed 16-bit little-endian PCM at real time. */
  voiceStreamPcm(samples: Uint8Array): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new FireTvError("Fire TV is not connected", "state"));
    }
    return this.voice.stream(samples);
  }

  /** Interrupt streaming, close WSS, then stop authenticated recording. */
  voiceStop(): Promise<void> {
    return this.voice.stop();
  }

  async startPairing(): Promise<FireTvPairingSession> {
    const previous = [...this.sessions];
    const controller = new AbortController();
    let closed = false;
    let submitted: Promise<void> = Promise.resolve();
    const session: FireTvPairingSession = {
      submitCode: (pin) => {
        if (closed)
          return Promise.reject(new FireTvError("Fire TV pairing session is closed", "state"));
        if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
          return Promise.reject(
            new FireTvError("Enter the four-digit PIN shown on the TV", "state"),
          );
        }
        const result = submitted.then(async (): Promise<FireTvPairingResult> => {
          if (closed) throw new FireTvError("Fire TV pairing session is closed", "state");
          const value = jsonObject(
            await this.remote("/v1/FireTV/pin/verify", "POST", { pin }, controller.signal, false),
          );
          if (closed) throw new FireTvError("Fire TV pairing cancelled", "cancelled");
          if (value.description === "") return { paired: false, status: "bad-pin" };
          if (!tokenValid(value.description)) {
            throw new FireTvError("Invalid Fire TV pairing response", "protocol");
          }
          this.invalidate();
          this.clientToken = value.description;
          return { paired: true, status: "ok", credentials: { clientToken: value.description } };
        });
        submitted = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      close: async () => {
        closed = true;
        controller.abort();
        this.sessions.delete(session);
        await submitted;
      },
    };
    this.sessions.add(session);
    try {
      await Promise.all(previous.map((old) => old.close()));
      if (closed) throw new FireTvError("Fire TV pairing cancelled", "cancelled");
      const value = jsonObject(
        await this.remote(
          "/v1/FireTV/pin/display",
          "POST",
          { friendlyName: this.name },
          controller.signal,
          false,
        ),
      );
      if (value.description !== "OK") {
        throw new FireTvError("Invalid Fire TV PIN display response", "protocol");
      }
      if (closed) throw new FireTvError("Fire TV pairing cancelled", "cancelled");
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  sendKey(key: FireTvKeyName): Promise<void> {
    if (!isHeld(key) && !["home", "back", "menu", "playPause", "powerToggle"].includes(key)) {
      return Promise.reject(new FireTvError("Unsupported Fire TV key", "state"));
    }
    return this.enqueue(async (signal) => {
      this.requireReleased();
      if (isHeld(key)) {
        const path = `/v1/FireTV?action=${heldActions[key]}`;
        await this.remote(path, "POST", { keyActionType: "keyDown" }, signal);
        if (signal.aborted) throw new FireTvError("Fire TV operation cancelled", "cancelled");
        this.held = key;
        await this.remote(path, "POST", { keyActionType: "keyUp" }, signal);
        if (!signal.aborted) this.held = undefined;
      } else {
        await this.remote(
          key === "playPause"
            ? "/v1/media?action=play"
            : `/v1/FireTV?action=${key === "powerToggle" ? "power" : key}`,
          "POST",
          undefined,
          signal,
        );
      }
    });
  }

  private heldKey(key: FireTvHeldKeyName, keyActionType: "keyDown" | "keyUp"): Promise<void> {
    if (!isHeld(key))
      return Promise.reject(new FireTvError("Unsupported Fire TV held key", "state"));
    return this.enqueue(async (signal) => {
      if (keyActionType === "keyDown") this.requireReleased();
      else if (this.held !== undefined && this.held !== key) {
        throw new FireTvError("Release the currently held Fire TV key first", "state");
      }
      await this.remote(`/v1/FireTV?action=${heldActions[key]}`, "POST", { keyActionType }, signal);
      if (!signal.aborted) this.held = keyActionType === "keyDown" ? key : undefined;
    });
  }

  sendKeyDown(key: FireTvHeldKeyName): Promise<void> {
    return this.heldKey(key, "keyDown");
  }

  sendKeyUp(key: FireTvHeldKeyName): Promise<void> {
    return this.heldKey(key, "keyUp");
  }

  private requireReleased(): void {
    if (this.held !== undefined) {
      throw new FireTvError("Release the currently held Fire TV key first", "state");
    }
  }

  inputText(text: string): Promise<void> {
    if (typeof text !== "string")
      return Promise.reject(new FireTvError("Invalid Fire TV text", "state"));
    return this.enqueue(async (signal) => {
      this.requireReleased();
      const keyboard = keyboardFrom(
        jsonObject(await this.remote("/v1/FireTV/keyboard", "GET", undefined, signal)),
      );
      if (!["visible", "active", "shown", "text"].includes(keyboard.state.toLowerCase())) {
        throw new FireTvError("Fire TV keyboard is not active", "state");
      }
      await this.remote("/v1/FireTV/keyboard", "POST", { text }, signal);
    });
  }

  getStatus(): Promise<FireTvStatus> {
    return this.enqueue(async (signal) =>
      statusFrom(jsonObject(await this.remote("/v1/FireTV/status", "GET", undefined, signal))),
    );
  }

  getProperties(): Promise<FireTvProperties> {
    return this.enqueue(async (signal) => {
      const properties = jsonObject(
        await this.remote("/v1/FireTV/properties", "GET", undefined, signal),
      );
      for (const flag of ["volumeSupport", "powerSupport"]) {
        if (properties[flag] !== undefined && typeof properties[flag] !== "string") {
          throw new FireTvError("Invalid Fire TV properties response", "protocol");
        }
      }
      return properties;
    });
  }

  getKeyboardState(): Promise<FireTvKeyboardState> {
    return this.enqueue(async (signal) =>
      keyboardFrom(jsonObject(await this.remote("/v1/FireTV/keyboard", "GET", undefined, signal))),
    );
  }

  scan(direction: "forward" | "backward", durationInSeconds: number): Promise<void> {
    if (
      (direction !== "forward" && direction !== "backward") ||
      !Number.isFinite(durationInSeconds) ||
      durationInSeconds <= 0
    )
      return Promise.reject(new FireTvError("Invalid Fire TV scan parameters", "state"));
    return this.enqueue(async (signal) => {
      await this.remote(
        "/v1/media?action=scan",
        "POST",
        {
          direction,
          durationInSeconds: String(durationInSeconds),
          speed: "1",
        },
        signal,
      );
    });
  }

  launchRemote(): Promise<void> {
    return this.enqueue(async (signal) => {
      await request({
        host: this.host,
        port: this.config.dialPort ?? 8009,
        protocol: "http",
        path: "/apps/FireTVRemote",
        method: "POST",
        timeoutMs: this.config.timeoutMs ?? 5000,
        signal,
        dial: true,
      });
    }, false);
  }
}

export function createFireTv(config: FireTvDeviceConfig): FireTvDevice {
  return new FireTvDevice(config);
}
