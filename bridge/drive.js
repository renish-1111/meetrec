// Google Drive: sign-in (the extension's "Connect Google Drive" button opens
// /drive/connect) and uploading finished recordings with a resumable, chunked
// upload. Uses the drive.file scope, so MeetRec can only see the files and
// folder it created itself.
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const FOLDER_NAME = process.env.GOOGLE_DRIVE_FOLDER_NAME || 'MeetRec';
const DELETE_AFTER_UPLOAD = process.env.DELETE_AFTER_UPLOAD === 'true';
// Where the sign-in is saved. Holds a refresh token, so it's kept private.
const ACCOUNT_FILE = process.env.DRIVE_ACCOUNT_FILE || fileURLToPath(new URL('drive-account.json', import.meta.url));
// Recordings waiting to upload, so a bridge restart doesn't lose them.
const QUEUE_FILE = process.env.DRIVE_QUEUE_FILE || fileURLToPath(new URL('drive-queue.json', import.meta.url));
// Overridable so the tests can point at a fake Google.
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const API_URL = process.env.GOOGLE_API_URL || 'https://www.googleapis.com';
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';

const CHUNK_SIZE = Number(process.env.DRIVE_CHUNK_SIZE || 16 * 1024 * 1024); // must be a multiple of 256 KiB
const MAX_CHUNK_ATTEMPTS = 5;
// A failed upload is retried after 30s, 1m, 2m, 4m, 8m, then every 15m until
// it succeeds, so it outlasts any outage. Only a missing file is given up on.
const RETRY_BASE_MS = Number(process.env.DRIVE_RETRY_BASE_MS || 30000);
const RETRY_MAX_MS = RETRY_BASE_MS * 30;
// Give up on a request that makes no progress for this long (e.g. the laptop
// slept or the connection froze), instead of hanging until the OS notices.
const STALL_TIMEOUT_MS = Number(process.env.DRIVE_STALL_TIMEOUT_MS || 120000);
const REQUEST_TIMEOUT_MS = 60000;

const configured = Boolean(CLIENT_ID && CLIENT_SECRET);

function loadAccount() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

let account = loadAccount(); // { refreshToken, email }
let accessToken = null;
let accessTokenExpiry = 0;
let folderId = null;

// [{ filePath, attempts, sessionUrl, size, retryAt }]. sessionUrl lets an
// interrupted upload continue where it stopped, even after a restart.
const queue = loadQueue();
let uploading = null;
let lastUpload = null;
let retryTimer = null;

function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')).map((j) => ({ ...j, retryAt: 0 }));
  } catch {
    return [];
  }
}

function saveQueue() {
  const jobs = queue.map(({ filePath, attempts, sessionUrl, size }) => ({ filePath, attempts, sessionUrl, size }));
  try {
    // The upload URLs grant access to the upload, so keep the file private.
    fs.writeFileSync(QUEUE_FILE + '.tmp', JSON.stringify(jobs, null, 2), { mode: 0o600 });
    fs.renameSync(QUEUE_FILE + '.tmp', QUEUE_FILE);
  } catch (err) {
    console.error(`[MeetRec] couldn't save the upload queue: ${err.message}`);
  }
}

export const driveEnabled = () => Boolean(configured && account);

export function driveStatus() {
  return {
    configured,
    connected: driveEnabled(),
    email: account?.email ?? null,
    uploading,
    queued: queue.map((q) => q.filePath).filter((f) => f !== uploading),
    lastUpload
  };
}

// --- Sign-in -------------------------------------------------------------

const pendingLogins = new Map(); // state -> { verifier, redirectUri, expires }

// Returns the Google consent URL to send the browser to.
export function startLogin(redirectUri) {
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  pendingLogins.set(state, { verifier, redirectUri, expires: Date.now() + 10 * 60000 });
  return AUTH_URL + '?' + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token, even when reconnecting
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state
  });
}

// Finishes sign-in with the code Google redirected back with.
export async function finishLogin(state, code) {
  const login = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!login || login.expires < Date.now()) throw new Error('sign-in link expired or invalid, please try again');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: login.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: login.verifier
    })
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok || !tokens.refresh_token) {
    throw new Error(tokens.error_description || tokens.error || 'Google did not return a refresh token');
  }
  // The ID token comes straight from Google over TLS, so its payload can be read as-is.
  let email = null;
  try {
    email = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).email ?? null;
  } catch {}
  account = { refreshToken: tokens.refresh_token, email };
  accessToken = tokens.access_token;
  accessTokenExpiry = Date.now() + tokens.expires_in * 1000;
  folderId = null;
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
  console.log(`[MeetRec] connected to Google Drive as ${email ?? 'unknown account'}`);
  resumeUploads(); // anything that waited for a sign-in
  return email;
}

export async function logout() {
  const old = account;
  account = null;
  accessToken = null;
  folderId = null;
  fs.rmSync(ACCOUNT_FILE, { force: true });
  if (old) {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: old.refreshToken })
    }).catch(() => {});
    console.log('[MeetRec] disconnected from Google Drive');
  }
}

// --- Upload --------------------------------------------------------------

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60000) return accessToken;
  if (!account) throw Object.assign(new Error('Google Drive is not connected'), { auth: true });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`token refresh failed: ${body.error || res.status} ${body.error_description || ''}`.trim());
    // A revoked or expired sign-in won't fix itself by retrying.
    err.auth = body.error === 'invalid_grant' || body.error === 'invalid_client';
    throw err;
  }
  accessToken = body.access_token;
  accessTokenExpiry = Date.now() + body.expires_in * 1000;
  return accessToken;
}

async function driveFetch(url, opts = {}) {
  const token = await getAccessToken();
  return fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, ...opts.headers }
  });
}

// PUTs part of an upload. Unlike fetch, this can tell a slow upload (still
// sending) from a stuck one: it fails only after STALL_TIMEOUT_MS with no
// bytes moving either way.
async function putChunk(url, range, buf = Buffer.alloc(0)) {
  const token = await getAccessToken();
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Range': range, 'Content-Length': buf.length },
      timeout: STALL_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, range: res.headers.range, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`upload stalled (no progress for ${STALL_TIMEOUT_MS / 1000}s)`)));
    req.on('error', reject);
    req.end(buf);
  });
}

// "bytes=0-12345" -> 12346
const nextOffset = (range) => (range ? Number(range.split('-')[1]) + 1 : 0);
const sessionGone = () => Object.assign(new Error('upload session expired, starting over'), { expired: true });

async function getFolderId() {
  if (folderId) return folderId;
  const q = `name = '${FOLDER_NAME.replace(/['\\]/g, '\\$&')}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await driveFetch(`${API_URL}/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' })}`);
  if (!res.ok) throw new Error(`folder lookup failed: HTTP ${res.status} ${await res.text()}`);
  const { files } = await res.json();
  if (files.length) return (folderId = files[0].id);

  const created = await driveFetch(`${API_URL}/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!created.ok) throw new Error(`folder create failed: HTTP ${created.status} ${await created.text()}`);
  folderId = (await created.json()).id;
  console.log(`[MeetRec] created Drive folder "${FOLDER_NAME}"`);
  return folderId;
}

// Asks Drive how far an interrupted upload got: { offset } or, if it already
// has everything, { file }.
async function uploadProgress(sessionUrl, size) {
  const res = await putChunk(sessionUrl, `bytes */${size}`);
  if (res.status === 200 || res.status === 201) return { file: JSON.parse(res.body) };
  if (res.status === 308) return { offset: nextOffset(res.range) };
  if (res.status === 404 || res.status === 410) throw sessionGone();
  throw new Error(`upload status check failed: HTTP ${res.status}`);
}

async function upload(job) {
  const { size } = await fs.promises.stat(job.filePath);
  let offset = 0;

  if (job.sessionUrl && job.size === size) {
    try {
      const got = await uploadProgress(job.sessionUrl, size);
      if (got.file) return got.file;
      offset = got.offset;
      if (offset) console.log(`[MeetRec] resuming upload at ${Math.round((offset / size) * 100)}%`);
    } catch (err) {
      if (!err.expired) throw err;
      job.sessionUrl = null;
    }
  } else {
    job.sessionUrl = null;
  }

  if (!job.sessionUrl) {
    const parent = await getFolderId();
    const init = await driveFetch(`${API_URL}/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name: path.basename(job.filePath), parents: [parent] })
    });
    if (!init.ok) throw new Error(`upload init failed: HTTP ${init.status} ${await init.text()}`);
    job.sessionUrl = init.headers.get('location');
    job.size = size;
    saveQueue();
  }

  const fh = await fs.promises.open(job.filePath, 'r');
  try {
    let chunkFailures = 0;
    const retryChunk = async (err) => {
      if (++chunkFailures > MAX_CHUNK_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 2000 * chunkFailures));
      const got = await uploadProgress(job.sessionUrl, size);
      return got.file ?? got.offset;
    };
    for (;;) {
      const len = Math.min(CHUNK_SIZE, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      const range = len ? `bytes ${offset}-${offset + len - 1}/${size}` : `bytes */${size}`;
      let res;
      try {
        res = await putChunk(job.sessionUrl, range, buf);
      } catch (err) {
        // Network blip or stall: find out where Drive got to and carry on from there.
        const got = await retryChunk(err);
        if (typeof got === 'object') return got;
        offset = got;
        continue;
      }
      if (res.status === 200 || res.status === 201) return JSON.parse(res.body);
      if (res.status === 308) {
        offset = nextOffset(res.range);
        chunkFailures = 0;
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        job.sessionUrl = null;
        throw sessionGone();
      }
      if (res.status >= 500) {
        const got = await retryChunk(new Error(`upload failed: HTTP ${res.status}`));
        if (typeof got === 'object') return got;
        offset = got;
        continue;
      }
      throw new Error(`upload failed: HTTP ${res.status} ${res.body}`);
    }
  } finally {
    await fh.close();
  }
}

function removeJob(job) {
  queue.splice(queue.indexOf(job), 1);
  saveQueue();
}

async function processQueue() {
  if (uploading || !driveEnabled()) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  for (;;) {
    const job = queue.find((j) => j.retryAt <= Date.now());
    if (!job || !driveEnabled()) break;
    uploading = job.filePath;
    try {
      console.log(`[MeetRec] uploading ${job.filePath} to Google Drive`);
      const file = await upload(job);
      removeJob(job);
      console.log(`[MeetRec] uploaded to Drive: ${file.webViewLink || file.id}`);
      lastUpload = { filePath: job.filePath, ok: true, link: file.webViewLink || null, at: new Date().toISOString() };
      if (DELETE_AFTER_UPLOAD) {
        await fs.promises.unlink(job.filePath);
        console.log(`[MeetRec] deleted local copy ${job.filePath}`);
      }
    } catch (err) {
      lastUpload = { filePath: job.filePath, ok: false, error: err.message, at: new Date().toISOString() };
      if (err.code === 'ENOENT') {
        console.error(`[MeetRec] giving up on Drive upload of ${job.filePath}: the file is gone`);
        removeJob(job);
      } else if (err.auth) {
        // Retrying won't help until you sign in again, which resumes the queue.
        console.error(`[MeetRec] Drive upload paused (${err.message}). Reconnect Google Drive in the extension popup to continue.`);
        saveQueue();
        break;
      } else {
        job.attempts++;
        const delay = Math.min(RETRY_BASE_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS);
        job.retryAt = Date.now() + delay;
        saveQueue();
        console.error(`[MeetRec] Drive upload failed (${err.message}), retrying in ${Math.round(delay / 1000)}s`);
      }
    }
  }
  uploading = null;
  const waiting = queue.filter((j) => j.retryAt > Date.now());
  if (waiting.length && driveEnabled()) {
    const next = Math.min(...waiting.map((j) => j.retryAt));
    retryTimer = setTimeout(processQueue, next - Date.now());
  }
}

export function queueUpload(filePath) {
  queue.push({ filePath, attempts: 0, sessionUrl: null, size: null, retryAt: 0 });
  saveQueue();
  processQueue();
}

// Picks up recordings left over from before a restart or a sign-in problem.
export function resumeUploads() {
  for (const job of queue) job.retryAt = 0;
  if (queue.length) {
    console.log(`[MeetRec] ${queue.length} recording(s) waiting to upload to Drive${driveEnabled() ? '' : ' once you connect'}`);
  }
  processQueue();
}
