# Hardware validation: Fire TV Stick 4K Plus (2025)

## Current status

**Partially validated on user hardware on 2026-10-13 and 2026-10-19.**
Intended target: AFTMA08C15, Fire TV Stick 4K Plus (2025), Fire OS 8 / Android 11 per [Amazon's specifications](https://developer.amazon.com/docs/device-specs/device-specifications-fire-tv-streaming-media-player.html).
Do not substitute the Vega-based 4K Select.
The synthetic fixture suite is independent protocol/transport verification, not a device certification or a captured firmware transcript.

Record the actual model identifier, Fire OS build/version, remote-service status fields and date when performing this procedure.
Do not record the displayed PIN or client token.
Different firmware versions can expose different transport, keyboard, or service behavior.

### Observed hardware results

The user identified the receiver as a Fire TV Stick 4K Plus.
Its DIAL device description independently reported model AFTMA08C15 on 2026-10-19.
Authenticated status reported `platformType: android`, `osVersion: 0032548774788`, and `turnstileVersion: 0.1.147068`.
Properties reported `powerSupport: NotSupported` and `volumeSupport: NotSupported`.
The capability endpoint also reported `isVolumeControlsSupported: false` and `volumeCapabilityLevelOfSupport: NotSupported`.
The user described a monitor as the connected display; the API does not establish whether that setup causes the unsupported volume capability.

- Native HTTP DIAL activation returned 201.
  The HTTPS remote service responded afterward.
- Native HTTPS PIN display and verification returned 200.
  The resulting credential was saved with directory mode 0700 and file mode 0600.
  Neither PIN nor credential was logged.
- The production TypeScript client connected to the real receiver through a temporary loopback-to-native-TCP relay.
  Home, right, left, up, down, menu, back, and home requests completed successfully.
  The user subsequently confirmed Home returned from YouTube to the Fire TV home screen and all four arrow directions changed the highlighted item.
  Menu and back were protocol-level acknowledgments only in that session.
- Disconnect/reconnect with the saved credential succeeded through the relay.
  A command after disconnect was rejected locally.
- The receiver reported a hidden keyboard with null mode.
  The client correctly refused text input in that state.
  With a text-entry field open, it reported state `visible`, mode `keyboard`, then state `text`, mode `keyboard` after manual typing.
  A request to the obsolete text route returned 200 without visible input.
  A whole-string `POST /v1/FireTV/keyboard` visibly entered `LibreControl cafe`, as confirmed by the user.
- The compiled CLI connected, read status/properties/keyboard state, sent home, disconnected, and exited with code 0 against the same real receiver through the relay.
  CLI output did not contain the credential.
- The temporary relay and temporary CLI state were removed after testing.
  No relay, native-tool transport fallback, or ADB dependency was added to production code.
- Native TCP connection to voice port 9090 succeeded.
  This establishes reachability, not an Alexa response.
- The first owned-client voice attempt failed while connecting to the remote API, before voice start or audio streaming.
  Explicit DIAL reactivation then returned 201.
  The user stepped away and requested that further real-device verification be deferred.
  No voice audio was sent in that attempt; the later direct test below verified Alexa interpretation.

### Owned voice implementation readiness

The package now owns the authenticated start/stop requests, TLS WebSocket transport, masked PCM frames, real-time pacing, lifecycle cleanup, and WAV parser.
No external Fire TV protocol library or runtime audio converter is used.
The Google TV `open-youtube.wav` asset was converted from mono 8 kHz signed 16-bit PCM to mono 16 kHz signed 16-bit little-endian PCM.
The converted fixture contains 40,960 PCM bytes covering 1.28 seconds, with its data chunk after metadata at offset 4096.
Automated native HTTP/WSS fixtures verify byte fidelity, pacing under stalls, control-frame backpressure, cancellation, revoked/replaced credential recovery, format validation, and CLI cleanup.
Both compiled CLI acceptance scenarios passed, and the voice scenario also passed on Node 20.
These are synthetic receiver checks, not evidence of an Alexa response on the user's stick.

### Direct hardware validation on 2026-10-19

In the earlier session, direct Node socket requests returned `EHOSTUNREACH`, while native `nc` and `curl` reached the receiver.
macOS Local Network permission was suspected but not confirmed.
The direct discovery and authenticated command results below supersede that earlier connectivity blocker.
Native Bonjour did not show `_amzn-fireTv._tcp` advertisements before or after DIAL activation on 2026-10-13; manual addressing was required then.
On 2026-10-19, with the stick powered and its TV off, SSDP/DIAL discovery found its device-description endpoint without a supplied IP.
The description identified manufacturer Amazon and model AFTMA08C15.
The updated production `discoverFireTv()` returned the receiver's friendly name, UUID, current address, and remote port 8080.
The saved previous address was stale; the newly discovered address's remote port was not reachable in a separate native probe.
Automatic discovery is verified for this setup; remote-service connectivity and TV wake are separate and were not established by discovery.
After explicit DIAL activation, the saved credential authenticated successfully at the discovered address without a TCP relay.
A native Home request was accepted, and the user confirmed that it turned on the connected TV.
With the stick connected to the TV, properties reported `powerSupport: MaybeSupported` and `volumeSupport: MaybeSupported`, unlike the earlier monitor setup.
Those flags alone do not establish discrete power, volume, or mute endpoints.
The user confirmed all four directional controls, Back, and Menu on the Fire TV home screen.
Menu's effect inside Netflix was not established; its home-screen options appeared after Home and an eight-second wait.
Select opened the playback path, and the user confirmed that Play/Pause paused the movie.
A forward scan with `durationInSeconds: "5"` was accepted but caused continuing forward movement, not a verified five-second jump.
A backward scan returned HTTP 400.
The user confirmed that a subsequent Play/Pause stopped forward scanning and resumed normal movie playback.
The user confirmed that `Matrix` appeared in native Fire TV search after the API reported `visible` / `keyboard`.
Netflix search reported `hidden` / null despite user-visible focus; the client refused text input there.
The owned voice implementation started recording and streamed the included sample; the user confirmed that YouTube opened.
The initial implementation timed out waiting for WebSocket close, despite a successful HTTP stop.
Concurrent HTTP stop alone did not resolve the real-device timeout.
Ending the TLS write side after flushing the WebSocket close frame resolved it.
With both changes in the production client, direct voice streaming and stop completed successfully; stop took 85 ms in the final hardware smoke.
The same smoke sent `sendKey("powerToggle")` successfully through the public library.
The current capability endpoint reported `isVolumeControlsSupported: false`, while power and volume levels remained `MaybeSupported`.
An empty-body `POST /v1/FireTV?action=power` returned HTTP 200, and the user confirmed that the TV turned off.
This is exposed as `powerToggle`, not a state-aware or discrete power-off operation.
No verified direct LAN volume-up, volume-down, or mute request was identified.
A synthesized Alexa volume-up request streamed successfully but produced no observed volume change; the user rejected voice as a replacement for direct volume buttons.
Direct volume and mute controls are unavailable through the current adapter.
Active keyboard Unicode input, reverse seeking, and credential-revocation handling remain unverified on the real receiver.
The unauthenticated HTTPS status request returned 403 rather than the older community documentation's 401.
No authentication-failure transition was tested by revoking the user's valid pairing.

## Prerequisites

- Package installation and `yarn verify` completed by the integrator; no test/build result is asserted by this guide.
- Receiver and Node computer on the same trusted LAN, without client isolation or a guest-network boundary.
- Physical remote available for recovery and opening a text-entry field.
- Identify the receiver's address from its settings/router.
  Do not enable ADB: this package does not need or use it.
- Understand that default HTTPS is encrypted but **does not authenticate peer identity** (`rejectUnauthorized: false`).
  Do not test over an untrusted network or expose receiver ports to the internet.

## Validation sequence

1. Start `yarn cli`, run `/scan`, then `/devices`.
   Record which receivers are discovered and their remote addresses/ports.
   Discovery searches mDNS and SSDP/DIAL without activating the remote service.
   A discovery miss does not establish that HTTP control is absent; multicast can be filtered.
   Use `/add <address> [name]` only if automatic discovery cannot find the identified receiver.
2. Confirm bare hosts select HTTPS.
   Use `/pair <id>`.
   The receiver should visibly display a PIN.
   Enter `/code` followed by those four digits privately.
   The CLI must report pairing without printing the PIN or token.
   Optionally enter one incorrect four-digit code first, observe rejection, then enter the correct one without opening another session.
3. Run `/connect <id>`, then `/status` and `/properties`.
   Record only non-secret status fields and reported support flags.
   Properties alone do not establish controllable endpoints; volume/mute controls are not exposed.
   Test `/power-toggle` separately when a TV power change is safe, and confirm the actual effect.
   Do not repeat or automatically retry a power toggle merely because the current TV state is unknown.
4. On a safe home-screen view, test `/up`, `/down`, `/left`, `/right`, `/select`, `/back`, `/home`, `/menu` one at a time.
   Confirm a visible navigation effect and no stuck key.
   If the receiver behaves unexpectedly, stop and use the physical remote.
   Do not infer success solely from an HTTP response.
5. Open a search/text field using the physical remote.
   Run `/keyboard`; record the non-secret state/mode (avoid sharing entered text).
   Try `/text` with a short ASCII string, then a non-ASCII character and a supplementary Unicode character.
   Confirm the actual text onscreen.
   If the keyboard state is not recognized, report its state/mode and firmware details rather than bypassing the active-keyboard requirement.
   The corrected client sends one whole-string request to `/v1/FireTV/keyboard` and recognizes the observed `text` focus state.
   Record visible text rather than assuming that an HTTP acknowledgment or keyboard snapshot proves insertion.
   Actual cursor/composition effects may depend on the receiver and app; no append/replacement guarantee is asserted.
6. With the receiver on a safe screen, run `/voice wav tests/fixtures/open-youtube.wav`.
   The command validates the WAV, starts recording, streams paced raw PCM, closes the voice socket, and stops recording.
   Observe whether Alexa responds or an app opens; a `voice streamed` CLI message proves transport completion only.
   Record any displayed interpretation or error without recording credentials.
   Do not run this test while the observer is away.
7. Start known playable content manually.
   Run `/playpause` twice, observing pause then resume (or the reverse).
   Test `/scan-forward 5` and `/scan-backward 5` where seeking is supported by that player.
   App-level playback/seek restrictions are distinct from transport/API compatibility.
8. Quit, restart the CLI from the same working directory/state directory, and run `/connect <id>` without new PIN entry.
   Confirm navigation succeeds with persisted credentials.
   Confirm state directory/file modes are 0700/0600 on a POSIX filesystem without printing file contents.
9. Run `/disconnect`, then a navigation command.
   It should reject locally.
   Reconnect and verify one command.
   Confirm `/quit`, EOF and SIGINT terminate without hanging.
10. If appropriate, explicitly run `/launch <id>` to test DIAL remote-app activation.
    Record whether the HTTP DIAL service returns 201 and whether there is an observable receiver effect.
    DIAL is not invoked automatically and failure does not justify hiding a pairing error.
11. If receiver settings provide a way to revoke paired client access, revoke this client and try a command.
    An HTTP 401 or 403 should require pairing and explicit connection again.
    Do not manufacture destructive receiver changes solely to test this case.

## Transport troubleshooting

The older community protocol notes show HTTP examples; a newer independent implementation uses HTTPS.
Default to HTTPS.
If pairing fails, record only the sanitized error class/status, firmware, address and port.
Do not automatically downgrade or assume a TLS failure means HTTP is supported.
Test an explicit `/add http://<address>:<port>` only if you have independently established that this receiver exposes a clear-text remote service and accept that credentials will be unencrypted.

For a library-level certificate check, instantiate with `rejectUnauthorized: true` and attempt connection using a securely supplied token.
A self-signed/untrusted receiver certificate should fail normal certificate validation; do not share raw certificates or captures without reviewing them for secrets.
Default permissive TLS success is not evidence of trusted peer identity.

Check LAN routing/firewall rules for remote port 8080, DIAL 8009, and mDNS UDP 5353 without exposing them publicly.
Manual add separates multicast discovery problems from control-service reachability.
Unexpected errors are surfaced, not silently retried.
If cancellation occurs after a received key-down, remote release cannot be guaranteed; recover with the physical remote and avoid prolonged held-key experiments.

## What to report

Provide model/build/date, selected HTTP/HTTPS transport, discovered service/port, sanitized status fields, which visible navigation/media/text/DIAL behaviors worked, and exact sanitized failure messages.
Mark each behavior as observed, failed, or not attempted.
Omit PINs, tokens, state-file contents and unredacted captures.
Only these observations can turn the current compatibility hypothesis into evidence for this specific firmware.
