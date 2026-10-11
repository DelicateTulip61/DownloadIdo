// "Download image / video": resolve what was right-clicked and save it.
import { callContent, notify } from './common.js';
import { saveFiles, saveUrl } from './downloads.js';
import { startHls } from './offscreen.js';
import { saveStream } from './streams.js';

export async function downloadTarget(info, tab) {
  const frameId = info.frameId || 0;
  let target = null;
  try {
    target = await callContent(tab.id, frameId, 'resolveTarget');
  } catch {
    // restricted page (chrome://, web store, PDF viewer): fall back to Chrome's own info
  }
  if ((!target || target.kind === 'none') && info.srcUrl && /^(https?|data):/i.test(info.srcUrl)) {
    target = { kind: 'url', url: info.srcUrl, media: info.mediaType === 'video' ? 'video' : 'image' };
  }
  if (!target) {
    notify('Reload the page', 'DownloadIdo was installed after this page opened. Reload the page and try again.');
    return;
  }
  const pageUrl = target.pageUrl || info.frameUrl || tab.url || ''; // the frame's URL: what its servers expect as Referer

  switch (target.kind) {
    case 'url':
      await saveUrl(target.url, { media: target.media, pageUrl });
      return;
    case 'blob': {
      const res = await callContent(tab.id, frameId, 'fetchBlobUrl', [target.url]);
      if (!res || res.error) throw new Error((res && res.error) || 'The page was closed.');
      await saveFiles([res], 'image', 'image');
      return;
    }
    case 'hls':
      await startHls({ tabId: tab.id, pageUrl, playlists: [target.url], stem: target.title || 'video', duration: target.duration });
      return;
    case 'stream':
      await saveStream(tab.id, frameId, target, pageUrl);
      return;
    case 'drm':
      notify('Protected video', 'This video is DRM-protected, so it cannot be downloaded.');
      return;
    default:
      notify('Nothing to download', target.reason || 'No image or video found there.');
  }
}
