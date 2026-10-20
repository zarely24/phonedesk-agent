// v0.5.4: the paths that froze a whole computer's video no longer touch the BLOCKING adb helper, and
// the work that ran on every reconnect (charge probe, policy re-push) is cached / skipped.
// Companion to test-nonblocking.js (which covers the timers). Run: node tools/test-freeze-paths.js
const path = require('path');
const { AgentCore } = require(path.join(process.cwd(), 'src', 'core.js'));

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

function makeCore(answers = {}) {
  const core = Object.create(AgentCore.prototype);   // skip the constructor's side effects
  core.devices = { SER1: { backoff: 1000 } };
  core.adbPath = 'adb';
  core.suPrefix = 'su -c';
  core.chargeNodes = { stopLevel: '/sys/fw/charge_stop_level', startLevel: '/sys/fw/charge_start_level',
    gates: ['/sys/g/charging_enabled', '/sys/g/input_suspend'] };
  core._chargeProbe = {};
  core.tokens = {};
  core._loadTokens = () => core.tokens;
  core._saveTokens = (m) => { core.tokens = m; core.saved = (core.saved || 0) + 1; };
  core.logs = [];
  core.emit = (kind, line) => { if (kind === 'log') core.logs.push(String(line)); };
  core.blocking = 0;
  core._adb = () => { core.blocking++; throw new Error('BLOCKING adb used'); };
  core.asyncCalls = [];
  core._adbAsync = (args) => {
    const cmd = args.join(' ');
    core.asyncCalls.push(cmd);
    if (answers.fail) return Promise.reject(new Error('device offline'));
    if (cmd.includes('test -e')) return Promise.resolve(answers.nodes ? 'yes' : '');
    if (/ id'$/.test(cmd) || cmd.endsWith(" 'id'")) return Promise.resolve(answers.root ? 'uid=0(root)' : 'uid=2000(shell)');
    if (cmd.includes('dumpsys battery')) return Promise.resolve('  level: 50\n  status: 2\n  USB powered: true');
    if (cmd.includes('pm list users')) return Promise.resolve('Users:\n\tUserInfo{0:Owner:13} running');
    if (cmd.includes('get-current-user')) return Promise.resolve('0');
    if (cmd.includes('content query')) return Promise.resolve('Row: 0 _id=42');
    return Promise.resolve('');
  };
  return core;
}
const tick = () => new Promise((r) => setTimeout(r, 20));
function fakeWs() { const ws = { readyState: 1, sent: [] }; ws.send = (s) => ws.sent.push(JSON.parse(s)); return ws; }

(async () => {
  // ---- 1. the connect-time charge probe: async, and probed once per serial ----
  const c1 = makeCore();
  c1.devices.SER1.chargePolicy = { enabled: true, stop: 80, resume: 25 };
  await c1._applyChargePolicy('SER1');
  check('charge probe used ZERO blocking adb calls', c1.blocking, 0);
  check('charge probe asked the phone (stop node, 2 gates, root)', c1.asyncCalls.length, 4);
  check('status reported to the dashboard', c1.devices.SER1.chargeStatus, 'unavailable (phone is not rooted)');
  check('policy recorded as applied', c1.devices.SER1.chargeApplied, { enabled: true, stop: 80, resume: 25 });

  // a reconnect throws the device object away (_dropDevice) - the probe result must survive that
  c1._dropDevice('SER1');
  c1.devices.SER1 = { backoff: 1000, chargePolicy: { enabled: true, stop: 80, resume: 25 } };
  c1.asyncCalls.length = 0;
  await c1._applyChargePolicy('SER1');
  check('after a reconnect the probe is NOT repeated (zero adb calls)', c1.asyncCalls.length, 0);
  check('...and the status is still reported', c1.devices.SER1.chargeStatus, 'unavailable (phone is not rooted)');

  // ---- 2. the backend re-pushes the same policy on every connect: skip it ----
  c1.asyncCalls.length = 0; c1.logs.length = 0;
  const ws1 = fakeWs();
  c1.setChargePolicy('SER1', { enabled: true, stop: 80, resume: 25 }, ws1);
  await tick();
  check('identical push: no probe, only the meta reply (battery + users + current)', c1.asyncCalls.filter((c) => /test -e| id'|'id'/.test(c)).length, 0);
  check('identical push: logged as skipped', c1.logs.some((l) => /already applied, not re-probing/.test(l)), true);
  check('identical push: dashboard meta still refreshed', ws1.sent.length === 1 && ws1.sent[0].op === 'meta' && ws1.sent[0].data.battery === 50, true);
  check('identical push: token file not rewritten', c1.saved || 0, 0);
  check('meta reply used ZERO blocking adb calls', c1.blocking, 0);

  // a different policy IS applied (and persisted)
  c1.tokens = { SER1: { device_token: 't' } };
  const ws2 = fakeWs();
  c1.setChargePolicy('SER1', { enabled: true, stop: 90, resume: 30 }, ws2);
  await tick();
  check('changed push: applied + persisted', [c1.devices.SER1.chargeApplied.stop, c1.tokens.SER1.chargePolicy.stop, c1.saved], [90, 90, 1]);
  check('changed push: still zero blocking calls', c1.blocking, 0);

  // ---- 3. a probe that could not reach the phone is not cached ----
  const c3 = makeCore({ fail: true });
  c3.devices.SER1.chargePolicy = { enabled: true, stop: 80, resume: 25 };
  await c3._applyChargePolicy('SER1');
  check('unreachable phone: zero blocking calls, degraded status', [c3.blocking, c3.devices.SER1.chargeStatus], [0, 'unavailable (phone is not rooted)']);
  check('unreachable phone: nothing cached, so the next connect probes again', c3._chargeProbe.SER1.nodes === undefined, true);

  // the firmware path, for completeness
  const c4 = makeCore({ nodes: true });
  c4.devices.SER1.chargePolicy = { enabled: true, stop: 80, resume: 25 };
  await c4._applyChargePolicy('SER1');
  check('firmware nodes: written through the async helper', [c4.blocking, c4.devices.SER1.chargeMethod,
    c4.asyncCalls.some((c) => c.includes('echo 25 > /sys/fw/charge_start_level'))], [0, 'firmware', true]);

  // ---- 4. upload-to-gallery (secondary profile, no root) ----
  const c5 = makeCore();
  c5._adbPush = async () => {}; c5._adbShellLong = async () => {};
  const landed = await c5._pushToGalleryMediaStore('SER1', 'C:/tmp/x.jpg', 'x.jpg', 25);
  check('gallery upload used ZERO blocking adb calls', c5.blocking, 0);
  check('gallery upload found the MediaStore row', /\/42 \(user 25, mediastore\)/.test(landed), true);
  const c6 = makeCore();
  c6._adbPush = async () => {}; c6._adbShellLong = async () => {};
  c6._pushToGalleryMediaStore = async () => 'ms'; c6._pushToGalleryRoot = async () => 'root';
  check('main-profile upload: zero blocking calls', [await c6._pushToGallery('SER1', 'f', 'x.jpg', 0), c6.blocking], ['/sdcard/DCIM/Camera/x.jpg', 0]);
  check('secondary-profile upload picks the non-root path without blocking', [await c6._pushToGallery('SER1', 'f', 'x.jpg', 25), c6.blocking], ['ms', 0]);

  // ---- 5. reconcile: a phone must be missing from TWO scans before it is dropped ----
  const c7 = makeCore();
  c7.startWsScrcpy = () => {}; c7._startUplinkProbes = () => {}; c7._refreshDevices = () => {}; c7.connectHome = () => {};
  c7.tokens = { SER1: { device_token: 't' } };
  c7.devices.SER1.ws = { readyState: 1, close() { c7.closed = true; } };
  c7._deviceCache = [];                      // one scan without the phone
  c7.reconcile();
  check('missing once: kept (USB hiccup)', [!!c7.devices.SER1, !!c7.closed], [true, false]);
  c7._deviceCache = [{ serial: 'SER1', state: 'ready' }];
  c7.reconcile();
  check('back on the next scan: miss counter reset', c7.devices.SER1.missedScans, 0);
  c7._deviceCache = [{ serial: 'SER1', state: 'offline' }];
  c7.reconcile(); c7.reconcile();
  check('missing twice: dropped and the reason logged', [!!c7.devices.SER1, !!c7.closed, c7.logs.some((l) => /adb reports it "offline" for 2 scans - dropping/.test(l))], [false, true, true]);
  check('`adb devices` rows: offline is surfaced, not silently dropped', c7._rowsToDevices('List of devices attached\nA\tdevice\nB\toffline\nC\tunauthorized\n'),
    [{ serial: 'A', state: 'ready' }, { serial: 'B', state: 'offline' }, { serial: 'C', state: 'unauthorized' }]);

  // ---- 6. profile switch: keeps the new profile's screen on, replies without blocking ----
  const c8 = makeCore();
  const long = [];
  c8._adbLong = (serial, args) => {
    const cmd = args.join(' '); long.push(cmd);
    if (cmd.includes('get-current-user')) return Promise.resolve('25');
    if (cmd.includes('get global airplane_mode_on')) return Promise.resolve(long.some((c) => c.includes('airplane-mode disable')) ? '0' : '1');
    if (cmd.includes('get system screen_off_timeout')) return Promise.resolve('1800000');
    return Promise.resolve('');
  };
  c8._waitForNetwork = async () => 'android';
  const ws8 = fakeWs();
  await c8.switchUser('SER1', 25, ws8);
  await tick();
  check('switch: stay awake while plugged set globally', long.includes('shell settings put global stay_on_while_plugged_in 7'), true);
  check('switch: the NEW profile\'s screen timeout set (--user before put)', long.includes('shell settings --user 25 put system screen_off_timeout 1800000'), true);
  check('switch: keep-screen-on verified by reading back', c8.logs.some((l) => /Keep screen on: PASS/.test(l)), true);
  check('switch: meta reply sent via the async reader', ws8.sent.length === 1 && ws8.sent[0].op === 'meta' && ws8.sent[0].data.current_user === 0, true);
  check('switch: ZERO blocking adb calls', c8.blocking, 0);

  console.log(fail ? `\n${fail} FAILING` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
