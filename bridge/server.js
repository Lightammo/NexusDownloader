'use strict';

/**
 * Nexus Downloader - local bridge (MVP fallback transport)
 *
 * Runs as a normal user process and accepts requests from the browser
 * extension on http://127.0.0.1:38765. It validates the URL, then hands it to
 * IDM's command line. Keeping the IDM launch in a normal process avoids the
 * native-messaging launcher edge case seen with IDM 6.42 on this machine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Collection = require('../extension/lib/collection-utils.js');
const idmHistory = require('./idm-history.js');

const VERSION = '0.3.2';
const ROOT = __dirname;
const CONFIG_PATH = path.resolve(ROOT, '..', 'native-host', 'config.json');
const LOG_FILE = path.join(ROOT, 'bridge.log');
const PORT = Number(process.env.NEXUS_BRIDGE_PORT || 38765);
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const MAX_CHECK_NAMES = 5000;

const DEFAULTS = {
  idmPath: 'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
  downloadDir: path.join(path.dirname(ROOT), 'downloads'),
  collectionRoot: path.join(path.dirname(ROOT), 'downloads', 'Collections'),
  allowedHosts: ['nexusmods.com', 'nexus-cdn.com'],
  allowAnyHost: false,
  silent: true,
  dryRun: false
};

let config = loadConfig();

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    log({ event: 'config-error', error: err.message });
  }
  const cfg = Object.assign({}, DEFAULTS, raw);
  if (process.env.NEXUS_BRIDGE_ALLOW_ANY === '1') cfg.allowAnyHost = true;
  if (process.env.NEXUS_BRIDGE_DRY_RUN === '1') cfg.dryRun = true;
  cfg.downloadDir = path.resolve(String(cfg.downloadDir));
  cfg.collectionRoot = path.resolve(
    String(process.env.NEXUS_BRIDGE_COLLECTION_ROOT || cfg.collectionRoot || path.join(cfg.downloadDir, 'Collections'))
  );
  return cfg;
}

/**
 * The popup's refresh button pings the bridge, and the ping picks up config
 * edits immediately. This avoids restarting the bridge just to change a path.
 */
function reloadConfig() {
  config = loadConfig();
  return config;
}

function log(entry) {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {
    /* ignore */
  }
  if (process.env.NEXUS_BRIDGE_DEBUG === '1') process.stderr.write(line);
}

// ---------------------------------------------------------------------------
// validation / helpers
// ---------------------------------------------------------------------------

function isAllowedHost(hostname) {
  if (config.allowAnyHost) return true;
  const host = String(hostname || '').toLowerCase();
  const list = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
  return list.some((domain) => {
    const d = String(domain || '').toLowerCase().replace(/^\.+/, '');
    return d.length > 0 && (host === d || host.endsWith('.' + d));
  });
}

function sanitizeFilename(name) {
  // Same rules as the extension, so a preflight's "already on disk" check looks
  // for exactly the name this bridge will write.
  const out = Collection.sanitizeFilename(name || '');
  return out || 'nexus-download.bin';
}

/**
 * Resolve a collection sub-folder ("Worldly Improvements [vmu2j4]") under
 * collectionRoot. The extension never sends an absolute path: allowing that
 * would turn the bridge into an arbitrary file writer for any local page.
 */
function resolveSubdir(subdir) {
  const root = path.resolve(config.collectionRoot);
  const raw = String(subdir || '').trim();
  if (!raw) return root;
  if (raw.length > 220) throw new Error('subdir is too long');
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw) || raw.includes('..')) {
    throw new Error('subdir must be a relative path inside collectionRoot');
  }
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.length > 3) {
    throw new Error('subdir must have between 1 and 3 segments');
  }
  for (const segment of segments) {
    const clean = Collection.sanitizeSegment(segment, 120);
    if (clean !== segment) throw new Error('subdir contains illegal characters: ' + segment);
  }
  const dir = path.resolve(root, ...segments);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error('subdir escapes collectionRoot');
  }
  return dir;
}

/**
 * A file name must never be downloaded twice by accident: a second copy would
 * either overwrite the first or litter the folder with `(2)` names. Duplicates
 * are skipped unless the caller explicitly asks to replace the existing file.
 */
function fileInfo(dir, filename) {
  try {
    const stat = fs.statSync(path.join(dir, filename));
    if (!stat.isFile()) return { exists: false };
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (_) {
    return { exists: false };
  }
}

function filenameFromUrl(parsed) {
  try {
    const base = decodeURIComponent(path.posix.basename(parsed.pathname || ''));
    // Many Nexus CDN links end in a UUID (no extension); in that case let IDM
    // use the server's Content-Disposition instead of forcing a bogus name.
    return /\.[a-z0-9]{1,10}$/i.test(base) ? base : '';
  } catch (_) {
    return '';
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function ping() {
  reloadConfig();
  return {
    ok: true,
    bridge: VERSION,
    idmPath: config.idmPath,
    idmExists: fs.existsSync(config.idmPath),
    downloadDir: config.downloadDir,
    collectionRoot: config.collectionRoot,
    configPath: CONFIG_PATH,
    allowAnyHost: !!config.allowAnyHost,
    dryRun: !!config.dryRun,
    silent: !!config.silent
  };
}

function download(input) {
  const id = 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const parsed = new URL(String(input.url || ''));
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('only http(s) URLs are allowed');
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw new Error('host is not allowed: ' + parsed.hostname);
  }

  const requestedName = String(input.filename || '').trim();
  const baseName = requestedName ? sanitizeFilename(requestedName) : filenameFromUrl(parsed);
  const dir = resolveSubdir(input.subdir);
  fs.mkdirSync(dir, { recursive: true });

  // Duplicates are never downloaded twice. `replace` is only sent after the
  // user explicitly confirmed "overwrite this file" in the panel: the old file
  // is removed at the last moment, so a missing IDM cannot destroy it.
  const onExisting = input.onExisting === 'replace' ? 'replace' : 'skip';
  const filename = baseName;
  const targetPath = filename ? path.join(dir, filename) : '';
  const exists = targetPath ? fs.existsSync(targetPath) : false;
  if (exists && onExisting !== 'replace') {
    log({ event: 'skip-existing', id, filename, dir, subdir: input.subdir || '' });
    return { ok: true, id, skipped: 'disk', filename, dir };
  }

  if (config.dryRun) {
    log({ event: 'dry-run', id, url: parsed.toString(), filename: filename || null, dir, replace: exists && onExisting === 'replace' });
    return { ok: true, id, dryRun: true, filename: filename || null, dir };
  }
  if (!fs.existsSync(config.idmPath)) {
    throw new Error('IDM executable not found: ' + config.idmPath);
  }
  if (exists && onExisting === 'replace') {
    log({ event: 'replace-existing', id, filename, dir, subdir: input.subdir || '' });
    fs.rmSync(targetPath, { force: true });
  }

  const args = [];
  if (config.silent) args.push('/n');
  args.push('/d', parsed.toString(), '/p', dir);
  if (filename) args.push('/f', filename);

  const child = spawn(config.idmPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.on('error', (err) => {
    log({ event: 'spawn-error', id, error: String(err && err.message ? err.message : err) });
  });
  child.unref();

  log({
    event: 'spawned',
    id,
    pid: child.pid,
    url: parsed.toString(),
    filename,
    dir,
    subdir: input.subdir || '',
    source: input.source || 'bridge'
  });
  return { ok: true, id, pid: child.pid, filename, dir, command: [config.idmPath].concat(args) };
}

/** Bulk disk probe used by the panel's preflight and by the completion watcher. */
function check(input) {
  const dir = resolveSubdir(input.subdir);
  const raw = Array.isArray(input.names) ? input.names : [];
  if (raw.length > MAX_CHECK_NAMES) throw new Error('too many names to check (max ' + MAX_CHECK_NAMES + ')');
  const files = {};
  for (const name of raw) {
    const safe = sanitizeFilename(String(name || ''));
    if (!safe) continue;
    files[safe] = fileInfo(dir, safe);
  }
  return { ok: true, dir, files, exists: fs.existsSync(dir) };
}

async function history(input) {
  const result = await idmHistory.collect({ force: !!(input && input.force) });
  return Object.assign({ ok: true }, result);
}

function openFolder(input) {
  const dir = resolveSubdir(input && input.subdir);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    log({ event: 'open-folder-error', error: String(err && err.message ? err.message : err) });
  });
  child.unref();
  return { ok: true, dir };
}

function openConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('config.json not found: ' + CONFIG_PATH);
  }
  const child = spawn('notepad.exe', [CONFIG_PATH], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    log({ event: 'open-config-error', error: String(err && err.message ? err.message : err) });
  });
  child.unref();
  return { ok: true, path: CONFIG_PATH };
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/ping') {
      writeJson(res, 200, ping());
      return;
    }

    if (req.method === 'POST' && (req.url === '/download' || req.url === '/check' || req.url === '/idmHistory' || req.url === '/openFolder' || req.url === '/openConfig')) {
      const body = await readBody(req);
      const input = body ? JSON.parse(body) : {};
      let result;
      if (req.url === '/download') result = download(input);
      else if (req.url === '/check') result = check(input);
      else if (req.url === '/idmHistory') result = await history(input);
      else if (req.url === '/openConfig') result = openConfig();
      else result = openFolder(input);
      writeJson(res, 200, result);
      return;
    }

    writeJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    log({ event: 'request-error', url: req.url, error: message });
    writeJson(res, 400, { ok: false, error: message });
  }
});

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  log({ event: 'bridge-start', version: VERSION, address, pid: process.pid, idmPath: config.idmPath, downloadDir: config.downloadDir, collectionRoot: config.collectionRoot });
  process.stdout.write(`Nexus Downloader bridge listening on ${address}\n`);
});

server.on('error', (err) => {
  log({ event: 'bridge-error', error: err.message });
  process.stderr.write('bridge error: ' + err.message + '\n');
  process.exit(1);
});
