'use strict';

/**
 * Nexus Downloader - Collections panel.
 *
 * Lives on /games/<game>/collections/<slug>. Shows every mod in the collection,
 * lets the user pick some or all of them, and hands the files to IDM one at a
 * time: resolve a link in this page (cookies + Cloudflare clearance), send it to
 * the bridge, wait for the archive to appear in the target folder, then take a
 * paced pause before the next one.
 *
 * Nothing here bypasses a Cloudflare challenge. When Nexus asks for one the
 * queue stops on that file, offers a tab to complete the check, and probes until
 * the session works again before resuming.
 *
 * Requires: lib/nexus-utils.js, lib/collection-utils.js, lib/queue-pacing.js,
 * lib/file-link.js (all listed before this file in manifest.json).
 */
(() => {
  const U = globalThis.NexusDownloader;
  const C = globalThis.NexusCollection;
  const P = globalThis.NexusQueuePacing;
  const FL = globalThis.NexusFileLink;
  if (!U || !C || !P || !FL) return;

  const page = C.parseCollectionPath(location.pathname, location.search);
  if (!page) return;

  const HOST_ID = '__nexus_collection_panel__';
  const MAX_LOG = 200;
  const PAGE_SIZE = 300;
  const PROBE_BASE_MS = 5000;
  const PROBE_MAX_MS = 30000;
  const CHALLENGE_GIVE_UP_MS = 30 * 60 * 1000;
  const RECONCILE_INTERVAL_MS = 5000;
  const RECONCILE_HIDDEN_MS = 30000;
  const SENT_STALE_MS = 2 * 60 * 60 * 1000;

  const SETTINGS_DEFAULTS = {
    enabled: true,
    collectionPauseSeconds: 5,
    collectionMaxConcurrent: 2,
    collectionDuplicatePolicy: 'skip',
    collectionUseIdmHistory: true,
    collectionSmallestFirst: true,
    collectionOpenCheckPage: true,
    collectionFolderSuffix: true
  };

  const state = {
    ready: false,
    loading: false,
    mounted: false,
    settings: Object.assign({}, SETTINGS_DEFAULTS),
    meta: null,
    items: [],
    byKey: new Map(),
    selected: new Set(),
    status: new Map(),
    renderLimit: PAGE_SIZE,
    jobId: '',
    dir: '',
    runTotal: 0,
    runDone: 0,
    running: false,
    paused: false,
    pauseReason: '',
    abort: false,
    reconciling: false,
    lastReconcileLogAt: 0,
    cooldownUntil: 0,
    strike: 0,
    bridge: null,
    bridgeOld: false,
    preflightDone: false,
    duplicateCounts: { disk: 0, ledger: 0, idm: 0 },
    logs: [],
    phase: 'idle'
  };

  let dom = null;

  // -------------------------------------------------------------------------
  // tiny helpers
  // -------------------------------------------------------------------------

  function send(message) {
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
        resolve({ ok: false, error: (err && err.message) || String(err) });
      }
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /** Sleep that gives up early when the queue is stopped. */
  async function waitSleep(ms) {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end && !state.abort) {
      await sleep(Math.min(500, end - Date.now()));
    }
  }

  function statusOf(key) {
    let entry = state.status.get(key);
    if (!entry) {
      entry = { state: '', duplicate: '', detail: '', error: '', name: '', sentAt: 0, doneAt: 0 };
      state.status.set(key, entry);
    }
    return entry;
  }

  function statusText(item) {
    const st = statusOf(item.key);
    if (st.state === 'resolving') return '解析中…';
    if (st.state === 'sent') return '已下发，等待落盘';
    if (st.state === 'waiting') return '等待落盘…';
    if (st.state === 'done') return '已完成';
    if (st.state === 'failed') return '失败';
    if (st.state === 'skipped') return '已跳过';
    if (st.state === 'blocked') return '需人工验证';
    if (st.duplicate === 'disk') return '磁盘已存在';
    if (st.duplicate === 'ledger') return '下发过';
    if (st.duplicate === 'idm') return 'IDM 有记录';
    if (!item.available) return item.reason === 'removed' ? '已被删除' : '不可下载';
    return '待下载';
  }

  function statusClass(item) {
    const st = statusOf(item.key);
    if (st.state === 'failed') return 'bad';
    if (st.state === 'done') return 'good';
    if (st.state === 'sent' || st.state === 'waiting' || st.state === 'resolving') return 'busy';
    if (!item.available) return 'muted';
    if (st.duplicate) return 'warn';
    return '';
  }

  function log(text, level) {
    const line = { at: Date.now(), text: String(text || ''), level: level || 'info' };
    state.logs.push(line);
    if (state.logs.length > MAX_LOG) state.logs.splice(0, state.logs.length - MAX_LOG);
    if (dom && dom.log && !dom.log.hidden) {
      dom.log.appendChild(logLine(line));
      dom.log.scrollTop = dom.log.scrollHeight;
    }
  }

  function logLine(line) {
    const el = document.createElement('div');
    el.className = 'log-line ' + line.level;
    let time = '';
    try {
      time = new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false });
    } catch (_) {
      time = '';
    }
    el.textContent = time + '  ' + line.text;
    return el;
  }

  // -------------------------------------------------------------------------
  // panel shell
  // -------------------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; width: 540px; max-height: 74vh;
      display: flex; flex-direction: column;
      background: #14161c; color: #e9ecf1; border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.55);
      font: 12.5px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif; overflow: hidden;
      z-index: 2147483000;
    }
    .panel[data-collapsed="1"] .body { display: none; }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #191c24; border-bottom: 1px solid rgba(255,255,255,.08); }
    .titles { min-width: 0; flex: 1; }
    .title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: #9aa3b2; font-size: 11.5px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .head-actions { display: flex; gap: 4px; }
    .icon { width: 26px; height: 26px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: #9aa3b2; cursor: pointer; font-size: 14px; line-height: 1; }
    .icon:hover { background: rgba(255,255,255,.08); color: #fff; }
    .body { display: flex; flex-direction: column; min-height: 0; }
    .banner { margin: 10px 12px 0; padding: 9px 11px; border-radius: 9px; background: rgba(232,135,30,.14); border: 1px solid rgba(232,135,30,.35); color: #f4c48a; font-size: 12px; }
    .banner.bad { background: rgba(229,72,77,.14); border-color: rgba(229,72,77,.4); color: #ffb4b6; }
    .banner.good { background: rgba(46,160,67,.14); border-color: rgba(46,160,67,.4); color: #8fe0a2; }
    .banner a { color: #f4c48a; }
    .toolbar { display: flex; align-items: center; gap: 6px; padding: 9px 12px 4px; flex-wrap: wrap; }
    .toolbar button, .actions button { border: 1px solid rgba(255,255,255,.14); background: #1e222b; color: #dfe4ec; border-radius: 7px; padding: 5px 9px; font-size: 12px; cursor: pointer; }
    .toolbar button:hover, .actions button:hover { background: #262b36; }
    .toolbar label.check { display: inline-flex; align-items: center; gap: 5px; color: #cfd6e2; cursor: pointer; }
    .spacer { flex: 1; }
    .dir { padding: 2px 12px 8px; color: #8f98a8; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dir .path { color: #c9d1de; }
    .list { overflow: auto; min-height: 90px; max-height: 40vh; border-top: 1px solid rgba(255,255,255,.06); border-bottom: 1px solid rgba(255,255,255,.06); }
    .row { display: flex; align-items: center; gap: 9px; padding: 7px 12px; border-bottom: 1px solid rgba(255,255,255,.04); }
    .row:hover { background: rgba(255,255,255,.03); }
    .row input[type=checkbox] { flex: 0 0 auto; margin: 0; accent-color: #e8871e; }
    .row .info { min-width: 0; flex: 1; }
    .row .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .file { color: #808a99; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .size { flex: 0 0 66px; text-align: right; color: #9aa3b2; font-size: 11.5px; }
    .row .redo { flex: 0 0 auto; border: 1px solid rgba(232,135,30,.45); background: rgba(232,135,30,.12); color: #f4c48a; border-radius: 6px; padding: 2px 6px; font-size: 11px; cursor: pointer; }
    .row .redo:hover { background: rgba(232,135,30,.22); }
    .chip { flex: 0 0 auto; padding: 2px 7px; border-radius: 999px; font-size: 11px; background: rgba(255,255,255,.07); color: #aeb7c5; white-space: nowrap; }
    .chip.good { background: rgba(46,160,67,.18); color: #8fe0a2; }
    .chip.bad { background: rgba(229,72,77,.18); color: #ffb4b6; }
    .chip.busy { background: rgba(56,139,253,.18); color: #9ec7ff; }
    .chip.warn { background: rgba(232,135,30,.18); color: #f4c48a; }
    .chip.muted { background: rgba(255,255,255,.05); color: #7f8794; }
    .row.unavailable .name { color: #7f8794; text-decoration: line-through; }
    .row.unavailable a { color: #9ec7ff; }
    .more { padding: 8px 12px; text-align: center; }
    .more button { width: 100%; }
    .progress { padding: 8px 12px 2px; }
    .bar { height: 5px; border-radius: 999px; background: rgba(255,255,255,.09); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#e8871e,#f0a34f); transition: width .25s ease; }
    .progress-text { color: #8f98a8; font-size: 11.5px; margin-top: 4px; }
    .actions { display: flex; align-items: center; gap: 6px; padding: 9px 12px 12px; }
    .actions .primary { background: #e8871e; border-color: #e8871e; color: #1a1305; font-weight: 600; }
    .actions .primary:hover { background: #f09a38; }
    .actions button[disabled] { opacity: .45; cursor: default; }
    .log { max-height: 150px; overflow: auto; border-top: 1px solid rgba(255,255,255,.06); padding: 6px 12px; font: 11px/1.5 Consolas, monospace; color: #9aa3b2; }
    .log-line.bad { color: #ff9a9d; }
    .log-line.good { color: #8fe0a2; }
    .settings { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; padding: 10px 12px 12px; border-top: 1px solid rgba(255,255,255,.06); }
    .settings label { display: flex; flex-direction: column; gap: 3px; color: #9aa3b2; font-size: 11px; }
    .settings input[type=number], .settings select { background: #1e222b; border: 1px solid rgba(255,255,255,.14); color: #e9ecf1; border-radius: 6px; padding: 4px 6px; font-size: 12px; }
    .settings .wide { grid-column: 1 / -1; }
    .settings button { background: #1e222b; border: 1px solid rgba(255,255,255,.14); color: #dfe4ec; border-radius: 6px; padding: 5px 8px; cursor: pointer; font-size: 11.5px; }
    .settings button:hover { background: #262b36; }
    .settings .rowcheck { flex-direction: row; align-items: center; gap: 6px; }
    .dialog { position: absolute; inset: 0; background: rgba(8,10,14,.72); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .dialog-box { width: 100%; background: #1b1f27; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 14px; }
    .dialog-title { font-weight: 600; margin-bottom: 8px; }
    .dialog-list { max-height: 150px; overflow: auto; color: #b9c1cf; font-size: 11.5px; margin-bottom: 10px; }
    .dialog-list div { padding: 2px 0; }
    .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .empty { padding: 18px 12px; color: #8f98a8; text-align: center; }
  `;

  function buildPanel() {
    if (dom && document.documentElement.contains(dom.host)) return dom;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483000;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      STYLE +
      '</style>' +
      '<div class="panel" data-collapsed="0">' +
      '  <div class="head">' +
      '    <div class="titles"><div class="title" data-el="title">Nexus Collections</div><div class="sub" data-el="sub">正在读取合集…</div></div>' +
      '    <div class="head-actions">' +
      '      <button class="icon" data-act="settings" title="下载设置">⚙</button>' +
      '      <button class="icon" data-act="collapse" title="收起">–</button>' +
      '      <button class="icon" data-act="close" title="关闭面板（刷新页面可重新打开）">×</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="body">' +
      '    <div class="banner" data-el="banner" hidden></div>' +
      '    <div class="toolbar">' +
      '      <label class="check"><input type="checkbox" data-act="all">全选</label>' +
      '      <button data-act="none">全不选</button>' +
      '      <button data-act="invert">反选</button>' +
      '      <button data-act="missing">仅缺</button>' +
      '      <span class="spacer"></span>' +
      '      <button data-act="folder">打开目录</button>' +
      '      <button data-act="sync">同步状态</button>' +
      '      <button data-act="reload">刷新列表</button>' +
      '    </div>' +
      '    <div class="dir">保存到 <span class="path" data-el="dir"></span></div>' +
      '    <div class="list" data-el="list"><div class="empty">正在读取合集…</div></div>' +
      '    <div class="more" data-el="more" hidden><button data-act="more">显示更多</button></div>' +
      '    <div class="progress"><div class="bar"><i data-el="bar"></i></div><div class="progress-text" data-el="progress"></div></div>' +
      '    <div class="actions">' +
      '      <button class="primary" data-act="start">下载选中</button>' +
      '      <button data-act="pause" hidden>暂停</button>' +
      '      <button data-act="resume" hidden>继续</button>' +
      '      <button data-act="retry">重试失败</button>' +
      '      <span class="spacer"></span>' +
      '      <button data-act="log">日志</button>' +
      '    </div>' +
      '    <div class="settings" data-el="settings" hidden>' +
      '      <label>下发间隔（秒）<input type="number" min="0" max="600" step="1" data-set="collectionPauseSeconds"></label>' +
      '      <label>最大同时下载数<input type="number" min="1" max="5" step="1" data-set="collectionMaxConcurrent"></label>' +
      '      <label>遇到重复项<select data-set="collectionDuplicatePolicy"><option value="skip">直接跳过</option><option value="ask">每次询问</option></select></label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionUseIdmHistory">把 IDM 历史算作重复</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionSmallestFirst">小文件优先</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionOpenCheckPage">人机验证时自动开页面</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionFolderSuffix">目录名带 slug</label>' +
      '      <button class="wide" data-act="resetjob">重置本合集的进度记录（不删文件）</button>' +
      '    </div>' +
      '    <div class="log" data-el="log" hidden></div>' +
      '  </div>' +
      '</div>';

    document.documentElement.appendChild(host);

    const q = (name) => root.querySelector('[data-el="' + name + '"]');
    dom = {
      host,
      root,
      panel: root.querySelector('.panel'),
      title: q('title'),
      sub: q('sub'),
      banner: q('banner'),
      list: q('list'),
      more: q('more'),
      dir: q('dir'),
      bar: q('bar'),
      progress: q('progress'),
      log: q('log'),
      settings: q('settings'),
      rows: new Map()
    };

    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    return dom;
  }

  function onClick(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path.find((node) => node instanceof Element && node.hasAttribute && node.hasAttribute('data-act'));
    if (target) {
      handleAction(target.getAttribute('data-act'), target);
      return;
    }
    // Checkboxes and selects handle themselves through change events.
    if (path.some((node) => node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLLabelElement)) {
      return;
    }
    const row = path.find((node) => node instanceof Element && node.classList && node.classList.contains('row'));
    if (!row) return;
    const key = row.getAttribute('data-key');
    const checkbox = row.querySelector('input[type=checkbox]');
    if (!checkbox || checkbox.disabled) return;
    checkbox.checked = !checkbox.checked;
    toggleKey(key, checkbox.checked);
  }

  function onChange(event) {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    if (target.getAttribute('data-act') === 'all') {
      if (target.checked) selectAll(true); else selectNone();
      renderList();
      updateSelectionUi();
      return;
    }
    if (target.type === 'checkbox' && target.closest && target.closest('.row')) {
      const row = target.closest('.row');
      toggleKey(row.getAttribute('data-key'), target.checked);
      return;
    }
    const settingKey = target.getAttribute('data-set');
    if (settingKey) {
      const value = target.type === 'checkbox' ? !!target.checked : target.value;
      saveSetting(settingKey, value);
    }
  }

  function handleAction(act, target) {
    switch (act) {
      case 'settings':
        dom.settings.hidden = !dom.settings.hidden;
        break;
      case 'collapse':
        dom.panel.setAttribute('data-collapsed', dom.panel.getAttribute('data-collapsed') === '1' ? '0' : '1');
        break;
      case 'close':
        if (state.running && !state.abort) {
          if (!window.confirm('下载正在进行，关闭面板会停止队列。确定关闭？')) return;
          stopQueue();
        }
        dom.host.remove();
        dom = null;
        state.mounted = false;
        break;
      case 'none':
        selectNone();
        renderList();
        break;
      case 'invert':
        invertSelection();
        renderList();
        break;
      case 'missing':
        selectMissing();
        renderList();
        break;
      case 'folder':
        send({ type: 'nd:collectionOpenFolder', subdir: currentSubdir() });
        break;
      case 'reload':
        if (state.running) {
          setBanner('正在下载，先暂停或停止再刷新列表。', 'bad');
          return;
        }
        loadCollection(true);
        break;
      case 'resetjob':
        resetJob();
        break;
      case 'sync':
        reconcile({ manual: true });
        break;
      case 'more':
        state.renderLimit += PAGE_SIZE;
        renderList();
        break;
      case 'start':
        startQueue();
        break;
      case 'pause':
        pauseQueue();
        break;
      case 'resume':
        resumeQueue();
        break;
      case 'retry':
        retryFailed();
        break;
      case 're-download':
        reDownload(target.getAttribute('data-key'));
        break;
      case 'log':
        dom.log.hidden = !dom.log.hidden;
        if (!dom.log.hidden) {
          dom.log.textContent = '';
          for (const line of state.logs) dom.log.appendChild(logLine(line));
          dom.log.scrollTop = dom.log.scrollHeight;
        }
        break;
      case 'dialog-skip':
      case 'dialog-replace':
      case 'dialog-cancel':
        resolveDialog(act);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------

  async function loadSettings() {
    const response = await send({ type: 'nd:getSettings' });
    if (response && response.ok && response.settings) {
      state.settings = Object.assign({}, SETTINGS_DEFAULTS, response.settings);
    }
    syncSettingsForm();
  }

  function syncSettingsForm() {
    if (!dom) return;
    for (const input of dom.settings.querySelectorAll('[data-set]')) {
      const key = input.getAttribute('data-set');
      if (!(key in SETTINGS_DEFAULTS)) continue;
      if (input.type === 'checkbox') input.checked = state.settings[key] !== false;
      else input.value = state.settings[key];
    }
  }

  async function saveSetting(key, value) {
    let normalized = value;
    if (key === 'collectionPauseSeconds') normalized = P.clamp(Number(value), 0, 600);
    if (key === 'collectionMaxConcurrent') normalized = P.normalizeConcurrent(value);
    if (key === 'collectionDuplicatePolicy') normalized = value === 'ask' ? 'ask' : 'skip';
    state.settings[key] = normalized;
    await send({ type: 'nd:setSettings', patch: { [key]: normalized } });
  }

  function currentSubdir() {
    if (!state.meta) return '';
    return C.collectionFolderName(
      { name: state.meta.name, slug: state.meta.slug },
      { suffix: state.settings.collectionFolderSuffix !== false }
    );
  }

  function pacingOptions() {
    return {
      gapSeconds: Number(state.settings.collectionPauseSeconds) || 0,
      hidden: document.visibilityState === 'hidden'
    };
  }

  function maxConcurrent() {
    return P.normalizeConcurrent(state.settings.collectionMaxConcurrent);
  }

  /**
   * Wait until fewer than maxConcurrent files are still waiting to appear on
   * disk. The cap is ours, not IDM's: IDM has no dependable global limit, and
   * letting a hundred links fire at once is exactly what we want to avoid.
   */
  async function waitForSlot() {
    while (!state.abort) {
      if (state.paused) await waitWhilePaused();
      if (state.abort) return false;
      if (pendingHandoffs().length < maxConcurrent()) return true;
      await reconcile();
      if (state.abort) return false;
      if (pendingHandoffs().length < maxConcurrent()) return true;
      updateSelectionUi();
      await sleep(1500);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // data
  // -------------------------------------------------------------------------

  async function loadCollection(force) {
    if (state.loading) return;
    state.loading = true;
    state.phase = 'loading';
    if (dom) setBanner('正在读取合集…', '');
    try {
      const response = await send({
        type: 'nd:collectionResolve',
        gameDomain: page.gameDomain,
        slug: page.slug,
        revision: page.revision || 0,
        force: !!force
      });

      if (!response || !response.ok) {
        if (dom) setBanner('读取合集失败：' + ((response && response.error) || '未知错误'), 'bad');
        log('读取合集失败：' + ((response && response.error) || '未知错误'), 'bad');
        renderEmpty('读取合集失败，可点“刷新列表”重试。');
        return;
      }

      state.meta = response.meta;
      state.items = response.items || [];
      state.byKey = new Map(state.items.map((item) => [item.key, item]));
      state.jobId = [state.meta.gameDomain, state.meta.slug, state.meta.revision].join(':');
      state.dir = '';
      state.selected = new Set();
      state.status = new Map();
      state.renderLimit = PAGE_SIZE;
      state.preflightDone = false;
      state.duplicateCounts = { disk: 0, ledger: 0, idm: 0 };
      state.phase = 'ready';

      await restoreJob(response.items);
      // Default selection: everything downloadable that is not already here.
      selectAll(state.settings.collectionDuplicatePolicy === 'ask');
      render();
      log('已读取合集：' + state.meta.name + '（' + state.items.length + ' 个 mod）');

      runPreflight();
    } finally {
      state.loading = false;
    }
  }

  async function runPreflight() {
    if (!state.items.length) return;
    const response = await send({
      type: 'nd:collectionCheck',
      subdir: currentSubdir(),
      items: state.items.map((item) => ({
        key: item.key,
        uri: item.uri,
        fileName: item.fileName
      })),
      useIdmHistory: state.settings.collectionUseIdmHistory !== false
    });

    if (!response || !response.ok) {
      const reason = (response && response.error) || '';
      if (/未启动|无法连接|Failed to fetch/i.test(reason)) {
        setBanner('本地桥接没在运行：先运行 bridge\\start.ps1，然后点“刷新列表”。', 'bad');
      } else if (response && response.bridgeMissing) {
        setBanner('本地桥接没有合集接口（版本过旧）：结束旧的 node bridge\\server.js，重新运行 bridge\\start.ps1，再刷新本页。', 'bad');
        state.bridgeOld = true;
      } else {
        setBanner('去重检查失败：' + (reason || '未知错误'), 'bad');
      }
      return;
    }

    state.dir = response.dir || '';
    state.preflightDone = true;
    state.duplicateCounts = response.counts || { disk: 0, ledger: 0, idm: 0 };

    for (const item of state.items) {
      const found = response.statuses && response.statuses[item.key];
      const st = statusOf(item.key);
      st.duplicate = (found && found.duplicate) || '';
      st.detail = (found && found.detail) || '';
    }

    selectAll(state.settings.collectionDuplicatePolicy === 'ask');
    render();

    const counts = state.duplicateCounts;
    const duplicates = counts.disk + counts.ledger + counts.idm;
    if (duplicates > 0) {
      setBanner(
        '发现 ' + duplicates + ' 个同名文件（磁盘 ' + counts.disk + ' / 下发过 ' + counts.ledger + ' / IDM ' + counts.idm +
          '），默认不勾选、也不会重复下载；要覆盖请点该行“重下”。',
        ''
      );
    } else if (response.historyError) {
      setBanner('IDM 历史读取失败，只用了磁盘与下发记录去重：' + response.historyError, '');
    } else if (!state.items.length) {
      setBanner('这个合集里没有可下载的 mod。', 'bad');
    } else {
      setBanner('', '');
    }
  }

  async function restoreJob(items) {
    const response = await send({ type: 'nd:collectionJobGet', jobId: state.jobId });
    const job = response && response.job;
    if (!job || !job.items) return;
    let restored = 0;
    for (const item of items) {
      const saved = job.items[item.key];
      if (!saved) continue;
      const st = statusOf(item.key);
      if (saved.state === 'done' || saved.state === 'sent' || saved.state === 'skipped' || saved.state === 'failed') {
        st.state = saved.state;
        st.error = saved.error || '';
        st.name = saved.name || '';
        st.sentAt = Number(saved.sentAt) || 0;
        st.doneAt = Number(saved.doneAt) || 0;
        restored += 1;
      }
    }
    if (restored > 0) {
      log('已恢复上次进度：' + restored + ' 项。', 'good');
      setBanner('已恢复上次进度（' + restored + ' 项）。点“继续”会从还没完成的开始。', 'good');
    }
  }

  function saveJob() {
    if (!state.jobId) return Promise.resolve();
    const items = {};
    for (const [key, st] of state.status) {
      if (!st.state && !st.duplicate) continue;
      items[key] = {
        state: st.state,
        error: st.error || '',
        duplicate: st.duplicate || '',
        name: st.name || '',
        sentAt: st.sentAt || 0,
        doneAt: st.doneAt || 0
      };
    }
    return send({
      type: 'nd:collectionJobSet',
      job: {
        jobId: state.jobId,
        collection: {
          gameDomain: state.meta.gameDomain,
          slug: state.meta.slug,
          name: state.meta.name,
          revision: state.meta.revision
        },
        dir: state.dir,
        items
      }
    });
  }

  // -------------------------------------------------------------------------
  // selection
  // -------------------------------------------------------------------------

  function selectable(item) {
    if (!item || !item.available) return false;
    const st = statusOf(item.key);
    if (st.state === 'done' || st.state === 'sent' || st.state === 'waiting') return false;
    return true;
  }

  function defaultSelectable(item) {
    if (!selectable(item)) return false;
    // In "ask" mode duplicates stay selected so the confirmation dialog can ask
    // about them; in "skip" mode they start unchecked and are never downloaded.
    return state.settings.collectionDuplicatePolicy === 'ask' ? true : !statusOf(item.key).duplicate;
  }

  function selectAll(keepDuplicates) {
    state.selected = new Set();
    for (const item of state.items) {
      if (keepDuplicates ? selectable(item) : defaultSelectable(item)) state.selected.add(item.key);
    }
    syncSelectAllBox();
  }

  function selectNone() {
    state.selected = new Set();
    syncSelectAllBox();
    updateSelectionUi();
  }

  function invertSelection() {
    const next = new Set();
    for (const item of state.items) {
      if (!selectable(item)) continue;
      if (!state.selected.has(item.key)) next.add(item.key);
    }
    state.selected = next;
    syncSelectAllBox();
    updateSelectionUi();
  }

  function selectMissing() {
    state.selected = new Set();
    for (const item of state.items) {
      const st = statusOf(item.key);
      if (selectable(item) && !st.duplicate && st.state !== 'done') state.selected.add(item.key);
    }
    syncSelectAllBox();
    updateSelectionUi();
  }

  function toggleKey(key, checked) {
    if (!key) return;
    if (checked) state.selected.add(key);
    else state.selected.delete(key);
    syncSelectAllBox();
    updateSelectionUi();
    updateRow(key);
  }

  function syncSelectAllBox() {
    if (!dom) return;
    const box = dom.root.querySelector('[data-act="all"]');
    if (!box) return;
    const eligible = state.items.filter(selectable).length;
    box.checked = eligible > 0 && state.selected.size >= eligible;
    box.indeterminate = state.selected.size > 0 && state.selected.size < eligible;
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  function render() {
    if (!dom || !state.meta) return;
    dom.title.textContent = state.meta.name || state.meta.slug;
    const meta = state.items.length + ' 个 mod · ' + C.formatSize(state.meta.totalSize);
    dom.sub.textContent = 'v' + state.meta.revision + ' · ' + meta;
    dom.dir.textContent = state.dir || '（点“打开目录”可创建）';
    renderList();
    updateSelectionUi();
    syncSettingsForm();
  }

  function renderEmpty(text) {
    if (!dom) return;
    dom.list.textContent = '';
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = text;
    dom.list.appendChild(el);
  }

  function renderList() {
    if (!dom) return;
    dom.list.textContent = '';
    dom.rows = new Map();

    if (!state.items.length) {
      renderEmpty(state.phase === 'loading' ? '正在读取合集…' : '没有可显示的 mod。');
      dom.more.hidden = true;
      return;
    }

    const visible = state.items.slice(0, state.renderLimit);
    const fragment = document.createDocumentFragment();
    for (const item of visible) fragment.appendChild(buildRow(item));
    dom.list.appendChild(fragment);

    dom.more.hidden = state.items.length <= state.renderLimit;
    updateSelectionUi();
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.className = 'row' + (item.available ? '' : ' unavailable');
    row.setAttribute('data-key', item.key);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.key);
    checkbox.disabled = !selectable(item);
    row.appendChild(checkbox);

    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.modName + (item.optional ? ' （可选）' : '');
    name.title = item.modName;

    const file = document.createElement('div');
    file.className = 'file';
    if (item.available) {
      const link = document.createElement('a');
      link.href = item.pageUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.uri || item.fileName || ('file ' + item.fileId);
      file.appendChild(link);
      file.appendChild(document.createTextNode(item.version ? ' · v' + item.version : ''));
    } else {
      file.textContent = item.reason === 'no-file' ? '合集里没有可下载的文件（外部来源）' : 'Nexus 上已不可用';
    }

    info.appendChild(name);
    info.appendChild(file);
    row.appendChild(info);

    const size = document.createElement('div');
    size.className = 'size';
    size.textContent = C.formatSize(item.sizeBytes);
    row.appendChild(size);

    const chip = document.createElement('div');
    chip.className = 'chip ' + statusClass(item);
    chip.textContent = statusText(item);
    if (statusOf(item.key).detail) chip.title = statusOf(item.key).detail;
    row.appendChild(chip);

    // Same name already here? Never dispatched automatically. This is the only
    // way to ask for a replacement, and it always confirms first.
    if (statusOf(item.key).duplicate && item.available) {
      const redo = document.createElement('button');
      redo.className = 'redo';
      redo.setAttribute('data-act', 're-download');
      redo.setAttribute('data-key', item.key);
      redo.textContent = '重下';
      redo.title = '删除同名旧文件后再下载（会覆盖）';
      row.appendChild(redo);
    }

    dom.rows.set(item.key, { row, chip, checkbox });
    return row;
  }

  function updateRow(key) {
    const item = state.byKey.get(key);
    const refs = dom && dom.rows.get(key);
    if (!item || !refs) return;
    refs.checkbox.checked = state.selected.has(key);
    refs.chip.className = 'chip ' + statusClass(item);
    refs.chip.textContent = statusText(item);
    refs.chip.title = statusOf(key).detail || statusOf(key).error || '';
  }

  function updateSelectionUi() {
    if (!dom || !state.meta) return;
    const chosen = Array.from(state.selected).filter((key) => state.byKey.has(key));
    const done = state.items.filter((item) => statusOf(item.key).state === 'done').length;
    const pendingDisk = state.items.filter((item) => {
      const s = statusOf(item.key).state;
      return s === 'sent' || s === 'waiting';
    }).length;
    dom.sub.textContent =
      'v' + state.meta.revision + ' · ' + state.items.length + ' 个 mod · ' + C.formatSize(state.meta.totalSize) +
      ' · 已选 ' + chosen.length;
    dom.progress.textContent =
      '已选 ' + chosen.length + ' · 已落盘 ' + done + ' · 待落盘 ' + pendingDisk +
      ' · 并发上限 ' + maxConcurrent() + ' · 间隔 ' + Math.round(P.computeGapMs(pacingOptions()) / 1000) + 's' +
      (state.runTotal ? ' · 本次 ' + state.runDone + '/' + state.runTotal : '') +
      (state.cooldownUntil > Date.now() ? ' · 限速冷却 ' + P.cooldownSecondsLeft(state.cooldownUntil) + 's' : '');
    const fraction = state.items.length ? (done / state.items.length) * 100 : 0;
    dom.bar.style.width = Math.min(100, Math.round(fraction)) + '%';

    const start = dom.root.querySelector('[data-act="start"]');
    if (start) start.disabled = state.running || chosen.length === 0;
    const pause = dom.root.querySelector('[data-act="pause"]');
    const resume = dom.root.querySelector('[data-act="resume"]');
    if (pause) pause.hidden = !state.running || state.paused;
    if (resume) resume.hidden = !state.running || !state.paused;
  }

  function setBanner(text, level, action) {
    if (!dom) return;
    dom.banner.hidden = !text;
    dom.banner.className = 'banner ' + (level || '');
    dom.banner.textContent = '';
    if (text) dom.banner.appendChild(document.createTextNode(text));
    if (action && action.href) {
      const link = document.createElement('a');
      link.href = action.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = action.label || '打开';
      link.style.marginLeft = '6px';
      dom.banner.appendChild(link);
    }
  }

  // -------------------------------------------------------------------------
  // duplicate dialog
  // -------------------------------------------------------------------------

  let dialogResolve = null;

  function askDuplicates(duplicates) {
    if (!dom) return Promise.resolve('skip');
    return new Promise((resolve) => {
      dialogResolve = resolve;
      const old = dom.root.querySelector('.dialog');
      if (old) old.remove();

      const overlay = document.createElement('div');
      overlay.className = 'dialog';

      const box = document.createElement('div');
      box.className = 'dialog-box';

      const title = document.createElement('div');
      title.className = 'dialog-title';
      title.textContent = '发现 ' + duplicates.length + ' 个同名文件（默认不重复下载）';

      const list = document.createElement('div');
      list.className = 'dialog-list';
      for (const item of duplicates.slice(0, 60)) {
        const line = document.createElement('div');
        const st = statusOf(item.key);
        line.textContent = item.modName + ' — ' + statusText(item) + (st.detail ? '（' + st.detail + '）' : '');
        list.appendChild(line);
      }
      if (duplicates.length > 60) {
        const more = document.createElement('div');
        more.textContent = '…还有 ' + (duplicates.length - 60) + ' 个';
        list.appendChild(more);
      }

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const skip = document.createElement('button');
      skip.setAttribute('data-act', 'dialog-skip');
      skip.textContent = '跳过这些（推荐）';
      const replace = document.createElement('button');
      replace.setAttribute('data-act', 'dialog-replace');
      replace.textContent = '覆盖下载（先删旧文件）';
      const cancel = document.createElement('button');
      cancel.setAttribute('data-act', 'dialog-cancel');
      cancel.textContent = '取消';
      actions.appendChild(cancel);
      actions.appendChild(skip);
      actions.appendChild(replace);

      box.appendChild(title);
      box.appendChild(list);
      box.appendChild(actions);
      overlay.appendChild(box);
      dom.panel.appendChild(overlay);
    });
  }

  function resolveDialog(act) {
    if (!dom) return;
    const overlay = dom.root.querySelector('.dialog');
    if (overlay) overlay.remove();
    if (dialogResolve) {
      const resolve = dialogResolve;
      dialogResolve = null;
      resolve(act === 'dialog-replace' ? 'replace' : act === 'dialog-skip' ? 'skip' : 'cancel');
    }
  }

  // -------------------------------------------------------------------------
  // queue
  // -------------------------------------------------------------------------

  function orderedSelection() {
    let keys = Array.from(state.selected).filter((key) => state.byKey.has(key));
    const items = keys.map((key) => state.byKey.get(key)).filter(Boolean);
    if (state.settings.collectionSmallestFirst !== false) {
      items.sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
    }
    keys = items.map((item) => item.key);
    return keys;
  }

  async function ensureBridge() {
    const ping = await send({ type: 'nd:ping' });
    if (!ping || !ping.ok) {
      setBanner('本地桥接未启动：请运行 bridge\\start.ps1，然后刷新本页。', 'bad');
      return null;
    }
    state.bridge = ping;
    const version = String(ping.bridge || '0');
    const major = Number(version.split('.')[0]) || 0;
    const minor = Number(version.split('.')[1]) || 0;
    state.bridgeOld = major < 1 && minor < 3;
    if (state.bridgeOld) {
      setBanner('桥接版本是 ' + version + '，合集接口需要 0.3.0：请结束旧的 node bridge\\server.js 并重新运行 bridge\\start.ps1，然后刷新本页。', 'bad');
      return null;
    }
    return ping;
  }

  async function startQueue() {
    if (state.running || dialogResolve || !state.items.length) return;
    const ping = await ensureBridge();
    if (!ping) return;

    const keys = orderedSelection();
    if (!keys.length) {
      setBanner('没有勾选任何 mod。', 'bad');
      return;
    }

    const duplicates = keys.map((key) => state.byKey.get(key)).filter((item) => statusOf(item.key).duplicate);
    let duplicateAction = 'skip';
    if (duplicates.length > 0 && state.settings.collectionDuplicatePolicy === 'ask') {
      const answer = await askDuplicates(duplicates);
      if (answer === 'cancel') return;
      duplicateAction = answer;
    }

    const replaceKeys = new Set();
    const plan = [];
    let skippedDuplicates = 0;
    for (const key of keys) {
      const st = statusOf(key);
      if (st.duplicate && duplicateAction !== 'replace') {
        st.state = 'skipped';
        st.error = '同名文件已存在，未重复下载（可在该行点“重下”覆盖）';
        skippedDuplicates += 1;
        continue;
      }
      if (st.duplicate) replaceKeys.add(key);
      plan.push(key);
    }

    if (!plan.length) {
      setBanner(
        skippedDuplicates
          ? '选中的都是已存在的同名文件，已全部跳过。要覆盖请在该行点“重下”。'
          : '没有可下载的项。',
        ''
      );
      renderList();
      updateSelectionUi();
      return;
    }

    if (plan.length > 50) {
      const ok = window.confirm(
        '这次要下发 ' + plan.length + ' 个文件。\n' +
          '免费账号需要逐个换链接，按当前节奏大约要 ' + estimateDuration(plan) + '。\n继续吗？'
      );
      if (!ok) return;
    }

    const subdir = currentSubdir();
    state.running = true;
    state.abort = false;
    state.paused = false;
    state.pauseReason = '';
    state.strike = 0;
    state.phase = 'running';
    state.runTotal = plan.length;
    state.runDone = 0;
    await adoptSharedCooldown();
    setBanner(
      skippedDuplicates
        ? '已跳过 ' + skippedDuplicates + ' 个同名文件（默认不重复下载）；要覆盖请点行内“重下”。'
        : '',
      ''
    );
    renderList();
    updateSelectionUi();
    log('开始下载 ' + plan.length + ' 个文件到 ' + (state.dir || subdir));

    const runKeys = plan;
    let index = 0;
    for (const key of runKeys) {
      if (state.abort) break;
      index += 1;
      const item = state.byKey.get(key);
      if (!item) continue;
      const st = statusOf(key);
      if (st.state === 'done' || st.state === 'skipped') continue;

      await waitWhilePaused();
      if (state.abort) break;
      await waitForSlot();
      if (state.abort) break;
      await waitCooldown();
      if (state.abort) break;

      let outcome = '';
      // A challenge stops the queue on this file; once the user passes it we
      // retry the same file instead of walking past it.
      for (;;) {
        outcome = await processItem(item, {
          index,
          total: runKeys.length,
          onExisting: replaceKeys.has(key) ? 'replace' : 'skip'
        });
        if (outcome === 'challenge-retry' && !state.abort) continue;
        break;
      }
      await saveJob();
      updateRow(key);
      updateSelectionUi();

      if (outcome === 'login') {
        setBanner('Nexus 要你登录：登录后点“重试失败”。', 'bad');
        stopQueue();
        break;
      }
      if (outcome === 'challenge-stop') {
        log('验证未完成，队列停下。', 'bad');
        stopQueue();
        break;
      }
      if (state.abort) break;

      const gapMs = P.computeGapMs(pacingOptions());
      log('等待 ' + Math.round(gapMs / 1000) + ' 秒后下发下一个（间隔）…');
      await waitSleep(gapMs);
      if (outcome === 'ok') state.runDone += 1;
    }

    const aborted = state.abort;
    state.running = false;
    state.abort = false;
    state.paused = false;
    state.phase = 'idle';
    state.runTotal = 0;
    state.runDone = 0;
    await saveJob();
    renderList();
    updateSelectionUi();

    const failed = state.items.filter((item) => statusOf(item.key).state === 'failed').length;
    const done = state.items.filter((item) => statusOf(item.key).state === 'done').length;
    const pendingDisk = state.items.filter((item) => {
      const s = statusOf(item.key).state;
      return s === 'sent' || s === 'waiting';
    }).length;
    if (aborted) {
      setBanner('已停止。已落盘 ' + done + ' 个，待落盘 ' + pendingDisk + ' 个，失败 ' + failed + ' 个。', '');
      log('队列已停止。', 'info');
    } else {
      setBanner(
        '本次结束：已落盘 ' + done + ' 个' +
          (pendingDisk ? '，IDM 还在下载 ' + pendingDisk + ' 个（会自动同步）' : '') +
          '，失败 ' + failed + ' 个。',
        failed ? '' : 'good'
      );
      log('队列结束：已落盘 ' + done + '，待落盘 ' + pendingDisk + '，失败 ' + failed + '。', failed ? 'bad' : 'good');
    }
  }

  function estimateDuration(keys) {
    // Time is set by the dispatch gap, not by transfer time: downloads overlap
    // up to maxConcurrent, and the next link is asked for on a fixed interval.
    const gapMs = P.computeGapMs(pacingOptions());
    const ms = gapMs * Math.max(1, keys.length);
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return '约 ' + minutes + ' 分钟';
    return '约 ' + (minutes / 60).toFixed(1) + ' 小时';
  }

  function pauseQueue() {
    if (!state.running) return;
    state.paused = true;
    state.pauseReason = state.pauseReason || 'user';
    setBanner('已暂停。点“继续”从当前这一条接着跑。', '');
    updateSelectionUi();
  }

  function resumeQueue() {
    if (!state.running) return;
    state.paused = false;
    state.pauseReason = '';
    setBanner('', '');
    updateSelectionUi();
  }

  function stopQueue() {
    state.abort = true;
    state.paused = false;
    state.running = false;
    updateSelectionUi();
  }

  function retryFailed() {
    let count = 0;
    for (const [key, st] of state.status) {
      if (st.state === 'failed') {
        st.state = '';
        st.error = '';
        state.selected.add(key);
        count += 1;
      }
    }
    if (count) {
      renderList();
      updateSelectionUi();
      setBanner('已把 ' + count + ' 个失败项重新勾选，点“下载选中”重试。', 'good');
    }
  }

  /**
   * Explicit "download this one again": the only path that may replace an
   * existing file. It always asks first, and it never creates a `(2)` copy.
   */
  async function reDownload(key) {
    if (state.running || !key) return;
    const item = state.byKey.get(key);
    if (!item) return;
    const st = statusOf(key);
    if (!st.duplicate) return;

    const ping = await ensureBridge();
    if (!ping) return;

    const name = item.uri || item.fileName || item.modName;
    const detail = st.detail ? '\n当前：' + st.detail : '';
    if (
      !window.confirm(
        '覆盖重下：' + name + detail + '\n\n会先删除目标目录里的同名文件，再让 IDM 重新下载。\n确定吗？'
      )
    ) {
      return;
    }

    state.running = true;
    state.abort = false;
    state.paused = false;
    state.runTotal = 1;
    state.runDone = 0;
    updateSelectionUi();
    try {
      const outcome = await processItem(item, { index: 1, total: 1, onExisting: 'replace' });
      if (outcome === 'ok') {
        st.duplicate = '';
        log('已覆盖重下：' + name, 'good');
      }
      await saveJob();
    } finally {
      state.running = false;
      state.abort = false;
      state.paused = false;
      state.runTotal = 0;
      state.runDone = 0;
      renderList();
      updateSelectionUi();
    }
  }

  async function resetJob() {
    if (state.running) {
      setBanner('正在下载，先停止再重置进度。', 'bad');
      return;
    }
    if (!window.confirm('清空本合集的下载进度记录？已下载的文件不会被删除。')) return;
    await send({ type: 'nd:collectionJobClear', jobId: state.jobId });
    for (const st of state.status.values()) {
      st.state = '';
      st.error = '';
    }
    state.selected = new Set();
    renderList();
    updateSelectionUi();
    await runPreflight();
    setBanner('进度记录已清空，重复项已重新检查。', 'good');
  }

  async function waitWhilePaused() {
    while (state.paused && !state.abort) {
      await sleep(300);
    }
  }

  // -------------------------------------------------------------------------
  // one item
  // -------------------------------------------------------------------------

  async function processItem(item, options) {
    const st = statusOf(item.key);
    const prefix = '[' + options.index + '/' + options.total + '] ';

    const attempts = P.DEFAULTS.retryAttempts;
    let rateLimitWaits = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (state.abort) return 'aborted';
      await waitWhilePaused();
      if (state.abort) return 'aborted';

      st.state = 'resolving';
      st.error = '';
      updateRow(item.key);

      const result = await FL.resolveByFileId(
        { fileId: item.fileId, gameId: item.gameId || state.meta.gameId, gameDomain: state.meta.gameDomain },
        { modId: item.modId }
      );

      if (result.url) {
        st.state = 'sent';
        updateRow(item.key);
        log(prefix + '已换到直链：' + item.uri, 'info');

        const response = await send({
          type: 'nd:collectionSend',
          url: result.url,
          filename: item.uri || item.fileName || '',
          subdir: currentSubdir(),
          onExisting: options.onExisting,
          key: item.key,
          fileId: item.fileId,
          gameId: item.gameId,
          modId: item.modId,
          referrer: location.href
        });

        if (response && response.ok) {
          if (response.skipped) {
            st.state = 'skipped';
            st.error = '目标目录已有同名文件';
            log(prefix + '跳过：目标目录已有 ' + (response.filename || item.uri), 'info');
          } else {
            const name = response.filename || item.uri;
            st.state = 'sent';
            st.name = name;
            st.sentAt = Date.now();
            updateRow(item.key);
            log(prefix + '已交给 IDM：' + name, 'good');
            // Fast path only: IDM may queue for a while, so completion is not
            // decided here. The reconciler below keeps checking the folder.
            const landed = await waitForDisk(name, P.diskWaitMs());
            if (landed) {
              st.state = 'done';
              st.doneAt = Date.now();
              log(prefix + '已落盘：' + name, 'good');
            } else {
              log(prefix + '已下发，IDM 还在下载（会自动同步落盘状态）', 'info');
            }
          }
          updateRow(item.key);
          return 'ok';
        }

        st.state = 'failed';
        st.error = (response && response.error) || '桥接返回失败';
        log(prefix + '下发失败：' + st.error, 'bad');
        updateRow(item.key);
        return 'failed';
      }

      const code = result.code || 'unknown';
      if (code === 'challenge') {
        const resumed = await handleChallenge(item, result);
        resetForRetry(st);
        return resumed ? 'challenge-retry' : 'challenge-stop';
      }
      if (code === 'rate_limited') {
        rateLimitWaits += 1;
        if (rateLimitWaits > 8) {
          st.state = 'failed';
          st.error = 'Nexus 连续限速，先停下';
          updateRow(item.key);
          return 'failed';
        }
        await applyRateLimit(result.retryAfterSeconds);
        resetForRetry(st);
        attempt -= 1; // waiting out a cooldown is not a failed attempt
        await waitCooldown();
        continue;
      }
      if (code === 'requires_login') {
        st.state = 'failed';
        st.error = '需要登录 Nexus';
        updateRow(item.key);
        return 'login';
      }
      if (code === 'not_found' || code === 'moderation' || code === 'access_denied' || code === 'no-file') {
        st.state = 'failed';
        st.error = result.message || code;
        updateRow(item.key);
        return 'failed';
      }

      st.state = 'failed';
      st.error = result.message || '未能取得下载链接';
      log(prefix + '失败（第 ' + attempt + ' 次）：' + st.error, 'bad');
      updateRow(item.key);
      if (attempt < attempts) {
        const wait = P.retryDelayMs(attempt);
        log(prefix + Math.round(wait / 1000) + ' 秒后重试…', 'info');
        await waitSleep(wait);
      }
    }

    return 'failed';
  }

  function resetForRetry(st) {
    if (st.state === 'resolving') st.state = '';
  }

  async function waitForDisk(name, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      if (state.abort) return false;
      const response = await send({
        type: 'nd:collectionPoll',
        subdir: currentSubdir(),
        names: [name]
      });
      const info = response && response.ok ? findFileInfo(response.files, name) : null;
      if (info && info.exists && info.size > 0) return true;
      await sleep(1000);
    }
    return false;
  }

  function findFileInfo(files, name) {
    if (!files || !name) return null;
    if (files[name]) return files[name];
    const wanted = String(name).toLowerCase();
    for (const key of Object.keys(files)) {
      if (key.toLowerCase() === wanted) return files[key];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // completion reconciliation
  // -------------------------------------------------------------------------

  /**
   * IDM has no status API, and it may sit in its own queue for tens of seconds
   * before it moves an archive into the target folder. Rather than guessing a
   * timeout, the folder itself is the source of truth: every few seconds we ask
   * the bridge once for all files we have handed over but not seen yet, and mark
   * the ones that appeared as done. One request, no IDM parsing.
   */
  function pendingHandoffs() {
    return state.items.filter((item) => {
      const st = statusOf(item.key);
      return st.state === 'sent' || st.state === 'waiting';
    });
  }

  async function reconcile(options) {
    const opts = options || {};
    if (state.reconciling || !state.meta) return { checked: 0, done: 0 };
    const pending = pendingHandoffs();
    if (!pending.length) {
      if (opts.manual) setBanner('没有等待同步的下发记录。', '');
      return { checked: 0, done: 0 };
    }

    state.reconciling = true;
    let doneCount = 0;
    const changed = [];
    try {
      for (let index = 0; index < pending.length; index += 400) {
        const chunk = pending.slice(index, index + 400);
        const names = chunk
          .map((item) => statusOf(item.key).name || C.sanitizeFilename(item.uri))
          .filter(Boolean);
        if (!names.length) continue;

        const response = await send({ type: 'nd:collectionPoll', subdir: currentSubdir(), names });
        if (!response || !response.ok) continue;

        for (const item of chunk) {
          const st = statusOf(item.key);
          const name = st.name || C.sanitizeFilename(item.uri);
          const info = findFileInfo(response.files, name);
          if (info && info.exists && info.size > 0) {
            st.state = 'done';
            st.doneAt = Date.now();
            st.error = '';
            doneCount += 1;
            changed.push(item.key);
          } else if (st.state === 'sent' && st.sentAt && Date.now() - st.sentAt > SENT_STALE_MS) {
            st.state = 'failed';
            st.error = 'IDM 超过 2 小时没有落盘，可以重试';
            changed.push(item.key);
          }
        }
      }
    } finally {
      state.reconciling = false;
      state.lastReconcileAt = Date.now();
    }

    if (changed.length) {
      for (const key of changed) updateRow(key);
      updateSelectionUi();
      await saveJob();
      if (doneCount > 0) log('同步：新确认 ' + doneCount + ' 个文件已落盘。', 'good');
      if (opts.manual) {
        setBanner('已同步：新确认 ' + doneCount + ' 个落盘。', doneCount ? 'good' : '');
      }
    } else if (opts.manual) {
      setBanner('已同步：IDM 还没有把新文件放进目录，稍后会自动再查。', '');
    }

    return { checked: pending.length, done: doneCount };
  }

  function startReconciler() {
    setInterval(() => {
      if (!state.meta) return;
      if (document.visibilityState === 'hidden' && Date.now() - state.lastReconcileAt < RECONCILE_HIDDEN_MS) {
        return;
      }
      reconcile().catch(() => {});
    }, RECONCILE_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // rate limit + challenge handling
  // -------------------------------------------------------------------------

  async function adoptSharedCooldown() {
    try {
      const data = await chrome.storage.local.get({ collectionRateLimit: 0 });
      const until = Number(data.collectionRateLimit) || 0;
      if (until > Date.now()) state.cooldownUntil = Math.max(state.cooldownUntil, until);
    } catch (_) {
      /* ignore */
    }
  }

  async function applyRateLimit(retryAfterSeconds) {
    state.strike = P.nextStrike(state.strike);
    const next = P.nextCooldown(state.cooldownUntil, state.strike, retryAfterSeconds);
    state.cooldownUntil = next.until;
    try {
      await chrome.storage.local.set({ collectionRateLimit: next.until });
    } catch (_) {
      /* ignore */
    }
    setBanner('Nexus 限速了：冷却 ' + next.seconds + ' 秒后自动继续（不会重头）。', 'bad');
    log('触发限速，冷却 ' + next.seconds + ' 秒（第 ' + state.strike + ' 次）。', 'bad');
    updateSelectionUi();
  }

  async function waitCooldown() {
    while (state.cooldownUntil > Date.now() && !state.abort) {
      if (state.paused) {
        await waitWhilePaused();
        continue;
      }
      updateSelectionUi();
      await sleep(1000);
    }
    if (state.cooldownUntil && state.cooldownUntil <= Date.now()) {
      state.cooldownUntil = 0;
      setBanner('', '');
    }
  }

  async function handleChallenge(item, result) {
    state.paused = true;
    state.pauseReason = 'challenge';
    state.strike = 0;
    setBanner(
      'N 网要求人机验证。' +
        (state.settings.collectionOpenCheckPage !== false ? '已在验证页面打开该 mod；' : '请在下方链接打开后完成验证；') +
        '通过后队列会自动继续。',
      'bad',
      item.pageUrl ? { label: '打开验证页面', href: item.pageUrl } : null
    );
    log('遇到 Cloudflare 验证，停在这一条（' + item.modName + '）。', 'bad');

    if (state.settings.collectionOpenCheckPage !== false && item.pageUrl) {
      try {
        window.open(item.pageUrl, '_blank', 'noopener');
      } catch (_) {
        /* popup blocked */
      }
    }

    const started = Date.now();
    let wait = PROBE_BASE_MS;
    while (!state.abort) {
      if (Date.now() - started > CHALLENGE_GIVE_UP_MS) {
        setBanner('验证等了太久，先停下。完成后点“重试失败”即可。', 'bad');
        log('验证超时，队列停止。', 'bad');
        break;
      }
      await sleep(wait);
      if (state.abort) break;
      if (await probeSession()) {
        state.paused = false;
        state.pauseReason = '';
        setBanner('验证已通过，继续下载。', 'good');
        log('验证通过，继续。', 'good');
        await sleep(1500 + Math.random() * 3000);
        return true;
      }
      wait = Math.min(wait + 5000, PROBE_MAX_MS);
      setBanner('仍在等待验证通过…（已经 ' + Math.round((Date.now() - started) / 1000) + ' 秒）', 'bad');
    }
    state.paused = false;
    state.pauseReason = '';
    return false;
  }

  async function probeSession() {
    try {
      const response = await fetch(location.href, {
        method: 'HEAD',
        credentials: 'include',
        cache: 'no-store'
      });
      if (response.status === 403) return false;
      if (!response.ok) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  function looksLikeChallengePage() {
    try {
      const title = document.title || '';
      if (/just a moment|attention required|请稍候/i.test(title) && !document.querySelector('mod-file-download')) {
        const html = (document.documentElement && document.documentElement.innerHTML || '').slice(0, 200000);
        return U.isCloudflareChallenge(html);
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  async function boot() {
    if (state.ready) return;
    state.ready = true;

    if (looksLikeChallengePage()) {
      try {
        sessionStorage.setItem('nd_resume_collection', location.pathname);
      } catch (_) {
        /* ignore */
      }
      return;
    }

    await loadSettings();
    buildPanel();
    state.mounted = true;
    renderEmpty('正在读取合集…');
    await loadCollection(false).catch((err) => {
      setBanner('读取合集失败：' + ((err && err.message) || String(err)), 'bad');
      renderEmpty('读取合集失败，可点“刷新列表”重试。');
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      state.settings = Object.assign({}, SETTINGS_DEFAULTS, changes.settings.newValue || {});
      syncSettingsForm();
    });

    document.addEventListener('visibilitychange', () => {
      updateSelectionUi();
      if (document.visibilityState === 'visible') reconcile().catch(() => {});
    });

    // Whatever a previous session left as "sent" gets checked against the
    // folder right away, then keeps being checked until it lands.
    reconcile().catch(() => {});
    startReconciler();
  }

  function reportBootError(err) {
    const message = (err && err.stack) || (err && err.message) || String(err);
    console.error('[NexusDownloader] 合集面板初始化失败：', err);
    try {
      chrome.runtime.sendMessage({
        type: 'nd:log',
        ok: false,
        message: '合集面板初始化失败: ' + String(message).slice(0, 400),
        url: location.href
      }).catch(() => {});
    } catch (_) {
      /* extension context may be gone */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(reportBootError), { once: true });
  } else {
    boot().catch(reportBootError);
  }
})();
