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
  const CU = globalThis.NexusChallenge;
  if (!U || !C || !P || !FL || !CU) return;

  const HOST_ID = '__nexus_collection_panel__';
  const MAX_LOG = 200;
  const PAGE_SIZE = 300;
  const AUTO_WAIT_MS = CU.DEFAULT_AUTO_WAIT_MS;
  const MANUAL_WAIT_MS = CU.DEFAULT_MANUAL_WAIT_MS;
  const MAX_CHALLENGE_RETRIES = CU.MAX_CHALLENGE_RETRIES;
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
    collectionWarmup: true,
    collectionFolderSuffix: true
  };

  const state = {
    ready: false,
    booting: false,
    challengeBlocked: false,
    lastBootAttemptAt: 0,
    currentPageKey: '',
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
    checkTabId: 0,
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
    if (st.state === 'resolving') return '解析中';
    if (st.state === 'sent') return '等待落盘';
    if (st.state === 'waiting') return '等待落盘';
    if (st.state === 'done') return '已完成';
    if (st.state === 'failed') return '失败';
    if (st.state === 'skipped') return '已跳过';
    if (st.state === 'blocked') return '需验证';
    if (st.duplicate === 'disk') return '已存在';
    if (st.duplicate === 'ledger') return '已下发';
    if (st.duplicate === 'idm') return 'IDM 已有';
    if (!item.available) return item.reason === 'removed' ? '已删除' : '不可下载';
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
    :host {
      all: initial;
      display: block;
      color-scheme: dark;
      font-size: 0.875rem;
      font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      line-height: 1.45;
      --nd-bg: #17191f;
      --nd-surface: #1c1f26;
      --nd-field: #20242c;
      --nd-line: rgba(255,255,255,.09);
      --nd-line-strong: rgba(255,255,255,.14);
      --nd-text: #e4e7ec;
      --nd-text-dim: #a5adba;
      --nd-text-faint: #8b94a3;
      --nd-accent: #c18a4b;
      --nd-accent-text: #d9b58e;
      --nd-focus: #9cb8d8;
      --nd-good: #a7d8b3;
      --nd-bad: #e9b1b3;
      --nd-busy: #a9c7ea;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      position: fixed;
      right: max(1rem, env(safe-area-inset-right));
      bottom: max(1rem, env(safe-area-inset-bottom));
      width: min(34rem, calc(100vw - 2rem));
      max-height: min(46rem, calc(100vh - 2rem));
      display: flex; flex-direction: column;
      background: var(--nd-bg); color: var(--nd-text);
      border: 1px solid var(--nd-line-strong);
      border-radius: 0.875rem;
      box-shadow: 0 0.75rem 2rem rgba(0,0,0,.32);
      font-size: 1em; overflow: hidden;
      z-index: 2147483000;
    }
    .panel[data-collapsed="1"] { width: min(22rem, calc(100vw - 2rem)); }
    .panel[data-collapsed="1"] .body { display: none; }
    .panel[data-collapsed="1"] .head { border-bottom-color: transparent; }
    .head {
      display: flex; align-items: center; gap: 0.75em;
      padding: 0.75em 0.875em;
      background: var(--nd-surface);
      border-bottom: 1px solid var(--nd-line);
    }
    .titles { min-width: 0; flex: 1; }
    .title { font-size: 1.071em; font-weight: 600; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: var(--nd-text-dim); font-size: 0.857em; margin-top: 0.15em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .head-actions { display: flex; gap: 0.125em; }
    .icon {
      width: 1.85em; height: 1.85em; padding: 0.35em;
      display: grid; place-items: center;
      border-radius: 0.45em; border: 1px solid transparent;
      background: transparent; color: var(--nd-text-dim);
      cursor: pointer;
    }
    .icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
    .icon:hover { background: rgba(255,255,255,.06); color: var(--nd-text); }
    .icon[data-act="settings"][aria-expanded="true"] { color: var(--nd-text); background: rgba(255,255,255,.05); }
    .panel[data-collapsed="1"] [data-act="collapse"] svg { transform: rotate(180deg); }
    .body { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .banner {
      margin: 0.625em 0.75em 0; padding: 0.55em 0.7em;
      border-radius: 0.5em;
      background: rgba(193,138,75,.10);
      border: 1px solid rgba(193,138,75,.26);
      color: var(--nd-accent-text);
      font-size: 0.857em; line-height: 1.5;
    }
    .banner.bad { background: rgba(190,116,120,.10); border-color: rgba(190,116,120,.28); color: var(--nd-bad); }
    .banner.good { background: rgba(117,164,128,.10); border-color: rgba(117,164,128,.28); color: var(--nd-good); }
    .banner a { color: var(--nd-accent-text); }
    .toolbar { display: flex; align-items: center; gap: 0.35em; padding: 0.65em 0.75em 0.25em; flex-wrap: wrap; }
    .toolbar button, .actions button, .settings button, .more button, .dialog-actions button {
      border: 1px solid var(--nd-line-strong);
      background: var(--nd-field); color: var(--nd-text);
      border-radius: 0.45em; padding: 0.4em 0.65em;
      font: inherit; font-size: 0.928em; line-height: 1.25;
      cursor: pointer;
    }
    .toolbar button:hover, .actions button:hover, .settings button:hover, .more button:hover, .dialog-actions button:hover { background: #272b34; }
    .toolbar label.check { display: inline-flex; align-items: center; gap: 0.4em; color: var(--nd-text); cursor: pointer; font-size: 0.928em; }
    .spacer { flex: 1; }
    .dir {
      padding: 0.15em 0.75em 0.6em;
      color: var(--nd-text-faint); font-size: 0.857em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dir .path { color: var(--nd-text-dim); }
    .list {
      overflow: auto; min-height: 9em;
      max-height: min(24rem, 38vh);
      border-top: 1px solid var(--nd-line);
      border-bottom: 1px solid var(--nd-line);
      scrollbar-width: thin;
      scrollbar-color: #3a404b transparent;
      overscroll-behavior: contain;
    }
    .list::-webkit-scrollbar { width: 0.45rem; }
    .list::-webkit-scrollbar-thumb { background: #3a404b; border-radius: 999px; }
    .row { display: flex; align-items: center; gap: 0.65em; padding: 0.55em 0.75em; border-bottom: 1px solid rgba(255,255,255,.045); }
    .row:last-child { border-bottom: 0; }
    .row:hover { background: rgba(255,255,255,.025); }
    .row input[type=checkbox] { flex: 0 0 auto; margin: 0; accent-color: var(--nd-accent); }
    .row .info { min-width: 0; flex: 1; }
    .row .name { color: var(--nd-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .file { color: var(--nd-text-faint); font-size: 0.857em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .file a { color: #a8c3e2; text-decoration: none; }
    .row .file a:hover { text-decoration: underline; }
    .row .size { flex: 0 0 4.8em; text-align: right; color: var(--nd-text-dim); font-size: 0.857em; }
    .row .redo {
      flex: 0 0 auto;
      border: 1px solid rgba(193,138,75,.38); background: rgba(193,138,75,.10);
      color: var(--nd-accent-text); border-radius: 0.4em;
      padding: 0.15em 0.5em; font: inherit; font-size: 0.857em; cursor: pointer;
    }
    .row .redo:hover { background: rgba(193,138,75,.18); }
    .chip {
      flex: 0 0 auto; padding: 0.15em 0.55em; border-radius: 999px;
      font-size: 0.857em;
      background: rgba(255,255,255,.055); color: var(--nd-text-dim);
      white-space: nowrap;
    }
    .chip.good { background: rgba(117,164,128,.13); color: var(--nd-good); }
    .chip.bad { background: rgba(190,116,120,.13); color: var(--nd-bad); }
    .chip.busy { background: rgba(126,156,196,.13); color: var(--nd-busy); }
    .chip.warn { background: rgba(193,138,75,.13); color: var(--nd-accent-text); }
    .chip.muted { background: rgba(255,255,255,.045); color: var(--nd-text-faint); }
    .row.unavailable .name { color: var(--nd-text-faint); text-decoration: line-through; }
    .row.unavailable a { color: #a8c3e2; }
    .more { padding: 0.6em 0.75em; text-align: center; }
    .more button { width: 100%; }
    .progress { padding: 0.6em 0.75em 0.15em; }
    .bar { height: 0.3rem; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#a97b47,#c89a63); transition: width .25s ease; }
    .progress-text { color: var(--nd-text-faint); font-size: 0.857em; margin-top: 0.3em; }
    .actions { display: flex; align-items: center; gap: 0.45em; padding: 0.65em 0.75em 0.75em; }
    .actions .primary { background: var(--nd-accent); border-color: var(--nd-accent); color: #1a130b; font-weight: 600; }
    .actions .primary:hover { background: #cc9858; }
    .actions button[disabled] { opacity: .5; cursor: default; }
    .log {
      max-height: 9.5em; overflow: auto;
      border-top: 1px solid var(--nd-line);
      padding: 0.45em 0.75em;
      font: 0.857em/1.5 Consolas, ui-monospace, monospace;
      color: var(--nd-text-dim);
    }
    .log-line.bad { color: var(--nd-bad); }
    .log-line.good { color: var(--nd-good); }
    .settings {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.6em 0.85em; padding: 0.75em;
      border-top: 1px solid var(--nd-line);
    }
    .settings label { display: flex; flex-direction: column; gap: 0.25em; color: var(--nd-text-dim); font-size: 0.857em; }
    .settings input[type=number], .settings select {
      width: 100%;
      background: var(--nd-field); border: 1px solid var(--nd-line-strong);
      color: var(--nd-text); border-radius: 0.4em;
      padding: 0.35em 0.5em; font: inherit; font-size: 1.08em;
    }
    .settings .wide { grid-column: 1 / -1; }
    .settings .rowcheck { flex-direction: row; align-items: center; gap: 0.45em; }
    .dialog { position: absolute; inset: 0; background: rgba(10,12,16,.66); display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .dialog-box { width: 100%; background: var(--nd-surface); border: 1px solid var(--nd-line-strong); border-radius: 0.75rem; padding: 0.9rem; }
    .dialog-title { font-weight: 600; margin-bottom: 0.55em; }
    .dialog-list { max-height: 9.5em; overflow: auto; color: var(--nd-text-dim); font-size: 0.928em; margin-bottom: 0.65em; }
    .dialog-list div { padding: 0.1em 0; }
    .dialog-actions { display: flex; gap: 0.5em; justify-content: flex-end; flex-wrap: wrap; }
    .empty { min-height: 10em; padding: 1.25em 0.75em; color: var(--nd-text-faint); text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6em; }
    .empty-text { max-width: 30em; color: var(--nd-text-dim); font-size: 0.928em; line-height: 1.5; }
    .empty-action { border: 1px solid var(--nd-line-strong); background: var(--nd-field); color: var(--nd-text); border-radius: 0.45em; padding: 0.4em 0.8em; font: inherit; font-size: 0.928em; cursor: pointer; }
    .empty.bad .empty-text { color: var(--nd-bad); }
    .spinner { width: 1.25em; height: 1.25em; border: 2px solid rgba(255,255,255,.14); border-top-color: var(--nd-accent-text); border-radius: 50%; animation: nd-spin .7s linear infinite; }
    @keyframes nd-spin { to { transform: rotate(360deg); } }
    .panel[data-phase="loading"] .toolbar,
    .panel[data-phase="loading"] .dir,
    .panel[data-phase="loading"] .actions { opacity: .6; }
    .panel[data-phase="loading"] .toolbar button,
    .panel[data-phase="loading"] .actions button { pointer-events: none; }
    button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
      outline: 2px solid var(--nd-focus);
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .bar i, .spinner, .icon svg { animation: none; transition: none; }
    }
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
      '<div class="panel" data-collapsed="0" data-phase="loading" role="region" aria-label="Nexus 合集下载">' +
      '  <div class="head">' +
      '    <div class="titles"><div class="title" data-el="title">Nexus Collections</div><div class="sub" data-el="sub">正在读取合集…</div></div>' +
      '    <div class="head-actions">' +
      '      <button class="icon" data-act="settings" title="下载设置" aria-label="下载设置" aria-expanded="false">' +
      '        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.6"/><circle cx="10" cy="11" r="1.6"/></svg>' +
      '      </button>' +
      '      <button class="icon" data-act="collapse" title="收起" aria-label="收起面板" aria-expanded="true">' +
      '        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>' +
      '      </button>' +
      '      <button class="icon" data-act="close" title="关闭面板" aria-label="关闭面板">' +
      '        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="body">' +
      '    <div class="banner" data-el="banner" role="status" aria-live="polite" hidden></div>' +
      '    <div class="toolbar">' +
      '      <label class="check"><input type="checkbox" data-act="all">全选</label>' +
      '      <button data-act="none">全不选</button>' +
      '      <button data-act="invert">反选</button>' +
      '      <button data-act="missing">仅缺失</button>' +
      '      <span class="spacer"></span>' +
      '      <button data-act="folder">打开目录</button>' +
      '      <button data-act="sync">同步状态</button>' +
      '      <button data-act="reload">刷新列表</button>' +
      '    </div>' +
      '    <div class="dir">保存到 <span class="path" data-el="dir">—</span></div>' +
      '    <div class="list" data-el="list" aria-busy="true"><div class="empty"><span class="spinner"></span><div class="empty-text">正在读取合集…</div></div></div>' +
      '    <div class="more" data-el="more" hidden><button data-act="more">显示更多</button></div>' +
      '    <div class="progress"><div class="bar"><i data-el="bar"></i></div><div class="progress-text" data-el="progress" aria-live="polite"></div></div>' +
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
      '      <label>并发下载数<input type="number" min="1" max="5" step="1" data-set="collectionMaxConcurrent"></label>' +
      '      <label>重复项处理<select data-set="collectionDuplicatePolicy"><option value="skip">直接跳过</option><option value="ask">每次询问</option></select></label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionUseIdmHistory">IDM 历史算作重复</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionSmallestFirst">小文件优先</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionOpenCheckPage">验证时自动处理</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionWarmup">开始前预热会话</label>' +
      '      <label class="rowcheck"><input type="checkbox" data-set="collectionFolderSuffix">目录名包含 slug</label>' +
      '      <button class="wide" data-act="resetjob">重置进度（不删文件）</button>' +
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
        setExpandedState(dom.root.querySelector('[data-act="settings"]'), !dom.settings.hidden, '下载设置');
        break;
      case 'collapse': {
        const collapsed = dom.panel.getAttribute('data-collapsed') !== '1';
        dom.panel.setAttribute('data-collapsed', collapsed ? '1' : '0');
        const button = dom.root.querySelector('[data-act="collapse"]');
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        button.setAttribute('aria-label', collapsed ? '展开面板' : '收起面板');
        button.title = collapsed ? '展开' : '收起';
        break;
      }
      case 'close':
        if (state.running && !state.abort) {
          if (!window.confirm('下载进行中，关闭会停止队列。确定关闭？')) return;
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
          setBanner('下载中，暂停后再刷新。', 'bad');
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
    setPanelPhase('loading');
    if (dom) {
      setBanner('', '');
      dom.sub.textContent = '正在读取合集…';
      renderLoading();
    }
    try {
      // Parse at call time, not at script load: Nexus is a client-side app, so
      // the panel can boot long after this file was injected.
      const page = C.parseCollectionPath(location.pathname, location.search);
      if (!page) throw new Error('当前页面不是合集页');

      const response = await send({
        type: 'nd:collectionResolve',
        gameDomain: page.gameDomain,
        slug: page.slug,
        revision: page.revision || 0,
        force: !!force
      });

      if (!response || !response.ok) {
        const reason = (response && response.error) || '未知错误';
        clearCollectionData();
        setPanelPhase('error');
        if (dom) {
          dom.sub.textContent = '读取失败';
          setBanner(reason, 'bad');
        }
        log('读取合集失败：' + reason, 'bad');
        renderEmpty('无法加载合集。', { action: 'reload', label: '重试', tone: 'bad' });
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
      setPanelPhase(state.items.length ? 'ready' : 'empty');

      await restoreJob(response.items);
      // Default selection: everything downloadable that is not already here.
      selectAll(state.settings.collectionDuplicatePolicy === 'ask');
      render();
      log('已读取合集：' + state.meta.name + '（' + state.items.length + ' 个 mod）');

      runPreflight();
    } catch (err) {
      const reason = (err && err.message) || String(err);
      clearCollectionData();
      setPanelPhase('error');
      if (dom) {
        dom.sub.textContent = '读取失败';
        setBanner(reason, 'bad');
      }
      renderEmpty('无法加载合集。', { action: 'reload', label: '重试', tone: 'bad' });
      log('读取合集失败：' + reason, 'bad');
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
        setBanner('本地桥接未运行。启动 bridge\\start.ps1 后刷新列表。', 'bad');
      } else if (response && response.bridgeMissing) {
        setBanner('桥接版本过旧（需 0.3.0）。重启 bridge\\start.ps1 后刷新。', 'bad');
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
        duplicates + ' 个同名文件已跳过：磁盘 ' + counts.disk + ' · 已下发 ' + counts.ledger + ' · IDM ' + counts.idm +
          '。点行内“重下”覆盖。',
        ''
      );
    } else if (response.historyError) {
      setBanner('IDM 历史读取失败，已按磁盘与下发记录去重。', '');
    } else if (!state.items.length) {
      setBanner('合集里没有可下载的 mod。', 'bad');
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
      setBanner('已恢复 ' + restored + ' 项进度。', 'good');
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
    dom.dir.textContent = state.dir || '尚未创建（打开目录可创建）';
    renderList();
    updateSelectionUi();
    syncSettingsForm();
  }

  function clearCollectionData() {
    state.meta = null;
    state.items = [];
    state.byKey = new Map();
    state.selected = new Set();
    state.status = new Map();
    state.dir = '';
  }

  function setPanelPhase(phase) {
    state.phase = phase;
    if (!dom) return;
    const busy = phase === 'loading';
    dom.panel.setAttribute('data-phase', phase);
    dom.list.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const control of dom.root.querySelectorAll('.toolbar button, .toolbar input, .actions button')) {
      if (busy) {
        if (control.dataset.loadDisabled === undefined) {
          control.dataset.loadDisabled = control.disabled ? '1' : '0';
        }
        control.disabled = true;
      } else if (control.dataset.loadDisabled !== undefined) {
        control.disabled = control.dataset.loadDisabled === '1';
        delete control.dataset.loadDisabled;
      }
    }
    const start = dom.root.querySelector('[data-act="start"]');
    if (start && phase === 'error') start.disabled = true;
  }

  function setExpandedState(button, expanded, label) {
    if (!button) return;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.setAttribute('aria-label', (expanded ? '收起' : '展开') + label);
  }

  function renderLoading() {
    renderEmpty('正在读取合集…', { loading: true });
  }

  function renderEmpty(text, options) {
    if (!dom) return;
    const opts = options || {};
    dom.list.textContent = '';

    const el = document.createElement('div');
    el.className = 'empty' + (opts.tone === 'bad' ? ' bad' : '');

    if (opts.loading) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      el.appendChild(spinner);
    }

    const copy = document.createElement('div');
    copy.className = 'empty-text';
    copy.textContent = text;
    el.appendChild(copy);

    if (opts.action && opts.label) {
      const button = document.createElement('button');
      button.className = 'empty-action';
      button.setAttribute('data-act', opts.action);
      button.textContent = opts.label;
      el.appendChild(button);
    }

    dom.list.appendChild(el);
  }

  function renderList() {
    if (!dom) return;
    dom.list.textContent = '';
    dom.rows = new Map();

    if (!state.items.length) {
      if (state.phase === 'loading') renderLoading();
      else if (state.phase === 'error') renderEmpty('无法加载合集。', { action: 'reload', label: '重试', tone: 'bad' });
      else renderEmpty('没有可下载的 mod。', { action: 'reload', label: '刷新列表' });
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
      file.textContent = item.reason === 'no-file' ? '合集未提供文件（外部来源）' : 'Nexus 上不可用';
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
      '已选 ' + chosen.length + ' · 完成 ' + done + '/' + state.items.length +
      (pendingDisk ? ' · 待落盘 ' + pendingDisk : '') +
      (state.running ? ' · 并发 ' + maxConcurrent() + ' · 间隔 ' + Math.round(P.computeGapMs(pacingOptions()) / 1000) + 's' : '') +
      (state.runTotal ? ' · 本次 ' + state.runDone + '/' + state.runTotal : '') +
      (state.cooldownUntil > Date.now() ? ' · 冷却 ' + P.cooldownSecondsLeft(state.cooldownUntil) + 's' : '');
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
      title.textContent = duplicates.length + ' 个同名文件已存在';

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
      skip.textContent = '全部跳过（推荐）';
      const replace = document.createElement('button');
      replace.setAttribute('data-act', 'dialog-replace');
      replace.textContent = '覆盖旧文件';
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
      setBanner('本地桥接未运行。启动 bridge\\start.ps1 后重试。', 'bad');
      return null;
    }
    state.bridge = ping;
    const version = String(ping.bridge || '0');
    const major = Number(version.split('.')[0]) || 0;
    const minor = Number(version.split('.')[1]) || 0;
    state.bridgeOld = major < 1 && minor < 3;
    if (state.bridgeOld) {
      setBanner('桥接版本过旧（' + version + '，需 0.3.0）。重启 bridge\\start.ps1 后刷新。', 'bad');
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
      setBanner('先勾选要下载的 mod。', 'bad');
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
        st.error = '同名文件已存在，已跳过';
        skippedDuplicates += 1;
        continue;
      }
      if (st.duplicate) replaceKeys.add(key);
      plan.push(key);
    }

    if (!plan.length) {
      setBanner(
        skippedDuplicates
          ? '同名文件已全部跳过。点行内“重下”可覆盖。'
          : '没有可下载的项。',
        ''
      );
      renderList();
      updateSelectionUi();
      return;
    }

    if (plan.length > 50) {
      const ok = window.confirm(
        '将下发 ' + plan.length + ' 个文件，预计 ' + estimateDuration(plan) + '。继续？'
      );
      if (!ok) return;
    }

    const subdir = currentSubdir();
    state.running = true;
    state.abort = false;
    state.paused = false;
    state.pauseReason = '';
    state.strike = 0;
    setPanelPhase('running');
    state.runTotal = plan.length;
    state.runDone = 0;
    await adoptSharedCooldown();
    setBanner(
      skippedDuplicates
        ? '已跳过 ' + skippedDuplicates + ' 个同名文件。点“重下”覆盖。'
        : '',
      ''
    );
    renderList();
    updateSelectionUi();
    log('开始下载 ' + plan.length + ' 个文件到 ' + (state.dir || subdir));

    await warmUpSession(plan);

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
      let challengeRetries = 0;
      // A challenge stops the queue on this file; once the verification tab is
      // clean we retry the same file instead of walking past it. Real requests
      // are the only proof, so the retry is the probe.
      for (;;) {
        outcome = await processItem(item, {
          index,
          total: runKeys.length,
          onExisting: replaceKeys.has(key) ? 'replace' : 'skip'
        });
        if (outcome === 'challenge-retry' && !state.abort && challengeRetries < MAX_CHALLENGE_RETRIES) {
          challengeRetries += 1;
          log('第 ' + challengeRetries + ' 次验证后重试同一文件…', 'info');
          continue;
        }
        if (outcome === 'challenge-retry') {
          st.state = 'failed';
          st.error = 'Cloudflare 验证反复失败';
          outcome = 'challenge-stop';
        }
        break;
      }
      await saveJob();
      updateRow(key);
      updateSelectionUi();

      if (outcome === 'login') {
        setBanner('需要登录 Nexus。登录后点“重试失败”。', 'bad');
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
    setPanelPhase('idle');
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
      setBanner('已停止：完成 ' + done + ' · 待落盘 ' + pendingDisk + ' · 失败 ' + failed + '。', '');
      log('队列已停止。', 'info');
    } else {
      setBanner(
        '已完成 ' + done + ' 个' +
          (pendingDisk ? '，' + pendingDisk + ' 个仍在 IDM 下载' : '') +
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
    setBanner('已暂停。点“继续”接着下载。', '');
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
      setBanner('已重新勾选 ' + count + ' 个失败项。点“下载选中”重试。', 'good');
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
        '覆盖 ' + name + '？' + detail + '\n\n会删除目标目录中的同名文件后重新下载。'
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
      setBanner('下载中，停止后再重置。', 'bad');
      return;
    }
    if (!window.confirm('重置本合集进度？已下载的文件不会删除。')) return;
    await send({ type: 'nd:collectionJobClear', jobId: state.jobId });
    for (const st of state.status.values()) {
      st.state = '';
      st.error = '';
    }
    state.selected = new Set();
    renderList();
    updateSelectionUi();
    await runPreflight();
    setBanner('进度已重置。', 'good');
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
        const resumed = await handleChallenge(item);
        if (resumed) {
          resetForRetry(st);
          return 'challenge-retry';
        }
        if (state.abort) return 'aborted';
        st.state = 'failed';
        st.error = 'Cloudflare 验证未通过';
        updateRow(item.key);
        return 'challenge-stop';
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
        setBanner('已同步：新增 ' + doneCount + ' 个落盘。', doneCount ? 'good' : '');
      }
    } else if (opts.manual) {
      setBanner('已同步：文件尚未落盘，稍后自动再查。', '');
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
    setBanner('触发限速：冷却 ' + next.seconds + ' 秒后自动继续。', 'bad');
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

  /**
   * A challenge cannot be solved from a fetch: the response is a challenge page
   * and fetch cannot run its JavaScript. So open the file page in a real tab,
   * watch it, and let the browser do what it normally does. A managed challenge
   * clears itself in a few seconds; an interactive one stays until the user
   * ticks the box, so after AUTO_WAIT_MS the tab is brought to the front once.
   *
   * The only proof that the session works again is the next real request, so
   * this returns true and the queue retries the same file instead of trusting a
   * HEAD probe.
   */
  async function handleChallenge(item) {
    state.paused = true;
    state.pauseReason = 'challenge';
    state.strike = 0;
    log('遇到 Cloudflare 验证，停在这一条（' + item.modName + '）。', 'bad');

    if (state.settings.collectionOpenCheckPage === false) {
      setBanner(
        '需要人机验证。完成验证后点“重试失败”，再点“下载选中”。',
        'bad',
        item.pageUrl ? { label: '打开验证页面', href: item.pageUrl } : null
      );
      return false;
    }

    const started = Date.now();
    let tabId = 0;
    let focused = false;

    try {
      tabId = await ensureCheckTab(item);
      if (!tabId) {
        setBanner(
          '无法自动打开验证页，请手动完成验证后点“重试失败”，再点“下载选中”。',
          'bad',
          item.pageUrl ? { label: '打开验证页面', href: item.pageUrl } : null
        );
        return false;
      }

      setBanner('N 网要求验证，已在后台打开验证页，正在等待通过…', 'bad');

      while (!state.abort) {
        const elapsed = Date.now() - started;
        if (elapsed > MANUAL_WAIT_MS) {
          setBanner(
            '验证超时，队列已停。完成验证后点“重试失败”，再点“下载选中”。',
            'bad',
            item.pageUrl ? { label: '打开验证页面', href: item.pageUrl } : null
          );
          log('验证超时（' + Math.round(elapsed / 1000) + ' 秒），队列停止。', 'bad');
          return false;
        }

        const got = await send({ type: 'nd:checkTabGet', tabId });
        if (!got || !got.ok || !got.tab) {
          state.checkTabId = 0;
          setBanner(
            '验证页已关闭。完成验证后点“重试失败”，再点“下载选中”。',
            'bad',
            item.pageUrl ? { label: '重新打开验证页', href: item.pageUrl } : null
          );
          log('验证页已关闭，队列停止。', 'bad');
          return false;
        }

        const probe = await send({ type: 'nd:checkTabProbe', tabId });
        const verdict = CU.tabState({
          tab: got.tab,
          probe: probe && probe.ok ? probe.probe : null,
          elapsedMs: elapsed,
          autoWaitMs: AUTO_WAIT_MS
        });

        if (verdict.state === 'clear') {
          await send({ type: 'nd:checkTabClose', tabId });
          state.checkTabId = 0;
          state.paused = false;
          state.pauseReason = '';
          setBanner('验证已通过，继续下载。', 'good');
          log('验证已通过（' + Math.round(elapsed / 1000) + ' 秒），继续。', 'good');
          await sleep(1200 + Math.random() * 1800);
          return true;
        }

        if (verdict.state === 'error') {
          setBanner(
            '验证页加载失败，请手动打开完成验证，再点“重试失败”。',
            'bad',
            item.pageUrl ? { label: '打开验证页面', href: item.pageUrl } : null
          );
          log('验证页加载失败。', 'bad');
          return false;
        }

        if (verdict.state === 'gone') {
          state.checkTabId = 0;
          setBanner('验证页已关闭，队列已停。', 'bad');
          return false;
        }

        if (verdict.escalate && !focused) {
          focused = true;
          await send({ type: 'nd:checkTabFocus', tabId });
          setBanner('已切到验证页：如出现“我不是机器人”，点一下即可。通过后会自动继续。', 'bad');
          log('验证页已切到前台，等待完成…', 'info');
        } else if (focused) {
          setBanner('等待验证…（' + Math.round(elapsed / 1000) + ' 秒）', 'bad');
        } else if (verdict.state === 'loading') {
          setBanner('正在加载验证页…', 'bad');
        } else {
          setBanner('等待验证页自动通过…（' + Math.round(elapsed / 1000) + ' 秒）', 'bad');
        }

        await sleep(CU.pollDelayMs(verdict.state));
      }
      return false;
    } finally {
      if (state.abort && tabId) {
        await send({ type: 'nd:checkTabClose', tabId });
        state.checkTabId = 0;
      }
      state.paused = false;
      state.pauseReason = '';
    }
  }

  /**
   * Reuse the verification tab if it is still around (a retry after a timeout
   * should not pile up tabs); navigate it to the file page so it loads again
   * with a fresh challenge. Otherwise open a background tab.
   */
  async function ensureCheckTab(item) {
    const url = item.pageUrl || FL.filePageUrl(item.fileId, state.meta.gameDomain, item.modId);
    if (!url) return 0;

    if (state.checkTabId) {
      const got = await send({ type: 'nd:checkTabGet', tabId: state.checkTabId });
      if (got && got.ok && got.tab) {
        const nav = await send({ type: 'nd:checkTabNavigate', tabId: state.checkTabId, url });
        if (nav && nav.ok) return state.checkTabId;
      }
      state.checkTabId = 0;
    }

    const opened = await send({ type: 'nd:checkTabOpen', url, active: false });
    if (!opened || !opened.ok) return 0;
    state.checkTabId = opened.tabId;
    return opened.tabId;
  }

  /**
   * Pre-load the first file page before the queue starts. This is cheap when the
   * session is already valid and surfaces a stale clearance before file #1.
   * The tab is always closed here: if it did not clear, the normal challenge
   * flow will open (and focus) a fresh one.
   */
  async function warmUpSession(plan) {
    if (!plan.length || state.abort) return;
    if (!CU.shouldWarmUp(plan.length, state.settings.collectionWarmup)) return;
    if (state.settings.collectionOpenCheckPage === false) return;

    const first = state.byKey.get(plan[0]);
    if (!first) return;

    setBanner('正在预热会话，检查登录 / 验证状态…', '');
    log('开始前预热会话…', 'info');

    const tabId = await ensureCheckTab(first);
    if (!tabId) {
      setBanner('', '');
      return;
    }

    const started = Date.now();
    try {
      while (!state.abort && Date.now() - started < 8000) {
        const got = await send({ type: 'nd:checkTabGet', tabId });
        if (!got || !got.ok || !got.tab) break;
        const probe = await send({ type: 'nd:checkTabProbe', tabId });
        const verdict = CU.tabState({
          tab: got.tab,
          probe: probe && probe.ok ? probe.probe : null,
          elapsedMs: Date.now() - started,
          autoWaitMs: AUTO_WAIT_MS
        });
        if (verdict.state === 'clear') {
          log('会话正常，开始下载。', 'good');
          break;
        }
        if (verdict.state === 'error' || verdict.state === 'gone') break;
        await sleep(700);
      }
    } finally {
      await send({ type: 'nd:checkTabClose', tabId });
      if (state.checkTabId === tabId) state.checkTabId = 0;
      setBanner('', '');
    }
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  function looksLikeChallengePage() {
    try {
      // The interstitial title is the cheap, reliable signal. Do not read the
      // whole document here: the location watcher may ask again a few times.
      const title = document.title || '';
      if (!/just a moment|attention required|请稍候/i.test(title)) return false;
      return !document.querySelector('mod-file-download');
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  async function boot() {
    if (state.ready || state.booting) return;

    const page = C.parseCollectionPath(location.pathname, location.search);
    if (!page) return;

    state.booting = true;
    try {
      if (looksLikeChallengePage()) {
        try {
          sessionStorage.setItem('nd_resume_collection', location.pathname);
        } catch (_) {
          /* ignore */
        }
        // Cloudflare may replace the challenge content in place instead of
        // reloading the document. Do not give up on this URL: syncLocation will
        // try again, slowly, until the challenge is gone.
        state.challengeBlocked = true;
        return;
      }

      state.challengeBlocked = false;
      state.ready = true;
      state.currentPageKey = pageKey(page);

      await loadSettings();
      buildPanel();
      state.mounted = true;
      setPanelPhase('loading');
      renderLoading();
      await loadCollection(false).catch((err) => {
        setPanelPhase('error');
        if (dom) {
          dom.sub.textContent = '读取失败';
          setBanner((err && err.message) || String(err), 'bad');
        }
        renderEmpty('无法加载合集。', { action: 'reload', label: '重试', tone: 'bad' });
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
    } finally {
      state.booting = false;
    }
  }

  function pageKey(page) {
    return page.gameDomain + ':' + page.slug + ':' + (page.revision || 0);
  }

  function currentPageKey() {
    const page = C.parseCollectionPath(location.pathname, location.search);
    return page ? pageKey(page) : '';
  }

  /**
   * Nexus is a client-side app: clicking a collection card updates the URL
   * without reloading the document, so this content script (and its one-time
   * boot) would otherwise keep running against the previous page. Poll the URL
   * and boot the panel when a collection page appears.
   *
   * Once the panel is bound to one collection, a move to another collection (or
   * away from collections) reloads the document. That is deliberately boring:
   * it gives the next page a clean queue, panel and listeners, and it also
   * covers the "panel left over a mod page" case without a state teardown.
   */
  function syncLocation() {
    const key = currentPageKey();

    if (!key) {
      if (state.mounted || state.running) reloadOnce();
      return;
    }

    if (state.ready && state.currentPageKey && state.currentPageKey !== key) {
      reloadOnce();
      return;
    }

    if (!state.ready && !state.booting) {
      // A standing challenge page is expensive to inspect, so retry it slowly;
      // a normal first visit boots immediately.
      const waitMs = state.challengeBlocked ? 3000 : 1000;
      if (Date.now() - state.lastBootAttemptAt < waitMs) return;
      state.lastBootAttemptAt = Date.now();
      boot().catch(reportBootError);
    }
  }

  let reloading = false;
  function reloadOnce() {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  let locationTimer = 0;
  function startLocationWatcher() {
    if (locationTimer) return;
    locationTimer = setInterval(syncLocation, 500);
    window.addEventListener('popstate', syncLocation);
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
    document.addEventListener('DOMContentLoaded', syncLocation, { once: true });
  } else {
    syncLocation();
  }
  startLocationWatcher();
})();
