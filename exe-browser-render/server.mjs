import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const NOVNC_DIR = '/usr/share/novnc';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/tmp/arcade-hub-data');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const SESSIONS_DIR = '/tmp/arcade-game-sessions';
const PORT = Number(process.env.PORT) || 10000;
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 100) * 1024 * 1024;
const MAX_LIBRARY_BYTES = Math.max(20, Number(process.env.MAX_LIBRARY_MB) || 400) * 1024 * 1024;
const MAX_LIBRARY_ITEMS = Math.max(1, Number(process.env.MAX_LIBRARY_ITEMS) || 80);
const ARCADE_UID = 10001;
const ARCADE_GID = 10001;
const RECENT_COOKIE = 'arcade_recent_games';
const RECENT_LIMIT = 12;
const COOKIE_AGE = 365 * 24 * 60 * 60;

await fsp.mkdir(LIBRARY_DIR, { recursive: true });
await fsp.mkdir(SESSIONS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.map': 'application/json',
};

let activeChild = null;
let activeSession = null;

function publicSession() {
  if (!activeSession) return null;
  return {
    id: activeSession.id,
    title: activeSession.title,
    engine: activeSession.engine,
    status: activeSession.status,
    startedAt: activeSession.startedAt,
  };
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function safeName(raw) {
  const name = path.basename(String(raw || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N} ._()\-]/gu, '_')
    .trim().slice(0, 120);
  return name && name !== '.' && name !== '..' ? name : 'uploaded-file';
}

function safeRelativePath(raw, fallback = 'uploaded-file') {
  const parts = String(raw || fallback).replace(/\\/g, '/').split('/')
    .filter((part) => part && part !== '.' && part !== '..').slice(-10)
    .map((part) => part.replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[^\p{L}\p{N} ._()\-]/gu, '_').trim().slice(0, 90) || '_');
  return parts.join('/').slice(0, 500) || safeName(fallback);
}

function safeId(value) { return /^[a-f0-9-]{36}$/i.test(String(value || '')); }

function decodeHeader(value, fallback = '') {
  try { return decodeURIComponent(String(value || fallback)); }
  catch { return fallback; }
}

function parseCookies(req) {
  const result = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
}

function setCookie(req, res, name, value, maxAge = COOKIE_AGE) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== null) attrs.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (isSecureRequest(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function readRecent(req) {
  const encoded = parseCookies(req)[RECENT_COOKIE] || '';
  if (!encoded || encoded.length > 4500) return [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && /^[a-f0-9]{64}$/i.test(String(x.hash || ''))
      && Number.isFinite(Number(x.playedAt)) && typeof x.name === 'string')
      .slice(0, RECENT_LIMIT).map((x) => ({ hash: String(x.hash).toLowerCase(), name: x.name.slice(0, 90), playedAt: Number(x.playedAt), engine: ['wine', 'dosbox', 'scummvm'].includes(x.engine) ? x.engine : 'wine' }));
  } catch { return []; }
}

function writeRecent(req, res, entries) {
  const clean = entries.slice(0, RECENT_LIMIT);
  let encoded = Buffer.from(JSON.stringify(clean)).toString('base64url');
  while (encoded.length > 3000 && clean.length) {
    clean.pop();
    encoded = Buffer.from(JSON.stringify(clean)).toString('base64url');
  }
  setCookie(req, res, RECENT_COOKIE, encoded, COOKIE_AGE);
}

function recentForLibrary(req, items) {
  const byHash = new Map();
  for (const item of items) if (!byHash.has(item.sha256)) byHash.set(item.sha256, item);
  return readRecent(req).map((entry) => {
    const match = byHash.get(entry.hash);
    return { name: match?.name || entry.name, playedAt: entry.playedAt, available: Boolean(match), id: match?.id || null, engine: entry.engine || 'wine' };
  });
}

async function readJson(req, maxBytes = 12000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('Request is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON request.'), { statusCode: 400 }); }
}

// This deployment is intentionally public: anyone with the URL can upload,
// delete, launch, stop, and control the shared desktop. Mutating browser
// requests are checked against the app's own origin below.
function isSameOriginMutation(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Allows non-browser API clients; no CORS is exposed.
  const expectedHost = req.headers['x-forwarded-host'] || req.headers.host;
  try { return Boolean(expectedHost && new URL(origin).host === expectedHost); }
  catch { return false; }
}

async function getMetadata(id) {
  if (!safeId(id)) return null;
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(LIBRARY_DIR, `${id}.json`), 'utf8'));
    await fsp.access(path.join(LIBRARY_DIR, `${id}.bin`));
    return meta;
  } catch { return null; }
}

async function listLibrary() {
  const names = await fsp.readdir(LIBRARY_DIR).catch(() => []);
  const items = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(LIBRARY_DIR, name), 'utf8'));
      if (safeId(meta.id) && await fsp.stat(path.join(LIBRARY_DIR, `${meta.id}.bin`)).then((s) => s.isFile()).catch(() => false)) items.push(meta);
    } catch { /* Ignore incomplete metadata. */ }
  }
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function storeUpload(req, res) {
  const existing = await listLibrary();
  if (existing.length >= MAX_LIBRARY_ITEMS) {
    sendJson(res, 413, { error: `The shared shelf is full (${MAX_LIBRARY_ITEMS} files). Delete an item first.` });
    req.resume(); return;
  }
  const usedBytes = existing.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES || (declared && usedBytes + declared > MAX_LIBRARY_BYTES)) {
    sendJson(res, 413, { error: `File exceeds the per-file limit or remaining shelf space. Per-file maximum: ${Math.floor(MAX_UPLOAD_BYTES / 1048576)} MB.` });
    req.resume(); return;
  }

  const originalName = safeName(decodeHeader(req.headers['x-file-name'], 'uploaded-file'));
  const relativePath = safeRelativePath(decodeHeader(req.headers['x-relative-path'], originalName), originalName);
  const uploader = safeName(decodeHeader(req.headers['x-uploader-name'], 'Community member')).slice(0, 40);
  const requestedGroupId = String(req.headers['x-group-id'] || '');
  const groupId = safeId(requestedGroupId) ? requestedGroupId.toLowerCase() : crypto.randomUUID();
  const groupName = safeName(decodeHeader(req.headers['x-group-name'], 'Uploaded game files'));
  const extension = path.extname(originalName).toLowerCase().slice(0, 16);
  const id = crypto.randomUUID();
  const tempFile = path.join(LIBRARY_DIR, `${id}.tmp`);
  const dataFile = path.join(LIBRARY_DIR, `${id}.bin`);
  const metadataFile = path.join(LIBRARY_DIR, `${id}.json`);
  const hash = crypto.createHash('sha256');
  let handle;
  let total = 0;
  try {
    handle = await fsp.open(tempFile, 'wx', 0o600);
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) throw Object.assign(new Error('File is larger than the upload limit.'), { statusCode: 413 });
      if (usedBytes + total > MAX_LIBRARY_BYTES) throw Object.assign(new Error('The temporary shared shelf is full.'), { statusCode: 413 });
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close(); handle = null;
    await fsp.rename(tempFile, dataFile);
    const meta = {
      id, name: originalName, relativePath, extension, groupId, groupName,
      size: total, sha256: hash.digest('hex'), uploader: uploader || 'Community member',
      createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(metadataFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
    sendJson(res, 201, meta);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tempFile, { force: true }).catch(() => {});
    await fsp.rm(dataFile, { force: true }).catch(() => {});
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Could not save upload.' });
  }
}

function sendDownload(res, filePath, downloadName) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { sendJson(res, 404, { error: 'File is no longer available.' }); return; }
  if (!stat.isFile()) { sendJson(res, 404, { error: 'File is no longer available.' }); return; }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName || 'download')}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}

function mimeFor(filePath) { return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'; }

function serveStatic(res, baseDir, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { res.writeHead(400).end('Bad path'); return; }
  if (decoded.includes('\0')) { res.writeHead(400).end('Bad path'); return; }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
  const absolute = path.resolve(baseDir, `.${path.sep}${normalized}`);
  if (!absolute.startsWith(baseDir + path.sep) && absolute !== baseDir) { res.writeHead(403).end('Forbidden'); return; }
  let stat;
  try { stat = fs.statSync(absolute); } catch { res.writeHead(404).end('Not found'); return; }
  if (!stat.isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, {
    'Content-Type': mimeFor(absolute), 'Content-Length': stat.size,
    'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  fs.createReadStream(absolute).pipe(res);
}

async function copyLibraryGroup(ids, destination) {
  const files = [];
  let total = 0;
  for (const id of ids) {
    const meta = await getMetadata(id);
    if (!meta) throw Object.assign(new Error('One of the selected files is no longer available.'), { statusCode: 404 });
    total += Number(meta.size || 0);
    if (total > MAX_LIBRARY_BYTES) throw Object.assign(new Error('Selected group is too large to stage.'), { statusCode: 413 });
    const rel = safeRelativePath(meta.relativePath || meta.name, meta.name);
    const target = path.resolve(destination, rel);
    if (!target.startsWith(destination + path.sep)) throw Object.assign(new Error('Unsafe filename.'), { statusCode: 400 });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(LIBRARY_DIR, `${id}.bin`), target);
    files.push({ meta, target, relativePath: rel });
  }
  return files;
}

async function walkFiles(folder, max = 12000) {
  const result = [];
  async function visit(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
      if (result.length > max) throw Object.assign(new Error('The game folder contains too many files.'), { statusCode: 413 });
    }
  }
  await visit(folder);
  return result;
}

async function setArcadeOwnership(target) {
  const stat = await fsp.lstat(target);
  await fsp.chown(target, ARCADE_UID, ARCADE_GID);
  if (stat.isDirectory()) {
    for (const child of await fsp.readdir(target)) await setArcadeOwnership(path.join(target, child));
  }
}

async function stopGameProcess() {
  const child = activeChild;
  const oldSession = activeSession;
  activeChild = null;
  activeSession = null;
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 900));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  if (oldSession?.engine === 'wine') {
    await execFileAsync('runuser', ['-u', 'arcade', '--', 'env', 'WINEPREFIX=/tmp/arcade-wineprefix', 'wineserver', '-k'], { timeout: 5000 }).catch(() => {});
  }
  if (oldSession?.workingDirectory) await fsp.rm(oldSession.workingDirectory, { recursive: true, force: true }).catch(() => {});
}

function runDesktopCommand(engine, args, cwd, title, hash, workingDirectory = null) {
  const env = [
    'DISPLAY=:0', 'HOME=/tmp/arcade-home', 'WINEPREFIX=/tmp/arcade-wineprefix',
    'WINEDEBUG=-all', 'LIBGL_ALWAYS_SOFTWARE=1', 'MESA_GL_VERSION_OVERRIDE=3.3',
    'SDL_AUDIODRIVER=dummy',
  ];
  const binary = engine === 'dosbox' ? 'dosbox' : engine === 'scummvm' ? 'scummvm' : 'wine';
  const child = spawn('runuser', ['-u', 'arcade', '--', 'env', ...env, binary, ...args], {
    cwd, detached: true, stdio: 'ignore',
  });
  activeChild = child;
  const sessionId = crypto.randomUUID();
  activeSession = { id: sessionId, title, engine, status: 'starting', startedAt: new Date().toISOString(), processId: child.pid, workingDirectory };
  child.once('spawn', () => {
    if (activeSession?.id === sessionId) activeSession.status = 'running';
  });
  child.once('error', (error) => {
    console.error(`Could not start ${engine}:`, error);
    if (activeSession?.id === sessionId) activeSession.status = 'error';
  });
  child.once('exit', (code, signal) => {
    if (activeSession?.id === sessionId) {
      activeSession.status = 'exited';
      activeSession.exitCode = code;
      activeSession.signal = signal;
      if (workingDirectory) fsp.rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
    if (activeChild === child) activeChild = null;
  });
  child.unref();
  return { ok: true, sessionId, title, engine, hash };
}

function chooseDosProgram(files) {
  const candidates = files.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.com' || ext === '.bat') return true;
    if (ext !== '.exe') return false;
    // DOSBox cannot execute modern PE Windows applications. Skip PE files so
    // a selected DOSBox launch does not accidentally try a Windows launcher.
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const offsetBytes = Buffer.alloc(4);
        if (fs.readSync(fd, offsetBytes, 0, 4, 0x3c) !== 4) return true;
        const peOffset = offsetBytes.readUInt32LE(0);
        if (peOffset > 1024 * 1024) return true;
        const signature = Buffer.alloc(4);
        if (fs.readSync(fd, signature, 0, 4, peOffset) !== 4) return true;
        return signature.toString('binary') !== 'PE\0\0';
      } finally { fs.closeSync(fd); }
    } catch { return true; }
  });
  const rank = (file) => /^(setup|install|unins|uninstall)/i.test(path.basename(file)) ? 10 : /^(game|play|start)/i.test(path.basename(file)) ? 0 : 2;
  candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return candidates[0] || null;
}

function dosboxArgs(sessionDir, target) {
  const args = ['-noconsole', '-c', `mount c ${sessionDir}`, '-c', 'c:'];
  if (target) {
    const rel = path.relative(sessionDir, target).split(path.sep).join('\\');
    const parent = path.posix.dirname(rel);
    if (parent && parent !== '.') args.push('-c', `cd \"${parent}\"`);
    args.push('-c', `\"${path.posix.basename(rel)}\"`);
  }
  return args;
}

async function startGame(req, res) {
  const body = await readJson(req, 20000);
  const engine = ['wine', 'dosbox', 'scummvm'].includes(body.engine) ? body.engine : 'wine';

  if (body.demo === true) {
    await stopGameProcess();
    const demoArgs = engine === 'wine' ? ['notepad'] : [];
    const demoTitle = engine === 'wine' ? 'Wine Notepad (built-in test)' : engine === 'dosbox' ? 'DOSBox prompt (built-in test)' : 'ScummVM launcher (built-in test)';
    const started = runDesktopCommand(engine, demoArgs, '/tmp/arcade-home', demoTitle, null);
    sendJson(res, 200, { ...started, message: `${demoTitle} was started on the Render server.` });
    return;
  }

  const requestedIds = Array.isArray(body.ids) ? body.ids : [];
  const ids = [...new Set(requestedIds.filter(safeId))];
  if (!ids.length || ids.length !== requestedIds.length || ids.length > 100) {
    sendJson(res, 400, { error: 'Select a valid game group containing no more than 100 files.' }); return;
  }

  const sessionDir = path.join(SESSIONS_DIR, crypto.randomUUID());
  await fsp.mkdir(sessionDir, { recursive: true });
  try {
    const staged = await copyLibraryGroup(ids, sessionDir);
    // Extract ZIP archives safely. Arbitrary files remain available alongside the extracted content.
    for (const item of staged.filter((file) => path.extname(file.target).toLowerCase() === '.zip')) {
      const extractDir = path.join(sessionDir, `unzipped-${path.basename(item.target, '.zip')}`);
      await fsp.mkdir(extractDir, { recursive: true });
      try {
        await execFileAsync('python3', [path.join(ROOT, 'extract-safe.py'), item.target, extractDir], { timeout: 120000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        throw Object.assign(new Error(`Could not extract ${item.meta.name}: ${error.stderr?.trim() || error.message}`), { statusCode: 400 });
      }
    }

    const allFiles = await walkFiles(sessionDir);
    let args = [];
    let target = null;
    let displayTitle = '';
    let sourceHash = null;

    if (engine === 'wine') {
      const exeCandidates = allFiles.filter((file) => path.extname(file).toLowerCase() === '.exe');
      const msiCandidates = allFiles.filter((file) => path.extname(file).toLowerCase() === '.msi');
      const launchRank = (file) => {
        const base = path.basename(file).toLowerCase();
        if (/^(game|launcher|play|start)[-_ ]/.test(base)) return 0;
        if (/^(game|launcher|play|start)\.exe$/.test(base)) return 0;
        if (/^(setup|install|unins|uninstall|crash|report)/.test(base)) return 10;
        return 2;
      };
      exeCandidates.sort((a, b) => launchRank(a) - launchRank(b) || a.localeCompare(b));
      msiCandidates.sort((a, b) => a.localeCompare(b));
      const candidates = exeCandidates.length ? exeCandidates : msiCandidates;
      if (!candidates.length) throw Object.assign(new Error('No .exe or .msi was found. Upload a ZIP containing the installed Windows game folder, or upload the EXE together with its DLL and data files.'), { statusCode: 400 });
      const requestedPath = String(body.executablePath || '');
      target = candidates.find((file) => path.relative(sessionDir, file).replace(/\\/g, '/') === requestedPath)
        || candidates.find((file) => staged.some((item) => item.target === file && path.extname(file).toLowerCase() === '.exe'))
        || candidates[0];
      args = path.extname(target).toLowerCase() === '.msi' ? ['msiexec', '/i', target] : [target];
      displayTitle = path.basename(target);
      sourceHash = staged.find((item) => item.target === target)?.meta.sha256 || staged.find((item) => item.meta.extension === '.zip')?.meta.sha256 || null;
    } else if (engine === 'dosbox') {
      target = chooseDosProgram(allFiles);
      args = dosboxArgs(sessionDir, target);
      displayTitle = target ? `${path.basename(target)} (DOSBox)` : 'DOSBox command prompt';
      sourceHash = (target && staged.find((item) => item.target === target)?.meta.sha256)
        || staged.find((item) => item.meta.extension === '.zip')?.meta.sha256
        || staged[0]?.meta.sha256 || null;
    } else {
      // Start the ScummVM launcher. Users can choose Add Game and browse to this
      // staged folder inside the remote desktop; game files are not copied locally.
      args = [];
      displayTitle = 'ScummVM launcher';
      sourceHash = staged.find((item) => item.meta.extension === '.zip')?.meta.sha256 || staged[0]?.meta.sha256 || null;
    }

    await setArcadeOwnership(sessionDir);
    await stopGameProcess();
    const started = runDesktopCommand(engine, args, target ? path.dirname(target) : sessionDir, displayTitle, sourceHash, sessionDir);
    if (sourceHash) {
      const recent = readRecent(req).filter((entry) => entry.hash !== sourceHash);
      recent.unshift({ hash: sourceHash, name: displayTitle, playedAt: Date.now(), engine });
      writeRecent(req, res, recent);
    }
    let message = `Started ${displayTitle} on Render. All connected visitors share this desktop session.`;
    if (engine === 'dosbox' && !target) message += ' DOSBox is open at its DOS prompt; use the mounted C: drive to browse the uploaded files.';
    if (engine === 'scummvm') message += ` In ScummVM, choose Add Game and browse to ${sessionDir} (or its unzipped-* subfolder).`;
    sendJson(res, 200, { ...started, message });
  } catch (error) {
    await fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Could not prepare this game on the Render server.' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOriginMutation(req)) {
      sendJson(res, 403, { error: 'Cross-origin changes are not allowed.' });
      req.resume();
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true, runtime: 'server-side-emulators', engines: ['wine', 'dosbox', 'scummvm'], storageMode: 'temporary', novncAvailable: fs.existsSync(path.join(NOVNC_DIR, 'vnc.html')),
        maxUploadMB: Math.floor(MAX_UPLOAD_BYTES / 1048576), maxLibraryItems: MAX_LIBRARY_ITEMS,
        uploadsEnabled: true, publicAccess: true, session: publicSession(),
      });
      return;
    }
    if (pathname === '/api/library/session' && req.method === 'GET') {
      sendJson(res, 200, { authorized: true, uploadsEnabled: true, publicAccess: true });
      return;
    }
    if (pathname === '/api/library' && req.method === 'GET') {
      const items = await listLibrary();
      sendJson(res, 200, {
        items, recentGames: recentForLibrary(req, items),
        maxUploadMB: Math.floor(MAX_UPLOAD_BYTES / 1048576), maxLibraryItems: MAX_LIBRARY_ITEMS,
        uploadsEnabled: true, publicAccess: true,
      }); return;
    }
    if (pathname === '/api/library' && req.method === 'POST') { await storeUpload(req, res); return; }
    if (pathname === '/api/library/recent' && req.method === 'DELETE') {
      setCookie(req, res, RECENT_COOKIE, '', 0); sendJson(res, 200, { ok: true }); return;
    }

    const deleteGroup = /^\/api\/library\/group\/([a-f0-9-]{36})$/.exec(pathname);
    if (deleteGroup && req.method === 'DELETE') {
      const items = (await listLibrary()).filter((item) => item.groupId === deleteGroup[1]);
      for (const item of items) {
        await fsp.rm(path.join(LIBRARY_DIR, `${item.id}.bin`), { force: true });
        await fsp.rm(path.join(LIBRARY_DIR, `${item.id}.json`), { force: true });
      }
      sendJson(res, 200, { ok: true, deleted: items.length }); return;
    }

    const itemMatch = /^\/api\/library\/([a-f0-9-]{36})(?:\/(download))?$/.exec(pathname);
    if (itemMatch) {
      const [, id, action] = itemMatch;
      const meta = await getMetadata(id);
      if (!meta) { sendJson(res, 404, { error: 'File is no longer in the shared library.' }); return; }
      if (req.method === 'GET' && action === 'download') {
        sendDownload(res, path.join(LIBRARY_DIR, `${id}.bin`), meta.name); return;
      }
      if (req.method === 'DELETE' && !action) {
          await fsp.rm(path.join(LIBRARY_DIR, `${id}.bin`), { force: true });
        await fsp.rm(path.join(LIBRARY_DIR, `${id}.json`), { force: true });
        sendJson(res, 200, { ok: true }); return;
      }
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      sendJson(res, 200, { session: publicSession(), authorized: true, publicAccess: true }); return;
    }
    if (pathname === '/api/session/start' && req.method === 'POST') { await startGame(req, res); return; }
    if (pathname === '/api/session/stop' && req.method === 'POST') {
      await stopGameProcess(); sendJson(res, 200, { ok: true }); return;
    }

    if (pathname.startsWith('/novnc/')) {
      const subPath = pathname.slice('/novnc'.length) || '/';
      serveStatic(res, NOVNC_DIR, subPath); return;
    }

    const publicPath = pathname === '/' ? '/index.html' : pathname;
    serveStatic(res, PUBLIC_DIR, publicPath);
  } catch (error) {
    console.error('Request failed:', error);
    if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal server error.' });
    else res.destroy();
  }
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/websockify') { socket.destroy(); return; }
  const origin = req.headers.origin;
  const expectedHost = req.headers['x-forwarded-host'] || req.headers.host;
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && expectedHost && new URL(origin).host === expectedHost); } catch { sameOrigin = false; }
  if (!sameOrigin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy(); return;
  }
  // Public mode: same-origin WebSocket upgrades are allowed. The VNC and
  // websockify listeners remain private on localhost; only this gateway is public.
  const upstream = net.createConnection({ host: '127.0.0.1', port: 6080 });
  const rawHeaders = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const headerName = req.rawHeaders[i].toLowerCase();
    if (headerName === 'transfer-encoding' || headerName === 'content-length') continue;
    rawHeaders.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  const upgradeRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${rawHeaders.join('\r\n')}\r\n\r\n`;
  upstream.once('connect', () => {
    upstream.write(upgradeRequest);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => {
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.on('error', (error) => { console.error('HTTP server error:', error); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Arcade Hub server-side runtime listening on 0.0.0.0:${PORT}`);
  console.log(`Shared file storage: ${LIBRARY_DIR} (temporary on Render Free)`);
  console.log('Shared uploads and remote play: enabled for anyone with the public URL');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await stopGameProcess();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  });
}
