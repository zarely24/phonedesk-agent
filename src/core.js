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
const os = require('os');

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
    // Battery charge limiting. `suPrefix` is how we run a root shell on the phone (GrapheneOS is
    // not rooted by default; on a rooted phone this is `su -c`). `chargeNodes` are the sysfs
    // paths we write — Pixel/Tensor expose the firmware hysteresis levels (preferred: the
    // embedded controller enforces them and the USB-C data link stays alive); `gates` are
    // generic charging-FET switches used by the poll-loop fallback. All overridable per SoC.
    this.suPrefix = opts.suPrefix != null ? opts.suPrefix : 'su -c';
    this.chargeNodes = opts.chargeNodes || {
      stopLevel: '/sys/devices/platform/google,charger/charge_stop_level',
      startLevel: '/sys/devices/platform/google,charger/charge_start_level',
      gates: [
        '/sys/class/power_supply/battery/charging_enabled',
        '/sys/class/power_supply/battery/input_suspend',
        '/sys/class/power_supply/battery/charge_control_limit',
      ],
    };
    this.devices = {};        // serial -> { token, ws, hb, backoff, online, chargePolicy, chargeTimer }
    this._wsProc = null;
    this._wsStarted = false;
    this._wsBackoff = 1000;   // respawn backoff for the shared ws-scrcpy (mirrors the phone-home backoff)
    this._wsRespawnTimer = null;
    this._stopped = false;    // set on shutdown() so ws-scrcpy isn't resurrected as the app quits
  }

  /** Tear down ONE device: stop its timers, close its socket, forget it. Used everywhere we drop a
      phone (unplug, refresh, reset, unpair, shutdown) so the cleanup never drifts out of sync. */
  _dropDevice(serial) {
    const dev = this.devices[serial];
    if (!dev) return;
    dev.token = null;
    try { clearInterval(dev.hb); } catch {}
    try { clearInterval(dev.ping); } catch {}
    try { clearInterval(dev.chargeTimer); } catch {}
    try { clearTimeout(dev.reconnectTimer); } catch {}
    try { dev.ws && dev.ws.close(); } catch {}
    delete this.devices[serial];
  }

  /** Forward one log line to the backend (for the admin live-log view) over every open phone-home
      socket. Best-effort and SILENT - it must never emit a log itself or it would feed back on itself. */
  forwardLog(line) {
    const msg = JSON.stringify({ op: 'log', line: String(line).slice(0, 2000) });
    Object.keys(this.devices).forEach((serial) => {
      const ws = this.devices[serial].ws;
      if (ws && ws.readyState === 1) { try { ws.send(msg); } catch {} }
    });
  }

  // adb hangs (USB hiccups, busy phone) must NOT block the Electron main thread - it's where the
  // phone-home heartbeats, the reconnect loop, and the UI all run. A hung adb call with no timeout
  // freezes the whole app and the backend then drops the socket. timeout: kill it and let the caller
  // (all wrapped in try/catch) treat it as a transient miss.
  _adb(args) { return execFileSync(this.adbPath, args, { encoding: 'utf8', timeout: 8000 }).trim(); }
  _getprop(serial, key) { try { return this._adb(['-s', serial, 'shell', 'getprop', key]); } catch { return ''; } }
  /** Battery level + whether the phone is actually drawing charge, from ONE `dumpsys battery`
      call (cheaper than two shell-outs every heartbeat x N phones). When our charge limit has
      gated the FET the phone still reads plugged-in (powered) but `status` flips away from 2
      (charging) - that "paused" state is exactly what we surface as charging:false. */
  _batteryAndCharging(serial) {
    try {
      const out = this._adb(['-s', serial, 'shell', 'dumpsys', 'battery']);
      const lvl = /level:\s*(\d+)/.exec(out);
      const status = /status:\s*(\d+)/.exec(out);   // 2 = charging
      const powered = [/AC powered:\s*true/i, /USB powered:\s*true/i, /Wireless powered:\s*true/i]
        .some((re) => re.test(out));
      const charging = status ? status[1] === '2' : powered;
      return { battery: lvl ? parseInt(lvl[1], 10) : null, charging };
    } catch { return { battery: null, charging: null }; }
  }
  _battery(serial) { return this._batteryAndCharging(serial).battery; }

  // ---- charge limiting: write the phone's sysfs charge-control nodes (best-effort, needs root)
  _writeNode(serial, node, value) {
    const inner = `echo ${value} > ${node}`;
    return this._adb(['-s', serial, 'shell', this.suPrefix ? `${this.suPrefix} '${inner}'` : inner]);
  }
  _nodeExists(serial, node) {
    const inner = `test -e ${node} && echo yes`;
    try { return /yes/.test(this._adb(['-s', serial, 'shell', this.suPrefix ? `${this.suPrefix} '${inner}'` : inner])); }
    catch { return false; }
  }
  /** Open/close the charging FET on a generic gate node (semantics differ per node name). */
  _setGate(serial, gate, allow) {
    let val;
    if (/input_suspend/.test(gate)) val = allow ? 0 : 1;            // 1 = suspend input (stop)
    else if (/charge_control_limit/.test(gate)) val = allow ? 100 : 0;
    else val = allow ? 1 : 0;                                       // charging_enabled style
    try { this._writeNode(serial, gate, val); }
    catch (e) { this.emit('log', `${serial}: charge gate write failed: ${(e && e.message) || e}`); }
  }
  /** Is `su` usable on this phone (rooted)? Cached per device - probing every beat would be wasteful.
      Sysfs charge control needs root; this lets us report "needs root" instead of failing silently. */
  _hasRoot(serial) {
    const dev = this.devices[serial];
    if (dev && dev._rooted != null) return dev._rooted;
    let rooted = false;
    try {
      const out = this._adb(['-s', serial, 'shell', this.suPrefix ? `${this.suPrefix} 'id'` : 'id']);
      rooted = /uid=0/.test(out);
    } catch { rooted = false; }
    if (dev) dev._rooted = rooted;
    return rooted;
  }
  /** Apply the device's stored charge policy. Prefer the Pixel firmware hysteresis (no polling,
      keeps USB data alive); fall back to a slow poll loop toggling a charging-FET gate. Sets
      dev.chargeStatus to a human string that's reported up to the dashboard so the operator can
      SEE on a real phone whether limiting is active, polling, or unavailable (no root / no node). */
  _applyChargePolicy(serial) {
    const dev = this.devices[serial];
    if (!dev) return;
    try { clearInterval(dev.chargeTimer); } catch {} dev.chargeTimer = null;
    const pol = dev.chargePolicy;
    if (!pol || !pol.enabled) { this._restoreCharging(serial); return; }
    const { stop, resume } = pol;
    const N = this.chargeNodes;
    if (this._nodeExists(serial, N.stopLevel) && this._nodeExists(serial, N.startLevel)) {
      try {
        this._writeNode(serial, N.startLevel, resume);
        this._writeNode(serial, N.stopLevel, stop);
        dev.chargeMethod = 'firmware'; dev.chargeStatus = `firmware (stop ${stop} / resume ${resume})`;
        this.emit('log', `${serial}: charge limit via firmware (start ${resume} / stop ${stop})`);
        return;
      } catch (e) { this.emit('log', `${serial}: firmware charge nodes failed: ${(e && e.message) || e}`); }
    }
    const gate = N.gates.find((g) => this._nodeExists(serial, g));
    if (!gate) {
      const rooted = this._hasRoot(serial);
      dev.chargeMethod = 'none';
      dev.chargeStatus = rooted ? 'unavailable (no charge-control node on this device)'
                                : 'unavailable (phone is not rooted)';
      this.emit('log', `${serial}: charge limiting ${dev.chargeStatus}`);
      return;
    }
    dev.chargeGate = gate; dev.chargeMethod = 'poll:' + gate;
    dev.chargeStatus = `poll ${gate.split('/').pop()} (stop ${stop} / resume ${resume})`;
    this.emit('log', `${serial}: charge limit via ${gate} poll loop (stop ${stop} / resume ${resume})`);
    const tick = () => {
      try {
        const b = this._battery(serial);
        if (b == null) return;
        if (b >= stop) this._setGate(serial, gate, false);
        else if (b <= resume) this._setGate(serial, gate, true);
      } catch {}
    };
    tick();
    dev.chargeTimer = setInterval(tick, 60000);
  }
  /** Undo any charge gating so the phone charges normally again (policy disabled / unpaired). */
  _restoreCharging(serial) {
    const dev = this.devices[serial];
    if (!dev) return;
    try { clearInterval(dev.chargeTimer); } catch {} dev.chargeTimer = null;
    const N = this.chargeNodes;
    try {
      if (this._nodeExists(serial, N.stopLevel)) this._writeNode(serial, N.stopLevel, 100);
      if (this._nodeExists(serial, N.startLevel)) this._writeNode(serial, N.startLevel, 0);
      if (dev.chargeGate) this._setGate(serial, dev.chargeGate, true);
    } catch {}
    dev.chargeMethod = null; dev.chargeGate = null; dev.chargeStatus = 'off';
  }
  /** Handle the backend's set_charge_policy op: validate, persist, apply, reflect in the dashboard. */
  setChargePolicy(serial, policy, ws) {
    if (!serial || !this.devices[serial]) return;
    const enabled = policy.enabled !== false;
    const stop = parseInt(policy.stop, 10);
    const resume = parseInt(policy.resume, 10);
    if (enabled && !(resume > 0 && resume < stop && stop <= 100)) {
      this.emit('log', `${serial}: ignoring invalid charge policy (resume ${resume}, stop ${stop})`);
      return;
    }
    const pol = { enabled, stop, resume };
    this.devices[serial].chargePolicy = pol;
    const tokens = this._loadTokens();
    if (tokens[serial]) { tokens[serial].chargePolicy = pol; this._saveTokens(tokens); }
    this.emit('log', `set_charge_policy (${serial}) -> ${JSON.stringify(pol)}`);
    this._applyChargePolicy(serial);
    try { ws && ws.send(JSON.stringify({ op: 'meta', data: this._metaPayload(serial) })); } catch {}
  }
  /** Handle create_profiles: bulk pm create-user + clone an app into each, then report back. */
  createProfiles(serial, count, pkg, prefix, ws) {
    count = parseInt(count, 10);
    if (!serial || !this.devices[serial] || !(count >= 1)) return;
    prefix = (String(prefix || 'Profile').replace(/[^\w .\-]/g, ' ').replace(/\s+/g, ' ').trim() || 'Profile').slice(0, 24);
    pkg = String(pkg || '').trim();
    this.emit('log', `create_profiles (${serial}) -> count=${count} package='${pkg}' prefix='${prefix}'`);
    const sh = (args) => this._adb(['-s', serial, 'shell', ...args]);
    let made = 0;
    for (let i = 0; i < count; i++) {
      try {
        const n = this._parseUsers(serial).length;   // next ordinal (owner + any existing)
        const out = sh(['pm', 'create-user', `'${prefix} ${n}'`]);
        const m = /id\s+(\d+)/i.exec(out);
        if (!m) { this.emit('log', `create-user failed: ${out}`); continue; }
        const id = m[1]; made++;
        if (pkg) {
          try { sh(['pm', 'install-existing', '--user', id, pkg]); this.emit('log', `cloned ${pkg} -> user ${id}`); }
          catch (e) { this.emit('log', `install-existing user ${id}: ${(e && e.message) || e}`); }
        }
      } catch (e) { this.emit('log', `create-user error: ${(e && e.message) || e}`); }
    }
    this.emit('log', `create_profiles done: ${made}/${count} created`);
    try { this.devices[serial]._metaCache = null; } catch {}   // force a fresh user list next meta
    try { ws && ws.send(JSON.stringify({ op: 'meta', data: this._metaPayload(serial, true) })); } catch {}
  }
  /** Handle upload_media: fetch each file from the backend and push it into the gallery.
      Files land in /sdcard/DCIM/Camera of the ACTIVE profile, at full original quality (adb push
      is a byte-for-byte copy - nothing is recompressed), then a media scan makes them appear. */
  async uploadMedia(serial, m, ws) {
    const dev = this.devices[serial];
    const transferId = m && m.transfer_id;
    const files = (m && Array.isArray(m.files)) ? m.files : [];
    if (!serial || !dev || !transferId || !files.length) return;
    const token = (this._loadTokens()[serial] || {}).device_token || dev.token || '';
    this.emit('log', `upload_media (${serial}) -> ${files.length} file(s), transfer=${transferId}`);
    const dest = '/sdcard/DCIM/Camera';
    try { this._adb(['-s', serial, 'shell', 'mkdir', '-p', dest]); } catch {}
    const results = [];
    for (const f of files) {
      const name = String((f && f.name) || 'file').replace(/[\/\\\0]/g, '_');
      const tmp = path.join(os.tmpdir(), `pd_${transferId}_${f.idx}_${name}`);
      try {
        const url = `${this.backend}/api/devices/media/${transferId}/${f.idx}?token=${encodeURIComponent(token)}`;
        await this._download(url, tmp);
        await this._adbPush(serial, tmp, `${dest}/${name}`);
        // Make it show up immediately. The legacy broadcast is deprecated on modern Android but the
        // shell is exempt from the file:// restriction; modern MediaProvider also auto-scans DCIM via
        // inotify, so this is belt-and-suspenders. Verify/adjust on a real GrapheneOS device.
        try {
          this._adb(['-s', serial, 'shell', 'am', 'broadcast', '-a',
            'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${dest}/${name}`]);
        } catch {}
        results.push({ name, ok: true });
        this.emit('log', `pushed ${name} -> ${dest}`);
      } catch (e) {
        const err = (e && e.message) || String(e);
        results.push({ name, ok: false, error: err });
        this.emit('log', `upload ${name} failed: ${err}`);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    try { ws && ws.send(JSON.stringify({ op: 'upload_result', transfer_id: transferId, results })); } catch {}
  }
  /** Stream a URL to a local file (Node http/https; no fetch in the Electron main process). */
  _download(url, dest) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch (e) { return reject(e); }
      const lib = u.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(dest);
      const req = lib.get(u, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); try { file.close(); } catch {}
          return reject(new Error('download HTTP ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
    });
  }
  /** adb push with NO 8s cap (unlike _adb) - a large video can take a while over USB. */
  _adbPush(serial, local, remote) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.adbPath, ['-s', serial, 'push', local, remote], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      if (p.stderr) p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve()
        : reject(new Error('adb push exit ' + code + (err ? ': ' + err.trim() : ''))));
    });
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
    const bc = this._batteryAndCharging(serial);   // battery + charging in one adb call
    const cs = dev && dev.chargeStatus;            // human-readable charge-limit state for the dashboard
    if (!full && dev && dev._metaCache) return { battery: bc.battery, charging: bc.charging, charge_status: cs, ...dev._metaCache };
    const cache = { users: this._listUsers(serial), current_user: this._currentUser(serial) };
    if (dev) dev._metaCache = cache;
    return { battery: bc.battery, charging: bc.charging, charge_status: cs, ...cache };
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
  /** Respawn ws-scrcpy after a crash/error, with exponential backoff so a crash-looping process
      can't peg the CPU (or re-run the pkill sweep) every 2s. Both the 'exit' and 'error' handlers
      funnel here; `gone` guards against them both firing for the same process (double-respawn). */
  _respawnWsScrcpy() {
    this._wsStarted = false; this._wsProc = null;
    if (this._stopped) return;        // app is quitting - don't bring it back
    const delay = this._wsBackoff;
    this._wsBackoff = Math.min(this._wsBackoff * 2, 30000);
    this.emit('log', `ws-scrcpy down; respawning in ${delay}ms`);
    this._wsRespawnTimer = setTimeout(() => this.startWsScrcpy(), delay);
  }
  startWsScrcpy() {
    if (this._stopped) return;
    if (this._wsStarted && this._wsProc) return;
    this._wsStarted = true;
    // clear orphaned scrcpy-server on each plugged phone (else its socket stays bound -> no video).
    // Fire-and-forget (NOT execFileSync) so a slow/hung adb here can't freeze the main thread on every
    // respawn; ws-scrcpy tolerates a still-bound socket briefly and the next cycle clears it.
    this.detectAll().forEach((d) => {
      try {
        const p = spawn(this.adbPath, ['-s', d.serial, 'shell', 'pkill', '-f', 'scrcpy'], { stdio: 'ignore' });
        p.on('error', () => {});   // an unhandled spawn 'error' would otherwise throw
      } catch {}
    });
    const adbDir = path.dirname(this.adbPath);
    const env = { ...process.env, ...this.runAsNodeEnv, WS_SCRCPY_PATHNAME: '/stream/', ADB_PATH: this.adbPath };
    const existingPath = env.PATH || env.Path || ''; delete env.PATH; delete env.Path;
    env.PATH = adbDir + path.delimiter + existingPath;
    const proc = spawn(this.nodeBin, ['index.js'], { cwd: this.wsScrcpyDist, env });
    this._wsProc = proc;
    let gone = false;                  // ensure exit/error trigger at most one respawn
    let stableTimer = null;
    const pipe = (s) => s && s.on('data', (d) => this.emit('log', '[ws-scrcpy] ' + String(d).trimEnd()));
    pipe(proc.stdout); pipe(proc.stderr);
    // If it stays up for 30s, treat the launch as healthy and reset the backoff to 1s.
    stableTimer = setTimeout(() => { this._wsBackoff = 1000; }, 30000);
    proc.on('error', (e) => {
      if (gone) return; gone = true; clearTimeout(stableTimer);
      this.emit('log', `ws-scrcpy spawn error: ${(e && e.message) || e}`);
      this._respawnWsScrcpy();
    });
    proc.on('exit', (c) => {
      if (gone) return; gone = true; clearTimeout(stableTimer);
      this.emit('log', `ws-scrcpy exited (${c})`);
      this._respawnWsScrcpy();
    });
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
      if (!plugged[serial]) this._dropDevice(serial);
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
    // Re-pairing a phone whose socket is still live (token changed): tear the old one down first, else
    // it leaks - the stale socket lingers and its heartbeat/ping intervals get orphaned (overwritten
    // by the new socket's 'open' handler) and run forever.
    if (dev.ws) { try { clearInterval(dev.hb); } catch {} try { clearInterval(dev.ping); } catch {} try { dev.ws.close(); } catch {} }
    dev.token = token;
    const ws = new WebSocket(`${this.wsBase}/ws/agent?token=${encodeURIComponent(token)}`);
    dev.ws = ws;
    ws.addEventListener('open', () => {
      dev.backoff = 1000; dev.online = true;
      this.emit('status', { serial, state: 'online' });
      const sendMeta = (full) => { try { ws.send(JSON.stringify({ op: 'meta', data: this._metaPayload(serial, full) })); } catch {} };
      sendMeta(true);                       // first beat: full (battery + fresh user list)
      // Re-apply any saved charge limit (the backend also re-pushes set_charge_policy on connect;
      // doing it here too means the limit holds even if that message is missed).
      try {
        const saved = (this._loadTokens()[serial] || {}).chargePolicy;
        if (saved) { dev.chargePolicy = saved; this._applyChargePolicy(serial); }
      } catch {}
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
      else if (m.op === 'set_charge_policy') this.setChargePolicy(serial, m, ws);   // battery charge limit
      else if (m.op === 'create_profiles') this.createProfiles(serial, m.count, m.package, m.name_prefix, ws);
      else if (m.op === 'upload_media') this.uploadMedia(serial, m, ws);   // push photos/videos to the gallery
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
    Object.keys(this.devices).forEach((serial) => this._dropDevice(serial));   // close handler can't reconnect a deleted entry
    this._killWsScrcpy();
    try { this._adb(['kill-server']); } catch {}   // next adb call auto-starts a fresh daemon
    this.reconcile();
  }

  /** Kill the shared ws-scrcpy without triggering its respawn (we either restart it ourselves or quit). */
  _killWsScrcpy() {
    try { clearTimeout(this._wsRespawnTimer); } catch {}
    this._wsRespawnTimer = null;
    try {
      if (this._wsProc) { this._wsProc.removeAllListeners('exit'); this._wsProc.removeAllListeners('error'); this._wsProc.kill(); }
    } catch {}
    this._wsProc = null; this._wsStarted = false; this._wsBackoff = 1000;
  }

  /** App is quitting: stop every phone-home socket + its timers and kill ws-scrcpy, so we don't leave
      orphan node/adb children (and a scrcpy-server bound on the phone) behind across auto-update restarts. */
  shutdown() {
    this.emit('log', 'shutdown: closing sockets and killing ws-scrcpy');
    this._stopped = true;             // block any pending/future respawn
    Object.keys(this.devices).forEach((serial) => this._dropDevice(serial));
    this._killWsScrcpy();
  }

  /** Reset: forget EVERY pairing on this computer (deletes the saved token file). The escape hatch
      when a phone is stuck after being removed on the website - phones then show as new and can be
      re-added with a fresh code. */
  resetPairings() {
    this.emit('log', 'reset: clearing all local pairings (agent.json)');
    Object.keys(this.devices).forEach((serial) => this._dropDevice(serial));
    try { fs.unlinkSync(this.tokenFile); } catch (e) { this.emit('log', 'reset unlink: ' + ((e && e.message) || e)); }
    this.reconcile();
  }

  /** The server removed this phone: forget its token, stop reconnecting (frees a pairing slot). */
  unpair(serial) {
    const tokens = this._loadTokens();
    if (tokens[serial]) { delete tokens[serial]; this._saveTokens(tokens); }
    try { this._restoreCharging(serial); } catch {}   // stop limiting before we forget the phone
    this._dropDevice(serial);
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
