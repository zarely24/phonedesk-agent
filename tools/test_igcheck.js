'use strict';
// src/igcheck.js (the v0.5.15 account check) with scripted screens and a fake phone - no adb.
// Run:  node tools/test_igcheck.js     (npm run test:igcheck)
//
// The screens are modelled on the screenshots taken on the farm on 2026-11-08 (phones 10 and 14,
// 1080x2400): the texts are the ones the phones printed, the bounds are read off the pictures.
// Every visit also checks that NO tap ever landed on something the check must never touch.
const ck = require('../src/igcheck');
const ig = require('../src/igpost');
const st = require('../src/igstats');

let fail = 0, n = 0;
const check = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const IG = 'com.instagram.android';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function node(o) {
  const b = o.b || [0, 0, 10, 10];
  const id = o.id ? (o.id.includes(':') ? o.id : `${IG}:id/${o.id}`) : '';
  return `<node index="0" text="${esc(o.text || '')}" resource-id="${id}" class="${o.cls || 'android.widget.TextView'}" package="${o.pkg || IG}" `
    + `content-desc="${esc(o.desc || '')}" checkable="false" checked="${o.checked ? 'true' : 'false'}" clickable="${o.click ? 'true' : 'false'}" enabled="true" `
    + `focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="${o.sel ? 'true' : 'false'}" bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]" />`;
}
// A window: its root first (it names the package), then the nodes. `root` = the window's own box.
function win(pkg, root, nodes) {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node({ cls: 'android.widget.FrameLayout', pkg, b: root })}${nodes.map((x) => node({ pkg, ...x })).join('')}</hierarchy>`;
}
const screen = (...nodes) => win(IG, [0, 0, 1080, 2400], nodes.flat());
const T = (text, l, t, r, b, x) => ({ text, b: [l, t, r, b], ...(x || {}) });
const D = (desc, l, t, r, b, x) => ({ desc, b: [l, t, r, b], cls: 'android.widget.ImageView', ...(x || {}) });
const C = (l, t, r, b, x) => ({ b: [l, t, r, b], cls: 'android.view.ViewGroup', click: true, ...(x || {}) });
const V = (l, t, r, b, x) => ({ b: [l, t, r, b], cls: 'android.view.View', ...(x || {}) });
const B = { click: true, cls: 'android.widget.Button' };

// ---------- the screens -----------------------------------------------------------------------
// Instagram's bottom bar: once with resource-ids, once with names only (ids are never relied on).
const NAV = [C(0, 2212, 1080, 2334, { id: 'tab_bar', click: false }), D('Home', 43, 2222, 173, 2324, { click: true, id: 'feed_tab' }),
  D('Reels', 259, 2222, 389, 2324, { click: true, id: 'clips_tab' }), D('Message', 475, 2222, 605, 2324, { click: true, id: 'direct_tab' }),
  D('Search and explore', 691, 2222, 821, 2324, { click: true, id: 'search_tab' }), D('Profile', 907, 2222, 1037, 2324, { click: true, id: 'profile_tab' })];
const NAV_NOIDS = NAV.slice(1).map((x) => ({ ...x, id: '' }));
const STORIES = (names) => [T('Your story', 72, 566, 224, 600), ...names.map((s, i) => T(s, 340 + i * 290, 566, 560 + i * 290, 600))];

// ph14/01_after_switch.png - the profile's home screen right after a VA-style switch, no lock screen
const LAUNCHER = win('com.android.launcher3', [0, 0, 1080, 2400], [V(0, 0, 1080, 2400, { id: 'com.android.launcher3:id/workspace' }),
  T('Gallery', 352, 1910, 468, 1950, { click: true }), T('App Store', 848, 1910, 1010, 1950, { click: true }),
  D('Phone', 72, 2120, 230, 2278, { click: true }), D('Messages', 331, 2120, 489, 2278, { click: true }),
  D('Vanadium', 590, 2120, 748, 2278, { click: true }), D('Camera', 849, 2120, 1007, 2278, { click: true })]);
// v0.5.16: the GrapheneOS home screen of the 2026-11-10 failures - Instagram's icon top left
const LAUNCHER_IG = win('com.android.launcher3', [0, 0, 1080, 2400], [V(0, 0, 1080, 2400, { id: 'com.android.launcher3:id/workspace' }),
  T('Instagram', 72, 1130, 230, 1170, { click: true }), T('Telegram', 331, 1130, 489, 1170, { click: true }),
  D('Phone', 72, 2120, 230, 2278, { click: true }), D('Camera', 849, 2120, 1007, 2278, { click: true })]);
// ph14/02_ig_open.png - "Join Instagram": nobody is logged in to this profile's Instagram
const JOIN = screen(T('English (US)', 416, 290, 612, 330, { click: true }), T('Join Instagram', 324, 1560, 756, 1620),
  T("Share what you're into with the people who get you.", 108, 1660, 970, 1745),
  T('Get started', 42, 1942, 1038, 2056, B), T('I already have a profile', 42, 2090, 1038, 2203, B), D('Meta', 460, 2250, 620, 2300));
// ph14/u15.png - restriction notice (its X read out as "Close"; the apostrophe as the phone writes it)
const NOTICE_RESTRICT = screen(T('What happened', 43, 180, 444, 234), D('Close', 960, 170, 1030, 240, { click: true }),
  T('We added a restriction to your account', 140, 726, 942, 858), T('Oct 25, 2026', 440, 890, 640, 926),
  T('You can’t send messages', 138, 1166, 610, 1204), T('Ends on Nov 24, 2026', 138, 1224, 484, 1262), T('See why', 42, 2154, 1038, 2262, B));
// ph14/u25.png - removed-post notice (here the X is an unlabelled icon)
const NOTICE_REMOVED = screen(T('What happened', 43, 180, 444, 234), V(960, 170, 1030, 240, { click: true, cls: 'android.widget.ImageView' }),
  T('We removed your post', 243, 728, 840, 790), T('Oct 22, 2026', 440, 822, 640, 858), C(43, 958, 1037, 1188),
  T('I mean, try me', 264, 1030, 503, 1068), T('Oct 20, 2026', 264, 1080, 478, 1118), T('You shared this on your profile', 43, 1212, 486, 1248),
  T('See why', 42, 2154, 1038, 2262, B));
// ph14/u20.png - feed with the Muse card (does not block) and the Meta card's X
const FEED_MUSE = screen(D('New post', 36, 180, 90, 234, { click: true }), D('Instagram', 374, 170, 682, 240), D('Activity', 966, 180, 1026, 234, { click: true }),
  STORIES(['breckiehill', 'avaxreyess', 'nimkguye']), D('Meta', 30, 640, 190, 682), D('Dismiss', 1004, 640, 1050, 684, { click: true }),
  T('Meet Muse, your new personal AI agent', 155, 1362, 925, 1410),
  T('Hand off everyday tasks like finding deals, booking reservations, and managing your inbox. Muse keeps working while you get on with your day.', 108, 1425, 970, 1550),
  T('Try Muse', 84, 1596, 996, 1684, B), T('sophierainreels', 150, 1778, 415, 1818), T('Trapp Glock · Body', 196, 1820, 516, 1856), NAV);
// ph14/u25_b.png - the plain feed after the X (bottom bar without ids)
const FEED_K = screen(D('New post', 36, 180, 90, 234, { click: true }), STORIES(['avaxreyess', 'nimkguyen', 'tracifoube']),
  T('zoeyiso', 150, 674, 282, 712), NAV_NOIDS);
// ph14/u25_profile.png (title left-aligned) and ph14/d0_open.png (title centred, "+" on its left)
const PROFILE_BODY_K = [T('Can\'t decide...', 62, 292, 252, 396), T('Kadie', 316, 348, 412, 386),
  T('3', 316, 418, 340, 458), T('posts', 316, 470, 410, 510), T('85', 526, 418, 574, 458), T('followers', 526, 470, 680, 510),
  T('12', 799, 418, 838, 458), T('following', 799, 470, 953, 510), T('Wanna see a magic trick? :)', 43, 582, 500, 622),
  T('Add banners', 43, 658, 334, 720, { click: true }), C(32, 754, 1048, 900), T('Your dashboard', 70, 786, 338, 828),
  T('44.3K views in the last 30 days.', 113, 830, 565, 869), T('Edit profile', 32, 924, 532, 1008, B), T('Share profile', 548, 924, 1048, 1008, B),
  D('Grid view', 96, 1042, 264, 1102, { click: true }), D('Reels', 456, 1042, 624, 1102, { click: true }), D('Photos of you', 816, 1042, 984, 1102, { click: true }),
  T('3,063', 64, 1570, 145, 1604), T('2,556', 426, 1570, 508, 1604), T('2,651', 788, 1570, 864, 1604)];
const PROFILE_K = screen(T('urfavekadiee', 43, 174, 444, 234, { id: 'action_bar_title', click: true }), D('Muse', 708, 174, 774, 234, { click: true }),
  D('New post', 840, 174, 894, 234, { click: true }), D('Options', 970, 174, 1022, 234, { click: true }), PROFILE_BODY_K, NAV);
const PROFILE_KC = screen(D('New post', 36, 174, 90, 234, { click: true }), T('urfavekadiee', 348, 174, 750, 234, { click: true }),
  D('Muse', 836, 174, 900, 234, { click: true }), D('Options', 970, 174, 1022, 234, { click: true }), PROFILE_BODY_K, NAV_NOIDS);
// ph14/u25_switcher.png - the accounts sheet drawn OVER the profile (both in one dump)
const SHEET_K = [C(0, 1342, 1080, 2400, { click: false }), T('urfavekadiee', 222, 1488, 466, 1528), V(938, 1484, 990, 1534, { cls: 'android.widget.ImageView' }),
  T('Add Instagram account', 222, 1658, 665, 1698), T('Other profiles', 53, 1808, 272, 1846), T('Add WhatsApp', 222, 1956, 508, 1996),
  T('Go to Accounts Center', 324, 2128, 757, 2170, B), D('Meta', 460, 2252, 620, 2302)];
const SWITCHER_K = screen(T('urfavekadiee', 43, 174, 444, 234, { id: 'action_bar_title' }), PROFILE_BODY_K, NAV, SHEET_K);
// ph14/d1_dashboard.png
const DASH_K = screen(D('Back', 43, 180, 103, 234, { click: true }), T('Your dashboard', 190, 180, 588, 234), D('Settings', 966, 180, 1026, 234, { click: true }),
  T('Insights', 43, 326, 197, 372), T('Oct 9 - Nov 7', 821, 324, 1036, 366),
  C(0, 420, 1080, 540), T('Views', 43, 456, 142, 494), T('44.3K', 864, 454, 974, 498),
  C(0, 550, 1080, 660), T('New followers', 43, 583, 277, 622), T('0', 952, 583, 976, 622),
  C(0, 676, 1080, 786), T('Content you shared', 43, 710, 359, 750), T('10', 935, 710, 976, 750),
  T('Your tools', 43, 884, 239, 924), C(0, 960, 1080, 1130), T('Monthly recap', 138, 1003, 418, 1048), T('See what you made happen last month.', 138, 1054, 798, 1092),
  T('New', 823, 1010, 954, 1082), T('Best practices', 138, 1176, 416, 1216), T('Inspiration on Edits', 138, 1318, 508, 1358), T('Ad tools', 138, 1461, 298, 1501),
  T('Monetization', 43, 1643, 301, 1683), T('Monetization tools', 138, 1778, 501, 1818), T('Tips and resources', 43, 1960, 411, 2000),
  T('Trending audio', 138, 2094, 425, 2134), T('Other helpful resources', 138, 2237, 592, 2277));
// ph10/a2_dash.png - another account's dashboard: "Next steps" before the tools
const DASH_L = screen(D('Back', 43, 180, 103, 234, { click: true }), T('Your dashboard', 190, 180, 588, 234), D('Settings', 966, 180, 1026, 234, { click: true }),
  T('Insights', 43, 326, 197, 372), T('Oct 9 - Nov 7', 821, 324, 1036, 366),
  C(0, 420, 1080, 540), T('Views', 43, 456, 142, 494), T('905.5K', 836, 454, 974, 498),
  C(0, 550, 1080, 660), T('New followers', 43, 583, 277, 622), T('4.1K', 902, 583, 974, 622),
  C(0, 676, 1080, 786), T('Content you shared', 43, 710, 359, 750), T('40', 927, 710, 976, 750),
  T('Next steps', 43, 884, 253, 924), T('Get Meta Verified', 233, 1010, 532, 1050), T('Sign up for a verified badge, account protection and more.', 233, 1056, 853, 1136),
  T('Connect your accounts to Muse', 233, 1430, 775, 1470), T('Review posts and messages before Muse sends them.', 233, 1476, 923, 1556),
  T('Your tools', 43, 1692, 239, 1732), T('Monthly recap', 138, 1811, 418, 1856), T('Best practices', 138, 1985, 416, 2025), T('Inspiration', 138, 2127, 342, 2167),
  T('Ad tools', 138, 2270, 298, 2310));
// ph14/d2_views.png, d4_over_1.png, d4_over_3.png - Insights, Overview tab
const INSIGHTS_HEAD = (tab) => [D('Back', 43, 180, 103, 234, { click: true }), T('Insights', 190, 180, 367, 234), D('Share', 852, 176, 908, 236, { click: true }),
  D('Info', 976, 176, 1036, 236, { click: true }), T('Overview', 98, 318, 262, 356, { click: true, sel: tab === 'o' }),
  T('Content', 470, 318, 610, 356, { click: true }), T('Audience', 820, 318, 979, 356, { click: true, sel: tab === 'a' })];
const OV1 = screen(INSIGHTS_HEAD('o'), T('All content', 43, 462, 288, 510), T('30 days', 852, 468, 1000, 504, { click: true }),
  C(43, 562, 436, 768), T('Views', 84, 606, 172, 638), T('44,321', 84, 676, 230, 726),
  C(470, 562, 866, 768), T('Net followers', 512, 606, 710, 638), T('--', 512, 676, 544, 726),
  C(898, 562, 1080, 768), T('Interactions', 941, 606, 1080, 638), T('969', 941, 676, 1024, 726),
  T('0.4% followers', 43, 806, 293, 844), T('99.6% non-followers', 43, 850, 390, 888),
  T('40.9K', 54, 1018, 136, 1048), T('20.4K', 54, 1180, 136, 1212), T('0', 118, 1342, 136, 1374),
  T('Oct 9', 170, 1384, 248, 1414), T('Oct 24', 550, 1384, 646, 1414), T('Nov 7', 945, 1384, 1028, 1414),
  T('Views by content type', 43, 1584, 487, 1630), D('Info', 510, 1584, 560, 1630, { click: true }),
  T('Viewers', 43, 1690, 181, 1728), T('20,198', 912, 1686, 1036, 1730), T('Followers', 74, 1812, 212, 1850), T('Non-followers', 310, 1812, 511, 1850),
  T('Reels', 43, 1894, 121, 1927), V(43, 1954, 869, 1975), T('43.3K', 944, 1950, 1027, 1980),
  T('Stories', 43, 2028, 149, 2062), T('978', 976, 2084, 1027, 2114), T('Posts', 43, 2162, 125, 2196), T('0', 1008, 2218, 1027, 2249),
  T('Live videos', 43, 2296, 210, 2330));
// the tile row after its one sideways swipe (Interactions now whole)
const OV1B = screen(INSIGHTS_HEAD('o'), T('All content', 43, 462, 288, 510), T('30 days', 852, 468, 1000, 504, { click: true }),
  C(0, 562, 411, 768), T('Net followers', 57, 606, 255, 638), T('--', 57, 676, 89, 726),
  C(443, 562, 839, 768), T('Interactions', 486, 606, 690, 638), T('969', 486, 676, 569, 726),
  T('0.4% followers', 43, 806, 293, 844), T('99.6% non-followers', 43, 850, 390, 888),
  T('Views by content type', 43, 1584, 487, 1630), T('Viewers', 43, 1690, 181, 1728), T('20,198', 912, 1686, 1036, 1730),
  T('Reels', 43, 1894, 121, 1927), T('43.3K', 944, 1950, 1027, 1980), T('Stories', 43, 2028, 149, 2062), T('978', 976, 2084, 1027, 2114),
  T('Posts', 43, 2162, 125, 2196), T('0', 1008, 2218, 1027, 2249), T('Live videos', 43, 2296, 210, 2330));
const THUMBS = (y, counts) => counts.map((c, i) => [D('Reel', 43 + i * 260, y - 268, 283 + i * 260, y + 52, { click: true }), T(c, 106 + i * 260, y, 165 + i * 260, y + 34)]).flat();
const CHIPS_INTER = (y) => [T('All', 43, y, 166, y + 98, { click: true }), T('Likes', 190, y, 391, y + 98, { click: true }), T('Comments', 415, y, 701, y + 98, { click: true }),
  T('Reposts', 725, y, 972, y + 98, { click: true }), D('Shares', 995, y, 1080, y + 98, { click: true })];
const OV2 = screen(INSIGHTS_HEAD('o'), T('Reels', 43, 402, 121, 432), T('43.3K', 944, 456, 1027, 486), T('Stories', 43, 536, 149, 568), T('978', 976, 590, 1027, 620),
  T('Posts', 43, 670, 125, 702), T('0', 1008, 724, 1027, 754), T('Live videos', 43, 804, 210, 836), T('0', 1008, 858, 1027, 888),
  T('Top content by views', 43, 978, 463, 1022), T('See all', 943, 980, 1037, 1020, { click: true }), THUMBS(1314, ['3.1K', '2.7K', '2.6K', '371']),
  T('Interactions by content type', 43, 1436, 607, 1482), D('Info', 630, 1436, 680, 1482, { click: true }), CHIPS_INTER(1518),
  T('Followers', 74, 1690, 212, 1724), T('Non-followers', 310, 1690, 511, 1724),
  T('Reels', 43, 1769, 121, 1802), T('952', 972, 1824, 1027, 1854), T('Stories', 43, 1903, 149, 1936), T('17', 997, 1958, 1027, 1988),
  T('Posts', 43, 2037, 125, 2070), T('0', 1008, 2092, 1027, 2122), T('Live videos', 43, 2170, 210, 2204), T('0', 1008, 2226, 1027, 2256));
const OV3 = screen(INSIGHTS_HEAD('o'), THUMBS(670, ['3.1K', '2.7K', '2.6K', '371']),
  T('Interactions by content type', 43, 788, 607, 836), CHIPS_INTER(870), T('Followers', 74, 1056, 212, 1090), T('Non-followers', 310, 1056, 511, 1090),
  T('Reels', 43, 1122, 121, 1152), T('952', 972, 1176, 1027, 1206), T('Stories', 43, 1255, 149, 1286), T('17', 997, 1310, 1027, 1340),
  T('Posts', 43, 1390, 125, 1422), T('0', 1008, 1444, 1027, 1474), T('Live videos', 43, 1524, 210, 1556), T('0', 1008, 1578, 1027, 1608),
  T('Profile activity', 43, 1699, 334, 1742), D('Info', 357, 1699, 407, 1742, { click: true }),
  C(0, 1800, 1080, 1924), T('Profile visits', 200, 1842, 412, 1882), T('2,253', 925, 1840, 1037, 1884),
  T('Bio link taps', 200, 2032, 406, 2072), T('0', 1014, 2032, 1037, 2072), T('Business address taps', 200, 2222, 581, 2262), T('0', 1014, 2222, 1037, 2262));
// ph14/d3_audience.png - 85 followers: Instagram shows no audience below 100
const AUD_U100 = screen(INSIGHTS_HEAD('a'), T('85', 492, 474, 588, 540), T('Followers', 432, 576, 648, 618),
  T('You can learn more about who’s following you when you have at least 100 followers.', 43, 720, 976, 810));
// ph10/a3_audience.png, a4_aud_1.png, a4_aud_2.png, a4_aud_3.png - 4,720 followers
const AUD1 = screen(INSIGHTS_HEAD('a'), T('Followers', 43, 464, 258, 510), T('30 days', 852, 468, 1000, 504, { click: true }),
  T('4,720', 43, 594, 256, 666), T('+435.1%', 43, 692, 181, 728), T('since Oct 9', 193, 692, 380, 728),
  T('Follower growth over time', 43, 798, 563, 844), D('Info', 586, 798, 636, 844, { click: true }),
  T('Overall', 43, 878, 230, 978, { click: true }), T('Follows', 254, 878, 450, 978, { click: true }), T('Unfollows', 474, 878, 703, 978, { click: true }),
  T('688', 64, 1138, 118, 1170), T('0', 98, 1300, 118, 1330), T('-688', 52, 1462, 118, 1494),
  T('Oct 9', 150, 1504, 228, 1534), T('Oct 23', 543, 1504, 638, 1534), T('Nov 6', 943, 1504, 1028, 1534),
  T('Top content by follows', 43, 1626, 492, 1670), T('See all', 943, 1628, 1037, 1668, { click: true }), THUMBS(1960, ['617', '601', '553', '532']),
  T('Gender', 43, 2084, 187, 2130), D('Info', 210, 2084, 260, 2130, { click: true }), T('Women', 43, 2196, 152, 2230), V(43, 2254, 843, 2276), T('2.1%', 961, 2251, 1027, 2284));
const AGE_ROWS = (y0, rows) => rows.map(([a, p], i) => [T(a, 43, y0 + i * 134, 127, y0 + i * 134 + 33), V(43, y0 + i * 134 + 58, 843, y0 + i * 134 + 78), T(p, 938, y0 + i * 134 + 54, 1027, y0 + i * 134 + 85)]).flat();
const AUD2 = screen(INSIGHTS_HEAD('a'), THUMBS(640, ['617', '601', '553', '532']),
  T('Gender', 43, 764, 187, 808), D('Info', 210, 764, 260, 808, { click: true }),
  T('Women', 43, 876, 152, 910), T('2.1%', 961, 931, 1027, 962), T('Men', 43, 1010, 107, 1044), T('97.9%', 936, 1066, 1027, 1097),
  T('Age range', 43, 1188, 246, 1234), D('Info', 268, 1188, 318, 1234, { click: true }), T('Women', 74, 1290, 181, 1321), T('Men', 278, 1290, 341, 1321),
  AGE_ROWS(1369, [['13-17', '0.1%'], ['18-24', '10.2%'], ['25-34', '24.7%'], ['35-44', '31.4%'], ['45-54', '20.2%'], ['55-64', '9.7%'], ['65+', '3.7%']]));
const PLACE_ROWS = (y0, rows) => rows.map(([name, p], i) => [T(name, 43, y0 + i * 134, 43 + name.length * 17, y0 + i * 134 + 32), V(43, y0 + i * 134 + 58, 843, y0 + i * 134 + 78),
  T(p, 943, y0 + i * 134 + 54, 1027, y0 + i * 134 + 86)]).flat();
const DAY_CHIPS = (y) => [['Su', 43, 166], ['M', 188, 300], ['Tu', 323, 443], ['W', 466, 580], ['Th', 602, 726], ['F', 749, 851], ['Sa', 874, 995]]
  .map(([d, l, r]) => T(d, l, y, r, y + 100, { click: true }));
const COUNTRIES = [['United States', '53.1%'], ['United Kingdom', '4.9%'], ['Canada', '3.9%'], ['Mexico', '3.3%'], ['Australia', '2.7%']];
const CITIES = [['New York', '8.2%'], ['Los Angeles', '3.1%'], ['Chicago', '2.2%'], ['Houston', '1.9%'], ['London', '1.5%']];
const AUD3 = (places) => screen(INSIGHTS_HEAD('a'), T('24.7%', 938, 396, 1027, 412),
  AGE_ROWS(466, [['35-44', '31.4%'], ['45-54', '20.2%'], ['55-64', '9.7%'], ['65+', '3.7%']]),
  T('Top locations', 43, 1042, 308, 1086), D('Info', 330, 1042, 380, 1086, { click: true }),
  T('Countries', 43, 1122, 274, 1222, { click: true, sel: places === COUNTRIES }), T('Cities', 296, 1122, 466, 1222, { click: true, sel: places === CITIES }),
  PLACE_ROWS(1300, places), T('Follower active times', 43, 2011, 464, 2057), D('Info', 486, 2011, 536, 2057, { click: true }),
  T('Based on your current time zone (EST)', 43, 2082, 604, 2118), DAY_CHIPS(2150), V(546, 2294, 655, 2334), V(668, 2294, 776, 2334));
// the Sunday bars of ph10/a4_aud_3.png (tops; every bar ends on the axis at y 1842)
const SUNDAY = [1446, 1550, 1433, 1280, 1216, 1214, 1256, 1324];
const DAY_TOPS = { Su: SUNDAY, M: [1500, 1600, 1500, 1300, 1250, 1220, 1214, 1300], Tu: [1400, 1500, 1450, 1300, 1214, 1250, 1260, 1330],
  W: [1450, 1550, 1450, 1214, 1250, 1250, 1300, 1340], Th: [1450, 1560, 1440, 1290, 1230, 1214, 1240, 1320],
  F: [1460, 1570, 1440, 1280, 1220, 1214, 1230, 1300], Sa: [1214, 1450, 1500, 1400, 1300, 1250, 1240, 1250] };
const BAR_X = [[60, 168], [181, 289], [302, 412], [425, 533], [546, 655], [668, 776], [790, 898], [912, 1020]];
const HOURS = [['12a', 90, 136], ['3a', 217, 252], ['6a', 338, 375], ['9a', 460, 497], ['12p', 576, 624], ['3p', 704, 740], ['6p', 826, 862], ['9p', 948, 984]];
const AUD4 = (places, day) => screen(INSIGHTS_HEAD('a'), T(places[1][1], 952, 410, 1027, 440),
  PLACE_ROWS(490, places.slice(2)), T('Follower active times', 43, 932, 464, 976), D('Info', 486, 932, 536, 976, { click: true }),
  T('Based on your current time zone (EST)', 43, 1002, 604, 1038), DAY_CHIPS(1072),
  DAY_TOPS[day].map((top, i) => V(BAR_X[i][0], top, BAR_X[i][1], 1842)), HOURS.map(([h, l, r]) => T(h, l, 1868, r, 1900)),
  T('When followers are most active', 43, 1969, 582, 2008), T('Fridays', 43, 2036, 166, 2072), T('3 PM - 6 PM', 43, 2080, 242, 2116),
  T('Thursdays', 43, 2145, 221, 2181), T('3 PM - 6 PM', 43, 2190, 242, 2226), T('Fridays', 43, 2254, 166, 2290), T('12 PM - 3 PM', 43, 2299, 258, 2335));
// ph10/a1_profile.png (title centred) and ph10/a0_open.png (Android's prompt over the feed)
const PROFILE_L = screen(D('New post', 36, 174, 90, 234, { click: true }), T('urlucybby', 401, 174, 720, 234, { click: true }),
  D('Muse', 856, 174, 922, 234, { click: true }), D('Options', 990, 174, 1044, 234, { click: true }), T('Make this space yours...', 62, 292, 252, 426),
  T('26', 316, 384, 364, 426), T('posts', 316, 438, 410, 476), T('4,720', 526, 384, 632, 426), T('followers', 526, 438, 680, 476),
  T('5', 799, 384, 823, 426), T('following', 799, 438, 953, 476), T('heyy', 43, 582, 122, 622), T('x.com/lucycakeddd', 90, 638, 428, 678, { click: true }),
  T('Add banners', 43, 702, 334, 764, { click: true }), C(32, 798, 1048, 943), T('Your dashboard', 70, 830, 338, 872),
  T('905.5K views in the last 30 days.', 113, 876, 586, 914), T('Edit profile', 32, 968, 532, 1052, B), T('Share profile', 548, 968, 1048, 1052, B),
  T('120K', 64, 1610, 130, 1644), T('91K', 426, 1610, 480, 1644), T('112K', 788, 1610, 852, 1644), NAV);
const PERMISSION = win('com.android.permissioncontroller', [70, 866, 1010, 1602], [
  T('Allow Instagram to send you notifications?', 142, 1056, 940, 1206, { id: 'com.android.permissioncontroller:id/permission_message' }),
  T('Allow', 132, 1286, 948, 1392, { ...B, id: 'com.android.permissioncontroller:id/permission_allow_button' }),
  T('Don’t allow', 132, 1434, 948, 1540, { ...B, id: 'com.android.permissioncontroller:id/permission_deny_button' })]);
const FEED_L = screen(D('New post', 36, 180, 90, 234, { click: true }), STORIES(['jasmine.sieben', 'aishahsofey', 'xaviermichea']),
  T('aishahsofey', 150, 680, 360, 720), T('slo, Twilight, Tazzy · around the world ((la la la la l...', 196, 728, 940, 764), NAV);
// the accounts sheet of a two-account app, in its own window (only the sheet is dumped)
const SWITCHER_L = win(IG, [0, 1342, 1080, 2400], [T('urlucybby', 222, 1488, 420, 1528), V(938, 1484, 990, 1534, { cls: 'android.widget.ImageView' }),
  T('lucy.backup2', 222, 1658, 470, 1698), T('Add Instagram account', 222, 1828, 665, 1868), T('Other profiles', 53, 1978, 272, 2016),
  T('Add WhatsApp', 222, 2126, 508, 2166), T('Go to Accounts Center', 324, 2268, 757, 2310, B)]);
// another account's public profile, opened with the VIEW intent
const VISIT_BACKUP = screen(D('Back', 30, 174, 100, 234, { click: true }), T('lucy.backup2', 150, 174, 420, 234), T('Lucy B', 316, 348, 450, 386),
  T('12', 316, 418, 364, 458), T('posts', 316, 470, 410, 510), T('310', 526, 418, 590, 458), T('followers', 526, 470, 680, 510),
  T('40', 799, 418, 838, 458), T('following', 799, 470, 953, 510), T('Follow', 32, 924, 532, 1008, B), T('Message', 548, 924, 1048, 1008, B), NAV);
// a personal account (no "Your dashboard")
const PROFILE_P = screen(T('mia.daily_', 43, 174, 330, 234, { click: true }), D('New post', 840, 174, 894, 234, { click: true }),
  T('Mia', 316, 348, 400, 386), T('14', 316, 418, 360, 458), T('posts', 316, 470, 410, 510), T('1.2M', 526, 418, 620, 458), T('followers', 526, 470, 680, 510),
  T('230', 799, 418, 860, 458), T('following', 799, 470, 953, 510), T('Edit profile', 32, 700, 532, 784, B), T('Share profile', 548, 700, 1048, 784, B), NAV);
const SWITCHER_P = win(IG, [0, 1500, 1080, 2400], [T('mia.daily_', 222, 1600, 420, 1640), T('Add Instagram account', 222, 1770, 665, 1810)]);
// login screens, blocks, other apps, prompts
const LOGIN_FORM = screen(T('English (US)', 416, 290, 612, 330), T('', 42, 1000, 1038, 1110, { cls: 'android.widget.EditText', desc: 'Username, email or mobile number' }),
  T('', 42, 1140, 1038, 1250, { cls: 'android.widget.EditText', desc: 'Password' }), T('Log in', 42, 1290, 1038, 1400, B),
  T('Forgot password?', 360, 1440, 720, 1490, { click: true }), T('Create new account', 42, 2100, 1038, 2200, B), D('Meta', 460, 2250, 620, 2300));
const LOGIN_SAVED = screen(D('Profile picture', 400, 700, 680, 980), T('urfavekadiee', 380, 1010, 700, 1060), T('Log in', 42, 1120, 1038, 1230, B),
  T('Log into another account', 42, 1260, 1038, 1370, B), T('Create new account', 42, 2100, 1038, 2200, B), D('Meta', 460, 2250, 620, 2300));
// v0.5.16: Meta's "profiles" chooser - logged out, but no "Log in" button and no field. The texts are
// what two farm phones showed in the 2026-11-10 run, where both ended "couldn't read":
// (5) Valentina no. 17 (several saved profiles, one already "Instagram user") and (20) Valentina 2
// no. 21 (one saved profile with "Continue").
const LOGIN_PROFILES = screen(D('Settings', 960, 150, 1040, 230, { click: true }),
  T('val.inbloom1', 250, 700, 800, 760, { click: true }), T('Instagram user', 250, 880, 800, 940, { click: true }),
  T('val2hot2handle', 250, 1060, 800, 1120, { click: true }), T('valnightdrive', 250, 1240, 800, 1300, { click: true }),
  T('Use another profile', 42, 1900, 1038, 2010, B), T('Create new account', 42, 2040, 1038, 2150, B), D('Meta logo', 460, 2250, 620, 2300));
const LOGIN_ONE = screen(D('Settings', 960, 150, 1040, 230, { click: true }), T('Instagram from Meta', 300, 300, 780, 350),
  D('val2best, profile photo', 400, 700, 680, 980), T('val2best', 380, 1010, 700, 1060), T('Continue', 42, 1120, 1038, 1230, B),
  T('Use another profile', 42, 1260, 1038, 1370, B), T('Create new account', 42, 2040, 1038, 2150, B), D('Meta logo', 460, 2250, 620, 2300));
const LOGIN_LOGAN = screen(D('Profile picture', 400, 700, 680, 980), T('logan.xo', 380, 1010, 700, 1060), T('Log in', 42, 1120, 1038, 1230, B),
  T('Log into another account', 42, 1260, 1038, 1370, B), T('Create new account', 42, 2100, 1038, 2200, B));
const CHALLENGE = screen(T('Confirm it\'s you', 43, 300, 700, 360), T('We noticed unusual activity on your account. Enter the 6-digit code we sent to your email.', 43, 400, 1037, 520),
  T('', 43, 600, 1037, 700, { cls: 'android.widget.EditText' }), T('Continue', 42, 2100, 1038, 2200, B));
const ACTION_BLOCKED = screen(T('Action Blocked', 140, 900, 940, 960), T('This action was blocked. Please try again later. We restrict certain activity to protect our community.', 140, 980, 940, 1120),
  T('Tell us', 140, 1180, 940, 1260, B), T('OK', 140, 1280, 940, 1360, B));
const SUSPENDED = screen(T('We suspended your account', 43, 300, 1037, 380), T('@urfavekadiee', 43, 400, 500, 440), T('You have 180 days left to disagree with this decision.', 43, 480, 1037, 560),
  T('Disagree with decision', 42, 1900, 1038, 2000, B), T('Log out', 42, 2050, 1038, 2150, B));
const DISABLED = screen(T('Your account has been disabled', 43, 300, 1037, 380), T('Learn more', 42, 1900, 1038, 2000, B));
const KEYGUARD = win('com.android.systemui', [0, 0, 1080, 2400], [V(0, 0, 1080, 2400, { id: 'com.android.systemui:id/keyguard_root_view' }),
  T('9:41', 300, 300, 780, 480), D('Unlock', 480, 1900, 600, 2020, { id: 'com.android.systemui:id/lock_icon_view' }), T('Swipe up to open', 380, 2200, 700, 2240)]);
const SHADE = win('com.android.systemui', [0, 0, 1080, 2400], [V(0, 0, 1080, 2400, { id: 'com.android.systemui:id/notification_panel' }), T('No notifications', 300, 900, 780, 960)]);
const BROWSER = win('app.vanadium.browser', [0, 0, 1080, 2400], [T('Google Play', 0, 200, 1080, 300), T('Install', 800, 1800, 1000, 1900, B)]);
const EDITS_PROMO = screen(T('Try Edits, an app by Instagram', 60, 1500, 1020, 1600), T('Continue', 60, 2100, 1020, 2200, B));
const MUSE_FULL = screen(T('Meet Muse, your new personal AI agent', 155, 1362, 925, 1410), T('Try Muse', 84, 1596, 996, 1684, B));
const NOTIF_PROMPT_IG = screen(T('Turn on notifications?', 140, 900, 940, 960), T('Turn on', 140, 1180, 940, 1260, B), T('Not now', 140, 1280, 940, 1360, B), NAV);
const ANR = win('android', [100, 900, 980, 1500], [T('Instagram isn\'t responding', 140, 950, 940, 1010), T('Close app', 140, 1200, 940, 1280, B), T('Wait', 140, 1300, 940, 1380, B)]);
const WEIRD = screen(T('Something new is here', 100, 600, 980, 660), T('Swipe to see more', 100, 700, 980, 760), T('Lorem ipsum', 100, 800, 980, 860));

const P = (xml) => ig.parseDump(xml);
const kind = (xml) => ck.classifyScreen(P(xml)).kind;

(async () => {
  // ---------- 1. numbers, percentages, dates ----------
  check('counts (header / dashboard formats)', ['4,720', '44.3K', '905.5K', '1.2M', '85', '20,198', '2,253', '--', '0'].map(st.parseCount),
    [4720, 44300, 905500, 1200000, 85, 20198, 2253, null, 0]);
  check('parsePct', ['53.1%', '+435.1% since Oct 9', '−2.5%', '<0.1%', '12,5 %', '+1,234.5%', '0.4% followers', '2,253', 'abc', ''].map(ck.parsePct),
    [53.1, 435.1, -2.5, 0.1, 12.5, 1234.5, 0.4, null, null, null]);
  check('parseDate', ['Nov 24, 2026', 'Ends on Nov 24, 2026', 'Oct 22, 2026', '24 November 2026', 'September 3, 2026', '2026-11-24', 'Nov 24', 'See why'].map(ck.parseDate),
    ['2026-11-24', '2026-11-24', '2026-10-22', '2026-11-24', '2026-09-03', '2026-11-24', '', '']);
  check('parseRange: Instagram\'s period and its length', [ck.parseRange('Oct 9 - Nov 7', '2026-11-08'), ck.parseRange('Dec 20 – Jan 18', '2027-01-19'), ck.parseRange('Views', '2026-11-08')],
    [{ text: 'Oct 9 - Nov 7', days: 30 }, { text: 'Dec 20 - Jan 18', days: 30 }, null]);

  // ---------- 2. every screen of the build, recognised ----------
  const KINDS = [['01_after_switch (launcher)', LAUNCHER, 'launcher'], ['02_ig_open (Join Instagram)', JOIN, 'no_account'],
    ['u15 (restriction notice)', NOTICE_RESTRICT, 'notice'], ['u20 (feed + Muse card)', FEED_MUSE, 'feed'], ['u25 (removed post notice)', NOTICE_REMOVED, 'notice'],
    ['u25_b (feed, bottom bar by names only)', FEED_K, 'feed'], ['u25_profile (title left)', PROFILE_K, 'profile'], ['d0_open (title centred)', PROFILE_KC, 'profile'],
    ['u25_switcher (sheet over the profile)', SWITCHER_K, 'switcher'], ['d1_dashboard', DASH_K, 'dashboard'], ['a2_dash (Next steps)', DASH_L, 'dashboard'],
    ['d2_views (Overview top)', OV1, 'insights_overview'], ['Overview after the tile swipe', OV1B, 'insights_overview'], ['d4_over_1', OV2, 'insights_overview'], ['d4_over_3', OV3, 'insights_overview'],
    ['d3_audience (under 100)', AUD_U100, 'insights_audience'], ['a3_audience', AUD1, 'insights_audience'], ['a4_aud_1', AUD2, 'insights_audience'],
    ['a4_aud_2', AUD3(COUNTRIES), 'insights_audience'], ['a4_aud_3', AUD4(COUNTRIES, 'Su'), 'insights_audience'], ['a1_profile', PROFILE_L, 'profile'],
    ['a0_open (Android notification prompt)', PERMISSION, 'popup'], ['the accounts sheet in its own window', SWITCHER_L, 'switcher'],
    ['another account\'s profile (visit)', VISIT_BACKUP, 'profile'], ['personal account profile', PROFILE_P, 'profile'],
    ['login form', LOGIN_FORM, 'login'], ['saved-account login', LOGIN_SAVED, 'login'], ['"Confirm it\'s you"', CHALLENGE, 'challenge'],
    ['"Action Blocked"', ACTION_BLOCKED, 'checkpoint'], ['"We suspended your account"', SUSPENDED, 'suspended'], ['"Your account has been disabled"', DISABLED, 'disabled'],
    ['lock screen (systemui)', KEYGUARD, 'keyguard'], ['notification shade', SHADE, 'other_app'], ['another app (browser)', BROWSER, 'other_app'],
    ['Edits promo (only Back closes it)', EDITS_PROMO, 'promo_back'], ['full-screen Muse promo', MUSE_FULL, 'promo_back'],
    ['Instagram\'s own "Turn on notifications?"', NOTIF_PROMPT_IG, 'popup'], ['"Instagram isn\'t responding"', ANR, 'loading'], ['empty dump', '', 'loading'],
    ['an unknown Instagram screen', WEIRD, 'unknown']];
  for (const [name, xml, want] of KINDS) check(`classify: ${name}`, kind(xml), want);
  {
    const c = ck.classifyScreen(P(PERMISSION));
    check('the Android prompt is answered "Don’t allow", never "Allow"', [c.detail.label, c.detail.target.cy], ['Don\'t allow', 1487]);
    check('Instagram\'s pop-up: "Not now"', ck.classifyScreen(P(NOTIF_PROMPT_IG)).detail.label, 'Not now');
    check('the Muse card on the feed is NOT a pop-up (its X is not ours to tap)', ck.classifyScreen(P(FEED_MUSE)).kind, 'feed');
    check('the own profile vs someone else\'s', [ck.classifyScreen(P(PROFILE_K)).detail.own, ck.classifyScreen(P(VISIT_BACKUP)).detail.own], [true, false]);
    check('the ANR dialog says why it waits', ck.classifyScreen(P(ANR)).detail.why, 'app_not_responding');
    check('a block page names the account when it prints @handle', ck.classifyScreen(P(SUSPENDED)).detail.username, 'urfavekadiee');
  }

  // ---------- 3. notices ----------
  check('u15: the restriction, its date and its end', ck.parseNotice(P(NOTICE_RESTRICT)),
    { kind: 'restriction', title: 'We added a restriction to your account', detail: 'You can\'t send messages · Ends on Nov 24, 2026', date: '2026-10-25', until: '2026-11-24' });
  check('u25: the removed post', ck.parseNotice(P(NOTICE_REMOVED)),
    { kind: 'removed_post', title: 'We removed your post', detail: 'I mean, try me · Oct 20, 2026 · You shared this on your profile', date: '2026-10-22', until: '' });
  {
    const x1 = ck.noticeCloseTarget(P(NOTICE_RESTRICT)), x2 = ck.noticeCloseTarget(P(NOTICE_REMOVED));
    check('the notice X: labelled "Close", or an unlabelled icon top-right; never "See why"', [x1.cx, x1.cy, x2.cx, x2.cy], [995, 205, 995, 205]);
  }
  check('statusFor: a restriction until Nov 24 is on today, off after; no end date = on; a removed post never restricts', [
    ck.statusFor('checked', [{ kind: 'restriction', until: '2026-11-24' }], '2026-11-08'), ck.statusFor('checked', [{ kind: 'restriction', until: '2026-11-24' }], '2026-11-25'),
    ck.statusFor('checked', [{ kind: 'restriction', until: '' }], '2026-11-08'), ck.statusFor('checked', [{ kind: 'removed_post', until: '' }], '2026-11-08'),
    ck.statusFor('logged_out', [], '2026-11-08')], ['RESTRICTED', 'HEALTHY', 'RESTRICTED', 'HEALTHY', null]);

  // ---------- 4. the profile header ----------
  const pick = (o, ks) => ks.reduce((a, k) => (a[k] = o[k], a), {});
  const HEAD = ['username', 'name', 'posts', 'followers', 'following', 'views_30d', 'has_dashboard', 'own'];
  check('u25_profile: urfavekadiee / Kadie / 3 posts 85 followers 12 following / 44.3K views', pick(ck.parseProfileHeader(P(PROFILE_K)), HEAD),
    { username: 'urfavekadiee', name: 'Kadie', posts: 3, followers: 85, following: 12, views_30d: 44300, has_dashboard: true, own: true });
  check('d0_open: the same with the title centred and no ids', pick(ck.parseProfileHeader(P(PROFILE_KC)), HEAD),
    { username: 'urfavekadiee', name: 'Kadie', posts: 3, followers: 85, following: 12, views_30d: 44300, has_dashboard: true, own: true });
  check('a1_profile: urlucybby, 26 / 4,720 / 5, 905.5K views, no name (the note bubble is not a name)', pick(ck.parseProfileHeader(P(PROFILE_L)), HEAD),
    { username: 'urlucybby', name: '', posts: 26, followers: 4720, following: 5, views_30d: 905500, has_dashboard: true, own: true });
  check('a personal account: 1.2M followers, no dashboard', pick(ck.parseProfileHeader(P(PROFILE_P)), HEAD),
    { username: 'mia.daily_', name: 'Mia', posts: 14, followers: 1200000, following: 230, views_30d: null, has_dashboard: false, own: true });
  check('a visited profile (Follow / Message): counts, not ours', pick(ck.parseProfileHeader(P(VISIT_BACKUP)), HEAD),
    { username: 'lucy.backup2', name: 'Lucy B', posts: 12, followers: 310, following: 40, views_30d: null, has_dashboard: false, own: false });
  check('handles: chevron dropped, Instagram\'s own words refused', ['urfavekadiee ⌄', '@Kim.Daily', 'followers', '85', 'Insights', 'a'].map(ck.handleOf),
    ['urfavekadiee', 'kim.daily', '', '', '', '']);

  // ---------- 5. the accounts sheet ----------
  check('u25_switcher: one account, the profile behind the sheet ignored', ck.parseSwitcher(P(SWITCHER_K), 'urfavekadiee'), [{ username: 'urfavekadiee', active: true }]);
  check('two accounts, the active one from the header', ck.parseSwitcher(P(SWITCHER_L), 'urlucybby'), [{ username: 'urlucybby', active: true }, { username: 'lucy.backup2', active: false }]);
  {
    const marked = SWITCHER_L.replace('bounds="[938,1484][990,1534]"', 'bounds="[938,1654][990,1704]"').replace('content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[938,1654]', 'content-desc="Selected" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[938,1654]');
    check('a check mark read out on a row wins', ck.parseSwitcher(P(marked), ''), [{ username: 'urlucybby', active: false }, { username: 'lucy.backup2', active: true }]);
  }
  check('login screens: the accounts they still offer', [ck.parseLoginRemembered(P(LOGIN_SAVED)), ck.parseLoginRemembered(P(LOGIN_FORM)), ck.classifyScreen(P(LOGIN_SAVED)).detail.remembered],
    [['urfavekadiee'], [], ['urfavekadiee']]);
  check('v0.5.16 the "profiles" chooser (no Log in button) is a login screen: several saved profiles / one with "Continue"',
    [ck.classifyScreen(P(LOGIN_PROFILES)).kind, ck.classifyScreen(P(LOGIN_PROFILES)).detail.remembered, ck.classifyScreen(P(LOGIN_ONE)).kind, ck.classifyScreen(P(LOGIN_ONE)).detail.remembered],
    ['login', ['val.inbloom1', 'val2hot2handle', 'valnightdrive'], 'login', ['val2best']]);
  check('...a button\'s word is not an account, and a username that only BEGINS with log / sign / create / forgot is one',
    [ck.parseLoginRemembered(P(LOGIN_ONE)).includes('continue'), ck.parseLoginRemembered(P(LOGIN_LOGAN))], [false, ['logan.xo']]);
  check('..."Use another profile" alone (no Continue, no Create new account, no Log in) is not enough to call a screen a login',
    ck.classifyScreen(P(screen(T('Use another profile', 42, 1260, 1038, 1370, B), T('Something else', 42, 300, 600, 360)))).kind === 'login', false);

  // ---------- 6. dashboard + Overview ----------
  check('d1_dashboard: period, Views 44.3K, New followers 0, Content you shared 10', ck.parseDashboard(P(DASH_K), '2026-11-08'),
    { range: 'Oct 9 - Nov 7', days: 30, views: 44300, new_followers: 0, content_shared: 10 });
  check('a2_dash: 905.5K / 4.1K / 40', ck.parseDashboard(P(DASH_L), '2026-11-08'), { range: 'Oct 9 - Nov 7', days: 30, views: 905500, new_followers: 4100, content_shared: 40 });
  {
    const o1 = ck.parseOverview(P(OV1), null);
    check('d2_views: tiles, followers / non-followers, Viewers, views by type (Live cut off)', pick(o1, ['views', 'net_followers', 'interactions', 'followers_pct_of_views', 'non_followers_pct_of_views', 'viewers', 'views_by_type', 'days', 'more_tiles']),
      { views: 44321, net_followers: null, interactions: 969, followers_pct_of_views: 0.4, non_followers_pct_of_views: 99.6, viewers: 20198,
        views_by_type: { reels: 43300, stories: 978, posts: 0, live: null }, days: 30, more_tiles: true });
    const o2 = ck.parseOverview(P(OV2), o1);
    check('d4_over_1: the views rows above "Top content" stay views; the rows under "Interactions by content type" are interactions',
      [o2.views_by_type, o2.interactions_by_type], [{ reels: 43300, stories: 978, posts: 0, live: 0 }, { reels: 952, stories: 17, posts: 0, live: 0 }]);
    const o3 = ck.parseOverview(P(OV3), o2);
    check('d4_over_3: profile activity', pick(o3, ['profile_visits', 'bio_link_taps', 'business_address_taps']), { profile_visits: 2253, bio_link_taps: 0, business_address_taps: 0 });
    check('a thumbnail\'s view count ("2.6K") is never taken for a row', o3.views_by_type.posts, 0);
    const lone = ck.parseOverview(P(OV3), null);
    check('without the earlier screens the thumbnails\' counts are not views either', lone.views_by_type, { reels: null, stories: null, posts: null, live: null });
  }

  // ---------- 7. Audience ----------
  check('d3_audience: 85 followers, under 100, nothing else', pick(ck.parseAudience(P(AUD_U100), null), ['followers', 'under_100', 'gender', 'age', 'countries']),
    { followers: 85, under_100: true, gender: null, age: null, countries: null });
  {
    let a = ck.parseAudience(P(AUD1), null, { loc: 'countries' });
    check('a3_audience: 4,720 followers, +435.1%, Women 2.1% (the thumbnails\' 617 / 553 are not percentages)', pick(a, ['followers', 'growth_pct', 'under_100', 'gender']),
      { followers: 4720, growth_pct: 435.1, under_100: false, gender: { women: 2.1, men: null } });
    a = ck.parseAudience(P(AUD2), a, { loc: 'countries' });
    check('a4_aud_1: gender + every age band (the Age range legend "Women / Men" is not the gender)', [a.gender, a.age],
      [{ women: 2.1, men: 97.9 }, { '13-17': 0.1, '18-24': 10.2, '25-34': 24.7, '35-44': 31.4, '45-54': 20.2, '55-64': 9.7, '65+': 3.7 }]);
    a = ck.parseAudience(P(AUD3(COUNTRIES)), a, { loc: 'countries' });
    check('a4_aud_2: the top five countries and USA %', [a.countries, a.us_pct],
      [[{ name: 'United States', pct: 53.1 }, { name: 'United Kingdom', pct: 4.9 }, { name: 'Canada', pct: 3.9 }, { name: 'Mexico', pct: 3.3 }, { name: 'Australia', pct: 2.7 }], 53.1]);
    check('...and no bars from a chart cut by the screen\'s edge', a.active_times && a.active_times.days, {});
    a = ck.parseAudience(P(AUD3(CITIES)), a, { loc: 'cities' });
    check('the Cities chip: cities apart from countries', [a.cities.map((c) => c.name), a.countries.length], [['New York', 'Los Angeles', 'Chicago', 'Houston', 'London'], 5]);
    a = ck.parseAudience(P(AUD4(CITIES, 'Su')), a, { loc: 'cities', day: 'Su' });
    check('a4_aud_3: Sunday\'s eight bars as shares of the tallest (no numbers printed)', a.active_times.days.Su, [0.631, 0.465, 0.651, 0.895, 0.997, 1, 0.933, 0.825]);
    check('...the time zone and "When followers are most active"', [a.active_times.tz, a.active_times.top],
      ['EST', [{ day: 'Fri', from: '3 PM', to: '6 PM' }, { day: 'Thu', from: '3 PM', to: '6 PM' }, { day: 'Fri', from: '12 PM', to: '3 PM' }]]);
    check('...and the cities seen twice are not listed twice', a.cities.length, 5);
    const said = AUD4(COUNTRIES, 'Su').replace(/class="android.view.View" package="com.instagram.android" content-desc=""( [^>]*bounds="\[(?:60|181|302|425|546|668|790|912),)/g,
      (m, rest) => `class="android.view.View" package="com.instagram.android" content-desc="40"${rest}`).replace('content-desc="40" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[668,', 'content-desc="80" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[668,');
    check('bars that read their value out: the values, not the heights', ck.parseAudience(P(said), null, { day: 'M' }).active_times.days.M, [0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5]);
  }

  // ---------- 7b. builds that read a whole row out as ONE node (no separate label / number) ----------
  {
    const RowD = (desc, l, t, r, b) => ({ desc, b: [l, t, r, b], cls: 'android.view.ViewGroup' });
    const OV_INLINE = screen(D('Back', 43, 180, 103, 234, { click: true }), T('Insights', 190, 180, 367, 234),   // no tab texts in this build
      RowD('Views, 44,321', 43, 562, 436, 768), RowD('Net followers, -2', 470, 562, 866, 768), RowD('Interactions, 969', 898, 562, 1080, 768),
      T('0.4%', 43, 806, 110, 844), T('followers', 118, 806, 293, 844), T('99.6%', 43, 850, 140, 888), T('non-followers', 148, 850, 390, 888),
      T('Views by content type', 43, 1584, 487, 1630), RowD('Viewers, 20,198', 0, 1680, 1080, 1740),
      RowD('Reels, 43.3K', 0, 1890, 1080, 1990), RowD('Stories, 978', 0, 2024, 1080, 2124), RowD('Posts, 0', 0, 2158, 1080, 2258));
    check('an Insights page recognised by its sections when the tabs are not text', kind(OV_INLINE), 'insights_overview');
    const o = ck.parseOverview(P(OV_INLINE), null);
    check('tiles and rows read out as one node each', [o.views, o.net_followers, o.interactions, o.followers_pct_of_views, o.non_followers_pct_of_views, o.viewers, o.views_by_type],
      [44321, -2, 969, 0.4, 99.6, 20198, { reels: 43300, stories: 978, posts: 0, live: null }]);
    check('...and their row still gets its one sideways swipe', ck.tileRow(P(OV_INLINE)), { y: 665, x1: 918, x2: 162, more: true });
    const AUD_INLINE = screen(INSIGHTS_HEAD('a'), T('Gender', 43, 764, 187, 808), RowD('Women, 2.1%', 0, 860, 1080, 980), RowD('Men, 97.9%', 0, 994, 1080, 1114),
      T('Age range', 43, 1188, 246, 1234), RowD('18-24, 10.2%', 0, 1360, 1080, 1480),
      T('Top locations', 43, 1600, 308, 1640), RowD('United States, 53.1%', 0, 1700, 1080, 1820), T('United States', 43, 1710, 244, 1742), T('53.1%', 943, 1764, 1027, 1796));
    const a = ck.parseAudience(P(AUD_INLINE), null, { loc: 'countries' });
    check('gender / age / places read out as one node; a row given both ways is counted once', [a.gender, a.age, a.countries, a.us_pct],
      [{ women: 2.1, men: 97.9 }, { '18-24': 10.2 }, [{ name: 'United States', pct: 53.1 }], 53.1]);
    check('the dashboard (it has an "Insights" heading too) is never taken for the Insights page', [kind(DASH_K), kind(DASH_L)], ['dashboard', 'dashboard']);
  }

  // ---------- 8. where taps land ----------
  {
    const at = (t) => (t ? [t.cx, t.cy] : null);
    check('profile tab: by name (no ids) and by id', [at(ck.profileTab(P(FEED_K))), at(ck.profileTab(P(FEED_MUSE)))], [[972, 2273], [972, 2273]]);
    check('"Your dashboard": the whole card', at(ck.dashboardRow(P(PROFILE_K))), [540, 827]);
    check('no dashboard row on a personal profile', ck.dashboardRow(P(PROFILE_P)), null);
    check('the dashboard\'s Views row (its row box), on both dashboards', [at(ck.viewsRow(P(DASH_K))), at(ck.viewsRow(P(DASH_L)))], [[540, 480], [540, 480]]);
    check('Insights tabs: Overview / Audience only, never Content', [at(ck.tabTarget(P(OV1), 'Audience')), at(ck.tabTarget(P(AUD1), 'Overview')), ck.tabTarget(P(OV1), 'Content')],
      [[900, 337], [180, 337], null]);
    check('chips: Cities, a day; nothing else', [at(ck.chipTarget(P(AUD3(COUNTRIES)), 'Cities')), at(ck.chipTarget(P(AUD4(COUNTRIES, 'Su')), 'Th')), ck.chipTarget(P(AUD1), 'Overall')],
      [[381, 1172], [664, 1122], null]);
    check('the title, left-aligned or centred (only when it is the account we read)', [at(ck.titleTarget(P(PROFILE_K), 'urfavekadiee')), at(ck.titleTarget(P(PROFILE_L), 'urlucybby')), ck.titleTarget(P(PROFILE_L), 'someone.else')],
      [[244, 204], [561, 204], null]);
    check('the tile row scrolls sideways once', ck.tileRow(P(OV1)), { y: 662, x1: 918, x2: 162, more: true });
    const refuse = (xml, x, y) => !!ck.tapRefused(P(xml), x, y);
    check('the last word before a tap: See why / Allow / Edit profile / Try Muse / See all / the sheet refused; the X, Don’t allow, the card allowed',
      [refuse(NOTICE_RESTRICT, 540, 2208), refuse(PERMISSION, 540, 1339), refuse(PROFILE_K, 282, 966), refuse(FEED_MUSE, 540, 1640), refuse(OV2, 990, 1000),
        refuse(SWITCHER_K, 344, 1508), refuse(NOTICE_RESTRICT, 995, 205), refuse(PERMISSION, 540, 1487), refuse(PROFILE_K, 540, 827)],
      [true, true, true, true, true, true, false, false, false]);
    const ALLOWED_WORDS = ['Not now', 'Skip', 'Later', 'Maybe later', 'No thanks', 'No, thanks', 'Dismiss', 'Close', 'Don’t allow', "Don't allow", 'Cancel'];
    const NEVER = ['OK', 'Okay', 'Got it', 'Allow', 'Continue', 'See why', 'Agree', 'Accept', 'Learn more', 'Try Muse', 'Log in'];
    const hits = (w) => ck.SAFE_DISMISS.some((s) => [s.text, s.desc].some((re) => re instanceof RegExp && re.test(w)));
    check('SAFE_DISMISS: every safe word, and none of the words that accept something', [ALLOWED_WORDS.every(hits), NEVER.filter(hits)], [true, []]);
  }

  // ---------- 9. adb text for core.js ----------
  check('dumpsys activity: resumed activity with u10, keyguard flag', ck.parseActivities('  KeyguardController:\n    mKeyguardShowing=false\n  topResumedActivity=ActivityRecord{8f2a1b u10 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t42}\n'),
    { resumed: { uid: 10, pkg: 'com.instagram.android', cls: 'com.instagram.mainactivity.InstagramMainActivity' }, keyguard: false });
  check('dumpsys activity: the owner printed with and without "u0"', [ck.parseActivities('    ResumedActivity: ActivityRecord{abc u0 com.android.launcher3/.uioverrides.QuickstepLauncher t3}').resumed,
    ck.parseActivities('    mResumedActivity: ActivityRecord{c0ffee com.android.launcher3/.uioverrides.QuickstepLauncher t3}\n mKeyguardShowing=true').resumed],
    [{ uid: 0, pkg: 'com.android.launcher3', cls: '.uioverrides.QuickstepLauncher' }, { uid: 0, pkg: 'com.android.launcher3', cls: '.uioverrides.QuickstepLauncher' }]);
  check('dumpsys window: the lock screen in front / an app in front / the dreaming-lockscreen flag', [
    ck.parseWindow('  mCurrentFocus=Window{1a2b u0 NotificationShade}'), ck.parseWindow('  mCurrentFocus=Window{9a2f u12 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}').focus,
    ck.parseWindow('mDreamingLockscreen=false mDreamingSleepToken=null').keyguard],
  [{ focus: { uid: 0, pkg: 'NotificationShade', cls: '' }, keyguard: true, covered: true }, { uid: 12, pkg: 'com.instagram.android', cls: 'com.instagram.mainactivity.InstagramMainActivity' }, false]);
  check('wm size: the override wins', [ck.parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600'), ck.parseWmSize('Physical size: 1080x2400'), ck.parseWmSize('')],
    [{ w: 720, h: 1600 }, { w: 1080, h: 2400 }, null]);
  // v0.5.16: the profile's lock state - a profile still locked has "no launcher" for Instagram
  check('user state: am get-started-user-state, "not started", dumpsys user for the right uid, unknown', [
    ck.parseUserState('RUNNING_LOCKED\n', 15), ck.parseUserState('RUNNING_UNLOCKED', 15), ck.parseUserState('User is not started: 15', 15),
    ck.parseUserState('Users:\r\n  UserInfo{0:Owner:c13} running\r\n    State: RUNNING_UNLOCKED\r\n  UserInfo{15:6:410} serialNo=20\r\n    State: RUNNING_UNLOCKING\r\n', 15),
    ck.parseUserState('Users:\n  UserInfo{0:Owner:c13} running\n    State: RUNNING_UNLOCKED\n  UserInfo{15:6:410}\n', 15),
    ck.parseUserState('Unknown command: get-started-user-state', 15)],
    ['RUNNING_LOCKED', 'RUNNING_UNLOCKED', 'STOPPED', 'RUNNING_UNLOCKING', null, null]);
  {
    const home = (pkg, label) => [
      { pkg, text: '', desc: '', bounds: { l: 0, t: 0, r: 1080, b: 2400 }, cx: 540, cy: 1200 },
      { pkg, text: 'Telegram', desc: '', bounds: { l: 330, t: 980, r: 490, b: 1200 }, cx: 410, cy: 1090 },
      { pkg, text: label, desc: '', bounds: { l: 60, t: 980, r: 220, b: 1200 }, cx: 140, cy: 1090 }];
    check('launcher icon: Instagram on the home screen / not "Instagram Lite" / not inside an app', [
      ck.launcherIconTarget(home('com.android.launcher3', 'Instagram'), 'Instagram'),
      ck.launcherIconTarget(home('com.android.launcher3', 'Instagram Lite'), 'Instagram'),
      ck.launcherIconTarget(home('com.instagram.android', 'Instagram'), 'Instagram'),
      ck.launcherIconTarget([], 'Instagram')],
    [{ x: 140, y: 1090 }, null, null, null]);
    const L = 'com.android.launcher3', box = { l: 60, t: 980, r: 220, b: 1200 };
    const one = (x) => [{ pkg: L, text: '', desc: '', bounds: { l: 0, t: 0, r: 1080, b: 2400 }, cx: 540, cy: 1200 }, Object.assign({ pkg: L, text: '', desc: '', bounds: box, cx: 140, cy: 1090 }, x)];
    check('launcher icon: an icon named only by its description counts; a label that cannot be tapped, a folder named Instagram and a folder class do not', [
      ck.launcherIconTarget(one({ desc: 'Instagram', clickable: true }), 'Instagram'),
      ck.launcherIconTarget(one({ text: 'Instagram', clickable: false }), 'Instagram'),
      ck.launcherIconTarget(one({ text: 'Instagram', clickable: true, id: 'com.android.launcher3:id/folder_icon_name' }), 'Instagram'),
      ck.launcherIconTarget(one({ text: 'Instagram', clickable: true, cls: 'com.android.launcher3.folder.FolderIcon' }), 'Instagram')],
    [{ x: 140, y: 1090 }, null, null, null]);
  }

  // ---------- 10. whole visits on a fake phone ----------
  // def: { screen: { xml, tap: [[label regex, next]], back, home, up, down, left, launch, unlock } }
  // A tap that hits a listed label (its node or the clickable box around it) moves on; any other tap
  // is recorded and changes nothing - the forbidden-tap check below catches it.
  function phone(def, start, o) {
    let cur = start, t = 0;
    const F = { taps: [], keys: [], swipes: [], opened: [], seen: [start], launched: 0, unlocked: 0, viewerAt: (o || {}).viewerAt != null ? o.viewerAt : null };
    const go = (nx) => { if (!def[nx]) throw new Error('fake phone: no screen ' + nx); cur = nx; F.seen.push(nx); };
    const xml = () => (typeof def[cur].xml === 'function' ? def[cur].xml() : def[cur].xml);
    F.dump = async () => xml();
    F.tap = async (x, y) => {
      const ns = P(xml());
      F.taps.push({ x, y, t, screen: cur, labels: ns.filter((m) => m.bounds && x >= m.bounds.l && x <= m.bounds.r && y >= m.bounds.t && y <= m.bounds.b).map((m) => m.text || m.desc).filter(Boolean) });
      if (def[cur].swallow > 0) { def[cur].swallow--; return; }   // a tooltip / an animation takes this tap
      for (const [re, nx] of def[cur].tap || []) {
        if (Array.isArray(re)) { if (x >= re[0] && x <= re[2] && y >= re[1] && y <= re[3]) { go(nx); return; } continue; }   // a bare box (an unlabelled icon)
        const hit = ns.find((m) => m.bounds && (re.test(m.text) || re.test(m.desc)));
        if (!hit) continue;
        const box = ig.tapTarget(ns, hit);
        const inBox = (m) => x >= m.bounds.l && x <= m.bounds.r && y >= m.bounds.t && y <= m.bounds.b;
        if (inBox(box) || inBox(hit)) { go(nx); return; }
      }
    };
    F.key = async (k) => { F.keys.push({ k, t, screen: cur }); if (def[cur][k]) go(def[cur][k]); };
    F.swipe = async (x1, y1, x2, y2) => {
      const dir = Math.abs(x2 - x1) > Math.abs(y2 - y1) ? (x2 < x1 ? 'left' : 'right') : (y2 < y1 ? 'up' : 'down');
      F.swipes.push({ dir, t, screen: cur });
      if (def[cur][dir]) go(def[cur][dir]);
    };
    F.wait = async (ms) => { t += ms; };
    F.now = () => t;
    F.viewer = async () => F.viewerAt != null && t >= F.viewerAt;
    F.launch = async () => { F.launched++; if (def[cur].launch) go(def[cur].launch); };
    F.openProfile = async (u) => { F.opened.push(u); if (def['visit:' + u]) go('visit:' + u); };
    F.unlock = async () => { F.unlocked++; if (def[cur].unlock) go(def[cur].unlock); };
    return F;
  }
  // Written separately from the module's own list on purpose: what the owner said must never be tapped.
  const NEVER_TAP = /^(see why|appeal|learn more|continue|agree|accept|allow|ok|get started|i already have a profile|log in|log into another account|create new account|try muse|add instagram account|add whatsapp|go to accounts center|follow|edit profile|share profile|add banners|message|see all|monthly recap|best practices|inspiration on edits|inspiration|ad tools|monetization tools|trending audio|other helpful resources|30 days|content|get meta verified|share|settings|info|dismiss|meta)$/i;
  const badTaps = (F) => F.taps.filter((tp) => tp.labels.some((l) => NEVER_TAP.test(l.trim())) || /^sheet/.test(tp.screen)).map((tp) => `${tp.screen}: ${tp.labels.join('/')}`);
  // IGCHECK_TRACE=1 prints every visit's trace (what was seen, tapped, swiped) - handy when tuning.
  const run = async (F, o) => {
    const r = await ck.check(F, Object.assign({ today: '2026-11-08' }, o || {}));
    if (process.env.IGCHECK_TRACE) console.log(r.trace.map((t) => `      ${String(t.ms).padStart(6)} ms  ${t.name.padEnd(7)} ${t.ok ? ' ' : '!'} ${t.matched}`).join('\n'));
    return r;
  };

  // ===== the 85-follower professional account of phone 14 (u25 -> profile -> Insights -> sheet) =====
  const KADIE = {
    removed: { xml: NOTICE_REMOVED, tap: [[[960, 170, 1030, 240], 'feed']] },   // its X is an unlabelled icon
    feed: { xml: FEED_K, tap: [[/^profile$/i, 'prof']] },
    prof: { xml: PROFILE_K, tap: [[/^your dashboard$/i, 'dash'], [/^urfavekadiee$/, 'sheet']], back: 'feed' },
    dash: { xml: DASH_K, tap: [[/^views$/i, 'ov1']], back: 'prof' },
    ov1: { xml: OV1, left: 'ov1b', up: 'ov2', tap: [[/^audience$/i, 'aud']], back: 'dash' },
    ov1b: { xml: OV1B, up: 'ov2', tap: [[/^audience$/i, 'aud']], back: 'dash' },
    ov2: { xml: OV2, up: 'ov3', tap: [[/^audience$/i, 'aud']], back: 'dash' },
    ov3: { xml: OV3, up: 'ov3', tap: [[/^audience$/i, 'aud']], back: 'dash' },
    aud: { xml: AUD_U100, back: 'dash' },
    sheet: { xml: SWITCHER_K, back: 'prof' },
  };
  {
    const F = phone(KADIE, 'removed');
    const r = await run(F);
    const a = r.accounts[0] || {};
    check('KADIE: checked, HEALTHY (a removed post does not restrict)', [r.state, r.status, r.why, r.username], ['checked', 'HEALTHY', '', 'urfavekadiee']);
    check('KADIE: the notice recorded and closed with its X', [r.notices.length, r.notices[0] && r.notices[0].kind, r.notices[0] && r.notices[0].date, F.taps[0].x > 960], [1, 'removed_post', '2026-10-22', true]);
    check('KADIE: the account', pick(a, ['username', 'active', 'name', 'posts', 'followers', 'following', 'views_30d', 'read', 'account_type']),
      { username: 'urfavekadiee', active: true, name: 'Kadie', posts: 3, followers: 85, following: 12, views_30d: 44300, read: 'own', account_type: 'professional' });
    const ins = a.insights || {};
    check('KADIE: Insights - dashboard + Overview', pick(ins, ['range', 'days', 'views', 'interactions', 'viewers', 'net_followers', 'new_followers', 'content_shared',
      'followers_pct_of_views', 'non_followers_pct_of_views', 'profile_visits', 'bio_link_taps', 'views_by_type', 'interactions_by_type']),
    { range: 'Oct 9 - Nov 7', days: 30, views: 44321, interactions: 969, viewers: 20198, net_followers: null, new_followers: 0, content_shared: 10,
      followers_pct_of_views: 0.4, non_followers_pct_of_views: 99.6, profile_visits: 2253, bio_link_taps: 0,
      views_by_type: { reels: 43300, stories: 978, posts: 0, live: 0 }, interactions_by_type: { reels: 952, stories: 17, posts: 0, live: 0 } });
    check('KADIE: Insights - Audience under 100 followers: no audience, and that is not an error', pick(ins, ['followers', 'under_100', 'gender', 'age', 'countries', 'cities', 'us_pct', 'active_times', 'why']),
      { followers: 85, under_100: true, gender: null, age: null, countries: null, cities: null, us_pct: null, active_times: null, why: [] });
    check('KADIE: one sideways swipe of the tiles, the Overview scrolled until it stopped changing', [F.swipes.filter((s) => s.dir === 'left').length, F.swipes.filter((s) => s.dir === 'up').length >= 2], [1, true]);
    check('KADIE: back on the profile, the sheet opened and closed with Back, the phone ends on the profile', [F.seen.includes('sheet'), F.seen[F.seen.length - 1]], [true, 'prof']);
    check('KADIE: no other accounts, nothing visited', [r.accounts.length, F.opened], [1, []]);
    check('KADIE: no forbidden tap, nothing tapped on the sheet', badTaps(F), []);
    check('KADIE: the evidence keeps the username out', JSON.stringify(r.screens).includes('urfavekadiee') || JSON.stringify(r.trace).includes('urfavekadiee'), false);
    check('KADIE: key screens kept (at most 12)', [r.screens.length <= 12, r.screens.map((s) => s.at).slice(0, 4)], [true, ['start', 'notice', 'profile', 'dashboard']]);
  }

  // ===== the 4,720-follower account of phone 10 (prompt -> profile -> full Audience -> 2 accounts) =====
  const dayScreens = (places, pre) => Object.fromEntries(['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'].map((d) => [`${pre || 'aud4_'}${d}`, {
    xml: AUD4(places, d), up: `${pre || 'aud4_'}${d}`, back: 'dash', tap: ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'].map((x) => [new RegExp(`^${x}$`), `${pre || 'aud4_'}${x}`]) }]));
  const LUCY = {
    prompt: { xml: PERMISSION, tap: [[/^don.t allow$/i, 'feed']] },
    feed: { xml: FEED_L, tap: [[/^profile$/i, 'prof']] },
    prof: { xml: PROFILE_L, tap: [[/^your dashboard$/i, 'dash'], [/^urlucybby$/, 'sheet']], back: 'feed' },
    dash: { xml: DASH_L, tap: [[/^views$/i, 'ov1']], back: 'prof' },
    ov1: { xml: OV1, left: 'ov1b', up: 'ov2', tap: [[/^audience$/i, 'aud1']], back: 'dash' },
    ov1b: { xml: OV1B, up: 'ov2', tap: [[/^audience$/i, 'aud1']], back: 'dash' },
    ov2: { xml: OV2, up: 'ov3', tap: [[/^audience$/i, 'aud1']], back: 'dash' },
    ov3: { xml: OV3, up: 'ov3', tap: [[/^audience$/i, 'aud1']], back: 'dash' },
    aud1: { xml: AUD1, up: 'aud2', back: 'dash' },
    aud2: { xml: AUD2, up: 'aud3', back: 'dash' },
    aud3: { xml: AUD3(COUNTRIES), up: 'aud4_Su', back: 'dash', tap: [[/^cities$/i, 'aud3c']] },
    aud3c: { xml: AUD3(CITIES), up: 'aud4_Su', back: 'dash' },
    ...dayScreens(CITIES),
    sheet: { xml: SWITCHER_L, back: 'prof' },
    'visit:lucy.backup2': { xml: VISIT_BACKUP, back: 'prof' },
  };
  {
    const F = phone(LUCY, 'prompt');
    const r = await run(F);
    const [me, other] = r.accounts;
    check('LUCY: checked HEALTHY, the Android prompt answered Don’t allow', [r.state, r.status, F.taps[0].labels.includes('Don’t allow')], ['checked', 'HEALTHY', true]);
    check('LUCY: the account', pick(me, ['username', 'posts', 'followers', 'following', 'views_30d', 'account_type']),
      { username: 'urlucybby', posts: 26, followers: 4720, following: 5, views_30d: 905500, account_type: 'professional' });
    const ins = me.insights;
    check('LUCY: dashboard numbers', pick(ins, ['range', 'days', 'new_followers', 'content_shared']), { range: 'Oct 9 - Nov 7', days: 30, new_followers: 4100, content_shared: 40 });
    check('LUCY: Audience - followers, growth, gender, age', pick(ins, ['followers', 'growth_pct', 'under_100', 'gender', 'age']),
      { followers: 4720, growth_pct: 435.1, under_100: false, gender: { women: 2.1, men: 97.9 }, age: { '13-17': 0.1, '18-24': 10.2, '25-34': 24.7, '35-44': 31.4, '45-54': 20.2, '55-64': 9.7, '65+': 3.7 } });
    check('LUCY: countries (default chip), then cities after tapping Cities, USA %', [ins.countries.map((c) => c.name + ' ' + c.pct), ins.cities.map((c) => c.name), ins.us_pct],
      [['United States 53.1', 'United Kingdom 4.9', 'Canada 3.9', 'Mexico 3.3', 'Australia 2.7'], ['New York', 'Los Angeles', 'Chicago', 'Houston', 'London'], 53.1]);
    check('LUCY: active times - every day chip tapped, eight bars each, Sunday as on the phone', [ins.active_times.tz, Object.keys(ins.active_times.days), ins.active_times.days.Su, ins.active_times.days.Sa.length],
      ['EST', ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'], [0.631, 0.465, 0.651, 0.895, 0.997, 1, 0.933, 0.825], 8]);
    check('LUCY: most active windows', ins.active_times.top, [{ day: 'Fri', from: '3 PM', to: '6 PM' }, { day: 'Thu', from: '3 PM', to: '6 PM' }, { day: 'Fri', from: '12 PM', to: '3 PM' }]);
    check('LUCY: nothing missing in the Insights', ins.why, []);
    check('LUCY: the second account, from the sheet, read by visiting its profile', pick(other, ['username', 'active', 'name', 'posts', 'followers', 'following', 'views_30d', 'read', 'insights']),
      { username: 'lucy.backup2', active: false, name: 'Lucy B', posts: 12, followers: 310, following: 40, views_30d: null, read: 'visit', insights: null });
    check('LUCY: one VIEW intent, Back after it, never a tap on the sheet or anything forbidden', [F.opened, F.seen[F.seen.length - 1], badTaps(F)], [['lucy.backup2'], 'prof', []]);
    check('LUCY: the Cities chip tapped once, the seven day chips once each', [F.taps.filter((tp) => tp.labels.includes('Cities')).length,
      ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'].map((d) => F.taps.filter((tp) => tp.labels.includes(d)).length)], [1, [1, 1, 1, 1, 1, 1, 1]]);
    check('LUCY: inside the time the backend allows', F.now() < 240000, true);
  }
  // the second account could not be opened: listed, numbers null, read 'list'
  {
    const def = { ...LUCY };
    delete def['visit:lucy.backup2'];
    const F = phone(def, 'prompt');
    const r = await run(F, { insights: false });
    check('a sheet account that does not open: read "list", numbers null; insights:false = no dashboard tap', [r.accounts[1].read, r.accounts[1].followers, r.accounts[0].insights, F.seen.includes('dash')],
      ['list', null, null, false]);
  }
  // others:false = no sheet
  {
    const F = phone(LUCY, 'prompt');
    const r = await run(F, { insights: false, others: false });
    check('others:false: the title is never tapped', [r.state, r.accounts.length, F.seen.includes('sheet')], ['checked', 1, false]);
  }

  // ===== a restriction notice, the Muse feed, a personal account =====
  {
    const def = {
      restrict: { xml: NOTICE_RESTRICT, tap: [[/^close$/i, 'muse']] },
      muse: { xml: FEED_MUSE, tap: [[/^profile$/i, 'prof']] },
      prof: { xml: PROFILE_P, tap: [[/^mia\.daily_$/, 'sheet']], back: 'muse' },
      sheet: { xml: SWITCHER_P, back: 'prof' },
    };
    const F = phone(def, 'restrict');
    const r = await run(F);
    check('restriction notice: RESTRICTED until Nov 24, closed with its X', [r.state, r.status, r.notices[0].kind, r.notices[0].until, F.taps[0].labels], ['checked', 'RESTRICTED', 'restriction', '2026-11-24', ['Close']]);
    check('personal account: no Insights, account_type personal, 1.2M followers', [r.accounts[0].account_type, r.accounts[0].insights, r.accounts[0].followers], ['personal', null, 1200000]);
    check('the Muse card: neither "Try Muse" nor its X tapped', [badTaps(F), F.taps.filter((tp) => tp.screen === 'muse').map((tp) => tp.labels.join('/'))], [[], ['Profile']]);
    const after = await run(phone(def, 'restrict'), { today: '2026-12-01' });
    check('...and HEALTHY once the restriction has ended', after.status, 'HEALTHY');
  }

  // ===== the ways a profile ends without an account read =====
  {
    const F = phone({ home: { xml: LAUNCHER, launch: 'join' }, join: { xml: JOIN } }, 'home');
    const r = await run(F);
    check('launcher first: Instagram started again, then "Join Instagram" = logged_out / NO_ACCOUNT, nothing tapped', [r.state, r.status, F.launched, F.taps.length, r.accounts], ['logged_out', 'NO_ACCOUNT', 1, 0, []]);
  }
  {
    const r = await run(phone({ s: { xml: LOGIN_FORM } }, 's'));
    const r2 = await run(phone({ s: { xml: LOGIN_SAVED } }, 's'));
    check('login form / saved login: logged_out / LOGIN_REQUIRED (+ remembered), "Log in" never tapped', [r.state, r.status, r.remembered, r2.status, r2.remembered],
      ['logged_out', 'LOGIN_REQUIRED', [], 'LOGIN_REQUIRED', ['urfavekadiee']]);
  }
  {
    // v0.5.16: the two logged-out screens of the 2026-11-10 run that ended "couldn't read"
    const F1 = phone({ s: { xml: LOGIN_PROFILES } }, 's'), F2 = phone({ s: { xml: LOGIN_ONE } }, 's');
    const r1 = await run(F1), r2 = await run(F2);
    check('the profiles chooser: logged_out / LOGIN_REQUIRED with the profiles it offers; nothing tapped - not a row, not "Continue", not "Use another profile"',
      [r1.state, r1.status, r1.remembered, F1.taps.length, r2.state, r2.status, r2.remembered, F2.taps.length],
      ['logged_out', 'LOGIN_REQUIRED', ['val.inbloom1', 'val2hot2handle', 'valnightdrive'], 0, 'logged_out', 'LOGIN_REQUIRED', ['val2best'], 0]);
  }
  {
    // v0.5.16: Instagram WAS up, and the phone keeps ending on the home screen - its own reason, so
    // that "ig_not_in_front" means the launch after the switch and nothing else
    const F = phone({ home: { xml: LAUNCHER, launch: 'home' } }, 'home');
    const r = await run(F);
    check('home screen again and again during the read: unreadable / ig_closed_during_read after two re-launches (not ig_not_in_front)', [r.state, r.why, F.launched], ['unreadable', 'ig_closed_during_read', 2]);
  }
  for (const [xml, status, name] of [[CHALLENGE, 'CHALLENGE_REQUIRED', '"Confirm it\'s you"'], [ACTION_BLOCKED, 'CHECKPOINT', '"Action Blocked"'],
    [SUSPENDED, 'SUSPENDED', '"We suspended your account"'], [DISABLED, 'DISABLED', '"Your account has been disabled"']]) {
    const F = phone({ s: { xml } }, 's');
    const r = await run(F);
    check(`${name}: blocked / ${status}, nothing tapped`, [r.state, r.status, F.taps.length], ['blocked', status, 0]);
  }
  {
    const r = await run(phone({ s: { xml: SUSPENDED } }, 's'));
    check('a block page naming the account: its username', r.username, 'urfavekadiee');
  }

  // ===== in the way, then fine =====
  {
    const def = { ...KADIE, locked: { xml: KEYGUARD, unlock: 'feed' } };
    const F = phone(def, 'locked');
    const r = await run(F, { insights: false, others: false });
    check('a lock screen: unlocked (dismiss-keyguard / menu / swipe), then read', [r.state, F.unlocked, r.username], ['checked', 1, 'urfavekadiee']);
  }
  {
    const def = { ...KADIE, browser: { xml: BROWSER, back: 'feed' } };
    const F = phone(def, 'browser');
    const r = await run(F, { insights: false, others: false });
    check('another app on top: Back, then read', [r.state, F.keys[0].k, F.keys[0].screen], ['checked', 'back', 'browser']);
  }
  {
    const F = phone({ browser: { xml: BROWSER } }, 'browser');
    const r = await run(F);
    check('stuck in another app: unreadable / left_app (with its package) after two Backs', [r.state, r.status, r.why, r.pkg, F.keys.length], ['unreadable', 'UNKNOWN', 'left_app', 'app.vanadium.browser', 2]);
  }
  {
    const def = { ...KADIE, promo: { xml: EDITS_PROMO, back: 'feed' } };
    const F = phone(def, 'promo');
    const r = await run(F, { insights: false, others: false });
    check('the Edits promo: Back (its "Continue" opens the store), then read', [r.state, badTaps(F)], ['checked', []]);
  }
  {
    const F = phone({ s: { xml: NOTIF_PROMPT_IG } }, 's');   // a pop-up that never goes away
    const r = await run(F);
    check('a pop-up that comes back every time: four "Not now", then unreadable / popup_loop', [r.state, r.why, F.taps.length, F.taps.every((tp) => tp.labels.includes('Not now'))], ['unreadable', 'popup_loop', 4, true]);
  }
  {
    const F = phone({ s: { xml: WEIRD, back: 's' } }, 's');
    const r = await run(F);
    check('a screen nobody knows: Back now and then, unreadable / unrecognised_screen after 45 s, nothing tapped', [r.state, r.why, F.taps.length, F.keys.length > 0, F.now() >= 45000 && F.now() < 60000],
      ['unreadable', 'unrecognised_screen', 0, true, true]);
    check('...with that screen in the evidence', r.screens.some((s) => s.at === 'unrecognised' && s.texts.includes('Something new is here')), true);
  }
  {
    const F = phone({ s: { xml: ANR } }, 's');
    const r = await run(F);
    check('"Instagram isn\'t responding": nothing tapped ("Close app" is not ours), unreadable / app_not_responding', [r.state, r.why, F.taps.length], ['unreadable', 'app_not_responding', 0]);
  }
  {
    const noTitle = PROFILE_K.replace('text="urfavekadiee"', 'text=""');
    const F = phone({ feed: { xml: FEED_K, tap: [[/^profile$/i, 'prof']] }, prof: { xml: noTitle } }, 'feed');
    const r = await run(F);
    check('a profile whose title cannot be read: unreadable / header_not_found', [r.state, r.why, r.accounts], ['unreadable', 'header_not_found', []]);
  }
  {
    const noCounts = screen(T('urfavekadiee', 43, 174, 444, 234), T('Edit profile', 32, 924, 532, 1008, B), NAV);
    const F = phone({ feed: { xml: FEED_K, tap: [[/^profile$/i, 'prof']] }, prof: { xml: noCounts } }, 'feed');
    const r = await run(F, { others: false });
    check('a username but no counts: still checked, why counts_not_found, numbers null', [r.state, r.why, r.accounts[0].username, r.accounts[0].followers], ['checked', 'counts_not_found', 'urfavekadiee', null]);
  }

  // ===== Insights can only ever add: a broken or slow Insights never fails the check =====
  {
    const def = { ...KADIE, dash: { xml: DASH_K.replace(/text="Views"/, 'text="Impressions"'), back: 'prof' } };
    const F = phone(def, 'feed');
    const r = await run(F, { others: false });
    check('no Views row on the dashboard: still checked, the dashboard numbers kept, the reason given', [r.state, r.accounts[0].insights.content_shared, r.accounts[0].insights.why, F.seen[F.seen.length - 1]],
      ['checked', 10, ['dashboard Views row not found'], 'prof']);
  }
  {
    const F = phone(LUCY, 'prompt');
    const r = await run(F, { insightsMs: 8000, others: false });
    check('Insights out of time: checked, what was read kept, "time up" in why', [r.state, r.accounts[0].insights.new_followers, r.accounts[0].insights.why.some((w) => /time up/.test(w))], ['checked', 4100, true]);
  }
  {
    const F = phone(KADIE, 'feed');
    const r = await run(F, { budgetMs: 30000 });
    check('little time left in the whole check: Insights skipped with a reason, the account still read', [r.state, r.accounts[0].followers, r.accounts[0].insights.why], ['checked', 85, ['skipped: not enough time left in the check']]);
  }

  // ===== taps that do not take, and other real-phone corners =====
  {
    const def = { ...KADIE, prof: { ...KADIE.prof, swallow: 1 }, dash: { ...KADIE.dash, swallow: 1 } };
    const F = phone(def, 'feed');
    const r = await run(F, { others: false });
    check('a tap swallowed by a tooltip: the dashboard row and the Views row are tapped once more, Insights still read',
      [r.state, r.accounts[0].insights.viewers, r.trace.filter((t) => /\(again\)/.test(t.matched)).length], ['checked', 20198, 2]);
  }
  {
    const sheetWithLogin = win(IG, [0, 1342, 1080, 2400], [T('urlucybby', 222, 1488, 420, 1528), T('Add Instagram account', 222, 1658, 665, 1698),
      T('Log into another account', 222, 1800, 700, 1840), T('Go to Accounts Center', 324, 2128, 757, 2170, B)]);
    check('an accounts sheet that also says "Log into another account" is the sheet, not a login screen', kind(sheetWithLogin), 'switcher');
    const savedLoginAdd = screen(T('urfavekadiee', 380, 1010, 700, 1060), T('Log in', 42, 1120, 1038, 1230, B), T('Add account', 42, 1260, 1038, 1370, B));
    check('...while a login page with "Add account" stays a login page', kind(savedLoginAdd), 'login');
  }
  {
    const neg = OV1.replace('text="--"', 'text="-12"');
    check('net followers can go down ("-12")', ck.parseOverview(P(neg), null).net_followers, -12);
    const minus = OV1.replace('text="--"', 'text="−3"');
    check('...also with the minus sign Instagram prints ("−3")', ck.parseOverview(P(minus), null).net_followers, -3);
  }
  {
    const noButtons = screen(T('mia.daily_', 43, 174, 330, 234), T('14', 316, 418, 360, 458), T('posts', 316, 470, 410, 510), T('1.2M', 526, 418, 620, 458),
      T('followers', 526, 470, 680, 510), T('230', 799, 418, 860, 458), T('following', 799, 470, 953, 510), T('Your story', 40, 600, 200, 640), NAV);
    const own = screen(T('mia.daily_', 43, 174, 330, 234), T('14', 316, 418, 360, 458), T('posts', 316, 470, 410, 510), T('1.2M', 526, 418, 620, 458),
      T('followers', 526, 470, 680, 510), T('230', 799, 418, 860, 458), T('following', 799, 470, 953, 510), T('Share profile', 548, 700, 1048, 784, B), NAV);
    const r1 = await run(phone({ feed: { xml: FEED_K, tap: [[/^profile$/i, 'prof']] }, prof: { xml: own } }, 'feed'), { others: false });
    check('"personal" only with the profile\'s buttons in view (no dashboard row above them)', r1.accounts[0].account_type, 'personal');
    check('a header without its buttons is not taken for the own profile at all', ck.classifyScreen(P(noButtons)).detail.own, false);
  }
  {
    const r = await run(phone({ s: { xml: '' } }, 's'));
    check('uiautomator never gives a screen: unreadable / empty_dump (the phone, not Instagram)', [r.state, r.why], ['unreadable', 'empty_dump']);
  }

  {
    const def = { ...LUCY, aud3: { ...LUCY.aud3, swallow: 1 } };
    const F = phone(def, 'prompt');
    const r = await run(F, { others: false });
    check('the Cities tap swallowed once: tapped again, and the countries are never recorded as cities', [r.accounts[0].insights.cities.map((c) => c.name)[0], r.accounts[0].insights.countries.length,
      F.taps.filter((tp) => tp.labels.includes('Cities')).length], ['New York', 5, 2]);
  }
  {
    const def = { ...LUCY, aud3: { ...LUCY.aud3, tap: [], up: 'aud4k_Su' }, ...dayScreens(COUNTRIES, 'aud4k_') };   // the chip goes nowhere: countries all the way
    const r = await run(phone(def, 'prompt'), { others: false });
    check('a Cities chip that never switches: cities null with the reason, the countries kept', [r.accounts[0].insights.cities, r.accounts[0].insights.countries.length,
      r.accounts[0].insights.why.includes('the Cities chip did not switch the list')], [null, 5, true]);
  }
  {
    const def = { ...LUCY };
    def.aud4_Su = { ...LUCY.aud4_Su, swallow: 0 };
    def.aud4_M = { ...LUCY.aud4_M, swallow: 1 };   // on Monday's screen the next tap (Tuesday) is lost once
    const F = phone(def, 'prompt');
    const r = await run(F, { others: false });
    const d = r.accounts[0].insights.active_times.days;
    check('a day chip whose tap did not take (same bars as the day before): tapped again, Tuesday is Tuesday', [d.Tu[0], d.M[0], r.trace.some((t) => /day chip \(again\)/.test(t.matched))],
      [ck.parseAudience(P(AUD4(CITIES, 'Tu')), null, { day: 'Tu' }).active_times.days.Tu[0], ck.parseAudience(P(AUD4(CITIES, 'M')), null, { day: 'M' }).active_times.days.M[0], true]);
  }
  {
    let nags = 0;   // a prompt that keeps coming back mid-Audience (a new one each time, so the screen keeps "changing")
    const def = { ...LUCY, aud2: { ...LUCY.aud2, up: 'nag' }, nag: { xml: () => NOTIF_PROMPT_IG.replace('Turn on notifications?', `Turn on notifications? (${++nags})`) } };
    const r = await run(phone(def, 'prompt'), { others: false });
    const ins = r.accounts[0].insights;
    check('Insights stopped half-way: still checked, the Overview and the Audience read so far are kept, the reason given',
      [r.state, r.status, ins.viewers, ins.followers, ins.gender, ins.why.includes('stopped: popup_loop')], ['checked', 'HEALTHY', 20198, 4720, { women: 2.1, men: 97.9 }, true]);
  }

  // ===== a person opens the phone =====
  {
    const F = phone(LUCY, 'prompt', { viewerAt: 15000 });
    const r = await run(F);
    const late = [...F.taps, ...F.keys, ...F.swipes].filter((x) => x.t >= 15000);
    check('a viewer opens the phone mid-visit: device_busy / viewer_opened at once', [r.state, r.why, r.aborted], ['device_busy', 'viewer_opened', true]);
    check('...and nothing is tapped, swiped or pressed after that moment', late.length, 0);
  }
  {
    const F = phone(KADIE, 'feed', { viewerAt: 0 });
    const r = await run(F);
    check('a viewer already there: not one tap', [r.state, F.taps.length], ['device_busy', 0]);
  }

  // ---------- 10b. the review of 2026-11-08: words people wrote, and other real-phone corners ----------
  // Instagram resumes where the app was left - for a chatter's profile, a DM thread or the inbox. What
  // fans type there must never read as a block, a notice or a pop-up, and nothing there is tapped.
  {
    const at = (t) => (t ? [t.cx, t.cy] : null);
    // a visit that throws (a regression) shows up as a FAIL line, not as a crash of the whole run
    const safe = async (F, o) => { try { return await run(F, o); } catch (e) { return { state: 'threw: ' + e.message, status: '', username: '', accounts: [], notices: [], trace: [], screens: [] }; } };
    const acc0 = (r) => r.accounts[0] || {};
    const ins0 = (r) => acc0(r).insights || { why: [], active_times: { days: {} } };
    const tap0 = (F) => (F.taps[0] ? F.taps[0].labels : null);
    const COMPOSER = (x) => T(x && x.draft ? x.draft : 'Message...', 40, 2200, 900, 2300, { cls: 'android.widget.EditText', click: true, ...(x && x.id ? { id: x.id } : {}) });
    const CALLS = [D('Audio call', 820, 174, 880, 234, { click: true }), D('Video call', 920, 174, 990, 234, { click: true })];
    const DM = (msg, o) => screen(D('Back', 30, 174, 100, 234, { click: true }), T('fan.account22', 150, 170, 520, 210), T('Active now', 150, 210, 400, 240),
      (o && o.calls === false) ? [] : CALLS, T('hey babe', 600, 900, 1040, 980), C(40, 1090, 910, 1270), T(msg, 40, 1100, 900, 1260),
      (o && o.composer === false) ? [] : COMPOSER(o));
    const FAN_WORDS = ['Hi! Meta support here. Please verify your account at the link or it gets disabled', 'Verify your account here', 'Check your email, I sent you the pics',
      'your account has been disabled lol', 'Your account has been disabled lol jk', 'We suspended your account haha', 'Action blocked again??', 'Confirm it\'s you babe',
      'What happened?', 'We removed your post lol', 'Later', 'Not now', 'Close', 'Cancel', 'my app keeps stopping', 'Join Instagram', 'Log into another account'];
    check('a DM thread: nothing a fan writes reads as a block, a notice, a pop-up or a login - it is a conversation (Back)',
      FAN_WORDS.map((w) => { const c = ck.classifyScreen(P(DM(w))); return `${c.kind}${c.detail.conversation ? '/conversation' : ''}`; }),
      FAN_WORDS.map(() => 'unknown/conversation'));
    check('...also known by its message box alone, or by its call buttons alone (a draft in the box)',
      [kind(DM('Verify your account here', { calls: false })), kind(DM('Verify your account here', { draft: 'hey', id: 'row_thread_composer_edittext' })),
        kind(DM('Verify your account here', { composer: false }))], ['unknown', 'unknown', 'unknown']);
    check('...and never tapped, whatever a finder hands over', [!!ck.tapRefused(P(DM('Later')), 470, 1180), !!ck.tapRefused(P(DM('Later')), 955, 204)], [true, true]);
    check('the old corner: "What happened?" in a thread plus an unlabelled icon top right is not a notice and has no X',
      [kind(screen(D('Back', 30, 174, 100, 234, { click: true }), T('fan.account22', 150, 170, 520, 210), C(920, 174, 990, 234, { cls: 'android.widget.ImageView' }),
        T('What happened?', 40, 1100, 900, 1160), COMPOSER())), ck.noticeCloseTarget(P(screen(T('fan.account22', 150, 170, 520, 210), C(920, 174, 990, 234), T('What happened?', 40, 1100, 900, 1160))))],
      ['unknown', null]);
    {
      const def = { ...KADIE, thread: { xml: DM('Hi! Meta support here. Please verify your account at the link or it gets disabled'), back: 'feed' } };
      const F = phone(def, 'thread');
      const r = await safe(F, { insights: false, others: false });
      check('a visit that starts in a DM thread with a "verify your account" message: Back at once, then read - checked / HEALTHY, nothing tapped in the thread',
        [r.state, r.status, r.username, F.keys[0] && F.keys[0].screen, F.taps.filter((tp) => tp.screen === 'thread').length, badTaps(F)], ['checked', 'HEALTHY', 'urfavekadiee', 'thread', 0, []]);
    }

    // the inbox: the bottom bar is in view, every row is a conversation somebody wrote
    const INBOX = (rows) => screen(T('urfavekadiee', 43, 174, 444, 234), T('Messages', 43, 420, 300, 470),
      rows.map(([who, msg], i) => [C(0, 560 + i * 170, 1080, 720 + i * 170, { id: 'row_inbox_container' }), T(who, 200, 590 + i * 170, 600, 630 + i * 170),
        T(msg, 200, 640 + i * 170, 700, 680 + i * 170)]).flat(), NAV);
    check('the inbox with a "What happened?" preview is the app with its bottom bar, not a notice',
      kind(INBOX([['fan.account22', 'What happened?'], ['other.fan', 'you can\'t be serious haha']])), 'feed');
    const PREVIEWS = ['Later', 'Not now', 'Close', 'Cancel', 'Skip', 'No thanks', 'Dismiss', 'Maybe later'];
    check('an inbox preview that reads like a button ("Later", "Not now", ...) is never a pop-up: tapping it would open the chat',
      PREVIEWS.map((w) => kind(INBOX([['fan.account22', w]]))), PREVIEWS.map(() => 'feed'));
    {
      const def = { inbox: { xml: INBOX([['fan.account22', 'What happened?'], ['other.fan', 'Not now']]), tap: [[/^profile$/i, 'prof']] }, prof: KADIE.prof, feed: KADIE.feed };
      const F = phone(def, 'inbox');
      const r = await safe(F, { insights: false, others: false });
      check('a visit that starts in the inbox: no notice recorded, the only tap is the profile tab', [r.state, r.status, r.notices, F.taps.map((tp) => tp.labels.join('/'))],
        ['checked', 'HEALTHY', [], ['Profile']]);
    }
    check('a story ring whose username is a button word ("later") is not a button (buttons are capitalised)',
      kind(screen(T('Some page', 43, 174, 444, 234), T('later', 340, 566, 560, 600, { click: true }), T('skip', 630, 566, 850, 600, { click: true }), T('More text here', 43, 900, 900, 950))), 'unknown');

    // Instagram's own nags are pop-ups, not blocks
    const TWO_FA = win(IG, [70, 700, 1010, 1700], [T('Help protect your account', 140, 760, 940, 820),
      T('Turn on two-factor authentication so only you can log in.', 140, 840, 940, 960), T('Turn on', 140, 1400, 940, 1500, B), T('Not now', 140, 1540, 940, 1640, B)]);
    const NAG = screen(T('Confirm your account', 43, 300, 700, 360), T('Add a phone number to help keep your account secure.', 43, 400, 1037, 480),
      T('Add phone number', 42, 2000, 1038, 2100, B), T('Skip', 42, 2150, 1038, 2250, B));
    check('the two-factor reminder ("Not now") and a confirm-your-info page with "Skip" are pop-ups, not blocks',
      [[kind(TWO_FA), ck.classifyScreen(P(TWO_FA)).detail.label], [kind(NAG), ck.classifyScreen(P(NAG)).detail.label]], [['popup', 'Not now'], ['popup', 'Skip']]);
    {
      const F = phone({ ...KADIE, nag: { xml: TWO_FA, tap: [[/^not now$/i, 'feed']] } }, 'nag');
      const r = await safe(F, { insights: false, others: false });
      check('...a visit answers it "Not now" and reads the account', [r.state, r.status, tap0(F)], ['checked', 'HEALTHY', ['Not now']]);
    }

    // "We restricted ..." is a restriction notice (recorded, closed, RESTRICTED), never a checkpoint
    for (const head of ['We restricted your account', 'We restricted some of your activity', 'We limited your account']) {
      const xml = NOTICE_RESTRICT.replace('We added a restriction to your account', head);
      check(`"${head}" under "What happened" is a restriction notice`, [kind(xml), ck.parseNotice(P(xml)).kind], ['notice', 'restriction']);
      const F = phone({ ...KADIE, n: { xml, tap: [[/^close$/i, 'feed']] } }, 'n');
      const r = await safe(F, { insights: false, others: false });
      check(`...a whole visit: checked / RESTRICTED until Nov 24, the notice recorded and closed with its X ("${head}")`,
        [r.state, r.status, r.notices.length, r.notices[0] && r.notices[0].title, r.notices[0] && r.notices[0].until, tap0(F), acc0(r).followers],
        ['checked', 'RESTRICTED', 1, head, '2026-11-24', ['Close'], 85]);
    }
    check('a notice\'s kind comes from its title first: a restriction that mentions a removed post stays a restriction',
      ck.parseNotice(P(NOTICE_RESTRICT.replace('You can’t send messages', 'Because we removed your post on Oct 20'))).kind, 'restriction');
    check('a notice reads only its own lines (nothing under its button)',
      ck.parseNotice(P(NOTICE_RESTRICT.replace('</hierarchy>', node({ text: 'zoeyiso: you can\'t catch me', b: [43, 2290, 900, 2330] }) + '</hierarchy>'))).detail,
      'You can\'t send messages · Ends on Nov 24, 2026');

    // "isn't responding" / Edits words that are not Android's dialog or a promo in the way
    const PROFILE_BIO = PROFILE_K.replace('Wanna see a magic trick? :)', 'Not responding to DMs, sorry');
    const FEED_STOPPED = screen(D('New post', 36, 180, 90, 234, { click: true }), T('zoeyiso', 150, 674, 282, 712),
      T('zoeyiso the rain has stopped', 43, 2050, 1000, 2100), T('Wait', 43, 2120, 200, 2160), NAV);
    const FEED_EDITS = screen(D('New post', 36, 180, 90, 234, { click: true }), T('zoeyiso', 150, 674, 282, 712), T('Made with Edits', 150, 712, 420, 750, { click: true }), NAV);
    const IG_PAGE_ANR = screen(T('Instagram isn\'t responding', 140, 950, 940, 1010), T('Close app', 140, 1200, 940, 1280, B), T('Wait', 140, 1300, 940, 1380, B), T('Something else', 140, 1500, 940, 1560));
    check('a bio "Not responding to DMs", a caption "...has stopped" + "Wait", a "Made with Edits" chip: the profile and the feed as they are',
      [kind(PROFILE_BIO), kind(FEED_STOPPED), kind(FEED_EDITS), ck.classifyScreen(P(IG_PAGE_ANR)).detail.why || ''], ['profile', 'feed', 'feed', '']);
    {
      const r1 = await safe(phone({ ...KADIE, prof: { ...KADIE.prof, xml: PROFILE_BIO } }, 'feed'), { insights: false, others: false });
      const F2 = phone({ ...KADIE, edits: { xml: FEED_EDITS, tap: [[/^profile$/i, 'prof']] } }, 'edits');
      const r2 = await safe(F2, { insights: false, others: false });
      check('...whole visits read them (no 45 s of "not responding", no Back out of the feed)', [r1.state, acc0(r1).followers, r2.state, F2.keys.length], ['checked', 85, 'checked', 0]);
    }
    {
      // an Edits sheet drawn inside the app over the feed (the bar still in the dump): its "Continue"
      // covers the profile tab - the tap is refused, Back closes the sheet, then the tab
      const FEED_SHEET = screen(D('New post', 36, 180, 90, 234, { click: true }), T('zoeyiso', 150, 674, 282, 712), NAV,
        C(0, 1500, 1080, 2400, { click: false }), T('Try Edits, an app by Instagram', 60, 1600, 1020, 1700), T('Continue', 42, 2200, 1038, 2340, B));
      const F = phone({ ...KADIE, covered: { xml: FEED_SHEET, back: 'feed', tap: [[/^continue$/i, 'feed']] } }, 'covered');
      const r = await safe(F, { insights: false, others: false });
      check('a sheet over the profile tab: its "Continue" never tapped, Back, then read',
        [kind(FEED_SHEET), r.state, F.keys[0] && F.keys[0].screen, F.taps.filter((tp) => tp.screen === 'covered').length, badTaps(F)], ['feed', 'checked', 'covered', 0, []]);
    }
    {
      const FEED_UPLOAD = screen(D('New post', 36, 180, 90, 234, { click: true }), T('Posting...', 150, 300, 600, 340), T('Cancel', 880, 290, 1040, 350, { click: true }),
        T('zoeyiso', 150, 674, 282, 712), NAV);
      const F = phone({ ...KADIE, up: { xml: FEED_UPLOAD, tap: [[/^profile$/i, 'prof']] } }, 'up');
      const r = await safe(F, { insights: false, others: false });
      check('a post still uploading on the feed: its "Cancel" is never tapped', [kind(FEED_UPLOAD), r.state, F.taps.map((tp) => tp.labels.join('/'))], ['feed', 'checked', ['Profile']]);
    }

    // errors: an adb call that fails inside Insights or on the sheet keeps the account read
    {
      let n = 0;
      const F = phone(LUCY, 'prompt');
      const swipe = F.swipe;
      F.swipe = async (...a) => { if (++n === 2) throw new Error('adb: Command failed: input swipe (timed out after 10000 ms)'); return swipe(...a); };
      const r = await safe(F, { others: false });
      const ins = ins0(r);
      check('an adb swipe that times out in the Overview: still checked, the account and the Overview so far kept, the error in insights.why, back on the profile',
        [r.state, r.status, acc0(r).followers, ins.viewers, ins.why.some((w) => /^stopped: error: adb: Command failed: input swipe/.test(w)), F.seen[F.seen.length - 1]],
        ['checked', 'HEALTHY', 4720, 20198, true, 'prof']);
    }
    {
      const F = phone(LUCY, 'prompt');
      const key = F.key;
      F.key = async (k) => { if (F.seen[F.seen.length - 1] === 'sheet') throw new Error('adb: device offline'); return key(k); };
      const r = await safe(F, { insights: false });
      check('an adb error on the accounts sheet: still checked with the account, the error in the trace',
        [r.state, r.accounts.length, acc0(r).username, r.trace.some((t) => t.name === 'error' && /device offline/.test(t.matched))], ['checked', 1, 'urlucybby', true]);
    }
    {
      const TZ = screen(INSIGHTS_HEAD('a'), T('Follower active times', 43, 932, 464, 976), T('Based on your current time zone', 43, 1002, 604, 1038, { desc: 'Based on your current time zone (EST)' }));
      let tz = null;
      try { tz = ck.parseAudience(P(TZ), null, {}).active_times.tz; } catch (e) { tz = 'THROWS ' + e.message; }
      const swap = (xml) => xml.split('text="Based on your current time zone (EST)" resource-id="" class="android.widget.TextView" package="com.instagram.android" content-desc=""')
        .join('text="Based on your current time zone" resource-id="" class="android.widget.TextView" package="com.instagram.android" content-desc="Based on your current time zone (EST)"');
      const def = Object.fromEntries(Object.entries(LUCY).map(([k, v]) => [k, typeof v.xml === 'string' ? { ...v, xml: swap(v.xml) } : v]));
      const r = await safe(phone(def, 'prompt'), { others: false });
      const atimes = ins0(r).active_times || { days: {} };
      check('the time zone only in the read-out (text says less): read, no crash, and a whole visit still reads everything',
        [tz, r.state, atimes.tz, Object.keys(atimes.days).length], ['EST', 'checked', 'EST', 7]);
    }

    // active-time bars that read something out
    {
      const barsSaid = (descs) => { let i = 0; return AUD4(COUNTRIES, 'Su').replace(/class="android.view.View" package="com.instagram.android" content-desc=""( [^>]*bounds="\[(?:60|181|302|425|546|668|790|912),)/g,
        (m, rest) => `class="android.view.View" package="com.instagram.android" content-desc="${descs[i++]}"${rest}`); };
      const bars = (descs) => { const a = ck.parseAudience(P(barsSaid(descs)), null, { day: 'Su' }); return a.active_times ? a.active_times.days.Su : null; };
      const HEIGHTS = [0.631, 0.465, 0.651, 0.895, 0.997, 1, 0.933, 0.825];
      check('bars read out "12a, 9%": the percentages, never the hour', bars(['12a, 9%', '3a, 7%', '6a, 9%', '9a, 13%', '12p, 15%', '3p, 15%', '6p, 14%', '9p, 12%']),
        [0.6, 0.467, 0.6, 0.867, 1, 1, 0.933, 0.8]);
      check('...also "Sunday 12 AM: 9%"', bars(['Sunday 12 AM: 9%', 'Sunday 3 AM: 7%', 'Sunday 6 AM: 9%', 'Sunday 9 AM: 13%', 'Sunday 12 PM: 15%', 'Sunday 3 PM: 15%', 'Sunday 6 PM: 14%', 'Sunday 9 PM: 12%']),
        [0.6, 0.467, 0.6, 0.867, 1, 1, 0.933, 0.8]);
      check('bars that read out only their slot ("12a" / "12") are measured by height', [bars(['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p']), bars(['12', '3', '6', '9', '12', '3', '6', '9'])],
        [HEIGHTS, HEIGHTS]);
    }

    // the profile tab: never a post's Save / Like just above the bar
    {
      const BAR_ITEMS = [C(43, 2222, 173, 2324), C(259, 2222, 389, 2324), C(475, 2222, 605, 2324), C(691, 2222, 821, 2324), C(907, 2222, 1037, 2324)];
      const FEED_SAVE = screen(D('Like', 30, 2100, 110, 2180, { click: true }), D('Go to profile', 150, 2100, 230, 2180, { click: true }), D('Save', 960, 2100, 1050, 2180, { click: true }),
        C(0, 2212, 1080, 2334, { id: 'tab_bar', click: false }), BAR_ITEMS);
      const NO_BAR = screen(T('caption', 43, 2000, 900, 2050), D('Like', 30, 2200, 110, 2280, { click: true }), D('Save', 960, 2200, 1050, 2280, { click: true }));
      check('profile tab with unnamed bar items: the bar\'s right-most item, never the post\'s Save or "Go to profile"; no bar = nothing',
        [at(ck.profileTab(P(FEED_SAVE))), ck.profileTab(P(NO_BAR))], [[972, 2273], null]);
    }
  }

  // ---------- 10c. v0.5.17: unread DMs and Instagram's own Account status ----------
  let statusedPhone = null;   // the phone of these visits, for the core.js check in section 11
  // THESE SCREENS ARE NOT FROM THE FARM'S PHONES. Nobody has photographed a DM badge or the Account
  // status page on a farm phone yet: they are modelled on Instagram's known layouts (the Messages tab
  // of the 2024+ bottom bar, id direct_tab, with its count badge; the older top-bar Messenger icon, id
  // action_bar_inbox_button; Settings and activity -> More info and support -> Account status, with
  // its rows removed content / what can't be recommended / features you can't use / account at risk),
  // at the 1080x2400 geometry of the screens above. The first real runs' `screens` say what to tune.
  {
    const BADGE = (n, x) => T(n, 572, 2214, 618, 2256, { id: 'notification_badge', ...(x || {}) });   // on the Message tab's top-right corner
    const FEED_DM = (n) => screen(D('New post', 36, 180, 90, 234, { click: true }), STORIES(['avaxreyess', 'nimkguyen', 'tracifoube']),
      T('zoeyiso', 150, 674, 282, 712), NAV, n == null ? [] : [BADGE(n)]);
    const PROFILE_DM = (n) => screen(T('urfavekadiee', 43, 174, 444, 234, { id: 'action_bar_title', click: true }), D('Muse', 708, 174, 774, 234, { click: true }),
      D('New post', 840, 174, 894, 234, { click: true }), D('Options', 970, 174, 1022, 234, { click: true }), PROFILE_BODY_K, NAV, n == null ? [] : [BADGE(n)]);
    // the Message tab read out with its count, no badge node
    const NAV_READOUT = NAV.map((x) => (x.desc === 'Message' ? { ...x, desc: 'Message, 5 unread messages' } : x));
    // an older build: the Messenger icon in the feed's top bar, the badge on it; no Messages tab below
    const FEED_TOPBAR = screen(D('Instagram', 374, 170, 682, 240), D('Activity', 850, 180, 910, 234, { click: true }),
      D('Messenger', 966, 180, 1026, 234, { click: true, id: 'action_bar_inbox_button' }), T('12', 1000, 160, 1046, 202, { id: 'action_bar_inbox_badge' }),
      T('zoeyiso', 150, 674, 282, 712), NAV.filter((x) => x.desc !== 'Message'));
    const dm = (xml) => { const d = ck.parseDmUnread(P(xml)); return d.value; };
    check('unread DMs: the badge on the Messages tab, "9+" as 9, no badge = 0, the read-out "Message, 5 unread messages", the older top-bar Messenger badge',
      [dm(FEED_DM('3')), dm(FEED_DM('9+')), dm(FEED_DM('99+')), dm(FEED_DM(null)), dm(screen(T('zoeyiso', 150, 674, 282, 712), NAV_READOUT)), dm(FEED_TOPBAR), dm(PROFILE_DM('4'))],
      [3, 9, 99, 0, 5, 12, 4]);
    check('unread DMs: nothing to read = null - no Messages icon (a login screen, Insights), a badge that is only a dot, a DM thread',
      [dm(LOGIN_FORM), dm(OV1), dm(screen(NAV, V(585, 2220, 605, 2240, { id: 'tab_badge_dot' }))), ck.parseDmUnread(P(screen(NAV, V(585, 2220, 605, 2240, { id: 'tab_badge_dot' })))).why,
        dm(screen(D('Back', 30, 174, 100, 234, { click: true }), T('fan.account22', 150, 170, 520, 210), D('Audio call', 820, 174, 880, 234, { click: true }),
          T('3', 600, 900, 640, 940), T('Message...', 40, 2200, 900, 2300, { cls: 'android.widget.EditText', click: true })))],
      [null, null, null, 'a badge without a number', null]);
    check('unread DMs: someone else\'s "Message" button and the numbers on a profile are not the badge (only the bars count)',
      [dm(VISIT_BACKUP), dm(PROFILE_K)], [0, 0]);

    // Settings and activity (top, then scrolled to the bottom) and the Account status page
    const ROW = (label, y, x) => [C(0, y, 1080, y + 120, { click: true }), T(label, 150, y + 40, 150 + label.length * 19, y + 80, x)];
    const SETTINGS1 = screen(D('Back', 43, 180, 103, 234, { click: true }), T('Settings and activity', 190, 180, 640, 234),
      T('', 43, 280, 1037, 370, { cls: 'android.widget.EditText', desc: 'Search', click: true }), T('Your account', 43, 420, 280, 460),
      C(0, 480, 1080, 640, { click: true }), T('Accounts Center', 150, 510, 470, 550), T('Password, security, personal details, ad preferences', 150, 560, 960, 600),
      T('How you use Instagram', 43, 690, 470, 730), ROW('Saved', 750), ROW('Archive', 880), ROW('Your activity', 1010), ROW('Notifications', 1140), ROW('Time management', 1270),
      T('Who can see your content', 43, 1420, 520, 1460), ROW('Account privacy', 1480), ROW('Close Friends', 1610), ROW('Blocked', 1740), ROW('Hide story and live', 1870));
    const SETTINGS2 = screen(D('Back', 43, 180, 103, 234, { click: true }), T('Settings and activity', 190, 180, 640, 234),
      T('More info and support', 43, 420, 480, 460), ROW('Help', 480), ROW('Privacy Center', 610), ROW('Account Status', 740), ROW('About', 870),
      T('Login', 43, 1040, 160, 1080), T('Add account', 43, 1110, 280, 1150, { click: true }), T('Log out', 43, 1200, 200, 1240, { click: true }),
      T('Log out of all accounts', 43, 1290, 480, 1330, { click: true }));
    const STATUS_HEAD = [D('Back', 43, 180, 103, 234, { click: true }), T('Account status', 190, 180, 560, 234), D('Profile picture', 440, 300, 640, 500),
      T('urfavekadiee', 380, 520, 700, 560), T('See if your account or content goes against our Community Guidelines or Recommendation Guidelines, and what that means for you.', 43, 600, 1037, 720)];
    // a row: its title, then either a line under it or an icon on its right read out ("No issues" / "Issue")
    const SROW = (title, y, line, icon) => [C(0, y, 1080, y + 170, { click: true }), T(title, 150, y + 30, 900, y + 70),
      ...(line ? [T(line, 150, y + 80, 900, y + 120)] : []), ...(icon ? [D(icon, 960, y + 50, 1020, y + 110)] : [])];
    const STATUS_OK = screen(STATUS_HEAD, SROW('Removed content and messaging issues', 780, '', 'No issues'), SROW('What can\'t be recommended', 960, '', 'No issues'),
      SROW('Features you can\'t use', 1140, '', 'No issues'), SROW('Account at risk of being disabled', 1320, '', 'No issues'),
      T('Learn more about how account status works', 43, 1600, 900, 1640, { click: true }));
    const STATUS_BAD1 = screen(STATUS_HEAD, SROW('Removed content and messaging issues', 780, '1 removed post', 'Issue'),
      SROW('What can\'t be recommended', 960, 'Your account can\'t be recommended to non-followers', ''));
    const STATUS_BAD2 = screen(STATUS_HEAD.slice(0, 2), SROW('What can\'t be recommended', 300, 'Your account can\'t be recommended to non-followers', ''),
      SROW('Features you can\'t use', 480, 'You can\'t go live for now', 'Issue'), SROW('Account at risk of being disabled', 660, 'No issues', ''));
    const sk = (xml) => ck.classifyScreen(P(xml)).kind;
    check('Settings and its Account status page are recognised by their title bars - not as the accounts sheet ("Add account"), a login ("Log out") or a block ("account at risk")',
      [sk(SETTINGS1), sk(SETTINGS2), sk(STATUS_OK), sk(STATUS_BAD1), sk(STATUS_BAD2)], ['settings', 'settings', 'account_status', 'account_status', 'account_status']);
    check('...and the dashboard\'s gear icon "Settings" or a fan named "Account status" in a DM thread is neither',
      [sk(DASH_K), sk(screen(D('Back', 30, 174, 100, 234, { click: true }), T('Account status', 150, 170, 520, 210), D('Audio call', 820, 174, 880, 234, { click: true }),
        T('hey', 600, 900, 900, 940), T('Message...', 40, 2200, 900, 2300, { cls: 'android.widget.EditText', click: true })))],
      ['dashboard', 'unknown']);
    const ps = (xml, prev) => ck.parseAccountStatus(P(xml), prev);
    const okSt = ps(STATUS_OK);
    check('Account status, nothing wrong: no_issues, every row seen, no items', [okSt.state, okSt.items, okSt.seen],
      ['no_issues', [], ['removed_content', 'not_recommended', 'features_limited', 'at_risk']]);
    const bad = ps(STATUS_BAD2, ps(STATUS_BAD1));
    check('Account status with issues, over two scrolled screens: removed content, not recommended, a feature limit - the row at risk is fine',
      [bad.state, bad.items, bad.seen.length],
      ['issues', [{ kind: 'removed_content', title: 'Removed content and messaging issues', detail: '1 removed post' },
        { kind: 'not_recommended', title: 'What can\'t be recommended', detail: 'Your account can\'t be recommended to non-followers' },
        { kind: 'features_limited', title: 'Features you can\'t use', detail: 'You can\'t go live for now' }], 4]);
    check('Account status: a page whose rows are not recognised is "unknown", never a guess', ps(screen(STATUS_HEAD, T('Something else entirely', 150, 800, 900, 840))).state, 'unknown');

    // the tap rules of the step
    const at2 = (xml, re, allow) => { const ns = P(xml); const n = ns.find((x) => re.test(x.text) || re.test(x.desc)); return ck.tapRefused(ns, n.cx, n.cy, allow); };
    check('taps: the profile\'s "Options" only with the step\'s allow-list; an allow-list never opens anything outside STATUS_TAPS ("Edit profile", "Log out")',
      [at2(PROFILE_K, /^Options$/, null) !== '', at2(PROFILE_K, /^Options$/, /^(options|menu|settings and activity)$/i), at2(PROFILE_K, /^Edit profile$/, /.*/) !== '',
        at2(SETTINGS2, /^Log out$/, /.*/) !== ''],
      [true, '', true, true]);
    check('taps: on Settings only the "Account status" row, and only with the allow-list; on the Account status page nothing at all, whatever is allowed',
      [at2(SETTINGS2, /^Account Status$/, /^account status$/i), at2(SETTINGS2, /^Account Status$/, null) !== '', at2(SETTINGS1, /^Saved$/, /^account status$/i) !== '',
        ...[/^Removed content/, /^No issues$/, /^Learn more/, /^Back$/].map((re) => at2(STATUS_OK, re, /.*/))],
      ['', true, true, 'the Account status page is only read (Back leaves it)', 'the Account status page is only read (Back leaves it)',
        'the Account status page is only read (Back leaves it)', 'the Account status page is only read (Back leaves it)']);

    // whole visits
    const STATUSED = (statusXml, more) => ({
      ...KADIE,
      feed: { xml: FEED_DM('3'), tap: [[/^profile$/i, 'prof']] },
      prof: { xml: PROFILE_DM('4'), tap: [[/^your dashboard$/i, 'dash'], [/^urfavekadiee$/, 'sheet'], [/^options$/i, 'set1']], back: 'feed' },
      set1: { xml: SETTINGS1, up: 'set2', back: 'prof' },
      set2: { xml: SETTINGS2, up: 'set2', back: 'prof', tap: [[/^account status$/i, 'stat']] },
      stat: { xml: statusXml, up: more ? 'stat2' : 'stat', back: 'set2' },
      ...(more ? { stat2: { xml: more, up: 'stat2', back: 'set2' } } : {}),
    });
    statusedPhone = () => phone(STATUSED(STATUS_OK), 'feed');
    {
      const F = phone(STATUSED(STATUS_OK), 'feed');
      const r = await run(F);
      check('visit, default (no status_page): unread DMs read off the feed and the profile (the higher, 4), Account status not opened, Options never tapped',
        [r.state, r.dm_unread, r.account_status, F.seen.includes('set1'), F.taps.some((tp) => tp.labels.includes('Options'))], ['checked', 4, null, false, false]);
    }
    {
      const F = phone(STATUSED(STATUS_OK), 'feed');
      const r = await run(F, { status_page: true });
      check('visit with status_page: menu -> Settings (scrolled) -> Account status read -> Back, Back; Insights and the sheet still read',
        [r.state, r.status, r.account_status, r.accounts[0].insights.viewers, F.seen.includes('sheet'), F.seen[F.seen.length - 1]],
        ['checked', 'HEALTHY', { state: 'no_issues', items: [], seen: ['removed_content', 'not_recommended', 'features_limited', 'at_risk'], why: '' }, 20198, true, 'prof']);
      check('visit with status_page: the only new taps are "Options" and "Account Status"; nothing at all on the status page; no forbidden tap',
        // (a tap on a row lands in the row's middle, beside its words: the row "Account Status" is the one at y 740-860)
        [F.taps.filter((tp) => ['set1', 'set2', 'stat'].includes(tp.screen) || tp.labels.includes('Options'))
          .map((tp) => `${tp.screen}: ${tp.labels.join('/') || (tp.screen === 'set2' && tp.y > 740 && tp.y < 860 ? 'Account Status' : '?')}`),
          F.taps.filter((tp) => tp.screen === 'stat').length, F.keys.filter((k) => k.screen === 'stat').map((k) => k.k), badTaps(F)],
        [['prof: Options', 'set2: Account Status'], 0, ['back'], []]);
      check('visit with status_page: the trace says what Instagram said, the screens keep the page (username masked)',
        [r.trace.some((t) => t.name === 'status' && /no_issues/.test(t.matched)), r.screens.some((s) => s.at === 'account_status'),
          JSON.stringify(r.screens).includes('urfavekadiee')], [true, true, false]);
    }
    {
      const F = phone(STATUSED(STATUS_BAD1, STATUS_BAD2), 'feed');
      const r = await run(F, { status_page: true, insights: false, others: false });
      check('visit with status_page, issues over two screens: state issues, three items, the page scrolled and never tapped',
        [r.account_status.state, r.account_status.items.map((x) => x.kind), F.taps.filter((tp) => /^stat/.test(tp.screen)).length, r.status],
        ['issues', ['removed_content', 'not_recommended', 'features_limited'], 0, 'HEALTHY']);
    }
    {
      // Settings that never shows "Account status": the step gives up, says why, and the check stands
      const def = STATUSED(STATUS_OK);
      def.set2 = { ...def.set2, xml: SETTINGS1, tap: [] };
      def.set1 = { ...def.set1, up: 'set1' };
      const F = phone(def, 'feed');
      const r = await run(F, { status_page: true, insights: false, others: false });
      check('visit with status_page, no "Account status" row: unknown + why, still checked, back on the profile, nothing on Settings tapped',
        [r.state, r.account_status.state, r.account_status.why, F.seen[F.seen.length - 1], F.taps.filter((tp) => /^set/.test(tp.screen)).length],
        ['checked', 'unknown', '"Account status" not found in Settings', 'prof', 0]);
    }
    {
      // a logged-out profile: no DM count, no Account status (nothing tapped)
      const F = phone({ s: { xml: LOGIN_FORM } }, 's');
      const r = await run(F, { status_page: true });
      check('logged out with status_page: dm_unread null, account_status null, nothing tapped', [r.state, r.dm_unread, r.account_status, F.taps.length], ['logged_out', null, null, 0]);
    }
    {
      // Instagram resumed on the Account status page (a previous run stopped there): Back out, then read
      const def = { ...STATUSED(STATUS_OK), stat: { xml: STATUS_OK, back: 'feed' } };
      const F = phone(def, 'stat');
      const r = await run(F, { insights: false, others: false });
      check('a visit that starts on the Account status page: Back (no tap there), then read', [r.state, F.keys[0] && F.keys[0].screen, F.taps.filter((tp) => tp.screen === 'stat').length],
        ['checked', 'stat', 0]);
    }
  }

  // ---------- 11. core.js: the real igCheck op, with a scripted adb ----------
  // The adb lines igCheck sends are answered from a small model of the phone (users, current user,
  // what is resumed) and the same fake screens: `uiautomator dump` + `cat` show the current screen,
  // `input tap / swipe / keyevent` move it. Timers are instant.
  {
    const { AgentCore } = require('../src/core');
    const REAL = global.setTimeout;
    global.setTimeout = (fn) => { fn(); return 0; };
    const makeCore = (F, o) => {
      const s = Object.assign({ user: '0', viewer: false, users: [0, 12], app: true, inFront: true }, o || {});
      const calls = [], replies = [];
      let launched = false;
      const core = Object.create(AgentCore.prototype);
      core.devices = {}; core.appVersion = ''; core.logs = [];
      core.emit = (ev, msg) => { if (ev === 'log') core.logs.push(String(msg)); };
      core._sendMeta = () => {};
      core._adbBinary = async () => Buffer.from('PNG');
      // v0.5.16: who is watching is no longer read from `ps -A` (it never saw anyone - see
      // _scrcpyRunning) but from the live streams the agent itself relays for people. `s.viewer`
      // puts one open stream on whichever phone is asked about; every ask is recorded as "viewer?",
      // and `s.viewerAfterAsks = n` makes someone open the phone at ask n+1.
      let asks = 0;
      core._personStreams = new Proxy({}, { get: (_t, serial) => {
        if (typeof serial !== 'string') return undefined;
        calls.push('viewer?');
        if (s.viewerAfterAsks != null && ++asks > s.viewerAfterAsks) s.viewer = true;
        return s.viewer ? new Set([{ readyState: 1 }]) : undefined;
      } });
      core._adbLong = async (serial, args) => {
        const cmd = args.join(' ');
        calls.push(cmd);
        let mm;
        if (/pm list users/.test(cmd)) return 'Users:\n' + s.users.map((u) => `\tUserInfo{${u}:Profile ${u}:410} running`).join('\n');
        if (/pm list packages --user \d+ com\.instagram\.android/.test(cmd)) return s.app ? 'package:com.instagram.android' : '';
        if (/am get-current-user/.test(cmd)) return s.user;
        if ((mm = /am switch-user (\d+)/.exec(cmd))) { s.user = mm[1]; launched = false; return ''; }
        if (/dumpsys activity activities/.test(cmd)) {
          const top = launched && s.inFront ? 'com.instagram.android/com.instagram.mainactivity.InstagramMainActivity' : 'com.android.launcher3/.uioverrides.QuickstepLauncher';
          // `screenUser`: the switch was accepted (am get-current-user says N) but ANOTHER profile is still on the screen
          return `  topResumedActivity=ActivityRecord{1f u${s.screenUser != null ? s.screenUser : s.user} ${top} t7}\n  mKeyguardShowing=false`;
        }
        // v0.5.16: a profile still LOCKED for its first `lockedPolls` state polls resolves no launcher
        // `notStarted`: a profile that is not running and that nobody is starting (open app aimed at it)
        // `states` = what a real cold start reports, in order (BOOTING, RUNNING_LOCKED, RUNNING_UNLOCKING); `stateUnknown` = adb gave nothing
        const stillLocked = () => s.lockedPolls > 0 || s.notStarted || s.resolveMisses > 0 || s.lockedForever || (s.states || []).some((x) => x === 'BOOTING' || x === 'RUNNING_LOCKED');
        // a failed start as real adb reports it: a rejection that carries Android's words (on stdout with -W, on stderr without)
        const failStart = (words, wait) => { if (!s.rejects) return words; const e = new Error(wait ? 'Command failed: C:\\adb\\adb.exe -s SER ' + cmd : words); e.stdout = wait ? words : ''; e.stderr = wait ? '' : words; throw e; };
        if (/am get-started-user-state/.test(cmd)) { if (s.stateUnknown) return ''; if (s.notStarted) return 'User is not started: 12'; if (s.states && s.states.length) return s.states.shift(); if (s.lockedForever) return 'RUNNING_LOCKED'; if (s.lockedPolls > 0) { s.lockedPolls--; return 'RUNNING_LOCKED'; } return 'RUNNING_UNLOCKED'; }
        if (/dumpsys user/.test(cmd) && s.dumpsysStates) { const st = s.dumpsysStates.length > 1 ? s.dumpsysStates.shift() : s.dumpsysStates[0]; if (st === 'RUNNING_UNLOCKED') s.lockedForever = false; return 'Current user: 12\n\nUsers:\n  UserInfo{0:Owner:c13} serialNo=0 isPrimary=true\n    Type: android.os.usertype.full.SYSTEM\n    State: RUNNING_UNLOCKED\n    Created: <unknown>\n  UserInfo{11:Profile 2:410} serialNo=13 isPrimary=false\n    State: -1\n  UserInfo{12:Profile 3:410} serialNo=14 isPrimary=false\n    Type: android.os.usertype.full.SECONDARY\n    State: ' + st + '\n    Created: +2d1h ago\n\nDevice properties:\n  Started users state: [0=RUNNING_UNLOCKED, 12=' + st + ']\n'; }
        if (/resolve-activity/.test(cmd)) { if (s.resolveMisses > 0) { s.resolveMisses--; s.missed = true; return 'No activity found'; } s.missed = false; return stillLocked() ? 'No activity found' : 'priority=0 preferredOrder=0\ncom.instagram.android/com.instagram.mainactivity.LauncherActivity'; }
        if (/am start --user \d+ -a android\.intent\.action\.MAIN/.test(cmd)) return failStart('Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.instagram.android }', false);
        if (/am start --user \d+ -n/.test(cmd)) { launched = true; return 'Starting: Intent { cmp=com.instagram.android/.mainactivity.LauncherActivity }'; }
        if (/am start -W --user \d+ -a android\.intent\.action\.MAIN/.test(cmd)) { if (stillLocked() || s.missed) return failStart('Error: Activity not started, unable to resolve Intent', true); launched = true; return 'Status: ok\nComplete'; }
        if (/am start -W --user \d+ -n/.test(cmd)) { if (s.amStartDead) return 'Status: ok\nComplete'; launched = true; return 'Starting: Intent { cmp=com.instagram.android/... }\nStatus: ok\nLaunchState: COLD\nTotalTime: 1180\nComplete'; }
        if (/uiautomator dump/.test(cmd)) return 'UI hierchary dumped to: /sdcard/pd_check.xml';
        if (/cat \/sdcard\/pd_(check|ui)\.xml/.test(cmd)) return launched && s.inFront ? F.dump() : (s.amStartDead ? LAUNCHER_IG : LAUNCHER);
        if (s.amStartDead && !launched && (mm = /input tap (\d+) (\d+)/.exec(cmd))) { if (Math.abs(+mm[1] - 151) < 60 && Math.abs(+mm[2] - 1150) < 80) launched = true; return ''; }
        if ((mm = /input tap (\d+) (\d+)/.exec(cmd))) { await F.tap(+mm[1], +mm[2]); return ''; }
        if ((mm = /input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmd))) { await F.swipe(+mm[1], +mm[2], +mm[3], +mm[4]); return ''; }
        if ((mm = /input keyevent (\w+)/.exec(cmd))) { if (mm[1] === '4') await F.key('back'); return ''; }
        // what a farm phone really lists, viewer or not: ws-scrcpy's server runs always, named app_process
        if (/ps -A/.test(cmd)) return 'USER PID PPID VSZ RSS WCHAN ADDR S NAME\nroot 1 0 1 1 0 0 S init\nshell 4242 1 1 1 0 0 S app_process';
        if (/date \+%F/.test(cmd)) return '2026-11-08';
        if (/wm size/.test(cmd)) return 'Physical size: 1080x2400';
        return '';
      };
      const ws = { readyState: 1, send: (txt) => { calls.push('<<REPLY>>'); replies.push(JSON.parse(txt)); } };
      return { core, calls, replies, ws, s };
    };
    const KEYS = ['ok', 'state', 'status', 'uid', 'seconds', 'agent_version', 'username', 'accounts', 'notices', 'remembered', 'why', 'screens', 'trace'];
    try {
      {
        const F = phone(KADIE, 'feed');
        const { core, calls, replies, ws } = makeCore(F);
        await core.igCheck('SER1', { op: 'ig_check', request_id: 'r1', uid: 12, shot: false, others: true, insights: true }, ws);
        const r = replies[0];
        check('core: the reply carries every key the backend relies on', KEYS.filter((k) => !(k in r)), []);
        check('core: profile 12 read through the real op', [r.op, r.request_id, r.ok, r.state, r.status, r.uid, r.username, r.agent_version, r.accounts[0].followers, r.accounts[0].insights.viewers],
          ['rpc_result', 'r1', true, 'checked', 'HEALTHY', 12, 'urfavekadiee', require('../package.json').version, 85, 20198]);
        const iSwitch = calls.indexOf('shell am switch-user 12'), iBack = calls.lastIndexOf('shell am switch-user 0'), iReply = calls.indexOf('<<REPLY>>');
        check('core: switched to 12, settled, launched with am start -W, then HOME + switched back to 0 - all BEFORE the reply',
          [iSwitch >= 0, calls.some((c) => /am start -W --user 12 -n com\.instagram\.android/.test(c)), iBack > iSwitch, iBack < iReply, calls.slice(0, iReply).includes('shell input keyevent KEYCODE_HOME'), replies.length],
          [true, true, true, true, true, 1]);
        check('core: "is someone watching?" was asked before taps and after waits - from the agent\'s own streams, with no adb call',
          [calls.filter((c) => c === 'viewer?').length > 10, calls.filter((c) => /ps -A/.test(c)).length], [true, 0]);
        check('core: every step logged', ['settle: u12 com.android.launcher3', 'Instagram in front', '-> checked / HEALTHY @urfavekadiee, 85 followers', 'restored profile 0']
          .map((x) => core.logs.some((l) => l.includes(x))), [true, true, true, true]);
        check('core: the job lock is released', core._posting.has('SER1'), false);
      }
      {
        // v0.5.17: the op's status_page reaches the visit (default off); dm_unread / account_status are in every reply
        const a = makeCore(statusedPhone()), b = makeCore(statusedPhone());
        await a.core.igCheck('SER1', { op: 'ig_check', request_id: 'd1', uid: 12, insights: false, others: false }, a.ws);
        await b.core.igCheck('SER1', { op: 'ig_check', request_id: 'd2', uid: 12, insights: false, others: false, status_page: true }, b.ws);
        const ra = a.replies[0], rb = b.replies[0];
        check('core: dm_unread read through the real op (4, the badge on the profile); account_status null unless the op says status_page: true',
          [ra.state, ra.dm_unread, ra.account_status, 'account_status' in ra, rb.state, rb.dm_unread, rb.account_status && rb.account_status.state, rb.account_status && rb.account_status.why],
          ['checked', 4, null, true, 'checked', 4, 'no_issues', '']);
        check('core: the trace and the log say it', [rb.trace.some((t) => t.name === 'status'), b.core.logs.some((l) => /4 unread DM\(s\), Account status no_issues/.test(l))], [true, true]);
        const busy = makeCore(phone(KADIE, 'feed'), { viewer: true });
        await busy.core.igCheck('SER2', { request_id: 'd3', uid: 12, status_page: true }, busy.ws);
        check('core: an early reply (device_busy) still carries dm_unread / account_status as null', [busy.replies[0].dm_unread, busy.replies[0].account_status], [null, null]);
      }
      {
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { viewer: true });
        await core.igCheck('SER2', { request_id: 'r2', uid: 12 }, ws);
        check('core: someone already watching -> device_busy, and the phone is not touched at all', [replies[0].ok, replies[0].state, calls.filter((c) => /input|switch-user|am start/.test(c))],
          [false, 'device_busy', []]);
      }
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'), { users: [0] });
        await core.igCheck('SER3', { request_id: 'r3', uid: 12 }, ws);
        check('core: a profile that is gone -> profile_not_found (ok false)', [replies[0].ok, replies[0].state, replies[0].why], [false, 'profile_not_found', 'profile is gone from the phone']);
      }
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'), { app: false });
        await core.igCheck('SER4', { request_id: 'r4', uid: 12 }, ws);
        check('core: no Instagram in the profile -> no_app / APP_ERROR (ok true)', [replies[0].ok, replies[0].state, replies[0].status], [true, 'no_app', 'APP_ERROR']);
      }
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'));
        await core.igCheck('SER5', { request_id: 'r5' }, ws);
        check('core: no uid -> bad_request', [replies[0].ok, replies[0].state], [false, 'bad_request']);
      }
      {
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { inFront: false });
        await core.igCheck('SER6', { request_id: 'r6', uid: 12, shot: true }, ws);
        check('core: Instagram never comes to the front -> unreadable / ig_not_in_front after 3 launches, with the screen and a screenshot',
          [replies[0].ok, replies[0].state, replies[0].why, calls.filter((c) => /am start -W --user 12 -n/.test(c)).length, replies[0].screens[0].pkg, !!replies[0].screenshot_b64],
          [true, 'unreadable', 'ig_not_in_front', 3, 'com.android.launcher3', true]);
      }
      {
        // v0.5.16 - the 2026-11-10 failure: the profile is still locked right after the switch, so
        // Instagram has no launcher yet. The check waits for the unlock, then launches and reads.
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 4 });
        await core.igCheck('SER12', { request_id: 'r12', uid: 12 }, ws);
        check('core: a profile still locked after the switch: waits for the unlock, then launches by component and reads it',
          [replies[0].state, replies[0].status, calls.filter((c) => /get-started-user-state 12/.test(c)).length >= 5,
            calls.filter((c) => /am start -W --user 12 -n/.test(c)).length, core.logs.some((l) => /profile 12: RUNNING_UNLOCKED after/.test(l))],
          ['checked', 'HEALTHY', true, 1, true]);
        check('core: nothing calls monkey any more (it has no --user option)', calls.filter((c) => /monkey/.test(c)), []);
      }
      {
        // A profile that never unlocks (someone set a PIN on it): the wait is bounded - one look a
        // second for 30 s, here 30 looks - then the three tries, and the result says where it stopped.
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 1e9 });
        await core.igCheck('SER14', { request_id: 'r14', uid: 12 }, ws);
        check('core: a profile that never unlocks: 30 looks at its state, 3 tries by MAIN/LAUNCHER intent (no launcher resolves), then unreadable / ig_not_in_front',
          [replies[0].state, replies[0].why, calls.filter((c) => /get-started-user-state 12/.test(c)).length,
            calls.filter((c) => /am start -W --user 12 -a android\.intent\.action\.MAIN -c android\.intent\.category\.LAUNCHER -p com\.instagram\.android/.test(c)).length,
            calls.filter((c) => /am start -W --user 12 -n/.test(c)).length, core.logs.some((l) => /profile 12: RUNNING_LOCKED after/.test(l))],
          ['unreadable', 'ig_not_in_front', 30, 3, 0, true]);
      }
      {
        // "Open app" (the website's button, MCP open_app, warm-up browsing) goes through the same wait.
        // On the profile the phone is on: one look, then the launch. Aimed at a profile that is not
        // running and that nobody is starting: three more looks, never the whole 15 s.
        const a = makeCore(phone(KADIE, 'feed'));
        await a.core.launchApp('SER15', { request_id: 'r15', uid: 12, package: 'com.instagram.android' }, a.ws);
        const b = makeCore(phone(KADIE, 'feed'), { notStarted: true });
        await b.core.launchApp('SER16', { request_id: 'r16', uid: 12, package: 'com.instagram.android' }, b.ws);
        const c = makeCore(phone(KADIE, 'feed'), { lockedPolls: 3 });
        await c.core.launchApp('SER17', { request_id: 'r17', uid: 12, package: 'com.instagram.android' }, c.ws);
        const looks = (x) => x.calls.filter((k) => /get-started-user-state 12/.test(k)).length;
        check('core: open app - unlocked profile: 1 look, opened by component; not-running profile: 4 looks, launch_failed with Android\'s words; unlocking profile: waited for, then opened',
          [a.replies[0].ok, a.replies[0].state, looks(a), a.calls.some((k) => /am start --user 12 -n com\.instagram\.android/.test(k)),
            b.replies[0].ok, b.replies[0].state, looks(b), /unable to resolve Intent/.test(b.replies[0].error || ''),
            c.replies[0].ok, c.replies[0].state, looks(c)],
          [true, 'opened', 1, true, false, 'launch_failed', 4, true, true, 'opened', 4]);
      }
      {
        // am start "works" but Instagram never shows: the third try taps the icon on the home screen
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { amStartDead: true });
        await core.igCheck('SER13', { request_id: 'r13', uid: 12 }, ws);
        check('core: am start that never brings Instagram up: 2 am starts, then the Instagram icon is tapped and the profile read',
          [replies[0].state, calls.filter((c) => /am start -W --user 12 -n/.test(c)).length, calls.some((c) => /input tap 151 1150/.test(c)), core.logs.some((l) => /launch 3\/3 \(icon at 151,1150\)/.test(l))],
          ['checked', 2, true, true]);
      }

      // ---- v0.5.16: checks written by the independent review of 2026-11-10 (mutation-tested) ----
      {
        // R1: a real cold start reports BOOTING first, then RUNNING_LOCKED, then RUNNING_UNLOCKING
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { states: ['BOOTING', 'BOOTING', 'RUNNING_LOCKED', 'RUNNING_UNLOCKING'] });
        await core.igCheck('R1', { request_id: 'R1', uid: 12 }, ws);
        check('core: cold start BOOTING -> RUNNING_LOCKED -> RUNNING_UNLOCKING -> unlocked: waited through all of them, one launch by component, read',
          [replies[0].state, calls.filter((c) => /get-started-user-state 12/.test(c)).length, calls.filter((c) => /am start -W --user 12 -n/.test(c)).length,
            calls.filter((c) => /am start -W --user 12 -a/.test(c)).length], ['checked', 5, 1, 0]);
      }
      {
        // R2: the phone cannot say the state (adb gave nothing) - no wait; the launcher is missing on try 1 and there on try 2
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { stateUnknown: true, resolveMisses: 1 });
        await core.igCheck('R2', { request_id: 'R2', uid: 12 }, ws);
        check('core: state unknown + no launcher on try 1: no wait (1 look), try 1 by MAIN/LAUNCHER intent fails, try 2 resolves FRESH and launches by component',
          [replies[0].state, calls.filter((c) => /get-started-user-state 12/.test(c)).length, calls.filter((c) => /am start -W --user 12 -a android\.intent\.action\.MAIN/.test(c)).length,
            calls.filter((c) => /am start -W --user 12 -n/.test(c)).length], ['checked', 1, 1, 1]);
      }
      {
        // open app on a profile that never unlocks: the wait is 10 looks (10 s) - the website gives launch_app 20 s
        const x = makeCore(phone(KADIE, 'feed'), { lockedPolls: 1e9 });
        await x.core.launchApp('R3', { request_id: 'R3', uid: 12, package: 'com.instagram.android' }, x.ws);
        check('core: open app, profile never unlocks: exactly 10 looks, then launch_failed', [x.replies[0].ok, x.replies[0].state, x.calls.filter((k) => /get-started-user-state 12/.test(k)).length], [false, 'launch_failed', 10]);
      }
      {
        // R4: someone opens the phone while the third try reads the home screen: no tap on their screen
        const env = makeCore(phone(KADIE, 'feed'), { amStartDead: true });
        const realAdb = env.core._adbLong;
        let homes = 0;
        env.core._adbLong = async (serial, args, ms) => {
          const cmd = args.join(' ');
          if (/input keyevent 3$/.test(cmd)) homes++;
          const r = await realAdb(serial, args, ms);
          if (homes === 2 && /cat \/sdcard\/pd_check\.xml/.test(cmd)) env.s.viewer = true;   // the dump try 3 reads for the icon
          return r;
        };
        await env.core.igCheck('R4', { request_id: 'R4', uid: 12 }, env.ws);
        check('core: a viewer who opens the phone while try 3 looks for the icon gets no tap; device_busy / viewer_opened',
          [env.replies[0].ok, env.replies[0].state, env.replies[0].why, env.calls.filter((c) => /input tap/.test(c))], [false, 'device_busy', 'viewer_opened', []]);
      }
      {
        // R5: real adb REJECTS when am start exits 1 (stdout dropped with -W; stderr without) - the three tries must survive that
        const a = makeCore(phone(KADIE, 'feed'), { lockedPolls: 1e9, rejects: true });
        await a.core.igCheck('R5', { request_id: 'R5', uid: 12 }, a.ws);
        const b = makeCore(phone(KADIE, 'feed'), { notStarted: true, rejects: true });
        await b.core.launchApp('R5b', { request_id: 'R5b', uid: 12, package: 'com.instagram.android' }, b.ws);
        check('core: am start that fails the way real adb fails (a rejection): still 3 tries and unreadable / ig_not_in_front; open app says launch_failed with Android\'s words',
          [a.replies[0].ok, a.replies[0].state, a.replies[0].why, a.calls.filter((c) => /am start -W --user 12 -a/.test(c)).length, b.replies[0].state, /unable to resolve Intent/.test(b.replies[0].error || '')],
          [true, 'unreadable', 'ig_not_in_front', 3, 'launch_failed', true]);
        if (process.env.IGCHECK_TRACE) console.log(a.core.logs.filter((l) => /launch \d/.test(l)).map((l) => '      ' + l).join('\n'));
      }
      {
        // R6: am get-started-user-state gives nothing, dumpsys user (real layout, "State: -1" for stopped users) says locked twice, then unlocked
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { stateUnknown: true, lockedForever: true, dumpsysStates: ['RUNNING_LOCKED', 'RUNNING_LOCKED', 'RUNNING_UNLOCKED'] });
        await core.igCheck('R6', { request_id: 'R6', uid: 12 }, ws);
        check('core: state read from dumpsys user when am cannot say: waited (3 dumpsys looks), then one launch by component',
          [replies[0].state, calls.filter((c) => /dumpsys user/.test(c)).length, calls.filter((c) => /am start -W --user 12 -n/.test(c)).length], ['checked', 3, 1]);
      }
      
      // ---- v0.5.16: the other ops the change touched (same review) ----
      {
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 3 });
        await core.igWhoami('R7', { request_id: 'R7', uid: 12 }, ws);
        const iStart = calls.findIndex((c) => /am start --user 12 -n com\.instagram\.android/.test(c));
        check('core: ig_whoami after a switch to a profile still locked: waits (4 looks), THEN starts Instagram for user 12 by component, finds the username, puts the phone back',
          [replies[0].ok, replies[0].state, replies[0].username, calls.filter((c) => /get-started-user-state 12/.test(c)).length, iStart > calls.lastIndexOf('shell am get-started-user-state 12'),
            calls.includes('shell am switch-user 0'), calls.filter((c) => /monkey|--user 0 /.test(c))], [true, 'found', 'urfavekadiee', 4, true, true, []]);
      }
      {
        // on a virtual clock: igpost.run's 12 s step limit reads Date.now(), which never moves with instant timers (17 s of spinning otherwise)
        const { core, calls, replies, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 2 });
        const realNow = Date.now, instant = global.setTimeout; let clock = 1e9;
        Date.now = () => clock; global.setTimeout = (fn, ms) => { clock += ms || 0; fn(); return 0; };
        try { await core.igPost('R8', { request_id: 'R8', uid: 12, mode: 'capture', fresh_ip: false, evidence: false }, ws); } finally { Date.now = realNow; global.setTimeout = instant; }
        check('core: ig_post (test run, no clip): reaches the launch - waits for the unlock (3 looks), starts Instagram for user 12 by component, no exception',
          [replies[0].why === 'exception', /not a function|TypeError|undefined/.test(String(replies[0].error || '')), calls.filter((c) => /get-started-user-state 12/.test(c)).length,
            calls.some((c) => /am start --user 12 -n com\.instagram\.android/.test(c))], [false, false, 3, true]);
      }
      {
        const a = makeCore(phone(KADIE, 'feed'));
        await a.core.checkAccountStatus('R9', { request_id: 'R9', uid: 12 }, a.ws);
        const b = makeCore(phone(KADIE, 'feed'));
        await b.core.igDiagnostic('R10', { request_id: 'R10', uid: 12 }, b.ws);
        check('core: the old status check and the diagnostic start Instagram for user 12 by component and answer',
          [a.replies[0].ok, a.calls.some((c) => /am start --user 12 -n com\.instagram\.android/.test(c)), b.replies[0].ok, b.calls.some((c) => /am start --user 12 -n com\.instagram\.android/.test(c))],
          [true, true, true, true]);
      }
      {
        const { core, calls } = makeCore(phone(KADIE, 'feed'));
        const d = core._checkDriver('R11', 12, 'com.instagram.android', async () => {});
        const out = await d.launch();
        check('core: the visit driver\'s re-launch resolves fresh and starts Instagram with -W for user 12; gives back text',
          [typeof out, /Status: ok/.test(out), calls.filter((c) => /resolve-activity --brief --user 12/.test(c)).length, calls.filter((c) => /am start -W --user 12 -n/.test(c)).length], ['string', true, 1, 1]);
      }

      {
        // R12: the same fake on a virtual clock - setTimeout(fn, ms) moves the clock by ms, every adb call costs 400 ms
        const realNow = Date.now, instant = global.setTimeout;
        let clock = 1e9;
        Date.now = () => clock;
        global.setTimeout = (fn, ms) => { clock += ms || 0; fn(); return 0; };
        try {
          const x = makeCore(phone(KADIE, 'feed'), { lockedPolls: 1e9 });
          const real = x.core._adbLong;
          x.core._adbLong = async (serial, args, ms) => { clock += 400; return real(serial, args, ms); };
          const t0 = clock;
          await x.core._waitUnlocked('R12', 12, 30000);
          const waited = clock - t0, looks = x.calls.filter((c) => /get-started-user-state 12/.test(c)).length;
          const t1 = clock;
          await x.core.launchApp('R12', { request_id: 'R12', uid: 12, package: 'com.instagram.android' }, x.ws);
          const open = clock - t1;
          check('core: (virtual clock, adb 400 ms a call) the 30 s wait lasts 29-32 s with 20+ looks; open app on a profile that never unlocks answers inside the backend\'s 20 s',
            [waited >= 29000 && waited <= 32000, looks >= 20, open <= 20000, x.replies[0].state], [true, true, true, 'launch_failed']);
        } finally { Date.now = realNow; global.setTimeout = instant; }
      }
            {
        const { core, replies, ws } = makeCore(phone({ s: { xml: JOIN } }, 's'));
        await core.igCheck('SER7', { request_id: 'r7', uid: 12, shot: true }, ws);
        const { core: c2, replies: r2, ws: w2 } = makeCore(phone(KADIE, 'feed'));
        await c2.igCheck('SER7b', { request_id: 'r7b', uid: 12, shot: true }, w2);
        check('core: shot:true -> a screenshot only when the result is not a clean read', [replies[0].state, !!replies[0].screenshot_b64, r2[0].state, 'screenshot_b64' in r2[0]], ['logged_out', true, 'checked', false]);
      }
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'));
        core._posting = new Set(['SER8']);
        await core.igCheck('SER8', { request_id: 'r8', uid: 12 }, ws);
        check('core: another job on the phone -> device_busy straight away', [replies[0].ok, replies[0].state], [false, 'device_busy']);
      }
      {
        const F = phone(LUCY, 'prompt');
        const env = makeCore(F, { viewerAfterAsks: 25 });
        await env.core.igCheck('SER9', { request_id: 'r9', uid: 12 }, env.ws);
        if (process.env.IGCHECK_TRACE) console.log(env.core.logs.map((l) => '      ' + l).join('\n'));
        const iReply = env.calls.indexOf('<<REPLY>>');
        check('core: ...it stopped in the middle (the profile had been read), not at the start', env.core.logs.some((l) => /profile @urlucybby: 26 posts/.test(l)), true);
        check('core: a viewer opening mid-visit -> device_busy / viewer_opened, the phone put back before the reply', [env.replies[0].ok, env.replies[0].state, env.replies[0].why,
          env.calls.slice(0, iReply).includes('shell am switch-user 0')], [false, 'device_busy', 'viewer_opened', true]);
      }
      {
        // the lock screen is up after the switch, and someone opens the phone right after dismiss-keyguard
        const env = makeCore(phone(KADIE, 'feed'));
        const realAdb = env.core._adbLong;
        env.core._adbLong = async (serial, args, ms) => {
          const cmd = args.join(' ');
          if (/dumpsys activity activities/.test(cmd)) { env.calls.push(cmd); return `  topResumedActivity=ActivityRecord{1f u${env.s.user} com.android.launcher3/.uioverrides.QuickstepLauncher t7}\n  mKeyguardShowing=true`; }
          if (/wm dismiss-keyguard/.test(cmd)) { env.calls.push(cmd); env.s.viewer = true; return ''; }
          return realAdb(serial, args, ms);
        };
        await env.core.igCheck('SER10', { request_id: 'r10', uid: 12 }, env.ws);
        const iReply = env.calls.indexOf('<<REPLY>>');
        check('core: a viewer who opens the phone during the unlock gets no MENU press and no swipe; device_busy / viewer_opened, the phone put back',
          [env.replies[0].ok, env.replies[0].state, env.replies[0].why, env.calls.includes('shell wm dismiss-keyguard'), env.calls.some((c) => /input keyevent 82|input swipe/.test(c)),
            env.calls.slice(0, iReply).includes('shell am switch-user 0')], [false, 'device_busy', 'viewer_opened', true, false, true]);
      }
      {
        // the Mac's phones answer adb slowly at busy moments: an `input swipe` that times out in Insights
        const env = makeCore(phone(KADIE, 'feed'));
        const realAdb = env.core._adbLong;
        env.core._adbLong = async (serial, args, ms) => {
          if (/input swipe/.test(args.join(' '))) { env.calls.push(args.join(' ')); throw new Error('Command failed: adb -s SER11 shell input swipe (timed out)'); }
          return realAdb(serial, args, ms);
        };
        await env.core.igCheck('SER11', { request_id: 'r11', uid: 12 }, env.ws);
        const r = env.replies[0], a = (r.accounts || [])[0] || {};
        check('core: an adb swipe that times out inside Insights: still ok / checked, the account and what Insights gave kept, the reason in insights.why',
          [r.ok, r.state, r.status, a.followers, a.insights && a.insights.views, a.insights && a.insights.why.some((w) => /^stopped: error: Command failed/.test(w))],
          [true, 'checked', 'HEALTHY', 85, 44321, true]);
      }

      // ---- v0.5.16: what the review of 2026-11-10 asked for before the release ----
      // A virtual clock for the checks whose loops are bounded by time: setTimeout(fn, ms) moves the
      // clock by ms (with instant timers and the real clock, a 15 s wait would spin for 15 real seconds).
      const onClock = async (fn) => {
        const realNow = Date.now, instant = global.setTimeout;
        let clock = 1e9;
        Date.now = () => clock;
        global.setTimeout = (f, ms) => { clock += ms || 0; f(); return 0; };
        try { return await fn(); } finally { Date.now = realNow; global.setTimeout = instant; }
      };
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 4 });
        await core.igCheck('T1', { request_id: 't1', uid: 12 }, ws);
        const tr = replies[0].trace;
        check('core: the REPLY says how the start went - what was in front after the switch, the wait for the unlock (ok), the try that worked (ok) - then the visit\'s own steps',
          [tr.slice(0, 3).map((t) => t.name), tr.slice(0, 3).map((t) => t.ok), tr[0].matched, /^RUNNING_UNLOCKED after \d+ s$/.test(tr[1].matched),
            /^component: Status: ok, LaunchState: COLD/.test(tr[2].matched), tr.length > 5, tr[3].name, tr.length <= 80],
          [['settle', 'unlock', 'launch 1/3'], [true, true, true], 'u12 com.android.launcher3', true, true, true, 'screen', true]);
      }
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 1e9, rejects: true });
        await core.igCheck('T2', { request_id: 't2', uid: 12, shot: true }, ws);
        const tr = replies[0].trace;
        check('core: a profile that never unlocks says so in the REPLY: still RUNNING_LOCKED after the wait, Android\'s own words for each of the 3 tries, what was in front each time',
          [tr.map((t) => t.name), tr.filter((t) => t.name !== 'settle').some((t) => t.ok), /^RUNNING_LOCKED after \d+ s$/.test(tr[1].matched),
            tr.filter((t) => /^launch/.test(t.name)).every((t) => /^MAIN\/LAUNCHER intent: Error: Activity not started, unable to resolve Intent/.test(t.matched)),
            tr.filter((t) => t.name === 'front').every((t) => t.matched === 'resumed u12 com.android.launcher3, screen com.android.launcher3'),
            tr.every((t) => t.matched.length <= 118), replies[0].why, !!replies[0].screenshot_b64],
          [['settle', 'unlock', 'launch 1/3', 'front', 'launch 2/3', 'front', 'launch 3/3', 'front'], false, true, true, true, true, 'ig_not_in_front', true]);
      }
      {
        const { core, replies, ws } = makeCore(phone(KADIE, 'feed'), { amStartDead: true });
        await core.igCheck('T3', { request_id: 't3', uid: 12 }, ws);
        check('core: ...and when only the icon tap brought Instagram up, the REPLY shows the two starts that did nothing and the tap that worked',
          replies[0].trace.slice(1, 7).map((t) => `${t.name}${t.ok ? ' ok' : ' no'}${/^launch 3/.test(t.name) ? ' ' + t.matched : ''}`),
          ['unlock ok', 'launch 1/3 no', 'front no', 'launch 2/3 no', 'front no', 'launch 3/3 ok icon at 151,1150']);
      }
      await onClock(async () => {
        // Android accepted the switch (am get-current-user says 12) but profile 10 is still on the screen,
        // with ITS Instagram icon on the home screen: tapping it would read profile 10's account as 12's.
        const a = makeCore(phone(KADIE, 'feed'), { amStartDead: true, screenUser: 10 });
        await a.core.igCheck('T4', { request_id: 't4', uid: 12 }, a.ws);
        check('core: another profile is still on the screen: its Instagram icon is NOT tapped; unreadable / ig_not_in_front, no account read, and the reply names who was in front',
          [a.replies[0].state, a.replies[0].why, a.replies[0].username, a.calls.filter((c) => /input tap/.test(c)), a.replies[0].trace[0].ok,
            a.replies[0].trace.filter((t) => t.name === 'front').map((t) => t.matched.split(',')[0])],
          ['unreadable', 'ig_not_in_front', '', [], false, ['resumed u10 com.android.launcher3', 'resumed u10 com.android.launcher3', 'resumed u10 com.android.launcher3']]);
        // ...and the older half of the same hole: another profile's Instagram already in front. Its package
        // name alone no longer counts as "Instagram in front" when Android names the other profile.
        const b = makeCore(phone(KADIE, 'feed'), { screenUser: 10 });
        await b.core.igCheck('T5', { request_id: 't5', uid: 12 }, b.ws);
        check('core: another profile\'s Instagram in front is not taken for this profile\'s: unreadable / ig_not_in_front, nothing of that account in the reply',
          [b.replies[0].state, b.replies[0].why, b.replies[0].username, b.replies[0].accounts, b.replies[0].trace.filter((t) => t.name === 'front')[0].matched],
          ['unreadable', 'ig_not_in_front', '', [], 'resumed u10 com.instagram.android, screen com.instagram.android']);
      });
      {
        // someone opens the phone while the check waits for a slow profile to unlock
        const env = makeCore(phone(KADIE, 'feed'), { lockedPolls: 1e9 });
        const realAdb = env.core._adbLong;
        let looks = 0;
        env.core._adbLong = async (serial, args, ms) => { if (/get-started-user-state/.test(args.join(' ')) && ++looks === 3) env.s.viewer = true; return realAdb(serial, args, ms); };
        await env.core.igCheck('T6', { request_id: 't6', uid: 12 }, env.ws);
        const iReply = env.calls.indexOf('<<REPLY>>');
        check('core: a viewer who opens the phone during the wait for the unlock is noticed at the next look (not 30 s later): device_busy / viewer_opened, no launch, the phone put back',
          [env.replies[0].ok, env.replies[0].state, env.replies[0].why, looks, env.calls.filter((c) => /am start/.test(c)), env.calls.slice(0, iReply).includes('shell am switch-user 0')],
          [false, 'device_busy', 'viewer_opened', 3, [], true]);
      }
      {
        const a = makeCore(phone(KADIE, 'feed'));
        await a.core.launchApp('S1', { request_id: 's1', uid: 12, package: 'com.instagram.android;reboot' }, a.ws);
        const b = makeCore(phone(KADIE, 'feed'));
        await b.core.checkAppsInstalled('S2', { request_id: 's2', uid: 12, packages: ['com.instagram.android', 'x;id', 'com.a$(id)', '', null, 'com.discord'] }, b.ws);
        const c = makeCore(phone(KADIE, 'feed'));
        await c.core.checkAccountStatus('S3', { request_id: 's3', uid: 12, package: 'com.x`id`' }, c.ws);
        check('core: only a package name ever reaches the phone\'s shell - open app, installed-apps check, status check',
          [a.replies[0].state, a.replies[0].error, a.calls.filter((k) => /^shell/.test(k)), Object.keys(b.replies[0].installed),
            b.calls.filter((k) => /pm list packages/.test(k)).some((k) => /[;$`]/.test(k)), c.replies[0].error, c.calls.filter((k) => /^shell/.test(k))],
          ['launch_failed', 'not a package name', [], ['com.instagram.android', 'com.discord'], false, 'not a package name', []]);
      }
      {
        const x = makeCore(phone(KADIE, 'feed'));
        const link = "https://example.com/a?x=1&y=2;z=$(id)'q";
        await x.core.openUrl('U1', { request_id: 'u1', uid: 12, url: link }, x.ws);
        const line = x.calls.find((k) => /am start -a android\.intent\.action\.VIEW/.test(k)) || '';
        const y = makeCore(phone(KADIE, 'feed'));
        await y.core.openUrl('U2', { request_id: 'u2', uid: 12, url: 'https://example.com/a b' }, y.ws);
        await y.core.openUrl('U3', { request_id: 'u3', uid: 12, url: 'https://example.com/a\nreboot' }, y.ws);
        await y.core.openUrl('U4', { request_id: 'u4', uid: 12, url: 'ftp://example.com/a' }, y.ws);
        check('core: open link - the link reaches the phone\'s shell inside single quotes, whole, with --user after it; a quote inside it is escaped; a blank, a line break or another scheme is refused and nothing is sent',
          [line, x.replies[0].ok, y.replies.map((r) => r.error), y.calls.filter((k) => /am start/.test(k))],
          ["shell am start -a android.intent.action.VIEW -d 'https://example.com/a?x=1&y=2;z=$(id)'\\''q' --user 12", true, ['invalid url', 'invalid url', 'invalid url'], []]);
        // a real POSIX shell must give the link back unchanged, as ONE word (skipped where there is no sh)
        let back = null;
        try { back = require('child_process').execFileSync('sh', ['-c', 'printf "%s|%s" ' + x.core._shq(link) + ' end'], { encoding: 'utf8', timeout: 8000 }); } catch (e) { back = null; }
        if (back != null) check('core: ...a real shell reads the quoted link as one word, unchanged, and runs nothing in it', back, link + '|end');
        else console.log('SKIP  (no sh on this computer) a real shell reads the quoted link as one word');
      }
      await onClock(async () => {
        const { core, calls, ws } = makeCore(phone(KADIE, 'feed'), { lockedPolls: 2 });
        await core.igPost('P1', { request_id: 'p1', uid: 12, mode: 'capture', fresh_ip: false, evidence: false, audio_url: 'https://www.instagram.com/reels/audio/123/?igsh=a&b=c' }, ws);
        const iWait = calls.lastIndexOf('shell am get-started-user-state 12'), iView = calls.findIndex((c) => /am start --user 12 -a android\.intent\.action\.VIEW/.test(c));
        check('core: ig_post with a sound link: the wait for the unlock comes FIRST (3 looks), then the link goes to Instagram inside single quotes',
          [calls.filter((c) => /get-started-user-state 12/.test(c)).length, iWait >= 0 && iView > iWait, calls[iView]],
          [3, true, "shell am start --user 12 -a android.intent.action.VIEW -d 'https://www.instagram.com/reels/audio/123/?igsh=a&b=c' -p com.instagram.android"]);
      });
      {
        // The Mac answers adb slowly at busy moments. A phone that cannot say which profile it is on is not moved:
        // before 0.5.16 the visit ran and the phone was LEFT on the visited profile (nobody knew where to put it back).
        const env = makeCore(phone(KADIE, 'feed'));
        const realAdb = env.core._adbLong;
        env.core._adbLong = async (serial, args, ms) => { if (/am get-current-user/.test(args.join(' '))) { env.calls.push(args.join(' ')); throw new Error('timed out'); } return realAdb(serial, args, ms); };
        await env.core.igCheck('W1', { request_id: 'w1', uid: 12 }, env.ws);
        check('core: the phone cannot say which profile it is on (asked twice): nothing is switched, the visit fails and says why',
          [env.replies[0].ok, env.replies[0].state, /nothing was switched/.test(env.replies[0].error || ''), env.calls.filter((c) => /am switch-user/.test(c)), env.calls.filter((c) => /am get-current-user/.test(c)).length],
          [false, 'failed', true, [], 2]);
      }
      {
        // who is watching: the agent's own record of people's live streams, per phone
        const core = Object.create(AgentCore.prototype);
        const sock = () => { const h = {}; return { readyState: 1, addEventListener: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); }, fire: (ev) => (h[ev] || []).forEach((fn) => fn()) }; };
        const a = sock(), b = sock(), c = sock();
        const seen = [await core._scrcpyRunning('P1')];                                   // nobody yet
        core._trackPerson('P1', a); core._trackPerson('P1', b); core._trackPerson('P2', c);
        seen.push(await core._scrcpyRunning('P1'), await core._scrcpyRunning('P2'), await core._scrcpyRunning('P3'));
        a.fire('close'); seen.push(await core._scrcpyRunning('P1'));                      // one of the two is left
        b.readyState = 3; seen.push(await core._scrcpyRunning('P1'));                     // closed with no event: not counted, and forgotten
        b.readyState = 1; seen.push(await core._scrcpyRunning('P1'));
        c.fire('error'); seen.push(await core._scrcpyRunning('P2'));
        check('core: who is watching = people\'s live video streams on THAT phone; a stream that closed no longer counts, with or without its close event',
          seen, [false, true, true, false, true, false, false, false]);
        const Q = 'action=proxy-adb&remote=tcp%3A8886&udid=SER';
        check('core: a stream counts as a person only when the backend said so (watch: false) AND it is the live video - not the device list, not a Multiview tile, not an older backend',
          [AgentCore._countsAsPerson(true, Q), AgentCore._countsAsPerson(true, 'action=multiplex'), AgentCore._countsAsPerson(false, Q), AgentCore._countsAsPerson(undefined, Q),
            AgentCore._countsAsPerson(true, ''), AgentCore._countsAsPerson(true, 'x=1&action=proxy-adb'), AgentCore._countsAsPerson(true, 'action=proxy-adbx')],
          [true, false, false, false, false, true, false]);
      }
    } finally { global.setTimeout = REAL; }
  }

  console.log(fail ? `\n${fail} of ${n} check(s) FAILED` : `\nall ${n} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
