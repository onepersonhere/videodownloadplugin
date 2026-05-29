/*
 * Minimal fragmented-MP4 muxer: combine a video-only fMP4 and an audio-only
 * fMP4 (each = ftyp + moov + (moof+mdat)*) into a single 2-track MP4.
 *
 * Strategy: build one moov that contains both tracks (audio relabelled to
 * track_ID 2), then concatenate the original fragments unchanged (patching the
 * audio fragments' track_ID). Sample data and timing are preserved byte-for-
 * byte, so no re-encoding happens.
 *
 * Works as a classic script (attaches `FMP4Muxer` to self/window) and as a
 * CommonJS module (for tests).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.FMP4Muxer = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function u32(b, p) {
    return b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  }
  function setU32(b, p, v) {
    b[p] = (v >>> 24) & 255;
    b[p + 1] = (v >>> 16) & 255;
    b[p + 2] = (v >>> 8) & 255;
    b[p + 3] = v & 255;
  }
  function typeOf(b, p) {
    return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  }
  function concat(list) {
    let n = 0;
    for (const a of list) n += a.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const a of list) {
      out.set(a, p);
      p += a.length;
    }
    return out;
  }

  // Walk the boxes in [start, end). Returns {type,start,size,header,dataStart,end}.
  function boxes(b, start, end) {
    start = start || 0;
    end = end == null ? b.length : end;
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p);
      const type = typeOf(b, p + 4);
      let header = 8;
      if (size === 1) {
        size = u32(b, p + 8) * 0x100000000 + u32(b, p + 12);
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < 8 || p + size > end) break;
      out.push({ type, start: p, size, header, dataStart: p + header, end: p + size });
      p += size;
    }
    return out;
  }
  function child(b, box, t) {
    return boxes(b, box ? box.dataStart : 0, box ? box.end : b.length).find((x) => x.type === t);
  }
  function children(b, box, t) {
    return boxes(b, box ? box.dataStart : 0, box ? box.end : b.length).filter((x) => x.type === t);
  }
  const cut = (b, box) => b.slice(box.start, box.end); // returns a writable copy

  function mkbox(type, parts) {
    const body = concat(parts);
    const out = new Uint8Array(8 + body.length);
    setU32(out, 0, 8 + body.length);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(body, 8);
    return out;
  }

  // track_ID lives at different offsets per box; patch in-place on a copy.
  function patchTkhd(trak, id) {
    const tk = child(trak, boxes(trak)[0], 'tkhd');
    const ver = trak[tk.dataStart];
    setU32(trak, tk.dataStart + 4 + (ver === 1 ? 16 : 8), id);
  }
  function patchTrex(trex, id) {
    setU32(trex, boxes(trex)[0].dataStart + 4, id);
  }
  function patchFragmentTrackId(frags, id) {
    for (const bx of boxes(frags)) {
      if (bx.type !== 'moof') continue;
      for (const traf of children(frags, bx, 'traf')) {
        const tf = child(frags, traf, 'tfhd');
        if (tf) setU32(frags, tf.dataStart + 4, id);
      }
    }
  }

  // Merge a video-only fMP4 and an audio-only fMP4 into one 2-track MP4.
  function mux(videoBuf, audioBuf) {
    const vmoov = boxes(videoBuf).find((b) => b.type === 'moov');
    const amoov = boxes(audioBuf).find((b) => b.type === 'moov');
    const vftyp = boxes(videoBuf).find((b) => b.type === 'ftyp');
    if (!vmoov || !amoov || !vftyp) throw new Error('missing ftyp/moov box');

    const vmvex = child(videoBuf, vmoov, 'mvex');
    const amvex = child(audioBuf, amoov, 'mvex');
    if (!vmvex || !amvex) throw new Error('inputs are not fragmented MP4 (no mvex)');

    const vmvhd = child(videoBuf, vmoov, 'mvhd');
    const vtrakB = child(videoBuf, vmoov, 'trak');
    const atrakB = child(audioBuf, amoov, 'trak');
    const vtrexB = child(videoBuf, vmvex, 'trex');
    const atrexB = child(audioBuf, amvex, 'trex');
    if (!vmvhd || !vtrakB || !atrakB || !vtrexB || !atrexB) throw new Error('unexpected init layout');

    const mvhd = cut(videoBuf, vmvhd);
    setU32(mvhd, mvhd.length - 4, 3); // next_track_ID

    const vtrak = cut(videoBuf, vtrakB); // keeps track_ID 1
    const atrak = cut(audioBuf, atrakB);
    patchTkhd(atrak, 2);

    const vtrex = cut(videoBuf, vtrexB);
    const atrex = cut(audioBuf, atrexB);
    patchTrex(atrex, 2);

    const ftyp = cut(videoBuf, vftyp);
    const moov = mkbox('moov', [mvhd, vtrak, atrak, mkbox('mvex', [vtrex, atrex])]);

    const vfrags = videoBuf.slice(vmoov.end);
    const afrags = audioBuf.slice(amoov.end);
    patchFragmentTrackId(afrags, 2);

    return concat([ftyp, moov, vfrags, afrags]);
  }

  return { mux, boxes };
});
