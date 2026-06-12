'use strict';
/*
 * AgentCore - the engine. Manages UP TO N phones on one computer:
 *   detect phones (adb) -> ONE shared ws-scrcpy -> pair each (one code per phone)
 *   -> a phone-home socket + token PER phone -> tunnel streams.
 * Auto-reconnects paired phones that are plugged in; drops ones that get unplugged.
 * Emits: 'status' ({serial, state}), 'log'.
 */
const { EventEmitter } = require('events');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Electron's main process (Node 20) has no global WebSocket; fall back to the `ws` package.
const WebSocket = globalThis.WebSocket || require('ws');
const http = require('http');
const https = require('https');

// POST JSON via Node's http(s) module - reliable in the Electron MAIN process (global fetch can hang).
function postJson(url, bodyObj, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(bodyObj);
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: () => { try { return JSON.parse(chunks); } catch { return {}; } },
        text: chunks,
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out - is the backend reachable?')));
    req.write(data);
    req.end();
  });
}

class AgentCore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.backend = opts.backend || 'http://localhost:8080';
    this.wsBase = this.backend.replace(/^http/, 'ws');
    this.adbPath = opts.adbPath || 'adb';
    this.wsScrcpyDist = opts.wsScrcpyDist;
    this.wsScrcpyPort = opts.wsScrcpyPort || 8000;
    this.tokenFile = opts.tokenFile;
    this.nodeBin = opts.nodeBin || process.execPath;
    this.runAsNodeEnv = opts.runAsNodeEnv || {};
    this.maxDevices = opts.maxDevices || 5;
    this.devices = {};        // serial -> { token, ws, hb, backoff, online }
    this._wsProc = null;
    this._wsStarted = false;
  }

  // adb hangs (USB hiccups, busy phone) must NOT block the Electron main thread - it's where the
  // phone-home heartbeats, the reconnect loop, and the UI all run. A hung adb call with no timeout
  // freezes the whole app and the backend then drops the socket. timeout: kill it and let the caller
  // (all wrapped in try/catch) treat it as a transient miss.
  _adb(args) { return execFileSync(this.adbPath, args, { encoding: 'utf8', timeout: 8000 }).trim(); }
  _getprop(serial, key) { try { return this._adb(['-s', serial, 'shell', 'getprop', key]); } catch { return ''; } }
  _battery(serial) {
    try { const m = /level:\s*(\d+)/.exec(this._adb(['-s', serial, 'shell', 'dumpsys', 'battery'])); return m ? parseInt(m[1], 10) : null; }
    catch { return null; }
  }
  /** Raw `pm list users` parse (no rename overlay) - used to verify on-phone renames. */
  _parseUsers(serial) {
    try {
      const out = this._adb(['-s', serial, 'shell', 'pm', 'list', 'users']);
      const users = [];
      out.split('\n').forEach((l) => { const m = /UserInfo\{(\d+):([^:]*):/.exec(l); if (m) users.push({ id: parseInt(m[1], 10), name: (m[2] || ('Profile ' + m[1])).trim() }); });
      return users;
    } catch { return []; }
  }
  /** Android users = "profiles". Owner-set names (renames the phone refused) overlay the raw ones. */
  _listUsers(serial) {
    const users = this._parseUsers(serial);
    const ov = (this._loadTokens()[serial] || {}).profiles || {};
    users.forEach((u) => { if (ov[u.id]) u.name = ov[u.id]; });
    return users;
  }
  _currentUser(serial) { try { const v = parseInt(this._adb(['-s', serial, 'shell', 'am', 'get-current-user']).trim(), 10); return isNaN(v) ? null : v; } catch { return null; } }
  /** Heartbeat payload. Battery is re-read every beat (it changes); the user/profile list barely ever
      does, so when full=false we reuse the cached list instead of shelling out `pm list users` +
      `am get-current-user`. That keeps the 10s heartbeat from flooding adb (3 commands x N phones every
      10s) and contending with scrcpy's video over the same adb server. switchUser/renameUser pass
      full=true so a real change is reflected immediately. Payload shape is identical either way. */
  _metaPayload(serial, full = true) {
    const dev = this.devices[serial];
    if (!full && dev && dev._metaCache) return { battery: this._battery(serial), ...dev._metaCache };
    const cache = { users: this._listUsers(serial), current_user: this._currentUser(serial) };
    if (dev) dev._metaCache = cache;
    return { battery: this._battery(serial), ...cache };
  }

  // ---- token store: agent.json = { devices: { serial: { device_token, name } } }
  _loadTokens() {
    let raw; try { raw = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')); } catch { return {}; }
    if (raw && raw.devices) return raw.devices;
    if (raw && raw.device_token) {   // migrate old single-device format -> assign to the first ready phone
      const r = this.detectAll().find((d) => d.state === 'ready');
      if (r) { const m = { [r.serial]: { device_token: raw.device_token, name: 'Phone' } }; this._saveTokens(m); return m; }
    }
    return {};
  }
  _saveTokens(map) { try { fs.writeFileSync(this.tokenFile, JSON.stringify({ devices: map }, null, 2)); } catch (e) { this.emit('log', 'token save failed: ' + e); } }

  // ---- detection (fast: one `adb devices` call; getprop only when pairing)
  detectAll() {
    let rows;
    try { rows = this._adb(['devices']).split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t')); }
    catch { return []; }
    return rows.filter((p) => p[1] === 'device' || p[1] === 'unauthorized')
      .map((p) => ({ serial: p[0], state: p[1] === 'device' ? 'ready' : 'unauthorized' }));
  }
  _deviceInfo(serial) {
    const model = this._getprop(serial, 'ro.product.model');
    return { brand: this._getprop(serial, 'ro.product.brand'), model, android: this._getprop(serial, 'ro.build.version.release'), name: model || 'Phone' };
  }
  firstUnpairedReady() { const t = this._loadTokens(); return this.detectAll().find((d) => d.state === 'ready' && !t[d.serial]) || null; }

  /** Snapshot for the wizard: phones (plugged + paired) with paired/online flags + counts. */
  status() {
    const tokens = this._loadTokens();
    const seen = {};
    const phones = this.detectAll().map((d) => {
      seen[d.serial] = true;
      return { serial: d.serial, state: d.state, name: (tokens[d.serial] && tokens[d.serial].name) || 'Phone',
        paired: !!tokens[d.serial], online: !!(this.devices[d.serial] && this.devices[d.serial].online) };
    });
    Object.keys(tokens).forEach((serial) => {   // paired but not currently plugged in
      if (!seen[serial]) phones.push({ serial, state: 'absent', name: tokens[serial].name || 'Phone', paired: true,
        online: !!(this.devices[serial] && this.devices[serial].online) });
    });
    return { phones, pairedCount: Object.keys(tokens).length, max: this.maxDevices };
  }

  // ---- shared ws-scrcpy (ONE process serves every phone)
  startWsScrcpy() {
    if (this._wsStarted && this._wsProc) return;
    this._wsStarted = true;
    // clear orphaned scrcpy-server on each plugged phone (else its socket stays bound -> no video)
    this.detectAll().forEach((d) => { try { execFileSync(this.adbPath, ['-s', d.serial, 'shell', 'pkill', '-f', 'scrcpy'], { timeout: 6000 }); } catch {} });
    const adbDir = path.dirname(this.adbPath);
    const env = { ...process.env, ...this.runAsNodeEnv, WS_SCRCPY_PATHNAME: '/stream/', ADB_PATH: this.adbPath };
    const existingPath = env.PATH || env.Path || ''; delete env.PATH; delete env.Path;
    env.PATH = adbDir + path.delimiter + existingPath;
    this._wsProc = spawn(this.nodeBin, ['index.js'], { cwd: this.wsScrcpyDist, env });
    const pipe = (s) => s && s.on('data', (d) => this.emit('log', '[ws-scrcpy] ' + String(d).trimEnd()));
    pipe(this._wsProc.stdout); pipe(this._wsProc.stderr);
    this._wsProc.on('exit', (c) => { this.emit('log', `ws-scrcpy exited (${c}); respawning`); this._wsStarted = false; this._wsProc = null; setTimeout(() => this.startWsScrcpy(), 2000); });
    this.emit('log', `ws-scrcpy launched on :${this.wsScrcpyPort} (adbDir=${adbDir})`);
  }

  async pair(code, info) {
    this.emit('log', `pairing (code ${code}) at ${this.backend} ...`);
    const r = await postJson(`${this.backend}/api/devices/pair`, { code, ...info });
    if (!r.ok) throw new Error(`Pairing failed (${r.status}). Check the code and try again.`);
    this.emit('log', 'paired OK');
    return r.json();
  }

  /** Keep connections in sync with what's plugged in: connect plugged+paired phones, drop unplugged ones. */
  reconcile() {
    this.startWsScrcpy();
    const tokens = this._loadTokens();
    const plugged = {}; this.detectAll().forEach((d) => { if (d.state === 'ready') plugged[d.serial] = true; });
    Object.keys(tokens).forEach((serial) => {
      const dev = this.devices[serial];
      const connected = dev && dev.ws && dev.ws.readyState <= 1;   // CONNECTING(0) or OPEN(1)
      if (plugged[serial] && !connected) this.connectHome(serial, tokens[serial].device_token);
    });
    Object.keys(this.devices).forEach((serial) => {               // unplugged -> stop reconnecting + go offline
      if (!plugged[serial] && this.devices[serial]) {
        const dev = this.devices[serial]; dev.token = null; clearInterval(dev.hb); clearInterval(dev.ping); clearTimeout(dev.reconnectTimer);
        try { dev.ws && dev.ws.close(); } catch {}
        delete this.devices[serial];
      }
    });
  }

  /** Pair the first plugged-in UNPAIRED phone with a code, then bring it online. */
  async addPhone(code) {
    this.startWsScrcpy();
    const tokens = this._loadTokens();
    if (Object.keys(tokens).length >= this.maxDevices) throw new Error(`You've reached the ${this.maxDevices}-phone limit.`);
    const d = this.firstUnpairedReady();
    if (!d) throw new Error('No new phone detected. Plug it in and tap "Allow" on the phone.');
    const info = this._deviceInfo(d.serial);
    const res = await this.pair(code, {
      serial: d.serial, brand: info.brand, model: info.model, android_version: info.android, name: info.name,
      os: process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux',
    });
    tokens[d.serial] = { device_token: res.device_token, name: info.name };
    this._saveTokens(tokens);
    this.connectHome(d.serial, res.device_token);
    return { serial: d.serial, name: info.name };
  }

  connectHome(serial, token) {
    const dev = this.devices[serial] = this.devices[serial] || { backoff: 1000 };
    // One phone-home socket per phone. Cancel any pending reconnect (the close handler and the 2s
    // reconcile() both try to reconnect a dropped phone - without this they race and we end up with
    // two live sockets + an orphaned heartbeat interval that never gets cleared).
    clearTimeout(dev.reconnectTimer); dev.reconnectTimer = null;
    if (dev.ws && dev.ws.readyState <= 1 && dev.token === token) return;   // already connecting/open
    dev.token = token;
    const ws = new WebSocket(`${this.wsBase}/ws/agent?token=${encodeURIComponent(token)}`);
    dev.ws = ws;
    ws.addEventListener('open', () => {
      dev.backoff = 1000; dev.online = true;
      this.emit('status', { serial, state: 'online' });
      const sendMeta = (full) => { try { ws.send(JSON.stringify({ op: 'meta', data: this._metaPayload(serial, full) })); } catch {} };
      sendMeta(true);                       // first beat: full (battery + fresh user list)
      let beat = 0;
      dev.hb = setInterval(() => { beat = (beat + 1) % 6; sendMeta(beat === 0); }, 10000);   // refresh the user list once a minute, battery every beat
      // Liveness watchdog. A half-open link (router/NAT drop, wifi blip) leaves a ZOMBIE socket: the
      // agent keeps "sending" into a dead pipe, the dashboard still shows the phone ONLINE, and the OS
      // doesn't surface the dead socket for ~15 min (TCP's default give-up). Ping every 15s and treat
      // ANY inbound frame (pong or a real message) as proof of life; after ~45s of total silence,
      // recycle the socket now and let the close handler reconnect. The pings also keep NAT mappings
      // warm, which prevents many of these drops in the first place. (Only the `ws` package exposes
      // control frames; the browser/undici WebSocket doesn't, so we feature-detect.)
      if (typeof ws.ping === 'function') {
        dev.alive = true; let gotPong = false, missed = 0;
        ws.on('pong', () => { gotPong = true; dev.alive = true; });   // server replied -> it speaks ping/pong
        ws.addEventListener('message', () => { dev.alive = true; });  // any real frame also proves life
        dev.ping = setInterval(() => {
          if (dev.alive) { dev.alive = false; missed = 0; }
          // Only recycle on silence once we KNOW this server answers pings (avoids a reconnect storm if
          // it never does); short-circuit keeps `missed` at 0 until then.
          else if (gotPong && ++missed >= 3) {                        // ~45s of total silence -> dead
            this.emit('log', `${serial}: no reply for ~45s, recycling dead socket`);
            try { ws.terminate ? ws.terminate() : ws.close(); } catch {}
            return;
          }
          try { ws.ping(); } catch {}
        }, 15000);
      }
    });
    ws.addEventListener('message', (e) => {
      let m = {}; try { m = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch {}
      if (m.op === 'open_stream') this.openTunnel(serial, token, m.stream_id, m.query);
      else if (m.op === 'switch_user') this.switchUser(serial, m.user_id, ws);
      else if (m.op === 'rename_user') this.renameUser(serial, m.user_id, m.name, ws);
      else if (m.op === 'unpair') this.unpair(serial);
      else if (m.op === 'refresh') this.refreshAll();   // VA pressed "Refresh phone" on the website
    });
    ws.addEventListener('close', (e) => {
      clearInterval(dev.hb); clearInterval(dev.ping); dev.online = false;
      if (e && e.code === 4401) {            // token revoked (phone deleted on the website) - forget it
        this.emit('log', `token rejected for ${serial}; unpairing locally`);
        this.unpair(serial);
        return;
      }
      this.emit('status', { serial, state: 'reconnecting' });
      dev.backoff = Math.min((dev.backoff || 1000) * 2, 30000);
      dev.reconnectTimer = setTimeout(() => { if (this.devices[serial] && this.devices[serial].token === token) this.connectHome(serial, token); }, dev.backoff);
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }

  /** Manual refresh: drop every connection, restart adb + ws-scrcpy, reconnect from scratch.
      Fixes the "phone just won't connect" moods without restarting the whole app. */
  refreshAll() {
    this.emit('log', 'manual refresh: restarting adb + ws-scrcpy and reconnecting everything');
    Object.keys(this.devices).forEach((serial) => {
      const dev = this.devices[serial];
      try { clearInterval(dev.hb); } catch {}
      try { clearInterval(dev.ping); } catch {}
      try { clearTimeout(dev.reconnectTimer); } catch {}
      try { dev.ws && dev.ws.close(); } catch {}
      delete this.devices[serial];          // close handler can't reconnect a deleted entry
    });
    try {
      if (this._wsProc) { this._wsProc.removeAllListeners('exit'); this._wsProc.kill(); }
    } catch {}
    this._wsProc = null; this._wsStarted = false;
    try { this._adb(['kill-server']); } catch {}   // next adb call auto-starts a fresh daemon
    this.reconcile();
  }

  /** Reset: forget EVERY pairing on this computer (deletes the saved token file). The escape hatch
      when a phone is stuck after being removed on the website - phones then show as new and can be
      re-added with a fresh code. */
  resetPairings() {
    this.emit('log', 'reset: clearing all local pairings (agent.json)');
    Object.keys(this.devices).forEach((serial) => {
      const dev = this.devices[serial];
      try { clearInterval(dev.hb); } catch {}
      try { clearInterval(dev.ping); } catch {}
      try { clearTimeout(dev.reconnectTimer); } catch {}
      try { dev.ws && dev.ws.close(); } catch {}
      delete this.devices[serial];
    });
    try { fs.unlinkSync(this.tokenFile); } catch (e) { this.emit('log', 'reset unlink: ' + ((e && e.message) || e)); }
    this.reconcile();
  }

  /** The server removed this phone: forget its token, stop reconnecting (frees a pairing slot). */
  unpair(serial) {
    const tokens = this._loadTokens();
    if (tokens[serial]) { delete tokens[serial]; this._saveTokens(tokens); }
    const dev = this.devices[serial];
    if (dev) {
      dev.token = null; clearInterval(dev.hb); clearInterval(dev.ping); clearTimeout(dev.reconnectTimer);
      try { dev.ws && dev.ws.close(); } catch {}
      delete this.devices[serial];
    }
    this.emit('log', `unpaired ${serial} (removed on the website)`);
    this.emit('status', { serial, state: 'unpaired' });
  }

  openTunnel(serial, token, streamId, query) {
    if (!streamId) { this.emit('log', `open_stream ignored (${serial}): missing stream_id`); return; }
    const tunnel = new WebSocket(`${this.wsBase}/ws/agent-stream?token=${encodeURIComponent(token)}&stream_id=${encodeURIComponent(streamId)}`);
    // The viewer's query selects the ws-scrcpy endpoint: device list = `action=multiplex`; live video =
    // `action=proxy-adb&remote=...&udid=<serial>`. The udid in the query targets THIS phone, so one
    // shared ws-scrcpy serves all of them. Forwarded verbatim through the per-phone tunnel.
    const q = (query && query.length) ? query : 'action=multiplex';
    const local = new WebSocket(`ws://127.0.0.1:${this.wsScrcpyPort}/stream/?${q}`);
    tunnel.binaryType = 'arraybuffer'; local.binaryType = 'arraybuffer';
    const tBuf = [], lBuf = [];
    // buf only holds frames during the brief window before `to` opens. If `to` never opens (or stalls
    // in CLOSING/CLOSED), don't let high-bitrate video pile up unbounded in memory - tear the tunnel down.
    const MAX_BUF = 1024;
    const link = (from, to, buf) => {
      from.addEventListener('message', (e) => {
        if (to.readyState === 1) to.send(e.data);
        else if (buf.length < MAX_BUF) buf.push(e.data);
        else { try { from.close(); } catch {} try { to.close(); } catch {} }
      });
      from.addEventListener('close', () => { try { to.close(); } catch {} });
      from.addEventListener('error', () => { try { to.close(); } catch {} });
    };
    link(tunnel, local, lBuf); link(local, tunnel, tBuf);
    local.addEventListener('open', () => { while (lBuf.length) local.send(lBuf.shift()); });
    tunnel.addEventListener('open', () => { while (tBuf.length) tunnel.send(tBuf.shift()); });
    this.emit('log', `stream ${streamId.slice(0, 8)} (${serial}) -> ?${q.slice(0, 56)}`);
  }

  /** Switch the phone's active Android user (profile), then cycle airplane mode -> fresh mobile IP. */
  async switchUser(serial, userId, ws) {
    const id = parseInt(userId, 10);
    if (isNaN(id) || !serial) return;
    const sh = (args) => { try { return this._adb(['-s', serial, 'shell', ...args]); } catch (e) { this.emit('log', `adb ${args.join(' ')}: ${(e && e.message) || e}`); return ''; } };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const airplane = (on) => {
      const r = sh(['cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable']);   // Android 11+
      if (/unknown|error|not found|usage/i.test(r)) {                                       // older fallback
        sh(['settings', 'put', 'global', 'airplane_mode_on', on ? '1' : '0']);
        sh(['am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', on ? 'true' : 'false']);
      }
    };
    this.emit('log', `switch_user (${serial}) -> ${id} (+ airplane cycle for a fresh IP)`);
    sh(['am', 'switch-user', String(id)]);
    airplane(true); await wait(4000);
    airplane(false); await wait(4000);
    sh(['svc', 'data', 'enable']);
    this.emit('log', `switch_user ${id} done`);
    try { ws.send(JSON.stringify({ op: 'meta', data: this._metaPayload(serial) })); } catch {}
  }

  /** Rename a profile: try on the phone itself (newer Androids); remember the name here if it refuses. */
  renameUser(serial, userId, name, ws) {
    const id = parseInt(userId, 10);
    const clean = String(name || '').replace(/[^\w .\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (isNaN(id) || !clean || !serial) return;
    try { this._adb(['-s', serial, 'shell', 'pm', 'rename-user', String(id), `'${clean}'`]); }
    catch (e) { this.emit('log', `pm rename-user: ${(e && e.message) || e}`); }
    const onPhone = (this._parseUsers(serial).find((u) => u.id === id) || {}).name === clean;
    const tokens = this._loadTokens();
    const entry = tokens[serial];
    if (entry) {
      entry.profiles = entry.profiles || {};
      if (onPhone) delete entry.profiles[id];   // the phone took it - no overlay needed
      else entry.profiles[id] = clean;          // older Android refused - keep the name in PhoneDesk
      this._saveTokens(tokens);
    }
    this.emit('log', `rename_user ${id} -> "${clean}" (${onPhone ? 'renamed on the phone' : 'saved in PhoneDesk'})`);
    try { ws.send(JSON.stringify({ op: 'meta', data: this._metaPayload(serial) })); } catch {}
  }
}

module.exports = { AgentCore };
