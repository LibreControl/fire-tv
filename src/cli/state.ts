import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { FireTvCredentials } from "../index.js";

export type CliDevice = {
  id: number;
  name: string;
  host: string;
  port?: number;
  dialPort?: number;
  voicePort?: number;
  protocol?: "http" | "https";
  credentials?: FireTvCredentials;
};

export type PersistedState = { devices: CliDevice[] };
export type CliEndpoint = Pick<CliDevice, "host" | "port" | "protocol">;

export function statePath(): string {
  return path.join(
    process.env.FIRE_TV_STATE_DIR
      ? path.resolve(process.env.FIRE_TV_STATE_DIR)
      : path.resolve(".librecontrol", "fire-tv"),
    "state.json",
  );
}

export function parseEndpoint(value: string): CliEndpoint {
  const invalid = () =>
    new Error("invalid host; use hostname[:port], [IPv6]:port, or http(s)://host:port");
  const explicitProtocol = value.includes("://");
  if (!value || /[\s@?#]/u.test(value)) throw invalid();
  if (!explicitProtocol && isIP(value) === 6) return { host: value };
  let url: URL;
  try {
    url = new URL(explicitProtocol ? value : `https://${value}`);
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw invalid();
  // URL normalizes default ports; preserve a user-specified port rather than
  // accidentally falling back to the receiver's nonstandard default of 8080.
  const authority = explicitProtocol ? value.slice(value.indexOf("://") + 3) : value;
  if (/:\/?$/u.test(authority)) throw invalid();
  const portMatch = /(?:\]|[^:]):([0-9]+)\/?$/u.exec(authority);
  const port = portMatch ? Number(portMatch[1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw invalid();
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  return {
    host,
    ...(port === undefined ? {} : { port }),
    ...(explicitProtocol
      ? { protocol: url.protocol === "http:" ? ("http" as const) : ("https" as const) }
      : {}),
  };
}

export async function loadState(): Promise<PersistedState> {
  const file = statePath();
  await secureDirectory(path.dirname(file));
  let state: PersistedState;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe state file");
    await chmod(file, 0o600);
    state = validateState(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(
        "Cannot load Fire TV state: invalid or unreadable state file; repair it before continuing (credentials were not overwritten).",
      );
    }
    state = { devices: [] };
  }
  const hosts =
    process.env.FIRE_TV_HOSTS?.split(",")
      .map((host) => host.trim())
      .filter(Boolean) ?? [];
  for (const value of hosts) {
    const endpoint = parseEndpoint(value);
    if (!state.devices.some((device) => sameEndpoint(device, endpoint))) {
      const id = nextDeviceId(state.devices);
      state.devices.push({ id, name: `Fire TV ${id}`, ...endpoint });
    }
  }
  await saveState(state);
  return state;
}

export async function saveState(state: PersistedState): Promise<void> {
  const validated = validateState(state);
  const file = statePath();
  const directory = path.dirname(file);
  await secureDirectory(directory);
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export function nextDeviceId(devices: CliDevice[]): number {
  return devices.reduce((maximum, device) => Math.max(maximum, device.id), 0) + 1;
}

export function sameEndpoint(left: CliEndpoint, right: CliEndpoint): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    (left.port ?? 8080) === (right.port ?? 8080) &&
    (left.protocol ?? "https") === (right.protocol ?? "https")
  );
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Fire TV state directory must be a real directory");
  await chmod(directory, 0o700);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateState(value: unknown): PersistedState {
  if (
    !value ||
    typeof value !== "object" ||
    !("devices" in value) ||
    !Array.isArray(value.devices)
  ) {
    throw new Error("invalid state");
  }
  const ids = new Set<number>();
  const devices = value.devices.map((entry: unknown): CliDevice => {
    if (!entry || typeof entry !== "object") throw new Error("invalid device");
    const device = entry as Record<string, unknown>;
    if (
      typeof device.id !== "number" ||
      !Number.isSafeInteger(device.id) ||
      device.id < 1 ||
      ids.has(device.id) ||
      typeof device.name !== "string" ||
      !device.name.trim() ||
      typeof device.host !== "string" ||
      !device.host ||
      /[\s/@?#]/u.test(device.host)
    )
      throw new Error("invalid device");
    ids.add(device.id);
    for (const field of ["port", "dialPort", "voicePort"] as const) {
      const port = device[field];
      if (
        port !== undefined &&
        (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      ) {
        throw new Error("invalid port");
      }
    }
    if (
      device.protocol !== undefined &&
      device.protocol !== "http" &&
      device.protocol !== "https"
    ) {
      throw new Error("invalid protocol");
    }
    let credentials: FireTvCredentials | undefined;
    if (device.credentials !== undefined) {
      const credential = device.credentials;
      if (
        !credential ||
        typeof credential !== "object" ||
        !("clientToken" in credential) ||
        typeof credential.clientToken !== "string" ||
        !credential.clientToken
      )
        throw new Error("invalid credentials");
      credentials = { clientToken: credential.clientToken };
    }
    return {
      id: device.id,
      name: device.name,
      host: device.host,
      ...(device.port === undefined ? {} : { port: device.port as number }),
      ...(device.dialPort === undefined ? {} : { dialPort: device.dialPort as number }),
      ...(device.voicePort === undefined ? {} : { voicePort: device.voicePort as number }),
      ...(device.protocol === undefined ? {} : { protocol: device.protocol as "http" | "https" }),
      ...(credentials === undefined ? {} : { credentials }),
    };
  });
  return { devices };
}
