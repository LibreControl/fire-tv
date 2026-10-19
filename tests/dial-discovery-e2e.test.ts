import { describe, expect, it } from "vitest";
import { discoverFireTv } from "../src/index.js";
import { dialDescription, dialReply, dialUuid, startDialServer } from "./helpers/dial-server.js";
import { startMdnsServer } from "./helpers/mdns-server.js";

describe("Fire TV DIAL discovery over loopback UDP and HTTP", () => {
  it("finds the observed Amazon AFT descriptor without activating the remote service", async () => {
    const server = await startDialServer();
    try {
      const found = await discoverFireTv(server.options);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        id: `uuid:${dialUuid}`,
        name: "Utkarsh's Fire TV Stick",
        host: "127.0.0.1",
        addresses: ["127.0.0.1"],
        port: 8080,
      });
      expect(server.requests.length).toBeGreaterThan(0);
      expect(
        server.requests.every(({ method, path }) => method === "GET" && path === "/dd.xml"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it.each([
    { manufacturer: "Roku", model: "AFTMA08C15" },
    { manufacturer: "Amazon", model: "Echo Show" },
    { manufacturer: "Google", model: "Chromecast" },
  ])("does not mistake $manufacturer $model for a Fire TV", async (device) => {
    const server = await startDialServer({
      descriptions: { "/dd.xml": { body: dialDescription(device) } },
    });
    try {
      expect(await discoverFireTv(server.options)).toEqual([]);
      expect(server.requests).toContainEqual({ method: "GET", path: "/dd.xml" });
    } finally {
      await server.close();
    }
  });

  it("decodes escaped Unicode names and keeps UUID identity stable across repeated duplicate replies", async () => {
    const server = await startDialServer({
      descriptions: {
        "/dd.xml": {
          body: dialDescription({
            name: "B&#233;a &amp; Zo&#xEB;&apos;s &lt;TV&gt; &quot;Den&quot;",
            udn: `uuid:${dialUuid.toUpperCase()}`,
          }),
        },
      },
      replies: (origin) => Array.from({ length: 20 }, () => dialReply(`${origin}/dd.xml`)),
    });
    try {
      const first = await discoverFireTv(server.options);
      const second = await discoverFireTv(server.options);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        name: 'Béa & Zoë\'s <TV> "Den"',
        id: `uuid:${dialUuid}`,
        host: "127.0.0.1",
        port: 8080,
      });
      expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    } finally {
      await server.close();
    }
  });

  it.each([8080, 18080])(
    "merges only equal host/remote-port endpoints with mDNS port %i",
    async (remotePort) => {
      const mdns = await startMdnsServer({ remotePort });
      const dial = await startDialServer();
      try {
        const found = await discoverFireTv({
          ...mdns.options,
          ssdpAddress: dial.options.ssdpAddress,
          ssdpPort: dial.options.ssdpPort,
          timeoutMs: 250,
        });
        expect(found).toHaveLength(remotePort === 8080 ? 1 : 2);
        expect(found.map(({ host, port }) => `${host}:${port}`).sort()).toEqual(
          remotePort === 8080 ? ["127.0.0.1:8080"] : ["127.0.0.1:18080", "127.0.0.1:8080"],
        );
        expect(dial.requests).toContainEqual({ method: "GET", path: "/dd.xml" });
      } finally {
        await Promise.all([mdns.close(), dial.close()]);
      }
    },
  );

  it("ignores malformed and unrelated SSDP replies without losing a valid candidate", async () => {
    const server = await startDialServer({
      replies: (origin) => [
        "not an HTTP response",
        "HTTP/1.1 200 OK\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n",
        dialReply(`${origin}/bad-status`).replace("200 OK", "404 Not Found"),
        dialReply(`${origin}/wrong-service`).replaceAll(
          "urn:dial-multiscreen-org:service:dial:1",
          "urn:schemas-upnp-org:device:MediaRenderer:1",
        ),
        dialReply(`${origin}/dd.xml`),
      ],
    });
    try {
      expect(await discoverFireTv(server.options)).toHaveLength(1);
      expect(server.requests.every(({ path }) => path === "/dd.xml")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("never fetches foreign, nonnumeric, credentialed, or non-HTTP description locations", async () => {
    const server = await startDialServer({
      replies: (origin) => [
        dialReply(`${origin.replace("127.0.0.1", "127.0.0.2")}/foreign`),
        dialReply(`${origin.replace("127.0.0.1", "localhost")}/hostname`),
        dialReply(`${origin.replace("http://", "http://user:password@")}/credentials`),
        dialReply(`${origin.replace("http:", "https:")}/secure`),
      ],
    });
    try {
      expect(await discoverFireTv(server.options)).toEqual([]);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("does not follow descriptor redirects or activate a DIAL application", async () => {
    const server = await startDialServer({
      descriptions: {
        "/dd.xml": { status: 302, location: "/redirected.xml" },
        "/redirected.xml": { body: dialDescription() },
      },
    });
    try {
      expect(await discoverFireTv(server.options)).toEqual([]);
      expect(server.requests.length).toBeGreaterThan(0);
      expect(
        server.requests.every(({ method, path }) => method === "GET" && path === "/dd.xml"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it.each([
    { label: "malformed XML", body: "<root><device><manufacturer>Amazon</manufacturer>" },
    {
      label: "DTD declarations",
      body: `<!DOCTYPE root [<!ENTITY owner "Amazon">]>${dialDescription({ manufacturer: "&owner;" })}`,
    },
    { label: "undeclared entities", body: dialDescription({ name: "&owner;" }) },
    { label: "oversized descriptions", body: dialDescription({ name: "x".repeat(128 * 1024) }) },
  ])("rejects $label", async ({ body }) => {
    const server = await startDialServer({ descriptions: { "/dd.xml": { body } } });
    try {
      expect(await discoverFireTv(server.options)).toEqual([]);
      expect(server.requests).toContainEqual({ method: "GET", path: "/dd.xml" });
    } finally {
      await server.close();
    }
  });

  it("returns a healthy receiver before the shared deadline despite another stalled descriptor", async () => {
    const server = await startDialServer({
      descriptions: { "/stalled.xml": { stall: true } },
      replies: (origin) => [dialReply(`${origin}/stalled.xml`), dialReply(`${origin}/dd.xml`)],
    });
    try {
      const started = Date.now();
      const found = await discoverFireTv({ ...server.options, timeoutMs: 200 });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ host: "127.0.0.1", port: 8080 });
      expect(server.requests).toContainEqual({ method: "GET", path: "/stalled.xml" });
      expect(server.requests).toContainEqual({ method: "GET", path: "/dd.xml" });
    } finally {
      await server.close();
    }
  });

  it("bounds concurrent stalled requests and releases them at the overall discovery deadline", async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `/stalled-${index}.xml`);
    const server = await startDialServer({
      descriptions: Object.fromEntries(paths.map((path) => [path, { stall: true }])),
      replies: (origin) => paths.map((path) => dialReply(origin + path)),
    });
    try {
      const started = Date.now();
      expect(await discoverFireTv({ ...server.options, timeoutMs: 150 })).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(server.requests.length).toBeGreaterThan(0);
      expect(server.requests.length).toBeLessThanOrEqual(4);
    } finally {
      await server.close();
    }
  });
});
