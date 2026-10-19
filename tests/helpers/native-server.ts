import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

export interface Fault {
  path: string;
  method?: "GET" | "POST";
  status?: number;
  body?: string;
  delayMs?: number;
  waitFor?: Promise<void>;
}

// Independent, synthetic receiver. No production protocol tables or transports imported.
export async function startNativeServer(options: { tls?: boolean } = {}) {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/native-protocol.json", import.meta.url), "utf8"),
  ) as {
    pin: string;
    token: string;
    status: Record<string, string>;
    properties: Record<string, string>;
  };
  const events = new EventEmitter();
  const faults: Fault[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests: { method: string; path: string; body: string }[] = [];
  const state = {
    paired: false,
    pairingDisplayed: false,
    tokenValid: true,
    currentToken: fixture.token,
    nextPairingToken: fixture.token,
    authFailureStatus: 401 as 401 | 403,
    x: 0,
    y: 0,
    held: null as string | null,
    keyboardActive: false,
    text: "",
    selected: 0,
    screen: "home",
    menuOpen: false,
    playing: false,
    // Synthetic display power only; this does not certify a receiver's CEC behavior.
    displayPowered: true,
    position: 60,
    launches: 0,
    effects: [] as string[],
    recording: false,
    voiceTransitions: [] as string[],
  };
  function respond(res: ServerResponse, status: number, value?: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(value === undefined ? "" : JSON.stringify(value));
  }
  async function handle(req: IncomingMessage, res: ServerResponse, dial: boolean) {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    // Authenticate at arrival: a delayed response belongs to that request's
    // credentials even if pairing replaces the token before the response is sent.
    const authenticated =
      state.paired && state.tokenValid && req.headers["x-client-token"] === state.currentToken;
    const authFailureStatus = state.authFailureStatus;
    requests.push({ method: req.method ?? "", path: url.pathname + url.search, body: raw });
    events.emit("request");
    const faultIndex = faults.findIndex(
      (fault) =>
        fault.path === url.pathname + url.search &&
        (fault.method === undefined || fault.method === req.method),
    );
    if (faultIndex !== -1) {
      const fault = faults.splice(faultIndex, 1)[0]!;
      if (fault.waitFor) await fault.waitFor;
      if (fault.delayMs)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            resolve();
          }, fault.delayMs);
          timers.add(timer);
        });
      if (res.destroyed) return;
      if (fault.status !== undefined || fault.body !== undefined) {
        res.writeHead(fault.status ?? 200);
        res.end(fault.body ?? "");
        return;
      }
    }
    if (res.destroyed) return;
    if (dial) {
      if (
        req.method !== "POST" ||
        url.pathname !== "/apps/FireTVRemote" ||
        raw !== "" ||
        req.headers["content-type"] !== "text/plain"
      )
        return respond(res, 400);
      state.launches++;
      res.writeHead(201, { location: "/apps/FireTVRemote/run" });
      res.end();
      return;
    }
    if (
      req.headers["x-api-key"] !== "0987654321" ||
      req.headers["content-type"] !== "application/json; charset=utf-8"
    )
      return respond(res, 400);
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return respond(res, 400);
      }
    }
    if (url.pathname === "/v1/FireTV/pin/display" && req.method === "POST") {
      if (typeof body.friendlyName !== "string" || !body.friendlyName) return respond(res, 400);
      state.pairingDisplayed = true;
      return respond(res, 200, { description: "OK" });
    }
    if (url.pathname === "/v1/FireTV/pin/verify" && req.method === "POST") {
      if (!state.pairingDisplayed || typeof body.pin !== "string") return respond(res, 400);
      if (body.pin !== fixture.pin) return respond(res, 200, { description: "" });
      state.paired = true;
      state.tokenValid = true;
      state.currentToken = state.nextPairingToken;
      return respond(res, 200, { description: state.currentToken });
    }
    if (!authenticated) return respond(res, authFailureStatus);
    if (req.method === "GET") {
      if (url.pathname === "/v1/FireTV/status") return respond(res, 200, fixture.status);
      if (url.pathname === "/v1/FireTV/properties") return respond(res, 200, fixture.properties);
      if (url.pathname === "/v1/FireTV/keyboard")
        return respond(res, 200, {
          state: state.keyboardActive ? "text" : "hidden",
          mode: state.keyboardActive ? "keyboard" : null,
          text: state.keyboardActive ? state.text : null,
        });
      return respond(res, 404);
    }
    if (req.method !== "POST") return respond(res, 405);
    const action = url.searchParams.get("action");
    if (url.pathname === "/v1/FireTV/voiceCommand") {
      if (raw !== "") return respond(res, 400);
      if (action === "start" && !state.recording) {
        state.recording = true;
        state.voiceTransitions.push("start");
      } else if (action === "stop") {
        state.recording = false;
        state.voiceTransitions.push("stop");
      } else return respond(res, 409);
      return respond(res, 200);
    }
    if (url.pathname === "/v1/FireTV") {
      if (
        action === "dpad_up" ||
        action === "dpad_down" ||
        action === "dpad_left" ||
        action === "dpad_right" ||
        action === "select"
      ) {
        if (body.keyActionType === "keyDown" && state.held === null) {
          state.held = action;
          state.effects.push(`${action}:down`);
        } else if (body.keyActionType === "keyUp" && state.held === action) {
          state.held = null;
          state.effects.push(`${action}:up`);
          if (action === "dpad_up") state.y--;
          if (action === "dpad_down") state.y++;
          if (action === "dpad_left") state.x--;
          if (action === "dpad_right") state.x++;
          if (action === "select") {
            state.selected++;
            state.screen = "search";
            state.keyboardActive = true;
          }
        } else return respond(res, 400);
      } else if (raw === "" && action === "home") {
        state.screen = "home";
        state.keyboardActive = false;
        state.menuOpen = false;
      } else if (raw === "" && action === "back") {
        state.screen = "home";
        state.keyboardActive = false;
      } else if (raw === "" && action === "menu") state.menuOpen = !state.menuOpen;
      else if (raw === "" && action === "power") {
        state.displayPowered = !state.displayPowered;
        state.effects.push(`power:${state.displayPowered ? "on" : "off"}`);
      } else return respond(res, 400);
    } else if (url.pathname === "/v1/FireTV/keyboard") {
      if (!state.keyboardActive || typeof body.text !== "string") return respond(res, 400);
      // Fixture-owned insert-at-end model, not hardware-proven cursor/IME semantics.
      state.text += body.text;
      state.effects.push(`text:${body.text}`);
    } else if (url.pathname === "/v1/media" && action === "play" && raw === "")
      state.playing = !state.playing;
    else if (url.pathname === "/v1/media" && action === "scan") {
      if (
        (body.direction !== "forward" && body.direction !== "backward") ||
        typeof body.durationInSeconds !== "string" ||
        !Number.isFinite(Number(body.durationInSeconds)) ||
        Number(body.durationInSeconds) <= 0 ||
        body.speed !== "1"
      )
        return respond(res, 400);
      state.position += Number(body.durationInSeconds) * (body.direction === "forward" ? 1 : -1);
    } else return respond(res, 404);
    respond(res, 200);
  }
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, false).catch(() => res.destroy());
  };
  const remote = options.tls
    ? createHttpsServer(
        {
          key: await readFile(new URL("../fixtures/localhost-key.pem", import.meta.url)),
          cert: await readFile(new URL("../fixtures/localhost-cert.pem", import.meta.url)),
        },
        listener,
      )
    : createServer(listener);
  const dial = createServer((req, res) => {
    void handle(req, res, true).catch(() => res.destroy());
  });
  await Promise.all(
    [remote, dial].map(async (server) => {
      // Public ephemeral port numbers must not accidentally contain a test PIN
      // and produce false-positive credential-leak assertions.
      for (;;) {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = String((server.address() as AddressInfo).port);
        if (!port.includes(fixture.pin) && !port.includes("0000")) break;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }),
  );
  return {
    fixture,
    state,
    requests,
    faults,
    config: {
      host: "127.0.0.1",
      port: (remote.address() as AddressInfo).port,
      dialPort: (dial.address() as AddressInfo).port,
      protocol: options.tls ? ("https" as const) : ("http" as const),
      timeoutMs: 500,
    },
    async waitForRequest(path: string, count = 1) {
      if (requests.filter((request) => request.path === path).length >= count) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          events.off("request", check);
          reject(new Error(`No fixture request for ${path}`));
        }, 2000);
        function check() {
          if (requests.filter((request) => request.path === path).length >= count) {
            clearTimeout(timer);
            events.off("request", check);
            resolve();
          }
        }
        events.on("request", check);
        check();
      });
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      await Promise.all(
        [remote, dial].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    },
  };
}
export type NativeServer = Awaited<ReturnType<typeof startNativeServer>>;
