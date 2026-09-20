// PhoneDesk agent WebRTC sender (POC). OFFERER side: for each viewer session the backend opens
// (op:'open_webrtc'), we start a scrcpy H.264 feed for that phone, wrap it in a WebRTC video track,
// and send an SDP offer up the existing agent home socket. Media then flows SRTP directly to the
// browser (via coturn when P2P is blocked — the farm is Starlink/CGNAT). NO re-encode: scrcpy's
// server already H.264-encodes on the phone (MediaCodec); we only packetize NAL units into RTP.
//
// ⚠️ POC — this module MUST be run and iterated on the OWNER'S HOST with a real phone. It cannot be
// verified in the PhoneDesk dev environment (no /dev phone). Expect 1–2 iterations: run it, watch
// the agent log + the browser's WebRTC stats overlay, and tune. Dependency: `npm i werift`.
'use strict';
const { spawn, execFileSync } = require('child_process');
let werift = null;
try { werift = require('werift'); } catch (e) { /* installed lazily; see startWebRtc guard */ }

// scrcpy server pushed to the phone. Bundle a known-good scrcpy-server jar with the agent build and
// point SCRCPY_SERVER at it; the version must match the scrcpy protocol the reader below expects.
const SCRCPY_SERVER = process.env.SCRCPY_SERVER || '';          // path to scrcpy-server.jar
const SCRCPY_VER = process.env.SCRCPY_VERSION || '2.4';

// One live session per viewer: session_id -> { pc, scrcpy, track, serial }
const sessions = new Map();

/** Two-quality profiles (spec §7). Focused when a VA opens the phone; thumbnail otherwise. */
const PROFILES = {
  focused:  { maxSize: 1080, bitrate: 6000000, maxFps: 30 },   // 1080p / 6 Mbps / 30fps
  thumbnail:{ maxSize: 540,  bitrate: 800000,  maxFps: 15 },   // 540p  / 0.8 Mbps / 15fps
};

function log(agent, ...a) { try { agent.emit('log', '[webrtc] ' + a.join(' ')); } catch (e) { console.log('[webrtc]', ...a); } }

/**
 * Start scrcpy's server on the phone and return a readable stream of raw H.264 (Annex-B).
 * Uses `adb reverse`/`forward` + the scrcpy control protocol. THIS IS THE PART TO VERIFY ON A PHONE:
 * scrcpy server args/handshake vary by version — align SCRCPY_VERSION + SCRCPY_SERVER with the jar
 * you ship. Returns { proc, socket } where socket emits H.264 buffers.
 */
function startScrcpyH264(adbPath, serial, profile) {
  const p = PROFILES[profile] || PROFILES.focused;
  // Push + run scrcpy-server, video only, no control (control stays on the existing agent path).
  execFileSync(adbPath, ['-s', serial, 'push', SCRCPY_SERVER, '/data/local/tmp/scrcpy-server.jar']);
  const args = ['-s', serial, 'shell',
    `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server ${SCRCPY_VER}`,
    'tunnel_forward=true', 'audio=false', 'control=false', 'cleanup=true',
    `max_size=${p.maxSize}`, `video_bit_rate=${p.bitrate}`, `max_fps=${p.maxFps}`,
    'video_codec=h264', 'send_frame_meta=false'];
  const proc = spawn(adbPath, args);
  // The server opens a local abstract socket; forward it and connect to read H.264.
  // (Implementation detail to finish on-host: `adb forward tcp:<port> localabstract:scrcpy`, then a
  //  net.Socket to 127.0.0.1:<port>. proc.stdout carries logs. The H.264 bytes come off that socket.)
  return { proc };
}

/** Handle op:'open_webrtc' from the backend: create the PeerConnection + offer for one viewer. */
async function open(agent, ws, serial, msg) {
  if (!werift) { try { werift = require('werift'); } catch (e) { log(agent, 'werift not installed — run `npm i werift`'); return; } }
  const { RTCPeerConnection } = werift;
  const sessionId = msg.session_id;
  const iceServers = (msg.iceServers || []).map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));
  const pc = new RTCPeerConnection({ iceServers });

  // H.264 sendonly track fed from scrcpy. werift: create a MediaStreamTrack(kind:'video') and
  // `track.writeRtp(...)` with RTP packets you packetize from scrcpy's NAL units (FU-A for big NALs,
  // STAP-A for SPS/PPS). This packetization is the #1 thing to get right on-host.
  const track = new werift.MediaStreamTrack({ kind: 'video' });
  pc.addTransceiver(track, { direction: 'sendonly' });

  const scrcpy = startScrcpyH264(agent.adbPath, serial, 'focused');
  // TODO(on-host): wire scrcpy H.264 -> RTP -> track.writeRtp(pkt). See design docs/webrtc-poc.md.

  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) sendSig(ws, { op: 'rtc_ice', session_id: sessionId, candidate });
  });
  pc.connectionStateChange.subscribe((st) => log(agent, `session ${sessionId} pc=${st}`));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSig(ws, { op: 'rtc_offer', session_id: sessionId, sdp: pc.localDescription.sdp });

  sessions.set(sessionId, { pc, scrcpy, track, serial });
  log(agent, `open_webrtc session=${sessionId} serial=${serial}`);
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
  try { s.pc.close(); } catch (e) {}
  try { s.scrcpy && s.scrcpy.proc && s.scrcpy.proc.kill(); } catch (e) {}
  log(agent, `close_webrtc session=${msg.session_id}`);
}

function sendSig(ws, obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch (e) {} }

module.exports = { open, answer, ice, close, sessions, PROFILES };
