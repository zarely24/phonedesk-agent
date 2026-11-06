// Bulk profile creation (v0.5.11): async only, stops at the phone's own limit, never repeats a name,
// never touches an existing profile, clones several apps, and reports a result the server shows.
//   node tools/test-create-profiles.js
const path = require('path');
const { AgentCore } = require(path.join(process.cwd(), 'src', 'core.js'));

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

// A fake phone: Owner + "Profile 1" + "Work"; Android allows MAX users in total.
function makeCore(MAX) {
  const core = Object.create(AgentCore.prototype);
  core.devices = { SER1: {} };
  core.adbPath = 'adb';
  core._loadTokens = () => ({});
  core.emit = () => {};
  core.blocking = 0;
  core._adb = () => { core.blocking++; throw new Error('BLOCKING adb used'); };
  core._sendMeta = () => {};
  core._adbLong = (serial, args, ms) => core._adbAsync(['-s', serial, ...args], ms);   // v0.5.13 _prepProfile
  const users = [{ id: 0, name: 'Owner' }, { id: 10, name: 'Profile 1' }, { id: 11, name: 'Work' }];
  let nextId = 12;
  core.users = users;
  core.calls = [];
  core.installed = {};
  core._adbAsync = (args) => {
    const sh = args.slice(3);                 // after -s SER1 shell
    const cmd = sh.join(' ');
    core.calls.push(cmd);
    if (cmd === 'pm get-max-users') return Promise.resolve(`Maximum supported users: ${MAX}`);
    if (cmd === 'pm get-max-running-users') return Promise.resolve('Maximum supported running users: 4');
    if (cmd === 'pm list users') return Promise.resolve('Users:\n' + users.map((u) => `\tUserInfo{${u.id}:${u.name}:410}`).join('\n'));
    if (sh[0] === 'pm' && sh[1] === 'create-user') {
      if (users.length >= MAX) return Promise.resolve('Error: couldn\'t create User.');
      const id = nextId++;
      users.push({ id, name: sh[2].replace(/^'|'$/g, '') });
      return Promise.resolve(`Success: created user id ${id}`);
    }
    if (sh[0] === 'pm' && sh[1] === 'install-existing') { (core.installed[sh[3]] = core.installed[sh[3]] || []).push(sh[4]); return Promise.resolve(`Package ${sh[4]} installed for user: ${sh[3]}`); }
    if (sh[0] === 'pm' && sh[1] === 'list' && sh[2] === 'packages' && sh[3] === '-U') {
      const uid = parseInt(sh[5], 10);
      return Promise.resolve((core.installed[sh[5]] || []).map((p, k) => `package:${p} uid:${uid * 100000 + 10100 + k}`).join('\n'));
    }
    if (cmd === 'dumpsys user') return Promise.resolve(users.map((u) => `  UserInfo{${u.id}:${u.name}:410} serialNo=${u.id + 7} creationTime=1`).join('\n'));
    return Promise.resolve('');
  };
  return core;
}

(async () => {
  // ---- plenty of room: 3 profiles, two apps each --------------------------------------------------
  let core = makeCore(32);
  const sent = [];
  const ws = { readyState: 1, send: (x) => sent.push(JSON.parse(x)) };
  await core.createProfiles('SER1', 3, 'com.instagram.android', 'Profile', ws, ['com.zhiliaoapp.musically', 'not a package!']);
  const job = core.devices.SER1.profilesJob;
  check('no blocking adb at all', core.blocking, 0);
  check('three created, numbered after the existing profiles like before', job.created.map((c) => c.name), ['Profile 3', 'Profile 4', 'Profile 5']);
  check('names continue after the highest number in use, no repeat', job.created.map((c) => c.id), [12, 13, 14]);
  check('the bad package name is dropped, both real apps cloned', job.created[0].apps, ['com.zhiliaoapp.musically', 'com.instagram.android']);
  check('setup marked complete in each', job.created.every((c) => c.setup), true);
  check('each new profile is stopped again afterwards', core.calls.filter((c) => c.startsWith('am stop-user')).length, 3);
  check('existing profiles untouched (no remove-user, no settings on 10/11)',
        core.calls.some((c) => /remove-user|--user 10 |--user 11 /.test(c + ' ')), false);
  check('done, nothing stopped it', [job.state, job.stopped], ['done', '']);
  check('results were reported while running and at the end', [sent[0].op, sent.length >= 4, sent[sent.length - 1].data.state], ['create_profiles_result', true, 'done']);
  check('the limit rides along', job.max_users, 32);

  // ---- the phone's limit: 6 in total, it has 3 -> only 3 more, then a clear reason ------------------
  core = makeCore(6);
  await core.createProfiles('SER1', 10, '', 'Profile', null);
  const j2 = core.devices.SER1.profilesJob;
  check('stops at the phone limit (owner included)', [j2.created.length, core.users.length], [3, 6]);
  check('...and says why', /limit is 6 profiles including the owner/.test(j2.stopped), true);
  check('no create-user call beyond the limit', core.calls.filter((c) => c.startsWith('pm create-user')).length, 3);

  // ---- meta carries the limits ----------------------------------------------------------------------
  core = makeCore(32);
  core._batteryAndChargingAsync = async () => ({ battery: 80, charging: false });
  core._hostStats = () => ({});
  const meta = await core._metaPayloadAsync('SER1', true);
  check('meta: max users + max running users', [meta.max_users, meta.max_running_users], [32, 4]);
  await core._metaPayloadAsync('SER1', true);
  check('the limit is read once per phone, then cached', core.calls.filter((c) => c === 'pm get-max-users').length, 1);

  {
    const c2 = makeCore(32);
    await c2.createProfiles('SER1', 1, 'com.instagram.android', 'Profile', null);
    check('identity: the new profile carries its serial (id + serial)', c2.devices.SER1.profilesJob.created[0].serial, 12 + 7);
  }

  // ---- profile_status: the parsers --------------------------------------------------------------
  const L = AgentCore._parseUserList('Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Profile 1:410}\n\tUserInfo{11:Guest:414}\n\tUserInfo{12:Temp:510}');
  check('user list: ids, names, running', L.map((u) => [u.id, u.name, u.running_flag]), [[0, 'Owner', true], [10, 'Profile 1', false], [11, 'Guest', false], [12, 'Temp', false]]);
  check('types from the flags', L.map((u) => AgentCore._userType(u.flags)), ['owner', 'full', 'guest', 'ephemeral']);
  const D = AgentCore._parseDumpsysUser('Users:\n  UserInfo{0:Owner:c13} serialNo=0 isPrimary=true\n    State: RUNNING_UNLOCKED\n    Created: <unknown>\n  UserInfo{10:Profile 1:410} serialNo=14\n    State: -1\n    Created: +2d1h ago');
  check('dumpsys user: serial + state per user', [D[0].serial, D[0].state, D[10].serial, D[10].created], [0, 'RUNNING_UNLOCKED', 14, '+2d1h ago']);
  const P = AgentCore._parsePackagesU('package:com.instagram.android uid:1010234\npackage:com.android.vending uid:10045', 10, ['com.instagram.android', 'com.android.vending', 'com.whatsapp']);
  check('packages: installed and the uid belongs to this profile', P['com.instagram.android'], { installed: true, uid: 1010234, owned: true });
  check('...a uid from another user is flagged', P['com.android.vending'].owned, false);
  check('...missing is missing', P['com.whatsapp'].installed, false);

  // ---- profile_status: the RPC end to end, read-only ------------------------------------------------
  {
    const c3 = makeCore(32);
    c3.installed['10'] = ['com.instagram.android'];
    const base = c3._adbAsync;
    c3._adbAsync = (args) => {
      const cmd = args.slice(3).join(' ');
      c3.calls.push(cmd);
      if (cmd === 'am get-current-user') return Promise.resolve('10');
      if (cmd.startsWith('settings get --user')) return Promise.resolve(args[6] === '11' ? 'null' : '1');
      if (cmd.startsWith('pm list packages -3')) return Promise.resolve('package:com.instagram.android');
      return base(args);
    };
    c3._adbLong = (ser, args) => c3._adbAsync(['-s', ser, ...args]);
    const replies = [];
    await c3.profileStatus('SER1', { request_id: 'r1' }, { readyState: 1, send: (x) => replies.push(JSON.parse(x)) });
    const r = replies[0];
    check('rpc answered with every profile', [r.op, r.ok, r.profiles.map((x) => x.id)], ['rpc_result', true, [0, 10, 11]]);
    const p10 = r.profiles.find((x) => x.id === 10), p11 = r.profiles.find((x) => x.id === 11);
    check('profile 10: current, serial, setup, Instagram owned', [p10.current, p10.serial, p10.setup_complete, p10.apps['com.instagram.android'].owned], [true, 17, true, true]);
    check('profile 11: setup not complete is reported as a problem', p11.problems.some((x) => /setup not marked complete/.test(x)), true);
    check('the check changes nothing on the phone',
          c3.calls.some((x) => /create-user|install-existing|settings put|switch-user|remove-user|stop-user|start-user/.test(x)), false);
    check('the limit rides along', [r.max_users, r.count], [32, 3]);
  }

  console.log(fail ? '\n' + fail + ' FAILING' : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
