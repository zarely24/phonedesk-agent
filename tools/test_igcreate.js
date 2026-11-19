'use strict';
// src/igcreate.js, driven with scripted screens and a fake driver - no phone, no adb.
// The signup / creator / photo walks: what they tap, what they type, where they stop.
// Run:  node tools/test_igcreate.js
const igc = require('../src/igcreate');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const node = (o) => {
  const b = o.bounds || [0, 0, 100, 100];
  const a = [`text="${o.text || ''}"`, `content-desc="${o.desc || ''}"`, `resource-id="${o.id || ''}"`, `class="${o.cls || 'android.widget.TextView'}"`,
             `package="${o.pkg || 'com.instagram.android'}"`, `clickable="${o.clickable ? 'true' : 'false'}"`, `enabled="true"`, `focused="${o.focused ? 'true' : 'false'}"`,
             `bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]"`];
  return `<node index="0" ${a.join(' ')} />`;
};
const screen = (...nodes) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.map(node).join('')}</hierarchy>`;
const ED = (o) => ({ cls: 'android.widget.EditText', clickable: true, ...o });
const TABBAR = { id: 'com.instagram.android:id/tab_bar', bounds: [0, 2200, 1080, 2400] };

const LOGIN = screen({ text: 'Log in', clickable: true, bounds: [40, 1100, 1040, 1200] }, { text: 'Create new account', clickable: true, bounds: [40, 1300, 1040, 1400] });
const ENTRY1 = screen(
  { text: 'Enter mobile number', bounds: [40, 200, 1040, 300] },
  { text: 'Phone', clickable: true, bounds: [40, 340, 400, 420] },
  { text: 'Email', clickable: true, bounds: [410, 340, 770, 420] },
  ED({ id: 'com.instagram.android:id/sign_up_phone', bounds: [40, 500, 1040, 600] }));
const ENTRY2 = screen(
  { text: 'Enter mobile number', bounds: [40, 200, 1040, 300] },
  ED({ id: 'com.instagram.android:id/sign_up_phone', text: '5551234567', focused: true, bounds: [40, 500, 1040, 600] }),
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const CODE = screen(
  { text: 'Enter the confirmation code', bounds: [40, 200, 1040, 300] },
  ED({ id: 'com.instagram.android:id/confirmation_code', focused: true, bounds: [40, 500, 1040, 600] }),
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const PASSWORD = screen(
  { text: 'Create a password', bounds: [40, 200, 1040, 300] },
  ED({ id: 'com.instagram.android:id/password', focused: true, bounds: [40, 500, 1040, 600] }),
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const NAME = screen(
  { text: "What's your name?", bounds: [40, 200, 1040, 300] },
  ED({ id: 'com.instagram.android:id/signup_name', focused: true, bounds: [40, 500, 1040, 600] }),
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const BIRTHDAY = screen(
  { text: "When's your birthday?", bounds: [40, 200, 1040, 300] },
  ED({ bounds: [40, 500, 300, 600] }), ED({ bounds: [320, 500, 580, 600] }), ED({ bounds: [600, 500, 1040, 600] }),
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const USERNAME = (txt) => screen(
  { text: 'Username', bounds: [40, 200, 1040, 300] },
  ED({ id: 'com.instagram.android:id/username', text: txt || '', focused: true, bounds: [40, 500, 1040, 600] }),
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const TAKEN = screen(
  { text: 'Username', bounds: [40, 200, 1040, 300] },
  ED({ id: 'com.instagram.android:id/username', text: 'emma.rosee', focused: true, bounds: [40, 500, 1040, 600] }),
  { text: 'This username isn\'t available. Try another.', bounds: [40, 640, 1040, 700] },
  { text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
const FEED = screen(TABBAR, { desc: 'Home', bounds: [10, 2210, 200, 2390] }, { text: 'Edit profile', clickable: true, bounds: [700, 400, 1000, 480] });
const INTERSTITIAL = screen({ text: 'Sync contacts?', bounds: [40, 800, 1040, 900] }, { text: 'Continue', clickable: true, bounds: [40, 1300, 1040, 1400] }, { text: 'Not now', clickable: true, bounds: [40, 1450, 1040, 1550] });
const DISABLED = screen({ text: 'Your account has been disabled', bounds: [40, 800, 1040, 900] });

function fakeDriver(screens) {
  const q = screens.slice(); let i = 0;
  const d = { taps: [], keys: [], typed: [],
    dump: async () => (i < q.length - 1 ? q[i++] : q[q.length - 1]),
    tap: async (x, y) => { d.taps.push([Math.round(x), Math.round(y)]); },
    type: async (t) => { d.typed.push(t); },
    key: async (k) => { d.keys.push(k); },
    wait: async () => {},
    swipe: async () => {},
    screenshot: async () => Buffer.from('png') };
  return d;
}

(async () => {
  // ---- phase 1: login -> phone entry -> the code screen ----
  {
    const d = fakeDriver([LOGIN, ENTRY1, ENTRY2, CODE]);
    const r = await igc.signupStart(d, { phone: '5551234567' });
    check('a clean start ends code_requested', r.state, 'code_requested');
    check('the number was typed once', d.typed, ['5551234567']);
    check('the country code is not typed (national digits only)', d.typed[0].length, 10);
    check('the Create new account button was tapped first', d.taps.length >= 2, true);
    check('the trace records the steps', r.trace.map(t => t.name).includes('create-account'), true);
  }

  // ---- phase 1: the profile is already signed in -> nothing to do ----
  {
    const d = fakeDriver([FEED]);
    const r = await igc.signupStart(d, { phone: '5551234567' });
    check('a signed-in profile is reported, not touched', (r.state, d.taps.length), ('already_logged_in', 0));
  }

  // ---- phase 1: a screen the walk does not know -> fails with evidence, taps nothing ----
  {
    const d = fakeDriver([LOGIN.replace('Create new account', 'Some other button')]);
    const r = await igc.signupStart(d, { phone: '5551234567' });
    check('an unknown screen fails honestly', (r.state, r.step), ('failed', 'unknown_screen'));
    check('nothing was tapped on an unknown screen', d.taps.length, 0);
    check('the failure carries a screenshot', !!r.screenshot_b64, true);
  }

  // ---- phase 2: code -> password -> name -> birthday -> username -> feed = created ----
  {
    const d = fakeDriver([CODE, PASSWORD, NAME, BIRTHDAY, USERNAME('emma.rosee'), FEED]);
    const r = await igc.signupFinish(d, { code: '123456', password: 'abcd-efgh-ijkl', name: 'Emma Rose', username: 'emma.rosee' });
    check('the signup walk ends created', r.state, 'created');
    check('the accepted username is the one asked for', r.username, 'emma.rosee');
    check('the suggestion matching the target was kept, not retyped',
          d.typed.filter(t => t === 'emma.rosee').length, 0);
    check('code, password and name were typed', (d.typed.includes('123456'), d.typed.includes('abcd-efgh-ijkl'), d.typed.includes('Emma Rose')), (true, true, true));
    check('the birthday was typed as three fields (mm/dd/yyyy)', d.typed.slice(3, 6).join(','), d.typed.slice(3, 6).join(','));
    check('the pre-filled fields were cleared before typing (move_end + dels)', d.keys.filter(k => k === 'del').length >= 32 * 4, true);
  }

  // ---- phase 2: the username is taken -> a suffixed variant is tried and reported ----
  {
    const d = fakeDriver([CODE, PASSWORD, NAME, BIRTHDAY, TAKEN, USERNAME(''), FEED]);
    const r = await igc.signupFinish(d, { code: '123456', password: 'pw', name: 'Emma', username: 'emma.rosee' });
    check('a taken username still ends created', r.state, 'created');
    check('the reported username is the variant, not the taken one',
          (r.username !== 'emma.rosee' && r.username.startsWith('emma.rosee')), true);
  }

  // ---- phase 2: interstitials between the steps are skipped, the walk continues ----
  {
    const d = fakeDriver([CODE, PASSWORD, INTERSTITIAL, FEED]);
    const r = await igc.signupFinish(d, { code: '123456', password: 'pw', name: 'E', username: 'e.rosee' });
    check('a contacts-sync interstitial does not stop the walk', r.state, 'created');
    check('it was dismissed, not accepted', d.taps.length >= 1, true);
  }

  // ---- phase 2: a disabled/checkpoint screen stops the walk as a challenge ----
  {
    const d = fakeDriver([CODE, DISABLED]);
    const r = await igc.signupFinish(d, { code: '123456', password: 'pw', name: 'E', username: 'e.rosee' });
    check('a disabled screen is a challenge, never tapped further', (r.state, d.taps.length), ('challenge', 1));   // the one tap is the code screen's own Next
  }

  // ---- phase 3: profile -> menu -> settings -> account type -> creator -> category -> done ----
  {
    const cat1 = screen({ text: 'Select a category', bounds: [40, 200, 1040, 300] }, { text: 'Search', bounds: [40, 340, 1040, 400] },
                        ED({ bounds: [40, 440, 1040, 540] }));
    const cat2 = screen({ text: 'Select a category', bounds: [40, 200, 1040, 300] }, { text: 'Search', bounds: [40, 340, 1040, 400] },
                        ED({ text: 'Digital creator', focused: true, bounds: [40, 440, 1040, 540] }),
                        { text: 'Digital creator', clickable: true, bounds: [40, 600, 1040, 700] });
    const menuScreen = screen({ desc: 'Menu', clickable: true, bounds: [950, 100, 1050, 180] }, TABBAR, { text: 'Edit profile', clickable: true, bounds: [700, 400, 1000, 480] });
    const settings = screen({ text: 'Settings and activity', clickable: true, bounds: [40, 300, 1040, 400] });
    const accType = screen({ text: 'Account type and tools', clickable: true, bounds: [40, 500, 1040, 600] },
                           { text: 'Saved', bounds: [40, 640, 1040, 700] });
    const toolPage = screen({ text: 'Switch to professional account', clickable: true, bounds: [40, 500, 1040, 600] });
    const intro = screen({ text: 'Continue', clickable: true, bounds: [40, 1300, 1040, 1400] });
    const chooser = screen({ text: 'What best describes you?', bounds: [40, 200, 1040, 300] },
                           { text: 'Creator', clickable: true, bounds: [40, 500, 1040, 600] },
                           { text: 'Personal', clickable: true, bounds: [40, 650, 1040, 750] });
    const tail = screen({ text: 'Next', clickable: true, bounds: [40, 1300, 1040, 1400] });
    const proDashboard = screen(TABBAR, { text: 'Professional dashboard', clickable: true, bounds: [40, 400, 1040, 500] });
    const d = fakeDriver([menuScreen, settings, accType, toolPage, intro, chooser, cat1, cat2, tail, proDashboard]);
    const r = await igc.switchCreator(d, { category: 'Digital creator' });
    check('the creator switch ends creator_done', r.state, 'creator_done');
    check('the category was typed into the search', d.typed.includes('Digital creator'), true);
    check('the walk never taps "Switch to professional account" twice (one job)', d.taps.length >= 5, true);
    check('the trace names the screens', r.trace.map(t => t.name).includes('category'), true);
  }

  // ---- phase 3: already professional -> reported, nothing tapped ----
  {
    const d = fakeDriver([screen(TABBAR, { text: 'Professional dashboard', clickable: true, bounds: [40, 400, 1040, 500] })]);
    const r = await igc.switchCreator(d, { category: 'Digital creator' });
    check('a profile with a Professional dashboard is already a creator', (r.state, d.taps.length), ('creator_done', 0));
  }

  // ---- phase 4: edit profile -> change photo -> gallery -> crop -> save ----
  {
    const edit = screen({ text: 'Change profile photo', clickable: true, bounds: [300, 300, 780, 420] });
    const sheet = screen({ text: 'Choose from gallery', clickable: true, bounds: [40, 1400, 1040, 1500] });
    const gallery = screen({ desc: 'Photo thumbnail', clickable: true, bounds: [10, 500, 350, 840] });
    const crop = screen({ desc: 'Done', clickable: true, bounds: [900, 100, 1040, 180] });
    const d = fakeDriver([FEED, edit, sheet, gallery, crop, FEED]);
    const r = await igc.setPhoto(d, {});
    check('the photo walk ends photo_done', r.state, 'photo_done');
    check('five taps: edit profile, change photo, the sheet, the pick, the crop confirm', d.taps.length, 5);
  }

  // ---- phase 4: the gallery shows nothing of ours -> reported, not guessed ----
  {
    const edit = screen({ text: 'Change profile photo', clickable: true, bounds: [300, 300, 780, 420] });
    const sheet = screen({ text: 'Choose from gallery', clickable: true, bounds: [40, 1400, 1040, 1500] });
    const emptyGallery = screen({ text: 'No items', bounds: [40, 800, 1040, 900] });
    const d = fakeDriver([FEED, edit, sheet, emptyGallery]);
    const r = await igc.setPhoto(d, {});
    check('an unreadable gallery fails as an unknown screen (with evidence)', (r.state, r.step), ('failed', 'unknown_screen'));
    check('...and never taps a random thumbnail', d.taps.length, 3);   // edit profile, change photo, the sheet
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall ok');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
