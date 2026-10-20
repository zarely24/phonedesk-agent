// Unit tests for src/h265-rtp.js — Annex-B HEVC NAL parsing + RTP (RFC 7798) packetization.
// Pure/synthetic H.265, no hardware. Run: node tools/test_h265_rtp.js
'use strict';
const assert = require('assert');
const { parseAnnexB, nalType, isKeyframe, isParameterSet, RtpH265Packetizer, NAL, FU_TYPE } = require('../src/h265-rtp');

let passed = 0;
function ok(name, cond) { assert(cond, name); console.log('  ok  ', name); passed++; }

// ---- helpers: synthetic HEVC NAL units (2-byte header: F=0, type, layerId=0, tid=1) ----
function nal(type, size, tid = 1) {
  const b = Buffer.alloc(size);
  b[0] = (type & 0x3f) << 1;            // F=0 | type(6) | layerId high bit = 0
  b[1] = tid & 0x07;                    // layerId low 5 bits = 0 | TID(3)
  for (let i = 2; i < size; i++) b[i] = (i * 13) & 0xff;
  return b;
}
function annexb(nals, fourByte) { const sc = fourByte ? Buffer.from([0, 0, 0, 1]) : Buffer.from([0, 0, 1]); return Buffer.concat([].concat(...nals.map((n) => [sc, n]))); }

// ---- 1. Annex-B parsing + type classification ----
(() => {
  const vps = nal(NAL.VPS, 20), sps = nal(NAL.SPS, 40), pps = nal(NAL.PPS, 8), idr = nal(NAL.IDR_W_RADL, 6000), p = nal(NAL.TRAIL_R, 900), cra = nal(NAL.CRA, 300);
  const stream = Buffer.concat([annexb([vps, sps, pps, idr], true), annexb([p, cra], false)]);
  const got = parseAnnexB(stream);
  ok('parses 6 NAL units', got.length === 6);
  ok('VPS detected (type 32)', nalType(got[0]) === NAL.VPS && isParameterSet(got[0]));
  ok('SPS detected (type 33)', nalType(got[1]) === NAL.SPS && isParameterSet(got[1]));
  ok('PPS detected (type 34)', nalType(got[2]) === NAL.PPS && isParameterSet(got[2]));
  ok('IDR_W_RADL is a keyframe', nalType(got[3]) === NAL.IDR_W_RADL && isKeyframe(got[3]));
  ok('TRAIL_R is not a keyframe', nalType(got[4]) === NAL.TRAIL_R && !isKeyframe(got[4]) && !isParameterSet(got[4]));
  ok('CRA is a keyframe', isKeyframe(got[5]));
  ok('handles both 3- and 4-byte start codes', got[4].length === 900 && got[5].length === 300);
})();

// ---- 2. Single NAL unit packet ----
(() => {
  const pk = new RtpH265Packetizer({ ssrc: 0x11223344, payloadType: 98, seq: 1000, mtu: 1200 });
  const small = nal(NAL.TRAIL_R, 200);
  const pkts = pk.packetize([small], 90000);
  ok('small NAL -> 1 RTP packet', pkts.length === 1);
  const h = pkts[0];
  ok('RTP version=2', (h[0] >> 6) === 2);
  ok('payload type=98', (h[1] & 0x7f) === 98);
  ok('marker=1 on last packet of frame', (h[1] >> 7) === 1);
  ok('seq set', h.readUInt16BE(2) === 1000);
  ok('timestamp 90k', h.readUInt32BE(4) === 90000);
  ok('ssrc set', h.readUInt32BE(8) === 0x11223344);
  ok('single-NAL payload == original NAL (2-byte header intact)', Buffer.compare(h.subarray(12), small) === 0);
  ok('payload NAL type readable by receiver', nalType(h.subarray(12)) === NAL.TRAIL_R);
})();

// ---- 3. FU fragmentation of a big NAL (RFC 7798 §4.4.3) ----
(() => {
  const pk = new RtpH265Packetizer({ ssrc: 1, payloadType: 98, seq: 65534, mtu: 1200 });
  const big = nal(NAL.IDR_N_LP, 5000, 2);
  const pkts = pk.packetize([big], 1234);
  const maxData = 1200 - 12 - 3;
  ok('big NAL fragmented into ceil((5000-2)/maxData) packets', pkts.length === Math.ceil((5000 - 2) / maxData));
  ok('every packet <= MTU', pkts.every((p) => p.length <= 1200));
  const first = pkts[0], last = pkts[pkts.length - 1];
  ok('PayloadHdr type = 49 (FU) on every fragment', pkts.every((p) => ((p[12] >> 1) & 0x3f) === FU_TYPE));
  ok('PayloadHdr keeps TID from the NAL', pkts.every((p) => (p[13] & 0x07) === 2));
  ok('FU header S bit on first only', (first[14] & 0x80) === 0x80 && pkts.slice(1).every((p) => (p[14] & 0x80) === 0));
  ok('FU header E bit on last only', (last[14] & 0x40) === 0x40 && pkts.slice(0, -1).every((p) => (p[14] & 0x40) === 0));
  ok('FU header carries original type (IDR_N_LP=20)', pkts.every((p) => (p[14] & 0x3f) === NAL.IDR_N_LP));
  ok('marker only on the last fragment', (last[1] >> 7) === 1 && pkts.slice(0, -1).every((p) => (p[1] >> 7) === 0));
  ok('sequence numbers wrap 65534,65535,0,...', first.readUInt16BE(2) === 65534 && pkts[1].readUInt16BE(2) === 65535 && pkts[2].readUInt16BE(2) === 0);
  ok('all fragments share the timestamp', pkts.every((p) => p.readUInt32BE(4) === 1234));
  // reassemble and compare to the original NAL (what a receiver does)
  const body = Buffer.concat(pkts.map((p) => p.subarray(15)));
  const rebuilt = Buffer.concat([Buffer.from([big[0], big[1]]), body]);
  ok('reassembled FU == original NAL byte-for-byte', Buffer.compare(rebuilt, big) === 0);
})();

// ---- 4. Full access unit: VPS+SPS+PPS+IDR, marker only at the very end ----
(() => {
  const pk = new RtpH265Packetizer({ ssrc: 2, payloadType: 98, seq: 0, mtu: 1200 });
  const au = [nal(NAL.VPS, 20), nal(NAL.SPS, 40), nal(NAL.PPS, 8), nal(NAL.IDR_W_RADL, 3000)];
  const pkts = pk.packetize(au, 5000);
  const markers = pkts.filter((p) => (p[1] >> 7) === 1).length;
  ok('exactly one marker per access unit', markers === 1 && (pkts[pkts.length - 1][1] >> 7) === 1);
  ok('parameter sets travel as single-NAL packets first', nalType(pkts[0].subarray(12)) === NAL.VPS && nalType(pkts[1].subarray(12)) === NAL.SPS && nalType(pkts[2].subarray(12)) === NAL.PPS);
  ok('sequence numbers are contiguous across the AU', pkts.every((p, i) => p.readUInt16BE(2) === i));
})();

// ---- 5. Edge cases ----
(() => {
  const pk = new RtpH265Packetizer({ ssrc: 3, payloadType: 98, seq: 0, mtu: 1200 });
  ok('1-byte garbage NAL is dropped, not crashed', pk.packetize([Buffer.from([0x40])], 1).length === 0);
  const exact = nal(NAL.TRAIL_R, 1200 - 12);
  ok('NAL that exactly fits the MTU goes as single packet', pk.packetize([exact], 1).length === 1);
  const over = nal(NAL.TRAIL_R, 1200 - 12 + 1);
  ok('one byte over the MTU fragments into 2', pk.packetize([over], 1).length === 2);
})();

console.log(`\nh265-rtp: ${passed} checks passed`);
