'use strict';
// v0.5.22 - one target visit for the backend's engagement runner (app/posting/engage.py). core.js
// has already switched to the profile and deep-linked the USA account INSIDE Instagram; this module
// is the eyes and the fingers: confirm whose profile is in front, tap Follow (when asked and not
// already following), open a recent post and Like it, back out.
//
// PURE (no adb, no clock), like igpost.js: the driver is { dump() -> xml, tap(x, y), key(name),
// wait(ms), screenshot()? } and the tests in tools/test_igengage.js drive it with fakes.
//
// IT NEVER: comments, opens DMs, types, follows private-request accounts twice, or touches
// anything but the Follow button and the Like button. The backend decides whether this visit
// follows at all (the caps and the ledger are its business).
//
// The like is best-effort: if the profile grid cannot be recognised on a build (the selectors are
// id/desc-based with a square-container fallback), the visit still succeeds with liked: 0 and the
// reply says so - the backend records visit + follow regardless.

const ig = require('./igpost');

const HANDLE_RE = /^[a-z0-9._]{1,30}$/i;
const FOLLOW_SEL = [{ text: /^follow$/i }, { desc: /^follow$/i }];
const FOLLOWING_RE = /^(following|requested)\s*$/i;
const UNLIKE_RE = /^unlike$/i;
const LIKE_RE = /^like$/i;

function thumbOf(n) {
  return /^(photo|video) thumbnail/i.test(String(n.desc || '')) || /(^|\/)(cell_|gallery_grid_item_thumbnail)/i.test(String(n.id || ''));
}

/** The profile grid's post cells, top-to-bottom then left-to-right: the order a person opens them
    in. Recognised by desc/id first; when a build names nothing, square-ish clickable containers in
    the middle band of the screen (a 3-wide grid is squares). */
function gridCells(nodes) {
  const size = ig.screenSize(nodes);
  let cells = nodes.filter((n) => n.bounds && thumbOf(n));
  if (!cells.length) {
    cells = nodes.filter((n) => {
      if (!n.bounds || !n.clickable) return false;
      const b = n.bounds;
      if (b.t < size.h * 0.15 || b.b > size.h * 0.85) return false;
      const bw = b.r - b.l, bh = b.b - b.t;
      return bw > size.w * 0.2 && Math.abs(bw - bh) <= bw * 0.4;
    });
  }
  cells.sort((a, b) => (Math.floor(a.bounds.t / 80) - Math.floor(b.bounds.t / 80)) || (a.bounds.l - b.bounds.l));
  return cells.map((n) => ({ x: n.cx, y: n.cy }));
}

/** One visit. Returns { state: 'visited'|'not_loaded'|'blocked'|'left_app'|'aborted'|'failed',
    followed, already_following, requested, liked, why, trace } - core.js wraps it in the RPC reply. */
async function run(driver, target, opts) {
  const o = opts || {};
  const trace = [];
  const out = { state: 'failed', followed: false, already_following: false, requested: false, liked: 0, why: '', trace };
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const aborted = async () => !!(o.abort && (await o.abort()));
  const dump = async () => ig.parseDump(await driver.dump());
  const appPkg = o.appPkg || 'com.instagram.android';
  const want = String(target || '').trim().replace(/^@/, '').toLowerCase();
  let seenApp = false;

  // 1) the profile: wait up to loadMs for the action-bar title to BE the target (retries matter:
  //    a cold profile can take several seconds; a wrong profile is never tapped).
  const loadMs = o.loadMs || 15000;
  let nodes = null, lastPkg = '', readTitle = '';
  while (ms() < loadMs) {
    if (await aborted()) { out.state = 'aborted'; out.why = 'a viewer opened the phone'; return out; }
    nodes = await dump().catch(() => []);
    const pkg = ig.screenPkg(nodes);
    if (pkg === appPkg) seenApp = true;
    lastPkg = pkg || lastPkg;
    const away = seenApp && pkg && pkg !== appPkg && !/permissioncontroller|packageinstaller|^android$|systemui/i.test(pkg);
    if (away) { out.state = 'left_app'; out.why = `left Instagram for ${pkg}`; return out; }
    const fatal = ig.findAny(nodes, ig.FATAL.map((f) => ({ text: f.text })));
    if (fatal) { const f = ig.FATAL.find((x) => x.text === fatal.sel.text); out.state = 'blocked'; out.why = f ? f.why : 'blocked'; return out; }
    const title = ig.usernameFrom(nodes, nodes.length ? ig.screenSize(nodes).h : 0).toLowerCase();
    if (title === want) break;
    if (title) readTitle = title;
    nodes = null;
    await driver.wait(2000);
  }
  if (!nodes) {
    out.state = 'not_loaded';
    // what WAS in front, for the record: the deep link landing in the browser reads as chrome's
    // package, a redirected profile shows another username, a phone still booting shows none.
    out.why = `the profile did not open (wanted @${want}`
      + (readTitle ? `, @${readTitle} was in front` : lastPkg && lastPkg !== appPkg ? `, ${lastPkg} was in front` : '') + ')';
    return out;
  }
  trace.push({ name: 'profile', ok: true, matched: `@${want}`, ms: ms() });

  // 2) follow - only the exact standalone button; "Following"/"Requested" already showing means
  //    this profile got there before we did (the backend's ledger should have caught it; believe
  //    the screen, not the ledger). After the tap, wait for the word to change.
  if (o.follow) {
    if (await aborted()) { out.state = 'aborted'; out.why = 'a viewer opened the phone'; return out; }
    const state = (ns) => ig.findAny(ns, [{ text: FOLLOWING_RE }, { desc: FOLLOWING_RE }]);
    if (state(nodes)) {
      out.already_following = true;
      out.requested = /^requested$/i.test(String((state(nodes).node.text || state(nodes).node.desc || '')));
      out.state = 'visited';
      trace.push({ name: 'follow', ok: true, matched: out.requested ? 'already requested' : 'already following', ms: ms() });
    } else {
      const btn = ig.findAny(nodes, FOLLOW_SEL);
      if (btn) {
        const t = ig.tapTarget(nodes, btn.node);
        await driver.tap(t.cx, t.cy);
        await driver.wait(2200);
        const after = await dump();
        if (state(after)) {
          out.followed = true;
          out.requested = /requested/i.test(String((state(after).node.text || state(after).node.desc || '')));
          trace.push({ name: 'follow', ok: true, matched: out.requested ? 'requested' : 'followed', ms: ms() });
        } else {
          trace.push({ name: 'follow', ok: false, matched: 'tapped, no confirmation', ms: ms() });
        }
      } else {
        trace.push({ name: 'follow', ok: true, matched: 'no Follow button (private or blocked)', ms: ms() });
      }
      out.state = 'visited';
    }
  } else {
    out.state = 'visited';
  }

  // 3) like up to like_posts recent posts: open the grid cell, tap the post's own Like button,
  //    back. A post whose button already says Unlike is skipped (the like would come off). An
  //    unrecognisable grid ends the liking, not the visit.
  const nPosts = Math.max(0, Math.min(2, parseInt(o.like_posts, 10) || 0));
  for (let i = 0; i < nPosts; i++) {
    if (await aborted()) { out.state = 'aborted'; out.why = 'a viewer opened the phone'; return out; }
    nodes = await dump().catch(() => []);
    const cells = gridCells(nodes);
    if (!cells[i]) { trace.push({ name: `like ${i + 1}`, ok: true, matched: `no post ${i + 1} on the grid`, ms: ms() }); break; }
    await driver.tap(cells[i].x, cells[i].y);
    await driver.wait(2600);
    nodes = await dump().catch(() => []);
    if (ig.screenPkg(nodes) && ig.screenPkg(nodes) !== appPkg) { await driver.key('back'); await driver.wait(1200); continue; }
    if (!ig.findAny(nodes, [{ desc: UNLIKE_RE }])) {
      const like = ig.findAny(nodes, [{ desc: LIKE_RE }]);
      if (like) {
        const t = ig.tapTarget(nodes, like.node);
        await driver.tap(t.cx, t.cy);
        out.liked += 1;
        await driver.wait(1400);
        trace.push({ name: `like ${i + 1}`, ok: true, matched: 'liked', ms: ms() });
      } else {
        trace.push({ name: `like ${i + 1}`, ok: true, matched: 'no Like button on the post', ms: ms() });
      }
    } else {
      trace.push({ name: `like ${i + 1}`, ok: true, matched: 'already liked', ms: ms() });
    }
    await driver.key('back');
    await driver.wait(1600);
  }
  if (out.liked < nPosts) out.why = out.why || (out.liked ? `liked ${out.liked} of ${nPosts}` : 'no recent post could be liked');
  return out;
}

module.exports = { run, gridCells };
