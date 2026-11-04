'use strict';

const $ = (id) => document.getElementById(id);

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function setInlineMsg(id, text, ok) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'inline-msg' + (text ? (ok ? ' ok' : ' bad') : '');
}

function setNotice(text, title) {
  const el = $('hostHint');
  el.textContent = text || '';
  el.hidden = !text;
  el.className = 'notice';
  if (title) el.title = title;
  else el.removeAttribute('title');
}

function setStatusState(state, label) {
  $('statusPill').className = 'status-pill ' + state;
  $('statusLabel').textContent = label;
  $('statusDot').className = 'dot';
}

function setPathText(el, value, fallback) {
  const text = value || fallback || '—';
  el.textContent = '';
  for (const part of text.split(/(?<=[\\/])/)) {
    el.appendChild(document.createTextNode(part));
    if (/[\\/]$/.test(part)) el.appendChild(document.createElement('wbr'));
  }
  el.title = value || '';
}

function setSettingsLoading(loading) {
  const toggles = $('toggles');
  toggles.setAttribute('aria-busy', loading ? 'true' : 'false');
  for (const input of toggles.querySelectorAll('input')) input.disabled = loading;
  $('refreshBtn').disabled = loading;
}

function fmtTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  } catch (_) {
    return '--:--';
  }
}

function renderEmptyEvents(list) {
  const sample = document.createElement('li');
  sample.className = 'event sample';
  sample.setAttribute('aria-hidden', 'true');

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = '--:--';

  const main = document.createElement('div');
  main.className = 'main';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = '示例：MyMod-1.0.7z';

  const tag = document.createElement('span');
  tag.className = 'sample-tag';
  tag.textContent = '示例';
  title.appendChild(tag);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = '已发送到 IDM';

  main.appendChild(title);
  main.appendChild(sub);
  sample.appendChild(time);
  sample.appendChild(main);
  list.appendChild(sample);
}

function renderEvents(events) {
  const list = $('eventList');
  list.textContent = '';

  if (!Array.isArray(events) || events.length === 0) {
    renderEmptyEvents(list);
    return;
  }

  for (const ev of events) {
    const li = document.createElement('li');
    li.className = 'event ' + (ev.ok ? 'ok' : 'bad');
    li.title = ev.url || '';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(ev.at);

    const main = document.createElement('div');
    main.className = 'main';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = ev.filename || ev.url || '下载';

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = ev.message || '';

    main.appendChild(title);
    main.appendChild(sub);
    li.appendChild(time);
    li.appendChild(main);
    list.appendChild(li);
  }
}

async function refreshStatus() {
  setStatusState('loading', '检测中');
  setSettingsLoading(true);
  $('openConfigBtn').disabled = true;
  $('hostState').textContent = '检测中…';
  $('hostState').className = 'value';
  $('idmState').textContent = '—';
  $('idmState').className = 'value';
  setNotice('');

  let results;
  try {
    results = await Promise.all([
      send({ type: 'nd:ping' }),
      send({ type: 'nd:getSettings' }),
      send({ type: 'nd:getEvents' })
    ]);
  } finally {
    setSettingsLoading(false);
  }

  const [ping, settings, events] = results;

  if (settings && settings.ok) {
    const s = settings.settings;
    $('enabled').checked = !!s.enabled;
    $('clickDownload').checked = s.clickDownload !== false;
    $('autoIntercept').checked = !!s.autoIntercept;
    $('devAllDownloads').checked = !!s.devAllDownloads;
  }

  if (ping && ping.ok) {
    setStatusState(ping.idmExists ? 'ok' : 'warn', ping.idmExists ? '已连接' : 'IDM 未找到');
    $('hostState').textContent = ping.dryRun ? '已连接 (dry-run)' : '已连接';
    $('hostState').className = 'value ok';
    $('idmState').textContent = ping.idmExists ? '已找到' : '未找到';
    $('idmState').className = 'value ' + (ping.idmExists ? 'ok' : 'bad');
    setPathText($('dirState'), ping.downloadDir, '—');
    setPathText($('collectionDirState'), ping.collectionRoot, '需重启桥接');
    if (ping.configPath) {
      $('openConfigBtn').disabled = false;
      $('openConfigBtn').title = '打开 ' + ping.configPath;
    } else {
      $('openConfigBtn').title = '重启桥接后可打开配置文件';
    }
    if (!ping.idmExists) {
      setNotice('IDM 路径无效：' + (ping.idmPath || '未配置'), ping.idmPath || '');
    }
  } else {
    setStatusState('bad', '未连接');
    $('hostState').textContent = '未连接';
    $('hostState').className = 'value bad';
    $('idmState').textContent = '—';
    $('idmState').className = 'value';
    setPathText($('dirState'), '', '—');
    setPathText($('collectionDirState'), '', '—');
    $('openConfigBtn').title = '启动桥接后可打开配置文件';
    setNotice('启动本地桥接后点“刷新状态”。', ping && ping.error ? ping.error : '');
  }

  if (events && events.ok) renderEvents(events.events);
}

async function saveToggle(patch) {
  const res = await send({ type: 'nd:setSettings', patch });
  if (!res || !res.ok) {
    setInlineMsg('settingsMsg', '保存失败：' + ((res && res.error) || '未知错误'), false);
  } else {
    setInlineMsg('settingsMsg', '', true);
  }
}

async function manualSend() {
  const url = $('manualUrl').value.trim();
  const filename = $('manualName').value.trim();

  if (!/^https?:\/\//i.test(url)) {
    setInlineMsg('manualMsg', '请粘贴 http(s) 链接。', false);
    return;
  }

  const button = $('sendBtn');
  button.disabled = true;
  button.textContent = '发送中…';
  setInlineMsg('manualMsg', '', true);

  const res = await send({ type: 'nd:manual', url, filename });

  button.disabled = false;
  button.textContent = '发送';

  if (res && res.ok) {
    setInlineMsg('manualMsg', '已发送：' + (res.filename || filename || '下载'), true);
    $('manualUrl').value = '';
    $('manualName').value = '';
  } else {
    setInlineMsg('manualMsg', '发送失败：' + ((res && res.error) || '未知错误'), false);
  }

  const events = await send({ type: 'nd:getEvents' });
  if (events && events.ok) renderEvents(events.events);
}

async function openConfigFile() {
  const button = $('openConfigBtn');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '打开中…';

  let res = await send({ type: 'nd:openConfig' });
  // If the extension worker was loaded before nd:openConfig existed, fall back
  // to the bridge directly so the button still works without a worker reload.
  const staleWorker = !res || /Receiving end|message port|Could not establish/i.test((res && res.error) || '');
  if (staleWorker) {
    try {
      const response = await fetch('http://127.0.0.1:38765/openConfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store'
      });
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      if (!response.ok || !data || !data.ok) {
        res = { ok: false, error: (data && data.error) || 'HTTP ' + response.status };
      } else {
        res = data;
      }
    } catch (err) {
      res = { ok: false, error: (err && err.message) || '本地桥接未响应' };
    }
  }

  button.disabled = false;
  button.textContent = label;

  if (!res || !res.ok) {
    let reason = (res && res.error) || '扩展后台未响应';
    if (/Failed to fetch|NetworkError/i.test(reason)) reason = '本地桥接未响应，请重启桥接';
    if (reason === 'not found') reason = '桥接版本过旧，请运行 start.ps1 -Restart';
    setNotice('打开配置失败：' + reason);
  }
}

async function copyDiagnostic() {
  const button = $('diagBtn');
  const data = await chrome.storage.local.get({ lastDiagnostic: null });
  if (!data.lastDiagnostic) {
    button.textContent = '暂无诊断';
    setTimeout(() => {
      button.textContent = '复制诊断';
    }, 1500);
    return;
  }

  const text = JSON.stringify(data.lastDiagnostic, null, 2);
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (_) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand('copy');
      area.remove();
    } catch (_) {
      copied = false;
    }
  }

  button.textContent = copied ? '已复制' : '复制失败';
  setTimeout(() => {
    button.textContent = '复制诊断';
  }, 1800);
}

function bind() {
  $('enabled').addEventListener('change', (e) => saveToggle({ enabled: e.target.checked }));
  $('clickDownload').addEventListener('change', (e) => saveToggle({ clickDownload: e.target.checked }));
  $('autoIntercept').addEventListener('change', (e) => saveToggle({ autoIntercept: e.target.checked }));
  $('devAllDownloads').addEventListener('change', (e) => saveToggle({ devAllDownloads: e.target.checked }));

  $('sendBtn').addEventListener('click', manualSend);
  $('manualName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualSend();
  });
  $('manualUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualSend();
  });

  $('refreshBtn').addEventListener('click', refreshStatus);
  $('diagBtn').addEventListener('click', copyDiagnostic);

  $('openConfigBtn').addEventListener('click', openConfigFile);

  $('openDirBtn').addEventListener('click', async () => {
    const res = await send({ type: 'nd:openFolder' });
    if (!res || !res.ok) {
      setNotice('打开目录失败：' + ((res && res.error) || '未知错误'));
    }
  });

  $('clearBtn').addEventListener('click', async () => {
    await send({ type: 'nd:clearEvents' });
    renderEvents([]);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  renderEvents([]);
  refreshStatus();
});
