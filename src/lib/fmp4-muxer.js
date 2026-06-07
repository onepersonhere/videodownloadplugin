/*
 * fMP4 -> progressive MP4 remuxer.
 *
 * Takes one or more fragmented MP4 buffers (ftyp + moov + (moof+mdat)*) and
 * rebuilds a single *progressive* MP4: one `moov` with a complete sample table
 * (stts/ctts/stsc/stsz/stco|co64/stss) per track and a single `mdat`. Unlike a
 * fragmented MP4, this has a known duration and a random-access index, so
 * players can show the scrub bar, seek, and change playback speed.
 *
 * Used as the final stage for every MP4 the extension produces:
 *   - Vimeo:      remux([videoFmp4, audioFmp4])   (separate tracks -> one file)
 *   - HLS fMP4:   remux([assembledFmp4])
 *   - HLS TS:     remux([muxjsOutput])            (mux.js emits fragmented MP4)
 *
 * Sample data and timing are preserved byte-for-byte (no re-encoding). UMD +
 * CommonJS (for tests).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.FMP4Muxer = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- reading ---------- */
  function rdU32(b, p) {
    return b[p] * 16777216 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  }
  function rdU64(b, p) {
    return rdU32(b, p) * 4294967296 + rdU32(b, p + 4);
  }
  function rdI32(b, p) {
    const v = rdU32(b, p);
    return v >= 2147483648 ? v - 4294967296 : v;
  }
  function typ(b, p) {
    return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  }
  function boxes(b, s, e) {
    s = s || 0;
    e = e == null ? b.length : e;
    const out = [];
    let p = s;
    while (p + 8 <= e) {
      let size = rdU32(b, p);
      const type = typ(b, p + 4);
      let header = 8;
      if (size === 1) {
        size = rdU64(b, p + 8);
        header = 16;
      } else if (size === 0) {
        size = e - p;
      }
      if (size < 8 || p + size > e) break;
      out.push({ type, start: p, size, header, dataStart: p + header, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (b, x, t) => boxes(b, x ? x.dataStart : 0, x ? x.end : b.length).find((k) => k.type === t);
  const kids = (b, x, t) => boxes(b, x ? x.dataStart : 0, x ? x.end : b.length).filter((k) => k.type === t);

  /* ---------- writing ---------- */
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
  function U32(n) {
    const b = new Uint8Array(4);
    b[0] = (n >>> 24) & 255;
    b[1] = (n >>> 16) & 255;
    b[2] = (n >>> 8) & 255;
    b[3] = n & 255;
    return b;
  }
  const U16 = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
  const I32 = (n) => U32(n >>> 0); // two's complement
  function U64(n) {
    return concat([U32(Math.floor(n / 4294967296)), U32(n >>> 0)]);
  }
  function box(type, parts) {
    const body = concat(parts);
    const len = body.length + 8;
    const h = new Uint8Array(8);
    h[0] = (len >>> 24) & 255;
    h[1] = (len >>> 16) & 255;
    h[2] = (len >>> 8) & 255;
    h[3] = len & 255;
    h[4] = type.charCodeAt(0);
    h[5] = type.charCodeAt(1);
    h[6] = type.charCodeAt(2);
    h[7] = type.charCodeAt(3);
    return concat([h, body]);
  }
  function full(type, ver, flags, parts) {
    const vf = new Uint8Array([ver & 255, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]);
    return box(type, [vf].concat(parts));
  }
  const MATRIX = concat([U32(0x10000), U32(0), U32(0), U32(0), U32(0x10000), U32(0), U32(0), U32(0), U32(0x40000000)]);

  /* ---------- demux every track out of a fragmented MP4 ---------- */
  function demuxAll(buf) {
    const moov = boxes(buf).find((b) => b.type === 'moov');
    if (!moov) return [];
    const mvex = child(buf, moov, 'mvex');
    const trexById = {};
    if (mvex) {
      for (const tx of kids(buf, mvex, 'trex')) {
        trexById[rdU32(buf, tx.dataStart + 4)] = {
          dur: rdU32(buf, tx.dataStart + 12),
          size: rdU32(buf, tx.dataStart + 16),
          flags: rdU32(buf, tx.dataStart + 20),
        };
      }
    }
    const tracks = {};
    const order = [];
    for (const trak of kids(buf, moov, 'trak')) {
      const tkhd = child(buf, trak, 'tkhd');
      const tver = buf[tkhd.dataStart];
      const id = rdU32(buf, tkhd.dataStart + 4 + (tver === 1 ? 16 : 8));
      const w = rdU32(buf, tkhd.end - 8) >>> 16;
      const h = rdU32(buf, tkhd.end - 4) >>> 16;
      const mdia = child(buf, trak, 'mdia');
      const mdhd = child(buf, mdia, 'mdhd');
      const mver = buf[mdhd.dataStart];
      const ts = mver === 1 ? rdU32(buf, mdhd.dataStart + 4 + 16) : rdU32(buf, mdhd.dataStart + 4 + 8);
      const hdlr = child(buf, mdia, 'hdlr');
      const handler = typ(buf, hdlr.dataStart + 8);
      const stbl = child(buf, child(buf, mdia, 'minf'), 'stbl');
      const stsd = child(buf, stbl, 'stsd');
      tracks[id] = { id, timescale: ts, w, h, handler, stsd: buf.subarray(stsd.start, stsd.end), samples: [], parts: [] };
      order.push(id);
    }

    for (const mf of boxes(buf)) {
      if (mf.type !== 'moof') continue;
      const moofStart = mf.start;
      for (const traf of kids(buf, mf, 'traf')) {
        const tfhd = child(buf, traf, 'tfhd');
        const fl = rdU32(buf, tfhd.dataStart) & 0xffffff;
        let p = tfhd.dataStart + 4;
        const tid = rdU32(buf, p);
        p += 4;
        const tr = tracks[tid];
        if (!tr) continue;
        const dx = trexById[tid] || { dur: 0, size: 0, flags: 0 };
        let baseOff = null;
        let tdDur = dx.dur;
        let tdSize = dx.size;
        let tdFlags = dx.flags;
        if (fl & 0x1) { baseOff = rdU64(buf, p); p += 8; }
        if (fl & 0x2) p += 4;
        if (fl & 0x8) { tdDur = rdU32(buf, p); p += 4; }
        if (fl & 0x10) { tdSize = rdU32(buf, p); p += 4; }
        if (fl & 0x20) { tdFlags = rdU32(buf, p); p += 4; }
        const base = baseOff != null ? baseOff : moofStart;
        for (const trun of kids(buf, traf, 'trun')) {
          const tf = rdU32(buf, trun.dataStart) & 0xffffff;
          const tver = buf[trun.dataStart];
          let q = trun.dataStart + 4;
          const cnt = rdU32(buf, q); q += 4;
          let dOff = 0;
          if (tf & 0x1) { dOff = rdI32(buf, q); q += 4; }
          let firstFlags = null;
          if (tf & 0x4) { firstFlags = rdU32(buf, q); q += 4; }
          let off = base + dOff;
          for (let i = 0; i < cnt; i++) {
            let dur = tdDur, size = tdSize, flags = tdFlags, cto = 0;
            if (tf & 0x100) { dur = rdU32(buf, q); q += 4; }
            if (tf & 0x200) { size = rdU32(buf, q); q += 4; }
            if (tf & 0x400) { flags = rdU32(buf, q); q += 4; }
            if (tf & 0x800) { cto = tver === 1 ? rdI32(buf, q) : rdU32(buf, q); q += 4; }
            if (i === 0 && firstFlags != null) flags = firstFlags;
            tr.samples.push({ size, duration: dur, cto, sync: !(flags & 0x10000) });
            tr.parts.push(buf.subarray(off, off + size));
            off += size;
          }
        }
      }
    }
    return order.map((id) => {
      const t = tracks[id];
      t.data = concat(t.parts);
      delete t.parts;
      return t;
    }).filter((t) => t.samples.length);
  }

  /* ---------- build a progressive MP4 from demuxed tracks ---------- */
  function rle(arr, eq, mk) {
    const out = [];
    for (const v of arr) {
      const last = out[out.length - 1];
      if (last && eq(last, v)) last.count++;
      else out.push(mk(v));
    }
    return out;
  }
  function buildStbl(tr, chunkOff, use64) {
    const N = tr.samples.length;
    const st = rle(tr.samples.map((s) => s.duration), (l, v) => l.delta === v, (v) => ({ count: 1, delta: v }));
    const sttsParts = [U32(st.length)];
    st.forEach((e) => { sttsParts.push(U32(e.count), U32(e.delta)); });
    const stts = full('stts', 0, 0, sttsParts);

    let ctts = new Uint8Array(0);
    if (tr.samples.some((s) => s.cto !== 0)) {
      const c = rle(tr.samples.map((s) => s.cto), (l, v) => l.off === v, (v) => ({ count: 1, off: v }));
      const parts = [U32(c.length)];
      c.forEach((e) => { parts.push(U32(e.count), I32(e.off)); });
      ctts = full('ctts', 1, 0, parts);
    }
    const stsc = full('stsc', 0, 0, [U32(1), U32(1), U32(N), U32(1)]);
    const stszParts = [U32(0), U32(N)];
    tr.samples.forEach((s) => stszParts.push(U32(s.size)));
    const stsz = full('stsz', 0, 0, stszParts);
    const stco = use64 ? full('co64', 0, 0, [U32(1), U64(chunkOff)]) : full('stco', 0, 0, [U32(1), U32(chunkOff)]);

    let stss = new Uint8Array(0);
    if (tr.handler === 'vide') {
      const idx = [];
      tr.samples.forEach((s, i) => { if (s.sync) idx.push(i + 1); });
      if (idx.length && idx.length < N) {
        stss = full('stss', 0, 0, [U32(idx.length)].concat(idx.map(U32)));
      }
    }
    return box('stbl', [tr.stsd, stts, ctts, stsc, stsz, stco, stss]);
  }
  function buildTrak(tr, id, movieTs, chunkOff, use64) {
    const mediaDur = tr.samples.reduce((a, s) => a + s.duration, 0);
    const movieDur = Math.round((mediaDur / tr.timescale) * movieTs);
    const vid = tr.handler === 'vide';
    const tkhd = full('tkhd', 0, 7, [
      U32(0), U32(0), U32(id), U32(0), U32(movieDur), U32(0), U32(0),
      U16(0), U16(0), U16(vid ? 0 : 0x100), U16(0), MATRIX, U32(vid ? tr.w << 16 : 0), U32(vid ? tr.h << 16 : 0),
    ]);
    const mdhd = full('mdhd', 0, 0, [U32(0), U32(0), U32(tr.timescale), U32(mediaDur), U16(0x55c4), U16(0)]);
    const name = (vid ? 'Video' : 'Sound') + '\0';
    const nameBytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) nameBytes[i] = name.charCodeAt(i);
    const handlerBytes = new Uint8Array([tr.handler.charCodeAt(0), tr.handler.charCodeAt(1), tr.handler.charCodeAt(2), tr.handler.charCodeAt(3)]);
    const hdlr = full('hdlr', 0, 0, [U32(0), handlerBytes, U32(0), U32(0), U32(0), nameBytes]);
    const mhd = vid ? full('vmhd', 0, 1, [U16(0), U16(0), U16(0), U16(0)]) : full('smhd', 0, 0, [U16(0), U16(0)]);
    const dinf = box('dinf', [full('dref', 0, 0, [U32(1), full('url ', 0, 1, [])])]);
    const minf = box('minf', [mhd, dinf, buildStbl(tr, chunkOff, use64)]);
    return box('trak', [tkhd, box('mdia', [mdhd, hdlr, minf])]);
  }

  function build(tracks) {
    if (!tracks.length) throw new Error('no fragmented tracks found to remux');
    const movieTs = 1000;
    const ftyp = box('ftyp', [strBytes('isom'), U32(0x200), strBytes('isomiso2avc1mp41')]);
    const total = tracks.reduce((a, t) => a + t.data.length, 0);
    const use64 = total + 16 > 0xffffffff;
    const mh = use64 ? 16 : 8;

    let off = ftyp.length + mh;
    const traks = [];
    tracks.forEach((t, i) => {
      traks.push(buildTrak(t, i + 1, movieTs, off, use64));
      off += t.data.length;
    });
    const dur = Math.max.apply(null, tracks.map((t) => Math.round((t.samples.reduce((a, s) => a + s.duration, 0) / t.timescale) * movieTs)));
    const mvhd = full('mvhd', 0, 0, [
      U32(0), U32(0), U32(movieTs), U32(dur), U32(0x10000), U16(0x100), U16(0), U32(0), U32(0),
      MATRIX, U32(0), U32(0), U32(0), U32(0), U32(0), U32(0), U32(tracks.length + 1),
    ]);
    const moov = box('moov', [mvhd].concat(traks));

    const data = concat(tracks.map((t) => t.data));
    let mdatHeader;
    if (use64) {
      mdatHeader = new Uint8Array(16);
      U32(1).forEach((v, i) => (mdatHeader[i] = v));
      mdatHeader[4] = 109; mdatHeader[5] = 100; mdatHeader[6] = 97; mdatHeader[7] = 116; // 'mdat'
      U64(data.length + 16).forEach((v, i) => (mdatHeader[8 + i] = v));
    } else {
      mdatHeader = new Uint8Array(8);
      U32(data.length + 8).forEach((v, i) => (mdatHeader[i] = v));
      mdatHeader[4] = 109; mdatHeader[5] = 100; mdatHeader[6] = 97; mdatHeader[7] = 116;
    }
    return concat([ftyp, mdatHeader, data, moov]);
  }

  function strBytes(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  // Demux every track from each input buffer and rebuild one progressive MP4.
  function remux(buffers) {
    const tracks = [];
    for (const b of buffers) {
      for (const t of demuxAll(b)) tracks.push(t);
    }
    return build(tracks);
  }

  // Convenience: combine a video-only and an audio-only fMP4 (Vimeo).
  function mux(videoBuf, audioBuf) {
    return remux([videoBuf, audioBuf]);
  }

  return { remux, mux, boxes };
});
