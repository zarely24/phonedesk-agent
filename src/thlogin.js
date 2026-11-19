// thlogin.js - v0.5.24: the Threads login walk for the backend's thlogin runner (app/thlogin.py).
// A Threads account IS the profile's Instagram account: the app's first screen offers "Continue
// as @user", one tap, no password, no SMS. This module drives that, screen by screen:
// launch -> "Continue as @handle" (or the account picker when several IG accounts exist) ->
// deny the notifications permission -> skip "find friends" -> the feed is up = logged in.
//
// Nothing here types credentials. A profile whose Instagram is not signed in gets only Threads'
// own login form - that is reported as `no_ig_account` and the run stops. Like igcreate.js, the
// walk classifies whatever is in front (order-proof), never taps on challenge screens, and
// screenshots what a failing step saw.
'use strict';
const igpost = require('./igpost');

const TH_PKG = 'com.instagram.barcelona';
const JITTER = () => 250 + Math.floor(Math.random() * 550);

// "Continue as @handle" / "Log in as @handle" - the same phrases Instagram's own check parser
// knows (igcheck.parseLoginRemembered), matched against the row text.
const CONTINUE_RE = /^(?:continue as|log in as|log into|switch to)\s+@?([a-z0-9._]{2,30})$/i;

// Meta's dialog buttons: never a step target, always dismissed first.
const POPUPS = [
  { text: /^not now$/i }, { desc: /^not now$/i }, { text: /^skip$/i }, { desc: /^skip$/i },
  { text: /^no thanks$/i }, { text: /^dismiss$/i }, { desc: /^dismiss$/i },
  { text: /^maybe later$/i }, { text: /^cancel$/i }, { desc: /^cancel$/i },
  { text: /^got it$/i }, { desc: /^close$/i }, { text: /^close$/i }, { text: /^x$/i },
  { text: /^ok,? got it$/i }, { desc: /^discard$/i },
];

// trouble screens: stop and report, never tap further
const CHALLENGE = [
  { text: /your account has been (disabled|suspended)/i, why: 'account disabled' },
  { text: /(checkpoint|help us verify)/i, why: 'checkpoint' },
  { text: /try again later|action blocked/i, why: 'rate limited' },
];

// Threads' bottom navigation: the feed is up = logged in.
const FEED_MARKERS = [
  { desc: /^home$/i }, { id: /tab_bar|home_tab|bottom_tab/ }, { text: /^home$/i },
  { desc: /^search$/i }, { desc: /^profile$/i },
];

function txtOf(n) { return String((n && n.text) || ''); }
function descOf(n) { return String((n && n.desc) || ''); }

async function run(driver, opts) {
  const o = opts || {};
  const want = String(o.username || '').replace(/^@/, '').toLowerCase();
  const now = driver.now || (() => Date.now());
  const trace = [];
  const abort = o.abort || (() => false);
  let seenApp = false, backs = 0, emptyReads = 0, unknowns = 0, tappedContinue = false, handle = '';
  const step = (name, ok, matched, t0) => trace.push({ name, ok: ok !== false, matched: String(matched || ''), ms: now() - (t0 || now()) });
  const screenshot = async () => { try { const png = await driver.screenshot(); return png && png.length ? png.toString('base64') : null; } catch { return null; } };
  const fail = (st, why) => ({ ok: false, state: 'failed', step: st, why, trace, screenshot_b64: null });
  const tapNode = (nodes, node) => { const t = igpost.tapTarget(nodes, node); return driver.tap(t.cx, t.cy); };
  const start = Date.now();

  try {
    for (let pass = 0; pass < 60; pass++) {
      if (abort()) return { ok: false, state: 'aborted', why: 'viewer_opened', trace };
      let nodes = [];
      try { nodes = igpost.parseDump(await driver.dump()); } catch { nodes = []; }
      const pkg = igpost.screenPkg(nodes);
      if (pkg === TH_PKG) seenApp = true;
      const t0 = now();

      // a foreign app on top (launcher, browser): Back once per pass, give up after three
      if (seenApp && pkg && pkg !== TH_PKG && !/permissioncontroller|packageinstaller|^android$|systemui/.test(pkg)) {
        if (backs >= 3) {
          const shot = await screenshot();
          return { ok: false, state: 'failed', step: 'away', why: 'left Threads for ' + pkg, trace, pkg, screenshot_b64: shot };
        }
        await driver.key('back'); backs += 1;
        step('back', true, 'left Threads for ' + pkg + ' (' + backs + ')', t0);
        await driver.wait(1500);
        continue;
      }
      // system permission dialog: deny, then re-read
      if (pkg && /permissioncontroller|packageinstaller/i.test(pkg)) {
        const deny = igpost.findAny(nodes, [{ text: /^(don'?t allow|deny)$/i }, { text: /^not now$/i }]);
        if (deny) {
          await tapNode(nodes, deny.node);
          step('permission', true, 'refused the system prompt', t0);
          await driver.wait(JITTER());
          continue;
        }
        await driver.wait(800);
        continue;
      }
      // Meta's own pop-ups ("find friends" / "sync contacts" / tips): dismissed, not accepted
      const popup = igpost.findAny(nodes, POPUPS);
      if (popup) {
        await tapNode(nodes, popup.node);
        step('dismiss', true, igpost.redact(txtOf(popup.node) || descOf(popup.node), want), t0);
        await driver.wait(JITTER());
        continue;
      }
      // trouble: stop here, never tap on a disabled / checkpoint screen
      const bad = igpost.findAny(nodes, CHALLENGE.map((c) => ({ text: c.text })));
      if (bad) {
        const hit = CHALLENGE.find((c) => c.text.test(txtOf(bad.node)));
        return { ok: false, state: 'challenge', step: 'walk', why: (hit && hit.why) || 'challenge', trace, screenshot_b64: await screenshot() };
      }
      if (!nodes.length) {
        emptyReads += 1;
        if (emptyReads >= 10) {
          const shot = await screenshot();
          return { ok: false, state: 'failed', step: 'walk', why: 'the screen cannot be read (uiautomator never went idle)', trace, screenshot_b64: shot };
        }
        await driver.wait(1600);
        continue;
      }
      emptyReads = 0;

      // done: the feed's bottom navigation is in front (two markers together, or one when we
      // just tapped "Continue as" - the tap plus any nav piece is proof enough)
      const matched = FEED_MARKERS.filter((sel) => igpost.findAny(nodes, [sel])).length;
      if (matched >= 2 || (matched >= 1 && tappedContinue)) {
        step('feed', true, 'the Threads feed is up as @' + (handle || want), t0);
        return { ok: true, state: tappedContinue ? 'logged_in' : 'already_logged_in',
                 username: handle || want, trace, screenshot_b64: await screenshot() };
      }

      // the login offer: possibly several rows when the profile's Instagram holds several accounts
      const conts = nodes.filter((n) => CONTINUE_RE.test(txtOf(n)) || CONTINUE_RE.test(descOf(n)));
      if (conts.length) {
        let pick = conts[0];
        if (want) {
          const mine = conts.find((n) => new RegExp('@?' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i').test(txtOf(n)));
          if (mine) pick = mine;
        }
        const m = CONTINUE_RE.exec(txtOf(pick)) || CONTINUE_RE.exec(descOf(pick));
        handle = (m && m[1]) || want;
        await tapNode(nodes, pick);   // conts are raw parsed nodes, not findAny hits
        tappedContinue = true;
        step('continue', true, 'tapped as @' + handle, t0);
        await driver.wait(2500);
        continue;
      }

      // Threads' own login form (email/phone + password): there is no IG session to continue
      if (!tappedContinue && (igpost.findAny(nodes, [{ text: /^log in$/i }, { id: /login_button/ }]) &&
          igpost.findAny(nodes, [{ text: /^sign up$/i }]))) {
        step('no-continue', true, 'Threads shows its own login form', t0);
        const shot = await screenshot();
        return { ok: false, state: 'no_ig_account', why: 'no Instagram session to continue from', trace, screenshot_b64: shot };
      }

      // unknown screen: Back once mid-walk, evidence at the end
      unknowns += 1;
      if (unknowns === 4) { await driver.key('back'); backs += 1; step('back', true, 'unknown screen (' + backs + ')', t0); }
      else if (unknowns >= 10) {
        const shot = await screenshot();
        return { ok: false, state: 'failed', step: 'unknown_screen', why: 'no known Threads screen',
                 trace, screen: igpost.describe(nodes, want), screenshot_b64: shot };
      }
      await driver.wait(1800);
      if (Date.now() - start > 4 * 60000) {
        const shot = await screenshot();
        return { ok: false, state: 'failed', step: 'timeout', why: 'the login walk ran out of time', trace, screenshot_b64: shot };
      }
    }
    const shot = await screenshot();
    return { ok: false, state: 'failed', step: 'too_many_steps', why: 'the login walk took too many passes', trace, screenshot_b64: shot };
  } finally { /* the caller restores the phone */ }
}

module.exports = { run, TH_PKG };
