// Tests extension/background.js and extension/content.js in a Node VM with
// mocked chrome.* and DOM APIs.
import vm from 'vm'; import fs from 'fs';
const EXT = new URL('../extension/', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) fails++; };

// ---- background.js ----
const sessionStore = {}; const bridgeCalls = []; const injected = [];
function loadWorker() { // fresh worker = fresh globals, same session storage
  const l = { msg: [], removed: [], installed: [] };
  const chrome = {
    storage: { session: {
      get: async k => { await sleep(1); return k in sessionStore ? { [k]: structuredClone(sessionStore[k]) } : {}; },
      set: async o => { await sleep(1); Object.assign(sessionStore, structuredClone(o)); } } },
    runtime: { onMessage: { addListener: f => l.msg.push(f) }, onInstalled: { addListener: f => l.installed.push(f) } },
    tabs: { onRemoved: { addListener: f => l.removed.push(f) },
      query: async ({ url }) => (url === 'https://meet.google.com/*' ? [{ id: 7 }, { id: 8 }] : []) },
    scripting: { executeScript: async ({ target, files }) => { injected.push(`${target.tabId}:${files}`); } } };
  const fetch = async (url, o) => { bridgeCalls.push(url.split('/').pop() + ':' + JSON.parse(o.body).tabId); };
  vm.runInNewContext(fs.readFileSync(new URL('background.js', EXT), 'utf8'), { chrome, fetch, console });
  return { msg: (type, tabId) => l.msg.forEach(f => f({ type, url: 'u' }, { tab: { id: tabId } })),
           close: tabId => l.removed.forEach(f => f(tabId)),
           install: () => Promise.all(l.installed.map(f => f({ reason: 'update' }))) };
}
let w = loadWorker();
w.msg('meet-join', 1); w.msg('meet-join', 1); w.msg('meet-join', 2); await sleep(50);
check('duplicate joins deduped, concurrent joins both stored', bridgeCalls.join() === 'join:1,join:2' && sessionStore.activeTabs.length === 2);
w = loadWorker(); // simulate service worker being killed + restarted
w.msg('meet-leave', 1); await sleep(50);
check('leave after worker restart still reaches bridge (the bug)', bridgeCalls.at(-1) === 'leave:1');
w = loadWorker(); w.close(2); w.close(99); await sleep(50);
check('tab close after restart sends leave; unrelated tab ignored', bridgeCalls.join() === 'join:1,join:2,leave:1,leave:2');
w.msg('meet-leave', 2); await sleep(50);
check('repeat leave ignored', bridgeCalls.length === 4);
w.msg('meet-heartbeat', 3); w.msg('meet-heartbeat', 3); await sleep(50);
check('every heartbeat is forwarded as /join (bridge may have forgotten the tab)', bridgeCalls.slice(4).join() === 'join:3,join:3');
w.msg('meet-leave', 3); await sleep(50);
check('leave after heartbeat-only tab still reaches bridge', bridgeCalls.at(-1) === 'leave:3');
await w.install();
check('on install/reload, content script re-injected into open Meet tabs', injected.join() === '7:content.js,8:content.js');

// ---- content.js ----
let present = false, qsCount = 0, observerCb, observerDisconnected = false, sent = [];
const events = () => sent.filter(t => t !== 'meet-heartbeat');
const document = { documentElement: {}, querySelector: () => (qsCount++, present ? {} : null) };
class MutationObserver { constructor(cb) { observerCb = cb; } observe() {} disconnect() { observerDisconnected = true; } }
const chrome = { runtime: { id: 'ext', sendMessage: m => sent.push(m.type) } };
const window = { addEventListener() {} };
vm.runInNewContext(fs.readFileSync(new URL('content.js', EXT), 'utf8'),
  { document, MutationObserver, chrome, window, location: { href: 'x' }, setTimeout, setInterval, clearTimeout, clearInterval, Date });
const burst = async ms => { const end = Date.now() + ms; while (Date.now() < end) { observerCb(); await sleep(5); } };

qsCount = 0; await burst(1000);
check(`mutation burst throttled (${qsCount} DOM checks in 1s of mutations every 5ms)`, qsCount <= 6);
present = true; await burst(1500); present = false; await burst(500);
check('1.5s flicker of the button does NOT count as a join', events().length === 0);
present = true; await burst(2000);
check('not joined before 3s stable', events().length === 0);
await sleep(2000);
check('joined after button stable 3s', events().join() === 'meet-join');
present = false; observerCb(); await sleep(900);
check('not left before 1s gone', events().join() === 'meet-join');
await sleep(600);
check('leave reported ~1s after button gone', events().join() === 'meet-join,meet-leave');

// heartbeats: sent every 5s only while in a call
present = true; observerCb(); await sleep(3500); sent.length = 0;
await sleep(5200);
check('heartbeat sent while in call', sent.includes('meet-heartbeat'));
present = false; observerCb(); await sleep(1500); sent.length = 0;
await sleep(5200);
check('no heartbeat after leaving', !sent.includes('meet-heartbeat'));

// orphaned by an extension reload: script shuts itself down
present = true; observerCb(); await sleep(3500);
delete chrome.runtime.id; sent.length = 0;
await sleep(5200);
check('orphaned script stops itself instead of failing silently forever', observerDisconnected && sent.length === 0);

console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
