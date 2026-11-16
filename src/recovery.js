'use strict';
/*
 * Self-recovery of phones that fall off adb (v0.5.19).
 *
 * WHY. On 2026-11-12 only 18 of 41 phones were online, so the 4:00 AM account check read 354 of 884
 * profiles. Most of the missing phones were still plugged in: adb had lost them ("offline"), or they
 * had dropped off the USB bus for a moment and come back in a state adb would not talk to. Until
 * now the agent only noticed (reconcile() drops a phone after two missed scans) and waited for a
 * person to replug the cable.
 *
 * WHAT IT DOES. A phone this computer knows (paired, and seen on adb since the app started) that
 * shows as "offline" / "unauthorized" or vanishes from `adb devices` is tried again by itself, in
 * escalating steps, each one time-limited, with a growing wait between tries:
 *
 *   reconnect_offline  `adb reconnect offline`   - asks adb to reconnect every device it lost
 *                                                    (harmless for the phones that are fine)
 *   reconnect_device   `adb -s SERIAL reconnect`  - kicks this one phone's connection
 *   kill_server        `adb kill-server` + `adb start-server`, then ws-scrcpy is restarted.
 *                      ONLY when several phones are stuck (KILL_MIN_STUCK), NO stream is open on
 *                      this computer and no job (post / account check / profile switch) runs, at
 *                      most once per KILL_EVERY_MS. Restarting adb's server cuts every phone of the
 *                      computer for a few seconds, so it is never done under a VA's live screen.
 *   usb_reset          OFF unless the owner ticks "USB reset" (agent setting).
 *                      Windows: pnputil /restart-device on the phone's USB device (Windows 10 2004+).
 *                      pnputil needs the app to run as administrator; when Windows refuses, the step
 *                      is switched off until the app restarts and the report says so.
 *                      Mac / Linux (v0.5.21): `uhubctl -a cycle` cuts the POWER of the hub port the
 *                      phone hangs off and turns it back on - the software version of pulling the
 *                      cable out. Needs uhubctl installed (brew install uhubctl) AND a hub that can
 *                      switch each port's power ("ppps" in uhubctl's list; most cheap hubs cannot).
 *                      The phone's hub + port is found by its serial in uhubctl's list and remembered,
 *                      so a phone that dropped off USB completely can still be cycled.
 *
 *   offline       reconnect_offline, reconnect_device, kill_server, usb_reset, then again from
 *                 reconnect_device (a step that is not allowed right now is skipped)
 *   unauthorized  reconnect_device twice (it brings back the "Allow USB debugging?" prompt). After
 *                 that it needs a person to tap Allow on the phone; nothing more is tried.
 *   absent        (gone from `adb devices`) kill_server, usb_reset. When neither is allowed there is
 *                 nothing a computer can do: one "none" report says why, and it waits for a person.
 *   unresponsive  (v0.5.21) adb lists the phone as "device" but every command on it fails or hangs
 *                 (core.js sees it in the heartbeat: 2 failed beats in a row). The 2026-11-16 phone 32
 *                 case: "Online" on the website, black screen, replugging did not help.
 *                 reconnect_device, usb_reset, then again. A try counts as a success only when a real
 *                 command (`shell echo`) answers afterwards, not when `adb devices` lists it.
 *
 * STATE REPORTS (v0.5.21). The moment a phone becomes stuck (and whenever its state changes while
 * stuck) one {step: 'stuck'} report goes out EVEN WITH SELF-RECOVERY OFF, so the server always knows
 * WHY a phone is down ("waiting for Allow USB debugging" vs "not on USB" vs "not answering") instead
 * of guessing. "back" was already reported either way.
 *
 * BY HAND (v0.5.21). manualUsbReset(serial) is the website's "Power-cycle USB" button: the same
 * usb_reset, without the setting or the 30-minute spacing (a person asked), but never two at once.
 *
 * LIMITS. One attempt at a time for the whole computer (never a burst of adb processes on the USB
 * tree), every command async with a timeout (THIS PROCESS IS THE VIDEO RELAY: see core.js _adbAsync),
 * at most MAX_PER_HOUR attempts per phone in any hour, the first one only after FIRST_DELAY_MS (a
 * USB hiccup heals itself in a scan or two). When the hourly cap is reached one "capped" report is
 * sent and it waits for the hour to free up. Nothing loops forever.
 *
 * REPORTS. Every attempt and its result, the cap, "nothing to try" and the phone coming back are
 * reported to the server (`report(evt)`; core.js sends them as {op: 'recovery'} over any open
 * phone-home socket of this computer - the stuck phone's own socket is gone by then).
 *
 * The whole manager is driven by core.js through a small `host` object, so the tests run it with a
 * fake adb (tools/test_recovery.js).
 */
const fs = require('fs');

const DEFAULTS = {
  firstDelayMs: 20000,                                        // stuck this long before the first try
  backoffMs: [60000, 120000, 300000, 600000, 1200000],        // wait after attempt n (the last repeats)
  maxPerHour: 6,                                              // attempts per phone in any 60 minutes
  settleMs: 6000,                                             // after a step, before looking again
  cmdTimeoutMs: 10000,                                        // one adb command
  startServerTimeoutMs: 20000,
  pnputilTimeoutMs: 20000,
  uhubctlTimeoutMs: 30000,                                    // a cycle waits uhubctlOffS with the power off
  uhubctlOffS: 3,
  manualEveryMs: 60000,                                       // the website's button: at most once a minute per phone
  killMinStuck: 3,                                            // kill-server only when this many phones are stuck
  killEveryMs: 30 * 60000,                                    // ... and at most this often per computer
  usbEveryMs: 30 * 60000,                                     // a USB reset per phone at most this often
  missedScans: 2,                                             // the same debounce as reconcile()'s drop
  noneEveryMs: 10 * 60000,                                    // "nothing to try": look again this much later
  reportKeep: 50,
};

const LADDER = {
  offline: ['reconnect_offline', 'reconnect_device', 'kill_server', 'usb_reset'],
  absent: ['kill_server', 'usb_reset'],
  unauthorized: ['reconnect_device', 'reconnect_device'],
  unresponsive: ['reconnect_device', 'usb_reset'],
};
const REPEAT_FROM = { offline: 1, absent: 0, unresponsive: 0 }; // where the ladder starts again after a full pass

/** The agent setting (agent-settings.json next to agent.json). Both OFF unless switched on (the
    shared rule: anything that acts on phones by itself ships default off). PD_SELF_RECOVERY / PD_USB_RESET (0/1) override both. */
function loadSettings(file, env = process.env) {
  let s = {};
  if (file) { try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { s = {}; } }
  const out = { self_recovery: s.self_recovery === true, usb_reset: s.usb_reset === true };
  if (env.PD_SELF_RECOVERY === '0') out.self_recovery = false;
  else if (env.PD_SELF_RECOVERY === '1') out.self_recovery = true;
  if (env.PD_USB_RESET === '1') out.usb_reset = true;
  else if (env.PD_USB_RESET === '0') out.usb_reset = false;
  return out;
}
function saveSettings(file, s) {
  fs.writeFileSync(file, JSON.stringify({ self_recovery: !!s.self_recovery, usb_reset: !!s.usb_reset }, null, 2));
}

/** The step for attempt number `n` (0 = the first) of a phone in `state`, or null when nothing is
    allowed / left. `allow(step)` says whether a step may run right now. Pure. */
function nextStep(state, n, allow) {
  const lad = LADDER[state];
  if (!lad) return null;
  if (state === 'unauthorized') return n < lad.length && allow(lad[n]) ? lad[n] : null;
  const from = REPEAT_FROM[state] || 0;
  const at = (i) => (i < lad.length ? lad[i] : lad[from + ((i - lad.length) % (lad.length - from))]);
  for (let k = 0; k < lad.length; k++) {
    const s = at(n + k);
    if (allow(s)) return s;
  }
  return null;
}

/** The USB instance id of the phone with this serial in `pnputil /enum-devices` output, or ''. The
    parent (composite) device is USB\VID_xxxx&PID_xxxx\SERIAL; interface children end in &MI_xx\... */
function findUsbInstance(out, serial) {
  if (!serial) return '';
  const want = String(serial).toUpperCase();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s*Instance ID:\s*(USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\(\S+))\s*$/i.exec(line);
    if (m && m[2].toUpperCase() === want) return m[1];
  }
  return '';
}

/** The hub + port the phone with this serial hangs off, in `uhubctl` (no arguments) output, or null.
    uhubctl lists every hub that can switch port power and, per port, what is plugged in:
      Current status for hub 20-3.4 [2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps]
        Port 1: 0103 power enable connect [18d1:4ee7 Google Pixel 8 48121FDJH000CR]
    The serial is the last word inside the port's brackets. Pure. */
function findHubPort(out, serial) {
  if (!serial) return null;
  const want = String(serial).toUpperCase();
  let hub = '';
  for (const line of String(out || '').split(/\r?\n/)) {
    const h = /^\s*Current status for hub (\S+)/i.exec(line);
    if (h) { hub = h[1]; continue; }
    const p = /^\s*Port (\d+):.*\[([0-9a-f]{4}:[0-9a-f]{4})([^\]]*)\]\s*$/i.exec(line);
    if (!p || !hub) continue;
    const words = p[3].trim().split(/\s+/);
    if (words.length && words[words.length - 1].toUpperCase() === want) return { hub, port: p[1] };
  }
  return null;
}

/** Where uhubctl is. The Mac app is started by launchd/Finder, whose PATH has no Homebrew, so the
    usual install places are looked at by name. PD_UHUBCTL points at another one. '' = not installed. */
function findUhubctl(env = process.env, exists = fs.existsSync) {
  const c = [env.PD_UHUBCTL, '/opt/homebrew/bin/uhubctl', '/usr/local/bin/uhubctl', '/usr/sbin/uhubctl', '/usr/bin/uhubctl']
    .filter(Boolean);
  for (const p of c) { try { if (exists(p)) return p; } catch {} }
  return '';
}

const STEP_WORDS = {
  reconnect_offline: 'adb reconnect offline',
  reconnect_device: 'adb reconnect (this phone)',
  kill_server: 'restart adb (kill-server / start-server)',
  usb_reset: 'USB reset (Windows: pnputil /restart-device; Mac/Linux: uhubctl power cycle)',
};

const STATE_LOG = {
  offline: 'adb says "offline": on USB, but adb lost it',
  unauthorized: 'adb says "unauthorized": the phone waits for "Allow USB debugging?"',
  absent: 'gone from adb devices: the computer does not see it on USB',
  unresponsive: 'adb lists it, but no command on it answers',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const errText = (e) => String((e && (e.stderr || e.message)) || e || '').trim().split(/\r?\n/)[0].slice(0, 200);

class Recovery {
  /** host: {
   *    adb(args, timeoutMs) -> Promise<string>   async adb (core._adbAsync)
   *    scan() -> Promise<[{serial, state}]>        a fresh `adb devices` (state 'ready' | 'offline' | 'unauthorized')
   *    paired() -> [serial]                        the phones this computer is paired with
   *    streamsOpen() -> number                     live tunnels on this computer
   *    jobsRunning() -> bool                       a post / account check / profile switch in progress
   *    settings() -> {self_recovery, usb_reset}
   *    report(evt), log(line)
   *    afterKill()                                 restart what holds an adb client (ws-scrcpy)
   *    run(cmd, args, timeoutMs) -> Promise<{code, out}>   for pnputil / uhubctl (never rejects)
   *    probe(serial) -> Promise<bool>              v0.5.21: does a real command answer? (`shell echo`)
   *    uhubctl() -> path or ''                     v0.5.21: where uhubctl is (Mac / Linux)
   *    now() -> ms, platform
   *  } */
  constructor(host, opts = {}) {
    this.host = host;
    this.cfg = { ...DEFAULTS, ...opts };
    this.phones = {};          // serial -> {state, missed, since, tries, nextAt, saidCap, saidNone, firstState}
    this.history = {};         // serial -> [attempt times] (survives episodes: the hourly cap is per phone)
    this.seen = new Set();     // serials seen on adb (any state) since the app started
    this.busy = false;
    this.lastKillAt = 0;
    this.lastUsb = {};
    this.usbOff = '';          // why the USB reset is off for this run ('' = it is not)
    this.hubPorts = {};        // serial -> {hub, port} last found in uhubctl's list (Mac / Linux)
    this.lastManual = {};      // serial -> when the website's button last ran for it
    this.lastReport = null;
  }

  /** '' when this computer has a way to reset a phone's USB at all (setting aside the owner's tick), else why not. */
  usbTool() {
    if (this.host.platform === 'win32') return '';
    if (this.host.platform !== 'darwin' && this.host.platform !== 'linux') return 'USB reset is not available on this system';
    let p = ''; try { p = (this.host.uhubctl && this.host.uhubctl()) || ''; } catch { p = ''; }
    return p ? '' : 'USB reset needs uhubctl (brew install uhubctl) and a hub that can switch port power';
  }

  now() { return this.host.now ? this.host.now() : Date.now(); }
  _settings() { try { return this.host.settings() || {}; } catch { return {}; } }

  /** Every scan (core.reconcile, every 2 s): who is stuck. Pure bookkeeping, no adb. */
  observe(rows) {
    const now = this.now();
    const by = {};
    (rows || []).forEach((r) => { by[r.serial] = r.state; this.seen.add(r.serial); });
    let paired = [];
    try { paired = this.host.paired() || []; } catch { paired = []; }
    const pairedSet = new Set(paired);
    Object.keys(this.phones).forEach((s) => { if (!pairedSet.has(s)) delete this.phones[s]; });   // unpaired
    paired.forEach((serial) => {
      if (!this.seen.has(serial)) return;                 // never seen since the app started (moved away?)
      const state = by[serial] || 'absent';
      const p = this.phones[serial];
      if (state === 'ready') {
        if (p && p.since != null) {
          const tries = p.tries;
          this._report({ serial, step: 'back', ok: true, state_before: p.state, state_after: 'ready', attempt: tries,
            detail: tries ? `back on adb after ${tries} ${tries === 1 ? 'try' : 'tries'}` : 'back on adb by itself',
            since: p.since });
          this.host.log && this.host.log(`${serial}: back on adb (${tries} recovery ${tries === 1 ? 'try' : 'tries'})`);
        }
        delete this.phones[serial];
        return;
      }
      const q = this.phones[serial] || (this.phones[serial] = { missed: 0, since: null, tries: 0, nextAt: 0 });
      q.missed++;
      if (q.since != null && q.state !== state) { q.saidNone = false; }     // a new state may have something to try
      q.state = state;
      if (q.since == null && q.missed >= this.cfg.missedScans) {
        q.since = now;
        q.firstState = state;
        q.nextAt = now + this.cfg.firstDelayMs;
        const on = !!this._settings().self_recovery;
        this.host.log && this.host.log(`${serial}: stuck (${STATE_LOG[state] || 'adb says "' + state + '"'})` +
          (on ? ` - self-recovery will try in ${Math.round(this.cfg.firstDelayMs / 1000)} s` : ' - self-recovery is off'));
      }
      // v0.5.21: say WHY it is down, once per state, whether or not self-recovery is on.
      if (q.since != null && q.saidState !== state) {
        q.saidState = state;
        this._report({ serial, step: 'stuck', ok: false, state_before: state, state_after: state, attempt: q.tries,
          detail: STATE_LOG[state] || state, since: q.since });
      }
    });
  }

  stuck() { return Object.keys(this.phones).filter((s) => this.phones[s].since != null); }

  status() {
    const st = this._settings();
    const tool = this.usbTool();
    return { on: !!st.self_recovery, usb_reset: !!st.usb_reset && !tool && !this.usbOff,
             usb_note: this.usbOff || tool,
             usb_tool: !tool,                         // v0.5.21: the website's "Power-cycle USB" button can work here
             stuck: this.stuck().length };
  }

  _allow(serial, now) {
    const st = this._settings();
    return (step) => {
      if (step === 'reconnect_offline' || step === 'reconnect_device') return true;
      if (step === 'kill_server') return this.killBlocked(now) === '';
      if (step === 'usb_reset') return this.usbBlocked(serial, now, st) === '';
      return false;
    };
  }

  /** '' when restarting adb's server is allowed now, else why not (words for the report). */
  killBlocked(now = this.now()) {
    const n = this.stuck().length;
    if (n < this.cfg.killMinStuck) return `restarting adb needs ${this.cfg.killMinStuck} stuck phones (${n} now)`;
    let streams = 0; try { streams = this.host.streamsOpen() || 0; } catch {}
    if (streams > 0) return `restarting adb waits: ${streams} live screen${streams === 1 ? '' : 's'} open on this computer`;
    let jobs = false; try { jobs = !!this.host.jobsRunning(); } catch {}
    if (jobs) return 'restarting adb waits: a post, account check or profile switch is running';
    if (this.lastKillAt && now - this.lastKillAt < this.cfg.killEveryMs) return 'adb was restarted less than 30 minutes ago';
    return '';
  }
  usbBlocked(serial, now = this.now(), st = this._settings()) {
    const tool = this.usbTool();
    if (tool) return tool;
    if (!st.usb_reset) return 'USB reset is off (agent setting)';
    if (this.usbOff) return this.usbOff;
    if (this.lastUsb[serial] && now - this.lastUsb[serial] < this.cfg.usbEveryMs) return 'USB reset was tried less than 30 minutes ago';
    return '';
  }

  /** Every scan, after observe(): start at most ONE attempt (for the whole computer). Returns its
      promise (the tests await it) or null. Never throws. */
  tick() {
    if (this.busy) return null;
    const st = this._settings();
    if (!st.self_recovery) return null;
    const now = this.now();
    const due = this.stuck().map((s) => [s, this.phones[s]]).filter(([, p]) => p.nextAt <= now)
      .sort((a, b) => a[1].nextAt - b[1].nextAt);
    if (!due.length) return null;
    const [serial, p] = due[0];
    const hist = (this.history[serial] || []).filter((t) => now - t < 3600000);
    this.history[serial] = hist;
    if (hist.length >= this.cfg.maxPerHour) {
      p.nextAt = hist[0] + 3600000;
      if (!p.saidCap) {
        p.saidCap = true;
        this._report({ serial, step: 'capped', ok: false, state_before: p.state, state_after: p.state, attempt: p.tries,
          detail: `${hist.length} tries in the last hour - waiting until ${new Date(p.nextAt).toISOString().slice(11, 16)} UTC`, since: p.since });
      }
      return null;
    }
    p.saidCap = false;
    const step = nextStep(p.state, p.tries, this._allow(serial, now));
    if (!step) {
      p.nextAt = now + this.cfg.noneEveryMs;
      if (!p.saidNone) {
        p.saidNone = true;
        let why;
        if (p.state === 'unauthorized') why = 'the phone asks "Allow USB debugging?" - someone must unlock it and tap Allow';
        else if (p.state === 'unresponsive') why = 'the phone is on USB but does not answer; ' + (this.usbBlocked(serial, now, st) || 'nothing left to try') +
          ' - restart the phone (hold the power button about 30 s if it is frozen)';
        else why = 'the computer does not see the phone on USB; ' + [this.killBlocked(now), this.usbBlocked(serial, now, st)].filter(Boolean).join('; ');
        this._report({ serial, step: 'none', ok: false, state_before: p.state, state_after: p.state, attempt: p.tries, detail: why, since: p.since });
      }
      return null;
    }
    this.busy = true;
    return this._attempt(serial, p, step).catch(() => {}).finally(() => { this.busy = false; });
  }

  async _attempt(serial, p, step) {
    const started = this.now();
    (this.history[serial] = this.history[serial] || []).push(started);
    p.tries++;
    const before = p.state;
    let detail = '';
    let ran = true;
    this.host.log && this.host.log(`${serial}: self-recovery try ${p.tries}: ${STEP_WORDS[step]}`);
    try {
      detail = await this._run(step, serial);
    } catch (e) {
      detail = 'failed: ' + errText(e);
      if (step === 'usb_reset' && this.usbOff) ran = false;
    }
    if (ran) await sleep(this.cfg.settleMs);
    let after = before;
    try {
      const rows = await this.host.scan();
      const r = (rows || []).find((x) => x.serial === serial);
      after = r ? r.state : 'absent';
    } catch { /* adb itself did not answer: keep the old state */ }
    // v0.5.21: a phone that was listed but did not answer is back only when a real command answers.
    if (after === 'ready' && (before === 'unresponsive' || p.firstState === 'unresponsive') && this.host.probe) {
      let alive = false;
      try { alive = !!(await this.host.probe(serial)); } catch { alive = false; }
      if (!alive) after = 'unresponsive';
    }
    const ok = after === 'ready';
    const wait = this.cfg.backoffMs[Math.min(p.tries - 1, this.cfg.backoffMs.length - 1)];
    p.nextAt = this.now() + wait;
    this._report({ serial, step, ok, state_before: before, state_after: after, attempt: p.tries,
      tries_hour: this.history[serial].length, cap: this.cfg.maxPerHour, detail: String(detail || '').slice(0, 300),
      since: p.since, next_in_s: ok ? null : Math.round(wait / 1000) });
    this.host.log && this.host.log(`${serial}: self-recovery try ${p.tries} (${step}) -> ${ok ? 'BACK' : 'still ' + after}${detail ? ' (' + detail + ')' : ''}`);
    if (ok) delete this.phones[serial];                  // reported here; observe() must not report "back" again
    else if (after !== before) { p.state = after; p.saidNone = false; }
  }

  async _run(step, serial) {
    const t = this.cfg.cmdTimeoutMs;
    if (step === 'reconnect_offline') return (await this.host.adb(['reconnect', 'offline'], t)) || 'done';
    if (step === 'reconnect_device') return (await this.host.adb(['-s', serial, 'reconnect'], t)) || 'done';
    if (step === 'kill_server') {
      this.lastKillAt = this.now();
      try { await this.host.adb(['kill-server'], t); } catch (e) { /* no server running is fine */ }
      await this.host.adb(['start-server'], this.cfg.startServerTimeoutMs);
      try { this.host.afterKill && this.host.afterKill(); } catch {}
      return 'adb server restarted';
    }
    if (step === 'usb_reset' && this.host.platform !== 'win32') {
      this.lastUsb[serial] = this.now();
      return this._uhubCycle(serial);
    }
    if (step === 'usb_reset') {
      this.lastUsb[serial] = this.now();
      const list = await this.host.run('pnputil', ['/enum-devices', '/connected'], this.cfg.pnputilTimeoutMs);
      if (list.code !== 0 && !/Instance ID/i.test(list.out || '')) {
        this.usbOff = 'USB reset is not available on this Windows (pnputil /enum-devices failed)';
        throw new Error(this.usbOff);
      }
      const id = findUsbInstance(list.out, serial);
      if (!id) return 'Windows does not list this phone on USB right now - nothing to reset';
      const r = await this.host.run('pnputil', ['/restart-device', id], this.cfg.pnputilTimeoutMs);
      if (r.code !== 0) {
        const o = String(r.out || '');
        if (/denied|administrator|elevat/i.test(o) || r.code === 5) {
          this.usbOff = 'USB reset needs the PhoneDesk app to run as administrator - off until the app restarts';
        } else if (/invalid|unknown|not recognized|usage/i.test(o)) {
          this.usbOff = 'USB reset needs Windows 10 2004 or newer (pnputil /restart-device)';
        }
        throw new Error((this.usbOff || 'pnputil said: ' + o.trim().split(/\r?\n/).pop()).slice(0, 200));
      }
      return 'USB device restarted';
    }
    throw new Error('unknown step ' + step);
  }

  /** Mac / Linux (v0.5.21): cut the power of the phone's hub port and turn it back on (uhubctl). */
  async _uhubCycle(serial) {
    const bin = (this.host.uhubctl && this.host.uhubctl()) || '';
    if (!bin) throw new Error('uhubctl is not installed (brew install uhubctl)');
    const t = this.cfg.uhubctlTimeoutMs;
    const list = await this.host.run(bin, [], t);
    const out = String(list.out || '');
    if (/permission|access denied|must be root|sudo/i.test(out) && !/Current status for hub/i.test(out)) {
      this.usbOff = 'uhubctl is not allowed to switch the hubs (it needs to run as root on this computer)';
      throw new Error(this.usbOff);
    }
    if (!/Current status for hub/i.test(out)) {
      throw new Error('no hub on this computer can switch its port power (uhubctl lists none) - a hub with per-port power switching is needed');
    }
    const found = findHubPort(out, serial);
    if (found) this.hubPorts[serial] = found;
    const at = found || this.hubPorts[serial];
    if (!at) throw new Error('the phone is not on a hub uhubctl can switch (or it dropped off USB before its port was ever seen)');
    const r = await this.host.run(bin, ['-l', at.hub, '-p', String(at.port), '-a', 'cycle', '-d', String(this.cfg.uhubctlOffS)], t);
    if (r.code !== 0) {
      const o = String(r.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || ('exit code ' + r.code);
      throw new Error(('uhubctl said: ' + o).slice(0, 200));
    }
    return `power of hub ${at.hub} port ${at.port} cut for ${this.cfg.uhubctlOffS} s and turned back on` + (found ? '' : ' (remembered port)');
  }

  /** The website's "Power-cycle USB" button (v0.5.21): one USB reset of this phone, now. A person asked,
      so the agent setting and the 30-minute spacing do not apply; at most one a minute per phone, and
      never while another try runs on this computer. Resolves {ok, state, detail}; never rejects. */
  async manualUsbReset(serial) {
    const tool = this.usbTool();
    if (tool) return { ok: false, state: 'unsupported', detail: tool };
    if (this.usbOff) return { ok: false, state: 'unsupported', detail: this.usbOff };
    const now = this.now();
    if (this.lastManual[serial] && now - this.lastManual[serial] < this.cfg.manualEveryMs) {
      return { ok: false, state: 'too_soon', detail: 'a USB reset of this phone ran less than a minute ago - give it a moment' };
    }
    if (this.busy) return { ok: false, state: 'busy', detail: 'another recovery try is running on this computer - try again in a minute' };
    this.busy = true;
    this.lastManual[serial] = now;
    const p = this.phones[serial];
    const before = (p && p.state) || 'ready';
    let detail = '', ok = false;
    try {
      detail = await this._run('usb_reset', serial);
      await sleep(this.cfg.settleMs);
      let after = before;
      try {
        const rows = await this.host.scan();
        const r = (rows || []).find((x) => x.serial === serial);
        after = r ? r.state : 'absent';
      } catch {}
      if (after === 'ready' && this.host.probe) {
        try { if (!(await this.host.probe(serial))) after = 'unresponsive'; } catch { after = 'unresponsive'; }
      }
      ok = after === 'ready';
      this._report({ serial, step: 'usb_reset', ok, state_before: before, state_after: after, attempt: p ? p.tries : 0,
        detail: ('by hand: ' + detail).slice(0, 300), since: p ? p.since : null });
      if (ok && p) delete this.phones[serial];
      return { ok, state: ok ? 'back' : after, detail };
    } catch (e) {
      detail = errText(e);
      this._report({ serial, step: 'usb_reset', ok: false, state_before: before, state_after: before, attempt: p ? p.tries : 0,
        detail: ('by hand, failed: ' + detail).slice(0, 300), since: p ? p.since : null });
      return { ok: false, state: 'failed', detail };
    } finally {
      this.busy = false;
    }
  }

  _report(evt) {
    const e = { at: this.now(), ...evt };
    this.lastReport = e;
    try { this.host.report(e); } catch {}
  }
}

module.exports = { Recovery, nextStep, findUsbInstance, findHubPort, findUhubctl, loadSettings, saveSettings, DEFAULTS, STEP_WORDS, STATE_LOG };
