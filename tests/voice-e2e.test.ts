import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFireTv } from "../src/index.js";
import { startNativeServer } from "./helpers/native-server.js";
import { startVoiceServer } from "./helpers/voice-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function setup(options: { strict?: boolean; timeoutMs?: number; tls?: boolean } = {}) {
  const remote = await startNativeServer({ tls: options.tls });
  cleanup.push(() => remote.close());
  const voice = await startVoiceServer(remote);
  cleanup.push(() => voice.close());
  const device = createFireTv({
    ...remote.config,
    voicePort: voice.port,
    rejectUnauthorized: options.strict ?? false,
    timeoutMs: options.timeoutMs ?? 800,
  });
  cleanup.push(() => device.disconnect());
  const pairing = await device.startPairing();
  await pairing.submitCode(remote.fixture.pin);
  await pairing.close();
  await device.connect();
  return { device, remote, voice };
}
async function fixturePcm() {
  const wav = await readFile(new URL("./fixtures/open-youtube.wav", import.meta.url));
  // Independent known converted fixture boundary, deliberately not the production WAV parser.
  expect(wav.toString("ascii", 4088, 4092)).toBe("data");
  expect(wav.readUInt32LE(4092)).toBe(40960);
  return wav.subarray(4096, 45056);
}

describe("owned native Alexa voice against independent HTTP/WSS receiver", () => {
  it("delivers exact Google-derived PCM at real-time pace and closes before authenticated stop", async () => {
    const { device, remote, voice } = await setup();
    const pcm = await fixturePcm();
    const start = performance.now();
    await device.voiceStart();
    await device.voiceStreamPcm(pcm);
    await device.voiceStop();
    const session = voice.sessions[0]!;
    expect(Buffer.concat(session.pcm)).toEqual(pcm);
    expect(session.pcm.every((chunk) => chunk.length <= 3200 && chunk.length % 2 === 0)).toBe(true);
    expect(performance.now() - start).toBeGreaterThanOrEqual(1150);
    expect(session.times.at(-1)! - session.times[0]!).toBeGreaterThanOrEqual(1050);
    expect(session.pong).toContainEqual(Buffer.from("alive"));
    expect(session.errors).toEqual([]);
    expect(voice.violations).toEqual([]);
    expect(remote.state.voiceTransitions).toEqual(["start", "wss", "close", "stop"]);
    expect(remote.state.recording).toBe(false);
    expect(session.closed).toBe(true);
    expect(
      remote.requests.filter((r) => r.path.includes("voiceCommand")).every((r) => r.body === ""),
    ).toBe(true);
  }, 8000);

  it("does not burst overdue PCM quanta after the event loop stalls", async () => {
    const { device, remote, voice } = await setup();
    const pcm = await fixturePcm();
    voice.faults.push({
      onFirstAudio: () => {
        // Stall the shared sender/receiver loop after an observed frame, not after an
        // assumed timer deadline. Absolute stream-start deadlines would now catch up.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450);
      },
    });
    await device.voiceStart();
    await device.voiceStreamPcm(pcm);
    await device.voiceStop();
    const session = voice.sessions[0]!;
    expect(Buffer.concat(session.pcm)).toEqual(pcm);
    const gaps = session.times.slice(1).map((time, index) => time - session.times[index]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(400);
    // Allow scheduler/network jitter while forbidding transmission faster than the
    // preceding frame's audio duration; this does not pin a particular chunk size.
    expect(gaps.every((gap, index) => gap >= session.pcm[index]!.length / 32 / 2)).toBe(true);
    expect(session.errors).toEqual([]);
    expect(remote.state.voiceTransitions).toEqual(["start", "wss", "close", "stop"]);
    expect(remote.state.recording).toBe(false);
    expect(session.closed).toBe(true);
  }, 10000);

  it("cancels a flooded recording and starts a clean session without leftover control work", async () => {
    const { device, remote, voice } = await setup();
    let firstAudio!: () => void;
    const receivedAudio = new Promise<void>((resolve) => {
      firstAudio = resolve;
    });
    voice.faults.push({ onFirstAudio: firstAudio });
    await device.voiceStart();
    const streaming = device.voiceStreamPcm(new Uint8Array(320000)).then(
      () => "success",
      () => "canceled",
    );
    await receivedAudio;
    const session = voice.sessions[0]!;
    session.pause();
    await session.floodPings(4096, Buffer.from("recording-control-ping"));
    expect(remote.state.recording).toBe(true);
    session.resume();
    const start = performance.now();
    await device.voiceStop();
    expect(await streaming).toBe("canceled");
    expect(performance.now() - start).toBeLessThan(1500);
    expect(remote.state.recording).toBe(false);
    expect(session.closed).toBe(true);
    expect(session.pcm.length).toBeLessThan(100);
    expect(session.errors).toEqual([]);
    expect(session.pong.length).toBeLessThan(512);
    await device.voiceStart();
    await device.voiceStreamPcm(Buffer.from([7, 8, 9, 10]));
    await device.voiceStop();
    expect(Buffer.concat(voice.sessions[1]!.pcm)).toEqual(Buffer.from([7, 8, 9, 10]));
    expect(remote.state.voiceTransitions).toEqual([
      "start",
      "wss",
      "close",
      "stop",
      "start",
      "wss",
      "close",
      "stop",
    ]);
    expect(remote.state.recording).toBe(false);
    expect(voice.violations).toEqual([]);
  }, 8000);

  it("rejects idle/duplicate/invalid operations without corrupting a recoverable session", async () => {
    const { device, remote, voice } = await setup();
    await expect(device.voiceStreamPcm(new Uint8Array(2))).rejects.toThrow();
    await expect(device.voiceStop()).rejects.toThrow();
    await device.voiceStart();
    await expect(device.voiceStart()).rejects.toThrow();
    await expect(device.voiceStreamPcm(new Uint8Array())).rejects.toThrow();
    await expect(device.voiceStreamPcm(new Uint8Array(3))).rejects.toThrow();
    await device.voiceStreamPcm(Uint8Array.from([1, 2, 3, 4]));
    await device.voiceStop();
    await device.voiceStart();
    await device.voiceStreamPcm(Uint8Array.from([5, 6]));
    await device.voiceStop();
    expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(Buffer.concat(voice.sessions[1]!.pcm)).toEqual(Buffer.from([5, 6]));
    expect(remote.state.recording).toBe(false);
  });

  it.each(["accept", "upgrade", "connection", "reject", "stall"] as const)(
    "cleans recorder after %s handshake failure",
    async (handshake) => {
      const { device, remote, voice } = await setup({ timeoutMs: 250 });
      voice.faults.push({ handshake });
      await expect(device.voiceStart()).rejects.toThrow();
      expect(remote.state.recording).toBe(false);
      expect(remote.state.voiceTransitions.at(-1)).toBe("stop");
      await device.voiceStart();
      await device.voiceStop();
      expect(remote.state.recording).toBe(false);
    },
  );

  it("honors explicit certificate rejection without plaintext fallback", async () => {
    const { device, remote, voice } = await setup({ strict: true });
    await expect(device.voiceStart()).rejects.toThrow();
    expect(voice.sessions).toHaveLength(0);
    expect(remote.state.recording).toBe(false);
  });

  it("does not open voice after failed HTTP start and allows recovery", async () => {
    const { device, remote, voice } = await setup();
    remote.faults.push({ path: "/v1/FireTV/voiceCommand?action=start", status: 500 });
    await expect(device.voiceStart()).rejects.toThrow();
    expect(voice.sessions).toHaveLength(0);
    expect(remote.state.recording).toBe(false);
    await device.voiceStart();
    await device.voiceStop();
  });

  it("invalidates global credentials on voice 401 and redacts receiver errors", async () => {
    const { device, remote } = await setup();
    remote.faults.push({
      path: "/v1/FireTV/voiceCommand?action=start",
      status: 401,
      body: `${remote.fixture.token} ${remote.fixture.pin}`,
    });
    const error = await device.voiceStart().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(remote.fixture.token);
    expect(String(error)).not.toContain(remote.fixture.pin);
    await expect(device.getStatus()).rejects.toThrow();
    expect(remote.state.recording).toBe(false);
  });

  it.each([401, 403] as const)(
    "recovers from persistent HTTP %s revocation after re-pairing with replacement credentials",
    async (status) => {
      const { device, remote, voice } = await setup({ tls: true });
      remote.state.authFailureStatus = status;
      remote.state.tokenValid = false;
      await expect(device.voiceStart()).rejects.toMatchObject({ statusCode: status });
      expect(
        remote.requests.filter((r) => r.path.includes("voiceCommand")).map((r) => r.path),
      ).toEqual(["/v1/FireTV/voiceCommand?action=start", "/v1/FireTV/voiceCommand?action=stop"]);
      expect(remote.state.tokenValid).toBe(false);
      expect(remote.state.recording).toBe(false);
      expect(voice.sessions).toHaveLength(0);
      await expect(device.getStatus()).rejects.toThrow();
      await expect(device.connect()).rejects.toThrow();

      remote.state.nextPairingToken = randomUUID();
      const pairing = await device.startPairing();
      await pairing.submitCode(remote.fixture.pin);
      await pairing.close();
      await device.connect();
      await device.sendKey("down");
      expect(remote.state.y).toBe(1);
      const pcm = Buffer.from([21, 22, 23, 24]);
      await device.voiceStart();
      await device.voiceStreamPcm(pcm);
      await device.voiceStop();
      expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(pcm);
      expect(voice.sessions[0]!.closed).toBe(true);
      expect(voice.sessions[0]!.errors).toEqual([]);
      expect(voice.violations).toEqual([]);
      expect(remote.state.voiceTransitions).toEqual(["start", "wss", "close", "stop"]);
      expect(remote.state.recording).toBe(false);
    },
  );

  it.each([
    { status: 401 as const, replacement: "rotated" },
    { status: 403 as const, replacement: "rotated" },
    { status: 401 as const, replacement: "reissued" },
    { status: 403 as const, replacement: "reissued" },
  ])(
    "does not invalidate $replacement credentials when old cleanup returns HTTP $status",
    async ({ status, replacement }) => {
      const { device, remote, voice } = await setup({ tls: true, timeoutMs: 3000 });
      let release!: () => void;
      const waitFor = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Ensure a failed assertion cannot strand the fixture's held response.
      cleanup.push(async () => {
        release();
      });
      remote.state.authFailureStatus = status;
      remote.state.tokenValid = false;
      remote.faults.push({ path: "/v1/FireTV/voiceCommand?action=stop", waitFor });
      const starting = device.voiceStart().then(
        () => "success",
        () => "denied",
      );
      await remote.waitForRequest("/v1/FireTV/voiceCommand?action=stop");
      expect(remote.state.recording).toBe(false);
      expect(voice.sessions).toHaveLength(0);

      if (replacement === "rotated") remote.state.nextPairingToken = randomUUID();
      const pairing = await device.startPairing();
      await pairing.submitCode(remote.fixture.pin);
      await pairing.close();
      await device.connect();
      // Pairing does not release the old response: the new connection is live
      // before the old credential's terminal denial reaches the client.
      await device.sendKey("down");
      expect(remote.state.y).toBe(1);
      release();
      expect(await starting).toBe("denied");
      await device.sendKey("down");
      expect(remote.state.y).toBe(2);
      await device.getStatus();
      const pcm = Buffer.from([31, 32, 33, 34]);
      await device.voiceStart();
      await device.voiceStreamPcm(pcm);
      await device.voiceStop();
      expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(pcm);
      expect(voice.sessions[0]!.closed).toBe(true);
      expect(voice.sessions[0]!.errors).toEqual([]);
      expect(voice.violations).toEqual([]);
      expect(remote.state.voiceTransitions).toEqual(["start", "wss", "close", "stop"]);
      expect(remote.state.recording).toBe(false);
    },
  );

  it("interrupts long paced audio promptly on stop and supports a fresh session", async () => {
    const { device, remote, voice } = await setup();
    await device.voiceStart();
    const stream = device.voiceStreamPcm(new Uint8Array(320000)).then(
      () => "success",
      () => "canceled",
    );
    await delay(130);
    const start = performance.now();
    await device.voiceStop();
    expect(await stream).toBe("canceled");
    expect(performance.now() - start).toBeLessThan(1500);
    expect(Buffer.concat(voice.sessions[0]!.pcm).length).toBeLessThan(320000);
    expect(remote.state.recording).toBe(false);
    await device.voiceStart();
    await device.voiceStop();
  });

  it.each(["stop", "disconnect"] as const)(
    "cancels delayed start during %s without reopening recorder",
    async (operation) => {
      const { device, remote, voice } = await setup();
      remote.faults.push({ path: "/v1/FireTV/voiceCommand?action=start", delayMs: 180 });
      const starting = device.voiceStart().then(
        () => "success",
        () => "canceled",
      );
      await remote.waitForRequest("/v1/FireTV/voiceCommand?action=start");
      if (operation === "stop") await device.voiceStop();
      else await device.disconnect();
      expect(await starting).toBe("canceled");
      await delay(250);
      expect(remote.state.recording).toBe(false);
      expect(voice.sessions).toHaveLength(0);
      if (operation === "disconnect") await device.connect();
      await device.voiceStart();
      await device.voiceStop();
    },
  );

  it("disconnect cancels streaming and stops recorder before reconnect", async () => {
    const { device, remote } = await setup();
    await device.voiceStart();
    const streaming = device.voiceStreamPcm(new Uint8Array(320000)).then(
      () => false,
      () => true,
    );
    await delay(120);
    await device.disconnect();
    expect(await streaming).toBe(true);
    expect(remote.state.recording).toBe(false);
    await device.connect();
    await device.voiceStart();
    await device.voiceStop();
  });

  it.each([
    Buffer.from([0x89, 126, 0, 126]), // forbidden extended control length
    Buffer.from([0x09, 0]), // fragmented ping
    Buffer.from([0xc2, 0]), // reserved bits
    Buffer.from([0x82, 127, 0, 0, 0, 1, 0, 0, 0, 0]), // announced >4GiB
    Buffer.from([0x88, 1, 0]), // impossible close payload
  ])("rejects malformed inbound framing and releases recorder", async (rawFrame) => {
    const { device, remote, voice } = await setup();
    voice.faults.push({ rawFrame });
    const result = await (async () => {
      await device.voiceStart();
      await device.voiceStreamPcm(new Uint8Array(32000));
    })().then(
      () => false,
      () => true,
    );
    expect(result).toBe(true);
    expect(remote.state.recording).toBe(false);
  });

  it("remote close during audio is failure, never successful truncated delivery", async () => {
    const { device, remote, voice } = await setup();
    voice.faults.push({ closeAfterBytes: 3200 });
    await device.voiceStart();
    await expect(device.voiceStreamPcm(new Uint8Array(32000))).rejects.toThrow();
    expect(remote.state.recording).toBe(false);
  });

  it("bounds ignored close and surfaces stop failure without leaking voice socket", async () => {
    const { device, remote, voice } = await setup({ timeoutMs: 250 });
    voice.faults.push({ ignoreClose: true });
    await device.voiceStart();
    remote.faults.push({ path: "/v1/FireTV/voiceCommand?action=stop", status: 500 });
    const start = performance.now();
    await expect(device.voiceStop()).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(1500);
    expect(voice.sessions[0]!.closed).toBe(true);
    // HTTP failure means receiver recording cannot be promised stopped; disconnect retries cleanup.
    await device.disconnect();
    expect(remote.state.recording).toBe(false);
  });

  it("retains byte order when receiver temporarily stops reading", async () => {
    const { device, voice } = await setup();
    const pcm = await fixturePcm();
    voice.faults.push({ pauseMs: 250 });
    await device.voiceStart();
    await device.voiceStreamPcm(pcm);
    await device.voiceStop();
    expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(pcm);
    expect(voice.sessions[0]!.errors).toEqual([]);
  }, 8000);
});

it("handles fragmented inbound metadata and interleaved ping without corrupting PCM", async () => {
  const { device, remote, voice } = await setup();
  voice.faults.push({
    rawFrame: Buffer.from([
      0x01,
      2,
      0x6f,
      0x6b, // nonfinal text metadata
      0x89,
      1,
      0x78, // ping between fragments
      0x80,
      0, // final continuation
    ]),
  });
  await device.voiceStart();
  await device.voiceStreamPcm(Buffer.from([1, 2, 3, 4]));
  await device.voiceStop();
  expect(Buffer.concat(voice.sessions[0]!.pcm)).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(voice.sessions[0]!.pong).toContainEqual(Buffer.from("x"));
  expect(remote.state.recording).toBe(false);
});
