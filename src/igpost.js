'use strict';
// Instagram posting on the phone itself (v0.5.9, 2026-10-28). PURE + isolated, like ./instagram.js:
// nothing in this file touches adb. It turns a `uiautomator dump` into a list of screen elements,
// finds the element a step wants, and runs a step script against a small `driver` that core.js
// implements with adb (dump / tap / type / key / wait / screenshot). That split is what makes the
// whole flow testable with no phone (tools/test_igpost.js scripts the screens) and re-tunable when
// Instagram moves a button: the recognition rules are DATA (the FLOW_* step lists below), not code.
//
// WHY ON THE PHONE. The farm's accounts are ordinary logins inside Android profiles - no Business
// account, no Facebook page, no API token - so Meta's publishing API cannot reach them (that path
// exists in the CRM for the handful of creator accounts). The only way to post as those accounts
// is the way a VA does it: in the app, on the phone, in that profile. This file is that VA.
//
// PROVISIONAL SIGNATURES. Every resource-id / text / content-desc below is written from the
// Instagram Android build as known at the time of writing and has NOT yet been confirmed against
// the farm's phones. That is expected and designed for: run a job in `capture` mode (it stops
// before Share and returns the sanitized texts + ids of every screen it saw) and correct the
// selectors from what the phone actually showed. The STRUCTURE is the contract: a step names its
// candidates in priority order, dismisses known pop-ups when its target is missing, times out
// honestly, and never guesses that something was shared.

// ---- 1. the screen ---------------------------------------------------------------------------
// uiautomator XML -> [{ text, desc, id, cls, pkg, clickable, bounds:{l,t,r,b}, cx, cy }]. Attribute
// scraping per <node .../>; no XML parser needed and robust to Instagram's 40-deep hierarchies.
function parseDump(xml) {
  const out = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml || '')) !== null) {
    const a = m[1];
    const attr = (k) => { const r = new RegExp('\\b' + k + '="([^"]*)"').exec(a); return r ? unescapeXml(r[1]) : ''; };
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr('bounds') || '');
    const bounds = b ? { l: +b[1], t: +b[2], r: +b[3], b: +b[4] } : null;
    out.push({
      text: attr('text'), desc: attr('content-desc'), id: attr('resource-id'), cls: attr('class'), pkg: attr('package'),
      clickable: attr('clickable') === 'true', enabled: attr('enabled') !== 'false', focused: attr('focused') === 'true',
      // v0.5.15: which Insights tab / chip is chosen, when the build says so (the account check)
      selected: attr('selected') === 'true', checked: attr('checked') === 'true',
      bounds, cx: bounds ? Math.round((bounds.l + bounds.r) / 2) : 0, cy: bounds ? Math.round((bounds.t + bounds.b) / 2) : 0,
    });
  }
  return out;
}
function unescapeXml(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
}

// A selector: { id?, text?, desc?, cls?, clickable?, nth? }. Strings match case-insensitively as a
// substring; RegExps test. `id` matches the whole resource-id or the part after the last '/'.
function matches(node, sel) {
  const hit = (v, want) => {
    if (want == null) return true;
    if (want instanceof RegExp) return want.test(v);
    return String(v).toLowerCase().includes(String(want).toLowerCase());
  };
  if (sel.id != null) {
    const tail = node.id.includes('/') ? node.id.slice(node.id.lastIndexOf('/') + 1) : node.id;
    if (!(hit(node.id, sel.id) || hit(tail, sel.id))) return false;
  }
  if (!hit(node.text, sel.text)) return false;
  if (!hit(node.desc, sel.desc)) return false;
  if (!hit(node.cls, sel.cls)) return false;
  if (sel.pkg != null && !hit(node.pkg, sel.pkg)) return false;
  if (sel.clickable != null && node.clickable !== sel.clickable) return false;
  if (sel.focused != null && node.focused !== sel.focused) return false;
  if (sel.enabled !== false && node.enabled === false) return false;
  return true;
}
function find(nodes, sel) {
  const all = nodes.filter((n) => n.bounds && matches(n, sel));
  if (!all.length) return null;
  const i = sel.nth != null ? sel.nth : 0;
  return all[i < 0 ? all.length + i : i] || null;
}
function findAny(nodes, sels) {
  for (const sel of sels) { const n = find(nodes, sel); if (n) return { node: n, sel }; }
  return null;
}
// Something a tap can land on: the node itself if it has a size, else its nearest clickable
// ancestor is unknown (flat list) - so we climb by geometry: a clickable node that CONTAINS it.
function tapTarget(nodes, node) {
  if (node.clickable || !node.bounds) return node;
  const inside = nodes.filter((n) => n.clickable && n.bounds && n.bounds.l <= node.bounds.l && n.bounds.t <= node.bounds.t && n.bounds.r >= node.bounds.r && n.bounds.b >= node.bounds.b);
  if (!inside.length) return node;
  inside.sort((a, b) => ((a.bounds.r - a.bounds.l) * (a.bounds.b - a.bounds.t)) - ((b.bounds.r - b.bounds.l) * (b.bounds.b - b.bounds.t)));
  return inside[0];
}

// What a screen "is", for the trace and for the capture mode. Texts and ids only - never the raw
// XML - and a username, when given, is redacted so a trace is safe to store and show.
function describe(nodes, username) {
  const red = (s) => redact(s, username);
  const texts = [], ids = new Set();
  for (const n of nodes) {
    if (n.text) texts.push(red(n.text));
    else if (n.desc) texts.push(red(n.desc));
    if (n.id) ids.add(n.id.includes('/') ? n.id.slice(n.id.lastIndexOf('/') + 1) : n.id);
  }
  return { texts: [...new Set(texts)].slice(0, 60), ids: [...ids].slice(0, 80) };
}
function redact(s, username) {
  let v = String(s || '');
  if (username) v = v.replace(new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '<user>');
  return v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>').replace(/\+?\d[\d\s().-]{7,}\d/g, '<phone>').slice(0, 80);
}

// ---- 2. the steps ----------------------------------------------------------------------------
// Pop-ups Instagram throws in the middle of a flow ("Add your phone number?", "Turn on
// notifications?", "Share to Facebook?", a new-feature tour). If a step's target is missing and one
// of these is on screen, it is dismissed and the step looks again. "Not now" first: it is the one
// that never changes a setting.
// NOT "Continue" (v0.5.14). The first real post on the farm (2026-11-08, phone 40) met Instagram's
// promo for its "Edits" app right after the clip was picked; its only button was "Continue", which
// this list used to tap - and that button opens the Edits page on Google Play, in the browser. The
// post then failed three screens later at "caption". "Continue" ACCEPTS whatever is offered; it is
// never a way to make something go away. Android's own "Allow X to send you notifications?" prompt
// is answered "Don't allow" (the dump writes it with a curly apostrophe).
const DISMISS = [
  { text: /^not now$/i }, { desc: /^not now$/i }, { text: /^skip$/i }, { text: /^later$/i }, { text: /^maybe later$/i },
  { text: /^no,? thanks$/i }, { text: /^dismiss$/i },
  { text: /^close$/i, clickable: true }, { desc: /^close$/i, clickable: true }, { text: /^got it$/i }, { text: /^ok$/i }, { text: /^okay$/i },
  { text: /^don.?t allow$/i }, { id: /permission_deny_button/ }, { text: /^deny$/i }, { text: /^cancel$/i, clickable: true },
];
// Screens that only Back closes safely: promos whose buttons all ACCEPT the offer. Back on a bottom
// sheet or dialog closes it without its action, and Instagram's editor stays where it was.
const BACK_ON = [
  { text: /\b(try|get|open|download|install|use|continue in|edit in|made (with|in))\s+edits\b/i, why: 'edits_promo' },
  { text: /\bedits\b.{0,40}\b(app|by instagram|from instagram|from meta)\b/i, why: 'edits_promo' },
  { desc: /\b(try|get|open|download)\s+edits\b/i, why: 'edits_promo' },
];
const MAX_BACKS = 2;              // per step: more than that and something else is wrong - say so instead

// The package on top of the screen (the first node of a dump belongs to the active window).
function screenPkg(nodes) {
  const n = (nodes || []).find((x) => x.pkg);
  return n ? n.pkg : '';
}
// Texts that mean "the app is not where a post can be made" - a login wall, a block, a crash.
// The classifier in ./instagram.js owns the full taxonomy; this is the short-circuit a post needs.
const FATAL = [
  { text: /log in|phone number, username|forgot password/i, why: 'login_required' },
  { text: /suspended|disabled your account|we removed your account/i, why: 'account_blocked' },
  { text: /confirm it'?s you|verify your account|help us confirm|challenge/i, why: 'challenge' },
  { text: /isn'?t responding|keeps stopping|has stopped/i, why: 'app_crash' },
  { text: /couldn'?t (post|share|upload)|failed to (post|share|upload)|something went wrong/i, why: 'share_failed' },
];

// One step: { name, find: [selectors], action, text?, optional?, settle?, timeout?, until? }
//   action: 'tap' | 'type' | 'key' | 'wait' | 'done'
//   settle: ms to wait after the action (the next screen needs to draw)
//   timeout: how long to keep re-dumping until a candidate appears (default STEP_TIMEOUT)
//   optional: missing target is not a failure (a screen some builds skip)
//   guard: 'no-share' marks the step capture mode must stop BEFORE
const STEP_TIMEOUT_MS = 12000, POLL_MS = 1500;

// Flow A: pick the clip from the gallery through the app's own composer (no audio link).
//   + (create) -> Reel -> gallery: newest item -> Next -> Next -> caption -> Share
const FLOW_REEL = [
  { name: 'home', find: [{ id: /tab_bar|feed_tab|creation_tab|tab_avatar/ }, { desc: /^(home|reels|create|new post|profile)$/i }], action: 'wait', settle: 0, timeout: 15000 },
  { name: 'create', find: [{ id: /creation_tab/ }, { desc: /^(create|new post|new reel)$/i }, { desc: /^create/i }], action: 'tap', settle: 2500 },
  { name: 'choose-reel', find: [{ text: /^reel$/i }, { desc: /^reel$/i }, { text: /^reels$/i }, { id: /gallery_folder_menu_reels|reel_tab/ }], action: 'tap', optional: true, settle: 2500, timeout: 5000 },
  { name: 'gallery-newest', find: [{ id: /gallery_grid_item_thumbnail|gallery_grid_item_selection|media_thumbnail|gallery_item/ }, { desc: /^(video|photo) thumbnail/i }, { desc: /thumbnail/i }], action: 'tap', settle: 2500 },
  { name: 'add-or-next', find: [{ text: /^(add|next)$/i }, { desc: /^(add|next)$/i }, { id: /next_button|clips_right_action_button|right_action_button|action_bar_button_action/ }], action: 'tap', settle: 4000 },
  { name: 'editor-next', find: [{ text: /^next$/i }, { desc: /^next$/i }, { id: /clips_right_action_button|next_button|right_action_button/ }], action: 'tap', optional: true, settle: 3500, timeout: 8000 },
  { name: 'caption', find: [{ id: /caption_input_text_view|caption_text_view|caption_input|caption/ }, { text: /write a caption|add a caption/i }, { desc: /caption/i }], action: 'type', settle: 1200 },
  { name: 'share', find: [{ text: /^share$/i }, { desc: /^share$/i }, { id: /share_button|clips_share_button|share_footer_button/ }], action: 'tap', guard: 'no-share', settle: 3000 },
  { name: 'confirm', find: [{ text: /shared|sharing|posted|your reel|uploading|finishing up|reels/i }, { id: /tab_bar|feed_tab/ }], action: 'done', timeout: 120000 },
];

// Flow B: the owner pasted an audio link from Instagram's own library (audio page -> "Use audio").
//   open link in this profile -> Use audio -> camera with that sound -> gallery -> newest -> Add ->
//   Next -> caption -> Share
const FLOW_REEL_WITH_AUDIO = [
  { name: 'audio-page', find: [{ text: /^use audio$/i }, { desc: /^use audio$/i }, { text: /use audio/i }, { desc: /use audio/i }, { id: /use_in_camera_button|use_audio|audio_page_cta/ }], action: 'tap', settle: 4000, timeout: 20000, fallback: 'primary-button' },
  { name: 'camera-gallery', find: [{ id: /gallery_grid_item_thumbnail|camera_gallery_button|gallery_button|clips_gallery/ }, { desc: /^(open gallery|gallery|add from gallery|camera roll)/i }, { desc: /gallery/i }, { desc: /thumbnail/i }], action: 'tap', settle: 2500 },
  { name: 'gallery-newest', find: [{ id: /gallery_grid_item_thumbnail|gallery_grid_item_selection|media_thumbnail|gallery_item/ }, { desc: /^(video|photo) thumbnail/i }, { desc: /thumbnail/i }], action: 'tap', optional: true, settle: 2500, timeout: 6000 },
  { name: 'add-or-next', find: [{ text: /^(add|next)$/i }, { desc: /^(add|next)$/i }, { id: /next_button|clips_right_action_button|right_action_button|action_bar_button_action/ }], action: 'tap', settle: 4000 },
  { name: 'editor-next', find: [{ text: /^next$/i }, { desc: /^next$/i }, { id: /clips_right_action_button|next_button|right_action_button/ }], action: 'tap', optional: true, settle: 3500, timeout: 8000 },
  { name: 'caption', find: [{ id: /caption_input_text_view|caption_text_view|caption_input|caption/ }, { text: /write a caption|add a caption/i }, { desc: /caption/i }], action: 'type', settle: 1200 },
  { name: 'share', find: [{ text: /^share$/i }, { desc: /^share$/i }, { id: /share_button|clips_share_button|share_footer_button/ }], action: 'tap', guard: 'no-share', settle: 3000 },
  { name: 'confirm', find: [{ text: /shared|sharing|posted|your reel|uploading|finishing up|reels/i }, { id: /tab_bar|feed_tab/ }], action: 'done', timeout: 120000 },
];

// Words Instagram itself writes on the reel (v0.5.14). The owner wanted the text in "instagram's
// default" font, "anywhere I want", "plain white": that font is Instagram's own and no server may
// draw it, so the phone does what a VA does in the reel editor - the "Aa" text tool, type, Done
// (the default style IS plain white, no band), then drag the text to the spot picked on the page.
// Inserted before the editor's Next when a job carries text (withText). `text-place` waits for the
// editor to be back (its Next button), then drags from the text's centre to the target.
const TEXT_STEPS = [
  { name: 'text-tool', find: [{ desc: /^text$/i }, { text: /^aa$/i }, { desc: /^aa$/i }, { desc: /add text/i }, { text: /^text$/i },
    { id: /text_overlay_button|add_text|text_tool|clips_text|editor_text_button/ }], action: 'tap', settle: 1800, timeout: 10000 },
  { name: 'text-type', find: [{ cls: /EditText/, focused: true }, { cls: /EditText/ }], action: 'type-overlay', settle: 600, timeout: 8000 },
  { name: 'text-done', find: [{ text: /^done$/i }, { desc: /^done$/i }, { id: /text_done|done_button/ }], action: 'tap', settle: 1500, timeout: 8000 },
  { name: 'text-place', find: [{ text: /^next$/i }, { desc: /^next$/i }, { id: /clips_right_action_button|next_button|right_action_button/ }], action: 'drag-overlay', settle: 1200, timeout: 10000 },
];
// A flow with the text steps in it, just before the editor's Next. The built-in flows stay untouched.
function withText(flow) {
  const out = flow.slice();
  const i = out.findIndex((s) => s.name === 'editor-next');
  out.splice(i >= 0 ? i : out.length, 0, ...TEXT_STEPS);
  return out;
}
// What the phone can type into the text tool: printable ASCII and line breaks (`input text`), at most
// 8 lines / 300 characters - the same rule the backend applied when the post was made.
function overlayForDevice(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/[^\x20-\x7e\n]/g, '').split('\n').map((l) => l.trim());
  return lines.slice(0, 8).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 300);
}
// The screen's size: the largest box in the dump (the root window).
function screenSize(nodes) {
  let w = 0, h = 0;
  for (const n of nodes || []) if (n.bounds) { w = Math.max(w, n.bounds.r); h = Math.max(h, n.bounds.b); }
  return { w: w || 1080, h: h || 2400 };
}
// Where the reel is drawn in the editor: the biggest video/preview view that is reel-shaped; if the
// build names it differently, a full-width 9:16 box in the middle of the screen.
const CANVAS_ID = /clips_video_preview|video_preview|preview_view|media_preview|clips_editor|edit_preview|player_view|video_view|texture_view|surface_view|canvas/i;
function canvasRect(nodes, size) {
  const sz = size || screenSize(nodes);
  let best = null;
  for (const n of nodes || []) {
    if (!n.bounds) continue;
    const w = n.bounds.r - n.bounds.l, h = n.bounds.b - n.bounds.t;
    if (w < sz.w * 0.5 || h <= 0) continue;
    const ratio = h / w;
    if (ratio < 1.3 || ratio > 2.1) continue;
    if (!(CANVAS_ID.test(n.id) || /TextureView|SurfaceView|VideoView/.test(n.cls))) continue;
    if (!best || w * h > (best.r - best.l) * (best.b - best.t)) best = n.bounds;
  }
  if (best) return { l: best.l, t: best.t, w: best.r - best.l, h: best.b - best.t, found: true };
  const w = sz.w, h = Math.round(sz.w * 16 / 9);
  return { l: 0, t: Math.max(0, Math.round((sz.h - h) / 2)), w, h, found: false };
}
// The owner's spot (x/y = the centre of the text as a share of the reel) on the screen. Kept inside
// the same range the backend allows: off the edges, and above Instagram's caption area / trash bin.
function overlayTarget(rect, x, y) {
  const cx = Math.min(0.9, Math.max(0.1, Number.isFinite(+x) ? +x : 0.5));
  const cy = Math.min(0.8, Math.max(0.08, Number.isFinite(+y) ? +y : 0.5));
  return { x: Math.round(rect.l + cx * rect.w), y: Math.round(rect.t + cy * rect.h) };
}
// Where the new text sits before the drag: the node showing its first line when the build exposes it
// (never the text box it was typed in), else the middle of the reel, where Instagram puts new text.
function overlayStart(nodes, text, rect) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const n = first && (nodes || []).find((x) => x.bounds && !/EditText/.test(x.cls) && (x.text.trim() === first || x.desc.trim() === first));
  return n ? { x: n.cx, y: n.cy, found: true } : { x: Math.round(rect.l + rect.w / 2), y: Math.round(rect.t + rect.h / 2), found: false };
}

// Who is logged in: open the profile tab and read the title. The username is the one piece of
// text the profile screen shows in the action bar on every Instagram build so far.
const FLOW_WHOAMI = [
  { name: 'home', find: [{ id: /tab_bar|feed_tab|profile_tab|tab_avatar/ }, { desc: /^(home|profile)$/i }], action: 'wait', settle: 0, timeout: 15000 },
  { name: 'profile-tab', find: [{ id: /profile_tab|tab_avatar/ }, { desc: /^profile$/i }, { desc: /profile/i, clickable: true }], action: 'tap', settle: 2500 },
  { name: 'read', find: [{ id: /action_bar_title|action_bar_textview_title|title_view|profile_header_username|username/ }, { cls: /TextView/, text: /^[a-z0-9._]{2,30}$/i, nth: 0 }], action: 'done', timeout: 8000 },
];

const USERNAME_RE = /^[a-z0-9._]{2,30}$/i;
// The username off a profile screen: the action-bar title first, else the first short handle-like
// text in the top fifth of the screen (the header), else nothing - never a guess.
function usernameFrom(nodes, screenH) {
  const title = findAny(nodes, [{ id: /action_bar_title|action_bar_textview_title|profile_header_username/ }, { id: /title_view|title/ , text: USERNAME_RE }]);
  if (title && USERNAME_RE.test(title.node.text)) return title.node.text;
  const top = (screenH || 2400) / 5;
  const cands = nodes.filter((n) => n.bounds && n.bounds.t < top && USERNAME_RE.test(n.text) && !/^(home|reels|search|profile|edit|share|follow|message|settings)$/i.test(n.text));
  cands.sort((a, b) => a.bounds.t - b.bounds.t);
  return cands.length ? cands[0].text : '';
}

// ---- 3. the runner ---------------------------------------------------------------------------
// driver: { dump() -> xml, tap(x,y), type(text), key(name), wait(ms), screenshot()?, now()? }
// opts:   { caption, mode: 'post'|'capture', username, screenH, onStep(step, info)?, abort()? -> bool }
// Returns { ok, state, step, trace:[{name, ok, matched, ms, screen?}], screens?:[...], why? }.
//   state: 'shared' | 'captured' | 'failed' | 'aborted'
async function run(driver, flow, opts) {
  const o = opts || {};
  const capture = o.mode === 'capture';
  const now = driver.now || (() => Date.now());
  const trace = [], screens = [];
  let nodes = [], xml = '';
  const dump = async () => { xml = await driver.dump(); nodes = parseDump(xml); return nodes; };
  const fail = (step, why, extra) => ({ ok: false, state: 'failed', step: step && step.name, why, trace, screens, screen: describe(nodes, o.username), ...(extra || {}) });
  // v0.5.14: once Instagram (o.appPkg) has been on screen, another app on top means the flow was
  // sent away (a promo button opened Google Play in the browser on 2026-11-08). A step never takes
  // a match from another app's screen; Back is pressed to come home, and if that does not work the
  // run fails as `left_app` with the package - not three screens later as a puzzling "not found".
  let seenApp = false;

  for (const step of flow) {
    const t0 = now();
    if (o.abort && o.abort()) return { ok: false, state: 'aborted', step: step.name, why: 'viewer_opened', trace, screens };
    if (capture && step.guard === 'no-share') {
      await dump();
      screens.push({ at: step.name, ...describe(nodes, o.username) });
      trace.push({ name: step.name, ok: true, matched: 'capture stop', ms: now() - t0 });
      return { ok: true, state: 'captured', step: step.name, trace, screens, screen: describe(nodes, o.username) };
    }
    // Look for a candidate, dismissing pop-ups in between, until the step's timeout.
    const limit = step.timeout || STEP_TIMEOUT_MS;
    let hit = null, dismissed = 0, backs = 0, fatal = null, emptyReads = 0, shotTap = null;
    while (true) {
      await dump();
      if (capture) screens.push({ at: step.name, ...describe(nodes, o.username) });
      const pkgNow = screenPkg(nodes);
      if (o.appPkg && pkgNow === o.appPkg) seenApp = true;
      const away = !!(o.appPkg && seenApp && pkgNow && pkgNow !== o.appPkg);
      // Android's own prompts (a permission question) sit on top of the app: answered, not fled.
      const sysDialog = away && /permissioncontroller|packageinstaller|^android$|systemui/.test(pkgNow);
      hit = away ? null : findAny(nodes, step.find);
      if (hit) break;
      // v0.5.18: a screen uiautomator cannot read (the sound page's previews never stop moving, so it
      // never gets an "idle" screen) comes back empty. Twice empty on a step that allows it: its button
      // is found on a screenshot instead (Instagram's big blue button: "Use audio").
      // v0.5.20: also unreadable = a read that is not Instagram at all. On 2026-11-13 (phone 40) the
      // read came back as a whole HOME SCREEN while the sound page with "Use audio" was in front, so
      // the empty-read rule never fired. A screenshot only taps a big blue button, which the home
      // screen does not have, so a real home screen still fails as before.
      const notApp = !!(o.appPkg && pkgNow && pkgNow !== o.appPkg && !/permissioncontroller|packageinstaller|^android$|systemui/.test(pkgNow));
      if (!nodes.length || notApp) emptyReads++; else emptyReads = 0;
      if (step.fallback === 'primary-button' && emptyReads >= 2 && driver.primaryButton) {
        const b = await driver.primaryButton();
        if (b) { shotTap = b; break; }
      }
      if (!away || sysDialog) {
        fatal = findAny(nodes, FATAL.map((f) => ({ text: f.text })));
        if (fatal) { const f = FATAL.find((x) => x.text === fatal.sel.text); return fail(step, f ? f.why : 'blocked'); }
      }
      const popup = dismissed < 3 && (!away || sysDialog) ? findAny(nodes, DISMISS) : null;
      if (popup) {
        const t = tapTarget(nodes, popup.node);
        await driver.tap(t.cx, t.cy); dismissed++;
        trace.push({ name: step.name + ':dismiss', ok: true, matched: selLabel(popup.sel) + ' "' + redact(popup.node.text || popup.node.desc, o.username) + '"', ms: now() - t0 });
        await driver.wait(1200);
        continue;
      }
      const promo = !away && backs < MAX_BACKS ? BACK_ON.find((b) => find(nodes, b.text ? { text: b.text } : { desc: b.desc })) : null;
      if (away || promo) {
        if (backs >= MAX_BACKS) return fail(step, 'left_app', { pkg: pkgNow });
        await driver.key('back'); backs++;
        trace.push({ name: step.name + ':back', ok: true, matched: away ? `left Instagram for ${pkgNow}` : promo.why, ms: now() - t0 });
        await driver.wait(1500);
        continue;
      }
      if (now() - t0 >= limit) break;
      await driver.wait(POLL_MS);
    }
    if (!hit && shotTap) {
      await driver.tap(shotTap.x, shotTap.y);
      trace.push({ name: step.name, ok: true, matched: `screen unreadable: the blue button on a screenshot, tapped at ${shotTap.x},${shotTap.y}`, ms: now() - t0 });
      await driver.wait(step.settle || 1500);
      continue;
    }
    if (!hit) {
      if (step.optional) { trace.push({ name: step.name, ok: true, matched: 'skipped (optional, not on screen)', ms: now() - t0 }); continue; }
      trace.push({ name: step.name, ok: false, matched: '', ms: now() - t0 });
      return fail(step, 'element_not_found');
    }
    let label = selLabel(hit.sel) + (hit.node.text ? ' "' + redact(hit.node.text, o.username) + '"' : hit.node.desc ? ' [' + redact(hit.node.desc, o.username) + ']' : '');
    if (step.action === 'type-overlay') {
      // the text tool's box: typed line by line, Enter between lines (input text cannot type a newline)
      const lines = overlayForDevice(o.overlay && o.overlay.text).split('\n');
      if (!hit.node.focused) { const t = tapTarget(nodes, hit.node); await driver.tap(t.cx, t.cy); await driver.wait(500); }
      for (let i = 0; i < lines.length; i++) {
        if (i) { await driver.key('enter'); await driver.wait(150); }
        if (lines[i]) await driver.type(lines[i]);
      }
      await driver.wait(400);
    } else if (step.action === 'drag-overlay') {
      const rect = canvasRect(nodes);
      const from = overlayStart(nodes, o.overlay && o.overlay.text, rect);
      const to = overlayTarget(rect, o.overlay && o.overlay.x, o.overlay && o.overlay.y);
      if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 6) await driver.swipe(from.x, from.y, to.x, to.y, 900);
      label += ` | text dragged (${from.x},${from.y})->(${to.x},${to.y}); reel ${rect.found ? 'found' : 'assumed'} at ${rect.l},${rect.t} ${rect.w}x${rect.h}${from.found ? '' : '; start = middle of the reel'}`;
    } else if (step.action === 'tap') {
      const t = tapTarget(nodes, hit.node);
      await driver.tap(t.cx, t.cy);
    } else if (step.action === 'type') {
      const t = tapTarget(nodes, hit.node);
      await driver.tap(t.cx, t.cy);
      await driver.wait(800);
      const text = String(o.caption || '');
      if (text) await driver.type(text);
      await driver.wait(400);
      await driver.key('back');          // close the keyboard; the share button is under it
    } else if (step.action === 'key') {
      await driver.key(step.key || 'back');
    }
    trace.push({ name: step.name, ok: true, matched: label, ms: now() - t0 });
    if (o.onStep) { try { await o.onStep(step, label); } catch {} }   // may be async (a capture screenshot)
    if (step.action === 'done') {
      return { ok: true, state: capture ? 'captured' : 'shared', step: step.name, trace, screens, screen: describe(nodes, o.username), nodes };
    }
    if (step.settle) await driver.wait(step.settle);
  }
  return { ok: true, state: capture ? 'captured' : 'shared', step: 'end', trace, screens, screen: describe(nodes, o.username) };
}
function selLabel(sel) {
  const k = Object.keys(sel).filter((x) => x !== 'nth' && x !== 'clickable')[0] || '?';
  const v = sel[k];
  return k + '=' + (v instanceof RegExp ? v.source : String(v));
}

// ASCII only: `adb shell input text` cannot type anything else, and a caption with an emoji in it
// would silently lose characters. The backend refuses non-ASCII captions; this is the belt.
function captionForDevice(caption, max) {
  return String(caption || '').replace(/[^\x20-\x7e\n]/g, '').replace(/\n+/g, ' ').trim().slice(0, max || 2000);
}

// The screen as a list of elements for a person or an AI agent driving the phone (v0.5.14 `ui_dump`,
// the CLI/MCP `read_screen`): what is written, what it is called, its id, where its centre is.
// Texts go through redact() (emails, phone numbers); no raw XML leaves the phone.
function uiElements(nodes, max) {
  const out = [], seen = new Set();
  for (const n of nodes || []) {
    if (!n.bounds || n.bounds.r - n.bounds.l < 2 || n.bounds.b - n.bounds.t < 2) continue;
    const id = n.id.includes('/') ? n.id.slice(n.id.lastIndexOf('/') + 1) : n.id;
    if (!n.text && !n.desc && !id && !n.clickable) continue;
    const key = [n.text, n.desc, id, n.cx, n.cy].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: redact(n.text), desc: redact(n.desc), id, cls: n.cls.split('.').pop(), clickable: n.clickable,
      focused: n.focused || undefined, bounds: n.bounds, cx: n.cx, cy: n.cy });
    if (out.length >= (max || 400)) break;
  }
  return out;
}

module.exports = {
  parseDump, matches, find, findAny, tapTarget, describe, redact, usernameFrom, captionForDevice, run,
  withText, overlayForDevice, screenSize, canvasRect, overlayTarget, overlayStart, screenPkg, uiElements,
  FLOW_REEL, FLOW_REEL_WITH_AUDIO, FLOW_WHOAMI, TEXT_STEPS, DISMISS, BACK_ON, FATAL, STEP_TIMEOUT_MS, MAX_BACKS,
};
