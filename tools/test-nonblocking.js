// Proves the recurring pollers never touch the BLOCKING adb helper. That is the whole fix: this
// process is the video relay, so one execFileSync on a timer freezes every phone's stream.
const path = require('path');
const { AgentCore } = require(path.join(process.cwd(), 'src', 'core.js'));

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

function makeCore() {
  const core = Object.create(AgentCore.prototype);   // skip the constructor's side effects
  core.devices = { SER1: {} };
  core.adbPath = 'adb';
  core._loadTokens = () => ({});
  core.emit = () => {};
  core.blocking = 0;
  core._adb = () => { core.blocking++; throw new Error('BLOCKING adb used on a recurring path'); };
  core.asyncCalls = [];
  core._adbAsync = (args) => {
    const cmd = args.join(' ');   // full argv: ['devices'] or ['-s', serial, 'shell', ...]
    core.asyncCalls.push(cmd);
    if (cmd === 'devices') return Promise.resolve('List of devices attached\nSER1\tdevice\nSER2\tunauthorized');
    if (cmd.includes('dumpsys battery')) return Promise.resolve('  level: 77\n  status: 2\n  AC powered: true');
    if (cmd.includes('pm list users')) return Promise.resolve('Users:\n\tUserInfo{0:Owner:13} running\n\tUserInfo{11:Work:10} running');
    if (cmd.includes('get-current-user')) return Promise.resolve('11');
    return Promise.resolve('');
  };
  return core;
}

(async () => {
  const core = makeCore();

  // the heartbeat payload - the call that ran every 10s per phone
  const meta = await core._metaPayloadAsync('SER1', true);
  check('heartbeat used ZERO blocking adb calls', core.blocking, 0);
  check('battery parsed', meta.battery, 77);
  check('charging parsed', meta.charging, true);
  check('profiles parsed', meta.users, [{ id: 0, name: 'Owner' }, { id: 11, name: 'Work' }]);
  check('current profile parsed', meta.current_user, 11);

  // a partial beat must reuse the cache rather than re-listing profiles
  core.asyncCalls.length = 0;
  await core._metaPayloadAsync('SER1', false);
  check('partial beat only reads battery', core.asyncCalls.length, 1);
  check('  ...and it is the battery call', core.asyncCalls[0].includes('dumpsys battery'), true);

  // the 2s device scan
  const c2 = makeCore();
  await c2._refreshDevices();
  check('device scan used ZERO blocking calls', c2.blocking, 0);
  check('device scan parsed both phones', c2.detectAll(),
        [{ serial: 'SER1', state: 'ready' }, { serial: 'SER2', state: 'unauthorized' }]);
  check('detectAll now reads the cache, no extra adb', c2.asyncCalls.length, 1);

  // a failing phone must not reject and kill the heartbeat
  const c3 = makeCore();
  c3._adbAsync = () => Promise.reject(new Error('device offline'));
  const m3 = await c3._metaPayloadAsync('SER1', true);
  check('an unreachable phone degrades quietly', [m3.battery, m3.users, m3.current_user], [null, [], null]);

  console.log(fail ? `\n${fail} FAILING` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
