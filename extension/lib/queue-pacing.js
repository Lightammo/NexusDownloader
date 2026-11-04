'use strict';

/**
 * Nexus Downloader - pacing maths for the Collections queue.
 *
 * Pure functions only: the queue asks these "how long do I wait before the next
 * request", the tests pin the numbers. The defaults mirror what the
 * nexusmods-bypass extension uses for its collection queue (2s floor, 5s extra
 * pause, size/3.2MB/s transfer estimate, 30s->10min shared cooldown, 1.5s->30s
 * retry backoff with equal jitter). We only reuse the behaviour, not its code.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusQueuePacing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    // Hard floor between two requests, even for skipped/failed rows.
    minGapMs: 2000,
    // Extra rest after each hand-off.
    pauseSeconds: 5,
    // Used only to estimate how long a file takes; never throttles IDM.
    assumedSpeedMBps: 3.2,
    // A single pause never exceeds this.
    maxPauseMs: 180000,
    // Hidden tabs get background timer throttling; slow down so the queue does
    // not burst when the tab wakes up.
    hiddenMultiplier: 3,
    // Give up waiting for a file to appear on disk after this.
    maxDiskWaitMs: 180000,
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

  /**
   * How long to wait after handing file N to IDM before asking Nexus for file
   * N+1's link. Small files: the 5s pause. Large files: roughly their transfer
   * time plus the pause, capped so one huge archive cannot stall the queue.
   */
  function computePauseMs(sizeKb, overrides) {
    const o = settings(overrides);
    const kb = Number(sizeKb);
    const megabytes = Number.isFinite(kb) && kb > 0 ? kb / 1024 : 0;
    const speed = Number(o.assumedSpeedMBps) > 0 ? Number(o.assumedSpeedMBps) : DEFAULTS.assumedSpeedMBps;
    const transferMs = (megabytes / speed) * 1000;
    const extraMs = Math.max(0, Number(o.pauseSeconds) || 0) * 1000;
    let pause = clamp(transferMs + extraMs, o.minGapMs, o.maxPauseMs);
    if (o.hidden) pause = Math.min(pause * Math.max(1, o.hiddenMultiplier), o.maxPauseMs * Math.max(1, o.hiddenMultiplier));
    return Math.round(pause);
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

  /** How long to watch the target folder for the file we just handed over. */
  function diskWaitMs(pauseMs, overrides) {
    const o = settings(overrides);
    const pause = Number(pauseMs) > 0 ? Number(pauseMs) : o.minGapMs;
    return Math.round(Math.min(pause * 3, o.maxDiskWaitMs));
  }

  function nextStrike(strike, overrides) {
    const o = settings(overrides);
    return Math.min((Number(strike) || 0) + 1, o.rateLimitMaxStrikes);
  }

  return {
    DEFAULTS,
    settings,
    clamp,
    computePauseMs,
    retryDelayMs,
    parseRetryAfterSeconds,
    nextCooldown,
    cooldownSecondsLeft,
    diskWaitMs,
    nextStrike
  };
});
