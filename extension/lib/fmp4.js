// Joins a fragmented-MP4 video track and a fragmented-MP4 audio track into one file.
// Only box headers and the small `moov`/`moof` boxes are read; media payloads (`mdat`) stay
// as Blob slices, so multi-GB inputs aren't copied into memory.
// mux() returns null whenever the input is outside what this handles safely (callers then
// keep the tracks as separate files).
// Browser: globalThis.DownloadIdoFmp4. Node tests: CommonJS module.exports.
// `var`, not const: re-injection into the same isolated world must not throw (see utils.js).
var downloadIdoFmp4 = (function () {
  'use strict';

  const VIDEO_ID = 1;
  const AUDIO_ID = 2;
  const ENCRYPTION_TYPES = ['encv', 'enca', 'sinf', 'senc'];
  const TFHD_BASE_DATA_OFFSET = 0x1;
  const TFHD_SAMPLE_DESCRIPTION = 0x2;
  const TFHD_DEFAULT_DURATION = 0x8;
  const TRUN_DATA_OFFSET = 0x1;
  const TRUN_FIRST_FLAGS = 0x4;
  const TRUN_DURATION = 0x100;
  const TRUN_SIZE = 0x200;
  const TRUN_FLAGS = 0x400;
  const TRUN_CTO = 0x800;

  // ---------------------------------------------------------------- reading

  /** Top-level boxes of a Blob: [{type, start, size}] (reads 16 bytes per box). */
  async function listBoxes(blob) {
    const boxes = [];
    let pos = 0;
    while (pos + 8 <= blob.size) {
      const head = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
      let size = head.getUint32(0);
      const type = fourcc(head, 4);
      if (size === 1) size = Number(head.getBigUint64(8));
      else if (size === 0) size = blob.size - pos;
      if (size < 8 || pos + size > blob.size) throw new Error('truncated box');
      boxes.push({ type, start: pos, size });
      pos += size;
    }
    return boxes;
  }

  function fourcc(view, at) {
    return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  }

  function headerSize(bytes, at) {
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at) === 1 ? 16 : 8;
  }

  /** Child boxes of the box at `at` in `bytes` (offsets relative to `bytes`). */
  function children(bytes, at, extraHeader = 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = at + view.getUint32(at);
    const out = [];
    let pos = at + headerSize(bytes, at) + extraHeader;
    while (pos + 8 <= end) {
      const size = view.getUint32(pos);
      if (size < 8 || pos + size > end) throw new Error('bad child box');
      out.push({ type: fourcc(view, pos + 4), start: pos, size });
      pos += size;
    }
    return out;
  }

  function child(bytes, at, type) {
    return children(bytes, at).find((c) => c.type === type) || null;
  }

  function containsType(bytes, types) {
    const text = new TextDecoder('latin1').decode(bytes);
    return types.some((t) => text.includes(t));
  }

  /**
   * True when the init lists samples itself (a "hybrid" file whose first media sits in a
   * top-level mdat the stbl points into). Only empty-moov inits can be re-laid-out safely.
   */
  function hasSampleTable(moov, mdia) {
    const minf = child(moov, mdia.start, 'minf');
    const stbl = minf && child(moov, minf.start, 'stbl');
    if (!stbl) return false;
    const v = new DataView(moov.buffer);
    const stsz = child(moov, stbl.start, 'stsz');
    const stts = child(moov, stbl.start, 'stts');
    return Boolean((stsz && v.getUint32(stsz.start + 16) > 0) || (stts && v.getUint32(stts.start + 12) > 0));
  }

  // ---------------------------------------------------------------- one track

  /**
   * Parse one fragmented-MP4 track.
   * @returns {Promise<{ftyp: Uint8Array|null, moov: Uint8Array, timescale: number, duration: number,
   *   fragments: {blob: Blob, moof: Uint8Array, mdatStart: number, end: number, time: number}[]}|null>}
   */
  async function readTrack(blob, dedupe) {
    let boxes;
    try { boxes = await listBoxes(blob); } catch { return null; }
    const moovs = boxes.filter((b) => b.type === 'moov');
    if (moovs.length !== 1) return null; // none, or a mid-stream quality/codec switch
    const read = async (b) => new Uint8Array(await blob.slice(b.start, b.start + b.size).arrayBuffer());
    const moov = await read(moovs[0]);
    if (containsType(moov, ENCRYPTION_TYPES)) return null;
    const traks = children(moov, 0).filter((c) => c.type === 'trak');
    if (traks.length !== 1) return null;
    const mdia = child(moov, traks[0].start, 'mdia');
    const mdhd = mdia && child(moov, mdia.start, 'mdhd');
    if (!mdhd || hasSampleTable(moov, mdia)) return null;
    const mv = new DataView(moov.buffer);
    const timescale = mv.getUint32(mdhd.start + 8 + 4 + (mv.getUint8(mdhd.start + 8) === 1 ? 16 : 8));
    if (!timescale) return null;

    const ftypBox = boxes.find((b) => b.type === 'ftyp');
    const mvex = child(moov, 0, 'mvex');
    const trex = mvex && children(moov, mvex.start).find((c) => c.type === 'trex');
    const trexDuration = trex ? mv.getUint32(trex.start + 20) : 0;
    const fragments = [];
    const seenTimes = new Set();
    let endTicks = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].type !== 'moof') continue;
      const mdat = boxes.slice(i + 1).find((b) => b.type === 'mdat' || b.type === 'moof');
      if (!mdat || mdat.type !== 'mdat') return null;
      const moof = await read(boxes[i]);
      const info = readMoof(moof, trexDuration);
      if (!info) return null;
      if (dedupe && seenTimes.has(info.time)) continue; // re-appended after a seek
      seenTimes.add(info.time);
      endTicks = Math.max(endTicks, info.time + info.duration);
      fragments.push({ blob, moof, mdatStart: boxes[i].start + boxes[i].size, end: mdat.start + mdat.size, time: info.time / timescale });
    }
    if (!fragments.length) return null;
    return { ftyp: ftypBox ? await read(ftypBox) : null, moov, timescale, fragments, duration: endTicks / timescale };
  }

  /** Decode time (tfdt) and total sample duration of a single-traf moof; null if unsupported. */
  function readMoof(moof, trexDuration) {
    if (containsType(moof, ENCRYPTION_TYPES)) return null;
    const trafs = children(moof, 0).filter((c) => c.type === 'traf');
    if (trafs.length !== 1) return null;
    const tfhd = child(moof, trafs[0].start, 'tfhd');
    const tfdt = child(moof, trafs[0].start, 'tfdt');
    if (!tfhd || !tfdt) return null;
    const v = new DataView(moof.buffer);
    if (v.getUint32(tfhd.start + 8) & 0xffffff & TFHD_BASE_DATA_OFFSET) return null; // absolute offsets
    const time = v.getUint8(tfdt.start + 8) === 1 ? Number(v.getBigUint64(tfdt.start + 12)) : v.getUint32(tfdt.start + 12);
    const tfhdFlags = v.getUint32(tfhd.start + 8) & 0xffffff;
    let defaultDuration = trexDuration;
    if (tfhdFlags & TFHD_DEFAULT_DURATION) {
      defaultDuration = v.getUint32(tfhd.start + 16 + (tfhdFlags & TFHD_SAMPLE_DESCRIPTION ? 4 : 0));
    }
    let duration = 0;
    for (const trun of children(moof, trafs[0].start).filter((c) => c.type === 'trun')) {
      duration += trunDuration(v, trun.start, defaultDuration);
    }
    return { time, duration };
  }

  /** Sum of a trun's sample durations (per-sample values, else the default). */
  function trunDuration(v, at, defaultDuration) {
    const flags = v.getUint32(at + 8) & 0xffffff;
    const count = v.getUint32(at + 12);
    if (!(flags & TRUN_DURATION)) return count * defaultDuration;
    let pos = at + 16 + (flags & TRUN_DATA_OFFSET ? 4 : 0) + (flags & TRUN_FIRST_FLAGS ? 4 : 0);
    const stride = [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_CTO].filter((b) => flags & b).length * 4;
    let sum = 0;
    for (let i = 0; i < count; i++, pos += stride) sum += v.getUint32(pos);
    return sum;
  }

  // ---------------------------------------------------------------- writing

  function box(type, ...parts) {
    const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let pos = 8;
    for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
    return out;
  }

  function slice(bytes, b) {
    return bytes.slice(b.start, b.start + b.size); // a copy, safe to patch
  }

  /** Movie timescale (mvhd) of a moov. */
  function movieTimescale(moov) {
    const mvhd = child(moov, 0, 'mvhd');
    const v = new DataView(moov.buffer);
    return v.getUint32(mvhd.start + 8 + 4 + (v.getUint8(mvhd.start + 8) === 1 ? 16 : 8));
  }

  /** Write an unsigned 32- or 64-bit field. */
  function setField(v, at, wide, value) {
    if (wide) v.setBigUint64(at, BigInt(Math.round(value)));
    else v.setUint32(at, Math.min(Math.round(value), 0xffffffff));
  }

  /** Read/write an unsigned 32- or 64-bit field, multiplying it by `factor`. */
  function scaleField(v, at, wide, factor) {
    if (wide) v.setBigUint64(at, BigInt(Math.round(Number(v.getBigUint64(at)) * factor)));
    else v.setUint32(at, Math.round(v.getUint32(at) * factor));
  }

  /**
   * Copy of a trak with tkhd.track_ID set to id. Its tkhd duration and edit-list segment
   * durations are in the movie timescale, so they're rescaled by `factor` when the trak moves
   * into a moov with a different mvhd timescale (otherwise e.g. audio priming becomes seconds).
   */
  function trakWithId(moov, trak, id, factor, track, movieTimescaleOut) {
    const out = slice(moov, trak);
    const v = new DataView(out.buffer);
    const tkhd = child(out, 0, 'tkhd');
    const wide = v.getUint8(tkhd.start + 8) === 1;
    const idAt = tkhd.start + 8 + 4 + (wide ? 16 : 8);
    v.setUint32(idAt, id);
    // Real durations: fragmented inits say 0, and Chrome then guesses the length from bitrate.
    setField(v, idAt + 8, wide, track.duration * movieTimescaleOut); // after track_ID + 4 reserved bytes
    const mdia = child(out, 0, 'mdia');
    const mdhd = child(out, mdia.start, 'mdhd');
    const mdhdWide = v.getUint8(mdhd.start + 8) === 1;
    setField(v, mdhd.start + 8 + 4 + (mdhdWide ? 16 : 8) + 4, mdhdWide, track.duration * track.timescale);
    if (factor === 1) return out;
    const edts = child(out, 0, 'edts');
    const elst = edts && child(out, edts.start, 'elst');
    if (elst) {
      const elstWide = v.getUint8(elst.start + 8) === 1;
      const count = v.getUint32(elst.start + 12);
      const entrySize = elstWide ? 20 : 12;
      for (let i = 0; i < count; i++) scaleField(v, elst.start + 16 + i * entrySize, elstWide, factor);
    }
    return out;
  }

  function trexWithId(moov, id) {
    const mvex = child(moov, 0, 'mvex');
    const trex = mvex && children(moov, mvex.start).find((c) => c.type === 'trex');
    if (!trex) return null;
    const out = slice(moov, trex);
    new DataView(out.buffer).setUint32(12, id);
    return out;
  }

  function buildMoov(video, audio) {
    const vChildren = children(video.moov, 0);
    const mvhd = slice(video.moov, vChildren.find((c) => c.type === 'mvhd'));
    const mv = new DataView(mvhd.buffer);
    mv.setUint32(mvhd.byteLength - 4, AUDIO_ID + 1); // next_track_ID is mvhd's last field
    const movieTs = movieTimescale(video.moov);
    const movieDuration = Math.max(video.duration, audio.duration) * movieTs;
    const mvhdWide = mv.getUint8(8) === 1;
    setField(mv, 8 + 4 + (mvhdWide ? 16 : 8) + 4, mvhdWide, movieDuration);
    const mehd = new Uint8Array(8); // version 0, flags 0, fragment_duration
    new DataView(mehd.buffer).setUint32(4, Math.min(Math.round(movieDuration), 0xffffffff));
    const vTrex = trexWithId(video.moov, VIDEO_ID);
    const aTrex = trexWithId(audio.moov, AUDIO_ID);
    if (!vTrex || !aTrex) return null;
    const vTrak = trakWithId(video.moov, vChildren.find((c) => c.type === 'trak'), VIDEO_ID, 1, video, movieTs);
    const factor = movieTs / movieTimescale(audio.moov);
    const aTrak = trakWithId(audio.moov, children(audio.moov, 0).find((c) => c.type === 'trak'), AUDIO_ID, factor, audio, movieTs);
    // Keep the video moov's other boxes (udta, …) but not mvex/mehd (rebuilt) or the old ones above.
    const others = vChildren.filter((c) => !['mvhd', 'trak', 'mvex'].includes(c.type)).map((c) => slice(video.moov, c));
    return box('moov', mvhd, vTrak, aTrak, ...others, box('mvex', box('mehd', mehd), vTrex, aTrex));
  }

  /** moof copy with the new track ID and sequence number. */
  function patchMoof(moof, trackId, sequence) {
    const out = moof.slice();
    const v = new DataView(out.buffer);
    const mfhd = child(out, 0, 'mfhd');
    if (mfhd) v.setUint32(mfhd.start + 12, sequence);
    const traf = child(out, 0, 'traf');
    v.setUint32(child(out, traf.start, 'tfhd').start + 12, trackId);
    return out;
  }

  /** Interleave two fragment lists by time without reordering either one. */
  function mergeInOrder(a, b) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && a[i].time <= b[j].time)) out.push(a[i++]);
      else out.push(b[j++]);
    }
    return out;
  }

  /**
   * Mux a video fMP4 Blob and an audio fMP4 Blob into one MP4 Blob, or null if unsupported.
   * Default (MSE captures): fragments are sorted by time and repeats dropped, since players
   * re-append after seeks. keepOrder (HLS): playlist order is kept as is, because a
   * discontinuity can restart timestamps and sorting would scramble the segments.
   * @param {Blob} videoBlob
   * @param {Blob} audioBlob
   * @param {{keepOrder?: boolean}} [options]
   * @returns {Promise<Blob|null>}
   */
  async function mux(videoBlob, audioBlob, { keepOrder = false } = {}) {
    try {
      const [video, audio] = await Promise.all([readTrack(videoBlob, !keepOrder), readTrack(audioBlob, !keepOrder)]);
      if (!video || !audio) return null;
      const moov = buildMoov(video, audio);
      if (!moov) return null;
      const vFrags = video.fragments.map((f) => ({ ...f, id: VIDEO_ID }));
      const aFrags = audio.fragments.map((f) => ({ ...f, id: AUDIO_ID }));
      const order = keepOrder
        ? mergeInOrder(vFrags, aFrags)
        : [...vFrags, ...aFrags].sort((a, b) => a.time - b.time || a.id - b.id);
      const parts = [];
      if (video.ftyp) parts.push(video.ftyp);
      parts.push(moov);
      order.forEach((f, i) => {
        parts.push(patchMoof(f.moof, f.id, i + 1), f.blob.slice(f.mdatStart, f.end));
      });
      return new Blob(parts, { type: 'video/mp4' });
    } catch {
      return null;
    }
  }

  return { mux };
})();

if (typeof module === 'object' && module.exports) module.exports = downloadIdoFmp4;
else globalThis.DownloadIdoFmp4 = downloadIdoFmp4;
