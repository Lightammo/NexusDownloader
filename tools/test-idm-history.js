#!/usr/bin/env node
'use strict';

/**
 * Tests for bridge/idm-history.js parsing (no IDM registry access needed).
 *
 *   node tools/test-idm-history.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../bridge/idm-history.js');
const C = require('../extension/lib/collection-utils.js');

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

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'idm-registry-sample.txt'), 'utf8');

test('parseRegOutput reads one record per download key', () => {
  const records = H.parseRegOutput(fixture);
  assert.equal(records.length, 2, 'the empty ChList key and the URL-less key are skipped');

  const first = records[0];
  assert.equal(first.id, '609');
  assert.equal(first.host, 'files.nexus-cdn.com');
  assert.ok(first.url.startsWith('https://files.nexus-cdn.com/'));
  assert.equal(first.finalName, 'Fatalis Adaptive 0.7.4 8923 0.7.5 2026-11-02T07-19Z Fk7FlBpPh.zip');
  assert.equal(first.status, '0x2');
  assert.equal(first.dateAdded, 'Nov 04 02:24:57 2026');
  assert.equal(first.source, 'registry');
});

test('parseRegOutput strips the query string from FileName', () => {
  const records = H.parseRegOutput(fixture);
  assert.equal(records[0].fileName, '3bf25125-617e-4e50-9d29-0cadc27f595d');
  assert.equal(records[1].fileName, "Stracker's Loader-1982-3-0-1-1700072090.zip");
});

test('parseRegOutput survives an empty or missing body', () => {
  assert.deepEqual(H.parseRegOutput(''), []);
  assert.deepEqual(H.parseRegOutput(null), []);
  assert.deepEqual(H.parseRegOutput('garbage\nmore garbage'), []);
});

test('parseLogText extracts the URL and the server file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-log-'));
  const file = path.join(dir, 'log_609.log');
  fs.writeFileSync(
    file,
    [
      'Folder C:\\Users\\Leo\\AppData\\Roaming\\IDM\\DwnlData\\Leo\\files_nexus-cdn_com_609\\ was created.',
      'Windows 10.0',
      'Url https://files.nexus-cdn.com/3b/f2/51/abc?md5=x&h=314931fb',
      'C0:HTTP/1.1 200 OK',
      'C0:Content-Disposition: attachment; filename="Fatalis Adaptive 0.7.4.zip"',
      ''
    ].join('\r\n')
  );
  const record = H.parseLogText(fs.readFileSync(file, 'utf8'), file);
  assert.ok(record);
  assert.equal(record.url, 'https://files.nexus-cdn.com/3b/f2/51/abc?md5=x&h=314931fb');
  assert.equal(record.finalName, 'Fatalis Adaptive 0.7.4.zip');
  assert.equal(record.source, 'log');
  assert.ok(record.at > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseLogText ignores logs without a Url line', () => {
  assert.equal(H.parseLogText('nothing here', 'x.log'), null);
});

test('parseUrlHistory keeps http(s) lines only', () => {
  const records = H.parseUrlHistory(
    ['https://files.nexus-cdn.com/a/b/c.zip', '', 'not a url', 'http://example.com/x', '  https://x/y  '].join('\n')
  );
  assert.equal(records.length, 3);
  assert.equal(records[0].source, 'urlhistory');
  assert.equal(records[2].url, 'https://x/y');
});

test('decodeConsole recovers GBK bytes from the OEM code page', () => {
  // "下载" in GBK
  const gbk = Buffer.from([0xcf, 0xc2, 0xd4, 0xd8]);
  assert.equal(H.decodeConsole(gbk), '下载');
  assert.equal(H.decodeConsole(Buffer.from('plain ascii', 'utf8')), 'plain ascii');
});

test('registry records satisfy the collection dedupe matcher', () => {
  const records = H.parseRegOutput(fixture);
  const stracker = {
    uri: "Stracker's Loader-1982-3-0-1-1700072090.zip",
    fileName: "Stracker's Loader"
  };
  const match = C.matchIdmRecord(stracker, records);
  assert.ok(match, 'the collection file matches the IDM record');
  assert.equal(match.record.id, '610');

  assert.equal(C.matchIdmRecord({ uri: 'never-downloaded.zip' }, records), null);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
