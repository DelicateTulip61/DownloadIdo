// "Download audio as MP3": the right-clicked video/audio's sound, as an .mp3.
// Direct URLs and HLS are converted in the offscreen document; page-owned streams (blob:,
// MediaSource) in the page's content script, which reports back by message.
import { U, callContent, notify, setBadge } from './common.js';
import { saveFiles, saveUrl } from './downloads.js';
import { onJobDone, startOffscreenJob } from './offscreen.js';
import { getPlaylists } from './playlists.js';

export const MP3_FILES = ['vendor/lamejs.js', 'lib/mpegts.js', 'lib/mp3.js'];
const MAX_SECONDS = 60 * 60; // matches lib/mp3.js: decoded audio is held in memory

const NO_AUDIO = 'Right-click a video or audio player to save its sound as MP3.';

export async function downloadMp3(info, tab) {
  const frameId = info.frameId || 0;
  let target = null;
  try {
    target = await callContent(tab.id, frameId, 'resolveTarget');
  } catch {
    // restricted page: fall back to Chrome's own info below
  }
  const chromeMedia = info.mediaType === 'video' || info.mediaType === 'audio';
  if ((!target || target.kind === 'none') && chromeMedia && /^https?:/i.test(info.srcUrl || '')) {
    target = { kind: 'url', url: info.srcUrl, media: info.mediaType };
  }
  if (!target) {
    notify('Reload the page', 'DownloadIdo was installed after this page opened. Reload the page and try again.');
    return;
  }
  if (Number.isFinite(target.duration) && target.duration > MAX_SECONDS) {
    notify('Too long for MP3', 'Audio longer than 60 minutes can\'t be converted to MP3.');
    return;
  }
  const pageUrl = target.pageUrl || info.frameUrl || tab.url || '';
  const stem = target.title || U.stemFromUrl(target.url || '') || 'audio';

  switch (target.kind) {
    case 'url':
      if (target.media === 'image') break;
      if (U.extFromUrl(target.url) === 'mp3') {
        await saveUrl(target.url, { media: 'audio', pageUrl }); // already MP3: no re-encode
        return;
      }
      setBadge(tab.id, '0%');
      await startOffscreenJob({ type: 'mp3', tabId: tab.id, url: target.url, pageUrl, stem });
      return;
    case 'hls':
      setBadge(tab.id, '0%');
      await startOffscreenJob({ type: 'hlsmp3', tabId: tab.id, pageUrl, playlists: [target.url], stem, duration: target.duration });
      return;
    case 'stream':
      await streamMp3(tab.id, frameId, target, pageUrl, stem);
      return;
    case 'drm':
      notify('Protected video', 'This video is DRM-protected, so its audio cannot be saved.');
      return;
    case 'none':
      notify('Nothing to convert', target.reason || NO_AUDIO);
      return;
    default:
      break; // images (url/blob)
  }
  notify('No audio here', NO_AUDIO);
}

/** blob: video/audio: plain Blob → sniffed HLS playlist (audio only) → MSE capture. */
async function streamMp3(tabId, frameId, target, pageUrl, stem) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: MP3_FILES });
  const asBlob = await startContentMp3(tabId, frameId, target.marker, 'blob', stem);
  if (asBlob.started) return;
  if (asBlob.error !== 'not-a-blob' && asBlob.error !== 'empty') {
    notify('Could not save audio', asBlob.error);
    return;
  }
  const playlists = await getPlaylists(tabId);
  if (playlists.length) {
    setBadge(tabId, '0%');
    await startOffscreenJob({ type: 'hlsmp3', tabId, frameId, pageUrl, playlists, stem, marker: target.marker, duration: target.duration });
    return;
  }
  const fromMse = await startContentMp3(tabId, frameId, target.marker, 'mse', stem);
  if (!fromMse.started) notify('Could not save audio', fromMse.error);
}

// ------------------------------------------------------------------ content-script jobs

const contentJobs = new Map(); // jobId -> {tabId, stem, partial}; mirrored in session storage

async function startContentMp3(tabId, frameId, marker, mode, stem) {
  const jobId = `mp3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { tabId, stem, partial: mode === 'mse' };
  contentJobs.set(jobId, job);
  chrome.storage.session.set({ [jobId]: job }).catch(() => {});
  setBadge(tabId, '0%');
  const res = (await callContent(tabId, frameId, 'startStreamMp3', [marker, mode, jobId])) || { error: 'The page was closed.' };
  if (!res.started) {
    await takeContentJob(jobId);
    setBadge(tabId, '');
  }
  return res;
}

async function takeContentJob(jobId) {
  const job = contentJobs.get(jobId) || (await chrome.storage.session.get(jobId))[jobId];
  contentJobs.delete(jobId);
  chrome.storage.session.remove(jobId).catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (sender.id !== chrome.runtime.id || tabId === undefined || !msg || typeof msg.jobId !== 'string') return false;
  if (msg.type === 'mp3-progress') setBadge(tabId, `${msg.pct}%`);
  if (msg.type === 'mp3-done') onContentMp3Done(msg, tabId).catch((e) => notify('Could not save audio', String(e && e.message || e)));
  return false;
});

async function onContentMp3Done({ jobId, url, error, truncated }, tabId) {
  const job = await takeContentJob(jobId);
  if (!job || job.tabId !== tabId) return; // not a job this tab was asked to run
  setBadge(tabId, '');
  if (error) {
    notify('Could not save audio', error);
    return;
  }
  if (!String(url).startsWith('blob:')) return;
  await saveFiles([{ url, ext: 'mp3' }], job.stem, 'audio');
  if (job.partial) {
    const notes = ['Saved the audio the player had loaded. For all of it, let it play to the end, then save again.'];
    if (truncated) notes.push('Some of the stream was dropped to save memory, so the file may have gaps.');
    notify('Audio saved (partial capture)', notes.join(' '));
  }
}

// ------------------------------------------------------------------ offscreen jobs

async function onOffscreenMp3Done({ job, files, live, error }) {
  setBadge(job.tabId, '');
  if (error) {
    if (job.marker !== undefined) { // HLS failed for a page stream: use what the player loaded
      const fromMse = await startContentMp3(job.tabId, job.frameId || 0, job.marker, 'mse', job.stem);
      if (!fromMse.started) notify('Could not save audio', fromMse.error);
      return;
    }
    notify('Could not save audio', error);
    return;
  }
  await saveFiles(files, job.stem, 'audio');
  if (live) notify('Live stream', 'This is a live stream, so only the part available right now was saved.');
}

onJobDone('mp3', onOffscreenMp3Done);
onJobDone('hlsmp3', onOffscreenMp3Done);
