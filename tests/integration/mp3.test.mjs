// MP3 encoder and MPEG-TS audio extraction, checked against ffprobe/ffmpeg.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeFixtures } from '../e2e/make-fixtures.mjs';

const require = createRequire(import.meta.url);
// Load the vendored encoder the way the browser does: a classic script that sets a global.
vm.runInThisContext(fs.readFileSync(new URL('../../extension/vendor/lamejs.js', import.meta.url), 'utf8'));
const { encodeMp3, isMp3 } = require('../../extension/lib/mp3.js');
const { extractAudio, looksLikeTs } = require('../../extension/lib/mpegts.js');

let media;
let out;
before(() => {
  media = makeFixtures();
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-'));
});

async function save(blob, name) {
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  return file;
}

function probe(file) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,codec_type,channels,sample_rate:format=duration', '-of', 'json', file]));
  return { streams: info.streams, duration: parseFloat(info.format.duration) };
}

/** Mean volume in dB (silence is about -91). */
function meanVolume(file) {
  const err = spawnSync('ffmpeg', ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return parseFloat(/mean_volume: (-?[\d.]+) dB/.exec(err)[1]);
}

function sine(seconds, rate, freq) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

test('encodeMp3 turns stereo PCM into a valid, audible MP3', async () => {
  const progress = [];
  const blob = await encodeMp3([sine(3, 44100, 440), sine(3, 44100, 660)], 44100, { onProgress: (f) => progress.push(f) });
  const file = await save(blob, 'stereo.mp3');
  const p = probe(file);
  assert.deepEqual(p.streams.map((s) => [s.codec_name, s.channels, s.sample_rate]), [['mp3', 2, '44100']]);
  assert.ok(Math.abs(p.duration - 3) < 0.3, `duration ${p.duration}`);
  assert.ok(meanVolume(file) > -35, 'not silent');
  assert.equal(progress.at(-1), 1);
  assert.equal(await isMp3(new Blob([fs.readFileSync(file)])), true);
});

test('encodeMp3 handles mono', async () => {
  const file = await save(await encodeMp3([sine(1, 44100, 440)], 44100), 'mono.mp3');
  assert.equal(probe(file).streams[0].channels, 1);
});

test('isMp3 tells MP3 from AAC (ADTS) and MP4', async () => {
  const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x80]); // ADTS sync: layer bits 00
  assert.equal(await isMp3(new Blob([adts])), false);
  assert.equal(await isMp3(new Blob([fs.readFileSync(path.join(media, 'clip.mp4'))])), false);
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 2, 0, 0, 0xff, 0xfb]); // 2-byte tag, then a frame
  assert.equal(await isMp3(new Blob([id3])), true);
});

test('extractAudio pulls the AAC stream out of a muxed transport stream', async () => {
  const tsFile = path.join(out, 'av.ts');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(media, 'clip.mp4'), '-c', 'copy', '-f', 'mpegts', tsFile]);
  const bytes = fs.readFileSync(tsFile);
  assert.equal(looksLikeTs(bytes), true);
  const audio = await extractAudio(new Blob([bytes]));
  assert.equal(audio.codec, 'aac');
  const file = await save(audio.blob, 'out.aac');
  const p = probe(file);
  assert.deepEqual(p.streams.map((s) => s.codec_name), ['aac']);
  assert.ok(Math.abs(p.duration - 6) < 0.3, `duration ${p.duration}`);
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim(), '');
});

test('extractAudio finds MP3 inside a transport stream, and returns null without audio', async () => {
  const mp3ts = path.join(out, 'mp3.ts');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
    '-c:a', 'libmp3lame', '-f', 'mpegts', mp3ts]);
  const audio = await extractAudio(new Blob([fs.readFileSync(mp3ts)]));
  assert.equal(audio.codec, 'mp3');
  assert.equal(await isMp3(audio.blob), true);

  const silentTs = path.join(out, 'video.ts');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(media, 'frag.mp4'), '-c', 'copy', '-f', 'mpegts', silentTs]);
  assert.equal(await extractAudio(new Blob([fs.readFileSync(silentTs)])), null);
  assert.equal(await extractAudio(new Blob([new Uint8Array(400)])), null, 'not a transport stream');
});
