import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractVoiceWavPcm } from "../src/audio/wav.js";

function chunk(name: string, bytes: Buffer) {
  const header = Buffer.alloc(8);
  header.write(name);
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, ...(bytes.length % 2 ? [Buffer.alloc(1)] : [])]);
}
function wave(
  options: {
    format?: number;
    channels?: number;
    rate?: number;
    bits?: number;
    align?: number;
    byteRate?: number;
    pcm?: Buffer;
    metadata?: boolean;
    duplicate?: string;
  } = {},
) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(options.format ?? 1, 0);
  fmt.writeUInt16LE(options.channels ?? 1, 2);
  fmt.writeUInt32LE(options.rate ?? 16000, 4);
  fmt.writeUInt32LE(options.byteRate ?? 32000, 8);
  fmt.writeUInt16LE(options.align ?? 2, 12);
  fmt.writeUInt16LE(options.bits ?? 16, 14);
  const pieces = [chunk("fmt ", fmt), chunk("data", options.pcm ?? Buffer.from([1, 2, 3, 4]))];
  if (options.metadata) pieces.unshift(chunk("JUNK", Buffer.from([9, 8, 7])));
  if (options.duplicate === "fmt") pieces.push(chunk("fmt ", fmt));
  if (options.duplicate === "data") pieces.push(chunk("data", Buffer.from([1, 2])));
  const body = Buffer.concat([Buffer.from("WAVE"), ...pieces]);
  const header = Buffer.alloc(8);
  header.write("RIFF");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("strict owned voice WAV extraction", () => {
  it("extracts only PCM audio after the converted asset's metadata chunks", async () => {
    const bytes = await readFile(new URL("./fixtures/open-youtube.wav", import.meta.url));
    const pcm = extractVoiceWavPcm(bytes);
    expect(pcm.byteLength).toBe(40960);
    expect(Buffer.from(pcm)).toEqual(bytes.subarray(4096, 45056));
  });
  it("accepts padded odd metadata and sliced Uint8Array input", () => {
    const wav = wave({ metadata: true });
    const wrapped = Buffer.concat([Buffer.from([0, 0, 0]), wav, Buffer.from([9])]);
    const bytes = wrapped.subarray(3, -1);
    const pcm = extractVoiceWavPcm(bytes);
    expect(Buffer.from(pcm)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
  it.each([
    { format: 3 },
    { channels: 2 },
    { rate: 8000 },
    { bits: 8 },
    { bits: 24 },
    { align: 4 },
    { byteRate: 16000 },
    { pcm: Buffer.alloc(0) },
    { pcm: Buffer.from([1]) },
    { duplicate: "fmt" },
    { duplicate: "data" },
  ])("rejects incompatible or ambiguous audio %j", (options) => {
    expect(() => extractVoiceWavPcm(wave(options))).toThrow();
  });
  it("rejects every truncation and malformed RIFF/chunk boundary", () => {
    const valid = wave({ metadata: true });
    for (let length = 0; length < valid.length; length++) {
      expect(() => extractVoiceWavPcm(valid.subarray(0, length))).toThrow();
    }
    for (const offset of [0, 8]) {
      const bytes = Buffer.from(valid);
      bytes[offset] = 0;
      expect(() => extractVoiceWavPcm(bytes)).toThrow();
    }
    const overflow = Buffer.from(valid);
    overflow.writeUInt32LE(0xffffffff, 16);
    expect(() => extractVoiceWavPcm(overflow)).toThrow();
    const riffOverflow = Buffer.from(valid);
    riffOverflow.writeUInt32LE(0xffffffff, 4);
    expect(() => extractVoiceWavPcm(riffOverflow)).toThrow();
    const riffShort = Buffer.from(valid);
    riffShort.writeUInt32LE(4, 4);
    expect(() => extractVoiceWavPcm(riffShort)).toThrow();
    const trailing = Buffer.concat([valid, Buffer.from([0])]);
    expect(() => extractVoiceWavPcm(trailing)).toThrow();
    const missingPad = Buffer.concat([valid.subarray(0, 23), valid.subarray(24)]);
    missingPad.writeUInt32LE(missingPad.length - 8, 4);
    expect(() => extractVoiceWavPcm(missingPad)).toThrow();
  });
  it("rejects absent fmt/data chunks and tiny fmt payloads", () => {
    for (const body of [
      chunk("JUNK", Buffer.alloc(4)),
      chunk("fmt ", Buffer.alloc(15)),
      chunk("data", Buffer.alloc(2)),
    ]) {
      const header = Buffer.alloc(12);
      header.write("RIFF");
      header.writeUInt32LE(body.length + 4, 4);
      header.write("WAVE", 8);
      expect(() => extractVoiceWavPcm(Buffer.concat([header, body]))).toThrow();
    }
  });
});
