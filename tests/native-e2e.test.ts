import { afterEach, describe, expect, it } from "vitest";
import { createFireTv, type FireTvDevice, type FireTvKeyName } from "../src/index.js";
import { startNativeServer, type NativeServer } from "./helpers/native-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(
  options: { tls?: boolean; timeoutMs?: number; rejectUnauthorized?: boolean } = {},
) {
  const server = await startNativeServer(options);
  cleanup.push(() => server.close());
  const device = createFireTv({
    ...server.config,
    name: "Synthetic test receiver",
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: options.rejectUnauthorized }
      : {}),
  });
  cleanup.push(() => device.disconnect());
  return { server, device };
}
async function pair(device: FireTvDevice, server: NativeServer) {
  const session = await device.startPairing();
  const result = await session.submitCode(server.fixture.pin);
  expect(result).toEqual({
    paired: true,
    status: "ok",
    credentials: { clientToken: server.fixture.token },
  });
  await session.close();
  await device.connect();
}

// Real sockets + independently implemented synthetic receiver, not a hardware capture.
describe("native adapter against synthetic Fire OS receiver", () => {
  it("retries an incorrect PIN, installs credentials and changes navigation, text, media and DIAL state", async () => {
    const { server, device } = await setup();
    expect(device.host).toBe("127.0.0.1");
    const session = await device.startPairing();
    expect(server.state.pairingDisplayed).toBe(true);
    expect(await session.submitCode("0000")).toEqual({ paired: false, status: "bad-pin" });
    expect(server.state.paired).toBe(false);
    expect((await session.submitCode(server.fixture.pin)).credentials?.clientToken).toBe(
      server.fixture.token,
    );
    await session.close();
    await device.connect();
    expect(await device.getStatus()).toEqual(server.fixture.status);
    expect(await device.getProperties()).toMatchObject({
      volumeSupport: "NotSupported",
      powerSupport: "NotSupported",
    });
    expect(await device.getKeyboardState()).toEqual({ state: "hidden", mode: null, text: null });
    await device.sendKey("up");
    await device.sendKey("left");
    expect([server.state.x, server.state.y]).toEqual([-1, -1]);
    await device.sendKey("right");
    await device.sendKey("down");
    expect([server.state.x, server.state.y]).toEqual([0, 0]);
    await device.sendKeyDown("select");
    expect(server.state.held).toBe("select");
    await device.sendKeyUp("select");
    expect(server.state.selected).toBe(1);
    await device.inputText("café 🦊 漢字");
    expect(server.state.text).toBe("café 🦊 漢字");
    expect((await device.getKeyboardState()).text).toBe("café 🦊 漢字");
    await device.sendKey("menu");
    expect(server.state.menuOpen).toBe(true);
    await device.sendKey("playPause");
    expect(server.state.playing).toBe(true);
    await device.sendKey("playPause");
    expect(server.state.playing).toBe(false);
    await device.scan("forward", 12);
    await device.scan("backward", 5);
    expect(server.state.position).toBe(67);
    await device.sendKey("back");
    expect(server.state.screen).toBe("home");
    await device.sendKey("select");
    await device.sendKey("home");
    expect(server.state.keyboardActive).toBe(false);
    await device.launchRemote();
    expect(server.state.launches).toBe(1);
    await device.disconnect();
    await expect(device.sendKey("up")).rejects.toThrow();
    await device.connect();
    await device.sendKey("down");
    expect(server.state.y).toBe(1);
  });

  it("toggles synthetic display power off and on with successive presses", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    expect(server.state.displayPowered).toBe(true);
    await device.sendKey("powerToggle");
    expect(server.state.displayPowered).toBe(false);
    await device.sendKey("powerToggle");
    expect(server.state.displayPowered).toBe(true);
    expect(server.state.effects).toEqual(["power:off", "power:on"]);
  });

  it.each([401, 403] as const)(
    "does not toggle on HTTP %i and invalidates queued and subsequent presses",
    async (status) => {
      const { server, device } = await setup();
      await pair(device, server);
      server.state.tokenValid = false;
      server.state.authFailureStatus = status;
      const pending = expect(device.sendKey("powerToggle")).rejects.toMatchObject({
        code: "http",
        statusCode: status,
      });
      const queued = expect(device.sendKey("powerToggle")).rejects.toThrow();
      await Promise.all([pending, queued]);
      const count = server.requests.length;
      await expect(device.sendKey("powerToggle")).rejects.toThrow();
      await expect(device.connect()).rejects.toThrow();
      expect(server.requests.length).toBe(count);
      expect(
        server.requests.filter((request) => request.path === "/v1/FireTV?action=power"),
      ).toHaveLength(1);
      expect(server.state.displayPowered).toBe(true);
      expect(server.state.effects).toEqual([]);
    },
  );

  it("cancels delayed and queued power presses on disconnect without toggling", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    server.faults.push({ path: "/v1/FireTV?action=power", delayMs: 200 });
    const pending = expect(device.sendKey("powerToggle")).rejects.toThrow();
    const queued = expect(device.sendKey("powerToggle")).rejects.toThrow();
    await server.waitForRequest("/v1/FireTV?action=power");
    await device.disconnect();
    await Promise.all([pending, queued]);
    const count = server.requests.length;
    await expect(device.sendKey("powerToggle")).rejects.toThrow();
    expect(server.requests.length).toBe(count);
    expect(server.state.displayPowered).toBe(true);
    expect(server.state.effects).toEqual([]);
    await device.connect();
    await device.sendKey("powerToggle");
    expect(server.state.displayPowered).toBe(false);
  });

  it("never retries a failed power toggle and allows a later explicit press", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    server.faults.push({ path: "/v1/FireTV?action=power", status: 500 });
    await expect(device.sendKey("powerToggle")).rejects.toMatchObject({ statusCode: 500 });
    expect(server.state.displayPowered).toBe(true);
    expect(
      server.requests.filter((request) => request.path === "/v1/FireTV?action=power"),
    ).toHaveLength(1);
    await device.sendKey("powerToggle");
    expect(server.state.displayPowered).toBe(false);
    expect(server.state.effects).toEqual(["power:off"]);
  });

  it("uses explicit HTTPS without downgrade and supports strict certificate rejection", async () => {
    const { server, device } = await setup({ tls: true, rejectUnauthorized: false });
    await pair(device, server);
    await device.sendKey("right");
    expect(server.state.x).toBe(1);
    const strict = createFireTv({
      ...server.config,
      clientToken: server.fixture.token,
      rejectUnauthorized: true,
    });
    cleanup.push(() => strict.disconnect());
    const count = server.requests.length;
    await expect(strict.connect()).rejects.toThrow();
    expect(server.requests.length).toBe(count);
    expect(server.requests.every((request) => !request.path.includes(server.fixture.token))).toBe(
      true,
    );
  });

  it("writes a whole Unicode string into an already edited field in state text", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    await device.sendKey("select");
    server.state.text = "C";
    expect(await device.getKeyboardState()).toEqual({
      state: "text",
      mode: "keyboard",
      text: "C",
    });
    const text = "café 🦊 漢字 e\u0301 👩‍💻";
    await device.inputText(text);
    expect(server.state.text).toContain(text);
    expect(await device.getKeyboardState()).toEqual({
      state: "text",
      mode: "keyboard",
      text: expect.stringContaining(text),
    });
  });

  it("serializes concurrent complete key presses and Unicode text without interleaving", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    await device.sendKey("select");
    server.state.effects.length = 0;
    server.faults.push({ path: "/v1/FireTV?action=dpad_up", delayMs: 40 });
    await Promise.all([
      device.sendKey("up"),
      device.inputText("A🦊"),
      device.sendKey("powerToggle"),
      device.sendKey("right"),
      device.inputText("漢B"),
      device.sendKey("powerToggle"),
    ]);
    expect(server.state.effects).toEqual([
      "dpad_up:down",
      "dpad_up:up",
      "text:A🦊",
      "power:off",
      "dpad_right:down",
      "dpad_right:up",
      "text:漢B",
      "power:on",
    ]);
    expect(server.state.held).toBeNull();
    expect(server.state.text).toBe("A🦊漢B");
    expect([server.state.x, server.state.y]).toEqual([1, -1]);
    expect(server.state.displayPowered).toBe(true);
  });

  it("recovers the command queue after a failed whole-string keyboard write", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    await device.sendKey("select");
    server.faults.push({
      path: "/v1/FireTV/keyboard",
      method: "POST",
      status: 500,
      body: `${server.fixture.token} ${server.fixture.pin}`,
    });
    await expect(device.inputText("failed 🦊")).rejects.toMatchObject({
      code: "http",
      statusCode: 500,
    });
    expect(server.state.text).toBe("");
    await device.inputText("recovered café 🦊");
    expect(server.state.text).toBe("recovered café 🦊");
    expect((await device.getKeyboardState()).text).toBe("recovered café 🦊");
  });

  it("invalidates the text queue on a keyboard write authentication failure", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    await device.sendKey("select");
    server.faults.push({ path: "/v1/FireTV/keyboard", method: "POST", status: 401 });
    const pending = expect(device.inputText("rejected 🦊")).rejects.toMatchObject({
      code: "http",
      statusCode: 401,
    });
    const queued = expect(device.inputText("never sent 漢字")).rejects.toThrow();
    await Promise.all([pending, queued]);
    expect(server.state.text).toBe("");
    const count = server.requests.length;
    await expect(device.inputText("disconnected")).rejects.toThrow();
    expect(server.requests.length).toBe(count);
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.path === "/v1/FireTV/keyboard",
      ),
    ).toHaveLength(1);
    await pair(device, server);
    await device.inputText("paired again");
    expect(server.state.text).toBe("paired again");
  });

  it("cancels an in-flight keyboard write and queued text on disconnect", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    await device.sendKey("select");
    server.faults.push({ path: "/v1/FireTV/keyboard", method: "POST", delayMs: 200 });
    const pending = expect(device.inputText("pending 🦊")).rejects.toThrow();
    const queued = expect(device.inputText("queued 漢字")).rejects.toThrow();
    await server.waitForRequest("/v1/FireTV/keyboard", 2);
    await device.disconnect();
    await Promise.all([pending, queued]);
    expect(server.state.text).toBe("");
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.path === "/v1/FireTV/keyboard",
      ),
    ).toHaveLength(1);
    await device.connect();
    await device.inputText("reconnected café");
    expect(server.state.text).toBe("reconnected café");
  });

  it("cancels pending and queued commands on disconnect and can reconnect", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    server.faults.push({ path: "/v1/FireTV?action=dpad_up", delayMs: 200 });
    const pending = expect(device.sendKey("up")).rejects.toThrow();
    const queued = expect(device.sendKey("right")).rejects.toThrow();
    await server.waitForRequest("/v1/FireTV?action=dpad_up");
    await device.disconnect();
    await Promise.all([pending, queued]);
    expect(server.state.effects).toEqual([]);
    expect(
      server.requests.filter((request) => request.path === "/v1/FireTV?action=dpad_right"),
    ).toHaveLength(0);
    await device.connect();
    await device.sendKey("right");
    expect(server.state.x).toBe(1);
  });

  it("retains explicit held-key ownership across incompatible command failures", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    await device.sendKeyDown("up");
    expect(server.state.held).toBe("dpad_up");
    const count = server.requests.length;
    await expect(device.sendKey("right")).rejects.toThrow();
    await expect(device.sendKey("powerToggle")).rejects.toThrow();
    await expect(device.sendKeyDown("left")).rejects.toThrow();
    await expect(device.sendKeyUp("right")).rejects.toThrow();
    await expect(device.inputText("blocked")).rejects.toThrow();
    expect(server.requests.length).toBe(count);
    expect(server.state.held).toBe("dpad_up");
    expect(server.state.displayPowered).toBe(true);
    await device.sendKeyUp("up");
    await device.sendKey("right");
    expect(server.state.held).toBeNull();
    expect([server.state.x, server.state.y]).toEqual([1, -1]);
  });

  it("replaces a pairing session by cancelling the old submission", async () => {
    const { server, device } = await setup();
    const old = await device.startPairing();
    server.faults.push({ path: "/v1/FireTV/pin/verify", delayMs: 200 });
    const rejected = expect(old.submitCode(server.fixture.pin)).rejects.toThrow();
    await server.waitForRequest("/v1/FireTV/pin/verify");
    const current = await device.startPairing();
    await rejected;
    await expect(old.submitCode(server.fixture.pin)).rejects.toThrow();
    expect((await current.submitCode(server.fixture.pin)).paired).toBe(true);
    await current.close();
    await device.connect();
    await device.sendKey("right");
    expect(server.state.x).toBe(1);
  });

  it("sanitizes synchronous malformed credential rejection before network I/O", async () => {
    const { server } = await setup();
    const token = `invalid${String.fromCharCode(10)}${server.fixture.token}`;
    let error: unknown;
    try {
      createFireTv({ ...server.config, clientToken: token });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(server.fixture.token);
    expect(server.requests).toHaveLength(0);
  });

  it("cancels in-flight pairing and rejects submissions to a closed session", async () => {
    const { server, device } = await setup();
    const session = await device.startPairing();
    server.faults.push({ path: "/v1/FireTV/pin/verify", delayMs: 200 });
    const pending = expect(session.submitCode(server.fixture.pin)).rejects.toThrow();
    await server.waitForRequest("/v1/FireTV/pin/verify");
    await session.close();
    await pending;
    await expect(session.submitCode(server.fixture.pin)).rejects.toThrow();
    expect(server.state.paired).toBe(false);
    expect(
      server.requests.filter((request) => request.path === "/v1/FireTV/pin/verify"),
    ).toHaveLength(1);
  });

  it("invalidates connected state on 401 without retry and permits re-pairing", async () => {
    const { server, device } = await setup();
    await pair(device, server);
    server.state.tokenValid = false;
    await expect(device.sendKey("home")).rejects.toThrow();
    const count = server.requests.length;
    await expect(device.sendKey("menu")).rejects.toThrow();
    expect(server.requests.length).toBe(count);
    expect(
      server.requests.filter((request) => request.path === "/v1/FireTV?action=home"),
    ).toHaveLength(1);
    await expect(device.connect()).rejects.toThrow();
    await pair(device, server);
    await device.sendKey("menu");
    expect(server.state.menuOpen).toBe(true);
  });

  it("rejects disconnected and unsupported commands and inactive keyboard input", async () => {
    const { server, device } = await setup();
    await expect(device.inputText("x")).rejects.toThrow();
    await expect(device.getStatus()).rejects.toThrow();
    await expect(device.sendKey("home")).rejects.toThrow();
    await pair(device, server);
    await expect(device.inputText("x")).rejects.toThrow();
    expect(server.state.text).toBe("");
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.path === "/v1/FireTV/keyboard",
      ),
    ).toHaveLength(0);
    const count = server.requests.length;
    for (const key of ["power", "powerOn", "powerOff", "volumeUp", "voice", "play", "pause"])
      await expect(device.sendKey(key as FireTvKeyName)).rejects.toThrow();
    await expect(device.scan("forward", -1)).rejects.toThrow();
    expect(server.requests.length).toBe(count);
    await device.sendKey("select");
    await device.inputText("valid");
    expect(server.state.text).toBe("valid");
  });

  it.each(["", "OK, synthetic non-JSON success"])(
    "accepts command success body %j",
    async (body) => {
      const { server, device } = await setup();
      await pair(device, server);
      server.faults.push({ path: "/v1/FireTV?action=home", status: 200, body });
      await expect(device.sendKey("home")).resolves.toBeUndefined();
      await device.sendKey("menu");
      expect(server.state.menuOpen).toBe(true);
    },
  );

  it("bounds timeout/network errors and sanitizes HTTP response secrets", async () => {
    const { server, device } = await setup({ timeoutMs: 200 });
    await pair(device, server);
    server.faults.push({ path: "/v1/FireTV?action=home", delayMs: 600 });
    const start = Date.now();
    await expect(device.sendKey("home")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1500);
    expect(
      server.requests.filter((request) => request.path === "/v1/FireTV?action=home"),
    ).toHaveLength(1);
    await device.disconnect();
    await device.connect();
    server.faults.push({
      path: "/v1/FireTV/status",
      status: 500,
      body: `${server.fixture.token} ${server.fixture.pin}`,
    });
    let error: unknown;
    try {
      await device.getStatus();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(server.fixture.token);
    expect(String(error)).not.toContain(server.fixture.pin);
    await server.close();
    // Already closed fixture must not be closed twice by cleanup.
    cleanup.splice(cleanup.length - 2, 1);
    await device.disconnect();
    const started = Date.now();
    await expect(device.connect()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it.each(["not-json", "{}", '{"osVersion":1,"platformType":"android","turnstileVersion":"x"}'])(
    "rejects malformed status %s",
    async (body) => {
      const { server, device } = await setup();
      await pair(device, server);
      server.faults.push({ path: "/v1/FireTV/status", body });
      await expect(device.getStatus()).rejects.toThrow();
      await device.disconnect();
      server.faults.push({ path: "/v1/FireTV/status", body });
      await expect(device.connect()).rejects.toThrow();
      const count = server.requests.length;
      await expect(device.sendKey("right")).rejects.toThrow();
      expect(server.requests.length).toBe(count);
    },
  );

  it.each(["not-json", "{}", '{"description":123}'])(
    "rejects malformed pairing verification %s",
    async (body) => {
      const { server, device } = await setup();
      const session = await device.startPairing();
      server.faults.push({ path: "/v1/FireTV/pin/verify", body });
      await expect(session.submitCode(server.fixture.pin)).rejects.toThrow();
      await session.close();
      await expect(device.connect()).rejects.toThrow();
    },
  );

  it("rejects malformed PIN-display and HTTP/DIAL failures without masking", async () => {
    const { server, device } = await setup();
    server.faults.push({ path: "/v1/FireTV/pin/display", body: "{}" });
    await expect(device.startPairing()).rejects.toThrow();
    await pair(device, server);
    server.faults.push({ path: "/v1/FireTV?action=menu", status: 400, body: "bad request" });
    await expect(device.sendKey("menu")).rejects.toThrow();
    expect(server.state.menuOpen).toBe(false);
    server.faults.push({ path: "/apps/FireTVRemote", status: 500 });
    await expect(device.launchRemote()).rejects.toThrow();
    expect(server.state.launches).toBe(0);
  });
});
