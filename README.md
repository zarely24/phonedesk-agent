# PhoneDesk — owner agent

The program the **phone owner** runs on the computer their phones are plugged into. It connects each
phone over USB (adb), dials out to the backend, and relays the phone's screen to whichever VA is
watching. Nothing listens for incoming connections, so the owner needs no port forwarding, no VPN and
no fixed IP.

Electron app, Windows and macOS, auto-updating from GitHub Releases. The backend lives in
[`phonedesk-backend`](https://github.com/zarely24/phonedesk-backend).

> **Keep this file current.** Every release, setting and gotcha belongs here too.

---

## The one thing to understand before changing anything

**This process is also the video relay.** `openTunnel` in `src/core.js` pumps frames from the local
ws-scrcpy out to the backend, on the same single-threaded Node event loop as everything else.

So **any blocking call in this process freezes every phone's video** for as long as it takes.

That is not theoretical. Until v0.4.0 the adb calls used `execFileSync`, and the routine polling
(`dumpsys battery` per phone every 10s, profile lists every 60s, `adb devices` every 2s) added up to
roughly **190 blocking calls a minute** with 18 phones on one computer. Measured at the server, the
video arriving from this agent stalled 20 times in 40 seconds, the worst gap 672 ms. It was invisible
with two or three phones and crippling with eighteen.

**Rule: anything on a timer must use `_adbAsync`, never `_adb`.** One-off calls behind a human action
(switch profile, rename, upload) may stay synchronous — they are rare and not on the video path.
`tools/test-nonblocking.js` enforces this.

---

## What it does

- Detects plugged-in phones via adb, pairs each one with a code from the dashboard
- Holds one outbound WebSocket per phone to the backend (heartbeat, presence, control ops)
- Runs **one shared ws-scrcpy** process serving every phone on the machine
- Opens a tunnel per viewer on demand and bridges it to that ws-scrcpy
- Android profile switching, with an airplane-mode cycle for a fresh mobile IP
- Battery charge limiting, so phones can stay plugged in 24/7 without swelling
- Bulk profile creation, upload-to-gallery, remote refresh
- Reports host health (CPU per core, memory, phones, live streams) on every heartbeat
- Streams its own log lines to the backend for the admin log view

Up to **30 phones per computer**.

---

## Layout

| File | What lives there |
|---|---|
| `src/main.js` | Electron shell, window, auto-update, the 2s reconcile timer |
| `src/core.js` | everything else: adb, pairing, sockets, tunnels, profiles, charge limiting |
| `src/renderer/` | the small setup UI the owner sees |
| `src/webrtc.js` | the dormant WebRTC sender (POC): offers H.264, or H.265 + H.264 when `WEBRTC_CODEC=h265`, and starts the matching capture once the browser answers |
| `src/h264-rtp.js` / `src/h265-rtp.js` | Annex-B NAL parsing + RTP packetization (RFC 6184 / RFC 7798). Pure code, no hardware, unit-tested |
| `src/scrcpy-capture.js` | raw video capture from the bundled **scrcpy 5.0.1** server (the one that can do `video_codec=h265`); the legacy 1.19-ws7 jar stays H.264-only |
| `resources/` | bundled adb, ws-scrcpy (with its 1.19-ws7 scrcpy jar) and `resources/scrcpy/scrcpy-server-v5.0.1`, shipped via `extraResources` |

Pairings are stored in `agent.json` under Electron's `userData`
(`%APPDATA%\PhoneDesk` on Windows), **not** in the program folder — so updates and reinstalls keep
the phones paired.

---

## Releasing

Any `v*` tag builds Windows and macOS installers and publishes a GitHub Release:

```bash
# bump "version" in package.json first
git tag v0.4.3 && git push origin v0.4.3
```

Windows agents then **auto-update silently** on their next launch or update check (every 30 minutes
since v0.4.3). macOS is unsigned, so Mac users get a prompt instead.

Device tokens survive updates, so an update never costs a re-pairing.

Download page for a fresh install: <https://phonedesk.map-mgt.com/download/>

---

## Release history

| Version | What changed |
|---|---|
| **unreleased (2026-10-20)** | **H.265 over WebRTC, still dormant.** The WebRTC POC could only send H.264 because the only scrcpy server we shipped (1.19-ws7, ws-scrcpy's) predates codec selection. The agent now also bundles the upstream **scrcpy-server 5.0.1** (`resources/scrcpy/`, sha256 `764eb6f7…3bc536`, pushed to the phone as `/data/local/tmp/scrcpy-server-pd5.jar` so it never collides with ws-scrcpy's jar) and can ask it for `video_codec=h265`. `src/scrcpy-capture.js` speaks the 5.x wire protocol (dummy byte, 64-byte device name, u32 codec id, 12-byte session/media records told apart by the top bit); `src/h265-rtp.js` packetizes HEVC per RFC 7798 (single-NAL + FU type 49, VPS/SPS/PPS re-sent with every IRAP). **Nothing changes unless two env vars are set on the owner's machine:** `WEBRTC_ENABLED=1` (as before) and `WEBRTC_CODEC=h265`. With both, the SDP offer lists H.265 first and H.264 second; the capture starts only after the browser answers, using whichever codec it accepted, so a browser without HEVC decode (Edge, old Chrome, no hardware decoder) silently gets the old H.264 path and a browser that accepts neither makes the agent close the session so the page falls back to the legacy stream. `WEBRTC_CODEC=h265-only` removes the H.264 safety net for experiments. Verified without a phone: `npm run test:rtp` (76 checks), `node tools/test_webrtc_negotiation.js` (14 checks, a werift peer plays the browser), and `node tools/rtp-ffmpeg-check.js <clip.h265>` (our RTP into ffmpeg's own RFC 7798 depacketizer + decoder: 180/180 frames). **Not yet verified on a phone** — `npm run webrtc-diagnose -- --codec both` on the farm host is the next step; see `docs/webrtc-hardware-validation.md` rows B1–B5 |
| **v0.5.3** | Owner-window fix only, no agent/phone logic touched. In v0.5.2 the Instagram diagnostic panel was appended to `<body>` *after* `.app`, and `.app` is `height:100%` of a fixed 480x660 window - so on a computer with more than ~11 phones the list was taller than the window and the panel was painted on top of phones 29-33 ("Instagram diagnostic (advanced)" text across the rows, white input boxes over the list). Its body also carried an inline `display:flex`, which beats the `.hide` class, so it was never collapsed. And its phone picker asked the main process for a *separate* phone list via a synchronous `adb devices`; whenever adb was busy the picker stayed empty and "Run diagnostic" could only say "Pick a phone". Now: the panel lives inside the phones step below "Reset pairings", `.app` grows with the list (`min-height`), hide/show is done with id-level rules, the controls are dark-themed, and the picker is filled from the same 2 s status snapshot that draws the list (same names, same order, "- not connected" suffix for unplugged phones). Also hides the update bar properly - the same id-beats-class flaw left an empty bar with a blue pill at the bottom of every window since v0.4.3 |
| **v0.5.2** | Profile switch now *verifies* the airplane-mode cycle (Airplane ON / OFF / mobile-network recovery each reported PASS or FAIL via telephony state, not just ping), the read-only Instagram status diagnostic (`tools/ig-status-diagnose.js`, manual launcher in the owner window, and the `ig_diagnostic` RPC op so the backend can trigger it) and the monitoring fixtures/classifier tests |
| **v0.5.1** | Ships the WebRTC-capable agent, dormant by default. The WebRTC path is a proof of concept: no TURN, unvalidated on real hardware - do not switch it on for the farm |
| **v0.5.0** | Device controls from the dashboard: `input_key`, `input_text`, `screenshot`, `launch_app`, `open_url` RPC ops; the Instagram status classifier (dormant); fleet canary/update/rollback runbooks under `deploy/` |
| **v0.4.5** | Upload-to-gallery works for secondary profiles again. The MediaStore `_id` lookup after insert passed its WHERE clause unquoted through `adb shell`, so the phone's shell stripped the SQL quotes and the row never matched — every non-root secondary-profile upload failed with "MediaStore row not found after insert". The `content` insert/query are now sent as one shell-quoted command; also fixes filenames containing a space |
| **v0.4.4** | Each agent measures its own upload speed and reports it, so the fleet's bitrate budget tracks the line the phones are actually on instead of a number typed into config |
| **v0.4.3** | An update that is ready no longer waits to be noticed: a desktop notification plus a dialog that comes to the front, repeated every 30 minutes until the owner restarts. Update checks every 30 minutes rather than every 6 hours. Restarting stays the owner's choice, since it briefly drops every phone |
| **v0.4.2** | Reports a hashed computer id rather than the hostname — machines get named after their owners, and that name has no place on a dashboard VAs can see |
| **v0.4.1** | Host health on every heartbeat: CPU per core, busiest core, memory, phones, live streams. Cached for 10s and shared across phones, or 18 heartbeats would each recompute the CPU delta over a near-zero window and report noise |
| **v0.4.0** | **The big one.** All timer-driven adb moved off the event loop (`_adbAsync`), heartbeats staggered so 18 phones stop polling in lockstep, battery polling 10s to 30s, `adb devices` cached instead of shelling out every 2s |
| v0.3.5 | Per-computer phone limit raised from 15 to 30 |
| v0.3.4 | Repointed at `phonedesk.map-mgt.com` after the backend left Render |

---

## Gotchas

**The owner window is a fixed 480x660 and `.app` is `height:100%`** (`src/renderer/style.css`). Anything
you append to `<body>` after `.app` is laid out at the 660 px mark - which, once the phone list is longer
than the window (about 11 phones), is *on top of the list*. New panels go **inside the step they belong
to** (`#s-phones` etc.), and `index.html` now overrides `.app` to `min-height:100%` so a long list grows
the page and scrolls. Same file, same trap: `.hide` is a plain class, so any id-level `display:` rule or
inline `style="display:..."` wins over it and the element is never hidden - that is how the v0.5.2
diagnostic panel was always expanded and how the update bar showed as an empty blue pill since v0.4.3.
Every element that gets `.hide` toggled and also has an id-level display rule needs an explicit
`#thatid.hide { display:none }`. Test the window with a long list before tagging: serve
`src/renderer/` with a stub `window.agent` that pushes 20 phones and screenshot it headless at 480x660
(`chrome --headless=new --window-size=480,660 --screenshot ...`); the real Electron window is not
resizable, so a layout that fits 5 phones tells you nothing about the farm.

**`BACKEND` is a hostname, not an address** (`src/config.js`). Moving the backend to a different
server needs only a DNS change — no rebuild, no client action. This is how the New York migration
moved 18 phones without anyone touching the owner's machine.

**Eighteen phones all connect within a second of each other**, so anything on a per-phone timer fires
in one burst unless it is staggered. That burst is what made the blocking calls so visible.

**The connect-time charge probe is still synchronous, and it is a fleet-wide outage waiting to
happen (2026-10-16).** On every socket `open`, `_applyChargePolicy` runs from the saved policy: about
five `_adb` (execFileSync) calls — `_nodeExists` for the firmware nodes and each gate, then `_hasRoot`
— ~1.1 s per phone. The `_rooted` cache does not help because `_dropDevice` deletes the device object
on every reconnect. The backend then re-pushes `set_charge_policy` on connect and `setChargePolicy`
runs the whole thing again plus a synchronous `_metaPayload`. Sixteen phones reconnecting in the same
second = the event loop frozen ~30 s, which exceeded the server's 20 s ping timeout, which dropped
all sixteen again: a self-sustaining reconnect spiral in which no `open_stream` is answered inside the
viewer's 10 s window, so every phone on that computer shows Online with a blank screen and the row's
Refresh (which only reconnects the socket) cannot help. It was triggered by one `spawnSync` gallery
upload timing out (`upload 8.MOV failed: ... ETIMEDOUT`). Mitigated on the server (uvicorn
`--ws-ping-timeout 120`, see the backend README, Diagnostics). **The fix that belongs here:** move
`_nodeExists` / `_hasRoot` / `_restoreCharging` and `setChargePolicy`'s meta reply onto `_adbAsync`,
keep `_rooted` in the token file so a reconnect does not re-probe, and make `uploadMedia` use
`execFile` with a timeout instead of `spawnSync`. Charge limiting is "unavailable (phone is not
rooted)" on every phone in the fleet today, so until then the cheapest relief is to not re-push the
policy on connect at all.

**One shared ws-scrcpy serves every phone**, and it is single-threaded too. If CPU ever becomes the
limit, sharding phones across several ws-scrcpy processes is the next move — the dashboard's
busiest-core reading is how you would know.

**Stream quality is decided by the backend, applied by the VA's browser, and never here.** Since
2026-09-07 the backend divides the farm's upload budget by however many streams are live on THIS
computer and hands each viewer a rung off a ladder; the browser then tells the phone what to encode.
No change in this repo can make the video sharper or smoother by itself.

**This repo does measure the line, though.** Every ~20 minutes `_uplinkProbe` pushes a 256 KB burst
of random bytes at `POST /api/uplink-probe` and the backend times its arrival — that is the farm's
real upload speed, measured over the exact path the video takes rather than to a speedtest mirror
that may be much closer. It runs **only when `_openTunnels === 0`**: a probe competing with a VA's
video makes both numbers meaningless and visibly stutters the stream, which on a 0.79 Mbit/s line is
not subtle. The first run is delayed and the interval jittered, because eighteen agents come back
from a power cut within seconds of each other and would otherwise measure nothing but themselves.
Random bytes rather than zeroes, so nothing on the path can compress the burst and make the line
look faster than it is. The result rides back on the heartbeat as `host.uplink_bps` for the
dashboard; the backend records its own copy and that is the one that sets quality.

The one thing this repo does contribute is the grouping key. The heartbeat's `host.id` — a hash of
the hostname, so the dashboard never shows what someone called their PC — is what tells the backend
which phones share an uplink. **An agent that stops reporting it does not break quality, but it does
make it pessimistic:** the backend then counts every live stream in the fleet rather than assume the
phone is alone, because guessing high is what makes video freeze. See `backend/README.md`.

---

## Tests

```bash
node tools/test-nonblocking.js
```

Proves the recurring pollers never reach the blocking adb helper — the property that caused the worst
bug in this codebase, pinned so it cannot come back.

### WebRTC codec plumbing (no phone needed)

```bash
npm run test:rtp                          # H.264 (42 checks) + H.265 (34 checks) parse/packetize, synthetic NALs
node tools/test_webrtc_negotiation.js     # offer/answer against a werift peer: H.265 chosen, H.264 fallback, rejection
npm run rtp-check -- path/to/clip.h265    # our RTP -> ffmpeg's depacketizer+decoder; PASS = every frame decoded
```

The third one is the closest thing to a real receiver without hardware: ffmpeg implements RFC 7798 /
RFC 6184 independently of us, so if it decodes every frame our fragmentation, headers and markers are
right. Make a clip with ffmpeg itself (`testsrc2`, `libx265`, `keyint=30:repeat-headers=1:bframes=0`,
`-f hevc`); the command is in the tool's header. Note the tool replays the first GOP after the clip: RTP
has no end-of-stream and ffmpeg holds its last ~20 decoded frames until more data arrives, so without
that tail the count was always 160/180 and looked like a packetizer bug (it was not — both codecs lost
exactly the same frames).

### WebRTC on a real phone (owner's machine)

```bash
npm install
npm run webrtc-diagnose -- --codec both --seconds 8      # add --serial <serial> to pick a phone
```

Runs the legacy H.264 capture and then the scrcpy 5 H.265 capture on the same phone, prints PASS/FAIL
per step (server start, socket, VPS/SPS/PPS, IRAP, fps) plus the bitrate each codec used for the same
seconds of screen. Scroll something on the phone while it runs — a still screen makes both numbers
tiny and meaningless. The `list_encoders` line tells you whether the phone has a hardware HEVC encoder
at all (Pixel/Tensor: `c2.exynos.hevc.encoder`). Paste the whole output back; it contains no secrets.
