import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Python 3's standard library provides the same real controlling terminal on
// macOS and Linux; unlike macOS `script`, its parent can accept piped stdin.
const ptyLauncher = String.raw`
import errno
import os
import pty
import select
import signal
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    attributes = termios.tcgetattr(0)
    attributes[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(0, termios.TCSANOW, attributes)
    os.execv(sys.argv[1], sys.argv[1:])

def forward(signum, frame):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)

def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]

input_open = True
try:
    while True:
        readable, _, _ = select.select([master, 0] if input_open else [master], [], [])
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            write_all(1, data)
        if 0 in readable:
            data = os.read(0, 4096)
            if data:
                write_all(master, data)
            else:
                input_open = False
                write_all(master, b"\x04")
finally:
    os.close(master)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;

export function startCli(stateDirectory: string, entry?: string, terminal = false) {
  const nodeArguments = entry ? [entry] : ["--import", "tsx", "src/cli/repl.ts"];
  const command = terminal ? "python3" : process.execPath;
  const arguments_ = terminal
    ? ["-u", "-c", ptyLauncher, process.execPath, ...nodeArguments]
    : nodeArguments;
  const child = spawn(command, arguments_, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, FIRE_TV_STATE_DIR: stateDirectory, FIRE_TV_HOSTS: "", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  const listeners = new Set<() => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const check of listeners) check();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    for (const check of listeners) check();
  });
  child.on("error", (error) => {
    spawnError = error;
    for (const check of listeners) check();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
      for (const check of listeners) check();
    });
  });
  async function waitFor(marker: string, after = 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`CLI did not produce expected marker: ${marker}`));
      }, 5000);
      function check() {
        if (stdout.slice(after).includes(marker) || stderr.slice(after).includes(marker)) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        } else if (spawnError || child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          listeners.delete(check);
          reject(spawnError ?? new Error("CLI exited before expected marker"));
        }
      }
      listeners.add(check);
      check();
    });
  }
  return {
    child,
    exited,
    waitFor,
    get output() {
      return stdout + stderr;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async command(line: string, marker: string) {
      const offset = stdout.length;
      child.stdin.write(`${line}\n`);
      await waitFor(marker, offset);
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(terminal ? "SIGTERM" : "SIGKILL");
      await exited;
    },
    async finish(command?: string) {
      if (command) child.stdin.write(`${command}\n`);
      // Keep the bridge's pipe open until /quit exits its PTY child; terminal
      // input EOF is a control character, not a pipe close in Node's raw mode.
      if (!terminal) child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill(terminal ? "SIGTERM" : "SIGKILL");
              reject(new Error("CLI failed to exit cleanly"));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
