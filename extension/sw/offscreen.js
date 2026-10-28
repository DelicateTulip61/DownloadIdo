// The offscreen document runs long jobs (HLS joins, Referer re-fetches); this module starts
// them and routes their completion messages to the module that asked.
import { errorText, notify, setBadge } from './common.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// ------------------------------------------------------------------ Referer rules
// Hotlink-protected servers refuse requests without the page's Referer. A short-lived
// declarativeNetRequest session rule adds it to the offscreen document's requests.

/** @type {Promise<unknown>} */
let ruleWrites = Promise.resolve();
/** Add the page's Referer to the offscreen document's requests until removeRule(id). */
function addRefererRule(pageUrl) {
  const add = ruleWrites.then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const id = rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: pageUrl }] },
        condition: { tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] },
      }],
    });
    return id;
  });
  ruleWrites = add.catch(() => {});
  return add;
}

function removeRule(id) {
  if (id) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

// ------------------------------------------------------------------ jobs

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen = creatingOffscreen || chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: 'Join streamed video segments into one file for download.',
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

/** Hand a job to the offscreen document; its requests carry the page's Referer meanwhile. */
export async function startOffscreenJob(job) {
  await ensureOffscreen();
  const refererRule = job.pageUrl ? await addRefererRule(job.pageUrl).catch(() => 0) : 0;
  await chrome.runtime.sendMessage({ target: 'offscreen', ...job, refererRule });
}

export async function startHls(job) {
  setBadge(job.tabId, '0%');
  await startOffscreenJob({ type: 'hls', ...job });
}

/** @type {Record<string, (msg: any) => Promise<void>>} */
const doneHandlers = {};

/** Register what happens when an offscreen job of `type` finishes ('hls', 'fetch'). */
export function onJobDone(type, handler) {
  doneHandlers[`${type}-done`] = handler;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const fromOffscreen = sender.id === chrome.runtime.id && (sender.url || '').endsWith(OFFSCREEN_PATH);
  if (!fromOffscreen || !msg) return false;
  if (msg.type === 'hls-progress') setBadge(msg.tabId, `${msg.pct}%`);
  const handler = doneHandlers[msg.type];
  if (handler) {
    removeRule(msg.job.refererRule);
    handler(msg).catch((e) => notify('Download failed', errorText(e)));
  }
  return false;
});
