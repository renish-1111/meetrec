import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OBSWebSocket from 'obs-websocket-js/json';
import { spawn } from 'child_process';
import { driveEnabled, driveStatus, queueUpload, resumeUploads, startLogin, finishLogin, logout, saveSettings } from './drive.js';

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

let startedByMeetRec = false;
// A recording started by hand from the popup is the user's to stop: ending a
// call (or switching auto-record off) must not cut it short.
let manualRecording = false;

// OBS emits STOPPED once the file is fully written, so it's safe to upload then.
obs.on('RecordStateChanged', ({ outputState, outputPath }) => {
  if (outputState !== 'OBS_WEBSOCKET_OUTPUT_STOPPED') return;
  const ours = startedByMeetRec;
  startedByMeetRec = false;
  manualRecording = false;
  const { configured, uploadEnabled, uploadManual } = driveStatus();
  // Recordings you start by hand in OBS are only uploaded if you opt in.
  if (!outputPath || !configured || !uploadEnabled || !(ours || uploadManual)) return;
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

// Manual controls from the extension popup. Unlike startRecording() these
// don't depend on a meeting being active, and they throw so the popup can show why.
// OBS acknowledges these requests before the output has actually changed
// state, so a /status right after one can still show the old state. Wait for
// the new state so the popup never renders stale buttons.
async function waitForState(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await obs.call('GetRecordStatus'))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`OBS did not ${what} in time`);
}

const RECORD_ACTIONS = {
  async start() {
    await connectOrLaunch(() => true);
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    manualRecording = true;
    if (!(await isRecording())) {
      await obs.call('StartRecord');
      // Not marked startedByMeetRec: whether a hand-started recording uploads
      // is the "Also upload recordings I start in OBS" setting's call.
    }
    await waitForState((s) => s.outputActive, 'start recording');
  },
  async stop() {
    await ensureConnected();
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    manualRecording = false;
    if (await isRecording()) await obs.call('StopRecord');
    await waitForState((s) => !s.outputActive, 'stop recording');
  },
  async pause() {
    await ensureConnected();
    if (!(await isRecording())) throw new Error('not recording');
    await obs.call('PauseRecord');
    await waitForState((s) => s.outputPaused, 'pause recording');
  },
  async resume() {
    await ensureConnected();
    if (!(await isRecording())) throw new Error('not recording');
    await obs.call('ResumeRecord');
    await waitForState((s) => !s.outputPaused, 'resume recording');
  }
};

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
        if (manualRecording) return console.log('[MeetRec] recording was started by hand, leaving it running');
        stopRecording();
      }, STOP_DELAY_MS);
    }
  }
}

// Manual actions run one at a time so a double-click can't send StartRecord twice.
let manualQueue = Promise.resolve();

app.post('/record/:action', async (req, res) => {
  if (!Object.hasOwn(RECORD_ACTIONS, req.params.action)) return res.status(404).json({ ok: false, error: 'unknown action' });
  const action = RECORD_ACTIONS[req.params.action];
  try {
    const run = manualQueue.then(action);
    manualQueue = run.catch(() => {});
    await run;
    console.log(`[MeetRec] manual ${req.params.action}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[MeetRec] manual ${req.params.action} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/status', async (req, res) => {
  const rec = obsConnected ? await obs.call('GetRecordStatus').catch(() => null) : null;
  res.json({
    obsConnected,
    activeMeetings: [...activeMeetings.keys()],
    recording: rec ? rec.outputActive : null,
    paused: rec ? !!rec.outputPaused : false,
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
      'Enter your Google client ID and secret in the MeetRec extension popup. See the README.'));
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

app.post('/drive/settings', async (req, res) => {
  try {
    await saveSettings(req.body ?? {});
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
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
