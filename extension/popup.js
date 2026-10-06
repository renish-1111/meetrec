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

function settingsForm(drive) {
  const form = el('form');
  const id = el('input', { value: drive.clientId, placeholder: 'xxxx.apps.googleusercontent.com', autocomplete: 'off' });
  const secret = el('input', {
    type: 'password', autocomplete: 'off',
    placeholder: drive.hasSecret ? 'Saved (type to replace)' : 'GOCSPX-…'
  });
  const folder = el('input', { value: drive.folderName, placeholder: 'MeetRec', maxLength: 200 });
  const checks = {};
  const checkbox = (key, text) => {
    checks[key] = el('input', { type: 'checkbox', checked: drive[key] });
    const label = el('label', { className: 'check' });
    label.append(text, checks[key]);
    return label;
  };
  const save = el('button', { type: 'submit' }, 'Save');
  const msg = el('p', { className: 'bad' });
  const field = (text, input) => {
    const f = el('div', { className: 'field' });
    f.append(el('label', {}, text), input);
    return f;
  };
  form.append(field('Client ID', id), field('Client secret', secret), field('Folder', folder),
    checkbox('uploadEnabled', 'Upload recordings to Drive'),
    checkbox('deleteAfterUpload', 'Delete local file after upload'),
    checkbox('uploadManual', 'Also upload recordings I start in OBS'), save, msg);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    const res = await fetch(`${BRIDGE_BASE_URL}/drive/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id.value, clientSecret: secret.value, folderName: folder.value,
        ...Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.checked])) })
    }).catch(() => null);
    if (res?.ok) refresh();
    else { msg.textContent = (await res?.json().catch(() => null))?.error || 'Could not save'; save.disabled = false; }
  };
  return form;
}

function renderDrive(drive) {
  driveEl.hidden = false;
  driveEl.replaceChildren();
  const waiting = drive.queued?.length ?? 0;
  const waitingText = `${waiting} recording${waiting === 1 ? '' : 's'} waiting to upload`;
  const settings = el('details', { open: !drive.configured });
  settings.append(el('summary', {}, 'Drive settings'), settingsForm(drive));
  if (!drive.configured) {
    driveEl.append(el('p', { className: 'muted' }, 'Enter your Google OAuth client to turn on Drive upload (see README).'), settings);
    return;
  }
  if (!drive.connected) {
    driveEl.append(el('p', { className: 'title' }, 'Back up recordings to Google Drive'));
    if (waiting) driveEl.append(el('p', { className: 'muted' }, `${waitingText}. They'll upload once you connect.`));
    const btn = el('button', {}, 'Connect Google Drive');
    btn.onclick = () => { chrome.tabs.create({ url: `${BRIDGE_BASE_URL}/drive/connect` }); window.close(); };
    driveEl.append(btn, settings);
    return;
  }
  const head = el('div', { className: 'head' });
  const who = el('p');
  who.append(el('span', { className: 'muted' }, 'Google Drive'), document.createElement('br'), el('b', {}, drive.email || 'connected'));
  const out = el('button', { className: 'link' }, 'Disconnect');
  out.onclick = async () => {
    out.disabled = true;
    await fetch(`${BRIDGE_BASE_URL}/drive/disconnect`, { method: 'POST' }).catch(() => {});
    refresh();
  };
  head.append(who, out);
  driveEl.append(head);
  if (drive.uploading) driveEl.append(el('p', { className: 'muted' }, `Uploading a recording…${waiting ? ` (${waitingText})` : ''}`));
  else if (drive.lastUpload?.ok && drive.lastUpload.link) {
    const lp = el('p');
    lp.append(el('a', { href: drive.lastUpload.link, target: '_blank' }, 'Open last upload'));
    driveEl.append(lp);
  } else if (drive.lastUpload && !drive.lastUpload.ok) {
    driveEl.append(el('p', { className: 'bad' }, `Last upload failed: ${drive.lastUpload.error}`));
  }
  if (!drive.uploading && waiting) driveEl.append(el('p', { className: 'muted' }, `${waitingText}, retrying automatically.`));
  driveEl.append(settings);
}

async function refresh() {
  let s;
  try {
    s = await fetch(`${BRIDGE_BASE_URL}/status`).then((r) => r.json());
  } catch {
    statusEl.replaceChildren(row('Bridge', 'Not running', 'bad'),
      el('p', { className: 'muted' }, 'Start it with ./install-autostart.sh or npm start in bridge/.'));
    driveEl.hidden = true;
    document.body.classList.remove('up');
    return;
  }
  statusEl.replaceChildren(
    row('Bridge', 'Running', 'ok'),
    row('OBS', s.obsConnected ? 'Connected' : 'Not connected', s.obsConnected ? 'ok' : 'bad'),
    row('Recording', s.recording ? '● Recording' : 'No', s.recording ? 'bad' : '')
  );
  document.body.classList.add('up');
  if (s.drive) renderDrive(s.drive);
}

refresh();
