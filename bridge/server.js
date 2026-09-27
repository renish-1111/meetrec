import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OBSWebSocket from 'obs-websocket-js/json';
import { spawn } from 'child_process';
import { driveEnabled, driveStatus, queueUpload, resumeUploads, startLogin, finishLogin, logout } from './drive.js';

const PORT = Number(process.env.PORT || 17643);
const OBS_URL = process.env.OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455';
const OBS_PASSWORD = process.env.OBS_WEBSOCKET_PASSWORD || undefined;
const START_DELAY_MS = Math.min(Number(process.env.START_DELAY_SECONDS || 0), 60) * 1000;
const STOP_DELAY_MS = Number(process.env.STOP_DELAY_SECONDS || 2) * 1000;
// Launched (minimized to tray) when a meeting starts and OBS isn't running.
// Set OBS_LAUNCH_COMMAND to empty to disable.
const OBS_LAUNCH_COMMAND = process.env.OBS_LAUNCH_COMMAND ?? 'obs-studio --minimize-to-tray --disable-missing-files-check';
const OBS_LAUNCH_TIMEOUT_MS = 30000;
// The extension re-sends /join every 5s while a tab is in a call. A tab that
// goes quiet this long is treated as having left, so a lost /leave (browser
// crash, bridge restart, orphaned content script) can't leave OBS recording.
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_SECONDS || 15) * 1000;

const obs = new OBSWebSocket();
let obsConnected = false;

// tabId -> time we last heard from it, for every Meet tab currently in a call
const activeMeetings = new Map();
let startTimer = null;
let stopTimer = null;

// Recordings you start by hand in OBS are only uploaded if you opt in.
const UPLOAD_MANUAL_RECORDINGS = process.env.UPLOAD_MANUAL_RECORDINGS === 'true';
let startedByMeetRec = false;

// OBS emits STOPPED once the file is fully written, so it's safe to upload then.
obs.on('RecordStateChanged', ({ outputState, outputPath }) => {
  if (outputState !== 'OBS_WEBSOCKET_OUTPUT_STOPPED') return;
  const ours = startedByMeetRec;
  startedByMeetRec = false;
  if (!outputPath || !driveStatus().configured || !(ours || UPLOAD_MANUAL_RECORDINGS)) return;
  // Queued even while Drive is disconnected; it uploads once you connect.
  queueUpload(outputPath);
  if (!driveEnabled()) console.log('[MeetRec] Google Drive not connected, the recording will upload once you connect');
});

obs.on('ConnectionClosed', () => {
  if (obsConnected) console.warn('[MeetRec] OBS connection closed');
  obsConnected = false;
});

let connecting = null;

// Shares one in-flight connect between concurrent callers, since
// obs-websocket-js rejects a second connect() while one is pending.
function ensureConnected() {
  if (obsConnected) return Promise.resolve();
  connecting ??= obs.connect(OBS_URL, OBS_PASSWORD)
    .then(() => {
      obsConnected = true;
      console.log(`[MeetRec] connected to OBS at ${OBS_URL}`);
    })
    .finally(() => { connecting = null; });
  return connecting;
}

let obsLaunched = false;

function launchObs() {
  if (obsLaunched) return;
  obsLaunched = true;
  console.log(`[MeetRec] OBS not reachable, launching: ${OBS_LAUNCH_COMMAND}`);
  const child = spawn(OBS_LAUNCH_COMMAND, { shell: true, detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error('[MeetRec] failed to launch OBS:', err.message));
  child.on('exit', () => { obsLaunched = false; });
  child.unref(); // OBS keeps running if the bridge exits
}

// Connects to OBS, launching it first if it isn't running, and waits for its
// WebSocket server to come up. Gives up early if shouldContinue() turns false.
async function connectOrLaunch(shouldContinue) {
  try {
    return await ensureConnected();
  } catch (err) {
    if (!OBS_LAUNCH_COMMAND) throw err;
  }
  launchObs();
  const deadline = Date.now() + OBS_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!shouldContinue()) throw new Error('meeting ended while OBS was starting');
    try {
      return await ensureConnected();
    } catch {}
  }
  throw new Error(`OBS did not become reachable within ${OBS_LAUNCH_TIMEOUT_MS / 1000}s`);
}

async function isRecording() {
  const status = await obs.call('GetRecordStatus');
  return status.outputActive;
}

async function startRecording() {
  try {
    await connectOrLaunch(() => activeMeetings.size > 0);
    if (activeMeetings.size === 0) return;
    if (await isRecording()) {
      console.log('[MeetRec] already recording, skipping start');
      return;
    }
    await obs.call('StartRecord');
    startedByMeetRec = true;
    console.log('[MeetRec] recording started');
  } catch (err) {
    console.error('[MeetRec] failed to start recording:', err.message);
  }
}

async function stopRecording() {
  try {
    await ensureConnected();
    if (!(await isRecording())) {
      console.log('[MeetRec] not recording, skipping stop');
      return;
    }
    await obs.call('StopRecord');
    console.log('[MeetRec] recording stopped');
  } catch (err) {
    console.error('[MeetRec] failed to stop recording:', err.message);
  }
}

const app = express();
// Only the extension (and local tools like curl, which send no Origin) may call
// the bridge. Without this, any website you visit could start a recording or
// read your Drive account from /status.
const isExtensionOrigin = (origin) => /^(chrome|moz)-extension:\/\//.test(origin);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isExtensionOrigin(origin)) return res.status(403).end();
  next();
});
app.use(cors({ origin: (origin, cb) => cb(null, !origin || isExtensionOrigin(origin)) }));
app.use(express.json());

app.post('/join', (req, res) => {
  const { tabId } = req.body ?? {};
  if (typeof tabId !== 'number') return res.status(400).end();

  const wasEmpty = activeMeetings.size === 0;
  activeMeetings.set(tabId, Date.now());

  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
    console.log('[MeetRec] cancelled pending stop (rejoin detected)');
  }

  if (wasEmpty && !startTimer) {
    console.log(`[MeetRec] meeting joined (tab ${tabId}), starting recording in ${START_DELAY_MS}ms`);
    startTimer = setTimeout(() => {
      startTimer = null;
      startRecording();
    }, START_DELAY_MS);
  }

  res.status(204).end();
});

app.post('/leave', (req, res) => {
  const { tabId } = req.body ?? {};
  if (typeof tabId !== 'number') return res.status(400).end();

  handleLeave(tabId, 'meeting left');
  res.status(204).end();
});

setInterval(() => {
  for (const [tabId, lastSeen] of activeMeetings) {
    if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
      handleLeave(tabId, `no heartbeat for ${HEARTBEAT_TIMEOUT_MS / 1000}s, treating as left`);
    }
  }
}, 1000);

function handleLeave(tabId, reason) {
  activeMeetings.delete(tabId);
  console.log(`[MeetRec] ${reason} (tab ${tabId}), ${activeMeetings.size} active`);

  if (activeMeetings.size === 0) {
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
      console.log('[MeetRec] cancelled pending start (left before it fired)');
    }
    if (!stopTimer) {
      console.log(`[MeetRec] stopping recording in ${STOP_DELAY_MS}ms`);
      stopTimer = setTimeout(() => {
        stopTimer = null;
        stopRecording();
      }, STOP_DELAY_MS);
    }
  }
}

app.get('/status', async (req, res) => {
  res.json({
    obsConnected,
    activeMeetings: [...activeMeetings.keys()],
    recording: obsConnected ? await isRecording().catch(() => null) : null,
    drive: driveStatus()
  });
});

// Sign-in: the extension opens /drive/connect in a tab, Google sends the
// browser back to /drive/callback, and the bridge stores the account.
const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>MeetRec</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h2>${title}</h2><p>${text}</p></body>`;
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

app.get('/drive/connect', (req, res) => {
  if (!driveStatus().configured) {
    return res.status(503).send(page('Google Drive isn\'t set up',
      'Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>bridge/.env</code> and restart the bridge. See the README.'));
  }
  res.redirect(startLogin(`http://127.0.0.1:${PORT}/drive/callback`));
});

app.get('/drive/callback', async (req, res) => {
  const { state, code, error } = req.query;
  if (error || !code) {
    return res.status(400).send(page('Not connected', `Google sign-in was cancelled (${escapeHtml(error || 'no code')}). You can close this tab.`));
  }
  try {
    const email = await finishLogin(String(state), String(code));
    res.send(page('Google Drive connected ✓',
      `Recordings will upload to the <b>MeetRec</b> folder in ${email ? `<b>${escapeHtml(email)}</b>'s` : 'your'} Drive. You can close this tab.`));
  } catch (err) {
    console.error('[MeetRec] Google sign-in failed:', err.message);
    res.status(400).send(page('Not connected', `${escapeHtml(err.message)}. You can close this tab and try again.`));
  }
});

app.post('/drive/disconnect', async (req, res) => {
  await logout();
  res.status(204).end();
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[MeetRec] bridge listening on http://127.0.0.1:${PORT}`);
  const drive = driveStatus();
  console.log(`[MeetRec] Google Drive: ${drive.connected ? `connected as ${drive.email}` : drive.configured ? 'not connected (use the extension to connect)' : 'not set up'}`);
  resumeUploads();
  ensureConnected().catch((err) => console.error('[MeetRec] initial OBS connect failed:', err.message));
});
