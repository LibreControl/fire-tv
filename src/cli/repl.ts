#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import {
  createFireTv,
  discoverFireTv,
  type FireTvDevice,
  type FireTvKeyName,
  type FireTvPairingSession,
} from "../index.js";
import { extractVoiceWavPcm } from "../audio/wav.js";
import {
  loadState,
  saveState,
  nextDeviceId,
  parseEndpoint,
  sameEndpoint,
  type CliDevice,
  type PersistedState,
} from "./state.js";

type Session = {
  selected?: CliDevice;
  device?: FireTvDevice;
  pairing?: FireTvPairingSession;
  launching?: FireTvDevice;
};

const keys: Record<string, FireTvKeyName> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  select: "select",
  home: "home",
  back: "back",
  menu: "menu",
  playpause: "playPause",
  "power-toggle": "powerToggle",
};
const secrets = new Set<string>();
let redactionPattern: RegExp | undefined;

function rememberSecret(secret: string): void {
  if (!secret || secrets.has(secret)) return;
  secrets.add(secret);
  secrets.add(JSON.stringify(secret).slice(1, -1));
  redactionPattern = new RegExp(
    [...secrets]
      .sort((left, right) => right.length - left.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|"),
    "gu",
  );
}

function redact(value: string): string {
  const result = redactionPattern ? value.replace(redactionPattern, "[REDACTED]") : value;
  return result.replace(/\p{Cc}/gu, (character) =>
    character === "\t" || character === "\n" || character === "\r" ? character : "",
  );
}

function print(message: string): void {
  output.write(`${redact(message)}\n`);
}

function printData(value: unknown): void {
  print(
    JSON.stringify(
      value,
      (key, entry: unknown) =>
        /token|pin|credential|password|secret/iu.test(key) ? "[REDACTED]" : entry,
      2,
    ),
  );
}

async function closeSession(session: Session): Promise<void> {
  const pairing = session.pairing;
  const device = session.device;
  const launching = session.launching;
  session.pairing = undefined;
  session.device = undefined;
  session.launching = undefined;
  await Promise.all([pairing?.close(), device?.disconnect(), launching?.disconnect()]);
}

async function main(): Promise<void> {
  const state = await loadState();
  for (const device of state.devices) {
    if (device.credentials) rememberSecret(device.credentials.clientToken);
  }
  const session: Session = {};
  let rl: readline.Interface | undefined = undefined;
  // readline manages raw-mode terminal input; hide the PIN as it is typed,
  // including redraws, without sacrificing ordinary interactive editing.
  const terminalOutput = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      if (rl && /^\s*\/?code(?:\s|$)/iu.test(rl.line)) {
        output.write(text.replace(/[^\r\n]/gu, ""));
      } else {
        output.write(redact(text));
      }
      callback();
    },
  });
  rl = readline.createInterface({
    input,
    output: terminalOutput,
    terminal: Boolean(input.isTTY),
    prompt: "fire-tv> ",
  });
  let inputClosed = false;
  rl.once("close", () => {
    inputClosed = true;
  });
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const interrupt = () => {
    stopping = true;
    rl?.close();
    shutdown ??= closeSession(session);
    void shutdown.catch(() => {});
  };
  process.on("SIGINT", interrupt);
  rl.on("SIGINT", interrupt);
  try {
    printHelp();
    rl.prompt();
    for await (const line of rl) {
      if (stopping) break;
      const trimmed = line.trim();
      if (/^\/?(?:quit|exit)$/u.test(trimmed)) break;
      try {
        if (trimmed) await runCommand(line, state, session);
      } catch (error) {
        if (!stopping) print(`error: ${error instanceof Error ? error.message : "command failed"}`);
      }
      // EOF closes readline while awaited commands are still running. Its
      // iterator retains queued lines, so drain them without reopening input.
      if (!stopping && !inputClosed) rl.prompt();
    }
  } finally {
    stopping = true;
    rl.close();
    process.off("SIGINT", interrupt);
    await (shutdown ?? closeSession(session));
  }
}

async function runCommand(line: string, state: PersistedState, session: Session): Promise<void> {
  const match = /^\s*\/?([^\s]+)(?:\s(.*))?$/u.exec(line);
  if (!match) return;
  const command = match[1]!.toLowerCase();
  const rest = match[2] ?? "";
  const args = rest.trim().split(/\s+/u).filter(Boolean);
  if (command === "help") return printHelp();
  if (command === "devices") return printDevices(state.devices);
  if (command === "add") {
    if (!args[0]) throw new Error("usage: /add <host[:port] | http(s)://host:port> [name]");
    const endpoint = parseEndpoint(args[0]);
    if (state.devices.some((device) => sameEndpoint(device, endpoint)))
      throw new Error("device already added; use /devices");
    const id = nextDeviceId(state.devices);
    const device: CliDevice = { id, name: args.slice(1).join(" ") || `Fire TV ${id}`, ...endpoint };
    state.devices.push(device);
    await saveState(state);
    print(`added [${device.id}] ${device.name} ${address(device)}`);
    return;
  }
  if (command === "scan") {
    print("scanning mDNS and DIAL/SSDP for Fire TV receivers...");
    const found = await discoverFireTv();
    let added = 0;
    for (const discovered of found) {
      if (state.devices.some((device) => sameEndpoint(device, discovered))) continue;
      state.devices.push({
        id: nextDeviceId(state.devices),
        name: discovered.name,
        host: discovered.host,
        port: discovered.port,
      });
      added++;
    }
    await saveState(state);
    print(`found ${found.length} device${found.length === 1 ? "" : "s"}; added ${added}`);
    if (!found.length) print("no devices found; try /add <host> [name], then /pair <id>");
    printDevices(state.devices);
    return;
  }
  if (command === "launch") {
    const selected = requireDevice(state.devices, args[0]);
    if (session.device && session.selected?.id === selected.id) {
      await session.device.launchRemote();
    } else {
      const temporary = createFireTv({
        host: selected.host,
        port: selected.port,
        dialPort: selected.dialPort,
        voicePort: selected.voicePort,
        protocol: selected.protocol,
        name: selected.name,
        id: String(selected.id),
        clientToken: selected.credentials?.clientToken,
      });
      session.launching = temporary;
      try {
        await temporary.launchRemote();
      } finally {
        session.launching = undefined;
        await temporary.disconnect();
      }
    }
    print(`launched remote on ${selected.name}`);
    return;
  }
  if (command === "pair" || command === "connect") {
    const selected = requireDevice(state.devices, args[0]);
    await closeSession(session);
    session.selected = selected;
    const device = createFireTv({
      host: selected.host,
      port: selected.port,
      dialPort: selected.dialPort,
      voicePort: selected.voicePort,
      protocol: selected.protocol,
      name: selected.name,
      id: String(selected.id),
      clientToken: selected.credentials?.clientToken,
    });
    session.device = device;
    if (command === "pair") {
      session.pairing = await device.startPairing();
      print(`pairing with ${selected.name}; enter the PIN shown on TV with /code <pin>`);
    } else {
      await device.connect();
      print(`connected ${selected.name}`);
    }
    return;
  }
  if (command === "code") {
    // Register before validation or I/O so even a reflected error is redacted.
    const pin = args.join("");
    if (pin) rememberSecret(pin);
    if (!session.pairing || !session.selected) throw new Error("start with /pair <id>");
    if (args.length !== 1) throw new Error("usage: /code <pin>");
    const result = await session.pairing.submitCode(pin);
    if (!result.paired) {
      print("incorrect PIN; try /code <pin> again");
      return;
    }
    if (!result.credentials) throw new Error("pairing did not return credentials; pair again");
    rememberSecret(result.credentials.clientToken);
    session.selected.credentials = result.credentials;
    await saveState(state);
    await session.pairing.close();
    session.pairing = undefined;
    print(`paired ${session.selected.name}`);
    return;
  }
  if (command === "disconnect") {
    await closeSession(session);
    print("disconnected");
    return;
  }
  const key = Object.hasOwn(keys, command) ? keys[command] : undefined;
  if (key) {
    await requireRemote(session).sendKey(key);
    print(`sent ${command}`);
    return;
  }
  if (command === "text") {
    if (!rest) throw new Error("usage: /text <text>");
    await requireRemote(session).inputText(rest);
    print("sent text");
    return;
  }
  if (command === "voice") {
    const action = args[0];
    if (action === "start" && args.length === 1) {
      await requireRemote(session).voiceStart();
      print("voice started");
    } else if (action === "stop" && args.length === 1) {
      await requireRemote(session).voiceStop();
      print("voice stopped");
    } else if (action === "pcm" || action === "wav") {
      const file = rest.trim().replace(/^\S+\s*/u, "");
      if (!file) throw new Error(`usage: /voice ${action} <path>`);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(file);
      } catch {
        throw new Error("could not read voice audio file");
      }
      const samples = action === "wav" ? extractVoiceWavPcm(bytes) : bytes;
      if (samples.byteLength === 0 || (samples.byteLength & 1) !== 0) {
        throw new Error("voice PCM must contain a nonempty even number of bytes");
      }
      const device = requireRemote(session);
      await device.voiceStart();
      let stopFailed = false;
      let stopError: unknown;
      try {
        await device.voiceStreamPcm(samples);
      } finally {
        try {
          await device.voiceStop();
        } catch (error) {
          // Let a stream failure propagate; only throw stop errors after normal completion.
          stopFailed = true;
          stopError = error;
        }
      }
      if (stopFailed) throw stopError;
      print("voice streamed");
    } else {
      throw new Error("usage: /voice start|stop|pcm <path>|wav <path>");
    }
    return;
  }
  if (command === "status") return printData(await requireRemote(session).getStatus());
  if (command === "properties") return printData(await requireRemote(session).getProperties());
  if (command === "keyboard") return printData(await requireRemote(session).getKeyboardState());
  if (command === "scan-forward" || command === "scan-backward") {
    const duration = Number(args[0]);
    if (args.length !== 1 || !Number.isFinite(duration) || duration <= 0)
      throw new Error(`usage: /${command} <positive seconds>`);
    await requireRemote(session).scan(
      command === "scan-forward" ? "forward" : "backward",
      duration,
    );
    print(`sent ${command}`);
    return;
  }
  throw new Error("unknown command; use /help");
}

function requireDevice(devices: CliDevice[], value?: string): CliDevice {
  const device = devices.find((entry) => String(entry.id) === value);
  if (!device) throw new Error("unknown device; use /devices, then supply its numeric ID");
  return device;
}

function requireRemote(session: Session): FireTvDevice {
  if (!session.device) throw new Error("not connected; use /connect <id>");
  return session.device;
}

function address(device: CliDevice): string {
  const host = device.host.includes(":") ? `[${device.host}]` : device.host;
  return `${host}${device.port === undefined ? "" : `:${device.port}`}`;
}

function printDevices(devices: CliDevice[]): void {
  if (!devices.length) print("no devices; use /scan or /add <host> [name]");
  for (const device of devices) {
    print(
      `[${device.id}] ${device.name} ${address(device)} ${device.credentials ? "paired" : "unpaired"} (${device.protocol ?? "https"})`,
    );
  }
}

function printHelp(): void {
  print(`Fire TV native remote
/help                           Show commands
/scan                           Discover Fire TV receivers
/add <host[:port]> [name]        Add a receiver (HTTPS by default)
/add http(s)://host:port [name]  Choose an explicit transport; never auto-downgraded
/devices                        List saved receivers
/pair <id>                      Display a pairing PIN on the TV
/code <pin>                     Submit the PIN (never logged)
/connect <id>                   Connect using saved credentials
/disconnect                     Close the current session
/launch <id>                    Explicitly activate the remote via DIAL
/up /down /left /right /select /home /back /menu /playpause
/power-toggle                   Toggle TV power (device/CEC dependent; not on/off)
/text <text>                    Type into an active TV keyboard
/voice start|stop                Start or stop Alexa audio input
/voice pcm <path>                Stream mono 16000 Hz signed 16-bit LE PCM
/voice wav <path>                Stream a WAV in that same PCM format
/voice wav tests/fixtures/open-youtube.wav  Use the supplied prerecorded sample
/status /properties /keyboard  Read receiver state
/scan-forward <seconds>         Scan media forward
/scan-backward <seconds>        Scan media backward
/quit                           Close and exit`);
}

main().catch((error: unknown) => {
  print(`error: ${error instanceof Error ? error.message : "Fire TV CLI failed"}`);
  process.exitCode = 1;
});
