// Small helpers shared by the service-worker modules.
import '../lib/utils.js';

export const U = globalThis.DownloadIdoUtils;
export const CONTENT_FILES = ['lib/utils.js', 'lib/fmp4.js', 'content/detect.js'];

export function errorText(e) {
  return String((e && e.message) || e || 'Unknown error');
}

export function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}

/** Toolbar badge for a tab's running job ('' when done); the popup lists the same progress. */
export function setBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  progressWrites = progressWrites.then(async () => {
    const { progress = {} } = await chrome.storage.session.get('progress');
    const next = { .../** @type {Record<string, string>} */ (progress) };
    if (text) next[tabId] = text;
    else delete next[tabId];
    await chrome.storage.session.set({ progress: next });
  }).catch(() => {});
}

/** @type {Promise<unknown>} */
let progressWrites = Promise.resolve();

/** Call a DownloadIdoContent method in one frame. Returns null when the script is missing. */
export async function callContent(tabId, frameId, method, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (m, a) => (globalThis.DownloadIdoContent ? globalThis.DownloadIdoContent[m](...a) : null),
    args: [method, args],
  });
  return res ? res.result : null;
}

export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}
