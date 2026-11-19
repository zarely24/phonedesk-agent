// igcreate.js - v0.5.23: the phone side of automated Instagram account creation
// (backend app/igcreate.py). Four ops, one per phase, each a SCREEN-DRIVEN walk: read the dump,
// classify what Instagram is showing, act, repeat - the order of Instagram's own screens never
// matters. Reuses igpost.js's dump helpers and the lessons igpost/igcheck already paid for:
// never take a match from another app's screen, dismiss real pop-ups, Back out of promos,
// answer system permission dialogs, screenshot what a failing step saw.
//
// Nothing here is read-only: this module CREATES accounts, types credentials, changes account
// type and profile photo - every caller in core.js gates it the way igPost is gated (one job per
// phone at a time, no live viewer, real profile switch, everything restored in `finally`).
'use strict';
const igpost = require('./igpost');

const IG_PKG = 'com.instagram.android';
const POLL_MS = 1200;
const STEP_TIMEOUT_MS = 14000;
const MAX_STEPS = 90;                       // the signup walk is long; the loop, not a list, is the shape
const JITTER = () => 250 + Math.floor(Math.random() * 550);   // a person's pause between actions

// Words Instagram writes when an account is in trouble: the walk stops and reports `challenge`
// rather than tapping anything on such a screen.
const CHALLENGE = [
  { text: /your account has been (disabled|suspended)/i, why: 'account disabled' },
  { text: /(checkpoint|required to verify)/i, why: 'checkpoint' },
  { text: /help us verify/i, why: 'verification required' },
  { text: /suspicious (login|activity)/i, why: 'suspicious activity' },
  { text: /try again later|action blocked/i, why: 'rate limited' },
];

// Instagram's own dialog buttons: never a step target, always dismissed first.
const POPUPS = [
  { text: /^not now$/i }, { desc: /^not now$/i }, { text: /^skip$/i }, { desc: /^skip$/i },
  { text: /^no thanks$/i }, { text: /^dismiss$/i }, { desc: /^dismiss$/i },
  { text: /^maybe later$/i }, { text: /^cancel$/i }, { desc: /^cancel$/i },
  { text: /^got it$/i }, { text: /^ok,? got it$/i }, { desc: /^close$/i }, { text: /^close$/i },
  { text: /^x$/i }, { desc: /^discard$/i }, { text: /^discard changes?$/i },
];

// System permission dialogs (the app cannot read past them and the walk may not answer for the
// human in general - but CONTACTS during a signup we own is ours to refuse: contacts sync is
// exactly what a farm account does not want).
const PERMISSIONS = [
  { pkg: /permissioncontroller|com\.google\.android\.packageinstaller|com\.android\.permissioncontroller/i },
];

function txtOf(n) { return String((n && n.text) || ''); }
function descOf(n) { return String((n && n.desc) || ''); }

// ---- the shared walk ------------------------------------------------------------------------

function makeCtx(driver, opts) {
  const o = opts || {};
  const now = driver.now || (() => Date.now());
  const c = {
    driver, o, now,
    trace: [],
    abort: o.abort || (() => false),
    seenApp: false,
    backs: 0,
    emptyReads: 0,
    unknowns: 0,
  };
  c.step = (name, ok, matched, t0) => {
    c.trace.push({ name, ok: ok !== false, matched: String(matched || ''), ms: now() - (t0 || now()) });
  };
  return c;
}
let ctx = null;   // one walk at a time per agent process (core.js serialises by phone)

async function dumpNodes() {
  const xml = await ctx.driver.dump();
  return igpost.parseDump(xml);
}

function pkgNow(nodes) { return igpost.screenPkg(nodes); }
function findAny(nodes, sels) { return igpost.findAny(nodes, sels); }
function tapNode(nodes, node) { const t = igpost.tapTarget(nodes, node); return ctx.driver.tap(t.cx, t.cy); }

async function pressBack(why) {
  await ctx.driver.key('back');
  ctx.backs += 1;
  ctx.step('back', true, why + ' (' + ctx.backs + ')');
  await ctx.driver.wait(1500);
}

async function screenshot() {
  try { const png = await ctx.driver.screenshot(); return png && png.length ? png.toString('base64') : null; }
  catch { return null; }
}

function fail(step, why, extra) {
  return { ok: false, state: 'failed', step, why, trace: ctx.trace, ...(extra || {}) };
}

async function resolveOverlays(nodes) {
  // system permission dialogs and Instagram pop-ups sit between every read and every action
  const p = pkgNow(nodes);
  if (p && /permissioncontroller|packageinstaller/i.test(p)) {
    const deny = findAny(nodes, [{ text: /^(don'?t allow|deny)$/i }, { text: /^not now$/i }]);
    if (deny) { await tapNode(nodes, deny.node); ctx.step('permission', true, 'refused'); await ctx.driver.wait(JITTER()); return 'restart'; }
    await ctx.driver.wait(800);
    return 'restart';
  }
  const popup = findAny(nodes, POPUPS);
  if (popup) {
    await tapNode(nodes, popup.node);
    ctx.step('dismiss', true, igpost.redact(txtOf(popup.node) || descOf(popup.node), ctx.o.username));
    await ctx.driver.wait(JITTER());
    return 'restart';
  }
  const bad = findAny(nodes, CHALLENGE.map((c) => ({ text: c.text })));
  if (bad) {
    const hit = CHALLENGE.find((c) => c.text.test(txtOf(bad.node)));
    return { ok: false, state: 'challenge', step: 'walk', why: (hit && hit.why) || 'challenge', trace: ctx.trace };
  }
  if (!nodes.length) {
    ctx.emptyReads += 1;
    if (ctx.emptyReads >= 10) return { ok: false, state: 'failed', step: 'walk', why: 'the screen cannot be read (uiautomator never went idle)', trace: ctx.trace };
    await ctx.driver.wait(1600);
    return 'restart';
  }
  ctx.emptyReads = 0;
  return nodes;
}

// ---- field helpers --------------------------------------------------------------------------

function editTexts(nodes) {
  return nodes.filter((n) => /EditText/.test(n.cls || '') && n.bounds);
}

function focusedField(nodes) {
  return editTexts(nodes).find((n) => n.focused) || editTexts(nodes)[0] || null;
}

async function typeInto(nodes, node, text) {
  if (!node.focused) { await tapNode(nodes, node); await ctx.driver.wait(600); }
  // a field that came with a suggestion is cleared first: select-all does not exist over adb,
  // so the caret is moved to the end and DEL is held long enough for a 30-char username
  await ctx.driver.key('move_end');
  for (let i = 0; i < 32; i++) await ctx.driver.key('del');
  if (text) await ctx.driver.type(text);
  await ctx.driver.wait(JITTER());
}

async function tapByText(nodes, res, settle) {
  const hit = findAny(nodes, [{ text: res }, { desc: res }]);
  if (!hit) return false;
  await tapNode(nodes, hit.node);
  await ctx.driver.wait(settle || 1800);
  return true;
}

const HAS_TAB_BAR = [{ id: /tab_bar|feed_tab|clips_tab|profile_tab/ }, { desc: /^(home|search|reels|profile)$/i }];

function onFeedOrProfile(nodes) {
  return !!findAny(nodes, HAS_TAB_BAR) ||
    !!findAny(nodes, [{ text: /^professional dashboard$/i }, { text: /^edit profile$/i }]);
}

function screenHas(nodes, res) {
  return !!findAny(nodes, [{ text: res }, { desc: res }, { id: res }]);
}

// ---- phase 1: open the signup form, enter the phone number ---------------------------------

async function signupStart(driver, opts) {
  ctx = makeCtx(driver, opts);
  const phone = String(opts.phone || '').replace(/\D/g, '');
  if (!phone) return { ok: false, state: 'bad_request', why: 'no phone number', trace: ctx.trace };
  const start = Date.now();
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (ctx.abort()) return { ok: false, state: 'aborted', why: 'viewer_opened', trace: ctx.trace };
      let nodes;
      try { nodes = await dumpNodes(); } catch { nodes = []; }
      const r = await resolveOverlays(nodes);
      if (r && r.ok === false) return r;
      if (r === 'restart') continue;
      nodes = r;
      // done: the code screen is in front (the backend now waits for the SMS)
      if (screenHas(nodes, /enter (the |your )?(confirmation )?code/i) || screenHas(nodes, /code.*sent|sent.*code|enter code/i)) {
        if (editTexts(nodes).length) {
          ctx.step('code-screen', true, 'the confirmation-code screen is up');
          return { ok: true, state: 'code_requested', trace: ctx.trace };
        }
      }
      // logged in already: this profile is not a signup candidate
      if (onFeedOrProfile(nodes)) {
        return { ok: false, state: 'already_logged_in', why: 'this profile is signed in to Instagram', trace: ctx.trace };
      }
      const t0 = Date.now();
      // 1. the login screen's "Create new account"
      if (await tapByText(nodes, /^create new account$|^sign ?up( with (email or phone|phone))?$/i, 2500)) {
        ctx.step('create-account', true, 'tapped', t0); continue;
      }
      // 2. the phone/email entry screen: make sure the PHONE tab is the one on
      if (await tapByText(nodes, /^phone$/i, 1200)) { ctx.step('phone-tab', true, 'tapped', t0); continue; }
      // 3. type the number into the field
      const field = focusedField(nodes);
      if (field && (screenHas(nodes, /mobile|phone|sign up/i) || /phone|mobile|sign_up/i.test(field.id || ''))) {
        await typeInto(nodes, field, phone);
        ctx.step('phone', true, 'typed ' + phone.slice(0, 3) + '...', t0);
        if (!(await tapByText(nodes, /^next$|^continue$/i, 3000))) {
          await ctx.driver.key('enter');
          await ctx.driver.wait(2500);
          ctx.step('phone-next', true, 'Enter');
        }
        continue;
      }
      // nothing known for a while: Back once, then give up with evidence
      ctx.unknowns = (ctx.unknowns || 0) + 1;
      if (ctx.unknowns === 3) await pressBack('unknown screen');
      if (ctx.unknowns >= 8) {
        const shot = await screenshot();
        return fail('unknown_screen', 'no known signup screen', { screen: igpost.describe(nodes, opts.username), screenshot_b64: shot });
      }
      await ctx.driver.wait(1800);
      if (Date.now() - start > 4 * 60000) {
        const shot = await screenshot();
        return fail('timeout', 'the signup form never opened', { screenshot_b64: shot });
      }
    }
    const shot = await screenshot();
    return fail('too_many_steps', 'the signup walk took too many passes', { screenshot_b64: shot });
  } finally { ctx = null; }
}

// ---- phase 2: code, password, name, birthday, username --------------------------------------

const USER_TAKEN = /isn'?t available|not available|already (been )?taken|username.*taken|try (another|a different)/i;

async function signupFinish(driver, opts) {
  ctx = makeCtx(driver, opts);
  const code = String(opts.code || '').replace(/\D/g, '');
  const password = String(opts.password || '');
  const name = String(opts.name || '');
  let username = String(opts.username || '').replace(/^@/, '').toLowerCase();
  if (!code || !password || !username) {
    return { ok: false, state: 'bad_request', why: 'code, password and username are all needed', trace: ctx.trace };
  }
  let nameDone = false;
  let pwDone = false;
  let finalUsername = username;
  const tries = [username,
    username + String(10 + Math.floor(Math.random() * 89)),
    username.slice(0, 24) + '.' + String(10 + Math.floor(Math.random() * 89))];
  let tryIdx = 0;
  const start = Date.now();
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (ctx.abort()) return { ok: false, state: 'aborted', why: 'viewer_opened', trace: ctx.trace };
      let nodes;
      try { nodes = await dumpNodes(); } catch { nodes = []; }
      const r = await resolveOverlays(nodes);
      if (r && r.ok === false) return r;
      if (r === 'restart') continue;
      nodes = r;
      if (onFeedOrProfile(nodes)) {
        ctx.step('created', true, 'profile/feed is up as @' + finalUsername);
        return { ok: true, state: 'created', username: finalUsername, trace: ctx.trace, screenshot_b64: await screenshot() };
      }
      const t0 = Date.now();
      // the confirmation code
      if (!pwDone && screenHas(nodes, /enter (the |your )?(confirmation )?code|sent.*code|enter code/i)) {
        const f = focusedField(nodes);
        if (f) {
          await typeInto(nodes, f, code);
          ctx.step('code', true, 'typed', t0);
          if (!(await tapByText(nodes, /^next$|^continue$/i, 3000))) { await ctx.driver.key('enter'); await ctx.driver.wait(2500); }
          continue;
        }
      }
      // the name
      if (!nameDone && screenHas(nodes, /what'?s your name|your name/i) && editTexts(nodes).length) {
        const f = focusedField(nodes);
        if (f) {
          await typeInto(nodes, f, name || username);
          nameDone = true;
          ctx.step('name', true, 'typed', t0);
          if (!(await tapByText(nodes, /^next$|^continue$/i, 3000))) { await ctx.driver.key('enter'); await ctx.driver.wait(2500); }
          continue;
        }
      }
      // the birthday (three EditTexts or wheels we can read; an unreadable one fails with evidence)
      if (screenHas(nodes, /birthday|date of birth|when.*born/i)) {
        const fields = editTexts(nodes);
        if (fields.length >= 2) {
          // a text build: today-25 as a safe adult date, typed per field
          const d = new Date();
          d.setFullYear(d.getFullYear() - 25);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          const yy = String(d.getFullYear());
          for (let k = 0; k < Math.min(3, fields.length); k++) {
            const v = [mm, dd, yy][k] || yy;
            await typeInto(nodes, fields[k], v);
          }
          ctx.step('birthday', true, 'typed mm/dd/yyyy', t0);
        } else if (screenHas(nodes, /numberpicker|picker|wheel/i) || nodes.some((n) => /NumberPicker/.test(n.cls || ''))) {
          const years = nodes.map(txtOf).filter((t) => /^(19|20)\d\d$/.test(t)).map(Number);
          const age = years.length ? new Date().getFullYear() - Math.min.apply(null, years) : 30;
          ctx.step('birthday', true, 'wheels, shown year makes ~' + age, t0);
          if (age < 16) {
            const shot = await screenshot();
            return fail('birthday_wheels_young', 'the birthday wheels show a minor year; refusing to continue', { screenshot_b64: shot });
          }
        } else {
          const shot = await screenshot();
          return fail('unsupported_birthday_screen', 'the birthday screen has no field this walk can type into', { screenshot_b64: shot });
        }
        if (!(await tapByText(nodes, /^next$|^continue$/i, 3000))) { await ctx.driver.key('enter'); await ctx.driver.wait(2500); }
        continue;
      }
      // the password
      if (!pwDone && screenHas(nodes, /password/i) && editTexts(nodes).length) {
        const f = focusedField(nodes);
        if (f) {
          await typeInto(nodes, f, password);
          pwDone = true;
          ctx.step('password', true, 'typed', t0);
          if (!(await tapByText(nodes, /^next$|^continue$|^sign up$/i, 3500))) { await ctx.driver.key('enter'); await ctx.driver.wait(3000); }
          continue;
        }
      }
      // the username (with "taken" retries)
      if (screenHas(nodes, /username/i) && editTexts(nodes).length && !USER_TAKEN.test(nodes.map(txtOf).join(' | '))) {
        const f = focusedField(nodes);
        if (f) {
          const want = tries[tryIdx] || (username + String(100 + Math.floor(Math.random() * 899)));
          const cur = txtOf(f);
          if (cur.toLowerCase() !== want) await typeInto(nodes, f, want);
          finalUsername = want;
          ctx.step('username', true, 'asked for ' + want, t0);
          if (!(await tapByText(nodes, /^next$|^continue$|^sign up$/i, 3500))) { await ctx.driver.key('enter'); await ctx.driver.wait(3000); }
          continue;
        }
      }
      // "username is taken": switch to the next variant and re-fill the field
      if (USER_TAKEN.test(nodes.map(txtOf).join(' | '))) {
        tryIdx += 1;
        if (tryIdx >= tries.length + 2) {
          const shot = await screenshot();
          return fail('username_taken', 'every username variant was taken', { screenshot_b64: shot });
        }
        const f = focusedField(nodes) || editTexts(nodes)[0];
        if (f) {
          finalUsername = tries[tryIdx] || username;
          await typeInto(nodes, f, finalUsername);
          ctx.step('username-retry', true, 'trying ' + finalUsername, t0);
        }
        continue;
      }
      // interstitials Instagram puts between the steps (add photo / sync contacts / follow people)
      if (await tapByText(nodes, /^skip$|^not now$|^no thanks$|^do not allow$|^maybe later$/i, 1800)) {
        ctx.step('interstitial', true, 'skipped', t0); continue;
      }
      if (await tapByText(nodes, /^save$/i, 2500)) { ctx.step('save-login', true, 'saved login info', t0); continue; }
      // agree-to-terms style screens and everything else with a single Next
      if (await tapByText(nodes, /^next$|^continue$|^i agree$|^agree$/i, 2500)) {
        ctx.step('continue', true, 'tapped', t0); continue;
      }
      ctx.unknowns = (ctx.unknowns || 0) + 1;
      if (ctx.unknowns === 4) await pressBack('unknown screen');
      if (ctx.unknowns >= 10) {
        const shot = await screenshot();
        return fail('unknown_screen', 'no known signup screen', { screen: igpost.describe(nodes, username), screenshot_b64: shot });
      }
      await ctx.driver.wait(1800);
      if (Date.now() - start > 6 * 60000) {
        const shot = await screenshot();
        return fail('timeout', 'the signup walk ran out of time', { screenshot_b64: shot });
      }
    }
    const shot = await screenshot();
    return fail('too_many_steps', 'the signup walk took too many passes', { screenshot_b64: shot });
  } finally { ctx = null; }
}

// ---- phase 3: switch to a professional Creator account ---------------------------------------

async function switchCreator(driver, opts) {
  ctx = makeCtx(driver, opts);
  const category = String(opts.category || 'Digital creator');
  const start = Date.now();
  let scrolls = 0;
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (ctx.abort()) return { ok: false, state: 'aborted', why: 'viewer_opened', trace: ctx.trace };
      let nodes;
      try { nodes = await dumpNodes(); } catch { nodes = []; }
      const r = await resolveOverlays(nodes);
      if (r && r.ok === false) return r;
      if (r === 'restart') continue;
      nodes = r;
      const t0 = Date.now();
      // done: the professional dashboard exists on the profile
      if (screenHas(nodes, /professional dashboard/i)) {
        ctx.step('professional', true, 'the profile has a Professional dashboard', t0);
        return { ok: true, state: 'creator_done', trace: ctx.trace, screenshot_b64: await screenshot() };
      }
      // go home first: the walk starts wherever Instagram was left
      if (!screenHas(nodes, /edit profile|professional dashboard/i) && !screenHas(nodes, /settings/i)) {
        if (await tapByText(nodes, /^profile$/i, 2000)) { ctx.step('profile-tab', true, 'tapped', t0); continue; }
      }
      // on the profile: open the menu
      if (screenHas(nodes, /edit profile/i)) {
        const menu = findAny(nodes, [{ desc: /^menu$/i }, { id: /action_bar_item_menu|more_options|options_button|thread_header_menu/ }, { text: /^menu$/i }]);
        if (menu) {
          await tapNode(nodes, menu.node);
          ctx.step('menu', true, 'opened the menu', t0);
          await ctx.driver.wait(2200);
          continue;
        }
      }
      // in the menu / sheet: Settings and activity
      if (await tapByText(nodes, /^settings and activity$|^settings$/i, 2500)) { ctx.step('settings', true, 'tapped', t0); continue; }
      // settings list: Account type and tools (may need a scroll to be visible)
      if (await tapByText(nodes, /^account type and tools$|^account type/i, 2500)) { ctx.step('account-type', true, 'tapped', t0); scrolls = 0; continue; }
      if (screenHas(nodes, /account type and tools/i) === false && screenHas(nodes, /settings and activity|saved|archive/i) && scrolls < 6) {
        const sz = igpost.screenSize(nodes);
        await ctx.driver.swipe(sz.w / 2, sz.h * 0.72, sz.w / 2, sz.h * 0.30, 700);
        scrolls += 1;
        ctx.step('settings-scroll', true, 'looking for Account type and tools (' + scrolls + ')', t0);
        await ctx.driver.wait(1200);
        continue;
      }
      // the tool page: switch to professional
      if (await tapByText(nodes, /^switch to professional account/i, 3000)) { ctx.step('switch-pro', true, 'tapped', t0); continue; }
      // intro / pitch screens: Next, Continue, Get started
      if (await tapByText(nodes, /^next$|^continue$|^get started$/i, 2500)) { ctx.step('intro', true, 'tapped', t0); continue; }
      // Creator vs Personal
      if (screenHas(nodes, /what best describes|creator$|^personal$/i)) {
        const pick = await tapByText(nodes, /^creator$/i, 2500);
        if (pick) { ctx.step('creator', true, 'chose Creator', t0); continue; }
      }
      // the category search: type, then pick the matching row
      if (screenHas(nodes, /what best describes your|category|select a category/i)) {
        const f = focusedField(nodes);
        if (f && screenHas(nodes, /search/i)) {
          await typeInto(nodes, f, category);
          await ctx.driver.wait(2000);
          const row = findAny(nodes, [{ text: new RegExp('^' + category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }]);
          if (row) {
            await tapNode(nodes, row.node);
            ctx.step('category', true, 'picked ' + category, t0);
            await ctx.driver.wait(2500);
            continue;
          }
          const any = findAny(nodes, [{ text: new RegExp(category.split(' ')[0], 'i') }]);
          if (any) {
            await tapNode(nodes, any.node);
            ctx.step('category', true, 'picked closest: ' + igpost.redact(txtOf(any.node), ''), t0);
            await ctx.driver.wait(2500);
            continue;
          }
        }
      }
      // the tail screens: toggles, review, dashboard pitch - Next/OK/Done carries them
      if (await tapByText(nodes, /^next$|^ok$|^done$|^got it$|^continue$|^save$/i, 2500)) {
        ctx.step('tail', true, 'tapped', t0); continue;
      }
      ctx.unknowns = (ctx.unknowns || 0) + 1;
      if (ctx.unknowns >= 10) {
        const shot = await screenshot();
        return fail('unknown_screen', 'no known screen during the creator switch', { screen: igpost.describe(nodes, ''), screenshot_b64: shot });
      }
      await ctx.driver.wait(1800);
      if (Date.now() - start > 6 * 60000) {
        const shot = await screenshot();
        return fail('timeout', 'the creator switch ran out of time', { screenshot_b64: shot });
      }
    }
    const shot = await screenshot();
    return fail('too_many_steps', 'the creator walk took too many passes', { screenshot_b64: shot });
  } finally { ctx = null; }
}

// ---- phase 4: the profile picture ------------------------------------------------------------

async function setPhoto(driver, opts) {
  ctx = makeCtx(driver, opts);
  const start = Date.now();
  let saved = false;
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (ctx.abort()) return { ok: false, state: 'aborted', why: 'viewer_opened', trace: ctx.trace };
      let nodes;
      try { nodes = await dumpNodes(); } catch { nodes = []; }
      const r = await resolveOverlays(nodes);
      if (r && r.ok === false) return r;
      if (r === 'restart') continue;
      nodes = r;
      const t0 = Date.now();
      if (saved && onFeedOrProfile(nodes)) {
        ctx.step('photo-done', true, 'back on the profile with a new picture', t0);
        return { ok: true, state: 'photo_done', trace: ctx.trace, screenshot_b64: await screenshot() };
      }
      // profile tab first
      if (!screenHas(nodes, /edit profile|change profile photo/i)) {
        if (await tapByText(nodes, /^profile$/i, 2000)) { ctx.step('profile-tab', true, 'tapped', t0); continue; }
      }
      // Edit profile
      if (await tapByText(nodes, /^edit profile$/i, 2500)) { ctx.step('edit-profile', true, 'tapped', t0); continue; }
      // Change profile photo -> the bottom sheet
      if (await tapByText(nodes, /^change profile photo$/i, 2200)) { ctx.step('change-photo', true, 'tapped', t0); continue; }
      // the sheet: choose the gallery
      if (await tapByText(nodes, /^choose (photo )?from gallery$|^select (photo )?from gallery$|^import from gallery$/i, 3000)) {
        ctx.step('gallery', true, 'opened the gallery', t0); continue;
      }
      // optional folder step (like the reel flow's choose-reel)
      if (await tapByText(nodes, /^gallery$/i, 2200)) { ctx.step('folder', true, 'tapped Gallery', t0); continue; }
      // the newest item is ours (the backend pushed it moments ago)
      const thumb = findAny(nodes, [
        { id: /gallery_grid_item_thumbnail|gallery_grid_item_selection|media_thumbnail|gallery_item|image_view/ },
        { desc: /^(photo|image|picture) thumbnail/i }, { desc: /thumbnail/i },
      ]);
      if (thumb) {
        await tapNode(nodes, thumb.node);
        ctx.step('pick', true, 'picked the newest picture', t0);
        await ctx.driver.wait(2500);
        continue;
      }
      // the crop screen: Done / Save / the checkmark - the walk is deep enough that any of
      // these carries the crop
      if (await tapByText(nodes, /^done$|^save$|^next$|^ok$/i, 2800)) {
        saved = true;
        ctx.step('crop', true, 'tapped', t0);
        continue;
      }
      const tick = findAny(nodes, [{ desc: /^(done|save|check|confirm)$/i }, { id: /crop_done|done_button|save_button|action_bar_save|button_text/ }]);
      if (tick) {
        await tapNode(nodes, tick.node);
        saved = true;
        ctx.step('crop', true, 'confirmed', t0);
        await ctx.driver.wait(2800);
        continue;
      }
      // an Edit-profile screen with a visible Save after the crop went through
      if (screenHas(nodes, /edit profile/i) && (await tapByText(nodes, /^save$/i, 3000))) {
        saved = true;
        ctx.step('save', true, 'saved the profile', t0);
        continue;
      }
      ctx.unknowns = (ctx.unknowns || 0) + 1;
      if (ctx.unknowns >= 10) {
        const shot = await screenshot();
        return fail('unknown_screen', 'no known screen during the photo step', { screen: igpost.describe(nodes, ''), screenshot_b64: shot });
      }
      await ctx.driver.wait(1800);
      if (Date.now() - start > 5 * 60000) {
        const shot = await screenshot();
        return fail('timeout', 'the photo walk ran out of time', { screenshot_b64: shot });
      }
    }
    const shot = await screenshot();
    return fail('too_many_steps', 'the photo walk took too many passes', { screenshot_b64: shot });
  } finally { ctx = null; }
}

module.exports = { signupStart, signupFinish, switchCreator, setPhoto, IG_PKG };
