'use strict';

/**
 * Nexus Downloader - background service worker
 *
 * Flow:
 *   Nexus file page -> browser starts a CDN download
 *   -> chrome.downloads.onCreated fires
 *   -> cancel the browser download, forward URL + filename to the local bridge
 *   -> bridge calls IDMan.exe /n /d ...
 */

const BRIDGE_URL = 'http://127.0.0.1:38765';
const MAX_EVENTS = 20;
const DEDUPE_MS = 5000;

const DEFAULTS = {
  enabled: true,
  autoIntercept: true,
  devAllDownloads: false
};

const recent = new Map();

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
