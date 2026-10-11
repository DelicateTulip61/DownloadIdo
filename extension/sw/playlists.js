// Remember HLS playlists each tab loads, so blob: players can be saved in full.
import { U } from './common.js';

const MAX_PLAYLISTS_PER_TAB = 15;

// Writes go through one chain so a page navigation's reset can't race a pending add.
let playlistWrites = Promise.resolve();
function updatePlaylists(tabId, change) {
  playlistWrites = playlistWrites.then(async () => {
    const key = `hls:${tabId}`;
    const { [key]: list = [] } = await chrome.storage.session.get(key);
    const next = change(list);
    if (next.length) await chrome.storage.session.set({ [key]: next });
    else await chrome.storage.session.remove(key);
  }).catch(() => {});
  return playlistWrites;
}

/** Non-blocking webRequest listener (chrome's typings expect a BlockingResponse). */
function onRequest(listener, filter) {
  chrome.webRequest.onBeforeRequest.addListener(/** @type {any} */ (listener), filter);
}

onRequest(
  (details) => {
    if (details.tabId < 0 || !U.isHlsUrl(details.url)) return;
    updatePlaylists(details.tabId, (list) => [details.url, ...list.filter((u) => u !== details.url)].slice(0, MAX_PLAYLISTS_PER_TAB));
  },
  { urls: ['*://*/*.m3u8*'] },
);

onRequest(
  (details) => {
    if (details.tabId >= 0) updatePlaylists(details.tabId, () => []);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => updatePlaylists(tabId, () => []));

/** Playlists the tab has loaded, newest first. @returns {Promise<string[]>} */
export async function getPlaylists(tabId) {
  await playlistWrites;
  const key = `hls:${tabId}`;
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  return /** @type {string[]} */ (list);
}
