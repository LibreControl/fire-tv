import dgram from "node:dgram";
import os from "node:os";
import type { DiscoverFireTvOptions, FireTvDiscoveryResult } from "../types.js";

const SERVICE = "_amzn-fireTv._tcp.local.";
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;

type RecordData = string | Buffer | { port: number; target: string };
interface MdnsRecord {
  name: string;
  type: number;
  data: RecordData;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

export function localNetworkAddresses(): string[] {
  return [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter((address): address is os.NetworkInterfaceInfo => Boolean(address))
        .filter((address) => address.family === "IPv4" && !address.internal)
        .map((address) => address.address),
    ),
  ];
}

export async function discoverFireTv(
  options: DiscoverFireTvOptions = {},
): Promise<FireTvDiscoveryResult[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const port = options.mdnsPort ?? MDNS_PORT;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
    throw new Error("Invalid Fire TV discovery timeout");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid Fire TV mDNS port");
  }
  const interfaces = options.networkInterfaces ?? localNetworkAddresses();
  const records = (
    await Promise.all(
      (interfaces.length ? [...new Set(interfaces)] : [undefined]).map((address) =>
        discoverOnInterface(address, options.mdnsAddress ?? MDNS_ADDRESS, port, timeoutMs),
      ),
    )
  ).flat();
  return buildResults(records);
}

function discoverOnInterface(
  networkInterface: string | undefined,
  destination: string,
  port: number,
  timeoutMs: number,
): Promise<MdnsRecord[]> {
  // Node 20 does not provide Promise.withResolvers; keep the supported executor API.
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const records: MdnsRecord[] = [];
    const recordKeys = new Set<string>();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // An unbound socket can fail before listening.
      }
      resolve(records);
    };
    // Bound the entire operation, including bind/send and subsequent socket errors.
    const timer = setTimeout(finish, timeoutMs);
    socket.on("error", finish);
    socket.on("message", (message) => {
      if (finished) return;
      const parsed = parseResponse(message);
      // Repeated announcements must not consume the bounded record budget.
      for (const record of parsed) {
        const data = Buffer.isBuffer(record.data)
          ? record.data.toString("hex")
          : typeof record.data === "string"
            ? record.type === 12
              ? normalize(record.data)
              : record.data
            : [record.data.port, normalize(record.data.target)];
        const key = JSON.stringify([normalize(record.name), record.type, data]);
        if (recordKeys.has(key) || records.length >= 16384) continue;
        recordKeys.add(key);
        records.push(record);
      }
    });
    socket.once("listening", () => {
      if (finished) return;
      if (destination === MDNS_ADDRESS) {
        try {
          socket.setMulticastTTL(255);
          socket.setMulticastLoopback(true);
          if (networkInterface) socket.setMulticastInterface(networkInterface);
          socket.addMembership(MDNS_ADDRESS, networkInterface);
        } catch {
          // Unicast replies can still work without multicast membership.
        }
      }
      socket.send(createQuery(), port, destination, (error) => {
        if (error) finish();
      });
    });
    try {
      socket.bind({ address: networkInterface, port: 0 });
    } catch {
      finish();
    }
  });
}

function createQuery(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const labels = SERVICE.replace(/\.$/, "")
    .split(".")
    .map((label) => {
      const bytes = Buffer.from(label);
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  const question = Buffer.alloc(4);
  question.writeUInt16BE(12, 0);
  question.writeUInt16BE(0x8001, 2); // IN class, request unicast response to ephemeral port.
  return Buffer.concat([header, ...labels, Buffer.from([0]), question]);
}

function readName(
  message: Buffer,
  start: number,
  boundary = message.length,
): { name: string; offset: number } {
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = start;
  let next: number | undefined;
  let expandedLength = 1;
  let end = boundary;
  while (true) {
    if (offset >= end || visited.has(offset) || visited.size >= 128) {
      throw new Error("Invalid or excessively compressed DNS name");
    }
    visited.add(offset);
    const length = message[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 2 > end) throw new Error("Truncated DNS pointer");
      next ??= offset + 2;
      const pointer = ((length & 0x3f) << 8) | message[offset + 1];
      if (pointer >= message.length) throw new Error("Invalid DNS pointer");
      offset = pointer;
      end = message.length;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new Error("Invalid DNS label");
    offset += 1;
    if (length === 0) return { name: `${labels.join(".")}.`, offset: next ?? offset };
    if (offset + length > end) throw new Error("Truncated DNS label");
    expandedLength += length + 1;
    if (expandedLength > 255) throw new Error("Oversized DNS name");
    labels.push(message.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }
}

function parseResponse(message: Buffer): MdnsRecord[] {
  try {
    if (message.length < 12 || (message.readUInt16BE(2) & 0x8000) === 0) return [];
    let offset = 12;
    const questions = message.readUInt16BE(4);
    const count = message.readUInt16BE(6) + message.readUInt16BE(8) + message.readUInt16BE(10);
    if (questions + count > 4096) return [];
    for (let index = 0; index < questions; index += 1) {
      offset = readName(message, offset).offset + 4;
      if (offset > message.length) throw new Error("Truncated DNS question");
    }
    const records: MdnsRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = readName(message, offset);
      offset = name.offset;
      if (offset + 10 > message.length) throw new Error("Truncated DNS record");
      const type = message.readUInt16BE(offset);
      const classCode = message.readUInt16BE(offset + 2) & 0x7fff;
      const ttl = message.readUInt32BE(offset + 4);
      const length = message.readUInt16BE(offset + 8);
      offset += 10;
      const end = offset + length;
      if (end > message.length) throw new Error("Truncated DNS data");
      let data: RecordData | undefined;
      if (type === 12) {
        const ptr = readName(message, offset, end);
        if (ptr.offset !== end) throw new Error("Invalid DNS PTR length");
        data = ptr.name;
      } else if (type === 33) {
        if (length < 7) throw new Error("Truncated DNS SRV");
        const target = readName(message, offset + 6, end);
        if (target.offset !== end) throw new Error("Invalid DNS SRV length");
        data = { port: message.readUInt16BE(offset + 4), target: target.name };
      } else if (type === 1 && length === 4) {
        data = [...message.subarray(offset, end)].join(".");
      } else if (type === 28 && length === 16) {
        const groups: string[] = [];
        for (let at = offset; at < end; at += 2) groups.push(message.readUInt16BE(at).toString(16));
        data = groups.join(":");
      } else if (type === 16) {
        data = message.subarray(offset, end);
        parseTxt(data); // Validate now so malformed packets are discarded atomically.
      }
      if (data !== undefined && classCode === 1 && ttl > 0)
        records.push({ name: name.name, type, data });
      offset = end;
    }
    return records;
  } catch {
    return []; // A malformed datagram must not poison other responses.
  }
}

function parseTxt(data: Buffer): Record<string, string | true> {
  const txt: Record<string, string | true> = Object.create(null);
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset++];
    if (offset + length > data.length) throw new Error("Truncated DNS TXT");
    const value = data.subarray(offset, offset + length).toString("utf8");
    offset += length;
    if (!value) continue;
    const equals = value.indexOf("=");
    const key = equals === -1 ? value : value.slice(0, equals);
    if (key) txt[key] = equals === -1 ? true : value.slice(equals + 1);
  }
  return txt;
}

function buildResults(records: MdnsRecord[]): FireTvDiscoveryResult[] {
  const targets = new Map<string, string>();
  const services = new Map<string, { port: number; target: string }>();
  const addressesByTarget = new Map<string, Set<string>>();
  const txtByService = new Map<string, Record<string, string | true>>();
  for (const record of records) {
    const name = normalize(record.name);
    if (record.type === 12 && name === normalize(SERVICE) && typeof record.data === "string") {
      targets.set(normalize(record.data), record.data);
    } else if (
      record.type === 33 &&
      typeof record.data === "object" &&
      !Buffer.isBuffer(record.data)
    ) {
      services.set(name, record.data);
    } else if ((record.type === 1 || record.type === 28) && typeof record.data === "string") {
      let addresses = addressesByTarget.get(name);
      if (!addresses) addressesByTarget.set(name, (addresses = new Set()));
      addresses.add(record.data);
    } else if (record.type === 16 && Buffer.isBuffer(record.data)) {
      let txt = txtByService.get(name);
      if (!txt) {
        txt = Object.create(null) as Record<string, string | true>;
        txtByService.set(name, txt);
      }
      Object.assign(txt, parseTxt(record.data));
    }
  }
  const results: FireTvDiscoveryResult[] = [];
  for (const [id, serviceName] of targets) {
    const srv = services.get(id);
    if (!srv || srv.port === 0) continue;
    const addresses = [...(addressesByTarget.get(normalize(srv.target)) ?? [])];
    const txt: Record<string, string | true> = txtByService.get(id) ?? Object.create(null);
    const instance = serviceName.slice(0, -(SERVICE.length + 1)).replace(/\\032/g, " ");
    const advertisedName = txt.friendlyName ?? txt.name;
    results.push({
      id,
      name: typeof advertisedName === "string" ? advertisedName : instance || "Fire TV",
      host:
        addresses.find((address) => !address.includes(":")) ??
        addresses[0] ??
        srv.target.replace(/\.$/, ""),
      port: srv.port,
      serviceName,
      addresses,
      txt,
    });
  }
  return results;
}
