/*
 * Small shared helpers used by the popup and the offscreen document.
 * UMD-style so it can also be unit-tested under Node.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.VDUtil = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Characters that are illegal in filenames on Windows/macOS/Linux.
  const ILLEGAL = /[\\/:*?"<>|]+/g;

  // Drop ASCII control characters (code points below 32) without embedding
  // raw control bytes in this source file.
  function stripControl(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) >= 32) out += s[i];
    }
    return out;
  }

  // Replace illegal chars with spaces, drop control chars, collapse
  // whitespace, trim and cap length. Hyphens and spaces are valid in
  // filenames and are preserved.
  function sanitizeFilename(name) {
    const cleaned = stripControl(String(name || '').replace(ILLEGAL, ' '));
    return cleaned
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 120)
      .trim() || 'video';
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  function humanBitrate(bps) {
    if (!bps) return '';
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
    return `${Math.round(bps / 1e3)} kbps`;
  }

  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  // Human label for a master-playlist variant, e.g. "1080p · 4.2 Mbps".
  function variantLabel(v) {
    const parts = [];
    if (v.resolution && v.resolution.height) {
      parts.push(`${v.resolution.height}p`);
    } else if (v.name) {
      parts.push(v.name);
    }
    if (v.bandwidth) parts.push(humanBitrate(v.bandwidth));
    return parts.join(' · ') || 'stream';
  }

  // Best-effort base name for the saved file, from page title or URL.
  function deriveBaseName(title, url) {
    let base = sanitizeFilename(title);
    if (!base || base === 'video') {
      try {
        const u = new URL(url);
        const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
        base = sanitizeFilename(last.replace(/\.(m3u8|mpd|ts|m4s)$/i, '')) || sanitizeFilename(u.hostname);
      } catch (e) {
        /* keep default */
      }
    }
    return base || 'video';
  }

  return {
    sanitizeFilename,
    humanSize,
    humanBitrate,
    formatDuration,
    variantLabel,
    deriveBaseName,
  };
});
