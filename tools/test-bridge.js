#!/usr/bin/env node
'use strict';

/**
 * Exercises the local bridge without a browser.
 *
 * Usage:
 *   node tools/test-bridge.js ping
 *   node tools/test-bridge.js download "https://example.com/file.zip" file.zip
 *   node tools/test-bridge.js check "Worldly Improvements [vmu2j4]" a.zip
 *   node tools/test-bridge.js idmHistory
 *   node tools/test-bridge.js openFolder
 *   node tools/test-bridge.js openConfig
 *
 * Set NEXUS_BRIDGE_ALLOW_ANY=1 when the bridge process is started to allow a
 * public test URL that is not in the Nexus allow-list.
 */

const BASE = process.env.NEXUS_BRIDGE_URL || 'http://127.0.0.1:38765';
const command = process.argv[2] || 'ping';

async function request(pathname, body) {
  const options = { method: body ? 'POST' : 'GET', headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(BASE + pathname, options);
  return response.json();
}

async function main() {
  let result;

  if (command === 'ping') {
    result = await request('/ping');
  } else if (command === 'download') {
    const url = process.argv[3];
    const filename = process.argv[4] || '';
    if (!url) {
      console.error('usage: node tools/test-bridge.js download <url> [filename]');
      process.exit(2);
    }
    result = await request('/download', { url, filename, source: 'cli-test' });
  } else if (command === 'openFolder') {
    result = await request('/openFolder', {});
  } else if (command === 'openConfig') {
    result = await request('/openConfig', {});
  } else if (command === 'check') {
    const subdir = process.argv[3] || '';
    const names = process.argv.slice(4);
    if (!names.length) {
      console.error('usage: node tools/test-bridge.js check "<subdir>" file1.zip [file2.zip ...]');
      process.exit(2);
    }
    result = await request('/check', { subdir, names });
  } else if (command === 'idmHistory') {
    result = await request('/idmHistory', { force: true });
  } else {
    console.error('usage: node tools/test-bridge.js <ping|download|check|idmHistory|openFolder|openConfig> [...]');
    process.exit(2);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result && result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('bridge request failed: ' + err.message);
  console.error('is the bridge running? run bridge/start.ps1');
  process.exit(1);
});
