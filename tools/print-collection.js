#!/usr/bin/env node
'use strict';

/**
 * Print a collection's mod list through the same normalizer the extension uses.
 * Needs no browser and no login: the GraphQL v2 API is public.
 *
 *   node tools/print-collection.js monsterhunterworld vmu2j4
 *   node tools/print-collection.js monsterhunterworld vmu2j4 2
 *
 * Doubles as the regression sentinel for "did the Nexus schema change?".
 */

const C = require('../extension/lib/collection-utils.js');

const QUERY = `query CollectionRevision ($slug: String!, $domainName: String, $revision: Int, $adult: Boolean) {
  collection (slug: $slug, domainName: $domainName) {
    id slug name collectionStatus
    game { domainName id }
    latestPublishedRevision { id revisionNumber modCount totalSize }
  }
  collectionRevision (slug: $slug, domainName: $domainName, revision: $revision, viewAdultContent: $adult) {
    id revisionNumber modCount totalSize status adultContent
    modFiles {
      optional
      updatePolicy
      fileId
      file {
        fileId modId name version size sizeInBytes uri category
        mod { modId name author status adultContent }
      }
    }
  }
}`;

async function main() {
  const gameDomain = process.argv[2];
  const slug = process.argv[3];
  const revision = Number(process.argv[4]) || 0;
  if (!gameDomain || !slug) {
    console.error('usage: node tools/print-collection.js <gameDomain> <slug> [revision]');
    process.exit(2);
  }

  const variables = { slug, domainName: gameDomain, adult: true };
  if (revision > 0) variables.revision = revision;

  const response = await fetch('https://api.nexusmods.com/v2/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables })
  });
  if (!response.ok) {
    console.error('HTTP ' + response.status);
    process.exit(1);
  }

  const data = await response.json();
  if (data.errors && data.errors.length) {
    console.error('GraphQL error: ' + data.errors.map((error) => error.message).join('; '));
    process.exit(1);
  }
  if (!data.data || !data.data.collection || !data.data.collectionRevision) {
    console.error('collection not found');
    process.exit(1);
  }

  const normalized = C.normalizeCollectionRevision(
    { collection: data.data.collection, revision: data.data.collectionRevision },
    { gameDomain, slug, revision }
  );
  const meta = normalized.meta;
  console.log(meta.name + '  [' + meta.slug + ']');
  console.log(
    'game=' + meta.gameDomain + ' id=' + meta.gameId + ' revision=v' + meta.revision +
      ' mods=' + normalized.items.length + ' size=' + C.formatSize(meta.totalSize)
  );
  console.log('folder: ' + C.collectionFolderName({ name: meta.name, slug: meta.slug }));
  console.log('');

  const rows = normalized.items.map((item) => [
    item.optional ? 'opt' : '   ',
    item.available ? 'ok ' : 'no ',
    String(item.modId).padStart(7),
    String(item.fileId).padStart(8),
    (C.formatSize(item.sizeBytes) || '—').padStart(10),
    item.uri || ('(no uri) ' + item.fileName),
    item.available ? '' : '  <- ' + item.reason
  ]);
  for (const row of rows) console.log(row.join('  '));

  const summary = C.summarize(normalized.items);
  console.log('');
  console.log(
    'total=' + summary.total + ' available=' + summary.available + ' unavailable=' + summary.unavailable +
      ' optional=' + summary.optional + ' bytes=' + summary.bytes
  );
}

main().catch((err) => {
  console.error('failed: ' + ((err && err.message) || err));
  process.exit(1);
});
