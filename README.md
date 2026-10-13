# LibreControl Fire TV

Native TypeScript ESM remote control for Fire TV, using the LAN remote protocol rather than ADB.
Requires Node.js 20 or later; development and CI use Node.js 22 and Yarn 4.9.2.

**Hardware validation is partial.**
The real receiver accepted pairing and navigation requests, and the compiled client/CLI worked through a temporary native TCP relay.
The user confirmed Home, all four arrow directions, and ASCII text entry on the native search screen.
Direct Node-to-LAN access, automatic discovery, Unicode text, playback behavior, and Alexa interpretation remain unverified.
See the observed results and limitations in the [hardware validation guide](docs/hardware-validation.md).
The intended receiver is the **Fire TV Stick 4K Plus (2025), AFTMA08C15, Fire OS 8 / Android 11**, as identified in [Amazon's device specifications](https://developer.amazon.com/docs/device-specs/device-specifications-fire-tv-streaming-media-player.html).
This is not the Vega-based Fire TV Stick 4K Select.
Synthetic fixture coverage is not a firmware compatibility claim.
Follow the [hardware validation guide](docs/hardware-validation.md) before relying on a real receiver.

## Install and develop

```sh
corepack yarn install --immutable
corepack yarn verify
corepack yarn cli
```

`yarn verify` runs typechecking, lint, formatting checks, tests, then build.
The test suite requires macOS or Linux and `python3` on PATH for its genuine pseudo-terminal PIN-redaction case.
Python is a test-only dependency; the library and CLI run on Node.js.
The independent tests use actual local HTTP/HTTPS and UDP servers and a real CLI subprocess; their responses are synthetic community-protocol fixtures, not captured traffic from this target device.
They exercise pairing and cancellation, persisted reconnect, key ownership and ordering, Unicode input, media, DIAL, certificate rejection, protocol failures, noisy discovery, credential permissions, terminal redaction, and process cleanup.
Source CLI execution does not require `dist`.

After `verify`, run the compiled CLI acceptance scenario independently of Vitest:

```sh
node --import tsx tests/helpers/smoke-cli.ts dist/cli/repl.js
```

The scenario pairs with the fixture, changes navigation/text/playback state, restarts with saved credentials without another PIN, activates DIAL, and checks clean quit/EOF and owner-only credential permissions.
It prints only sanitized observed fixture state and removes its temporary state directory.
CI runs both the complete suite and this compiled-program scenario.

After building, use `node dist/cli/repl.js`, or the installed `librecontrol-fire-tv` executable.
The package exports `@librecontrol/fire-tv` from `dist/index.js` with TypeScript declarations.

## Pair and control

```ts
import { createFireTv } from "@librecontrol/fire-tv";

const tv = createFireTv({ host: "192.168.1.42", name: "Living room" });
const pairing = await tv.startPairing();
try {
  // Obtain the four digits from the TV; do not log the PIN or returned token.
  const result = await pairing.submitCode(pinFromUser);
  if (!result.paired) throw new Error("Incorrect PIN; submit again before closing");
  // Persist result.credentials securely for the next process, if desired.
} finally {
  await pairing.close();
}

await tv.connect();
try {
  await tv.sendKey("home");
  await tv.sendKey("right");
  await tv.sendKey("select");
  console.log(await tv.getStatus());
  // Only while a receiver text-entry keyboard is active:
  await tv.inputText("Hello 🌍");
  await tv.sendKey("playPause");
  await tv.scan("forward", 10);
} finally {
  await tv.disconnect();
}
```

Successful pairing both returns `{ paired: true, status: "ok", credentials: { clientToken } }` and installs that credential on the instance.
A wrong PIN returns `{ paired: false, status: "bad-pin" }` without closing the session.
Closing aborts submissions and rejects later submissions; starting another session closes the previous one.
Pairing does not implicitly connect.
Reconnect using `createFireTv({ host, clientToken })` then `connect()`; `connect()` validates authenticated status before enabling commands.

## Public API

`FireTvDeviceConfig` accepts `host`, optional `port` (8080), `dialPort` (8009), `voicePort` (9090), `name`, `id`, `clientToken`, `timeoutMs` (5000), `protocol` (`"https"` by default), and `rejectUnauthorized` (`false` by default).
Host is a hostname or IP address, not a URL; separate the scheme and ports in library configuration.

`FireTvDevice` and `createFireTv(config)` expose readonly `host`, `id`, `name`, plus:

- `startPairing()`, `connect()`, `disconnect()`.
- `sendKey(key)` for `up`, `down`, `left`, `right`, `select`, `back`, `home`, `menu`, `playPause`.
- `sendKeyDown(key)` / `sendKeyUp(key)` for direction and select keys only.
- `inputText(text)` sends the whole Unicode string in one `POST /v1/FireTV/keyboard` request after checking that the keyboard is active, including the hardware-observed `text` state.
  The receiver/app controls cursor and composition behavior; appending or replacing existing text is not guaranteed.
- `getStatus()` returns `osVersion`, `platformType`, `turnstileVersion` strings.
- `getProperties()` preserves receiver-reported properties.
  `volumeSupport` and `powerSupport` do not establish controllable command endpoints.
- `getKeyboardState()` returns `{ state, mode, text }`, with nullable mode/text.
- `scan("forward" | "backward", positiveSeconds)`.
- `launchRemote()` explicitly activates `/apps/FireTVRemote` via HTTP DIAL; it needs no connected session and expects status 201.
  It is never an automatic recovery attempt.
- `voiceStart()` starts authenticated recording and opens WSS; requires a connected session.
- `voiceStreamPcm(samples)` streams nonempty, even-length raw mono 16000 Hz signed 16-bit little-endian PCM at real-time speed. It never starts recording implicitly.
- `voiceStop()` interrupts streaming, closes WSS, then stops recording over authenticated HTTP(S). Idle stop and duplicate start reject.
- `extractVoiceWavPcm(bytes)` validates PCM WAV input and returns its audio data view, accounting for arbitrary padded metadata chunks.

Commands serialize: complete down/up presses and text strings cannot interleave.
An explicitly held key prevents other presses, text, or key-down operations until released; incompatible releases reject.
A failed operation does not poison the queue, so a matching release can still be attempted.
Disconnect aborts active requests, invalidates queued work and supports a later reconnect.
Cancellation after a receiver accepted key-down cannot guarantee remote release; there is no hidden retry or cleanup command.
HTTP 401 or 403 for the current authenticated lifecycle clears the credential and connected state: pair again and explicitly reconnect.
Delayed responses from an older credential/lifecycle cannot discard a replacement pairing.
Errors are `FireTvError` with sanitized `message`, `code` and optional `statusCode`; response bodies and underlying Node error details are not exposed.

Voice uses a separate explicitly owned lifecycle rather than the navigation queue.
Concurrent PCM buffers serialize within that session; stop/disconnect cancel pending audio immediately.
Start, socket, and streaming failures attempt recording cleanup without retrying commands.
Transient stop failures retain uncertain recording ownership for a later explicit stop/disconnect; remote recording state cannot be guaranteed after a network failure.
Terminal authentication rejection releases the unusable local voice session rather than permanently blocking a new pairing.

`discoverFireTv({ timeoutMs, mdnsAddress, mdnsPort, networkInterfaces })` browses `_amzn-fireTv._tcp.local.`.
Defaults are native multicast, port 5353, a 5000 ms window, and local IPv4 interfaces.
`networkInterfaces` contains **local IP addresses**, not interface names.
Each socket binds an ephemeral port and asks for unicast replies.
Results include `id`, `name`, `host`, `port`, `serviceName`, `addresses`, and `txt`.
Compressed names, split datagrams and duplicate announcements are supported; malformed datagrams are ignored.
An unavailable interface contributes no results.
Discovery does not change transport selection: discovered devices still default to HTTPS.

## CLI

```text
/add 192.168.1.42 Living room
/devices
/pair 1
/code <pin shown on TV>
/connect 1
/home
/status
/disconnect
/quit
```

`/code` takes the four digits directly, without angle brackets.
The CLI does not echo PINs or tokens.
Device IDs shown by `/devices` are CLI-local numeric IDs.

Commands: `/help`, `/scan`, `/add <host> [name]`, `/devices`, `/pair <id>`, `/code <pin>`, `/connect <id>`, `/disconnect`, `/up`, `/down`, `/left`, `/right`, `/select`, `/home`, `/back`, `/menu`, `/playpause`, `/text <text>`, `/status`, `/properties`, `/keyboard`, `/scan-forward <seconds>`, `/scan-backward <seconds>`, `/launch <id>`, `/voice start`, `/voice stop`, `/voice pcm <path>`, `/voice wav <path>`, `/quit`.

Bare hosts and `host:port` use HTTPS.
`/add https://host:port` is explicit HTTPS; `/add http://host:port` permits an older HTTP receiver or local fixture without automatic downgrade.
Bracketed IPv6 addresses are accepted by the CLI.
`FIRE_TV_HOSTS` is a comma-separated list in the same syntax.
`FIRE_TV_STATE_DIR` overrides the state directory; the default file is `.librecontrol/fire-tv/state.json` under the working directory.
State persists device configurations and credentials with directory mode 0700, file mode 0600 and atomic replacement.
Invalid JSON is an error, not a reason to discard credentials.
Restart, then `/connect <id>` without another PIN.
EOF, SIGINT and `/quit` clean up and exit.

## Prerecorded Alexa audio

The owned Node.js transport posts authenticated voice start/stop to the remote service and sends masked binary raw PCM over **WSS**, port 9090 by default, with an HTTP/1.1 upgrade.
There is no external Fire TV runtime library, transcription response, microphone capture, TTS, or invented fallback.

After connecting, use `/voice wav tests/fixtures/open-youtube.wav`.
The CLI validates the complete WAV before recording, streams at 1x duration, and always attempts stop.
`/voice pcm <path>` accepts raw PCM in the same format; the explicit start/stop commands are useful to library-style sessions.

The supplied fixture was converted from `google-tv/tests/fixtures/open-youtube.wav` using `afconvert -f WAVE -d LEI16@16000 -c 1 google-tv/tests/fixtures/open-youtube.wav fire-tv/tests/fixtures/open-youtube.wav` from the repository root.
It contains 40960 PCM bytes, mono 16000 Hz s16le, lasting 1.280 seconds; its data chunk starts at offset 4096, not 44.
No runtime converter is required.
Its filename suggests the command, but we have not independently transcribed it.

Independent synthetic fixtures can prove transport/authentication/audio fidelity and lifecycle behavior, not Alexa's recognition or an actual receiver response.
No actual voice hardware result is claimed here; see the hardware guide for separately observed results.

## Security and limits

Remote HTTPS and voice WSS use receiver certificates that may be self-signed.
Default `rejectUnauthorized: false` provides encryption **without authenticated peer identity** on both transports; use only on a trusted, isolated LAN.
Set `rejectUnauthorized: true` in the library to require Node's certificate validation for both.
The CLI currently uses the default receiver policy and has no certificate-verification toggle.
Explicit HTTP remote mode and DIAL are unencrypted.
There is never an automatic HTTPS-to-HTTP fallback.
The protocol's static `x-api-key` is a public identifier, not an authentication secret; the paired client token is a secret.
Restrict access to state files and avoid sharing them or raw packet captures.

There are no volume, power, arbitrary app launch, separate play/pause, or ADB commands.
The tested receiver reports native volume unsupported; physical-remote IR/CEC support does not establish a LAN volume endpoint.
Voice always uses WSS, even with explicit HTTP remote configuration; it never downgrades to plaintext WS.
Keyboard activation/state names, certificate policy, transport availability, media behavior and DIAL service availability must be verified on the actual firmware.
See [protocol evidence](docs/protocol.md).

## Releases

The default and semantic-release branch is `main`.
CI follows Google TV's Setup, Format, Lint, Typecheck, Test, and Build jobs, checking `main`, `develop`, feature branches, Renovate branches, and pull requests.
Build also runs the compiled navigation/text and voice acceptance scenarios.
Automatic release follows a successful push CI run on `main`.
Manual release is restricted to `RELEASE_ALLOWED_ACTORS` and requires the selected commit's `Build` check to have succeeded.
Both paths use `RELEASE_TOKEN` for GitHub release commits and npm trusted publishing/OIDC, and generate the changelog through semantic-release.
GitHub issue/PR success and failure comments are disabled.

Provide `RELEASE_TOKEN` through an organization secret accessible to this repository or a repository secret; do not put credentials in source files.
Configure the npm package's GitHub trusted publisher with organization `LibreControl`, repository `fire-tv`, workflow filename `release.yml`, no environment, and direct `npm publish` permission enabled.
Creating the GitHub repository does not create the npm package or its trust relationship.
A new npm package requires an authenticated initial publish and package ownership before its trusted publisher can be configured.
After bootstrap, automatic releases use OIDC rather than a long-lived npm token.
Do not edit generated release files manually.
Workflows assume this package is the checkout root, matching the standalone sibling packages.
