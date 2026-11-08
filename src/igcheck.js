'use strict';
// The daily account check, on the phone itself (v0.5.15, 2026-11-08). For ONE Android profile: which
// Instagram account is logged in (or that none is, or that it is blocked), its header numbers, the
// other accounts on that app, and - for a professional account - what Instagram's OWN Insights say
// about the last 30 days. PURE like ./igpost.js and ./igstats.js: nothing in this file touches adb.
// core.js `igCheck` switches the phone to the profile, makes sure Instagram is really in front and
// hands `check()` a small driver; everything that decides what a screen IS, what a number on it
// MEANS and WHERE a tap may land lives here, so tools/test_igcheck.js drives whole visits with
// scripted screens and no phone.
//
// WHY. The owner: "i need to open the phone and check on each profile what accounts we got and how
// many followers we got" and "the automation will open the phone and check each profiles and see it
// from there, views, usa % everything at 4am NYC TIME". The 06:00 sweep before this (`ig_whoami` +
// stats) got 30 usernames out of 887 profiles: it called every logged-out profile UNKNOWN, stopped
// at the first "What happened" notice, and never opened Insights.
//
// WHAT THE PHONES REALLY SHOW (2026-11-08, phones 10 and 14, 1080x2400 - the build's screenshots):
//   "Join Instagram" + Get started + I already have a profile  -> NO_ACCOUNT (nothing is tapped)
//   a login form / a saved-account login                         -> LOGIN_REQUIRED (+ remembered)
//   "What happened" + X: "We added a restriction to your account / You can't send messages / Ends
//     on Nov 24, 2026", or "We removed your post"                -> recorded, closed with its X
//   Android's "Allow Instagram to send you notifications?"      -> "Don't allow"
//   home feed with a "Meet Muse / Try Muse" card (not blocking) -> the profile tab
//   profile: title left-aligned OR centred, "3 posts 85 followers 12 following", "Your dashboard /
//     44.3K views in the last 30 days."                         -> the header numbers
//   "Your dashboard" -> "Views" -> Insights: Overview (tiles, followers %, viewers, by content type,
//     profile activity) and Audience (followers + growth, gender, age, countries / cities, active
//     times, most active windows; nothing below 100 followers - Instagram says so)
//   tapping the title -> the accounts sheet                     -> the other accounts, read only
//
// READ-ONLY - THESE ARE REAL ACCOUNTS. Taps: the profile tab, the "Your dashboard" row, the
// dashboard's "Views" row, the Insights tabs Overview / Audience, the Countries / Cities chips, the
// active-times day chips, the action-bar title (opens the accounts sheet), a notice's close X and
// SAFE_DISMISS buttons. Swipes: up/down inside Insights, ONE sideways swipe of the Overview tiles.
// Keys: BACK / HOME. Every tap also goes through a last check (`tapRefused`): a point that lands on
// anything FORBIDDEN, or anywhere on the accounts sheet, is not tapped - Back is the answer then.
//
// PROVISIONAL like the other readers: the texts below are what the phones printed on 2026-11-08;
// resource-ids are only ever a second opinion (Instagram renames them; texts change less). What was
// not found comes back null with a reason (`why`) and the screens in `screens`, never a guess.
const ig = require('./igpost');
const st = require('./igstats');

const IG_PKG = 'com.instagram.android';
const DAYS = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];                // the active-times chips, in order
const SLOTS = ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'];   // the eight 3-hour bars of a day
const AGES = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];

// Time limits of the visit (driver time, ms). The backend waits 300 s for the whole op; core.js
// spends up to ~40 s on the switch, settle and launch, so the visit itself ends by DEFAULT_BUDGET.
const LOOP_MS = 45000;           // step 5: from launch to a usable Instagram screen
const PROFILE_WAIT_MS = 10000;   // step 6: the header after tapping the profile tab
const INSIGHTS_MS = 120000;      // step 7: dashboard + Overview + Audience
const SHEET_WAIT_MS = 5000;      // step 8: the accounts sheet after tapping the title
const VISIT_WAIT_MS = 10000;     // step 9: another account's header after the VIEW intent
const DEFAULT_BUDGET_MS = 240000;
const MIN_LEFT = { insights: 60000, sheet: 15000, visit: 16000 };
const MAX_NOTICES = 4, MAX_POPUPS = 4, MAX_PROMO_BACKS = 3, MAX_OTHER_APP = 2, MAX_LAUNCH = 2, MAX_UNLOCK = 2;
const MAX_VISITS = 4;
const MAX_DUMPS = 160;           // a runaway loop ends as `too_many_screens`, never as a hung phone
const VIEWER_RECHECK_MS = 1000;  // the viewer check right before a tap may reuse one this fresh
const MAX_SCREENS = 12;

// ---- 0. text helpers -------------------------------------------------------------------------
// Curly apostrophes ("Don’t allow", "who’s"), no-break spaces and unicode dashes / minus signs
// ("Oct 9 – Nov 7", "−2.5%") are folded before any matching.
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‛′ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/[   ]/g, ' ').replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ').trim();
}
function labelsOf(n) {
  const t = norm(n.text), d = norm(n.desc);
  return t && d && t !== d ? [t, d] : t ? [t] : d ? [d] : [];
}
function lbl(n) { return norm(n.text) || norm(n.desc); }
function is(n, re) { return labelsOf(n).some((s) => re.test(s)); }
function has(nodes, re) { return nodes.some((n) => n.bounds && is(n, re)); }
function first(nodes, re, f) { return nodes.find((n) => n.bounds && is(n, re) && (!f || f(n))) || null; }
// Nodes a person can see: uiautomator reports hidden views as [0,0][0,0].
function boxed(nodes) { return (nodes || []).filter((n) => n.bounds && n.bounds.r > n.bounds.l && n.bounds.b > n.bounds.t); }
function size(nodes) { return ig.screenSize(nodes); }
function inside(n, x, y) { return n.bounds && x >= n.bounds.l && x <= n.bounds.r && y >= n.bounds.t && y <= n.bounds.b; }
function clip(s, n) { const v = norm(s); return v.length > n ? v.slice(0, n - 1) + '…' : v; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Instagram usernames: letters, digits, "." and "_", at most 30. A header holds plenty of other
// handle-shaped words ("Kadie", "85", "posts"), so a handle also needs a letter or "_" and must not
// be one of Instagram's own labels.
const HANDLE = /^(?=[a-z0-9._]*[a-z_])[a-z0-9._]{2,30}$/i;
const NOT_HANDLE = /^(instagram|meta|threads|facebook|whatsapp|home|reels?|search|explore|profile|edit|share|follow|following|followers?|message|messages|settings|posts?|menu|options|more|back|close|cancel|skip|next|done|insights|dashboard|overview|content|audience|views?|viewers|gender|women|men|countries|cities|today|yesterday|new|english|login|log|signup|password|username|verified|story|stories|live|create|activity|notifications|camera|gallery|switch|accounts?|or|and|from|the|with|for|you|your|use)$/i;
function handleOf(s) {
  // "urfavekadiee ⌄": the title's chevron is sometimes part of the text
  const v = norm(s).replace(/^@/, '').replace(/\s*[⌄˅▾▼⌵∨↓]+$/, '').trim();
  return HANDLE.test(v) && !NOT_HANDLE.test(v) ? v.toLowerCase() : '';
}
// The username out of a trace line (igpost.redact also cuts at 80 characters; a trace line keeps 160).
function redactUser(s, username) {
  const v = String(s || '');
  return username ? v.replace(new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '<user>') : v;
}

// ---- 1. numbers, percentages, dates ----------------------------------------------------------
function count(s) { return st.parseCount(norm(s)); }
// "Net followers" can go down: "-12" / "−12" / "+4".
function signedCount(s) {
  const m = /^([+-])\s*(\d.*)$/.exec(norm(s));
  if (!m) return count(s);
  const v = count(m[2]);
  return v == null ? null : (m[1] === '-' ? -v : v);
}
// "53.1%" 53.1 | "+435.1% since Oct 9" 435.1 | "−2.5%" -2.5 | "<0.1%" 0.1 | "12,5 %" 12.5 | "+1,234.5%" 1234.5
function parsePct(s) {
  const m = /^<?\s*([+-])?\s*(\d[\d.,]*)\s*%/.exec(norm(s));
  if (!m) return null;
  const t = m[2];
  const v = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? parseFloat(t.replace(/,/g, '')) : parseFloat(t.replace(',', '.'));
  if (!isFinite(v)) return null;
  return m[1] === '-' ? -v : v;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec';
function iso(y, mo, d) {
  if (!(y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// "Nov 24, 2026" / "Ends on Nov 24, 2026" / "24 November 2026" / "2026-11-24" -> "2026-11-24".
// No year printed -> '' (a guessed year would be a guessed restriction end).
function parseDate(s) {
  const t = norm(s);
  let m = new RegExp(`\\b(${MON})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i').exec(t);
  if (m) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = new RegExp(`\\b(\\d{1,2})\\s+(${MON})[a-z]*\\.?,?\\s+(\\d{4})\\b`, 'i').exec(t);
  if (m) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return '';
}
// The dashboard's period: "Oct 9 - Nov 7" (Instagram's own words, kept) and how many days it spans.
const RANGE_RE = new RegExp(`^(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\s*-\\s*(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$`, 'i');
function parseRange(s, today) {
  const t = norm(s);
  const m = RANGE_RE.exec(t);
  if (!m) return null;
  const year = /^\d{4}/.test(today || '') ? parseInt(today, 10) : new Date().getFullYear();
  const m1 = MONTHS[m[1].toLowerCase()], d1 = +m[2], m2 = MONTHS[m[4].toLowerCase()], d2 = +m[5];
  const y2 = m[6] ? +m[6] : year;
  const y1 = m[3] ? +m[3] : (m1 > m2 ? y2 - 1 : y2);   // "Dec 20 - Jan 18" starts the year before
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
  return { text: t.replace(/\s*-\s*/, ' - '), days: days > 0 && days < 400 ? days : null };
}

// ---- 2. sections and rows --------------------------------------------------------------------
// An Insights tab is one long scrolled list of sections ("Views by content type", "Gender", ...).
// A row belongs to the last section header above it on the same screen; rows above the first
// header on a screen belong to the section BEFORE that header; a screen with no header at all is
// inside the section the previous screen ended in (`carry`). That is what keeps "Reels 43.3K"
// (views) apart from "Reels 952" (interactions) when both lists share one screen.
function headsOf(nodes, defs) {
  const out = [];
  for (const n of nodes) {
    const d = defs.find((x) => is(n, x.re));
    if (d && !out.some((h) => h.key === d.key)) out.push({ key: d.key, t: n.bounds.t, b: n.bounds.b, node: n });
  }
  return out.sort((a, b) => a.t - b.t);
}
function sectionAt(y, heads, before, carry) {
  let cur = null;
  for (const h of heads) if (h.t <= y + 4) cur = h.key;
  if (cur) return cur;
  const below = heads.find((h) => h.t > y + 4);
  if (below) return before[below.key] || null;
  return carry || null;
}
// Instagram prints a row's number on the label's line (Viewers ... 20,198) or on the bar line just
// under it (Reels / ▬▬▬ 43.3K). Each number goes to the closest row label at or above it in the
// same section, to its right, at most one row away.
function rowsToValues(labels, values) {
  const out = new Map();
  for (const v of values.slice().sort((a, b) => a.node.bounds.t - b.node.bounds.t)) {
    let owner = null;
    for (const l of labels) {
      if (l.sec !== v.sec || l.node === v.node) continue;
      const dy = v.node.bounds.t - l.node.bounds.t;
      if (dy < -14 || dy > 170) continue;
      if (v.node.bounds.l < l.node.bounds.r - 4) continue;
      if (!owner || l.node.bounds.t > owner.node.bounds.t) owner = l;
    }
    if (owner && !out.has(owner)) out.set(owner, v.value);
  }
  return out;
}
// The number that belongs to a label: directly above it ("85" over "Followers"), below it
// ("Followers" over "4,720") or just left of it on the same line. Like igstats' numberNear, but it
// hands back the node too.
function numberNear(nodes, label) {
  const lb = label.bounds;
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    if (n === label || !n.bounds) continue;
    const v = count(lbl(n));
    if (v == null) continue;
    const above = n.bounds.b <= lb.t + 12 && lb.t - n.bounds.b < 160 && Math.abs(n.cx - label.cx) < 180;
    const left = Math.abs(n.cy - label.cy) < 30 && n.bounds.r <= lb.l + 12 && lb.l - n.bounds.r < 120;
    const below = n.bounds.t >= lb.b - 12 && n.bounds.t - lb.b < 160 && Math.abs(n.cx - label.cx) < 180;
    if (!(above || left || below)) continue;
    const d = Math.abs(n.cx - label.cx) + Math.abs(n.cy - label.cy) + (below ? 50 : 0);
    if (d < bestD) { bestD = d; best = { value: v, node: n }; }
  }
  return best;
}

// ---- 3. what is on the screen ----------------------------------------------------------------
const LAUNCHER_PKG = /launcher|trebuchet|quickstep|lawnchair|\.home$|homescreen/i;
const PROMPT_PKG = /permissioncontroller|packageinstaller|^android$/i;
const KEYGUARD_ID = /keyguard|lock_icon|lockscreen|bouncer|pin_view|password_entry|pattern_view/i;
const KEYGUARD_TEXT = /swipe up to (open|unlock)|enter (your )?(pin|password|pattern)|draw (your )?(unlock )?pattern|^unlock$/i;
// Android's own "Instagram isn't responding" / "keeps stopping" dialog. The system draws it in its own
// window (package "android"), never inside Instagram's, and it always comes with its own buttons.
// Matching the words anywhere on any screen turned a bio like "Not responding to DMs, sorry" or a
// caption ending "...the rain has stopped" into a hung app - every day, for that account.
const ANR_TITLE = /^(.+ )?(isn't responding|is not responding|keeps stopping|has stopped)$/i;
const ANR_BUTTON = /^(close app|wait|app info|open app again|send feedback)$/i;
const NAV_WORD = /^(home|reels|search( and explore)?|explore|profile|your profile|messages?|messenger|direct( messages)?|inbox|create|new post|shop|activity)$/i;
const NAV_ID = /(^|\/)(tab_bar|feed_tab|clips_tab|profile_tab|tab_avatar|search_tab|direct_tab|creation_tab)$/;

// Instagram's own bottom bar: by id, or three of its tab names in the bottom strip.
function tabBar(nodes, h) {
  const bottom = nodes.filter((n) => n.bounds.t >= h * 0.86);
  if (bottom.some((n) => NAV_ID.test(n.id))) return true;
  return bottom.filter((n) => NAV_WORD.test(norm(n.desc)) || NAV_WORD.test(norm(n.text))).length >= 3;
}

// The window the dump shows: the whole screen, or a dialog / bottom sheet in a window of its own (that
// one starts further down). "The title bar" and "the upper part of the page" are measured inside it.
function frame(nodes) {
  let top = Infinity, w = 0, h = 0;
  for (const n of nodes) { top = Math.min(top, n.bounds.t); w = Math.max(w, n.bounds.r); h = Math.max(h, n.bounds.b); }
  w = w || 1080; h = h || 2400; top = isFinite(top) ? top : 0;
  return { top, w, h, span: Math.max(1, h - top) };
}
// WORDS PEOPLE WROTE (review of 2026-11-08). Instagram resumes where the app was left, and for the
// profile a chatter worked in that is a DM thread or the inbox. A fan's "Please verify your account",
// "your account has been disabled lol", "What happened?" or "Later" there is not Instagram talking - and
// reading it as a block, a notice or a pop-up called healthy accounts blocked or RESTRICTED, and could
// tap a conversation open (the fan then sees "Seen"). So: a screen with a message box (a DM thread, a
// story reply, comments) or a DM thread's call buttons is a CONVERSATION - nothing on it is read as a
// block, a notice or a pop-up and nothing on it is tapped (Back leaves it); a screen with a post's
// Like / Comment / Share / Save buttons has a caption on it, so no block or notice is read there either.
const COMPOSER_TEXT = /^(message|send message|send a message|write a message|type a message|add a comment|comment as|reply)\b/i;
const COMPOSER_ID = /composer|message_input|direct_text_input|comment_text_input|reply_text/i;
const CALL_DESC = /^(audio call|video call|voice call|start (an )?(audio|video) call)$/i;
function conversation(nodes, f) {
  return nodes.some((n) => (/EditText/.test(n.cls) && (is(n, COMPOSER_TEXT) || COMPOSER_ID.test(n.id)))
    || (n.bounds.b <= f.top + f.span * 0.14 && CALL_DESC.test(norm(n.desc))));
}
const POST_ACTION = /^(like|unlike|comment|send post|share|save|add to saved|remove from saved)$/i;
function postOnScreen(nodes) { return nodes.filter((n) => POST_ACTION.test(norm(n.desc))).length >= 2; }
// Instagram's own wording as the HEADLINE of a page: a short line that STARTS with it, in the upper
// part of the page. A sentence somebody wrote (a caption, a bubble, a bio) almost never is one.
function headline(nodes, re, f) {
  return nodes.find((n) => n.bounds.t < f.top + f.span * 0.6 && labelsOf(n).some((s) => s.length <= 100 && re.test(s))) || null;
}

// What makes a page a block, not a notice: its headline, on an Instagram page of its own (no bottom
// bar, nobody's messages or posts on it). Disabled and suspended are looked for first, then the
// "What happened" notice, then challenge and checkpoint - and a challenge or checkpoint page that
// offers "Not now" / "Skip" is a nag (turn on two-factor, confirm your info), dismissed like a pop-up.
// "We restricted your account" / "...some of your activity" is NOT a block: that is how Instagram
// words a restriction notice (recorded, closed with its X, status RESTRICTED while it lasts).
const HARD_BLOCKS = [
  { kind: 'disabled', re: /^(we('ve| have)? disabled your account|your account (has been|was|is) (permanently )?disabled|account (has been )?disabled)\b/i },
  { kind: 'suspended', re: /^(we('ve| have)? suspended your account|your account (has been|was|is) suspended|account suspended)\b/i },
];
const SOFT_BLOCKS = [
  { kind: 'challenge', re: /^(confirm it'?s you|help us confirm (it'?s you|you own)|enter (the|your)? ?(\d-digit )?(security |confirmation |login )?code|we sent (you )?(a|an|the) (code|email|text|sms)|check your (email|texts|text messages)\b|verify (your )?(identity|account)|suspicious login|we detected (an )?unusual)/i },
  { kind: 'checkpoint', re: /^(confirm your account|action blocked|your account (has been|was) (temporarily )?locked|we('ve| have) (temporarily )?locked your account|confirm you'?re (human|not a robot)|complete (a|the) (security|captcha) check)/i },
];
const NOTICE_TITLE = /^what happened\??$/i;
const NOTICE_HEAD = /^(we('ve| have)? (added|removed|restricted|limited|took down|deleted)\b.*|your (post|reel|story|comment|video|account) (was|has been|is) (removed|restricted|limited|taken down)\b.*|you can'?t .*for now.*)$/i;
const NOTICE_BUTTON = /^(see why|close|dismiss|back|ok|okay|learn more|appeal|done|continue|got it|what happened\??|disagree with decision|request a review)$/i;
const UNTIL = /\b(ends on|ends|until|through|expires( on)?|lifted on|lasts until)\b/i;
// The notice's title "What happened", in the page's title bar (u15 / u25: y 180-234 of 2400).
function noticeTitle(nodes, f) { return first(nodes, NOTICE_TITLE, (n) => n.bounds.t < f.top + f.span * 0.14); }
// A notice: the title in the title bar, or Instagram's notice wording as the headline - and the
// notice's own X or its "See why", the two things every notice on the farm had. (Only asked on a
// page of its own: see `classifyScreen`.)
function isNotice(nodes, f) {
  if (!noticeTitle(nodes, f) && !headline(nodes, NOTICE_HEAD, f)) return false;
  return has(nodes, /^see why$/i) || !!noticeCloseTarget(nodes);
}

// The buttons that make a prompt go away without accepting anything: "Not now", "Skip", "Later",
// "Maybe later", "No thanks", "Dismiss", "Close", "Don't allow", "Cancel" - and nothing else. igpost's
// DISMISS also has "OK" / "Got it": on a notice those ACKNOWLEDGE, so they are not here.
const SAFE_DISMISS = [
  { text: /^not now$/i }, { desc: /^not now$/i }, { text: /^skip$/i }, { text: /^later$/i }, { text: /^maybe later$/i },
  { text: /^no,? thanks$/i }, { text: /^dismiss$/i }, { text: /^close$/i },
  { text: /^don.?t allow$/i }, { id: /permission_deny_button/, text: /^(don.?t allow|deny)?$/i }, { text: /^cancel$/i },
];
// With Instagram's bottom bar in view (the feed, the inbox, a profile) only the words that answer a
// QUESTION count. "Later", "Close", "Cancel", "Skip" and "Dismiss" are also what fans write in the
// inbox and what an upload bar offers (Cancel = cancel a post still uploading) - not ours to tap.
const SAFE_ON_APP = [{ text: /^not now$/i }, { desc: /^not now$/i }, { text: /^maybe later$/i }, { text: /^no,? thanks$/i }, { text: /^don.?t allow$/i }];
// A challenge / checkpoint page that offers one of these is a nag Instagram lets you skip (turn on
// two-factor, confirm your info), not a block: a real checkpoint never has a way round it.
const SOFT_DISMISS = [{ text: /^not now$/i }, { desc: /^not now$/i }, { text: /^skip$/i }, { text: /^later$/i }, { text: /^maybe later$/i },
  { text: /^no,? thanks$/i }, { text: /^dismiss$/i }];
// An X drawn as an icon ("Close" / "Dismiss" read out loud). Only on a screen WITHOUT the bottom bar:
// on the feed the same X closes a promo card in the feed, which is not ours to touch.
const SAFE_DISMISS_ICON = [{ desc: /^(close|dismiss)$/i, clickable: true }];
// Never tapped, whatever a finder returns (the tests also check every scripted tap against it).
const FORBIDDEN = /^(see why|appeal|disagree with decision|request a review|learn more|continue|agree|i agree|accept|allow|ok|okay|get started|i already have (a profile|an account)|log ?in|log into another account|create new account|sign up|try muse|add (instagram )?account|add whatsapp|(go to )?accounts center|follow|follow back|edit profile|share profile|add banners|message|see all|monthly recap|best practices|inspiration( on edits)?|ad tools|monetization tools|trending audio|other helpful resources|\d+ days|share|settings|options|menu|content|info|more info|get meta verified|connect your accounts to muse|switch accounts?)$/i;

function contains(c, n) { return c.bounds.l <= n.bounds.l && c.bounds.t <= n.bounds.t && c.bounds.r >= n.bounds.r && c.bounds.b >= n.bounds.b; }
// A word inside a list row is something a person wrote, not a button: the row is a clickable,
// row-sized box around it that also holds other words (the sender of an inbox conversation, the
// author of a comment). Tapping it would open the chat and mark the fan's messages Seen.
function inRow(nodes, hit) {
  const word = lbl(hit);
  return nodes.some((c) => c !== hit && c.clickable && contains(c, hit) && c.bounds.b - c.bounds.t <= 320
    && nodes.some((x) => x !== hit && x !== c && lbl(x) && lbl(x) !== word && contains(c, x)));
}
// The button that makes a prompt go away. o.nav: the bottom bar is in view (SAFE_ON_APP only);
// o.soft: only the "skip this" words (SOFT_DISMISS); o.icon: an X icon counts too. Never a word that
// starts lower-case (buttons are capitalised, usernames never are), never one inside a list row.
function dismissTarget(nodes, o) {
  const opt = o || {};
  const ok = (n) => {
    const label = lbl(n);
    return !(/[a-z]/i.test(label) && !/^[A-Z]/.test(label)) && !FORBIDDEN.test(label) && !inRow(nodes, n);
  };
  const rules = opt.soft ? SOFT_DISMISS : opt.nav ? SAFE_ON_APP : SAFE_DISMISS;
  for (const sel of rules.concat(opt.icon && !opt.nav && !opt.soft ? SAFE_DISMISS_ICON : [])) {
    const n = nodes.find((x) => ig.matches(x, sel) && ok(x));
    if (n) return { node: ig.tapTarget(nodes, n), label: lbl(n) || 'X' };
  }
  return null;
}
// Promos only Back closes (igpost.BACK_ON: the Edits app; Muse full screen) - on a page of their own.
// With the bottom bar in view the same words are a post's "Made with Edits" chip or the feed's Muse
// card: Back there would leave the feed (and Instagram) and end the visit as promo_loop.
function promoBack(nodes, nav) {
  if (nav) return null;
  const b = ig.BACK_ON.find((x) => ig.find(nodes, x.text ? { text: x.text } : { desc: x.desc }));
  if (b) return b.why;
  if (has(nodes, /^try muse$/i)) return 'muse_promo';
  return null;
}
function isLogin(nodes) {
  const field = nodes.some((n) => /EditText/.test(n.cls) && is(n, /username|email|mobile number|phone number|password/i));
  const btn = has(nodes, /^log ?in$/i);
  const strong = has(nodes, /^log into another account$/i) || has(nodes, /^(continue|log in) as @?[a-z0-9._]+$/i);
  const extra = has(nodes, /^forgot (your )?password\??$/i) || has(nodes, /^(create new account|sign up|create account)$/i)
    || has(nodes, /^switch accounts?$/i) || has(nodes, /^add account$/i);
  return strong || (btn && (field || extra));
}
// The accounts sheet. Checked BEFORE the login screen: a sheet that also offers "Log into another
// account" must never read as a logged-out account. "Add account" alone counts only without a
// "Log in" button (a saved-account login page can say "Add account" too).
function isSwitcher(nodes) {
  return has(nodes, /^add instagram account$/i) || has(nodes, /^(go to )?accounts center$/i)
    || (has(nodes, /^add account$/i) && !has(nodes, /^log ?in$/i));
}
const AUDIENCE_MARKS = [/at least 100 followers/i, /^follower growth over time$/i, /^top content by follows$/i, /^gender$/i, /^age range$/i, /^top locations$/i, /^follower active times$/i, /^when followers are most active$/i, /since (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i];
const OVERVIEW_MARKS = [/^all content$/i, /^net followers$/i, /^views by content type$/i, /^viewers$/i, /^top content by views$/i, /^interactions by content type$/i, /^profile activity$/i, /^profile visits$/i, /%\s*non-?followers$/i];
// The Insights pages: their title plus the Overview / Audience tabs, or - when a build does not
// expose the tabs as text - the title plus a section only that tab has. (The dashboard also has an
// "Insights" heading; it is recognised before this.)
function insightsTab(nodes) {
  if (!has(nodes, /^insights$/i)) return null;
  const tabs = has(nodes, /^overview$/i) || has(nodes, /^audience$/i);
  if (AUDIENCE_MARKS.some((re) => has(nodes, re))) return 'audience';
  if (OVERVIEW_MARKS.some((re) => has(nodes, re))) return 'overview';
  if (!tabs) return null;
  const sel = nodes.find((n) => n.selected && /^(overview|content|audience)$/i.test(lbl(n)));
  return sel ? lbl(sel).toLowerCase() : 'unknown';
}
function isDashboard(nodes) {
  return has(nodes, /^(your|professional) dashboard$/i) && !has(nodes, /^edit profile$/i)
    && (has(nodes, /^content you shared$/i) || has(nodes, /^new followers$/i) || has(nodes, /^your tools$/i) || has(nodes, /^next steps$/i));
}
function isProfileScreen(nodes, h) {
  const top = nodes.filter((n) => n.bounds.t < h * 0.45);
  const words = has(top, /^posts?$/i) && has(top, /^followers?$/i) && has(top, /^following$/i);
  const inline = has(top, /^\d[\d.,]*\s?[KMB]?\s*followers?$/i) && has(top, /^\d[\d.,]*\s?[KMB]?\s*following$/i);
  return words || inline || has(nodes, /^(edit|share) profile$/i);
}

// What the screen is, for the visit: { kind, detail }. Kinds: no_account, login, checkpoint,
// challenge, suspended, disabled, notice, popup, promo_back, other_app, keyguard, launcher, switcher,
// profile, dashboard, insights_overview, insights_audience, feed, loading, unknown.
function classifyScreen(nodesIn, opts) {
  const o = opts || {};
  const app = o.appPkg || IG_PKG;
  const nodes = boxed(nodesIn);
  if (!nodes.length) return { kind: 'loading', detail: { why: 'empty screen dump' } };
  const pkg = ig.screenPkg(nodes);
  const f = frame(nodes);
  const h = f.h;
  // Android's "isn't responding" dialog: its own window (package "android"), its own buttons
  if ((!pkg || pkg === 'android') && has(nodes, ANR_TITLE) && has(nodes, ANR_BUTTON)) return { kind: 'loading', detail: { why: 'app_not_responding', pkg } };
  if (pkg && pkg !== app) {
    if (/systemui/i.test(pkg)) {
      if (nodes.some((n) => KEYGUARD_ID.test(n.id)) || has(nodes, KEYGUARD_TEXT)) return { kind: 'keyguard', detail: { pkg } };
      return { kind: 'other_app', detail: { pkg } };   // the notification shade: Back closes it
    }
    if (PROMPT_PKG.test(pkg)) {
      const t = dismissTarget(nodes, { icon: true });
      return t ? { kind: 'popup', detail: { pkg, target: t.node, label: t.label } } : { kind: 'other_app', detail: { pkg } };
    }
    if (LAUNCHER_PKG.test(pkg)) return { kind: 'launcher', detail: { pkg } };
    return { kind: 'other_app', detail: { pkg } };
  }
  // Inside Instagram (or a dump that does not say whose it is).
  const nav = tabBar(nodes, h);
  const convo = conversation(nodes, f);
  // An Instagram page of its own: no bottom bar, nobody's messages or posts on it. Only such a page
  // can be a block or a notice (see "WORDS PEOPLE WROTE" above).
  if (!nav && !convo && !postOnScreen(nodes)) {
    for (const b of HARD_BLOCKS) { const n = headline(nodes, b.re, f); if (n) return blocked(b.kind, n, nodes, b.re); }
    if (isNotice(nodes, f)) return { kind: 'notice', detail: { notice: parseNotice(nodes), close: noticeCloseTarget(nodes) } };
    for (const b of SOFT_BLOCKS) {
      const n = headline(nodes, b.re, f);
      if (!n) continue;
      const nag = dismissTarget(nodes, { soft: true });
      if (nag) return { kind: 'popup', detail: { target: nag.node, label: nag.label, nag: b.kind } };
      return blocked(b.kind, n, nodes, b.re);
    }
  }
  if (!convo && (has(nodes, /^join instagram$/i) || (has(nodes, /^get started$/i) && has(nodes, /^i already have (a profile|an account)$/i)))) return { kind: 'no_account', detail: {} };
  if (isSwitcher(nodes)) return { kind: 'switcher', detail: {} };
  if (!convo && isLogin(nodes)) return { kind: 'login', detail: { remembered: parseLoginRemembered(nodes) } };
  const d = convo ? null : dismissTarget(nodes, { nav, icon: !nav });
  if (d) return { kind: 'popup', detail: { target: d.node, label: d.label } };
  const promo = promoBack(nodes, nav);
  if (promo) return { kind: 'promo_back', detail: { why: promo } };
  if (isDashboard(nodes)) return { kind: 'dashboard', detail: {} };
  const tab = insightsTab(nodes);
  if (tab) return { kind: tab === 'audience' ? 'insights_audience' : 'insights_overview', detail: { tab } };
  if (isProfileScreen(nodes, h)) return { kind: 'profile', detail: { own: has(nodes, /^(edit|share) profile$/i) || has(nodes, /^(your|professional) dashboard$/i) } };
  if (nav) return { kind: 'feed', detail: {} };
  // a DM thread / story reply / comments: Back leaves it (the visit does that at once)
  if (convo) return { kind: 'unknown', detail: { conversation: true } };
  if (nodes.some((n) => /ProgressBar/.test(n.cls)) || nodes.filter((n) => lbl(n)).length < 3) return { kind: 'loading', detail: {} };
  return { kind: 'unknown', detail: {} };
}
function blocked(kind, n, nodes, re) {
  return { kind, detail: { text: clip(labelsOf(n).find((s) => re.test(s)) || lbl(n), 120), username: blockedUsername(nodes) } };
}
function blockedUsername(nodes) {
  for (const n of nodes) { const m = /@([a-z0-9._]{2,30})\b/i.exec(lbl(n)); if (m && handleOf(m[1])) return m[1].toLowerCase(); }
  return '';
}

// ---- 4. notices ------------------------------------------------------------------------------
// What a notice is about. Its title decides first ("We removed your post" stays a removed post even
// when the post's own caption says "you can't stop me"); the lines under it only when the title is
// not one Instagram's wording is known for.
const KIND_REMOVED = /removed your (post|reel|story|video|comment)|(post|reel|story|video|comment) (was|has been) (removed|taken down)|took down/i;
const KIND_RESTRICTION = /restriction|restricted|limited|you can'?t /i;
const KIND_WARNING = /warning|against our (community )?(guidelines|standards)|may be (disabled|deleted)|could be (disabled|deleted)/i;
function noticeKind(s) { return KIND_REMOVED.test(s) ? 'removed_post' : KIND_RESTRICTION.test(s) ? 'restriction' : KIND_WARNING.test(s) ? 'warning' : ''; }
// "What happened": title, the date under it, what it means and when it ends.
//   u15: We added a restriction to your account / Oct 25, 2026 / You can't send messages / Ends on Nov 24, 2026
//   u25: We removed your post / Oct 22, 2026 / [post] I mean, try me / Oct 20, 2026 / You shared this on your profile
function parseNotice(nodesIn) {
  const all = boxed(nodesIn);
  const f = frame(all);
  // only the notice's own lines: under its title bar, above its bottom button ("See why") - never
  // whatever else the dump holds (a bottom bar, a list behind it)
  const titleN = noticeTitle(all, f);
  const button = all.filter((n) => n.bounds.t > f.top + f.span * 0.5 && NOTICE_BUTTON.test(lbl(n)) && !NOTICE_TITLE.test(lbl(n)))
    .sort((a, b) => a.bounds.t - b.bounds.t)[0];
  const from = titleN ? titleN.bounds.b - 6 : f.top;
  const to = button ? button.bounds.t + 6 : f.top + f.span * 0.88;
  const nodes = all.filter((n) => n.bounds.t >= from && n.bounds.b <= to).sort((a, b) => a.bounds.t - b.bounds.t || a.bounds.l - b.bounds.l);
  const rows = [];
  for (const n of nodes) { const s = lbl(n); if (s && !rows.some((r) => r.s === s && Math.abs(r.n.bounds.t - n.bounds.t) < 20)) rows.push({ n, s }); }
  const head = rows.find((r) => NOTICE_HEAD.test(r.s))
    || rows.find((r) => !NOTICE_TITLE.test(r.s) && !NOTICE_BUTTON.test(r.s) && !parseDate(r.s) && r.s.length > 12);
  const after = rows.filter((r) => !head || r.n.bounds.t > head.n.bounds.t);
  const dateRow = after.find((r) => parseDate(r.s) && !UNTIL.test(r.s));
  const untilRow = rows.find((r) => UNTIL.test(r.s) && parseDate(r.s));
  const body = after.filter((r) => r !== dateRow && !NOTICE_TITLE.test(r.s) && !NOTICE_BUTTON.test(r.s)).map((r) => ig.redact(r.s, '').replace(/…$/, ''));
  const title = head ? head.s : '';
  const kind = noticeKind(title) || noticeKind(body.join(' ')) || 'other';
  return { kind, title: clip(title, 120), detail: clip(body.join(' · '), 200), date: dateRow ? parseDate(dateRow.s) : '', until: untilRow ? parseDate(untilRow.s) : '' };
}
// The notice's X (top right). Never "See why" - that is at the bottom and is FORBIDDEN anyway.
function noticeCloseTarget(nodesIn) {
  const nodes = boxed(nodesIn);
  const f = frame(nodes);
  const top = nodes.filter((n) => n.bounds.b <= f.top + f.span * 0.14);
  const c = top.find((n) => /^(close|dismiss|done)$/i.test(norm(n.desc)) || /^(close|dismiss|[x×✕✖])$/i.test(norm(n.text))
    || (/(^|\/)(close|close_button|dismiss_button|action_bar_button_close|igds_headline_close_button|navigation_close)/i.test(n.id) && !FORBIDDEN.test(lbl(n))));
  if (c) return ig.tapTarget(nodes, c);
  // an unlabelled icon in the corner is the X only of a "What happened" page whose title sits in that
  // same title bar (anywhere else the corner holds other things - a DM thread's call buttons)
  if (noticeTitle(nodes, f)) {
    const icon = top.filter((n) => n.clickable && !lbl(n) && n.cx > f.w * 0.8 && (n.bounds.r - n.bounds.l) < f.w * 0.2).sort((a, b) => b.cx - a.cx)[0];
    if (icon) return icon;
  }
  return null;
}
// A restriction counts while it lasts: no end date printed = still on.
function statusFor(state, notices, today) {
  if (state !== 'checked') return null;
  const on = (notices || []).some((n) => n.kind === 'restriction' && (!n.until || !today || n.until >= today));
  return on ? 'RESTRICTED' : 'HEALTHY';
}

// ---- 5. login screens ------------------------------------------------------------------------
// The accounts a login screen still offers ("Continue as x", a saved-account row), lower-case.
function parseLoginRemembered(nodesIn) {
  const nodes = boxed(nodesIn);
  const out = [];
  const add = (v) => { const u = handleOf(v); if (u && !out.includes(u)) out.push(u); };
  for (const n of nodes) {
    for (const s of labelsOf(n)) {
      const m = /^(?:continue as|log in as|log into|switch to)\s+@?([a-z0-9._]{2,30})$/i.exec(s);
      if (m) add(m[1]);
      else if (!/EditText/.test(n.cls) || (n.text && !is(n, /username|email|mobile|phone|password/i))) {
        if (HANDLE.test(s.replace(/^@/, '')) && !/^(log|sign|create|forgot)/i.test(s)) add(s);
      }
    }
  }
  return out.slice(0, 6);
}

// ---- 6. the profile header -------------------------------------------------------------------
// The username off the action bar: the title by id, else the handle-shaped text in the bar (the
// title is left-aligned on some builds and centred with "+" on its left on others).
function headerUsername(nodes, h) {
  const bar = nodes.filter((n) => n.bounds.t < (h || 2400) * 0.13);
  for (const n of bar) {
    if (/action_bar_title|action_bar_textview_title|profile_header_username|title_view/.test(n.id)) { const v = handleOf(n.text) || handleOf(n.desc); if (v) return { username: v, node: n }; }
  }
  // TEXT only: the bar's icons read out names too ("Muse", "Create", "Options"), and the title is
  // the one thing in the bar that is written
  const c = bar.map((n) => ({ n, v: handleOf(n.text) })).filter((x) => x.v)
    .sort((a, b) => a.n.bounds.t - b.n.bounds.t || a.n.bounds.l - b.n.bounds.l);
  return c.length ? { username: c[0].v, node: c[0].n } : { username: '', node: null };
}
// posts / followers / following off the header (igstats.countsFrom: resource-id, "N label", number
// over its label), the display name above the counts, and the dashboard row's "44.3K views in the
// last 30 days."
function parseProfileHeader(nodesIn) {
  const nodes = boxed(nodesIn);
  const { w, h } = size(nodes);
  const head = headerUsername(nodes, h);
  const c = st.countsFrom(nodes);
  const inl = st.dashboardInline(nodes);
  const dash = dashboardRow(nodes);
  // the name: a line above the counts, in the counts' column (the avatar's note bubble sits left of it)
  let name = '';
  const postsLbl = first(nodes, /^posts?$/i, (n) => n.bounds.t < h * 0.45) || first(nodes, /^\d[\d.,]*\s?[KMB]?\s*posts?$/i, (n) => n.bounds.t < h * 0.45);
  if (postsLbl) {
    const num = /posts?$/i.test(lbl(postsLbl)) && count(lbl(postsLbl)) == null ? numberNear(nodes, postsLbl) : null;
    const anchor = num && num.node.bounds.t < postsLbl.bounds.t ? num.node : postsLbl;
    const byId = nodes.find((n) => /full_name|profile_header_name|profile_header_full_name/.test(n.id) && norm(n.text));
    const cand = byId || nodes.filter((n) => norm(n.text) && n.bounds.b <= anchor.bounds.t + 6 && n.bounds.t >= h * 0.12 && n.bounds.l >= anchor.bounds.l - 40
      && count(lbl(n)) == null && handleOf(n.text) !== head.username && !/^(posts?|followers?|following)$/i.test(lbl(n)))
      .sort((a, b) => b.bounds.b - a.bounds.b)[0];
    if (cand) name = clip(cand.text, 60);
  }
  return {
    username: head.username, name,
    posts: c.posts, followers: c.followers, following: c.following,
    views_30d: inl.views != null && (inl.days == null || inl.days === 30) ? inl.views : null,
    views_days: inl.views != null ? inl.days : null,
    has_dashboard: !!dash, own: has(nodes, /^(edit|share) profile$/i) || !!dash,
    // "personal" is only concluded with the profile's buttons in sight: the dashboard row sits above
    // them, so with them visible a missing row really is missing (not scrolled out of view)
    buttons: has(nodes, /^(edit|share) profile$/i),
    w, h,
  };
}

// ---- 7. the accounts sheet -------------------------------------------------------------------
// Rows above "Add Instagram account", in its column (the sheet may be drawn over the profile, whose
// texts are then in the same dump - the column and the band keep them out). Never tapped.
function parseSwitcher(nodesIn, activeUsername) {
  const nodes = boxed(nodesIn);
  const { w, h } = size(nodes);
  const add = first(nodes, /^add (instagram )?account$/i);
  const center = first(nodes, /^(go to )?accounts center$/i);
  const anchor = add || center;
  if (!anchor) return [];
  const rows = [];
  for (const n of nodes) {
    if (n === anchor || n.bounds.b > anchor.bounds.t + 4 || n.bounds.t < anchor.bounds.t - 6 * 200 || n.bounds.t < h * 0.13) continue;
    if (add ? Math.abs(n.bounds.l - add.bounds.l) > 60 : n.cx > w * 0.8) continue;
    const u = handleOf(n.text);   // written usernames only - icons on the rows read out other words
    if (u && !rows.some((r) => r.username === u)) rows.push({ username: u, node: n });
  }
  const want = String(activeUsername || '').toLowerCase();
  // a check mark on a row = the active account (when the build reads it out); else the header's
  const marked = rows.find((r) => nodes.some((m) => m !== r.node && Math.abs(m.cy - r.node.cy) < 60 && m.cx > w * 0.7
    && (m.checked || m.selected || /^(selected|checked|current( account)?|active|check ?mark)$/i.test(norm(m.desc)))));
  return rows.sort((a, b) => a.node.bounds.t - b.node.bounds.t)
    .map((r) => ({ username: r.username, active: marked ? r === marked : r.username === want }));
}

// ---- 8. "Your dashboard" ---------------------------------------------------------------------
//   Insights  Oct 9 - Nov 7 / Views ↗ 44.3K > / New followers 0 > / Content you shared 10 >
function parseDashboard(nodesIn, today) {
  const nodes = boxed(nodesIn);
  const { w } = size(nodes);
  const out = { range: '', days: null, views: null, new_followers: null, content_shared: null };
  for (const n of nodes) { const r = parseRange(lbl(n), today); if (r) { out.range = r.text; out.days = r.days; break; } }
  const ROWS = [['views', /^views$/i], ['new_followers', /^new followers$/i], ['content_shared', /^content you shared$/i]];
  const labels = [], values = [];
  for (const n of nodes) {
    for (const [k, re] of ROWS) if (is(n, re)) labels.push({ key: k, node: n, sec: 'rows' });
    if (n.cx > w * 0.55) { const v = count(lbl(n)); if (v != null) values.push({ value: v, node: n, sec: 'rows' }); }
  }
  for (const [l, v] of rowsToValues(labels, values)) if (out[l.key] == null) out[l.key] = v;
  for (const [k, re] of ROWS) {   // a row read out as one node: "Views, 44.3K"
    if (out[k] != null) continue;
    const word = re.source.slice(1, -1);
    for (const n of nodes) { const m = new RegExp(`^${word}[,:]?\\s+([\\d][\\d.,]*\\s?[KMB]?)$`, 'i').exec(lbl(n)); if (m) { out[k] = count(m[1]); break; } }
  }
  return out;
}

// ---- 9. Insights: Overview -------------------------------------------------------------------
const OV_HEADS = [
  { key: 'views_type', re: /^views by content type$/i },
  { key: 'top_views', re: /^top content by views$/i },
  { key: 'inter_type', re: /^interactions by content type$/i },
  { key: 'profile_activity', re: /^profile activity$/i },
];
// rows above a screen's first header: the section before it (the thumbnails of "Top content" have no rows)
const OV_BEFORE = { views_type: 'top', top_views: 'views_type', inter_type: 'views_type', profile_activity: 'inter_type' };
const TYPE_ROWS = [['reels', /^reels$/i], ['stories', /^stories$/i], ['posts', /^posts$/i], ['live', /^live( videos?)?$/i]];
const ACTIVITY_ROWS = [['profile_visits', /^profile visits$/i], ['bio_link_taps', /^(bio link taps|external link taps|website taps|link taps)$/i], ['business_address_taps', /^business address taps$/i]];
const TILES = [['views', /^views$/i], ['net_followers', /^net followers$/i], ['interactions', /^interactions?$/i], ['viewers', /^(accounts reached|reach)$/i]];
function typeRow() { return { reels: null, stories: null, posts: null, live: null }; }
function newOverview() {
  return { views: null, net_followers: null, interactions: null, viewers: null, followers_pct_of_views: null, non_followers_pct_of_views: null,
    profile_visits: null, bio_link_taps: null, business_address_taps: null, views_by_type: typeRow(), interactions_by_type: typeRow(),
    days: null, tiles_seen: [], more_tiles: false, _sec: null };
}
const PCT_ONLY = /^<?\s*[+-]?\s*\d[\d.,]*\s*%$/;
// One screen of the Overview tab, merged over what earlier screens gave (`prev`): a number found
// once is kept. Tiles "Views 44,321" / "Net followers --" / "Interactions 969", "0.4% followers /
// 99.6% non-followers", "Viewers 20,198", views and interactions by content type, profile activity.
function parseOverview(nodesIn, prev) {
  const ov = prev ? clone(prev) : newOverview();
  const all = boxed(nodesIn);
  const { w, h } = size(all);
  const nodes = belowChrome(all);
  const set = (o, k, v) => { if (o[k] == null && v != null) o[k] = v; };
  const heads = headsOf(nodes, OV_HEADS);
  const carry = prev ? prev._sec : null;
  const sec = (n) => sectionAt(n.bounds.t, heads, OV_BEFORE, carry);
  const per = first(nodes, /^\d{1,3} days$/i);
  if (per && ov.days == null) ov.days = parseInt(labelsOf(per).find((s) => /^\d{1,3} days$/i.test(s)), 10);
  // tiles: label on top, number under it, left-aligned in the tile; only above the first section
  for (const [k, re] of TILES) {
    const inTop = (n) => n.bounds.t < h * 0.6 && (sec(n) === 'top' || (!heads.length && !carry));
    // a tile read out as one node ("Views, 44,321" / "Net followers --")
    const one = new RegExp(`^${re.source.slice(1, -1)}[,:]?\\s+([+-]?\\s*\\d[\\d.,]*\\s?[KMB]?|-+)$`, 'i');
    const whole = nodes.find((n) => inTop(n) && labelsOf(n).some((t) => one.test(t)));
    if (whole) {
      if (!ov.tiles_seen.includes(k)) ov.tiles_seen.push(k);
      if (whole.bounds.r >= w - 4) ov.more_tiles = true;
      const t = labelsOf(whole).find((x) => one.test(x));
      set(ov, k, signedCount(one.exec(t)[1]));
      continue;
    }
    const l = nodes.find((n) => is(n, re) && inTop(n));
    if (!l) continue;
    if (!ov.tiles_seen.includes(k)) ov.tiles_seen.push(k);
    if (l.bounds.r >= w - 4) ov.more_tiles = true;   // cut by the screen's edge: the row scrolls sideways
    // the tile's number: the first number under its label, left-aligned with it ("--" = nothing yet)
    const v = nodes.filter((n) => n !== l && n.bounds.t >= l.bounds.b - 6 && n.bounds.t - l.bounds.b < 150 && Math.abs(n.bounds.l - l.bounds.l) < 50
      && signedCount(lbl(n)) != null).sort((a, b) => a.bounds.t - b.bounds.t)[0];
    if (v) set(ov, k, signedCount(lbl(v)));
  }
  // "0.4% followers" / "99.6% non-followers" (one node, or the % and the word side by side)
  for (const n of nodes) {
    const s = lbl(n);
    let m = /^(<?\s*\d[\d.,]*\s*%)\s*(non-?followers|followers)$/i.exec(s);
    if (!m && PCT_ONLY.test(s)) {
      const nx = nodes.find((x) => x !== n && Math.abs(x.cy - n.cy) < 24 && x.bounds.l >= n.bounds.r - 6 && x.bounds.l - n.bounds.r < 60 && /^(non-?followers|followers)$/i.test(lbl(x)));
      if (nx) m = [s, s, lbl(nx)];
    }
    if (!m) continue;
    set(ov, /^non/i.test(m[2]) ? 'non_followers_pct_of_views' : 'followers_pct_of_views', parsePct(m[1]));
  }
  // rows
  const labels = [], values = [];
  for (const n of nodes) {
    const s = sec(n);
    if (!s) continue;
    // a row read out as one node: "Viewers, 20,198" / "Reels 43.3K" / "Profile visits: 2,253"
    for (const t of labelsOf(n)) {
      const m = /^(reels|stories|posts|live(?: videos?)?|viewers|profile visits|bio link taps|external link taps|website taps|link taps|business address taps)[,:]?\s+(\d[\d.,]*\s?[KMB]?)$/i.exec(t);
      const v = m ? count(m[2]) : null;
      if (v == null) continue;
      const word = m[1].toLowerCase();
      if (word === 'viewers') { if (s === 'views_type') set(ov, 'viewers', v); }
      else if (/^(reels|stories|posts|live)/.test(word)) {
        const key = word.startsWith('live') ? 'live' : word;
        if (s === 'views_type') set(ov.views_by_type, key, v); else if (s === 'inter_type') set(ov.interactions_by_type, key, v);
      } else if (s === 'profile_activity') set(ov, word === 'profile visits' ? 'profile_visits' : /business/.test(word) ? 'business_address_taps' : 'bio_link_taps', v);
    }
    if (s === 'views_type' || s === 'inter_type') {
      for (const [k, re] of TYPE_ROWS) if (is(n, re)) labels.push({ key: k, node: n, sec: s });
      if (s === 'views_type' && is(n, /^viewers$/i)) labels.push({ key: 'viewers', node: n, sec: s });
    }
    if (s === 'profile_activity') for (const [k, re] of ACTIVITY_ROWS) if (is(n, re)) labels.push({ key: k, node: n, sec: s });
    if (n.cx > w * 0.55) { const v = count(lbl(n)); if (v != null) values.push({ value: v, node: n, sec: s }); }
  }
  for (const [l, v] of rowsToValues(labels, values)) {
    if (l.key === 'viewers') set(ov, 'viewers', v);
    else if (l.sec === 'views_type') set(ov.views_by_type, l.key, v);
    else if (l.sec === 'inter_type') set(ov.interactions_by_type, l.key, v);
    else set(ov, l.key, v);
  }
  ov._sec = sectionAt(h, heads, OV_BEFORE, carry);
  return ov;
}
function overviewDone(ov) {
  return ov.profile_visits != null && ov.interactions_by_type.live != null && ov.views_by_type.live != null && ov.viewers != null;
}

// ---- 10. Insights: Audience ------------------------------------------------------------------
const AUD_HEADS = [
  { key: 'growth', re: /^follower growth over time$/i },
  { key: 'top_follows', re: /^top content by follows$/i },
  { key: 'gender', re: /^gender$/i },
  { key: 'age', re: /^age range$/i },
  { key: 'locations', re: /^top locations$/i },
  { key: 'active', re: /^follower active times$/i },
  { key: 'most_active', re: /^when followers are most active$/i },
];
const AUD_BEFORE = { growth: 'followers', top_follows: 'growth', gender: 'top_follows', age: 'gender', locations: 'age', active: 'locations', most_active: 'active' };
const WEEKDAY = { sun: 'Sun', mon: 'Mon', tues: 'Tue', tue: 'Tue', wednes: 'Wed', wed: 'Wed', thurs: 'Thu', thu: 'Thu', fri: 'Fri', satur: 'Sat', sat: 'Sat' };
const TIME_RANGE = /^(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$/i;
function newAudience() {
  return { followers: null, growth_pct: null, under_100: false, gender: null, age: null, countries: null, cities: null, us_pct: null,
    active_times: null, _sec: null };
}
function hourSlot(s) {
  const m = /^(12|3|6|9)\s*([ap])\.?(m\.?)?$/i.exec(norm(s));
  return m ? m[1] + m[2].toLowerCase() : null;
}
// The day chips Su M Tu W Th F Sa: a row of at least five of them.
function dayChips(nodesIn) {
  const nodes = boxed(nodesIn);
  const chips = nodes.filter((n) => DAYS.includes(norm(n.text) || norm(n.desc)));
  for (const c of chips) {
    const row = chips.filter((x) => Math.abs(x.cy - c.cy) < 30);
    if (row.length >= 5) {
      const byDay = {};
      for (const x of row) { const d = norm(x.text) || norm(x.desc); if (!byDay[d]) byDay[d] = x; }
      return { byDay, top: Math.min(...row.map((x) => x.bounds.t)), bottom: Math.max(...row.map((x) => x.bounds.b)) };
    }
  }
  return null;
}
function isPlace(n, w) {
  const s = lbl(n);
  if (!s || s.length < 2 || n.cx > w * 0.5 || parsePct(s) != null || count(s) != null || /\d\s*%/.test(s)) return false;
  if (/^(countries|cities|top locations|info|more info|information|about this|learn more|overview|content|audience|insights)$/i.test(s)) return false;
  return /[a-z]/i.test(s);
}
// What a bar reads out loud, when the build gives it a value: a percentage ("12a, 9%", "Sunday 12 AM:
// 9%") or a bare number ("40"). Its slot alone ("12a", "12 AM") is not a value - taking the first
// number of the read-out turned a whole day into the hours 12, 3, 6, 9.
function barValue(desc) {
  const s = norm(desc);
  const m = /(\d[\d.,]*)\s*%/.exec(s);
  if (m) return parsePct(m[1] + '%');
  return /^\d[\d.,]*$/.test(s) ? count(s) : null;
}
const SLOT_HOURS = [12, 3, 6, 9, 12, 3, 6, 9];
// The bars of the chosen day: no numbers are printed, so each bar's height as a share of the
// tallest one (or the value a bar reads out, when the build gives it one). Only when the hour
// labels under the chart are on screen - a chart cut by the screen's edge is read after a scroll.
function readBars(nodes, w, h, sec) {
  const hours = {};
  for (const n of nodes) { const s = hourSlot(n.text); if (s && !hours[s] && (sec(n) === 'active' || sec(n) == null)) hours[s] = n; }
  const found = SLOTS.filter((s) => hours[s]);
  if (found.length < 6) return null;
  const axisTop = Math.min(...found.map((s) => hours[s].bounds.t));
  const chips = dayChips(nodes);
  const top = chips ? chips.bottom : 0;
  const cand = nodes.filter((n) => n.bounds.b <= axisTop + 4 && n.bounds.t >= top - 2 && !norm(n.text) && sec(n) === 'active'
    && (!norm(n.desc) || /\d/.test(norm(n.desc)))
    && (n.bounds.r - n.bounds.l) >= w * 0.025 && (n.bounds.r - n.bounds.l) <= w * 0.16 && (n.bounds.b - n.bounds.t) >= 2);
  if (!cand.length) return null;
  const bottoms = {};
  for (const n of cand) { const k = Math.round(n.bounds.b / 8); bottoms[k] = (bottoms[k] || 0) + 1; }
  const base = 8 * +Object.keys(bottoms).sort((a, b) => bottoms[b] - bottoms[a])[0];
  const bars = cand.filter((n) => Math.abs(n.bounds.b - base) <= 10);
  const raw = SLOTS.map((s) => {
    const x = hours[s] ? hours[s].cx : null;
    if (x == null) return null;
    const b = bars.filter((n) => Math.abs(n.cx - x) < w * 0.06).sort((a, c) => Math.abs(a.cx - x) - Math.abs(c.cx - x))[0];
    if (!b) return null;
    return { h: b.bounds.b - b.bounds.t, said: barValue(b.desc) };
  });
  // read-outs that are only the hours under the chart (12, 3, 6, 9, ...) are the slots, not values
  const hoursOnly = raw.every((r, i) => !r || r.said == null || r.said === SLOT_HOURS[i]);
  const useSaid = raw.filter((r) => r && r.said != null).length >= 6 && !hoursOnly;
  const vals = raw.map((r) => (r == null ? null : useSaid ? r.said : r.h));
  const max = Math.max(0, ...vals.filter((v) => v != null));
  if (!(max > 0) || vals.filter((v) => v != null).length < 6) return null;
  return vals.map((v) => (v == null ? null : Math.round((v / max) * 1000) / 1000));
}
function readMostActive(nodes, sec) {
  const out = [];
  const rows = nodes.filter((n) => sec(n) === 'most_active' && lbl(n)).sort((a, b) => a.bounds.t - b.bounds.t || a.bounds.l - b.bounds.l);
  const push = (day, range) => {
    const d = WEEKDAY[day.toLowerCase()];
    const m = TIME_RANGE.exec(norm(range));
    if (!d || !m) return;
    const t = (x) => norm(x).toUpperCase().replace(/\./g, '').replace(/\s*([AP]M)$/, ' $1');
    const item = { day: d, from: t(m[1]), to: t(m[2]) };
    if (!out.some((x) => x.day === item.day && x.from === item.from && x.to === item.to)) out.push(item);
  };
  for (let i = 0; i < rows.length; i++) {
    const s = lbl(rows[i]);
    let m = /^(sun|mon|tues|wednes|thurs|fri|satur)days?[\s,:]+(.+)$/i.exec(s);
    if (m && TIME_RANGE.test(norm(m[2]))) { push(m[1], m[2]); continue; }
    m = /^(sun|mon|tues|wednes|thurs|fri|satur)days?$/i.exec(s);
    if (!m) continue;
    const nx = rows.slice(i + 1).find((x) => x.bounds.t >= rows[i].bounds.t - 4 && x.bounds.t - rows[i].bounds.b < 90 && TIME_RANGE.test(lbl(x)));
    if (nx) push(m[1], lbl(nx));
  }
  return out;
}
function usPct(countries) {
  const us = (countries || []).find((c) => /^(united states( of america)?|usa|us|u\.s\.)$/i.test(c.name));
  return us ? us.pct : null;
}
// One screen of the Audience tab, merged over earlier screens. opts.loc: which location chip is on
// ('countries' is Instagram's default), opts.day: the day chip just tapped ('Su'..'Sa').
function parseAudience(nodesIn, prev, opts) {
  const o = opts || {};
  const au = prev ? clone(prev) : newAudience();
  const all = boxed(nodesIn);
  const { w, h } = size(all);
  const nodes = belowChrome(all);
  const heads = headsOf(nodes, AUD_HEADS);
  const carry = prev ? prev._sec : null;
  const sec = (n) => sectionAt(n.bounds.t, heads, AUD_BEFORE, carry);
  if (has(nodes, /at least 100 followers/i)) au.under_100 = true;
  // the followers number: under "Followers" (100+), or over it (the under-100 page)
  if (au.followers == null) {
    const fl = nodes.find((n) => is(n, /^followers$/i) && n.bounds.t < h * 0.45 && (sec(n) === 'followers' || sec(n) == null));
    const v = fl ? numberNear(nodes, fl) : null;
    if (v) au.followers = v.value;
  }
  // "+435.1% since Oct 9" (one node, or the % and "since Oct 9" side by side)
  if (au.growth_pct == null) {
    for (const n of nodes) {
      const s = lbl(n);
      if (/\bsince\b/i.test(s) && parsePct(s) != null) { au.growth_pct = parsePct(s); break; }
      if (PCT_ONLY.test(s) && (sec(n) === 'followers' || sec(n) == null)
        && nodes.some((x) => x !== n && Math.abs(x.cy - n.cy) < 24 && x.bounds.l >= n.bounds.r - 6 && /^since\b/i.test(lbl(x)))) { au.growth_pct = parsePct(s); break; }
    }
  }
  // gender, age, locations: label on the left, the % at the right end of its bar
  const labels = [], values = [];
  const place = (key, name, v) => {
    au[key] = au[key] || [];
    if (!au[key].some((x) => x.name.toLowerCase() === name.toLowerCase())) au[key].push({ name: clip(name, 60), pct: v });
  };
  for (const n of nodes) {
    const s = sec(n);
    if (!s) continue;
    // a row read out as one node: "Women, 2.1%" / "18-24 10.2%" / "United States, 53.1%"
    for (const t of labelsOf(n)) {
      const m = /^(.+?)[,:]?\s+(<?\s*\d[\d.,]*\s*%)$/.exec(t);
      const v = m ? parsePct(m[2]) : null;
      if (v == null) continue;
      const name = m[1].trim();
      if (s === 'gender' && /^(women|men)$/i.test(name)) { au.gender = au.gender || { women: null, men: null }; const g = name.toLowerCase(); if (au.gender[g] == null) au.gender[g] = v; }
      else if (s === 'age' && AGES.includes(name)) { au.age = au.age || {}; if (au.age[name] == null) au.age[name] = v; }
      else if (s === 'locations' && /[a-z]/i.test(name) && !/^(countries|cities|top locations)$/i.test(name)) place(o.loc === 'cities' ? 'cities' : 'countries', name, v);
    }
    if (s === 'gender') { if (is(n, /^women$/i)) labels.push({ key: 'women', node: n, sec: s }); else if (is(n, /^men$/i)) labels.push({ key: 'men', node: n, sec: s }); }
    else if (s === 'age') { const a = AGES.find((x) => lbl(n) === x); if (a) labels.push({ key: a, node: n, sec: s }); }
    else if (s === 'locations') { if (isPlace(n, w)) labels.push({ key: lbl(n), node: n, sec: s }); }
    const t = lbl(n);
    if (n.cx > w * 0.55 && /%$/.test(t)) { const p = parsePct(t); if (p != null) values.push({ value: p, node: n, sec: s }); }
  }
  for (const [l, v] of rowsToValues(labels, values)) {
    if (l.sec === 'gender') { au.gender = au.gender || { women: null, men: null }; if (au.gender[l.key] == null) au.gender[l.key] = v; }
    else if (l.sec === 'age') { au.age = au.age || {}; if (au.age[l.key] == null) au.age[l.key] = v; }
    else place(o.loc === 'cities' ? 'cities' : 'countries', l.key, v);
  }
  // active times: the time zone line, the chosen day's bars, the most active windows
  // the zone from whichever label carries it (the text and the read-out can differ on a build)
  const tzN = first(nodes, /time zone \(([^)]+)\)/i);
  const tz = tzN ? labelsOf(tzN).map((s) => /time zone \(([^)]+)\)/i.exec(s)).find(Boolean) : null;
  const ensureAT = () => (au.active_times = au.active_times || { tz: '', days: {}, top: [] });
  if (tz) ensureAT().tz = tz[1].trim();
  if (o.day && DAYS.includes(o.day)) { const b = readBars(nodes, w, h, sec); if (b) ensureAT().days[o.day] = b; }
  const top = readMostActive(nodes, sec);
  if (top.length) { const at = ensureAT(); for (const t of top) if (!at.top.some((x) => x.day === t.day && x.from === t.from && x.to === t.to)) at.top.push(t); }
  au.us_pct = usPct(au.countries);
  au._sec = sectionAt(h, heads, AUD_BEFORE, carry);
  return au;
}
function hoursVisible(nodes) { return SLOTS.filter((s) => boxed(nodes).some((n) => hourSlot(n.text) === s)).length >= 6; }

// ---- 11. tap targets -------------------------------------------------------------------------
// Instagram's bottom bar as a box: its container by id, or the strip its named tabs sit in.
function tabStrip(nodes, w, h) {
  const bar = nodes.find((n) => /(^|\/)tab_bar$/.test(n.id) && n.bounds.t >= h * 0.8);
  if (bar) return bar.bounds;
  const items = nodes.filter((n) => n.bounds.t >= h * 0.86 && (NAV_ID.test(n.id) || NAV_WORD.test(norm(n.desc)) || NAV_WORD.test(norm(n.text))));
  if (items.length < 3) return null;
  return { l: 0, t: Math.min(...items.map((n) => n.bounds.t)), r: w, b: Math.max(...items.map((n) => n.bounds.b)) };
}
// The profile tab: its exact name, then its id, then a name that mentions "profile" - the last two
// only inside the bottom bar's own box. A post's Save / Like button sits just above that bar and is
// never a candidate (a Save there would be a write on a real account).
function profileTab(nodesIn) {
  const nodes = boxed(nodesIn);
  const { w, h } = size(nodes);
  const strip = tabStrip(nodes, w, h);
  const inStrip = (n) => !!strip && n.bounds.t >= strip.t - 4 && n.bounds.b <= strip.b + 4;
  const n = nodes.find((x) => /^(profile|your profile)$/i.test(norm(x.desc)) && x.bounds.t >= h * 0.8 && (!strip || inStrip(x)))
    || nodes.find((x) => /(^|\/)(profile_tab|tab_avatar)$/.test(x.id))
    || nodes.find((x) => /profile/i.test(norm(x.desc)) && x.clickable && inStrip(x));
  if (n) return ig.tapTarget(nodes, n);
  if (!strip) return null;
  // last resort: the bar's right-most item (Instagram has always put the profile last)
  const items = nodes.filter((x) => x.clickable && inStrip(x) && (x.bounds.r - x.bounds.l) < w * 0.3).sort((a, b) => b.cx - a.cx);
  return items[0] || null;
}
// The "Your dashboard" row of the PROFILE (its whole box when it is one).
function dashboardRow(nodesIn) {
  const nodes = boxed(nodesIn);
  const { h } = size(nodes);
  const n = first(nodes, /^(your|professional) dashboard$/i, (x) => x.bounds.t > h * 0.12)
    || first(nodes, /\d\s?[KMB]?\s+(views|accounts reached)\b.*\blast\s+\d+\s+days/i, (x) => x.bounds.t > h * 0.12)
    || nodes.find((x) => /professional_dashboard|pro_dashboard|insights_entry|dashboard_entry/.test(x.id) && x.bounds.t > h * 0.12);
  return n ? ig.tapTarget(nodes, n) : null;
}
// The dashboard's "Views" row (inside "Insights"), never anything under "Your tools".
function viewsRow(nodesIn) {
  const nodes = boxed(nodesIn);
  const tools = first(nodes, /^(your tools|next steps|monetization|tips and resources)$/i);
  const n = first(nodes, /^views$/i, (x) => !tools || x.bounds.b <= tools.bounds.t);
  return n ? ig.tapTarget(nodes, n) : null;
}
// "Overview" / "Audience" under the Insights title (never "Content").
function tabTarget(nodesIn, name) {
  if (!/^(overview|audience)$/i.test(name)) return null;
  const nodes = boxed(nodesIn);
  const { h } = size(nodes);
  const n = nodes.find((x) => lbl(x).toLowerCase() === name.toLowerCase() && x.bounds.t < h * 0.22);
  return n ? ig.tapTarget(nodes, n) : null;
}
// "Countries" / "Cities", or a day chip Su..Sa (from the chip row only).
function chipTarget(nodesIn, name) {
  const nodes = boxed(nodesIn);
  if (DAYS.includes(name)) { const r = dayChips(nodes); return r && r.byDay[name] ? ig.tapTarget(nodes, r.byDay[name]) : null; }
  if (!/^(countries|cities)$/i.test(name)) return null;
  const n = nodes.find((x) => lbl(x).toLowerCase() === name.toLowerCase());
  return n ? ig.tapTarget(nodes, n) : null;
}
// The action-bar title (the username): opens the accounts sheet.
function titleTarget(nodesIn, username) {
  const nodes = boxed(nodesIn);
  const { h } = size(nodes);
  const head = headerUsername(nodes, h);
  if (!head.node || (username && head.username !== String(username).toLowerCase())) return null;
  return ig.tapTarget(nodes, head.node);
}
// The Overview tiles' row, for its one sideways swipe.
function tileRow(nodesIn) {
  const nodes = boxed(nodesIn);
  const { w, h } = size(nodes);
  const tile = (n) => TILES.some(([, re]) => is(n, re) || labelsOf(n).some((t) => new RegExp(`^${re.source.slice(1, -1)}[,:]?\\s+\\S`, 'i').test(t)));
  const ls = nodes.filter((n) => tile(n) && n.bounds.t < h * 0.6);
  if (!ls.length) return null;
  // the swipe runs through the tiles: just under a label, or through the middle of a whole-tile node
  const y = Math.round(ls.reduce((a, n) => a + n.cy, 0) / ls.length) + (ls.some((n) => is(n, /^(views|net followers|interactions?)$/i)) ? 40 : 0);
  return { y, x1: Math.round(w * 0.85), x2: Math.round(w * 0.15), more: ls.some((n) => n.bounds.r >= w - 4) };
}
// The last word before a tap: never on a FORBIDDEN label, never on the accounts sheet, never inside a
// conversation (a DM thread / story reply / comments with no bottom bar: Back is the way out).
function tapRefused(nodesIn, x, y) {
  const nodes = boxed(nodesIn || []);
  if (nodes.length && isSwitcher(nodes)) return 'the accounts sheet is open';
  if (nodes.length) { const f = frame(nodes); if (!tabBar(nodes, f.h) && conversation(nodes, f)) return 'a conversation is open'; }
  const hit = nodes.find((n) => inside(n, x, y) && labelsOf(n).some((s) => FORBIDDEN.test(s)));
  return hit ? `"${lbl(hit)}" is never tapped` : '';
}

// ---- 12. the visit ---------------------------------------------------------------------------
// driver: { dump() -> xml, tap(x, y), key('back'|'home'), swipe(x1, y1, x2, y2, ms), wait(ms),
//           now()?, viewer()? -> bool, launch()?, openProfile(username)?, unlock()? }
// opts:   { appPkg, insights, others, today: 'YYYY-MM-DD', budgetMs, log(line)? }
// Returns the reply's body: { state, status, username, accounts, notices, remembered, why, screens,
// trace, aborted? }. Never throws for anything the phone shows; a viewer opening the phone ends it
// as state 'device_busy', why 'viewer_opened' (core.js puts the phone back and replies ok:false).
class Stop extends Error { constructor() { super('stop'); } }
class Abort extends Error { constructor(why) { super(why); this.why = why; } }

function context(driver, o) {
  const now = driver.now || (() => Date.now());
  const t0 = now();
  const R = { state: 'unreadable', status: 'UNKNOWN', username: '', accounts: [], notices: [], remembered: [], why: '', screens: [], trace: [] };
  const k = { notice: 0, popup: 0, promo: 0, other: 0, launch: 0, unlock: 0, dumps: 0, back: 0 };
  let viewerAt = -Infinity;
  const ctx = {
    driver, o, R, k, now, nodes: [],
    deadline: t0 + (o.budgetMs || DEFAULT_BUDGET_MS),
    left() { return ctx.deadline - now(); },
    note(name, ok, matched) {
      const e = { name, ok: !!ok, matched: String(matched == null ? '' : matched).slice(0, 160), ms: now() - t0 };
      if (R.trace.length < 160) R.trace.push(e);
      if (o.log) { try { o.log(`${name}${ok ? '' : ' [!]'} ${e.matched}`); } catch {} }
    },
    // "someone opened the phone": checked after every wait and right before every tap / swipe / key
    async viewer(force) {
      if (!driver.viewer) return;
      const t = now();
      if (!force && t - viewerAt < VIEWER_RECHECK_MS) return;
      viewerAt = t;
      if (await driver.viewer()) { ctx.note('viewer', false, 'someone opened the phone - stopping'); throw new Abort('viewer_opened'); }
    },
    async wait(ms) { await driver.wait(ms); await ctx.viewer(true); },
    async dump() {
      if (++k.dumps > MAX_DUMPS) stop(ctx, 'unreadable', 'UNKNOWN', 'too_many_screens');
      let xml = '';
      try { xml = await driver.dump(); } catch { xml = ''; }
      ctx.nodes = boxed(ig.parseDump(xml));
      return ctx.nodes;
    },
    async tap(node, why) {
      const refused = tapRefused(ctx.nodes, node.cx, node.cy);
      if (refused) { ctx.note('tap', false, `${why}: refused, ${refused}`); return false; }
      await ctx.viewer(false);
      await driver.tap(node.cx, node.cy);
      ctx.note('tap', true, `${why} "${clip(lbl(node), 50)}" @${node.cx},${node.cy}`);
      return true;
    },
    async key(name, why) { await ctx.viewer(false); await driver.key(name); ctx.note('key', true, `${name.toUpperCase()} - ${why}`); },
    async swipe(x1, y1, x2, y2, ms, why) {
      await ctx.viewer(false);
      await driver.swipe(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), ms);
      ctx.note('swipe', true, `${why} (${Math.round(x1)},${Math.round(y1)})->(${Math.round(x2)},${Math.round(y2)})`);
    },
    // the screens kept for tuning (texts + ids, emails / phone numbers masked); `must` = always kept
    shot(at, nodes, must) {
      const s = { at, pkg: ig.screenPkg(nodes), ...ig.describe(nodes || [], '') };
      if (R.screens.length < MAX_SCREENS) R.screens.push(s);
      else if (must) R.screens[MAX_SCREENS - 1] = s;
    },
  };
  return ctx;
}
function stop(ctx, state, status, why, extra) {
  ctx.R.state = state; ctx.R.status = status; ctx.R.why = why || '';
  if (extra) Object.assign(ctx.R, extra);
  ctx.note('result', state !== 'unreadable', `${state} / ${status}${why ? ' (' + why + ')' : ''}`);
  throw new Stop();
}
// The screens that can turn up at any moment, handled the same wherever they appear. Returns true
// when it acted (look again), false when the screen is not one of them; ends the visit (Stop) for
// a logged-out or blocked account and for loops that do not go away.
async function interrupt(ctx, nodes, c) {
  const { k, R } = ctx;
  switch (c.kind) {
    case 'notice': {
      if (k.notice >= MAX_NOTICES) { ctx.shot('notice', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'notice_loop'); }
      k.notice++;
      const n = c.detail.notice;
      if (!R.notices.some((x) => x.title === n.title && x.date === n.date)) R.notices.push(n);
      ctx.shot('notice', nodes);
      ctx.note('screen', true, `notice ${n.kind}: ${clip(n.title, 70)}${n.until ? ' (ends ' + n.until + ')' : ''}`);
      if (!(c.detail.close && await ctx.tap(c.detail.close, 'notice X'))) await ctx.key('back', 'notice without an X');
      await ctx.wait(1500);
      return true;
    }
    case 'popup': {
      if (k.popup >= MAX_POPUPS) { ctx.shot('popup', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'popup_loop'); }
      k.popup++;
      ctx.shot('popup', nodes);
      if (!(await ctx.tap(c.detail.target, 'dismiss'))) await ctx.key('back', 'pop-up');
      await ctx.wait(1200);
      return true;
    }
    case 'promo_back': {
      if (k.promo >= MAX_PROMO_BACKS) { ctx.shot('promo', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'promo_loop'); }
      k.promo++;
      ctx.shot('promo', nodes);
      await ctx.key('back', `promo (${c.detail.why})`);
      await ctx.wait(1200);
      return true;
    }
    case 'other_app': {
      if (k.other >= MAX_OTHER_APP) { ctx.shot('other_app', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'left_app', { pkg: c.detail.pkg || '' }); }
      k.other++;
      ctx.shot('other_app', nodes);
      await ctx.key('back', `another app on top (${c.detail.pkg || '?'})`);
      await ctx.wait(1500);
      return true;
    }
    case 'keyguard': {
      if (k.unlock >= MAX_UNLOCK || !ctx.driver.unlock) { ctx.shot('keyguard', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'screen_locked'); }
      k.unlock++;
      await ctx.viewer(false);
      await ctx.driver.unlock();
      ctx.note('unlock', true, 'lock screen: dismiss-keyguard, menu, swipe up');
      await ctx.wait(1500);
      return true;
    }
    case 'launcher': {
      if (k.launch >= MAX_LAUNCH || !ctx.driver.launch) { ctx.shot('launcher', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'ig_not_in_front'); }
      k.launch++;
      await ctx.viewer(false);
      await ctx.driver.launch();
      ctx.note('launch', true, 'home screen - starting Instagram again');
      await ctx.wait(3000);
      return true;
    }
    case 'no_account':
      ctx.shot('no_account', nodes, true);
      return stop(ctx, 'logged_out', 'NO_ACCOUNT', '');   // stop() always throws
    case 'login':
      R.remembered = c.detail.remembered || [];
      ctx.shot('login', nodes, true);
      return stop(ctx, 'logged_out', 'LOGIN_REQUIRED', '');
    case 'checkpoint': case 'challenge': case 'suspended': case 'disabled': {
      const status = { checkpoint: 'CHECKPOINT', challenge: 'CHALLENGE_REQUIRED', suspended: 'SUSPENDED', disabled: 'DISABLED' }[c.kind];
      if (c.detail.username && !R.username) R.username = c.detail.username;
      ctx.shot(c.kind, nodes, true);
      return stop(ctx, 'blocked', status, c.detail.text || '');
    }
    default: return false;
  }
}
// Deeper Instagram screens left open (by a previous run, or by Instagram resuming where it was):
// Back, a few times.
async function backOutOfDeep(ctx, c) {
  if (!['switcher', 'dashboard', 'insights_overview', 'insights_audience'].includes(c.kind) || ctx.k.back >= 6) return false;
  ctx.k.back++;
  await ctx.key('back', `${c.kind} still open`);
  await ctx.wait(1200);
  return true;
}
// Step 5: from whatever Instagram opened on to the feed or the profile.
async function reachMain(ctx) {
  const end = ctx.now() + (ctx.o.loopMs || LOOP_MS);
  let unknown = 0, firstShot = true, anything = false;
  while (true) {
    const nodes = await ctx.dump();
    const c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
    if (nodes.length) anything = true;
    if (firstShot) { ctx.shot('start', nodes); firstShot = false; }
    if (c.kind === 'feed' || c.kind === 'profile') { ctx.note('screen', true, c.kind); return { nodes, c }; }
    if (await interrupt(ctx, nodes, c)) { unknown = 0; continue; }
    if (await backOutOfDeep(ctx, c)) continue;
    // when in doubt, Back: at once out of a conversation (a DM thread the app resumed in), after three
    // looks at any other screen nobody knows
    if (c.kind === 'unknown' && (c.detail.conversation || ++unknown >= 3) && ctx.k.back < 6) {
      unknown = 0; ctx.k.back++;
      await ctx.key('back', c.detail.conversation ? 'a conversation is open' : 'unrecognised screen');
      await ctx.wait(1500);
      continue;
    }
    if (ctx.now() >= end) {
      ctx.shot('unrecognised', nodes, true);
      // empty_dump: uiautomator never gave a screen (the phone, not Instagram, is the problem)
      stop(ctx, 'unreadable', 'UNKNOWN', c.detail && c.detail.why === 'app_not_responding' ? 'app_not_responding' : anything ? 'unrecognised_screen' : 'empty_dump');
    }
    await ctx.wait(1500);
  }
}
// Step 6: the own profile's header.
async function readOwnProfile(ctx, start) {
  const end = ctx.now() + PROFILE_WAIT_MS;
  let nodes = start.nodes, c = start.c, taps = 0, best = null;
  while (true) {
    if (c.kind === 'profile' && c.detail.own) {
      const hd = parseProfileHeader(nodes);
      if (hd.username) { best = { hd, nodes }; if (hd.followers != null || hd.posts != null) break; }
    } else if ((c.kind === 'feed' || c.kind === 'profile') && taps < 2) {
      const t = profileTab(nodes);
      if (!t) { ctx.shot('feed', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'header_not_found', { detail: 'no profile tab on the screen' }); }
      taps++;
      if (await ctx.tap(t, 'profile tab')) await ctx.wait(2500);
      else { await ctx.key('back', 'something covers the profile tab'); await ctx.wait(1200); }   // a sheet over the bar
      nodes = await ctx.dump(); c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
      continue;
    } else if (await interrupt(ctx, nodes, c) || await backOutOfDeep(ctx, c)) {
      nodes = await ctx.dump(); c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
      continue;
    }
    if (ctx.now() >= end) break;
    await ctx.wait(1000);
    nodes = await ctx.dump(); c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
  }
  if (!best) { ctx.shot('profile', nodes, true); stop(ctx, 'unreadable', 'UNKNOWN', 'header_not_found'); }
  ctx.shot('profile', best.nodes);
  return best;
}
// Look until one of `kinds` is on screen (handling pop-ups and notices on the way), at most `ms`.
async function waitFor(ctx, kinds, ms, accept) {
  const end = ctx.now() + ms;
  while (true) {
    const nodes = await ctx.dump();
    const c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
    if (kinds.includes(c.kind) && (!accept || accept(nodes, c))) return { nodes, c };
    if (await interrupt(ctx, nodes, c)) continue;
    if (ctx.now() >= end) return { nodes, c, timeout: true };
    await ctx.wait(1000);
  }
}
// Tap, then wait for the next screen; when the screen did not move (a tooltip or an animation took
// the tap), tap once more. `again(nodes, c)` finds the target again on the screen we are still on.
async function tapUntil(ctx, target, why, kinds, ms, again) {
  let t = target, s = null;
  for (let i = 0; i < 2 && t; i++) {
    if (!(await ctx.tap(t, i ? `${why} (again)` : why))) break;
    await ctx.wait(2500);
    s = await waitFor(ctx, kinds, ms);
    if (!s.timeout) return s;
    t = again ? again(s.nodes, s.c) : null;
  }
  return s || { timeout: true, nodes: ctx.nodes, c: classifyScreen(ctx.nodes, { appPkg: ctx.o.appPkg }) };
}
// Back until the own profile is on screen again (verified), at most four times.
async function backToProfile(ctx) {
  for (let i = 0; i < 5; i++) {
    const nodes = await ctx.dump();
    const c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
    if (c.kind === 'profile' && c.detail.own) return { nodes, c };
    if (await interrupt(ctx, nodes, c)) continue;
    if (c.kind === 'feed') { const t = profileTab(nodes); if (t && await ctx.tap(t, 'profile tab')) { await ctx.wait(2000); continue; } }
    if (i === 4) break;
    await ctx.key('back', 'back to the profile');
    await ctx.wait(1200);
  }
  return null;
}
function signature(nodes) { return nodes.filter((n) => lbl(n)).map((n) => lbl(n) + '@' + n.bounds.t).join('|'); }
// Insights keeps its title and the Overview / Content / Audience tabs pinned at the top while the
// list scrolls under them: nothing above the tabs' bottom edge is content (a screen that starts in
// the middle of the cities would otherwise read the "Overview" tab as a city).
function belowChrome(all) {
  const { h } = size(all);
  const tabs = all.filter((n) => /^(overview|content|audience)$/i.test(lbl(n)) && n.bounds.t < h * 0.22);
  const cut = tabs.length ? Math.max(...tabs.map((n) => n.bounds.b)) + 2 : 0;
  return cut ? all.filter((n) => n.bounds.t >= cut) : all;
}
function emptyInsights(why) {
  return { range: '', days: null, views: null, interactions: null, viewers: null, net_followers: null, new_followers: null, content_shared: null,
    followers_pct_of_views: null, non_followers_pct_of_views: null, profile_visits: null, bio_link_taps: null,
    views_by_type: typeRow(), interactions_by_type: typeRow(), followers: null, growth_pct: null, under_100: false,
    gender: null, age: null, countries: null, cities: null, us_pct: null, active_times: null, why: why || [] };
}
// Insights failures never fail the check: a soft stop (unreadable) inside a later step is turned
// into a reason for that step, and the account read so far stands. So is an ERROR: an adb call that
// failed or timed out (the Mac's phones answer slowly at busy moments) or a screen this file did not
// expect - the step ends there with "error: ..." as its reason. Only a person opening the phone
// (Abort / core's viewer guard) and a logged-out or blocked account found on the way end the visit.
async function soft(ctx, fn) {
  const saved = { state: ctx.R.state, status: ctx.R.status, why: ctx.R.why };
  try { return { ok: true, value: await fn() }; } catch (e) {
    if (e instanceof Abort || (e && e.viewer)) throw e;
    if (e instanceof Stop) {
      if (ctx.R.state !== 'unreadable') throw e;
      const why = ctx.R.why; Object.assign(ctx.R, saved); return { ok: false, why };
    }
    const why = 'error: ' + clip((e && e.message) || e, 80);
    ctx.note('error', false, why);
    Object.assign(ctx.R, saved);
    return { ok: false, why };
  }
}
// Step 7: "Your dashboard" -> "Views" -> Insights Overview -> Audience, then back to the profile.
async function readInsights(ctx, profileNodes) {
  const ins = emptyInsights([]);
  const t0 = ctx.now();
  const budget = Math.min(ctx.o.insightsMs || INSIGHTS_MS, ctx.left() - MIN_LEFT.sheet);
  const late = () => ctx.now() - t0 > budget;
  const why = (s) => { if (!ins.why.includes(s)) ins.why.push(s); };
  const cls = (n) => classifyScreen(n, { appPkg: ctx.o.appPkg });
  // what the tabs gave so far: folded into `ins` at the end, also when the step stops half-way
  let ov = null, au = null;
  const r = await soft(ctx, async () => {
    // a) the dashboard
    const row = dashboardRow(profileNodes);
    if (!row) { why('dashboard row not found'); return; }
    const d = await tapUntil(ctx, row, '"Your dashboard" row', ['dashboard'], 8000, (n, c) => (c.kind === 'profile' ? dashboardRow(n) : null));
    if (d.timeout) { why('the dashboard did not open'); ctx.shot('dashboard?', d.nodes); return; }
    ctx.shot('dashboard', d.nodes);
    const dash = parseDashboard(d.nodes, ctx.o.today);
    Object.assign(ins, { range: dash.range, days: dash.days, new_followers: dash.new_followers, content_shared: dash.content_shared });
    if (dash.views != null) ins.views = dash.views;
    if (!dash.range) why('dashboard period not found');
    // b) Views -> Insights, Overview tab
    const vr = viewsRow(d.nodes);
    if (!vr) { why('dashboard Views row not found'); return; }
    let s = await tapUntil(ctx, vr, 'dashboard "Views" row', ['insights_overview', 'insights_audience'], 8000, (n, c) => (c.kind === 'dashboard' ? viewsRow(n) : null));
    if (s.timeout) { why('Insights did not open'); ctx.shot('insights?', s.nodes); return; }
    if (s.c.kind === 'insights_audience') {   // the app remembered the last tab
      const t = tabTarget(s.nodes, 'Overview');
      if (t) s = await tapUntil(ctx, t, 'Insights tab', ['insights_overview'], 6000, (n, c) => (c.kind === 'insights_audience' ? tabTarget(n, 'Overview') : null));
    }
    if (!s.timeout && s.c.kind === 'insights_overview') {
      ctx.shot('overview', s.nodes);
      ov = parseOverview(s.nodes, null);
      const tr = tileRow(s.nodes);
      if (tr && tr.more && !late()) {   // ONE sideways swipe: the tiles hidden to the right
        await ctx.swipe(tr.x1, tr.y, tr.x2, tr.y, 500, 'Overview tiles left');
        await ctx.wait(1000);
        ov = parseOverview(await ctx.dump(), ov);
      }
      let sig = signature(ctx.nodes);
      const { w, h } = size(ctx.nodes);
      for (let i = 0; i < 7 && !late() && !overviewDone(ov); i++) {
        await ctx.swipe(w / 2, h * 0.78, w / 2, h * 0.34, 800, 'Overview scroll');
        await ctx.wait(1200);
        let n2 = await ctx.dump();
        const c2 = cls(n2);
        if (c2.kind !== 'insights_overview' && c2.kind !== 'insights_audience') { if (await interrupt(ctx, n2, c2)) n2 = await ctx.dump(); else break; }
        const sg = signature(n2);
        if (sg === sig) break;   // the bottom: the screen stopped changing
        sig = sg;
        ov = parseOverview(n2, ov);
      }
      if (late() && !overviewDone(ov)) why('time up in the Overview tab');
    } else why('Overview tab not reached');
    if (late()) { why('time up before the Audience tab'); return; }
    // c) Audience
    const at = tabTarget(ctx.nodes, 'Audience');
    if (!at) { why('Audience tab not found'); return; }
    const a = await tapUntil(ctx, at, 'Insights tab', ['insights_audience'], 6000, (n, c) => (c.kind === 'insights_overview' ? tabTarget(n, 'Audience') : null));
    if (a.timeout) { why('Audience tab did not open'); ctx.shot('audience?', a.nodes); return; }
    ctx.shot('audience', a.nodes);
    let loc = 'countries', citiesDone = false, cityTaps = 0, daysDone = false, revs = 0;
    au = parseAudience(a.nodes, null, { loc });
    let nodes = a.nodes, sig = signature(nodes);
    const { w, h } = size(nodes);
    for (let i = 0; i < 12 && !au.under_100 && !late(); i++) {
      // Cities: once the countries list is complete (five rows, or the next section is in sight)
      if (!citiesDone && au.countries && au.countries.length && (au.countries.length >= 5 || has(nodes, /^follower active times$/i))) {
        const chip = chipTarget(nodes, 'Cities');
        if (chip && cityTaps < 2) {
          cityTaps++;
          if (!(await ctx.tap(chip, cityTaps > 1 ? 'location chip (again)' : 'location chip'))) { citiesDone = true; continue; }
          await ctx.wait(1200);
          nodes = await ctx.dump();
          const countries = au.countries.map((c) => c.name.toLowerCase());
          const next = parseAudience(nodes, au, { loc: 'cities' });
          // the tap did not take when every "city" is one of the countries just read: read nothing
          if (next.cities && next.cities.length && next.cities.every((c) => countries.includes(c.name.toLowerCase()))) {
            if (cityTaps >= 2) { why('the Cities chip did not switch the list'); citiesDone = true; }
            continue;
          }
          au = next; loc = 'cities'; citiesDone = true;
          continue;
        }
        if (!chip && revs < 3) { revs++; await ctx.swipe(w / 2, h * 0.45, w / 2, h * 0.70, 600, 'back up to the location chips'); await ctx.wait(1000); nodes = await ctx.dump(); au = parseAudience(nodes, au, { loc }); continue; }
        if (!chip) citiesDone = true;
      }
      // active times: every day chip, when the chips and the chart's hour labels share the screen
      if (!daysDone && (hoursVisible(nodes) || has(nodes, /^follower active times$/i))) {
        const chips = dayChips(nodes);
        if (chips && hoursVisible(nodes)) {
          daysDone = true;
          let prev = null;
          for (const day of DAYS) {
            if (late()) { why('time up in the active times'); break; }
            // the same bars as the day before = the tap did not take (a real week never repeats to
            // the pixel): one more tap, then the bars are taken as they are
            for (let k = 0; k < 2; k++) {
              const t = chipTarget(nodes, day);
              if (!t || !(await ctx.tap(t, k ? 'day chip (again)' : 'day chip'))) { why(`day chip ${day} not found`); break; }
              await ctx.wait(800);
              nodes = await ctx.dump();
              au = parseAudience(nodes, au, { loc, day });
              const got = au.active_times && au.active_times.days[day];
              if (!(got && prev && JSON.stringify(got) === JSON.stringify(prev))) break;
              if (k === 1) why(`active-time bars for ${day} equal the day before (the chip may not have switched)`);
            }
            if (!(au.active_times && au.active_times.days[day])) why(`active-time bars for ${day} not read`);
            else prev = au.active_times.days[day];
          }
          sig = signature(nodes);
        } else if (!chips && hoursVisible(nodes) && revs < 3) {
          revs++; await ctx.swipe(w / 2, h * 0.45, w / 2, h * 0.70, 600, 'back up to the day chips'); await ctx.wait(1000);
          nodes = await ctx.dump(); au = parseAudience(nodes, au, { loc }); continue;
        }
      }
      if (daysDone && au.active_times && au.active_times.top.length && citiesDone) break;
      await ctx.swipe(w / 2, h * 0.78, w / 2, h * 0.34, 800, 'Audience scroll');
      await ctx.wait(1200);
      let n2 = await ctx.dump();
      const c2 = cls(n2);
      if (c2.kind !== 'insights_audience' && c2.kind !== 'insights_overview') { if (await interrupt(ctx, n2, c2)) n2 = await ctx.dump(); else break; }
      const sg = signature(n2);
      if (sg === sig) break;
      sig = sg; nodes = n2;
      au = parseAudience(nodes, au, { loc });
    }
    if (!au.under_100 && late()) why('time up in the Audience tab');
  });
  if (!r.ok) why(`stopped: ${r.why}`);
  // what the Overview and the Audience gave, also when the step stopped half-way
  if (ov) {
    for (const k of ['views', 'interactions', 'viewers', 'net_followers', 'followers_pct_of_views', 'non_followers_pct_of_views', 'profile_visits', 'bio_link_taps']) {
      if (ov[k] != null) ins[k] = ov[k];
    }
    ins.views_by_type = ov.views_by_type; ins.interactions_by_type = ov.interactions_by_type;
    if (ins.days == null && ov.days) ins.days = ov.days;
    for (const [k, label] of [['views', 'Views tile'], ['interactions', 'Interactions tile'], ['viewers', 'Viewers'], ['profile_visits', 'Profile visits']]) if (ov[k] == null) why(`${label} not found`);
  }
  if (au) {
    Object.assign(ins, { followers: au.followers, growth_pct: au.growth_pct, under_100: au.under_100, gender: au.gender, countries: au.countries, cities: au.cities, us_pct: au.us_pct });
    ins.age = au.age ? AGES.reduce((o, k) => (o[k] = au.age[k] != null ? au.age[k] : null, o), {}) : null;
    if (au.active_times && (Object.keys(au.active_times.days).length || au.active_times.top.length)) {
      ins.active_times = { tz: au.active_times.tz, days: au.active_times.days, top: au.active_times.top };
    }
    if (!au.under_100) {
      if (!au.gender) why('gender not found');
      if (!au.age) why('age range not found');
      if (!au.countries) why('countries not found');
      if (!au.cities) why('cities not read');
      if (!ins.active_times || !Object.keys(ins.active_times.days).length) why('active-time bars not read');
      if (!ins.active_times || !ins.active_times.top.length) why('most active times not found');
    }
  }
  // d) back to the profile, verified
  const back = await soft(ctx, () => backToProfile(ctx));
  if (!back.ok || !back.value) why('did not get back to the profile');
  return ins;
}
// Step 8: the accounts sheet (tap the title, read, Back). Returns [{username, active}] or null.
async function readAccountsSheet(ctx, username) {
  let nodes = await ctx.dump();
  let c = classifyScreen(nodes, { appPkg: ctx.o.appPkg });
  if (!(c.kind === 'profile' && c.detail.own)) { const b = await backToProfile(ctx); if (!b) return { list: null, why: 'not on the profile' }; nodes = b.nodes; }
  const t = titleTarget(nodes, username);
  if (!t) return { list: null, why: 'the title (username) is not tappable on this screen' };
  const s = await tapUntil(ctx, t, 'title (accounts sheet)', ['switcher'], SHEET_WAIT_MS, (n, c) => (c.kind === 'profile' && c.detail.own ? titleTarget(n, username) : null));
  if (s.timeout) {
    ctx.shot('sheet?', s.nodes);
    if (!(s.c.kind === 'profile' && s.c.detail.own)) await backToProfile(ctx);
    return { list: null, why: 'the accounts sheet did not open' };
  }
  ctx.shot('switcher', s.nodes);
  const list = parseSwitcher(s.nodes, username);
  await ctx.key('back', 'close the accounts sheet');
  await ctx.wait(1000);
  nodes = await ctx.dump();
  if (classifyScreen(nodes, { appPkg: ctx.o.appPkg }).kind === 'switcher') { await ctx.key('back', 'close the accounts sheet (again)'); await ctx.wait(1000); }
  return { list, why: list.length ? '' : 'no account rows on the sheet' };
}
// Step 9: another account of this app, by its public profile (VIEW intent) - counts only.
async function visitAccount(ctx, acc) {
  await ctx.viewer(false);
  await ctx.driver.openProfile(acc.username);
  ctx.note('visit', true, `opened instagram.com/${acc.username}/`);
  await ctx.wait(2000);
  const s = await waitFor(ctx, ['profile'], VISIT_WAIT_MS, (nodes) => headerUsername(nodes, size(nodes).h).username === acc.username);
  if (!s.timeout) {
    const hd = parseProfileHeader(s.nodes);
    Object.assign(acc, { name: hd.name, posts: hd.posts, followers: hd.followers, following: hd.following, read: 'visit' });
  } else ctx.shot('visit?', s.nodes);
  await ctx.key('back', 'leave the visited profile');
  await ctx.wait(1200);
}
function account(username, active) {
  return { username, active, name: '', posts: null, followers: null, following: null, views_30d: null, read: 'list', account_type: '', insights: null };
}
async function check(driver, opts) {
  const o = Object.assign({ appPkg: IG_PKG, insights: true, others: true, today: '' }, opts || {});
  const ctx = context(driver, o);
  const R = ctx.R;
  try {
    const start = await reachMain(ctx);
    const prof = await readOwnProfile(ctx, start);
    const hd = prof.hd;
    R.username = hd.username;
    const me = Object.assign(account(hd.username, true), {
      name: hd.name, posts: hd.posts, followers: hd.followers, following: hd.following, views_30d: hd.views_30d, read: 'own',
      account_type: hd.has_dashboard ? 'professional' : (hd.buttons && (hd.followers != null || hd.posts != null) ? 'personal' : ''),
    });
    R.accounts.push(me);
    R.state = 'checked'; R.status = 'HEALTHY';
    if (hd.followers == null && hd.posts == null && hd.following == null) R.why = 'counts_not_found';
    ctx.note('profile', true, `@${hd.username}: ${hd.posts} posts, ${hd.followers} followers, ${hd.following} following, ${hd.views_30d} views/30d, ${me.account_type || 'type ?'}`);
    // step 7
    if (o.insights !== false && hd.has_dashboard) {
      me.insights = ctx.left() > MIN_LEFT.insights ? await readInsights(ctx, prof.nodes) : emptyInsights(['skipped: not enough time left in the check']);
    }
    // step 8 + 9
    if (o.others !== false) {
      if (ctx.left() > MIN_LEFT.sheet) {
        const r = await soft(ctx, () => readAccountsSheet(ctx, hd.username));
        const sheet = r.ok ? r.value : { list: null, why: r.why };
        if (sheet.why) ctx.note('accounts', false, sheet.why);
        const others = (sheet.list || []).filter((a) => a.username !== hd.username);
        for (const a of others.slice(0, 8)) R.accounts.push(account(a.username, false));
        let visits = 0;
        for (const acc of R.accounts.filter((a) => !a.active)) {
          if (visits >= MAX_VISITS || !driver.openProfile || ctx.left() < MIN_LEFT.visit) break;
          visits++;
          const v = await soft(ctx, () => visitAccount(ctx, acc));
          if (!v.ok) ctx.note('visit', false, `${acc.username}: ${v.why}`);
        }
      } else ctx.note('accounts', false, 'skipped: not enough time left in the check');
    }
  } catch (e) {
    // a person opened the phone: our own check (Abort) or core's guard inside a driver call (e.viewer)
    if (e instanceof Abort || (e && e.viewer)) { R.state = 'device_busy'; R.status = 'UNKNOWN'; R.why = 'viewer_opened'; R.aborted = true; }
    else if (e instanceof Stop) { /* the result is in R already */ }
    // an error once the account was read keeps the read (core would otherwise reply "failed" with no
    // account at all); before that there is nothing to keep, and core replies "failed" with the error
    else if (R.state === 'checked') ctx.note('error', false, 'after the account was read: ' + clip((e && e.message) || e, 120));
    else throw e;
  }
  return finish(ctx);
}
function finish(ctx) {
  const R = ctx.R;
  if (R.state === 'checked') R.status = statusFor('checked', R.notices, ctx.o.today);
  if (R.username) {   // the username stays out of the evidence, like igpost's traces
    for (const s of R.screens) s.texts = s.texts.map((t) => redactUser(t, R.username));
    for (const t of R.trace) t.matched = redactUser(t.matched, R.username).slice(0, 160);
  }
  return R;
}

// ---- 13. adb text parsers for core.js (pure, so they are tested) ------------------------------
// `dumpsys activity activities`: the resumed activity { uid, pkg, cls } (uid 0 may be printed with
// no "u0") and whether the keyguard is showing (null when the dump does not say).
function parseActivities(text) {
  const t = String(text || '');
  let resumed = null;
  for (const key of ['topResumedActivity', 'mResumedActivity', 'ResumedActivity', 'mFocusedApp']) {
    const m = new RegExp(`\\b${key}\\s*[:=]\\s*(?:ActivityRecord|AppWindowToken|Token)?\\{[0-9a-f]+\\s+(?:u(\\d+)\\s+)?([A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)`).exec(t);
    if (m) { resumed = { uid: m[1] != null ? parseInt(m[1], 10) : 0, pkg: m[2], cls: m[3] }; break; }
  }
  const k = /\b(?:mKeyguardShowing|KeyguardShowing|isKeyguardShowing|keyguardShowing|mShowingLockscreen)\s*[=:]\s*(true|false)/i.exec(t);
  return { resumed, keyguard: k ? k[1].toLowerCase() === 'true' : null };
}
// `dumpsys window`: the focused window and the keyguard flags. NotificationShade in focus = the
// lock screen (Android 12+) or the pulled-down shade - either way something covers the app.
function parseWindow(text) {
  const t = String(text || '');
  const m = /mCurrentFocus\s*=\s*Window\{[0-9a-f]+\s+(?:u(\d+)\s+)?([^\s}]+)/.exec(t);
  let focus = null;
  if (m) { const [pkg, cls] = m[2].split('/'); focus = { uid: m[1] != null ? parseInt(m[1], 10) : 0, pkg, cls: cls || '' }; }
  const k = /\b(?:mKeyguardShowing|isKeyguardShowing|keyguardShowing|mShowingLockscreen|mDreamingLockscreen)\s*[=:]\s*(true|false)/i.exec(t);
  const covered = !!(focus && /^(NotificationShade|StatusBar|Keyguard|Bouncer)/i.test(focus.pkg));
  return { focus, keyguard: k ? k[1].toLowerCase() === 'true' : (covered ? true : null), covered };
}
// `wm size`: the override when one is set, else the physical size.
function parseWmSize(text) {
  const t = String(text || '');
  const m = /Override size:\s*(\d+)x(\d+)/.exec(t) || /Physical size:\s*(\d+)x(\d+)/.exec(t);
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
}

module.exports = {
  // what a screen is, and what is on it
  classifyScreen, parseNotice, noticeCloseTarget, parseProfileHeader, parseSwitcher, parseLoginRemembered,
  parseDashboard, parseOverview, parseAudience, parsePct, parseDate, parseRange, statusFor, handleOf,
  // where a tap may land
  profileTab, dashboardRow, viewsRow, tabTarget, chipTarget, titleTarget, tileRow, dayChips, tapRefused,
  // the visit
  check, emptyInsights, newOverview, newAudience,
  // adb output, for core.js
  parseActivities, parseWindow, parseWmSize,
  SAFE_DISMISS, FORBIDDEN, DAYS, SLOTS, AGES, IG_PKG, LOOP_MS, INSIGHTS_MS, DEFAULT_BUDGET_MS,
};
