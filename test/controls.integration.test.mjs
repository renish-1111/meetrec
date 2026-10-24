// Integration test for the manual Start/Stop/Pause/Resume controls: real
// bridge/server.js against a mock OBS WebSocket, then the real popup.js
// rendering that /status in a minimal fake DOM and clicking its buttons.
import path from 'path'; import os from 'os'; import vm from 'vm'; import fs from 'fs';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
const BRIDGE_DIR = fileURLToPath(new URL('../bridge/', import.meta.url));
const EXT = new URL('../extension/', import.meta.url);
const require = createRequire(BRIDGE_DIR + 'package.json');
const { WebSocketServer } = require('ws');

const OBS_PORT = 4495, PORT = 17695, BASE = `http://127.0.0.1:${PORT}`;
let recording = false, paused = false;
let startCalls = 0;
let lagMs = 0, stuck = false; // OBS applies changes lagMs after acknowledging; stuck = never applies
const later = f => (stuck ? 0 : lagMs ? setTimeout(f, lagMs) : f());
const wss = new WebSocketServer({ port: OBS_PORT });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 1) return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    if (m.op !== 6) return;
    const { requestType, requestId } = m.d;
    if (requestType === 'StartRecord') startCalls++;
    if (requestType === 'StartRecord') later(() => { recording = true; });
    if (requestType === 'StopRecord') later(() => { recording = paused = false; });
    if (requestType === 'PauseRecord') later(() => { paused = true; });
    if (requestType === 'ResumeRecord') later(() => { paused = false; });
    const responseData = requestType === 'GetRecordStatus' ? { outputActive: recording, outputPaused: paused } : {};
    ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
  });
});
const bridge = spawn('node', ['server.js'], { cwd: BRIDGE_DIR, env: { ...process.env, PORT: String(PORT),
  OBS_WEBSOCKET_URL: `ws://127.0.0.1:${OBS_PORT}`, OBS_WEBSOCKET_PASSWORD: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  START_DELAY_SECONDS: '0', STOP_DELAY_SECONDS: '1', OBS_LAUNCH_COMMAND: '',
  DRIVE_SETTINGS_FILE: path.join(os.tmpdir(), 'meetrec-no-settings.json'), DRIVE_ACCOUNT_FILE: path.join(os.tmpdir(), 'meetrec-no-account.json'), DRIVE_QUEUE_FILE: path.join(os.tmpdir(), 'meetrec-no-queue.json') } });
bridge.stderr.on('data', d => process.stdout.write('  bridge! ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) fails++; };
const status = () => fetch(BASE + '/status').then(r => r.json());
const rec = a => fetch(`${BASE}/record/${a}`, { method: 'POST' }).then(async r => ({ code: r.status, ...(await r.json()) }));

// minimal DOM, just enough for popup.js
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.className = ''; this.textContent = ''; }
  append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; }
  querySelectorAll() { return this.children.filter(c => c.tag === 'button'); }
  querySelector(sel) { // only 'details[open]' is needed
    const walk = n => (n.tag === 'details' && n.open ? n : (n.children || []).map(walk).find(Boolean));
    return this.children.map(walk).find(Boolean) || null; }
  set id(v) { this._id = v; } get id() { return this._id; }
}
const els = Object.fromEntries(['status', 'drive', 'controls', 'toggle'].map(i => [i, new El('div')]));
const document = { getElementById: i => els[i], createElement: t => new El(t), createTextNode: t => Object.assign(new El('#text'), { textContent: t }), body: { classList: { add() {}, remove() {} } } };
const chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, tabs: { create() {} } };
const popupSrc = fs.readFileSync(new URL('popup.js', EXT), 'utf8').replace('17643', String(PORT));
const loadPopup = async () => { vm.runInNewContext(popupSrc, { document, chrome, fetch, window: { close() {} }, console, setInterval, clearInterval }); await sleep(300); };
const btn = id => els.controls.children.find(c => c.id === id);
const label = id => btn(id).children.map(c => (typeof c === 'string' ? c : c.textContent)).join(' ');
const click = async id => { btn(id).onclick(); await sleep(400); };

try {
  for (let i = 0; i < 50; i++) { try { if ((await status()).obsConnected) break; } catch {} await sleep(100); }
  // status may report obsConnected only after first OBS use; the first start connects
  check('unknown action -> 404', (await rec('explode')).code === 404);
  check('pause while idle -> 502 with reason', (await rec('pause')).code === 502 && !recording);
  check('start works with no meeting', (await rec('start')).ok && recording);
  check('start again is harmless', (await rec('start')).ok && recording);
  let s = await status();
  check('status: recording, not paused', s.recording === true && s.paused === false);
  check('pause', (await rec('pause')).ok && paused);
  s = await status();
  check('status reports paused', s.recording === true && s.paused === true);
  check('resume', (await rec('resume')).ok && !paused);
  check('stop', (await rec('stop')).ok && !recording);
  check('stop when idle is harmless', (await rec('stop')).ok);

  // popup
  await loadPopup();
  check('popup idle: Start enabled, Pause/Stop disabled', !btn('btn-start').disabled && btn('btn-pause').disabled && btn('btn-stop').disabled);
  await click('btn-start');
  check('Start button starts recording; Start disabled, Pause/Stop enabled',
    recording && btn('btn-start').disabled && !btn('btn-pause').disabled && !btn('btn-stop').disabled);
  check('button reads Pause', label('btn-pause').includes('Pause'));
  await click('btn-pause');
  check('Pause button pauses; it now reads Resume', paused && label('btn-pause').includes('Resume'));
  await click('btn-pause');
  check('Resume button resumes', !paused && label('btn-pause').includes('Pause'));
  await click('btn-stop');
  check('Stop button stops; controls reset', !recording && !btn('btn-start').disabled && btn('btn-stop').disabled);

  // OBS lags behind its own acknowledgement: one click must be enough
  lagMs = 700;
  await click('btn-start'); await sleep(800);
  check('LAG: one Start click -> recording and buttons already reflect it (no second click needed)',
    recording && btn('btn-start').disabled && !btn('btn-stop').disabled);
  await click('btn-pause'); await sleep(800);
  check('LAG: one Pause click -> paused, button reads Resume', paused && label('btn-pause').includes('Resume'));
  await click('btn-pause'); await sleep(800);
  check('LAG: one Resume click -> resumed', !paused && label('btn-pause').includes('Pause'));
  await click('btn-stop'); await sleep(800);
  check('LAG: one Stop click -> stopped and Start enabled again', !recording && !btn('btn-start').disabled && btn('btn-stop').disabled);
  const t0 = Date.now(); const r = await rec('start');
  check('LAG: API only answers once OBS is really recording', r.ok && recording && Date.now() - t0 >= 600);
  await rec('stop'); lagMs = 0;

  // popup follows changes made outside it (OBS hotkey, another tab, auto-record)
  await rec('start'); await sleep(1800);
  check('popup poll picks up an external start', btn('btn-start').disabled && !btn('btn-stop').disabled);
  await rec('stop'); await sleep(1800);
  check('popup poll picks up an external stop', !btn('btn-start').disabled && btn('btn-stop').disabled);

  // buttons are updated in place: a poll must never replace the node under the cursor
  const nodes = ['btn-start', 'btn-pause', 'btn-stop'].map(btn);
  await sleep(3300);
  check('polling keeps the same button elements (clicks cannot be lost to a redraw)',
    ['btn-start', 'btn-pause', 'btn-stop'].every((id, i) => btn(id) === nodes[i]));

  // Drive settings panel: background polling must not collapse it or wipe typing
  const panel = () => els.drive.children.find(c => c.tag === 'details');
  check('Drive settings panel rendered', !!panel());
  const before = panel(); before.open = true; before.ontoggle?.();
  await sleep(3200);
  check('settings panel stays open and is not re-created by polling', panel() === before && panel().open === true);
  await click('btn-start');
  check('clicking Start does not redraw the open settings panel (unsaved edits kept)', panel() === before && panel().open);
  await click('btn-stop');
  before.open = false; before.ontoggle?.(); await sleep(1800);
  check('collapsed panel is redrawn normally again', panel() !== before);

  // prototype names are not actions
  check('POST /record/constructor and /record/hasOwnProperty -> 404',
    (await rec('constructor')).code === 404 && (await rec('hasOwnProperty')).code === 404);

  // double-click / concurrent callers: serialized, both succeed, one StartRecord
  startCalls = 0;
  const both = await Promise.all([rec('start'), rec('start')]);
  check('concurrent starts both succeed', both.every(r => r.ok) && recording && startCalls === 1);
  await rec('stop');

  // a recording started by hand is not stopped by a call ending
  const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.status);
  await rec('start'); await post('/join', { tabId: 5 }); await sleep(300); await post('/leave', { tabId: 5 }); await sleep(3500);
  check('manual recording survives the call ending (auto-stop skipped)', recording === true);
  await rec('stop'); await sleep(300);
  // ... but an automatic one still stops when the call ends
  await post('/join', { tabId: 6 }); await sleep(800);
  check('auto recording started by joining', recording === true);
  await post('/leave', { tabId: 6 }); await sleep(3500);
  check('auto recording still stops after leaving', recording === false);
  // pressing Start during the pending auto-stop keeps the recording
  await post('/join', { tabId: 7 }); await sleep(800); await post('/leave', { tabId: 7 });
  await rec('start'); await sleep(3500);
  check('Start pressed during the pending stop is not undone by it', recording === true);
  await rec('stop');

  // OBS never reaching the state -> clear error, not a silent no-op
  stuck = true; btn('btn-start').onclick(); await sleep(5600);
  check('stuck OBS: popup shows an error under the buttons', els.controls.children.some(c => c.tag === 'p' && /Failed/.test(c.textContent)));
  stuck = false; recording = false;

  // a slow poll that was already in flight must not redraw stale buttons over a click
  {
    let phase = 'idle'; // what /status says
    const slowFetch = async (url, o) => {
      if (url.endsWith('/status')) { const snap = phase; await sleep(400);
        return { json: async () => ({ obsConnected: true, recording: snap === 'rec', paused: false }) }; }
      await sleep(900); phase = 'rec'; return { json: async () => ({ ok: true }) };
    };
    for (const k of ['status', 'controls']) els[k] = new El('div');
    els.drive = new El('div');
    vm.runInNewContext(popupSrc, { document, chrome, fetch: slowFetch, window: { close() {} }, console, setInterval, clearInterval });
    await sleep(700);                    // initial refresh done: idle, Start enabled
    await sleep(850);                    // t~1550: the 1.5s poll is now in flight (status read as idle)
    btn('btn-start').onclick();          // click while that poll is pending
    await sleep(500);                    // poll resolves with stale 'idle' while the POST is still running
    check('stale poll response does not re-enable buttons during a click',
      [...els.controls.children].filter(c => c.tag === 'button').every(b => b.disabled));
    await sleep(1500);
    check('after the click the popup shows the new state', btn('btn-start').disabled && !btn('btn-stop').disabled);
  }
} finally { bridge.kill(); wss.close(); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
