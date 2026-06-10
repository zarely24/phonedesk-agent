// Repack win-unpacked/resources/app.asar with the current agent/src (avoids electron-builder/winCodeSign).
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const archive = path.join(ROOT, 'dist-installers', 'win-unpacked', 'resources', 'app.asar');
const tmp = path.join(ROOT, '.asar-tmp');
fs.rmSync(tmp, { recursive: true, force: true });
asar.extractAll(archive, tmp);
// Swap in the whole current src/ (config.js now points at Render; core.js has the tunnel/video fixes).
fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true, force: true });
asar.createPackage(tmp, archive).then(() => {
  const bytes = fs.readFileSync(archive).toString('latin1');
  console.log('repacked app.asar:', fs.statSync(archive).size, 'bytes');
  console.log('multi-device (reconcile + addPhone):', bytes.includes('reconcile(') && bytes.includes('addPhone('));
  console.log('points at Render:', bytes.includes('phonedesk-backend.onrender.com'));
  console.log('localhost default gone:', !bytes.includes("'http://127.0.0.1:8080'"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
