// Relays join/leave events from Meet tabs to the local bridge server, which
// talks to OBS. Also catches tabs closed outright (crash, ctrl+w) via
// chrome.tabs.onRemoved so a hard-closed tab still triggers a "leave".
const BRIDGE_BASE_URL = 'http://127.0.0.1:17643';
const STORAGE_KEY = 'activeTabs';
// User-facing on/off switch (popup). Stored in storage.local so it survives
// browser restarts; absent means on.
const ENABLED_KEY = 'autoRecord';

// MV3 service workers are killed after ~30s idle, wiping in-memory state, so
// the set of in-call tabs lives in chrome.storage.session (survives worker
// restarts, cleared when the browser exits). Updates are chained so that
// events arriving close together can't clobber each other's read-modify-write.
let storageQueue = Promise.resolve();

function updateActiveTabs(mutate) {
  const result = storageQueue.then(async () => {
    const { [STORAGE_KEY]: stored = [] } = await chrome.storage.session.get(STORAGE_KEY);
    const tabs = new Set(stored);
    const changed = mutate(tabs);
    if (changed) await chrome.storage.session.set({ [STORAGE_KEY]: [...tabs] });
    return changed;
  });
  storageQueue = result.catch(() => {});
  return result;
}

async function isEnabled() {
  const { [ENABLED_KEY]: enabled = true } = await chrome.storage.local.get(ENABLED_KEY);
  return enabled !== false;
}

async function listTabs() {
  await storageQueue; // let in-flight updates land first
  const { [STORAGE_KEY]: stored = [] } = await chrome.storage.session.get(STORAGE_KEY);
  return stored;
}

// Each resolves to true only if the tab's state actually changed.
const addTab = (tabId) => updateActiveTabs((tabs) => !tabs.has(tabId) && !!tabs.add(tabId));
const removeTab = (tabId) => updateActiveTabs((tabs) => tabs.delete(tabId));

async function notifyBridge(path, tabId, url) {
  try {
    await fetch(`${BRIDGE_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, url })
    });
  } catch (err) {
    console.error('[MeetRec] bridge request failed:', path, err.message);
  }
}

// Tabs are tracked even while auto-recording is off, so turning it back on
// mid-call starts recording immediately. Only the bridge calls are gated.
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === 'meet-join') {
    addTab(tabId).then(async (added) => {
      if (added && await isEnabled()) notifyBridge('/join', tabId, message.url);
    });
  } else if (message.type === 'meet-heartbeat') {
    // Forwarded every time (while enabled): the bridge may have restarted and forgotten this tab.
    addTab(tabId);
    isEnabled().then((enabled) => { if (enabled) notifyBridge('/join', tabId, message.url); });
  } else if (message.type === 'meet-leave') {
    removeTab(tabId).then(async (removed) => {
      if (removed && await isEnabled()) notifyBridge('/leave', tabId, message.url);
    });
  }
});

// Switching off stops the recording for calls in progress; switching on
// starts it for them.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[ENABLED_KEY]) return;
  const enabled = changes[ENABLED_KEY].newValue !== false;
  if (enabled === (changes[ENABLED_KEY].oldValue !== false)) return;
  for (const tabId of await listTabs()) notifyBridge(enabled ? '/join' : '/leave', tabId, null);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTab(tabId).then(async (removed) => {
    if (removed && await isEnabled()) notifyBridge('/leave', tabId, null);
  });
});

// Chrome doesn't inject content scripts into tabs that were already open when
// the extension was installed or reloaded, and the old copies there can no
// longer reach this worker. Inject fresh ones so an open call keeps reporting.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
      .catch((err) => console.error('[MeetRec] could not inject into tab', tab.id, err.message));
  }
});
