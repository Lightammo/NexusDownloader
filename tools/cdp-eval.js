#!/usr/bin/env node
'use strict';

/**
 * Minimal Chrome DevTools Protocol helper: evaluates a JS expression in the
 * extension popup page (or the first page target) and prints the result.
 *
 * Usage:
 *   node tools/cdp-eval.js "chrome.runtime.sendMessage({type:'nd:ping'})"
 *   CDP_PORT=9224 node tools/cdp-eval.js "..."
 */

const port = process.env.CDP_PORT || '9224';
const expression = process.argv[2];

if (!expression) {
  console.error('usage: node tools/cdp-eval.js "<expression>"');
  process.exit(2);
}

async function main() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json();
  const match = process.env.CDP_URL_MATCH;
  const target = match
    ? targets.find((t) => t.url.includes(match))
    : targets.find((t) => t.url.includes('popup.html')) ||
      targets.find((t) => t.type === 'page');

  if (!target) throw new Error('no debuggable target found');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

  await send('Runtime.enable');
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  console.log(JSON.stringify(result.result, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error('CDP error: ' + err.message);
  process.exit(1);
});
