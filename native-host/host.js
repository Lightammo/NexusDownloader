#!/usr/bin/env node
'use strict';

/**
 * Nexus Downloader - Native Messaging Host
 *
 * Chrome launches this process and speaks the native-messaging wire protocol:
 *   4-byte little-endian length + UTF-8 JSON payload, on stdin/stdout.
 *
 * The host validates the request, then hands the URL to Internet Download
 * Manager via its command line interface:
 *   IDMan.exe /n /d <url> /p <dir> /f <filename>
 *
 * /n = silent mode (no dialogs), no /a so the download starts immediately.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST_NAME = 'com.nexusdownloader.host';
const HOST_VERSION = '0.1.0';
// When packaged as a Node SEA, __dirname points inside the embedded snapshot,
// so prefer the directory of the executable if it holds our config.json.
const EXE_DIR = path.dirname(process.execPath);
const ROOT = fs.existsSync(path.join(EXE_DIR, 'config.json')) ? EXE_DIR : __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'host.log');
const MAX_MESSAGE_BYTES = 1024 * 1024; // Chrome's extension -> host limit

const DEFAULTS = {
  idmPath: 'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
  downloadDir: path.join(path.dirname(ROOT), 'downloads'),
  allowedHosts: ['nexusmods.com', 'nexus-cdn.com'],
  allowAnyHost: false,
  silent: true,
  dryRun: false
};

let config = loadConfig();

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {
    /* logging must never take the host down */
  }
}

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch (_) {
    /* no log yet */
  }
}

function log(entry) {
  const record = Object.assign({ at: new Date().toISOString() }, entry);
  const line = JSON.stringify(record) + '\n';
  try {
    ensureLogDir();
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {
    /* ignore */
  }
  if (process.env.NEXUS_HOST_DEBUG === '1') {
    process.stderr.write(line);
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[nexus-host] config.json is invalid: ${err.message}\n`);
    }
  }
  const cfg = Object.assign({}, DEFAULTS, raw);
  // Test hook: lets tools/test-host.js exercise a public URL without
  // permanently loosening the allow-list in config.json.
  if (process.env.NEXUS_HOST_ALLOW_ANY === '1') cfg.allowAnyHost = true;
  cfg.downloadDir = path.resolve(String(cfg.downloadDir));
  return cfg;
}

// ---------------------------------------------------------------------------
// native messaging framing
// ---------------------------------------------------------------------------

function send(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));

  if (pending > 0) pending--;
  if (pending === 0 && stdinClosed) {
    // Give the browser's native-messaging teardown a moment: the IDM command
    // line stub can still be finishing its hand-off to the running instance.
    setTimeout(() => process.exit(0), 1200);
  }
}

let pending = 0;
let stdinClosed = false;

function readLoop() {
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_MESSAGE_BYTES) {
        log({ event: 'protocol-error', reason: 'invalid length', length });
        send({ ok: false, error: 'invalid message length' });
        process.exit(1);
      }
      if (buffer.length < 4 + length) break;

      const payload = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);

      let message;
      try {
        message = JSON.parse(payload);
      } catch (err) {
        log({ event: 'protocol-error', reason: 'invalid json', error: err.message });
        send({ ok: false, error: 'invalid json' });
        continue;
      }
      pending++;
      handle(message);
    }
  });

  process.stdin.on('end', () => {
    stdinClosed = true;
    if (pending === 0) {
      setTimeout(() => process.exit(0), 1200);
    }
  });
  process.stdin.on('error', () => process.exit(0));
}

// ---------------------------------------------------------------------------
// validation helpers
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

function filenameFromUrl(parsed) {
  try {
    const base = decodeURIComponent(path.posix.basename(parsed.pathname || ''));
    return base || 'nexus-download.bin';
  } catch (_) {
    return 'nexus-download.bin';
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFilename(name) {
  let out = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();

  if (!out) out = 'nexus-download.bin';
  if (WINDOWS_RESERVED.test(out)) out = '_' + out;

  const ext = path.extname(out).slice(0, 20);
  if (out.length > 180) {
    out = out.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  return out;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function handle(message) {
  if (!message || typeof message !== 'object') {
    return send({ ok: false, error: 'invalid message' });
  }

  switch (message.type) {
    case 'ping':
      return handlePing();
    case 'download':
      return handleDownload(message);
    case 'openFolder':
      return handleOpenFolder();
    default:
      log({ event: 'unknown-type', type: message.type });
      return send({ ok: false, error: `unknown message type: ${message.type}` });
  }
}

function handlePing() {
  let idmExists = false;
  try {
    idmExists = fs.existsSync(config.idmPath);
  } catch (_) {
    /* ignore */
  }
  send({
    ok: true,
    host: HOST_NAME,
    version: HOST_VERSION,
    idmPath: config.idmPath,
    idmExists,
    downloadDir: config.downloadDir,
    allowAnyHost: !!config.allowAnyHost,
    dryRun: !!config.dryRun,
    silent: !!config.silent,
    node: process.version
  });
}

function spawnIdm(args) {
  return spawn(config.idmPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
}

function handleDownload(message) {
  const id = 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  try {
    const parsed = new URL(String(message.url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('only http(s) URLs are allowed');
    }
    if (!isAllowedHost(parsed.hostname)) {
      throw new Error(`host is not allowed: ${parsed.hostname}`);
    }

    const filename = sanitizeFilename(message.filename || filenameFromUrl(parsed));
    const dir = path.resolve(config.downloadDir);
    fs.mkdirSync(dir, { recursive: true });

    const args = [];
    if (config.silent) args.push('/n');
    args.push('/d', parsed.toString(), '/p', dir, '/f', filename);

    const command = [config.idmPath].concat(args);

    if (config.dryRun) {
      log({ event: 'dry-run', id, command, source: message.source || 'unknown' });
      return send({ ok: true, id, dryRun: true, filename, dir, command });
    }

    if (!fs.existsSync(config.idmPath)) {
      throw new Error(`IDM executable not found: ${config.idmPath}`);
    }

    const child = spawnIdm(args);
    if (!child) {
      throw new Error('failed to spawn IDM launcher');
    }

    let replied = false;
    const replyOnce = (payload) => {
      if (replied) return;
      replied = true;
      send(payload);
    };

    child.on('error', (err) => {
      const message = String(err && err.message ? err.message : err);
      log({ event: 'spawn-error', id, error: message });
      replyOnce({ ok: false, error: message });
    });

    // IDM's command-line stub forwards the URL to the running IDM instance and
    // then exits. Wait for that hand-off before answering Chrome, otherwise the
    // native host can be torn down while the transfer is still in flight.
    child.on('exit', (code) => {
      log({ event: 'spawned', id, pid: child.pid, code, url: parsed.toString(), filename, dir, source: message.source || 'unknown', referrer: message.referrer || '' });
      replyOnce({
        ok: true,
        id,
        pid: child.pid,
        filename,
        dir,
        command
      });
    });

    setTimeout(() => {
      // IDM was not running and the spawned process became the main instance;
      // it will not exit on its own, so answer Chrome after a short grace period.
      if (!replied) {
        log({ event: 'spawned', id, pid: child.pid, code: null, url: parsed.toString(), filename, dir, source: message.source || 'unknown', referrer: message.referrer || '' });
        replyOnce({ ok: true, id, pid: child.pid, filename, dir, command });
        try { child.unref(); } catch (_) { /* ignore */ }
      }
    }, 1500).unref();

    log({
      event: 'spawning',
      id,
      pid: child.pid,
      url: parsed.toString(),
      filename,
      dir,
      source: message.source || 'unknown',
      referrer: message.referrer || ''
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log({ event: 'download-error', id, error: msg, url: message && message.url });
    send({ ok: false, error: msg });
  }
}

function handleOpenFolder() {
  try {
    const dir = path.resolve(config.downloadDir);
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
    child.unref();
    send({ ok: true, dir });
  } catch (err) {
    send({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

log({
  event: 'host-start',
  version: HOST_VERSION,
  pid: process.pid,
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  tty: { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY },
  env: {
    APPDATA: process.env.APPDATA,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP
  }
});
readLoop();
