import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startVoiceCli } from "./voice-cli-fixture.js";

// Parent-only after build: node --import tsx tests/helpers/smoke-voice-cli.ts dist/cli/repl.js
// Real compiled program, independent HTTPS/WSS receiver; no Vitest or production codec.
const fixture = await startVoiceCli(process.argv[2] ?? "dist/cli/repl.js");
try {
  const { cli, remote, voice } = fixture;
  await cli.waitFor("fire-tv>");
  await cli.command("/connect 1", "connected Synthetic");
  const wav = await readFile(new URL("../fixtures/open-youtube.wav", import.meta.url));
  const started = performance.now();
  await cli.command("/voice wav tests/fixtures/open-youtube.wav", "voice streamed");
  const durationMs = performance.now() - started;
  const pcm = Buffer.concat(voice.sessions[0]!.pcm);
  assert.equal(pcm.length, 40960);
  assert.deepEqual(pcm, wav.subarray(4096, 45056));
  assert.ok(durationMs >= 1150, "Audio was not paced at realtime");
  assert.deepEqual(remote.state.voiceTransitions, ["start", "wss", "close", "stop"]);
  assert.equal(remote.state.recording, false);
  assert.deepEqual(voice.violations, []);
  assert.deepEqual(voice.sessions[0]!.errors, []);
  assert.deepEqual(await cli.finish("/quit"), { code: 0, signal: null });
  assert.ok(!cli.output.includes("error:"));
  assert.ok(!cli.output.includes(remote.fixture.token));
  assert.ok(!cli.output.includes(remote.fixture.pin));
  console.log(
    JSON.stringify({
      audioBytes: pcm.length,
      durationMs: Math.round(durationMs),
      recordingTransitions: remote.state.voiceTransitions,
      recording: remote.state.recording,
    }),
  );
} finally {
  await fixture.close();
}
