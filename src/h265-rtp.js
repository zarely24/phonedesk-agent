// H.265 / HEVC Annex-B NAL parsing + RTP packetization (RFC 7798 / RFC 3550). Pure, hardware-independent,
// and unit-tested (tools/test_h265_rtp.js) with synthetic HEVC — the codec plumbing between scrcpy's
// H.265 output (video_codec=h265, scrcpy >= 2.0) and the werift video track. No decode/re-encode: we only
// reframe NAL units into RTP packets.
//
// H.265 differs from H.264 in two places that matter here:
//   - the NAL header is TWO bytes: [F(1) | Type(6) | LayerId(6) | TID(3)]; type = (b0 >> 1) & 0x3f
//   - fragmentation is "FU" with payload-header type 49 (not FU-A/28), and the FU header carries the
//     ORIGINAL 6-bit NAL type: [S(1) | E(1) | FuType(6)]
'use strict';

const { parseAnnexB } = require('./h264-rtp');   // start-code splitting is codec-agnostic

const RTP_VERSION = 2;
const CLOCK_HZ = 90000;          // H.265 RTP clock (same as H.264)
const DEFAULT_MTU = 1200;        // safe SRTP payload size (leaves room under ~1500 MTU)
const FU_TYPE = 49;              // RFC 7798 §4.4.3 fragmentation unit payload-header type

// NAL unit types (RFC 7798 / H.265 Table 7-1). IRAP pictures (16..23) are the keyframes.
const NAL = {
  TRAIL_N: 0, TRAIL_R: 1,
  BLA_W_LP: 16, BLA_W_RADL: 17, BLA_N_LP: 18, IDR_W_RADL: 19, IDR_N_LP: 20, CRA: 21,
  VPS: 32, SPS: 33, PPS: 34, AUD: 35, SEI_PREFIX: 39, SEI_SUFFIX: 40,
};

const nalType = (nal) => (nal[0] >> 1) & 0x3f;
/** IRAP = any of BLA/IDR/CRA (types 16..21; 22/23 are reserved IRAP). A decoder can start here. */
const isKeyframe = (nal) => { const t = nalType(nal); return t >= 16 && t <= 23; };
/** VPS/SPS/PPS — the parameter sets a late joiner needs before its first IRAP. */
const isParameterSet = (nal) => { const t = nalType(nal); return t === NAL.VPS || t === NAL.SPS || t === NAL.PPS; };

/**
 * Packetizes H.265 NAL units into RTP packets. One instance per WebRTC session/track.
 *   pk = new RtpH265Packetizer({ ssrc, payloadType });
 *   const packets = pk.packetize([nal1, nal2, ...], rtpTimestamp);   // -> [Buffer, ...]
 * Single NAL unit packets (§4.4.1) for anything that fits the MTU, FU packets (§4.4.3) otherwise.
 * Aggregation packets (type 48) are deliberately not used — every receiver must accept the two above.
 */
class RtpH265Packetizer {
  constructor(opts = {}) {
    this.ssrc = (opts.ssrc >>> 0) || (Math.floor(Math.random() * 0xffffffff) >>> 0);
    this.pt = opts.payloadType != null ? opts.payloadType : 96;
    this.mtu = opts.mtu || DEFAULT_MTU;
    this.seq = (opts.seq != null ? opts.seq : Math.floor(Math.random() * 0xffff)) & 0xffff;
  }

  _nextSeq() { const s = this.seq; this.seq = (this.seq + 1) & 0xffff; return s; }

  _rtpHeader(marker, timestamp) {
    const h = Buffer.alloc(12);
    h[0] = (RTP_VERSION << 6);                 // V=2, P=0, X=0, CC=0
    h[1] = ((marker ? 1 : 0) << 7) | (this.pt & 0x7f);
    h.writeUInt16BE(this._nextSeq(), 2);
    h.writeUInt32BE(timestamp >>> 0, 4);
    h.writeUInt32BE(this.ssrc, 8);
    return h;
  }

  /** One NAL unit -> one or more RTP packets. `frameEnd` marks the last NAL of the access unit. */
  packetizeNal(nal, timestamp, frameEnd) {
    const out = [];
    if (nal.length < 2) return out;             // not a valid HEVC NAL (needs the 2-byte header)
    if (nal.length + 12 <= this.mtu) {
      // Single NAL unit packet (RFC 7798 §4.4.1): the NAL as-is, 2-byte header included.
      out.push(Buffer.concat([this._rtpHeader(frameEnd, timestamp), Buffer.from(nal)]));
      return out;
    }
    // FU fragmentation (RFC 7798 §4.4.3). PayloadHdr = the NAL's 2-byte header with Type replaced by
    // 49 (F / LayerId / TID copied through); FU header = S|E|FuType(original 6-bit type); then the NAL
    // payload WITHOUT its 2-byte header, split across fragments.
    const type = nalType(nal);
    const ph0 = (nal[0] & 0x81) | (FU_TYPE << 1);   // keep F bit + LayerId high bit, set type=49
    const ph1 = nal[1];                              // LayerId low bits + TID unchanged
    const payload = nal.subarray(2);
    const maxData = this.mtu - 12 - 3;               // RTP header (12) + PayloadHdr (2) + FU header (1)
    let offset = 0;
    while (offset < payload.length) {
      const chunk = payload.subarray(offset, Math.min(offset + maxData, payload.length));
      const isFirst = offset === 0;
      const isLast = offset + chunk.length >= payload.length;
      let fuHeader = type & 0x3f;
      if (isFirst) fuHeader |= 0x80;                 // S bit
      if (isLast) fuHeader |= 0x40;                  // E bit
      const marker = isLast && frameEnd;
      out.push(Buffer.concat([this._rtpHeader(marker, timestamp),
        Buffer.from([ph0, ph1, fuHeader]), Buffer.from(chunk)]));
      offset += chunk.length;
    }
    return out;
  }

  /** A full access unit (array of NAL units) at one timestamp -> RTP packets (last has marker=1). */
  packetize(nals, timestamp) {
    const out = [];
    nals.forEach((nal, i) => {
      const frameEnd = i === nals.length - 1;
      this.packetizeNal(nal, timestamp, frameEnd).forEach((p) => out.push(p));
    });
    return out;
  }
}

module.exports = { parseAnnexB, nalType, isKeyframe, isParameterSet, RtpH265Packetizer, NAL, FU_TYPE, CLOCK_HZ, DEFAULT_MTU };
