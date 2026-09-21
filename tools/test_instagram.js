'use strict';
// Fixture tests for the Instagram classifier (spec §29). No phone required.
//
// TWO sources of fixtures:
//  1) SYNTHETIC (inline below): tiny hand-written uiautomator snippets that exercise each matcher and
//     the "never guess HEALTHY" invariants. They test the classifier LOGIC, not real Instagram — the
//     text/resource-ids here are PROVISIONAL and must be validated against a real device in Phase 1.
//  2) REAL (tools/fixtures/instagram/*.xml + expected.json): sanitized dumps captured from an actual
//     phone. This directory is the Phase-1 drop point; the loader picks them up automatically. It is
//     intentionally empty of real signatures now (we do not invent Instagram IDs/text we haven't seen).
//
// Run: node tools/test_instagram.js
const fs = require('fs');
const path = require('path');
const { classify } = require('../src/instagram');

const node = (attrs) => `<node ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')} />`;
const wrap = (nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.join('')}</hierarchy>`;

// ---- SYNTHETIC fixtures (provisional signatures — validate on real device in Phase 1) ----
const FIX = {
  HEALTHY: wrap([
    node({ 'resource-id': 'com.instagram.android:id/action_bar_title', text: 'Account Status' }),
    node({ text: 'Your account can be recommended to non-followers' }),
    node({ text: 'No violations of our Recommendation Guidelines' }),
  ]),
  NOT_RECOMMENDED: wrap([
    node({ 'resource-id': 'com.instagram.android:id/action_bar_title', text: 'Account Status' }),
    node({ text: "Can't be recommended to non-followers" }),
    node({ text: 'This affects how your account is recommended' }),
  ]),
  LOGIN_REQUIRED: wrap([
    node({ 'resource-id': 'com.instagram.android:id/login_username', text: 'Phone number, username or email' }),
    node({ 'resource-id': 'com.instagram.android:id/password', text: 'Password' }),
    node({ text: 'Log in' }),
  ]),
  CHALLENGE_REQUIRED: wrap([
    node({ text: "Confirm it's you" }),
    node({ text: 'We detected unusual activity on your account' }),
    node({ text: 'Enter the code we sent you' }),
  ]),
  SUSPENDED: wrap([
    node({ text: 'We suspended your account' }),
    node({ text: 'You have 30 days to disagree with this decision' }),
  ]),
  DISABLED: wrap([
    node({ text: 'Your account has been disabled' }),
    node({ text: 'If you think this was a mistake, you can request a review' }),
  ]),
  APP_ERROR: wrap([
    node({ text: "Instagram isn't responding" }),
    node({ text: 'Close app' }), node({ text: 'Wait' }),
  ]),
  // Logged-in home: NOT enough to prove recommendation status -> UNKNOWN + loggedInHome:true.
  LOGGED_IN_HOME: wrap([
    node({ 'resource-id': 'com.instagram.android:id/tab_bar' }),
    node({ 'content-desc': 'Home' }), node({ 'content-desc': 'Reels' }),
    node({ 'content-desc': 'Search and explore' }), node({ 'content-desc': 'Your profile' }),
    node({ 'content-desc': 'New post' }),
  ]),
  // ---- "never HEALTHY accidentally" edge cases ----
  // Home feed that happens to contain the word "recommended" (Suggested-for-you etc.) but is NOT the
  // Account Status surface -> must NOT be HEALTHY.
  HOME_WITH_RECOMMENDED_WORD: wrap([
    node({ 'resource-id': 'com.instagram.android:id/tab_bar' }),
    node({ 'content-desc': 'Home' }), node({ 'content-desc': 'Your profile' }),
    node({ text: 'Suggested for you' }), node({ text: 'Recommended accounts' }),
    node({ text: 'Follow' }), node({ text: 'Reels' }),
  ]),
  // On the Account Status surface but with no clear good/bad wording -> UNKNOWN, never HEALTHY.
  ACCOUNT_STATUS_AMBIGUOUS: wrap([
    node({ 'resource-id': 'com.instagram.android:id/action_bar_title', text: 'Account Status' }),
    node({ text: 'Overview' }), node({ text: 'Loading' }),
  ]),
  // Just the words "Log in" with no credential field / id -> not enough for LOGIN_REQUIRED.
  LOGIN_WORD_ONLY: wrap([node({ text: 'Log in with Facebook' }), node({ text: 'Terms' })]),
  UNKNOWN: wrap([node({ text: 'Something completely different' })]),
  EMPTY: '',
};

const cases = [
  ['HEALTHY', 'HEALTHY', false],
  ['NOT_RECOMMENDED', 'NOT_RECOMMENDED', false],
  ['LOGIN_REQUIRED', 'LOGIN_REQUIRED', false],
  ['CHALLENGE_REQUIRED', 'CHALLENGE_REQUIRED', false],
  ['SUSPENDED', 'SUSPENDED', false],
  ['DISABLED', 'DISABLED', false],
  ['APP_ERROR', 'APP_ERROR', false],
  ['LOGGED_IN_HOME', 'UNKNOWN', true],
  ['HOME_WITH_RECOMMENDED_WORD', 'UNKNOWN', true],   // <- must not be HEALTHY
  ['ACCOUNT_STATUS_AMBIGUOUS', 'UNKNOWN', false],    // <- on page but unclear -> UNKNOWN
  ['LOGIN_WORD_ONLY', 'UNKNOWN', false],
  ['UNKNOWN', 'UNKNOWN', false],
  ['EMPTY', 'UNKNOWN', false],
];

let fails = 0, ran = 0;
const check = (name, ok, detail) => { ran++; if (!ok) fails++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  ' + detail : '')); };

console.log('SYNTHETIC fixtures:');
for (const [fixture, wantStatus, wantHome] of cases) {
  const r = classify(FIX[fixture]);
  const ok = r.status === wantStatus && (!!r.loggedInHome === wantHome);
  check(`${fixture} -> ${r.status}${r.loggedInHome ? ' (home)' : ''}`, ok, ok ? '' : `[wanted ${wantStatus}${wantHome ? '+home' : ''}]`);
}
// Hard invariant: NOTHING that looks like a home/feed may classify HEALTHY on its own.
for (const fx of ['LOGGED_IN_HOME', 'HOME_WITH_RECOMMENDED_WORD', 'ACCOUNT_STATUS_AMBIGUOUS', 'LOGIN_WORD_ONLY', 'UNKNOWN', 'EMPTY']) {
  check(`invariant: ${fx} is never HEALTHY`, classify(FIX[fx]).status !== 'HEALTHY');
}

// ---- REAL fixtures (Phase 1 drop point) ----
const dir = path.join(__dirname, 'fixtures', 'instagram');
let real = 0;
try {
  const manifestPath = path.join(dir, 'expected.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entries = Object.entries(manifest).filter(([f]) => f.endsWith('.xml'));
    if (entries.length) {
      console.log(`\nREAL fixtures (${entries.length}):`);
      for (const [file, want] of entries) {
        const xml = fs.readFileSync(path.join(dir, file), 'utf8');
        const r = classify(xml);
        const wantStatus = typeof want === 'string' ? want : want.status;
        check(`${file} -> ${r.status}`, r.status === wantStatus, r.status === wantStatus ? '' : `[wanted ${wantStatus}]`);
        real++;
      }
    }
  }
} catch (e) { console.log('  (real-fixture load error: ' + e.message + ')'); }
if (!real) console.log('\nREAL fixtures: 0 — none captured yet (Phase 1). Loader is ready; drop *.xml + expected.json into tools/fixtures/instagram/.');

console.log(`\n${fails ? 'FAILED ❌ (' + fails + ')' : 'PASSED ✅'}  (${ran} checks, ${real} real fixtures)`);
process.exit(fails ? 1 : 0);
