// Streamed (blob:) videos: plain Blob → sniffed HLS playlist → MSE buffer capture.
import { callContent, notify, setBadge } from './common.js';
import { saveFiles } from './downloads.js';
import { onJobDone, startHls } from './offscreen.js';
import { getPlaylists } from './playlists.js';

export async function saveStream(tabId, frameId, target, pageUrl) {
  const stem = target.title || 'video';
  const asBlob = await callContent(tabId, frameId, 'exportStream', [target.marker, 'blob']);
  if (asBlob && asBlob.files) {
    await saveFiles(asBlob.files, stem);
    return;
  }
  const playlists = await getPlaylists(tabId);
  if (playlists.length) {
    await startHls({ tabId, frameId, pageUrl, playlists, stem, marker: target.marker, duration: target.duration });
    return;
  }
  await saveMse(tabId, frameId, target.marker, stem);
}

async function saveMse(tabId, frameId, marker, stem) {
  const res = await callContent(tabId, frameId, 'exportStream', [marker, 'mse']);
  if (!res || res.error) {
    notify('Could not save video', (res && res.error) || 'The page was closed.');
    return;
  }
  await saveFiles(res.files, stem);
  const notes = ['Saved the part of the video the player had loaded. For the full video, let it play to the end, then download again.'];
  if (res.files.length > 1) notes.push('Video and audio were saved as separate files.');
  if (res.truncated) notes.push('Some of the stream was dropped to save memory, so the file may have gaps.');
  notify('Video saved (partial capture)', notes.join(' '));
}

onJobDone('hls', async ({ job, files, live, error }) => {
  setBadge(job.tabId, '');
  if (error) {
    if (job.marker !== undefined) {
      await saveMse(job.tabId, job.frameId || 0, job.marker, job.stem);
      return;
    }
    notify('Could not save video stream', error);
    return;
  }
  await saveFiles(files, job.stem);
  if (job.marker !== undefined) callContent(job.tabId, job.frameId || 0, 'clearMarker', [job.marker]).catch(() => {});
  if (files.length > 1) notify('Video saved', 'Video and audio were saved as separate files.');
  if (live) notify('Live stream', 'This is a live stream, so only the part available right now was saved.');
});
