'use strict';

/**
 * Nexus Downloader - pure helpers for the Cloudflare recovery flow.
 *
 * The queue never tries to solve a challenge. It opens the file page in a real
 * browser tab and watches that tab: a managed challenge usually clears itself in
 * a few seconds, while an interactive one stays until the user ticks the box.
 * These helpers only decide what the tab currently looks like and when to bring
 * it to the front; the actual page load is done by the browser.
 *
 * Loaded by the content script, the service worker (importScripts) and the
 * unit tests (require). Nothing here touches the DOM or chrome.*.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusChallenge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Cloudflare's interstitial titles in the languages Nexus serves. A matching
  // title alone is not proof (the page could still be loading), so callers also
  // pass the DOM probe when it is available.
  const CHALLENGE_TITLE =
    /just a moment|attention required|checking your browser|verify(?:ing)? you are human|请稍候|正在验证|安全验证/i;

  const NEXUS_URL = /^https:\/\/(?:[a-z0-9-]+\.)*nexusmods\.com\//i;

  const DEFAULT_AUTO_WAIT_MS = 12000;
  const DEFAULT_MANUAL_WAIT_MS = 3 * 60 * 1000;
  const MAX_CHALLENGE_RETRIES = 3;
  const WARMUP_MIN_ITEMS = 5;

  function text(value) {
    return String(value == null ? '' : value);
  }

  function isChallengeTitle(title) {
    return CHALLENGE_TITLE.test(text(title));
  }

  function isNexusUrl(url) {
    return NEXUS_URL.test(text(url));
  }

  function isErrorUrl(url) {
    return /^(?:chrome-error|edge-error|about:neterror):/i.test(text(url));
  }

  /**
   * Turn one tab snapshot plus the optional content-script probe into a small
   * state the queue can branch on.
   *
   * @returns {{state: 'gone'|'error'|'loading'|'challenge'|'clear'|'unknown',
   *            escalate: boolean}}
   *   escalate = the tab has been a challenge/unknown long enough that the user
   *   should see it (and tick the box if Cloudflare asks for one).
   */
  function tabState(input) {
    const opts = input || {};
    const tab = opts.tab || null;
    const probe = opts.probe || null;
    const elapsedMs = Math.max(0, Number(opts.elapsedMs) || 0);
    const autoWaitMs = Math.max(1000, Number(opts.autoWaitMs) || DEFAULT_AUTO_WAIT_MS);

    if (!tab || tab.id == null) return { state: 'gone', escalate: false };

    const url = text(tab.url || tab.pendingUrl);
    if (isErrorUrl(url) || isErrorUrl(tab.pendingUrl)) {
      return { state: 'error', escalate: false };
    }
    if (tab.status && tab.status !== 'complete') {
      return { state: 'loading', escalate: false };
    }

    if (probe && probe.ok) {
      if (probe.challenge || probe.turnstile) {
        return { state: 'challenge', escalate: elapsedMs >= autoWaitMs };
      }
      if (probe.readyState && probe.readyState !== 'complete') {
        return { state: 'loading', escalate: false };
      }
      if (isNexusUrl(probe.href || url)) {
        return { state: 'clear', escalate: false };
      }
      return { state: 'unknown', escalate: elapsedMs >= autoWaitMs };
    }

    // The content script could not answer (still loading, extension reloaded,
    // or a cross-origin challenge page). Fall back to the tab's own metadata.
    if (isChallengeTitle(tab.title)) {
      return { state: 'challenge', escalate: elapsedMs >= autoWaitMs };
    }
    if (tab.status === 'complete' && isNexusUrl(url)) {
      return { state: 'clear', escalate: false };
    }
    return { state: 'unknown', escalate: elapsedMs >= autoWaitMs };
  }

  /** Warm up before a batch only when it is long enough to be worth the tab. */
  function shouldWarmUp(itemCount, enabled) {
    if (enabled === false) return false;
    return Number(itemCount) >= WARMUP_MIN_ITEMS;
  }

  /** Poll interval while a page is loading; 1s once it is settled. */
  function pollDelayMs(state) {
    return state === 'loading' ? 700 : 1000;
  }

  return {
    DEFAULT_AUTO_WAIT_MS,
    DEFAULT_MANUAL_WAIT_MS,
    MAX_CHALLENGE_RETRIES,
    WARMUP_MIN_ITEMS,
    isChallengeTitle,
    isNexusUrl,
    isErrorUrl,
    tabState,
    shouldWarmUp,
    pollDelayMs
  };
});
