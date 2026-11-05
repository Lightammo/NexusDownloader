'use strict';

/**
 * Nexus Downloader - background service worker
 *
 * Flow:
 *   Nexus file page -> browser starts a CDN download
 *   -> chrome.downloads.onCreated fires
 *   -> cancel the browser download, forward URL + filename to the local bridge
 *   -> bridge calls IDMan.exe /n /d ...
 *
 * Collections: the panel in collection.js asks this worker for the mod list
 * (Nexus GraphQL v2, public, no Cloudflare), for the dedupe verdict against the
 * bridge's disk + IDM history, and for each hand-off to the bridge.
 */

importScripts('lib/collection-utils.js', 'lib/challenge-utils.js');

const BRIDGE_URL = 'http://127.0.0.1:38765';
const MAX_EVENTS = 20;
const DEDUPE_MS = 5000;
const MAX_LEDGER_ENTRIES = 5000;
const COLLECTION_CACHE_MS = 10 * 60 * 1000;
const MAX_CHECK_ITEMS = 5000;

const DEFAULTS = {
  enabled: true,
  autoIntercept: true,
  devAllDownloads: false,
  clickDownload: true
};

const GRAPHQL_URL = 'https://api-router.nexusmods.com/graphql';
const COLLECTION_GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';

const recent = new Map();
const collectionCache = new Map();

// ---------------------------------------------------------------------------
// settings + events
// ---------------------------------------------------------------------------

async function getSettings() {
  const data = await chrome.storage.local.get({ settings: DEFAULTS });
  return Object.assign({}, DEFAULTS, data.settings || {});
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function addEvent(event) {
  const data = await chrome.storage.local.get({ events: [] });
  const events = Array.isArray(data.events) ? data.events : [];
  events.unshift(Object.assign({ at: Date.now() }, event));
  await chrome.storage.local.set({ events: events.slice(0, MAX_EVENTS) });
}

// ---------------------------------------------------------------------------
// local bridge
// ---------------------------------------------------------------------------

async function callBridge(pathname, body) {
  const options = { method: body ? 'POST' : 'GET', headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(BRIDGE_URL + pathname, options);
    const data = await response.json();
    if (!response.ok && data && !data.error) data.error = 'HTTP ' + response.status;
    return data;
  } catch (err) {
    return {
      ok: false,
      error: '本地桥接未启动或无法连接（运行 bridge\\start.ps1）：' + (err && err.message ? err.message : String(err))
    };
  }
}

/**
 * Read the file list for a mod from Nexus's public GraphQL router.
 */
async function fetchModFiles(gameId, modId) {
  const gid = Number(gameId);
  const mid = Number(modId);
  if (!Number.isInteger(gid) || gid <= 0 || !Number.isInteger(mid) || mid <= 0) return [];

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query ModFiles ($gameId: ID!, $modId: ID!) {
          modFiles (gameId: $gameId, modId: $modId) {
            fileId
            name
            uri
            category
            primary
            version
            detectedFileExtension
          }
        }`,
        variables: { gameId: String(gid), modId: String(mid) },
        operationName: 'ModFiles'
      })
    });
    if (!response.ok) return [];
    const data = await response.json();
    const files = data && data.data && data.data.modFiles;
    return Array.isArray(files) ? files : [];
  } catch (_) {
    return [];
  }
}

/**
 * Nexus's GraphQL file object exposes the display name and detected extension,
 * not the original archive filename. Display name + extension is the best
 * fallback when the page payload has no fileName.
 */
function composeFileName(file) {
  if (!file) return '';
  const name = String(file.name || '').trim();
  const extension = String(file.detectedFileExtension || '').replace(/^\.+/, '');
  if (!name) return '';
  if (!extension) return name;
  if (name.toLowerCase().endsWith('.' + extension.toLowerCase())) return name;
  return name + '.' + extension;
}

/**
 * Resolve the primary file (id + guessed filename) for page-level "Manual
 * download" buttons that do not expose a file_id in their href/DOM.
 */
async function resolvePrimaryFileInfo(domain, modId) {
  const gameId = await resolveGameId(domain);
  if (!gameId) return null;

  const files = await fetchModFiles(gameId, modId);
  if (files.length === 0) return null;

  const primary =
    files.find((file) => file && (Number(file.primary) === 1 || file.category === 'MAIN')) || files[0];
  if (!primary || !primary.fileId) return null;

  return { fileId: String(primary.fileId), fileName: composeFileName(primary) };
}

async function resolveFileName(domain, modId, fileId) {
  const gameId = await resolveGameId(domain);
  if (!gameId) return '';
  const files = await fetchModFiles(gameId, modId);
  const match = files.find((file) => String(file.fileId) === String(fileId));
  return match ? composeFileName(match) : '';
}

/**
 * Resolve a numeric Nexus game id for a domain slug. The page usually has it
 * already; this is only a fallback used when GenerateDownloadUrl wants it.
 */
async function resolveGameId(domain) {
  const clean = String(domain || '').trim();
  if (!/^[a-z0-9-]+$/i.test(clean)) return '';

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query GameByDomain ($domainName: String!) {
          game (domainName: $domainName) { id domainName }
        }`,
        variables: { domainName: clean },
        operationName: 'GameByDomain'
      })
    });
    if (!response.ok) return '';
    const data = await response.json();
    const id = data && data.data && data.data.game && data.data.game.id;
    return id ? String(id) : '';
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

const COLLECTION_QUERY = `query CollectionRevision ($slug: String!, $domainName: String, $revision: Int, $adult: Boolean) {
  collection (slug: $slug, domainName: $domainName) {
    id
    slug
    name
    collectionStatus
    game { domainName id }
    latestPublishedRevision { id revisionNumber modCount totalSize }
  }
  collectionRevision (slug: $slug, domainName: $domainName, revision: $revision, viewAdultContent: $adult) {
    id
    revisionNumber
    modCount
    totalSize
    status
    adultContent
    modFiles {
      optional
      updatePolicy
      fileId
      file {
        fileId
        modId
        name
        version
        size
        sizeInBytes
        uri
        category
        mod { modId name author status adultContent }
      }
    }
  }
}`;

async function getStored(key, fallback) {
  const data = await chrome.storage.local.get({ [key]: fallback });
  return data[key];
}

/**
 * The public GraphQL v2 API answers without a login and without Cloudflare, so
 * the mod list never has to be scraped out of the collection page.
 */
async function fetchCollectionRevision(input) {
  const gameDomain = String((input && input.gameDomain) || '').trim();
  const slug = String((input && input.slug) || '').trim();
  const revision = Number(input && input.revision) || 0;
  if (!gameDomain || !slug) return { ok: false, error: '缺少 gameDomain 或 slug' };

  const cacheKey = gameDomain + ':' + slug + ':' + revision;
  const cached = collectionCache.get(cacheKey);
  if (!(input && input.force) && cached && Date.now() - cached.at < COLLECTION_CACHE_MS) {
    return Object.assign({ cached: true }, cached.value);
  }

  const variables = { slug, domainName: gameDomain, adult: true };
  if (revision > 0) variables.revision = revision;

  let response;
  try {
    response = await fetch(COLLECTION_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: COLLECTION_QUERY, variables })
    });
  } catch (err) {
    return { ok: false, error: '无法访问 Nexus API：' + ((err && err.message) || String(err)) };
  }

  if (!response.ok) return { ok: false, error: 'Nexus API 返回 HTTP ' + response.status };

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, error: 'Nexus API 返回了无法解析的内容' };
  }

  if (data && Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0] || {};
    const code = (first.extensions && first.extensions.code) || '';
    return { ok: false, error: first.message || 'Nexus API 报错', code };
  }

  const collection = data && data.data && data.data.collection;
  const revisionData = data && data.data && data.data.collectionRevision;
  if (!collection || !revisionData) {
    return { ok: false, error: '找不到这个合集（可能已删除或未公开）' };
  }

  const value = NexusCollection.normalizeCollectionRevision(
    { collection, revision: revisionData },
    { gameDomain, slug }
  );
  collectionCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function getLedger() {
  const ledger = await getStored('dispatchLedger', {});
  return ledger && typeof ledger === 'object' ? ledger : {};
}

async function recordDispatch(entry) {
  if (!entry || !entry.key) return;
  const ledger = await getLedger();
  ledger[entry.key] = Object.assign({ at: Date.now() }, entry);
  const keys = Object.keys(ledger);
  if (keys.length > MAX_LEDGER_ENTRIES) {
    keys
      .sort((a, b) => (ledger[a].at || 0) - (ledger[b].at || 0))
      .slice(0, keys.length - MAX_LEDGER_ENTRIES)
      .forEach((key) => delete ledger[key]);
  }
  await chrome.storage.local.set({ dispatchLedger: ledger });
}

function sameDir(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/**
 * Preflight: which rows are already here? Combines the disk check and the IDM
 * history from the bridge with our own dispatch ledger.
 */
async function collectionCheck(input) {
  const subdir = String((input && input.subdir) || '');
  const items = Array.isArray(input && input.items) ? input.items.slice(0, MAX_CHECK_ITEMS) : [];
  const useIdmHistory = !(input && input.useIdmHistory === false);

  const names = items
    .map((item) => NexusCollection.sanitizeFilename(item && (item.uri || item.fileName)))
    .filter(Boolean);

  const [disk, history, ledger] = await Promise.all([
    names.length ? callBridge('/check', { subdir, names }) : Promise.resolve({ ok: false }),
    useIdmHistory ? callBridge('/idmHistory', {}) : Promise.resolve({ ok: false }),
    getLedger()
  ]);

  const records = history && Array.isArray(history.records) ? history.records : [];
  const statuses = {};
  const counts = { disk: 0, ledger: 0, idm: 0 };

  for (const item of items) {
    const key = String((item && item.key) || '');
    if (!key) continue;
    const name = NexusCollection.sanitizeFilename(item.uri || item.fileName || '');
    const status = { duplicate: '', detail: '' };

    const info = disk && disk.ok && disk.files ? disk.files[name] : null;
    if (info && info.exists) {
      status.duplicate = 'disk';
      status.detail = NexusCollection.formatSize(info.size) + ' · ' + NexusCollection.relativeTime(info.mtimeMs);
    } else if (ledger[key] && sameDir(ledger[key].dir, disk && disk.dir)) {
      status.duplicate = 'ledger';
      status.detail = '扩展下发过 · ' + NexusCollection.relativeTime(ledger[key].at);
    } else {
      const match = NexusCollection.matchIdmRecord(item, records);
      if (match) {
        status.duplicate = 'idm';
        status.detail = 'IDM 有记录' + (match.record.dateAdded ? ' · ' + match.record.dateAdded : '');
      }
    }

    if (status.duplicate) counts[status.duplicate] += 1;
    statuses[key] = status;
  }

  return {
    ok: true,
    dir: (disk && disk.dir) || '',
    statuses,
    counts,
    historyError: (history && history.error) || '',
    historyCount: records.length,
    bridgeMissing: !(disk && disk.ok)
  };
}

async function collectionSend(input) {
  const url = String((input && input.url) || '');
  const filename = String((input && input.filename) || '');
  const subdir = String((input && input.subdir) || '');
  // Only an explicit "overwrite this file" from the panel sends 'replace';
  // everything else is a skip, so a duplicate name is never downloaded twice.
  const onExisting = input && input.onExisting === 'replace' ? 'replace' : 'skip';

  const response = await callBridge('/download', {
    url,
    filename,
    subdir,
    onExisting,
    referrer: String((input && input.referrer) || ''),
    source: 'collection'
  });

  if (response && response.ok && !response.skipped) {
    await recordDispatch({
      key: String((input && input.key) || ''),
      dir: response.dir || '',
      name: response.filename || filename,
      fileId: String((input && input.fileId) || ''),
      gameId: String((input && input.gameId) || ''),
      modId: String((input && input.modId) || ''),
      status: 'sent'
    });
    await addEvent({
      ok: true,
      url,
      filename: response.filename || filename,
      fileId: String((input && input.fileId) || ''),
      gameId: String((input && input.gameId) || ''),
      message: '已交给 IDM（合集）',
      source: 'collection'
    });
  }

  return response;
}

async function collectionPoll(input) {
  const subdir = String((input && input.subdir) || '');
  const names = Array.isArray(input && input.names) ? input.names : [];
  if (!names.length) return { ok: false, error: 'nothing to check' };
  return callBridge('/check', { subdir, names });
}

async function saveCollectionJob(job) {
  if (!job || !job.jobId) return { ok: false, error: 'missing jobId' };
  const jobs = await getStored('collectionJobs', {});
  jobs[job.jobId] = Object.assign({}, job, { updatedAt: Date.now() });
  const ids = Object.keys(jobs);
  if (ids.length > 20) {
    ids
      .sort((a, b) => (jobs[a].updatedAt || 0) - (jobs[b].updatedAt || 0))
      .slice(0, ids.length - 20)
      .forEach((id) => delete jobs[id]);
  }
  await chrome.storage.local.set({ collectionJobs: jobs });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// collection verification tab
// ---------------------------------------------------------------------------
//
// window.open() from a content script is popup-blocked once the queue has been
// running for a while: the user gesture that started it is gone. Opening the
// tab here always works, and chrome.tabs.get() lets the panel watch the page
// load and close it as soon as Cloudflare stops asking. No new permission is
// needed: the host permission for nexusmods.com already exposes url/title/status.

function isNexusCheckUrl(rawUrl) {
  return NexusChallenge.isNexusUrl(String(rawUrl || ''));
}

function tabSnapshot(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: !!tab.active,
    status: tab.status || '',
    title: tab.title || '',
    url: tab.url || '',
    pendingUrl: tab.pendingUrl || ''
  };
}

async function openCheckTab(rawUrl, active) {
  if (!isNexusCheckUrl(rawUrl)) return { ok: false, error: '验证页必须是 nexusmods.com 地址' };
  try {
    const tab = await chrome.tabs.create({ url: rawUrl, active: !!active });
    return { ok: true, tabId: tab.id, windowId: tab.windowId, tab: tabSnapshot(tab) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function getCheckTab(tabId) {
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    return { ok: true, tab: tabSnapshot(tab) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function navigateCheckTab(tabId, rawUrl) {
  if (!isNexusCheckUrl(rawUrl)) return { ok: false, error: '验证页必须是 nexusmods.com 地址' };
  try {
    const tab = await chrome.tabs.update(Number(tabId), { url: rawUrl });
    return { ok: true, tab: tabSnapshot(tab) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function probeCheckTab(tabId) {
  try {
    const probe = await chrome.tabs.sendMessage(Number(tabId), { type: 'nd:challengeProbe' });
    return { ok: true, probe: probe || null };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function focusCheckTab(tabId) {
  try {
    const tab = await chrome.tabs.update(Number(tabId), { active: true });
    if (tab && tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (_) {
        /* the window may already be focused */
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function closeCheckTab(tabId) {
  try {
    await chrome.tabs.remove(Number(tabId));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ---------------------------------------------------------------------------
// download interception
// ---------------------------------------------------------------------------

function isNexusDownloadUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase();
  const isNexusHost =
    host === 'nexusmods.com' ||
    host.endsWith('.nexusmods.com') ||
    host.endsWith('.nexus-cdn.com');
  if (!isNexusHost) return false;

  // CDN file links live on cf-files.nexusmods.com or *.nexus-cdn.com and
  // usually carry a /cdn/ path segment. Avoid grabbing normal page downloads.
  if (host.endsWith('.nexus-cdn.com')) return true;
  if (host.startsWith('cf-files.')) return true;
  return /\/cdn\//i.test(url.pathname);
}

function pickFilename(suggested, url) {
  let name = '';
  if (suggested) {
    name = String(suggested).split(/[\\/]/).pop() || '';
  }
  if (!name) {
    try {
      const pathname = new URL(url).pathname;
      name = decodeURIComponent(pathname.split('/').pop() || '');
    } catch (_) {
      name = '';
    }
  }
  return name || 'nexus-download.bin';
}

chrome.downloads.onCreated.addListener((item) => {
  handleCreated(item).catch((err) => {
    addEvent({
      ok: false,
      message: '内部错误: ' + (err && err.message ? err.message : String(err)),
      url: item && item.url ? item.url : ''
    });
  });
});

async function handleCreated(item) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.autoIntercept) return;

  const url = item.finalUrl || item.url || '';
  if (!settings.devAllDownloads && !isNexusDownloadUrl(url)) return;

  const now = Date.now();
  const last = recent.get(url);
  if (last && now - last < DEDUPE_MS) return;
  recent.set(url, now);
  for (const [key, at] of recent) {
    if (now - at > 60000) recent.delete(key);
  }

  // Stop Chrome's own download so IDM is the only writer.
  try {
    await chrome.downloads.cancel(item.id);
  } catch (_) {
    /* already cancelled by another extension */
  }
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch (_) {
    /* ignore */
  }

  const filename = pickFilename(item.filename, url);
  const response = await callBridge('/download', {
    url,
    filename,
    referrer: item.referrer || '',
    source: item.byExtensionId ? 'extension' : 'browser'
  });

  const ok = !!(response && response.ok);
  const message = ok
    ? '已交给 IDM'
    : '发送失败: ' + ((response && response.error) || '未知错误');

  await addEvent({
    ok,
    url,
    filename,
    message,
    source: settings.devAllDownloads ? 'dev' : 'auto'
  });

  if (typeof item.tabId === 'number' && item.tabId >= 0) {
    chrome.tabs
      .sendMessage(item.tabId, {
        type: 'nexus-downloader:toast',
        ok,
        text: ok ? '已交给 IDM：' + filename : 'IDM 接管失败：' + ((response && response.error) || '未知错误')
      })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// popup / content-script messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'nd:ping':
      callBridge('/ping').then(sendResponse);
      return true;

    case 'nd:resolveGameId':
      resolveGameId(message.domain).then((gameId) => sendResponse({ ok: !!gameId, gameId }));
      return true;

    case 'nd:resolvePrimaryFileId':
      resolvePrimaryFileInfo(message.gameDomain, message.modId).then((info) =>
        sendResponse(info ? { ok: true, fileId: info.fileId, fileName: info.fileName } : { ok: false })
      );
      return true;

    case 'nd:resolveFileName':
      resolveFileName(message.gameDomain, message.modId, message.fileId).then((fileName) =>
        sendResponse({ ok: !!fileName, fileName })
      );
      return true;

    case 'nd:log':
      addEvent({
        ok: !!message.ok,
        message: String(message.message || '页面事件'),
        url: String(message.url || ''),
        source: 'page-log'
      }).then(() => sendResponse({ ok: true }));
      return true;

    case 'nd:clickDownload': {
      const url = String(message.url || '');
      const filename = String(message.filename || '');
      const fileId = String(message.fileId || '');
      const gameId = String(message.gameId || '');

      callBridge('/download', {
        url,
        filename,
        referrer: String(message.referrer || ''),
        source: 'page-click'
      })
        .then(async (response) => {
          const ok = !!(response && response.ok);
          await addEvent({
            ok,
            url,
            filename: (response && response.filename) || filename,
            fileId,
            gameId,
            message: ok
              ? '已交给 IDM（页面一键下载）'
              : '发送失败: ' + ((response && response.error) || '未知错误'),
            source: 'page-click'
          });
          sendResponse(response);
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case 'nd:manual':
      callBridge('/download', {
        url: String(message.url || ''),
        filename: String(message.filename || ''),
        source: 'manual'
      })
        .then(async (response) => {
          await addEvent({
            ok: !!(response && response.ok),
            url: String(message.url || ''),
            filename: String(message.filename || ''),
            message: response && response.ok ? '手动发送到 IDM' : '发送失败: ' + ((response && response.error) || '未知错误'),
            source: 'manual'
          });
          sendResponse(response);
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'nd:openFolder':
      callBridge('/openFolder', {}).then(sendResponse);
      return true;

    case 'nd:openConfig':
      callBridge('/openConfig', {}).then(sendResponse);
      return true;

    case 'nd:getSettings':
      getSettings().then((settings) => sendResponse({ ok: true, settings }));
      return true;

    case 'nd:setSettings':
      saveSettings(message.patch).then((settings) => sendResponse({ ok: true, settings }));
      return true;

    case 'nd:getEvents':
      chrome.storage.local.get({ events: [] }).then((data) => {
        sendResponse({ ok: true, events: Array.isArray(data.events) ? data.events : [] });
      });
      return true;

    case 'nd:clearEvents':
      chrome.storage.local.set({ events: [] }).then(() => sendResponse({ ok: true }));
      return true;

    // -----------------------------------------------------------------------
    // collections
    // -----------------------------------------------------------------------

    case 'nd:collectionResolve':
      fetchCollectionRevision(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'nd:collectionCheck':
      collectionCheck(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'nd:collectionSend':
      collectionSend(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'nd:collectionPoll':
      collectionPoll(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'nd:collectionJobGet':
      getStored('collectionJobs', {}).then((jobs) => {
        sendResponse({ ok: true, job: (jobs && jobs[message.jobId]) || null });
      });
      return true;

    case 'nd:collectionJobSet':
      saveCollectionJob(message.job)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'nd:collectionJobClear':
      getStored('collectionJobs', {}).then(async (jobs) => {
        if (jobs && jobs[message.jobId]) {
          delete jobs[message.jobId];
          await chrome.storage.local.set({ collectionJobs: jobs });
        }
        sendResponse({ ok: true });
      });
      return true;

    case 'nd:collectionOpenFolder':
      callBridge('/openFolder', { subdir: String(message.subdir || '') }).then(sendResponse);
      return true;

    // -----------------------------------------------------------------------
    // Cloudflare verification tab
    // -----------------------------------------------------------------------

    case 'nd:checkTabOpen':
      openCheckTab(String(message.url || ''), !!message.active).then(sendResponse);
      return true;

    case 'nd:checkTabGet':
      getCheckTab(message.tabId).then(sendResponse);
      return true;

    case 'nd:checkTabNavigate':
      navigateCheckTab(message.tabId, String(message.url || '')).then(sendResponse);
      return true;

    case 'nd:checkTabProbe':
      probeCheckTab(message.tabId).then(sendResponse);
      return true;

    case 'nd:checkTabFocus':
      focusCheckTab(message.tabId).then(sendResponse);
      return true;

    case 'nd:checkTabClose':
      closeCheckTab(message.tabId).then(sendResponse);
      return true;

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['settings']);
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULTS });
  }
  await chrome.storage.local.set({ events: [] });
});
