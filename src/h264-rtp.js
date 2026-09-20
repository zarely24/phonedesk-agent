// H.264 Annex-B NAL parsing + RTP packetization (RFC 6184 / RFC 3550). Pure, hardware-independent,
// and unit-tested (tools/test_rtp.js) with synthetic H.264 — this is the codec plumbing between
// scrcpy's H.264 and the werift video track. No decode/re-encode: we only reframe NAL units into RTP.
'use strict';

const RTP_VERSION = 2;
const CLOCK_HZ = 90000;          // H.264 RTP clock
const DEFAULT_MTU = 1200;        // safe SRTP payload size (leaves room under ~1500 MTU)

// NAL unit types (nal[0] & 0x1f)
const NAL = { NON_IDR: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 };

/** Split an Annex-B buffer into NAL units (without the 000001/00000001 start codes). */
function parseAnnexB(buf) {
  const nals = [];
  let i = 0; const n = buf.length;
  // find first start code
  let start = findStart(buf, 0);
  while (start.idx !== -1) {
    const nalStart = start.idx + start.len;
    const next = findStart(buf, nalStart);
    const nalEnd = next.idx === -1 ? n : next.idx;
    if (nalEnd > nalStart) nals.push(buf.subarray(nalStart, nalEnd));
    start = next;
  }
  return nals;
}
function findStart(buf, from) {
  for (let i = from; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return { idx: i, len: 3 };
      if (i + 4 <= buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) return { idx: i, len: 4 };
    }
  }
  return { idx: -1, len: 0 };
}

const nalType = (nal) => nal[0] & 0x1f;
const isKeyframe = (nal) => nalType(nal) === NAL.IDR;

/**
 * Packetizes H.264 NAL units into RTP packets. One instance per WebRTC session/track.
 *   pk = new RtpH264Packetizer({ ssrc, payloadType });
 *   const packets = pk.packetize([nal1, nal2, ...], rtpTimestamp);   // -> [Buffer, ...]
 * The caller sets `marker` correctly via `frameEnd` (last packet of an access unit gets marker=1).
 */
class RtpH264Packetizer {
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
    if (nal.length + 12 <= this.mtu) {
      // Single NAL unit packet (RFC 6184 §5.6). marker only on the last packet of the frame.
      out.push(Buffer.concat([this._rtpHeader(frameEnd, timestamp), Buffer.from(nal)]));
      return out;
    }
    // FU-A fragmentation (RFC 6184 §5.8): split the NAL payload, keep the 1-byte NAL header info.
    const nalHeader = nal[0];
    const nri = nalHeader & 0x60;
    const type = nalHeader & 0x1f;
    const payload = nal.subarray(1);
    const maxData = this.mtu - 12 - 2;         // minus RTP header (12) + FU indicator+header (2)
    let offset = 0;
    while (offset < payload.length) {
      const chunk = payload.subarray(offset, Math.min(offset + maxData, payload.length));
      const isFirst = offset === 0;
      const isLast = offset + chunk.length >= payload.length;
      const fuIndicator = (0 << 7) | nri | 28;             // FU-A type = 28
      let fuHeader = type & 0x1f;
      if (isFirst) fuHeader |= 0x80;                        // S bit
      if (isLast) fuHeader |= 0x40;                         // E bit
      const marker = isLast && frameEnd;
      out.push(Buffer.concat([this._rtpHeader(marker, timestamp),
        Buffer.from([fuIndicator, fuHeader]), Buffer.from(chunk)]));
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

/** Convert a scrcpy PTS (microseconds) to a 90 kHz RTP timestamp (wrapping 32-bit). */
function ptsToRtp(ptsUs) { return Math.round((ptsUs % (2 ** 32 / 90 * 1000)) * CLOCK_HZ / 1e6) >>> 0; }

module.exports = { parseAnnexB, nalType, isKeyframe, RtpH264Packetizer, ptsToRtp, NAL, CLOCK_HZ, DEFAULT_MTU };
