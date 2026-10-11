// Globals shared between the extension's classic scripts (type checking only).

type DownloadIdoUtilsApi = typeof import('../extension/lib/utils.js');

declare var DownloadIdoUtils: DownloadIdoUtilsApi;
declare var DownloadIdoFmp4: typeof import('../extension/lib/fmp4.js');
declare var DownloadIdoContent: Record<string, (...args: any[]) => any> | undefined;
declare var DownloadIdo: {
  handleMenuClick: (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => Promise<void>;
  injectIntoOpenTabs: () => Promise<void>;
};

declare var module: { exports: unknown } | undefined;
