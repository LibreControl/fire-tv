import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCli } from "./cli-process.js";
import { startNativeServer } from "./native-server.js";

// Parent-only real-program check after build:
// node --import tsx tests/helpers/smoke-cli.ts dist/cli/repl.js
// No library imports, Vitest, production action tables, mock clients or transports.
const entry = process.argv[2] ?? "dist/cli/repl.js";
const directory = await mkdtemp(join(tmpdir(), "fire-tv-program-smoke-"));
const server = await startNativeServer();
const processes: ReturnType<typeof startCli>[] = [];
try {
  const first = startCli(directory, entry);
  processes.push(first);
  await first.waitFor("fire-tv>");
  await first.command(`/add http://127.0.0.1:${server.config.port} Synthetic`, "added [1]");
  await first.command("/pair 1", "enter the PIN");
  await first.command("/code 0000", "incorrect PIN");
  await first.command(`/code ${server.fixture.pin}`, "paired Synthetic");
  await first.command("/connect 1", "connected Synthetic");
  await first.command("/right", "sent right");
  await first.command("/select", "sent select");
  await first.command("/text Smoke café 🦊", "sent text");
  await first.command("/playpause", "sent playpause");
  assert.equal(server.state.displayPowered, true);
  await first.command("/power-toggle", "sent power-toggle");
  assert.equal(server.state.displayPowered, false);
  await first.command("/scan-forward 9", "sent scan-forward");
  await first.command("/status", "synthetic-fire-os-8");
  assert.equal(server.state.x, 1);
  assert.equal(server.state.text, "Smoke café 🦊");
  await first.command("/keyboard", "Smoke café 🦊");
  assert.equal(server.state.playing, true);
  assert.equal(server.state.position, 69);
  assert.deepEqual(await first.finish("/quit"), { code: 0, signal: null });
  const file = join(directory, "state.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    devices: { dialPort?: number; credentials?: { clientToken: string } }[];
  };
  assert.equal(saved.devices[0]?.credentials?.clientToken, server.fixture.token);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  saved.devices[0]!.dialPort = server.config.dialPort;
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const pairingRequests = server.requests.filter((request) =>
    request.path.includes("/pin/"),
  ).length;
  const second = startCli(directory, entry);
  processes.push(second);
  await second.waitFor("fire-tv>");
  await second.command("/connect 1", "connected Synthetic");
  await second.command("/launch 1", "launched remote");
  await second.command("/left", "sent left");
  await second.command("/playpause", "sent playpause");
  await second.command("/power-toggle", "sent power-toggle");
  assert.equal(server.state.displayPowered, true);
  assert.deepEqual(
    server.state.effects.filter((effect) => effect.startsWith("power:")),
    ["power:off", "power:on"],
  );
  await second.command("/scan-backward 4", "sent scan-backward");
  await second.command("/home", "sent home");
  assert.equal(server.state.x, 0);
  assert.equal(server.state.playing, false);
  assert.equal(server.state.position, 65);
  assert.equal(server.state.keyboardActive, false);
  assert.equal(server.state.launches, 1);
  assert.equal(
    server.requests.filter((request) => request.path.includes("/pin/")).length,
    pairingRequests,
  );
  assert.deepEqual(await second.finish(), { code: 0, signal: null });
  for (const process of processes) {
    assert.ok(!process.output.includes(server.fixture.pin), "PIN leaked in CLI output");
    assert.ok(!process.output.includes(server.fixture.token), "Token leaked in CLI output");
  }
  console.log(
    JSON.stringify(
      {
        provenance: "SYNTHETIC community-protocol fixture; NOT a hardware capture",
        program: entry,
        persistedRestartWithoutPin: true,
        ownerOnlyCredentials: true,
        cleanQuitAndEof: true,
        powerTransitions: server.state.effects.filter((effect) => effect.startsWith("power:")),
        state: {
          x: server.state.x,
          y: server.state.y,
          text: server.state.text,
          screen: server.state.screen,
          playing: server.state.playing,
          displayPowered: server.state.displayPowered,
          position: server.state.position,
          launches: server.state.launches,
        },
        requests: server.requests.length,
      },
      null,
      2,
    ),
  );
} finally {
  for (const process of processes) await process.stop();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
