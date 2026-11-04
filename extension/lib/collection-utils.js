'use strict';

/**
 * Nexus Downloader - pure helpers for Collections batch downloads.
 *
 * Loaded by the content script, the service worker (importScripts) and the
 * local bridge (require). Nothing in here touches the DOM, chrome.* or fs.
 *
 * Keeping the naming / dedupe / normalisation rules in one file matters:
 * the extension previews "file already exists" with these exact rules, and the
 * bridge writes the file with the same rules. If they drift, a preflight can
 * say "new" while the download lands under another name.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusCollection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SEGMENT = 80;
  const MAX_FILENAME = 180;
  const KEEP_EXT = /(\.[A-Za-z0-9]{1,12})$/;
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  // -------------------------------------------------------------------------
  // basic helpers
  // -------------------------------------------------------------------------

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function digits(value) {
    const raw = text(value).trim();
    return /^\d+$/.test(raw) ? raw : '';
  }

  /**
   * One Windows path segment. Used for the collection folder and archive names
   * on both sides of the bridge.
   */
  function sanitizeSegment(value, maxLength) {
    const limit = Number(maxLength) > 0 ? Number(maxLength) : MAX_SEGMENT;
    let out = text(value)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim();
    if (!out) out = '_';
    if (RESERVED.test(out)) out = '_' + out;
    if (out.length > limit) out = out.slice(0, limit).replace(/[.\s]+$/g, '');
    return out || '_';
  }

  /** A file name, keeping the extension when the base has to be shortened. */
  function sanitizeFilename(value, maxLength) {
    const limit = Number(maxLength) > 0 ? Number(maxLength) : MAX_FILENAME;
    const raw = text(value).trim();
    if (!raw) return '';
    const ext = (KEEP_EXT.exec(raw) || [])[1] || '';
    const base = ext ? raw.slice(0, raw.length - ext.length) : raw;
    return sanitizeSegment(base, Math.max(1, limit - ext.length)) + ext;
  }

  /** `Name [slug]` - the per-collection folder. */
  function collectionFolderName(input, options) {
    const opts = options || {};
    const name = sanitizeSegment(input && input.name, 100);
    const slug = sanitizeSegment(input && input.slug, 32);
    const suffix = opts.suffix !== false && slug && slug !== '_';
    const full = suffix ? name + ' [' + slug + ']' : name;
    return sanitizeSegment(full, 120);
  }

  function formatSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 1024) return value + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return (size >= 100 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit];
  }

  /** `archive.zip` -> `archive (2).zip`, used instead of ever overwriting. */
  function withSuffix(filename, index) {
    const n = Number(index);
    if (!Number.isFinite(n) || n < 2) return filename;
    const raw = text(filename);
    const ext = (KEEP_EXT.exec(raw) || [])[1] || '';
    const base = ext ? raw.slice(0, raw.length - ext.length) : raw;
    return base + ' (' + Math.floor(n) + ')' + ext;
  }

  // -------------------------------------------------------------------------
  // collection page
  // -------------------------------------------------------------------------

  /**
   * `/games/monsterhunterworld/collections/vmu2j4`
   * `/games/monsterhunterworld/collections/vmu2j4/revisions/2`
   * `/monsterhunterworld/collections/vmu2j4?revision=2`
   */
  function parseCollectionPath(pathname, search) {
    const segments = text(pathname).split('/').filter(Boolean);
    let gameDomain = '';
    let index = 0;
    if (segments[0] === 'games' && segments.length >= 3) {
      gameDomain = segments[1];
      index = 2;
    } else if (segments.length >= 3) {
      gameDomain = segments[0];
      index = 1;
    }
    if (!gameDomain || segments[index] !== 'collections') return null;
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(gameDomain)) return null;

    const slug = segments[index + 1];
    if (!slug || !/^[A-Za-z0-9_-]{2,64}$/.test(slug)) return null;

    let revision = 0;
    const tail = segments[index + 2];
    if (tail === 'revisions' || tail === 'revision') {
      const value = Number(segments[index + 3]);
      if (Number.isInteger(value) && value > 0) revision = value;
    }

    if (!revision) {
      const params = new URLSearchParams(text(search || '').replace(/^\?/, ''));
      const value = Number(params.get('revision') || params.get('revisionNumber'));
      if (Number.isInteger(value) && value > 0) revision = value;
    }

    return { gameDomain, slug, revision };
  }

  function collectionPageUrl(input) {
    const domain = text(input && input.gameDomain) || 'www.nexusmods.com';
    const slug = text(input && input.slug);
    const revision = Number(input && input.revision);
    let url = 'https://www.nexusmods.com/games/' + domain + '/collections/' + slug;
    if (Number.isInteger(revision) && revision > 0) url += '/revisions/' + revision;
    return url;
  }

  function modFilePageUrl(input) {
    const domain = text(input && input.gameDomain);
    const modId = digits(input && input.modId);
    const fileId = digits(input && input.fileId);
    if (!domain || !modId) return '';
    let url = 'https://www.nexusmods.com/' + domain + '/mods/' + modId + '?tab=files';
    if (fileId) url += '&file_id=' + fileId;
    return url;
  }

  // -------------------------------------------------------------------------
  // GraphQL payload -> flat rows
  // -------------------------------------------------------------------------

  /**
   * @param payload  { collection, revision } straight from the API
   * @param options  { gameDomain }
   * @returns { ok, meta, items } - items are the rows the panel renders
   */
  function normalizeCollectionRevision(payload, options) {
    const opts = options || {};
    const data = payload || {};
    const collection = data.collection || {};
    const revision = data.revision || {};

    const gameDomain =
      text(collection.gameDomain) ||
      text(collection.game && collection.game.domainName) ||
      text(opts.gameDomain);
    const gameId =
      digits(collection.gameId) || digits(collection.game && collection.game.id) || '';

    const meta = {
      id: digits(collection.id),
      slug: text(collection.slug) || text(opts.slug),
      name: text(collection.name) || text(opts.slug),
      gameDomain,
      gameId,
      status: text(collection.collectionStatus),
      revision: Number(revision.revisionNumber) || 0,
      revisionId: digits(revision.id),
      revisionStatus: text(revision.status),
      adultContent: !!revision.adultContent,
      modCount: Number(revision.modCount) || 0,
      totalSize: Number(revision.totalSize) || 0,
      pageUrl: collectionPageUrl({ gameDomain, slug: text(collection.slug) || text(opts.slug) })
    };

    const files = Array.isArray(revision.modFiles) ? revision.modFiles : [];
    const seen = new Set();
    const items = [];

    for (const entry of files) {
      if (!entry || typeof entry !== 'object') continue;
      const file = entry.file || null;
      const mod = (file && file.mod) || {};
      const modId = digits(file && file.modId) || digits(mod.modId) || digits(entry.modId);
      const fileId = digits(entry.fileId) || digits(file && file.fileId);
      if (!fileId) continue;

      const key = (gameId || '0') + ':' + (modId || '0') + ':' + fileId;
      if (seen.has(key)) continue;
      seen.add(key);

      const sizeKb = Number(file && file.size) || 0;
      const sizeBytes = Number(file && file.sizeInBytes) || sizeKb * 1024;

      let available = true;
      let reason = '';
      if (!file) {
        available = false;
        reason = 'no-file';
      } else if (text(file.category).toUpperCase() === 'REMOVED') {
        available = false;
        reason = 'removed';
      } else {
        const status = text(mod.status).toLowerCase();
        if (status && status !== 'published' && status !== 'archived') {
          available = false;
          reason = 'mod-' + status;
        }
      }

      items.push({
        key,
        gameId,
        modId: modId || '',
        fileId,
        modName: text(mod.name) || text(file && file.name) || ('mod ' + (modId || '?')),
        author: text(mod.author),
        fileName: text(file && file.name),
        uri: text(file && file.uri),
        version: text(file && file.version) || text(entry.version),
        sizeKb,
        sizeBytes,
        category: text(file && file.category),
        optional: !!entry.optional,
        updatePolicy: text(entry.updatePolicy),
        adultContent: !!mod.adultContent,
        available,
        reason,
        pageUrl: modFilePageUrl({ gameDomain, modId, fileId })
      });
    }

    const summary = summarize(items);
    meta.availableCount = summary.available;
    meta.totalSize = meta.totalSize || items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);

    return { ok: true, meta, items };
  }

  function summarize(items) {
    const list = Array.isArray(items) ? items : [];
    const out = {
      total: list.length,
      available: 0,
      unavailable: 0,
      optional: 0,
      bytes: 0
    };
    for (const item of list) {
      if (!item) continue;
      if (item.available) out.available += 1;
      else out.unavailable += 1;
      if (item.optional) out.optional += 1;
      out.bytes += Number(item.sizeBytes) || 0;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // dedupe identity
  // -------------------------------------------------------------------------

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * What a CDN URL tells us about the file it serves. Nexus hands out two
   * shapes: `.../<original-name>.zip?...` and `.../<uuid>?...&h=<hash>`.
   */
  function extractCdnIdentity(rawUrl) {
    const out = { host: '', path: '', name: '', uuid: '', h: '' };
    if (!rawUrl) return out;
    let url;
    try {
      url = new URL(text(rawUrl));
    } catch (_) {
      return out;
    }
    out.host = url.hostname.toLowerCase();
    out.path = url.pathname;
    const base = decodeURIComponent(url.pathname.split('/').pop() || '');
    out.h = text(url.searchParams.get('h'));
    if (UUID_RE.test(base)) out.uuid = base.toLowerCase();
    else if (KEEP_EXT.test(base)) out.name = base.toLowerCase();
    return out;
  }

  function normalizeName(value) {
    return text(value)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
      .trim()
      .toLowerCase();
  }

  /**
   * Does an IDM record (from the bridge's /idmHistory) describe this file?
   * We compare the original archive name, which is what Nexus puts in the CDN
   * path for most links and what IDM stores in FR_FNCD.
   */
  function matchIdmRecord(item, records) {
    if (!item || !Array.isArray(records) || records.length === 0) return null;
    const wanted = [normalizeName(item.uri), normalizeName(item.fileName)].filter(Boolean);
    if (wanted.length === 0) return null;
    for (const record of records) {
      if (!record) continue;
      const candidates = [normalizeName(record.finalName), normalizeName(record.fileName)];
      const identity = extractCdnIdentity(record.url);
      if (identity.name) candidates.push(normalizeName(identity.name));
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (wanted.includes(candidate)) return { record, by: 'name' };
      }
    }
    return null;
  }

  function relativeTime(timestamp, now) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '';
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const diff = Math.max(0, current - value);
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟前';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    const days = Math.round(hours / 24);
    if (days < 31) return days + ' 天前';
    try {
      return new Date(value).toLocaleDateString('zh-CN');
    } catch (_) {
      return '';
    }
  }

  return {
    MAX_SEGMENT,
    MAX_FILENAME,
    sanitizeSegment,
    sanitizeFilename,
    collectionFolderName,
    formatSize,
    withSuffix,
    parseCollectionPath,
    collectionPageUrl,
    modFilePageUrl,
    normalizeCollectionRevision,
    summarize,
    extractCdnIdentity,
    normalizeName,
    matchIdmRecord,
    relativeTime,
    digits
  };
});
