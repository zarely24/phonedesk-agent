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

**Its browser-side twin (backend, 2026-10-26).** The valve ends *lag* (queued video). A phone that
*froze and needed a refresh* is a different failure and lives in the browser: ws-scrcpy's WebCodecs
player stops for good on any decoder error (Chrome reclaiming the decoder of a hidden tab, a damaged
chunk, a dead connection). The stream page now runs a watchdog that notices a dead decoder, a quit
player or a silent chain (it asks for a keyframe the same way this valve does, by replaying the
settings frame with its lowest bitrate bit flipped) and reloads itself. See the backend README,
"Freezes that needed a refresh". Nothing in the agent changed for it.

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
- Brings phones that fall off adb back by itself (v0.5.19 self-recovery, see below), and reports every try

Up to **30 phones per computer**.

---

## Layout

| File | What lives there |
|---|---|
| `src/main.js` | Electron shell, window, auto-update, the 2s reconcile timer |
| `src/core.js` | everything else: adb, pairing, sockets, tunnels, profiles, charge limiting |
| `src/igpost.js` / `src/igstats.js` / `src/igcheck.js` | Instagram on the phone, PURE (no adb, tested with scripted screens): posting + whoami (v0.5.9), the whoami numbers (v0.5.12), the daily account check `ig_check` (v0.5.15) |
| `src/recovery.js` | v0.5.19 self-recovery of phones that fall off adb: the escalation ladder, the hourly cap, the agent setting. Driven by core.js through a small `host` object, tested with a fake adb |
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

**The release is named from `package.json`, not from the tag you push** (electron-builder
`--publish always` publishes `v<version>`). On 2026-11-08 `v0.5.15` was pushed while `package.json` still
said 0.5.14: the build published release **0.5.14** (tag `v0.5.14`, created by GitHub) and left a stray
`v0.5.15` tag on the 0.5.14 commit with no release. A tag that already exists cannot be pushed again, so
before tagging the real release that stray tag has to go:

```bash
git push origin :refs/tags/v0.5.15 && git tag -d v0.5.15     # only when that tag has NO release
git tag v0.5.15 && git push origin v0.5.15                   # after package.json says 0.5.15
```

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
| **v0.5.19** | **Phones that fall off adb are brought back by the app itself, and every try is reported (2026-11-13).** **Why.** On 2026-11-12 only 18 of 41 phones were online, so the 4:00 AM check read 354 of 884 profiles. Most of the missing phones were still plugged in: adb had lost them ("offline"), or they had dropped off the USB bus and come back in a state adb would not talk to. Until now `reconcile()` only noticed (it drops a phone after two missed scans) and the phone waited for a person to replug its cable. **What it does** (`src/recovery.js`, wired in `core.js` `reconcile()` / `_recoveryMgr()`): a paired phone that was seen on adb since the app started and now shows "offline" / "unauthorized" or is gone from `adb devices` for two scans is "stuck". 20 s later (a USB hiccup heals itself) the first try runs, then 1, 2, 5, 10, 20, 20... minutes apart. The tries escalate: **offline** = `adb reconnect offline`, `adb -s SERIAL reconnect`, restart adb's server, USB reset, then again from the per-phone reconnect; **unauthorized** = `adb -s SERIAL reconnect` twice (it brings the "Allow USB debugging?" prompt back), then it needs a person to tap Allow; **gone from adb** = restart adb's server, USB reset - and when neither is allowed ONE "none" report says why (a computer cannot bring back a phone it does not see on USB). **Restarting adb's server** (`kill-server` + `start-server`, then ws-scrcpy is restarted because its adb client died with the server) cuts EVERY phone of the computer for a few seconds, so it runs only when 3 or more phones are stuck, NO live screen is open on this computer (`_openTunnels`), no post / account check / profile switch is running (`_jobsRunning`), and not within 30 minutes of the last one. **USB reset** is Windows only and OFF unless the owner ticks it: `pnputil /enum-devices /connected` finds the phone's USB device (`USB\VID_xxxx&PID_xxxx\SERIAL`), `pnputil /restart-device` re-enumerates it. pnputil needs the app to run as administrator and Windows 10 2004+; when Windows refuses, the step is off until the app restarts and the report and the host stats say why. **Limits.** One try at a time for the whole computer (never a burst of adb processes on the USB tree); every command async with a timeout (10 s, start-server 20 s, pnputil 20 s) - nothing new touches the blocking `_adb`; at most 6 tries per phone in any hour, then ONE "capped" report and a wait for the hour to free up. A paired phone NOT seen on adb since the app started (moved to another computer) is left alone. **Reports.** `{op: 'recovery', data: {serial, name, step, ok, state_before, state_after, attempt, tries_hour, cap, detail, since, next_in_s, at}}` with `step` one of `reconnect_offline`, `reconnect_device`, `kill_server`, `usb_reset`, `none` (nothing to try, `detail` says why), `capped`, `back` (it came back between tries, or by itself). The stuck phone's own socket is gone, so a report rides ANY open phone-home socket of this computer; with none open (every phone down) up to 50 wait and go out with the first socket that opens. An older backend ignores the op. The heartbeat's `host` block gains `recovery: {on, usb_reset, usb_note, stuck}`. **The setting.** `agent-settings.json` next to `agent.json`: `self_recovery` and `usb_reset`, BOTH DEFAULT OFF (the farm rule: anything that acts on phones by itself ships off; the owner ticks "Bring stuck phones back by themselves" on each computer, or sets `PD_SELF_RECOVERY=1`). While it is off nothing is tried and the website says "Self-recovery is switched off on its computer"; two tick boxes under the phone list in the owner's app; `PD_SELF_RECOVERY=0/1` and `PD_USB_RESET=0/1` override the file. **Server side** (backend, same day): the "Offline phones" section on Farm health, Fix list items for phones offline 30+ minutes, the Discord "many phones offline" alert. Tests: `tools/test_recovery.js` (fake adb, fake clock). |
| **v0.5.17** | **Unread DMs and Instagram's own Account status, read during the 4:00 AM check (2026-11-11). Both READ-ONLY, both opt-in keys on the `ig_check` reply - an older backend ignores them, an older agent simply does not send them.** (1) **`dm_unread`** (int or null): the number on the Messages icon's badge - the Message tab of the bottom bar (id `direct_tab`) or, on older builds, the Messenger / Direct icon of the feed's top bar (id `action_bar_inbox_button`) - or the count in the icon's read-out ("Message, 5 unread messages"). Read off the feed and the own profile the visit is on anyway (`igcheck.parseDmUnread`, the highest reading of the visit): NO new tap, the inbox is never opened, no conversation is touched, so nothing is ever marked Seen. "9+" reads 9 (a lower bound); an icon without a badge = 0; no icon / a dot without a number / a conversation on screen = null (the reason is in the trace's `dms` line). (2) **`account_status`** (`{state: 'no_issues'\|'issues'\|'unknown', items:[{kind, title, detail}], seen:[kinds], page_ok?, why}` or null), only when the op carries **`status_page: true`** (default off): own profile -> the menu icon (Options / Menu) -> "Settings and activity" (or "Settings and privacy" on an older build's menu sheet) -> scrolled down to "Account status" -> read, scrolled at most twice -> Back, Back, verified back on the profile, BEFORE the accounts sheet. `kind`: `removed_content`, `not_recommended`, `features_limited`, `at_risk`, `monetization`. A row's verdict comes from the words / icon in its own band ("No issues", a check mark vs "1 removed post", "Issue", "can't be recommended", "You can't go live for now"), never from its title. The new taps pass `tapRefused` with a narrow allow-list (`STATUS_TAPS`: options / menu / settings and activity / settings and privacy / account status, honoured only for the step's own taps); on Settings nothing but the "Account status" row (every word under the point and in its row must be allowed - "Log out", "Add account", "Accounts Center" never are); on the Account status page NOTHING is tapped, whatever is allowed. Settings and the status page are recognised by their WRITTEN title in the title bar (not the dashboard's gear icon "Settings", not a fan named "Account status" in a thread) and before the blocks, so the page's own wording ("account at risk", "features you can't use") is never read as a block or a notice; a visit that starts on either page backs out first. A failure in the step never fails the check (`state: 'unknown'` + `why`). Logged-out / blocked / unreadable profiles: both null. `npm run test:igcheck` 269 checks. **The DM badge and the Account status page have NOT been seen on a farm phone: the fake screens in `tools/test_igcheck.js` (section 10c) are modelled on Instagram's known layouts, not on screenshots - the first real runs' `screens` + `trace` say what to tune. Nothing of this has run on a real phone.** |
| **v0.5.16** | **Instagram really opens after a profile switch; a person on the phone is really seen; nothing but a package name or a quoted link reaches a phone's shell (2026-11-10).** **The failure.** The first two 4:00 AM checks (2026-11-09 and 11-10, every phone on v0.5.15) read 165 of 884 profiles. On 2026-11-10: 672 `unreadable` / `ig_not_in_front`, each after the same 62-66 s on the Windows PCs (three launches x four looks), the saved screenshot a plain unlocked home screen, the reply's trace EMPTY. The owner profile opened on 39 of 39 phones, every other profile on 123 of 795; each failing profile was retried 3-6 times and failed every time (about 4 % of visits to a cold profile opened). **The cause** (worked out from those numbers, then every link checked against the AOSP 17 / GrapheneOS 17 source by an independent review; it was never seen in the agent's own log, which nobody could read): Android keeps 3 users running (`config_multiuserMaxRunningUsers`; a phone reported exactly owner + resting profile + the last visited one), so every profile the check visits starts cold. After `am switch-user` a cold profile is `BOOTING`, then `RUNNING_LOCKED` until its storage is unlocked, and that only begins once the new user's first screen has gone idle - Settings' placeholder home, `FallbackHome`. `_checkSettle` accepts that screen (it is 'an activity of user N'), so the very next command, `cmd package resolve-activity`, ran inside the locked window, where PackageManager matches only Direct-Boot-aware components: `No activity found`. That lookup ran ONCE, before the three tries, and the fallback was `monkey -p <pkg> --user N ...`: monkey has no `--user` option (it prints `** Error: Unknown option` and exits), so all three tries started nothing while the profile finished unlocking behind them. The same lookup-once code was in `ig_whoami`, `ig_post`, `launch_app`, the old status check and the diagnostic. **The fix.** (1) `_waitUnlocked`: one look a second at `am get-started-user-state N` (`dumpsys user` when that says nothing) until `RUNNING_UNLOCKED`, 30 s at most (10 s for open app and open link, whose backend limits are 20-25 s); it waits only while the profile is on its way (`BOOTING` / `RUNNING_LOCKED` / `RUNNING_UNLOCKING`), three looks for 'not started', not at all when Android cannot say. (2) `_startApp`: the launcher is looked up FRESH on every try; with none, a MAIN/LAUNCHER intent addressed to the package; monkey is gone everywhere. A failed start now reports Android's own words (`_adbLong` keeps stdout on an error: with `-W` the reason is printed there and adb exits 1). (3) On try 3, when the target profile's own home screen is in front, the icon labelled exactly 'Instagram' is tapped as a person would (a tappable icon, not a folder of that name). (4) `ig_post` waits for the unlock right after the switch, before the gallery push and the sound link. **What the review found and this release also fixes.** (a) *Wrong profile.* The icon tap, and the older 'the screen's package is Instagram' test, did not ask WHOSE screen was in front: a switch that Android accepted but that never reached the screen would have read another profile's account and stored it under the profile asked for. Both now require that `dumpsys activity` does not name another user. (b) *A person on the phone was never seen.* `_scrcpyRunning` - the 'someone opened the phone' test of `ig_check`, `ig_post`, `ig_whoami` and the diagnostic - searched `ps -A` for the word scrcpy. The phone-side server is started as `app_process / com.genymobile.scrcpy.Server`, so ps lists it as `app_process`, and ws-scrcpy keeps it running on every phone whether or not anyone watches: the test said 'nobody' on all ~3,100 visits of 2026-11-10. It now asks the agent itself: `openTunnel` remembers every live VIDEO stream the backend marks as a person (`watch: false` on `open_stream`; needs the backend of 2026-11-10 - an older backend says nothing and nobody is counted, as before), per phone, until its tunnel closes (a closed socket is dropped even when its close event is lost). No adb call, so every guard is also one process spawn cheaper. The unlock wait asks it at every look. (c) *Commands on the phone.* adb joins its arguments into one line that the phone's shell reads again. `launch_app`, `check_apps_installed` and the old status check passed the package name through unchecked, `open_url` and the sound link of `ig_post` passed the link unquoted: `x;reboot` or anything after an `&` ran on the phone with adb's rights, for any login that may open a phone (and every link with two parameters was cut at its `&`). Packages must now match `_validPkg`; links travel inside single quotes (`_shq`) and may hold no blank or control character. The backend refuses the same from 2026-11-10 for older agents. (d) *The next blind spot.* A failed start used to come back with an empty trace. Now every reply's trace begins with `settle` (what was in front after the switch), `unlock` (the state and the seconds waited), `launch n/3` (component / MAIN/LAUNCHER intent / icon, and what Android answered) and, for a try that failed, `front` (who and what was in front). Monitoring shows it under Details -> What the phone saw. `ig_not_in_front` now means only this start; Instagram going back to the home screen DURING a read is `ig_closed_during_read`. (e) *Logged-out screens that read as 'couldn't read'.* Meta's profiles chooser (saved profiles as rows, or one with 'Continue', then 'Use another profile' / 'Create new account'; no 'Log in' button) is now a login screen: `logged_out` / `LOGIN_REQUIRED` with the profiles it offers. Two phones showed it on 2026-11-10. `parseLoginRemembered` no longer drops usernames that merely begin with log / sign / create / forgot. (f) A phone that cannot say which profile it is on (`am get-current-user` timing out, the Mac at busy moments) is no longer switched: before, the visit ran and the phone was left on the visited profile. **Tests.** `npm run test:igcheck`: 248 checks (the review ran 74 single-change mutants of the fix against the suite and wrote the checks for the survivors: a real cold start's BOOTING -> RUNNING_LOCKED -> RUNNING_UNLOCKING, a fresh lookup on every try, adb failing the way adb fails, the other ops, a virtual clock for the time limits). `npm test` runs every suite. **Not yet seen on a phone.** The fake phone in the tests encodes the diagnosis, so a green run shows the code agrees with it, not that it is right. The proof is a SECOND pass: on one idle phone press Check this phone, let it finish, and press it again without restarting the app (v0.5.15 failed about 96 % of second-pass visits). Then read a profile's Details: `unlock` should say `RUNNING_UNLOCKED after N s` with N of a few seconds. |
| **v0.5.15** | **The 4:00 AM account check: new op `ig_check` (2026-11-08).** The owner: "open the phone and check on each profile what accounts we got and how many followers we got" and "views, usa % everything at 4am NYC TIME". The 06:00 sweep before it (`ig_whoami` + stats) read 30 usernames out of 887 profiles: every logged-out profile came back UNKNOWN, the first "What happened" notice stopped it, Instagram was started 2.5 s into `am switch-user` without anyone checking it was in front, and Insights were never opened. `ig_check {uid, shot, others, insights}` (`ig_whoami` and `ig_post` unchanged): (1) **settle + verify** - after the switch (no airplane cycle) it waits up to 15 s until that profile's own screen is resumed and no lock screen covers it (dismiss-keyguard, MENU, swipe up), then `am start -W` and checks Instagram is REALLY in front (the resumed activity for that user, or the screen dump), three tries, else `unreadable` / `ig_not_in_front`; (2) **every screen recognised** by the new pure module `src/igcheck.js`, from texts (resource-ids only as a second opinion), written from the farm's own screenshots of 2026-11-08 (phones 10 and 14): "Join Instagram" = `NO_ACCOUNT`, a login form / saved-account login = `LOGIN_REQUIRED` + the accounts it still offers, "Confirm it's you" / "Action Blocked" / suspended / disabled = blocked with that status, "What happened" notices recorded (`restriction` with its end date = `RESTRICTED` while it lasts, `removed_post`, `warning`) and closed with their X, Android's "Allow Instagram to send you notifications?" answered "Don't allow", Instagram's own prompts "Not now" and the like, promos that only Back closes, another app, the launcher, the lock screen; (3) **the profile** (title left-aligned or centred): username, name, posts / followers / following, "44.3K views in the last 30 days."; (4) **Insights**, when the profile has a "Your dashboard" row: the dashboard (period "Oct 9 - Nov 7", Views, New followers, Content you shared) -> its Views row -> Overview (tiles Views / Net followers / Interactions with one sideways swipe, followers vs non-followers %, Viewers = reach, views and interactions by content type, profile visits, bio link taps; scrolled until the screen stops changing) -> Audience (followers, "+435.1% since Oct 9", gender, age bands, the top countries and - after its chip - cities, USA %, the active-time bars of every day chip Su..Sa as shares of the tallest bar, "When followers are most active"; below 100 followers Instagram shows none: `under_100`). An Insights failure never fails the check (nulls + reasons in `why`); a tap a tooltip swallowed is tried once more; (5) **the accounts sheet** (tap the title, read, Back - never a row) and up to four other accounts read off their public profile (`VIEW https://www.instagram.com/<u>/ -p com.instagram.android`); (6) HOME + switch back BEFORE the reply, so the backend's next profile finds the phone free. READ-ONLY: a fixed list of allowed taps, and every tap passes `tapRefused` (never See why / Allow / Continue / Log in / Try Muse / Edit profile / Add account / a row of the sheet ...); a viewer opening the phone (scrcpy) stops it at once (`device_busy` / `viewer_opened`). Screen dumps are fresh (the file is removed first, its own name `pd_check.xml`) so a failed dump is never mistaken for the previous screen. Reply: see "Account check op" below. Words people wrote (a DM thread or the inbox the app resumed in, a bio, a caption) never read as a block, a notice, a pop-up or a hung app, and nothing in a conversation is tapped - see "Words people wrote" there (review of 2026-11-08). `npm run test:igcheck` (211 checks: every screenshot modelled, whole visits on a scripted phone with every tap checked against a never-tap list, and the real `igCheck` against a scripted adb). `igpost.parseDump` now also reads `selected` / `checked`. **The texts are what the phones showed on 2026-11-08 but the flow has not run on a phone yet** - the first runs' `screens` + `trace` say what to tune. |
| **v0.5.14** | **Text written by Instagram itself, and the first real post's failures fixed (2026-11-08).** (1) **Text on the reel in Instagram's own default font, plain white, wherever the owner drops it.** The owner wanted the words "in instagram's default" font, "anywhere I want", "plain white". That font (Instagram Sans, the "Classic" style) is Meta's and is not published or licensed, so no server may draw it - the phone does what a VA does: `ig_post` takes `text`, `text_x`, `text_y` (the CENTRE of the text as a share of the reel's width/height) and, when `text` is set, the flow gets `TEXT_STEPS` before the editor's Next (`igpost.withText`): tap the editor's "Aa"/Text tool, type the lines (Enter between them; `adb input text` = printable ASCII only), Done (the default style IS plain white, no band), then drag the text from where Instagram put it (the middle of the reel, or the node showing its first line when the build exposes one) to the spot (`input swipe`, 0.9 s). The reel's box on screen is the biggest reel-shaped preview/texture view in the dump, else a full-width 9:16 box in the middle of the screen; the spot is kept to x 10-90 %, y 8-80 % (Instagram's caption area and the trash bin that appears while dragging sit below). The trace line of `text-place` says the exact drag and whether the reel's box was found or assumed. A test run with text keeps the screenshot taken RIGHT AFTER the text was placed (the editor with the words on the clip) as its evidence. The backend never sends text to an agent below 0.5.14 (it would be ignored and the reel posted without it). (2) **"Continue" is no longer tapped as a pop-up dismissal.** The first real post (phone 40, 03:00 UTC) met Instagram's promo for its Edits app right after the clip; its button "Continue" was in `DISMISS`, tapping it opened Google Play in the browser (Vanadium on these GrapheneOS phones), and the job failed three screens later at `caption`. New `BACK_ON` list: screens that only Back closes safely (the Edits promo texts) get Back. Android's "Allow X to send you notifications?" is answered "Don't allow" (curly apostrophe in the dump). (3) **Sent to another app = Back, then a clear failure.** Once Instagram has been on screen, a dump whose top package is another app is never searched for the step's button (the browser's own "Next" must not count); Back is pressed (at most 2 per step) and if Instagram does not come back the run fails `left_app` with the package (`pkg` in the reply). (4) **The sound link is opened only inside Instagram.** The second real post's link fell through to a plain VIEW intent and opened in the browser; now `am start -a VIEW -d <link> -p com.instagram.android`, else Instagram's `UrlHandlerActivity`, else the job fails "Instagram would not open the sound link" - never the browser. (5) **New op `ui_dump`** -> `{ok, elements:[{text, desc, id, cls, clickable, focused?, bounds, cx, cy}], w, h, pkg}`: the screen as elements (deduped, emails/phone numbers masked, at most 400), for the CLI/MCP `read_screen` so an AI agent driving the phone can find buttons by name and learn the composer's real ids. Read-only, like `screenshot`. `npm run test:igpost` (59 checks, including tonight's failure replayed: promo -> Back, browser -> Back, stuck in the browser -> `left_app`). **The Mac's phones (20-40, phone 40 included) need the dmg installed by hand.** |
| **v0.5.13** | **New profiles no longer stop on "Set a PIN" (2026-11-06).** A profile made by `pm create-user` keeps the setup wizard ENABLED for that user; marking `user_setup_complete=1` (done since v0.5.11) is only a hint, and sometimes the wizard's home screen still won the first switch and walked the VA into "Protect your phone / Set a PIN". New `_prepProfile(serial, uid)` runs for every profile EXCEPT the owner (uid 0): (1) `user_setup_complete` / `tv_user_setup_complete` = 1 again; (2) `pm disable-user --user N` for the setup-wizard packages that are enabled in THAT user only (`com.google.android.setupwizard`, `com.android.provision`, Samsung `SecSetupWizard`, Xiaomi `provision`; exact package names, the owner's wizard is never touched); (3) lock screen = None (`locksettings set-disabled --user N true`) so the profile never shows a keyguard. If someone already set a real PIN on a profile, Android refuses step 3 - the PIN stays (it cannot be removed without knowing it) and the log says "a PIN is set on this profile". It runs (a) right after each profile is created in `create_profiles` (the result per profile now carries `wizard_off` and `lock`), (b) after every verified VA switch, and (c) in `_igSwitchTo` (posting / account checks) - so profiles made by older agents are fixed the first time anyone switches to them. If the wizard was disabled during a switch (it may be the screen showing), HOME is pressed once. Done once per phone+profile per agent run, so later switches cost nothing. No root needed (all `adb shell`). `node tools/test_prep_profile.js` (8 checks). |
| **v0.5.12** | **Account numbers in the Analytics visit (2026-11-06), and the first release of v0.5.11.** The backend's new daily Analytics sweep (06:00 New York, backend README "Analytics") calls `ig_whoami` on every profile. With `stats: true` the same visit now also reads, via the new pure module `src/igstats.js`: (1) **posts / followers / following** off the profile header (resource-id, then "N followers" text/content-desc, then a number next to its label - no tap); (2) **professional-dashboard views + accounts reached** for the last N days - from the "Professional dashboard" row when it prints "12.3K views in the last 30 days", else it opens the row, reads the "Views" / "Accounts reached" tiles and presses Back (personal accounts have no dashboard: views null, `account_type: personal`); (3) **reel plays** - taps the PROFILE's Reels tab (never the bottom-bar Reels feed; told apart by position) and sums the play counts on the reels visible on the first screen. Read-only: the only taps are the dashboard row, Back and the profile's Reels tab; a viewer opening the phone (scrcpy running) stops it before the next tap. Whatever is not found comes back null with a reason in `stats.why` and the sanitized screen (texts + ids, username redacted) in `stats.screens` for tuning - **the selectors are PROVISIONAL**, not yet seen on a farm phone. Reply: `stats: {posts, followers, following, account_type, views, reach, days, reels_views, reels_counted, why, screens}`; without the flag `ig_whoami` is unchanged. Adds ~10-15 s per profile. Number parsing handles "1,234", "12.5K", "1.2M", "3 456", "12,5K". `npm run test:igstats` (18 checks). **v0.5.11 was committed but never tagged**, so this release also ships its bulk profile creation + `profile_status` (row below). |
| **v0.5.11** | **Bulk profile creation, rebuilt for many profiles (the owner's goal: 60 across the farm).** `create_profiles` used **blocking** adb on the event loop that relays every phone's video (about five calls per profile); 30 profiles would have frozen every stream on that computer for minutes, the same failure as the reconnect spiral. Now: (1) **async adb only** (`_adbAsync`, which gained a timeout argument: `pm create-user` gets 60 s); (2) **the phone's own limit** - `pm get-max-users` (owner included; set by the OS build: stock Pixel 4, GrapheneOS higher) is read once per phone and cached, and creation stops early with the reason instead of firing calls Android refuses; `pm get-max-running-users` is reported too (the rest of the profiles simply wait stopped); (3) **several apps** - `packages: [...]` cloned into every new profile with `pm install-existing` (`package` still works for an older backend); (4) each new profile is set up headless (`user_setup_complete`) and then **stopped again** (`am stop-user`), so creating 30 never leaves 30 running; (5) **a result**: op `create_profiles_result` `{state, requested, created:[{id,name,apps,setup}], failed, stopped, max_users}` while running and at the end, and the meta beat carries `max_users`, `max_running_users`, `profiles_job`. Names continue the existing numbering; nothing here removes or changes an existing profile. No root. **Also in v0.5.11:** creation now *verifies* each cloned app from `pm list packages -U --user N` (installed, and its uid belongs to that profile, uid / 100000 == user id) instead of trusting `install-existing`'s wording, and records each new profile's Android **serial** (`dumpsys user`), so a profile is identified by id + serial and a recreated one with a recycled id is never mistaken for the old one. New read-only RPC **`profile_status`** (`{packages?}` -> every profile's id, serial, name, type from the UserInfo flags (owner / full / guest / ephemeral / work profile / restricted), running state, created, `user_setup_complete`, the watched apps (Instagram, Play services, Play Store + any asked) with uid ownership, third-party count, and problems in words); it runs only `pm list users`, `dumpsys user`, `am get-current-user`, `settings get`, `pm list packages`. The identity/flags/uid checks follow the same Android rules a KernelSU module the owner looked at (profile-isolation-manager) uses, re-implemented here without root, without its device gate and without any of its integrity/hiding parts. `node tools/test-create-profiles.js` (27 checks). |
| **v0.5.8** | **The congestion valve: video is held still and resumed on a fresh keyframe instead of lagging.** Nothing on the path ever dropped a frame before, so a line that could not carry the phones' output queued it (socket buffer, then the kernel's) and VAs saw freeze / fast-forward / growing delay until they reloaded - the 2026-10-25 shift lagged all day on the bottom rung. Now each tunnel has a `TunnelGovernor` (`src/congestion.js`): it measures the queue (`bufferedAmount` / arrival rate, plus a 1 s ws ping whose pong lag exposes the kernel buffer), stops forwarding video past 600 ms / 96 KB / 800 ms pong lag, lets the queue drain, forces a keyframe by replaying the viewer's settings command with the bitrate nudged by 1 bit/s (ws-scrcpy restarts the encoder on any change), resumes on the SPS/PPS/IDR, and reports `{"op":"congestion"}` to the backend (≤ 1 per 5 s per computer) so the budget is cut and the pages ask for less. Device messages and text are never held. `host.congestion` in the meta beat. `npm run test:congestion` (64 checks). See "The second thing to understand" above. Not yet seen on a real phone at release time. |
| **v0.5.10** | **Phones left in airplane mode after a profile switch: fixed three ways.** Seen 2026-10-30 on the Mac's phones (19-40): a switch ended with airplane mode still ON and no stream. The OFF half of the cycle had a 6 s adb limit, a timeout was swallowed as success (the catch returned a string the error check did not match), nothing retried or re-checked, and two switches on one phone could run at once. Now (1) **every airplane command is verified** - `_setAirplane` reads the setting back and tries up to three times (the modern command twice, 15 s each, then the old settings+broadcast path), and a switch whose network does not come back looks again and turns airplane off once more; (2) **one switch at a time per phone** - a request that arrives mid-switch waits and only the LAST one made while waiting runs, a repeat of a switch that passed under a minute ago is a no-op; (3) **the airplane watchdog** - every 45 s, one phone at a time, any connected phone that is not mid-switch or in a posting job and reads airplane ON on two consecutive looks is turned OFF and data re-enabled (`PD_AIRPLANE_WATCHDOG=0` disables it). Every switch ends with a verdict in the meta beat (`switch_status`: ok / "airplane mode would not turn off" / "mobile data did not come back" / "the profile switch did not complete", seconds taken) that the device page shows to the VA, and `airplane_watchdog` says when the watchdog last acted. `npm run test:airplane` (42 checks). **The Mac cannot update itself**: download the new dmg from the release and drag it over Applications. |
| **v0.5.9** | **Scheduled posting: `ig_post` and `ig_whoami`.** The backend's planner (backend README, "Scheduled posting") sends one post at a time per phone: switch to the profile (airplane cycle unless `fresh_ip:false`), fetch the clip by path with this computer's device token and drop it into THAT profile's gallery, open Instagram (the audio link first when the job carries a sound), tap through the composer by resource-id / text / content-desc from `uiautomator dump` (`src/igpost.js`, pure and data-driven: the FLOW_* step lists are the selectors), type the caption, Share, wait for the confirmation, Home, switch back. `mode:'capture'` stops before Share and returns every screen's texts + ids (sanitized) plus a screenshot - the tuning loop, because the selectors are PROVISIONAL until confirmed on a farm phone. `ig_whoami` opens the profile tab and reads the username for the backend's account scan. A person watching the phone wins (refused / aborted); one job per phone at a time. `npm run test:igpost` (40 checks). |
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

## Warm-up browsing + phone-assisted connect (backend 2026-11-02, no agent change)

Two backend features added 2026-11-02 drive the phones with ops this agent **already** has, so there
is no new agent code and no version bump for them:

- **Warm-up browsing** (`app/posting/activity.py`): after a post, daily, or on demand, the backend
  opens Instagram in a profile and scrolls it like a person using `switch_user`, `launch_app`,
  `input_swipe`, `input_tap` and `input_key` — the same ops the control page uses. It never follows,
  comments or types. The backend stops the moment a viewer opens (it watches `presence`), so the
  agent needs no new safety logic.
- **Phone-assisted API connect** (`/api/igapi/connect/on-phone`): the backend sends `open_url`
  `{uid, url}` with a Meta OAuth authorize link, so the account is authorized in the profile it is
  already logged into. Relies on `open_url` opening in the given Android user's default browser,
  which it already does.

If either misbehaves, it is the backend's step logic or these ops, not a new op — check the backend
logs, not a new agent build.

## Account check op (v0.5.15)

`ig_check` `{uid, shot, others, insights, status_page}` reads ONE profile on the phone itself. The backend's daily
4:00 AM New York run (`app/accountcheck.py`) and the Monitoring page's Check buttons send it ONE at a
time per phone, with a 300 s timeout; the agent ends its visit by ~250 s and puts the phone back
(HOME, then `am switch-user <previous>`) before it replies.

Reply (the backend relies on these keys): `{ok, state, status, uid, seconds, agent_version, username,
accounts:[{username, active, name, posts, followers, following, views_30d, read:'own'|'visit'|'list',
account_type:'professional'|'personal'|'', insights}], notices:[{kind, title, detail, date, until}],
remembered:[usernames a login screen still offers], why, screens:[{at, pkg, texts, ids}],
trace:[{name, ok, matched, ms}], screenshot_b64?, dm_unread, account_status}` (the last two since v0.5.17)

- `state` / `status`: `checked` -> `HEALTHY`, or `RESTRICTED` while a restriction notice's end date has
  not passed (no date printed = still on); `logged_out` -> `LOGIN_REQUIRED` / `NO_ACCOUNT`; `blocked` ->
  `CHECKPOINT` / `CHALLENGE_REQUIRED` / `SUSPENDED` / `DISABLED`; `no_app` -> `APP_ERROR`; `unreadable`
  -> `UNKNOWN` with `why`: `ig_not_in_front` (since v0.5.16 this means ONE thing: Instagram never came
  up after the switch - see the trace's `unlock` / `launch n/3` / `front` entries), `ig_closed_during_read`
  (v0.5.16: it was up, and the phone ended on the home screen more often than a re-launch could mend),
  `left_app` (+ `pkg`), `unrecognised_screen`,
  `empty_dump` (uiautomator gave nothing), `app_not_responding`, `screen_locked`, `notice_loop`,
  `popup_loop`, `promo_loop`, `header_not_found`, `too_many_screens`. A username without counts is
  still `checked`, `why: counts_not_found`. `ok:false` only for `device_busy` (another job, someone
  watching, or `why: viewer_opened` mid-visit), `profile_not_found`, `bad_request`, `failed`.
- `insights` (the active account, only with a "Your dashboard" row): `{range, days, views,
  interactions, viewers, net_followers, new_followers, content_shared, followers_pct_of_views,
  non_followers_pct_of_views, profile_visits, bio_link_taps, views_by_type:{reels, stories, posts,
  live}, interactions_by_type:{...}, followers, growth_pct, under_100, gender:{women, men},
  age:{'13-17'..'65+'}, countries:[{name, pct}], cities:[...], us_pct, active_times:{tz,
  days:{Su:[8 shares of the tallest bar, 12a..9p], ...}, top:[{day:'Fri', from:'3 PM', to:'6 PM'}]},
  why:[...]}` - Instagram's own "last 30 days" figures. Anything not found is null and named in `why`;
  under 100 followers Instagram shows no audience (`under_100: true`, not an error). Personal accounts:
  `account_type: 'personal'`, `insights: null`.
- `dm_unread` (v0.5.17): the unread-messages count on the Messages icon's badge (the bottom bar's
  Message tab, or an older build's top-bar Messenger icon), read off the feed / own profile the visit
  passes - no tap, the inbox never opened. Highest reading of the visit; "9+" = 9 (lower bound); no
  badge = 0; null when no icon was in sight, the badge was a dot without a number, or the profile was
  not `checked`. The trace's `dms` line says which.
- `account_status` (v0.5.17, only with `status_page: true`; else null): Instagram's own Account status
  page. `{state: 'no_issues' | 'issues' | 'unknown', items:[{kind, title, detail}], seen:[kinds],
  page_ok?, why}`; kinds `removed_content`, `not_recommended`, `features_limited`, `at_risk`,
  `monetization`. `unknown` + `why` when the menu / Settings / the row / the page was not reached or
  its wording not recognised (`"Account status" not found in Settings`, `Settings did not open`, ...) -
  never a guess, and never a failed check. Null for a profile that was not `checked`.
- `read`: `own` = the account logged in (its profile tab); `visit` = another account of this app read
  off its public profile; `list` = only seen on the accounts sheet (numbers null).
- `screenshot_b64` only with `shot: true` and a result that is not `checked`.
- `trace` (v0.5.16) always BEGINS with how the start went, before the visit's own steps:
  `settle` (what was in front after the switch: `u12 com.android.launcher3`, or `u12
  com.android.settings` = Android's placeholder home while the profile is still locked), `unlock`
  (`RUNNING_UNLOCKED after 4 s`; not ok when it was still `RUNNING_LOCKED` / `BOOTING` after 30 s),
  `launch n/3` (`component: Status: ok, LaunchState: COLD, TotalTime: 1180`, or `MAIN/LAUNCHER intent:
  Error: Activity not started, unable to resolve Intent ...`, or `icon at 151,1150`; ok on the try
  that brought Instagram up) and, after a try that failed, `front` (`resumed u10
  com.android.launcher3, screen com.android.launcher3` - note the user: `u10` when profile 12 was asked
  for means the switch never reached the screen). The backend keeps 80 entries, 120 characters each;
  of a longer visit the last steps are kept. Package names, profile numbers and Android's words only.

**How it moves the phone** (`src/core.js` `igCheck`): guards (one job per phone via `_posting`,
nobody watching, the user exists, Instagram installed) -> `_igSwitchTo` (no airplane cycle; a phone
that cannot say which profile it is on is not moved) ->
`_checkSettle` (up to 15 s: that user's screen resumed, no lock screen - `dumpsys activity
activities`, then `dumpsys window`) -> `_checkLaunch` (v0.5.16: `_waitUnlocked` first - up to 30 s
until the profile is `RUNNING_UNLOCKED`; then `am start -W` with the launcher looked up fresh on each
of three tries, the third by the home-screen icon when the target profile's own home is in front;
"in front" = Android names THIS user's Instagram, or the screen is Instagram's and Android does not
name another user) ->
`igcheck.check(driver)` (profile -> Insights -> v0.5.17 Account status when asked -> accounts sheet ->
other accounts) -> HOME + switch back -> reply. Every step is logged as `[check <serial> u<uid>]`.

**Who is watching** (v0.5.16). Every "someone opened the phone" test (`guard()` here, `viewerOpened`
in `ig_post`, `abort` in the stats visit) is `_scrcpyRunning(serial)`. It answers from the agent's own
record of people's live video streams on that phone (`_trackPerson`, filled by `openTunnel` when the
backend's `open_stream` says `watch: false`), not from the phone. It is asked before every tap, after
every wait and at every look of the unlock wait; a `true` ends the visit as `device_busy` /
`viewer_opened` and the phone is put back first. Needs the backend of 2026-11-10 or later: an older
backend sends no `watch`, nothing is counted, and the test says "nobody" as it did before 0.5.16
(when it looked for "scrcpy" in `ps -A` and could never find it). Claude / CLI control is not a
stream and is not counted.
**Everything that decides what a screen is lives in `src/igcheck.js`** (pure): `classifyScreen`,
`parseNotice` / `noticeCloseTarget`, `parseProfileHeader`, `parseSwitcher`, `parseLoginRemembered`,
`parseDashboard`, `parseOverview` / `parseAudience` (merged over the scrolled screens, section by
section - "Reels 43.3K" under "Views by content type" and "Reels 952" under "Interactions by content
type" can share one screen), the tap-target finders, `SAFE_DISMISS`, `FORBIDDEN` and `tapRefused`
(the last word before any tap).

**Tuning from a real run.** The Monitoring page's Details show each profile's `screens` (texts + ids,
username masked) and `trace`. An `unrecognised_screen`, or an Insights `why` such as "Viewers not
found", names the screen: add its real text to the matcher in `src/igcheck.js`, model that screen in
`tools/test_igcheck.js` (texts and bounds off a screenshot), `npm run test:igcheck`, release. The
active-time bars are read from the bars' own boxes in the dump; if a build draws the chart as one
picture (no nodes), `why` says "active-time bars not read" and everything else still comes back.

**What it never does.** Tap anything but: the profile tab, "Your dashboard", the dashboard's
"Views", the Overview / Audience tabs, the Countries / Cities chips, the day chips, the title (opens
the accounts sheet), a notice's X, and Not now / Skip / Later / Maybe later / No thanks / Dismiss /
Close / Don't allow / Cancel on a prompt. One tap happens outside Instagram, before the visit (v0.5.16):
the icon labelled exactly "Instagram" on the TARGET profile's own home screen, as the third launch
try. A login screen is never touched: not "Log in", not "Continue", not a saved profile's row. Tap a row of the accounts sheet. Follow, like, message, edit or post.
Keep going once someone opens the phone.

**The Account status step (v0.5.17, only with `status_page: true`) adds exactly three taps**, each
through `tapRefused` with the step's own allow-list (`STATUS_TAPS` in `src/igcheck.js`; an allow-list
never opens a label outside it): the own profile's menu icon ("Options" / "Menu", top right - "Options"
stays FORBIDDEN for everything else), "Settings and activity" / "Settings and privacy" on an older
build's menu sheet, and the "Account status" row on Settings. On Settings no other row is ever tapped
(every word under the point and in its row must be on the allow-list: "Log out", "Add account",
"Accounts Center" never are) - only swipes to scroll down to the row. On the Account status page
nothing is tapped at all, whatever any caller allows (`tapRefused` refuses every point there): it is
scrolled at most twice and left with Back. The unread-DM count needs no tap.

**Words people wrote are never Instagram talking** (review of 2026-11-08, before the first real run).
Instagram resumes where the app was left - for a chatter's profile, a DM thread or the inbox - so a
fan's "Please verify your account", "your account has been disabled lol", "What happened?" or "Later"
can be on the first screen. The rules that keep those from becoming a false block, a false RESTRICTED
or a tap that opens a chat (and marks it Seen):
- A screen with a message box (DM thread, story reply, comments) or a DM thread's call buttons is a
  *conversation*: nothing on it is read as a block, notice, login or pop-up, nothing on it is tapped
  (`tapRefused`), and the visit presses Back at once.
- A block (`disabled`, `suspended`, then `challenge`, `checkpoint`) or a notice is only read on an
  Instagram page of its own (no bottom bar, no conversation, no post with Like / Comment / Save
  buttons), and only from the page's *headline*: a line of at most 100 characters that STARTS with
  the wording, in the upper 60 % of the window. "What happened" counts only in the title bar, with its
  X or "See why". A challenge / checkpoint page that offers "Not now" / "Skip" is a nag (the two-factor
  reminder) and is dismissed. "We restricted your account" is a restriction notice (RESTRICTED), not a
  checkpoint. A notice's kind comes from its title first, and only its own lines are read.
- With the bottom bar in view only Not now / Maybe later / No thanks / Don't allow count as a dismiss
  ("Cancel" there can be an upload still running). Anywhere: never a lower-case word (a username),
  never a word inside a list row (a clickable row-sized box that also holds other words).
- "Isn't responding" is only Android's own dialog (package `android`, with Close app / Wait); the Edits
  / Muse promos are only promos on a page of their own (a post's "Made with Edits" chip in the feed is
  not one).
- An adb call that fails or times out after the account was read (Insights, the sheet, a visit) ends
  only that step - `insights.why` / the trace says `error: ...` - and the reply stays `checked`.

## Scheduled posting ops (v0.5.9)

Both are request/response over the phone-home socket (`request_id` -> `rpc_result`), like the
account-monitoring ops, and both target an explicit Android user.

`ig_post` `{uid, file_path, file_name, caption, audio_url, mode:'post'|'capture', fresh_ip, evidence,
restore_user, username, text?, text_x?, text_y?}` -> `{ok, state, step, why, trace:[{name, ok, matched,
ms}], screen:{texts, ids}, screens?, screenshot_b64?, flow:'audio'|'gallery' (+'+text'), gallery, pkg?,
seconds}`. `state` is what was OBSERVED: `shared` only when the confirm step saw the "sharing" screen;
`failed` with `why` (`element_not_found` at `step`, `login_required`, `account_blocked`, `challenge`,
`app_crash`, `share_failed`, `left_app` + `pkg` (v0.5.14: Instagram sent the phone to another app
and Back did not bring it home), `exception`); `captured` in capture mode; `device_busy` when someone
is watching (before) or opened the phone (during -> `aborted`); `profile_not_found`,
`app_not_installed`. With `text` (v0.5.14) the flow writes it with Instagram's own text tool and drags
it so its centre lands at `text_x`/`text_y` (shares of the reel) - see the v0.5.14 row above.

`ui_dump` `{}` (v0.5.14) -> `{ok, elements:[{text, desc, id, cls, clickable, bounds:{l,t,r,b}, cx, cy}],
w, h, pkg}` in device pixels; what the backend's control op `ui` and the CLI/MCP `read_screen` return.
`file_path` is a backend path - this computer appends `?token=<its device token>`, so the token
never rides in a job. The clip lands via `_pushToGallery` (MediaStore for secondary profiles), so
the "newest gallery item" the flow taps is the one just pushed.

`ig_whoami` `{uid}` -> `{ok, state:'found'|'not_found'|'app_not_installed', username, status, step,
screen}`. Opens Instagram in that profile, taps the profile tab, reads the action-bar title (or the
first handle-like text in the header); never guesses.

**Where the selectors live and how to tune them.** `src/igpost.js`: `FLOW_REEL` (create -> Reel ->
gallery -> Next -> Next -> caption -> Share -> confirm), `FLOW_REEL_WITH_AUDIO` (Use audio ->
gallery -> ...), `FLOW_WHOAMI`, `TEXT_STEPS` (v0.5.14: Aa -> type -> Done -> drag, inserted by
`withText`), `DISMISS` (pop-ups tapped away when a step's target is missing - never a "Continue":
that ACCEPTS what a promo offers, see v0.5.14), `BACK_ON` (promos only Back closes safely), `FATAL`
(texts that end the job with a reason). A step lists its candidates in priority order
(resource-id tail, exact text, content-desc); `optional` steps are skipped after a short wait (a
build that goes straight to the gallery has no "Reel" chooser). Run a Test run from the Posting
page, open the job's details, read the `[step] texts | ids` lines of the screen where it stopped,
add the real id/text to that step's `find`, release. The runner is pure: `tools/test_igpost.js`
drives it with scripted screens, so a selector change is tested without a phone.

**What it never does.** Posts while a stream is open on the phone; two jobs on one phone; retries
a Share by itself; types non-ASCII (`adb input text` cannot - the caption is filtered); leaves the
phone on the posting profile (`restore_user` switches back, without an airplane cycle).

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

**Never launch an app in a profile you just switched to without waiting for it to unlock (v0.5.16).**
`am switch-user N` returns, and `am get-current-user` says N, while the profile is still
`RUNNING_LOCKED`. Until it reaches `RUNNING_UNLOCKED`, Android resolves only Direct-Boot-aware apps:
`cmd package resolve-activity --user N com.instagram.android` prints "No activity found" and an
implicit `am start` cannot be resolved. Use `_waitUnlocked` then `_startApp` (resolves fresh every
time). And `monkey` cannot target a profile: it has no `--user` option and fails. Do not bring it
back as a fallback. This cost the first two 4:00 AM account checks ~80 % of their profiles.

**"Is someone on the phone?" is not something the phone can tell you (v0.5.16).** ws-scrcpy starts its
server on every connected phone and keeps it running, viewer or no viewer, and `ps -A` lists it as
`app_process`. For two months `_scrcpyRunning` looked for "scrcpy" in that list and answered "nobody"
every time, so no check, post or stats visit ever stopped for a person. The only place that knows is
the relay itself: a person's stream comes through `openTunnel` (see "Who is watching"). If you add an
op that touches the screen, guard it with `_scrcpyRunning`, and never go back to asking the phone.

**Anything from the server that goes into an `adb shell` line is shell text (v0.5.16).** `execFile`
protects the PC; it does not protect the phone: adb joins its arguments with spaces and the phone's
own shell parses the line again. A value with `;`, `&`, `|`, backquotes or `$( )` in it starts a
second command there with adb's rights. So: a package name is checked with `AgentCore._validPkg`
before it is used (`launch_app`, `check_apps_installed`, the fleet ops), a number is `parseInt`'d,
and anything free-form (a link, a file name, a profile name) goes inside `this._shq(...)`. Until
0.5.16 `open_url` and the sound link of `ig_post` were passed bare: every link was cut at its first
`&`, and what followed was run. `tools/test_igcheck.js` hands a link with `&`, `;`, `$( )` and a quote
to a real `sh` and expects it back as one word.

**A phone that stays in airplane mode after a profile switch (v0.5.10).** The profile switch cycles
airplane mode for a fresh mobile IP (`switchUser` -> `_setAirplane` in `src/core.js`). Until v0.5.10
the OFF command had a 6 s limit, a timeout was swallowed (`.catch(() => 'err')`, and `'err'` does not
match the `/unknown|error|.../` check that chooses the fallback), nothing retried, nothing looked
again later, and two switches on one phone ran at the same time. On a Mac driving 22 phones through
hubs, adb answers slower than 6 s at busy moments, so phones 19-40 were the ones left ON. Now the
command is verified and retried, switches are one at a time per phone, and a watchdog turns airplane
off on any idle phone found ON twice in a row. The log tells the story per phone: `Airplane OFF:
PASS/FAIL`, `airplane OFF attempt N/3 did not take`, `Airplane still ON after the cycle - turning it
off again`, `Switch done in N s` / `Switch FAILED after N s: <why>`, and `airplane watchdog - ...`.
A phone the watchdog cannot fix (`could NOT turn airplane off (three attempts)`) needs a look at the
cable or a Refresh. By hand on the Mac, for every phone at once:
`A=/Applications/PhoneDesk.app/Contents/Resources/adb/mac/adb; for s in $($A devices | awk 'NR>1 && $2=="device"{print $1}'); do $A -s $s shell cmd connectivity airplane-mode disable; done`.

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
No change in this repo can make the video sharper or smoother by itself. (The ladder's shape is the
backend README's business. For orientation: since 2026-10-27 every rung from 1.5 Mbit/s upward is
720 wide, sized so that with all 38 phones watched at once - 18 on the 40 Mbit/s computer, 20 on the
100 Mbit/s one - every stream is still 720p; the only thing that pulls a computer below that is a
real congestion cut, i.e. this repo's valve reporting that the line itself stopped draining.)

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
npm test                   # EVERY suite below, one line each; exit code 1 if any fails (v0.5.16, tools/run-all-tests.js)
```

No phone is needed for any of them; about half a minute. Run it before every tag: the release workflow
builds whatever commit a tag points at and runs no test itself.

```bash
node tools/test-create-profiles.js   # v0.5.11 bulk profiles: async, limit-aware, several apps, result op
node tools/test_recovery.js          # v0.5.19 self-recovery: the ladder, the cap, kill-server rules, USB reset, reports (fake adb)
```

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

```bash
npm run test:airplane      # = node tools/test_airplane.js
```

`test_airplane.js` runs the REAL `switchUser` against a scripted adb: the verified ON/OFF/network
steps (v0.5.2), and since v0.5.10 an OFF that times out once and is retried, the settings fallback
when the modern command is unknown, an OFF that never lands (three attempts, a verdict in words),
three quick switches running as first + last, the no-op repeat, the airplane watchdog (two looks,
mid-switch and disconnected phones skipped, the settle window) and the verdict in the meta beat.
42 checks; the failing-network cases wait out real timeouts, so about a minute.

### Instagram on the phone (no phone needed)

```bash
npm run test:igpost        # posting + whoami flows on scripted screens
npm run test:igstats       # the whoami numbers (v0.5.12)
npm run test:igcheck       # the daily account check (v0.5.15); 269 checks since v0.5.17 (10c = DMs + Account status, modelled screens)
```

`test_igcheck.js` models every screen photographed on the farm on 2026-11-08 (launcher after a switch,
"Join Instagram", both "What happened" notices, the feed with the Muse card, both profile layouts, the
accounts sheet, both dashboards, the Overview and Audience screens, the under-100 Audience, Android's
notification prompt) plus login / saved login / "Confirm it's you" / Action Blocked / suspended /
disabled / lock screen / another app / promos, and the review's corners (a DM thread and the inbox
full of button-like and block-like fan messages, the two-factor nag, "We restricted your account",
a bio / caption with "not responding" / "has stopped", a "Made with Edits" chip, an upload's Cancel,
adb errors mid-Insights, bars that read out "12a, 9%"). It then runs whole visits on a scripted phone - every
tap checked against a never-tap list written separately from the module's own - and finally the real
`AgentCore.igCheck` against a scripted adb (guards, switch, settle, verified launch, phone put back
before the reply, the reply's keys). `IGCHECK_TRACE=1` prints each visit's trace.

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
