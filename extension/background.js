// Relays join/leave events from Meet tabs to the local bridge server, which
// talks to OBS. Also catches tabs closed outright (crash, ctrl+w) via
// chrome.tabs.onRemoved so a hard-closed tab still triggers a "leave".
const BRIDGE_BASE_URL = 'http://127.0.0.1:17643';
const STORAGE_KEY = 'activeTabs';

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

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === 'meet-join') {
    addTab(tabId).then((added) => {
      if (added) notifyBridge('/join', tabId, message.url);
    });
  } else if (message.type === 'meet-heartbeat') {
    // Always forwarded: the bridge may have restarted and forgotten this tab.
    addTab(tabId);
    notifyBridge('/join', tabId, message.url);
  } else if (message.type === 'meet-leave') {
    removeTab(tabId).then((removed) => {
      if (removed) notifyBridge('/leave', tabId, message.url);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTab(tabId).then((removed) => {
    if (removed) notifyBridge('/leave', tabId, null);
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
