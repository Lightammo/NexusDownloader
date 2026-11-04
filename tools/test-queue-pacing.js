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

test('defaults mirror the bypass pacing numbers', () => {
  assert.equal(P.DEFAULTS.minGapMs, 2000);
  assert.equal(P.DEFAULTS.pauseSeconds, 5);
  assert.equal(P.DEFAULTS.assumedSpeedMBps, 3.2);
  assert.equal(P.DEFAULTS.maxPauseMs, 180000);
  assert.equal(P.DEFAULTS.rateLimitBaseSeconds, 30);
  assert.equal(P.DEFAULTS.rateLimitMaxSeconds, 600);
});

test('small files just take the extra pause', () => {
  const ms = P.computePauseMs(138);
  assert.ok(ms >= 5000 && ms < 5200, 'got ' + ms);
});

test('bigger files add their estimated transfer time', () => {
  // 100 MB at 3.2 MB/s = 31.25 s, plus 5 s.
  const ms = P.computePauseMs(100 * 1024);
  assert.ok(ms >= 36000 && ms <= 36500, 'got ' + ms);
});

test('a huge file is capped at maxPauseMs', () => {
  const ms = P.computePauseMs(10 * 1024 * 1024);
  assert.equal(ms, 180000);
});

test('unknown size only waits the floor + pause', () => {
  assert.equal(P.computePauseMs(0), 5000);
  assert.equal(P.computePauseMs(undefined), 5000);
});

test('a hidden tab slows the queue down', () => {
  const visible = P.computePauseMs(138);
  const hidden = P.computePauseMs(138, { hidden: true });
  assert.equal(hidden, visible * 3);
});

test('pause is never below the hard floor', () => {
  const ms = P.computePauseMs(10, { pauseSeconds: 0 });
  assert.equal(ms, 2000);
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

test('diskWaitMs watches for about three pauses, capped', () => {
  assert.equal(P.diskWaitMs(5000), 15000);
  assert.equal(P.diskWaitMs(20000), 60000, '3x the pause');
  assert.equal(P.diskWaitMs(100000), 180000, 'capped at maxDiskWaitMs');
});

test('nextStrike is capped at rateLimitMaxStrikes', () => {
  assert.equal(P.nextStrike(0), 1);
  assert.equal(P.nextStrike(5), 6);
  assert.equal(P.nextStrike(6), 6);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
