/*
 * PhoneDesk owner agent (functional core, zero npm deps — Node 18+ global fetch/WebSocket).
 *
 *   1. Detects the phone via adb (brand/model/Android/battery).
 *   2. Runs a LOCAL ws-scrcpy (the stream source) on 127.0.0.1:8000.
 *   3. Pairs (first run) and opens a phone-home WebSocket -> phone shows ONLINE in the dashboard.
 *   4. On an "open_stream" signal, tunnels the local ws-scrcpy socket up to the backend, so a VA's
 *      browser sees the live screen via the dashboard's Connect button.
 *
 * The Electron wizard (big buttons, brand guides, bundled adb/scrcpy, tray) will wrap this.
 *
 * Local dev:  set BACKEND=http://localhost:8080 && node agent.js <PAIRING-CODE>
 */
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND = process.env.BACKEND || 'http://localhost:8000';
const WS_BASE = BACKEND.replace(/^http/, 'ws');
const ADB = process.env.ADB_PATH || 'adb';
const TOKEN_FILE = path.join(__dirname, '.agent.json');
const HEARTBEAT_MS = 10000;
const WS_SCRCPY_DIST =
  process.env.WS_SCRCPY_DIST || path.join(__dirname, '..', 'vendor', 'ws-scrcpy', 'dist');
const WS_SCRCPY_PORT = parseInt(process.env.WS_SCRCPY_PORT || '8000', 10);
const LOCAL_MUX = `ws://127.0.0.1:${WS_SCRCPY_PORT}/stream/?action=multiplex`;

// ---------- adb ----------
function adb(args) { return execFileSync(ADB, args, { encoding: 'utf8' }).trim(); }
function firstSerial() {
  const rows = adb(['devices']).split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const row = rows.map((l) => l.split('\t')).find((p) => p[1] === 'device');
  return row ? row[0] : null;
}
function getprop(serial, key) { try { return adb(['-s', serial, 'shell', 'getprop', key]); } catch { return ''; } }
function battery(serial) {
  try { const m = /level:\s*(\d+)/.exec(adb(['-s', serial, 'shell', 'dumpsys', 'battery'])); return m ? parseInt(m[1], 10) : null; }
  catch { return null; }
}
function deviceInfo(serial) {
  const model = getprop(serial, 'ro.product.model');
  return {
    serial, model, brand: getprop(serial, 'ro.product.brand'),
    android_version: getprop(serial, 'ro.build.version.release'), name: model || 'Phone',
    os: process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux',
  };
}

// ---------- local ws-scrcpy (the stream source) ----------
function startWsScrcpy() {
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: WS_SCRCPY_DIST,
    env: { ...process.env, WS_SCRCPY_PATHNAME: '/stream/' },
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[ws-scrcpy] ${d}`));
  proc.stderr.on('data', (d) => process.stdout.write(`[ws-scrcpy] ${d}`));
  proc.on('exit', (c) => { console.log(`[ws-scrcpy] exited (${c}); respawning in 2s`); setTimeout(startWsScrcpy, 2000); });
  console.log(`[agent] launched local ws-scrcpy on :${WS_SCRCPY_PORT}`);
}

// ---------- pairing / token ----------
async function pair(code, info) {
  const r = await fetch(`${BACKEND}/api/devices/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, ...info }),
  });
  if (!r.ok) throw new Error(`pairing failed: ${r.status} ${await r.text()}`);
  return r.json();
}
function loadToken() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; } }
function saveToken(d) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(d, null, 2)); }

// ---------- stream tunnel (backend <-> local ws-scrcpy) ----------
function openTunnel(token, streamId) {
  const tunnel = new WebSocket(`${WS_BASE}/ws/agent-stream?token=${encodeURIComponent(token)}&stream_id=${encodeURIComponent(streamId)}`);
  const local = new WebSocket(LOCAL_MUX);
  tunnel.binaryType = 'arraybuffer';
  local.binaryType = 'arraybuffer';
  const tBuf = [], lBuf = [];
  const link = (from, to, buf) => {
    from.addEventListener('message', (e) => { if (to.readyState === 1) to.send(e.data); else buf.push(e.data); });
    from.addEventListener('close', () => { try { to.close(); } catch {} });
    from.addEventListener('error', () => { try { to.close(); } catch {} });
  };
  link(tunnel, local, lBuf);
  link(local, tunnel, tBuf);
  local.addEventListener('open', () => { while (lBuf.length) local.send(lBuf.shift()); });
  tunnel.addEventListener('open', () => { while (tBuf.length) tunnel.send(tBuf.shift()); });
  console.log(`[agent] stream ${streamId.slice(0, 8)}… tunnel opened`);
}

// ---------- phone-home ----------
let ws, backoff = 1000, hbTimer;
function connect(token, serial) {
  ws = new WebSocket(`${WS_BASE}/ws/agent?token=${encodeURIComponent(token)}`);
  ws.addEventListener('open', () => {
    backoff = 1000;
    console.log('[agent] phone-home connected — ONLINE in dashboard');
    try { ws.send(JSON.stringify({ op: 'meta', data: { battery: battery(serial) } })); } catch {}
    hbTimer = setInterval(() => { try { ws.send(JSON.stringify({ op: 'heartbeat', battery: battery(serial) })); } catch {} }, HEARTBEAT_MS);
  });
  ws.addEventListener('message', (e) => {
    let m = {}; try { m = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch {}
    if (m.op === 'open_stream') openTunnel(token, m.stream_id);
  });
  ws.addEventListener('close', () => {
    clearInterval(hbTimer);
    backoff = Math.min(backoff * 2, 30000);
    console.log(`[agent] disconnected; reconnecting in ${backoff}ms`);
    setTimeout(() => connect(token, serial), backoff);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

async function main() {
  const serial = firstSerial();
  if (!serial) { console.error('No authorized phone found. Plug in via USB and tap "Allow".'); process.exit(1); }
  const info = deviceInfo(serial);
  console.log(`[agent] found: ${info.brand} ${info.model} (Android ${info.android_version})`);
  startWsScrcpy();

  let stored = loadToken();
  if (!stored || !stored.device_token) {
    const code = process.argv[2] || process.env.PAIR_CODE;
    if (!code) { console.error('First run needs a pairing code:  node agent.js ABC-DEF'); process.exit(1); }
    stored = await pair(code, info);
    saveToken(stored);
    console.log(`[agent] paired OK  device_id=${stored.device_id}`);
  }
  connect(stored.device_token, serial);
}

main().catch((e) => { console.error(e); process.exit(1); });
