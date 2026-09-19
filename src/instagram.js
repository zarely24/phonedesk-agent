'use strict';
// Instagram account-status classifier for PhoneDesk (spec §9-22).
//
// PURE + isolated on purpose: it takes a `uiautomator dump` XML string and returns a normalized
// status + evidence + confidence, with NO device I/O. That makes it unit-testable against sanitized
// XML fixtures (no phone) and easy to re-tune when Instagram changes its UI — the recognition rules
// live here as small independent matchers, not one giant function.
//
// Statuses returned MATCH the backend enum (app/monitoring/status.py): HEALTHY, NOT_RECOMMENDED,
// LOGIN_REQUIRED, CHECKPOINT, CHALLENGE_REQUIRED, SUSPENDED, DISABLED, APP_ERROR, UNKNOWN.
// Hard rule: never guess HEALTHY. If nothing matches, UNKNOWN (spec §21).

// Pull the human-readable signals out of the XML: text=, content-desc=, and resource-id=. We don't
// need a real XML parser — attribute scraping is robust to Instagram's deeply nested hierarchies.
function extract(xml) {
  const grab = (attr) => {
    const out = [];
    const re = new RegExp(attr + '="([^"]*)"', 'g');
    let m;
    while ((m = re.exec(xml || '')) !== null) if (m[1]) out.push(m[1]);
    return out;
  };
  const texts = grab('text').concat(grab('content-desc'));
  const ids = grab('resource-id');
  const blob = texts.join(' \n ').toLowerCase();
  return { texts, ids, blob, idBlob: ids.join(' ').toLowerCase() };
}
const anyOf = (blob, needles) => needles.find((n) => blob.includes(n)) || null;

// Rule set. Each returns {status, confidence, evidence} or null. Ordered by priority: technical and
// security/account states win over the "logged-in home" fallback so a challenge is never read as OK.
function detectAppError(s) {
  const hit = anyOf(s.blob, ["isn't responding", 'keeps stopping', 'has stopped', 'unfortunately', 'close app', 'wait for app']);
  if (hit) return { status: 'APP_ERROR', confidence: 0.9, evidence: ['app_not_responding: "' + hit + '"'] };
  return null;
}
function detectLogin(s) {
  const strong = anyOf(s.blob, ['log into another account', 'save your login info', "you can't use instagram without"]);
  const login = anyOf(s.blob, ['log in', 'sign in']);
  const cred = anyOf(s.blob, ['password', 'username, or email', 'phone number, username', 'phone number, username or email']);
  const idLogin = anyOf(s.idBlob, ['login_username', 'login_password', 'log_in_button', 'login']);
  if (strong || (login && (cred || idLogin))) {
    return { status: 'LOGIN_REQUIRED', confidence: strong ? 0.97 : 0.93,
             evidence: ['login_screen_detected'].concat(cred ? ['credential_field_detected'] : []) };
  }
  return null;
}
function detectChallenge(s) {
  const hit = anyOf(s.blob, [
    "confirm it's you", 'confirm it’s you', 'we detected unusual', 'unusual activity',
    'suspicious login', 'help us confirm', 'confirm your identity', 'verify your identity',
    'enter the code', 'we sent a code', 'we sent you a code', 'security code', 'two-factor',
    'we need to confirm', 'get back into your account',
  ]);
  if (hit) return { status: 'CHALLENGE_REQUIRED', confidence: 0.95, evidence: ['challenge_detected: "' + hit + '"'] };
  const cp = anyOf(s.blob, ['confirm your account', 'we restricted some activity', 'action blocked', 'try again later']);
  if (cp) return { status: 'CHECKPOINT', confidence: 0.85, evidence: ['checkpoint_detected: "' + cp + '"'] };
  return null;
}
function detectDisabledSuspended(s) {
  const dis = anyOf(s.blob, ['your account has been disabled', 'account was disabled', 'we disabled your account', 'account has been disabled for']);
  if (dis) return { status: 'DISABLED', confidence: 0.98, evidence: ['account_disabled: "' + dis + '"'] };
  const sus = anyOf(s.blob, ['your account has been suspended', 'we suspended your account', 'account suspended', 'suspended your account']);
  if (sus) return { status: 'SUSPENDED', confidence: 0.98, evidence: ['account_suspended: "' + sus + '"'] };
  return null;
}
// The primary signal (spec §13): Instagram's "Account Status" recommendation state. Only trust this
// when we're actually on the Account Status surface.
function detectAccountStatus(s) {
  const onPage = s.blob.includes('account status') || anyOf(s.blob, ['can be recommended', "can't be recommended", 'recommendation guidelines', 'affects how your account is recommended']);
  if (!onPage) return null;
  // NOTE: "non-followers" is NOT a discriminator — it appears in both the good ("can be recommended
  // to non-followers") and bad wording, so match only the explicit negative phrasings.
  const bad = anyOf(s.blob, ["can't be recommended", 'cannot be recommended', 'not recommended', "doesn't follow our recommendation", 'affects how your account is recommended']);
  if (bad) return { status: 'NOT_RECOMMENDED', confidence: 0.97, evidence: ['account_status: "' + bad + '"'] };
  const good = anyOf(s.blob, ['your account can be recommended', 'can be recommended to non-followers', 'no violations', "doesn't have any", 'follows our recommendation guidelines', 'your account follows']);
  if (good) return { status: 'HEALTHY', confidence: 0.97, evidence: ['account_status: "' + good + '"'] };
  return null;
}
// Is the user on a normal logged-in Instagram home/nav (so at least not logged out / challenged)?
function isLoggedInHome(s) {
  const idHit = anyOf(s.idBlob, ['tab_bar', 'feed_tab', 'action_bar_inbox', 'profile_tab', 'tab_avatar', 'creation_tab']);
  const descHit = anyOf(s.blob, ['home', 'reels', 'search and explore', 'your profile', 'new post']);
  return !!(idHit || (descHit && s.texts.length > 4));
}

// Classify the CURRENT screen. `loggedInHome` tells the caller it may navigate to Account Status and
// re-classify; on its own, a logged-in home is NOT proof of recommendation status, so we return
// UNKNOWN rather than guess HEALTHY (spec §21).
function classify(xml) {
  if (!xml || xml.trim().length < 20) {
    return { status: 'UNKNOWN', confidence: 0.15, evidence: ['empty_or_no_hierarchy'], loggedInHome: false };
  }
  const s = extract(xml);
  for (const rule of [detectAppError, detectAccountStatus, detectDisabledSuspended, detectChallenge, detectLogin]) {
    const r = rule(s);
    if (r) return Object.assign({ loggedInHome: false }, r);
  }
  const home = isLoggedInHome(s);
  if (home) {
    return { status: 'UNKNOWN', confidence: 0.3, loggedInHome: true,
             evidence: ['logged_in_home_detected', 'account_status_not_read'] };
  }
  return { status: 'UNKNOWN', confidence: 0.2, evidence: ['unrecognised_screen'], loggedInHome: false };
}

module.exports = { classify, extract, isLoggedInHome };
