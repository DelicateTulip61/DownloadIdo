// Saving files into Downloads/DownloadIdo/, with full-size swaps and a hotlink retry.
import { U, errorText, notify } from './common.js';
import { onJobDone, startOffscreenJob } from './offscreen.js';

const SNIFF_TIMEOUT_MS = 5000;
const RETRYABLE_ERROR = /^(SERVER_|NETWORK_)/;

/**
 * Ask the server about a URL without downloading it: does it exist, and what file type is it?
 * @returns {Promise<{ok: boolean, ext: string}>}
 */
async function probeUrl(url, pageUrl) {
  if (!U.isAllowedFetch(url, pageUrl)) return { ok: false, ext: '' };
  const tries = [{ method: 'HEAD' }, { method: 'GET', headers: { Range: 'bytes=0-0' } }]; // some servers reject HEAD
  for (const opts of tries) {
    try {
      const res = await fetch(url, { ...opts, credentials: 'include', signal: AbortSignal.timeout(SNIFF_TIMEOUT_MS) });
      res.body?.cancel();
      if (res.ok) return { ok: true, ext: U.extFromMime(res.headers.get('content-type')) };
    } catch {
      // try the next way
    }
  }
  return { ok: false, ext: '' };
}

/** Swap a known resized image URL for its full-size original, if the original really exists. */
async function preferFullSize(url, pageUrl) {
  const full = U.fullSizeImageUrl(url);
  if (!full) return { url, ext: '' };
  const probe = await probeUrl(full, pageUrl);
  // Must exist AND be served as an image (a rule could point at a video or a document).
  return probe.ok && U.isImageExt(probe.ext) ? { url: full, ext: probe.ext } : { url, ext: '' };
}

const retries = new Map(); // downloadId -> {url, filename, pageUrl}; mirrored in session storage

function rememberRetry(id, entry) {
  retries.set(id, entry); // synchronously, before onChanged can fire for a fast 403
  chrome.storage.session.set({ [`retry:${id}`]: entry }).catch(() => {});
}

async function takeRetry(id) {
  const key = `retry:${id}`;
  const entry = retries.get(id) || (await chrome.storage.session.get(key))[key];
  retries.delete(id);
  chrome.storage.session.remove(key).catch(() => {});
  return entry;
}

/**
 * Save a URL into Downloads/DownloadIdo/. If the server refuses it (hotlink protection),
 * onChanged retries once with the page's Referer.
 */
export async function saveUrl(requestedUrl, { media = 'image', subfolder = '', pageUrl = '' } = {}) {
  const isData = /^data:/i.test(requestedUrl);
  if (!isData && !U.isAllowedFetch(requestedUrl, pageUrl)) throw new Error('That address is not allowed (local network or unsupported link).');
  const best = media === 'image' && !isData ? await preferFullSize(requestedUrl, pageUrl) : { url: requestedUrl, ext: '' };
  const url = best.url;
  const ext = U.extFromUrl(url) || best.ext || (isData ? '' : (await probeUrl(url, pageUrl)).ext) || (media === 'video' ? 'mp4' : 'jpg');
  const filename = U.buildDownloadPath({ stem: U.stemFromUrl(url), ext, fallback: media, subfolder });
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  if (!isData && pageUrl) rememberRetry(id, { url, filename, pageUrl });
  return id;
}

/** Save extension/page-made blob URLs (stream exports, HLS output, blob images). */
export async function saveFiles(files, stem, fallback = 'video') {
  for (const f of files) {
    const ext = f.ext || U.extFromMime(f.mime) || (fallback === 'image' ? 'png' : 'mp4');
    const name = f.part ? `${stem} (${f.part})` : stem;
    await chrome.downloads.download({
      url: f.url,
      filename: U.buildDownloadPath({ stem: name, ext, fallback }),
      conflictAction: 'uniquify',
      saveAs: false,
    });
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const retry = await takeRetry(delta.id);
  if (!retry || state === 'complete') return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || !RETRYABLE_ERROR.test(item.error || '')) return;
  // chrome.downloads requests can't get headers changed, but the offscreen document's fetches
  // can: fetch there with the page's Referer, then save the result.
  try {
    await startOffscreenJob({ type: 'fetch', url: retry.url, filename: retry.filename, pageUrl: retry.pageUrl });
  } catch (e) {
    notify('Download blocked', `The site refused the file (${item.error}). ${errorText(e)}`);
  }
});

onJobDone('fetch', async ({ job, url, error }) => {
  if (error) {
    notify('Download blocked', `The site refused the file. ${error}`);
    return;
  }
  await chrome.downloads.download({ url, filename: job.filename, conflictAction: 'uniquify', saveAs: false });
});
