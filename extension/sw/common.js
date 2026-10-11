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

export function setBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

/** Call a DownloadIdoContent method in one frame. Returns null when the script is missing. */
export async function callContent(tabId, frameId, method, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (m, a) => (globalThis.DownloadIdoContent ? globalThis.DownloadIdoContent[m](...a) : null),
    args: [method, args],
  });
  return res ? res.result : null;
}

export async function mapLimit(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}
