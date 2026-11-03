#!/usr/bin/env node
'use strict';

/**
 * Unit tests for extension/lib/nexus-utils.js (no browser required).
 *
 *   node tools/test-nexus-utils.js
 */

const assert = require('node:assert/strict');
const U = require('../extension/lib/nexus-utils.js');

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

test('digits accepts only positive integer strings', () => {
  assert.equal(U.digits('123'), '123');
  assert.equal(U.digits(123), '123');
  assert.equal(U.digits('abc'), '');
  assert.equal(U.digits('12a'), '');
  assert.equal(U.digits(null), '');
});

test('normalizeFileId unwraps a Nexus uid', () => {
  assert.equal(U.normalizeFileId('33114'), '33114');
  assert.equal(U.normalizeFileId(String(2 ** 32 + 33114)), '33114');
  assert.equal(U.normalizeFileId('abc'), '');
  assert.equal(U.normalizeFileId('0'), '');
});

test('fileIdFromHref reads file_id / id / fid and /files/ paths', () => {
  assert.equal(
    U.fileIdFromHref('https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=49837'),
    '49837'
  );
  assert.equal(
    U.fileIdFromHref('https://www.nexusmods.com/Core/Libs/Common/Widgets/ModRequirementsPopUp?id=51105&game_id=1303'),
    '51105'
  );
  assert.equal(U.fileIdFromHref('https://www.nexusmods.com/skyrim/mods/100/files/5000'), '5000');
  assert.equal(U.fileIdFromHref('/skyrim/mods/100?tab=files&file_id=42'), '42');
  assert.equal(U.fileIdFromHref('/api/files/' + String(2 ** 32 + 5000) + '/download'), '5000');
  assert.equal(U.fileIdFromHref(''), '');
});

test('gameDomainFromPath supports legacy and /games/ URLs', () => {
  assert.equal(U.gameDomainFromPath('/skyrimspecialedition/mods/12604'), 'skyrimspecialedition');
  assert.equal(U.gameDomainFromPath('/games/stardewvalley/mods/1105'), 'stardewvalley');
  assert.equal(U.gameDomainFromPath('/mods/1105'), '');
  assert.equal(U.gameDomainFromPath('/'), '');
});

test('classifyDownloadLabel separates manual, slow, fast and manager buttons', () => {
  assert.equal(U.classifyDownloadLabel('Manual download'), 'manual');
  assert.equal(U.classifyDownloadLabel('MANUAL DOWNLOAD'), 'manual');
  assert.equal(U.classifyDownloadLabel('Slow download'), 'slow');
  assert.equal(U.classifyDownloadLabel('Fast download'), 'fast');
  assert.equal(U.classifyDownloadLabel('Download with Vortex'), 'manager');
  assert.equal(U.classifyDownloadLabel('Mod manager download'), 'manager');
  assert.equal(U.classifyDownloadLabel('Download'), 'download');
  assert.equal(U.classifyDownloadLabel('View file contents'), '');
  assert.equal(U.classifyDownloadLabel(''), '');
});

test('isDirectCdnUrl only accepts Nexus CDN hosts', () => {
  assert.equal(U.isDirectCdnUrl('https://files.nexus-cdn.com/3b/f2/x?md5=a&expires=1'), true);
  assert.equal(U.isDirectCdnUrl('https://cf-files.nexusmods.com/cdn/123/x.zip'), true);
  assert.equal(U.isDirectCdnUrl('https://www.nexusmods.com/skyrim/mods/1?tab=files'), false);
  assert.equal(U.isDirectCdnUrl('nxm://skyrim/mods/1/files/2'), false);
  assert.equal(U.isDirectCdnUrl('not a url'), false);
});

test('parseDownloadUrlResponse handles JSON, arrays and escaped entities', () => {
  assert.equal(
    U.parseDownloadUrlResponse('{"url":"https://files.nexus-cdn.com/a.zip?key=1&amp;expires=2"}'),
    'https://files.nexus-cdn.com/a.zip?key=1&expires=2'
  );
  assert.equal(
    U.parseDownloadUrlResponse('[{"downloadUrl":"https:\\/\\/files.nexus-cdn.com\\/b.zip?key=3"}]'),
    'https://files.nexus-cdn.com/b.zip?key=3'
  );
  assert.equal(
    U.parseDownloadUrlResponse('{"data":{"downloadUrl":"https://files.nexus-cdn.com/c.zip"}}'),
    'https://files.nexus-cdn.com/c.zip'
  );
});

test('parseDownloadUrlResponse handles Nexus widget HTML', () => {
  assert.equal(
    U.parseDownloadUrlResponse(
      '<a id="slowDownloadButton" data-download-url="https://files.nexus-cdn.com/x/mod.zip?key=k&amp;expires=1">Slow</a>'
    ),
    'https://files.nexus-cdn.com/x/mod.zip?key=k&expires=1'
  );
  assert.equal(
    U.parseDownloadUrlResponse('<input id="dl_link" value="https://files.nexus-cdn.com/y/mod.zip?key=q">'),
    'https://files.nexus-cdn.com/y/mod.zip?key=q'
  );
  assert.equal(
    U.parseDownloadUrlResponse('<input value="https://files.nexus-cdn.com/z/mod.zip?key=r" id="dl_link">'),
    'https://files.nexus-cdn.com/z/mod.zip?key=r'
  );
});

test('parseDownloadUrlResponse rejects nxm:// links and empty HTML', () => {
  assert.equal(
    U.parseDownloadUrlResponse('nxm://skyrim/mods/100/files/200?key=abc&expires=1700000000'),
    ''
  );
  assert.equal(U.parseDownloadUrlResponse('<html><body>Nothing here</body></html>'), '');
  assert.equal(U.parseDownloadUrlResponse(''), '');
});

test('parseDownloadUrlFromPageHtml reads mod-file-download attributes', () => {
  assert.equal(
    U.parseDownloadUrlFromPageHtml(
      '<mod-file-download download-url="https://files.nexus-cdn.com/x.zip?key=1"></mod-file-download>'
    ),
    'https://files.nexus-cdn.com/x.zip?key=1'
  );
  assert.equal(
    U.parseDownloadUrlFromPageHtml(
      '<mod-file-download file="{&quot;id&quot;:33114,&quot;downloadUrl&quot;:&quot;https://files.nexus-cdn.com/y.zip?key=2&quot;}"></mod-file-download>'
    ),
    'https://files.nexus-cdn.com/y.zip?key=2'
  );
  assert.equal(
    U.parseDownloadUrlFromPageHtml('<mod-file-download download-url="/api/files/123/download"></mod-file-download>'),
    '/api/files/123/download'
  );
});

test('isNexusApiFileRoute recognizes /api/files uid routes', () => {
  assert.equal(U.isNexusApiFileRoute('/api/files/10870565002578/download'), true);
  assert.equal(U.isNexusApiFileRoute('https://www.nexusmods.com/api/files/123'), true);
  assert.equal(U.isNexusApiFileRoute('https://www.nexusmods.com/skyrim/mods/1'), false);
});

test('describeResponseError extracts JSON message and detects Cloudflare', () => {
  assert.equal(U.describeResponseError('{"error":"You must wait"}', 403), 'You must wait');
  assert.match(U.describeResponseError('<html><title>Just a moment...</title></html>', 403), /Cloudflare/);
  assert.match(U.describeResponseError('<b>Slow down</b>', 429), /Slow down/);
});

test('filenameFromPayload prefers the real archive name', () => {
  assert.equal(
    U.filenameFromPayload({ fileName: 'My Mod-1.2.zip', name: 'Main File' }, 'https://files.nexus-cdn.com/uuid'),
    'My Mod-1.2.zip'
  );
  assert.equal(
    U.filenameFromPayload({ name: 'Main File' }, 'https://files.nexus-cdn.com/abc/Real-Name.7z?key=1'),
    'Real-Name.7z'
  );
  assert.equal(U.filenameFromPayload({ name: 'Main File' }, 'https://files.nexus-cdn.com/uuid'), '');
  assert.equal(U.filenameFromPayload(null, 'https://files.nexus-cdn.com/uuid'), '');
});

test('unwrapFilePayload flattens {file:{...}} wrappers and arrays', () => {
  const inner = { id: 5, fileName: 'a.zip' };
  const merged = U.unwrapFilePayload({ file: inner, gameId: 1704 });
  assert.equal(merged.id, '5');
  assert.equal(merged.fileName, 'a.zip');
  assert.equal(merged.gameId, 1704);

  assert.equal(U.unwrapFilePayload({ id: 9 })?.id, 9);
  assert.equal(U.unwrapFilePayload([{ id: 7, fileName: 'b.7z' }])?.id, 7);
  assert.equal(U.unwrapFilePayload([]), null);
});

test('payloadFileId finds ids in wrappers, arrays and uids', () => {
  assert.equal(U.payloadFileId({ file: { id: 123 } }), '123');
  assert.equal(U.payloadFileId([{ fileId: 456 }]), '456');
  assert.equal(U.payloadFileId({ id: 9, file: { file_id: 99 } }), '99');
  assert.equal(U.payloadFileId({ uid: String(2 ** 32 + 33114) }), '33114');
  assert.equal(U.payloadFileId({ name: 'no id' }), '');
});

test('selectPayloadForFile picks the clicked file from a multi-file payload', () => {
  const payload = {
    files: [
      { id: 1, downloadUrl: 'https://files.nexus-cdn.com/one.zip' },
      { id: 2, downloadUrl: 'https://files.nexus-cdn.com/two.zip' }
    ]
  };
  assert.equal(U.selectPayloadForFile(payload, '2').downloadUrl, 'https://files.nexus-cdn.com/two.zip');
  assert.equal(U.selectPayloadForFile(payload, '9'), null);
  assert.equal(U.selectPayloadForFile({ id: 7, downloadUrl: 'https://files.nexus-cdn.com/x.zip' }, '7').downloadUrl,
    'https://files.nexus-cdn.com/x.zip');
});

test('buildGenerateBody uses the numeric game id, not the domain', () => {
  const body = new URLSearchParams(U.buildGenerateBody({ fileId: '49837', gameId: '1704', gameDomain: 'skyrimspecialedition' }));
  assert.equal(body.get('fid'), '49837');
  assert.equal(body.get('game_id'), '1704');
  assert.equal(body.get('game_name'), null);

  const noNumeric = new URLSearchParams(U.buildGenerateBody({ fileId: '1', gameId: 'skyrim', gameDomain: 'skyrim' }));
  assert.equal(noNumeric.get('game_id'), null);
  assert.equal(noNumeric.get('game_name'), 'skyrim');
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures)' : ''));
