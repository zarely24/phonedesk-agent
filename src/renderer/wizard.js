'use strict';

function go(step) {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
  document.getElementById('s-' + step).classList.add('active');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

document.getElementById('btn-start').addEventListener('click', () => go('phones'));
document.getElementById('add-phone-btn').addEventListener('click', () => { document.getElementById('pair-err').classList.add('hide'); go('pair'); });
document.getElementById('pair-btn').addEventListener('click', doPair);
document.getElementById('pair-back').addEventListener('click', () => go('phones'));

// The main process sends the full phone status every ~2s.
window.agent.onDevice((st) => { if (st && st.phones) { renderPhones(st); updatePairStatus(st); } });
window.agent.onStatus(() => { /* per-phone online/reconnecting - the 2s status poll refreshes the list */ });

// Refresh: restart adb + the stream engine + every connection, without closing the app.
document.getElementById('refresh-btn').addEventListener('click', async function () {
  const b = this;
  b.disabled = true; b.textContent = 'Refreshing...';
  try { await window.agent.refresh(); } catch {}
  setTimeout(() => { b.disabled = false; b.innerHTML = '&#8635; Refresh'; }, 2500);
});

// Version label + the update banner (Windows: restart-to-install; Mac: download the new dmg).
if (window.agent.version) window.agent.version().then((v) => { document.getElementById('ver').textContent = 'v' + v; }).catch(() => {});
if (window.agent.onUpdate) window.agent.onUpdate((u) => {
  const bar = document.getElementById('update-bar');
  const txt = document.getElementById('update-text');
  const btn = document.getElementById('update-btn');
  if (u.ready) {                       // Windows: already downloaded, one click installs
    txt.textContent = 'Update v' + u.version + ' is ready.';
    btn.textContent = 'Restart to update';
    btn.onclick = () => { btn.disabled = true; window.agent.installUpdate(); };
  } else {                             // Mac: open the new dmg download
    txt.textContent = 'Update v' + u.version + ' is available.';
    btn.textContent = 'Download update';
    btn.onclick = () => window.agent.openUpdate();
  }
  bar.classList.remove('hide');
});

function renderPhones(st) {
  const list = document.getElementById('phones-list');
  const counter = document.getElementById('phones-counter');
  const hint = document.getElementById('phones-hint');
  const addBtn = document.getElementById('add-phone-btn');
  const guide = document.getElementById('detect-guide');
  guide.classList.add('hide');

  const paired = st.phones.filter((p) => p.paired);
  const onlineN = paired.filter((p) => p.online).length;
  counter.textContent = `${onlineN} of ${st.max} phones online`;

  list.innerHTML = paired.length ? paired.map((p) => {
    const cls = p.online ? 'online' : (p.state === 'absent' ? 'off' : 'warn');
    const label = p.online ? 'Online' : (p.state === 'absent' ? 'Unplugged' : 'Connecting...');
    return `<div class="phone-row"><span class="dot ${cls}"></span><b>${esc(p.name)}</b><span class="muted">${label}</span></div>`;
  }).join('') : '<p class="muted">No phones added yet.</p>';

  const nextUnpaired = st.phones.find((p) => p.state === 'ready' && !p.paired);
  const unauthorized = st.phones.find((p) => p.state === 'unauthorized');
  if (st.pairedCount >= st.max) {
    hint.textContent = `You've reached the ${st.max}-phone limit.`;
    addBtn.disabled = true; addBtn.textContent = `Phone limit reached (${st.max})`;
  } else {
    addBtn.disabled = false; addBtn.textContent = '+ Add a phone';
    if (nextUnpaired) {
      hint.innerHTML = 'New phone detected - click <b>+ Add a phone</b> and enter its code.';
    } else if (unauthorized) {
      hint.innerHTML = 'A phone is plugged in - look at it and tap <b>Allow</b> (tick <b>Always allow</b>).';
    } else {
      hint.innerHTML = 'Click <b>+ Add a phone</b>, then plug the new phone in (USB, with USB debugging on).';
      if (!st.phones.length) {
        const steps = ['Settings -> About phone -> tap <b>Build number</b> 7 times', 'Open <b>Developer options</b>', 'Turn on <b>USB debugging</b>'];
        guide.innerHTML = '<ol>' + steps.map((s) => `<li>${s}</li>`).join('') + '</ol>';
        guide.classList.remove('hide');
      }
    }
  }
}

// Live status on the "Add a phone" screen: tells the owner exactly where the new phone stands.
function updatePairStatus(st) {
  const el = document.getElementById('pair-status');
  if (!el) return;
  const ready = st.phones.find((p) => p.state === 'ready' && !p.paired);
  const unauthorized = st.phones.find((p) => p.state === 'unauthorized');
  el.classList.remove('ok', 'warn');
  if (ready) {
    el.classList.add('ok');
    el.textContent = 'New phone detected - enter its pairing code below.';
  } else if (unauthorized) {
    el.classList.add('warn');
    el.textContent = 'Phone plugged in - tap Allow on its screen (tick Always allow).';
  } else {
    el.textContent = 'Waiting for the phone... plug it in via USB (USB debugging on).';
  }
}

async function doPair() {
  const code = document.getElementById('code').value.trim();
  const err = document.getElementById('pair-err');
  const btn = document.getElementById('pair-btn');
  err.classList.add('hide');
  if (!code) { err.textContent = 'Please enter the code.'; err.classList.remove('hide'); return; }
  btn.disabled = true; btn.textContent = 'Adding...';
  try {
    await window.agent.addPhone(code);
    document.getElementById('code').value = '';
    go('phones');                          // back to the overview; the new phone appears online shortly
  } catch (e) {
    err.textContent = (e && e.message) ? e.message : 'Could not add. Check the code and try again.';
    err.classList.remove('hide');
  } finally { btn.disabled = false; btn.textContent = 'Add phone'; }
}
