#!/usr/bin/env node
'use strict';

/**
 * Unit tests for extension/lib/challenge-utils.js (no browser required).
 *
 *   node tools/test-challenge-utils.js
 */

const assert = require('node:assert/strict');
const C = require('../extension/lib/challenge-utils.js');

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

const AUTO = C.DEFAULT_AUTO_WAIT_MS;

test('challenge titles are recognised in English and Chinese', () => {
  assert.equal(C.isChallengeTitle('Just a moment...'), true);
  assert.equal(C.isChallengeTitle('Attention Required! | Cloudflare'), true);
  assert.equal(C.isChallengeTitle('请稍候…'), true);
  assert.equal(C.isChallengeTitle('Clarity at Monster Hunter World'), false);
  assert.equal(C.isChallengeTitle(''), false);
});

test('only https nexusmods.com URLs are considered Nexus pages', () => {
  assert.equal(C.isNexusUrl('https://www.nexusmods.com/monsterhunterworld/mods/3004'), true);
  assert.equal(C.isNexusUrl('https://nexusmods.com/'), true);
  assert.equal(C.isNexusUrl('http://www.nexusmods.com/'), false);
  assert.equal(C.isNexusUrl('https://evilnexusmods.com/'), false);
  assert.equal(C.isNexusUrl('https://challenges.cloudflare.com/'), false);
});

test('an incomplete tab is loading, not clear', () => {
  const v = C.tabState({
    tab: { id: 1, status: 'loading', url: 'https://www.nexusmods.com/x' },
    probe: null,
    elapsedMs: 9000
  });
  assert.deepEqual(v, { state: 'loading', escalate: false });
});

test('a challenge probe is a challenge without escalation until the wait passes', () => {
  const tab = { id: 1, status: 'complete', url: 'https://www.nexusmods.com/x' };
  const probe = { ok: true, challenge: true, href: 'https://www.nexusmods.com/x' };
  assert.deepEqual(C.tabState({ tab, probe, elapsedMs: 1000, autoWaitMs: AUTO }), {
    state: 'challenge',
    escalate: false
  });
  assert.deepEqual(C.tabState({ tab, probe, elapsedMs: AUTO, autoWaitMs: AUTO }), {
    state: 'challenge',
    escalate: true
  });
});

test('a turnstile iframe alone is enough to call it a challenge', () => {
  const v = C.tabState({
    tab: { id: 1, status: 'complete', url: 'https://www.nexusmods.com/x' },
    probe: { ok: true, challenge: false, turnstile: true, href: 'https://www.nexusmods.com/x' },
    elapsedMs: 2000
  });
  assert.equal(v.state, 'challenge');
});

test('a clean probe on a Nexus page is clear', () => {
  const v = C.tabState({
    tab: { id: 1, status: 'complete', url: 'https://www.nexusmods.com/x' },
    probe: { ok: true, challenge: false, turnstile: false, readyState: 'complete', href: 'https://www.nexusmods.com/x' },
    elapsedMs: 1000
  });
  assert.deepEqual(v, { state: 'clear', escalate: false });
});

test('a failed probe falls back to the tab title and URL', () => {
  const challenge = C.tabState({
    tab: { id: 1, status: 'complete', title: 'Just a moment...', url: 'https://www.nexusmods.com/x' },
    probe: null,
    elapsedMs: AUTO
  });
  assert.deepEqual(challenge, { state: 'challenge', escalate: true });

  const clear = C.tabState({
    tab: { id: 1, status: 'complete', title: 'Clarity at Monster Hunter World', url: 'https://www.nexusmods.com/x' },
    probe: null,
    elapsedMs: 2000
  });
  assert.deepEqual(clear, { state: 'clear', escalate: false });

  const unknown = C.tabState({
    tab: { id: 1, status: 'complete', title: '', url: 'https://challenges.cloudflare.com/x' },
    probe: null,
    elapsedMs: 2000
  });
  assert.deepEqual(unknown, { state: 'unknown', escalate: false });
});

test('an error page or a closed tab is not retried forever', () => {
  assert.deepEqual(
    C.tabState({ tab: { id: 1, status: 'complete', url: 'chrome-error://chromewebdata/' }, elapsedMs: 1000 }),
    { state: 'error', escalate: false }
  );
  assert.deepEqual(C.tabState({ tab: null, elapsedMs: 1000 }), { state: 'gone', escalate: false });
});

test('warm-up only matters for a batch of five or more', () => {
  assert.equal(C.shouldWarmUp(1, true), false);
  assert.equal(C.shouldWarmUp(4, true), false);
  assert.equal(C.shouldWarmUp(5, true), true);
  assert.equal(C.shouldWarmUp(100, false), false, 'explicitly disabled');
  assert.equal(C.shouldWarmUp(100, true), true);
});

test('polling is a little faster while a page is loading', () => {
  assert.equal(C.pollDelayMs('loading'), 700);
  assert.equal(C.pollDelayMs('challenge'), 1000);
  assert.equal(C.pollDelayMs('clear'), 1000);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
