// Runs in the page's MAIN world at document_start.
// Keeps a copy of every chunk a player appends to a MediaSource SourceBuffer, so streamed
// (blob:) videos can be saved later. Only what the player has loaded is captured.
// Memory is bounded: one shared budget per page, oldest captures are dropped first, and
// DRM players (encrypted, so useless to save) are never copied.
(function () {
  'use strict';
  if (typeof MediaSource === 'undefined') return;

  const MSG_SOURCE = 'downloadido';
  const PAGE_BUDGET_BYTES = 512 * 1024 * 1024; // all captures on this page together

  const tracksBySourceBuffer = new WeakMap(); // SourceBuffer -> track
  const tracksByMediaSource = new WeakMap(); // MediaSource -> track[]
  const mediaSourceByUrl = new Map(); // blob: URL -> WeakRef(MediaSource); players often revoke the URL right away
  const allTracks = []; // capture order, for eviction
  const drmVideos = []; // WeakRef(<video>) that had MediaKeys attached
  let totalBytes = 0;

  function mediaSourceOf(video) {
    if (video.srcObject instanceof MediaSource) return video.srcObject;
    const ref = mediaSourceByUrl.get(video.currentSrc || video.src);
    return ref ? ref.deref() : null;
  }

  function isDrmMediaSource(ms) {
    return drmVideos.some((ref) => {
      const v = ref.deref();
      return v && mediaSourceOf(v) === ms;
    });
  }

  /** Stop copying (and free) a MediaSource's tracks: its content is encrypted. */
  function markDrm(ms) {
    for (const t of tracksByMediaSource.get(ms) || []) {
      dropTrack(t, 'drm');
      t.truncated = true;
    }
  }

  function dropTrack(track, reason) {
    totalBytes -= track.bytes;
    track.chunks = [];
    track.bytes = 0;
    track[reason] = true;
  }

  /** Free the oldest captures (not `keep`) until `extra` more bytes fit in the page budget. */
  function makeRoom(extra, keep) {
    for (const t of allTracks) {
      if (totalBytes + extra <= PAGE_BUDGET_BYTES) return true;
      if (t !== keep && t.bytes) dropTrack(t, 'evicted');
    }
    return totalBytes + extra <= PAGE_BUDGET_BYTES;
  }

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAddSourceBuffer.apply(this, arguments);
    try {
      const drm = isDrmMediaSource(this);
      const track = { mime: String(mime), chunks: [], bytes: 0, truncated: drm, evicted: false, drm };
      tracksBySourceBuffer.set(sb, track);
      allTracks.push(track);
      const list = tracksByMediaSource.get(this);
      if (list) list.push(track);
      else {
        tracksByMediaSource.set(this, [track]);
        // Detached from its video: nobody can export it any more, so free it.
        this.addEventListener('sourceclose', () => {
          for (const t of tracksByMediaSource.get(this) || []) {
            dropTrack(t, 'evicted');
            const i = allTracks.indexOf(t);
            if (i >= 0) allTracks.splice(i, 1);
          }
        });
      }
    } catch {
      // never break the page's player because of capture
    }
    return sb;
  };

  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const track = tracksBySourceBuffer.get(this);
    if (track && !track.truncated) {
      try {
        const view = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        if (!makeRoom(view.byteLength, track)) track.truncated = true;
        else {
          track.chunks.push(view.slice()); // copy: players often reuse their buffers
          track.bytes += view.byteLength;
          totalBytes += view.byteLength;
        }
      } catch {
        track.truncated = true; // e.g. out of memory: the file would have a gap
      }
    }
    return origAppendBuffer.apply(this, arguments);
  };

  if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype.setMediaKeys) {
    const origSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      try {
        if (keys) {
          drmVideos.push(new WeakRef(this));
          const ms = mediaSourceOf(this);
          if (ms) markDrm(ms);
        }
      } catch {
        // never break the page's player because of capture
      }
      return origSetMediaKeys.apply(this, arguments);
    };
  }

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.apply(this, arguments);
    if (obj instanceof MediaSource) {
      for (const [u, ref] of mediaSourceByUrl) if (!ref.deref()) mediaSourceByUrl.delete(u);
      mediaSourceByUrl.set(url, new WeakRef(obj));
    }
    return url;
  };

  function findMarked(marker, root) {
    const hit = root.querySelector(`[data-downloadido-target="${CSS.escape(marker)}"]`);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const inner = findMarked(marker, el.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  }

  function exportTracks(marker) {
    const video = findMarked(marker, document);
    if (!video) return { error: 'Video element not found' };
    const ref = mediaSourceByUrl.get(video.currentSrc || video.src);
    const ms = video.srcObject instanceof MediaSource ? video.srcObject : ref && ref.deref();
    const tracks = (ms && tracksByMediaSource.get(ms)) || [];
    const withData = tracks.filter((t) => t.bytes > 0);
    if (!withData.length) {
      const evicted = tracks.some((t) => t.evicted);
      return {
        error: evicted
          ? 'This video\'s stream data was dropped to save memory. Reload the page, play the video, then try again.'
          : 'No stream data captured. Reload the page, play the video, then try again.',
      };
    }
    return {
      tracks: withData.map((t) => ({
        mime: t.mime,
        truncated: t.truncated || t.evicted,
        blob: new Blob(t.chunks, { type: t.mime.split(';')[0] }),
      })),
    };
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.source !== MSG_SOURCE || msg.type !== 'mse-export') return;
    let reply;
    try {
      reply = exportTracks(String(msg.marker));
    } catch (e) {
      reply = { error: String((e && e.message) || e) };
    }
    window.postMessage({ source: MSG_SOURCE, type: 'mse-export-result', id: msg.id, ...reply }, '*');
  });
})();
