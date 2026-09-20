// PhoneDesk agent WebRTC sender (POC). OFFERER side. For each viewer session the backend opens
// (op:'open_webrtc') we capture the phone's H.264 with the SAME scrcpy-server the project already
// ships (v1.19-ws7, resources/ws-scrcpy/vendor/Genymobile/scrcpy/scrcpy-server.jar), parse its
// frame-meta protocol into NAL units, RTP-packetize them (src/h264-rtp.js — unit-tested), and push
// them onto a werift H.264 track. Media then flows SRTP directly to the browser (via coturn on CGNAT).
// No decode/re-encode — the phone's MediaCodec H.264 is passed through untouched.
//
// The capture path (scrcpy launch args / socket handshake) is verified by tools/webrtc-diagnose.js on
// the OWNER'S host; the codec plumbing (parse + packetize) is unit-tested locally.
'use strict';
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { parseAnnexB, nalType, isKeyframe, RtpH264Packetizer, NAL } = require('./h264-rtp');

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

const sessions = new Map();   // session_id -> { pc, capture, track, packetizer, serial, stats }

function log(agent, ...a) { try { agent.emit('log', '[webrtc] ' + a.join(' ')); } catch (e) { console.log('[webrtc]', ...a); } }

/**
 * Launch scrcpy-server on the phone and connect to its video socket. Returns an EventEmitter-ish
 * object emitting parsed H.264 access units. `onNalUnits(nals, ptsUs, keyframe)` and `onError` are
 * callbacks. Uses `adb forward` + the scrcpy 1.19 frame-meta protocol (send_frame_meta=true):
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

async function _open(agent, ws, serial, msg, sessionId) {
  const { RTCPeerConnection, MediaStreamTrack } = werift;
  const iceServers = (msg.iceServers || []).map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));
  const pc = new RTCPeerConnection({ iceServers, codecs: { video: [new werift.RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }] })] } });

  const track = new MediaStreamTrack({ kind: 'video' });
  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
  const stats = { nals: 0, keyframes: 0, rtp: 0, bytes: 0, sps: false, pps: false, idr: false };
  const packetizer = new RtpH264Packetizer({ payloadType: 96 });
  let lastConfig = [];   // remember SPS/PPS to prepend to keyframes so a late joiner decodes

  const capture = startCapture(agent.adbPath, serial, 'focused', {
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

  pc.onIceCandidate.subscribe((c) => { if (c) sendSig(ws, { op: 'rtc_ice', session_id: sessionId, candidate: c }); });
  pc.iceConnectionStateChange.subscribe((s) => log(agent, `session ${sessionId} ice=${s}`));
  pc.connectionStateChange.subscribe((s) => {
    log(agent, `session ${sessionId} pc=${s}`);
    if (s === 'failed' || s === 'closed' || s === 'disconnected') { try { close(agent, { session_id: sessionId }); } catch (e) {} }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSig(ws, { op: 'rtc_offer', session_id: sessionId, sdp: pc.localDescription.sdp });
  sessions.set(sessionId, { pc, capture, track, packetizer, serial, stats });
  log(agent, `open_webrtc session=${sessionId} serial=${serial} (scrcpy ${SCRCPY_VERSION})`);
}

async function answer(agent, msg) {
  const s = sessions.get(msg.session_id); if (!s) return;
  try { await s.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); } catch (e) { log(agent, 'setRemote err', e.message); }
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
  log(agent, `close_webrtc session=${msg.session_id} (rtp=${s.stats.rtp} kf=${s.stats.keyframes})`);
}
function sendSig(ws, obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch (e) {} }

module.exports = { open, answer, ice, close, sessions, PROFILES, startCapture, bundledJar, SCRCPY_VERSION };
