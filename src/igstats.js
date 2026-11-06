'use strict';
// Account numbers off the phone (v0.5.12, 2026-11-06), for the backend's daily Analytics sweep.
// PURE like ./igpost.js: it reads `uiautomator dump` screens through the same tiny `driver`
// (dump / tap / key / wait) and never touches adb itself, so tools/test_igstats.js drives it with
// scripted screens and no phone.
//
// It runs right after `ig_whoami` has read the username, i.e. while Instagram is ON THE PROFILE
// TAB of that account, and collects in the same visit:
//   1. posts / followers / following  - the profile header (no tap)
//   2. professional dashboard views + accounts reached for the last N days - the "Professional
//      dashboard" row on the profile usually prints "12.3K views in the last 30 days"; when it does
//      not, the row is opened, the overview read, and Back pressed. Personal accounts have no
//      dashboard: those fields stay null and account_type says 'personal'.
//   3. reel plays - the Reels tab of the profile: the play count on every reel thumbnail visible
//      on the first screen (about 9-12 reels), summed. This works for personal accounts too.
// READ-ONLY: the only taps are the dashboard row, Back, and the profile's own Reels tab. Nothing
// is followed, liked, edited or posted. A viewer opening the phone mid-way aborts (opts.abort).
//
// PROVISIONAL SELECTORS, same as igpost.js: written from Instagram's Android layout as known on
// 2026-11-06 and NOT yet seen on a farm phone. Every reader has several fallbacks (resource-id,
// then "N label" text/content-desc, then a number sitting next to its label), and whatever is not
// found comes back as null plus a reason in `why` and the sanitized screen in `screens`, so the
// selectors can be corrected from what the phones actually showed - never a guessed number.
const ig = require('./igpost');

// "1,234" 1234 | "12.5K" 12500 | "1.2M" | "3 456" | "987" ; anything else -> null
function parseCount(s) {
  const m = /^\s*([\d][\d.,\s ]*)\s*([KMB])?\s*$/i.exec(String(s == null ? '' : s));
  if (!m) return null;
  let num = m[1].replace(/[\s ]/g, '');
  const suf = (m[2] || '').toUpperCase();
  if (suf) {
    num = num.replace(',', '.');                      // "12,5K" in some locales
    const v = parseFloat(num);
    if (!isFinite(v)) return null;
    return Math.round(v * (suf === 'K' ? 1e3 : suf === 'M' ? 1e6 : 1e9));
  }
  if (/^\d{1,3}([.,]\d{3})+$/.test(num)) num = num.replace(/[.,]/g, '');   // thousands separators
  if (!/^\d+$/.test(num)) return null;
  return parseInt(num, 10);
}
const NUM = '([\\d][\\d.,\\u00a0 ]*\\s?[KMB]?)';

function labelOf(n) { return (n.text || n.desc || '').trim(); }
function screenHeight(nodes) { return nodes.reduce((h, n) => (n.bounds && n.bounds.b > h ? n.bounds.b : h), 0) || 2400; }

// The number that belongs to a label node: the closest numeric node directly above it (classic
// header: "1,234" over "followers") or just left of it on the same line ("1,234 followers" split).
function numberNear(nodes, label) {
  const lb = label.bounds;
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    if (n === label || !n.bounds) continue;
    const v = parseCount(n.text || n.desc);
    if (v == null) continue;
    const above = n.bounds.b <= lb.t + 12 && lb.t - n.bounds.b < 160 && Math.abs(n.cx - label.cx) < 180;
    const left = Math.abs(n.cy - label.cy) < 30 && n.bounds.r <= lb.l + 12 && lb.l - n.bounds.r < 120;
    const below = n.bounds.t >= lb.b - 12 && n.bounds.t - lb.b < 160 && Math.abs(n.cx - label.cx) < 180;
    if (!(above || left || below)) continue;
    const d = Math.abs(n.cx - label.cx) + Math.abs(n.cy - label.cy) + (below ? 50 : 0);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

// ---- 1. posts / followers / following --------------------------------------------------------
const COUNT_IDS = {
  posts: /profile_header_post_count|textview_post_count|familiar_post_count_value|post_count/,
  followers: /profile_header_followers_count|textview_followers_count|familiar_followers_value|followers_count/,
  following: /profile_header_following_count|textview_following_count|familiar_following_value|following_count/,
};
const COUNT_WORD = { posts: /^posts?$/i, followers: /^followers?$/i, following: /^following$/i };

function countsFrom(nodes) {
  const out = { posts: null, followers: null, following: null };
  const h = screenHeight(nodes);
  const header = nodes.filter((n) => n.bounds && n.bounds.t < h * 0.6);
  for (const k of Object.keys(out)) {
    const byId = header.find((n) => COUNT_IDS[k].test(n.id) && parseCount(n.text || n.desc) != null);
    if (byId) { out[k] = parseCount(byId.text || byId.desc); continue; }
    const re = new RegExp('^' + NUM + '\\s*' + COUNT_WORD[k].source.slice(1, -1) + '$', 'i');   // "1,234 followers"
    const inline = header.map((n) => re.exec((n.text || '').trim()) || re.exec((n.desc || '').trim())).find(Boolean);
    if (inline) { out[k] = parseCount(inline[1]); continue; }
    const lbl = header.find((n) => COUNT_WORD[k].test(labelOf(n)));
    if (lbl) out[k] = numberNear(header, lbl);
  }
  return out;
}

// ---- 2. professional dashboard ---------------------------------------------------------------
const DASH_ENTRY = [{ id: /professional_dashboard|pro_dashboard|business_dashboard|insights_entry/ }, { text: /^professional dashboard$/i }, { desc: /professional dashboard/i }, { text: /professional dashboard/i }];
const INLINE_RE = new RegExp(NUM + '\\s+(views|accounts reached|reached)\\b[^\\d]*(\\d+)\\s*days', 'i');

function dashboardInline(nodes) {
  const out = { views: null, reach: null, days: null };
  for (const n of nodes) {
    for (const s of [n.text, n.desc]) {
      const m = INLINE_RE.exec(s || '');
      if (!m) continue;
      const v = parseCount(m[1]);
      if (v == null) continue;
      if (/views/i.test(m[2])) out.views = v; else out.reach = v;
      out.days = parseInt(m[3], 10);
    }
  }
  return out;
}

// The dashboard / insights overview: "Views" and "Accounts reached" tiles with their number.
function dashboardScreen(nodes) {
  const out = dashboardInline(nodes);
  const pick = (re) => {
    for (const n of nodes) {
      const t = labelOf(n);
      const one = new RegExp('^' + NUM + '\\s*' + re.source + '$', 'i').exec(t);      // "1,234 Views"
      if (one) return parseCount(one[1]);
      if (new RegExp('^' + re.source + '$', 'i').test(t) && n.bounds) { const v = numberNear(nodes, n); if (v != null) return v; }
    }
    return null;
  };
  if (out.views == null) out.views = pick(/views/);
  if (out.reach == null) out.reach = pick(/accounts reached/);
  if (out.days == null) {
    const d = nodes.map((n) => /last\s+(\d+)\s+days/i.exec(n.text || n.desc || '')).find(Boolean);
    if (d) out.days = parseInt(d[1], 10);
  }
  return out;
}

// ---- 3. reel plays on the Reels tab ----------------------------------------------------------
const REELS_TAB = [{ id: /profile_tab_reels|clips_tab|reels_tab|profile_tab_icon_view_clips/ }, { desc: /^reels$/i }, { desc: /^reels tab/i }, { text: /^reels$/i }];
const PLAY_IDS = /preview_clip_play_count|clips_play_count|play_count|view_count/;
const PLAY_RE = new RegExp(NUM + '\\s*(views|plays)\\b', 'i');

function reelsFrom(nodes) {
  const counts = [];
  const seen = new Set();
  for (const n of nodes) {
    if (!n.bounds) continue;
    let v = null;
    if (PLAY_IDS.test(n.id)) v = parseCount(n.text || n.desc);
    if (v == null) { const m = PLAY_RE.exec(n.desc || '') || PLAY_RE.exec(n.text || ''); if (m) v = parseCount(m[1]); }
    if (v == null) continue;
    const key = Math.round(n.bounds.l / 40) + ':' + Math.round(n.bounds.t / 40);   // one count per thumbnail
    if (seen.has(key)) continue;
    seen.add(key);
    counts.push(v);
  }
  return { sum: counts.length ? counts.reduce((a, b) => a + b, 0) : null, n: counts.length };
}
// The profile's own Reels tab, never the bottom navigation's "Reels" (that is the feed).
function findReelsTab(nodes) {
  const h = screenHeight(nodes);
  for (const sel of REELS_TAB) {
    const n = nodes.find((x) => x.bounds && ig.matches(x, sel) && x.bounds.b < h * 0.88 && x.bounds.t > h * 0.12);
    if (n) return n;
  }
  return null;
}

// ---- the visit -------------------------------------------------------------------------------
// driver: { dump, tap, key, wait }   nodes: the profile screen whoami ended on (igpost nodes)
// opts: { username, abort?: async () => bool, reels?: bool (default true), dashboard?: bool (default true) }
async function collect(driver, nodes, opts) {
  const o = opts || {};
  const out = { posts: null, followers: null, following: null, account_type: '', views: null, reach: null, days: null,
                reels_views: null, reels_counted: 0, why: [], screens: [] };
  const shot = (at, ns) => out.screens.push({ at, ...ig.describe(ns, o.username) });
  const dump = async () => ig.parseDump(await driver.dump());
  const aborted = async () => !!(o.abort && (await o.abort()));
  let profile = nodes && nodes.length ? nodes : await dump();

  Object.assign(out, countsFrom(profile));
  if (out.followers == null) { out.why.push('followers not found'); shot('profile', profile); }

  const dash = ig.findAny(profile, DASH_ENTRY);
  out.account_type = dash ? 'professional' : (out.followers != null ? 'personal' : '');
  if (dash && o.dashboard !== false) {
    const inl = dashboardInline(profile);
    if (inl.views != null || inl.reach != null) Object.assign(out, inl);
    else {
      if (await aborted()) { out.why.push('aborted: a viewer opened the phone'); return out; }
      const t = ig.tapTarget(profile, dash.node);
      await driver.tap(t.cx, t.cy);
      await driver.wait(3500);
      let ds = await dump();
      let r = dashboardScreen(ds);
      if (r.views == null && r.reach == null) { await driver.wait(2500); ds = await dump(); r = dashboardScreen(ds); }
      Object.assign(out, r);
      if (r.views == null) { out.why.push('dashboard views not found'); shot('dashboard', ds); }
      await driver.key('back');
      await driver.wait(1800);
      profile = await dump();
    }
  }

  if (o.reels !== false) {
    const tab = findReelsTab(profile);
    if (!tab) { out.why.push('reels tab not found'); shot('profile', profile); return out; }
    if (await aborted()) { out.why.push('aborted: a viewer opened the phone'); return out; }
    const t = ig.tapTarget(profile, tab);
    await driver.tap(t.cx, t.cy);
    await driver.wait(3000);
    let rs = await dump();
    let r = reelsFrom(rs);
    if (!r.n) { await driver.wait(2000); rs = await dump(); r = reelsFrom(rs); }
    out.reels_views = r.sum;
    out.reels_counted = r.n;
    if (!r.n) { out.why.push('no reel play counts on the reels tab'); shot('reels', rs); }
  }
  out.screens = out.screens.slice(0, 4);
  return out;
}

module.exports = { parseCount, countsFrom, dashboardInline, dashboardScreen, reelsFrom, findReelsTab, collect, DASH_ENTRY, REELS_TAB };
