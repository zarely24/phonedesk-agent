'use strict';
// src/igpost.js, driven with scripted screens and a fake driver - no phone, no adb.
// Run:  node tools/test_igpost.js
const ig = require('../src/igpost');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const node = (o) => {
  const b = o.bounds || [0, 0, 100, 100];
  const a = [`text="${o.text || ''}"`, `content-desc="${o.desc || ''}"`, `resource-id="${o.id || ''}"`, `class="${o.cls || 'android.widget.TextView'}"`,
             `package="${o.pkg || 'com.instagram.android'}"`, `clickable="${o.clickable ? 'true' : 'false'}"`, `enabled="${o.enabled === false ? 'false' : 'true'}"`,
             `focused="${o.focused ? 'true' : 'false'}"`, `bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]"`];
  return `<node index="0" ${a.join(' ')} />`;
};
const screen = (...nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.map(node).join('')}</hierarchy>`;
// a screen another app draws (every node carries that app's package)
const appScreen = (pkg, ...nodes) => screen(...nodes.map((n) => ({ ...n, pkg })));
// a screen that Back closes (a promo sheet): the fake phone moves on when Back is pressed on it
const closesOnBack = (xml) => ({ xml, onBack: true });

// Screens, roughly as Instagram draws them (the ids are the provisional ones the flows look for).
const HOME = screen({ id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] },
                    { id: 'com.instagram.android:id/creation_tab', desc: 'Create', clickable: true, bounds: [430, 2220, 650, 2380] },
                    { id: 'com.instagram.android:id/profile_tab', desc: 'Profile', clickable: true, bounds: [860, 2220, 1080, 2380] });
const CREATE_SHEET = screen({ text: 'Post', clickable: true, bounds: [0, 1800, 1080, 1900] }, { text: 'Reel', clickable: true, bounds: [0, 1900, 1080, 2000] }, { text: 'Story', clickable: true, bounds: [0, 2000, 1080, 2100] });
const GALLERY = screen({ id: 'com.instagram.android:id/gallery_grid_item_thumbnail', desc: 'Video thumbnail', clickable: true, bounds: [0, 300, 360, 660] },
                       { id: 'com.instagram.android:id/gallery_grid_item_thumbnail', desc: 'Photo thumbnail', clickable: true, bounds: [360, 300, 720, 660] },
                       { id: 'com.instagram.android:id/next_button', text: 'Next', clickable: true, bounds: [900, 100, 1060, 200] });
const EDITOR = screen({ id: 'com.instagram.android:id/clips_right_action_button', text: 'Next', clickable: true, bounds: [900, 2250, 1060, 2350] });
const SHARE_SHEET = screen({ id: 'com.instagram.android:id/caption_input_text_view', text: 'Write a caption...', clickable: true, bounds: [40, 300, 1040, 500] },
                           { id: 'com.instagram.android:id/share_button', text: 'Share', clickable: true, bounds: [40, 2200, 1040, 2320] });
const SHARED = screen({ text: 'Sharing to Reels…', bounds: [0, 200, 1080, 260] }, { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] });
const POPUP_OVER_HOME = screen({ text: 'Turn on notifications?', bounds: [100, 900, 980, 1000] }, { text: 'Not now', clickable: true, bounds: [100, 1100, 980, 1200] },
                               { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] });
const LOGIN = screen({ text: 'Phone number, username or email', bounds: [40, 900, 1040, 1000] }, { text: 'Log in', clickable: true, bounds: [40, 1100, 1040, 1200] });
const AUDIO_PAGE = screen({ text: 'Original audio', bounds: [0, 300, 1080, 360] }, { text: 'Use audio', clickable: true, bounds: [40, 2200, 1040, 2320] });
const CAMERA = screen({ id: 'com.instagram.android:id/camera_gallery_button', desc: 'Open gallery', clickable: true, bounds: [40, 2200, 240, 2400] });
const PROFILE = screen({ id: 'com.instagram.android:id/action_bar_title', text: 'bella.rose_22', bounds: [200, 100, 800, 180] },
                       { text: 'Edit profile', clickable: true, bounds: [40, 900, 1040, 1000] }, { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] });

// A fake phone: a list of screens. A dump shows the current one (as a real phone keeps showing the
// same screen however often it is dumped); a TAP moves to the next screen (the last one repeats).
// Records taps/types/keys and the simulated time.
function fakeDriver(screens) {
  const q = screens.slice(); let i = 0, t = 0;
  const cur = () => q[Math.min(i, q.length - 1)];
  const d = { taps: [], typed: [], keys: [], swipes: [], waited: 0,
    dump: async () => (typeof cur() === 'string' ? cur() : cur().xml),
    tap: async (x, y) => { d.taps.push([x, y]); i++; }, type: async (s) => { d.typed.push(s); },
    key: async (k) => { d.keys.push(k); if (k === 'back' && typeof cur() === 'object' && cur().onBack) i++; },
    swipe: async (x1, y1, x2, y2, ms) => { d.swipes.push([x1, y1, x2, y2, ms]); },
    wait: async (ms) => { d.waited += ms; t += ms; }, now: () => t, screenshot: async () => Buffer.from('png') };
  return d;
}

// ---------- parsing + matching ----------
{
  const nodes = ig.parseDump(HOME);
  check('parses every node with bounds and a centre', [nodes.length, nodes[1].cx, nodes[1].cy], [3, 540, 2300]);
  check('id matches on the tail after the slash', !!ig.find(nodes, { id: 'creation_tab' }), true);
  check('id matches by regex', !!ig.find(nodes, { id: /^com\.instagram\.android:id\/profile_tab$/ }), true);
  check('desc matches case-insensitively as a substring', !!ig.find(nodes, { desc: 'creat' }), true);
  check('a miss is null, not a throw', ig.find(nodes, { text: 'nope' }), null);
  check('findAny returns the first candidate that hits, in order', ig.findAny(nodes, [{ text: 'x' }, { desc: /^profile$/i }]).node.id, 'com.instagram.android:id/profile_tab');
  const n2 = ig.parseDump(screen({ text: 'Use audio', bounds: [100, 2250, 300, 2300] }, { clickable: true, bounds: [40, 2200, 1040, 2320], cls: 'android.widget.Button' }));
  check('an unclickable label resolves to the clickable box around it', ig.tapTarget(n2, n2[0]).cls, 'android.widget.Button');
  check('XML entities are unescaped', ig.parseDump(screen({ text: 'Rock &amp; roll &quot;live&quot;' }))[0].text, 'Rock & roll "live"');
  const d = ig.describe(ig.parseDump(PROFILE), 'bella.rose_22');
  check('describe redacts the username and lists ids without the package prefix', [d.texts[0], d.ids.includes('action_bar_title')], ['<user>', true]);
  check('describe redacts emails and phone numbers', ig.describe(ig.parseDump(screen({ text: 'sent to a.b@x.io and +1 305 555 0100' }))).texts[0], 'sent to <email> and <phone>');
}

// ---------- the username ----------
{
  check('username comes from the action-bar title', ig.usernameFrom(ig.parseDump(PROFILE)), 'bella.rose_22');
  const header = screen({ text: 'Edit profile', bounds: [40, 900, 1040, 1000] }, { text: 'some.handle', bounds: [100, 120, 500, 180] }, { text: 'Reels', bounds: [0, 2300, 200, 2400] });
  check('else the first handle-like text in the header, never a tab label', ig.usernameFrom(ig.parseDump(header), 2400), 'some.handle');
  check('nothing handle-like -> empty, never a guess', ig.usernameFrom(ig.parseDump(HOME)), '');
}

// ---------- the caption ----------
{
  check('caption: non-ASCII stripped, newlines folded, trimmed', ig.captionForDevice('  hey 🔥 there\nlink in bio  '), 'hey  there link in bio');
  check('caption: capped', ig.captionForDevice('x'.repeat(50), 10).length, 10);
}

// ---------- the gallery flow, happy path ----------
(async () => {
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'new drop #reels', mode: 'post' });
    check('gallery flow ends shared', [r.ok, r.state, r.step], [true, 'shared', 'confirm']);
    check('every step passed, in order', r.trace.map((t) => t.name), ['home', 'create', 'choose-reel', 'gallery-newest', 'add-or-next', 'editor-next', 'caption', 'share', 'confirm']);
    check('the newest gallery item (first thumbnail) was tapped', d.taps.some(([x, y]) => x === 180 && y === 480), true);
    check('the caption was typed and the keyboard closed', [d.typed, d.keys], [['new drop #reels'], ['back']]);
    check('Share was tapped', d.taps.some(([x, y]) => x === 540 && y === 2260), true);
  }
  // ---------- capture mode stops before Share ----------
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, EDITOR, SHARE_SHEET, SHARE_SHEET]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'capture' });
    check('capture mode returns captured at the share step', [r.ok, r.state, r.step], [true, 'captured', 'share']);
    check('and never taps Share', d.taps.some(([x, y]) => x === 540 && y === 2260), false);
    check('and carries a screen record per step', r.screens.length >= 6 && r.screens[0].at === 'home', true);
    check('the capture of the share sheet lists its ids', r.screens[r.screens.length - 1].ids.includes('share_button'), true);
  }
  // ---------- pop-ups are dismissed, then the step continues ----------
  {
    const d = fakeDriver([POPUP_OVER_HOME, HOME, CREATE_SHEET, GALLERY, GALLERY, EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post' });
    check('a "Not now" pop-up in the way is tapped away', r.trace.some((t) => t.name === 'create:dismiss'), true);
    check('...and the flow still completes', r.state, 'shared');
    check('the tap went to the pop-up button', d.taps[0], [540, 1150]);
  }
  // ---------- a login wall is fatal, with the reason ----------
  {
    const d = fakeDriver([LOGIN]);
    const r = await ig.run(d, ig.FLOW_REEL, { mode: 'post' });
    check('login wall -> failed with login_required', [r.ok, r.state, r.why, r.step], [false, 'failed', 'login_required', 'home']);
    check('the failing screen is described', r.screen.texts.includes('Log in'), true);
  }
  // ---------- a missing element times out honestly ----------
  {
    const d = fakeDriver([HOME, screen({ text: 'Something unexpected', bounds: [0, 0, 100, 100] })]);
    const r = await ig.run(d, ig.FLOW_REEL, { mode: 'post' });
    check('an element that never appears -> element_not_found at that step', [r.state, r.why, r.step], ['failed', 'element_not_found', 'gallery-newest']);
    check('the step waited its timeout before giving up', d.waited >= ig.STEP_TIMEOUT_MS, true);
  }
  // ---------- an optional step that is not on screen is skipped quickly ----------
  {
    const d = fakeDriver([HOME, GALLERY, GALLERY, EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);   // no "Reel" chooser on this build
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post' });
    check('a build without the Reel chooser still posts', r.state, 'shared');
    check('the optional step is marked skipped', r.trace.find((t) => t.name === 'choose-reel').matched.startsWith('skipped'), true);
  }
  // ---------- the audio flow ----------
  {
    const d = fakeDriver([AUDIO_PAGE, CAMERA, GALLERY, GALLERY, EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const r = await ig.run(d, ig.FLOW_REEL_WITH_AUDIO, { caption: 'with sound', mode: 'post' });
    check('audio flow: Use audio -> gallery -> newest -> ... -> shared', [r.state, r.trace[0].name, r.trace[0].matched.includes('use audio')], ['shared', 'audio-page', true]);
  }
  // ---------- whoami flow ----------
  {
    const d = fakeDriver([HOME, PROFILE]);
    const r = await ig.run(d, ig.FLOW_WHOAMI, { mode: 'post' });
    check('whoami reaches the profile and hands back the nodes', [r.ok, r.step, ig.usernameFrom(r.nodes)], [true, 'read', 'bella.rose_22']);
  }
  // ---------- the share failure text is caught at confirm ----------
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, EDITOR, SHARE_SHEET, SHARE_SHEET, screen({ text: "Couldn't share. Try again.", bounds: [0, 0, 1080, 100] })]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post' });
    check("'Couldn't share' after the tap -> failed share_failed, not shared", [r.state, r.why], ['failed', 'share_failed']);
  }
  // ======== v0.5.14 ========================================================================
  const IG = 'com.instagram.android';
  // The first real post on the farm (2026-11-08, phone 40): after the clip, Instagram's promo for its
  // Edits app, whose only button was "Continue" - tapping it opened Google Play in the browser.
  const EDITS_PROMO = screen({ text: 'Try Edits, an app by Instagram', bounds: [60, 1500, 1020, 1600] }, { text: 'Continue', clickable: true, bounds: [60, 2100, 1020, 2200] });
  const PLAY_IN_BROWSER = appScreen('app.vanadium.browser', { text: 'Google Play', bounds: [0, 200, 1080, 300] }, { text: 'Next', clickable: true, bounds: [800, 1800, 1000, 1900] });
  const NOTIF_PROMPT = appScreen('com.google.android.permissioncontroller', { text: 'Allow Vanadium to send you notifications?', bounds: [100, 900, 980, 1000] },
    { id: 'com.android.permissioncontroller:id/permission_allow_button', text: 'Allow', clickable: true, bounds: [100, 1100, 980, 1180] },
    { id: 'com.android.permissioncontroller:id/permission_deny_button', text: 'Don’t allow', clickable: true, bounds: [100, 1200, 980, 1280] });
  {
    check('"Continue" is no longer something to tap a pop-up away with', ig.DISMISS.some((s) => s.text && s.text.test('Continue')), false);
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, closesOnBack(EDITS_PROMO), EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post', appPkg: IG });
    check('the Edits promo is closed with Back, and the post goes on to shared', [r.state, (r.trace.find((t) => t.name === 'editor-next:back') || {}).matched], ['shared', 'edits_promo']);
    check('...its "Continue" button is never tapped', d.taps.some(([x, y]) => x === 540 && y === 2150), false);
  }
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, closesOnBack(PLAY_IN_BROWSER), EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post', appPkg: IG });
    check('sent to another app: Back brings the phone home and the post goes on', [r.state, (r.trace.find((t) => t.name === 'editor-next:back') || {}).matched], ['shared', 'left Instagram for app.vanadium.browser']);
    check("...and the browser's own Next is never taken for Instagram's", d.taps.some(([x, y]) => x === 900 && y === 1850), false);
  }
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, PLAY_IN_BROWSER]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post', appPkg: IG });
    check('stuck in another app: failed left_app, naming it, after two Backs', [r.state, r.why, r.pkg, d.keys.filter((k) => k === 'back').length], ['failed', 'left_app', 'app.vanadium.browser', ig.MAX_BACKS]);
  }
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, NOTIF_PROMPT, EDITOR, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const r = await ig.run(d, ig.FLOW_REEL, { caption: 'c', mode: 'post', appPkg: IG });
    check('Android\'s "Allow ... notifications?" is answered Don’t allow, and the post goes on', [r.state, d.taps.some(([x, y]) => x === 540 && y === 1240)], ['shared', true]);
  }
  // ---------- text written by Instagram's own text tool, dragged to the owner's spot ----------
  const EDITOR_AA = screen({ id: 'com.instagram.android:id/clips_video_preview', cls: 'android.view.TextureView', bounds: [0, 120, 1080, 2040] },
                           { desc: 'Text', clickable: true, bounds: [960, 300, 1060, 400] },
                           { id: 'com.instagram.android:id/clips_right_action_button', text: 'Next', clickable: true, bounds: [900, 2250, 1060, 2350] });
  const TEXT_EDITOR = screen({ cls: 'android.widget.EditText', focused: true, bounds: [100, 800, 980, 1000] }, { text: 'Done', clickable: true, bounds: [880, 120, 1060, 220] });
  {
    const names = ig.withText(ig.FLOW_REEL).map((s) => s.name);
    check('withText puts the text steps right before the editor\'s Next', names.slice(names.indexOf('add-or-next'), names.indexOf('editor-next') + 1),
      ['add-or-next', 'text-tool', 'text-type', 'text-done', 'text-place', 'editor-next']);
    check('...and leaves the built-in flow as it was', ig.FLOW_REEL.some((s) => s.name === 'text-tool'), false);
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, EDITOR_AA, TEXT_EDITOR, EDITOR_AA, SHARE_SHEET, SHARE_SHEET, SHARED]);
    const seen = [];
    const r = await ig.run(d, ig.withText(ig.FLOW_REEL), { caption: 'c', mode: 'post', appPkg: IG,
      overlay: { text: 'POV: you finally\nsaid hi', x: 0.3, y: 0.25 }, onStep: async (s) => { await null; seen.push(s.name); } });
    check('text flow ends shared, through Aa -> type -> Done -> place', [r.state, seen.slice(5, 9)], ['shared', ['text-tool', 'text-type', 'text-done', 'text-place']]);
    check('the lines are typed one by one with Enter between them (then the caption)', [d.typed, d.keys], [['POV: you finally', 'said hi', 'c'], ['enter', 'back']]);
    check('the text is dragged from the middle of the reel to 30 % / 25 % of it', d.swipes, [[540, 1080, 324, 600, 900]]);
    check('...and the trace says where it went', r.trace.find((t) => t.name === 'text-place').matched.includes('(540,1080)->(324,600); reel found at 0,120 1080x1920'), true);
  }
  {
    const d = fakeDriver([HOME, CREATE_SHEET, GALLERY, GALLERY, EDITOR_AA, TEXT_EDITOR, EDITOR_AA, SHARE_SHEET, SHARE_SHEET]);
    const r = await ig.run(d, ig.withText(ig.FLOW_REEL), { caption: 'c', mode: 'capture', appPkg: IG, overlay: { text: 'hi', x: 0.5, y: 0.5 } });
    check('a test run with text places it and still stops before Share', [r.state, r.step, r.trace.some((t) => t.name === 'text-place')], ['captured', 'share', true]);
    check('...in the middle, no drag is needed', d.swipes.length, 0);
  }
  {
    const fb = ig.canvasRect(ig.parseDump(screen({ bounds: [0, 0, 1080, 2400] }, { text: 'Next', bounds: [900, 2250, 1060, 2350] })));
    check('no preview view in the dump: a full-width 9:16 reel in the middle of the screen', fb, { l: 0, t: 240, w: 1080, h: 1920, found: false });
    check('the spot is kept off the edges and above Instagram\'s caption area', ig.overlayTarget(fb, 1.5, 0.95), { x: 972, y: 1776 });
    const exposed = ig.parseDump(screen({ cls: 'android.widget.EditText', text: 'POV: you finally', bounds: [0, 0, 1080, 200] }, { text: 'POV: you finally', bounds: [300, 1000, 780, 1080] }));
    check('when the build shows the new text in the dump, the drag starts on it (not on the typing box)', ig.overlayStart(exposed, 'POV: you finally\nsaid hi', fb), { x: 540, y: 1040, found: true });
    check('what the phone can type: no emoji, at most two blank lines', ig.overlayForDevice('Hi \u{1F60D}\n\n\n\nthere'), 'Hi\n\nthere');
  }
  // ---------- read_screen (ui_dump) ----------
  {
    const els = ig.uiElements(ig.parseDump(screen({ text: 'Sent to a.b@x.io', bounds: [0, 0, 500, 50] }, { text: 'Sent to a.b@x.io', bounds: [0, 0, 500, 50] },
      { bounds: [0, 0, 1080, 2400] }, { id: 'com.instagram.android:id/share_button', text: 'Share', clickable: true, bounds: [40, 2200, 1040, 2320] })));
    check('read_screen: duplicates and empty boxes dropped, emails masked, ids without the package', els.map((e) => [e.text, e.id, e.cx, e.cy]),
      [['Sent to <email>', '', 250, 25], ['Share', 'share_button', 540, 2260]]);
  }
  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
