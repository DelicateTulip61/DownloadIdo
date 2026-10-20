// Options page: saves each change straight to chrome.storage.sync (read by sw/settings.js).
'use strict';

const DEFAULTS = { folder: 'DownloadIdo', saveAs: false, mp3Kbps: 192 }; // keep in sync with sw/settings.js
const U = globalThis.DownloadIdoUtils;
const form = /** @type {HTMLFormElement & {saveAs: HTMLInputElement, mp3Kbps: RadioNodeList}} */ (document.getElementById('form'));
const folderInput = /** @type {HTMLInputElement} */ (document.getElementById('folder'));
const statusLine = document.getElementById('status');

/** The folder name exactly as downloads will use it (same sanitizing as the service worker). */
function cleanFolder(value) {
  return U.sanitizeFilename(String(value || '').trim(), DEFAULTS.folder);
}

function showPreview() {
  document.getElementById('preview').textContent = `Downloads/${cleanFolder(folderInput.value)}/`;
}

let statusTimer = null;
function flashSaved() {
  statusLine.textContent = 'Saved';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusLine.textContent = ''; }, 1500);
}

async function save() {
  await chrome.storage.sync.set({
    folder: cleanFolder(folderInput.value),
    saveAs: form.saveAs.checked,
    mp3Kbps: Number(form.mp3Kbps.value) || DEFAULTS.mp3Kbps,
  });
  flashSaved();
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  folderInput.value = String(s.folder);
  form.saveAs.checked = s.saveAs === true;
  form.mp3Kbps.value = String(s.mp3Kbps);
  showPreview();
}

folderInput.addEventListener('input', showPreview);
folderInput.addEventListener('change', () => {
  folderInput.value = cleanFolder(folderInput.value);
  showPreview();
  save();
});
form.addEventListener('change', (e) => { if (e.target !== folderInput) save(); });
form.addEventListener('submit', (e) => e.preventDefault());

load();
