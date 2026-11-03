'use strict';

/**
 * Nexus Downloader - pure helpers shared by the content script and the tests.
 *
 * Nothing in here touches the DOM or chrome.*; content.js passes in plain
 * values. Keeping these functions side-effect free makes the brittle part of
 * the integration (Nexus markup and response shapes) unit-testable without a
 * browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusDownloader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DOWNLOAD_URL_KEYS = [
    'url',
    'downloadUrl',
    'download_url',
    'DirectDownloadUrl',
    'DirectDownloadLink',
    'URI',
    'src',
    'href'
  ];

  const CDN_HOSTS = ['nexus-cdn.com', 'files.nexusmods.com'];

  const MANAGER_RE =
    /vortex|mod manager|mod organizer|模组管理器|mod\s*マネージャー|모드\s*관리자|gestionnaire de mods|gestor de mods|menedżer modów|\bnxm\b/i;
  const MANUAL_RE =
    /manual\s*download|téléchargement\s*manuel|manueller?\s*download|descarga\s*manual|download\s*manual|手动下载|手動下載|수동\s*다운로드|手動ダウンロード/i;
  const SLOW_RE =
    /slow\s*download|langsamer?\s*download|téléchargement\s*lent|descarga\s*lenta|慢速下载|低速ダウンロード|저속\s*다운로드/i;
  const FAST_RE = /fast\s*download|快车下载|高速下载|高速ダウンロード/i;
  const DOWNLOAD_RE = /(^|[^a-z])download([^a-z]|$)|下载|ダウンロード|다운로드|télécharger|descargar/i;

  function digits(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    return /^\d+$/.test(text) ? text : '';
  }

  // Nexus sometimes names a file by uid (game id * 2^32 + file id), e.g. in
  // mod-download-modal JSON and /api/files/<uid>/download routes.
  const UID_FACTOR = 2 ** 32;
  const MAX_FILE_ID = 2 ** 31 - 1;

  function normalizeFileId(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!/^\d{1,16}$/.test(text)) return '';
    const number = Number(text);
    if (!Number.isSafeInteger(number)) return '';
    const fileId = number >= UID_FACTOR ? number % UID_FACTOR : number;
    return fileId > 0 && fileId <= MAX_FILE_ID ? String(fileId) : '';
  }

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/\\\//g, '/');
  }

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
  }

  function isCloudflareChallenge(text) {
    if (!text) return false;
    return /cf-turnstile|challenges\.cloudflare\.com|Just a moment|Attention Required!|cf-error-details|id="challenge-form"/i.test(
      String(text)
    );
  }

  // -------------------------------------------------------------------------
  // Nexus page context
  // -------------------------------------------------------------------------

  function fileIdFromHref(href) {
    if (!href) return '';
    const text = String(href);
    try {
      const url = new URL(text, 'https://www.nexusmods.com/');
      const apiMatch = url.pathname.match(/\/api\/files\/(\d+)/);
      if (apiMatch) {
        const value = normalizeFileId(apiMatch[1]);
        if (value) return value;
      }
      for (const key of ['file_id', 'fid', 'id']) {
        const value = normalizeFileId(url.searchParams.get(key));
        if (value) return value;
      }
      const pathMatch = url.pathname.match(/\/files\/(\d+)/);
      if (pathMatch) {
        const value = normalizeFileId(pathMatch[1]);
        if (value) return value;
      }
    } catch (_) {
      /* fall through to regex */
    }
    const apiFallback = text.match(/\/api\/files\/(\d+)/i);
    if (apiFallback) return normalizeFileId(apiFallback[1]);
    const match = text.match(/[?&](?:file_id|fid|id)=(\d+)/i) || text.match(/\/files\/(\d+)/i);
    return match ? normalizeFileId(match[1]) : '';
  }

  function modIdFromPath(pathname) {
    const match = String(pathname || '').match(/\/mods\/(\d+)/);
    return match ? match[1] : '';
  }

  function gameDomainFromPath(pathname) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    if (segments[0] === 'games' && segments[1]) return segments[1];
    if (segments[0] && segments[0] !== 'mods' && segments[0] !== 'api' && segments[0] !== 'Core') {
      return segments[0];
    }
    return '';
  }

  function classifyDownloadLabel(rawLabel) {
    const text = String(rawLabel || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!text) return '';
    if (MANAGER_RE.test(text)) return 'manager';
    if (SLOW_RE.test(text)) return 'slow';
    if (MANUAL_RE.test(text)) return 'manual';
    if (FAST_RE.test(text)) return 'fast';
    if (DOWNLOAD_RE.test(text)) return 'download';
    return '';
  }

  // -------------------------------------------------------------------------
  // File payload (the JSON Nexus puts on <mod-file-download file="..."> etc.)
  // -------------------------------------------------------------------------

  function unwrapFilePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;

    if (Array.isArray(payload)) {
      const objects = payload.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (objects.length === 0) return null;
      const withFile =
        objects.find(
          (item) =>
            digits(item.id) ||
            digits(item.fileId) ||
            digits(item.file_id) ||
            digits(item.fid) ||
            typeof item.downloadUrl === 'string' ||
            typeof item.download_url === 'string'
        ) || objects[0];
      return unwrapFilePayload(withFile);
    }

    for (const key of ['file', 'mainFile', 'fileData']) {
      const inner = payload[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        // Inner file fields win (id / fileName / downloadUrl), while outer
        // fields such as gameId / modId are kept.
        const merged = Object.assign({}, payload, inner);
        const innerId =
          normalizeFileId(inner.id) ||
          normalizeFileId(inner.fileId) ||
          normalizeFileId(inner.file_id) ||
          normalizeFileId(inner.fid) ||
          normalizeFileId(inner.uid);
        if (innerId) merged.id = innerId;
        return merged;
      }
    }

    return payload;
  }

  function payloadFileId(payload) {
    const file = unwrapFilePayload(payload);
    if (!file) return '';
    return (
      normalizeFileId(file.id) ||
      normalizeFileId(file.fileId) ||
      normalizeFileId(file.file_id) ||
      normalizeFileId(file.fid) ||
      normalizeFileId(file.uid) ||
      ''
    );
  }

  function payloadGameId(payload) {
    const file = unwrapFilePayload(payload);
    if (!file) return '';
    return (
      digits(file.gameId) ||
      digits(file.game_id) ||
      digits(file.game && file.game.id) ||
      ''
    );
  }

  /**
   * When a modal carries links for several files, pick the entry that names the
   * clicked file. Falls back to the old single-object behaviour when nothing
   * matches, so a page that only exposes one file keeps working.
   */
  function selectPayloadForFile(payload, fileId) {
    const expected = normalizeFileId(fileId);
    if (!expected || !payload) return unwrapFilePayload(payload);

    let list = null;
    if (Array.isArray(payload)) list = payload;
    else if (payload.file && Array.isArray(payload.file)) list = payload.file;
    else if (payload.files && Array.isArray(payload.files)) list = payload.files;
    if (!list) return unwrapFilePayload(payload);

    const objects = list.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    const matching = objects.filter((item) => payloadFileId(item) === expected);
    if (matching.length) return unwrapFilePayload(matching[0]);

    // Only trust a single unscoped entry; several would be a guess.
    const unscoped = objects.filter((item) => !payloadFileId(item));
    if (unscoped.length === 1) return unwrapFilePayload(unscoped[0]);

    // The list names other files (or several links without ids): do not guess.
    return null;
  }

  function filenameFromName(name) {
    const base = String(name || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      .trim();
    if (!base) return '';
    if (!/\.[A-Za-z0-9]{1,10}$/.test(base)) return '';
    return base;
  }

  function filenameFromUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const pathname = new URL(rawUrl, 'https://www.nexusmods.com/').pathname;
      const base = decodeURIComponent(pathname.split('/').pop() || '');
      return filenameFromName(base);
    } catch (_) {
      return '';
    }
  }

  function filenameFromPayload(payload, url) {
    const file = unwrapFilePayload(payload);
    if (file) {
      for (const key of ['fileName', 'file_name', 'filename', 'archiveName', 'archive_name', 'uri', 'name']) {
        const value = filenameFromName(file[key]);
        if (value) return value;
      }
    }
    return filenameFromUrl(url);
  }

  // -------------------------------------------------------------------------
  // Download URL shapes
  // -------------------------------------------------------------------------

  function isDirectCdnUrl(rawUrl) {
    if (!rawUrl) return false;
    let url;
    try {
      url = new URL(String(rawUrl), 'https://www.nexusmods.com/');
    } catch (_) {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'files.nexusmods.com') return true;
    if (host.startsWith('cf-files.') && host.endsWith('.nexusmods.com')) return true;
    return CDN_HOSTS.some((domain) => host === domain || host.endsWith('.' + domain));
  }

  function isNexusApiFileRoute(rawUrl) {
    if (!rawUrl) return false;
    try {
      const url = new URL(String(rawUrl), 'https://www.nexusmods.com/');
      const host = url.hostname.toLowerCase();
      if (host !== 'nexusmods.com' && !host.endsWith('.nexusmods.com')) return false;
      return /^\/api\/files\/\d+(?:\/download)?\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function findUrlInJson(value, depth) {
    if (value === null || value === undefined || depth > 5) return '';
    if (typeof value === 'string') return isHttpUrl(value) ? decodeEntities(value) : '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findUrlInJson(item, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';

    for (const key of DOWNLOAD_URL_KEYS) {
      const candidate = value[key];
      if (typeof candidate === 'string' && isHttpUrl(candidate)) return decodeEntities(candidate);
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === 'object') {
        const found = findUrlInJson(child, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }

  function extractUrlFromHtml(text) {
    const patterns = [
      /data-download-url\s*=\s*["']([^"']+)["']/i,
      /id\s*=\s*["']dl_link["'][^>]*value\s*=\s*["']([^"']+)["']/i,
      /value\s*=\s*["']([^"']+)["'][^>]*id\s*=\s*["']dl_link["']/i,
      /"(?:downloadUrl|download_url|DirectDownloadUrl|DirectDownloadLink|URI)"\s*:\s*"([^"]+)"/i,
      /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && isHttpUrl(match[1])) return match[1];
    }
    return '';
  }

  /**
   * Pulls a CDN/download URL out of whatever Nexus returned: JSON, an HTML
   * widget, or a plain URL. Returns '' when nothing usable was found.
   */
  function parseDownloadUrlResponse(text) {
    if (!text) return '';
    const raw = String(text).trim();
    if (!raw) return '';

    if (raw[0] === '{' || raw[0] === '[') {
      try {
        const parsed = JSON.parse(raw);
        const fromJson = findUrlInJson(parsed, 0);
        if (fromJson) return fromJson;
      } catch (_) {
        /* not JSON after all */
      }
    }

    if (isHttpUrl(raw) && raw.length < 4096 && !/\s/.test(raw)) {
      return decodeEntities(raw);
    }

    const fromHtml = extractUrlFromHtml(raw);
    if (fromHtml) return decodeEntities(fromHtml);

    return '';
  }

  /**
   * Pulls a download URL out of a full Nexus file page: the current
   * <mod-file-download download-url="…"> attribute, the file JSON attribute, or
   * the older markup.
   */
  function parseDownloadUrlFromPageHtml(text) {
    if (!text) return '';
    const raw = String(text).slice(0, 2 * 1024 * 1024);

    const directPatterns = [
      /download-url\s*=\s*["']([^"']+)["']/i,
      /data-download-url\s*=\s*["']([^"']+)["']/i
    ];
    for (const pattern of directPatterns) {
      const match = raw.match(pattern);
      if (!match) continue;
      const value = decodeEntities(match[1]);
      if (isHttpUrl(value) || value.startsWith('/api/files/')) return value;
    }

    const attributePattern = /(?:main-file|file)\s*=\s*(["'])([\s\S]*?)\1/gi;
    for (const match of raw.matchAll(attributePattern)) {
      let parsed;
      try {
        parsed = JSON.parse(decodeEntities(match[2]));
      } catch (_) {
        continue;
      }
      const url = findUrlInJson(parsed, 0);
      if (url) return url;
    }

    return parseDownloadUrlResponse(raw);
  }

  function describeResponseError(text, status) {
    const body = String(text || '').trim();
    if (!body) return status ? 'Nexus 返回了 HTTP ' + status : '';

    if (isCloudflareChallenge(body)) {
      return 'Nexus 要求人机验证（Cloudflare），请刷新页面或稍后重试';
    }

    if (body[0] === '{' || body[0] === '[') {
      try {
        const parsed = JSON.parse(body);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          for (const key of ['error', 'message', 'detail', 'errorMessage']) {
            if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim().slice(0, 200);
          }
        }
      } catch (_) {
        /* fall through to HTML text */
      }
    }

    const plain = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!plain) return status ? 'Nexus 返回了 HTTP ' + status : '';
    if (isCloudflareChallenge(plain)) {
      return 'Nexus 要求人机验证（Cloudflare），请刷新页面或稍后重试';
    }
    return plain.slice(0, 200);
  }

  function buildGenerateBody(input) {
    const params = new URLSearchParams();
    params.set('fid', normalizeFileId(input && input.fileId) || String((input && input.fileId) || ''));
    const gameId = digits(input && input.gameId);
    const gameDomain = String((input && input.gameDomain) || '').trim();
    // The generator takes the numeric game id; a domain is only a hint when
    // the number has not been resolved yet.
    if (gameId) params.set('game_id', gameId);
    else if (gameDomain) params.set('game_name', gameDomain);
    return params.toString();
  }

  return {
    digits,
    normalizeFileId,
    decodeEntities,
    isHttpUrl,
    isCloudflareChallenge,
    fileIdFromHref,
    modIdFromPath,
    gameDomainFromPath,
    classifyDownloadLabel,
    unwrapFilePayload,
    selectPayloadForFile,
    payloadFileId,
    payloadGameId,
    filenameFromName,
    filenameFromUrl,
    filenameFromPayload,
    isDirectCdnUrl,
    isNexusApiFileRoute,
    parseDownloadUrlResponse,
    parseDownloadUrlFromPageHtml,
    describeResponseError,
    buildGenerateBody
  };
});
