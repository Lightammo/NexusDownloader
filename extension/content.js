'use strict';

/**
 * Nexus Downloader - Nexus page content script
 *
 * One-click flow (v0.2):
 *   Files page -> user clicks "Manual download"
 *   -> we stop the navigation (no new tab)
 *   -> read the file payload / file_id from the page
 *   -> ask Nexus for the signed CDN link from inside the logged-in page
 *   -> hand the link to the background worker -> local bridge -> IDM
 *
 * If Nexus refuses to produce a link, the toast offers a fallback link to the
 * normal file page (with nd_auto=1, which makes this script retry once).
 */

(() => {
  const U = globalThis.NexusDownloader;
  const FL = globalThis.NexusFileLink;
  if (!U || !FL) return;

  // Link resolution lives in lib/file-link.js so the Collections queue uses the
  // exact same GenerateDownloadUrl / fallback path as the one-click flow.
  const {
    markAdTimerCookie,
    fetchText,
    callGenerateDownloadUrl,
    fetchApiRoute,
    fetchFilePageDownloadUrl
  } = FL;

  const DEFAULTS = {
    enabled: true,
    autoIntercept: true,
    devAllDownloads: false,
    clickDownload: true
  };

  let settings = Object.assign({}, DEFAULTS);
  const settingsReady = chrome.storage.local
    .get({ settings: DEFAULTS })
    .then((data) => {
      settings = Object.assign({}, DEFAULTS, data.settings || {});
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = Object.assign({}, DEFAULTS, changes.settings.newValue || {});
  });

  // -------------------------------------------------------------------------
  // small async helpers
  // -------------------------------------------------------------------------

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: '扩展后台没有响应' });
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function reportEvent(ok, text) {
    try {
      chrome.runtime.sendMessage({ type: 'nd:log', ok, message: text, url: location.href }).catch(() => {});
    } catch (_) {
      /* extension context may be gone */
    }
  }

  // Nexus's free-download gate reads an `ab` cookie for its ad timer; that and
  // the raw fetch helper live in lib/file-link.js next to GenerateDownloadUrl.

  // -------------------------------------------------------------------------
  // toast
  // -------------------------------------------------------------------------

  let toastHost = null;
  let hideTimer = null;

  function buildToast() {
    if (toastHost && document.documentElement.contains(toastHost)) return toastHost;

    toastHost = document.createElement('div');
    toastHost.id = '__nexus_downloader_toast__';
    toastHost.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:auto;';

    const root = toastHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .toast {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 280px;
          max-width: 420px;
          padding: 12px 14px;
          border-radius: 12px;
          background: #16181f;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-left: 4px solid #e8871e;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
          color: #f2f3f5;
          font: 13px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif;
          animation: nd-in 180ms ease-out;
        }
        .toast.bad { border-left-color: #e5484d; }
        .icon {
          flex: 0 0 26px;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          font-size: 14px;
          font-weight: 700;
          background: rgba(232, 135, 30, 0.18);
          color: #f0a34f;
        }
        .toast.bad .icon { background: rgba(229, 72, 77, 0.18); color: #ff7b7f; }
        .body { min-width: 0; }
        .title { font-weight: 600; margin-bottom: 2px; }
        .sub {
          color: #a7acb8;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .action {
          display: inline-block;
          margin-top: 6px;
          color: #f0a34f;
          font-size: 12px;
          text-decoration: underline;
          cursor: pointer;
        }
        .action[hidden] { display: none; }
        @keyframes nd-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      </style>
      <div class="toast">
        <div class="icon">↓</div>
        <div class="body">
          <div class="title"></div>
          <div class="sub"></div>
          <a class="action" hidden></a>
        </div>
      </div>
    `;

    document.documentElement.appendChild(toastHost);
    return toastHost;
  }

  function show(opts) {
    const options = opts || {};
    const ok = options.ok !== false;
    const el = buildToast();
    const root = el.shadowRoot;

    root.querySelector('.toast').className = 'toast ' + (ok ? 'ok' : 'bad');
    root.querySelector('.icon').textContent = options.icon || (ok ? '↓' : '!');
    root.querySelector('.title').textContent =
      options.title || (ok ? 'Nexus Downloader' : 'IDM 接管失败');
    root.querySelector('.sub').textContent = options.text || '';

    const action = root.querySelector('.action');
    if (options.action && options.action.href) {
      action.hidden = false;
      action.textContent = options.action.label || '打开下载页';
      action.setAttribute('href', options.action.href);
    } else {
      action.hidden = true;
      action.removeAttribute('href');
    }

    clearTimeout(hideTimer);
    hideTimer = setTimeout(
      () => {
        if (toastHost && toastHost.parentNode) toastHost.remove();
      },
      options.keepMs || (ok ? 6000 : 12000)
    );
  }

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------

  function eventPath(event) {
    if (typeof event.composedPath === 'function') {
      return event.composedPath().filter((node) => node instanceof Element);
    }
    const path = [];
    let node = event.target;
    while (node && node instanceof Element) {
      path.push(node);
      node = node.parentElement;
    }
    return path;
  }

  function findClickable(path) {
    for (const node of path) {
      if (node.tagName === 'A' || node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') {
        return node;
      }
    }
    for (const node of path) {
      if (node.id === 'slowDownloadButton' || node.hasAttribute('data-download-url')) {
        return node;
      }
    }
    return null;
  }

  function labelOf(el) {
    const parts = [
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tracking')
    ];
    return parts
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  }

  function classify(el, path) {
    const id = el.id;
    if (id === 'slowDownloadButton' || id === 'action-manual') return 'manual';
    if (id === 'fastDownloadButton' || id === 'action-fast') return 'fast';
    if (id === 'action-vortex' || id === 'action-nmm') return 'manager';

    const inFileWidget = Boolean(
      el.closest(
        'mod-file-download, mod-download-buttons, mod-download-modal, .file-expander-header, .file-item, .mod-file-download'
      ) ||
        path.some((node) => /^(MOD-FILE-DOWNLOAD|MOD-DOWNLOAD-BUTTONS|MOD-DOWNLOAD-MODAL)$/.test(node.tagName))
    );

    let kind = U.classifyDownloadLabel(labelOf(el));
    if (kind === 'download' && !inFileWidget) kind = '';
    if (!kind && el.hasAttribute('data-download-url')) kind = 'manual';
    if (!kind && inFileWidget && /(^|[^a-z])(manual|slow|fast|download)([^a-z]|$)/i.test(labelOf(el))) {
      kind = 'download';
    }
    return kind;
  }

  function hrefOf(el) {
    const own = el.getAttribute('href');
    if (own) return own;
    const anchor = el.closest('a[href]');
    return anchor ? anchor.getAttribute('href') || '' : '';
  }

  function parseJsonLoose(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      /* maybe HTML-escaped JSON */
    }
    const decoded = String(raw)
      .replace(/&quot;/gi, '"')
      .replace(/&#0*34;/g, '"')
      .replace(/&#x0*22;/gi, '"')
      .replace(/&amp;/gi, '&');
    try {
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function isFileContainer(node) {
    if (!node || !node.tagName) return false;
    if (/^(MOD-FILE-DOWNLOAD|MOD-DOWNLOAD-BUTTONS|MOD-DOWNLOAD-MODAL)$/.test(node.tagName)) return true;
    const cls = node.classList;
    return Boolean(cls && (cls.contains('file-item') || cls.contains('file-expander-header')));
  }

  function fileIdFromNode(node) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    for (const attr of ['data-file-id', 'data-fileid', 'file-id', 'file_id', 'data-fid', 'fid', 'data-file', 'file', 'main-file']) {
      const value = U.normalizeFileId(node.getAttribute(attr));
      if (value) return value;
    }
    const dataset = node.dataset || {};
    for (const key of ['fileId', 'fileid', 'fid']) {
      const value = U.normalizeFileId(dataset[key]);
      if (value) return value;
    }
    // The web components carry the file as JSON, and a modal may only carry `uid`.
    for (const attr of ['file', 'main-file']) {
      const parsed = parseJsonLoose(node.getAttribute(attr));
      const value = U.payloadFileId(parsed);
      if (value) return value;
    }
    if (isFileContainer(node)) {
      for (const attr of ['data-id', 'id']) {
        const value = U.normalizeFileId(node.getAttribute(attr));
        if (value) return value;
      }
      if (U.normalizeFileId(dataset.id)) return U.normalizeFileId(dataset.id);
      const idMatch = /(?:^|[-_])(\d{2,})$/.exec(String(node.id || ''));
      if (idMatch) return U.normalizeFileId(idMatch[1]);
    }
    for (const attr of ['data-download-url', 'download-url']) {
      const dataUrl = node.getAttribute(attr);
      if (dataUrl) {
        const value = U.fileIdFromHref(dataUrl);
        if (value) return value;
      }
    }
    return '';
  }

  function fileIdFromPath(path) {
    for (const node of path) {
      const value = fileIdFromNode(node);
      if (value) return value;
    }
    return '';
  }

  function fileIdFromRow(path) {
    const container = path.find(isFileContainer);
    if (!container || typeof container.querySelectorAll !== 'function') return '';
    const nodes = container.querySelectorAll(
      'a[href], [data-file-id], [data-fileid], [file-id], [data-fid], [data-id]'
    );
    for (const node of nodes) {
      const value = fileIdFromNode(node) || U.fileIdFromHref(node.getAttribute('href') || '');
      if (value) return value;
    }
    return '';
  }

  function payloadFromNode(node) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    for (const attr of ['file', 'main-file', 'data-file', 'data-main-file', 'file-data', 'download-links']) {
      const raw = node.getAttribute(attr);
      if (!raw || raw.length > 200000) continue;
      const parsed = parseJsonLoose(raw);
      if (parsed) {
        return { payload: U.unwrapFilePayload(parsed), from: node.tagName.toLowerCase() + '[' + attr + ']' };
      }
    }
    for (const prop of ['file', 'mainFile', 'fileData']) {
      let value;
      try {
        value = node[prop];
      } catch (_) {
        continue;
      }
      if (!value) continue;
      const parsed = typeof value === 'string' ? parseJsonLoose(value) : value;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { payload: U.unwrapFilePayload(parsed), from: 'property:' + prop };
      }
    }
    for (const attr of ['data-download-url', 'download-url', 'downloadUrl']) {
      const downloadUrl = node.getAttribute(attr);
      if (downloadUrl) {
        return { payload: { downloadUrl }, from: node.tagName.toLowerCase() + '[' + attr + ']' };
      }
    }
    return null;
  }

  function readPayload(path) {
    for (const node of path) {
      const info = payloadFromNode(node);
      if (info) return info;
    }

    // Some layouts keep the resolved URL / file JSON next to the button, or in
    // a modal the host component owns, not on the button's own ancestor path.
    const container = path.find(isFileContainer);
    if (!container) return null;

    const urlEl = container.querySelector('[data-download-url], [download-url]');
    const url = urlEl && (urlEl.getAttribute('data-download-url') || urlEl.getAttribute('download-url'));
    if (url) return { payload: { downloadUrl: url }, from: 'sibling[download-url]' };

    const modal =
      container.querySelector('mod-download-modal, download-modal') ||
      (container.shadowRoot && container.shadowRoot.querySelector('mod-download-modal, download-modal'));
    if (modal) {
      const info = payloadFromNode(modal);
      if (info) return info;
    }

    // Nexus can portal the requirements/download modal into #next-shadow-root.
    const portal = document.getElementById('next-shadow-root');
    const portalModal =
      portal && portal.shadowRoot && portal.shadowRoot.querySelector('mod-download-modal, download-modal');
    if (portalModal && portalModal !== modal) {
      const info = payloadFromNode(portalModal);
      if (info) return info;
    }

    if (typeof container.querySelectorAll === 'function') {
      const payloadNodes = container.querySelectorAll(
        '[file], [main-file], [data-file], [data-main-file], [file-data], [download-links]'
      );
      for (const node of payloadNodes) {
        const info = payloadFromNode(node);
        if (info) return info;
      }
    }
    return null;
  }

  function ancestorChain(node) {
    const chain = [];
    let current = node;
    let guard = 0;
    while (current && guard < 60) {
      guard += 1;
      if (current instanceof Element) chain.push(current);
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      if (root && root.host) {
        current = root.host;
        continue;
      }
      break;
    }
    return chain;
  }

  function payloadFromDocument() {
    const nodes = document.querySelectorAll(
      '[data-download-url], mod-file-download, mod-download-buttons, [data-file-id], [data-fileid], [file-id]'
    );
    for (const node of nodes) {
      const info = readPayload(ancestorChain(node));
      if (info && info.payload) return info.payload;
    }
    return null;
  }

  function attrSnapshot(node) {
    const out = {};
    const attributes = node.attributes || [];
    for (let i = 0; i < attributes.length && Object.keys(out).length < 14; i += 1) {
      const name = attributes[i].name;
      if (!/file|download|game|id|fid|data-|href|class|name|label/i.test(name)) continue;
      out[name] = String(attributes[i].value || '').slice(0, 300);
    }
    return out;
  }

  function describeClick(el, path, extra) {
    return Object.assign(
      {
        at: new Date().toISOString(),
        url: location.href,
        label: labelOf(el).slice(0, 200),
        href: hrefOf(el),
        html: String(el.outerHTML || '').slice(0, 1200),
        chain: path.slice(0, 6).map((node) => ({
          tag: String(node.tagName || '').toLowerCase(),
          id: node.id || '',
          class: typeof node.className === 'string' ? node.className.slice(0, 120) : '',
          attrs: attrSnapshot(node)
        }))
      },
      extra || {}
    );
  }

  let nextDataGameId;
  function gameIdFromNextData() {
    if (nextDataGameId !== undefined) return nextDataGameId;
    const script = document.getElementById('__NEXT_DATA__');
    if (!script || !script.textContent) return '';
    nextDataGameId = '';
    try {
      const data = JSON.parse(script.textContent);
      const props = data && data.props && data.props.pageProps;
      const id =
        (props && props.game && props.game.id) ||
        (props && props.gameId) ||
        (props && props.mod && props.mod.game && props.mod.game.id) ||
        '';
      if (U.digits(id)) nextDataGameId = U.digits(id);
    } catch (_) {
      /* ignore malformed NEXT_DATA */
    }
    return nextDataGameId;
  }

  function payloadHasDownload(payload) {
    const file = U.unwrapFilePayload(payload);
    if (!file) return false;
    if (U.payloadFileId(file)) return true;
    return ['downloadUrl', 'download_url', 'url'].some(
      (key) => typeof file[key] === 'string' && file[key].trim()
    );
  }

  function gameIdFromDocument() {
    const ids = new Set();
    for (const node of document.querySelectorAll('[data-game-id], [game-id]')) {
      const value = U.digits((node.dataset && node.dataset.gameId) || node.getAttribute('game-id'));
      if (value) ids.add(value);
    }
    if (ids.size === 1) return Array.from(ids)[0];
    if (ids.size > 1) return '';

    const scripts = Array.from(document.querySelectorAll('script')).slice(0, 128);
    for (const script of scripts) {
      const match = String(script.textContent || '').match(/\bgame_id\b\s*[:=]\s*["']?(\d{1,10})/);
      if (match) ids.add(match[1]);
      if (ids.size > 1) return '';
    }
    return ids.size === 1 ? Array.from(ids)[0] : '';
  }

  function readGameId(path, payload) {
    const fromPayload = U.payloadGameId(payload);
    if (fromPayload) return fromPayload;

    for (const node of path) {
      for (const attr of ['game-id', 'data-game-id', 'game_id']) {
        const value = U.digits(node.getAttribute && node.getAttribute(attr));
        if (value) return value;
      }
      const dataset = node.dataset || {};
      if (U.digits(dataset.gameId)) return U.digits(dataset.gameId);
    }

    const meta = document.querySelector('meta[name="game-id"]');
    if (meta) {
      const value = U.digits(meta.getAttribute('content'));
      if (value) return value;
    }

    const nextDataId = gameIdFromNextData();
    if (nextDataId) return nextDataId;

    return gameIdFromDocument();
  }

  function buildFilePageUrl(fileId, auto) {
    const modId = U.modIdFromPath(location.pathname);
    const gameDomain = U.gameDomainFromPath(location.pathname);
    const withAuto = auto !== false;
    if (modId && gameDomain) {
      return (
        'https://www.nexusmods.com/' +
        gameDomain +
        '/mods/' +
        modId +
        '?tab=files&file_id=' +
        encodeURIComponent(fileId) +
        (withAuto ? '&nd_auto=1' : '')
      );
    }
    const url = new URL(location.href);
    url.searchParams.set('tab', 'files');
    url.searchParams.set('file_id', fileId);
    if (withAuto) url.searchParams.set('nd_auto', '1');
    else url.searchParams.delete('nd_auto');
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // link resolution
  // -------------------------------------------------------------------------

  async function resolveGameId(domain) {
    if (!domain) return '';
    const response = await sendMessage({ type: 'nd:resolveGameId', domain });
    return response && response.ok ? U.digits(response.gameId) : '';
  }

  async function resolvePrimaryFile(gameDomain, modId) {
    if (!gameDomain || !U.digits(modId)) return null;
    const response = await sendMessage({ type: 'nd:resolvePrimaryFileId', gameDomain, modId });
    if (!response || !response.ok || !U.digits(response.fileId)) return null;
    return { fileId: U.digits(response.fileId), fileName: response.fileName || '' };
  }

  async function resolveFileName(gameDomain, modId, fileId) {
    if (!gameDomain || !U.digits(modId) || !U.digits(fileId)) return '';
    const response = await sendMessage({
      type: 'nd:resolveFileName',
      gameDomain,
      modId,
      fileId
    });
    return response && response.ok ? String(response.fileName || '') : '';
  }

  async function resolveDownloadUrl(payload, fileId, gameId, gameDomain, href) {
    const file = U.unwrapFilePayload(payload);
    const candidates = [];
    if (file) {
      for (const key of ['downloadUrl', 'download_url', 'url']) {
        const value = file[key];
        if (typeof value === 'string' && value.trim()) {
          try {
            candidates.push(new URL(value.trim(), location.href).href);
          } catch (_) {
            /* ignore malformed URL */
          }
        }
      }
    }

    if (href) {
      try {
        const absoluteHref = new URL(href, location.href).href;
        if (U.isNexusApiFileRoute(absoluteHref)) {
          const resolved = await fetchApiRoute(absoluteHref, fileId);
          if (resolved) return { url: resolved, gameId, via: 'api-route' };
        }
      } catch (_) {
        /* not a usable href */
      }
    }

    for (const candidate of candidates) {
      if (U.isDirectCdnUrl(candidate)) return { url: candidate, gameId, via: 'page-data' };
    }

    for (const candidate of candidates) {
      if (U.isNexusApiFileRoute(candidate)) {
        const resolved = await fetchApiRoute(candidate, fileId);
        if (resolved) return { url: resolved, gameId, via: 'page-data-route' };
      }
    }

    for (const candidate of candidates) {
      if (/ModRequirementsPopUp|DownloadPopUp|RequirementsPopUp/i.test(candidate)) {
        try {
          const text = await fetchText(candidate);
          const url = U.parseDownloadUrlResponse(text);
          if (url) return { url, gameId, via: 'requirements-popup' };
        } catch (_) {
          /* try the API next */
        }
      }
    }

    if (!fileId) return { url: '', gameId, error: '没有找到 file_id' };

    let effectiveGameId = gameId;
    let lastError;
    try {
      return { url: await callGenerateDownloadUrl(fileId, effectiveGameId, gameDomain), gameId: effectiveGameId, via: 'api' };
    } catch (err) {
      lastError = err;
      // A free account's first request may be answered with [] until the page's
      // ad-timer cookie is present; mark it and retry once.
      if (markAdTimerCookie()) {
        try {
          return {
            url: await callGenerateDownloadUrl(fileId, effectiveGameId, gameDomain),
            gameId: effectiveGameId,
            via: 'api+ad-timer'
          };
        } catch (retryError) {
          lastError = retryError;
        }
      }
    }

    if (!U.digits(effectiveGameId) && gameDomain) {
      const resolved = await resolveGameId(gameDomain);
      if (resolved) {
        effectiveGameId = resolved;
        try {
          return {
            url: await callGenerateDownloadUrl(fileId, effectiveGameId, gameDomain),
            gameId: effectiveGameId,
            via: 'api+graphql'
          };
        } catch (err) {
          lastError = err;
        }
      }
    }

    // The manual download page itself often carries the signed link in
    // <mod-file-download download-url="…"> even when the generator refuses.
    try {
      const pageUrl = await fetchFilePageDownloadUrl(fileId);
      if (pageUrl) {
        const absolutePageUrl = new URL(pageUrl, location.href).href;
        if (U.isDirectCdnUrl(absolutePageUrl)) {
          return { url: absolutePageUrl, gameId: effectiveGameId, via: 'file-page' };
        }
        if (U.isNexusApiFileRoute(absolutePageUrl)) {
          const resolved = await fetchApiRoute(absolutePageUrl, fileId);
          if (resolved) return { url: resolved, gameId: effectiveGameId, via: 'file-page-route' };
        }
      }
    } catch (_) {
      /* keep trying */
    }

    // Nexus also exposes /api/files/<uid>/download, where uid is
    // gameId * 2^32 + fileId. Fetch it the way a click would.
    if (U.digits(effectiveGameId)) {
      try {
        const uid = (BigInt(effectiveGameId) * 4294967296n + BigInt(fileId)).toString();
        const resolved = await fetchApiRoute(`${location.origin}/api/files/${uid}/download`, fileId);
        if (resolved) return { url: resolved, gameId: effectiveGameId, via: 'api-route-uid' };
      } catch (_) {
        /* keep trying */
      }
    }

    // Last resort: the old widget endpoints sometimes bypass the API gate.
    for (const widget of ['DownloadPopUp', 'ModRequirementsPopUp']) {
      try {
        const widgetUrl =
          '/Core/Libs/Common/Widgets/' +
          widget +
          '?id=' +
          encodeURIComponent(fileId) +
          (effectiveGameId ? '&game_id=' + encodeURIComponent(effectiveGameId) : '');
        const text = await fetchText(widgetUrl);
        const url = U.parseDownloadUrlResponse(text);
        if (url) return { url, gameId: effectiveGameId, via: 'widget' };
      } catch (_) {
        /* keep trying */
      }
    }

    return {
      url: '',
      gameId: effectiveGameId,
      error: (lastError && lastError.message) || '未能取得下载链接'
    };
  }

  // -------------------------------------------------------------------------
  // click interception
  // -------------------------------------------------------------------------

  const busy = new WeakSet();

  function isExtensionToast(path) {
    return path.some((node) => node.id === '__nexus_downloader_toast__');
  }

  async function handleDownloadClick(event) {
    if (event.type === 'auxclick') {
      if (event.button !== 1) return;
    } else if (event.button !== 0 && event.button !== undefined) {
      return;
    }

    if (event.defaultPrevented) return;
    if (!settings.enabled || !settings.clickDownload) return;
    if (!(event.target instanceof Element)) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (!/\/mods\/\d+\/?$/.test(location.pathname)) return;

    const path = eventPath(event);
    if (isExtensionToast(path)) return;

    const el = findClickable(path);
    if (!el) return;
    if (el.closest('nav, .nav, .pagination, .comment-container, .comment-content, .forum-post, .header-nav, .search-results')) {
      return;
    }

    const kind = classify(el, path);
    if (!kind || kind === 'manager') return;

    const href = hrefOf(el);
    if (/^nxm:/i.test(href) || /[?&]nmm=1(?:&|$)/i.test(href)) return;

    const payloadInfo = readPayload(path);
    const payload = payloadInfo ? payloadInfo.payload : null;
    const payloadFileId = U.payloadFileId(payload);
    const hrefFileId = U.fileIdFromHref(href);
    const attrFileId = fileIdFromPath(path);
    const rowFileId = fileIdFromRow(path);
    // A file-row link is more specific than a page-level payload; never let the
    // main-file widget override the file the user actually clicked.
    let fileId = hrefFileId || payloadFileId || attrFileId || rowFileId || U.fileIdFromHref(location.href);
    const otherFileId = hrefFileId || attrFileId || rowFileId;
    let matchingPayload = U.selectPayloadForFile(payload, fileId);
    if (payloadFileId && otherFileId && payloadFileId !== otherFileId) matchingPayload = null;
    const gameDomain = U.gameDomainFromPath(location.pathname);
    const gameId = readGameId(path, matchingPayload) || '';

    event.preventDefault();
    event.stopImmediatePropagation();

    if (busy.has(el)) return;
    busy.add(el);

    show({
      ok: true,
      icon: '…',
      text: '正在解析下载链接…',
      keepMs: 20000
    });

    let usedPrimaryFile = false;
    let primaryFileName = '';

    if (!fileId && !payloadHasDownload(matchingPayload)) {
      // Page-level "Manual download" buttons know only the mod; Nexus resolves
      // the primary file via GraphQL. Try that before giving up.
      const modId = U.modIdFromPath(location.pathname);
      if (modId && gameDomain) {
        const primary = await resolvePrimaryFile(gameDomain, modId);
        if (primary) {
          fileId = primary.fileId;
          primaryFileName = primary.fileName;
          usedPrimaryFile = true;
        }
      }

      if (!fileId) {
        const diagnostic = describeClick(el, path, {
          payloadKeys: payload ? Object.keys(payload).slice(0, 20) : [],
          payloadFrom: payloadInfo ? payloadInfo.from : '',
          hrefFileId,
          payloadFileId,
          attrFileId,
          rowFileId,
          gameDomain,
          modId: U.modIdFromPath(location.pathname)
        });
        console.warn('[NexusDownloader] 没有找到 file_id，点击诊断：', diagnostic);
        try {
          chrome.storage.local.set({ lastDiagnostic: diagnostic });
        } catch (_) {
          /* ignore */
        }
        reportEvent(false, '没有找到 file_id（诊断已保存，可在弹窗复制）');
        show({
          ok: false,
          title: '未能直接下载',
          text: '没有找到 file_id。请打开扩展弹窗，点“复制诊断”把信息发我。',
          keepMs: 20000
        });
        busy.delete(el);
        return;
      }
    }

    try {
      const result = await resolveDownloadUrl(matchingPayload, fileId, gameId, gameDomain, href);

      if (!result.url) {
        reportEvent(false, '一键下载解析失败: ' + (result.error || 'Nexus 没有返回下载链接'));
        show({
          ok: false,
          title: '未能直接下载',
          text: result.error || 'Nexus 没有返回下载链接',
          action: fileId ? { label: '打开下载页', href: buildFilePageUrl(fileId) } : null
        });
        return;
      }

      let filename =
        U.filenameFromPayload(matchingPayload, result.url) ||
        primaryFileName ||
        U.filenameFromName(el.getAttribute('download') || '') ||
        U.filenameFromName(el.getAttribute('data-filename') || '');

      if (!filename) {
        const modId = U.modIdFromPath(location.pathname);
        if (modId) filename = await resolveFileName(gameDomain, modId, fileId);
      }
      const response = await sendMessage({
        type: 'nd:clickDownload',
        url: result.url,
        filename,
        fileId,
        gameId: result.gameId || gameId,
        gameDomain,
        referrer: location.href
      });

      if (response && response.ok) {
        show({
          ok: true,
          text:
            '已交给 IDM：' +
            (filename || response.filename || '下载') +
            (usedPrimaryFile ? '（主文件）' : ''),
          keepMs: 5000
        });
      } else {
        show({
          ok: false,
          text: '发送失败：' + ((response && response.error) || '本地桥接未启动？'),
          action: fileId ? { label: '打开下载页', href: buildFilePageUrl(fileId) } : null
        });
      }
    } catch (err) {
      const message = (err && err.message) || String(err);
      reportEvent(false, '一键下载异常: ' + message);
      show({
        ok: false,
        title: '解析下载链接失败',
        text: message,
        action: fileId ? { label: '打开下载页', href: buildFilePageUrl(fileId) } : null
      });
    } finally {
      busy.delete(el);
    }
  }

  // -------------------------------------------------------------------------
  // fallback auto-start (only when the page was opened with nd_auto=1)
  // -------------------------------------------------------------------------

  let autoStartedKey = '';

  async function maybeAutoStart() {
    const params = new URLSearchParams(location.search);
    if (params.get('nd_auto') !== '1') return;
    if (!settings.enabled || !settings.clickDownload) return;

    const fileId = params.get('file_id') || params.get('id');
    if (!U.digits(fileId)) return;

    const key = location.pathname + '#' + fileId;
    if (autoStartedKey === key) return;
    autoStartedKey = key;

    try {
      const url = new URL(location.href);
      url.searchParams.delete('nd_auto');
      history.replaceState(null, '', url.toString());
    } catch (_) {
      /* ignore */
    }

    show({ ok: true, icon: '…', text: '正在自动解析下载链接…', keepMs: 20000 });

    const gameDomain = U.gameDomainFromPath(location.pathname);
    const pagePayload = payloadFromDocument();
    const payloadFileId = U.payloadFileId(pagePayload);
    let matchingPayload = U.selectPayloadForFile(pagePayload, fileId);
    if (payloadFileId && payloadFileId !== fileId) matchingPayload = null;
    const gameId = readGameId(ancestorChain(document.body), matchingPayload);
    const result = await resolveDownloadUrl(matchingPayload, fileId, gameId, gameDomain, location.href);

    if (!result.url) {
      show({
        ok: false,
        title: '自动下载失败',
        text: (result.error || 'Nexus 没有返回下载链接') + '；可直接点页面上的 Slow download 重试'
      });
      return;
    }

    let autoFilename = U.filenameFromPayload(matchingPayload, result.url);
    if (!autoFilename) {
      const modId = U.modIdFromPath(location.pathname);
      if (modId) autoFilename = await resolveFileName(gameDomain, modId, fileId);
    }

    const response = await sendMessage({
      type: 'nd:clickDownload',
      url: result.url,
      filename: autoFilename,
      fileId,
      gameId: result.gameId || gameId,
      gameDomain,
      referrer: location.href
    });

    if (response && response.ok) {
      show({ ok: true, text: '已交给 IDM：' + (response.filename || '下载'), keepMs: 5000 });
    } else {
      show({
        ok: false,
        text: '发送失败：' + ((response && response.error) || '本地桥接未启动？')
      });
    }
  }

  // -------------------------------------------------------------------------
  // Cloudflare challenge probe (used by the collection verification tab)
  // -------------------------------------------------------------------------

  function probeChallengeDocument() {
    const title = document.title || '';
    const titleChallenge = /just a moment|attention required|checking your browser|verify(?:ing)? you are human|请稍候|正在验证|安全验证/i.test(
      title
    );
    let form = false;
    let turnstile = false;
    try {
      form = !!document.querySelector(
        '#challenge-form, #cf-challenge-running, .cf-browser-verification, #cf-please-wait, #challenge-stage'
      );
      const widget = document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile');
      if (widget) {
        const rect = widget.getBoundingClientRect();
        turnstile = rect.width > 0 && rect.height > 0;
      }
    } catch (_) {
      /* ignore a transient DOM state */
    }
    return {
      ok: true,
      title,
      href: location.href,
      readyState: document.readyState,
      challenge: titleChallenge || form,
      turnstile
    };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  function start() {
    window.addEventListener('click', handleDownloadClick, true);
    window.addEventListener('auxclick', handleDownloadClick, true);

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.type !== 'nd:challengeProbe') return false;
        try {
          sendResponse(probeChallengeDocument());
        } catch (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
        return false;
      });
    } catch (_) {
      /* extension context invalidated */
    }

    const runAuto = () => {
      delay(800).then(maybeAutoStart).catch(() => {});
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runAuto, { once: true });
    } else {
      runAuto();
    }
  }

  settingsReady.then(start, start);
})();
