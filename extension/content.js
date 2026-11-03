'use strict';

(() => {
  let host = null;
  let hideTimer = null;

  function build() {
    if (host && document.documentElement.contains(host)) return host;

    host = document.createElement('div');
    host.id = '__nexus_downloader_toast__';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:auto;';

    const root = host.attachShadow({ mode: 'open' });
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
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);
    return host;
  }

  function show(ok, text) {
    const el = build();
    const toast = el.shadowRoot.querySelector('.toast');
    toast.className = 'toast ' + (ok ? 'ok' : 'bad');
    el.shadowRoot.querySelector('.icon').textContent = ok ? '↓' : '!';
    el.shadowRoot.querySelector('.title').textContent = ok ? 'Nexus Downloader' : 'IDM 接管失败';
    el.shadowRoot.querySelector('.sub').textContent = text || '';

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (host && host.parentNode) host.remove();
    }, 6000);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'nexus-downloader:toast') return;
    show(!!message.ok, message.text);
  });
})();
