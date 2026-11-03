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
  const users = [{ id: 0, name: 'Owner' }, { id: 10, name: 'Profile 1' }, { id: 11, name: 'Work' }];
  let nextId = 12;
  core.users = users;
  core.calls = [];
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
    if (sh[0] === 'pm' && sh[1] === 'install-existing') return Promise.resolve(`Package ${sh[4]} installed for user: ${sh[3]}`);
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

  console.log(fail ? `\n${fail} FAILING` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
