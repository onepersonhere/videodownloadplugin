/*
 * Minimal, dependency-free HLS (m3u8) parser.
 *
 * Exposes M3U8.parse(text, baseUrl) which returns either:
 *   { type: 'master', variants: [...], media: [...] }
 *   { type: 'media',   segments: [...], isLive, encryption, fmp4, ... }
 *
 * Works as a classic script (attaches to `self`/`window` as `M3U8`) and as a
 * CommonJS module (for the Node test suite).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.M3U8 = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveUrl(base, rel) {
    try {
      return new URL(rel, base).href;
    } catch (e) {
      return rel;
    }
  }

  // Parse an HLS attribute list: KEY=VALUE,KEY2="quoted, value",KEY3=0x1A
  // Quoted values may contain commas; everything else is comma-delimited.
  function parseAttributes(input) {
    const attrs = {};
    const n = input.length;
    let i = 0;
    while (i < n) {
      let key = '';
      while (i < n && input[i] !== '=') key += input[i++];
      i++; // skip '='
      let val = '';
      if (input[i] === '"') {
        i++; // opening quote
        while (i < n && input[i] !== '"') val += input[i++];
        i++; // closing quote
      } else {
        while (i < n && input[i] !== ',') val += input[i++];
      }
      while (i < n && (input[i] === ',' || input[i] === ' ')) i++;
      key = key.trim();
      if (key) attrs[key] = val;
    }
    return attrs;
  }

  function hexToBytes(hex) {
    hex = String(hex).trim().replace(/^0x/i, '');
    if (hex.length % 2) hex = '0' + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  // HLS default IV when EXT-X-KEY has no IV: the media sequence number as a
  // 128-bit big-endian integer.
  function seqToIv(seq) {
    const iv = new Uint8Array(16);
    let v = BigInt(seq);
    for (let i = 15; i >= 0; i--) {
      iv[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return iv;
  }

  // "length[@offset]" -> { length, offset }
  function parseByteRange(str, prevEnd) {
    const parts = String(str).split('@');
    const length = parseInt(parts[0], 10);
    const offset = parts.length > 1 ? parseInt(parts[1], 10) : prevEnd || 0;
    return { length, offset };
  }

  function parseResolution(str) {
    if (!str) return null;
    const m = /(\d+)x(\d+)/.exec(str);
    return m ? { width: +m[1], height: +m[2] } : null;
  }

  function parseMaster(lines, baseUrl, raw) {
    const variants = [];
    const media = [];
    let pendingStream = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pendingStream = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        continue;
      }
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
        media.push({
          mediaType: (a.TYPE || '').toUpperCase(),
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          isDefault: (a.DEFAULT || '').toUpperCase() === 'YES',
          autoselect: (a.AUTOSELECT || '').toUpperCase() === 'YES',
          channels: a.CHANNELS || '',
          uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
        });
        continue;
      }
      if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
        // I-frame-only variants are not useful for full downloads.
        continue;
      }
      if (line[0] === '#') continue;

      // A non-comment line that follows a STREAM-INF is the variant URI.
      if (pendingStream) {
        const res = parseResolution(pendingStream.RESOLUTION);
        variants.push({
          uri: resolveUrl(baseUrl, line),
          bandwidth: parseInt(pendingStream.BANDWIDTH, 10) || 0,
          averageBandwidth: parseInt(pendingStream['AVERAGE-BANDWIDTH'], 10) || 0,
          resolution: res,
          codecs: pendingStream.CODECS || '',
          frameRate: parseFloat(pendingStream['FRAME-RATE']) || 0,
          audioGroup: pendingStream.AUDIO || '',
          subtitleGroup: pendingStream.SUBTITLES || '',
          name: pendingStream.NAME || '',
        });
        pendingStream = null;
      }
    }

    // Highest quality first (by resolution height, then bandwidth).
    variants.sort((a, b) => {
      const ha = a.resolution ? a.resolution.height : 0;
      const hb = b.resolution ? b.resolution.height : 0;
      return hb - ha || b.bandwidth - a.bandwidth;
    });

    return { type: 'master', variants, media, raw };
  }

  function parseMedia(lines, baseUrl) {
    const segments = [];
    let key = null; // { method, uri, iv, keyFormat }
    let map = null; // { uri, byterange }
    let curInf = null;
    let mediaSequence = 0;
    let nextSeq = 0;
    let targetDuration = 0;
    let version = 0;
    let isLive = true; // flipped false by #EXT-X-ENDLIST
    let discontinuity = false;
    let pendingByteRange = null;
    const byteCursor = {}; // uri -> next implicit offset

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line[0] === '#') {
        if (line.startsWith('#EXT-X-VERSION:')) {
          version = parseInt(line.slice('#EXT-X-VERSION:'.length), 10) || 0;
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
          targetDuration = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
        } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
          nextSeq = mediaSequence;
        } else if (line.startsWith('#EXT-X-ENDLIST')) {
          isLive = false;
        } else if (line.startsWith('#EXT-X-KEY:')) {
          const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
          const method = (a.METHOD || '').toUpperCase();
          if (method === 'NONE') {
            key = null;
          } else {
            key = {
              method,
              uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
              iv: a.IV ? hexToBytes(a.IV) : null,
              keyFormat: a.KEYFORMAT || 'identity',
            };
          }
        } else if (line.startsWith('#EXT-X-MAP:')) {
          const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
          map = {
            uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
            byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null,
          };
        } else if (line.startsWith('#EXTINF:')) {
          const v = line.slice('#EXTINF:'.length);
          const comma = v.indexOf(',');
          curInf = {
            duration: parseFloat(comma >= 0 ? v.slice(0, comma) : v) || 0,
            title: comma >= 0 ? v.slice(comma + 1) : '',
          };
        } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
          pendingByteRange = line.slice('#EXT-X-BYTERANGE:'.length);
        } else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
          discontinuity = true;
        }
        continue;
      }

      // A non-comment line is a media segment URI.
      const uri = resolveUrl(baseUrl, line);
      let byterange = null;
      if (pendingByteRange) {
        byterange = parseByteRange(pendingByteRange, byteCursor[uri] || 0);
        byteCursor[uri] = byterange.offset + byterange.length;
        pendingByteRange = null;
      }
      const seq = nextSeq++;
      segments.push({
        uri,
        duration: curInf ? curInf.duration : 0,
        title: curInf ? curInf.title : '',
        sequence: seq,
        discontinuity,
        byterange,
        key: key ? Object.assign({}, key, { iv: key.iv || seqToIv(seq) }) : null,
        map: map ? Object.assign({}, map) : null,
      });
      curInf = null;
      discontinuity = false;
    }

    let encryption = 'NONE';
    let keyFormat = 'identity';
    for (const s of segments) {
      if (s.key && s.key.method) {
        encryption = s.key.method;
        keyFormat = s.key.keyFormat;
        break;
      }
    }

    return {
      type: 'media',
      version,
      targetDuration,
      mediaSequence,
      isLive,
      totalDuration: segments.reduce((sum, s) => sum + (s.duration || 0), 0),
      segments,
      encryption,
      keyFormat,
      fmp4: segments.some((s) => s.map),
    };
  }

  function parse(text, baseUrl) {
    const lines = String(text).split(/\r?\n/);
    const isMaster = /^#EXT-X-STREAM-INF:/m.test(text);
    return isMaster ? parseMaster(lines, baseUrl, text) : parseMedia(lines, baseUrl);
  }

  return {
    parse,
    parseAttributes,
    resolveUrl,
    hexToBytes,
    seqToIv,
    parseByteRange,
  };
});
