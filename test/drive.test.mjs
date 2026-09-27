// End-to-end test for the Google Drive upload: runs the real bridge against a
// mock OBS and a mock Google (token + Drive API). No OBS or Google account needed.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs'; import os from 'os'; import path from 'path';
const BRIDGE_DIR = fileURLToPath(new URL('../bridge/', import.meta.url));
const require = createRequire(BRIDGE_DIR + 'package.json');
const { WebSocketServer } = require('ws');

const OBS_PORT = 4497, GOOGLE_PORT = 4496, BRIDGE = 'http://127.0.0.1:17697';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-drive-'));
let fileN = 0, recording = false;

// Mock OBS: StopRecord writes a "recording" and emits RecordStateChanged STOPPED.
const sockets = new Set();
const emitStopped = (outputPath) => {
  for (const ws of sockets) ws.send(JSON.stringify({ op: 5, d: { eventType: 'RecordStateChanged', eventIntent: 64,
    eventData: { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath } } }));
};
const wss = new WebSocketServer({ port: OBS_PORT });
wss.on('connection', (ws) => {
  sockets.add(ws); ws.on('close', () => sockets.delete(ws));
  ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 1) return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    if (m.op !== 6) return;
    const { requestType, requestId } = m.d;
    let responseData = {};
    if (requestType === 'GetRecordStatus') responseData = { outputActive: recording };
    if (requestType === 'StartRecord') recording = true;
    let out;
    if (requestType === 'StopRecord') {
      recording = false;
      out = path.join(tmp, `meeting-${++fileN}.mkv`);
      fs.writeFileSync(out, Buffer.alloc(300 * 1024, fileN));
      responseData = { outputPath: out };
    }
    ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
    if (out) setTimeout(() => emitStopped(out), 100);
  });
});

// Mock Google.
const uploads = []; let foldersCreated = 0, tokenRefreshes = 0, codeExchanges = 0, revoked = 0, failNextChunk = false;
// hangNextChunk: take the bytes but never answer (a frozen connection).
// holdChunks: after the first chunk, never answer again (bridge killed mid-upload).
// failInits: refuse this many upload starts with a 500.
let hangNextChunk = false, holdChunks = false, failInits = 0;
const google = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks); const url = new URL(req.url, 'http://x');
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body.toString());
      if (form.get('grant_type') === 'refresh_token') { tokenRefreshes++; return json(200, { access_token: 'tok', expires_in: 3600 }); }
      if (form.get('code') !== 'good-code' || !form.get('code_verifier')) return json(400, { error: 'invalid_grant' });
      codeExchanges++;
      const idToken = ['x', Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url'), 'sig'].join('.');
      return json(200, { access_token: 'tok', expires_in: 3600, refresh_token: 'refresh', id_token: idToken });
    }
    if (url.pathname === '/revoke') { revoked++; return json(200, {}); }
    if (req.headers.authorization !== 'Bearer tok') return json(401, { error: 'unauthorized' });
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') return json(200, { files: foldersCreated ? [{ id: 'folder1' }] : [] });
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') { foldersCreated++; return json(200, { id: 'folder1' }); }
    if (url.pathname === '/upload/drive/v3/files') {
      if (failInits > 0) { failInits--; return json(500, { error: 'backend' }); }
      const meta = JSON.parse(body); const id = uploads.length;
      uploads.push({ meta, size: Number(req.headers['x-upload-content-length']), data: Buffer.alloc(0) });
      res.writeHead(200, { Location: `http://127.0.0.1:${GOOGLE_PORT}/session/${id}` }); return res.end();
    }
    if (url.pathname.startsWith('/session/')) {
      const u = uploads[Number(url.pathname.split('/')[2])];
      if (failNextChunk && body.length) { failNextChunk = false; return json(503, { error: 'backend' }); }
      if (holdChunks && body.length && u.data.length) return;
      if (hangNextChunk && body.length) { hangNextChunk = false; u.data = Buffer.concat([u.data, body]); return; }
      u.data = Buffer.concat([u.data, body]);
      if (u.data.length >= u.size) return json(200, { id: 'file' + uploads.indexOf(u), webViewLink: 'https://drive/x' });
      res.writeHead(308, u.data.length ? { Range: `bytes=0-${u.data.length - 1}` } : {}); return res.end();
    }
    json(404, {});
  });
}).listen(GOOGLE_PORT, '127.0.0.1');

const startBridge = (port, extra) => {
  const b = spawn('node', ['server.js'], { cwd: BRIDGE_DIR, env: { ...process.env, PORT: String(port),
    OBS_WEBSOCKET_URL: `ws://127.0.0.1:${OBS_PORT}`, OBS_WEBSOCKET_PASSWORD: '', START_DELAY_SECONDS: '0', STOP_DELAY_SECONDS: '1',
    OBS_LAUNCH_COMMAND: '', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', DRIVE_ACCOUNT_FILE: path.join(tmp, 'account.json'),
    DRIVE_QUEUE_FILE: path.join(tmp, 'queue.json'), DRIVE_CHUNK_SIZE: String(256 * 1024), DRIVE_STALL_TIMEOUT_MS: '1000',
    GOOGLE_DRIVE_FOLDER_NAME: 'MeetRec', DELETE_AFTER_UPLOAD: 'false', UPLOAD_MANUAL_RECORDINGS: 'false', GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`,
    GOOGLE_AUTH_URL: 'https://accounts.example/auth', GOOGLE_REVOKE_URL: `http://127.0.0.1:${GOOGLE_PORT}/revoke`,
    GOOGLE_API_URL: `http://127.0.0.1:${GOOGLE_PORT}`, DRIVE_RETRY_BASE_MS: '200', ...extra } });
  b.stdout.on('data', d => process.stdout.write(`  bridge${port}| ` + d));
  b.stderr.on('data', d => process.stdout.write(`  bridge${port}! ` + d));
  return b;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body) => fetch(BRIDGE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const status = () => fetch(BRIDGE + '/status').then(r => r.json());
let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

const bridge = startBridge(17697);
let bridge2;
try {
  for (let i = 0; i < 50; i++) { try { if ((await status()).obsConnected) break; } catch {} await sleep(100); }
  let d = (await status()).drive;
  check('Drive configured but not connected at first', d.configured === true && d.connected === false);

  // Websites can't drive the bridge; the extension and curl (no Origin) can.
  const evil = await fetch(BRIDGE + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"tabId":9}' });
  check('requests from websites are refused', evil.status === 403 && (await status()).activeMeetings.length === 0);
  const ext = await fetch(BRIDGE + '/status', { headers: { Origin: 'chrome-extension://abc' } });
  check('requests from the extension are allowed', ext.status === 200);

  // Sign-in: /drive/connect redirects to Google; Google redirects back to /drive/callback.
  const conn = await fetch(BRIDGE + '/drive/connect', { redirect: 'manual' });
  const authUrl = new URL(conn.headers.get('location'));
  check('connect redirects to Google consent', conn.status === 302 && authUrl.origin === 'https://accounts.example'
    && authUrl.searchParams.get('redirect_uri') === `${BRIDGE}/drive/callback` && authUrl.searchParams.get('code_challenge_method') === 'S256');
  const state = authUrl.searchParams.get('state');
  const forged = await fetch(`${BRIDGE}/drive/callback?state=wrong&code=good-code`);
  check('callback with a wrong state is rejected', forged.status === 400 && codeExchanges === 0);
  const cb = await fetch(`${BRIDGE}/drive/callback?state=${state}&code=good-code`);
  check('callback finishes sign-in', cb.status === 200 && (await cb.text()).includes('me@example.com'));
  d = (await status()).drive;
  check('status shows connected account', d.connected === true && d.email === 'me@example.com');
  check('sign-in saved privately to disk', (fs.statSync(path.join(tmp, 'account.json')).mode & 0o777) === 0o600);

  await post('/join', { tabId: 1 }); await sleep(300);
  await post('/leave', { tabId: 1 }); await sleep(2000);
  check('recording uploaded after the call', uploads.length === 1);
  check('uploaded into the created MeetRec folder', foldersCreated === 1 && uploads[0]?.meta.parents[0] === 'folder1');
  check('upload keeps the file name', uploads[0]?.meta.name === 'meeting-1.mkv');
  check('uploaded bytes match the file', uploads[0]?.data.equals(fs.readFileSync(path.join(tmp, 'meeting-1.mkv'))));
  check('status shows last upload', (await status()).drive.lastUpload?.ok === true);
  check('local file kept by default', fs.existsSync(path.join(tmp, 'meeting-1.mkv')));

  // A 5xx mid-upload is retried and the second meeting reuses the folder.
  failNextChunk = true;
  await post('/join', { tabId: 2 }); await sleep(300);
  await post('/leave', { tabId: 2 }); await sleep(5000);
  check('upload retried after a server error', uploads.length === 2 && uploads[1].data.length === uploads[1].size);
  check('existing folder reused', foldersCreated === 1);
  check('access token reused between uploads', tokenRefreshes === 0);

  // A recording MeetRec didn't start (e.g. started by hand) isn't uploaded.
  const manual = path.join(tmp, 'manual.mkv'); fs.writeFileSync(manual, 'x');
  emitStopped(manual); await sleep(1000);
  check('recordings not started by MeetRec are not uploaded', uploads.length === 2);

  // A frozen connection times out and the upload carries on where Drive got to.
  hangNextChunk = true;
  await post('/join', { tabId: 5 }); await sleep(300);
  await post('/leave', { tabId: 5 }); await sleep(6000);
  check('stalled upload times out and completes', uploads.length === 3 && uploads[2].data.equals(fs.readFileSync(path.join(tmp, `meeting-${fileN}.mkv`))));

  // Uploads that keep failing are retried more than 5 times.
  failInits = 5;
  await post('/join', { tabId: 6 }); await sleep(300);
  await post('/leave', { tabId: 6 });
  for (let i = 0; i < 150 && uploads.length < 4; i++) await sleep(100);
  await sleep(500);
  check('upload retried past 5 failures', uploads.length === 4 && uploads[3].data.length === uploads[3].size);

  // Bridge killed mid-upload: the queue is on disk and the next start resumes it.
  holdChunks = true;
  await post('/join', { tabId: 7 }); await sleep(300);
  await post('/leave', { tabId: 7 });
  for (let i = 0; i < 50 && !(uploads.length === 5 && uploads[4].data.length); i++) await sleep(100);
  bridge.kill(); await sleep(200);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'queue.json'), 'utf8'));
  check('pending upload saved to disk', saved.length === 1 && saved[0].filePath.endsWith(`meeting-${fileN}.mkv`) && saved[0].sessionUrl);
  check('upload queue file is private', (fs.statSync(path.join(tmp, 'queue.json')).mode & 0o777) === 0o600);
  const halfDone = uploads[4].data.length;
  const resumedFile = fs.readFileSync(path.join(tmp, `meeting-${fileN}.mkv`)); // bridge2 deletes it after upload
  holdChunks = false;

  // DELETE_AFTER_UPLOAD removes the local copy once it's safely on Drive.
  bridge2 = startBridge(17696, { DELETE_AFTER_UPLOAD: 'true', UPLOAD_MANUAL_RECORDINGS: 'true' });
  const B2 = 'http://127.0.0.1:17696';
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B2 + '/status').then(r => r.json())).obsConnected) break; } catch {} await sleep(100); }
  await sleep(1000);
  check('upload resumed after restart in the same session', uploads.length === 5 && halfDone > 0
    && uploads[4].data.length === uploads[4].size && uploads[4].data.equals(resumedFile));
  check('queue emptied once uploaded', JSON.parse(fs.readFileSync(path.join(tmp, 'queue.json'), 'utf8')).length === 0);
  const p2 = (p, body) => fetch(B2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await p2('/join', { tabId: 3 }); await sleep(300);
  await p2('/leave', { tabId: 3 }); await sleep(2000);
  const last = path.join(tmp, `meeting-${fileN}.mkv`);
  check('sign-in survives a bridge restart', uploads.length === 6);
  check('DELETE_AFTER_UPLOAD uploads then deletes local file', !fs.existsSync(last));

  const disc = await fetch(B2 + '/drive/disconnect', { method: 'POST', headers: { Origin: 'chrome-extension://abc' } });
  d = (await fetch(B2 + '/status').then(r => r.json())).drive;
  check('disconnect revokes and forgets the account', disc.status === 204 && revoked === 1 && d.connected === false
    && !fs.existsSync(path.join(tmp, 'account.json')));
  await p2('/join', { tabId: 4 }); await sleep(300);
  await p2('/leave', { tabId: 4 }); await sleep(2000);
  d = (await fetch(B2 + '/status').then(r => r.json())).drive;
  check('recording made while disconnected is queued, not uploaded', uploads.length === 6 && d.queued.length === 1);

  // Reconnecting uploads what waited.
  const conn2 = await fetch(B2 + '/drive/connect', { redirect: 'manual' });
  const state2 = new URL(conn2.headers.get('location')).searchParams.get('state');
  await fetch(`${B2}/drive/callback?state=${state2}&code=good-code`); await sleep(1000);
  d = (await fetch(B2 + '/status').then(r => r.json())).drive;
  check('queued recording uploads after reconnecting', uploads.length === 7 && d.queued.length === 0 && uploads[6].meta.name === `meeting-${fileN}.mkv`);

  // UPLOAD_MANUAL_RECORDINGS=true uploads recordings started by hand too.
  const manual2 = path.join(tmp, 'manual2.mkv'); fs.writeFileSync(manual2, 'hand');
  emitStopped(manual2); await sleep(1000);
  check('UPLOAD_MANUAL_RECORDINGS uploads recordings started by hand', uploads.length === 8 && uploads[7].meta.name === 'manual2.mkv');
} catch (err) { console.log('FAIL', err); fails++; }
finally { bridge.kill(); bridge2?.kill(); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
wss.close(); google.close(); process.exit(fails ? 1 : 0);
