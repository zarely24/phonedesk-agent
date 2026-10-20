#!/usr/bin/env node
// Codec-plumbing check WITHOUT a phone or a browser: stream an Annex-B elementary stream (.h265 or .h264)
// through OUR RTP packetizer over plain UDP to a local ffmpeg, which depacketizes with its own RFC 7798 /
// RFC 6184 implementation and DECODES. If ffmpeg decodes every frame we sent, the packetizer is
// interoperable with a real receiver. Prints no secrets. Needs ffmpeg on PATH (or FFMPEG env var).
//   node tools/rtp-ffmpeg-check.js <file.h265|file.h264> [--fps 30] [--port 5004] [--mtu 1200]
// Make a test clip (no phone needed):
//   ffmpeg -f lavfi -i testsrc2=size=540x960:rate=30 -t 6 -pix_fmt yuv420p -c:v libx265 -preset ultrafast \
//     -x265-params keyint=30:repeat-headers=1:bframes=0 -f hevc test.h265
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.error('usage: node tools/rtp-ffmpeg-check.js <file.h265|file.h264> [--fps 30] [--port 5004]'); process.exit(2); }
const FPS = parseInt(getArg('--fps', '30'), 10);
const PORT = parseInt(getArg('--port', '5004'), 10);
const MTU = parseInt(getArg('--mtu', '1200'), 10);
const isH265 = /\.(h265|hevc|265)$/i.test(file);
const codec = isH265 ? require('../src/h265-rtp') : require('../src/h264-rtp');
const Packetizer = isH265 ? codec.RtpH265Packetizer : codec.RtpH264Packetizer;
const PT = isH265 ? 98 : 96;

// Split the stream into access units. A new picture starts at a VCL NAL whose first-slice flag is set
// (H.265: bit 7 of the byte after the 2-byte header; H.264: first_mb_in_slice ue(v) == 0 => first bit 1);
// parameter sets / SEI / AUD seen before it belong to that picture.
const nals = codec.parseAnnexB(fs.readFileSync(file));
const isVcl = (n) => (isH265 ? codec.nalType(n) < 32 : (codec.nalType(n) >= 1 && codec.nalType(n) <= 5));
const firstSlice = (n) => (isH265 ? (n[2] & 0x80) !== 0 : (n[1] & 0x80) !== 0);
const aus = []; let cur = []; let seenVcl = false;
for (const n of nals) {
  if (isVcl(n) && firstSlice(n) && seenVcl) { aus.push(cur); cur = []; seenVcl = false; }
  cur.push(n); if (isVcl(n)) seenVcl = true;
}
if (cur.length) aus.push(cur);
// Flush tail: RTP has no end-of-stream and ffmpeg holds its last ~20 decoded frames until more data
// arrives, so after the clip we replay its first GOP (keyframe-led, decodable). Only the ORIGINAL
// frames count toward pass/fail; the tail just pushes them out.
const isKey = (n) => (isH265 ? codec.isKeyframe(n) : codec.nalType(n) === 5);
let gop = aus.findIndex((au, k) => k > 0 && au.some(isKey)); if (gop < 1) gop = Math.min(30, aus.length);
const tail = aus.slice(0, gop);
const sequence = aus.concat(tail);
console.log(`${path.basename(file)}: ${nals.length} NAL units -> ${aus.length} access units (${isH265 ? 'H.265' : 'H.264'}), ${FPS} fps, MTU ${MTU}`);

// SDP for ffmpeg (plain RTP, no SRTP). H265 per RFC 7798, H264 per RFC 6184.
const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=pd-rtp-check', 'c=IN IP4 127.0.0.1', 't=0 0',
  `m=video ${PORT} RTP/AVP ${PT}`, `a=rtpmap:${PT} ${isH265 ? 'H265' : 'H264'}/90000`,
  isH265 ? `a=fmtp:${PT} tx-mode=SRST` : `a=fmtp:${PT} packetization-mode=1`, ''].join('\n');
const sdpPath = path.join(os.tmpdir(), `pd-rtp-check-${process.pid}.sdp`);
fs.writeFileSync(sdpPath, sdp);

// FFMPEG may name the binary or its folder (Windows env vars are case-insensitive, so a stale lowercase
// "ffmpeg=C:\...\bin" also lands here); anything that does not exist on disk falls back to PATH.
function resolveFfmpeg() {
  const env = process.env.FFMPEG; if (!env) return 'ffmpeg';
  const exe = os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const c of [env, path.join(env, exe)]) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  return 'ffmpeg';
}
// framecrc on stdout = one line per DECODED frame, written as each frame comes out: an exact count that
// does not depend on when ffmpeg prints its progress line. reorder_queue_size=0 disables the RTP jitter
// buffer (loopback never reorders) so the last frames are not held back waiting for later packets.
const ff = spawn(resolveFfmpeg(), ['-hide_banner', '-loglevel', 'warning', '-nostats',
  '-protocol_whitelist', 'file,rtp,udp', '-reorder_queue_size', '0', '-i', sdpPath, '-f', 'framecrc', '-'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let decoded = 0, errText = '', outRest = '', lastFrameAt = Date.now(), firstPts = null, lastPts = null;
ff.stdout.on('data', (d) => {
  outRest += d; const lines = outRest.split('\n'); outRest = lines.pop();
  for (const l of lines) if (/^0,\s*\d+/.test(l)) { decoded++; lastFrameAt = Date.now(); const pts = parseInt(l.split(',')[1], 10); if (firstPts == null) firstPts = pts; lastPts = pts; }
});
ff.stderr.on('data', (d) => { errText += d; });
ff.on('error', (e) => { console.error('ffmpeg failed to start:', e.message); process.exit(2); });

const sock = dgram.createSocket('udp4');
const pk = new Packetizer({ payloadType: PT, mtu: MTU, ssrc: 0x50443236 });
let sentPkts = 0, sentBytes = 0, i = 0;
const t0 = Date.now();
const START_DELAY = parseInt(getArg('--start-delay', '800'), 10);
setTimeout(() => {                                             // let ffmpeg open the socket first
  const timer = setInterval(() => {
    if (i >= sequence.length) {
      clearInterval(timer);
      // RTP has no end-of-stream: let ffmpeg drain until it has produced no new frame for 3 s (or 20 s
      // in all), then stop it. A fixed delay truncated the count whenever ffmpeg ran behind arrival.
      const doneAt = Date.now();
      const drain = setInterval(() => {
        if (Date.now() - lastFrameAt > 3000 || Date.now() - doneAt > 20000) {
          clearInterval(drain); try { sock.close(); } catch (e) {} try { ff.kill(); } catch (e) {}
        }
      }, 250);
      return;
    }
    const ts = Math.round(i * 90000 / FPS) >>> 0;
    for (const p of pk.packetize(sequence[i], ts)) { sock.send(p, PORT, '127.0.0.1'); sentPkts++; sentBytes += p.length; }
    i++;
  }, 1000 / FPS);
}, START_DELAY);

ff.on('close', () => {
  try { fs.unlinkSync(sdpPath); } catch (e) {}
  if (/^0,\s*\d+/.test(outRest)) decoded++;
  // Real decode problems only: drop the null/framecrc muxers' benign timestamp notes.
  const warnings = errText.split(/\r?\n|\r/).filter((l) => l.trim() && !/\[(null|framecrc) @/.test(l)
    && /error|missing|corrupt|invalid|Could not|no frame|discard/i.test(l)).slice(0, 8);
  const ratio = aus.length ? Math.min(decoded, aus.length) / aus.length : 0;   // tail frames don't count
  console.log(`sent: ${aus.length} access units + ${tail.length} flush-tail frames, ${sentPkts} RTP packets, ${sentBytes} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`ffmpeg decoded: ${decoded} frames (${Math.round(ratio * 100)}% of sent), first decoded frame #${firstPts == null ? '-' : firstPts}, last #${lastPts == null ? '-' : lastPts} (need 0..${aus.length - 1})`);
  if (warnings.length) { console.log('ffmpeg warnings:'); warnings.forEach((w) => console.log('   ', w.trim().slice(0, 160))); }
  const pass = decoded >= aus.length && warnings.length === 0;
  console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} - ${isH265 ? 'H.265 (RFC 7798)' : 'H.264 (RFC 6184)'} packetizer vs ffmpeg depacketizer+decoder`);
  process.exit(pass ? 0 : 1);
});
