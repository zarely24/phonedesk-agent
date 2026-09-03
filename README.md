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
| `resources/` | bundled adb and ws-scrcpy, shipped via `extraResources` |

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
| **v0.4.3** | An update that is ready no longer waits to be noticed: a desktop notification plus a dialog that comes to the front, repeated every 30 minutes until the owner restarts. Update checks every 30 minutes rather than every 6 hours. Restarting stays the owner's choice, since it briefly drops every phone |
| **v0.4.2** | Reports a hashed computer id rather than the hostname — machines get named after their owners, and that name has no place on a dashboard VAs can see |
| **v0.4.1** | Host health on every heartbeat: CPU per core, busiest core, memory, phones, live streams. Cached for 10s and shared across phones, or 18 heartbeats would each recompute the CPU delta over a near-zero window and report noise |
| **v0.4.0** | **The big one.** All timer-driven adb moved off the event loop (`_adbAsync`), heartbeats staggered so 18 phones stop polling in lockstep, battery polling 10s to 30s, `adb devices` cached instead of shelling out every 2s |
| v0.3.5 | Per-computer phone limit raised from 15 to 30 |
| v0.3.4 | Repointed at `phonedesk.map-mgt.com` after the backend left Render |

---

## Gotchas

**`BACKEND` is a hostname, not an address** (`src/config.js`). Moving the backend to a different
server needs only a DNS change — no rebuild, no client action. This is how the New York migration
moved 18 phones without anyone touching the owner's machine.

**Eighteen phones all connect within a second of each other**, so anything on a per-phone timer fires
in one burst unless it is staggered. That burst is what made the blocking calls so visible.

**One shared ws-scrcpy serves every phone**, and it is single-threaded too. If CPU ever becomes the
limit, sharding phones across several ws-scrcpy processes is the next move — the dashboard's
busiest-core reading is how you would know.

**Stream quality is decided by the VA's browser, not here.** The browser tells the phone what to
encode. No change in this repo can make the video sharper or smoother by itself.

---

## Tests

```bash
node tools/test-nonblocking.js
```

Proves the recurring pollers never reach the blocking adb helper — the property that caused the worst
bug in this codebase, pinned so it cannot come back.
