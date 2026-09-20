// Unit tests for src/h264-rtp.js — Annex-B NAL parsing + RTP (RFC 6184) packetization.
// Pure/synthetic H.264, no hardware. Run: node tools/test_rtp.js
'use strict';
const assert = require('assert');
const { parseAnnexB, nalType, isKeyframe, RtpH264Packetizer, NAL } = require('../src/h264-rtp');

let passed = 0;
function ok(name, cond) { assert(cond, name); console.log('  ok  ', name); passed++; }

// ---- helpers: build synthetic NAL units + an Annex-B stream ----
function nal(type, size) { const b = Buffer.alloc(size); b[0] = (type & 0x1f) | 0x60 /*nri*/; for (let i = 1; i < size; i++) b[i] = (i * 7) & 0xff; return b; }
function annexb(nals, fourByte) { const sc = fourByte ? Buffer.from([0, 0, 0, 1]) : Buffer.from([0, 0, 1]); return Buffer.concat([].concat(...nals.map((n) => [sc, n]))); }

// ---- 1. Annex-B parsing: SPS, PPS, IDR, non-IDR ----
(() => {
  const sps = nal(NAL.SPS, 12), pps = nal(NAL.PPS, 6), idr = nal(NAL.IDR, 5000), p = nal(NAL.NON_IDR, 900);
  const stream = Buffer.concat([annexb([sps, pps, idr], true), annexb([p], false)]);
  const got = parseAnnexB(stream);
  ok('parses 4 NAL units', got.length === 4);
  ok('SPS detected', nalType(got[0]) === NAL.SPS);
  ok('PPS detected', nalType(got[1]) === NAL.PPS);
  ok('IDR detected + isKeyframe', nalType(got[2]) === NAL.IDR && isKeyframe(got[2]));
  ok('non-IDR detected', nalType(got[3]) === NAL.NON_IDR && !isKeyframe(got[3]));
  ok('handles both 3- and 4-byte start codes', got[3].length === 900);
})();

// ---- 2. Single NAL packet (small NAL <= MTU) ----
(() => {
  const pk = new RtpH264Packetizer({ ssrc: 0x11223344, payloadType: 96, seq: 1000, mtu: 1200 });
  const small = nal(NAL.NON_IDR, 200);
  const pkts = pk.packetize([small], 90000);
  ok('small NAL -> 1 RTP packet', pkts.length === 1);
  const h = pkts[0];
  ok('RTP version=2', (h[0] >> 6) === 2);
  ok('payload type=96', (h[1] & 0x7f) === 96);
  ok('marker=1 on last packet of frame', (h[1] >> 7) === 1);
  ok('seq set', h.readUInt16BE(2) === 1000);
  ok('timestamp 90k', h.readUInt32BE(4) === 90000);
  ok('ssrc set', h.readUInt32BE(8) === 0x11223344);
  ok('single-NAL payload == original NAL', Buffer.compare(h.subarray(12), small) === 0);
})();

// ---- 3. FU-A fragmentation for a large NAL ----
(() => {
  const pk = new RtpH264Packetizer({ ssrc: 1, payloadType: 96, seq: 0, mtu: 1200 });
  const big = nal(NAL.IDR, 5000);
  const pkts = pk.packetizeNal(big, 3000, true);
  ok('large NAL fragments into multiple packets', pkts.length > 1);
  // first fragment: S=1,E=0 ; last: S=0,E=1 ; middle: S=0,E=0
  const fuInd = (p) => p[12], fuHdr = (p) => p[13];
  ok('FU-A indicator type=28', (fuInd(pkts[0]) & 0x1f) === 28);
  ok('first fragment S bit set', (fuHdr(pkts[0]) & 0x80) !== 0 && (fuHdr(pkts[0]) & 0x40) === 0);
  ok('last fragment E bit set', (fuHdr(pkts[pkts.length - 1]) & 0x40) !== 0);
  ok('middle fragment S=0,E=0', (fuHdr(pkts[1]) & 0xc0) === 0);
  ok('FU header carries original NAL type', (fuHdr(pkts[0]) & 0x1f) === NAL.IDR);
  ok('only last fragment has marker=1', (pkts[pkts.length - 1][1] >> 7) === 1 && (pkts[0][1] >> 7) === 0);
  ok('every fragment respects MTU', pkts.every((p) => p.length <= 1200));
  ok('sequence numbers increment by 1', pkts.every((p, i) => p.readUInt16BE(2) === i));

  // round-trip: reassemble FU-A back to the original NAL
  let reFirst = pkts[0]; const nalHeader = (fuInd(reFirst) & 0xe0) | (fuHdr(reFirst) & 0x1f);
  let body = Buffer.concat(pkts.map((p) => p.subarray(14)));
  const reNal = Buffer.concat([Buffer.from([nalHeader]), body]);
  ok('FU-A reassembles to the original NAL', Buffer.compare(reNal, big) === 0);
})();

// ---- 4. seq/marker across a multi-NAL access unit + wrap ----
(() => {
  const pk = new RtpH264Packetizer({ ssrc: 1, payloadType: 96, seq: 65534, mtu: 1200 });
  const pkts = pk.packetize([nal(NAL.SPS, 10), nal(NAL.PPS, 6), nal(NAL.IDR, 300)], 12345);
  ok('access unit -> N packets', pkts.length === 3);
  ok('seq wraps 65535 -> 0', pkts[0].readUInt16BE(2) === 65534 && pkts[1].readUInt16BE(2) === 65535 && pkts[2].readUInt16BE(2) === 0);
  ok('marker only on the LAST NAL of the access unit', (pkts[0][1] >> 7) === 0 && (pkts[2][1] >> 7) === 1);
  ok('all share the frame timestamp', pkts.every((p) => p.readUInt32BE(4) === 12345));
})();

// ---- 5. malformed / edge input (parser must never throw) ----
(() => {
  ok('empty buffer -> []', parseAnnexB(Buffer.alloc(0)).length === 0);
  ok('no start code -> []', parseAnnexB(Buffer.from([1, 2, 3, 4, 5])).length === 0);
  ok('start code only -> []', parseAnnexB(Buffer.from([0, 0, 0, 1])).length === 0);
  ok('trailing start code ignored', parseAnnexB(Buffer.concat([annexb([nal(NAL.NON_IDR, 20)], true), Buffer.from([0, 0, 1])])).length === 1);
  ok('two IDRs back to back', parseAnnexB(annexb([nal(NAL.IDR, 100), nal(NAL.IDR, 100)], true)).length === 2);
  const pk = new RtpH264Packetizer({ payloadType: 96 });
  ok('packetize([]) -> []', pk.packetize([], 0).length === 0);
  ok('1-byte NAL packetizes', pk.packetize([Buffer.from([0x65])], 0).length === 1);
})();

// ---- 6. mock WebRTC session lifecycle: creation / isolation / cleanup / idempotency (spec §5,§6,§10)
(() => {
  const webrtc = require('../src/webrtc');
  const agent = { emit() {} };
  function mockSession(id) {
    const rec = { pcClosed: 0, capStopped: 0 };
    webrtc.sessions.set(id, { pc: { close() { rec.pcClosed++; } }, capture: { stop() { rec.capStopped++; } }, stats: { rtp: 3, keyframes: 1 } });
    return rec;
  }
  const a = mockSession('sessA'); const b = mockSession('sessB');
  ok('two sessions coexist', webrtc.sessions.size >= 2);
  webrtc.close(agent, { session_id: 'sessA' });
  ok('close(A): pc closed + capture stopped', a.pcClosed === 1 && a.capStopped === 1);
  ok('close(A): session A removed', !webrtc.sessions.has('sessA'));
  ok('ISOLATION: session B untouched', webrtc.sessions.has('sessB') && b.pcClosed === 0);
  webrtc.close(agent, { session_id: 'sessA' });     // idempotent
  ok('close(A) again is a no-op (no throw)', a.pcClosed === 1);
  webrtc.close(agent, { session_id: 'does-not-exist' });
  ok('close(unknown) is safe', true);
  webrtc.close(agent, { session_id: 'sessB' });
  ok('cleanup B', !webrtc.sessions.has('sessB') && b.pcClosed === 1);
})();

console.log(`\nPASSED ✅  (${passed} checks) — H.264 NAL parse + RTP packetization + malformed + session lifecycle`);
