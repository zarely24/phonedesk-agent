'use strict';
// src/thlogin.js, driven with scripted screens and a fake driver - no phone, no adb.
// Run:  node tools/test_thlogin.js
const th = require('../src/thlogin');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const node = (o) => {
  const b = o.bounds || [0, 0, 100, 100];
  const a = [`text="${o.text || ''}"`, `content-desc="${o.desc || ''}"`, `resource-id="${o.id || ''}"`, `class="${o.cls || 'android.widget.TextView'}"`,
             `package="${o.pkg || 'com.instagram.barcelona'}"`, `clickable="${o.clickable ? 'true' : 'false'}"`, `enabled="true"`, `focused="false"`,
             `bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]"`];
  return `<node index="0" ${a.join(' ')} />`;
};
const screen = (...nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.map(node).join('')}</hierarchy>`;

// Threads' first screen on a profile signed into Instagram: the big "Continue as" offer.
const WELCOME = screen(
  { text: 'Threads', bounds: [400, 300, 680, 420] },
  { text: 'Continue as @emma.rosee', clickable: true, bounds: [140, 900, 940, 1020] },
  { text: 'Continue with another account', bounds: [140, 1100, 940, 1180] });
// several Instagram accounts in the profile's switcher: one row each
const PICKER = screen(
  { text: 'Continue as @emma.rosee', clickable: true, bounds: [140, 900, 940, 1020] },
  { text: 'Continue as @lilyy.fraser', clickable: true, bounds: [140, 1100, 940, 1220] });
// Android's own notification prompt sits on top of the app (answer: Don't allow)
const NOTIF = screen(
  { pkg: 'com.google.android.permissioncontroller', text: 'Allow Threads to send you notifications?', bounds: [100, 800, 980, 1000] },
  { pkg: 'com.google.android.permissioncontroller', text: "Don't allow", clickable: true, bounds: [100, 1050, 500, 1150] },
  { pkg: 'com.google.android.permissioncontroller', text: 'Allow', clickable: true, bounds: [580, 1050, 980, 1150] });
// Threads' own interstitials (its Not now rows are dismissed as pop-ups)
const FRIENDS = screen(
  { text: 'Get suggested accounts', bounds: [140, 500, 940, 600] },
  { text: 'Not now', clickable: true, bounds: [140, 1500, 940, 1600] });
// the feed: the bottom navigation with at least two known pieces
const FEED = screen(
  { desc: 'Home', clickable: true, bounds: [20, 2260, 200, 2390] },
  { desc: 'Search', clickable: true, bounds: [240, 2260, 420, 2390] },
  { desc: 'Profile', clickable: true, bounds: [880, 2260, 1060, 2390] });
// Threads' own login form: there is no Instagram session to continue from
const LOGIN_FORM = screen(
  { text: 'Log in', clickable: true, bounds: [140, 900, 940, 1000] },
  { text: 'Sign up', bounds: [140, 1100, 940, 1180] });
const DISABLED = screen({ text: 'Your account has been disabled', bounds: [100, 800, 980, 900] });
const UNKNOWN = screen({ text: 'A screen the walk has never seen', bounds: [100, 800, 980, 900] });
const FOREIGN = screen({ text: 'a web page', pkg: 'com.android.chrome', bounds: [0, 0, 1080, 300] });

function fakeDriver(screens) {
  const q = screens.slice(); let i = 0;
  const d = { taps: [], keys: [], typed: [],
    dump: async () => (i < q.length - 1 ? q[i++] : q[q.length - 1]),
    tap: async (x, y) => { d.taps.push([Math.round(x), Math.round(y)]); },
    type: async (t) => { d.typed.push(t); },
    key: async (k) => { d.keys.push(k); },
    wait: async () => {},
    swipe: async () => {},
    screenshot: async () => Buffer.from('png') };
  return d;
}

(async () => {
  // ---- the happy path: welcome -> notifications denied -> friends skipped -> feed ----
  {
    const d = fakeDriver([WELCOME, NOTIF, FRIENDS, FEED]);
    const r = await th.run(d, { username: 'emma.rosee' });
    check('a clean login ends logged_in', r.state, 'logged_in');
    check('the handle came off the Continue-as row', r.username, 'emma.rosee');
    check('exactly three taps: continue, the permission denial, the pop-up', d.taps.length, 3);
    check('nothing was ever typed (no password on Threads)', d.typed.length, 0);
    check('the trace names the steps', ['continue', 'permission', 'dismiss', 'feed'].every(s => r.trace.some(t => t.name === s)), true);
  }

  // ---- already logged in: the feed answers at once, nothing tapped ----
  {
    const d = fakeDriver([FEED]);
    const r = await th.run(d, { username: 'emma.rosee' });
    check('a logged-in feed is reported, not touched', (r.state, d.taps.length), ('already_logged_in', 0));
  }

  // ---- several Instagram accounts: the walk picks the target's own row ----
  {
    const d = fakeDriver([PICKER, FEED]);
    const r = await th.run(d, { username: 'lilyy.fraser' });
    check('the right row wins when several accounts exist', r.username, 'lilyy.fraser');
    check('the tap landed on the second row', (d.taps[0][1] > 1100), true);
  }

  // ---- no Instagram session: Threads shows its own login form -> reported, never typed ----
  {
    const d = fakeDriver([LOGIN_FORM]);
    const r = await th.run(d, { username: 'katie.ox' });
    check('no IG session is reported, nothing typed', (r.state, d.typed.length), ('no_ig_account', 0));
  }

  // ---- a disabled screen stops the walk as a challenge ----
  {
    const d = fakeDriver([WELCOME, DISABLED]);
    const r = await th.run(d, { username: 'emma.rosee' });
    check('a disabled screen is a challenge', (r.state, d.taps.length), ('challenge', 1));
  }

  // ---- a foreign app on top: Back brings Threads back ----
  {
    const d = fakeDriver([WELCOME, FOREIGN, FEED]);
    const r = await th.run(d, { username: 'emma.rosee' });
    check('a browser hijack is Backed out of, the login still lands', r.state, 'logged_in');
    check('one Back was pressed', d.keys, ['back']);
  }

  // ---- an unknown screen: honest failure with evidence ----
  {
    const d = fakeDriver([UNKNOWN]);
    const r = await th.run(d, { username: 'emma.rosee' });
    check('an unknown screen fails honestly', (r.state, r.step), ('failed', 'unknown_screen'));
    check('nothing was tapped on an unknown screen', d.taps.length, 0);
    check('the failure carries a screenshot', !!r.screenshot_b64, true);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall ok');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
