import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { discoverFireTv } from "../src/index.js";
import { startMdnsServer } from "./helpers/mdns-server.js";

function questionClass(message: Buffer): number {
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) offset += 1 + message[offset]!;
  return message.readUInt16BE(offset + 3);
}

describe("native discovery over actual localhost UDP", () => {
  it("aggregates compressed split DNS records, ignores malformed packets and deduplicates announcements", async () => {
    const server = await startMdnsServer();
    try {
      const found = await discoverFireTv(server.options);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        name: "Synthetic Lounge",
        host: "127.0.0.1",
        port: 18080,
        serviceName: expect.stringMatching(/^Synthetic Lounge\._amzn-fireTv\._tcp\.local\.?$/u),
        txt: { id: "synthetic-serial", model: "AFTMA08C15", flag: true },
      });
      expect(found[0]?.id).toBeTruthy();
      expect(found[0]?.addresses).toContain("127.0.0.1");
      expect(new Set(found[0]?.addresses).size).toBe(found[0]?.addresses.length);
      expect(server.queries.length).toBeGreaterThan(0);
      expect(server.queries[0]?.readUInt16BE(4)).toBeGreaterThan(0);
      expect(questionClass(server.queries[0]!) & 0x8000).toBe(0x8000);
      const again = await discoverFireTv(server.options);
      expect(again.map((device) => device.id)).toEqual(found.map((device) => device.id));
    } finally {
      await server.close();
    }
  });

  it("remains bounded and useful under saturated duplicates and a deep acyclic compression chain", async () => {
    const server = await startMdnsServer({ saturated: true });
    try {
      const started = Date.now();
      const found = await discoverFireTv({ ...server.options, timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        host: "127.0.0.1",
        port: 18080,
        txt: { model: "AFTMA08C15" },
      });
    } finally {
      await server.close();
    }
  });

  it("lets a standalone discovery program exit with no lingering socket or timer", async () => {
    const server = await startMdnsServer({ silent: true });
    try {
      const options = { ...server.options, timeoutMs: 40 };
      const program = `import {discoverFireTv} from './src/index.ts'; console.log(JSON.stringify(await discoverFireTv(${JSON.stringify(options)})));`;
      const result = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          timeout: 5000,
        },
      );
      expect(JSON.parse(result.stdout)).toEqual([]);
    } finally {
      await server.close();
    }
  }, 10000);

  it("times out quietly with no receiver and releases its ephemeral socket", async () => {
    const server = await startMdnsServer({ silent: true });
    try {
      const start = Date.now();
      expect(await discoverFireTv({ ...server.options, timeoutMs: 40 })).toEqual([]);
      expect(Date.now() - start).toBeLessThan(1500);
      expect(await discoverFireTv({ ...server.options, timeoutMs: 40 })).toEqual([]);
      expect(server.queries.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });
});
