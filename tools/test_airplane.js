'use strict';
// v0.5.2 — unit test for the VERIFIED profile-switch / airplane cycle in AgentCore.switchUser().
// Exercises the REAL method with a mocked adb (_adbLong) so we test the actual verification logic,
// PASS/FAIL logs, "skip airplane if the profile switch failed" rule, and per-phone failure isolation.
// No real device, no real adb. Run: node tools/test_airplane.js
const { AgentCore } = require('../src/core');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } }

// Make the real switchUser's timed waits instant so the suite runs in ms, not ~25s.
const REAL_SETTIMEOUT = global.setTimeout;
const instantTimers = () => { global.setTimeout = (fn) => { fn(); return 0; }; };
const realTimers = () => { global.setTimeout = REAL_SETTIMEOUT; };

function makeCore(script) {
  const core = Object.create(AgentCore.prototype);
  core.__calls = []; core.__logs = [];
  core.emit = (ev, m) => { if (ev === 'log') core.__logs.push(String(m)); };
  core._metaPayload = () => ({});
  core._adbLong = (serial, args, ms) => { core.__calls.push(args.join(' ')); return Promise.resolve(script(args.join(' ')) || ''); };
  return core;
}
const PING_OK = '64 bytes from 8.8.8.8: icmp_seq=1 ttl=52 time=20 ms\n1 packets transmitted, 1 received, 0% packet loss';

async function run() {
  instantTimers();

  // 1) Happy path — switch takes, airplane ON/OFF verify, network recovers.
  {
    let air = '0';
    const core = makeCore((cmd) => {
      if (cmd.includes('get-current-user')) return '5';
      if (cmd.includes('airplane-mode enable')) { air = '1'; return ''; }
      if (cmd.includes('airplane-mode disable')) { air = '0'; return ''; }
      if (cmd.includes('settings get global airplane_mode_on')) return air;
      if (cmd.includes('telephony.registry')) return 'mDataConnectionState=2';   // DATA_CONNECTED
      if (cmd.includes('ping')) return PING_OK;
      return '';
    });
    await core.switchUser('SER1', 5, { send: () => {} });
    const L = core.__logs.join(' | ');
    ok(/Profile switch: PASS/.test(L), 'happy: Profile switch PASS');
    ok(/Airplane ON: PASS/.test(L), 'happy: Airplane ON PASS');
    ok(/Airplane OFF: PASS/.test(L), 'happy: Airplane OFF PASS');
    ok(/Mobile network recovery: PASS \(android\)/.test(L), 'happy: network recovery PASS via Android signal');
  }

  // 1b) ICMP blocked but mobile data IS connected -> still PASS via the Android telephony signal.
  {
    const core = makeCore((cmd) => {
      if (cmd.includes('get-current-user')) return '5';
      if (cmd.includes('settings get global airplane_mode_on')) return cmd.includes('enable') ? '1' : '0';
      if (cmd.includes('telephony.registry')) return 'blah\n  mDataConnectionState = 2\n';
      if (cmd.includes('ping')) return 'connect: Network is unreachable';   // ICMP blocked
      return '';
    });
    // airplane_mode_on read returns based on last set; simplify: return '1' after enable, '0' after disable
    let air2 = '0';
    core._adbLong = (serial, args, ms) => {
      const cmd = args.join(' '); core.__calls.push(cmd);
      if (cmd.includes('airplane-mode enable')) air2 = '1';
      if (cmd.includes('airplane-mode disable')) air2 = '0';
      if (cmd.includes('settings get global airplane_mode_on')) return Promise.resolve(air2);
      if (cmd.includes('get-current-user')) return Promise.resolve('5');
      if (cmd.includes('telephony.registry')) return Promise.resolve('mDataConnectionState=2');
      if (cmd.includes('ping')) return Promise.resolve('connect: Network is unreachable');
      return Promise.resolve('');
    };
    await core.switchUser('SER1b', 5, { send: () => {} });
    ok(/Mobile network recovery: PASS \(android\)/.test(core.__logs.join(' | ')), 'icmp-blocked: PASS via Android signal despite ping failing');
  }

  // 2) Profile switch FAILED -> airplane cycle skipped, NO airplane/data commands sent.
  {
    const core = makeCore((cmd) => cmd.includes('get-current-user') ? '0' : '');   // wanted 5, got 0
    await core.switchUser('SER2', 5, { send: () => {} });
    const L = core.__logs.join(' | ');
    ok(/Profile switch: FAIL/.test(L), 'switch-fail: Profile switch FAIL');
    ok(/Airplane cycle: SKIPPED/.test(L), 'switch-fail: airplane SKIPPED');
    ok(!core.__calls.some((c) => c.includes('airplane-mode')), 'switch-fail: no airplane commands sent');
    ok(!core.__calls.some((c) => c.includes('svc data')), 'switch-fail: no data toggle sent');
  }

  // 3) Airplane never actually turns on (setting stays 0) -> Airplane ON FAIL.
  {
    const core = makeCore((cmd) => {
      if (cmd.includes('get-current-user')) return '5';
      if (cmd.includes('settings get global airplane_mode_on')) return '0';
      if (cmd.includes('ping')) return PING_OK;
      return '';
    });
    await core.switchUser('SER3', 5, { send: () => {} });
    ok(/Airplane ON: FAIL/.test(core.__logs.join(' | ')), 'airplane-on-fail: Airplane ON FAIL logged');
  }

  // 4) Network never recovers -> _waitForNetwork returns false and respects its deadline.
  {
    realTimers();  // real clock for the timeout window
    // No Android data (state != 2) AND ping fails -> no signal.
    const core = makeCore((cmd) => cmd.includes('telephony.registry') ? 'mDataConnectionState=0' : (cmd.includes('ping') ? 'unreachable' : ''));
    const t0 = Date.now();
    const res = await core._waitForNetwork('SER4', 250);
    instantTimers();
    ok(!res, 'network-fail: _waitForNetwork returns "" when neither signal confirms');
    ok(Date.now() - t0 >= 200, 'network-fail: honored the timeout window');
    // And _networkUp prefers the Android signal when present.
    const up = makeCore((cmd) => cmd.includes('telephony.registry') ? 'mDataConnectionState=2' : '');
    ok(await up._networkUp('S') === 'android', 'networkUp: Android telephony state=2 -> "android"');
    const pingOnly = makeCore((cmd) => cmd.includes('telephony.registry') ? 'mDataConnectionState=1' : (cmd.includes('ping') ? PING_OK : ''));
    ok(await pingOnly._networkUp('S') === 'ping', 'networkUp: falls back to ping when telephony not connected');
  }

  // 5) Failure isolation — adb throws for this phone; switchUser must not throw (other phones unaffected).
  {
    const core = Object.create(AgentCore.prototype);
    core.emit = () => {}; core._metaPayload = () => ({});
    core._adbLong = () => Promise.reject(new Error('adb boom'));
    core._waitForNetwork = async () => '';
    let threw = false;
    try { await core.switchUser('SER5', 5, { send: () => {} }); } catch (e) { threw = true; }
    ok(!threw, 'isolation: a throwing phone does not crash switchUser');
  }

  // ---- v0.5.10: verified airplane commands, one switch at a time, the watchdog, the verdict ----

  // 7) The OFF command times out once (a loaded USB tree) -> retried, verified, PASS. Before v0.5.10
  //    the timeout was swallowed and the phone stayed in airplane mode.
  {
    let air = '0', disables = 0;
    const core = makeCore(() => '');
    core._adbLong = (serial, args) => {
      const cmd = args.join(' '); core.__calls.push(cmd);
      if (cmd.includes('get-current-user')) return Promise.resolve('5');
      if (cmd.includes('airplane-mode enable')) { air = '1'; return Promise.resolve(''); }
      if (cmd.includes('airplane-mode disable')) {
        disables++;
        if (disables === 1) return Promise.reject(Object.assign(new Error(''), { killed: true }));   // adb killed at the deadline
        air = '0'; return Promise.resolve('');
      }
      if (cmd.includes('settings get global airplane_mode_on')) return Promise.resolve(air);
      if (cmd.includes('telephony.registry')) return Promise.resolve('mDataConnectionState=2');
      return Promise.resolve('');
    };
    core.devices = { SER7: {} };
    await core.switchUser('SER7', 5, { send: () => {} });
    const L = core.__logs.join(' | ');
    ok(disables === 2, 'off-timeout: the OFF command was sent again after the timeout (' + disables + ' sends)');
    ok(/airplane OFF attempt 1\/3 \(settings path\) did not take/.test(L), 'off-timeout: the timed-out attempt fell to the settings path and is logged');
    ok(/Airplane OFF: PASS/.test(L), 'off-timeout: Airplane OFF PASS after the retry');
    ok(core.devices.SER7.switchStatus && core.devices.SER7.switchStatus.ok === true, 'off-timeout: the verdict on the phone record is ok');
  }

  // 8) The modern command is not there (an answer with "Unknown command") -> settings path, verified.
  {
    let air = '0';
    const core = makeCore((cmd) => {
      if (cmd.includes('get-current-user')) return '5';
      if (cmd.includes('airplane-mode')) return 'Error: Unknown command: airplane-mode';
      if (cmd.includes('settings put global airplane_mode_on 1')) { air = '1'; return ''; }
      if (cmd.includes('settings put global airplane_mode_on 0')) { air = '0'; return ''; }
      if (cmd.includes('settings get global airplane_mode_on')) return air;
      if (cmd.includes('telephony.registry')) return 'mDataConnectionState=2';
      return '';
    });
    await core.switchUser('SER8', 5, { send: () => {} });
    const L = core.__logs.join(' | ');
    ok(core.__calls.some((c) => c.includes('settings put global airplane_mode_on 1')) && core.__calls.some((c) => c.includes('am broadcast')), 'fallback: settings + broadcast path used when the command is unknown');
    ok(/Airplane ON: PASS/.test(L) && /Airplane OFF: PASS/.test(L), 'fallback: both halves verified PASS');
  }

  // 9) Airplane never turns OFF (every attempt fails) -> FAIL, three attempts, a verdict in words.
  {
    let air = '0';
    const core = makeCore((cmd) => {
      if (cmd.includes('get-current-user')) return '5';
      if (cmd.includes('airplane-mode enable')) { air = '1'; return ''; }
      if (cmd.includes('settings get global airplane_mode_on')) return air;   // disable never lands
      return '';
    });
    core._waitForNetwork = async () => '';
    core.devices = { SER9: {} };
    await core.switchUser('SER9', 5, { send: () => {} });
    const L = core.__logs.join(' | ');
    const disables = core.__calls.filter((c) => c.includes('airplane-mode disable')).length;
    const settingsOff = core.__calls.filter((c) => c.includes('settings put global airplane_mode_on 0')).length;
    ok(/Airplane OFF: FAIL/.test(L), 'off-fail: Airplane OFF FAIL logged');
    ok(disables >= 2 && settingsOff >= 1, `off-fail: both paths tried (${disables} command sends, ${settingsOff} settings writes)`);
    ok(/Airplane still ON after the cycle - turning it off again/.test(L), 'off-fail: a second OFF round after the network did not come back');
    const v = core.devices.SER9.switchStatus;
    ok(v && v.ok === false && v.problem === 'airplane mode would not turn off', 'off-fail: the verdict says airplane mode would not turn off');
    ok(/Switch FAILED after \d+ s: airplane mode would not turn off/.test(L), 'off-fail: the failure is one log line in words');
  }

  // 10) One switch at a time per phone: three quick requests run as first + last, in order.
  {
    const order = [];
    let cur = '0';
    const core = makeCore(() => '');
    core._adbLong = (serial, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('switch-user')) { cur = args[args.length - 1]; order.push('switch ' + cur); }
      if (cmd.includes('get-current-user')) return Promise.resolve(cur);
      if (cmd.includes('settings get global airplane_mode_on')) return Promise.resolve(cmd.includes('x') ? '0' : '0');
      if (cmd.includes('telephony.registry')) return Promise.resolve('mDataConnectionState=2');
      return Promise.resolve('');
    };
    core._setAirplane = async (serial, on) => { order.push('air ' + (on ? 'on' : 'off') + ' @' + cur); return true; };
    const p1 = core.switchUser('SER10', 3, { send: () => {} });
    const p2 = core.switchUser('SER10', 4, { send: () => {} });
    const p3 = core.switchUser('SER10', 5, { send: () => {} });
    await Promise.all([p1, p2, p3]);
    ok(order.join(',') === 'switch 3,air on @3,air off @3,switch 5,air on @5,air off @5', 'serial: first and last run in order, the middle one is dropped (' + order.join(',') + ')');
    ok(p2 === p1 && p3 === p1, 'serial: callers that arrive during a switch wait on the same promise');
    // A repeat of a switch that just passed is a no-op.
    core.__logs.length = 0; order.length = 0;
    await core.switchUser('SER10', 5, { send: () => {} });
    ok(order.length === 0 && /already on profile 5 .* nothing to do/.test(core.__logs.join(' | ')), 'serial: repeating a switch that passed a moment ago does nothing');
    // ...but a different profile runs.
    await core.switchUser('SER10', 6, { send: () => {} });
    ok(order[0] === 'switch 6', 'serial: a different profile still switches');
  }

  // 11) The airplane watchdog: a phone found ON twice gets turned off; mid-switch phones are skipped.
  {
    const core = makeCore(() => '');
    const calls = [];
    let air = '1';
    core._adbLong = (serial, args) => {
      const cmd = args.join(' '); calls.push(serial + ': ' + cmd);
      if (cmd.includes('settings get global airplane_mode_on')) return Promise.resolve(air);
      if (cmd.includes('airplane-mode disable')) { air = '0'; return Promise.resolve(''); }
      return Promise.resolve('');
    };
    core.devices = { W1: { ws: { readyState: 1, send() {} } }, W2: { ws: { readyState: 1, send() {} } }, W3: { ws: { readyState: 3 } } };
    core._switches = { W2: { running: Promise.resolve(), next: null, last: null } };   // W2 is mid-switch
    await core._airplaneWatchdogTick();
    ok(!calls.some((c) => c.includes('disable')), 'watchdog: first look only counts (no command yet)');
    ok(!calls.some((c) => c.startsWith('W2:')) && !calls.some((c) => c.startsWith('W3:')), 'watchdog: a phone mid-switch and a disconnected phone are not even read');
    await core._airplaneWatchdogTick();
    ok(calls.some((c) => c === 'W1: shell cmd connectivity airplane-mode disable') && calls.some((c) => c === 'W1: shell svc data enable'), 'watchdog: second look turns airplane off and data on');
    ok(core.devices.W1.airplaneWatchdog && core.devices.W1.airplaneWatchdog.ok === true && core.devices.W1.airplaneWatchdog.fixes === 1, 'watchdog: the fix is recorded for the dashboard');
    ok(core.__logs.some((l) => /airplane watchdog - airplane is OFF again/.test(l)), 'watchdog: says what it did');
    calls.length = 0;
    await core._airplaneWatchdogTick();
    ok(!calls.some((c) => c.includes('disable')), 'watchdog: a phone that reads OFF is left alone');
    // Just-finished switch: hands off for 30 s.
    core._switches.W1 = { running: null, next: null, last: { id: 1, ok: true, at: Date.now() } };
    air = '1'; calls.length = 0;
    await core._airplaneWatchdogTick(); await core._airplaneWatchdogTick();
    ok(!calls.some((c) => c.startsWith('W1:')), 'watchdog: a phone that just finished a switch is left to settle');
  }

  // 12) The meta beat carries the verdict and the watchdog record.
  {
    const core = makeCore(() => '');
    core._batteryAndChargingAsync = async () => ({ battery: 50, charging: true });
    core._hostStats = () => ({});
    core._listUsersAsync = async () => [{ id: 0, name: 'Owner' }];
    core._currentUserAsync = async () => 0;
    core.devices = { M1: { switchStatus: { user: 5, ok: false, problem: 'airplane mode would not turn off' }, airplaneWatchdog: { fixes: 2 } } };
    const m = await core._metaPayloadAsync('M1', true);
    ok(m.switch_status && m.switch_status.problem === 'airplane mode would not turn off' && m.airplane_watchdog.fixes === 2, 'meta: switch_status + airplane_watchdog ride along');
    const m2 = await core._metaPayloadAsync('M1', false);
    ok(m2.switch_status && m2.switch_status.user === 5 && Array.isArray(m2.users), 'meta: also on the partial beat');
  }

  // 6) _airplaneOn parsing.
  {
    const t = (v) => { const c = makeCore(() => v); return c._airplaneOn('S'); };
    ok(await t('1') === true, 'airplaneOn("1") === true');
    ok(await t('0') === false, 'airplaneOn("0") === false');
    ok(await t('') === null, 'airplaneOn("") === null (unknown)');
  }

  realTimers();
  console.log(`\n${failed ? 'FAILED ❌' : 'PASSED ✅'}  (${passed} ok, ${failed} failed) — verified airplane/profile cycle + v0.5.10 retries, serialization, watchdog`);
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
