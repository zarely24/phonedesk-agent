'use strict';
// Unit tests for the Phase-1 diagnostic LOGIC (no phone): the strict three-state multi-user
// assessment and the PII redaction. Run: node tools/test_ig_diagnose.js
const { assessMultiUser, sanitizeXml, sanitizeLine, navCandidates } = require('./ig-diagnose-logic');

let fails = 0, ran = 0;
const ok = (name, cond) => { ran++; if (!cond) fails++; console.log((cond ? '  ok   ' : '  FAIL ') + name); };

console.log('GOAL 1 — assessMultiUser (strict three-state):');

// SWITCH_USER_REQUIRED: foreground stayed a DIFFERENT user than the target.
ok('fg stays user 0, target 11 -> SWITCH_USER_REQUIRED',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: { uid: 0, pkg: 'com.android.launcher' }, targetUid: 11 }).result === 'SWITCH_USER_REQUIRED');
ok('fg stays user 0 showing IG (user 0), target 11 -> SWITCH_USER_REQUIRED',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: { uid: 0, pkg: 'com.instagram.android' }, targetUid: 11 }).result === 'SWITCH_USER_REQUIRED');

// SWITCH_USER_REQUIRED: launching the target CHANGED the foreground android user (a switch happened).
ok('foreground user changed 0 -> 11 -> SWITCH_USER_REQUIRED (a switch occurred)',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '11', fgAfter: { uid: 11, pkg: 'com.instagram.android' }, targetUid: 11 }).result === 'SWITCH_USER_REQUIRED');

// INCONCLUSIVE cases.
ok('could not read current-user -> INCONCLUSIVE',
  assessMultiUser({ currentUserBefore: '', currentUserAfter: '0', fgAfter: { uid: 0, pkg: 'x' }, targetUid: 11 }).result === 'INCONCLUSIVE');
ok('could not read foreground activity -> INCONCLUSIVE',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: null, targetUid: 11 }).result === 'INCONCLUSIVE');
ok('target was already the foreground user -> INCONCLUSIVE (did not test background)',
  assessMultiUser({ currentUserBefore: '11', currentUserAfter: '11', fgAfter: { uid: 11, pkg: 'com.instagram.android' }, targetUid: 11 }).result === 'INCONCLUSIVE');
ok('contradictory (fg uid says target but current-user unchanged & != target) -> INCONCLUSIVE',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: { uid: 11, pkg: 'com.instagram.android' }, targetUid: 11 }).result === 'INCONCLUSIVE');

// BACKGROUND_UI_CONFIRMED: ONLY with externally-confirmed target-profile proof + unchanged foreground.
ok('never BACKGROUND_UI_CONFIRMED from signals alone',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: { uid: 0, pkg: 'com.instagram.android' }, targetUid: 11 }).result !== 'BACKGROUND_UI_CONFIRMED');
ok('BACKGROUND_UI_CONFIRMED only with targetProofSeen + unchanged foreground',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: { uid: 0, pkg: 'com.instagram.android' }, targetUid: 11, targetProofSeen: true }).result === 'BACKGROUND_UI_CONFIRMED');
ok('targetProofSeen but foreground CHANGED -> still SWITCH_USER_REQUIRED (a switch happened)',
  assessMultiUser({ currentUserBefore: '0', currentUserAfter: '11', fgAfter: { uid: 11, pkg: 'com.instagram.android' }, targetUid: 11, targetProofSeen: true }).result === 'SWITCH_USER_REQUIRED');
ok('every result is one of the three allowed values',
  ['BACKGROUND_UI_CONFIRMED', 'SWITCH_USER_REQUIRED', 'INCONCLUSIVE'].includes(
    assessMultiUser({ currentUserBefore: '0', currentUserAfter: '0', fgAfter: { uid: 0, pkg: 'x' }, targetUid: 11 }).result));

console.log('\nPRIVACY — redaction:');
const xml = '<node resource-id="com.instagram.android:id/tab_bar" text="john.doe@gmail.com" content-desc="@bob_handle"/>'
  + '<node text="+1 (415) 555-1234"/><node text="' + 'a'.repeat(90) + '"/><node text="myuser42"/>';
const clean = sanitizeXml(xml, 'myuser42');
ok('email redacted', clean.includes('[EMAIL]') && !clean.includes('john.doe@gmail.com'));
ok('@handle redacted', clean.includes('[HANDLE]') && !clean.includes('@bob_handle'));
ok('phone redacted', clean.includes('[PHONE]') && !clean.includes('555-1234'));
ok('long text redacted', clean.includes('[LONG_TEXT_REDACTED]') && !clean.includes('a'.repeat(90)));
ok('given username redacted', clean.includes('[USERNAME]') && !clean.includes('myuser42'));
ok('structural resource-id KEPT (not PII)', clean.includes('com.instagram.android:id/tab_bar'));
ok('sanitizeLine redacts a lone evidence string', sanitizeLine('challenge for user@x.com', '').includes('[EMAIL]'));

console.log('\nnavCandidates (read-only, sanitized):');
const nav = navCandidates('<node resource-id="com.instagram.android:id/menu_settings_row"/><node content-desc="Account Status"/><node content-desc="dm from @secret"/>', '');
ok('finds interesting resource-id', nav.resourceIds.some((s) => /menu_settings/.test(s)));
ok('content-descs are sanitized', nav.contentDescs.every((s) => !s.includes('@secret')));
ok('detects Account Status text', nav.mentionsAccountStatus === true);

console.log(`\n${fails ? 'FAILED ❌ (' + fails + ')' : 'PASSED ✅'}  (${ran} checks) — diagnostic logic + privacy`);
process.exit(fails ? 1 : 0);
