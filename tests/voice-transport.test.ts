import { afterEach, describe, expect, it } from "vitest";
import { VoiceSocket } from "../src/transport/websocket.js";
import { startNativeServer } from "./helpers/native-server.js";
import { startVoiceServer } from "./helpers/voice-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
// These integration waits observe real TLS write completion/backpressure; fake
// timers cannot advance the operating system's socket buffers or network events.
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Voice fixture observation timed out");
    await delay(10);
  }
}
async function setup(pauseMs: number, timeoutMs = 1000) {
  const remote = await startNativeServer();
  cleanup.push(() => remote.close());
  const voice = await startVoiceServer(remote);
  cleanup.push(() => voice.close());
  // Transport-only cases start from an already authorized recording session.
  remote.state.paired = true;
  remote.state.recording = true;
  voice.faults.push({ pauseMs });
  const controller = new AbortController();
  const socket = await VoiceSocket.open({
    host: remote.config.host,
    port: voice.port,
    clientToken: remote.fixture.token,
    rejectUnauthorized: false,
    timeoutMs,
    signal: controller.signal,
  });
  cleanup.push(() => socket.close().catch(() => {}));
  return { socket, controller, voice, remote };
}

describe("native TLS voice transport under socket pressure", () => {
  it("delivers ordered masked bytes after receiver pauses beyond TCP buffering", async () => {
    const { socket, controller, voice } = await setup(250);
    const payload = Buffer.alloc(65534);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    // Eight MiB exceeds local TCP send buffers; await actual write completion each time.
    for (let i = 0; i < 128; i++) await socket.writePcm(payload, controller.signal);
    await socket.close();
    expect(voice.sessions[0]!.pcm).toHaveLength(128);
    for (const frame of voice.sessions[0]!.pcm) expect(frame.equals(payload)).toBe(true);
    expect(voice.sessions[0]!.errors).toEqual([]);
  }, 10000);

  it("settles blocked writes on cancellation without waiting for paused receiver", async () => {
    const { socket, controller } = await setup(4000);
    const payload = Buffer.alloc(65534);
    const sending = (async () => {
      for (let i = 0; i < 512; i++) await socket.writePcm(payload, controller.signal);
    })().then(
      () => "success",
      () => "canceled",
    );
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const start = performance.now();
      expect(await sending).toBe("canceled");
      expect(performance.now() - start).toBeLessThan(1500);
    } finally {
      clearTimeout(timer);
    }
  }, 10000);

  it("coalesces control floods behind a blocked PCM write and recovers with the latest pong", async () => {
    const { socket, controller, voice, remote } = await setup(0, 5000);
    const session = voice.sessions[0]!;
    session.pause();
    const payload = Buffer.alloc(65534);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    let completed = 0;
    let lastProgress = performance.now();
    const sending = (async () => {
      for (let i = 0; i < 256; i++) {
        await socket.writePcm(payload, controller.signal);
        completed++;
        lastProgress = performance.now();
      }
    })().then(
      () => "success",
      () => "failed",
    );
    await waitUntil(() => completed > 0 && performance.now() - lastProgress >= 100);
    expect(completed).toBeLessThan(256);
    const beforeFlood = completed;
    const finalPing = Buffer.from("latest-control-ping");
    await session.floodPings(4096, finalPing);
    // Leave reads paused while the actual network delivers the final ping.
    await delay(100);
    // The audio writer remains blocked while inbound controls continue to arrive.
    expect(completed).toBe(beforeFlood);
    expect(remote.state.recording).toBe(true);
    session.resume();
    expect(await sending).toBe("success");
    await waitUntil(() => session.pong.some((pong) => pong.equals(finalPing)));
    await socket.close();
    expect(session.pcm).toHaveLength(256);
    for (const chunk of session.pcm) expect(chunk.equals(payload)).toBe(true);
    // Not a fixed two-pong expectation: permit some progress across network events,
    // but reject a queued response for every ping while the consumer was blocked.
    expect(session.pong.length).toBeLessThan(64);
    expect(session.pong.at(-1)).toEqual(finalPing);
    expect(session.errors).toEqual([]);
    expect(session.closed).toBe(true);
    expect(voice.violations).toEqual([]);
  }, 15000);

  it("cancels a blocked writer under control flood and closes without draining queued pongs", async () => {
    const { socket, controller, voice } = await setup(0, 500);
    const session = voice.sessions[0]!;
    session.pause();
    const payload = Buffer.alloc(65534, 0x34);
    let completed = 0;
    let lastProgress = performance.now();
    const sending = (async () => {
      for (let i = 0; i < 256; i++) {
        await socket.writePcm(payload, controller.signal);
        completed++;
        lastProgress = performance.now();
      }
    })().then(
      () => "success",
      () => "canceled",
    );
    await waitUntil(() => completed > 0 && performance.now() - lastProgress >= 100);
    expect(completed).toBeLessThan(256);
    await session.floodPings(2048, Buffer.from("canceled-control-ping"));
    const start = performance.now();
    controller.abort();
    expect(await sending).toBe("canceled");
    // The receiver deliberately never resumes; bounded close must tear down rather
    // than waiting for thousands of control responses or for its read buffer.
    await socket.close().catch(() => {});
    expect(performance.now() - start).toBeLessThan(1500);
    session.resume();
    await waitUntil(() => session.closed);
    expect(session.pong.length).toBeLessThan(64);
    expect(session.errors).toEqual([]);
  }, 8000);
});
