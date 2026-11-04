#!/usr/bin/env node
'use strict';

/**
 * Unit tests for extension/lib/collection-utils.js (no browser required).
 *
 *   node tools/test-collection-utils.js
 */

const assert = require('node:assert/strict');
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

// ---------------------------------------------------------------------------
// collection page parsing
// ---------------------------------------------------------------------------

test('parseCollectionPath reads /games/<game>/collections/<slug>', () => {
  const info = C.parseCollectionPath('/games/monsterhunterworld/collections/vmu2j4', '');
  assert.deepEqual(info, { gameDomain: 'monsterhunterworld', slug: 'vmu2j4', revision: 0 });
});

test('parseCollectionPath reads an explicit revision', () => {
  const info = C.parseCollectionPath('/games/skyrimspecialedition/collections/9zfscf/revisions/121', '');
  assert.equal(info.gameDomain, 'skyrimspecialedition');
  assert.equal(info.slug, '9zfscf');
  assert.equal(info.revision, 121);
});

test('parseCollectionPath falls back to ?revision=', () => {
  const info = C.parseCollectionPath('/games/skyrimspecialedition/collections/9zfscf', '?revision=7');
  assert.equal(info.revision, 7);
});

test('parseCollectionPath supports the legacy /<game>/collections/<slug> route', () => {
  const info = C.parseCollectionPath('/fallout4/collections/abc123', '');
  assert.equal(info.gameDomain, 'fallout4');
  assert.equal(info.slug, 'abc123');
});

test('parseCollectionPath rejects non-collection pages', () => {
  assert.equal(C.parseCollectionPath('/monsterhunterworld/mods/3004', ''), null);
  assert.equal(C.parseCollectionPath('/games/monsterhunterworld/collections', ''), null);
  assert.equal(C.parseCollectionPath('/', ''), null);
  assert.equal(C.parseCollectionPath('/games/x/collections/a/b/c', ''), null);
});

test('collectionPageUrl and modFilePageUrl rebuild usable links', () => {
  assert.equal(
    C.collectionPageUrl({ gameDomain: 'monsterhunterworld', slug: 'vmu2j4' }),
    'https://www.nexusmods.com/games/monsterhunterworld/collections/vmu2j4'
  );
  assert.equal(
    C.modFilePageUrl({ gameDomain: 'monsterhunterworld', modId: '3004', fileId: '20215' }),
    'https://www.nexusmods.com/monsterhunterworld/mods/3004?tab=files&file_id=20215'
  );
  assert.equal(C.modFilePageUrl({ gameDomain: '', modId: '3004' }), '');
});

// ---------------------------------------------------------------------------
// Windows naming
// ---------------------------------------------------------------------------

test('sanitizeSegment replaces illegal characters and trims dots', () => {
  assert.equal(C.sanitizeSegment('Clarity 1.7'), 'Clarity 1.7');
  assert.equal(C.sanitizeSegment('a/b:c*d?"e<f>g|h'), 'a_b_c_d__e_f_g_h');
  assert.equal(C.sanitizeSegment('   name.  '), 'name');
  assert.equal(C.sanitizeSegment(''), '_');
});

test('sanitizeSegment protects reserved device names', () => {
  assert.equal(C.sanitizeSegment('CON'), '_CON');
  assert.equal(C.sanitizeSegment('lpt1'), '_lpt1');
  assert.equal(C.sanitizeSegment('conifer'), 'conifer');
});

test('sanitizeFilename keeps the extension when shortening', () => {
  const long = 'x'.repeat(300) + '.zip';
  const out = C.sanitizeFilename(long, 60);
  assert.equal(out.length, 60);
  assert.ok(out.endsWith('.zip'));
  assert.equal(C.sanitizeFilename('bad:name.rar'), 'bad_name.rar');
  assert.equal(C.sanitizeFilename(''), '');
});

test('collectionFolderName appends the slug by default', () => {
  assert.equal(
    C.collectionFolderName({ name: 'Worldly Improvements', slug: 'vmu2j4' }),
    'Worldly Improvements [vmu2j4]'
  );
  assert.equal(
    C.collectionFolderName({ name: 'Worldly Improvements', slug: 'vmu2j4' }, { suffix: false }),
    'Worldly Improvements'
  );
  assert.equal(C.collectionFolderName({ name: 'A/B:C', slug: 'x1' }), 'A_B_C [x1]');
});

test('withSuffix produces (2), (3) renames instead of overwriting', () => {
  assert.equal(C.withSuffix('Clarity 1.7-3004-1-7.rar', 2), 'Clarity 1.7-3004-1-7 (2).rar');
  assert.equal(C.withSuffix('archive.zip', 1), 'archive.zip');
  assert.equal(C.withSuffix('noext', 3), 'noext (3)');
});

test('formatSize is human readable', () => {
  assert.equal(C.formatSize(0), '—');
  assert.equal(C.formatSize(512), '512 B');
  assert.equal(C.formatSize(141761), '138 KB');
  assert.equal(C.formatSize(1024 * 1024 * 3.5), '3.5 MB');
});

// ---------------------------------------------------------------------------
// GraphQL normalisation
// ---------------------------------------------------------------------------

function samplePayload() {
  return {
    collection: {
      id: '277',
      slug: 'vmu2j4',
      name: 'Worldly Improvements',
      collectionStatus: 'listed',
      gameId: '2531',
      game: { domainName: 'monsterhunterworld', id: '2531' }
    },
    revision: {
      id: '184543',
      revisionNumber: 2,
      modCount: 5,
      totalSize: '748697',
      status: 'published',
      adultContent: false,
      modFiles: [
        {
          optional: false,
          fileId: 20215,
          version: '1.7',
          updatePolicy: 'prefer',
          file: {
            fileId: 20215,
            modId: 3004,
            name: 'Clarity 1.7',
            version: '1.7',
            size: 138,
            sizeInBytes: '141761',
            uri: 'Clarity 1.7-3004-1-7-1608607481.rar',
            category: 'OLD_VERSION',
            mod: { modId: 3004, name: 'Clarity - More details for skills and items.', author: 'Avatoxico', status: 'published' }
          }
        },
        {
          optional: true,
          fileId: 17858,
          version: '1.4',
          file: {
            fileId: 17858,
            modId: 3474,
            name: 'Fatalis Patch',
            size: 36,
            sizeInBytes: null,
            uri: 'Fatalis Patch-3474-1-4-1601540952.zip',
            category: 'MAIN',
            mod: { modId: 3474, name: 'Tic Rate Fix', author: 'AsteriskAmpersand', status: 'published' }
          }
        },
        {
          optional: false,
          fileId: 999,
          file: {
            fileId: 999,
            modId: 8888,
            name: 'Gone',
            size: 10,
            uri: 'Gone-8888-1-0.zip',
            category: 'REMOVED',
            mod: { modId: 8888, name: 'Removed mod', status: 'published' }
          }
        },
        {
          optional: false,
          fileId: 777,
          file: null
        }
      ]
    }
  };
}

test('normalizeCollectionRevision flattens the rows the panel needs', () => {
  const out = C.normalizeCollectionRevision(samplePayload(), { gameDomain: 'monsterhunterworld' });
  assert.equal(out.ok, true);
  assert.equal(out.meta.name, 'Worldly Improvements');
  assert.equal(out.meta.gameDomain, 'monsterhunterworld');
  assert.equal(out.meta.gameId, '2531');
  assert.equal(out.meta.revision, 2);
  assert.equal(out.items.length, 4);

  const clarity = out.items[0];
  assert.equal(clarity.key, '2531:3004:20215');
  assert.equal(clarity.fileId, '20215');
  assert.equal(clarity.modId, '3004');
  assert.equal(clarity.uri, 'Clarity 1.7-3004-1-7-1608607481.rar');
  assert.equal(clarity.sizeBytes, 141761);
  assert.equal(clarity.available, true);
  assert.equal(clarity.pageUrl, 'https://www.nexusmods.com/monsterhunterworld/mods/3004?tab=files&file_id=20215');
});

test('normalizeCollectionRevision falls back to size (KB) when sizeInBytes is null', () => {
  const out = C.normalizeCollectionRevision(samplePayload(), {});
  const fatalis = out.items.find((item) => item.fileId === '17858');
  assert.equal(fatalis.sizeBytes, 36 * 1024);
  assert.equal(fatalis.optional, true);
});

test('normalizeCollectionRevision marks removed / missing files unavailable', () => {
  const out = C.normalizeCollectionRevision(samplePayload(), {});
  const removed = out.items.find((item) => item.fileId === '999');
  assert.equal(removed.available, false);
  assert.equal(removed.reason, 'removed');
  const missing = out.items.find((item) => item.fileId === '777');
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'no-file');
});

test('normalizeCollectionRevision dedupes repeated file ids', () => {
  const payload = samplePayload();
  payload.revision.modFiles.push(JSON.parse(JSON.stringify(payload.revision.modFiles[0])));
  const out = C.normalizeCollectionRevision(payload, {});
  assert.equal(out.items.filter((item) => item.fileId === '20215').length, 1);
});

test('summarize counts availability, optional rows and bytes', () => {
  const out = C.normalizeCollectionRevision(samplePayload(), {});
  const summary = C.summarize(out.items);
  assert.equal(summary.total, 4);
  assert.equal(summary.available, 2);
  assert.equal(summary.unavailable, 2);
  assert.equal(summary.optional, 1);
  assert.ok(summary.bytes > 0);
});

// ---------------------------------------------------------------------------
// CDN identity / IDM history matching
// ---------------------------------------------------------------------------

test('extractCdnIdentity understands named and uuid links', () => {
  const named = C.extractCdnIdentity(
    'https://supporter-files.nexus-cdn.com/6993/125/MDF-XL-125-1-5-36-1760731285.7z?md5=x&expires=1'
  );
  assert.equal(named.host, 'supporter-files.nexus-cdn.com');
  assert.equal(named.name, 'mdf-xl-125-1-5-36-1760731285.7z');
  assert.equal(named.uuid, '');

  const uuid = C.extractCdnIdentity(
    'https://files.nexus-cdn.com/3b/f2/51/3bf25125-617e-4e50-9d29-0cadc27f595d?md5=x&expires=1&h=314931fb'
  );
  assert.equal(uuid.uuid, '3bf25125-617e-4e50-9d29-0cadc27f595d');
  assert.equal(uuid.h, '314931fb');
  assert.equal(uuid.name, '');
});

test('matchIdmRecord finds the archive by original name', () => {
  const item = { uri: 'Clarity 1.7-3004-1-7-1608607481.rar', fileName: 'Clarity 1.7' };
  const records = [
    { url: 'https://files.nexus-cdn.com/a/b/other.zip', finalName: 'other.zip' },
    { url: 'https://files.nexus-cdn.com/a/b/x.rar', finalName: 'Clarity 1.7-3004-1-7-1608607481.rar', dateAdded: 'Nov 03 2026' }
  ];
  const match = C.matchIdmRecord(item, records);
  assert.ok(match);
  assert.equal(match.by, 'name');
  assert.equal(match.record.finalName, 'Clarity 1.7-3004-1-7-1608607481.rar');
});

test('matchIdmRecord also matches the CDN path name', () => {
  const item = { uri: 'Stracker\'s Loader-1982-3-0-1-1700072090.zip', fileName: '' };
  const records = [
    { url: 'https://supporter-files.nexus-cdn.com/2531/1982/Stracker%27s%20Loader-1982-3-0-1-1700072090.zip?md5=x', finalName: '' }
  ];
  assert.ok(C.matchIdmRecord(item, records));
});

test('matchIdmRecord returns null when nothing matches', () => {
  assert.equal(C.matchIdmRecord({ uri: 'a.zip' }, []), null);
  assert.equal(C.matchIdmRecord({ uri: 'a.zip' }, [{ url: 'https://x/y/b.zip' }]), null);
  assert.equal(C.matchIdmRecord({ uri: '' }, [{ url: 'https://x/y/b.zip' }]), null);
});

test('relativeTime renders friendly ages', () => {
  const now = Date.now();
  assert.equal(C.relativeTime(now - 5000, now), '刚刚');
  assert.equal(C.relativeTime(now - 5 * 60000, now), '5 分钟前');
  assert.equal(C.relativeTime(now - 3 * 3600000, now), '3 小时前');
  assert.equal(C.relativeTime(0, now), '');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
