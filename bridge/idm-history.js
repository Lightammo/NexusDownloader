'use strict';

/**
 * Nexus Downloader - read-only view of IDM's download history.
 *
 * IDM has no command line export, so we use what it leaves on disk:
 *
 *   1. HKCU\Software\DownloadManager\<id>  - one key per download in the list:
 *      Url0 / Host / Path / FileName / FR_FNCD (final name) / Status / dateAdded.
 *      The list shrinks when the user clears entries, so this is "current list".
 *   2. %APPDATA%\IDM\DwnlData\<user>\<slug>_<n>\*.log - the per-download logs,
 *      which stay after the list entry is deleted. They keep `Url ...` and the
 *      server's `Content-Disposition: ... filename="..."`, enough to recognise a
 *      file that was downloaded before.
 *   3. %APPDATA%\IDM\UrlHistory.txt - the "add URL" box history (small).
 *
 * All three are best effort: any failure returns fewer records, never an error
 * the caller has to handle.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REG_ROOT = 'HKCU\\Software\\DownloadManager';
const CACHE_MS = 60 * 1000;
const REG_TIMEOUT_MS = 5000;
const MAX_LOG_FILES = 400;
const MAX_LOG_BYTES = 16 * 1024;

let cache = { at: 0, records: [], error: '', scannedAt: 0 };

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/** reg.exe writes in the OEM code page (936 on Chinese Windows). */
function decodeConsole(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch (_) {
    return utf8;
  }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const KEY_RE = /^HKEY_[A-Z_]+\\Software\\DownloadManager\\(\d+)$/i;
const VALUE_RE = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/;

function parseRegOutput(raw) {
  const records = [];
  if (!raw) return records;

  let current = null;
  for (const line of String(raw).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      const match = KEY_RE.exec(line.trim());
      current = match ? { id: match[1], values: {} } : null;
      if (current) records.push(current);
      continue;
    }
    if (!current) continue;
    const match = VALUE_RE.exec(line);
    if (!match) continue;
    current.values[match[1]] = match[3];
  }

  const out = [];
  for (const entry of records) {
    const values = entry.values;
    const url = String(values.Url0 || '').trim();
    if (!url) continue;
    const fileName = String(values.FileName || '').split('?')[0].trim();
    out.push({
      id: entry.id,
      url,
      host: String(values.Host || '').trim(),
      path: String(values.Path || '').trim(),
      fileName,
      finalName: String(values.FR_FNCD || '').trim(),
      status: String(values.Status || '').trim(),
      dateAdded: String(values.dateAdded || '').trim(),
      source: 'registry'
    });
  }
  return out;
}

function runRegQuery() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('reg', ['query', REG_ROOT, '/s'], { windowsHide: true });
    } catch (err) {
      resolve({ text: '', error: String((err && err.message) || err) });
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      resolve({ text: decodeConsole(Buffer.concat(chunks)), error: error || '' });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      finish('reg query timed out');
    }, REG_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(String((err && err.message) || err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? '' : 'reg query exited with ' + code);
    });
  });
}

async function readRegistry() {
  const result = await runRegQuery();
  return { records: parseRegOutput(result.text), error: result.error };
}

// ---------------------------------------------------------------------------
// DwnlData logs / UrlHistory
// ---------------------------------------------------------------------------

function readTextFile(file, maxBytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(maxBytes, fs.fstatSync(fd).size);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      return decodeConsole(buffer);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return '';
  }
}

function parseLogText(raw, file) {
  if (!raw) return null;
  const urlMatch = raw.match(/^Url\s+(\S+)\s*$/im);
  if (!urlMatch) return null;
  const disposition = raw.match(/Content-Disposition:[^\r\n]*?filename\s*=\s*"([^"]+)"/i);
  const finalName = disposition ? disposition[1] : '';
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch (_) {
    mtime = 0;
  }
  return {
    id: '',
    url: urlMatch[1],
    host: '',
    path: '',
    fileName: '',
    finalName,
    status: '',
    dateAdded: '',
    at: mtime,
    source: 'log'
  };
}

function readDownloadLogs(appDataDir) {
  const out = [];
  const roots = [path.join(appDataDir, 'DwnlData')];
  for (const root of roots) {
    let users = [];
    try {
      users = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (_) {
      continue;
    }
    let seen = 0;
    for (const user of users) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(path.join(root, user.name), { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch (_) {
        continue;
      }
      for (const dir of dirs) {
        if (seen >= MAX_LOG_FILES) break;
        const dirPath = path.join(root, user.name, dir.name);
        let files = [];
        try {
          files = fs.readdirSync(dirPath).filter((name) => /\.log$/i.test(name));
        } catch (_) {
          continue;
        }
        for (const name of files) {
          if (seen >= MAX_LOG_FILES) break;
          seen += 1;
          const record = parseLogText(readTextFile(path.join(dirPath, name), MAX_LOG_BYTES), path.join(dirPath, name));
          if (record) out.push(record);
        }
      }
    }
  }
  return out;
}

function parseUrlHistory(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line))
    .map((url) => ({
      id: '',
      url,
      host: '',
      path: '',
      fileName: '',
      finalName: '',
      status: '',
      dateAdded: '',
      source: 'urlhistory'
    }));
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function idmAppDataDir() {
  if (process.env.IDM_APPDATA) return process.env.IDM_APPDATA;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'IDM');
}

function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    if (!record || !record.url) continue;
    if (seen.has(record.url)) continue;
    seen.add(record.url);
    out.push(record);
  }
  return out;
}

/**
 * @returns {Promise<{ok, records, scannedAt, error, counts}>}
 */
async function collect(options) {
  const opts = options || {};
  const now = Date.now();
  if (!opts.force && cache.at && now - cache.at < CACHE_MS) {
    return {
      ok: true,
      cached: true,
      records: cache.records,
      scannedAt: cache.scannedAt,
      error: cache.error,
      counts: cache.counts
    };
  }

  const errors = [];
  let registry = [];
  try {
    const result = await readRegistry();
    registry = result.records;
    if (result.error) errors.push(result.error);
  } catch (err) {
    errors.push(String((err && err.message) || err));
  }

  const appData = idmAppDataDir();
  let logs = [];
  let history = [];
  try {
    logs = readDownloadLogs(appData);
  } catch (err) {
    errors.push(String((err && err.message) || err));
  }
  try {
    history = parseUrlHistory(readTextFile(path.join(appData, 'UrlHistory.txt'), 512 * 1024));
  } catch (err) {
    errors.push(String((err && err.message) || err));
  }

  const records = dedupe(registry.concat(logs, history));
  const counts = {
    registry: registry.length,
    logs: logs.length,
    urlHistory: history.length,
    merged: records.length
  };

  cache = {
    at: now,
    records,
    scannedAt: now,
    error: errors.join('; '),
    counts
  };

  return { ok: true, cached: false, records, scannedAt: now, error: cache.error, counts };
}

function clearCache() {
  cache = { at: 0, records: [], error: '', scannedAt: 0 };
}

module.exports = {
  collect,
  clearCache,
  parseRegOutput,
  parseLogText,
  parseUrlHistory,
  decodeConsole,
  idmAppDataDir,
  CACHE_MS
};
