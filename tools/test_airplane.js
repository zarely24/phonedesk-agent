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
    let threw = false;
    try { await core.switchUser('SER5', 5, { send: () => {} }); } catch (e) { threw = true; }
    ok(!threw, 'isolation: a throwing phone does not crash switchUser');
  }

  // 6) _airplaneOn parsing.
  {
    const t = (v) => { const c = makeCore(() => v); return c._airplaneOn('S'); };
    ok(await t('1') === true, 'airplaneOn("1") === true');
    ok(await t('0') === false, 'airplaneOn("0") === false');
    ok(await t('') === null, 'airplaneOn("") === null (unknown)');
  }

  realTimers();
  console.log(`\n${failed ? 'FAILED ❌' : 'PASSED ✅'}  (${passed} ok, ${failed} failed) — verified airplane/profile cycle`);
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
