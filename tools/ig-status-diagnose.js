'use strict';
/*
 * PhoneDesk — Instagram status DIAGNOSTIC (Phase 1). READ-ONLY, ONE phone, ONE profile.
 *
 * Runs on the OWNER'S computer (where the phones + adb live). It answers the Phase-1 questions
 * WITHOUT changing account state and WITHOUT switching Android users:
 *   Goal 1  does `am start --user <uid>` + uiautomator actually expose the TARGET user's Instagram,
 *           or does UIAutomator still see the FOREGROUND user? (=> is `am switch-user` required?)
 *   Goal 2  capture + sanitize real UIAutomator XML of whatever Instagram screen is naturally shown.
 *   Goal 3  find a deterministic route to Account Status (deep link? resource-id taps?) — report
 *           observed resource-ids / content-descs (does NOT tap through / change anything).
 *   Goal 4  feed the captured XML through the real classifier and report what it decides.
 *
 * SAFETY — this script will NOT: switch Android users, post/like/follow/message, change credentials,
 * log out, trigger challenges, or enable monitoring. It only reads UI + launches Instagram to look at
 * it, and presses Home at the end. It REQUIRES you to confirm the phone is free.
 *
 *   node tools/ig-status-diagnose.js --serial <ADB_SERIAL> --uid <TARGET_UID> --confirm-free [--username <handle_to_redact>]
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const instagram = require('../src/instagram');

const IG = 'com.instagram.android';
function argv(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const SERIAL = argv('--serial');
const UID = argv('--uid');
const USERNAME = argv('--username') || '';
const CONFIRM = process.argv.includes('--confirm-free');

function adbPath() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const p = os.platform();
  const bundled = path.join(__dirname, '..', 'resources', 'adb', p === 'win32' ? 'win/adb.exe' : (p === 'darwin' ? 'mac/adb' : 'linux/adb'));
  return fs.existsSync(bundled) ? bundled : 'adb';
}
const ADB = adbPath();
const sh = (args, ms) => new Promise((resolve) => {
  execFile(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: ms || 15000, maxBuffer: 16 * 1024 * 1024 },
    (err, out) => resolve(String(out || '').trim()));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const section = (t) => log('\n==== ' + t + ' ' + '='.repeat(Math.max(0, 60 - t.length)));

// ---- sanitizer: strip PII from a dump BEFORE it is ever written to disk ----------------------
function sanitize(xml) {
  let out = xml;
  const redactAttr = (val) => {
    let v = val;
    v = v.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '[EMAIL]');           // emails
    v = v.replace(/(\+?\d[\d ()\-]{7,}\d)/g, '[PHONE]');                                       // phone-ish
    v = v.replace(/@[A-Za-z0-9._]{2,}/g, '[HANDLE]');                                          // @handles
    if (USERNAME) v = v.split(USERNAME).join('[USERNAME]');
    // Long free text is likely a message/caption/bio -> redact the body, keep it short.
    if (v.length > 60) v = '[LONG_TEXT_REDACTED]';
    return v;
  };
  out = out.replace(/(text|content-desc)="([^"]*)"/g, (m, attr, val) => `${attr}="${redactAttr(val)}"`);
  return out;
}

async function connected() {
  const out = await new Promise((res) => execFile(ADB, ['devices'], { encoding: 'utf8', timeout: 8000 }, (e, o) => res(o || '')));
  return new RegExp('^' + SERIAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+device', 'm').test(out);
}
async function userExists(uid) { return new RegExp('UserInfo\\{' + uid + ':').test(await sh(['shell', 'pm', 'list', 'users'], 8000)); }
async function igInstalled(uid) {
  return (await sh(['shell', 'pm', 'list', 'packages', '--user', String(uid), IG], 10000)).split('\n').some((l) => l.trim() === 'package:' + IG);
}
async function scrcpyRunning() {   // a live PhoneDesk stream keeps scrcpy-server on the phone
  const out = await sh(['shell', 'ps', '-A'], 8000);
  return /scrcpy|app_process.*Server/i.test(out);
}
async function resolveLauncher(uid) {
  const out = await sh(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '--user', String(uid), IG], 8000);
  const line = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
  return line.includes('/') ? line : null;
}
async function uiDump() {
  await sh(['shell', 'uiautomator', 'dump', '/sdcard/pd_diag_ui.xml'], 20000);
  const xml = await sh(['shell', 'cat', '/sdcard/pd_diag_ui.xml'], 10000);
  await sh(['shell', 'rm', '-f', '/sdcard/pd_diag_ui.xml'], 5000);
  return xml;
}
// Parse the resumed activity: which package + which android user is actually foreground.
async function foregroundActivity() {
  let out = await sh(['shell', 'dumpsys', 'activity', 'activities'], 10000);
  let m = out.match(/(?:mResumedActivity|topResumedActivity)[^\n]*\bu(\d+)\s+([A-Za-z0-9_.]+)\//);
  if (!m) { out = await sh(['shell', 'dumpsys', 'window'], 10000); m = out.match(/mCurrentFocus[^\n]*\bu(\d+)\s+([A-Za-z0-9_.]+)\//); }
  return m ? { uid: parseInt(m[1], 10), pkg: m[2] } : null;
}
// Report candidate Account-Status navigation anchors we can SEE (no taps performed).
function navCandidates(xml) {
  const ids = [...xml.matchAll(/resource-id="([^"]*)"/g)].map((m) => m[1]);
  const descs = [...xml.matchAll(/content-desc="([^"]*)"/g)].map((m) => m[1]);
  const interesting = (s) => /account.?status|menu|settings|options|hamburger|profile|more|supervision/i.test(s);
  return {
    resourceIds: [...new Set(ids.filter(interesting))].slice(0, 20),
    contentDescs: [...new Set(descs.filter(interesting))].slice(0, 20),
    mentionsAccountStatus: /account status/i.test(xml),
  };
}

const CAP_DIR = path.join(__dirname, 'fixtures', 'instagram', 'captured');

async function main() {
  section('PhoneDesk Instagram diagnostic (READ-ONLY, one phone)');
  if (!SERIAL || !UID) { log('Usage: node tools/ig-status-diagnose.js --serial <SERIAL> --uid <UID> --confirm-free [--username <handle>]'); process.exit(2); }
  if (!CONFIRM) {
    log('REFUSING: pass --confirm-free ONLY after you have verified in PhoneDesk that NO VA has an');
    log('active stream/control session on this phone. This phone must be the one you identified as free.');
    process.exit(2);
  }
  log(`adb: ${ADB}`);
  log(`serial: ${SERIAL}   target uid: ${UID}   redacting username: ${USERNAME || '(none given)'}`);

  if (!(await connected())) { log('ABORT: device not connected/authorized in adb.'); process.exit(1); }
  if (await scrcpyRunning()) {
    log('ABORT: a scrcpy/stream process is running on this phone — it looks IN USE. Leaving it alone.');
    process.exit(1);
  }
  if (!(await userExists(UID))) { log(`ABORT: android user ${UID} not found on this phone.`); process.exit(1); }
  if (!(await igInstalled(UID))) { log(`ABORT: Instagram not installed for user ${UID}.`); process.exit(1); }

  const findings = { serial: SERIAL, targetUid: Number(UID), when: new Date().toISOString() };

  // ---- GOAL 1: multi-user foreground behavior ------------------------------------------------
  section('GOAL 1 — Android multi-user foreground behavior');
  const currentUser = (await sh(['shell', 'am', 'get-current-user'], 6000)).trim();
  findings.foregroundUserBefore = currentUser;
  log(`am get-current-user (foreground): ${currentUser}`);
  const comp = await resolveLauncher(UID);
  log(`Instagram launcher for uid ${UID}: ${comp || '(unresolved)'}`);
  if (comp) { await sh(['shell', 'am', 'start', '--user', String(UID), '-n', comp], 10000); await wait(3500); }
  const fg = await foregroundActivity();
  findings.foregroundActivityAfterStart = fg;
  log(`foreground after start: ${fg ? `u${fg.uid} ${fg.pkg}` : '(could not read)'}`);
  const targetForegrounded = !!(fg && fg.pkg === IG && fg.uid === Number(UID));
  findings.targetInstagramForegrounded = targetForegrounded;
  findings.switchUserRequired = !targetForegrounded;
  log(`\n>>> Instagram for TARGET uid ${UID} is foreground: ${targetForegrounded ? 'YES' : 'NO'}`);
  log(`>>> CONCLUSION: am switch-user ${targetForegrounded ? 'NOT required (am start --user reached the target)' : 'IS REQUIRED (UIAutomator would see the foreground user, not the target)'}`);

  // ---- GOAL 2: capture + sanitize the natural screen -----------------------------------------
  section('GOAL 2 — capture + sanitize UI');
  fs.mkdirSync(CAP_DIR, { recursive: true });
  const rawScreen = await uiDump();
  const cleanScreen = sanitize(rawScreen);
  const f1 = path.join(CAP_DIR, `capture_screen_${Date.now()}.xml`);
  fs.writeFileSync(f1, cleanScreen);
  log(`captured (sanitized) current screen -> ${f1}  (${cleanScreen.length} bytes)`);

  // ---- GOAL 3: Account Status navigation -----------------------------------------------------
  section('GOAL 3 — Account Status navigation');
  const navFromScreen = navCandidates(cleanScreen);
  log(`current screen mentions "Account Status": ${navFromScreen.mentionsAccountStatus}`);
  log(`candidate nav resource-ids: ${JSON.stringify(navFromScreen.resourceIds)}`);
  log(`candidate nav content-descs: ${JSON.stringify(navFromScreen.contentDescs)}`);
  // Try the (undocumented) deep link — observe only.
  await sh(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'instagram://account_status', '--user', String(UID)], 8000);
  await wait(3000);
  const rawDeep = await uiDump();
  const cleanDeep = sanitize(rawDeep);
  const deepWorked = /account status/i.test(cleanDeep);
  findings.deepLinkReachedAccountStatus = deepWorked;
  const f2 = path.join(CAP_DIR, `capture_after_deeplink_${Date.now()}.xml`);
  fs.writeFileSync(f2, cleanDeep);
  log(`instagram://account_status deep link reached an Account Status screen: ${deepWorked}`);
  log(`captured (sanitized) post-deeplink screen -> ${f2}`);

  // ---- GOAL 4: classifier on the real (sanitized) XML ----------------------------------------
  section('GOAL 4 — classifier on real UI');
  for (const [name, xml] of [['current screen', cleanScreen], ['after deep link', cleanDeep]]) {
    const r = instagram.classify(xml);
    log(`${name.padEnd(16)} -> ${r.status}  conf=${r.confidence}  loggedInHome=${!!r.loggedInHome}  evidence=${JSON.stringify(r.evidence)}`);
  }

  // ---- restore: leave the phone on Home, unchanged profile -----------------------------------
  section('RESTORE');
  await sh(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], 6000);
  const after = (await sh(['shell', 'am', 'get-current-user'], 6000)).trim();
  findings.foregroundUserAfter = after;
  findings.restoredOk = after === currentUser;   // we never switched users, so this should hold
  log(`android user before: ${currentUser}   after: ${after}   (unchanged: ${findings.restoredOk})`);
  log('pressed Home. No profile switch, no account actions were performed.');

  section('SUMMARY (paste this back)');
  log(JSON.stringify(findings, null, 2));
  log('\nReview the captured *.xml under tools/fixtures/instagram/captured/ for any leftover PII before');
  log('committing them as fixtures (add to expected.json with the status you observed).');
}

main().catch((e) => { console.error('diagnostic error:', e && e.message || e); process.exit(1); });
