'use strict';
// Fixture tests for the Instagram classifier (spec §29). No phone required: each fixture is a
// sanitized `uiautomator dump` snippet for a known state, and we assert the normalized status.
// When Instagram changes its UI, update a fixture here and re-run — no device needed.
const { classify } = require('../src/instagram');

// Minimal but representative uiautomator XML. Real dumps are far larger/nested; the classifier
// only scrapes text=/content-desc=/resource-id=, so these exercise the same matchers.
const node = (attrs) => `<node ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')} />`;
const wrap = (nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.join('')}</hierarchy>`;

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
  // Logged-in home: NOT enough to prove recommendation status -> UNKNOWN + loggedInHome:true
  LOGGED_IN_HOME: wrap([
    node({ 'resource-id': 'com.instagram.android:id/tab_bar' }),
    node({ 'content-desc': 'Home' }), node({ 'content-desc': 'Reels' }),
    node({ 'content-desc': 'Search and explore' }), node({ 'content-desc': 'Your profile' }),
    node({ 'content-desc': 'New post' }),
  ]),
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
  ['LOGGED_IN_HOME', 'UNKNOWN', true],   // logged in, but account status not read
  ['UNKNOWN', 'UNKNOWN', false],
  ['EMPTY', 'UNKNOWN', false],
];

let fails = 0;
for (const [fixture, wantStatus, wantHome] of cases) {
  const r = classify(FIX[fixture]);
  const ok = r.status === wantStatus && (!!r.loggedInHome === wantHome);
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + fixture + ' -> ' + r.status +
    (r.loggedInHome ? ' (loggedInHome)' : '') + '  conf=' + r.confidence +
    (ok ? '' : `   [wanted ${wantStatus}${wantHome ? ' +home' : ''}]`));
  if (!ok) fails++;
}
// Never-guess-HEALTHY invariant: a logged-in home must NOT classify as HEALTHY on its own.
if (classify(FIX.LOGGED_IN_HOME).status === 'HEALTHY') { console.log('  FAIL  invariant: logged-in home guessed HEALTHY'); fails++; }

if (fails) { console.log(`\nFAILED ❌ (${fails})`); process.exit(1); }
console.log('\nPASSED ✅ (all Instagram classifier fixtures)');
