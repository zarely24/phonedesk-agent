'use strict';
// src/igengage.js, driven with scripted screens and a fake driver - no phone, no adb.
// Run:  node tools/test_igengage.js
const eg = require('../src/igengage');
const ig = require('../src/igpost');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const node = (o) => {
  const b = o.bounds || [0, 0, 100, 100];
  const a = [`text="${o.text || ''}"`, `content-desc="${o.desc || ''}"`, `resource-id="${o.id || ''}"`, `class="${o.cls || 'android.widget.TextView'}"`,
             `package="${o.pkg || 'com.instagram.android'}"`, `clickable="${o.clickable ? 'true' : 'false'}"`, `enabled="true"`, `focused="false"`,
             `bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]"`];
  return `<node index="0" ${a.join(' ')} />`;
};
const screen = (...nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.map(node).join('')}</hierarchy>`;

// The target's profile (the action-bar title is the username; the Follow button and the grid).
const profileScreen = (handle, opts = {}) => screen(
  { id: 'com.instagram.android:id/action_bar_title', text: handle, bounds: [200, 100, 800, 180] },
  ...(opts.followBtn === false ? [] : [{ text: opts.following ? 'Following' : 'Follow', clickable: true, bounds: [700, 200, 900, 280] }]),
  ...(opts.grid === false ? [] : [
    { id: 'com.instagram.android:id/cell_0', desc: 'Photo thumbnail', clickable: true, bounds: [10, 700, 350, 1040] },
    { id: 'com.instagram.android:id/cell_1', desc: 'Video thumbnail', clickable: true, bounds: [370, 700, 710, 1040] },
    { id: 'com.instagram.android:id/cell_2', desc: 'Photo thumbnail', clickable: true, bounds: [730, 700, 1070, 1040] },
  ]),
  { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] });
const POST_OPEN = (liked) => screen(
  { desc: liked ? 'Unlike' : 'Like', clickable: true, bounds: [40, 1300, 160, 1420] },
  { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] });
const LOGIN = screen({ text: 'Phone number, username or email', bounds: [40, 900, 1040, 1000] }, { text: 'Log in', clickable: true, bounds: [40, 1100, 1040, 1200] });
const OTHER_APP = screen({ text: 'a page', pkg: 'com.android.chrome', bounds: [0, 0, 1080, 300] });

// A fake phone: each dump shows the next screen in the list (the last repeats); taps/keys advance
// nothing by themselves - the screens say what comes next. Records everything, like test_igpost's.
function fakeDriver(screens, opts = {}) {
  const q = screens.slice(); let i = 0;
  const d = { taps: [], keys: [],
    dump: async () => (i < q.length - 1 ? q[i++] : q[q.length - 1]),
    tap: async (x, y) => { d.taps.push([x, y]); },
    key: async (k) => { d.keys.push(k); },
    wait: async () => {},
    screenshot: async () => Buffer.from('png'),
    primaryButton: opts.primaryButton };
  return d;
}

(async () => {
  // ---- the happy path: follow + like one post ----
  {
    // profile, (tap Follow) profile-with-Following, grid, post open, (tap Like) post open, profile back
    const d = fakeDriver([
      profileScreen('usa.target'), profileScreen('usa.target', { following: true }),
      profileScreen('usa.target'), POST_OPEN(false), POST_OPEN(true), profileScreen('usa.target', { following: true }),
    ]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 1 });
    check('a clean visit ends "visited"', r.state, 'visited');
    check('the follow was confirmed', (r.followed, r.liked), (true, 1));
    check('follow + open-post + like taps happened', d.taps.length, 3);
    check('back out of the post', d.keys, ['back']);
    check('the trace says what happened', [r.trace[0].name, r.trace[1].name], ['profile', 'follow']);
  }

  // ---- already following: the ledger missed one, the screen wins ----
  {
    const d = fakeDriver([profileScreen('usa.target', { following: true })]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 0 });
    check('"Following" on arrival: no tap, said so', (r.state, r.already_following, d.taps.length), ('visited', true, 0));
    check('a "Requested" state is reported as such', (await eg.run(fakeDriver([profileScreen('usa.target', { following: true })]), 'x.y', { follow: true, like_posts: 0 })).requested, false);
  }

  // ---- follow: false -> the follow step is skipped entirely ----
  {
    const d = fakeDriver([profileScreen('usa.target')]);
    const r = await eg.run(d, 'usa.target', { follow: false, like_posts: 0 });
    check('follow off: nothing tapped', (r.state, d.taps.length), ('visited', 0));
  }

  // ---- no follow button (private / blocked): the visit still succeeds ----
  {
    const d = fakeDriver([profileScreen('usa.target', { followBtn: false })]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 0 });
    check('no Follow button: visited, not followed', (r.state, r.followed, r.trace.some((t) => /no Follow button/.test(t.matched))), ('visited', false, true));
  }

  // ---- the like skips an already-liked post ----
  {
    // cell 1 opens an already-liked post (Unlike) -> no like tap, straight back
    const d = fakeDriver([
      profileScreen('usa.target', { following: true }), profileScreen('usa.target', { following: true }),
      profileScreen('usa.target', { following: true }), POST_OPEN(true), profileScreen('usa.target', { following: true }),
    ]);
    const r = await eg.run(d, 'usa.target', { follow: false, like_posts: 1 });
    check('an already-liked post is left alone', (r.liked, d.taps.length, d.keys[0]), (0, 1, 'back'));
  }

  // ---- no grid recognised: liked 0, visit still good ----
  {
    const d = fakeDriver([profileScreen('usa.target', { grid: false, following: true })]);
    const r = await eg.run(d, 'usa.target', { follow: false, like_posts: 1 });
    check('no grid: liked 0, still visited', (r.state, r.liked), ('visited', 0));
  }

  // ---- a login wall is "blocked", never tapped ----
  {
    const d = fakeDriver([LOGIN]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 1 });
    check('a login wall blocks the visit', (r.state, r.why), ('blocked', 'login_required'));
    check('nothing was tapped on a wall', d.taps.length, 0);
  }

  // ---- the link opened the browser instead (Instagram never seen): not_loaded, with the hint ----
  {
    const d = fakeDriver([OTHER_APP, OTHER_APP]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 0 });
    check('a page that never opened Instagram is not_loaded, saying what was in front',
      (r.state, /com\.android\.chrome was in front/.test(r.why)), ('not_loaded', true));
    check('nothing was tapped on a screen that is not the target', d.taps.length, 0);
  }

  // ---- a different profile loaded: never tapped ----
  {
    const d = fakeDriver([profileScreen('someone.else')]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 1 });
    check('the wrong profile is not touched', (r.state, d.taps.length), ('not_loaded', 0));
    check('...and the reply says whose profile it was', /someone\.else/.test(r.why), true);
  }

  // ---- a viewer opening the phone stops it ----
  {
    let gone = false;
    const d = fakeDriver([profileScreen('usa.target')]);
    const r = await eg.run(d, 'usa.target', { follow: true, like_posts: 1, abort: async () => true });
    check('abort wins before anything happens', (r.state, d.taps.length), ('aborted', 0));
  }

  // ---- the grid fallback: squares when the build names nothing ----
  {
    const squares = screen(
      { id: 'com.instagram.android:id/action_bar_title', text: 'usa.target', bounds: [200, 100, 800, 180] },
      { cls: 'android.widget.ViewGroup', clickable: true, bounds: [10, 700, 350, 1040] },
      { cls: 'android.widget.ViewGroup', clickable: true, bounds: [370, 700, 710, 1040] },
      { cls: 'android.view.View', clickable: true, bounds: [900, 900, 1000, 1000] },   // not square-enough noise
      { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] });
    const cells = eg.gridCells(ig.parseDump(squares));
    check('unnamed squares are still found as cells, big-to-small', [cells.length, cells[0].x], [2, 180]);
  }
})().then(() => { console.log(fail ? `\n${fail} FAILED` : '\nall ok'); process.exit(fail ? 1 : 0); });
