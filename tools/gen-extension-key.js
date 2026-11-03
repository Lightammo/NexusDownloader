#!/usr/bin/env node
'use strict';

/**
 * Generates a stable RSA key for the unpacked extension and writes it into
 * extension/manifest.json as "key". Chrome derives the extension id from this
 * key, so the id stays the same across reloads and machines.
 *
 * Usage:
 *   node tools/gen-extension-key.js          # create key if missing
 *   node tools/gen-extension-key.js --force  # rotate key (changes extension id)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const manifestPath = path.join(__dirname, '..', 'extension', 'manifest.json');
const force = process.argv.includes('--force');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function extensionIdFromDer(der) {
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

if (manifest.key && !force) {
  const der = Buffer.from(manifest.key, 'base64');
  console.log('key already present');
  console.log('extension id: ' + extensionIdFromDer(der));
  process.exit(0);
}

const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' }
});

manifest.key = publicKey.toString('base64');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('wrote ' + manifestPath);
console.log('extension id: ' + extensionIdFromDer(publicKey));
