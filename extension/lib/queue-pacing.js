'use strict';

/**
 * Nexus Downloader - pacing maths for the Collections queue.
 *
 * Pure functions only. The queue asks "how long until the next hand-off" and
 * "how many files may be in flight at once"; the tests pin the numbers.
 *
 * Deliberately no size/speed estimate: a collection archive's transfer time
 * depends on the connection, IDM's queue and the CDN, so guessing it produced
 * both meaningless settings and wrong "still downloading" judgements. The
 * dispatch interval is a plain number of seconds, and completion is decided by
 * the file appearing on disk (see collection.js), not by a timer.
 *
 * Rate-limit and retry numbers still mirror the nexusmods-bypass queue (30s ->
 * 10min shared cooldown, 1.5s -> 30s retry with equal jitter): we reuse the
 * behaviour, not its code.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusQueuePacing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    // Interval between two hand-offs, in seconds. 0 means "as fast as the
    // concurrency limit allows", but never below minGapMs.
    gapSeconds: 5,
    // Hard floor between two hand-offs.
    minGapMs: 2000,
    maxGapMs: 10 * 60 * 1000,
    // Hidden tabs get background timer throttling; space hand-offs out more so
    // the queue does not burst when the tab wakes up.
    hiddenMultiplier: 3,
    // How many files may be handed to IDM but not seen on disk yet.
    maxConcurrent: 2,
    minConcurrent: 1,
    maxConcurrentLimit: 5,
    // Fast path after a hand-off: watch the folder briefly for the file, then
    // leave the rest to the reconciler.
    fastDiskWaitMs: 8000,
    // Exponential backoff for a single file.
    retryBaseMs: 1500,
    retryMaxMs: 30000,
    retryAttempts: 3,
    // Shared rate-limit cooldown.
    rateLimitBaseSeconds: 30,
    rateLimitMaxSeconds: 600,
    rateLimitMaxStrikes: 6
  });

  function settings(overrides) {
    return Object.assign({}, DEFAULTS, overrides || {});
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
  }

  /** Interval before the next hand-off. */
  function computeGapMs(overrides) {
    const o = settings(overrides);
    const seconds = Number(o.gapSeconds);
    const base = clamp((Number.isFinite(seconds) ? seconds : DEFAULTS.gapSeconds) * 1000, o.minGapMs, o.maxGapMs);
    if (!o.hidden) return Math.round(base);
    return Math.round(Math.min(base * Math.max(1, o.hiddenMultiplier), o.maxGapMs * Math.max(1, o.hiddenMultiplier)));
  }

  /** How long the queue waits for a just-handed file before moving on. */
  function diskWaitMs(overrides) {
    const o = settings(overrides);
    return Math.round(clamp(o.fastDiskWaitMs, 1000, o.maxGapMs));
  }

  /** Keep the concurrency setting in a sane range. */
  function normalizeConcurrent(value) {
    return Math.round(clamp(value, DEFAULTS.minConcurrent, DEFAULTS.maxConcurrentLimit));
  }

  /** Exponential backoff with equal jitter, so tabs do not retry in lockstep. */
  function retryDelayMs(attempt, overrides, random) {
    const o = settings(overrides);
    const step = Math.max(0, (Number(attempt) || 1) - 1);
    const ceiling = Math.min(o.retryBaseMs * Math.pow(2, step), o.retryMaxMs);
    const rnd = typeof random === 'function' ? random : Math.random;
    return Math.round(ceiling / 2 + rnd() * (ceiling / 2));
  }

  function parseRetryAfterSeconds(header, nowMs) {
    const raw = String(header === null || header === undefined ? '' : header).trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return 0;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    return Math.max(0, Math.round((at - now) / 1000));
  }

  /**
   * The cooldown every queue in every tab shares. `Retry-After` wins and is
   * never shortened; our own backoff only applies when the server did not say.
   */
  function nextCooldown(previousUntil, strike, headerSeconds, overrides, nowMs) {
    const o = settings(overrides);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const explicit = Number(headerSeconds);
    let seconds;
    if (Number.isFinite(explicit) && explicit > 0) {
      seconds = explicit;
    } else {
      const step = Math.max(0, (Number(strike) || 1) - 1);
      seconds = Math.min(o.rateLimitBaseSeconds * Math.pow(2, step), o.rateLimitMaxSeconds);
    }
    const until = Math.max(Number(previousUntil) || 0, now + seconds * 1000);
    return { until, seconds: Math.max(0, Math.round((until - now) / 1000)) };
  }

  function cooldownSecondsLeft(until, nowMs) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    return Math.max(0, Math.ceil(((Number(until) || 0) - now) / 1000));
  }

  function nextStrike(strike, overrides) {
    const o = settings(overrides);
    return Math.min((Number(strike) || 0) + 1, o.rateLimitMaxStrikes);
  }

  return {
    DEFAULTS,
    settings,
    clamp,
    computeGapMs,
    diskWaitMs,
    normalizeConcurrent,
    retryDelayMs,
    parseRetryAfterSeconds,
    nextCooldown,
    cooldownSecondsLeft,
    nextStrike
  };
});
