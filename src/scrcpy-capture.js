// Raw video capture from a MODERN scrcpy server (>= 2.0; we bundle 5.0.1) - the path that can ask the
// phone's MediaCodec for H.265. The legacy ws-scrcpy jar (1.19-ws7, src/webrtc.js startCapture) only
// speaks H.264. Both can run on the same phone at the same time: each is its own app_process with its
// own abstract socket, and MediaCodec happily runs two encoders.
//
// Wire protocol (scrcpy 5.0.1 server, server/src/main/java/com/genymobile/scrcpy/device/{DesktopConnection,
// Streamer}.java - read at the tag, not guessed):
//   app_process / com.genymobile.scrcpy.Server 5.0.1 key=value ...   (first arg MUST equal the jar version)
//   video socket (forward tunnel, abstract name "scrcpy_%08x" of scid):
//     [1 byte dummy 0]                   send_dummy_byte=true
//     [64 bytes device name, NUL-padded] send_device_meta=true
//     [u32 BE codec id]                  send_stream_meta=true  ("h264"=0x68323634, "h265"=0x68323635)
//     then records, each a 12-byte header (+ payload for media):
//       session record: u32 flags (bit31 = 1, bit0 = client-resize) | u32 width | u32 height   (no payload)
//       media record:   u64 ptsAndFlags (bit62 = config/VPS-SPS-PPS, bit61 = key frame) | u32 size | payload
//     The two are told apart by the TOP BIT of byte 0: session = 1, media = 0 (a PTS never has bit 63 set).
'use strict';
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const SERVER_VERSION = '5.0.1';
const REMOTE_JAR = '/data/local/tmp/scrcpy-server-pd5.jar';   // NOT ws-scrcpy's path, so the two never clash
const DEVICE_NAME_LEN = 64;
const CODEC_IDS = { 0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1' };
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEYFRAME = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;

/** The modern server jar this project ships (resources/scrcpy/). Overridable for diagnostics. */
function bundledJar() {
  return process.env.SCRCPY5_SERVER ||
    path.join(__dirname, '..', 'resources', 'scrcpy', 'scrcpy-server-v' + SERVER_VERSION);
}

/**
 * Launch the modern scrcpy server with `video_codec=<codec>` and connect to its video socket.
 * opts: { codec: 'h265'|'h264', maxSize, bitRate, maxFps, encoder? }
 * cbs:  { agent?, onNalUnits(nals, ptsUs, keyframe, len, config), onSession({width,height,codec}), onError(err) }
 * Returns { stop() }. Everything is async (no execFileSync) - the agent process is also the video relay.
 */
function startCapture(adbPath, serial, opts, cbs) {
  const o = Object.assign({ codec: 'h265', maxSize: 1080, bitRate: 6000000, maxFps: 30 }, opts || {});
  const parseAnnexB = require(o.codec === 'h265' ? './h265-rtp' : './h264-rtp').parseAnnexB;
  const port = 29000 + Math.floor(Math.random() * 2000);
  const scid = Math.floor(Math.random() * 0x7fffffff);               // the server formats it as _%08x
  const socketName = 'scrcpy_' + scid.toString(16).padStart(8, '0');
  let proc = null, sock = null, buf = Buffer.alloc(0), stage = 0, closed = false, codecName = null;
  const log = (m) => { try { cbs.agent && cbs.agent.emit('log', '[scrcpy5] ' + m); } catch (e) {} };
  const fail = (e) => { if (!closed) { closed = true; cbs.onError && cbs.onError(e); } };
  const run = (args, cb) => execFile(adbPath, ['-s', serial, ...args], { maxBuffer: 4 * 1024 * 1024 }, cb);

  run(['push', bundledJar(), REMOTE_JAR], (err) => {
    if (err) return fail(new Error('adb push scrcpy5 jar: ' + err.message));
    const kv = [
      'scid=' + scid.toString(16), 'log_level=warn', 'audio=false', 'control=false', 'tunnel_forward=true',
      'video_codec=' + o.codec, 'video_bit_rate=' + o.bitRate, 'max_fps=' + o.maxFps, 'max_size=' + o.maxSize,
      'send_device_meta=true', 'send_dummy_byte=true', 'send_stream_meta=true', 'send_frame_meta=true',
      'cleanup=true', 'power_on=true', 'clipboard_autosync=false',
    ];
    if (o.encoder) kv.push('video_encoder=' + o.encoder);
    proc = spawn(adbPath, ['-s', serial, 'shell', 'CLASSPATH=' + REMOTE_JAR, 'app_process', '/',
      'com.genymobile.scrcpy.Server', SERVER_VERSION].concat(kv));
    proc.stdout.on('data', (d) => log('server: ' + String(d).trim().slice(0, 200)));
    proc.stderr.on('data', (d) => log('server! ' + String(d).trim().slice(0, 200)));
    proc.on('exit', (c) => { if (!closed) fail(new Error('scrcpy5 server exited ' + c)); });
    setTimeout(() => {
      run(['forward', 'tcp:' + port, 'localabstract:' + socketName], (e2) => {
        if (e2) return fail(new Error('adb forward: ' + e2.message));
        sock = net.connect(port, '127.0.0.1', () => log('video socket connected (' + o.codec + ')'));
        sock.on('data', onData);
        sock.on('error', fail);
        sock.on('close', () => fail(new Error('video socket closed')));
      });
    }, 900);
  });

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 0) {                                   // dummy byte
      if (buf.length < 1) return;
      buf = buf.subarray(1); stage = 1;
    }
    if (stage === 1) {                                   // device name
      if (buf.length < DEVICE_NAME_LEN) return;
      buf = buf.subarray(DEVICE_NAME_LEN); stage = 2;
    }
    if (stage === 2) {                                   // codec id (or the 0/1 "stream disabled" code)
      if (buf.length < 4) return;
      const id = buf.readUInt32BE(0); buf = buf.subarray(4); stage = 3;
      if (id === 0 || id === 1) {
        return fail(new Error(id === 1 ? 'scrcpy5: video config error (codec/encoder unsupported on this phone?)'
                                       : 'scrcpy5: video stream disabled by the server'));
      }
      codecName = CODEC_IDS[id] || ('0x' + id.toString(16));
      log('stream codec: ' + codecName);
      if (codecName !== o.codec) return fail(new Error('scrcpy5: asked for ' + o.codec + ', server streams ' + codecName));
    }
    while (buf.length >= 12) {
      if (buf[0] & 0x80) {                               // session record (no payload)
        const flags = buf.readUInt32BE(0), width = buf.readUInt32BE(4), height = buf.readUInt32BE(8);
        buf = buf.subarray(12);
        cbs.onSession && cbs.onSession({ width, height, codec: codecName, clientResize: (flags & 1) === 1 });
        continue;
      }
      const ptsRaw = buf.readBigUInt64BE(0);
      const len = buf.readUInt32BE(8);
      if (buf.length < 12 + len) break;
      const payload = buf.subarray(12, 12 + len);
      buf = buf.subarray(12 + len);
      const config = (ptsRaw & FLAG_CONFIG) !== 0n;
      const key = (ptsRaw & FLAG_KEYFRAME) !== 0n;
      const ptsUs = config ? 0 : Number(ptsRaw & PTS_MASK);
      cbs.onNalUnits && cbs.onNalUnits(parseAnnexB(payload), ptsUs, key || config, len, config);
    }
  }

  return {
    stop() {
      closed = true;
      try { sock && sock.destroy(); } catch (e) {}
      try { proc && proc.kill(); } catch (e) {}
      execFile(adbPath, ['-s', serial, 'forward', '--remove', 'tcp:' + port], () => {});
    },
  };
}

/** Ask the phone which video encoders it has (scrcpy's own listing). Resolves with the raw text. */
function listEncoders(adbPath, serial) {
  return new Promise((resolve) => {
    execFile(adbPath, ['-s', serial, 'push', bundledJar(), REMOTE_JAR], (err) => {
      if (err) return resolve('push failed: ' + err.message);
      execFile(adbPath, ['-s', serial, 'shell', 'CLASSPATH=' + REMOTE_JAR, 'app_process', '/',
        'com.genymobile.scrcpy.Server', SERVER_VERSION, 'list_encoders=true', 'log_level=warn'],
      { timeout: 15000, maxBuffer: 1024 * 1024 }, (e, out, errOut) => resolve(String(out || '') + String(errOut || '')));
    });
  });
}

module.exports = { startCapture, listEncoders, bundledJar, SERVER_VERSION, REMOTE_JAR, CODEC_IDS };
