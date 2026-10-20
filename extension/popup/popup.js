// Toolbar popup: jobs in progress and the recent DownloadIdo downloads.
// Lists come from storage (history ids, progress map) + chrome.downloads; nothing is kept here.
'use strict';

const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'heic', 'jfif', 'tif', 'tiff'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'ts'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'weba', 'wav', 'flac', 'opus'],
};
const KIND_LABEL = { image: 'IMG', video: 'VID', audio: 'MP3', file: 'FILE' };

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only: file names are untrusted
  return node;
}

function baseName(path) {
  return String(path || '').split(/[\\/]/).pop() || 'download';
}

function kindOf(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase() || '';
  return Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || 'file';
}

function formatSize(bytes) {
  if (!(bytes > 0)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function describe(item) {
  if (item.state === 'in_progress') {
    const pct = item.totalBytes > 0 ? Math.floor((item.bytesReceived / item.totalBytes) * 100) : null;
    return { text: pct === null ? `Downloading… ${formatSize(item.bytesReceived)}` : `Downloading… ${pct}%`, pct };
  }
  if (item.state === 'interrupted') return { text: `Failed · ${item.error || 'interrupted'}`.replaceAll('_', ' ').toLowerCase(), failed: true };
  if (item.exists === false) return { text: 'File was moved or deleted' };
  return { text: [formatSize(item.fileSize || item.totalBytes), timeAgo(item.endTime || item.startTime)].filter(Boolean).join(' · ') };
}

function actionButton(label, onClick) {
  const b = el('button', 'btn ghost', label);
  b.addEventListener('click', onClick);
  return b;
}

function renderItem(item) {
  const name = baseName(item.filename);
  const kind = kindOf(name);
  const row = el('li', 'item');
  row.append(el('div', `kind ${kind}`, KIND_LABEL[kind]));

  const info = el('div', 'info');
  info.append(el('div', 'name', name));
  const status = describe(item);
  info.append(el('div', status.failed ? 'meta failed' : 'meta', status.text));
  if (typeof status.pct === 'number') {
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = `${status.pct}%`;
    bar.append(fill);
    info.append(bar);
  }
  info.title = item.filename;
  row.append(info);

  const actions = el('div', 'actions');
  if (item.state === 'complete' && item.exists !== false) {
    actions.append(actionButton('Open', () => chrome.downloads.open(item.id)));
    actions.append(actionButton('Show', () => chrome.downloads.show(item.id)));
  }
  row.append(actions);
  return row;
}

async function renderJobs() {
  const { progress = {} } = await chrome.storage.session.get('progress');
  const entries = Object.entries(progress);
  $('working').hidden = entries.length === 0;
  const rows = await Promise.all(entries.map(async ([tabId, text]) => {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    const row = el('li', 'item');
    row.append(el('div', 'kind video', '…'));
    const info = el('div', 'info');
    info.append(el('div', 'name', (tab && tab.title) || 'A tab'));
    info.append(el('div', 'meta', `Saving stream · ${text}`));
    const pct = parseInt(text, 10);
    if (Number.isFinite(pct)) {
      const bar = el('div', 'bar');
      const fill = el('span');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      info.append(bar);
    }
    row.append(info, el('div'));
    return row;
  }));
  $('jobs').replaceChildren(...rows);
}

async function renderRecent() {
  const stored = await chrome.storage.local.get('history');
  const history = /** @type {number[]} */ (stored.history || []);
  const items = history.length ? await chrome.downloads.search({ limit: 0 }) : [];
  const byId = new Map(items.map((d) => [d.id, d]));
  const rows = history.map((id) => byId.get(id)).filter(Boolean).map(renderItem);
  $('recent').replaceChildren(...rows);
  $('empty').hidden = rows.length > 0;
  $('clear').hidden = rows.length === 0;
}

let pending = null;
function render() {
  // Coalesce bursts of download/storage events into one redraw.
  clearTimeout(pending);
  pending = setTimeout(() => { renderJobs(); renderRecent(); }, 50);
}

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('clear').addEventListener('click', () => chrome.storage.local.set({ history: [] }));
chrome.downloads.onChanged.addListener(render);
chrome.storage.onChanged.addListener(render);

renderJobs();
renderRecent();
