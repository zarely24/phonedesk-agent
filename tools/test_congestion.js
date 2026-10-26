'use strict';
// v0.5.8 - unit test for src/congestion.js (the per-tunnel queue watchdog) and its wiring into
// AgentCore.openTunnel. Drives the governor with synthetic frames and a scripted bufferedAmount;
// then runs a REAL openTunnel against two fake WebSockets to prove frames are dropped / forwarded /
// keyframes forced exactly as the pure module says. No phone, no network.
// Run: node tools/test_congestion.js
const path = require('path');
const C = require(path.join(process.cwd(), 'src', 'congestion.js'));

let passed = 0, failed = 0;
function ok(cond, msg, extra) { if (cond) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } }

// ---- frame builders ---------------------------------------------------------------------------
function nal(type, len = 40) { const u = new Uint8Array(len); u[3] = 1; u[4] = type & 31; for (let i = 5; i < len; i++) u[i] = (i * 7) & 255; return u; }
const P = (len) => nal(1, len);        // non-IDR slice
const IDR = (len) => nal(5, len);
const SPS = () => nal(7, 20);
const PPS = () => nal(8, 12);
function settings(bitrate, prefixLen = 0) {
  // CommandControlMessage: [type 101][bitrate i32][maxFps i32][iFrame i8][w i16][h i16]...35 bytes
  const u = new Uint8Array(prefixLen + 36);
  const b = prefixLen;
  u[b] = 101;
  u[b + 1] = (bitrate >>> 24) & 255; u[b + 2] = (bitrate >>> 16) & 255; u[b + 3] = (bitrate >>> 8) & 255; u[b + 4] = bitrate & 255;
  u[b + 5] = 0; u[b + 6] = 0; u[b + 7] = 0; u[b + 8] = 20;   // maxFps 20
  u[b + 9] = 10;                                             // iFrameInterval
  u[b + 10] = 1; u[b + 11] = 0;                              // width 256
  u[b + 12] = 2; u[b + 13] = 42;                             // height 554
  return u;
}
function readBitrate(buf) { const a = new Uint8Array(buf); const b = a.length - 36 + 1; return ((a[b] << 24) | (a[b + 1] << 16) | (a[b + 2] << 8) | a[b + 3]) >>> 0; }

console.log('frame classification');
ok(C.isVideoFrame(P()), 'a 4-byte start code is video');
ok(C.isVideoFrame(new Uint8Array([0, 0, 1, 0x65, 1, 2])), 'a 3-byte start code is video');
ok(!C.isVideoFrame(new TextEncoder().encode('scrcpy_message....')), 'a device message (magic prefix) is not video');
ok(!C.isVideoFrame(null) && !C.isVideoFrame(new Uint8Array([0, 0])), 'null / too short is not video');
ok(C.toU8('{"json":1}') === null, 'text is never video');
ok(JSON.stringify(C.nalTypes(P())) === '[1]', 'nalTypes reads one NAL');
ok(JSON.stringify(C.nalTypes(new Uint8Array([...SPS(), ...PPS(), ...IDR()]))) === '[7,8,5]', 'nalTypes scans a message holding several NALs');
ok(C.isResyncFrame(IDR()) && C.isResyncFrame(SPS()) && C.isResyncFrame(PPS()), 'IDR / SPS / PPS are resync frames');
ok(!C.isResyncFrame(P()) && !C.isResyncFrame(nal(6)), 'P-slice and SEI are not');

console.log('settings frame capture + forced keyframe');
const sf = C.captureSettingsFrame(settings(400000).buffer);
ok(sf && sf.length === 36 && sf[0] === 101, 'captures a bare type-101 command');
const sf2 = C.captureSettingsFrame(settings(400000, 14));
ok(sf2 && sf2.length === 50, 'captures when the command is the TAIL of a longer message (ws-scrcpy batches)');
ok(C.captureSettingsFrame(P(60)) === null, 'a video frame is not a settings frame');
ok(C.captureSettingsFrame(new Uint8Array(10)) === null, 'too short is not');
const f1 = C.forceKeyframeMessage(sf, 0), f2 = C.forceKeyframeMessage(sf, 1), f3 = C.forceKeyframeMessage(sf, 2);
ok(f1 instanceof ArrayBuffer && f1.byteLength === 36, 'force message is an ArrayBuffer of the same length');
ok(readBitrate(f1) === 399999 && readBitrate(f2) === 399998 && readBitrate(f3) === 399999, 'bitrate nudged by -1 / -2 alternating (every force differs from the last)', [readBitrate(f1), readBitrate(f2), readBitrate(f3)]);
ok(new Uint8Array(f1)[8] === 20 && new Uint8Array(f1)[9] === 10 && new Uint8Array(f1)[11] === 0 && new Uint8Array(f1)[13] === 42, 'every other field is untouched');
ok(readBitrate(C.forceKeyframeMessage(sf2, 0)) === 399999 && C.forceKeyframeMessage(sf2, 0).byteLength === 50, 'works on the prefixed capture too');
ok(C.forceKeyframeMessage(null, 0) === null && C.forceKeyframeMessage(C.captureSettingsFrame(settings(5)), 0) === null, 'refuses a missing frame or an insane bitrate');
ok(sf[1] === 0 && sf[2] === 6 && sf[3] === 26 && sf[4] === 128, 'the captured copy itself is never mutated');

console.log('governor: a healthy stream is untouched');
{
  const g = new C.TunnelGovernor();
  let t = 1000, sent = 0;
  for (let i = 0; i < 200; i++) { t += 50; const r = g.onVideo(750, 0, () => false, t); if (r.send) sent++; }
  ok(sent === 200 && !g.dropping && g.events === 0, '200 frames with an empty queue all forwarded');
  ok(Math.abs(g.rateBps(t) - 15000) < 1500, 'rate estimate ~15 KB/s for 750 B at 20 fps', g.rateBps(t));
  ok(Math.abs(g.queueMs(15000, t) - 1000) < 150, 'queueMs: 15 KB queued at 15 KB/s is ~1 s', g.queueMs(15000, t));
  const s = g.stats(t);
  ok(s.dropped_frames === 0 && s.events === 0 && s.dropping === false && s.rtt_ms === null, 'stats are clean');
}

console.log('governor: congestion -> hold still -> drain -> force keyframe -> resume with no lag');
{
  const g = new C.TunnelGovernor();
  let t = 1000;
  for (let i = 0; i < 60; i++) { t += 50; g.onVideo(750, 0, () => false, t); }          // 3 s healthy at 15 KB/s
  // The line dips: the socket buffer fills (queue = 1.2 s of video).
  t += 50; let r = g.onVideo(750, 18000, () => false, t);
  ok(!r.send && r.entered && g.dropping && g.events === 1, 'first frame over the threshold is dropped and marks the entry');
  ok(!r.force, 'no keyframe is requested while the queue is still full (it would be dropped too)');
  // Still congested: everything is dropped, including a natural IDR (resuming now would rebuild the lag).
  t += 50; r = g.onVideo(9000, 17000, () => true, t);
  ok(!r.send && !r.force, 'an IDR arriving into a full queue is still dropped');
  // Within minDropMs even an empty queue does not resume (lets a burst finish).
  t += 40; r = g.onVideo(750, 0, () => true, t);
  ok(!r.send, 'minDropMs: not yet');
  // Queue drained, but only P-frames arrive: the governor asks for a keyframe, once per 1.5 s.
  t += 200; r = g.onVideo(750, 0, () => false, t);
  ok(!r.send && r.force, 'drained + no keyframe in sight = force a keyframe');
  t += 50; r = g.onVideo(750, 0, () => false, t);
  ok(!r.send && !r.force, 'a second force is rate-limited');
  t += 1500; r = g.onVideo(750, 0, () => false, t);
  ok(r.force, 'after 1.5 s it may ask again');
  // The restarted encoder's SPS arrives: resume on it.
  t += 50; r = g.onVideo(20, 0, () => true, t);
  ok(r.send && r.left && !g.dropping, 'resumes on the first resync frame once drained');
  const s = g.stats(t);
  ok(s.events === 1 && s.dropped_frames === 6 && s.forces === 2 && s.max_queue_ms > 1000, 'stats: 1 event, 6 dropped frames, 2 forces, peak queue recorded', s);
  // Back to healthy.
  t += 50; r = g.onVideo(750, 0, () => false, t);
  ok(r.send && !r.entered && !r.left, 'normal forwarding after recovery');
}

console.log('governor: byte threshold alone trips it (rate unknown)');
{
  const g = new C.TunnelGovernor();
  const r = g.onVideo(40000, 100 * 1024, () => false, 5000);
  ok(!r.send && r.entered, '100 KB queued is congestion even before a rate exists');
}

console.log('governor: pong lag alone trips it (kernel buffer invisible to bufferedAmount)');
{
  const g = new C.TunnelGovernor();
  let t = 1000;
  g.onPingSent(t); g.onPong(t + 120);                                  // baseline RTT 120 ms
  for (let i = 0; i < 40; i++) { t += 50; g.onVideo(750, 0, () => false, t); }
  ok(g.stats(t).rtt_ms === 120 && g.pongLagMs(t) === 0, 'baseline learned, no lag');
  g.onPingSent(t); g.onPong(t + 1100);                                 // 980 ms above baseline
  ok(g.pongLagMs(t + 1100) === 980, 'lag = pong time above the best RTT seen');
  t += 1150; const r = g.onVideo(750, 0, () => false, t);
  ok(!r.send && r.entered, 'congested on pong lag with an empty bufferedAmount');
  // An outstanding ping that never returns counts as growing lag.
  const g2 = new C.TunnelGovernor();
  g2.onPingSent(0); g2.onPong(100);
  g2.onPingSent(1000);
  ok(g2.pongLagMs(2500) === 1400, 'unanswered ping: lag grows with the wait', g2.pongLagMs(2500));
  ok(g2.pingDue() === false, 'no second ping while one is outstanding');
  g2.onPong(2600); ok(g2.pingDue() === true, 'pong clears it');
  // Relief needs the lag back under half the threshold too.
  g2.onPingSent(3000); g2.onPong(3000 + 100 + 500);                    // lag 500 > 400
  ok(!g2.relieved(0, 3700), 'lag 500 ms: not relieved (needs < 400)');
  g2.onPingSent(4000); g2.onPong(4000 + 100 + 50);
  ok(g2.relieved(0, 4200), 'lag 50 ms, empty queue: relieved');
}

console.log('governor: defaults are the documented ones');
ok(C.DEFAULTS.highMs === 600 && C.DEFAULTS.lowMs === 200 && C.DEFAULTS.highBytes === 96 * 1024 && C.DEFAULTS.pongHighMs === 800 && C.DEFAULTS.forceEveryMs === 1500, 'thresholds', C.DEFAULTS);

// ---- the wiring: a real openTunnel over fake sockets --------------------------------------------
console.log('AgentCore.openTunnel wiring');
{
  const made = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.bufferedAmount = 0; this._h = {}; this.binaryType = ''; made.push(this); }
    addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    on(ev, fn) { this.addEventListener(ev, fn); }
    emit(ev, e) { (this._h[ev] || []).forEach((f) => f(e)); }
    send(d) { this.sent.push(d); }
    ping() { this.pinged = (this.pinged || 0) + 1; }
    close() { this.readyState = 3; this.emit('close', {}); }
  }
  const Module = require('module');
  const realLoad = Module._load;
  // AgentCore picks `globalThis.WebSocket || require('ws')` at require time: plant ours first.
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  delete require.cache[require.resolve(path.join(process.cwd(), 'src', 'core.js'))];
  const { AgentCore } = require(path.join(process.cwd(), 'src', 'core.js'));
  globalThis.WebSocket = saved;
  Module._load = realLoad;

  const core = new AgentCore({ backend: 'http://x', wsBase: 'ws://x', wsScrcpyPort: 8000 });
  const logs = []; core.on('log', (l) => logs.push(l));
  const homeWS = new FakeWS('home'); made.length = 0;
  core.devices['SER1'] = { ws: homeWS, backoff: 1000 };
  core.openTunnel('SER1', 'tok', 'stream-abcdef0123', 'action=proxy-adb&remote=tcp%3A8886&udid=SER1');
  const [tunnel, local] = made;
  ok(tunnel && local && tunnel.url.includes('/ws/agent-stream') && local.url.includes('127.0.0.1:8000'), 'tunnel + local sockets opened');
  ok(core._openTunnels === 1 && core._governors.size === 1, 'stream counted, governor registered');

  // viewer -> phone: settings frame is captured AND forwarded
  local.sent.length = 0;
  tunnel.emit('message', { data: settings(400000).buffer });
  ok(local.sent.length === 1, 'the viewer settings command still reaches ws-scrcpy');
  // phone -> viewer: healthy frames pass; a device message passes regardless
  tunnel.sent.length = 0;
  for (let i = 0; i < 20; i++) local.emit('message', { data: P(750).buffer });
  local.emit('message', { data: new TextEncoder().encode('scrcpy_messageXYZ').buffer });
  local.emit('message', { data: '{"type":"hello"}' });
  ok(tunnel.sent.length === 22, 'all video + the device message + text forwarded when the queue is empty', tunnel.sent.length);

  // congestion: queue fills -> frames dropped, backend told, log line
  tunnel.bufferedAmount = 120 * 1024;
  tunnel.sent.length = 0; homeWS.sent.length = 0;
  for (let i = 0; i < 5; i++) local.emit('message', { data: P(750).buffer });
  ok(tunnel.sent.length === 0, 'video is held back while congested');
  const rep = homeWS.sent.map((s) => JSON.parse(s)).find((m) => m.op === 'congestion');
  ok(rep && rep.stream_id === 'stream-a' && rep.streams_open === 1 && rep.events_5m === 1 && typeof rep.queue_ms === 'number', 'backend receives ONE congestion report over the phone-home socket', homeWS.sent);
  ok(logs.some((l) => /uplink congested/.test(l)), 'congestion is logged');
  const stats = core._congestionStats(Date.now());
  ok(stats.dropping_streams === 1 && stats.events_5m === 1 && stats.streams === 1, 'host stats show one stream dropping', stats);
  // a device message still goes through while dropping
  local.emit('message', { data: new TextEncoder().encode('scrcpy_messageABC').buffer });
  ok(tunnel.sent.length === 1, 'device messages are never dropped');

  // drain: queue empties -> a keyframe is forced on ws-scrcpy (bitrate 399999), then an SPS resumes
  tunnel.bufferedAmount = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 170) { /* spin past minDropMs */ }
  local.sent.length = 0; tunnel.sent.length = 0;
  local.emit('message', { data: P(750).buffer });
  ok(local.sent.length === 1 && readBitrate(local.sent[0]) === 399999, 'a nudged settings command is sent to ws-scrcpy to force the keyframe', local.sent.map(readBitrate));
  ok(tunnel.sent.length === 0, 'the P-frame itself is still dropped');
  local.emit('message', { data: SPS().buffer });
  local.emit('message', { data: PPS().buffer });
  local.emit('message', { data: IDR(9000).buffer });
  local.emit('message', { data: P(750).buffer });
  ok(tunnel.sent.length === 4, 'SPS/PPS/IDR and the following frames flow again', tunnel.sent.length);
  ok(logs.some((l) => /video resumed after/.test(l)), 'recovery is logged');
  const hostBlock = core._hostStats();
  ok(hostBlock.congestion && hostBlock.congestion.events_5m === 1 && hostBlock.congestion.dropping_streams === 0, 'host block carries the congestion summary', hostBlock.congestion);

  // second report within 5 s is suppressed; a tunnel close unregisters
  homeWS.sent.length = 0;
  tunnel.bufferedAmount = 120 * 1024;
  local.emit('message', { data: P(750).buffer });
  ok(homeWS.sent.length === 0, 'congestion reports are rate-limited to one per 5 s per computer');
  tunnel.close();
  ok(core._governors.size === 0 && core._openTunnels === 0, 'close unregisters the governor and uncounts the stream');
  ok(tunnel.pinged === undefined || typeof tunnel.pinged === 'number', 'ping timer is harmless on a fake');

  // The viewer's FIRST settings command arrives while the local socket is still opening (it is
  // buffered). It must be captured from there too, or the first congestion of every stream would
  // have no keyframe to force.
  made.length = 0; logs.length = 0;
  core.openTunnel('SER1', 'tok', 'stream-second00', 'action=proxy-adb&remote=tcp%3A8886&udid=SER1');
  const [tun2, loc2] = made;
  loc2.readyState = 0;                                  // ws-scrcpy side not open yet
  tun2.emit('message', { data: settings(250000).buffer });
  ok(loc2.sent.length === 0, 'the command is buffered while local is opening');
  loc2.readyState = 1; loc2.emit('open', {});
  ok(loc2.sent.length === 1, '...and flushed when it opens');
  for (let i = 0; i < 20; i++) loc2.emit('message', { data: P(750).buffer });
  tun2.bufferedAmount = 120 * 1024;
  loc2.emit('message', { data: P(750).buffer });        // enter congestion
  tun2.bufferedAmount = 0;
  const t1 = Date.now(); while (Date.now() - t1 < 170) { /* past minDropMs */ }
  loc2.sent.length = 0;
  loc2.emit('message', { data: P(750).buffer });
  ok(loc2.sent.length === 1 && readBitrate(loc2.sent[0]) === 249999, 'a keyframe is forced from the settings command captured out of the pre-open buffer', loc2.sent.map(readBitrate));
  ok(!logs.some((l) => /no settings frame seen yet/.test(l)), 'no "no settings frame" complaint');
  tun2.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
