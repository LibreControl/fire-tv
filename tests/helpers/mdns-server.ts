import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";

// Hand-authored DNS wire encoding, independent of production discovery/parser.
const service = "_amzn-fireTv._tcp.local";
const instance = `Synthetic Lounge.${service}`;
const hostname = "synthetic-fire-tv.local";
function u16(value: number) {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}
function name(value: string) {
  return Buffer.concat([
    ...value
      .split(".")
      .map((label) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}
function record(owner: Buffer, type: number, data: Buffer) {
  return Buffer.concat([
    owner,
    u16(type),
    u16(0x8001),
    Buffer.from([0, 0, 0, 120]),
    u16(data.length),
    data,
  ]);
}
function packet(records: Buffer[]) {
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0]),
    u16(0),
    u16(records.length),
    u16(0),
    u16(0),
    ...records,
  ]);
}
function txt(values: string[]) {
  return Buffer.concat(
    values.map((value) =>
      Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]),
    ),
  );
}

export async function startMdnsServer(
  options: { silent?: boolean; saturated?: boolean; remotePort?: number } = {},
) {
  const socket = createSocket("udp4");
  const sendErrors: Error[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // PTR owner begins at offset 12, instance's suffix points back to that owner.
  const ptr = packet([
    record(
      name(service),
      12,
      Buffer.concat([Buffer.from([16]), Buffer.from("Synthetic Lounge"), Buffer.from([0xc0, 12])]),
    ),
  ]);
  const details = packet([
    record(
      name(instance),
      33,
      Buffer.concat([u16(0), u16(0), u16(options.remotePort ?? 18080), name(hostname)]),
    ),
    record(name(instance), 16, txt(["id=synthetic-serial", "model=AFTMA08C15", "flag"])),
  ]);
  const address = packet([record(name(hostname), 1, Buffer.from([127, 0, 0, 1]))]);
  const ipv6 = packet([
    record(name(hostname), 28, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
  ]);
  const loop = packet([record(Buffer.from([0xc0, 12]), 12, Buffer.from([0xc0, 12]))]);
  const pointer = (offset: number) => u16(0xc000 | offset);
  const firstPtr = record(
    name(service),
    12,
    Buffer.concat([Buffer.from([16]), Buffer.from("Synthetic Lounge"), pointer(12)]),
  );
  const instanceOffset = 12 + name(service).length + 10;
  const duplicate = record(pointer(12), 12, pointer(instanceOffset));
  // Keep datagrams below a typical MTU and platform UDP send-size limits.
  // Each packet includes its own compression targets. Sixty-four records per
  // packet can fill the 16,384-record budget exactly, and later packets keep
  // saturating it before the legitimate SRV/TXT/address records arrive.
  const saturated = Array.from({ length: 280 }, () =>
    packet([firstPtr, ...Array.from({ length: 63 }, () => duplicate)]),
  );
  const chainOffset = 12 + 2 + 10 + name(instance).length;
  const chain = Buffer.concat(
    Array.from({ length: 512 }, (_, index) => pointer(chainOffset + 2 + index * 2)),
  );
  const deep = Buffer.concat([
    packet([record(pointer(chainOffset), 12, name(instance))]),
    chain,
    name(service),
  ]);
  socket.on("message", (message, remote) => {
    // Existing mDNS-only tests direct SSDP here too, never onto the real LAN.
    if (message.toString("ascii", 0, 8) === "M-SEARCH") return;
    if (options.silent) return;
    // Intentionally malformed before/between valid split replies; duplicate announcements.
    const packets = options.saturated
      ? [deep, ...saturated, details, address]
      : [Buffer.from([0, 1, 2]), loop, ptr, details, address, ipv6, ptr, details, address];
    packets.forEach((response, index) => {
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          socket.send(response, remote.port, remote.address, (error) => {
            if (error) sendErrors.push(error);
          });
        },
        options.saturated ? Math.floor(index / 16) * 2 : index * 5,
      );
      timers.add(timer);
    });
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    options: {
      mdnsAddress: "127.0.0.1",
      mdnsPort: (socket.address() as AddressInfo).port,
      ssdpAddress: "127.0.0.1",
      ssdpPort: (socket.address() as AddressInfo).port,
      timeoutMs: 150,
      networkInterfaces: ["127.0.0.1"],
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      if (sendErrors.length) throw new AggregateError(sendErrors, "mDNS fixture failed to send");
    },
  };
}
