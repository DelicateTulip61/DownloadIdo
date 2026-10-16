// Globals shared between the extension's classic scripts (type checking only).

type DownloadIdoUtilsApi = typeof import('../extension/lib/utils.js');

declare var DownloadIdoUtils: DownloadIdoUtilsApi;
declare var DownloadIdoFmp4: typeof import('../extension/lib/fmp4.js');
declare var DownloadIdoMp3: typeof import('../extension/lib/mp3.js');
declare var DownloadIdoMpegts: typeof import('../extension/lib/mpegts.js');
declare var lamejs: { Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => { encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array; flush(): Int8Array } };
declare var DownloadIdoContent: Record<string, (...args: any[]) => any> | undefined;
declare var DownloadIdo: {
  handleMenuClick: (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => Promise<void>;
  injectIntoOpenTabs: () => Promise<void>;
};

declare var module: { exports: unknown } | undefined;
