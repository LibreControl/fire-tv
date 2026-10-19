# Fire TV native remote protocol

## Evidence and compatibility boundary

This implementation is based on community reverse-engineering evidence, not an Amazon-supported public remote-control API:

- [Community protocol notes](https://github.com/zane-programs/reversing-with-claude-code/blob/master/fire-tv/PROTOCOL.md) describe pairing, authenticated commands, mDNS and DIAL.
  The upstream branch name `master` is a source URL, not this package's release convention.
- [C4-FireTV-RE implementation and README](https://github.com/zane-programs/C4-FireTV-RE) identify the remote service on port 8080 as **HTTPS**, unlike the earlier protocol notes' HTTP examples.
  The package consequently defaults to HTTPS, while explicit `protocol: "http"` supports synthetic fixtures or an independently confirmed HTTP receiver.
  There is no protocol probing, silent downgrade or automatic retry.
- [Home Assistant community REST commands](https://community.home-assistant.io/t/rest-commands-for-fire-tv/901314) document whole-string text submission to `POST /v1/FireTV/keyboard`.
  On the user's Fire TV Stick 4K Plus with remote service `0.1.147068`, this route visibly entered text; the obsolete text route returned 200 without visible input.
- [Amazon's streaming player specifications](https://developer.amazon.com/docs/device-specs/device-specifications-fire-tv-streaming-media-player.html) identify the intended Fire TV Stick 4K Plus (2025), AFTMA08C15, Fire OS 8 / Android 11.
  These specifications do not establish that its firmware implements this community remote API.
- [hms-firetv voice protocol research](https://github.com/hms-homelab/hms-firetv/blob/master/src/clients/VoiceClient.cpp) and [voice lifecycle service](https://github.com/hms-homelab/hms-firetv/blob/master/src/services/VoiceService.cpp) identify HTTPS start/stop, WSS port 9090, and raw mono 16 kHz s16le audio.
  This repository independently implements those wire facts using Node 20 built-ins; it does not copy the upstream C++ implementation or load an external Fire TV runtime.

The independent E2E fixture is synthetic and exercises the library and CLI against real local network transports.
It is not captured receiver traffic, and successful fixture verification cannot establish compatibility with the intended device.
Some operations have been validated on user hardware; see [hardware validation](hardware-validation.md) for observations and remaining gaps.

## Discovery

Browse `_amzn-fireTv._tcp.local.` using a PTR question, class IN with its unicast-response bit set.
Native multicast destination is 224.0.0.251:5353; sockets bind ephemeral ports on local IPv4 addresses.
Collect PTR, SRV, TXT, A and AAAA records across responses, then combine service instance records with their SRV host addresses.
SRV supplies the remote port; discovery does not imply that the port uses HTTP rather than HTTPS.

The parser bounds datagram fields, label sizes, expanded names and compression traversal; rejects loops, truncated data and excessively deep pointer chains; ignores a malformed datagram atomically.
Accumulation is bounded, duplicate service targets are indexed once, and timers/sockets close on success or socket failure.
The implementation can report a DNS target name when addresses are absent.
Loopback destination/port and local bind-address overrides are available for real UDP fixture testing.

In parallel, search SSDP at 239.255.255.250:1900 with `ST: urn:dial-multiscreen-org:service:dial:1`.
Fetch candidate descriptions only from numeric HTTP URLs matching the UDP sender, without credentials or redirects.
Accept manufacturer Amazon and model names beginning with AFT, decode the friendly name, and use the UDN UUID as identity when valid.
These receivers use remote port 8080; the SSDP description port is not the remote port.
Descriptor bodies are limited to 64 KiB, with at most 64 candidates and four concurrent requests.
Each request has a 1.5-second deadline capped by the shared discovery deadline.
DTD and custom entity declarations are rejected.
Merge mDNS and DIAL results by host/remote-port endpoint.
Discovery never activates a DIAL application or proves that the remote service is currently reachable.
The powered user receiver was discovered this way with its TV off on 2026-10-19, despite no `_amzn-fireTv._tcp` advertisement.

## Remote requests

Port 8080 by default.
Every remote request carries `Content-Type: application/json; charset=utf-8` and the static `x-api-key: 0987654321`.
That API key is a publicly documented protocol identifier, not a user credential.
Authenticated requests additionally carry `x-client-token`.

1. `POST /v1/FireTV/pin/display` with `{ friendlyName }`, expecting `{ description: "OK" }`.
2. `POST /v1/FireTV/pin/verify` with `{ pin }`.
   Empty description means wrong PIN; a nonempty printable token description is the paired credential.
3. `GET /v1/FireTV/status` validates `osVersion`, `platformType`, `turnstileVersion` as strings.
   `connect()` uses this request to validate authentication.
4. `GET /v1/FireTV/properties` preserves receiver-reported properties, including informational `volumeSupport` / `powerSupport` strings if present.
   No controllable volume/power endpoints are inferred from flags.
5. `GET /v1/FireTV/keyboard` requires string `state` and nullable string `mode` / `text`.
   User hardware reported `visible` / `keyboard` initially and `text` / `keyboard` after manual typing.
   This package accepts `visible`, `text`, `active`, or `shown` as active; `active` and `shown` remain compatibility assumptions rather than observations of that firmware.
6. `POST /v1/FireTV?action=dpad_up|dpad_down|dpad_left|dpad_right|select` with `{ keyActionType: "keyDown" | "keyUp" }`.
   A complete press sends down followed by up within one serialized operation.
7. `POST /v1/FireTV?action=home|back|menu|power` with an empty body.
   The `power` action is exposed as `powerToggle`; the user confirmed that it turned off the connected TV.
   It is not a discrete on/off command, does not report TV power state, and must not be automatically retried.
8. `POST /v1/FireTV/keyboard` with `{ text }` containing the complete Unicode string, only after an active keyboard check.
   The keyboard check and single write occupy one serialized operation; the client does not split characters or fall back to another endpoint.
   Cursor and composition effects are receiver/app-owned; this API guarantees neither appending nor replacing the existing field.
   The synthetic fixture uses a deterministic insert-at-end model for tests, not hardware-proven editing semantics.
9. `POST /v1/media?action=play` with an empty body toggles playback; exposed as `playPause`, not distinct play or pause operations.
10. `POST /v1/media?action=scan` with `{ direction: "forward" | "backward", durationInSeconds: "10", speed: "1" }`.
    Public scan duration is a positive finite number, serialized as a string.
    The duration is a receiver hint, not a guaranteed bounded jump or automatic stop.
    User hardware continued scanning forward after a duration of five seconds; Play/Pause stopped scanning and resumed playback.
    The same receiver rejected a backward scan with HTTP 400; reverse support remains unverified.

Command success accepts any 2xx response, including empty or non-JSON bodies.
Data-bearing responses are validated as JSON objects with required field types.
HTTP 401 or 403 for the current authenticated credential/lifecycle invalidates the connected state and credential, cancelling active/queued lifecycle work.
Stale responses cannot discard a replacement pairing, even when a token value is reissued.
Other HTTP failures are surfaced with numeric status; malformed payloads, network errors, cancellation and deadlines produce sanitized `FireTvError`s.
Response bodies and underlying exception messages are never copied into errors.
Responses have a 1 MiB size limit and an overall request deadline, rather than an inactivity timer that a slow sender could extend indefinitely.

## Owned Alexa voice transport

`voiceStart()` requires an authenticated connected device and sends an empty-body `POST /v1/FireTV/voiceCommand?action=start` on the configured remote port (8080 by default).
It then opens TLS WSS at `/` on `voicePort` (9090 by default), using Node HTTPS HTTP/1.1 upgrade, the same static API key, and the paired client token.
It does not rely on reportedly unauthenticated upgrade acceptance.
WSS remains TLS even when the remote HTTP fixture configuration uses plaintext HTTP.

The client validates status 101, Upgrade/Connection headers and RFC6455 `Sec-WebSocket-Accept`; handshake, writes and close have bounded deadlines.
Client frames are masked.
Incoming control/metadata frames are bounded and malformed, masked-server, reserved-bit, or oversized frames reject; ping receives pong.
Pending pong work is bounded to one write and one latest payload, coalescing unanswered pings rather than accumulating an unbounded queue.
Unexpected remote closure is an error, never successful audio delivery.

`voiceStreamPcm()` accepts only a nonempty even-byte `Uint8Array`, representing mono 16000 Hz signed 16-bit little-endian PCM.
No WAV header or codec/application prefix is sent.
Ordered binary frames use 3200-byte/100 ms quanta with a shorter final quantum, paced at 1x audio duration including the final quantum.
Writes respect transport backpressure, and pacing rebases after delays rather than bursting overdue audio.
This quantum is a pacing choice, not a claimed firmware requirement.
The buffer must remain unmodified until its returned promise settles.

`voiceStop()` cancels start/stream work and initiates WSS close plus empty-body authenticated `POST /v1/FireTV/voiceCommand?action=stop` concurrently.
The transport ends its TLS write side after the WebSocket close frame flushes, then waits for peer acknowledgment within the close deadline.
This avoids waiting for a close acknowledgment while withholding the transport EOF or HTTP stop the receiver may require.
Both shutdown operations settle before completion; HTTP stop failures retain uncertain recording ownership and take precedence over a transport-close error.
Duplicate starts and idle stream/stop reject.
Start/socket/stream failures attempt bounded cleanup; disconnect cancels voice and unrelated queued navigation work and permits reconnect.
Transient stop failures surface sanitized errors and retain uncertain recording ownership for later explicit cleanup, with no automatic command retry.
Terminal 401/403 cleanup rejection releases the unusable local voice session; it does not claim that remote recording was stopped with a revoked credential.
Network failure cannot prove that remote recording stopped.
A cancelled start cannot later install a usable socket.

The WAV convenience export parses complete RIFF/WAVE chunks and padding rather than assuming a 44-byte header.
Only PCM format 1, mono 16000 Hz, 16-bit, block alignment 2 and byte rate 32000 are accepted.
The CLI reads/validates files before starting recording and cleans up on failure, quit, EOF, SIGINT and disconnect.

The fixture is a conversion of `google-tv/tests/fixtures/open-youtube.wav`: 40960 raw PCM bytes, 1.280 seconds, data offset 4096.
Conversion used macOS `afconvert`, not a runtime dependency.
The sample's filename suggests “open YouTube”; its words were not independently transcribed.
On the user's receiver, streaming this sample visibly opened YouTube, as confirmed by the user.
Synthetic HTTP/TLS-WebSocket fixtures verify protocol consumption independently of that hardware observation.

## DIAL

`POST http://host:8009/apps/FireTVRemote`, empty body, `Content-Type: text/plain`, expects `201 Created`.
This is an explicit remote-app activation operation exposed by `launchRemote()` / `/launch <id>`, not an automatic workaround for pairing or command failures.
No arbitrary app launching is implemented.

## Lifecycle and security

One active pairing session is retained per device; starting another cancels the previous session.
PIN attempts serialize and closing the session aborts pending submission.
Successful pairing installs the token but leaves the device disconnected until `connect()`.
Authenticated commands serialize, and an explicit held key must be released before another down/press/text operation.
Disconnect cancels I/O and queued work, notifies sessions, and permits reconnect with the retained token.
A current-lifecycle 401 or 403 discards that token instead.

There is no command retry and no compensating key release on disconnect.
If a key-down reached the receiver before a network error or cancellation, the receiver's held-key state is uncertain; local cancellation cannot undo a received command.
Avoid long holds during initial hardware validation.

Default HTTPS certificate verification is disabled (`rejectUnauthorized: false`) for interoperability with proprietary/self-signed receivers.
Encryption does not authenticate the peer under this policy; a LAN attacker could impersonate a receiver and obtain pairing credentials or commands.
This certificate behavior is not a verified property of the target firmware.
`rejectUnauthorized: true` opts into Node's normal trusted-certificate validation, with failures reported as sanitized network errors.
There is no global TLS setting change.
Explicit HTTP and DIAL transmit in clear text.
Use a trusted LAN and owner-only credential storage; never include PINs/tokens in shared diagnostic output.
