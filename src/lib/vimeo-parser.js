/*
 * Parser for Vimeo's adaptive "master.json" / "playlist.json" manifest.
 *
 * Vimeo's adaptive delivery (vod-adaptive*.vimeocdn.com) does not use standard
 * HLS/DASH manifests. Instead it serves a JSON document:
 *
 *   { clip_id, base_url, video: [rendition...], audio: [rendition...] }
 *
 * where each rendition has a base64 `init_segment` (the fMP4 init / moov) and a
 * list of `segments` with URLs relative to a 3-level base. Video and audio are
 * always separate tracks.
 *
 * parse(text, manifestUrl) resolves every URL to absolute and returns a tidy,
 * quality-sorted structure for the downloader. UMD + CommonJS (for tests).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.VimeoManifest = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolve(base, rel) {
    try {
      return new URL(rel, base).href;
    } catch (e) {
      return rel;
    }
  }

  function mapRendition(r, manifestBase) {
    const rBase = resolve(manifestBase, r.base_url || '');
    const segments = (r.segments || []).map((s) => ({
      // Vimeo encodes ranges in the segment URL (query string) when present,
      // so fetching the resolved URL is enough. `range` is kept for the rare
      // manifests that specify a byte range against a single media file.
      url: s.url != null ? resolve(rBase, s.url) : rBase,
      range: s.range || null,
      size: s.size || 0,
      start: s.start,
      end: s.end,
    }));
    return {
      id: r.id,
      baseUrl: rBase,
      mime: r.mime_type || '',
      codecs: r.codecs || '',
      bitrate: r.bitrate || r.avg_bitrate || 0,
      width: r.width || 0,
      height: r.height || 0,
      fps: r.framerate || 0,
      channels: r.channels || 0,
      sampleRate: r.sample_rate || 0,
      duration: r.duration || 0,
      initBase64: r.init_segment || null,
      initUrl: r.init_segment_url != null ? resolve(rBase, r.init_segment_url) : null,
      segments,
    };
  }

  function parse(text, manifestUrl) {
    const m = typeof text === 'string' ? JSON.parse(text) : text;
    const base = resolve(manifestUrl, m.base_url || '');
    const video = (m.video || [])
      .map((r) => mapRendition(r, base))
      .sort((a, b) => b.height * b.width - a.height * a.width || b.bitrate - a.bitrate);
    const audio = (m.audio || [])
      .map((r) => mapRendition(r, base))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return { type: 'vimeo', clipId: m.clip_id || '', video, audio };
  }

  // Heuristic: does this text look like a Vimeo adaptive manifest?
  function looksLikeVimeo(text) {
    try {
      const m = typeof text === 'string' ? JSON.parse(text) : text;
      return !!(m && (m.clip_id || m.base_url) && (Array.isArray(m.video) || Array.isArray(m.audio)));
    } catch (e) {
      return false;
    }
  }

  return { parse, looksLikeVimeo };
});
