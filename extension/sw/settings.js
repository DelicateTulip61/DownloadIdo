// User settings (chrome.storage.sync), edited on the options page.

export const DEFAULT_SETTINGS = Object.freeze({
  folder: 'DownloadIdo', // folder inside the browser's download folder
  saveAs: false, // ask where to save single downloads
  mp3Kbps: 192,
});

export const MP3_KBPS_CHOICES = [128, 192, 320];

/** Current settings, with defaults for anything unset or invalid. */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    folder: typeof stored.folder === 'string' && stored.folder.trim() ? stored.folder.trim() : DEFAULT_SETTINGS.folder,
    saveAs: stored.saveAs === true,
    mp3Kbps: MP3_KBPS_CHOICES.includes(Number(stored.mp3Kbps)) ? Number(stored.mp3Kbps) : DEFAULT_SETTINGS.mp3Kbps,
  };
}
