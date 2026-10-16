// Turns a media file (video or audio) into an MP3: MP3 sources pass through untouched,
// MPEG-TS is demuxed first, everything else is decoded by the browser and re-encoded with
// lamejs (extension/vendor/lamejs.js, LGPL-3.0). Runs in the offscreen document and, injected
// on demand, in content scripts. encodeMp3() is pure (PCM in, Blob out) for Node tests.
// Browser: globalThis.DownloadIdoMp3. Node tests: CommonJS module.exports.
// `var`, not const: re-injection into the same isolated world must not throw (see utils.js).
var downloadIdoMp3 = (function () {
  'use strict';

  const SAMPLE_RATE = 44100; // decodeAudioData resamples to the context's rate
  const KBPS = 192;
  const FRAME_SAMPLES = 1152;
  const BLOCK_SAMPLES = FRAME_SAMPLES * 64;
  const MAX_SECONDS = 60 * 60; // decoded PCM is held in memory: ~635 MB per hour of stereo
  const MAX_INPUT_BYTES = 1024 * 1024 * 1024;
  const ID3_HEADER = 10;

  /** Does the Blob start with an MP3 frame (after any ID3 tag)? ADTS AAC is not matched. */
  async function isMp3(blob) {
    if (blob.type === 'audio/mpeg') return true;
    let head = new Uint8Array(await blob.slice(0, ID3_HEADER).arrayBuffer());
    let at = 0;
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // "ID3": skip the tag
      at = ID3_HEADER + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]);
      head = new Uint8Array(await blob.slice(at, at + 2).arrayBuffer());
    }
    return head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ((head[1] >> 1) & 0x3) === 1; // Layer III
  }

  /** Let other work run. Unlike setTimeout, not throttled in background tabs or hidden pages. */
  function yieldToEventLoop() {
    return new Promise(/** @param {(value?: unknown) => void} resolve */ (resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }

  function toInt16(samples, start, end) {
    const out = new Int16Array(end - start);
    for (let i = start, j = 0; i < end; i++, j++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /**
   * Encode PCM (one Float32Array per channel, 1 or 2 channels) to an MP3 Blob. Yields to the
   * event loop between blocks so a page stays responsive while it runs.
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @param {{kbps?: number, onProgress?: (fraction: number) => void}} [options]
   */
  async function encodeMp3(channels, sampleRate, { kbps = KBPS, onProgress } = {}) {
    const encoder = new globalThis.lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    const total = channels[0].length;
    const parts = [];
    for (let start = 0; start < total; start += BLOCK_SAMPLES) {
      const end = Math.min(start + BLOCK_SAMPLES, total);
      const left = toInt16(channels[0], start, end);
      const out = channels.length > 1 ? encoder.encodeBuffer(left, toInt16(channels[1], start, end)) : encoder.encodeBuffer(left);
      if (out.length) parts.push(new Uint8Array(out));
      if (onProgress) onProgress(end / total);
      await yieldToEventLoop();
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  /** Decode any browser-readable media to 44.1 kHz PCM, at most two channels. */
  async function decodeAudio(blob) {
    if (blob.size > MAX_INPUT_BYTES) throw new Error('This file is too large to convert to MP3 (over 1 GB).');
    let buffer;
    try {
      buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
    } catch {
      throw new Error('This media has no audio track that can be converted.');
    }
    if (buffer.duration > MAX_SECONDS) throw new Error('Audio longer than 60 minutes can\'t be converted to MP3.');
    const n = buffer.numberOfChannels;
    const all = Array.from({ length: n }, (_, i) => buffer.getChannelData(i));
    if (n <= 2) return { channels: all, sampleRate: buffer.sampleRate };
    // Surround: average even channels into left, odd into right (lame takes mono or stereo).
    const mix = (offset) => {
      const out = new Float32Array(buffer.length);
      const picked = all.filter((_, i) => i % 2 === offset);
      for (const ch of picked) for (let i = 0; i < out.length; i++) out[i] += ch[i] / picked.length;
      return out;
    };
    return { channels: [mix(0), mix(1)], sampleRate: buffer.sampleRate };
  }

  /**
   * Any media Blob -> MP3 Blob. Throws an Error with a user-facing message when impossible.
   * @param {Blob} blob
   * @param {{onProgress?: (fraction: number) => void}} [options]
   */
  async function toMp3(blob, { onProgress } = {}) {
    if (await isMp3(blob)) return blob;
    let source = blob;
    const ts = globalThis.DownloadIdoMpegts;
    if (ts.looksLikeTs(new Uint8Array(await blob.slice(0, 189).arrayBuffer()))) {
      const audio = await ts.extractAudio(blob);
      if (!audio) throw new Error('This video has no audio track.');
      if (audio.codec === 'mp3') return audio.blob;
      source = audio.blob;
    }
    const { channels, sampleRate } = await decodeAudio(source);
    return encodeMp3(channels, sampleRate, { onProgress });
  }

  return { isMp3, encodeMp3, toMp3, MAX_SECONDS };
})();

if (typeof module === 'object' && module.exports) module.exports = downloadIdoMp3;
else globalThis.DownloadIdoMp3 = downloadIdoMp3;
