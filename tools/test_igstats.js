'use strict';
// src/igstats.js with scripted screens and a fake driver - no phone, no adb.
// Run:  node tools/test_igstats.js
const st = require('../src/igstats');
const ig = require('../src/igpost');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const node = (o) => {
  const b = o.bounds || [0, 0, 100, 100];
  const a = [`text="${o.text || ''}"`, `content-desc="${o.desc || ''}"`, `resource-id="${o.id ? 'com.instagram.android:id/' + o.id : ''}"`,
             `class="${o.cls || 'android.widget.TextView'}"`, `package="com.instagram.android"`, `clickable="${o.clickable ? 'true' : 'false'}"`,
             `enabled="true"`, `bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]"`];
  return `<node index="0" ${a.join(' ')} />`;
};
const screen = (...nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.map(node).join('')}</hierarchy>`;
const NAV = [{ id: 'tab_bar', bounds: [0, 2200, 1080, 2400] }, { id: 'clips_tab', desc: 'Reels', clickable: true, bounds: [216, 2220, 432, 2380] },
             { id: 'profile_tab', desc: 'Profile', clickable: true, bounds: [864, 2220, 1080, 2380] }];

// Classic header: number over its label, ids on the numbers. Professional row WITH the number.
const PRO_INLINE = screen({ id: 'action_bar_title', text: 'bella.rose_22', bounds: [200, 100, 800, 180] },
  { id: 'row_profile_header_textview_post_count', text: '48', bounds: [380, 260, 520, 320] }, { text: 'posts', bounds: [380, 320, 520, 370] },
  { id: 'row_profile_header_textview_followers_count', text: '12.5K', bounds: [560, 260, 760, 320] }, { text: 'followers', bounds: [560, 320, 760, 370] },
  { id: 'row_profile_header_textview_following_count', text: '1,034', bounds: [800, 260, 1000, 320] }, { text: 'following', bounds: [800, 320, 1000, 370] },
  { id: 'professional_dashboard_entry', text: 'Professional dashboard', clickable: true, bounds: [40, 700, 1040, 760] },
  { text: '23.4K views in the last 30 days', bounds: [40, 760, 1040, 800] },
  { id: 'profile_tab_reels', desc: 'Reels', clickable: true, bounds: [360, 1100, 720, 1200] }, ...NAV);
// Newer header: no ids, "N label" content-descs; professional row WITHOUT a number.
const PRO_NO_NUMBER = screen({ id: 'action_bar_title', text: 'kim.daily', bounds: [200, 100, 800, 180] },
  { desc: '311 posts', clickable: true, bounds: [380, 260, 520, 370] }, { desc: '2,004 followers', clickable: true, bounds: [560, 260, 760, 370] },
  { desc: '98 following', clickable: true, bounds: [800, 260, 1000, 370] },
  { text: 'Professional dashboard', clickable: true, bounds: [40, 700, 1040, 760] },
  { id: 'profile_tab_reels', desc: 'Reels', clickable: true, bounds: [360, 1100, 720, 1200] }, ...NAV);
const DASHBOARD = screen({ text: 'Professional dashboard', bounds: [0, 100, 1080, 180] }, { text: 'Last 30 days', bounds: [40, 220, 400, 270] },
  { text: '8,912', bounds: [40, 320, 500, 400] }, { text: 'Views', bounds: [40, 400, 500, 450] },
  { text: '1.2K', bounds: [580, 320, 1040, 400] }, { text: 'Accounts reached', bounds: [580, 400, 1040, 450] });
const REELS = screen({ id: 'profile_tab_reels', desc: 'Reels', bounds: [360, 1100, 720, 1200] },
  { id: 'preview_clip_play_count', text: '1,204', bounds: [10, 1600, 120, 1640] }, { id: 'preview_clip_play_count', text: '15.1K', bounds: [370, 1600, 480, 1640] },
  { id: 'preview_clip_play_count', text: '300', bounds: [730, 1600, 840, 1640] }, ...NAV);
const REELS_DESC = screen({ desc: 'Reel by x, 2,000 views', clickable: true, bounds: [0, 1300, 360, 1900] },
  { desc: 'Reel by x, 1.5K plays', clickable: true, bounds: [360, 1300, 720, 1900] }, ...NAV);
const EMPTY = screen(...NAV);
// Personal: label UNDER the number, no ids, no dashboard.
const PERSONAL = screen({ id: 'action_bar_title', text: 'sam_p', bounds: [200, 100, 800, 180] },
  { text: '7', bounds: [380, 260, 520, 320] }, { text: 'Posts', bounds: [380, 320, 520, 370] },
  { text: '1.1M', bounds: [560, 260, 760, 320] }, { text: 'Followers', bounds: [560, 320, 760, 370] },
  { text: '0', bounds: [800, 260, 1000, 320] }, { text: 'Following', bounds: [800, 320, 1000, 370] },
  { id: 'profile_tab_reels', desc: 'Reels', clickable: true, bounds: [360, 1100, 720, 1200] }, ...NAV);

function driver(screens) {
  const q = screens.slice(); let i = 0;
  const d = { taps: [], keys: [], dump: async () => q[Math.min(i, q.length - 1)],
    tap: async (x, y) => { d.taps.push([x, y]); i++; }, key: async (k) => { d.keys.push(k); i++; }, wait: async () => {} };
  return d;
}
const pick = (o, ks) => ks.map((k) => o[k]);

(async () => {
  // ---------- numbers ----------
  check('parseCount', ['1,234', '12.5K', '1.2M', '987', '3 456', '12,5K', '2B', 'Posts', '', '1.234.567'].map(st.parseCount),
        [1234, 12500, 1200000, 987, 3456, 12500, 2000000000, null, null, 1234567]);

  // ---------- header counts ----------
  check('counts by resource-id', st.countsFrom(ig.parseDump(PRO_INLINE)), { posts: 48, followers: 12500, following: 1034 });
  check('counts from "N label" content-desc', st.countsFrom(ig.parseDump(PRO_NO_NUMBER)), { posts: 311, followers: 2004, following: 98 });
  check('counts from a number above its label (no ids)', st.countsFrom(ig.parseDump(PERSONAL)), { posts: 7, followers: 1100000, following: 0 });
  check('no header -> nulls, never a guess', st.countsFrom(ig.parseDump(EMPTY)), { posts: null, followers: null, following: null });

  // ---------- dashboard ----------
  check('dashboard row with "23.4K views in the last 30 days"', st.dashboardInline(ig.parseDump(PRO_INLINE)), { views: 23400, reach: null, days: 30 });
  check('dashboard overview screen tiles', st.dashboardScreen(ig.parseDump(DASHBOARD)), { views: 8912, reach: 1200, days: 30 });
  check('reels tab = the profile tab, not the bottom nav', st.findReelsTab(ig.parseDump(PRO_INLINE)).id, 'com.instagram.android:id/profile_tab_reels');
  check('only the bottom nav "Reels" -> not found', st.findReelsTab(ig.parseDump(EMPTY)), null);

  // ---------- reels ----------
  check('reel play counts by id', st.reelsFrom(ig.parseDump(REELS)), { sum: 16604, n: 3 });
  check('reel play counts from thumbnail descriptions', st.reelsFrom(ig.parseDump(REELS_DESC)), { sum: 3500, n: 2 });

  // ---------- the visit ----------
  {
    const d = driver([PRO_INLINE, REELS]);
    const r = await st.collect(d, ig.parseDump(PRO_INLINE), { username: 'bella.rose_22' });
    check('pro + inline views: one tap (reels tab), no back', [pick(r, ['account_type', 'followers', 'views', 'days', 'reels_views', 'reels_counted']), d.taps.length, d.keys], [['professional', 12500, 23400, 30, 16604, 3], 1, []]);
    check('nothing missing -> no why, no screens', [r.why, r.screens.length], [[], 0]);
  }
  {
    const d = driver([PRO_NO_NUMBER, DASHBOARD, PRO_NO_NUMBER, REELS]);
    const r = await st.collect(d, ig.parseDump(PRO_NO_NUMBER), { username: 'kim.daily' });
    check('pro without inline number: opens the dashboard, reads, Back, then reels', [pick(r, ['account_type', 'followers', 'views', 'reach', 'reels_views']), d.taps.length, d.keys],
          [['professional', 2004, 8912, 1200, 16604], 2, ['back']]);
  }
  {
    const d = driver([PERSONAL, REELS_DESC]);
    const r = await st.collect(d, ig.parseDump(PERSONAL), { username: 'sam_p' });
    check('personal: no dashboard tap, views null, reels counted', [pick(r, ['account_type', 'followers', 'views', 'reels_views']), d.taps.length], [['personal', 1100000, null, 3500], 1]);
  }
  {
    const d = driver([PERSONAL, EMPTY]);
    const r = await st.collect(d, ig.parseDump(PERSONAL), { username: 'sam_p' });
    check('reels tab without counts -> null + why + the screen for tuning', [r.reels_views, r.why, r.screens.map((x) => x.at)], [null, ['no reel play counts on the reels tab'], ['reels']]);
  }
  {
    const d = driver([PRO_NO_NUMBER]);
    const r = await st.collect(d, ig.parseDump(PRO_NO_NUMBER), { username: 'kim.daily', abort: async () => true });
    check('a viewer opened the phone -> no tap at all', [d.taps.length, r.why], [0, ['aborted: a viewer opened the phone']]);
  }
  {
    const d = driver([EMPTY]);
    const r = await st.collect(d, ig.parseDump(EMPTY), { username: 'x' });
    check('unrecognised profile -> nulls, reasons, screens redacted', [r.followers, r.account_type, r.why], [null, '', ['followers not found', 'reels tab not found']]);
  }
  {
    const s = screen({ text: 'my handle is bella.rose_22', bounds: [0, 300, 1080, 400] }, ...NAV);
    const r = await st.collect(driver([s]), ig.parseDump(s), { username: 'bella.rose_22' });
    check('the username is redacted in captured screens', r.screens[0].texts.includes('my handle is <user>'), true);
  }
  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
