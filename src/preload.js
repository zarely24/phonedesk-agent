'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  onDevice: (cb) => ipcRenderer.on('device', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  addPhone: (code) => ipcRenderer.invoke('add-phone', code),
  backendUrl: () => ipcRenderer.invoke('backend-url'),
  version: () => ipcRenderer.invoke('app-version'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openUpdate: () => ipcRenderer.invoke('open-update'),
});
