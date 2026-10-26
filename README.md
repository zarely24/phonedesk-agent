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

**Rule: anything on a timer must use `_adbAsync`, never `_adb`.** And since v0.5.4 the same goes for
anything that runs on every reconnect or that VAs trigger all day (the charge probe, the policy push,
upload-to-gallery, the meta reply after a profile switch) — "rare" turned out to mean forty times an
hour on a busy computer. The only synchronous adb left is behind genuinely rare owner actions: pairing
(`getprop`), creating or renaming profiles, and the full "refresh everything" button.
`tools/test-nonblocking.js` and `tools/test-freeze-paths.js` enforce this.

---

## The second thing to understand: the congestion valve (v0.5.8)

**Until v0.5.8 nothing on the video path ever dropped a frame.** The phone encodes at whatever the
viewer's page asked for; this process forwards every frame into its WebSocket to the backend; the
backend forwards every frame to the viewer. So when the farm's upload could not carry what the phones
were producing - a Starlink dip, a keyframe burst, one more viewer than the budget assumed - the
frames did not get smaller, they **queued**: first in this process's socket buffer, then in the
Windows kernel's send buffer (which autotunes to megabytes = many seconds at 120 kbit/s). The VA saw
the picture freeze, then fast-forward, then freeze again, and the delay only grew until something
reconnected. That is why VAs reloaded the phone page a hundred times an hour: a reload was the only
thing that emptied the queue. The 2026-10-25 shift had both computers on the bottom rung of the
ladder (120 kbit/s, 256 px) for eight hours and it *still* lagged, because a fixed bitrate cannot
follow a line that moves.

`src/congestion.js` is the valve, one `TunnelGovernor` per stream, wired into `openTunnel`:

1. **It watches the queue.** `tunnel.bufferedAmount` (bytes handed to the socket and not yet
   written) divided by the rate frames are arriving = how late the viewer is about to be. Plus a ws
   **ping every second** on the tunnel: the pong waits behind everything queued in the kernel, which
   `bufferedAmount` cannot see, so pong time above the best RTT seen = kernel queue.
2. **Over the threshold (600 ms of video, or 96 KB, or 800 ms of pong lag) it stops forwarding
   video.** The viewer's picture simply holds still. Device messages (clipboard, rotation) and text
   are never held. Nothing new enters the queue, so it drains at line speed - typically under a second.
3. **Once drained, it asks the phone for a keyframe** - a decoder cannot resume on a P-frame. It
   replays the viewer's own `TYPE_CHANGE_STREAM_PARAMETERS` command (captured as it passed through,
   including from the pre-open buffer where the first one always is) with the bitrate lowered by
   **1 bit/s** (alternating -1/-2 so consecutive forces still differ). ws-scrcpy's server restarts
   the encoder on any settings change, and a restart begins with SPS/PPS/IDR. Rate-limited to one
   request per 1.5 s. If no settings command has been seen yet it logs that and waits for the natural
   keyframe (up to `iFrameInterval` away).
4. **It resumes on the first SPS/PPS/IDR** - with zero accumulated delay.
5. **It tells the backend** (`{"op":"congestion"}` on the phone-home socket, at most once per 5 s per
   computer). The backend owns bitrates: it cuts that computer's budget (to 70 %, or 85 % of what is
   actually arriving) and the stream pages follow within a poll, so the congestion does not simply
   recur. The agent never picks a bitrate itself - two controllers on one encoder would oscillate.

Every meta beat's `host` block now carries `congestion: {streams, dropping_streams, events_5m,
max_queue_ms, pong_lag_ms, rtt_ms, dropped_frames}` for the dashboard. Log lines to look for:
`uplink congested - holding the picture still until the queue drains (queue N ms, pong lag N ms, …)`
and `video resumed after N ms congestion (dropped N frames / N KB total, peak queue N ms)`.

What a VA sees now: a brief still picture (about a second) instead of ten seconds of growing lag,
and the picture comes back *current*. Smooth is the goal; sharp is what the budget can afford.

Everything in the governor is synchronous and allocation-free per frame on purpose - it runs on the
relay's event loop for every video message of every phone. `npm run test:congestion`
(`tools/test_congestion.js`, 64 checks) covers the frame classification, the settings-frame
capture/nudge, the state machine, the pong accounting and the real `openTunnel` wiring over fake
sockets. **Not yet verified on a real phone** at the time of release - the first real shift is the
test; the `[congestion]` lines in the backend's per-phone log view are the evidence.

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

**Since v0.5.6 the dashboard can finish a release:** "Fleet apps -> Update agents now" tells each
computer to restart into a downloaded update (or to check GitHub right away). The click at the PC is
only needed for computers still on 0.5.5 or older.

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

## Fleet chores from the farm PC (no release needed)

Some jobs are faster done **on the farm PC itself** than through the dashboard, because every phone
on that PC is on USB and one adb loop reaches all of them. The scripts in `tools/` are for the person
sitting at (or remoted into) the PC. They use the agent's **own bundled adb.exe**
(`%LOCALAPPDATA%\Programs\PhoneDesk\resources\adb\win\adb.exe`); that is deliberate - a different
adb version restarts the adb server, which kicks every live VA stream on that PC for a few seconds.

### Install an app on every phone and every profile - `tools/install-app-everywhere.ps1`

Why it exists (2026-10-24): the owner asked for ChatGPT and X on all 38 phones in all profiles. Doing
that by hand is Play Store -> Install, per phone, per profile - hours. The dashboard's per-phone
"Add apps to profiles" button cannot do it either: it only *clones* an app that is already on that
phone into its other profiles, and (until the agent ships `list_apps`/`install_apps`) the fleet agent
does not answer it at all. The script does the whole thing in one go, from one phone that has the app:

1. `pm path <pkg>` on a phone that already has the app (the "source"; auto-detected, or `-Source <serial>`)
   lists its APK files - Play Store apps are a base APK plus split APKs (CPU, screen density, language).
2. `adb pull` each of them to `%TEMP%`. Pulling a Play-installed APK needs no root.
3. On every other phone: `adb install-multiple -r <all the splits>`. **Without `--user`, `pm install`
   targets all users** (`INSTALL_ALL_USERS`), so every existing profile gets it in this one step.
4. Then `pm list packages --user <id>` for each profile from `pm list users`, and `pm install-existing
   --user <id> <pkg>` for any profile that still lacks it (the same command bulk profile creation uses -
   no download, it just enables the already-present code for that profile).
5. A summary table per package x phone: `ok`, `PARTIAL` (some profile refused), `FAILED` (install
   error, e.g. `INSTALL_FAILED_INSUFFICIENT_STORAGE`), or `SKIPPED - no source phone`.

Run it from a PowerShell window on the farm PC:

```powershell
powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1                                   # ChatGPT + X
powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1 -Packages com.openai.chatgpt      # one app
powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1 -Only SERIAL1,SERIAL2             # some phones
```

Facts worth knowing:

- **Install the app from the Play Store on ONE phone first** (any profile). No phone has it -> the
  script says so and skips that package. Copying from a phone, not from an APK site, keeps Google's
  signature, so Play Store updates on the other 37 keep working.
- The whole fleet is Pixel 6a / 8 / 8a (all arm64, same density class), so one phone's split set fits
  every other phone. If a model with a different screen density ever joins, pull from a phone of that
  model (`-Source`) for those.
- **Safe to re-run**: phones and profiles that already have the app are skipped; a half-finished run
  just continues.
- Run it **while the agent is running** - it shares the agent's adb server. Each full install moves
  ~100-200 MB over USB and takes 20-40 s; the VA on that phone sees nothing except a slower stream
  for that moment. 38 phones x 2 apps is roughly 20-30 minutes per PC, hands-off.
- Profiles created *later* get the app the normal way: bulk profile creation already runs
  `pm install-existing` for its package, and the dashboard button handles the rest once the agent
  learns the op.
- Package names: ChatGPT `com.openai.chatgpt`, X `com.twitter.android`, Instagram
  `com.instagram.android`, TikTok `com.zhiliaoapp.musically`.
- It was tested against a simulated adb (3 phones, mixed profile counts, one failing install, an
  already-complete re-run), not yet on the farm. First real run: watch the first phone's row before
  walking away.

---

## Release history

| Version | What changed |
|---|---|
| **v0.5.8** | **The congestion valve: video is held still and resumed on a fresh keyframe instead of lagging.** Nothing on the path ever dropped a frame before, so a line that could not carry the phones' output queued it (socket buffer, then the kernel's) and VAs saw freeze / fast-forward / growing delay until they reloaded - the 2026-10-25 shift lagged all day on the bottom rung. Now each tunnel has a `TunnelGovernor` (`src/congestion.js`): it measures the queue (`bufferedAmount` / arrival rate, plus a 1 s ws ping whose pong lag exposes the kernel buffer), stops forwarding video past 600 ms / 96 KB / 800 ms pong lag, lets the queue drain, forces a keyframe by replaying the viewer's settings command with the bitrate nudged by 1 bit/s (ws-scrcpy restarts the encoder on any change), resumes on the SPS/PPS/IDR, and reports `{"op":"congestion"}` to the backend (≤ 1 per 5 s per computer) so the budget is cut and the pages ask for less. Device messages and text are never held. `host.congestion` in the meta beat. `npm run test:congestion` (64 checks). See "The second thing to understand" above. Not yet seen on a real phone at release time. |
| **v0.5.7** | **Fleet apps, after the first real run (2026-10-24, ChatGPT on PC 1).** What the farm taught us: a fresh install of a 110 MB app takes **40-55 s per phone**, but the two phones that *already had* ChatGPT took 8 and 13 minutes to be re-installed over (the first of them, which also downloaded the set, hit the 10-minute cap and was killed as "failed"). Three changes: (1) the install limit is **25 min** (`INSTALL_LIMIT_MS`; the backend waits 45); (2) **a phone that already has this exact `version_code` is not pushed again** - the agent only checks every profile and `pm install-existing`s the missing ones, seconds instead of minutes (the phone the app was copied from, a re-run after a new profile was created, phones where a VA installed it by hand), reply carries `already: true`; (3) **failures show adb's reason, not the command line** - `_adbWhy()` drops the `Command failed: C:\...\adb.exe ...` prefix and keeps adb's last line, and a timeout says "adb gave no answer in 25 min". `tools/test_fleet_apps.js` is at 37 checks. |
| **v0.5.6** | **Fleet apps: the dashboard can install or remove any app on every phone, in every profile.** Six RPC ops: `list_apps` / `install_apps` (the per-phone "Add apps to profiles" button finally gets an answer - it had been timing out since the backend shipped it), `export_app` (pull a Play-installed app's base + split APKs off this phone with `pm path` + `adb pull`, PUT them to the backend with the device token), `install_app` (download the set ONCE per computer into `%TEMP%\pd_fleet_<id>`, `adb install-multiple -r` = every existing profile, then verify each profile and `pm install-existing` any that was missed; one install at a time per computer), `uninstall_app` (`pm uninstall`, all profiles), `update_now` (restart into a downloaded update, or check GitHub right now - so no release after this one needs anyone at the PC). The meta beat now carries `agent_version`. All async (`_adbLong` / spawn): the video relay never blocks. `tools/test_fleet_apps.js` (30 checks). |
| **v0.5.5** | **H.265 over WebRTC, dormant until the backend opts a phone in.** The WebRTC POC could only send H.264 because the only scrcpy server we shipped (1.19-ws7, ws-scrcpy's) predates codec selection. The agent now also bundles the upstream **scrcpy-server 5.0.1** (`resources/scrcpy/`, sha256 `764eb6f7…3bc536`, pushed to the phone as `/data/local/tmp/scrcpy-server-pd5.jar` so it never collides with ws-scrcpy's jar) and can ask it for `video_codec=h265`. `src/scrcpy-capture.js` speaks the 5.x wire protocol (dummy byte, 64-byte device name, u32 codec id, 12-byte session/media records told apart by the top bit); `src/h265-rtp.js` packetizes HEVC per RFC 7798 (single-NAL + FU type 49, VPS/SPS/PPS re-sent with every IRAP). **Nothing changes unless two env vars are set on the owner's machine:** `WEBRTC_ENABLED=1` (as before) and `WEBRTC_CODEC=h265`. With both, the SDP offer lists H.265 first and H.264 second; the capture starts only after the browser answers, using whichever codec it accepted, so a browser without HEVC decode (Edge, old Chrome, no hardware decoder) silently gets the old H.264 path and a browser that accepts neither makes the agent close the session so the page falls back to the legacy stream. `WEBRTC_CODEC=h265-only` removes the H.264 safety net for experiments. Verified without a phone: `npm run test:rtp` (76 checks), `node tools/test_webrtc_negotiation.js` (14 checks, a werift peer plays the browser), and `node tools/rtp-ffmpeg-check.js <clip.h265>` (our RTP into ffmpeg's own RFC 7798 depacketizer + decoder: 180/180 frames). **Not yet verified on a phone** — `npm run webrtc-diagnose -- --codec both` on the farm host is the next step; see `docs/webrtc-hardware-validation.md` rows B1–B5 | **v0.5.5 also moves the switch to the server:** `open_webrtc` from a backend that sends `enabled: true` (it only does so for phones in its `WEBRTC_DEVICE_IDS`) is enough to run a session, and its `codec` field (the server's `WEBRTC_CODEC`) picks what is offered — so nobody has to set `WEBRTC_ENABLED` / `WEBRTC_CODEC` on the farm computer any more. Those variables still win when they exist (`WEBRTC_ENABLED=0` is an owner veto). The backend also now hands the agent the same TURN credentials it gives the browser, which the farm's Starlink CGNAT needs. Tests: `npm run test:webrtc` (negotiation + the switch rules), `npm run test:rtp`.
| **v0.5.4** | **No more frozen video from reconnects, uploads and profile switches.** Measured 2026-10-20 on PC 2: one Pixel 8a with a flaky USB link reconnected 36 times in 29 minutes and every reconnect ran the synchronous charge probe (~1.1 s) plus the backend's policy re-push (~1.7 s more), 27 profile switches each ended in a blocking meta reply, and three gallery uploads sat in 8 s adb timeouts — the single thread that relays all 20 phones' video on that computer was frozen for minutes per half hour, which VAs saw as screens going black and phones "disconnecting". Now: the charge probe is async and cached per serial across reconnects (zero adb calls on a reconnect), an identical policy push is skipped, every meta reply and the whole upload-to-gallery path use the async adb helper, the blocking readers are deleted, a phone is only dropped after missing from two consecutive `adb devices` scans (with the reason logged), and every socket close logs its code. Also: after a profile switch the agent sets stay-awake-while-plugged and a 30-minute screen timeout on the new profile (`Keep screen on: PASS/FAIL`), because a fresh profile's 30 s default is what made the Pixel 8s "go black" after a switch. Tests: `npm run test:freeze` (`tools/test-nonblocking.js` + `tools/test-freeze-paths.js`) |
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

## Fleet apps ops (v0.5.6)

The dashboard's "Fleet apps" section (backend README, same heading) drives these over the normal
phone-home socket as request/response ops (`request_id` in, `rpc_result` out):

| op | in | does | out |
|---|---|---|---|
| `list_apps` | - | `pm list packages -3 --user <id>` per profile | `by_user {uid: [pkg]}` |
| `install_apps` | `user_ids, packages` | `pm install-existing --user` per pair (clone an app the phone has into other profiles) | `results [{uid, package, ok, error}]`, fresh `by_user` |
| `export_app` | `app_id, package` | `pm path` -> `adb pull` each APK -> `PUT /api/fleet-apps/{app_id}/files/{idx}?token=<device token>` | `files [{idx,name,size}]`, `version_name`, `version_code`; `not_installed` if the phone lacks it |
| `install_app` | `app_id, package, files, version_code` | if the phone already has exactly `version_code`: skip the push, verify per profile, `pm install-existing` the missed ones (seconds). Otherwise download the set once per computer (cached 24 h in `%TEMP%\pd_fleet_<app_id>`), `adb install-multiple -r <files>` (no `--user` = all profiles; 25 min limit, ~45 s real for a fresh install), then verify + repair the same way | `state installed / partial / failed`, `per_user`, `missing`, `already`, adb's reason (or "adb gave no answer in 25 min"), `seconds` |
| `uninstall_app` | `package` | `pm uninstall <pkg>` (all profiles) | `removed / absent / failed` |
| `update_now` | - | main.js: `quitAndInstall()` if an update is downloaded, else `checkForUpdates()` now | `restarting / downloading / checking / dev_build`; old agents never answer |

Rules that matter here:

- **A fresh install is under a minute; re-installing over a copy the phone already has took 8-13
  minutes** in the first real run (two Pixel 6a that already had ChatGPT; why Android is that slow
  there is not understood). The same-version shortcut makes those phones a few seconds instead, and
  the 25-minute limit is the safety net for the ones that still have to be pushed over.

- **Everything is async** (`_adbLong`, `spawn`). The relay is this event loop; a 150 MB
  `install-multiple` through `execFileSync` would freeze every phone's video for a minute.
- **Installs and uninstalls on one computer run one at a time** (`_fleetSerial`). Eighteen phones share
  one USB tree and one CPU; the backend also dispatches one phone per computer, this is the local guard.
- **Package names are validated** (`[A-Za-z0-9_.]{3,200}`) before anything reaches adb; `app_id` too.
- **Pulling a Play-installed APK needs no root** (`/data/app/~~*/<pkg>-*/` is world-readable). A
  system app or an app protected by a device policy would fail the pull - the reply says why.
- Reinstalling over a different signature (sideloaded APKMirror build over a Play build, or the other
  way round) fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; the row shows that text.

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

**The connect-time charge probe used to be synchronous, and it froze whole computers (2026-10-16,
again 2026-10-20; fixed in v0.5.4).** On every socket `open`, `_applyChargePolicy` ran from the saved
policy: about five `_adb` (execFileSync) calls — `_nodeExists` for the firmware nodes and each gate,
then `_hasRoot` — ~1.1 s per phone. The `_rooted` cache did not help because `_dropDevice` deleted
the device object on every reconnect. The backend then re-pushes `set_charge_policy` on connect and
`setChargePolicy` ran the whole thing again plus a synchronous `_metaPayload` (~1.7 s). On
2026-10-16 sixteen phones reconnecting in the same second froze the loop ~30 s, longer than the
server's 20 s ping timeout, so all sixteen dropped again: a self-sustaining spiral, every screen on
that computer blank (mitigated on the server with uvicorn `--ws-ping-timeout 120`). On 2026-10-20 the
same mechanism ran at a smaller scale all shift long on PC 2: ONE Pixel 8a with a flaky USB link
reconnected 36 times in 29 minutes (83 charge probes, 41 policy pushes), plus 27 profile switches each
ending in the blocking meta reply, plus three gallery uploads whose `_adb` calls hit the 8 s cap
(`spawnSync ... ETIMEDOUT`). Add it up and the relay was frozen for a few minutes out of every half
hour, in 1–10 s bites — which VAs on the other 19 phones reported as "the screen keeps going black"
and "the phones keep disconnecting", while every phone showed Online.

What v0.5.4 changed, in `src/core.js`: the probe (`_probeChargeNodes`, `_hasRootAsync`,
`_writeNodeAsync`) is async and its result is cached **per serial in `this._chargeProbe`**, which
survives `_dropDevice` — so a reconnect costs zero adb calls, and an incomplete probe (adb failed) is
never cached. `setChargePolicy` compares the push with `dev.chargeApplied` and skips an identical one
(`... unchanged ... not re-probing` in the log). Every "reply with meta" goes through `_sendMeta`
(the async reader); the blocking `_metaPayload` / `_batteryAndCharging` / `_listUsers` /
`_currentUser` were deleted so nobody reaches for them again. Upload-to-gallery runs every adb call
through `_adbAsync` (the pushes were already async; the `content insert/query`, `mkdir`, `rm`, scan
broadcast were not). And `reconcile()` only drops a phone after it has been missing from **two**
consecutive `adb devices` scans (a USB hiccup is one), logging why:
`<serial>: adb reports it "offline" for 2 scans - dropping (USB cable/hub?)`. The socket close handler
now logs `phone-home socket closed (code N) - reconnecting in X ms` or `- dropped by this app`, so a
"keeps disconnecting" phone can be told apart from a bad cable by grep alone. The server-side ping
timeout stays as belt-and-braces.

**A profile switch now also keeps the new profile's screen on (v0.5.4).** Each Android profile has
its own screen timeout and a freshly created one defaults to 30 s; scrcpy mirrors a sleeping phone as
black, so a VA switched onto a new profile saw the phone "go black" half a minute later. After a
successful switch the agent sets `stay_on_while_plugged_in=7` (global, what Developer options "Stay
awake" sets) and that profile's `screen_off_timeout` to 30 minutes, then reads it back and logs
`Keep screen on: PASS/FAIL` next to the airplane-cycle lines. Phones that are not charging still sleep
after 30 idle minutes; the VA's power button in the viewer wakes them.

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
npm run test:freeze        # = node tools/test-nonblocking.js && node tools/test-freeze-paths.js
```

`test-nonblocking.js` proves the recurring pollers never reach the blocking adb helper — the property
that caused the worst bug in this codebase, pinned so it cannot come back. `test-freeze-paths.js`
(v0.5.4) does the same for the paths that run on every reconnect and every VA action: the charge
probe (async, cached across a `_dropDevice`, an unreachable phone is not cached), the skipped
identical policy push, upload-to-gallery, the two-scan drop debounce in `reconcile()`, and the
profile switch (keep-screen-on commands with `--user` before `put`, meta reply via the async reader).
Both stub adb entirely; no phone needed, about ten seconds (the switch test waits out the real
airplane-cycle delays).

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
