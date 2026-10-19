import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startVoiceCli } from "./helpers/voice-cli-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = await startVoiceCli();
  cleanup.push(() => fixture.close());
  await fixture.cli.waitFor("fire-tv>");
  await fixture.cli.command("/connect 1", "connected Synthetic");
  return fixture;
}

describe("actual voice CLI subprocess", () => {
  it("streams the supplied WAV as exact paced raw audio and exits naturally on EOF", async () => {
    const { cli, remote, voice } = await setup();
    const wav = await readFile(new URL("./fixtures/open-youtube.wav", import.meta.url));
    const start = performance.now();
    await cli.command("/voice wav tests/fixtures/open-youtube.wav", "voice streamed");
    expect(performance.now() - start).toBeGreaterThanOrEqual(1150);
    expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(wav.subarray(4096, 45056));
    expect(voice.sessions[0]!.closed).toBe(true);
    expect(remote.state.recording).toBe(false);
    expect(await cli.finish()).toEqual({ code: 0, signal: null });
    expect(cli.output).not.toContain("error:");
    expect(cli.output).not.toContain(remote.fixture.token);
    expect(cli.output).not.toContain(remote.fixture.pin);
  }, 12000);

  it("prevalidates malformed WAV, odd PCM and missing files without starting, then recovers", async () => {
    const { cli, directory, remote, voice } = await setup();
    const bad = join(directory, "bad.wav");
    const odd = join(directory, "odd.pcm");
    await writeFile(bad, Buffer.from("not a wave"));
    await writeFile(odd, Buffer.from([1, 2, 3]));
    await cli.command(`/voice wav ${bad}`, "error:");
    await cli.command(`/voice pcm ${odd}`, "error:");
    await cli.command(`/voice wav ${join(directory, "missing.wav")}`, "error:");
    expect(voice.sessions).toHaveLength(0);
    expect(remote.state.voiceTransitions).toEqual([]);
    const good = join(directory, "good.pcm");
    await writeFile(good, Buffer.from([1, 2, 3, 4]));
    await cli.command(`/voice pcm ${good}`, "voice streamed");
    expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(remote.state.recording).toBe(false);
    expect(await cli.finish("/quit")).toEqual({ code: 0, signal: null });
  }, 12000);

  it("recovers from rejected voice handshake without leaving recording active", async () => {
    const { cli, directory, remote, voice } = await setup();
    const good = join(directory, "good.pcm");
    await writeFile(good, Buffer.from([1, 2]));
    voice.faults.push({ handshake: "reject" });
    await cli.command(`/voice pcm ${good}`, "error:");
    expect(remote.state.recording).toBe(false);
    await cli.command(`/voice pcm ${good}`, "voice streamed");
    expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(Buffer.from([1, 2]));
    expect(await cli.finish("/quit")).toEqual({ code: 0, signal: null });
  }, 12000);

  it.each(["eof", "quit", "disconnect", "sigint"] as const)(
    "closes manual recording on %s",
    async (operation) => {
      const { cli, remote, voice } = await setup();
      await cli.command("/voice start", "voice started");
      expect(remote.state.recording).toBe(true);
      if (operation === "disconnect") {
        await cli.command("/disconnect", "disconnected");
        expect(await cli.finish()).toEqual({ code: 0, signal: null });
      } else {
        if (operation === "sigint") cli.child.kill("SIGINT");
        expect(await cli.finish(operation === "quit" ? "/quit" : undefined)).toEqual({
          code: 0,
          signal: null,
        });
      }
      expect(remote.state.recording).toBe(false);
      expect(voice.sessions[0]!.closed).toBe(true);
    },
    12000,
  );

  it("SIGINT during file streaming cancels promptly and naturally exits", async () => {
    const { cli, directory, remote } = await setup();
    const long = join(directory, "long.pcm");
    await writeFile(long, Buffer.alloc(320000));
    cli.child.stdin.write(`/voice pcm ${long}\n`);
    await remote.waitForRequest("/v1/FireTV/voiceCommand?action=start");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const start = performance.now();
    cli.child.kill("SIGINT");
    expect(await cli.finish()).toEqual({ code: 0, signal: null });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(remote.state.recording).toBe(false);
  }, 12000);
});
