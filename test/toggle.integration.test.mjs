// Integration test for the auto-record switch: the real extension/background.js
// (mock chrome.*, real fetch) talking to the real bridge/server.js and a mock
// OBS WebSocket. Checks the switch really starts/stops OBS recording.
import path from 'path'; import os from 'os'; import vm from 'vm'; import fs from 'fs';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
const BRIDGE_DIR = fileURLToPath(new URL('../bridge/', import.meta.url));
const EXT = new URL('../extension/', import.meta.url);
const require = createRequire(BRIDGE_DIR + 'package.json');
const { WebSocketServer } = require('ws');

const OBS_PORT = 4498, BRIDGE_PORT = 17698;
let recording = false;
const wss = new WebSocketServer({ port: OBS_PORT });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 1) return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    if (m.op !== 6) return;
    const { requestType, requestId } = m.d;
    if (requestType === 'StartRecord') recording = true;
    if (requestType === 'StopRecord') recording = false;
    const responseData = requestType === 'GetRecordStatus' ? { outputActive: recording } : {};
    ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
  });
});

const bridge = spawn('node', ['server.js'], { cwd: BRIDGE_DIR, env: { ...process.env, PORT: String(BRIDGE_PORT),
  OBS_WEBSOCKET_URL: `ws://127.0.0.1:${OBS_PORT}`, OBS_WEBSOCKET_PASSWORD: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  START_DELAY_SECONDS: '0', STOP_DELAY_SECONDS: '1', OBS_LAUNCH_COMMAND: '',
  DRIVE_SETTINGS_FILE: path.join(os.tmpdir(), 'meetrec-no-settings.json'), DRIVE_ACCOUNT_FILE: path.join(os.tmpdir(), 'meetrec-no-account.json'), DRIVE_QUEUE_FILE: path.join(os.tmpdir(), 'meetrec-no-queue.json') } });
bridge.stdout.on('data', d => process.stdout.write('  bridge| ' + d));
bridge.stderr.on('data', d => process.stdout.write('  bridge! ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) fails++; };
const status = () => fetch(`http://127.0.0.1:${BRIDGE_PORT}/status`).then(r => r.json());

// background.js with the bridge URL pointed at the test bridge
const session = {}, local = {}, onMessage = [], onChanged = [];
const chrome = {
  storage: {
    session: { get: async k => (k in session ? { [k]: session[k] } : {}), set: async o => Object.assign(session, o) },
    local: { get: async k => (k in local ? { [k]: local[k] } : {}) },
    onChanged: { addListener: f => onChanged.push(f) } },
  runtime: { onMessage: { addListener: f => onMessage.push(f) }, onInstalled: { addListener() {} } },
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  scripting: { executeScript: async () => {} } };
vm.runInNewContext(fs.readFileSync(new URL('background.js', EXT), 'utf8')
  .replace('17643', String(BRIDGE_PORT)), { chrome, fetch, console });
const send = (type, tabId) => onMessage.forEach(f => f({ type, url: 'https://meet.google.com/x' }, { tab: { id: tabId } }));
// what the popup checkbox does
const setSwitch = async v => { const oldValue = local.autoRecord; local.autoRecord = v;
  await Promise.all(onChanged.map(f => f({ autoRecord: { oldValue, newValue: v } }, 'local'))); };
const until = async (cond, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await cond()) return true; await sleep(100); } return false; };

try {
  check('bridge up and OBS connected', await until(async () => (await status().catch(() => ({}))).obsConnected));

  send('meet-join', 1);
  check('switch on (default): joining a call starts recording', await until(() => recording));

  await setSwitch(false);
  check('switching off mid-call stops the recording', await until(() => !recording));

  send('meet-heartbeat', 1); await sleep(1500);
  check('while off, heartbeats do not restart recording', !recording);
  send('meet-leave', 1); send('meet-join', 2); await sleep(1500);
  check('while off, a new call is not recorded', !recording && !(await status()).recording);

  await setSwitch(true);
  check('switching on mid-call starts recording for the call in progress', await until(() => recording));

  send('meet-leave', 2);
  check('leaving with switch on stops recording', await until(() => !recording, 5000));
} finally {
  bridge.kill(); wss.close();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
