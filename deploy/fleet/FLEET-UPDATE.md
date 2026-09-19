# Fleet agent update — all 18 phones to 0.5.0-canary.1 (with immediate rollback)

Run this **on the shared agent host** (the PC/Mac the 18 phones are plugged into). It updates the
shared agent in place, keeping the existing `.agent.json` so all 18 phones re-attach with their
current pairings (no re-pairing, no new device records). Rollback restores v0.4.5 in minutes.

> The person driving the backend (me) verifies the fleet from the backend side (reconnects, streams,
> RPC ops) as soon as you run the DEPLOY step — keep the PhoneDesk backend reachable.

## Guardrails
- No stream-quality change (bitrate/FPS/resolution/max-size/codec/encoder/H.264/WebRTC/compression/
  bandwidth). The new build is +127/−0 in core.js and touches no stream code — verified.
- Automatic monitoring stays OFF; `AGENT_DETECTOR_DEVICES` stays unset; `check_account_status` is
  NOT fleet-run. Cloud Android stays paused; its branch is NOT part of this build.

---

## BEFORE (do all of these first)

**1. Confirm the current agent is v0.4.5.**
Check the running/installed agent version on the host (installed app "About", or the `version` in the
agent's `package.json` / build). Expected: `0.4.5`.

**2. Preserve the exact v0.4.5 build for rollback.**
Do NOT overwrite the current build in place. Keep the current installed app / build directory exactly
as-is (e.g. copy it to `phonedesk-agent-v0.4.5-rollback/`), or note the installer you can re-run. This
is your instant rollback artifact.

**3. Back up agent config/state — CRITICAL.**
The token file **`.agent.json`** (in the agent's working dir, next to `agent.js`) holds **all 18
device pairings/tokens**. Losing it means re-pairing every phone. Copy it somewhere safe:
```
cp .agent.json  .agent.json.backup-v0.4.5
```
Also note anything you pass via env (BACKEND, ADB_PATH, WS_SCRCPY_DIST, WS_SCRCPY_PORT) so the new
build launches identically.

**4. Confirm the new build is v0.5.0-canary.1.**
The new code is branch `feat/agent-rpc-instagram-detector` (commit `b20571f`, `package.json` version
`0.5.0-canary.1`). Do NOT include the cloud-android branch.

**5. Tests — already run and green** (Instagram classifier + backend RPC/monitoring/e2e).

**6. Stream config frozen — already verified** (no stream lines added/removed).

---

## DEPLOY (in-place update, keeps all pairings)

Map these to however you currently launch the shared agent (installed Electron app vs `node agent.js`
/ `npm start` / a service). The principle is identical: **stop old → swap code → start new, SAME
`.agent.json`.**

1. **Stop** the current v0.4.5 agent (quit the app / stop the service / Ctrl-C the process). Streams
   drop here — expected and brief.
2. **Put the new code in place** without touching `.agent.json`:
   - Source/dev run: in the agent checkout, `git fetch && git checkout feat/agent-rpc-instagram-detector`
     (or copy that build over), keeping the same working dir so `.agent.json` is reused.
   - Installed build: install the 0.5.0-canary.1 build; ensure it uses the **same** working dir /
     `.agent.json` (copy your backup into place if the installer uses a fresh dir).
3. **Start** the new agent with the **same** env/launch command as before. Do NOT re-pair.
4. Tell me it's up — I begin backend verification immediately.

**Do not leave the fleet partially updated.** It's one shared agent; it's either all-old or all-new.

---

## VERIFY (I run these from the backend the moment you start the new agent)
- 18/18 `/ws/agent` reconnects, 0 unexpected closes.
- Each device **Online**; existing **profiles** still listed.
- **Stream** starts + **touch/control** healthy on a sample.
- New ops on a few devices: `check_apps_installed`, correct **selected profile/UID**, **Instagram
  installed** detection, **Edits installed** detection, `launch_app`, `open_url`.
- No unexpected agent errors in the backend logs.
- Explicitly NOT run fleet-wide: `check_account_status`.

---

## ROLLBACK to v0.4.5 — do this immediately if ANY of:
devices fail to reconnect · broken streams · broken touch/control · profile problems · repeated
crashes · major RPC errors · instability affecting VA work.

**Stop troubleshooting on the live fleet and roll back:**
1. **Stop** the new (0.5.0-canary.1) agent.
2. **Restore** the v0.4.5 build you preserved in BEFORE-2.
3. **Restore** the token file: `cp .agent.json.backup-v0.4.5 .agent.json` (only if it changed; the
   update shouldn't have altered it, but restore to be safe).
4. **Start** the v0.4.5 agent with the original env/launch command.
5. Tell me — I confirm from the backend: **18/18 reconnect**, streams + control return.
6. We report the failure with the relevant agent + backend logs. No fleet is left partially updated.

Rollback needs **no** backend change: we never set `AGENT_DETECTOR_DEVICES`, never enabled
monitoring, never changed stream settings. The production backend/DB and pre-deploy backups are
untouched throughout.
