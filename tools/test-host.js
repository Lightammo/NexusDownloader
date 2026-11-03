#!/usr/bin/env node
'use strict';

/**
 * Speaks the Chrome native-messaging protocol to the host, without a browser.
 *
 * Usage:
 *   node tools/test-host.js ping
 *   node tools/test-host.js download "https://example.com/file.zip" file.zip
 *   node tools/test-host.js download ... --exe      # test NexusHost.exe launcher
 *   node tools/test-host.js ping --exe
 *
 * Set NEXUS_HOST_ALLOW_ANY=1 to bypass the host allow-list for a public test URL.
 */

const path = require('path');
const { spawn } = require('child_process');

const hostDir = path.join(__dirname, '..', 'native-host');
const hostExe = process.env.NEXUS_HOST_EXE || path.join(hostDir, 'NexusHost.exe');
const hostJs = path.join(hostDir, 'host.js');

const argv = process.argv.slice(2);
const useExe = argv.includes('--exe');
const args = argv.filter((a) => a !== '--exe');
const command = args[0];

function frame(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function runHost(message) {
  return new Promise((resolve, reject) => {
    const child = useExe
      ? spawn(hostExe, [], { cwd: hostDir, stdio: ['pipe', 'pipe', 'inherit'] })
      : spawn(process.execPath, [hostJs], { cwd: hostDir, stdio: ['pipe', 'pipe', 'inherit'] });

    let buffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('timeout waiting for native host response'));
    }, 20000);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;

      const payload = buffer.subarray(4, 4 + length).toString('utf8');
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(payload));
      } catch (err) {
        reject(new Error('invalid JSON from host: ' + err.message));
      }
      // Do not kill the host: let it finish its IDM hand-off naturally.
      child.unref();
    });

    child.stdin.write(frame(message));
    child.stdin.end();
  });
}

async function main() {
  let message;

  if (command === 'ping') {
    message = { type: 'ping' };
  } else if (command === 'download') {
    const url = args[1];
    const filename = args[2] || '';
    if (!url) {
      console.error('usage: node tools/test-host.js download <url> [filename] [--exe]');
      process.exit(2);
    }
    message = { type: 'download', url, filename, source: 'cli-test' };
  } else if (command === 'openFolder') {
    message = { type: 'openFolder' };
  } else {
    console.error('usage: node tools/test-host.js <ping|download|openFolder> [...] [--exe]');
    process.exit(2);
  }

  const response = await runHost(message);
  console.log(JSON.stringify(response, null, 2));
  process.exit(response && response.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR: ' + err.message);
  process.exit(1);
});
