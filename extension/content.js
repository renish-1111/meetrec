// Watches the Meet DOM for the "in call" state and reports join/leave events
// to the background service worker. The "Leave call" (hang up) button only
// exists once you've actually joined a call, not in the pre-join lobby, which
// makes it a reliable signal for both join and leave detection.
(() => {
  const CHECK_INTERVAL_MS = 1000;
  const MUTATION_THROTTLE_MS = 250; // Meet mutates constantly; cap DOM checks
  // A state change must hold this long before it's reported, to ignore DOM
  // flicker. Leaves are reported faster; the bridge's stop delay (and its
  // cancel-on-rejoin) already absorbs a brief false "leave".
  const JOIN_STABLE_MS = 3000;
  const LEAVE_STABLE_MS = 1000;
  // While in a call, re-announce every few seconds. The bridge treats a tab
  // that goes quiet as having left, so a lost "leave" (bridge restarted, this
  // script orphaned by an extension reload) can't leave OBS recording forever.
  const HEARTBEAT_MS = 5000;

  const IN_CALL_SELECTOR = [
    '[aria-label="Leave call"]',
    '[aria-label="Leave call and end meeting"]',
    '[data-tooltip="Leave call"]',
    '[data-tooltip="Leave call and end meeting"]'
  ].join(', ');

  let inCall = false; // last state reported to the background worker
  let observedInCall = false; // latest raw DOM reading
  let observedSince = Date.now();
  let pendingCheck = null;

  function isInCallNow() {
    return document.querySelector(IN_CALL_SELECTOR) !== null;
  }

  function send(type) {
    // After the extension is reloaded, this copy of the script is orphaned and
    // can't reach it anymore. The reloaded extension injects a fresh copy, so
    // this one just shuts down.
    if (!chrome.runtime?.id) return shutDown();
    try {
      chrome.runtime.sendMessage({ type, url: location.href });
    } catch (err) {
      shutDown();
    }
  }

  function tick() {
    const nowInCall = isInCallNow();
    if (nowInCall !== observedInCall) {
      observedInCall = nowInCall;
      observedSince = Date.now();
      // Re-check right when this change becomes stable, not on the next interval.
      if (observedInCall !== inCall) {
        setTimeout(tick, observedInCall ? JOIN_STABLE_MS : LEAVE_STABLE_MS);
      }
    }

    const stableMs = observedInCall ? JOIN_STABLE_MS : LEAVE_STABLE_MS;
    if (observedInCall !== inCall && Date.now() - observedSince >= stableMs) {
      inCall = observedInCall;
      send(inCall ? 'meet-join' : 'meet-leave');
    }
  }

  // Coalesce mutation bursts into at most one check per MUTATION_THROTTLE_MS.
  function scheduleTick() {
    if (pendingCheck) return;
    pendingCheck = setTimeout(() => {
      pendingCheck = null;
      tick();
    }, MUTATION_THROTTLE_MS);
  }

  const observer = new MutationObserver(scheduleTick);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const checkInterval = setInterval(tick, CHECK_INTERVAL_MS);
  const heartbeatInterval = setInterval(() => {
    if (inCall) send('meet-heartbeat');
  }, HEARTBEAT_MS);

  function shutDown() {
    observer.disconnect();
    clearInterval(checkInterval);
    clearInterval(heartbeatInterval);
    clearTimeout(pendingCheck);
  }

  window.addEventListener('beforeunload', () => {
    if (inCall) send('meet-leave');
  });

  tick();
})();
