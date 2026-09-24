import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OBSWebSocket from 'obs-websocket-js/json';
import { spawn } from 'child_process';

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
app.use(cors());
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
    recording: obsConnected ? await isRecording().catch(() => null) : null
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[MeetRec] bridge listening on http://127.0.0.1:${PORT}`);
  ensureConnected().catch((err) => console.error('[MeetRec] initial OBS connect failed:', err.message));
});
