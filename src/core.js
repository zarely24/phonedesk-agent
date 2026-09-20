'use strict';
/*
 * AgentCore - the engine. Manages UP TO N phones on one computer:
 *   detect phones (adb) -> ONE shared ws-scrcpy -> pair each (one code per phone)
 *   -> a phone-home socket + token PER phone -> tunnel streams.
 * Auto-reconnects paired phones that are plugged in; drops ones that get unplugged.
 * Emits: 'status' ({serial, state}), 'log'.
 */
const { EventEmitter } = require('events');
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const instagram = require('./instagram');   // Instagram account-status classifier (pure/testable)

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

// POST raw bytes. Used only by the uplink probe, which needs to push a burst and be told how long
// the SERVER took to receive it - so the body is bytes, not JSON, and the reply carries the verdict.
function postBytes(url, buf, headers, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, ...headers },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('uplink probe timed out')));
    req.write(buf);
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
    try { clearTimeout(dev.hbStart); } catch {}
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
  /** Async twin of _adb, and the one anything on a timer MUST use.
      THIS PROCESS IS ALSO THE VIDEO RELAY (see openTunnel): frames from ws-scrcpy are pumped to the
      backend on this same single event loop. So every synchronous adb call freezes EVERY phone's
      stream for as long as adb takes - 100-600ms on a loaded USB tree. With 18 phones on one computer
      the polling alone was ~190 blocking calls a minute; measured at the server that showed up as
      video stalls of 178-672ms in the data arriving from this agent, which is exactly the stutter the
      VAs report. One-off calls triggered by a human action may stay synchronous; recurring ones cannot. */
  _adbAsync(args) {
    return new Promise((resolve, reject) => {
      execFile(this.adbPath, args, { encoding: 'utf8', timeout: 8000 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout || '').trim());
      });
    });
  }
  async _batteryAndChargingAsync(serial) {
    try {
      const out = await this._adbAsync(['-s', serial, 'shell', 'dumpsys', 'battery']);
      const lvl = /level:\s*(\d+)/.exec(out);
      const status = /status:\s*(\d+)/.exec(out);
      const powered = [/AC powered:\s*true/i, /USB powered:\s*true/i, /Wireless powered:\s*true/i]
        .some((re) => re.test(out));
      return { battery: lvl ? parseInt(lvl[1], 10) : null, charging: status ? status[1] === '2' : powered };
    } catch { return { battery: null, charging: null }; }
  }
  async _listUsersAsync(serial) {
    const users = [];
    try {
      const out = await this._adbAsync(['-s', serial, 'shell', 'pm', 'list', 'users']);
      out.split('\n').forEach((l) => {
        const m = /UserInfo\{(\d+):([^:]*):/.exec(l);
        if (m) users.push({ id: parseInt(m[1], 10), name: (m[2] || ('Profile ' + m[1])).trim() });
      });
    } catch { return []; }
    const ov = (this._loadTokens()[serial] || {}).profiles || {};
    users.forEach((u) => { if (ov[u.id]) u.name = ov[u.id]; });
    return users;
  }
  async _currentUserAsync(serial) {
    try {
      const v = parseInt(await this._adbAsync(['-s', serial, 'shell', 'am', 'get-current-user']), 10);
      return isNaN(v) ? null : v;
    } catch { return null; }
  }
  /** Async twin of _metaPayload, used by the heartbeat. Same caching rule: the profile list barely
      ever changes, so only a `full` beat re-reads it. */
  async _metaPayloadAsync(serial, full = true) {
    const dev = this.devices[serial];
    const bc = await this._batteryAndChargingAsync(serial);
    const cs = dev && dev.chargeStatus;
    if (!full && dev && dev._metaCache) {
      return { battery: bc.battery, charging: bc.charging, charge_status: cs, host: this._hostStats(), ...dev._metaCache };
    }
    const cache = { users: await this._listUsersAsync(serial), current_user: await this._currentUserAsync(serial) };
    if (dev) dev._metaCache = cache;
    return { battery: bc.battery, charging: bc.charging, charge_status: cs, host: this._hostStats(), ...cache };
  }
  /** Health of the computer the phones are plugged into.
      Reported on every heartbeat so we can see the machine instead of guessing about it. Free to
      collect: os.cpus() and process.cpuUsage() are in-process counters, no shell-out, no adb -
      which matters, because this runs on the same event loop that relays the video.
      busiestCore is the number that counts. ws-scrcpy relays all 18 phones on ONE Node thread and
      this agent is a second one, so the ceiling is a single core, not the CPU as a whole: 100% on
      one core with the average at 15% means saturated, however idle the machine looks. */
  _hostStats() {
    const now = Date.now();
    // Shared across all phones on this computer. Without this cache each of the 18 heartbeats would
    // recompute the delta against the previous phone's reading milliseconds earlier, and every CPU
    // number would be noise measured over a near-zero window.
    if (this._hostCache && now - this._hostCacheAt < 10000) return this._hostCache;
    const cpus = os.cpus();
    const cur = cpus.map((c) => {
      const t = c.times;
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
    });
    let perCore = [];
    if (this._cpuPrev && this._cpuPrev.length === cur.length) {
      perCore = cur.map((c, i) => {
        const dTotal = c.total - this._cpuPrev[i].total;
        const dIdle = c.idle - this._cpuPrev[i].idle;
        return dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0;
      });
    }
    this._cpuPrev = cur;

    // This process's own share, as a percentage of ONE core (so >100 is impossible here).
    let agentPct = null;
    const cu = process.cpuUsage();
    if (this._cpuUsagePrev && this._cpuStamp) {
      const usedMs = (cu.user - this._cpuUsagePrev.user + cu.system - this._cpuUsagePrev.system) / 1000;
      const wallMs = now - this._cpuStamp;
      if (wallMs > 0) agentPct = Math.max(0, Math.min(100, Math.round((usedMs / wallMs) * 100)));
    }
    this._cpuUsagePrev = cu;
    this._cpuStamp = now;

    const totalMem = os.totalmem();
    const stats = {
      // A stable, non-identifying id instead of the hostname: machines are often named after the
      // person who owns them, and that name has no business appearing on the dashboard. The hash is
      // only used to group the phones that share a computer.
      id: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8),
      cores: cpus.length,
      cpu_model: (cpus[0] && cpus[0].model) ? cpus[0].model.trim() : '',
      cpu_avg: perCore.length ? Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length) : null,
      cpu_busiest_core: perCore.length ? Math.max(...perCore) : null,
      cpu_per_core: perCore,
      agent_cpu: agentPct,
      mem_used_gb: Math.round((totalMem - os.freemem()) / 1073741824 * 10) / 10,
      mem_total_gb: Math.round(totalMem / 1073741824 * 10) / 10,
      phones_connected: Object.keys(this.devices || {}).length,
      streams_open: this._openTunnels || 0,
      // Last measured upload speed for this computer, so the dashboard can show the farm's real
      // bandwidth next to its CPU. The backend records probes itself; this is only for display.
      uplink_bps: (this._lastUplink || {}).bps || null,
      uplink_at: (this._lastUplink || {}).at || null,
      uptime_h: Math.round(os.uptime() / 360) / 10,
    };
    this._hostCache = stats;
    this._hostCacheAt = now;
    return stats;
  }
  /** Cached `adb devices`. This used to shell out on the 2s reconcile timer - another blocking call
      every two seconds. _refreshDevices() keeps the cache warm off the event loop; the very first
      read falls back to the blocking call so startup behaviour is unchanged. */
  detectAll() {
    if (!this._deviceCache) this._deviceCache = this._detectAllBlocking();
    return this._deviceCache;
  }
  _rowsToDevices(out) {
    return out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t'))
      .filter((p) => p[1] === 'device' || p[1] === 'unauthorized')
      .map((p) => ({ serial: p[0], state: p[1] === 'device' ? 'ready' : 'unauthorized' }));
  }
  _detectAllBlocking() {
    try { return this._rowsToDevices(this._adb(['devices'])); } catch { return []; }
  }
  _refreshDevices() {
    return this._adbAsync(['devices'])
      .then((out) => { this._deviceCache = this._rowsToDevices(out); })
      .catch(() => {});
  }
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
    // Async battery read: this runs once a minute for EVERY phone, and a blocking read here stalls
    // the video relay just as the heartbeat did. Flipping the gate is rare (only when a threshold is
    // crossed), so that one may stay synchronous.
    const tick = () => {
      this._batteryAndChargingAsync(serial).then(({ battery: b }) => {
        if (b == null) return;
        try {
          if (b >= stop) this._setGate(serial, gate, false);
          else if (b <= resume) this._setGate(serial, gate, true);
        } catch {}
      }).catch(() => {});
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
        // Make the profile usable headlessly: mark its setup as already complete so switching to it
        // lands on the home screen instead of the first-run wizard that forces a PIN. No human has to
        // tap "skip" on each phone. settings/am run under shell (WRITE_SECURE_SETTINGS) - no root.
        // (GrapheneOS's wizard differs slightly; verify on a real device and adjust if it still prompts.)
        try {
          sh(['am', 'start-user', id]);                                       // bring the profile up
          sh(['settings', 'put', '--user', id, 'secure', 'user_setup_complete', '1']);
          sh(['settings', 'put', '--user', id, 'secure', 'tv_user_setup_complete', '1']);
          this.emit('log', `profile ${id}: setup marked complete (no PIN prompt)`);
        } catch (e) { this.emit('log', `setup-skip user ${id}: ${(e && e.message) || e}`); }
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
    // Which profile's gallery? user 0 (or unset) = the primary profile, reachable via /sdcard.
    // A secondary profile has its own storage at /storage/emulated/<userId>. adb runs as the
    // "shell" user which can reach the primary always; secondary profiles may need root.
    const uid = (m.user_id === 0 || m.user_id > 0) ? m.user_id : null;
    this.emit('log', `upload_media (${serial}) -> ${files.length} file(s), profile=${uid == null ? 'main' : uid}, transfer=${transferId}`);
    const results = [];
    for (const f of files) {
      const name = String((f && f.name) || 'file').replace(/[\/\\\0]/g, '_');
      const tmp = path.join(os.tmpdir(), `pd_${transferId}_${f.idx}_${name}`);
      try {
        const url = `${this.backend}/api/devices/media/${transferId}/${f.idx}?token=${encodeURIComponent(token)}`;
        await this._download(url, tmp);
        const landed = await this._pushToGallery(serial, tmp, name, uid);
        results.push({ name, ok: true });
        this.emit('log', `pushed ${name} -> ${landed}`);
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
  /** Land one file in DCIM/Camera of the target profile at full quality, then make it visible.
      The method depends on which Android user owns that gallery:
        - main / user 0: adb's shell already lives in that user, so a direct push + media scan works.
        - a secondary profile: /storage/emulated/<uid> is a per-user mount the shell cannot reach - a
          direct push dies with "stat failed: Permission denied". With root we cp in as su (root sees
          every user's mount); without root we go through that user's MediaStore via `content`, which
          IS permitted cross-user for the shell uid. Returns a short location string for logging. */
  async _pushToGallery(serial, local, name, uid) {
    if (!uid || uid === 0) {
      const dest = '/sdcard/DCIM/Camera';
      try { this._adb(['-s', serial, 'shell', 'mkdir', '-p', dest]); } catch {}
      await this._adbPush(serial, local, `${dest}/${name}`);
      try {
        this._adb(['-s', serial, 'shell', 'am', 'broadcast',
          '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${dest}/${name}`]);
      } catch {}
      return `${dest}/${name}`;
    }
    try { this._adb(['-s', serial, 'shell', 'am', 'start-user', String(uid)]); } catch {}   // provider must be up
    return this._hasRoot(serial)
      ? this._pushToGalleryRoot(serial, local, name, uid)
      : this._pushToGalleryMediaStore(serial, local, name, uid);
  }
  /** Rooted path: stage in a shell-writable dir, su-cp into the secondary user's DCIM (FUSE synthesizes
      app-readable ownership on the copy), then scan it into that user's MediaStore. */
  async _pushToGalleryRoot(serial, local, name, uid) {
    const dest = `/storage/emulated/${uid}/DCIM/Camera`;
    const staged = `/data/local/tmp/pd_${uid}_${name.replace(/[^\w.\-]/g, '_')}`;
    await this._adbPush(serial, local, staged);
    try {
      const inner = `mkdir -p '${dest}' && cp '${staged}' '${dest}/${name}'`;
      this._adb(['-s', serial, 'shell', `${this.suPrefix} "${inner}"`]);
      try { this._adb(['-s', serial, 'shell', `${this.suPrefix} "cmd media scan '${dest}/${name}'"`]); }
      catch {
        try { this._adb(['-s', serial, 'shell', 'am', 'broadcast', '--user', String(uid),
          '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${dest}/${name}`]); } catch {}
      }
    } finally {
      try { this._adb(['-s', serial, 'shell', 'rm', '-f', staged]); } catch {}
    }
    return `${dest}/${name} (user ${uid}, root)`;
  }
  /** Non-root path: create a row in the secondary user's MediaStore and stream the bytes into it. The
      byte redirect runs on-device (from a staged tmp file) so the adb-shell PTY can't corrupt binary
      data, and the write uses the uncapped shell since a large video can exceed the 8s _adb timeout. */
  async _pushToGalleryMediaStore(serial, local, name, uid) {
    const isVideo = /\.(mp4|mov|m4v|3gp|mkv|webm|avi)$/i.test(name);
    const coll = isVideo ? 'content://media/external/video/media'
                         : 'content://media/external/images/media';
    const staged = `/data/local/tmp/pd_${uid}_${name.replace(/[^\w.\-]/g, '_')}`;
    await this._adbPush(serial, local, staged);
    try {
      // Build ONE remote command string with each value wrapped in device-shell single quotes.
      // adb shell concatenates argv into a string the phone's /system/bin/sh re-parses, which
      // strips bare quotes and splits on spaces - so a filename with a space, or the SQL literal
      // in the query below, arrives mangled unless we quote it for that shell ourselves.
      const insertCmd = `content insert --user ${uid} --uri ${coll}`
        + ` --bind ${this._shq('_display_name:s:' + name)}`
        + ` --bind ${this._shq('mime_type:s:' + this._mimeFor(name, isVideo))}`
        + ` --bind ${this._shq('relative_path:s:DCIM/Camera/')}`;
      this._adb(['-s', serial, 'shell', insertCmd]);
      const id = this._mediaStoreId(serial, coll, name, uid);
      if (id == null) throw new Error('MediaStore row not found after insert');
      await this._adbShellLong(serial, `content write --user ${uid} --uri ${coll}/${id} < '${staged}'`);
      return `${coll}/${id} (user ${uid}, mediastore)`;
    } finally {
      try { this._adb(['-s', serial, 'shell', 'rm', '-f', staged]); } catch {}
    }
  }
  /** Single-quote a value for the phone's /system/bin/sh. adb shell joins argv into one string
      that the device shell re-parses, so any value carrying a space or an SQL quote must be quoted
      for THAT shell or it gets split / stripped before `content` ever sees it. */
  _shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  /** Newest MediaStore _id for a display name in a given user - the row we just inserted (sort DESC,
      first row wins). Returns null if the query finds nothing.

      The --where value is an SQL string literal (its own single quotes), and it must survive the
      phone's shell intact - the earlier version passed it unquoted, the device shell dropped the
      quotes, and `content` got `_display_name=NAME.jpeg` (a bare token, not a string), matched
      nothing, and every secondary-profile upload failed with "row not found after insert". */
  _mediaStoreId(serial, coll, name, uid) {
    const where = `_display_name='${String(name).replace(/'/g, "''")}'`;
    try {
      const cmd = `content query --user ${uid} --uri ${coll} --projection _id`
        + ` --where ${this._shq(where)} --sort ${this._shq('_id DESC')}`;
      const out = this._adb(['-s', serial, 'shell', cmd]);
      const m = /_id=(\d+)/.exec(out);
      return m ? m[1] : null;
    } catch { return null; }
  }
  _mimeFor(name, isVideo) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
      mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', '3gp': 'video/3gpp',
      mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo' };
    return map[ext] || (isVideo ? 'video/mp4' : 'image/jpeg');
  }
  /** adb shell for one command string with no 8s cap (mirrors _adbPush's spawn). */
  _adbShellLong(serial, cmd) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.adbPath, ['-s', serial, 'shell', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      if (p.stderr) p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve()
        : reject(new Error('adb shell exit ' + code + (err ? ': ' + err.trim() : ''))));
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
  _deviceInfo(serial) {
    const model = this._getprop(serial, 'ro.product.model');
    return { brand: this._getprop(serial, 'ro.product.brand'), model, android: this._getprop(serial, 'ro.build.version.release'), name: model || 'Phone' };
  }
  firstUnpairedReady() { const t = this._loadTokens(); return this.detectAll().find((d) => d.state === 'ready' && !t[d.serial]) || null; }

  /** Persist the dashboard-assigned name + list position the backend pushed down, so the owner's
      app shows the SAME label and order the manager sees - making each physical phone identifiable.
      The 2s status poll redraws the wizard, so no explicit UI nudge is needed. */
  setLabel(serial, m) {
    const tokens = this._loadTokens();
    const entry = tokens[serial];
    if (!entry) return;   // not a phone this computer owns
    if (typeof m.name === 'string' && m.name.trim()) entry.name = m.name.trim().slice(0, 40);
    if (Number.isFinite(m.position)) entry.position = m.position;
    this._saveTokens(tokens);
    this.emit('log', `label set for ${serial}: "${entry.name}"${Number.isFinite(entry.position) ? ' pos ' + entry.position : ''}`);
  }

  /** Snapshot for the wizard: phones (plugged + paired) with paired/online flags + counts,
      ordered by the manager's dashboard position (unset positions sink to the bottom). */
  status() {
    const tokens = this._loadTokens();
    const seen = {};
    const phones = this.detectAll().map((d) => {
      seen[d.serial] = true;
      const t = tokens[d.serial] || {};
      return { serial: d.serial, state: d.state, name: t.name || 'Phone', position: t.position,
        paired: !!tokens[d.serial], online: !!(this.devices[d.serial] && this.devices[d.serial].online) };
    });
    Object.keys(tokens).forEach((serial) => {   // paired but not currently plugged in
      if (!seen[serial]) phones.push({ serial, state: 'absent', name: tokens[serial].name || 'Phone',
        position: tokens[serial].position, paired: true,
        online: !!(this.devices[serial] && this.devices[serial].online) });
    });
    const pos = (p) => (Number.isFinite(p.position) ? p.position : 1e9);
    phones.sort((a, b) => pos(a) - pos(b) || String(a.name).localeCompare(String(b.name)));
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
    this._refreshDevices();   // async; detectAll() below reads the cache it keeps warm
    this.startWsScrcpy();
    this._startUplinkProbes();
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
    if (dev.ws) { try { clearTimeout(dev.hbStart); } catch {} try { clearInterval(dev.hb); } catch {} try { clearInterval(dev.ping); } catch {} try { dev.ws.close(); } catch {} }
    dev.token = token;
    const ws = new WebSocket(`${this.wsBase}/ws/agent?token=${encodeURIComponent(token)}`);
    dev.ws = ws;
    ws.addEventListener('open', () => {
      dev.backoff = 1000; dev.online = true;
      this.emit('status', { serial, state: 'online' });
      const sendMeta = (full) => {
        // Async: _metaPayload's synchronous adb calls used to stall every phone's video (see _adbAsync).
        this._metaPayloadAsync(serial, full)
          .then((data) => { try { ws.send(JSON.stringify({ op: 'meta', data })); } catch {} })
          .catch(() => {});
      };
      sendMeta(true);                       // first beat: full (battery + fresh user list)
      // Re-apply any saved charge limit (the backend also re-pushes set_charge_policy on connect;
      // doing it here too means the limit holds even if that message is missed).
      try {
        const saved = (this._loadTokens()[serial] || {}).chargePolicy;
        if (saved) { dev.chargePolicy = saved; this._applyChargePolicy(serial); }
      } catch {}
      let beat = 0;
      // Battery every 30s (it is a dashboard number, not telemetry), full profile list every 60s.
      // The random offset matters: all 18 phones connect within a second of each other at startup, so
      // without it every poll lands in the same instant and they queue behind one another on the USB
      // tree. Spreading them turns one big periodic hit into a thin trickle.
      const HB_MS = 30000;
      dev.hbStart = setTimeout(() => {
        sendMeta(false);
        dev.hb = setInterval(() => { beat = (beat + 1) % 2; sendMeta(beat === 0); }, HB_MS);
      }, Math.floor(Math.random() * HB_MS));
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
      else if (m.op === 'refresh') this.refreshOne(serial);   // VA pressed "Refresh phone" on ONE phone's row
      else if (m.op === 'set_charge_policy') this.setChargePolicy(serial, m, ws);   // battery charge limit
      else if (m.op === 'create_profiles') this.createProfiles(serial, m.count, m.package, m.name_prefix, ws);
      else if (m.op === 'upload_media') this.uploadMedia(serial, m, ws);   // push photos/videos to the gallery
      else if (m.op === 'set_label') this.setLabel(serial, m);   // dashboard name/order -> owner app
      // Account monitoring + shortcuts (request/response over this same socket; reply carries request_id).
      else if (m.op === 'check_apps_installed') this.checkAppsInstalled(serial, m, ws);
      else if (m.op === 'launch_app') this.launchApp(serial, m, ws);
      else if (m.op === 'open_url') this.openUrl(serial, m, ws);
      else if (m.op === 'check_account_status') this.checkAccountStatus(serial, m, ws);
      // Physical device controls (real, deterministic: PhoneDesk button -> here -> adb -> phone).
      else if (m.op === 'input_key') this.inputKey(serial, m, ws);        // Power/Vol/Back/Home/Recent...
      else if (m.op === 'input_text') this.inputText(serial, m, ws);      // keyboard text into the focused field
      else if (m.op === 'screenshot') this.screenshot(serial, m, ws);     // adb screencap -> PNG back to the VA
      else if (m.op === 'input_tap') this.inputTap(serial, m, ws);        // tap at device coords (WebRTC video)
      else if (m.op === 'input_swipe') this.inputSwipe(serial, m, ws);    // swipe/drag/scroll at device coords
      // WebRTC video (POC, per-device flag on the backend). Signaling only rides this socket; SRTP
      // media goes agent <-> (coturn) <-> browser directly. See src/webrtc.js.
      else if (m.op === 'open_webrtc' || m.op === 'rtc_answer' || m.op === 'rtc_ice' || m.op === 'close_webrtc') {
        // Isolated: any error loading/handling WebRTC stays here — never breaks the agent, other
        // phones, or legacy streaming (spec §5). WebRTC is off by default; this only runs for the
        // opt-in test device the backend allows.
        try {
          const wrtc = require('./webrtc');
          if (m.op === 'open_webrtc') wrtc.open(this, ws, serial, m);
          else if (m.op === 'rtc_answer') wrtc.answer(this, m);
          else if (m.op === 'rtc_ice') wrtc.ice(this, m);
          else wrtc.close(this, m);
        } catch (e) { this.emit('log', '[webrtc] dispatch error (isolated): ' + (e && e.message)); }
      }
    });
    ws.addEventListener('close', (e) => {
      clearTimeout(dev.hbStart); clearInterval(dev.hb); clearInterval(dev.ping); dev.online = false;
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

  /** Manual refresh of ONE phone (the row the VA clicked on the website): reconnect just that
      phone so the rest of the fleet stays live. reconcile() reconnects the dropped phone and
      leaves already-connected phones untouched, and it won't restart the shared ws-scrcpy or the
      adb server (those are fleet-wide - killing them is what used to disconnect every phone). */
  refreshOne(serial) {
    if (!serial || !this.devices[serial]) return;
    this.emit('log', `manual refresh (${serial}): reconnecting this phone only`);
    this._dropDevice(serial);
    this.reconcile();
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
    try { clearInterval(this._uplinkTimer); } catch {}
    this._uplinkTimer = null;
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

  /** Measure this computer's REAL upload speed, by pushing a burst at the backend and letting it
      time the arrival.

      Why here and not a speedtest website: this is the exact leg that carries the video - this
      computer to the PhoneDesk server, same protocol, same host. A speedtest to a nearby ISP mirror
      can read fine while this path does not, and it is this path the VAs actually watch through.

      Why only when nothing is streaming: the burst would otherwise compete with a VA's video, and
      then neither number means anything - the probe reads low because video is using the line, and
      the video stutters because the probe is. On a 0.79 Mbit/s line that is not a subtle effect.

      Deliberately small (256 KB, ~2.6s at 0.79 Mbit/s): big enough to get past TCP slow-start,
      small enough that it is not itself an outage. */
  async _uplinkProbe() {
    if ((this._openTunnels || 0) > 0) return;               // someone is watching; don't fight them
    const tokens = this._loadTokens();
    const serial = Object.keys(tokens)[0];
    const token = serial && (tokens[serial] || {}).device_token;
    if (!token) return;                                      // nothing paired yet, nothing to measure
    const SIZE = 256 * 1024;
    // Random bytes, not zeroes: a run of zeroes is trivially compressible and any transparent proxy
    // or middlebox on the path could squeeze it, which would read as a line far faster than it is.
    const buf = crypto.randomBytes(SIZE);
    try {
      const r = await postBytes(`${this.backend}/api/uplink-probe`, buf, { 'x-device-token': token });
      if (r && r.bps) {
        this._lastUplink = { bps: r.bps, at: Date.now() };
        this.emit('log', `uplink probe: ${(r.bps / 1e6).toFixed(2)} Mbit/s up ` +
                         `(${SIZE / 1024}KB in ${r.seconds}s) -> budget ${(r.budget_bps / 1e6).toFixed(2)} Mbit/s, ` +
                         `about ${r.max_viewers} viewer(s) at once`);
      } else if (r && r.why) {
        this.emit('log', `uplink probe inconclusive: ${r.why}`);
      }
    } catch (e) {
      this.emit('log', `uplink probe failed: ${(e && e.message) || e}`);
    }
  }

  /** Run the probe on a timer. Started from reconcile() so it begins once something is paired, and
      guarded so repeated reconciles do not stack up timers. The first run is delayed and the
      interval jittered: every agent in the fleet starts within seconds of a power cut, and 18 of
      them probing in lockstep would measure nothing but each other. */
  _startUplinkProbes() {
    if (this._uplinkTimer) return;
    const EVERY = 20 * 60 * 1000;
    const jitter = () => EVERY + Math.floor(Math.random() * 5 * 60 * 1000);
    setTimeout(() => this._uplinkProbe(), 30000 + Math.floor(Math.random() * 60000));
    this._uplinkTimer = setInterval(() => this._uplinkProbe(), jitter());
  }

  openTunnel(serial, token, streamId, query) {
    if (!streamId) { this.emit('log', `open_stream ignored (${serial}): missing stream_id`); return; }
    // Count live streams, so CPU can be read against how many VAs are actually watching.
    this._openTunnels = (this._openTunnels || 0) + 1;
    let counted = true;
    const uncount = () => { if (counted) { counted = false; this._openTunnels = Math.max(0, (this._openTunnels || 1) - 1); } };
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
    tunnel.addEventListener('close', uncount); tunnel.addEventListener('error', uncount);
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

  // ===========================================================================================
  // Account monitoring + shortcuts (spec §3-22). Request/response over the phone-home socket: the
  // backend sends an op with a request_id, we do the work and reply with op:'rpc_result'. Every
  // operation targets an explicit Android user (uid) and NEVER silently falls back to the owner
  // profile (spec §8). NONE of this touches the video stream/quality (spec §34).
  // ===========================================================================================
  _rpcReply(ws, m, obj) {
    try { ws && ws.readyState === 1 && ws.send(JSON.stringify(Object.assign({ op: 'rpc_result', request_id: m && m.request_id }, obj))); } catch {}
  }
  /** adb with a longer timeout + bigger buffer than _adb — uiautomator/pm dumps exceed the 8s cap. */
  _adbLong(serial, args, ms) {
    return new Promise((resolve, reject) => {
      execFile(this.adbPath, ['-s', serial, ...args], { encoding: 'utf8', timeout: ms || 30000, maxBuffer: 12 * 1024 * 1024 },
        (err, stdout, stderr) => { if (err) reject(new Error(String(stderr || err.message || '').trim())); else resolve(String(stdout || '').trim()); });
    });
  }
  async _userExists(serial, uid) {
    const out = await this._adbLong(serial, ['shell', 'pm', 'list', 'users'], 8000);
    return new RegExp('UserInfo\\{' + uid + ':').test(out);        // e.g. "UserInfo{0:Owner:c13} running"
  }
  async _pkgInstalledForUser(serial, uid, pkg) {
    const out = await this._adbLong(serial, ['shell', 'pm', 'list', 'packages', '--user', String(uid), pkg], 10000);
    return out.split('\n').some((l) => l.trim() === 'package:' + pkg);   // pm can substring-match; require exact
  }
  async _resolveLauncher(serial, uid, pkg) {
    try {
      const out = await this._adbLong(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '--user', String(uid), pkg], 8000);
      const line = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
      if (line.includes('/')) return line;                          // com.instagram.android/.activity.MainTabActivity
    } catch {}
    return null;
  }
  async _uiDump(serial) {
    await this._adbLong(serial, ['shell', 'uiautomator', 'dump', '/sdcard/pd_ui.xml'], 20000);
    return this._adbLong(serial, ['shell', 'cat', '/sdcard/pd_ui.xml'], 10000);
  }

  async checkAppsInstalled(serial, m, ws) {
    const uid = parseInt(m.uid != null ? m.uid : 0, 10);
    const packages = Array.isArray(m.packages) ? m.packages : [];
    try {
      if (!(await this._userExists(serial, uid))) return this._rpcReply(ws, m, { ok: false, state: 'profile_not_found', error: 'PROFILE_NOT_FOUND' });
      const installed = {};
      for (const p of packages) { try { installed[p] = await this._pkgInstalledForUser(serial, uid, p); } catch { installed[p] = false; } }
      this._rpcReply(ws, m, { ok: true, uid, installed });
    } catch (e) { this._rpcReply(ws, m, { ok: false, state: 'error', error: String((e && e.message) || e) }); }
  }

  async launchApp(serial, m, ws) {
    const uid = parseInt(m.uid != null ? m.uid : 0, 10);
    const pkg = String(m.package || '');
    try {
      if (!pkg) return this._rpcReply(ws, m, { ok: false, state: 'launch_failed', error: 'no package' });
      if (!(await this._userExists(serial, uid))) return this._rpcReply(ws, m, { ok: false, state: 'profile_not_found', error: 'PROFILE_NOT_FOUND' });
      if (!(await this._pkgInstalledForUser(serial, uid, pkg))) return this._rpcReply(ws, m, { ok: false, state: 'app_not_installed', error: 'APP_NOT_INSTALLED' });
      const comp = await this._resolveLauncher(serial, uid, pkg);
      const out = comp
        ? await this._adbLong(serial, ['shell', 'am', 'start', '--user', String(uid), '-n', comp], 10000)
        : await this._adbLong(serial, ['shell', 'monkey', '-p', pkg, '--user', String(uid), '-c', 'android.intent.category.LAUNCHER', '1'], 10000);
      const ok = !/error|exception|not found|no activities/i.test(out || '');
      this.emit('log', `launch_app (${serial}) user=${uid} ${pkg} -> ${ok ? 'opened' : 'failed'}`);
      this._rpcReply(ws, m, ok ? { ok: true, state: 'opened' } : { ok: false, state: 'launch_failed', error: (out || '').slice(0, 200) });
    } catch (e) { this._rpcReply(ws, m, { ok: false, state: 'launch_failed', error: String((e && e.message) || e) }); }
  }

  async openUrl(serial, m, ws) {
    const uid = parseInt(m.uid != null ? m.uid : 0, 10);
    const url = String(m.url || '');
    try {
      if (!/^https?:\/\//i.test(url)) return this._rpcReply(ws, m, { ok: false, state: 'launch_failed', error: 'invalid url' });
      if (!(await this._userExists(serial, uid))) return this._rpcReply(ws, m, { ok: false, state: 'profile_not_found', error: 'PROFILE_NOT_FOUND' });
      // Opens in the profile's default browser (its existing logged-in session). We never touch
      // cookies/credentials (spec §7).
      const out = await this._adbLong(serial, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, '--user', String(uid)], 10000);
      const ok = !/error|exception|no activities|unable/i.test(out || '');
      this.emit('log', `open_url (${serial}) user=${uid} -> ${ok ? 'opened' : 'failed'}`);
      this._rpcReply(ws, m, ok ? { ok: true, state: 'opened' } : { ok: false, state: 'launch_failed', error: (out || '').slice(0, 200) });
    } catch (e) { this._rpcReply(ws, m, { ok: false, state: 'launch_failed', error: String((e && e.message) || e) }); }
  }

  // ===========================================================================================
  // Physical controls. These are the SAME hardware/nav keys a person would press, sent straight to
  // the device with `adb ... input`. Device-global (a keyevent is not per-profile), whitelisted so a
  // request can never inject an arbitrary keycode, and they touch NOTHING about the video stream or
  // its quality. `ok:true` means adb dispatched the event without error - it is NOT proof the phone
  // visibly reacted; that is confirmed by watching the stream (spec: PASS = observed on the device).
  // ===========================================================================================
  async inputKey(serial, m, ws) {
    // Only the controls PhoneDesk exposes. Airplane is deliberately absent (toggling it can drop the
    // phone off the network and needs WRITE_SECURE_SETTINGS - unsafe to do blind).
    const KEYS = { power: 26, volume_up: 24, volume_down: 25, back: 4, home: 3, recent: 187,
                   enter: 66, backspace: 67, tab: 61, menu: 82, dpad_up: 19, dpad_down: 20 };
    const key = String(m.key || '').toLowerCase();
    const code = KEYS[key];
    if (code == null) return this._rpcReply(ws, m, { ok: false, state: 'bad_key', error: 'unsupported key: ' + key });
    try {
      await this._adbLong(serial, ['shell', 'input', 'keyevent', String(code)], 8000);
      this.emit('log', `input_key (${serial}) ${key}`);
      this._rpcReply(ws, m, { ok: true, key });
    } catch (e) { this._rpcReply(ws, m, { ok: false, state: 'error', error: String((e && e.message) || e) }); }
  }

  // Coordinate input for the WebRTC video (the legacy path taps via ws-scrcpy inside the iframe;
  // the WebRTC <video> maps the click on the browser side and sends DEVICE coords here). Device-global.
  async inputTap(serial, m, ws) {
    const x = Math.round(m.x), y = Math.round(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this._rpcReply(ws, m, { ok: false, error: 'bad coords' });
    try { await this._adbLong(serial, ['shell', 'input', 'tap', String(x), String(y)], 8000); this._rpcReply(ws, m, { ok: true }); }
    catch (e) { this._rpcReply(ws, m, { ok: false, error: String((e && e.message) || e) }); }
  }
  async inputSwipe(serial, m, ws) {
    const a = [m.x1, m.y1, m.x2, m.y2].map((v) => Math.round(v));
    if (a.some((v) => !Number.isFinite(v))) return this._rpcReply(ws, m, { ok: false, error: 'bad coords' });
    const dur = Math.max(10, Math.min(3000, Math.round(m.dur || 150)));   // ms; scroll/drag use longer
    try { await this._adbLong(serial, ['shell', 'input', 'swipe', ...a.map(String), String(dur)], 8000); this._rpcReply(ws, m, { ok: true }); }
    catch (e) { this._rpcReply(ws, m, { ok: false, error: String((e && e.message) || e) }); }
  }

  async inputText(serial, m, ws) {
    const text = String(m.text != null ? m.text : '');
    if (!text) return this._rpcReply(ws, m, { ok: false, state: 'empty', error: 'no text' });
    // `input text` wants %s for spaces; backslash-escape the chars the DEVICE shell would otherwise
    // interpret so they reach `input` literally. ASCII only - unicode needs an IME (out of scope).
    const enc = text.replace(/ /g, '%s').replace(/(["\\$`&;<>|()*?~#!'])/g, '\\$1');
    try {
      await this._adbLong(serial, ['shell', 'input', 'text', enc], 8000);
      this.emit('log', `input_text (${serial}) ${text.length} chars`);
      this._rpcReply(ws, m, { ok: true, chars: text.length });
    } catch (e) { this._rpcReply(ws, m, { ok: false, state: 'error', error: String((e && e.message) || e) }); }
  }

  /** adb that returns raw bytes (screencap is a PNG, not text) - separate from _adbLong which is utf8. */
  _adbBinary(serial, args, ms) {
    return new Promise((resolve, reject) => {
      execFile(this.adbPath, ['-s', serial, ...args], { encoding: 'buffer', timeout: ms || 15000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => { if (err) reject(new Error(String((stderr && stderr.toString()) || (err && err.message) || '').trim())); else resolve(stdout); });
    });
  }

  async screenshot(serial, m, ws) {
    try {
      // exec-out (not `shell`) so the PNG stream isn't corrupted by CRLF translation.
      const png = await this._adbBinary(serial, ['exec-out', 'screencap', '-p'], 15000);
      if (!png || !png.length) return this._rpcReply(ws, m, { ok: false, state: 'error', error: 'empty capture' });
      this.emit('log', `screenshot (${serial}) ${png.length}B`);
      this._rpcReply(ws, m, { ok: true, mime: 'image/png', b64: png.toString('base64'), bytes: png.length });
    } catch (e) { this._rpcReply(ws, m, { ok: false, state: 'error', error: String((e && e.message) || e) }); }
  }

  /** Best-effort deep link into Instagram's Account Status. Not an officially documented scheme, so
      failure is normal — the classifier then returns UNKNOWN rather than guess (spec §21). Real-phone
      tuning may replace this with resource-id/text taps (Profile -> menu -> Account Status). */
  async _navigateAccountStatus(serial, uid) {
    try { await this._adbLong(serial, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'instagram://account_status', '--user', String(uid)], 8000); } catch {}
  }

  async checkAccountStatus(serial, m, ws) {
    const uid = parseInt(m.uid != null ? m.uid : 0, 10);
    const pkg = String(m.package || 'com.instagram.android');
    if (!this._checking) this._checking = new Set();
    // One status check per physical phone at a time (spec §27) — never two navigating the same device.
    if (this._checking.has(serial)) return this._rpcReply(ws, m, { ok: false, state: 'device_busy', status: 'UNKNOWN', error: 'another check in progress' });
    this._checking.add(serial);
    const started = Date.now();
    try {
      if (!(await this._userExists(serial, uid))) return this._rpcReply(ws, m, { ok: false, status: 'PROFILE_UNAVAILABLE', error: 'PROFILE_NOT_FOUND' });
      if (!(await this._pkgInstalledForUser(serial, uid, pkg))) return this._rpcReply(ws, m, { ok: false, status: 'APP_ERROR', error: 'instagram not installed for this profile' });
      // Foreground Instagram for THIS profile (never the owner) then read the UI hierarchy.
      const comp = await this._resolveLauncher(serial, uid, pkg);
      if (comp) { try { await this._adbLong(serial, ['shell', 'am', 'start', '--user', String(uid), '-n', comp], 10000); } catch {} }
      await new Promise((r) => setTimeout(r, 2500));               // let the UI settle
      let xml = ''; try { xml = await this._uiDump(serial); } catch { xml = ''; }
      let r = instagram.classify(xml);
      // Logged in but the recommendation status isn't on screen yet — try Account Status once.
      if (r.status === 'UNKNOWN' && r.loggedInHome) {
        try {
          await this._navigateAccountStatus(serial, uid);
          await new Promise((res) => setTimeout(res, 2000));
          const r2 = instagram.classify(await this._uiDump(serial));
          if (r2.status !== 'UNKNOWN') r = r2;
        } catch {}
      }
      const dur = ((Date.now() - started) / 1000).toFixed(1);
      this.emit('log', `check_account_status (${serial}) user=${uid} -> ${r.status} conf=${r.confidence} in ${dur}s`);
      this._rpcReply(ws, m, { ok: true, status: r.status, confidence: r.confidence, evidence: r.evidence, reason: (r.evidence && r.evidence[0]) || r.status });
    } catch (e) {
      this._rpcReply(ws, m, { ok: false, status: 'APP_ERROR', error: String((e && e.message) || e) });
    } finally { this._checking.delete(serial); }
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
