// v0.5.5: the backend can switch WebRTC (and the codec it should offer) on per phone through the
// open_webrtc message, so nobody has to set environment variables on the farm computer. The owner's
// own variables still win when they exist. Run: node tools/test_webrtc_switch.js
const path = require('path');
const w = require(path.join(process.cwd(), 'src', 'webrtc.js'));
let fail = 0;
const check = (n, g, want) => { const ok = JSON.stringify(g) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (ok ? '' : `\n      got ${JSON.stringify(g)} want ${JSON.stringify(want)}`)); };
const env = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

env('WEBRTC_ENABLED'); env('WEBRTC_CODEC');
check('nothing set anywhere: dormant', w.webrtcAllowed({ session_id: 'x' }), false);
check('backend says enabled: allowed', w.webrtcAllowed({ enabled: true }), true);
check('backend sends a non-boolean: still dormant', w.webrtcAllowed({ enabled: 'yes' }), false);
check('no message at all: dormant', w.webrtcAllowed(undefined), false);
env('WEBRTC_ENABLED', '0');
check('owner veto (WEBRTC_ENABLED=0) beats the backend', w.webrtcAllowed({ enabled: true }), false);
env('WEBRTC_ENABLED', 'yes');
check('owner opt-in works without the backend flag (old behaviour)', w.webrtcAllowed({}), true);
env('WEBRTC_ENABLED');

check('codec: default is H.264', w.codecMode({}), 'h264');
check('codec: backend asks for h265', w.codecMode({ codec: 'h265' }), 'h265');
check('codec: backend asks for hevc-only', w.codecMode({ codec: 'HEVC-only' }), 'h265-only');
check('codec: garbage from the backend falls back to H.264', w.codecMode({ codec: 'vp9' }), 'h264');
env('WEBRTC_CODEC', 'h264');
check('codec: owner environment beats the backend', w.codecMode({ codec: 'h265' }), 'h264');
env('WEBRTC_CODEC');
check('codec: no message, no env', w.codecMode(), 'h264');

console.log(fail ? `\n${fail} FAILING` : '\nall checks passed');
process.exit(fail ? 1 : 0);
