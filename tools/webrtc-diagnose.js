#!/usr/bin/env node
// PhoneDesk WebRTC self-diagnostic. The OWNER runs this on the phone-farm host; it exercises the REAL
// capture path and prints a report we use to debug WITHOUT SSH access to that host. Never prints secrets.
//   H.264 (default): bundled scrcpy 1.19-ws7 -> video socket -> H.264 -> NAL parse   (the original POC path)
//   H.265:           bundled scrcpy 5.0.1   -> video socket -> H.265 -> NAL parse   (--codec h265)
//   Usage:  node tools/webrtc-diagnose.js [--serial <serial>] [--seconds 6] [--codec h264|h265|both]
//   With --codec both (recommended on a new phone model) it runs H.264 then H.265 and prints the bitrate
//   each needed for the same screen, which is the number that decides whether H.265 is worth shipping.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const h264 = require('../src/h264-rtp');
const h265 = require('../src/h265-rtp');
const webrtc = require('../src/webrtc');
const scrcpy5 = require('../src/scrcpy-capture');

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseInt(getArg('--seconds', '6'), 10);
const CODEC = String(getArg('--codec', 'h264')).toLowerCase();

function adbPath() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const p = os.platform();
  const bundled = path.join(__dirname, '..', 'resources', 'adb', p === 'win32' ? 'win/adb.exe' : (p === 'darwin' ? 'mac/adb' : 'linux/adb'));
  if (fs.existsSync(bundled)) return bundled;
  return 'adb';
}
const PASS = (b) => (b ? 'PASS' : 'FAIL');
function tryExec(file, a) { try { return execFileSync(file, a, { encoding: 'utf8', timeout: 8000 }).trim(); } catch (e) { return null; } }

function agentVersion() { try { return require('../package.json').version; } catch (e) { return '?'; } }
function wsScrcpyVersion() { try { return require('../resources/ws-scrcpy/package.json').version; } catch (e) { return '?'; } }
function jarInfo(jar) {
  try { const b = fs.readFileSync(jar); return { path: jar, sha256: crypto.createHash('sha256').update(b).digest('hex').slice(0, 16), bytes: b.length }; }
  catch (e) { return { path: jar, sha256: 'MISSING', bytes: 0 }; }
}

/** Capture `seconds` of H.264 through the legacy path; returns counters. */
function captureH264(adb, serial, seconds) {
  const r = { codec: 'h264', scrcpy: false, socket: false, data: false, vps: null, sps: false, pps: false, idr: false, nals: 0, bytes: 0, frames: 0, err: null };
  return new Promise((resolve) => {
    const cap = webrtc.startCapture(adb, serial, 'focused', {
      agent: { emit() {} },
      onNalUnits(nals, ptsUs, keyframe, len) {
        r.scrcpy = true; r.socket = true; r.data = true; r.frames++;
        r.nals += nals.length; r.bytes += (len || 0);
        for (const n of nals) { const t = h264.nalType(n); if (t === h264.NAL.SPS) r.sps = true; if (t === h264.NAL.PPS) r.pps = true; if (t === h264.NAL.IDR) r.idr = true; }
      },
      onError(e) { r.err = e.message; },
    });
    setTimeout(() => { try { cap.stop(); } catch (e) {} resolve(r); }, seconds * 1000);
  });
}

/** Capture `seconds` of H.265 through the scrcpy 5 path; returns counters. */
function captureH265(adb, serial, seconds) {
  const r = { codec: 'h265', scrcpy: false, socket: false, data: false, vps: false, sps: false, pps: false, idr: false, nals: 0, bytes: 0, frames: 0, w: 0, h: 0, err: null, serverLog: [] };
  return new Promise((resolve) => {
    const p = webrtc.PROFILES.focused;
    const cap = scrcpy5.startCapture(adb, serial, { codec: 'h265', maxSize: p.maxSize, bitRate: p.bitRate, maxFps: p.maxFps }, {
      agent: { emit(kind, line) { if (kind === 'log') r.serverLog.push(String(line).slice(0, 200)); } },
      onSession(info) { r.socket = true; r.w = info.width; r.h = info.height; },
      onNalUnits(nals, ptsUs, keyframe, len, config) {
        r.scrcpy = true; r.socket = true; r.data = true; if (!config) r.frames++;
        r.nals += nals.length; r.bytes += (len || 0);
        for (const n of nals) { const t = h265.nalType(n); if (t === h265.NAL.VPS) r.vps = true; if (t === h265.NAL.SPS) r.sps = true; if (t === h265.NAL.PPS) r.pps = true; if (h265.isKeyframe(n)) r.idr = true; }
      },
      onError(e) { r.err = e.message; },
    });
    setTimeout(() => { try { cap.stop(); } catch (e) {} resolve(r); }, seconds * 1000);
  });
}

function report(r, seconds) {
  const C = r.codec.toUpperCase();
  console.log(`  scrcpy server start: `, PASS(r.scrcpy), r.err ? '(' + r.err + ')' : '');
  console.log(`  video socket:        `, PASS(r.socket), r.w ? `(${r.w}x${r.h})` : '');
  console.log(`  ${C} data received:  `, PASS(r.data));
  if (r.codec === 'h265') console.log(`  VPS detected:        `, PASS(r.vps));
  console.log(`  SPS detected:        `, PASS(r.sps));
  console.log(`  PPS detected:        `, PASS(r.pps));
  console.log(`  ${r.codec === 'h265' ? 'IRAP' : 'IDR '} detected:       `, PASS(r.idr));
  console.log(`  ${C} bitrate:        `, r.bytes ? Math.round(r.bytes * 8 / seconds / 1000) + ' kbps' : 'n/a');
  console.log(`  estimated FPS:       `, Math.round(r.frames / seconds));
  console.log(`  NAL units:           `, r.nals);
  if (r.serverLog && r.serverLog.length && !r.data) { console.log('  server said:'); r.serverLog.slice(0, 6).forEach((l) => console.log('    ', l)); }
}

async function main() {
  const adb = adbPath();
  console.log('===== PhoneDesk WebRTC diagnostic =====');
  console.log('PhoneDesk agent version:', agentVersion());
  console.log('OS:', os.platform(), os.release(), '| arch', os.arch());
  console.log('Node:', process.version);
  const adbv = tryExec(adb, ['version']);
  console.log('ADB:', adbv ? adbv.split('\n')[0] : 'NOT FOUND (' + adb + ')');

  let weriftOk = false; try { require('werift'); weriftOk = true; } catch (e) {}
  console.log('WebRTC module loaded:', PASS(!!webrtc.open), '| werift loaded:', PASS(weriftOk), '| offer mode (WEBRTC_CODEC):', webrtc.codecMode());

  const j1 = jarInfo(webrtc.bundledJar()), j5 = jarInfo(scrcpy5.bundledJar());
  console.log('\nSCRCPY:');
  console.log('  ws-scrcpy version:', wsScrcpyVersion());
  console.log('  legacy server (H.264):', webrtc.SCRCPY_VERSION, '| jar sha256[16]:', j1.sha256, '| bytes:', j1.bytes);
  console.log('  modern server (H.265):', scrcpy5.SERVER_VERSION, '| jar sha256[16]:', j5.sha256, '| bytes:', j5.bytes, j5.bytes ? '' : '<- MISSING: resources/scrcpy/');

  console.log('\nCONNECTED DEVICES:');
  const devs = tryExec(adb, ['devices', '-l']);
  console.log(devs || '  (adb devices failed)');
  const serials = (devs || '').split('\n').slice(1)
    .map((l) => l.trim()).filter((l) => l && / device\b/.test(l))
    .map((l) => l.split(/\s+/)[0]);
  const serial = getArg('--serial', serials[0]);
  if (!serial) { console.log('\nNo authorized device found — plug in ONE phone + `adb devices` should show it as "device".'); return; }

  const model = tryExec(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model']) || '?';
  const androidV = tryExec(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release']) || '?';
  console.log(`\nTEST PHONE: ${serial}  (${model}, Android ${androidV})`);
  console.log('  ADB connection:      ', PASS(!!model && model !== '?'));

  if (CODEC === 'h265' || CODEC === 'both') {
    // Which hardware encoders does the phone have? (scrcpy's own listing - the H.265 line is the one
    // that matters; Pixel/Tensor shows c2.exynos.hevc.encoder, Qualcomm shows c2.qti.hevc.encoder.)
    console.log('\nVIDEO ENCODERS ON THE PHONE (scrcpy 5 list_encoders):');
    const enc = await scrcpy5.listEncoders(adb, serial);
    const lines = enc.split('\n').map((l) => l.trim()).filter((l) => /encoder|codec/i.test(l));
    (lines.length ? lines : enc.split('\n').slice(0, 12)).slice(0, 20).forEach((l) => console.log('  ', l.slice(0, 160)));
    console.log('  H.265 hardware encoder:', PASS(/h265.*encoder|hevc.*encoder|encoder.*hevc/i.test(enc)));
  }

  const results = {};
  if (CODEC === 'h264' || CODEC === 'both') {
    console.log('\nCAPTURE TEST H.264 (legacy scrcpy ' + webrtc.SCRCPY_VERSION + ', ' + SECONDS + 's):');
    results.h264 = await captureH264(adb, serial, SECONDS); report(results.h264, SECONDS);
  }
  if (CODEC === 'h265' || CODEC === 'both') {
    console.log('\nCAPTURE TEST H.265 (scrcpy ' + scrcpy5.SERVER_VERSION + ' video_codec=h265, ' + SECONDS + 's):');
    results.h265 = await captureH265(adb, serial, SECONDS); report(results.h265, SECONDS);
  }
  if (results.h264 && results.h265 && results.h264.bytes && results.h265.bytes) {
    const a = results.h264.bytes, b = results.h265.bytes;
    console.log(`\nH.265 used ${Math.round((1 - b / a) * 100)}% ${b < a ? 'fewer' : 'MORE'} bytes than H.264 for the same ${SECONDS}s of screen` +
      ' (both asked for the same bitrate cap; a still screen makes both tiny — scroll something during the test).');
  }
  console.log('\nSend this whole output back (it contains no secrets).');
}
main().catch((e) => { console.error('diagnostic error:', e); process.exit(1); });
