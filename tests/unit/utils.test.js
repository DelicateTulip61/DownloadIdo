const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../../extension/lib/utils.js');

test('extFromMime maps known types and ignores parameters', () => {
  assert.equal(u.extFromMime('video/mp4; codecs="avc1.42E01E"'), 'mp4');
  assert.equal(u.extFromMime('audio/mp4'), 'm4a');
  assert.equal(u.extFromMime('IMAGE/WEBP'), 'webp');
  assert.equal(u.extFromMime('application/x-unknown'), '');
  assert.equal(u.extFromMime(''), '');
});

test('extFromUrl reads path extension, format hints and data URLs', () => {
  assert.equal(u.extFromUrl('https://a.com/x/photo.JPG?w=1'), 'jpg');
  assert.equal(u.extFromUrl('https://pbs.example.com/media/abc?format=png&name=orig'), 'png');
  assert.equal(u.extFromUrl('https://images.example.com/photo-1?fm=webp'), 'webp');
  assert.equal(u.extFromUrl('https://a.com/page.html'), '');
  assert.equal(u.extFromUrl('data:image/gif;base64,R0lGOD'), 'gif');
  assert.equal(u.extFromUrl('not a url'), '');
});

test('sanitizeFilename strips illegal characters, reserved names and trailing dots', () => {
  assert.equal(u.sanitizeFilename('a<b>:c"d/e\\f|g?h*'), 'a_b_c_d_e_f_g_h_');
  assert.equal(u.sanitizeFilename('  hello.  '), 'hello');
  assert.equal(u.sanitizeFilename('CON'), 'download');
  assert.equal(u.sanitizeFilename('', 'img'), 'img');
  assert.equal(u.sanitizeFilename('x'.repeat(300)).length, 120);
});

test('stemFromUrl decodes the last path segment without a known extension', () => {
  assert.equal(u.stemFromUrl('https://a.com/dir/My%20Photo.jpg?x=1'), 'My Photo');
  assert.equal(u.stemFromUrl('https://a.com/dir/archive.v2'), 'archive.v2');
  assert.equal(u.stemFromUrl('https://a.com/'), '');
  assert.equal(u.stemFromUrl('blob:https://a.com/uuid'), '');
});

test('buildDownloadPath puts files under the DownloadIdo folder', () => {
  assert.equal(u.buildDownloadPath({ stem: 'cat', ext: 'jpg' }), 'DownloadIdo/cat.jpg');
  assert.equal(u.buildDownloadPath({ stem: '', ext: 'mp4', fallback: 'video' }), 'DownloadIdo/video.mp4');
  assert.equal(u.buildDownloadPath({ stem: 'a', ext: 'png', subfolder: 'site: x' }), 'DownloadIdo/site_ x/a.png');
});

test('parseSrcset handles width, density, missing descriptors and commas in URLs', () => {
  const c = u.parseSrcset('https://x.com/w_100,h_100/a.jpg 100w, https://x.com/w_800,h_800/a.jpg 800w');
  assert.deepEqual(c.map((x) => [x.url, x.w]), [
    ['https://x.com/w_100,h_100/a.jpg', 100],
    ['https://x.com/w_800,h_800/a.jpg', 800],
  ]);
  const d = u.parseSrcset('a.jpg, b.jpg 2x,c.jpg 3x');
  assert.deepEqual(d.map((x) => [x.url, x.x]), [['a.jpg', 1], ['b.jpg', 2], ['c.jpg', 3]]);
  assert.deepEqual(u.parseSrcset(''), []);
});

test('pickLargestCandidate prefers the largest width, then density', () => {
  assert.equal(u.pickLargestCandidate(u.parseSrcset('s.jpg 300w, l.jpg 1200w, m.jpg 600w')), 'l.jpg');
  assert.equal(u.pickLargestCandidate(u.parseSrcset('a.jpg 1x, b.jpg 2x')), 'b.jpg');
  assert.equal(u.pickLargestCandidate([]), '');
});

test('extractCssUrls reads quoted, unquoted and multiple layers, skipping gradients', () => {
  assert.deepEqual(u.extractCssUrls('url("https://a.com/a.png")'), ['https://a.com/a.png']);
  assert.deepEqual(
    u.extractCssUrls("linear-gradient(red, blue), url('b.jpg'), url(c.webp)"),
    ['b.jpg', 'c.webp'],
  );
  assert.deepEqual(u.extractCssUrls('none'), []);
  assert.deepEqual(u.extractCssUrls('url("a\\"b.png")'), ['a"b.png']);
});

test('isHlsUrl detects m3u8 paths only', () => {
  assert.equal(u.isHlsUrl('https://a.com/v/master.m3u8?token=1'), true);
  assert.equal(u.isHlsUrl('https://a.com/v/video.mp4'), false);
  assert.equal(u.isHlsUrl('garbage'), false);
});

test('parseM3u8 parses a master playlist with separate audio', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
    'high/index.m3u8',
  ].join('\n');
  const m = u.parseM3u8(text, 'https://cdn.com/v/master.m3u8');
  assert.equal(m.type, 'master');
  assert.equal(m.variants.length, 2);
  const best = u.pickBestVariant(m);
  assert.equal(best.variant.url, 'https://cdn.com/v/high/index.m3u8');
  assert.equal(best.audio.url, 'https://cdn.com/v/audio/en.m3u8');
});

test('parseM3u8 parses a media playlist with keys, map, byteranges and sequence', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="500@0"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000A',
    '#EXTINF:4,',
    'seg0.m4s',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXT-X-BYTERANGE:1000@500',
    '#EXTINF:4,',
    'all.m4s',
    '#EXT-X-BYTERANGE:200',
    '#EXTINF:4,',
    'all.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const m = u.parseM3u8(text, 'https://cdn.com/v/index.m3u8');
  assert.equal(m.type, 'media');
  assert.equal(m.endList, true);
  assert.deepEqual(m.map, { url: 'https://cdn.com/v/init.mp4', byterange: { length: 500, offset: 0 } });
  assert.equal(m.segments.length, 3);
  assert.equal(m.segments[0].sequence, 7);
  assert.equal(m.segments[0].key.method, 'AES-128');
  assert.equal(m.segments[0].key.url, 'https://cdn.com/v/key.bin');
  assert.equal(m.segments[1].key, null);
  assert.deepEqual(m.segments[1].byterange, { length: 1000, offset: 500 });
  assert.deepEqual(m.segments[2].byterange, { length: 200, offset: 1500 });
});

test('parseM3u8 rejects non-playlists', () => {
  assert.throws(() => u.parseM3u8('<html>', 'https://a.com/'), /Not an HLS playlist/);
});

test('pickBestVariant handles masters without audio groups', () => {
  const best = u.pickBestVariant({ variants: [{ url: 'a', bandwidth: 1, audio: '' }], audio: [] });
  assert.equal(best.variant.url, 'a');
  assert.equal(best.audio, null);
});

test('buildIv uses explicit IV or the big-endian sequence number', () => {
  assert.deepEqual([...u.buildIv('0x0000000000000000000000000000000A', 0)].slice(-2), [0, 10]);
  assert.deepEqual([...u.buildIv('', 258)].slice(-2), [1, 2]);
  assert.deepEqual([...u.buildIv('', 0)], new Array(16).fill(0));
});

test('sanitizeFilename strips bidi/zero-width characters and never splits emoji', () => {
  assert.equal(u.sanitizeFilename('evil\u202Egpj.exe'), 'evilgpj.exe');
  const emoji = '😀'.repeat(130);
  const out = u.sanitizeFilename(emoji);
  assert.equal(Array.from(out).length, 120);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), 'no dangling high surrogate');
  assert.equal(u.sanitizeFilename('a'.repeat(119) + '.b'), 'a'.repeat(119), 'no trailing dot after truncation');
});

test('isPrivateHost recognises loopback, private, link-local and local names', () => {
  for (const h of ['localhost', 'x.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '[::1]', 'fd12:3456::1', 'fe80::1', 'nas.local', 'svc.internal', '100.64.0.1']) {
    assert.equal(u.isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2001:4860::8888', '192.169.0.1']) {
    assert.equal(u.isPrivateHost(h), false, h);
  }
});

test('isAllowedFetch blocks non-http schemes and public-page to private-network requests', () => {
  assert.equal(u.isAllowedFetch('https://cdn.com/a.ts', 'https://site.com/'), true);
  assert.equal(u.isAllowedFetch('http://192.168.1.1/reboot', 'https://evil.com/'), false);
  assert.equal(u.isAllowedFetch('http://127.0.0.1:8080/x', 'http://localhost:3000/'), true);
  assert.equal(u.isAllowedFetch('file:///C:/secret.txt', 'https://site.com/'), false);
  assert.equal(u.isAllowedFetch('chrome-extension://abc/x', 'https://site.com/'), false);
  assert.equal(u.isAllowedFetch('not a url', 'https://site.com/'), false);
});

test('playlistDuration sums EXTINF and durationMatches tolerates small differences', () => {
  const m = u.parseM3u8('#EXTM3U\n#EXTINF:4.5,\na.ts\n#EXTINF:3,\nb.ts\n#EXT-X-ENDLIST', 'https://a.com/x.m3u8');
  assert.equal(u.playlistDuration(m), 7.5);
  assert.equal(u.durationMatches(7.5, 6.2), true);
  assert.equal(u.durationMatches(30, 4), false);
  assert.equal(u.durationMatches(600, 590), true);
  assert.equal(u.durationMatches(10, NaN), true);
  assert.equal(u.durationMatches(10, Infinity), true);
});

test('fullSizeImageUrl maps known resized image URLs to their originals', () => {
  const cases = [
    ['https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=small', 'https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=orig'],
    ['https://pbs.twimg.com/media/GAbc123XYZ.jpg', 'https://pbs.twimg.com/media/GAbc123XYZ.jpg?name=orig'],
    ['https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/800px-Example.jpg',
      'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg'],
    ['https://upload.wikimedia.org/wikipedia/en/thumb/8/80/Logo.svg/120px-Logo.svg.png',
      'https://upload.wikimedia.org/wikipedia/en/8/80/Logo.svg'],
    ['https://i.pinimg.com/236x/1a/2b/3c/1a2b3c4d.jpg', 'https://i.pinimg.com/originals/1a/2b/3c/1a2b3c4d.jpg'],
    ['https://i.pinimg.com/75x75_RS/1a/2b/3c/1a2b3c4d.jpg', 'https://i.pinimg.com/originals/1a/2b/3c/1a2b3c4d.jpg'],
    ['https://preview.redd.it/abc123xyz.jpg?width=640&crop=smart&auto=webp&s=deadbeef', 'https://i.redd.it/abc123xyz.jpg'],
    ['https://i.imgur.com/AbCdEfGl.jpg', 'https://i.imgur.com/AbCdEfG.jpg'],
    ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg'],
    ['https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/mqdefault.webp', 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp'],
    ['https://images.unsplash.com/photo-1500000000000-abc?ixid=xyz&w=400&q=80&fit=crop', 'https://images.unsplash.com/photo-1500000000000-abc?ixid=xyz'],
    ['https://blog.example.com/wp-content/uploads/2024/05/photo-300x200.jpg', 'https://blog.example.com/wp-content/uploads/2024/05/photo.jpg'],
    ['https://cdn.shopify.com/s/files/1/0001/products/shirt_400x400.jpg?v=123', 'https://cdn.shopify.com/s/files/1/0001/products/shirt.jpg?v=123'],
    ['https://cdn.shopify.com/s/files/1/0001/products/shirt_grande.jpg', 'https://cdn.shopify.com/s/files/1/0001/products/shirt.jpg'],
    ['https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/Photo.PNG/640px-Photo.PNG', 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Photo.PNG'],
    ['https://shop.example.com/cdn/shop/files/shirt.jpg?v=1&width=533', 'https://shop.example.com/cdn/shop/files/shirt.jpg?v=1'],
  ];
  for (const [input, expected] of cases) assert.equal(u.fullSizeImageUrl(input), expected, input);
});

test('fullSizeImageUrl leaves originals and unknown hosts alone', () => {
  for (const url of [
    'https://pbs.twimg.com/media/GAbc123XYZ?format=jpg&name=orig',
    'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg',
    'https://i.pinimg.com/originals/1a/2b/3c/1a2b3c4d.jpg',
    'https://i.imgur.com/AbCdEfG.jpg', // 7 characters: already the original
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    'https://example.com/wp-content/uploads/photo.jpg',
    'https://example.com/images/photo-300x200.jpg', // size suffix outside WordPress uploads
    'https://images.unsplash.com/photo-1?ixid=xyz',
    // Wikimedia thumbs of non-images: a video poster and a PDF page.
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Foo.webm/220px--Foo.webm.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Doc.pdf/page1-220px-Doc.pdf.jpg',
    // Retina suffixes and size words that are just part of a Shopify file name.
    'https://cdn.shopify.com/s/files/1/0001/files/logo_2x.png',
    'https://shop.example.com/cdn/shop/files/shirt_large.png',
    'data:image/png;base64,AAAA',
    'not a url',
  ]) {
    assert.equal(u.fullSizeImageUrl(url), '', url);
  }
});
