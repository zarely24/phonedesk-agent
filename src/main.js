'use strict';
const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const { AgentCore } = require('./core');
const { BACKEND } = require('./config');
const fs = require('fs');

// Only ever run ONE PhoneDesk (a second copy fights over port 8000 and the phone's online slot).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
});

const UPDATE_REPO = 'zarely24/phonedesk-agent';
const MAC_DMG_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/PhoneDesk.dmg`;

// Write a log file (the packaged app has no visible console). Find it at %APPDATA%\PhoneDesk\agent.log
// Rotated so it can't grow unbounded over weeks of 24/7 logging and fill the disk: when agent.log
// passes ~5MB it's rolled to agent.log.1 (one old copy kept), so on-disk logs stay under ~10MB.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let _logFile = null;
let _logBytes = -1;   // cached size of the current agent.log; -1 = not yet seeded from disk
function fileLog(...a) {
  try {
    if (!_logFile) _logFile = path.join(app.getPath('userData'), 'agent.log');
    if (_logBytes < 0) { try { _logBytes = fs.statSync(_logFile).size; } catch { _logBytes = 0; } }
    const line = new Date().toISOString() + ' ' + a.map(String).join(' ') + '\n';
    if (_logBytes + Buffer.byteLength(line) > LOG_MAX_BYTES) {
      try { fs.renameSync(_logFile, _logFile + '.1'); } catch {}   // overwrites any previous .1
      _logBytes = 0;
    }
    fs.appendFileSync(_logFile, line);
    _logBytes += Buffer.byteLength(line);
    if (core) core.forwardLog(line.replace(/\n$/, ''));   // stream the line up for the admin live-log view
  } catch {}
}

// A crash in the main process would otherwise kill the agent silently (all phones drop, no trace).
// Log it and stay up - a background agent should survive a stray error, not vanish on the owner.
process.on('uncaughtException', (e) => fileLog('UNCAUGHT EXCEPTION:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => fileLog('UNHANDLED REJECTION:', (e && e.stack) || e));

// In a packaged build, adb + ws-scrcpy are bundled in resources. In dev, use the vendor copy + system adb.
const isPackaged = app.isPackaged;
const adbPath = isPackaged
  ? path.join(process.resourcesPath, 'adb', process.platform === 'win32' ? 'win' : 'mac',
      process.platform === 'win32' ? 'adb.exe' : 'adb')
  : (process.env.ADB_PATH || 'adb');
const wsScrcpyDist = isPackaged
  ? path.join(process.resourcesPath, 'ws-scrcpy')
  : path.join(__dirname, '..', '..', 'vendor', 'ws-scrcpy', 'dist');

let core;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 660, resizable: false, autoHideMenuBar: true,
    title: 'PhoneDesk',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('device', core.status());
      if (pendingUpdate) win.webContents.send('update', pendingUpdate);
    }
  });
}

// ---- updates: Windows installs itself (electron-updater); Mac gets a "Download" button.
let pendingUpdate = null;
let updatePromptOpen = false;
let updateNagTimer = null;

/** Make a ready update impossible to miss.
    Previously this only pushed a message into the app window - which the owner usually keeps
    minimised or closed - and then waited for them to happen to restart. An update could sit
    undelivered for days, which matters when the update IS the fix for the fleet's video.
    Now: a desktop notification plus a dialog that comes to the front, repeated every 30 minutes
    until they act. Restarting is one click; nothing is forced on them mid-shift, because a restart
    drops every phone for a moment and that has to be their choice. */
function promptForUpdate(updater, u) {
  const title = 'PhoneDesk update ready';
  const body = `Version ${u.version} is downloaded. Restarting takes about 20 seconds and the phones reconnect on their own.`;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body });
      n.on('click', () => { try { updater.quitAndInstall(); } catch {} });
      n.show();
    }
  } catch {}
  const showDialog = () => {
    if (updatePromptOpen) return;
    updatePromptOpen = true;
    dialog.showMessageBox({
      type: 'info',
      title,
      message: title,
      detail: body + '\n\nPlease restart as soon as you can - this update improves the phone streams.',
      buttons: ['Restart now', 'Remind me in 30 minutes'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then((r) => {
      updatePromptOpen = false;
      if (r.response === 0) { try { updater.quitAndInstall(); } catch (e) { fileLog('quitAndInstall:', e && e.message); } }
    }).catch(() => { updatePromptOpen = false; });
  };
  showDialog();
  if (updateNagTimer) clearInterval(updateNagTimer);
  updateNagTimer = setInterval(showDialog, 30 * 60 * 1000);
}

function announceUpdate(u) {
  pendingUpdate = u;
  fileLog('update:', JSON.stringify(u));
  if (win && !win.isDestroyed()) win.webContents.send('update', u);
}
function newerVersion(tag) {
  const a = String(tag || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = app.getVersion().split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return false;
}
function checkMacUpdate() {
  const req = https.get({
    hostname: 'api.github.com', path: `/repos/${UPDATE_REPO}/releases/latest`,
    headers: { 'User-Agent': 'PhoneDesk', Accept: 'application/vnd.github+json' },
  }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const tag = JSON.parse(body).tag_name;
        if (tag && newerVersion(tag)) announceUpdate({ ready: false, version: tag.replace(/^v/, '') });
      } catch {}
    });
  });
  req.on('error', () => {});
  req.setTimeout(15000, () => req.destroy());
}
function initUpdates() {
  if (!app.isPackaged) return;            // dev runs don't self-update
  if (process.platform === 'darwin') {
    checkMacUpdate();
    setInterval(checkMacUpdate, 6 * 3600 * 1000);
    return;
  }
  let updater;
  try { updater = require('electron-updater').autoUpdater; }
  catch (e) { fileLog('electron-updater unavailable:', e && e.message); return; }   // old zip builds
  updater.autoDownload = true;
  updater.on('update-downloaded', (info) => {
    announceUpdate({ ready: true, version: info.version });
    promptForUpdate(updater, { version: info.version });
  });
  updater.on('error', (e) => fileLog('updater error:', (e && e.message) || e));
  const check = () => { try { updater.checkForUpdates().catch(() => {}); } catch {} };
  check();
  setInterval(check, 30 * 60 * 1000);
}

app.whenReady().then(() => {
  core = new AgentCore({
    backend: BACKEND,
    adbPath,
    wsScrcpyDist,
    tokenFile: path.join(app.getPath('userData'), 'agent.json'),
    nodeBin: process.execPath,                 // Electron binary...
    runAsNodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, // ...run as plain Node to launch ws-scrcpy
    maxDevices: 30,                            // up to 30 phones per computer
  });
  core.on('status', (s) => { fileLog('status:', JSON.stringify(s)); if (win && !win.isDestroyed()) win.webContents.send('status', s); });
  core.on('log', (m) => fileLog('[core]', m));

  try { core.reconcile(); } catch (e) { fileLog('reconcile error:', e && e.stack); }  // launch ws-scrcpy + reconnect paired phones
  createWindow();
  initUpdates();

  const poll = setInterval(() => {
    try { core.reconcile(); } catch {}                       // connect newly-plugged phones, drop unplugged
    if (win && !win.isDestroyed()) win.webContents.send('device', core.status());
  }, 2000);
  app.on('before-quit', () => {
    clearInterval(poll);
    try { core.shutdown(); } catch (e) { fileLog('shutdown error:', e && e.stack); }
  });
});

ipcMain.handle('backend-url', () => BACKEND);
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('refresh', () => {
  try { core.refreshAll(); } catch (e) { fileLog('refresh error:', e && e.stack); }
  return true;
});
ipcMain.handle('reset-pairings', () => {
  try { core.resetPairings(); } catch (e) { fileLog('reset error:', e && e.stack); }
  return true;
});
ipcMain.handle('install-update', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall(); } catch (e) { fileLog('quitAndInstall:', e && e.message); }
});
ipcMain.handle('open-update', () => shell.openExternal(MAC_DMG_URL));

// ---- Instagram diagnostic launcher (Phase-1, MANUAL only) ---------------------------------------
// Isolated from streaming/pairing: if any of this fails, the rest of the agent is unaffected. Nothing
// here auto-runs — the owner must open the panel, pick a phone/profile, and confirm the phone is free.
ipcMain.handle('list-devices', () => {
  try { return core ? core.status() : { phones: [] }; } catch (e) { return { phones: [] }; }
});
ipcMain.handle('run-ig-diagnostic', async (_e, opts) => {
  opts = opts || {};
  const serial = String(opts.serial || '').trim();
  const uid = String(opts.uid == null ? '' : opts.uid).trim();
  if (!serial || uid === '') return { ok: false, output: 'Pick a phone and enter a profile UID first.' };
  // Explicit "this phone is free" confirmation (spec 7). The diagnostic itself ALSO refuses if a
  // scrcpy/stream is running, so this is defence in depth.
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Run diagnostic', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    message: 'Run the Instagram diagnostic on this phone?',
    detail: `Phone ${serial}, profile ${uid}.\n\nRun this ONLY if no one is using this phone right now. `
      + `It reads the screen to check the account; it will NOT switch profiles, post, like, message, or `
      + `change anything.\n\nI confirm this phone is currently free.`,
  });
  if (r.response !== 0) return { ok: false, output: 'Cancelled.' };
  // Packaged: the script lives in app.asar.unpacked (plain Node can't read app.asar). Pass the packaged
  // adb via ADB_PATH so the diagnostic finds it (resources/ ships outside the asar).
  const { execFile } = require('child_process');
  const script = path.join(__dirname, '..', 'tools', 'ig-status-diagnose.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const args = [script, '--serial', serial, '--uid', uid, '--confirm-free'];
  if (opts.username) args.push('--username', String(opts.username));
  fileLog('ig-diagnostic: running for', serial, 'uid', uid);
  return await new Promise((resolve) => {
    execFile(process.execPath, args, {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', ADB_PATH: adbPath }),
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = String(stdout || '') + (stderr ? '\n[stderr]\n' + String(stderr) : '');
      resolve({ ok: !err, output: out.trim() || (err && err.message) || 'no output' });
    });
  });
});

ipcMain.handle('add-phone', async (_e, code) => {
  try {
    fileLog('add-phone: pairing the next plugged-in phone');
    const r = await core.addPhone(String(code || '').trim());
    fileLog('add-phone OK:', JSON.stringify(r));
    return r;
  } catch (e) {
    fileLog('add-phone ERROR:', e && e.stack);
    throw e;
  }
});

app.on('window-all-closed', () => app.quit());
