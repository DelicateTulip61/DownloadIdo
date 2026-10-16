// Generates binary test media with ffmpeg into tests/e2e/.fixtures (git-ignored).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures');
const DONE_MARKER = 'done-v4'; // bump when fixtures change
const ff = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { cwd: dir });

export function makeFixtures() {
  if (fs.existsSync(path.join(dir, DONE_MARKER))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });

  const images = {
    'plain.png': '200x150', 'small.jpg': '320x180', 'big.jpg': '1280x720', 'pic-small.jpg': '320x180',
    'pic-big.jpg': '1600x900', 'overlay.jpg': '300x200', 'pe-none.jpg': '300x200', 'bg.jpg': '300x200',
    'pseudo.jpg': '300x200', 'shadow.jpg': '200x150', 'iframe.jpg': '200x150', 'lazy.jpg': '300x200',
    'linked-thumb.jpg': '150x100', 'linked-full.jpg': '1200x800', 'noext.png': '200x150', 'hot.jpg': '200x150',
    'tiny.png': '16x16',
  };
  for (const [name, size] of Object.entries(images)) {
    ff('-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', name);
  }

  const av = ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6'];
  ff(...av, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-movflags', '+faststart', 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '4', '-c:v', 'libx264', '-profile:v', 'baseline',
    '-level', '3.0', '-pix_fmt', 'yuv420p', '-g', '25', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'frag.mp4');

  // Plain audio files for <audio> elements: AAC (gets converted) and MP3 (saved as-is).
  ff('-f', 'lavfi', '-i', 'sine=frequency=550', '-t', '4', '-c:a', 'aac', 'tone.m4a');
  ff('-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '3', '-c:a', 'libmp3lame', 'tone.mp3');
  // Audio-only fMP4 (pairs with frag.mp4 for muxing / two-SourceBuffer MSE).
  ff('-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:a', 'aac', '-frag_duration', '1000000',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'frag-audio.m4a');
  // fMP4 with absolute base_data_offset in tfhd: the muxer must refuse it.
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-g', '25', '-movflags', 'frag_keyframe+empty_moov', 'frag-abs.mp4');
  // "Hybrid" fMP4: the first fragment's samples live in the moov (no empty_moov): must be refused.
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-g', '25', '-movflags', 'frag_keyframe+default_base_moof', 'frag-hybrid.mp4');

  // AES-128 encrypted HLS with a master playlist.
  fs.writeFileSync(path.join(dir, 'hls', 'key.bin'), Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  fs.writeFileSync(path.join(dir, 'keyinfo'), `key.bin\n${path.join(dir, 'hls', 'key.bin')}\n`);
  ff(...av, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2',
    '-hls_playlist_type', 'vod', '-hls_key_info_file', 'keyinfo', '-master_pl_name', 'master.m3u8',
    '-hls_segment_filename', 'hls/seg%d.ts', 'hls/index.m3u8');

  // fMP4 HLS with a separate audio rendition (EXT-X-MEDIA + EXT-X-MAP).
  fs.mkdirSync(path.join(dir, 'hls2'));
  ff(...av, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes', '-master_pl_name', 'master.m3u8',
    '-hls_fmp4_init_filename', 'init_%v.mp4', '-hls_segment_filename', 'hls2/seg_%v_%d.m4s', 'hls2/stream_%v.m3u8');

  fs.writeFileSync(path.join(dir, DONE_MARKER), '');
  return dir;
}
