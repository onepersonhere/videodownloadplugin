/*
 * Content script (top frame). Two jobs:
 *   1. Tell the background worker the page title + URL (for nicer filenames).
 *   2. Report direct media URLs found on <video>/<audio>/<source> elements.
 *
 * Network-level detection (HLS manifests, media in iframes) is handled by the
 * service worker via webRequest; this is a best-effort supplement for media
 * that is referenced directly in the DOM.
 */
(function () {
  'use strict';
  if (window.top !== window) return; // top frame only

  const seen = new Set();

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* extension context may be gone; ignore */
    }
  }

  function sendPageInfo() {
    send({ cmd: 'pageInfo', title: document.title || '', url: location.href });
  }

  function looksLikeMedia(url) {
    return /^https?:/i.test(url) &&
      !/^blob:|^data:/i.test(url);
  }

  function scan() {
    const items = [];
    const els = document.querySelectorAll('video, audio, video source, audio source');
    els.forEach((el) => {
      const candidates = [el.currentSrc, el.src, el.getAttribute && el.getAttribute('src')];
      for (const raw of candidates) {
        if (!raw) continue;
        let url;
        try {
          url = new URL(raw, location.href).href;
        } catch (e) {
          continue;
        }
        if (!looksLikeMedia(url) || seen.has(url)) continue;
        seen.add(url);
        const isHls = /\.m3u8(\?|#|$)/i.test(url);
        items.push({
          url,
          kind: isHls ? 'hls' : 'direct',
          mime: (el.getAttribute && el.getAttribute('type')) || '',
          size: 0,
          fromPage: true,
        });
      }
    });
    if (items.length) send({ cmd: 'pageMedia', items });
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 800);
  }

  sendPageInfo();
  scan();

  // Re-scan when the DOM changes (players often inject <video> late).
  const observer = new MutationObserver(scheduleScan);
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  } catch (e) {
    /* ignore */
  }

  // Title can change after load (SPAs); report it again shortly after.
  document.addEventListener('DOMContentLoaded', sendPageInfo);
  window.addEventListener('load', () => { sendPageInfo(); scan(); });
  setTimeout(sendPageInfo, 2500);
})();
