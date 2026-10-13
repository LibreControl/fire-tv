import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeServer } from "./native-server.js";
import { startVoiceServer } from "./voice-server.js";
import { startCli } from "./cli-process.js";

export async function startVoiceCli(entry?: string) {
  const directory = await mkdtemp(join(tmpdir(), "fire-tv-voice-cli-"));
  const remote = await startNativeServer();
  const voice = await startVoiceServer(remote);
  // Only fixture-owned synthetic credentials; never reads user persisted state.
  remote.state.paired = true;
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      devices: [
        {
          id: 1,
          name: "Synthetic",
          host: remote.config.host,
          port: remote.config.port,
          protocol: remote.config.protocol,
          dialPort: remote.config.dialPort,
          voicePort: voice.port,
          credentials: { clientToken: remote.fixture.token },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const cli = startCli(directory, entry);
  return {
    directory,
    remote,
    voice,
    cli,
    async close() {
      await cli.stop();
      await voice.close();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
