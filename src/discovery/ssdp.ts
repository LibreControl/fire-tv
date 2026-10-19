import dgram from "node:dgram";
import http from "node:http";
import { isIP } from "node:net";
import type { DiscoverFireTvOptions, FireTvDiscoveryResult } from "../types.js";

const SSDP_ADDRESS = "239.255.255.250";
const DIAL_SERVICE = "urn:dial-multiscreen-org:service:dial:1";
const MAX_CANDIDATES = 64;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_DESCRIPTION_BYTES = 64 * 1024;
const DESCRIPTION_TIMEOUT_MS = 1500;

interface Candidate {
  url: URL;
  host: string;
  localAddress: string | undefined;
}

/** SSDP only locates descriptors: discovery never starts a DIAL application. */
export function discoverSsdp(
  options: DiscoverFireTvOptions,
  interfaces: string[],
  port: number,
  deadline: number,
): Promise<FireTvDiscoveryResult[]> {
  return new Promise((resolve) => {
    const sockets: dgram.Socket[] = [];
    const requests = new Set<http.ClientRequest>();
    const candidates = new Set<string>();
    const queue: Candidate[] = [];
    const results: FireTvDiscoveryResult[] = [];
    const destination = options.ssdpAddress ?? SSDP_ADDRESS;
    let active = 0;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      queue.length = 0;
      for (const request of requests) request.destroy();
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          /* Binding may have failed. */
        }
      }
      resolve(results);
    };
    const timer = setTimeout(finish, Math.max(0, deadline - performance.now()));
    const drain = (): void => {
      while (!finished && active < MAX_CONCURRENT_REQUESTS && queue.length) {
        if (performance.now() >= deadline) return finish();
        const candidate = queue.shift()!;
        active += 1;
        void readDescription(candidate, deadline, requests)
          .then((result) => {
            if (!finished && performance.now() < deadline && result) results.push(result);
          })
          .finally(() => {
            active -= 1;
            drain();
          });
      }
    };
    const query = Buffer.from(
      [
        "M-SEARCH * HTTP/1.1",
        `HOST: ${destination}:${port}`,
        'MAN: "ssdp:discover"',
        "MX: 1",
        `ST: ${DIAL_SERVICE}`,
        "",
        "",
      ].join("\r\n"),
    );
    for (const localAddress of interfaces.length ? interfaces : [undefined]) {
      if (performance.now() >= deadline) break;
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(socket);
      socket.on("error", () => {
        try {
          socket.close();
        } catch {
          /* Already closed. */
        }
      });
      socket.on("message", (message, sender) => {
        if (finished || candidates.size >= MAX_CANDIDATES) return;
        const url = parseLocation(message, sender.address);
        if (!url || candidates.has(url.href)) return;
        candidates.add(url.href);
        queue.push({ url, host: sender.address, localAddress });
        drain();
      });
      socket.once("listening", () => {
        if (finished) return;
        try {
          if (destination === SSDP_ADDRESS) {
            socket.setMulticastTTL(2);
            if (localAddress) socket.setMulticastInterface(localAddress);
          }
          socket.send(query, port, destination, () => {});
        } catch {
          try {
            socket.close();
          } catch {
            /* Already closed. */
          }
        }
      });
      try {
        socket.bind({ address: localAddress, port: 0 });
      } catch {
        try {
          socket.close();
        } catch {
          /* Unbound socket. */
        }
      }
    }
  });
}

function parseLocation(message: Buffer, sender: string): URL | undefined {
  if (message.length > 8192 || !isIP(sender)) return;
  const lines = message.toString("utf8").split("\r\n");
  if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(lines.shift() ?? "")) return;
  const headers: Record<string, string> = Object.create(null);
  for (const line of lines) {
    if (!line) break;
    const colon = line.indexOf(":");
    if (colon < 1) return;
    const key = line.slice(0, colon).toLowerCase();
    if (headers[key] !== undefined) return;
    headers[key] = line.slice(colon + 1).trim();
  }
  if (headers.st?.toLowerCase() !== DIAL_SERVICE || !headers.location) return;
  try {
    // Check the literal authority too: WHATWG URL normalizes hex/integer IPv4 forms.
    const authority = /^http:\/\/([^/?#]+)/i.exec(headers.location)?.[1];
    if (!authority || !/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(authority)) return;
    const literalHost = authority.split(":")[0];
    const url = new URL(headers.location);
    if (
      isIP(literalHost) !== 4 ||
      literalHost !== sender ||
      url.hostname !== sender ||
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.hash
    )
      return;
    return url;
  } catch {
    return;
  }
}

function readDescription(
  candidate: Candidate,
  deadline: number,
  requests: Set<http.ClientRequest>,
): Promise<FireTvDiscoveryResult | undefined> {
  return new Promise((resolve) => {
    let request: http.ClientRequest | undefined;
    let finished = false;
    const finish = (result?: FireTvDiscoveryResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (request) {
        requests.delete(request);
        request.destroy();
      }
      resolve(result);
    };
    const timer = setTimeout(
      finish,
      Math.max(0, Math.min(DESCRIPTION_TIMEOUT_MS, deadline - performance.now())),
    );
    try {
      request = http.get(
        candidate.url,
        {
          agent: false,
          localAddress: candidate.localAddress,
          maxHeaderSize: 8192,
          headers: { Accept: "application/xml, text/xml", Connection: "close" },
        },
        (response) => {
          // Node's HTTP client does not follow redirects.
          if (
            response.statusCode !== 200 ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity") ||
            Number(response.headers["content-length"]) > MAX_DESCRIPTION_BYTES
          ) {
            response.destroy();
            finish();
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_DESCRIPTION_BYTES) {
              response.destroy();
              finish();
            } else chunks.push(chunk);
          });
          response.on("error", () => finish());
          response.on("aborted", () => finish());
          response.on("end", () => {
            if (finished) return;
            const description = parseDescription(Buffer.concat(chunks, bytes).toString("utf8"));
            if (!description) return finish();
            const uuid = /^uuid:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(
              description.UDN ?? "",
            );
            const id = uuid ? `uuid:${uuid[1].toLowerCase()}` : `fire-tv:${candidate.host}:8080`;
            finish({
              id,
              name: description.friendlyName || "Fire TV",
              host: candidate.host,
              port: 8080,
              serviceName: DIAL_SERVICE,
              addresses: [candidate.host],
              txt: { manufacturer: description.manufacturer, modelName: description.modelName },
            });
          });
        },
      );
      requests.add(request);
      request.on("error", () => finish());
      request.on("close", () => finish());
    } catch {
      finish();
    }
  });
}

function decodeXml(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) {
    throw new Error("Invalid XML entity");
  }
  const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    if (predefined[entity] !== undefined) return predefined[entity];
    const point = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(
      point === 9 ||
      point === 10 ||
      point === 13 ||
      (point >= 0x20 && point <= 0xd7ff) ||
      (point >= 0xe000 && point <= 0xfffd) ||
      (point >= 0x10000 && point <= 0x10ffff)
    ))
      throw new Error("Invalid XML character");
    return String.fromCodePoint(point);
  });
}

/** A bounded, non-expanding XML reader for direct UPnP root/device properties. */
function parseDescription(xml: string): Record<string, string> | undefined {
  try {
    const stack: { name: string; text: string; child: boolean }[] = [];
    const fields: Record<string, string> = Object.create(null);
    let offset = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
    let nodes = 0;
    let roots = 0;
    let devices = 0;
    const localName = (name: string): string => name.split(":").pop()!;
    const append = (text: string): void => {
      if (stack.length) stack[stack.length - 1].text += text;
      else if (text.trim()) throw new Error("Text outside XML root");
    };
    while (offset < xml.length) {
      if (xml[offset] !== "<") {
        const end = xml.indexOf("<", offset);
        const stop = end < 0 ? xml.length : end;
        append(decodeXml(xml.slice(offset, stop)));
        offset = stop;
        continue;
      }
      if (xml.startsWith("<!--", offset)) {
        const end = xml.indexOf("-->", offset + 4);
        if (end < 0 || xml.slice(offset + 4, end).includes("--")) return;
        offset = end + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", offset)) {
        const end = xml.indexOf("]]>", offset + 9);
        if (end < 0 || !stack.length) return;
        append(xml.slice(offset + 9, end));
        offset = end + 3;
        continue;
      }
      if (xml.startsWith("<?", offset)) {
        const end = xml.indexOf("?>", offset + 2);
        if (end < 0) return;
        offset = end + 2;
        continue;
      }
      // DTDs, entity declarations, and other markup declarations are forbidden.
      if (xml.startsWith("<!", offset)) return;
      const match =
        /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(
          xml.slice(offset),
        );
      if (!match || ++nodes > 2048) return;
      offset += match[0].length;
      const [, closing, name, attributes, selfClosing] = match;
      decodeXml(attributes);
      if (closing) {
        if (attributes || selfClosing) return;
        const element = stack.pop();
        if (!element || element.name !== name) return;
        if (
          stack.length === 2 &&
          localName(stack[0].name) === "root" &&
          localName(stack[1].name) === "device" &&
          !element.child
        ) {
          const key = localName(name);
          if (fields[key] !== undefined) return;
          fields[key] = element.text.trim();
        }
      } else {
        if (!stack.length && (++roots !== 1 || localName(name) !== "root")) return;
        if (stack.length === 1 && localName(name) === "device" && ++devices !== 1) return;
        if (stack.length) stack[stack.length - 1].child = true;
        if (!selfClosing) stack.push({ name, text: "", child: false });
        if (stack.length > 32) return;
      }
    }
    if (
      stack.length ||
      roots !== 1 ||
      devices !== 1 ||
      fields.manufacturer?.toLowerCase() !== "amazon" ||
      !/^AFT/.test(fields.modelName ?? "")
    )
      return;
    return fields;
  } catch {
    return;
  }
}
