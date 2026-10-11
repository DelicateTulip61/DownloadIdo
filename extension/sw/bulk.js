// "Download all images and videos on this page".
import { CONTENT_FILES, U, errorText, localStamp, mapLimit, notify } from './common.js';
import { saveUrl } from './downloads.js';

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
      items.push({ ...item, pageUrl: f.result.pageUrl });
    }
  }
  if (!items.length) {
    notify('Nothing to download', 'No images or videos found on this page.');
    return;
  }

  const subfolder = `${(top && top.result.host) || 'page'} ${localStamp()}`;
  let failed = 0;
  await mapLimit(items, BULK_CONCURRENCY, async (item) => {
    try {
      await saveUrl(item.url, { media: item.media, subfolder, pageUrl: item.pageUrl || tab.url || '' });
    } catch {
      failed++;
    }
  });

  const parts = [`Saving ${items.length - failed} files to Downloads/${U.BASE_FOLDER}/${U.sanitizeFilename(subfolder)}.`];
  if (failed) parts.push(`${failed} could not be started.`);
  if (skippedStreams) parts.push(`${skippedStreams} streamed video(s) skipped — right-click each one to save it.`);
  notify('Downloading page media', parts.join(' '));
}
