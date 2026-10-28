// Pulls the audio stream (AAC in ADTS, or MP3) out of an MPEG transport stream, so it can be
// decoded (Chrome's decodeAudioData doesn't read .ts). Reads the Blob in chunks.
// Browser: globalThis.DownloadIdoMpegts. Node tests: CommonJS module.exports.
// `var`, not const: re-injection into the same isolated world must not throw (see utils.js).
var downloadIdoMpegts = (function () {
  'use strict';

  const PACKET = 188;
  const SYNC = 0x47;
  const CHUNK_PACKETS = 20000;
  const STREAM_TYPES = { 0x0f: 'aac', 0x03: 'mp3', 0x04: 'mp3' };

  /** True when the bytes look like an MPEG-TS (sync byte every 188 bytes). */
  function looksLikeTs(bytes) {
    return bytes.length > PACKET && bytes[0] === SYNC && bytes[PACKET] === SYNC;
  }

  /** Program map PID from a PAT packet payload starting at p. */
  function readPat(buf, p) {
    const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const end = p + 3 + sectionLength - 4;
    for (let q = p + 8; q + 4 <= end; q += 4) {
      const program = (buf[q] << 8) | buf[q + 1];
      if (program !== 0) return ((buf[q + 2] & 0x1f) << 8) | buf[q + 3];
    }
    return -1;
  }

  /** First audio elementary stream in a PMT payload starting at p: {pid, codec} or null. */
  function readPmt(buf, p) {
    const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const end = p + 3 + sectionLength - 4;
    let q = p + 12 + (((buf[p + 10] & 0x0f) << 8) | buf[p + 11]);
    while (q + 5 <= end) {
      const codec = STREAM_TYPES[buf[q]];
      if (codec) return { pid: ((buf[q + 1] & 0x1f) << 8) | buf[q + 2], codec };
      q += 5 + (((buf[q + 3] & 0x0f) << 8) | buf[q + 4]);
    }
    return null;
  }

  /**
   * The audio stream of a transport stream as {codec: 'aac'|'mp3', blob}, or null if there is none.
   * @param {Blob} blob
   */
  async function extractAudio(blob) {
    let pmtPid = -1;
    let audio = null;
    const parts = [];
    const chunk = PACKET * CHUNK_PACKETS;
    for (let off = 0; off < blob.size; off += chunk) {
      const buf = new Uint8Array(await blob.slice(off, Math.min(off + chunk, blob.size)).arrayBuffer());
      for (let i = 0; i + PACKET <= buf.length; i += PACKET) {
        if (buf[i] !== SYNC) return null; // not (or no longer) a transport stream
        const start = (buf[i + 1] & 0x40) !== 0;
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        const adaptation = (buf[i + 3] >> 4) & 0x3;
        if (adaptation === 2) continue; // adaptation field only, no payload
        let p = i + 4 + (adaptation === 3 ? 1 + buf[i + 4] : 0);
        const end = i + PACKET;
        if (p >= end) continue;
        if (pid === 0 && pmtPid < 0 && start) {
          pmtPid = readPat(buf, p + 1 + buf[p]);
        } else if (pid === pmtPid && !audio && start) {
          audio = readPmt(buf, p + 1 + buf[p]);
        } else if (audio && pid === audio.pid) {
          if (start) p += 9 + buf[p + 8]; // skip the PES header
          if (p < end) parts.push(buf.slice(p, end));
        }
      }
    }
    if (!audio || !parts.length) return null;
    return { codec: audio.codec, blob: new Blob(parts, { type: audio.codec === 'mp3' ? 'audio/mpeg' : 'audio/aac' }) };
  }

  return { looksLikeTs, extractAudio };
})();

if (typeof module === 'object' && module.exports) module.exports = downloadIdoMpegts;
else globalThis.DownloadIdoMpegts = downloadIdoMpegts;
