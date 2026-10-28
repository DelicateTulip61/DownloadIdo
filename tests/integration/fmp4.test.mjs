// Muxer tests against real ffmpeg-made fragmented MP4s; results are checked with ffprobe/ffmpeg.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeFixtures } from '../e2e/make-fixtures.mjs';

const require = createRequire(import.meta.url);
const { mux } = require('../../extension/lib/fmp4.js');

let media;
let out;
before(() => {
  media = makeFixtures();
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp4-'));
});

const blobOf = (...files) => new Blob(files.map((f) => fs.readFileSync(path.join(media, f))));

async function save(blob, name) {
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  return file;
}

function probe(file) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,duration:stream_tags=:format=duration', '-of', 'json', file]));
  return { types: info.streams.map((s) => s.codec_type).sort(), streams: info.streams, duration: parseFloat(info.format.duration) };
}

/** Decodes every frame; returns ffmpeg's error output (empty when the file is clean). */
function decodeErrors(file) {
  return spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim();
}

test('muxes a video fMP4 and an audio fMP4 into one playable file', async () => {
  const result = await mux(blobOf('frag.mp4'), blobOf('frag-audio.m4a'));
  assert.ok(result, 'mux returned null');
  const file = await save(result, 'muxed.mp4');
  const p = probe(file);
  assert.deepEqual(p.types, ['audio', 'video']);
  for (const s of p.streams) assert.ok(Math.abs(parseFloat(s.duration) - 4) < 0.3, `${s.codec_type} ${s.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('fragments appended twice (seek then replay) are kept once', async () => {
  const frag = fs.readFileSync(path.join(media, 'frag.mp4'));
  const firstMoof = frag.indexOf('moof') - 4;
  const replayed = new Blob([frag, frag.subarray(firstMoof)]); // same fragments again after the init
  const result = await mux(replayed, blobOf('frag-audio.m4a'));
  assert.ok(result);
  const file = await save(result, 'replayed.mp4');
  const packets = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  assert.equal(packets, '100', '4 s at 25 fps, each frame once');
  assert.equal(decodeErrors(file), '');
});

test('keepOrder (HLS) keeps every fragment in playlist order instead of de-duplicating by time', async () => {
  // Same timestamps twice under one init = a discontinuity that restarts the clock.
  const frag = fs.readFileSync(path.join(media, 'frag.mp4'));
  const restarted = new Blob([frag, frag.subarray(frag.indexOf('moof') - 4)]);
  const result = await mux(restarted, blobOf('frag-audio.m4a'), { keepOrder: true });
  assert.ok(result);
  const file = await save(result, 'keep-order.mp4');
  const packets = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  assert.equal(packets, '200', 'both passes kept');
});

test('writes a well-formed mehd box (8-byte payload)', async () => {
  const bytes = new Uint8Array(await (await mux(blobOf('frag.mp4'), blobOf('frag-audio.m4a'))).arrayBuffer());
  const at = Buffer.from(bytes).indexOf('mehd') - 4;
  assert.ok(at >= 0, 'mehd present');
  assert.equal(new DataView(bytes.buffer).getUint32(at), 16);
});

test('rescales edit lists when the two inits use different movie timescales', async () => {
  // ffmpeg's HLS renditions: video mvhd timescale 1000, audio 44100 with a 2504-tick priming edit.
  const seg = (v, n) => Array.from({ length: n }, (_, i) => `hls2/seg_${v}_${i}.m4s`);
  const result = await mux(blobOf('hls2/init_0.mp4', ...seg(0, 3)), blobOf('hls2/init_1.mp4', ...seg(1, 4)));
  assert.ok(result);
  const file = await save(result, 'hls2.mp4');
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,start_time:format=duration', '-of', 'json', file]));
  for (const s of info.streams) assert.ok(parseFloat(s.start_time) < 0.2, `${s.codec_type} starts at ${s.start_time}`);
  assert.ok(Math.abs(parseFloat(info.format.duration) - 6) < 0.3, `duration ${info.format.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('refuses inputs it cannot rewrite safely', async () => {
  const audio = blobOf('frag-audio.m4a');
  assert.equal(await mux(blobOf('frag-abs.mp4'), audio), null, 'absolute base_data_offset');
  assert.equal(await mux(blobOf('frag-hybrid.mp4'), audio), null, 'samples listed in the moov (hybrid file)');
  assert.equal(await mux(blobOf('frag.mp4', 'frag.mp4'), audio), null, 'two init segments (quality switch)');
  assert.equal(await mux(blobOf('clip.mp4'), audio), null, 'not fragmented');
  assert.equal(await mux(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]), audio), null, 'garbage');
});
