/*
 * Offscreen worker for HLS downloads.
 *
 * Receives a job from the service worker, then:
 *   1. Loads the media playlist (resolving a master playlist if needed).
 *   2. Fetches every segment with bounded concurrency + retries.
 *   3. AES-128 decrypts segments when required (Web Crypto).
 *   4. Assembles the output:
 *        - fMP4 streams  -> concat init segment + media segments (video/mp4)
 *        - MPEG-TS streams -> transmux to MP4 via mux.js (fallback: raw .ts)
 *   5. Creates a Blob URL and asks the service worker to save it.
 */
'use strict';

const CONCURRENCY = 6;
const MAX_RETRIES = 4;

const controllers = new Map(); // jobId -> { canceled }
const objectUrls = new Set();

function post(msg) {
  chrome.runtime.sendMessage(Object.assign({ target: 'sw' }, msg)).catch(() => {});
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, opts, ctrl) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (ctrl && ctrl.canceled) throw new Error('canceled');
    try {
      const res = await fetch(url, opts);
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      lastErr = e;
      if (ctrl && ctrl.canceled) throw new Error('canceled');
      await delay(Math.min(8000, 400 * Math.pow(2, attempt)));
    }
  }
  throw new Error('fetch failed (' + ((lastErr && lastErr.message) || '?') + '): ' + url);
}

async function fetchText(url, ctrl) {
  const res = await fetchWithRetry(url, { credentials: 'include' }, ctrl);
  return res.text();
}

async function fetchBuffer(url, byterange, ctrl) {
  const opts = { credentials: 'include' };
  if (byterange) {
    opts.headers = { Range: `bytes=${byterange.offset}-${byterange.offset + byterange.length - 1}` };
  }
  const res = await fetchWithRetry(url, opts, ctrl);
  return res.arrayBuffer();
}

// MPEG-TS -> fragmented MP4 using mux.js. mux.js processes synchronously,
// so all 'data' events have fired by the time flush() returns.
function transmuxTsToMp4(tsChunks) {
  if (typeof muxjs === 'undefined') throw new Error('mux.js not loaded');
  const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  const dataParts = [];
  let initSegment = null;

  transmuxer.on('data', (segment) => {
    if (!initSegment && segment.initSegment) initSegment = segment.initSegment;
    dataParts.push(segment.data);
  });

  for (const chunk of tsChunks) transmuxer.push(chunk);
  transmuxer.flush();

  if (!dataParts.length) throw new Error('transmuxer produced no output');

  let total = initSegment ? initSegment.byteLength : 0;
  for (const d of dataParts) total += d.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  if (initSegment) {
    out.set(initSegment, off);
    off += initSegment.byteLength;
  }
  for (const d of dataParts) {
    out.set(d, off);
    off += d.byteLength;
  }
  return out;
}

function ensureExt(base, ext) {
  const clean = VDUtil.sanitizeFilename(base);
  return new RegExp('\\.' + ext + '$', 'i').test(clean) ? clean : `${clean}.${ext}`;
}

function concatU8(list) {
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

function base64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// "start-end" byte range -> { offset, length } for a Range header.
function parseRange(range) {
  const m = /(\d+)-(\d+)/.exec(range);
  if (!m) return null;
  const offset = +m[1];
  return { offset, length: +m[2] - offset + 1 };
}

// Vimeo adaptive download: assemble the chosen video + audio tracks (init +
// segments) and mux them into one MP4. Falls back to two files if muxing fails.
async function runVimeo(job) {
  const jobId = job.jobId;
  const ctrl = { canceled: false };
  controllers.set(jobId, ctrl);

  try {
    const text = await fetchText(job.url, ctrl);
    const man = VimeoManifest.parse(text, job.url);
    if (!man.video.length && !man.audio.length) throw new Error('No tracks found in Vimeo manifest');

    const video = job.videoId ? man.video.find((v) => v.id === job.videoId) : man.video[0];
    const audio = job.audioId ? man.audio.find((a) => a.id === job.audioId) : man.audio[0];
    if (!video && !audio) throw new Error('No playable track in Vimeo manifest');

    const totalSegs = (video ? video.segments.length : 0) + (audio ? audio.segments.length : 0);
    let doneSegs = 0;
    let receivedBytes = 0;
    let lastReport = 0;
    function report(phase, force) {
      const now = Date.now();
      if (force || now - lastReport > 250) {
        lastReport = now;
        post({ cmd: 'progress', jobId, phase: phase || 'fetching', progress: totalSegs ? doneSegs / totalSegs : 0, received: receivedBytes, segments: totalSegs, done: doneSegs });
      }
    }

    async function assemble(rend) {
      const parts = [];
      if (rend.initBase64) parts.push(base64ToUint8(rend.initBase64));
      else if (rend.initUrl) parts.push(new Uint8Array(await fetchBuffer(rend.initUrl, null, ctrl)));

      const results = new Array(rend.segments.length);
      let next = 0;
      async function worker() {
        for (;;) {
          if (ctrl.canceled) throw new Error('canceled');
          const i = next++;
          if (i >= rend.segments.length) return;
          const seg = rend.segments[i];
          const buf = await fetchBuffer(seg.url, seg.range ? parseRange(seg.range) : null, ctrl);
          results[i] = new Uint8Array(buf);
          doneSegs++;
          receivedBytes += results[i].byteLength;
          report('fetching');
        }
      }
      const pool = [];
      for (let w = 0; w < Math.min(CONCURRENCY, rend.segments.length); w++) pool.push(worker());
      await Promise.all(pool);
      for (const u of results) parts.push(u);
      return concatU8(parts);
    }

    const videoBuf = video ? await assemble(video) : null;
    const audioBuf = audio ? await assemble(audio) : null;
    if (ctrl.canceled) throw new Error('canceled');
    report('assembling', true);
    post({ cmd: 'progress', jobId, phase: 'assembling', progress: 1, received: receivedBytes, segments: totalSegs, done: doneSegs });

    const base = job.filename || 'video';
    const makeUrl = (u8, mime) => {
      const url = URL.createObjectURL(new Blob([u8], { type: mime }));
      objectUrls.add(url);
      return url;
    };

    if (videoBuf && audioBuf) {
      try {
        const merged = FMP4Muxer.mux(videoBuf, audioBuf);
        post({ cmd: 'ready', jobId, outputs: [{ objectUrl: makeUrl(merged, 'video/mp4'), filename: ensureExt(base, 'mp4'), size: merged.length }] });
      } catch (e) {
        // Robust fallback: deliver both tracks as separate, always-valid files.
        post({ cmd: 'log', jobId, message: 'mux failed, saving separate files: ' + e.message });
        post({
          cmd: 'ready',
          jobId,
          note: 'Muxing failed — saved video and audio as separate files.',
          outputs: [
            { objectUrl: makeUrl(videoBuf, 'video/mp4'), filename: ensureExt(base + ' (video)', 'mp4'), size: videoBuf.length },
            { objectUrl: makeUrl(audioBuf, 'audio/mp4'), filename: ensureExt(base + ' (audio)', 'm4a'), size: audioBuf.length },
          ],
        });
      }
    } else if (videoBuf) {
      post({ cmd: 'ready', jobId, outputs: [{ objectUrl: makeUrl(videoBuf, 'video/mp4'), filename: ensureExt(base, 'mp4'), size: videoBuf.length }] });
    } else {
      post({ cmd: 'ready', jobId, outputs: [{ objectUrl: makeUrl(audioBuf, 'audio/mp4'), filename: ensureExt(base, 'm4a'), size: audioBuf.length }] });
    }
  } catch (e) {
    if (String(e && e.message) === 'canceled') return;
    post({ cmd: 'error', jobId, message: String((e && e.message) || e) });
  } finally {
    controllers.delete(jobId);
  }
}

async function runHls(job) {
  const jobId = job.jobId;
  const ctrl = { canceled: false };
  controllers.set(jobId, ctrl);

  try {
    let url = job.url;
    let text = await fetchText(url, ctrl);
    let parsed = M3U8.parse(text, url);

    // Resolve a master playlist down to a single media playlist.
    if (parsed.type === 'master') {
      let variant = null;
      if (job.variantUri) variant = parsed.variants.find((v) => v.uri === job.variantUri);
      if (!variant) variant = parsed.variants[0]; // already sorted best-first
      if (!variant) throw new Error('No playable variant found in master playlist');
      url = variant.uri;
      text = await fetchText(url, ctrl);
      parsed = M3U8.parse(text, url);
    }

    if (parsed.type !== 'media') throw new Error('Could not load a media playlist');
    if (!parsed.segments.length) throw new Error('Playlist has no segments (empty or protected stream)');

    // Encryption capability check.
    if (parsed.encryption !== 'NONE') {
      if (parsed.encryption !== 'AES-128') {
        throw new Error('Unsupported encryption "' + parsed.encryption + '" (likely DRM-protected)');
      }
      if (parsed.keyFormat && parsed.keyFormat !== 'identity') {
        throw new Error('DRM key format not supported: ' + parsed.keyFormat);
      }
    }

    const segments = parsed.segments;
    const total = segments.length;
    const isFmp4 = parsed.fmp4;

    // fMP4 init segment (fetched once; shared by all media segments).
    let initData = null;
    if (isFmp4) {
      const withMap = segments.find((s) => s.map && s.map.uri);
      if (withMap) initData = await fetchBuffer(withMap.map.uri, withMap.map.byterange, ctrl);
    }

    // AES-128 key cache (keyed by URI).
    const keyCache = new Map();
    async function getKey(keyUri) {
      if (keyCache.has(keyUri)) return keyCache.get(keyUri);
      const raw = await fetchBuffer(keyUri, null, ctrl);
      const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      keyCache.set(keyUri, cryptoKey);
      return cryptoKey;
    }

    const results = new Array(total);
    let completed = 0;
    let receivedBytes = 0;
    let nextIndex = 0;
    let lastReport = 0;

    function report(phase, force) {
      const now = Date.now();
      if (force || now - lastReport > 250) {
        lastReport = now;
        post({
          cmd: 'progress',
          jobId,
          phase: phase || 'fetching',
          progress: total ? completed / total : 0,
          received: receivedBytes,
          total: 0,
          segments: total,
          done: completed,
        });
      }
    }

    async function worker() {
      for (;;) {
        if (ctrl.canceled) throw new Error('canceled');
        const i = nextIndex++;
        if (i >= total) return;
        const seg = segments[i];
        let buf = await fetchBuffer(seg.uri, seg.byterange, ctrl);
        if (seg.key && seg.key.method === 'AES-128') {
          const key = await getKey(seg.key.uri);
          buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: seg.key.iv }, key, buf);
        }
        results[i] = new Uint8Array(buf);
        completed++;
        receivedBytes += results[i].byteLength;
        report('fetching');
      }
    }

    const pool = [];
    for (let w = 0; w < Math.min(CONCURRENCY, total); w++) pool.push(worker());
    await Promise.all(pool);
    if (ctrl.canceled) throw new Error('canceled');
    report('fetching', true);

    // Assemble the output container.
    post({ cmd: 'progress', jobId, phase: 'assembling', progress: 1, received: receivedBytes, segments: total, done: total });

    let blob;
    let ext;
    if (isFmp4) {
      const parts = [];
      if (initData) parts.push(new Uint8Array(initData));
      for (const u of results) parts.push(u);
      blob = new Blob(parts, { type: 'video/mp4' });
      ext = 'mp4';
    } else if (job.mux !== false && typeof muxjs !== 'undefined') {
      try {
        const mp4 = transmuxTsToMp4(results);
        blob = new Blob([mp4], { type: 'video/mp4' });
        ext = 'mp4';
      } catch (e) {
        post({ cmd: 'log', jobId, message: 'TS->MP4 transmux failed, saving raw .ts: ' + e.message });
        blob = new Blob(results, { type: 'video/mp2t' });
        ext = 'ts';
      }
    } else {
      blob = new Blob(results, { type: 'video/mp2t' });
      ext = 'ts';
    }

    const objectUrl = URL.createObjectURL(blob);
    objectUrls.add(objectUrl);
    post({ cmd: 'ready', jobId, outputs: [{ objectUrl, filename: ensureExt(job.filename || 'video', ext), size: blob.size }] });
  } catch (e) {
    if (String(e && e.message) === 'canceled') return; // service worker already marked it
    post({ cmd: 'error', jobId, message: String((e && e.message) || e) });
  } finally {
    controllers.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.cmd === 'download') {
    if (msg.job && msg.job.kind === 'vimeo') runVimeo(msg.job);
    else runHls(msg.job);
  } else if (msg.cmd === 'cancel') {
    const ctrl = controllers.get(msg.jobId);
    if (ctrl) ctrl.canceled = true;
  } else if (msg.cmd === 'revoke') {
    if (msg.url && objectUrls.has(msg.url)) {
      URL.revokeObjectURL(msg.url);
      objectUrls.delete(msg.url);
    }
  }
  // No async response needed.
});
