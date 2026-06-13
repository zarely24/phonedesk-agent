'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
  updater.on('update-downloaded', (info) => announceUpdate({ ready: true, version: info.version }));
  updater.on('error', (e) => fileLog('updater error:', (e && e.message) || e));
  const check = () => { try { updater.checkForUpdates().catch(() => {}); } catch {} };
  check();
  setInterval(check, 6 * 3600 * 1000);
}

app.whenReady().then(() => {
  core = new AgentCore({
    backend: BACKEND,
    adbPath,
    wsScrcpyDist,
    tokenFile: path.join(app.getPath('userData'), 'agent.json'),
    nodeBin: process.execPath,                 // Electron binary...
    runAsNodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, // ...run as plain Node to launch ws-scrcpy
    maxDevices: 5,                             // up to 5 phones per computer
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
