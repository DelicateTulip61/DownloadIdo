// "Download all images and videos on this page".
import { CONTENT_FILES, U, errorText, localStamp, notify } from './common.js';
import { saveUrl } from './downloads.js';
import { getSettings } from './settings.js';

const BULK_CONCURRENCY = 4;

async function collectFrames(tabId) {
  const run = () => chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (globalThis.DownloadIdoContent ? globalThis.DownloadIdoContent.collectAll() : null),
  });
  let results = await run();
  if (results.some((r) => !r.result)) {
    // Page opened before install: inject the detector, then ask again.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
    results = await run();
  }
  return results.filter((r) => r.result);
}

export async function downloadAll(tab) {
  let frames;
  try {
    frames = await collectFrames(tab.id);
  } catch (e) {
    notify('Cannot read this page', `Chrome doesn't allow extensions here. (${errorText(e)})`);
    return;
  }
  const top = frames.find((f) => f.frameId === 0) || frames[0];
  const seen = new Set();
  const items = [];
  let skippedStreams = 0;
  for (const f of frames) {
    skippedStreams += f.result.skippedStreams;
    for (const item of f.result.items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push({ ...item, pageUrl: f.result.pageUrl || tab.url || '' });
    }
  }
  if (!items.length) {
    notify('Nothing to download', 'No images or videos found on this page.');
    return;
  }
  const subfolder = `${(top && top.result.host) || 'page'} ${localStamp()}`;
  await chrome.storage.session.set({ [QUEUE_KEY]: { subfolder, pending: items, inflight: [], started: 0, failed: 0, skippedStreams } });
  await runQueue();
}

// The job lives in session storage, not in memory: Chrome may stop the service worker in the
// middle of a long page, and the next start picks the queue up again (resumeQueue below).
const QUEUE_KEY = 'bulkQueue';

/**
 * @typedef {{url: string, media: string, pageUrl: string}} BulkItem
 * @typedef {{subfolder: string, pending: BulkItem[], inflight: BulkItem[], started: number,
 *   failed: number, skippedStreams: number}} BulkQueue
 */

/** @returns {Promise<BulkQueue | undefined>} */
async function readQueue() {
  const stored = await chrome.storage.session.get(QUEUE_KEY);
  return /** @type {BulkQueue | undefined} */ (stored[QUEUE_KEY]);
}
let running = null;
/** @type {Promise<unknown>} */
let queueWrites = Promise.resolve();

/** Atomically read-modify-write the queue (one writer chain per worker). */
function updateQueue(change) {
  const next = queueWrites.then(async () => {
    const queue = await readQueue();
    if (!queue) return null;
    const result = change(queue);
    await chrome.storage.session.set({ [QUEUE_KEY]: queue });
    return result;
  });
  queueWrites = next.catch(() => {});
  return next;
}

function runQueue() {
  running = running || processQueue().finally(() => { running = null; });
  return running;
}

async function processQueue() {
  // Items that were in flight when an earlier worker stopped are tried again first.
  await updateQueue((q) => { q.pending = [...q.inflight, ...q.pending]; q.inflight = []; });
  const take = () => updateQueue((q) => {
    const item = q.pending.shift();
    if (item) q.inflight.push(item);
    return item || null;
  });
  const worker = async () => {
    for (let item = await take(); item; item = await take()) {
      const queue = await readQueue();
      if (!queue) return;
      let ok = true;
      try {
        await saveUrl(item.url, { media: item.media, subfolder: queue.subfolder, pageUrl: item.pageUrl });
      } catch {
        ok = false;
      }
      await updateQueue((q) => {
        q.inflight = q.inflight.filter((x) => x.url !== item.url);
        if (ok) q.started++;
        else q.failed++;
      });
    }
  };
  await Promise.all(Array.from({ length: BULK_CONCURRENCY }, worker));

  const done = await readQueue();
  await chrome.storage.session.remove(QUEUE_KEY);
  if (!done) return;
  const { folder } = await getSettings();
  const parts = [`Saving ${done.started} files to Downloads/${U.sanitizeFilename(folder)}/${U.sanitizeFilename(done.subfolder)}.`];
  if (done.failed) parts.push(`${done.failed} could not be started.`);
  if (done.skippedStreams) parts.push(`${done.skippedStreams} streamed video(s) skipped — right-click each one to save it.`);
  notify('Downloading page media', parts.join(' '));
}

/** On worker start: finish a bulk download an earlier worker didn't. */
async function resumeQueue() {
  if (await readQueue()) await runQueue();
}
resumeQueue().catch(() => {});

/** Exposed for tests: process a stored queue now. */
export const resumeBulk = resumeQueue;
