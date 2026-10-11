# DownloadIdo — Chrome extension plan

Right-click any image or video → **Download image / video**. Files go straight to
`Downloads/DownloadIdo/` (no dialog).

## Decisions (from Q&A)
- Video scope: **try everything** — direct files, HLS streams, and MSE/blob players
  (captures what the player has buffered). DRM (EME) content is refused.
- Save mode: straight to `Downloads/DownloadIdo/`, auto-renamed on conflict.
- Hard cases: images under overlays, CSS background images, best resolution
  (srcset / `<picture>` / lazy `data-*`), "download all media on page".

## Architecture (Manifest V3, files under `extension/`)
| Part | Job |
|------|-----|
| `background.js` (service worker) | Context menus, `chrome.downloads`, sniffs `.m3u8` URLs per tab via `webRequest`, routes jobs |
| `content/detect.js` (all frames) | Remembers right-click point; finds media under it with `elementsFromPoint` (+ shadow DOM, + geometric fallback for `pointer-events:none`); collects all media for bulk |
| `content/mse-hook.js` (MAIN world, `document_start`) | Hooks `MediaSource.addSourceBuffer` / `SourceBuffer.appendBuffer` to keep buffered stream bytes |
| `offscreen/` (offscreen document) | Heavy work: HLS playlist parse, segment fetch, AES-128 decrypt, concat → blob URL for download |
| `lib/utils.js` | Pure helpers (srcset, filenames, CSS url parse, m3u8 parse) — unit tested |

## Video tiers (in order)
1. `currentSrc` / `<source>` is a real URL → direct download.
2. Player uses `blob:` and an HLS playlist was seen on the tab → fetch full stream (best variant).
3. Otherwise → export MSE-captured buffers (one file per track; audio + video may be separate).
4. `video.mediaKeys` set (DRM) → notice, no download.

## Testing
- `node --test` unit tests for `lib/utils.js`.
- Playwright e2e: loads unpacked extension, local fixture page (img, srcset, picture,
  overlay, `pointer-events:none`, CSS bg, `::before` bg, shadow DOM, iframe, mp4,
  ffmpeg-generated HLS played by hls.js), right-clicks, triggers the menu handler,
  asserts files land in the download folder.

## Known limits
- DRM video (Netflix, Spotify, Disney+…) cannot be downloaded.
- YouTube & similar: MSE capture only gets buffered parts, quality switches can corrupt,
  audio/video come as separate files. Downloading may violate the site's terms.
- Native Chrome menu items can't be shown per-element, so one menu item appears everywhere.
