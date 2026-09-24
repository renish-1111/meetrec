// End-to-end test for bridge/server.js: runs the real server against a mock
// OBS WebSocket (v5 protocol) and drives it over HTTP. No OBS needed.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs'; import os from 'os'; import path from 'path';
const BRIDGE_DIR = fileURLToPath(new URL('../bridge/', import.meta.url));
const require = createRequire(BRIDGE_DIR + 'package.json');
const { WebSocketServer } = require('ws');

const OBS_PORT = 4499, BRIDGE = 'http://127.0.0.1:17699';
let recording = false; const calls = [];
function startMockObs(port) {
const server = new WebSocketServer({ port });
server.on('connection', (ws) => {
  ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 1) return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    if (m.op === 6) {
      const { requestType, requestId } = m.d; calls.push(requestType);
      let responseData = {};
      if (requestType === 'GetRecordStatus') responseData = { outputActive: recording };
      if (requestType === 'StartRecord') recording = true;
      if (requestType === 'StopRecord') recording = false;
      ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
    }
  });
});
return server;
}
const wss = startMockObs(OBS_PORT);

const bridge = spawn('node', ['server.js'], { cwd: BRIDGE_DIR,
  env: { ...process.env, PORT: '17699', OBS_WEBSOCKET_URL: `ws://127.0.0.1:${OBS_PORT}`, OBS_WEBSOCKET_PASSWORD: '', START_DELAY_SECONDS: '0', STOP_DELAY_SECONDS: '2', OBS_LAUNCH_COMMAND: '' } });
bridge.stdout.on('data', d => process.stdout.write('  bridge| ' + d));
bridge.stderr.on('data', d => process.stdout.write('  bridge! ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body) => fetch(BRIDGE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status);
const status = () => fetch(BRIDGE + '/status').then(r => r.json());
let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

try {
for (let i = 0; i < 50; i++) { try { if ((await status()).obsConnected) break; } catch {} await sleep(100); }
check('status reports OBS connected', (await status()).obsConnected === true);
check('bad body -> 400', await post('/join', { tabId: 'x' }) === 400);

await post('/join', { tabId: 1 }); await sleep(300);
check('join starts recording', recording === true);

await post('/join', { tabId: 2 }); await post('/leave', { tabId: 1 }); await sleep(2500);
check('still recording while another tab is in a call', recording === true);

await post('/leave', { tabId: 2 }); await sleep(1000);
check('not stopped before stop delay', recording === true);
await sleep(1500);
check('stopped after stop delay', recording === false);

await post('/join', { tabId: 3 }); await sleep(300);
await post('/leave', { tabId: 3 }); await sleep(1000);
await post('/join', { tabId: 3 }); await sleep(2000);
check('rejoin within window cancels stop', recording === true);
await post('/leave', { tabId: 3 }); await sleep(2500);
check('final leave stops', recording === false);

const s = await status();
check('status: no active meetings, recording=false', s.activeMeetings.length === 0 && s.recording === false);

// OBS goes down, then comes back
for (const c of wss.clients) c.terminate();
await sleep(300);
check('status reflects OBS disconnect', (await status()).obsConnected === false);
await post('/join', { tabId: 4 }); await sleep(500);
check('reconnects and records after OBS drop', recording === true);
await post('/leave', { tabId: 4 }); await sleep(2500);

console.log('OBS calls:', calls.join(', '));

// Auto-launch: OBS isn't running at join. The launch command (here, touching a
// marker file) "starts OBS", which the test fakes by bringing up a mock server.
const LAUNCH_OBS_PORT = 4498, LAUNCH_BRIDGE = 'http://127.0.0.1:17698';
const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-')), 'launched');
const bridge2 = spawn('node', ['server.js'], { cwd: BRIDGE_DIR,
  env: { ...process.env, PORT: '17698', OBS_WEBSOCKET_URL: `ws://127.0.0.1:${LAUNCH_OBS_PORT}`, OBS_WEBSOCKET_PASSWORD: '',
    START_DELAY_SECONDS: '0', STOP_DELAY_SECONDS: '2', HEARTBEAT_TIMEOUT_SECONDS: '4', OBS_LAUNCH_COMMAND: `touch '${marker}'` } });
bridge2.stdout.on('data', d => process.stdout.write('  bridge2| ' + d));
bridge2.stderr.on('data', d => process.stdout.write('  bridge2! ' + d));
let wss2;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(LAUNCH_BRIDGE + '/status'); break; } catch {} await sleep(100); }
  await fetch(LAUNCH_BRIDGE + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: 5 }) });
  await sleep(500);
  check('launches OBS when it is not running', fs.existsSync(marker));
  check('not recording before OBS is up', recording === false);
  wss2 = startMockObs(LAUNCH_OBS_PORT); await sleep(2000);
  check('starts recording once launched OBS is reachable', recording === true);
  await fetch(LAUNCH_BRIDGE + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: 5 }) });
  await sleep(2500);
  check('stops after stop delay', recording === false);

  // Heartbeats: a tab that keeps re-sending /join stays active; one that goes
  // quiet (e.g. its /leave was lost) is dropped and recording stops.
  const join2 = () => fetch(LAUNCH_BRIDGE + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: 6 }) });
  await join2(); await sleep(500);
  check('recording for heartbeat test', recording === true);
  await sleep(2500); await join2(); await sleep(2500);
  check('heartbeat keeps tab active past the timeout', recording === true);
  await sleep(6000); // 4s timeout + up to 1s sweep + 2s stop delay, from last heartbeat
  check('silent tab times out and recording stops (lost /leave)', recording === false);
} finally { bridge2.kill(); wss2?.close(); }
} catch (err) { console.log('FAIL', err); fails++; }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
bridge.kill(); wss.close(); process.exit(fails ? 1 : 0);
