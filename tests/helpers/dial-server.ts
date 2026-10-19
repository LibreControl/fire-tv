import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const dialUuid = "8338a484-3a63-3e89-8d0d-8642ee85f305";

// Captured device shape; independent of the production SSDP/XML implementation.
export function dialDescription(
  options: {
    name?: string;
    manufacturer?: string;
    model?: string;
    udn?: string;
  } = {},
) {
  return `<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:r="urn:restful-tv-org:schemas:upnp-dd"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:tvdevice:1</deviceType><friendlyName>${options.name ?? "Utkarsh's Fire TV Stick"}</friendlyName><manufacturer>${options.manufacturer ?? "Amazon"}</manufacturer><modelName>${options.model ?? "AFTMA08C15"}</modelName><UDN>${options.udn ?? `uuid:${dialUuid}`}</UDN></device></root>`;
}

export function dialReply(location: string) {
  return `HTTP/1.1 200 OK\r\nST: urn:dial-multiscreen-org:service:dial:1\r\nUSN: uuid:${dialUuid}::urn:dial-multiscreen-org:service:dial:1\r\nLOCATION: ${location}\r\nCACHE-CONTROL: max-age=1800\r\n\r\n`;
}

interface DescriptionResponse {
  body?: string;
  status?: number;
  location?: string;
  stall?: boolean;
}

export async function startDialServer(
  options: {
    descriptions?: Record<string, DescriptionResponse>;
    replies?: (origin: string) => string[];
  } = {},
) {
  const requests: { method: string; path: string }[] = [];
  const sendErrors: Error[] = [];
  const http = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ method: request.method ?? "", path });
    const description =
      options.descriptions?.[path] ??
      (path === "/dd.xml" ? { body: dialDescription() } : undefined);
    if (!description) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (description.stall) return;
    response.writeHead(description.status ?? 200, {
      "content-type": "text/xml; charset=utf-8",
      ...(description.location === undefined ? {} : { location: description.location }),
    });
    response.end(description.body ?? "");
  });
  // A wildcard listener lets negative controls catch a forbidden GET to 127.0.0.2.
  await new Promise<void>((resolve) => http.listen(0, "0.0.0.0", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const socket = createSocket("udp4");
  socket.on("message", (message, remote) => {
    // A DIAL receiver does not answer mDNS or unrelated SSDP searches.
    const query = message.toString("utf8");
    if (
      !/^M-SEARCH \* HTTP\/1\.1\r\n/iu.test(query) ||
      !/\r\nST:\s*urn:dial-multiscreen-org:service:dial:1\r\n/iu.test(query)
    )
      return;
    for (const reply of options.replies?.(origin) ?? [dialReply(`${origin}/dd.xml`)]) {
      socket.send(reply, remote.port, remote.address, (error) => {
        if (error) sendErrors.push(error);
      });
    }
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    origin,
    requests,
    options: {
      ssdpAddress: "127.0.0.1",
      ssdpPort: (socket.address() as AddressInfo).port,
      mdnsAddress: "127.0.0.1",
      mdnsPort: (socket.address() as AddressInfo).port,
      networkInterfaces: ["127.0.0.1"],
      timeoutMs: 250,
    },
    async close() {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const closed = new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
      http.closeAllConnections();
      await closed;
      if (sendErrors.length) throw new AggregateError(sendErrors, "DIAL fixture failed to send");
    },
  };
}
