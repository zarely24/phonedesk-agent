#!/usr/bin/env node
// PhoneDesk WebRTC self-diagnostic. The OWNER runs this on the phone-farm host; it exercises the REAL
// capture path (bundled scrcpy 1.19-ws7 -> video socket -> H.264 -> NAL parse) and prints a report we
// use to debug WITHOUT SSH access to that host. Never prints secrets.
//   Usage:  node tools/webrtc-diagnose.js [--serial <serial>] [--seconds 6]
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { nalType, NAL } = require('../src/h264-rtp');
const webrtc = require('../src/webrtc');

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseInt(getArg('--seconds', '6'), 10);

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
function jarInfo() {
  const jar = webrtc.bundledJar();
  try { const b = fs.readFileSync(jar); return { path: jar, sha256: crypto.createHash('sha256').update(b).digest('hex').slice(0, 16), bytes: b.length }; }
  catch (e) { return { path: jar, sha256: 'MISSING', bytes: 0 }; }
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
  console.log('WebRTC module loaded:', PASS(!!webrtc.open), '| werift loaded:', PASS(weriftOk));

  const ji = jarInfo();
  console.log('\nSCRCPY:');
  console.log('  ws-scrcpy version:', wsScrcpyVersion());
  console.log('  scrcpy server version:', webrtc.SCRCPY_VERSION);
  console.log('  server jar:', ji.path);
  console.log('  jar sha256[16]:', ji.sha256, '| bytes:', ji.bytes);

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

  // exercise the REAL capture path
  console.log('\nCAPTURE TEST (' + SECONDS + 's):');
  const r = { adb: false, scrcpy: false, socket: false, h264: false, sps: false, pps: false, idr: false, nals: 0, bytes: 0, frames: 0, w: 0, h: 0, err: null };
  r.adb = !!model && model !== '?';
  await new Promise((resolve) => {
    const t0 = Date.now();
    const cap = webrtc.startCapture(adb, serial, 'focused', {
      agent: { emit() {} },
      onNalUnits(nals, ptsUs, keyframe, len) {
        r.scrcpy = true; r.socket = true; r.h264 = true; r.frames++;
        r.nals += nals.length; r.bytes += (len || 0);
        for (const n of nals) { const t = nalType(n); if (t === NAL.SPS) r.sps = true; if (t === NAL.PPS) r.pps = true; if (t === NAL.IDR) r.idr = true; }
      },
      onError(e) { r.err = e.message; },
    });
    setTimeout(() => { try { cap.stop(); } catch (e) {} resolve(); }, SECONDS * 1000);
  });
  const secs = SECONDS;
  console.log('  ADB connection:      ', PASS(r.adb));
  console.log('  scrcpy server start: ', PASS(r.scrcpy), r.err ? '(' + r.err + ')' : '');
  console.log('  video socket:        ', PASS(r.socket));
  console.log('  H264 data received:  ', PASS(r.h264));
  console.log('  SPS detected:        ', PASS(r.sps));
  console.log('  PPS detected:        ', PASS(r.pps));
  console.log('  IDR detected:        ', PASS(r.idr));
  console.log('  H264 bitrate:        ', r.bytes ? Math.round(r.bytes * 8 / secs / 1000) + ' kbps' : 'n/a');
  console.log('  estimated FPS:       ', Math.round(r.frames / secs));
  console.log('  NAL units:           ', r.nals);
  console.log('\nSend this whole output back (it contains no secrets).');
}
main().catch((e) => { console.error('diagnostic error:', e); process.exit(1); });
