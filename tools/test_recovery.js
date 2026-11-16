// v0.5.19 self-recovery of phones that fall off adb (src/recovery.js + its wiring in src/core.js), with a
// FAKE adb and a fake clock: the escalation ladder, the debounce and the first delay, one try at a time,
// the hourly cap, "nothing to try", kill-server only with several phones stuck and no stream / job,
// the Windows USB reset behind its setting (and Windows saying no), the setting switched off, a phone
// never seen since the app started, and the reports going out over ANOTHER phone's socket (or waiting
// for one). No phone, no real adb.
//
//   node tools/test_recovery.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Recovery, nextStep, findUsbInstance, findHubPort, findUhubctl, loadSettings, saveSettings } = require(path.join(__dirname, '..', 'src', 'recovery.js'));
const { AgentCore } = require(path.join(__dirname, '..', 'src', 'core.js'));

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

// ---- pure: the ladder -------------------------------------------------------------------------------
const all = () => true;
const noBig = (s) => s !== 'kill_server' && s !== 'usb_reset';
check('offline: the full ladder, then again from reconnect_device',
  [0, 1, 2, 3, 4, 5, 6, 7].map((n) => nextStep('offline', n, all)),
  ['reconnect_offline', 'reconnect_device', 'kill_server', 'usb_reset', 'reconnect_device', 'kill_server', 'usb_reset', 'reconnect_device']);
check('offline: steps that are not allowed are skipped', [0, 1, 2, 3].map((n) => nextStep('offline', n, noBig)),
  ['reconnect_offline', 'reconnect_device', 'reconnect_device', 'reconnect_device']);
check('absent: restart adb, USB reset', [0, 1, 2].map((n) => nextStep('absent', n, all)), ['kill_server', 'usb_reset', 'kill_server']);
check('absent with neither allowed: nothing to try', nextStep('absent', 0, noBig), null);
check('unauthorized: reconnect twice, then a person must tap Allow', [0, 1, 2].map((n) => nextStep('unauthorized', n, all)),
  ['reconnect_device', 'reconnect_device', null]);
check('an unknown state: nothing', nextStep('recovery', 0, all), null);

const PNP = [
  'Instance ID:                USB\\VID_8087&PID_0026\\5&2A3B&0&14',
  'Device Description:         Intel(R) Wireless Bluetooth(R)',
  '',
  'Instance ID:                USB\\VID_18D1&PID_4EE7\\35071FDH2002XY',
  'Device Description:         Pixel 8a',
  'Instance ID:                USB\\VID_18D1&PID_4EE7&MI_01\\6&1C2&0&0001',
].join('\r\n');
check('pnputil: the phone\'s USB device by its serial', findUsbInstance(PNP, '35071fdh2002xy'), 'USB\\VID_18D1&PID_4EE7\\35071FDH2002XY');
check('pnputil: a serial that is not there', findUsbInstance(PNP, 'NOPE'), '');
check('pnputil: an empty serial never matches', findUsbInstance(PNP, ''), '');

// ---- the setting ---------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd_rec_'));
const sf = path.join(tmp, 'agent-settings.json');
check('no settings file: both OFF (default off)', loadSettings(sf, {}), { self_recovery: false, usb_reset: false });
saveSettings(sf, { self_recovery: false, usb_reset: true });
check('saved settings are read back', loadSettings(sf, {}), { self_recovery: false, usb_reset: true });
check('the environment overrides the file', loadSettings(sf, { PD_SELF_RECOVERY: '1', PD_USB_RESET: '0' }), { self_recovery: true, usb_reset: false });
fs.writeFileSync(sf, '{broken');
check('a broken file = the defaults (off)', loadSettings(sf, {}), { self_recovery: false, usb_reset: false });

// ---- the manager with a fake adb -------------------------------------------------------------------------
function farm(opts = {}) {
  const t = { now: 1_000_000 };
  const states = Object.assign({}, opts.states || {});   // serial -> 'ready' | 'offline' | 'unauthorized' | (missing = absent)
  const calls = [];
  const reports = [];        // the tries and their outcome ('stuck' state reports, v0.5.21, are in `said`)
  const said = [];
  const runs = [];
  const pairedList = opts.paired || Object.keys(states);   // fixed at the start: a phone that leaves adb stays paired
  const st = Object.assign({ self_recovery: true, usb_reset: false }, opts.settings || {});
  const host = {
    adb: (args, timeoutMs) => {
      calls.push(args.join(' ') + (timeoutMs ? '' : ' (NO TIMEOUT)'));
      const cmd = args.join(' ');
      if (opts.onAdb) opts.onAdb(cmd, states);
      return Promise.resolve('');
    },
    scan: () => Promise.resolve(Object.keys(states).map((s) => ({ serial: s, state: states[s] }))),
    paired: () => pairedList,
    streamsOpen: () => (opts.streams || 0),
    jobsRunning: () => !!opts.jobs,
    settings: () => st,
    report: (e) => (e.step === 'stuck' ? said : reports).push(e),
    log: () => {},
    afterKill: () => calls.push('AFTER_KILL'),
    run: (cmd, args, timeoutMs) => {
      runs.push(cmd + ' ' + args.join(' '));
      return Promise.resolve(opts.onRun ? opts.onRun(args) : { code: 0, out: '' });
    },
    now: () => t.now,
    platform: opts.platform || 'linux',
    probe: (serial) => Promise.resolve(opts.probe ? opts.probe(serial, states) : true),
    uhubctl: () => (opts.uhubctl || ''),
  };
  const r = new Recovery(host, { settleMs: 0 });
  const rows = () => Object.keys(states).map((s) => ({ serial: s, state: states[s] }));
  const scan = () => r.observe(rows());
  return { r, t, states, calls, reports, said, runs, st, scan, host };
}
const steps = (reports) => reports.map((e) => e.step + (e.ok ? ':ok' : ''));

(async () => {
  // 1. offline -> the first try after the debounce + delay; adb reconnect brings it back
  {
    const f = farm({ states: { A: 'ready', B: 'ready' }, onAdb: (cmd, s) => { if (cmd === 'reconnect offline') s.B = 'ready'; } });
    f.scan();
    f.states.B = 'offline';
    f.scan();
    check('one scan is a hiccup, not stuck', f.r.stuck(), []);
    f.scan();
    check('two scans = stuck', f.r.stuck(), ['B']);
    check('nothing is tried before the first delay', f.r.tick(), null);
    f.t.now += 20000;
    const p = f.r.tick();
    check('...then one try starts', p !== null, true);
    check('only ONE try at a time for the computer', f.r.tick(), null);
    await p;
    check('the first step is adb reconnect offline, with a timeout', f.calls, ['reconnect offline']);
    check('reported: the step, ok, the states', f.reports.map((e) => [e.serial, e.step, e.ok, e.state_before, e.state_after, e.attempt]),
      [['B', 'reconnect_offline', true, 'offline', 'ready', 1]]);
    f.scan();
    check('the phone back after a try is not reported a second time', f.reports.length, 1);
    check('...and nothing is stuck any more', f.r.stuck(), []);
  }

  // 2. a phone that stays offline: the ladder, the backoff, the hourly cap
  {
    const f = farm({ states: { A: 'ready', B: 'ready' } });
    f.scan(); f.states.B = 'offline'; f.scan(); f.scan();
    const run = async () => { const p = f.r.tick(); if (p) await p; return !!p; };
    f.t.now += 20000;
    await run();
    check('try 1: reconnect offline', f.calls.slice(-1), ['reconnect offline']);
    check('the next try waits (backoff)', await run(), false);
    f.t.now += 60000;
    await run();
    check('try 2: this phone only', f.calls.slice(-1), ['-s B reconnect']);
    f.t.now += 120000;
    await run();
    check('try 3: one phone stuck -> no adb restart, reconnect again', f.calls.slice(-1), ['-s B reconnect']);
    check('kill-server was never run', f.calls.includes('kill-server'), false);
    for (let i = 0; i < 3; i++) { f.t.now += 1200000; await run(); }
    check('six tries happened', f.reports.filter((e) => !['capped', 'none', 'back'].includes(e.step)).length, 6);
    check('every try failed and says when the next one comes', f.reports.every((e) => e.ok === false && e.next_in_s > 0), true);
  }
  {
    const f = farm({ states: { B: 'ready' } });
    f.r.cfg.backoffMs = [1000];
    f.scan(); f.states.B = 'offline'; f.scan(); f.scan();
    f.t.now += 20000;
    for (let i = 0; i < 9; i++) { const p = f.r.tick(); if (p) await p; f.t.now += 1000; }
    const tries = f.reports.filter((e) => e.step !== 'capped');
    check('at most 6 tries in an hour per phone', tries.length, 6);
    check('one "capped" report, not one per scan', f.reports.filter((e) => e.step === 'capped').length, 1);
    const capped = f.reports.find((e) => e.step === 'capped');
    check('the capped report says when it goes on', /waiting until \d\d:\d\d UTC/.test(capped.detail), true);
    f.t.now += 3600000;
    const p = f.r.tick();
    check('after the hour it tries again', p !== null, true);
    await p;
  }

  // 3. gone from adb, alone on the computer: nothing a computer can do -> one "none" report, no adb call
  {
    const f = farm({ states: { A: 'ready', B: 'ready' } });
    f.scan(); delete f.states.B; f.scan(); f.scan();
    f.t.now += 20000;
    check('absent + nothing allowed: no try', f.r.tick(), null);
    check('no adb command was run', f.calls, []);
    check('one "none" report saying why', f.reports.map((e) => [e.step, e.state_before]), [['none', 'absent']]);
    check('...in words', /does not see the phone on USB; restarting adb needs 3 stuck phones \(1 now\); USB reset needs uhubctl/.test(f.reports[0].detail), true);
    f.t.now += 20 * 60000;
    f.r.tick();
    check('...not repeated every look', f.reports.length, 1);
    f.states.B = 'ready'; f.scan();
    check('when it comes back by itself that is reported', f.reports.slice(-1).map((e) => [e.step, e.ok, e.detail]), [['back', true, 'back on adb by itself']]);
  }

  // 4. unauthorized: reconnect twice, then the person
  {
    const f = farm({ states: { B: 'ready' } });
    f.r.cfg.backoffMs = [1000];
    f.scan(); f.states.B = 'unauthorized'; f.scan(); f.scan();
    f.t.now += 20000;
    for (let i = 0; i < 4; i++) { const p = f.r.tick(); if (p) await p; f.t.now += 1000; }
    check('unauthorized: two reconnects', f.calls, ['-s B reconnect', '-s B reconnect']);
    check('then: tap Allow', f.reports.slice(-1).map((e) => [e.step, /Allow USB debugging/.test(e.detail)]), [['none', true]]);
  }

  // 5. several phones stuck: kill-server only with no stream and no job, at most every 30 min
  {
    const opts = { states: { A: 'ready', B: 'ready', C: 'ready', D: 'ready' }, streams: 1 };
    const f = farm(opts);
    f.scan(); ['B', 'C', 'D'].forEach((s) => { delete f.states[s]; }); f.scan(); f.scan();
    f.t.now += 20000;
    check('3 stuck but a live screen is open: no try (nothing else for an absent phone)', f.r.tick(), null);
    check('the reason names the open screen', f.reports.every((e) => e.step === 'none' && /live screen/.test(e.detail)), true);
    opts.streams = 0; opts.jobs = true;
    check('a job running: still no restart', f.r.killBlocked(f.t.now), 'restarting adb waits: a post, account check or profile switch is running');
    opts.jobs = false;
    f.t.now += 10 * 60000;
    const p = f.r.tick();
    check('no stream, no job, 3 stuck: adb is restarted', p !== null, true);
    await p;
    check('kill-server, start-server, then ws-scrcpy restarted', f.calls, ['kill-server', 'start-server', 'AFTER_KILL']);
    f.t.now += 10 * 60000;
    const q = f.r.tick();
    if (q) await q;
    check('...but not again within 30 minutes', f.calls.filter((c) => c === 'kill-server').length, 1);
  }

  // 6. the Windows USB reset: off by default, on with the setting, Windows saying no
  {
    const f = farm({ states: { B: 'ready' }, platform: 'win32' });
    f.r.cfg.backoffMs = [1000];
    f.scan(); f.states.B = 'offline'; f.scan(); f.scan();
    check('USB reset off by default', f.r.usbBlocked('B', f.t.now), 'USB reset is off (agent setting)');
    f.st.usb_reset = true;
    f.host.run = (cmd, args) => {
      f.runs.push(cmd + ' ' + args.join(' '));
      if (args[0] === '/enum-devices') return Promise.resolve({ code: 0, out: PNP.replace('35071FDH2002XY', 'B') });
      return Promise.resolve({ code: 5, out: 'Access is denied.' });
    };
    f.t.now += 20000;
    for (let i = 0; i < 4; i++) { const p = f.r.tick(); if (p) await p; f.t.now += 1000; }
    check('the USB reset ran pnputil on the phone\'s device', f.runs, ['pnputil /enum-devices /connected', 'pnputil /restart-device USB\\VID_18D1&PID_4EE7\\B']);
    const usb = f.reports.find((e) => e.step === 'usb_reset');
    check('Windows said no: reported in words', /run as administrator/.test(usb.detail), true);
    check('...and the step is off until the app restarts', f.r.status().usb_reset, false);
    check('...the status says why', /administrator/.test(f.r.status().usb_note), true);
  }
  {
    const f = farm({ states: { B: 'ready' }, platform: 'darwin', settings: { usb_reset: true } });
    check('a Mac without uhubctl: no USB reset, and it says what is missing', /uhubctl/.test(f.r.usbBlocked('B', f.t.now)), true);
    check('...the status tells the website the button cannot work here', f.r.status().usb_tool, false);
  }

  // 6b. v0.5.21: Mac / Linux USB power cycle through uhubctl
  const UHUB = [
    'Current status for hub 20-3.4 [2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps]',
    '  Port 1: 0103 power enable connect [18d1:4ee7 Google Pixel 8 48121FDJH000CR]',
    '  Port 2: 0100 power',
    '  Port 3: 0103 power enable connect [18d1:4ee7 Google Pixel 6a 26111JEGR0XXXX]',
    'Current status for hub 20-3 [2109:0817 VIA Labs, Inc. USB3.0 Hub, USB 3.00, 4 ports, ppps]',
    '  Port 1: 02a0 power 5gbps Rx.Detect',
  ].join('\n');
  check('uhubctl: the phone\'s hub and port by its serial', findHubPort(UHUB, '26111jegr0xxxx'), { hub: '20-3.4', port: '3' });
  check('uhubctl: a serial on no port', findHubPort(UHUB, 'NOPE'), null);
  check('uhubctl: an empty serial never matches', findHubPort(UHUB, ''), null);
  check('uhubctl is found where Homebrew puts it', findUhubctl({}, (p) => p === '/opt/homebrew/bin/uhubctl'), '/opt/homebrew/bin/uhubctl');
  check('...PD_UHUBCTL wins', findUhubctl({ PD_UHUBCTL: '/x/uhubctl' }, () => true), '/x/uhubctl');
  check('...none installed: empty', findUhubctl({}, () => false), '');
  {
    const f = farm({ states: { '48121FDJH000CR': 'offline' }, platform: 'darwin', uhubctl: '/opt/homebrew/bin/uhubctl',
      settings: { usb_reset: true },
      onRun: (args) => { if (!args.length) return { code: 0, out: UHUB }; f.states['48121FDJH000CR'] = 'ready'; return { code: 0, out: 'Sent power cycle' }; } });
    check('a Mac with uhubctl: the USB reset is allowed', f.r.usbBlocked('48121FDJH000CR', f.t.now), '');
    check('...and the website button can work', f.r.status().usb_tool, true);
    const res = await f.r.manualUsbReset('48121FDJH000CR');
    check('the button: power cycle of the right port', f.runs,
      ['/opt/homebrew/bin/uhubctl ', '/opt/homebrew/bin/uhubctl -l 20-3.4 -p 1 -a cycle -d 3']);
    check('...the phone came back', [res.ok, res.state], [true, 'back']);
    check('...reported as a by-hand USB reset', f.reports.map((e) => [e.step, e.ok, /by hand/.test(e.detail)]), [['usb_reset', true, true]]);
    const again = await f.r.manualUsbReset('48121FDJH000CR');
    check('...not twice within a minute', again.state, 'too_soon');
    f.t.now += 61000;
    delete f.states['48121FDJH000CR'];                 // gone from USB: the remembered port is used
    const f2out = UHUB.replace('[18d1:4ee7 Google Pixel 8 48121FDJH000CR]', '');
    f.host.run = (cmd, args) => { f.runs.push(cmd + ' ' + args.join(' ')); return Promise.resolve(args.length ? { code: 0, out: '' } : { code: 0, out: f2out }); };
    const gone = await f.r.manualUsbReset('48121FDJH000CR');
    check('a phone gone from USB: its remembered port is cycled', f.runs[f.runs.length - 1], '/opt/homebrew/bin/uhubctl -l 20-3.4 -p 1 -a cycle -d 3');
    check('...still gone afterwards: not ok, says absent', [gone.ok, gone.state, /remembered port/.test(gone.detail)], [false, 'absent', true]);
  }
  {
    const f = farm({ states: { B: 'ready' }, platform: 'darwin', uhubctl: '/u',
      onRun: () => ({ code: 0, out: 'No compatible devices detected!' }) });
    const res = await f.r.manualUsbReset('B');
    check('no switchable hub: the button says so in words', [res.ok, /per-port power switching/.test(res.detail)], [false, true]);
  }
  {
    const f = farm({ states: { B: 'ready' }, platform: 'darwin' });
    const res = await f.r.manualUsbReset('B');
    check('no uhubctl: unsupported, says what to install', [res.state, /brew install uhubctl/.test(res.detail)], ['unsupported', true]);
  }

  // 6c. v0.5.21: a phone adb lists but that does not answer ('unresponsive'), and the state reports
  check('unresponsive: reconnect this phone, USB reset, then again', [0, 1, 2].map((n) => nextStep('unresponsive', n, all)),
    ['reconnect_device', 'usb_reset', 'reconnect_device']);
  {
    let answers = false;
    const f = farm({ states: { B: 'ready' }, settings: { self_recovery: false }, probe: () => answers,
      onAdb: (cmd) => { if (cmd === '-s B reconnect') answers = true; } });
    f.scan();
    f.states.B = 'unresponsive'; f.scan(); f.scan();
    check('stuck with self-recovery OFF: the state is still reported once', f.said.map((e) => [e.step, e.state_before]), [['stuck', 'unresponsive']]);
    f.scan(); f.scan();
    check('...not again every scan', f.said.length, 1);
    f.states.B = 'offline'; f.scan();
    check('...again when the state changes', f.said.map((e) => e.state_before), ['unresponsive', 'offline']);
    check('...and nothing is tried while it is off', [f.r.tick(), f.calls.length], [null, 0]);
    f.states.B = 'unresponsive'; f.scan();
    f.st.self_recovery = true;
    f.t.now += 20000;
    // the first try: adb lists it as "device" again but a real command does not answer yet
    answers = false;
    f.host.adb = (args, t) => { f.calls.push(args.join(' ')); return Promise.resolve(''); };
    f.states.B = 'unresponsive';
    const realScan = f.host.scan;
    f.host.scan = () => Promise.resolve([{ serial: 'B', state: 'ready' }]);
    await f.r.tick();
    check('listed again but not answering: NOT counted as back', f.reports.map((e) => [e.step, e.ok, e.state_after]), [['reconnect_device', false, 'unresponsive']]);
    f.t.now += 61000;
    answers = true;
    await f.r.tick();
    const last = f.reports[f.reports.length - 1];
    check('...back only when a real command answers (2nd try, a reconnect: the USB reset is off)', [last.step, last.ok, last.state_after], ['reconnect_device', true, 'ready']);
    f.host.scan = realScan;
  }

  // 7. switched off; a phone never seen since the app started
  {
    const f = farm({ states: { B: 'ready' }, settings: { self_recovery: false } });
    f.scan(); f.states.B = 'offline'; f.scan(); f.scan();
    f.t.now += 20000;
    check('self-recovery off: nothing runs', [f.r.tick(), f.calls.length], [null, 0]);
    check('...the status says off', f.r.status().on, false);
  }
  {
    const f = farm({ states: { A: 'ready' }, paired: ['A', 'GONE'] });
    f.scan(); f.scan(); f.scan();
    check('a paired phone never seen on this computer since the start is left alone', f.r.stuck(), []);
  }
  {
    const f = farm({ states: { A: 'ready', B: 'ready' }, paired: ['A', 'B'] });
    f.scan(); f.states.B = 'offline'; f.scan(); f.scan();
    f.host.paired = () => ['A'];
    f.scan();
    check('an unpaired phone is forgotten', f.r.stuck(), []);
  }

  // 8. core.js: the reports ride another phone's socket, or wait for one
  {
    const core = Object.create(AgentCore.prototype);
    core.emit = () => {};
    core._loadTokens = () => ({ B: { name: 'Phone 7' } });
    core._recoveryOutbox = [];
    const sent = [];
    core.devices = { A: { ws: { readyState: 3, send: () => sent.push('closed!') } } };
    core._reportRecovery({ serial: 'B', step: 'reconnect_device', ok: false });
    check('no open socket: the report waits', [sent.length, core._recoveryOutbox.length], [0, 1]);
    core.devices.C = { ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) } };
    core._flushRecovery();
    check('...and goes out over another phone\'s socket once one is open', sent.map((m) => [m.op, m.data.serial, m.data.name, m.data.step]),
      [['recovery', 'B', 'Phone 7', 'reconnect_device']]);
    for (let i = 0; i < 60; i++) { core.devices = {}; core._reportRecovery({ serial: 'B', step: 'x' + i }); }
    check('at most 50 wait', core._recoveryOutbox.length, 50);
    check('...the newest ones', core._recoveryOutbox[49].step, 'x59');

    // the host adapter only ever uses the ASYNC adb
    const c2 = Object.create(AgentCore.prototype);
    c2.emit = () => {};
    c2.devices = {};
    c2._loadTokens = () => ({ S1: {} });
    c2.settingsFile = path.join(tmp, 'none.json');
    c2._recovery = null;
    c2._adb = () => { throw new Error('BLOCKING adb used by self-recovery'); };
    const asyncCalls = [];
    c2._adbAsync = (args, t) => { asyncCalls.push([args.join(' '), t]); return Promise.resolve('List of devices attached\nS1\toffline'); };
    const mgr = c2._recoveryMgr();
    const rows = await mgr.host.scan();
    await mgr.host.adb(['-s', 'S1', 'reconnect'], 10000);
    check('the scan + reconnect use the async adb with a timeout', asyncCalls.map((c) => c[0]), ['devices', '-s S1 reconnect']);
    check('...the scan parses the states', rows, [{ serial: 'S1', state: 'offline' }]);
    check('...and refreshes the device cache reconcile() reads', c2._deviceCache, rows);
    check('settings default: both off', c2.recoverySettings(), { self_recovery: false, usb_reset: false });
    c2.settingsFile = path.join(tmp, 's2.json');
    check('the owner app switches it', c2.setRecoverySettings({ self_recovery: true, usb_reset: true }), { self_recovery: true, usb_reset: true });
    check('...and it is saved', JSON.parse(fs.readFileSync(c2.settingsFile, 'utf8')), { self_recovery: true, usb_reset: true });
    c2._posting = new Set(['S9']);
    check('a post running counts as a job', c2._jobsRunning(), true);
  }

  // 9. v0.5.21: adb errors in words, and "on adb but not answering" from the heartbeat
  {
    const W = AgentCore._adbErrText;
    check('a timeout says the phone did not answer', /did not answer in 15 s/.test(W({ killed: true }, '', 15000)), true);
    check('adb\'s own complaint is kept (last line)', W({ code: 1, message: 'Command failed: adb -s X shell' }, 'x\nerror: device offline\n', 8000), 'adb: error: device offline');
    check('"Command failed: <command line>" alone is never the answer', W({ code: 1, message: 'Command failed: adb -s X exec-out screencap -p' }, '', 8000), 'adb failed (exit code 1)');
    const c = Object.create(AgentCore.prototype);
    const logs = [];
    c.emit = (k, l) => logs.push(l);
    c.devices = { P: {} };
    c._noteAdb('P', false, new Error('the phone did not answer in 8 s'));
    check('one failed beat is not "unresponsive"', c._adbState('P').state, 'ready');
    c._noteAdb('P', false, new Error('the phone did not answer in 8 s'));
    const s = c._adbState('P');
    check('two in a row are', [s.state, s.fails, /did not answer/.test(s.error)], ['unresponsive', 2, true]);
    check('...logged once', logs.filter((l) => /not answering/.test(l)).length, 1);
    c._noteAdb('P', true);
    check('one good answer clears it', c._adbState('P').state, 'ready');
    // the meta beat carries it, and an unresponsive phone keeps its last profile list (no 3 extra timeouts)
    c.devices.P = { adbHealth: { fails: 3, since: 5, error: 'x' }, _metaCache: { users: [{ id: 0, name: 'Owner' }], current_user: 0 } };
    c.appVersion = '0.5.21';
    c._hostStats = () => ({});
    let extra = 0;
    c._adbAsync = (args) => { if (args.includes('dumpsys')) return Promise.reject(Object.assign(new Error('t'), { killed: true })); extra++; return Promise.reject(new Error('no')); };
    c._loadTokens = () => ({});
    const meta = await c._metaPayloadAsync('P', true);
    check('the meta beat says unresponsive', meta.adb.state, 'unresponsive');
    check('...keeps the last profile list and asks nothing more', [meta.users.length, extra], [1, 0]);
  }

  console.log(fail ? `\n${fail} FAILING` : '\nall recovery checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
