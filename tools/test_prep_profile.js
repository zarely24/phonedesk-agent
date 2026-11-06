// v0.5.13: a new profile never stops on the setup wizard's "Set a PIN" step.
// _prepProfile on a fake phone (no adb):   node tools/test_prep_profile.js
const path = require('path');
const { AgentCore } = require(path.join(process.cwd(), 'src', 'core.js'));

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};
// enabled: packages enabled per user; pin: users that have a PIN set
function makeCore({ enabled = {}, pin = [] } = {}) {
  const core = Object.create(AgentCore.prototype);
  core.devices = { SER1: {} };
  core.emit = () => {};
  core.calls = [];
  core.settings = {};
  core._adbLong = (serial, args) => {
    const sh = args.slice(1); const cmd = sh.join(' ');
    core.calls.push(cmd);
    if (sh[0] === 'settings' && sh[1] === 'put') { core.settings[sh[3] + ':' + sh[5]] = sh[6]; return Promise.resolve(''); }
    if (cmd.startsWith('pm list packages -e --user ')) return Promise.resolve((enabled[sh[5]] || []).map((p) => 'package:' + p).join('\n'));
    if (sh[0] === 'pm' && sh[1] === 'disable-user') {
      enabled[sh[3]] = (enabled[sh[3]] || []).filter((p) => p !== sh[4]);
      return Promise.resolve(`Package ${sh[4]} new state: disabled-user`);
    }
    if (sh[0] === 'locksettings') {
      if (pin.includes(sh[3])) return Promise.reject(Object.assign(new Error("Old password '' didn't match"), { killed: false }));
      return Promise.resolve('Lock screen disabled set to true');
    }
    return Promise.resolve('');
  };
  return core;
}
const logs = [];
const log = (x) => logs.push(x);

(async () => {
  {
    const core = makeCore({ enabled: { 12: ['com.google.android.setupwizard', 'com.google.android.setupwizard.ext', 'com.instagram.android'] } });
    const r = await core._prepProfile('SER1', 12, log);
    check('new profile: only the setup wizard is disabled (exact name, not .ext)', r.wizard_off, ['com.google.android.setupwizard']);
    check('new profile: lock screen set to none', r.lock, 'none');
    check('setup marked complete for THAT user', [core.settings['12:user_setup_complete'], core.settings['12:tv_user_setup_complete']], ['1', '1']);
    check('every command targets user 12', core.calls.filter((c) => /disable-user|locksettings|settings put/.test(c)).every((c) => / --user 12 /.test(c + ' ')), true);
    const n = core.calls.length;
    await core._prepProfile('SER1', 12, log);
    check('second time on the same profile: no adb at all', core.calls.length, n);
  }
  {
    const core = makeCore({ enabled: { 0: ['com.google.android.setupwizard'] } });
    const r = await core._prepProfile('SER1', 0, log);
    check('the owner (uid 0) is never touched', [r, core.calls.length], [{ wizard_off: [], lock: '?' }, 0]);
  }
  {
    const core = makeCore({ enabled: { 13: ['com.instagram.android'] }, pin: ['13'] });
    logs.length = 0;
    const r = await core._prepProfile('SER1', 13, log);
    check('wizard already off + a real PIN set: nothing disabled, PIN left alone, said in the log',
      [r.wizard_off, r.lock, logs.some((l) => /PIN is set/.test(l))], [[], 'pin set', true]);
  }
  {
    const core = makeCore({ enabled: { 14: ['com.android.provision', 'com.sec.android.app.SecSetupWizard'] } });
    const r = await core._prepProfile('SER1', 14, log);
    check('AOSP + Samsung wizards too', r.wizard_off, ['com.android.provision', 'com.sec.android.app.SecSetupWizard']);
  }
  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
