// Pure helpers shared by the service worker, content script, and offscreen document.
// Browser: sets globalThis.DownloadIdoUtils (classic script, content script or module import).
// Node tests: CommonJS module.exports.
// `var`, not const: this file can be injected again into the same isolated world (after an
// update, or by bulk re-injection), and redeclaring a top-level const would throw there.
var downloadIdoUtils = (function () {
  'use strict';

  const BASE_FOLDER = 'DownloadIdo';
  const MAX_NAME_LENGTH = 120;

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
    'video/mp2t': 'ts', 'video/x-matroska': 'mkv',
    'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/aac': 'aac',
    'audio/ogg': 'ogg', 'audio/mp2t': 'ts',
  };
  const KNOWN_EXTS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'heic', 'jfif', 'tif', 'tiff',
    'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'ts', 'm4a', 'mp3', 'aac', 'ogg', 'weba',
  ]);
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'jfif', 'tif', 'tiff']);
  const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

  /** Mime type ("video/mp4; codecs=...") → file extension, or '' if unknown. */
  function extFromMime(mime) {
    if (!mime) return '';
    return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
  }

  /** Lower-case extension of a URL's path (or format query hint), '' if not a known media ext. */
  function extFromUrl(url) {
    let u;
    try { u = new URL(url); } catch { return ''; }
    if (u.protocol === 'data:') {
      const m = /^data:([^;,]+)/i.exec(url);
      return m ? extFromMime(m[1]) : '';
    }
    const m = /\.([a-z0-9]{2,5})$/i.exec(u.pathname);
    if (m && KNOWN_EXTS.has(m[1].toLowerCase())) return m[1].toLowerCase();
    const hint = (u.searchParams.get('format') || u.searchParams.get('fm') || '').toLowerCase();
    return KNOWN_EXTS.has(hint) ? hint : '';
  }

  /** Make a string safe as a single Windows/macOS/Linux path segment. */
  function sanitizeFilename(name, fallback = 'download') {
    const trimEdges = (v) => v.trim().replace(/^[.\s]+|[.\s]+$/g, '');
    let s = trimEdges(String(name || '')
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // bidi / zero-width spoofing
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' '));
    const chars = Array.from(s); // code points, so emoji aren't split in half
    if (chars.length > MAX_NAME_LENGTH) s = trimEdges(chars.slice(0, MAX_NAME_LENGTH).join(''));
    if (!s || RESERVED_WIN.test(s.split('.')[0])) s = fallback;
    return s;
  }

  /** Split "name.ext" into [stem, ext] when ext is a known media extension. */
  function splitKnownExt(name) {
    const m = /^(.*)\.([a-z0-9]{2,5})$/i.exec(name);
    if (m && m[1] && KNOWN_EXTS.has(m[2].toLowerCase())) return [m[1], m[2].toLowerCase()];
    return [name, ''];
  }

  /** Best-effort base name (no extension) taken from the last path segment of a URL. */
  function stemFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'data:' || u.protocol === 'blob:') return '';
      let seg = u.pathname.split('/').filter(Boolean).pop() || '';
      try { seg = decodeURIComponent(seg); } catch { /* keep raw */ }
      return splitKnownExt(seg)[0];
    } catch {
      return '';
    }
  }

  /**
   * Build "DownloadIdo/<subfolder>/<name>.<ext>".
   * @param {{stem?: string, ext?: string, fallback?: string, subfolder?: string}} p
   */
  function buildDownloadPath({ stem, ext, fallback = 'download', subfolder = '' }) {
    const safeStem = sanitizeFilename(stem, fallback);
    const safeExt = String(ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const file = safeExt ? `${safeStem}.${safeExt}` : safeStem;
    const parts = [BASE_FOLDER];
    if (subfolder) parts.push(sanitizeFilename(subfolder, 'page'));
    parts.push(file);
    return parts.join('/');
  }

  /**
   * Parse a srcset attribute (HTML spec, simplified). URLs may contain commas
   * (e.g. Cloudinary "w_100,h_100"), so split on whitespace first, not on commas.
   * @returns {{url: string, w: number, x: number}[]}
   */
  function parseSrcset(srcset) {
    const out = [];
    const s = String(srcset || '');
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        while (i < s.length && s[i] !== ',') i++;
        descriptor = s.slice(start, i).trim();
      }
      if (!url) continue;
      let w = 0;
      let x = 0;
      for (const d of descriptor.split(/\s+/)) {
        const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(d);
        if (!m) continue;
        if (m[2].toLowerCase() === 'w') w = parseFloat(m[1]);
        else x = parseFloat(m[1]);
      }
      if (!w && !x) x = 1;
      out.push({ url, w, x });
    }
    return out;
  }

  /** Pick the largest candidate: width descriptors win over density descriptors. */
  function pickLargestCandidate(candidates) {
    let best = null;
    for (const c of candidates) {
      if (!best) { best = c; continue; }
      const cScore = c.w ? [1, c.w] : [0, c.x];
      const bScore = best.w ? [1, best.w] : [0, best.x];
      if (cScore[0] > bScore[0] || (cScore[0] === bScore[0] && cScore[1] > bScore[1])) best = c;
    }
    return best ? best.url : '';
  }

  /** All url(...) values from a computed CSS value such as background-image. */
  function extractCssUrls(value) {
    const urls = [];
    const re = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
    let m;
    while ((m = re.exec(String(value || '')))) {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      const url = raw.replace(/\\(.)/g, '$1');
      if (url) urls.push(url);
    }
    return urls;
  }

  function resolveUrl(url, base) {
    try { return new URL(url, base).href; } catch { return ''; }
  }

  function isHlsUrl(url) {
    try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return false; }
  }

  function isImageExt(ext) {
    return IMAGE_EXTS.has(ext);
  }

  // Known image hosts that serve resized copies: how to get the full-size original.
  // Each rule gets a parsed URL and returns the original's URL, or '' when it doesn't apply.
  // Callers must check the result exists (some originals 404) and fall back to the input.
  const FULL_SIZE_RULES = [
    { // X / Twitter: ?name=small|medium|large|900x900 -> name=orig
      name: 'twitter',
      apply: (u) => {
        if (u.hostname !== 'pbs.twimg.com' || !u.pathname.startsWith('/media/')) return '';
        if (u.searchParams.get('name') === 'orig') return '';
        u.searchParams.set('name', 'orig');
        return u.href;
      },
    },
    { // Wikimedia: /thumb/a/ab/File.jpg/800px-File.jpg -> /a/ab/File.jpg
      name: 'wikimedia',
      apply: (u) => {
        // Only image originals: video posters (Foo.webm/…jpg) and PDF pages (Doc.pdf/…jpg) are thumbs of non-images.
        const m = /^(\/[^/]+\/[^/]+)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\.(?:jpe?g|png|gif|webp|svg|tiff?))\/[^/]+$/i.exec(u.pathname);
        return u.hostname === 'upload.wikimedia.org' && m ? `${u.origin}${m[1]}${m[2]}` : '';
      },
    },
    { // Pinterest: /236x/ab/cd/ef/hash.jpg -> /originals/ab/cd/ef/hash.jpg
      name: 'pinterest',
      apply: (u) => {
        const m = /^\/(?:\d+x\d*(?:_RS)?)(\/.+)$/.exec(u.pathname);
        return u.hostname === 'i.pinimg.com' && m ? `${u.origin}/originals${m[1]}` : '';
      },
    },
    { // Reddit: preview.redd.it/id.jpg?width=640&s=… -> i.redd.it/id.jpg
      name: 'reddit',
      apply: (u) => (u.hostname === 'preview.redd.it' ? `https://i.redd.it${u.pathname}` : ''),
    },
    { // Imgur: thumbnails add one size letter to the 7-character id (abcdefgl.jpg)
      name: 'imgur',
      apply: (u) => {
        const m = /^\/([A-Za-z0-9]{7})[sbtmlh](\.[a-z]+)$/.exec(u.pathname);
        return u.hostname === 'i.imgur.com' && m ? `${u.origin}/${m[1]}${m[2]}` : '';
      },
    },
    { // YouTube thumbnails: hqdefault/mqdefault/sddefault -> maxresdefault
      name: 'youtube',
      apply: (u) => {
        const m = /^(\/vi(?:_webp)?\/[^/]+\/)(?:hq|mq|sd)?default(\.\w+)$/.exec(u.pathname);
        return u.hostname === 'i.ytimg.com' && m ? `${u.origin}${m[1]}maxresdefault${m[2]}` : '';
      },
    },
    { // Unsplash: drop resize parameters
      name: 'unsplash',
      apply: (u) => {
        if (u.hostname !== 'images.unsplash.com') return '';
        const before = u.search;
        for (const p of ['w', 'h', 'q', 'fit', 'crop', 'dpr', 'auto', 'fm']) u.searchParams.delete(p);
        return u.search !== before ? u.href : '';
      },
    },
    { // WordPress media library: photo-300x200.jpg -> photo.jpg
      name: 'wordpress',
      apply: (u) => {
        if (!u.pathname.includes('/wp-content/uploads/')) return '';
        const stripped = u.pathname.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1');
        return stripped !== u.pathname ? `${u.origin}${stripped}` : '';
      },
    },
    { // Shopify: name_400x400.jpg / name_400x.jpg and ?width=400
      name: 'shopify',
      apply: (u) => {
        if (u.hostname !== 'cdn.shopify.com' && !u.pathname.startsWith('/cdn/shop/')) return '';
        const before = u.href;
        // _400x400 / _400x / _x400 (2+ digits, so logo_2x.png stays); named sizes only on legacy /s/files/ paths.
        const named = u.pathname.startsWith('/s/files/') ? '|pico|icon|thumb|small|compact|medium|large|grande' : '';
        const suffix = new RegExp(`_(?:\\d{2,}x\\d*|\\d*x\\d{2,}${named})(@\\dx)?(\\.[a-z0-9]+)$`, 'i');
        u.pathname = u.pathname.replace(suffix, '$2');
        u.searchParams.delete('width');
        u.searchParams.delete('height');
        return u.href !== before ? u.href : '';
      },
    },
  ];

  /** The full-size original of a known resized image URL, or '' when no rule applies. */
  function fullSizeImageUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return ''; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    for (const rule of FULL_SIZE_RULES) {
      const out = rule.apply(new URL(parsed.href));
      if (out && out !== url) return out;
    }
    return '';
  }

  /** Loopback, private-network, link-local and local-only host names. */
  function isPrivateHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    return h === '::' || h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('::ffff:');
  }

  /**
   * May the extension request `url` on behalf of a page at `pageUrl`?
   * Only http(s), and a public page can't point us at the user's local network.
   */
  function isAllowedFetch(url, pageUrl) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!isPrivateHost(u.hostname)) return true;
    try { return isPrivateHost(new URL(pageUrl).hostname); } catch { return false; }
  }

  /** Total seconds of a parsed media playlist (sum of #EXTINF). */
  function playlistDuration(media) {
    return media.segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  }

  /** Does a playlist duration plausibly match the video element's duration? */
  function durationMatches(playlistSeconds, videoSeconds) {
    if (!Number.isFinite(videoSeconds) || videoSeconds <= 0) return true; // unknown: can't judge
    return Math.abs(playlistSeconds - videoSeconds) <= Math.max(2, videoSeconds * 0.03);
  }

  // ---------------------------------------------------------------- HLS (m3u8)

  /** Parse an attribute list: KEY=VALUE,KEY="quoted, value" */
  function parseAttrList(str) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    }
    return attrs;
  }

  /**
   * Parse a master or media playlist. Relative URIs are resolved against baseUrl.
   * Master: {type:'master', variants:[{url,bandwidth,audio}], audio:[{groupId,url,isDefault}]}
   * Media:  {type:'media', segments:[{url,key,sequence,byterange,duration}], map, endList}
   */
  function parseM3u8(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audio = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrList(line.slice(18));
          const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
          if (uri) {
            variants.push({
              url: resolveUrl(uri, baseUrl),
              bandwidth: parseInt(a['BANDWIDTH'] || a['AVERAGE-BANDWIDTH'] || '0', 10),
              audio: a['AUDIO'] || '',
            });
          }
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrList(line.slice(13));
          if (a['TYPE'] === 'AUDIO' && a['URI']) {
            audio.push({
              groupId: a['GROUP-ID'] || '',
              url: resolveUrl(a['URI'], baseUrl),
              isDefault: a['DEFAULT'] === 'YES',
            });
          }
        }
      }
      return { type: 'master', variants, audio };
    }

    const segments = [];
    let key = null;
    let map = null;
    let sequence = 0;
    let byterange = null;
    let duration = 0;
    let lastRangeEnd = 0;
    let endList = false;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        sequence = parseInt(line.slice(22), 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrList(line.slice(11));
        key = a['METHOD'] === 'NONE'
          ? null
          : { method: a['METHOD'], url: a['URI'] ? resolveUrl(a['URI'], baseUrl) : '', iv: a['IV'] || '' };
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrList(line.slice(11));
        map = { url: resolveUrl(a['URI'], baseUrl), byterange: parseByterange(a['BYTERANGE'], 0) };
      } else if (line.startsWith('#EXTINF:')) {
        duration = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        byterange = parseByterange(line.slice(17), lastRangeEnd);
      } else if (line === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (!line.startsWith('#')) {
        segments.push({ url: resolveUrl(line, baseUrl), key, sequence, byterange, duration });
        if (byterange) lastRangeEnd = byterange.offset + byterange.length;
        byterange = null;
        duration = 0;
        sequence++;
      }
    }
    return { type: 'media', segments, map, endList };
  }

  /** "length[@offset]" → {offset, length}; offset defaults to end of previous range. */
  function parseByterange(value, defaultOffset) {
    if (!value) return null;
    const [len, off] = String(value).split('@');
    return { length: parseInt(len, 10), offset: off !== undefined ? parseInt(off, 10) : defaultOffset };
  }

  /** Pick the highest-bandwidth variant and its matching audio rendition (if separate). */
  function pickBestVariant(master) {
    const variant = master.variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a), master.variants[0]);
    if (!variant) return { variant: null, audio: null };
    const group = master.audio.filter((r) => r.groupId === variant.audio);
    const audio = group.find((r) => r.isDefault) || group[0] || null;
    return { variant, audio };
  }

  /** 16-byte AES-128 IV: explicit hex IV attribute, else big-endian media sequence number. */
  function buildIv(ivHex, sequence) {
    const iv = new Uint8Array(16);
    if (ivHex) {
      const hex = ivHex.replace(/^0x/i, '').padStart(32, '0').slice(-32);
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
      return iv;
    }
    let n = sequence;
    for (let i = 15; i >= 12 && n > 0; i--) {
      iv[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    return iv;
  }

  const api = {
    BASE_FOLDER, extFromMime, extFromUrl, sanitizeFilename, splitKnownExt, stemFromUrl,
    buildDownloadPath, parseSrcset, pickLargestCandidate, extractCssUrls, resolveUrl,
    isHlsUrl, isImageExt, fullSizeImageUrl, isPrivateHost, isAllowedFetch, playlistDuration, durationMatches,
    parseM3u8, pickBestVariant, buildIv,
  };

  return api;
})();

if (typeof module === 'object' && module.exports) module.exports = downloadIdoUtils;
else globalThis.DownloadIdoUtils = downloadIdoUtils;
