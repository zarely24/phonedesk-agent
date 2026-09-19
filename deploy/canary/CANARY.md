# Single-phone canary — updating ONE Android phone to the new agent (0.5.0-canary.1)

**Status: PREPARED, NOT EXECUTED.** Do not start until a specific idle phone is chosen and the
host-topology question in §0 is answered. This updates exactly **one** phone to the new agent
(`feat/agent-rpc-instagram-detector`, version `0.5.0-canary.1`) and leaves the other **17 on
v0.4.5**.

Goal, in order: first prove the new agent has **not broken normal phone operation** (online, stream,
touch, keyboard) and that the new **Shortcuts** ops work; **only then**, as a *separate* later step,
test the Instagram account-status detector. This procedure deliberately **stops before**
`check_account_status`.

## Hard guardrails (must all stay true the whole time)
- **Do NOT** publish a release tag or GitHub release for the agent. (The fleet auto-updates from
  published releases via `electron-updater`; a tag/release would push new code to all 18.)
- **Do NOT** update, restart, or reconfigure the other 17 phones or the shared production host agent.
- **Do NOT** enable automatic monitoring. Leave `MonitoringSettings.enabled = false`.
- **Do NOT** set `AGENT_DETECTOR_DEVICES` on the backend. (It is only needed for
  `check_account_status`, which we are NOT testing yet. Shortcuts — apps/launch/URL — do **not**
  need it.)
- **Do NOT** run `check_account_status` (see §10).
- **Do NOT** change any stream/bitrate/FPS/resolution/codec/ws-scrcpy quality setting.
- Cloud Android stays paused (branch `feat/cloud-android-staging`, not executed).

---

## §0 — Confirm topology FIRST (this decides the whole method)

The agent code indicates **all 18 phones are driven by one agent process on one host** (one
ws-scrcpy relaying all phones on a single Node thread). If that is true, **you cannot update just
one phone by restarting the shared host agent** — that restarts all 18 and interrupts every active
VA. So the canary phone must be isolated onto its **own agent instance**. Pick one:

- **Method A — separate canary host (recommended, zero risk to the 17).** Move the chosen **idle**
  phone to a *different* computer that runs the new agent and has **only that phone** attached. The
  production host keeps serving the other 17 untouched.
- **Method B — second agent instance on the same host.** Only if a separate computer isn't
  available. Run a *second* agent process bound to **only** the canary phone's serial, on its own
  ws-scrcpy port, without restarting the main agent. This is fiddly (two processes sharing one
  machine's adb) and needs care; prefer Method A. If you must use B, we finalize the exact isolation
  together before running.

> When you tell me which phone, also tell me: (1) is it really the all-on-one-host setup above, and
> (2) can we use Method A (a spare computer)? Then I'll fill in the exact build/run commands for your
> environment.

**Agent version is not reported to PhoneDesk.** The dashboard will *not* show "0.4.5 → 0.5.0". Verify
the version **on the host** (installed app / `package.json`) and, more importantly, **by behavior**
(the new Shortcuts ops respond for this phone; the old agent times out to "agent required").

---

## §1 — Select the phone and confirm it is idle
1. In PhoneDesk, identify the candidate phone. Confirm **no VA is currently using it**:
   - It is **not** the phone anyone is actively streaming (check with the team / assignments).
   - Prefer one that is unassigned or off-shift right now.
2. Watch it for a couple of minutes to be sure a stream isn't about to start.

## §2 — Record current state (for verification + rollback)
Record, and keep this note until the canary is fully done:
- **Device ID** (PhoneDesk device page → the id in the URL / device record).
- **Serial** (`adb -s <serial> get-serialno`, or from `adb devices`).
- **Model / label** as shown in PhoneDesk.
- **Current agent version = v0.4.5** (the fleet baseline; confirm on the current host if in doubt).
- **Which host it is currently on**, and how that host's agent is launched (so rollback restores it).
- The phone's **Android profiles/UIDs** (PhoneDesk device page lists them; or
  `adb -s <serial> shell pm list users`). Note which UID has Instagram / Edits / a browser, for §6–§9.

## §3 — Update ONLY this phone to the new agent
Using **Method A** (recommended):
1. On the canary host, install prerequisites the same way the fleet host has them (Node 18+, adb;
   ws-scrcpy available exactly as your normal agent build bundles it).
2. Get the new agent code: check out **`feat/agent-rpc-instagram-detector`** (version
   `0.5.0-canary.1`) — do **not** use `main`/0.4.5.
3. Attach **only the canary phone** by USB; confirm `adb devices` lists exactly one device in
   `device` state.
4. In PhoneDesk → **+ Add device** → copy the pairing code. (This registers the canary run; it may
   rebind to the same device record or create a new one labelled for the canary — either is fine and
   is undone in Rollback.)
5. Launch the new agent against **production PhoneDesk** with that pairing code, using your standard
   run/build command **from the canary branch** (installed Electron build from the branch, or dev
   mode `node agent.js <CODE>` / `npm start`). Exact command depends on how you package the fleet
   agent — we lock this in once you confirm the host in §0.

> The other 17 phones and their host agent are not touched by any step here.

## §4 — Verify it reconnects to PhoneDesk
- The phone shows **online** in PhoneDesk within ~15–30 s of the agent starting.
- Host verification of the build: the running agent reports **0.5.0-canary.1** (app/`package.json`).
- Behavioral confirmation of new code (do this in §5–§9).

## §5 — Verify existing stream / touch / keyboard still work (REGRESSION GATE)
This is the most important gate — the new agent must not have broken normal operation.
1. **Connect** to the canary phone in PhoneDesk → live screen appears (same as before).
2. **Touch**: tap/swipe on the stream → the phone responds normally.
3. **Keyboard**: focus a text field on the phone and type → characters arrive.
4. Confirm the video looks the same as other phones (no quality change — none was made).
- **If any of stream/touch/keyboard is broken → STOP and roll back (§Rollback).** Do not proceed.

## §6 — Test `check_apps_installed`
- In the phone's **Shortcuts** UI (device control center), the app tiles resolve their
  installed/not-installed state for the **current profile** (this round-trips `check_apps_installed`
  to the agent).
- Expected: with the **new** agent, tiles show real Available / Not-installed per app. With the old
  agent they showed "agent required"/timed out. Seeing real per-app states = the new op works.

## §7 — Test profile / UID isolation
- Switch the device's **profile/UID** in PhoneDesk (the profile selector) and re-check app states.
- Expected: results are **per-profile** — an app installed under UID X but not UID Y shows Available
  on X and Not-installed on Y. This proves the agent's `--user <uid>` targeting is isolating
  correctly (no cross-profile bleed).

## §8 — Test Instagram **launch**
- Select the profile where Instagram is installed → use the **Instagram** shortcut (Launch).
- Expected: Instagram opens **on the phone**, under the **selected profile** (verify on the live
  stream). This exercises `launch_app` with UID targeting.
- (This is *launching* the app only — **not** reading account status. See §10.)

## §9 — Test **Edits** installed / not-installed detection, and **Telegram Web** opening
- **Edits detection**: on a profile where Edits (`com.instagram.edits` / the Edits app) is present,
  the Edits shortcut shows **Available**; on a profile without it, **Not-installed**. Flip between a
  has-Edits and a no-Edits profile and confirm the two differ (this is `check_apps_installed`
  discriminating correctly).
- **Telegram Web**: use the **Telegram Web** shortcut → the phone's browser opens web.telegram.org
  **in the selected profile** (this exercises `open_url`). Confirm it opens on the stream.

## §10 — DO NOT run `check_account_status` yet
Stop here. Do **not** trigger Monitoring "Check Now" for the canary and do **not** set
`AGENT_DETECTOR_DEVICES`. The Instagram **account-status** navigation/selectors are unverified
against the live app and must be validated as a **separate** exercise, only after §1–§9 pass. Testing
it now would conflate "did the new agent break the phone?" with "is the Instagram detector correct?"
— we keep those apart on purpose.

---

## Rollback to v0.4.5 (if anything in §4–§9 fails, or when the canary is done)
1. **Stop the new (0.5.0-canary.1) agent** on the canary host.
2. **Method A:** move the phone back to its original production host and let the existing v0.4.5
   agent there pick it up again (it re-attaches on the shared host as before). **Method B:** stop the
   second instance; the main v0.4.5 agent continues.
3. In PhoneDesk, if a separate **canary device record** was created in §3.4, remove that extra record
   (the original device record for this phone is unchanged). If it rebound to the same record, no
   cleanup is needed.
4. Confirm in PhoneDesk: the phone is **online** again on its original host, and Connect/stream/touch
   work. The fleet is back to **18 × v0.4.5**.
5. No backend change is needed to roll back (we never set `AGENT_DETECTOR_DEVICES`, never enabled
   monitoring, never changed stream settings). The production backend/DB and the pre-deploy backups
   are untouched by the canary.

## Acceptance (all must pass before considering any wider rollout)
- [ ] §5 stream + touch + keyboard work on the new agent (no regression).
- [ ] §6 `check_apps_installed` returns real per-app state.
- [ ] §7 results are correctly isolated per profile/UID.
- [ ] §8 Instagram launches under the selected profile.
- [ ] §9 Edits installed/not-installed detection is correct; Telegram Web opens via `open_url`.
- [ ] The other 17 phones stayed on v0.4.5 and were never interrupted.
- [ ] `check_account_status` was **not** run (deferred to a separate, later validation).
