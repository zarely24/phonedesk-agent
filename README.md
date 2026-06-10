# PhoneDesk owner agent

The small program the **owner** runs on their computer. It connects their phone (USB/adb) to your
backend so it appears in your dashboard. This folder currently holds the **functional core**
(`agent.js`); the Electron setup wizard (big buttons, brand guides, system tray, bundled adb) will
wrap this core next.

## What the core does today
1. Detects the connected phone via adb and reads real info (brand, model, Android version, battery).
2. First run: pairs with a code from the dashboard ("+ Add device") and saves a device token to `.agent.json`.
3. Opens an outbound phone-home WebSocket to the backend → the phone shows **Online** with live
   battery in the dashboard. Auto-reconnects on cable/network drops.

> Live screen streaming (the dashboard "Connect" button) is added with the relay tunnel — the next step.

## Requirements
- Node 18+ (uses built-in `fetch` + `WebSocket` — no npm install needed for the core)
- `adb` on PATH (or set `ADB_PATH`). The Electron build will bundle adb so owners install nothing.

## Run it (local dev)
```powershell
# 1) In the dashboard, click "+ Add device" and copy the code (e.g. ABC-DEF)
# 2) Point the agent at your backend and pass the code (first run only):
$env:BACKEND="http://localhost:8080"; node agent.js ABC-DEF
# After pairing, just:
$env:BACKEND="http://localhost:8080"; node agent.js
```
The phone then appears Online in the dashboard. Ctrl-C to take it offline.

## Roadmap for this folder
- [x] Functional core: detect + pair + phone-home presence (`agent.js`)
- [ ] Relay tunnel: forward the local ws-scrcpy stream so "Connect" shows the live screen
- [ ] Electron wrapper: 7-step wizard, bundled adb + scrcpy, system tray, auto-start, installer
