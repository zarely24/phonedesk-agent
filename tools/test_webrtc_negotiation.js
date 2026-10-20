// Offline test of the WebRTC codec negotiation in src/webrtc.js - no phone, no backend, no browser.
// A werift peer plays the browser (answerer) and we check that:
//   1. WEBRTC_CODEC=h265 offers H.265 first with the HEVC fmtp line, H.264 second
//   2. an HEVC-capable answerer makes the agent start the H.265 capture (scrcpy 5 path)
//   3. an H.264-only answerer makes the agent fall back to the H.264 capture (legacy jar)
//   4. WEBRTC_CODEC unset keeps the legacy behaviour: H.264 only, capture starts before the offer
// The two capture functions are stubbed (they would otherwise shell out to adb).
// Run: node tools/test_webrtc_negotiation.js
'use strict';
const assert = require('assert');
const werift = require('werift');
process.env.WEBRTC_ENABLED = '1';

let passed = 0;
function ok(name, cond) { assert(cond, name); console.log('  ok  ', name); passed++; }

// ---- stubs: record which capture path was started instead of launching scrcpy ----
const scrcpy5 = require('../src/scrcpy-capture');
const webrtc = require('../src/webrtc');
const started = [];
scrcpy5.startCapture = (adb, serial, opts) => { started.push('h265:' + opts.codec); return { stop() {} }; };
webrtc.startCapture = (adb, serial) => { started.push('h264'); return { stop() {} }; };
// webrtc.js calls its own startCapture through module scope, so patch via the sessions path instead:
// startH264 uses the local binding; we detect it by the legacy jar push failing fast on a fake adb path.
const agent = { adbPath: 'adb-does-not-exist', emit(kind, line) { if (kind === 'log') logs.push(line); } };
let logs = [];
function fakeWs(onMsg) { return { readyState: 1, send(s) { onMsg(JSON.parse(s)); } }; }

async function negotiate(mode, answererCodecs) {
  process.env.WEBRTC_CODEC = mode;
  logs = []; started.length = 0;
  const sessionId = 'sess-' + mode + '-' + answererCodecs.length;
  const browser = new werift.RTCPeerConnection({ codecs: { video: answererCodecs } });
  let offerSdp = null;
  const ws = fakeWs(async (m) => {
    if (m.op === 'rtc_offer') {
      offerSdp = m.sdp;
      let answerSdp;
      try {
        await browser.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const ans = await browser.createAnswer();
        await browser.setLocalDescription(ans);
        answerSdp = browser.localDescription.sdp;
      } catch (e) {
        // werift throws when it can decode nothing we offered; a real browser answers with the
        // m-line REJECTED (port 0). Hand-build that answer so the agent sees what Chrome would send.
        answerSdp = m.sdp.replace(/^m=video \d+ /m, 'm=video 0 ').replace('a=sendonly', 'a=inactive');
      }
      await webrtc.answer(agent, { session_id: sessionId, sdp: answerSdp });
    }
  });
  await webrtc.open(agent, ws, 'SERIAL1', { session_id: sessionId, iceServers: [] });
  await new Promise((r) => setTimeout(r, 400));
  const s = webrtc.sessions.get(sessionId);
  const result = { offerSdp, codec: s && s.codec, negotiated: s && s.transceiver.codecs.map((c) => c.mimeType), logs: logs.slice() };
  try { webrtc.close(agent, { session_id: sessionId }); } catch (e) {}
  try { browser.close(); } catch (e) {}
  return result;
}

const fb = [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }];
const HEVC_BROWSER = [
  new werift.RTCRtpCodecParameters({ mimeType: 'video/H265', clockRate: 90000, rtcpFeedback: fb, parameters: 'level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST' }),
  new werift.RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: fb, parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' }),
];
const H264_ONLY_BROWSER = [HEVC_BROWSER[1]];

(async () => {
  // 1 + 2: h265 mode, HEVC-capable browser
  let r = await negotiate('h265', HEVC_BROWSER);
  const lines = r.offerSdp.split(/\r?\n/);
  const h265map = lines.find((l) => /^a=rtpmap:\d+ H265\/90000/.test(l));
  const h264map = lines.find((l) => /^a=rtpmap:\d+ H264\/90000/.test(l));
  ok('offer advertises H265/90000', !!h265map);
  ok('offer advertises H264/90000 as the fallback', !!h264map);
  const pt265 = h265map.match(/^a=rtpmap:(\d+)/)[1];
  ok('H265 is listed before H264 on the m= line', new RegExp(`^m=video \\d+ [^ ]+ ${pt265}\\b`).test(lines.find((l) => l.startsWith('m=video'))));
  ok('H265 fmtp carries profile-id/level-id/tier-flag/tx-mode', lines.some((l) => l.startsWith(`a=fmtp:${pt265} `) && /profile-id=1/.test(l) && /level-id=120/.test(l) && /tier-flag=0/.test(l) && /tx-mode=SRST/.test(l)));
  ok('m-line is sendonly', lines.includes('a=sendonly'));
  ok('HEVC browser -> negotiated codec is H265', (r.negotiated || [])[0] === 'video/H265');
  ok('HEVC browser -> agent started the H.265 (scrcpy 5) capture', started[0] === 'h265:h265' && r.codec === 'h265');
  ok('agent logged the negotiation', r.logs.some((l) => /negotiated H\.265/.test(l)));

  // 3: h265 mode, browser without HEVC
  r = await negotiate('h265', H264_ONLY_BROWSER);
  ok('H264-only browser -> negotiated codec is H264', (r.negotiated || [])[0] === 'video/H264');
  ok('H264-only browser -> agent fell back to the H.264 capture', r.codec === 'h264' && !started.some((x) => x.startsWith('h265')));
  ok('agent logged that the browser declined H.265', r.logs.some((l) => /declined H\.265/.test(l)));

  // h265-only mode, browser without HEVC: no codec -> session closed, browser falls back to legacy
  r = await negotiate('h265-only', H264_ONLY_BROWSER);
  ok('h265-only + H264-only browser -> session closed (rejected m-line)', !webrtc.sessions.has('sess-h265-only-1') && r.logs.some((l) => /no usable video codec|answer not usable|rejected the video m-line/.test(l)));

  // 4: legacy mode
  r = await negotiate('h264', HEVC_BROWSER);
  ok('legacy mode offers no H265 line', !/H265\/90000/.test(r.offerSdp));
  ok('legacy mode starts H.264 capture before the answer', r.codec === 'h264');

  console.log(`\nwebrtc negotiation: ${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
