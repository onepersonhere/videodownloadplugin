/*
 * Node test suite for the pure-logic pieces (m3u8 parser + utils).
 * Run with: node tests/parser.test.cjs
 */
const assert = require('assert');
const M3U8 = require('../src/lib/m3u8-parser.js');
const U = require('../src/lib/util.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n      ' + e.message);
    process.exitCode = 1;
  }
}

console.log('m3u8-parser');

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="aud",FRAME-RATE=30
https://cdn.example.com/v1080/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"`;

test('master: parses variants and sorts best-first', () => {
  const r = M3U8.parse(MASTER, 'https://host.test/path/master.m3u8');
  assert.strictEqual(r.type, 'master');
  assert.strictEqual(r.variants.length, 2, 'I-frame variant excluded, 2 remain');
  assert.strictEqual(r.variants[0].resolution.height, 1080, 'highest first');
  assert.strictEqual(r.variants[0].bandwidth, 5000000);
  assert.strictEqual(r.variants[0].audioGroup, 'aud');
  assert.strictEqual(r.variants[1].resolution.width, 640);
});

test('master: resolves relative + absolute variant URIs', () => {
  const r = M3U8.parse(MASTER, 'https://host.test/path/master.m3u8');
  assert.strictEqual(r.variants[0].uri, 'https://cdn.example.com/v1080/index.m3u8');
  assert.strictEqual(r.variants[1].uri, 'https://host.test/path/v360/index.m3u8');
});

test('master: parses EXT-X-MEDIA audio rendition with URI', () => {
  const r = M3U8.parse(MASTER, 'https://host.test/path/master.m3u8');
  const aud = r.media.find((m) => m.mediaType === 'AUDIO');
  assert.ok(aud, 'audio rendition present');
  assert.strictEqual(aud.groupId, 'aud');
  assert.strictEqual(aud.language, 'en');
  assert.strictEqual(aud.isDefault, true);
  assert.strictEqual(aud.channels, '2');
  assert.strictEqual(aud.uri, 'https://host.test/path/audio/en.m3u8');
});

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXTINF:3.003,
http://other.cdn/seg2.ts
#EXT-X-ENDLIST`;

test('media: parses segments, durations, totals, VOD flag', () => {
  const r = M3U8.parse(MEDIA, 'https://host.test/v/index.m3u8');
  assert.strictEqual(r.type, 'media');
  assert.strictEqual(r.segments.length, 3);
  assert.strictEqual(r.isLive, false, 'ENDLIST => VOD');
  assert.ok(Math.abs(r.totalDuration - 21.021) < 1e-6);
  assert.strictEqual(r.segments[0].uri, 'https://host.test/v/seg0.ts');
  assert.strictEqual(r.segments[2].uri, 'http://other.cdn/seg2.ts');
  assert.strictEqual(r.segments[1].sequence, 1);
  assert.strictEqual(r.encryption, 'NONE');
  assert.strictEqual(r.fmp4, false);
});

test('media: live when no ENDLIST', () => {
  const live = MEDIA.replace('#EXT-X-ENDLIST', '');
  const r = M3U8.parse(live, 'https://host.test/v/index.m3u8');
  assert.strictEqual(r.isLive, true);
});

const ENC = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1.key"
#EXTINF:6.0,
s10.ts
#EXTINF:6.0,
s11.ts
#EXT-X-ENDLIST`;

test('media: AES-128 key + default IV from media sequence', () => {
  const r = M3U8.parse(ENC, 'https://host.test/v/index.m3u8');
  assert.strictEqual(r.encryption, 'AES-128');
  assert.strictEqual(r.keyFormat, 'identity');
  const s = r.segments[0];
  assert.strictEqual(s.key.method, 'AES-128');
  assert.strictEqual(s.key.uri, 'https://keys.test/k1.key');
  // sequence 10 -> IV last byte 0x0a, rest zero
  assert.strictEqual(s.key.iv.length, 16);
  assert.strictEqual(s.key.iv[15], 10);
  assert.strictEqual(s.key.iv[14], 0);
  assert.strictEqual(r.segments[1].key.iv[15], 11);
});

test('media: explicit hex IV is honored', () => {
  const m = ENC.replace('URI="https://keys.test/k1.key"', 'URI="k.key",IV=0x00000000000000000000000000000001');
  const r = M3U8.parse(m, 'https://host.test/v/index.m3u8');
  assert.strictEqual(r.segments[0].key.iv[15], 1);
  assert.strictEqual(r.segments[1].key.iv[15], 1, 'explicit IV used for all');
});

const FMP4 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg-1.m4s
#EXTINF:4.0,
seg-2.m4s
#EXT-X-ENDLIST`;

test('media: detects fMP4 and init map URI', () => {
  const r = M3U8.parse(FMP4, 'https://host.test/v/index.m3u8');
  assert.strictEqual(r.fmp4, true);
  assert.strictEqual(r.segments[0].map.uri, 'https://host.test/v/init.mp4');
});

const BYTERANGE = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
#EXT-X-BYTERANGE:75232@0
main.ts
#EXTINF:10.0,
#EXT-X-BYTERANGE:82112
main.ts
#EXT-X-ENDLIST`;

test('media: EXT-X-BYTERANGE with implicit offset chaining', () => {
  const r = M3U8.parse(BYTERANGE, 'https://host.test/v/index.m3u8');
  assert.strictEqual(r.segments[0].byterange.offset, 0);
  assert.strictEqual(r.segments[0].byterange.length, 75232);
  assert.strictEqual(r.segments[1].byterange.offset, 75232, 'implicit offset = prev end');
  assert.strictEqual(r.segments[1].byterange.length, 82112);
});

test('attributes: quoted values may contain commas', () => {
  const a = M3U8.parseAttributes('BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080');
  assert.strictEqual(a.CODECS, 'avc1.640028,mp4a.40.2');
  assert.strictEqual(a.BANDWIDTH, '5000000');
  assert.strictEqual(a.RESOLUTION, '1920x1080');
});

test('seqToIv: big-endian 128-bit', () => {
  const iv = M3U8.seqToIv(258); // 0x0102
  assert.strictEqual(iv[15], 2);
  assert.strictEqual(iv[14], 1);
  assert.strictEqual(iv[0], 0);
});

test('hexToBytes: handles 0x prefix and odd length', () => {
  assert.deepStrictEqual(Array.from(M3U8.hexToBytes('0x0aff')), [10, 255]);
});

console.log('util');

test('sanitizeFilename: strips illegal chars, collapses whitespace', () => {
  assert.strictEqual(U.sanitizeFilename('My: Video/<Title>?.mp4'), 'My Video Title .mp4');
});
test('sanitizeFilename: empty -> video', () => {
  assert.strictEqual(U.sanitizeFilename('   '), 'video');
});
test('sanitizeFilename: preserves hyphens (valid in filenames)', () => {
  assert.strictEqual(U.sanitizeFilename('cool-clip'), 'cool-clip');
});
test('sanitizeFilename: drops control characters', () => {
  // NUL (0) and TAB (9) are both control chars and should be removed.
  assert.strictEqual(U.sanitizeFilename('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(9) + 'c'), 'abc');
});
test('deriveBaseName: falls back to URL basename', () => {
  assert.strictEqual(U.deriveBaseName('', 'https://x.test/path/cool-clip.m3u8?a=1'), 'cool-clip');
});
test('formatDuration: h:mm:ss / m:ss', () => {
  assert.strictEqual(U.formatDuration(75), '1:15');
  assert.strictEqual(U.formatDuration(3725), '1:02:05');
});
test('humanSize: scales units', () => {
  assert.strictEqual(U.humanSize(1536), '1.5 KB');
  assert.strictEqual(U.humanSize(0), '0 B');
});
test('variantLabel: resolution + bitrate', () => {
  assert.strictEqual(U.variantLabel({ resolution: { width: 1920, height: 1080 }, bandwidth: 4200000 }), '1080p · 4.2 Mbps');
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures above)' : ''));
