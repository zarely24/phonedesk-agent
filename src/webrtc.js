// PhoneDesk agent WebRTC sender (POC). OFFERER side. For each viewer session the backend opens
// (op:'open_webrtc') we capture the phone's encoded video, parse it into NAL units, RTP-packetize them
// and push them onto a werift video track. Media then flows SRTP directly to the browser (via coturn on
// CGNAT). No decode/re-encode — the phone's MediaCodec output is passed through untouched.
//
// Two capture paths, picked by the codec that gets NEGOTIATED with the browser:
//   H.264 — the SAME scrcpy-server the project already ships (v1.19-ws7, ws-scrcpy's jar), frame-meta
//           protocol, src/h264-rtp.js (RFC 6184). This is the original POC path and stays the default.
//   H.265 — a modern scrcpy server (v5.0.1, resources/scrcpy/) asked for video_codec=h265, decoded by
//           src/scrcpy-capture.js, packetized by src/h265-rtp.js (RFC 7798). Roughly 30-40% fewer bits
//           for the same picture, which is the whole point on the farm's starved uplink.
//
// WEBRTC_CODEC selects what we OFFER:
//   unset / 'h264'  — offer H.264 only, legacy jar, capture starts before the offer (unchanged behaviour)
//   'h265'          — offer H.265 first, H.264 second; capture starts AFTER the answer, with whichever
//                     codec the browser accepted (a browser without HEVC decode silently gets H.264)
//   'h265-only'     — offer H.265 only (test what a given browser/phone really does; no H.264 safety net)
//
// The capture path (scrcpy launch args / socket handshake) is verified by tools/webrtc-diagnose.js on
// the OWNER'S host; the codec plumbing (parse + packetize) is unit-tested locally (tools/test_rtp.js,
// tools/test_h265_rtp.js) and checked against ffmpeg's depacketizers (tools/rtp-ffmpeg-check.js).
'use strict';
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const h264 = require('./h264-rtp');
const h265 = require('./h265-rtp');
const scrcpy5 = require('./scrcpy-capture');
const { parseAnnexB, nalType, isKeyframe, RtpH264Packetizer, NAL } = h264;

let werift = null;
try { werift = require('werift'); } catch (e) { /* loaded lazily; guarded in open() */ }

const SCRCPY_VERSION = '1.19-ws7';
const DEVICE_NAME_LEN = 64;      // scrcpy 1.x: 64-byte device name after a 1-byte dummy on the socket
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
// the jar this project already ships (matches ws-scrcpy) — resolved relative to the agent resources
function bundledJar() {
  return process.env.SCRCPY_SERVER ||
    path.join(__dirname, '..', 'resources', 'ws-scrcpy', 'vendor', 'Genymobile', 'scrcpy', 'scrcpy-server.jar');
}

const PROFILES = {
  focused:  { maxSize: 1080, bitRate: 6000000, maxFps: 30 },
  thumbnail:{ maxSize: 540,  bitRate: 800000,  maxFps: 15 },
};

/** What to offer, from WEBRTC_CODEC (see header). Returns 'h264' | 'h265' | 'h265-only'. */
function codecMode() {
  const v = String(process.env.WEBRTC_CODEC || '').trim().toLowerCase();
  if (v === 'h265' || v === 'hevc') return 'h265';
  if (v === 'h265-only' || v === 'hevc-only') return 'h265-only';
  return 'h264';
}

/** werift codec descriptions. The browser answers with the first one it can decode. Chrome offers HEVC
    itself with profile-id=1 (Main), tier-flag=0 and tx-mode=SRST; level-id 120 = level 4.0 (1080p30 fits
    with room) so any HEVC-capable receiver accepts it. H.264: constrained baseline, packetization-mode 1
    (FU-A), which is what MediaCodec's Annex-B output maps to. */
function codecParams(mode) {
  const fb = [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }];
  const H265 = new werift.RTCRtpCodecParameters({ mimeType: 'video/H265', clockRate: 90000, rtcpFeedback: fb,
    parameters: 'level-id=120;profile-id=1;tier-flag=0;tx-mode=SRST' });
  const H264 = new werift.RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: fb,
    parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' });
  if (mode === 'h265-only') return [H265];
  if (mode === 'h265') return [H265, H264];
  return [new werift.RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: fb })];
}

const sessions = new Map();   // session_id -> { pc, capture, track, packetizer, serial, stats, codec }

function log(agent, ...a) { try { agent.emit('log', '[webrtc] ' + a.join(' ')); } catch (e) { console.log('[webrtc]', ...a); } }

/**
 * Launch scrcpy-server (1.19-ws7, H.264) on the phone and connect to its video socket. Returns an
 * EventEmitter-ish object emitting parsed H.264 access units. `onNalUnits(nals, ptsUs, keyframe)` and
 * `onError` are callbacks. Uses `adb forward` + the scrcpy 1.19 frame-meta protocol (send_frame_meta=true):
 *   [1 byte dummy][64 byte device name] then repeated [8B pts | 4B len][H.264 payload].
 */
function startCapture(adbPath, serial, profile, cbs) {
  const p = PROFILES[profile] || PROFILES.focused;
  const port = 27000 + Math.floor(Math.random() * 2000);
  const scid = 'scrcpy_pd_' + Math.random().toString(16).slice(2, 8);
  let proc = null, sock = null, buf = Buffer.alloc(0), gotHeader = false, closed = false;

  const run = (args, cb) => execFile(adbPath, ['-s', serial, ...args], { maxBuffer: 4 * 1024 * 1024 }, cb);

  run(['push', bundledJar(), REMOTE_JAR], (err) => {
    if (err) return cbs.onError && cbs.onError(new Error('adb push jar: ' + err.message));
    // scrcpy 1.19-ws7 positional args (ws-scrcpy launches it this way): version, then options.
    // send_frame_meta=true so we can split access units; control=false (control stays on legacy path).
    const server = ['shell',
      `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
      'web', // ws7 "mode" arg
      String(p.bitRate), String(p.maxFps), String(p.maxSize),
      'true',   // tunnel_forward
      '-',      // crop (none)
      'true',   // send_frame_meta
      String(scid)];
    proc = spawn(adbPath, ['-s', serial, ...server]);
    proc.stdout.on('data', (d) => log(cbs.agent, 'scrcpy:', String(d).trim().slice(0, 200)));
    proc.stderr.on('data', (d) => log(cbs.agent, 'scrcpy!', String(d).trim().slice(0, 200)));
    proc.on('exit', (c) => { if (!closed) cbs.onError && cbs.onError(new Error('scrcpy exited ' + c)); });

    // forward the abstract socket and connect once scrcpy has opened it
    setTimeout(() => {
      run(['forward', `tcp:${port}`, `localabstract:${scid}`], (e2) => {
        if (e2) return cbs.onError && cbs.onError(new Error('adb forward: ' + e2.message));
        sock = net.connect(port, '127.0.0.1', () => log(cbs.agent, 'video socket connected'));
        sock.on('data', (chunk) => onData(chunk));
        sock.on('error', (e) => cbs.onError && cbs.onError(e));
        sock.on('close', () => { if (!closed) cbs.onError && cbs.onError(new Error('video socket closed')); });
      });
    }, 700);
  });

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!gotHeader) {
      if (buf.length < 1 + DEVICE_NAME_LEN) return;
      // 1 dummy byte + 64-byte device name (scrcpy 1.x). Skip them.
      buf = buf.subarray(1 + DEVICE_NAME_LEN);
      gotHeader = true;
    }
    // frame-meta loop: [8B pts][4B len][payload]
    while (buf.length >= 12) {
      const ptsRaw = buf.readBigUInt64BE(0);
      const len = buf.readUInt32BE(8);
      if (buf.length < 12 + len) break;
      const payload = buf.subarray(12, 12 + len);
      buf = buf.subarray(12 + len);
      const CONFIG = (ptsRaw >> 63n) & 1n;   // top bit = config packet (SPS/PPS) in scrcpy 1.x
      const ptsUs = Number(ptsRaw & 0x7fffffffffffffffn);
      const nals = parseAnnexB(payload);
      const keyframe = nals.some(isKeyframe) || CONFIG === 1n;
      cbs.onNalUnits && cbs.onNalUnits(nals, ptsUs, keyframe, len);
    }
  }

  return {
    stop() {
      closed = true;
      try { sock && sock.destroy(); } catch (e) {}
      try { proc && proc.kill(); } catch (e) {}
      execFile(adbPath, ['-s', serial, 'forward', '--remove', `tcp:${port}`], () => {});
    },
  };
}

async function open(agent, ws, serial, msg) {
  // Agent-side safety flags (defense in depth; the backend also gates via WEBRTC_DEVICE_IDS):
  // WebRTC is OPT-IN and dormant by default — it runs ONLY when WEBRTC_ENABLED is explicitly
  // truthy (1/true/yes/on). Absent or anything else => dormant (spec: WebRTC OFF by default).
  // WEBRTC_TEST_DEVICE then pins WebRTC to ONE phone's serial.
  const enabled = /^(1|true|yes|on)$/i.test(String(process.env.WEBRTC_ENABLED || '').trim());
  if (!enabled) { log(agent, 'WEBRTC disabled by default (WEBRTC_ENABLED not set truthy) — ignoring open_webrtc'); return; }
  const testSerial = process.env.WEBRTC_TEST_DEVICE || '';
  if (testSerial && serial !== testSerial) { log(agent, `open_webrtc for ${serial} ignored — not the test device (${testSerial})`); return; }
  if (!werift) { try { werift = require('werift'); } catch (e) { log(agent, 'werift not installed — run `npm i werift`'); return; } }
  const sessionId = msg && msg.session_id;
  if (!sessionId) return;
  try {
    await _open(agent, ws, serial, msg, sessionId);
  } catch (e) {
    // FAILURE ISOLATION (spec §5): a broken WebRTC session must never crash the agent or touch
    // another phone. Clean up whatever we created and stop — the browser falls back to legacy.
    log(agent, `open_webrtc session=${sessionId} FAILED, isolated: ${e && e.message}`);
    try { close(agent, { session_id: sessionId }); } catch (e2) {}
  }
}

/** Start the H.264 capture (legacy 1.19-ws7 jar) feeding a session's track. */
function startH264(agent, s, sessionId) {
  const { track, stats } = s;
  const packetizer = new RtpH264Packetizer({ payloadType: 96 });
  s.packetizer = packetizer; s.codec = 'h264';
  let lastConfig = [];   // remember SPS/PPS to prepend to keyframes so a late joiner decodes
  // Called through module.exports so diagnostics/tests can swap the capture without touching adb.
  s.capture = module.exports.startCapture(agent.adbPath, s.serial, 'focused', {
    agent,
    onNalUnits(nals, ptsUs, keyframe) {
      const ts = Math.round(ptsUs * 90000 / 1e6) >>> 0;
      for (const n of nals) {
        const t = nalType(n);
        if (t === NAL.SPS) { stats.sps = true; lastConfig = [n]; }
        if (t === NAL.PPS) { stats.pps = true; lastConfig.push(n); }
        if (t === NAL.IDR) stats.idr = true;
      }
      let toSend = nals;
      if (keyframe && stats.sps && stats.pps && !nals.some((n) => nalType(n) === NAL.SPS)) toSend = lastConfig.concat(nals);
      const packets = packetizer.packetize(toSend, ts);
      for (const pkt of packets) { try { track.writeRtp(pkt); stats.rtp++; stats.bytes += pkt.length; } catch (e) {} }
      stats.nals += nals.length; if (keyframe) stats.keyframes++;
    },
    onError(e) {
      log(agent, `session ${sessionId} capture error: ${e && e.message}`);
      // Isolated teardown: scrcpy/socket died -> close this session only; browser falls back to legacy.
      try { close(agent, { session_id: sessionId }); } catch (e2) {}
    },
  });
}

/** Start the H.265 capture (scrcpy 5.0.1, video_codec=h265) feeding a session's track. */
function startH265(agent, s, sessionId) {
  const { track, stats } = s;
  const packetizer = new h265.RtpH265Packetizer({ payloadType: 98 });
  s.packetizer = packetizer; s.codec = 'h265';
  const p = PROFILES.focused;
  const bitRate = parseInt(process.env.WEBRTC_BITRATE || '', 10) || p.bitRate;
  let lastConfig = [];   // VPS/SPS/PPS from the config packet; prepended to every IRAP for late joiners
  let lastTs = 0;
  s.capture = scrcpy5.startCapture(agent.adbPath, s.serial, { codec: 'h265', maxSize: p.maxSize, bitRate, maxFps: p.maxFps }, {
    agent,
    onSession(info) { stats.width = info.width; stats.height = info.height; log(agent, `session ${sessionId} h265 ${info.width}x${info.height}`); },
    onNalUnits(nals, ptsUs, keyframe, len, config) {
      for (const n of nals) {
        const t = h265.nalType(n);
        if (t === h265.NAL.VPS) { stats.vps = true; lastConfig = [n]; }
        else if (t === h265.NAL.SPS) { stats.sps = true; lastConfig.push(n); }
        else if (t === h265.NAL.PPS) { stats.pps = true; lastConfig.push(n); }
        else if (h265.isKeyframe(n)) stats.idr = true;
      }
      // MediaCodec emits VPS/SPS/PPS as a separate config packet (pts 0) right before the first IRAP.
      // Don't send it alone with a bogus timestamp: hold it and send it WITH the keyframe.
      if (config) { stats.nals += nals.length; return; }
      const ts = Math.round(ptsUs * 90000 / 1e6) >>> 0; lastTs = ts;
      let toSend = nals;
      if (keyframe && lastConfig.length && !nals.some(h265.isParameterSet)) toSend = lastConfig.concat(nals);
      const packets = packetizer.packetize(toSend, ts);
      for (const pkt of packets) { try { track.writeRtp(pkt); stats.rtp++; stats.bytes += pkt.length; } catch (e) {} }
      stats.nals += nals.length; if (keyframe) stats.keyframes++;
    },
    onError(e) {
      log(agent, `session ${sessionId} h265 capture error: ${e && e.message}`);
      try { close(agent, { session_id: sessionId }); } catch (e2) {}
    },
  });
}

async function _open(agent, ws, serial, msg, sessionId) {
  const { RTCPeerConnection, MediaStreamTrack } = werift;
  const mode = codecMode();
  const iceServers = (msg.iceServers || []).map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));
  const pc = new RTCPeerConnection({ iceServers, codecs: { video: codecParams(mode) } });

  const track = new MediaStreamTrack({ kind: 'video' });
  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
  const stats = { nals: 0, keyframes: 0, rtp: 0, bytes: 0, vps: false, sps: false, pps: false, idr: false };
  const s = { pc, transceiver, capture: null, track, packetizer: null, serial, stats, codec: null, mode };
  sessions.set(sessionId, s);

  // Legacy behaviour (H.264 only): start capturing before the offer so SPS/PPS are cached by the time
  // the browser connects. With H.265 on the table we must WAIT for the answer: the capture codec is
  // whatever the browser accepted, and starting the wrong scrcpy server would waste a phone encoder.
  if (mode === 'h264') startH264(agent, s, sessionId);

  pc.onIceCandidate.subscribe((c) => { if (c) sendSig(ws, { op: 'rtc_ice', session_id: sessionId, candidate: c }); });
  pc.iceConnectionStateChange.subscribe((st) => log(agent, `session ${sessionId} ice=${st}`));
  pc.connectionStateChange.subscribe((st) => {
    log(agent, `session ${sessionId} pc=${st}`);
    if (st === 'failed' || st === 'closed' || st === 'disconnected') { try { close(agent, { session_id: sessionId }); } catch (e) {} }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSig(ws, { op: 'rtc_offer', session_id: sessionId, sdp: pc.localDescription.sdp });
  log(agent, `open_webrtc session=${sessionId} serial=${serial} offer=${mode} (scrcpy ${mode === 'h264' ? SCRCPY_VERSION : scrcpy5.SERVER_VERSION + '/' + SCRCPY_VERSION})`);
}

async function answer(agent, msg) {
  const s = sessions.get(msg.session_id); if (!s) return;
  try { await s.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
  catch (e) {
    // A rejected m-line (browser could decode none of what we offered) lands here. Close so the
    // browser's fallback timer takes it to the legacy stream instead of waiting on a dead session.
    log(agent, `session ${msg.session_id} answer not usable (${e.message}) — closing, browser falls back to legacy`);
    try { close(agent, { session_id: msg.session_id }); } catch (e2) {}
    return;
  }
  if (s.capture) return;                                   // legacy mode already capturing
  // A browser that can decode nothing we offered REJECTS the m-line (port 0) but may still echo a
  // payload type on it, so check the port before trusting the codec list.
  if (/^m=video 0(\s|$)/m.test(String(msg.sdp || ''))) {
    log(agent, `session ${msg.session_id} browser rejected the video m-line — no common codec; closing, browser falls back to legacy`);
    try { close(agent, { session_id: msg.session_id }); } catch (e) {}
    return;
  }
  // What did the browser accept? werift narrows transceiver.codecs to the negotiated set, best first.
  const negotiated = (s.transceiver.codecs || [])[0];
  const name = negotiated ? String(negotiated.mimeType || '').toLowerCase() : '';
  if (name.includes('h265')) { log(agent, `session ${msg.session_id} negotiated H.265 (pt ${negotiated.payloadType})`); startH265(agent, s, msg.session_id); }
  else if (name.includes('h264')) { log(agent, `session ${msg.session_id} negotiated H.264 (pt ${negotiated.payloadType}) — browser declined H.265`); startH264(agent, s, msg.session_id); }
  else { log(agent, `session ${msg.session_id} no usable video codec in the answer (${name || 'none'}) — closing, browser falls back to legacy`); try { close(agent, { session_id: msg.session_id }); } catch (e) {} }
}
async function ice(agent, msg) {
  const s = sessions.get(msg.session_id); if (!s || !msg.candidate) return;
  try { await s.pc.addIceCandidate(msg.candidate); } catch (e) { log(agent, 'addIce err', e.message); }
}
function close(agent, msg) {
  const s = sessions.get(msg.session_id); if (!s) return;
  sessions.delete(msg.session_id);
  try { s.capture && s.capture.stop(); } catch (e) {}
  try { s.pc.close(); } catch (e) {}
  log(agent, `close_webrtc session=${msg.session_id} codec=${s.codec || 'none'} (rtp=${s.stats.rtp} kf=${s.stats.keyframes} bytes=${s.stats.bytes})`);
}
function sendSig(ws, obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch (e) {} }

module.exports = { open, answer, ice, close, sessions, PROFILES, startCapture, bundledJar, SCRCPY_VERSION, codecMode, codecParams };
