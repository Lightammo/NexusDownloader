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

const VERSION = '0.2.2';
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, '..', 'native-host', 'config.json');
const LOG_FILE = path.join(ROOT, 'bridge.log');
const PORT = Number(process.env.NEXUS_BRIDGE_PORT || 38765);
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;

const DEFAULTS = {
  idmPath: 'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
  downloadDir: path.join(path.dirname(ROOT), 'downloads'),
  allowedHosts: ['nexusmods.com', 'nexus-cdn.com'],
  allowAnyHost: false,
  silent: true,
  dryRun: false
};

const config = loadConfig();

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    log({ event: 'config-error', error: err.message });
  }
  const cfg = Object.assign({}, DEFAULTS, raw);
  if (process.env.NEXUS_BRIDGE_ALLOW_ANY === '1') cfg.allowAnyHost = true;
  cfg.downloadDir = path.resolve(String(cfg.downloadDir));
  return cfg;
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
  let out = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!out) out = 'nexus-download.bin';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) out = '_' + out;
  const ext = path.extname(out).slice(0, 20);
  if (out.length > 180) out = out.slice(0, Math.max(1, 180 - ext.length)) + ext;
  return out;
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
  return {
    ok: true,
    bridge: VERSION,
    idmPath: config.idmPath,
    idmExists: fs.existsSync(config.idmPath),
    downloadDir: config.downloadDir,
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
  const filename = requestedName ? sanitizeFilename(requestedName) : filenameFromUrl(parsed);
  const dir = path.resolve(config.downloadDir);
  fs.mkdirSync(dir, { recursive: true });

  if (config.dryRun) {
    log({ event: 'dry-run', id, url: parsed.toString(), filename: filename || null, dir });
    return { ok: true, id, dryRun: true, filename: filename || null, dir };
  }
  if (!fs.existsSync(config.idmPath)) {
    throw new Error('IDM executable not found: ' + config.idmPath);
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

  log({ event: 'spawned', id, pid: child.pid, url: parsed.toString(), filename, dir, source: input.source || 'bridge' });
  return { ok: true, id, pid: child.pid, filename, dir, command: [config.idmPath].concat(args) };
}

function openFolder() {
  const dir = path.resolve(config.downloadDir);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    log({ event: 'open-folder-error', error: String(err && err.message ? err.message : err) });
  });
  child.unref();
  return { ok: true, dir };
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

    if (req.method === 'POST' && (req.url === '/download' || req.url === '/openFolder')) {
      const body = await readBody(req);
      const input = body ? JSON.parse(body) : {};
      const result = req.url === '/download' ? download(input) : openFolder();
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
  log({ event: 'bridge-start', version: VERSION, address, pid: process.pid, idmPath: config.idmPath, downloadDir: config.downloadDir });
  process.stdout.write(`Nexus Downloader bridge listening on ${address}\n`);
});

server.on('error', (err) => {
  log({ event: 'bridge-error', error: err.message });
  process.stderr.write('bridge error: ' + err.message + '\n');
  process.exit(1);
});
