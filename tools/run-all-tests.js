// `npm test`: every suite in tools/ (test_*.js and test-*.js), one after the other, one line each.
// No phone needed; about half a minute (the freeze suites wait out real delays).
// Exit code 1 when any suite fails, so it can gate a release by hand:  npm test && git tag vX.Y.Z
//
// Added with v0.5.16 (2026-11-10): the review of that release noted that nothing ran the suites
// together and that the release workflow builds a tag without running any of them.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => /^test[_-].*\.js$/.test(f)).sort();
let failed = 0;
const t0 = Date.now();
for (const f of suites) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${f.padEnd(30)} ${String(Math.round((Date.now() - t) / 1000)).padStart(3)} s  ${last.slice(0, 90)}`);
  if (!ok) {
    const bad = out.split(/\r?\n/).filter((l) => /^(FAIL|not ok|\s+got |\s+want )/.test(l) || /Error/.test(l)).slice(0, 12);
    if (bad.length) console.log(bad.map((l) => '      ' + l.slice(0, 200)).join('\n'));
    if (r.error) console.log('      ' + String(r.error.message || r.error));
  }
}
console.log(`\n${suites.length - failed} of ${suites.length} suites passed in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
