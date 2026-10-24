'use strict';
// v0.5.6 - unit test for the fleet-app ops in AgentCore: list_apps, install_apps, export_app,
// install_app, uninstall_app, update_now. Exercises the REAL methods with a scripted adb (_adbLong /
// _adbPull), a fake backend (_download / _upload) and a fake socket. No device, no network.
// Run: node tools/test_fleet_apps.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentCore } = require('../src/core');

let passed = 0, failed = 0;
function ok(cond, msg, extra) { if (cond) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } }

/** A phone: profiles + which packages each has. `apk` lists the files a package is made of. */
function makePhone({ users = [0, 10], pk = {}, failInstall = null } = {}) {
  const phone = { users, pk, failInstall, calls: [] };
  phone.script = (args) => {
    const cmd = args.join(' ');
    phone.calls.push(cmd);
    let m;
    if (/^shell pm list users$/.test(cmd)) return phone.users.map((u) => `\tUserInfo{${u}:Profile ${u}:c13} running`).join('\n');
    if ((m = /^shell pm list packages -3 --user (\d+)$/.exec(cmd))) return Object.keys(phone.pk).filter((p) => phone.pk[p].includes(+m[1])).map((p) => 'package:' + p).join('\n');
    if ((m = /^shell pm list packages --user (\d+) (\S+)$/.exec(cmd))) return Object.keys(phone.pk).filter((p) => p.includes(m[2]) && phone.pk[p].includes(+m[1])).map((p) => 'package:' + p).join('\n');
    if ((m = /^shell pm path (\S+)$/.exec(cmd))) return phone.pk[m[1]] ? [`package:/data/app/~~x/${m[1]}-1/base.apk`, `package:/data/app/~~x/${m[1]}-1/split_config.arm64_v8a.apk`].join('\n') : '';
    if ((m = /^shell dumpsys package (\S+)$/.exec(cmd))) return phone.pk[m[1]] ? `  Package [${m[1]}]\n    versionCode=1234 minSdk=26\n    versionName=9.8.7\n` : '';
    if ((m = /^shell pm install-existing --user (\d+) (\S+)$/.exec(cmd))) {
      if (!phone.pk[m[2]]) throw new Error(`Error: Package ${m[2]} doesn't exist`);
      if (!phone.pk[m[2]].includes(+m[1])) phone.pk[m[2]].push(+m[1]);
      return `Package ${m[2]} installed for user: ${m[1]}`;
    }
    if (/^install-multiple -r /.test(cmd)) {
      const pkg = /pd_fleet_([A-Za-z0-9_-]+)/.exec(cmd) ? 'com.openai.chatgpt' : 'x';
      if (phone.failInstall) return 'Performing Streamed Install\n' + phone.failInstall;
      phone.pk[pkg] = phone.users.slice(0, phone.installAllUsers === false ? 1 : phone.users.length);   // Android: all users
      return 'Performing Streamed Install\nSuccess';
    }
    if ((m = /^shell pm uninstall (\S+)$/.exec(cmd))) { if (phone.uninstallFails) return 'Failure [DELETE_FAILED_INTERNAL_ERROR]'; delete phone.pk[m[1]]; return 'Success'; }
    throw new Error('unscripted adb: ' + cmd);
  };
  return phone;
}

function makeCore(phone, { appVersion = '0.5.6' } = {}) {
  const core = Object.create(AgentCore.prototype);
  core.__logs = []; core.__events = [];
  core.listenerCount = (ev) => core.__listeners && core.__listeners[ev] ? 1 : 0;
  core.emit = (ev, m) => { if (ev === 'log') core.__logs.push(String(m)); else core.__events.push([ev, m]); if (core.__listeners && core.__listeners[ev]) core.__listeners[ev](m); };
  core.on = (ev, fn) => { (core.__listeners = core.__listeners || {})[ev] = fn; };
  core.appVersion = appVersion;
  core.backend = 'https://pd.test';
  core.adbPath = 'adb';
  core.tokenFile = path.join(os.tmpdir(), 'pd_test_tokens_none.json');
  core.devices = { S1: { token: 'devtok' } };
  core._adbLong = (serial, args) => { try { return Promise.resolve(phone.script(args)); } catch (e) { return Promise.reject(e); } };
  core._adbAsync = (args) => core._adbLong(args[1], args.slice(2));
  core.__pulled = []; core.__uploaded = []; core.__downloaded = [];
  core._adbPull = (serial, remote, local) => { core.__pulled.push(remote); fs.writeFileSync(local, 'x'.repeat(remote.endsWith('base.apk') ? 5000 : 700)); return Promise.resolve(); };
  core._upload = (url, file, headers) => { core.__uploaded.push({ url, size: fs.statSync(file).size, name: headers['X-File-Name'] }); return Promise.resolve('{"ok":true}'); };
  core._download = (url, dest) => { core.__downloaded.push(url); const m = /files\/(\d+)\?/.exec(url); fs.writeFileSync(dest, 'y'.repeat(+m[1] === 0 ? 5000 : 700)); return Promise.resolve(); };
  return core;
}
function fakeWs() { const ws = { readyState: 1, sent: [] }; ws.send = (s) => ws.sent.push(JSON.parse(s)); return ws; }
function lastReply(ws) { return ws.sent[ws.sent.length - 1]; }
const FILES = [{ idx: 0, name: 'base.apk', size: 5000 }, { idx: 1, name: 'split_config.arm64_v8a.apk', size: 700 }];
function cleanCache() { try { fs.rmSync(path.join(os.tmpdir(), 'pd_fleet_app000001'), { recursive: true, force: true }); } catch {} }

async function run() {
  // 1) list_apps: third-party apps per profile
  {
    const phone = makePhone({ users: [0, 10], pk: { 'com.instagram.android': [0, 10], 'com.openai.chatgpt': [0] } });
    const core = makeCore(phone); const ws = fakeWs();
    await core.listApps('S1', { request_id: 'r1' }, ws);
    const r = lastReply(ws);
    ok(r.ok && r.request_id === 'r1', 'list_apps answers with the request id');
    ok(JSON.stringify(r.by_user) === JSON.stringify({ 0: ['com.instagram.android', 'com.openai.chatgpt'], 10: ['com.instagram.android'] }), 'by_user lists each profile\'s third-party apps', r.by_user);
  }
  // 2) install_apps: clone into profiles, bad package filtered, missing profile reported
  {
    const phone = makePhone({ users: [0, 10], pk: { 'com.openai.chatgpt': [0] } });
    const core = makeCore(phone); const ws = fakeWs();
    await core.installApps('S1', { request_id: 'r2', user_ids: [10, 99], packages: ['com.openai.chatgpt', 'bad pkg!'] }, ws);
    const r = lastReply(ws);
    ok(r.ok, 'install_apps ok');
    ok(r.results.length === 2, 'one result per (profile x valid package)', r.results);
    ok(r.results[0].uid === 10 && r.results[0].ok === true, 'profile 10 got the app', r.results[0]);
    ok(r.results[1].uid === 99 && r.results[1].ok === false && r.results[1].error === 'PROFILE_NOT_FOUND', 'unknown profile reported, not thrown', r.results[1]);
    ok(r.by_user[10].includes('com.openai.chatgpt'), 'fresh by_user returned');
  }
  // 3) export_app: pulls every split, uploads each with the device token, reports version
  {
    const phone = makePhone({ pk: { 'com.openai.chatgpt': [0, 10] } });
    const core = makeCore(phone); const ws = fakeWs();
    await core.exportApp('S1', { request_id: 'r3', package: 'com.openai.chatgpt', app_id: 'app000001' }, ws);
    const r = lastReply(ws);
    ok(r.ok, 'export ok', r);
    ok(core.__pulled.length === 2 && core.__uploaded.length === 2, 'two APK files pulled and uploaded');
    ok(core.__uploaded[0].url === 'https://pd.test/api/fleet-apps/app000001/files/0?token=devtok', 'upload URL carries app id, index and device token', core.__uploaded[0].url);
    ok(core.__uploaded[0].name === 'base.apk' && core.__uploaded[0].size === 5000, 'file name + size go with it');
    ok(r.files.length === 2 && r.files[1].name === 'split_config.arm64_v8a.apk' && r.files[1].size === 700, 'reply manifest', r.files);
    ok(r.version_name === '9.8.7' && r.version_code === 1234, 'version from dumpsys', r);
    ok(!fs.existsSync(path.join(os.tmpdir(), 'pd_export_app000001')), 'temp export dir removed');
  }
  // 3b) export of an app the phone does not have
  {
    const core = makeCore(makePhone({ pk: {} })); const ws = fakeWs();
    await core.exportApp('S1', { request_id: 'r3b', package: 'com.openai.chatgpt', app_id: 'app000001' }, ws);
    ok(lastReply(ws).ok === false && lastReply(ws).state === 'not_installed', 'not_installed when the source phone lacks it');
  }
  // 4) install_app: download once, install-multiple, verify per profile
  {
    cleanCache();
    const phone = makePhone({ users: [0, 10, 11], pk: {} });
    const core = makeCore(phone); const ws = fakeWs();
    await core.installApp('S1', { request_id: 'r4', package: 'com.openai.chatgpt', app_id: 'app000001', files: FILES }, ws);
    const r = lastReply(ws);
    ok(r.ok && r.state === 'installed', 'installed', r);
    ok(core.__downloaded.length === 2, 'both files downloaded');
    ok(phone.calls.some((c) => /^install-multiple -r .*0_base\.apk .*1_split_config\.arm64_v8a\.apk$/.test(c)), 'adb install-multiple -r with both files, no --user', phone.calls.filter((c) => c.startsWith('install')));
    ok(JSON.stringify(r.per_user) === JSON.stringify({ 0: true, 10: true, 11: true }), 'verified on all three profiles', r.per_user);
    ok(r.version_name === '9.8.7', 'version reported');
    // a second phone on the same computer: files come from the cache, no download
    const phone2 = makePhone({ users: [0], pk: {} });
    const core2 = makeCore(phone2); const ws2 = fakeWs();
    await core2.installApp('S1', { request_id: 'r4b', package: 'com.openai.chatgpt', app_id: 'app000001', files: FILES }, ws2);
    ok(lastReply(ws2).ok && core2.__downloaded.length === 0, 'second phone reuses the downloaded set (no download)');
  }
  // 4b) install_app where Android only put it on the owner: install-existing repairs the rest
  {
    const phone = makePhone({ users: [0, 10], pk: {} }); phone.installAllUsers = false;
    const core = makeCore(phone); const ws = fakeWs();
    await core.installApp('S1', { request_id: 'r4c', package: 'com.openai.chatgpt', app_id: 'app000001', files: FILES }, ws);
    const r = lastReply(ws);
    ok(r.ok && r.state === 'installed' && phone.calls.includes('shell pm install-existing --user 10 com.openai.chatgpt'), 'missed profile repaired with install-existing', r);
  }
  // 4c) install failure is reported with adb's reason
  {
    const phone = makePhone({ users: [0], pk: {}, failInstall: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]' });
    const core = makeCore(phone); const ws = fakeWs();
    await core.installApp('S1', { request_id: 'r4d', package: 'com.openai.chatgpt', app_id: 'app000001', files: FILES }, ws);
    const r = lastReply(ws);
    ok(r.ok === false && r.state === 'failed' && /INSUFFICIENT_STORAGE/.test(r.error), 'failed + reason', r);
  }
  // 4d) bad input never touches adb
  {
    const phone = makePhone(); const core = makeCore(phone); const ws = fakeWs();
    await core.installApp('S1', { request_id: 'r4e', package: 'rm -rf', app_id: 'app000001', files: FILES }, ws);
    ok(lastReply(ws).state === 'bad_request' && phone.calls.length === 0, 'bad package rejected before adb');
  }
  // 5) uninstall
  {
    const phone = makePhone({ pk: { 'com.openai.chatgpt': [0, 10] } }); const core = makeCore(phone); const ws = fakeWs();
    await core.uninstallApp('S1', { request_id: 'r5', package: 'com.openai.chatgpt' }, ws);
    ok(lastReply(ws).ok && lastReply(ws).state === 'removed' && !phone.pk['com.openai.chatgpt'], 'uninstalled for all users');
    await core.uninstallApp('S1', { request_id: 'r5b', package: 'com.openai.chatgpt' }, ws);
    ok(lastReply(ws).ok && lastReply(ws).state === 'absent', 'already gone -> absent, still ok');
    const p3 = makePhone({ pk: { 'com.x': [0] } }); p3.uninstallFails = true; const c3 = makeCore(p3); const w3 = fakeWs();
    await c3.uninstallApp('S1', { request_id: 'r5c', package: 'com.x' }, w3);
    ok(lastReply(w3).ok === false && /DELETE_FAILED/.test(lastReply(w3).error), 'uninstall failure reported');
  }
  // 6) update_now relays to main.js and answers unsupported when nobody listens
  {
    const core = makeCore(makePhone()); const ws = fakeWs();
    core.updateNow('S1', { request_id: 'r6' }, ws);
    ok(lastReply(ws).state === 'unsupported' && lastReply(ws).version === '0.5.6', 'no listener -> unsupported (with version)');
    const core2 = makeCore(makePhone()); const ws2 = fakeWs();
    core2.on('update_now', (req) => req.reply({ ok: true, state: 'restarting', version: '0.5.6', to: '0.5.7' }));
    core2.updateNow('S1', { request_id: 'r6b' }, ws2);
    ok(lastReply(ws2).ok && lastReply(ws2).state === 'restarting' && lastReply(ws2).request_id === 'r6b', 'listener answer relayed with request id');
  }
  // 7) the queue serialises installs on one computer
  {
    cleanCache();
    const order = [];
    const core = makeCore(makePhone({ users: [0], pk: {} }));
    core._installAppNow = (serial, m) => new Promise((res) => { order.push('start ' + m.request_id); setTimeout(() => { order.push('end ' + m.request_id); res(); }, 20); });
    await Promise.all([core.installApp('S1', { request_id: 'a' }), core.installApp('S1', { request_id: 'b' })]);
    ok(order.join(',') === 'start a,end a,start b,end b', 'second install waits for the first', order);
  }
  cleanCache();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
