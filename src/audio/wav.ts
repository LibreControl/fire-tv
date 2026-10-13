const invalidWav = (): Error => new Error("invalid voice WAV: expected complete RIFF/WAVE audio");

/** Extract a view of mono 16 kHz signed 16-bit little-endian PCM from a WAV file. */
export function extractVoiceWavPcm(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 12) throw invalidWav();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasTag = (offset: number, tag: string): boolean => {
    for (let index = 0; index < 4; index++) {
      if (bytes[offset + index] !== tag.charCodeAt(index)) return false;
    }
    return true;
  };
  if (!hasTag(0, "RIFF") || !hasTag(8, "WAVE")) throw invalidWav();
  const end = view.getUint32(4, true) + 8;
  if (end !== bytes.byteLength) throw invalidWav();

  let formatFound = false;
  let samples: Uint8Array | undefined;
  let offset = 12;
  while (offset < end) {
    if (end - offset < 8) throw invalidWav();
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const next = start + size + (size & 1);
    if (next > end) throw invalidWav();
    if (hasTag(offset, "fmt ")) {
      if (formatFound || size < 16) throw invalidWav();
      formatFound = true;
      if (
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint32(start + 4, true) !== 16000 ||
        view.getUint32(start + 8, true) !== 32000 ||
        view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16
      ) {
        throw new Error("unsupported voice WAV: use PCM mono 16000 Hz 16-bit little-endian audio");
      }
    } else if (hasTag(offset, "data")) {
      if (samples || size === 0 || (size & 1) !== 0) throw invalidWav();
      samples = bytes.subarray(start, start + size);
    }
    offset = next;
  }
  if (!formatFound || !samples) throw invalidWav();
  return samples;
}
