// Shows bridge/OBS status and connects or disconnects Google Drive.
const BRIDGE_BASE_URL = 'http://127.0.0.1:17643';
const statusEl = document.getElementById('status');
const driveEl = document.getElementById('drive');
const controlsEl = document.getElementById('controls');
const toggleEl = document.getElementById('toggle');
const ENABLED_KEY = 'autoRecord';

// Master switch: when off, Meet calls no longer start or stop OBS recording.
async function initToggle() {
  const { [ENABLED_KEY]: stored = true } = await chrome.storage.local.get(ENABLED_KEY);
  toggleEl.checked = stored !== false;
  toggleEl.onchange = () => chrome.storage.local.set({ [ENABLED_KEY]: toggleEl.checked }).then(refresh);
}

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
    if (res?.ok) { settingsOpen = false; refresh(false, true); }
    else { msg.textContent = (await res?.json().catch(() => null))?.error || 'Could not save'; save.disabled = false; }
  };
  return form;
}

function renderDrive(drive) {
  driveEl.hidden = false;
  driveEl.replaceChildren();
  const waiting = drive.queued?.length ?? 0;
  const waitingText = `${waiting} recording${waiting === 1 ? '' : 's'} waiting to upload`;
  const settings = el('details', { open: !drive.configured || settingsOpen });
  settings.ontoggle = () => { settingsOpen = settings.open; };
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
    refresh(false, true);
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

let settingsOpen = false; // Drive settings panel expanded by the user
let busy = false; // a manual control request is in flight
let lastError = ''; // shown under the buttons until the next action

// Manual Start / Pause-Resume / Stop, shown once the bridge is reachable.
// The buttons are created once and updated in place: replacing them on every
// poll swallowed any click whose mousedown and mouseup straddled a redraw.
const controls = {};

async function runControl(name) {
  if (busy) return;
  busy = true; // also pauses the background poll so it can't redraw mid-click
  setControls({ busy: true });
  const r = await fetch(`${BRIDGE_BASE_URL}/record/${name}`, { method: 'POST' })
    .then((res) => res.json()).catch((err) => ({ ok: false, error: err.message }));
  busy = false;
  lastError = r.ok ? '' : `Failed: ${r.error}`;
  await refresh();
}

function buildControls() {
  const make = (key, className, getAction) => {
    const b = el('button', { id: `btn-${key}`, className, onclick: () => runControl(getAction()) });
    const icon = el('i'); const text = document.createTextNode('');
    b.append(icon, text);
    controls[key] = { b, icon, text };
    return b;
  };
  controls.error = el('p', { className: 'bad' });
  controlsEl.replaceChildren(
    make('start', 'start', () => 'start'),
    make('pause', 'pause', () => (controls.paused ? 'resume' : 'pause')),
    make('stop', 'stop', () => 'stop'),
    controls.error);
}

function setControls({ recording = false, paused = false, busy: isBusy = false } = {}) {
  if (!controls.start) buildControls();
  controls.paused = paused;
  const set = (key, icon, label, disabled) => {
    const c = controls[key];
    if (c.icon.textContent !== icon) c.icon.textContent = icon;
    if (c.text.textContent !== label) c.text.textContent = label;
    c.b.disabled = disabled;
  };
  set('start', '●', 'Start', isBusy || recording);
  set('pause', paused ? '▶' : '❚❚', paused ? 'Resume' : 'Pause', isBusy || !recording);
  set('stop', '■', 'Stop', isBusy || !recording);
}

function renderControls(s) {
  controlsEl.hidden = false;
  setControls({ recording: !!s.recording, paused: !!s.paused });
  controls.error.textContent = lastError;
}

// The Drive card is never redrawn while its settings are open (by a poll or a
// button click), which would collapse the panel and reset unsaved checkboxes
// and text to the saved values. Only forceDrive (after save/disconnect) does.
let polling = false; // a background refresh is in flight

async function refresh(poll = false, forceDrive = false) {
  if (busy || (poll && polling)) return;
  if (poll) polling = true;
  try { await doRefresh(forceDrive); } finally { if (poll) polling = false; }
}

async function doRefresh(forceDrive) {
  let s;
  try {
    s = await fetch(`${BRIDGE_BASE_URL}/status`).then((r) => r.json());
  } catch {
    statusEl.replaceChildren(row('Bridge', 'Not running', 'bad'),
      el('p', { className: 'muted' }, 'Start it with ./install-autostart.sh or npm start in bridge/.'));
    driveEl.hidden = true;
    controlsEl.hidden = true;
    document.body.classList.remove('up');
    return;
  }
  if (busy) return; // a control was clicked while this was in flight; the response is stale
  statusEl.replaceChildren(
    row('Bridge', 'Running', 'ok'),
    row('OBS', s.obsConnected ? 'Connected' : 'Not connected', s.obsConnected ? 'ok' : 'bad'),
    row('Recording', s.recording ? (s.paused ? 'Paused' : '● Recording') : 'No', s.recording && !s.paused ? 'bad' : '')
  );
  renderControls(s);
  document.body.classList.add('up');
  if (s.drive && (forceDrive || !driveEl.querySelector('details[open]'))) renderDrive(s.drive);
}

initToggle();
refresh();
// Keep the buttons in step with OBS (recording started or stopped elsewhere).
setInterval(() => refresh(true), 1500);
