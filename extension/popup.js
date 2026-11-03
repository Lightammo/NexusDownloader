'use strict';

const $ = (id) => document.getElementById(id);

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function setMsg(text, ok) {
  const el = $('manualMsg');
  el.textContent = text || '';
  el.className = 'msg' + (text ? (ok ? ' ok' : ' bad') : '');
}

function fmtTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  } catch (_) {
    return '--:--';
  }
}

function renderEvents(events) {
  const list = $('eventList');
  list.textContent = '';

  if (!Array.isArray(events) || events.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'event empty';
    empty.textContent = '还没有记录。在 Nexus 文件页点一次下载试试。';
    list.appendChild(empty);
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
  const dot = $('statusDot');

  const [ping, settings, events] = await Promise.all([
    send({ type: 'nd:ping' }),
    send({ type: 'nd:getSettings' }),
    send({ type: 'nd:getEvents' })
  ]);

  if (settings && settings.ok) {
    const s = settings.settings;
    $('enabled').checked = !!s.enabled;
    $('clickDownload').checked = s.clickDownload !== false;
    $('autoIntercept').checked = !!s.autoIntercept;
    $('devAllDownloads').checked = !!s.devAllDownloads;
  }

  if (ping && ping.ok) {
    dot.className = 'dot ok';
    $('hostState').textContent = ping.dryRun ? '已连接 (dry-run)' : '已连接';
    $('hostState').className = 'value ok';
    $('idmState').textContent = ping.idmExists ? '已找到' : '未找到';
    $('idmState').className = 'value ' + (ping.idmExists ? 'ok' : 'bad');
    $('dirState').textContent = ping.downloadDir || '—';
    $('dirState').title = ping.downloadDir || '';
    $('hostHint').textContent = ping.idmExists
      ? ''
      : 'config.json 里的 idmPath 不存在：' + (ping.idmPath || '');
  } else {
    dot.className = 'dot bad';
    $('hostState').textContent = '未连接';
    $('hostState').className = 'value bad';
    $('idmState').textContent = '—';
    $('idmState').className = 'value';
    $('dirState').textContent = '—';
    $('dirState').title = '';
    $('hostHint').textContent = '先启动本地桥接：powershell -File bridge\\start.ps1，然后重试。';
    if (ping && ping.error) $('hostHint').title = ping.error;
  }

  if (events && events.ok) renderEvents(events.events);
}

async function saveToggle(patch) {
  const res = await send({ type: 'nd:setSettings', patch });
  if (!res || !res.ok) setMsg('保存设置失败：' + ((res && res.error) || '未知错误'), false);
}

async function manualSend() {
  const url = $('manualUrl').value.trim();
  const filename = $('manualName').value.trim();

  if (!/^https?:\/\//i.test(url)) {
    setMsg('请粘贴 http(s) 下载链接', false);
    return;
  }

  const button = $('sendBtn');
  button.disabled = true;
  button.textContent = '发送中…';
  setMsg('', true);

  const res = await send({ type: 'nd:manual', url, filename });

  button.disabled = false;
  button.textContent = '发送';

  if (res && res.ok) {
    setMsg('已发送到 IDM：' + (res.filename || filename || '下载'), true);
    $('manualUrl').value = '';
    $('manualName').value = '';
  } else {
    setMsg('失败：' + ((res && res.error) || '未知错误'), false);
  }

  const events = await send({ type: 'nd:getEvents' });
  if (events && events.ok) renderEvents(events.events);
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

  $('openDirBtn').addEventListener('click', async () => {
    const res = await send({ type: 'nd:openFolder' });
    if (!res || !res.ok) setMsg('打开失败：' + ((res && res.error) || '未知错误'), false);
  });

  $('clearBtn').addEventListener('click', async () => {
    await send({ type: 'nd:clearEvents' });
    renderEvents([]);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  refreshStatus();
});
