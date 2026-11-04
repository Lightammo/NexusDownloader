#!/usr/bin/env node
'use strict';

/**
 * Unit tests for extension/lib/queue-pacing.js (no browser required).
 *
 *   node tools/test-queue-pacing.js
 */

const assert = require('node:assert/strict');
const P = require('../extension/lib/queue-pacing.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    console.error('     ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

test('defaults are a plain interval plus a concurrency cap', () => {
  assert.equal(P.DEFAULTS.gapSeconds, 5);
  assert.equal(P.DEFAULTS.minGapMs, 2000);
  assert.equal(P.DEFAULTS.maxConcurrent, 2);
  assert.equal('assumedSpeedMBps' in P.DEFAULTS, false, 'no speed estimate anymore');
});

test('the gap is exactly the configured number of seconds', () => {
  assert.equal(P.computeGapMs({}), 5000);
  assert.equal(P.computeGapMs({ gapSeconds: 0 }), 2000, 'never below the 2s floor');
  assert.equal(P.computeGapMs({ gapSeconds: 3 }), 3000);
  assert.equal(P.computeGapMs({ gapSeconds: 12.5 }), 12500);
  assert.equal(P.computeGapMs({ gapSeconds: '8' }), 8000);
});

test('the gap is capped and slowed down in a hidden tab', () => {
  assert.equal(P.computeGapMs({ gapSeconds: 99999 }), P.DEFAULTS.maxGapMs);
  assert.equal(P.computeGapMs({ gapSeconds: 5, hidden: true }), 15000);
});

test('a file only gets the short fast-path watch', () => {
  assert.equal(P.diskWaitMs({}), 8000);
  assert.equal(P.diskWaitMs({ fastDiskWaitMs: 500 }), 1000, 'never below 1s');
});

test('concurrency is clamped to 1..5', () => {
  assert.equal(P.normalizeConcurrent(0), 1);
  assert.equal(P.normalizeConcurrent(1), 1);
  assert.equal(P.normalizeConcurrent(3), 3);
  assert.equal(P.normalizeConcurrent('2'), 2);
  assert.equal(P.normalizeConcurrent(99), 5);
  assert.equal(P.normalizeConcurrent('abc'), 1);
});

test('retryDelayMs uses equal jitter and a 30s ceiling', () => {
  const zero = () => 0;
  assert.equal(P.retryDelayMs(1, {}, zero), 750);
  assert.equal(P.retryDelayMs(2, {}, zero), 1500);
  assert.equal(P.retryDelayMs(3, {}, zero), 3000);
  assert.equal(P.retryDelayMs(9, {}, zero), 15000);
});

test('parseRetryAfterSeconds handles seconds and HTTP dates', () => {
  assert.equal(P.parseRetryAfterSeconds('60'), 60);
  assert.equal(P.parseRetryAfterSeconds('0'), 0);
  assert.equal(P.parseRetryAfterSeconds(''), 0);
  const now = Date.parse('2026-11-04T10:00:00Z');
  const header = new Date(now + 90000).toUTCString();
  assert.equal(P.parseRetryAfterSeconds(header, now), 90);
});

test('nextCooldown prefers Retry-After and never shortens it', () => {
  const now = 1000000;
  const explicit = P.nextCooldown(0, 1, 120, {}, now);
  assert.equal(explicit.until, now + 120000);
  assert.equal(explicit.seconds, 120);

  const previous = now + 300000;
  const later = P.nextCooldown(previous, 2, 60, {}, now);
  assert.equal(later.until, previous, 'the later cooldown wins');
});

test('nextCooldown backs off exponentially without a header', () => {
  const now = 0;
  assert.equal(P.nextCooldown(0, 1, 0, {}, now).seconds, 30);
  assert.equal(P.nextCooldown(0, 2, 0, {}, now).seconds, 60);
  assert.equal(P.nextCooldown(0, 3, 0, {}, now).seconds, 120);
  assert.equal(P.nextCooldown(0, 9, 0, {}, now).seconds, 600, 'capped at 10 minutes');
});

test('cooldownSecondsLeft rounds up and never goes negative', () => {
  assert.equal(P.cooldownSecondsLeft(10000, 1000), 9);
  assert.equal(P.cooldownSecondsLeft(1000, 10000), 0);
  assert.equal(P.cooldownSecondsLeft(0, 0), 0);
});

test('nextStrike is capped at rateLimitMaxStrikes', () => {
  assert.equal(P.nextStrike(0), 1);
  assert.equal(P.nextStrike(5), 6);
  assert.equal(P.nextStrike(6), 6);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
