# Instagram classifier — real UI fixtures (Phase 1 drop point)

The classifier (`src/instagram.js`) is tested by `tools/test_instagram.js`. Today it runs only against
**synthetic** snippets whose text / resource-ids are **PROVISIONAL** — hand-written to exercise the
matching logic, **not** confirmed against a real Instagram build. This directory is where **real,
sanitized** `uiautomator` dumps go so the classifier is validated against what Instagram actually
renders.

**Do not add invented signatures here.** Only add dumps captured from a real device.

## How to capture (Phase 1, one phone, with approval)
For each state you can reproduce on a test account/profile:
```
adb -s <serial> shell uiautomator dump /sdcard/pd_dump.xml
adb -s <serial> pull /sdcard/pd_dump.xml <STATUS>__<short-note>.xml
```
Then **sanitize** the file before committing: remove usernames, real names, message/DM text, emails,
phone numbers, and any personal content. Keep only the structural signals the classifier reads
(`text=`, `content-desc=`, `resource-id=`) that justify the status.

## Manifest
Add each file to `expected.json` (same directory), mapping filename → expected status:
```json
{
  "HEALTHY__account_status_good.xml": "HEALTHY",
  "LOGIN_REQUIRED__logged_out.xml": "LOGIN_REQUIRED",
  "CHALLENGE_REQUIRED__code_entry.xml": "CHALLENGE_REQUIRED",
  "SUSPENDED__suspended_notice.xml": "SUSPENDED",
  "DISABLED__disabled_notice.xml": "DISABLED"
}
```
`node tools/test_instagram.js` loads them automatically and asserts `classify()` matches.

## Statuses to capture in Phase 1
HEALTHY (Account Status "can be recommended"), NOT_RECOMMENDED, LOGIN_REQUIRED, CHECKPOINT,
CHALLENGE_REQUIRED, SUSPENDED, DISABLED, APP_ERROR — plus the **path to reach Account Status**
(Profile → menu → Account Status) captured as resource-ids, to replace the undocumented
`instagram://account_status` deep link.

## Reminder
HEALTHY must require **positive evidence on the Account Status surface**. Simply opening Instagram or
seeing the home feed is never HEALTHY — keep that invariant when tuning against real dumps.
