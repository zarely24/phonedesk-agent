'use strict';
// Pure, phone-free logic for the Instagram diagnostic — unit-testable without a device.
// Kept separate from ig-status-diagnose.js (which does the adb I/O) so the DECISION rules and the
// PRIVACY redaction can be tested deterministically.

// ------------------------------------------------------------------------------------------------
// GOAL 1 — multi-user foreground assessment. STRICT: we never conclude the background profile is
// inspectable just because a command launched or dumpsys named Instagram. We reason ONLY about
// whether the FOREGROUND Android user changed and whether it still equals the target.
//
// Inputs (all read on the phone, no switching performed):
//   currentUserBefore : `am get-current-user` before launch
//   currentUserAfter  : `am get-current-user` after `am start --user <target>`
//   fgAfter           : { uid, pkg } parsed from dumpsys (the ACTUAL resumed activity), or null
//   targetUid         : the profile we want to inspect
//   targetProofSeen   : (optional) true ONLY if a real-phone operator confirmed a target-profile-
//                       unique marker is visible in the dump while the foreground user is a DIFFERENT
//                       user. This is the only thing that can justify BACKGROUND_UI_CONFIRMED, and it
//                       cannot be produced automatically/safely — see the notes below.
//
// Result: BACKGROUND_UI_CONFIRMED | SWITCH_USER_REQUIRED | INCONCLUSIVE  (+ human-readable reasons).
// ------------------------------------------------------------------------------------------------
function assessMultiUser({ currentUserBefore, currentUserAfter, fgAfter, targetUid, targetProofSeen }) {
  const reasons = [];
  const T = Number(targetUid);
  const cb = currentUserBefore == null || currentUserBefore === '' ? null : Number(currentUserBefore);
  const ca = currentUserAfter == null || currentUserAfter === '' ? null : Number(currentUserAfter);

  if (cb == null || ca == null || !fgAfter || !Number.isFinite(T)) {
    reasons.push('could not read foreground user / resumed activity reliably');
    return { result: 'INCONCLUSIVE', reasons };
  }
  if (ca !== cb) {
    reasons.push(`foreground Android user CHANGED ${cb} -> ${ca} when launching; reaching the target changed the foreground user (a switch happened)`);
    return { result: 'SWITCH_USER_REQUIRED', reasons };
  }
  // Foreground user unchanged from here (ca === cb).
  if (cb === T) {
    reasons.push(`target uid ${T} was ALREADY the foreground user; this run did not exercise a background profile — rerun with a target that is not the current user`);
    return { result: 'INCONCLUSIVE', reasons };
  }
  // BACKGROUND_UI_CONFIRMED is only defensible if, WITHOUT changing the foreground user, we positively
  // proved the dump is the target's session. Standard UIAutomator dumps the FOREGROUND window only, so
  // this requires external, human-confirmed profile-unique evidence (targetProofSeen). We never infer
  // it from activity/package names.
  if (targetProofSeen === true) {
    reasons.push(`foreground user unchanged (${ca}) AND a target-profile-unique marker was confirmed in the dump; UIAutomator inspected the target without a switch`);
    return { result: 'BACKGROUND_UI_CONFIRMED', reasons };
  }
  const fgUid = fgAfter.uid == null ? null : Number(fgAfter.uid);
  if (fgUid === T) {
    reasons.push(`resumed activity claims user ${fgUid} (=target) but am get-current-user is still ${ca} (!=target); contradictory — cannot trust the hierarchy is the target's session`);
    return { result: 'INCONCLUSIVE', reasons };
  }
  reasons.push(`foreground Android user stayed ${ca} (!= target ${T}) after launch; UIAutomator dumps the foreground user, so the target profile cannot be inspected without switching`);
  return { result: 'SWITCH_USER_REQUIRED', reasons };
}

// ------------------------------------------------------------------------------------------------
// PRIVACY — redact PII before anything is written to disk OR printed to logs.
// ------------------------------------------------------------------------------------------------
function _redactValue(v, username) {
  let r = String(v == null ? '' : v);
  r = r.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '[EMAIL]');   // emails
  r = r.replace(/(\+?\d[\d ()\-]{7,}\d)/g, '[PHONE]');                              // phone-ish
  r = r.replace(/@[A-Za-z0-9._]{2,}/g, '[HANDLE]');                                 // @handles
  if (username) r = r.split(username).join('[USERNAME]');
  if (r.length > 60) r = '[LONG_TEXT_REDACTED]';                                    // messages/captions/bios
  return r;
}
// Sanitize a full uiautomator XML: redact every text= and content-desc= value; keep resource-ids
// (structural, not PII) and the node structure.
function sanitizeXml(xml, username) {
  return String(xml || '').replace(/(text|content-desc)="([^"]*)"/g, (m, attr, val) => `${attr}="${_redactValue(val, username)}"`);
}
// Sanitize an arbitrary UI-derived string before it is logged (nav content-descs, classifier evidence).
function sanitizeLine(s, username) { return _redactValue(s, username); }

// Which resource-ids / content-descs on a screen look like Account-Status navigation anchors. We only
// REPORT these (read-only); we never tap. resource-ids are structural; content-descs are sanitized.
function navCandidates(xml, username) {
  const ids = [...String(xml || '').matchAll(/resource-id="([^"]*)"/g)].map((m) => m[1]);
  const descs = [...String(xml || '').matchAll(/content-desc="([^"]*)"/g)].map((m) => m[1]);
  const interesting = (s) => /account.?status|menu|settings|options|hamburger|more|supervision|professional/i.test(s);
  return {
    resourceIds: [...new Set(ids.filter(interesting))].slice(0, 25),                       // structural, safe
    contentDescs: [...new Set(descs.filter(interesting))].map((d) => sanitizeLine(d, username)).slice(0, 25),
    mentionsAccountStatus: /account status/i.test(String(xml || '')),
  };
}

module.exports = { assessMultiUser, sanitizeXml, sanitizeLine, navCandidates };
