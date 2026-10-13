import http from "node:http";
import https from "node:https";

export class FireTvError extends Error {
  constructor(
    message: string,
    readonly code: "http" | "network" | "timeout" | "cancelled" | "protocol" | "state",
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "FireTvError";
  }
}

export interface RequestOptions {
  host: string;
  port: number;
  path: string;
  method: "GET" | "POST";
  timeoutMs: number;
  protocol?: "http" | "https";
  rejectUnauthorized?: boolean;
  signal: AbortSignal;
  clientToken?: string;
  body?: unknown;
  dial?: boolean;
}

/** Never include response bodies, credentials, or underlying error messages in errors. */
export function request(options: RequestOptions): Promise<string> {
  // Node 20 compatibility: Promise.withResolvers is not available on the minimum runtime.
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new FireTvError("Fire TV request cancelled", "cancelled"));
      return;
    }
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const headers: Record<string, string | number> = {
      "Content-Type": options.dial ? "text/plain" : "application/json; charset=utf-8",
    };
    if (!options.dial) headers["x-api-key"] = "0987654321";
    if (options.clientToken !== undefined) headers["x-client-token"] = options.clientToken;
    if (options.method === "POST") headers["Content-Length"] = Buffer.byteLength(body);
    let settled = false;
    const finish = (error?: FireTvError, value = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const transport = options.protocol === "http" ? http : https;
    let req: http.ClientRequest;
    try {
      const requestConfig: https.RequestOptions = {
        hostname: options.host,
        port: options.port,
        path: options.path,
        method: options.method,
        headers,
        agent: false,
        rejectUnauthorized: options.rejectUnauthorized ?? false,
      };
      req = transport.request(requestConfig, (response) => {
        const status = response.statusCode ?? 0;
        if (options.dial ? status !== 201 : status < 200 || status >= 300) {
          finish(new FireTvError(`Fire TV HTTP request failed (${status})`, "http", status));
          response.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            finish(new FireTvError("Fire TV response exceeds size limit", "protocol"));
            response.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        response.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
        response.on("error", () =>
          finish(new FireTvError("Fire TV network request failed", "network")),
        );
        response.on("aborted", () =>
          finish(new FireTvError("Fire TV response interrupted", "network")),
        );
      });
    } catch {
      reject(new FireTvError("Invalid Fire TV network request", "network"));
      return;
    }
    const abort = (): void => {
      finish(new FireTvError("Fire TV request cancelled", "cancelled"));
      req.destroy();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    req.on("error", () => finish(new FireTvError("Fire TV network request failed", "network")));
    const timer = setTimeout(() => {
      finish(new FireTvError("Fire TV request timed out", "timeout"));
      req.destroy();
    }, options.timeoutMs);
    try {
      req.end(body);
    } catch {
      finish(new FireTvError("Fire TV network request failed", "network"));
      req.destroy();
    }
  });
}

export function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FireTvError("Invalid Fire TV JSON response", "protocol");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FireTvError("Invalid Fire TV response object", "protocol");
  }
  return value as Record<string, unknown>;
}
