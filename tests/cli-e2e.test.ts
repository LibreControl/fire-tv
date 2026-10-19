import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startCli } from "./helpers/cli-process.js";
import { startNativeServer } from "./helpers/native-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "fire-tv-cli-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await startNativeServer();
  cleanup.push(() => server.close());
  return { directory, server };
}
function cli(directory: string) {
  const process = startCli(directory);
  cleanup.push(() => process.stop());
  return process;
}
interface SavedState {
  devices: {
    id: number;
    host: string;
    port: number;
    protocol: string;
    dialPort?: number;
    credentials?: { clientToken: string };
  }[];
}

describe("real Fire TV CLI subprocess", () => {
  it("pairs, persists owner-only credentials and restarts without another PIN", async () => {
    const { directory, server } = await setup();
    const first = cli(directory);
    await first.waitFor("fire-tv>");
    await first.command(`/add http://127.0.0.1:${server.config.port} Synthetic`, "added [1]");
    await first.command("/pair 1", "enter the PIN");
    await first.command("/code 0000", "incorrect PIN");
    await first.command(`/code ${server.fixture.pin}`, "paired Synthetic");
    await first.command("/connect 1", "connected Synthetic");
    first.child.stdin.write(
      "/right\n/select\n/text café 🦊\n/playpause\n/scan-forward 12\n/scan-backward 5\n",
    );
    await first.command("/status", "synthetic-fire-os-8");
    expect(server.state.x).toBe(1);
    expect(server.state.text).toBe("café 🦊");
    expect(server.state.playing).toBe(true);
    expect(server.state.position).toBe(67);
    await first.command("/properties", "NotSupported");
    await first.command("/keyboard", "café 🦊");
    expect(await first.finish("/quit")).toEqual({ code: 0, signal: null });
    const stateFile = join(directory, "state.json");
    const saved = JSON.parse(await readFile(stateFile, "utf8")) as SavedState;
    expect(saved.devices[0]).toMatchObject({
      id: 1,
      host: "127.0.0.1",
      port: server.config.port,
      protocol: "http",
      credentials: { clientToken: server.fixture.token },
    });
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const pinRequests = server.requests.filter((request) => request.path.includes("/pin/")).length;
    // DIAL port is a persisted device field; the fixture uses an ephemeral port.
    saved.devices[0]!.dialPort = server.config.dialPort;
    await writeFile(stateFile, JSON.stringify(saved), { mode: 0o600 });
    const second = cli(directory);
    await second.waitFor("fire-tv>");
    await second.command("/devices", "paired");
    await second.command("/connect 1", "connected Synthetic");
    second.child.stdin.write("/home\n/menu\n/playpause\n/launch 1\n");
    await second.command("/status", "synthetic-fire-os-8");
    expect(server.state.screen).toBe("home");
    expect(server.state.menuOpen).toBe(true);
    expect(server.state.playing).toBe(false);
    expect(server.state.launches).toBe(1);
    expect(server.requests.filter((request) => request.path.includes("/pin/")).length).toBe(
      pinRequests,
    );
    expect(await second.finish()).toEqual({ code: 0, signal: null });
    for (const output of [first.output, second.output]) {
      expect(output).not.toContain(server.fixture.token);
      expect(output).not.toContain(server.fixture.pin);
      expect(output).not.toContain("0000");
    }
  }, 15000);

  it("toggles visible synthetic power twice and rejects disconnected or invalid-auth presses", async () => {
    const { directory, server } = await setup();
    const process = cli(directory);
    await process.waitFor("fire-tv>");
    await process.command(`/add http://127.0.0.1:${server.config.port} Synthetic`, "added [1]");
    await process.command("/pair 1", "enter the PIN");
    await process.command(`/code ${server.fixture.pin}`, "paired Synthetic");
    await process.command("/connect 1", "connected Synthetic");
    expect(server.state.displayPowered).toBe(true);
    await process.command("/power-toggle", "sent power-toggle");
    expect(server.state.displayPowered).toBe(false);
    await process.command("/power-toggle", "sent power-toggle");
    expect(server.state.displayPowered).toBe(true);
    expect(server.state.effects).toEqual(["power:off", "power:on"]);
    await process.command("/disconnect", "disconnected");
    const count = server.requests.length;
    await process.command("/power-toggle", "error:");
    expect(server.requests.length).toBe(count);
    expect(server.state.displayPowered).toBe(true);
    await process.command("/connect 1", "connected Synthetic");
    server.state.tokenValid = false;
    await process.command("/power-toggle", "error:");
    const rejectedCount = server.requests.length;
    await process.command("/power-toggle", "error:");
    expect(server.requests.length).toBe(rejectedCount);
    expect(server.state.displayPowered).toBe(true);
    expect(server.state.effects).toEqual(["power:off", "power:on"]);
    expect(await process.finish("/quit")).toEqual({ code: 0, signal: null });
  }, 15000);

  it("redacts secrets from receiver errors, rejects unsupported commands and allows recovery", async () => {
    const { directory, server } = await setup();
    const process = cli(directory);
    await process.waitFor("fire-tv>");
    await process.command(`/add http://127.0.0.1:${server.config.port} Synthetic`, "added [1]");
    await process.command("/pair 1", "enter the PIN");
    await process.command(`/code ${server.fixture.pin}`, "paired Synthetic");
    await process.command("/connect 1", "connected Synthetic");
    server.faults.push({
      path: "/v1/FireTV/status",
      status: 500,
      body: `${server.fixture.token} ${server.fixture.pin}`,
    });
    process.child.stdin.write("/status\n/power\n/power-on\n/power-off\n/volume\n/voice\n/right\n");
    await process.command("/status", "synthetic-fire-os-8");
    server.faults.push({
      path: "/v1/FireTV/properties",
      body: JSON.stringify({
        volumeSupport: "NotSupported",
        powerSupport: "NotSupported",
        note: `${server.fixture.token} ${server.fixture.pin}`,
      }),
    });
    await process.command("/properties", "NotSupported");
    expect(server.state.x).toBe(1);
    expect(server.state.displayPowered).toBe(true);
    expect(process.output).not.toContain(server.fixture.token);
    expect(process.output).not.toContain(server.fixture.pin);
    expect(process.output.toLowerCase()).toMatch(/unknown|unsupported/);
    expect(await process.finish("/quit")).toEqual({ code: 0, signal: null });
  }, 15000);

  it("drains piped lines on EOF and persists manual device configuration", async () => {
    const { directory, server } = await setup();
    const process = cli(directory);
    process.child.stdin.write(`/add http://127.0.0.1:${server.config.port} Synthetic\n/devices\n`);
    expect(await process.finish()).toEqual({ code: 0, signal: null });
    expect(process.output).toContain("added [1] Synthetic");
    expect(process.output).toContain(
      `[1] Synthetic 127.0.0.1:${server.config.port} unpaired (http)`,
    );
    expect(process.output).not.toContain("error:");
    const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as SavedState;
    expect(saved.devices[0]?.port).toBe(server.config.port);
    expect(saved.devices[0]?.protocol).toBe("http");
  });

  it("fails usefully on corrupt persisted JSON rather than silently discarding credentials", async () => {
    const { directory } = await setup();
    const original = '{"devices":[broken secret';
    await writeFile(join(directory, "state.json"), original, { mode: 0o600 });
    const process = cli(directory);
    const result = await process.finish();
    expect(result.code).not.toBe(0);
    expect(process.output).toMatch(/state|JSON|parse/i);
    expect(process.output).not.toContain("broken secret");
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(original);
  });

  it("hides mixed-case PIN commands in a genuine pseudo-terminal", async () => {
    const { directory, server } = await setup();
    const terminal = startCli(directory, undefined, true);
    cleanup.push(() => terminal.stop());
    await terminal.waitFor("fire-tv>");
    await terminal.command(`/add http://127.0.0.1:${server.config.port} Synthetic`, "added [1]");
    await terminal.command("/pair 1", "enter the PIN");
    await terminal.command("/Code 0000", "incorrect PIN");
    await terminal.command(`/CODE ${server.fixture.pin}`, "paired Synthetic");
    await terminal.command("/connect 1", "connected Synthetic");
    expect(await terminal.finish("/quit")).toEqual({ code: 0, signal: null });
    // Strip terminal escape sequences, not printed characters, to catch PINs
    // revealed transiently then overwritten by terminal cursor movement.
    const rendered = stripVTControlCharacters(terminal.output);
    expect(rendered).not.toContain(server.fixture.pin);
    expect(rendered).not.toContain("0000");
    expect(rendered).not.toContain(server.fixture.token);
  }, 15000);

  it("handles SIGINT without leaving a running child", async () => {
    const { directory } = await setup();
    const process = cli(directory);
    await process.waitFor("fire-tv>");
    process.child.kill("SIGINT");
    const result = await process.finish();
    expect(result).toEqual({ code: 0, signal: null });
  });
});
