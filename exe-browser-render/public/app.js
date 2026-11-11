const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { files: [], recent: [], maxUploadMB: 100, activeSession: null };
const remoteFrame = $('#remoteFrame');

function showView(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  if (name === 'shared') refreshLibrary();
  if (name === 'player') refreshSession();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function message(text, kind = '') {
  const el = $('#uploadMessage');
  el.textContent = text;
  el.className = `message ${kind}`;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}
function prettyDate(value) {
  try { return new Date(value).toLocaleString(); } catch { return ''; }
}
function setStatus(text) { $('#playerStatus').textContent = text; }
function currentGroups() {
  const map = new Map();
  for (const file of state.files) {
    const key = file.groupId || file.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(file);
  }
  return [...map.entries()].map(([id, files]) => ({
    id,
    files: files.sort((a, b) => String(a.relativePath || a.name).localeCompare(String(b.relativePath || b.name))),
    title: files[0]?.groupName || files[0]?.name || 'Uploaded files',
    uploader: files[0]?.uploader || 'Community member',
    size: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
    createdAt: files.reduce((latest, file) => String(file.createdAt) > String(latest) ? file.createdAt : latest, files[0]?.createdAt),
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function canRun(group, engine) {
  if (engine === 'wine') return group.files.some((file) => /\.(exe|msi|zip)$/i.test(file.name));
  return group.files.length > 0;
}

async function refreshLibrary() {
  try {
    const response = await fetch('/api/library', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Library request failed (${response.status}).`);
    const data = await response.json();
    state.files = Array.isArray(data.items) ? data.items : [];
    state.recent = Array.isArray(data.recentGames) ? data.recentGames : [];
    state.maxUploadMB = Number(data.maxUploadMB) || 100;
    $('#uploadLimit').textContent = state.maxUploadMB;
    $('#navCount').textContent = state.files.length;
    $('#listCount').textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'}`;
    renderFiles();
    renderRecent();
  } catch (error) {
    $('#fileList').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderFiles() {
  const groups = currentGroups();
  if (!groups.length) {
    $('#fileList').innerHTML = '<div class="empty">No shared files yet. Upload a ZIP or complete game folder.</div>';
    return;
  }
  $('#fileList').innerHTML = groups.map((group) => {
    const filesMarkup = group.files.map((file) => `<a href="/api/library/${escapeAttr(file.id)}/download" title="Download ${escapeAttr(file.relativePath || file.name)}">↓ ${escapeHtml(file.relativePath || file.name)} · ${bytes(Number(file.size) || 0)}</a>`).join('');
    const ids = group.files.map((file) => file.id).join(',');
    return `<article class="file-group">
      <div class="file-group-top"><span class="file-glyph">▧</span><div class="file-group-title"><strong>${escapeHtml(group.title)}</strong><small>${group.files.length} file(s) · ${bytes(group.size)} · ${escapeHtml(prettyDate(group.createdAt))}<br>Uploaded by ${escapeHtml(group.uploader)}</small></div></div>
      <div class="group-files">${filesMarkup}</div>
      <div class="file-buttons"><button class="small-btn run" data-run-group="${escapeAttr(ids)}" data-engine="wine" ${canRun(group, 'wine') ? '' : 'disabled'}>Wine · Windows EXE</button><button class="small-btn" data-run-group="${escapeAttr(ids)}" data-engine="dosbox">DOSBox</button><button class="small-btn" data-run-group="${escapeAttr(ids)}" data-engine="scummvm">ScummVM</button><button class="small-btn delete" data-delete-group="${escapeAttr(group.id)}">Delete</button></div>
    </article>`;
  }).join('');
}

function renderRecent() {
  $('#clearRecent').disabled = state.recent.length === 0;
  if (!state.recent.length) {
    $('#recentList').innerHTML = '<div class="empty">Games launched on this browser will appear here.</div>';
    return;
  }
  $('#recentList').innerHTML = state.recent.map((item) => {
    const status = item.available ? 'Available in shared library' : 'Needs to be re-uploaded';
    const engineName = ({ wine: 'Wine', dosbox: 'DOSBox', scummvm: 'ScummVM' })[item.engine] || 'Wine';
    const button = item.available ? `<button class="small-btn run" data-recent-run="${escapeAttr(item.id)}" data-engine="${escapeAttr(item.engine || 'wine')}">Run again</button>` : '<button class="small-btn" disabled>Unavailable</button>';
    return `<div class="recent-row"><span class="recent-icon">◷</span><div class="recent-main"><strong>${escapeHtml(item.name)}</strong><small>${engineName} · ${escapeHtml(prettyDate(item.playedAt))} · ${status}</small></div>${button}</div>`;
  }).join('');
}

function inferGroupName(files) {
  const first = files[0]?.webkitRelativePath || '';
  if (first.includes('/')) return first.split('/')[0];
  return files.length > 1 ? `${files[0].name} + ${files.length - 1} more` : files[0]?.name || 'Uploaded files';
}

async function uploadFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file);
  if (!files.length) return;
  const oversize = files.find((file) => file.size > state.maxUploadMB * 1048576);
  if (oversize) { message(`${oversize.name} exceeds the ${state.maxUploadMB} MB per-file limit.`, 'error'); return; }

  const groupId = crypto.randomUUID();
  const groupName = inferGroupName(files);
  const uploader = $('#uploaderName').value.trim() || 'Community member';
  let uploaded = 0;
  const errors = [];
  $('#uploadButton').disabled = true;
  $('#uploadFolderButton').disabled = true;
  $('#uploadButton').textContent = 'Uploading…';
  try {
    for (const file of files) {
      message(`Uploading ${uploaded + 1} of ${files.length}: ${file.name}`);
      const relativePath = file.webkitRelativePath || file.name;
      const response = await fetch('/api/library', {
        method: 'POST', credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Relative-Path': encodeURIComponent(relativePath),
          'X-Group-Id': groupId,
          'X-Group-Name': encodeURIComponent(groupName),
          'X-Uploader-Name': encodeURIComponent(uploader),
        },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) errors.push(`${file.name}: ${result.error || `HTTP ${response.status}`}`);
      else uploaded++;
    }
    $('#uploadInput').value = '';
    $('#folderUploadInput').value = '';
    await refreshLibrary();
    if (errors.length) message(`Uploaded ${uploaded}/${files.length}. ${errors.slice(0, 2).join(' · ')}`, 'error');
    else message(`Uploaded ${uploaded} file(s) as “${groupName}”. Everyone can see the group.`, 'success');
  } catch (error) {
    message(`Upload interrupted after ${uploaded}/${files.length}: ${error.message}`, 'error');
  } finally {
    $('#uploadButton').disabled = false;
    $('#uploadFolderButton').disabled = false;
    $('#uploadButton').textContent = 'Upload selected files';
  }
}

function openRemoteScreen() {
  $('#remotePlaceholder').classList.add('hidden');
  remoteFrame.hidden = false;
  const query = new URLSearchParams({
    autoconnect: 'true',
    resize: 'scale',
    path: 'websockify',
    encrypt: location.protocol === 'https:' ? 'true' : 'false',
  });
  remoteFrame.src = `/novnc/vnc.html?${query.toString()}`;
  showView('player');
}

async function startRemoteGame({ ids = [], demo = false, engine = 'wine' } = {}) {
  setStatus(demo ? 'Starting the built-in Wine test app on Render…' : 'Preparing files and starting the game on Render…');
  try {
    const response = await fetch('/api/session/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, demo, engine }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Start failed (${response.status}).`);
    state.activeSession = { title: result.title, engine: result.engine || engine, status: 'starting' };
    $('#sessionTag').textContent = 'STARTING ON RENDER';
    setStatus(result.message || `Started ${result.title} on Render.`);
    showView('player');
    openRemoteScreen();
    await refreshSession();
    await refreshLibrary();
  } catch (error) {
    setStatus(error.message);
    showView('player');
    $('#sessionTag').textContent = 'START FAILED';
  }
}

async function refreshSession() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json();
    state.activeSession = data.session || null;
    if (state.activeSession) {
      $('#sessionTag').textContent = String(state.activeSession.status || 'ACTIVE').toUpperCase();
      setStatus(`${state.activeSession.title} · ${state.activeSession.engine || 'wine'} · ${state.activeSession.status}`);
    } else {
      $('#sessionTag').textContent = 'NO ACTIVE GAME';
      setStatus('No game started yet.');
    }
  } catch { setStatus('Could not check the server session.'); }
}

async function stopRemoteGame() {
  if (!confirm('Stop the current game for everyone connected?')) return;
  try {
    const response = await fetch('/api/session/stop', { method: 'POST', credentials: 'same-origin' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not stop game.');
    remoteFrame.src = 'about:blank'; remoteFrame.hidden = true;
    $('#remotePlaceholder').classList.remove('hidden');
    await refreshSession();
  } catch (error) { setStatus(error.message); }
}

async function deleteGroup(groupId) {
  if (!confirm('Delete this entire group from the shared shelf for everyone?')) return;
  try {
    const response = await fetch(`/api/library/group/${encodeURIComponent(groupId)}`, { method: 'DELETE', credentials: 'same-origin' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Delete failed.');
    message(`Deleted ${result.deleted || 0} file(s).`, 'success');
    await refreshLibrary();
  } catch (error) { message(error.message, 'error'); }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.go)));
$('#runDemo').addEventListener('click', () => startRemoteGame({ demo: true, engine: 'wine' }));
$('#runDosboxDemo').addEventListener('click', () => startRemoteGame({ demo: true, engine: 'dosbox' }));
$('#runScummvmDemo').addEventListener('click', () => startRemoteGame({ demo: true, engine: 'scummvm' }));
$('#uploadInput').addEventListener('change', (event) => uploadFiles(event.target.files));
$('#folderUploadInput').addEventListener('change', (event) => uploadFiles(event.target.files));
$('#uploadFolderButton').addEventListener('click', () => $('#folderUploadInput').click());
$('#uploadButton').addEventListener('click', () => uploadFiles($('#uploadInput').files));
$('#refreshButton').addEventListener('click', refreshLibrary);
$('#connectButton').addEventListener('click', async () => {
  openRemoteScreen();
  await refreshSession();
});
$('#stopButton').addEventListener('click', stopRemoteGame);
$('#fileList').addEventListener('click', (event) => {
  const run = event.target.closest('[data-run-group]');
  const del = event.target.closest('[data-delete-group]');
  if (run) startRemoteGame({ ids: run.dataset.runGroup.split(',').filter((id) => /^[a-f0-9-]{36}$/i.test(id)), engine: run.dataset.engine || 'wine' });
  if (del) deleteGroup(del.dataset.deleteGroup);
});
$('#recentList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-recent-run]');
  if (!button) return;
  const file = state.files.find((item) => item.id === button.dataset.recentRun);
  if (!file) return;
  const group = currentGroups().find((entry) => entry.id === (file.groupId || file.id));
  if (group) startRemoteGame({ ids: group.files.map((entry) => entry.id), engine: button.dataset.engine || 'wine' });
});
$('#clearRecent').addEventListener('click', async () => {
  const response = await fetch('/api/library/recent', { method: 'DELETE', credentials: 'same-origin' });
  if (response.ok) { state.recent = []; renderRecent(); }
});


const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); }));
dropzone.addEventListener('drop', (event) => uploadFiles(event.dataTransfer.files));

async function init() {
  try {
    const healthResponse = await fetch('/api/health', { cache: 'no-store' });
    const health = await healthResponse.json();
    $('#serviceStatus').textContent = ['server-side-wine', 'server-side-emulators'].includes(health.runtime) ? 'Render runtime online' : 'Service online';
    state.maxUploadMB = health.maxUploadMB || 100;
    $('#uploadLimit').textContent = state.maxUploadMB;
  } catch {
    $('#serviceStatus').textContent = 'Server unavailable';
  }
  await refreshLibrary();
  await refreshSession();
}

// Keep the free instance warm only while an app page is actively open. Render
// still spins down after inactivity; this is not an always-on keepalive service.
setInterval(() => {
  if (document.visibilityState === 'visible') fetch('/api/health', { cache: 'no-store' }).catch(() => {});
}, 90000);
init();
