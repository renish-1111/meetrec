// Shows bridge/OBS status and connects or disconnects Google Drive.
const BRIDGE_BASE_URL = 'http://127.0.0.1:17643';
const statusEl = document.getElementById('status');
const driveEl = document.getElementById('drive');

function row(label, value, cls) {
  const div = document.createElement('div');
  div.className = 'row';
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('span'); v.textContent = value; if (cls) v.className = cls;
  div.append(l, v);
  return div;
}

function el(tag, props = {}, text = '') {
  const e = Object.assign(document.createElement(tag), props);
  if (text) e.textContent = text;
  return e;
}

function renderDrive(drive) {
  driveEl.hidden = false;
  driveEl.replaceChildren();
  const waiting = drive.queued?.length ?? 0;
  const waitingText = `${waiting} recording${waiting === 1 ? '' : 's'} waiting to upload`;
  if (!drive.configured) {
    driveEl.append(el('p', { className: 'muted' },
      'Google Drive upload isn\'t set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to bridge/.env (see README).'));
    return;
  }
  if (!drive.connected) {
    driveEl.append(el('p', {}, 'Upload recordings to Google Drive automatically.'));
    if (waiting) driveEl.append(el('p', { className: 'muted' }, `${waitingText}. They'll upload once you connect.`));
    const btn = el('button', {}, 'Connect Google Drive');
    btn.onclick = () => { chrome.tabs.create({ url: `${BRIDGE_BASE_URL}/drive/connect` }); window.close(); };
    driveEl.append(btn);
    return;
  }
  const p = el('p');
  p.append('Google Drive: ', el('b', {}, drive.email || 'connected'));
  driveEl.append(p);
  if (drive.uploading) driveEl.append(el('p', { className: 'muted' }, `Uploading a recording…${waiting ? ` (${waitingText})` : ''}`));
  else if (drive.lastUpload?.ok && drive.lastUpload.link) {
    const lp = el('p');
    lp.append(el('a', { href: drive.lastUpload.link, target: '_blank' }, 'Open last upload'));
    driveEl.append(lp);
  } else if (drive.lastUpload && !drive.lastUpload.ok) {
    driveEl.append(el('p', { className: 'bad' }, `Last upload failed: ${drive.lastUpload.error}`));
  }
  if (!drive.uploading && waiting) driveEl.append(el('p', { className: 'muted' }, `${waitingText}, retrying automatically.`));
  const btn = el('button', { className: 'secondary' }, 'Disconnect');
  btn.onclick = async () => {
    btn.disabled = true;
    await fetch(`${BRIDGE_BASE_URL}/drive/disconnect`, { method: 'POST' }).catch(() => {});
    refresh();
  };
  driveEl.append(btn);
}

async function refresh() {
  let s;
  try {
    s = await fetch(`${BRIDGE_BASE_URL}/status`).then((r) => r.json());
  } catch {
    statusEl.replaceChildren(row('Bridge', 'Not running', 'bad'),
      el('p', { className: 'muted' }, 'Start it with ./install-autostart.sh or npm start in bridge/.'));
    driveEl.hidden = true;
    return;
  }
  statusEl.replaceChildren(
    row('Bridge', 'Running', 'ok'),
    row('OBS', s.obsConnected ? 'Connected' : 'Not connected', s.obsConnected ? 'ok' : 'bad'),
    row('Recording', s.recording ? '● Recording' : 'No', s.recording ? 'bad' : '')
  );
  if (s.drive) renderDrive(s.drive);
}

refresh();
