/*
 * HLS Video Downloader — background service worker (Manifest V3).
 *
 * Responsibilities:
 *   1. Sniff network traffic for HLS manifests (.m3u8) and direct media files.
 *   2. Keep a per-tab registry of detected media in chrome.storage.session
 *      (so it survives service-worker restarts and the popup can read it).
 *   3. Route download jobs: direct files go straight to chrome.downloads;
 *      HLS streams are handed to an offscreen document that fetches, decrypts
 *      and assembles the segments, then hands back a Blob URL to save.
 */
'use strict';

const SESSION = chrome.storage.session;

// In-memory working copy; storage.session is the durable source of truth.
const state = { media: {}, jobs: {} };

// Resolves once we've rehydrated state after a service-worker restart.
const ready = SESSION.get(['media', 'jobs'])
  .then((s) => {
    state.media = s.media || {};
    state.jobs = s.jobs || {};
  })
  .catch(() => {});

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 120);
}
function persistNow() {
  clearTimeout(persistTimer);
  return SESSION.set({ media: state.media, jobs: state.jobs }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#5B6CF0' });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#5B6CF0' });
});

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

const HLS_CT = /mpegurl/i;
const DIRECT_EXT = /\.(mp4|m4v|webm|mkv|mov|m4a|mp3|aac|ogg|ogv|wav|flac|avi|3gp)(\?|#|$)/i;
const SEGMENT_EXT = /\.(ts|m4s)(\?|#|$)/i;
const SEGMENT_HINT = /[._/-](init|seg|segment|chunk|frag|fragment)[._-]?\d*/i;

function headerValue(headers, name) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? (h.value || '') : '';
}

function isLikelySegment(url) {
  return SEGMENT_EXT.test(url) || SEGMENT_HINT.test(url);
}

// Decide what kind of media (if any) a finished request represents.
function classify(url, contentType, contentLength) {
  const ct = (contentType || '').toLowerCase();
  if (/^(blob|data|chrome-extension):/.test(url)) return null;

  // HLS manifests: by content-type or by .m3u8 extension.
  if (HLS_CT.test(ct) || /\.m3u8(\?|#|$)/i.test(url)) return { kind: 'hls' };

  if (isLikelySegment(url) || /mp2t/.test(ct)) return null; // HLS segment, skip

  const looksDirect =
    DIRECT_EXT.test(url) ||
    (/^(video|audio)\//.test(ct) && !HLS_CT.test(ct));
  if (!looksDirect) return null;

  // Require a meaningful size when we only have a content-type to go on, to
  // avoid logging tiny init segments, ad beacons, etc.
  const len = parseInt(contentLength, 10);
  if (!DIRECT_EXT.test(url) && len && len < 1024 * 1024) return null;
  return { kind: 'direct', mime: ct.split(';')[0] || '' };
}

function recordMedia(tabId, item) {
  if (tabId == null || tabId < 0) return;
  ready.then(() => {
    const bucket = state.media[tabId] || (state.media[tabId] = { title: '', pageUrl: '', items: {} });
    const existing = bucket.items[item.url];
    if (existing) {
      // Enrich an existing entry without losing earlier info.
      bucket.items[item.url] = Object.assign(existing, item, { ts: existing.ts });
    } else {
      bucket.items[item.url] = Object.assign({ ts: Date.now() }, item);
    }
    persist();
    updateBadge(tabId);
    // Fill in a page title for nicer filenames if we don't have one yet.
    if (!bucket.title) {
      chrome.tabs.get(tabId).then((t) => {
        if (t && (t.title || t.url)) {
          bucket.title = t.title || bucket.title;
          bucket.pageUrl = t.url || bucket.pageUrl;
          persist();
        }
      }).catch(() => {});
    }
  });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const ct = headerValue(details.responseHeaders, 'content-type');
    const cl = headerValue(details.responseHeaders, 'content-length');
    const hit = classify(details.url, ct, cl);
    if (!hit) return;
    recordMedia(details.tabId, {
      url: details.url,
      kind: hit.kind,
      mime: hit.mime || ct.split(';')[0] || '',
      size: parseInt(cl, 10) || 0,
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame', 'main_frame'] },
  ['responseHeaders']
);

// Fallback: catch .m3u8 requests even when we never see response headers
// (e.g. served from cache). Direct files always surface via headers above.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (/\.m3u8(\?|#|$)/i.test(details.url)) {
      recordMedia(details.tabId, { url: details.url, kind: 'hls', mime: '', size: 0 });
    }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame'] }
);

/* ------------------------------------------------------------------ *
 * Tab lifecycle / badge
 * ------------------------------------------------------------------ */

function updateBadge(tabId) {
  const bucket = state.media[tabId];
  const count = bucket ? Object.keys(bucket.items).length : 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear a tab's media when it navigates to a new page.
  if (changeInfo.status === 'loading' && changeInfo.url) {
    ready.then(() => {
      if (state.media[tabId]) {
        delete state.media[tabId];
        persist();
        updateBadge(tabId);
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    if (state.media[tabId]) {
      delete state.media[tabId];
      persist();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Offscreen document
 * ------------------------------------------------------------------ */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let creatingOffscreen = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Fetch, decrypt and assemble HLS media segments into a downloadable file.',
    })
    .catch((err) => {
      // A racing call may have created it already; ignore that specific case.
      if (!/single offscreen/i.test(String(err && err.message))) throw err;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  return creatingOffscreen;
}

function sendToOffscreen(msg) {
  chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg)).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Jobs / downloads
 * ------------------------------------------------------------------ */

function newJobId() {
  return 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function setJob(jobId, patch) {
  const job = state.jobs[jobId];
  if (!job) return;
  Object.assign(job, patch);
  persist();
}

function ensureExtension(name, fallbackExt, url) {
  let ext = fallbackExt;
  if (url) {
    const m = DIRECT_EXT.exec(url);
    if (m) ext = m[1].toLowerCase();
  }
  const clean = (name || 'video').replace(/\.+$/, '');
  return new RegExp('\\.' + ext + '$', 'i').test(clean) ? clean : `${clean}.${ext}`;
}

async function startDownload(job) {
  await ready;
  const jobId = newJobId();
  state.jobs[jobId] = {
    jobId,
    kind: job.kind,
    title: job.title || job.filename || 'video',
    status: 'starting',
    phase: 'init',
    progress: 0,
    received: 0,
    total: 0,
    createdAt: Date.now(),
  };
  persistNow();

  if (job.kind === 'direct') {
    const filename = ensureExtension(job.filename, 'mp4', job.url);
    setJob(jobId, { status: 'downloading', phase: 'saving', filename });
    chrome.downloads.download(
      { url: job.url, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          setJob(jobId, { status: 'error', message: (chrome.runtime.lastError || {}).message || 'download failed' });
        } else {
          setJob(jobId, { downloadId });
        }
      }
    );
    return jobId;
  }

  // HLS: hand off to the offscreen document.
  setJob(jobId, { status: 'downloading', phase: 'fetching', filename: job.filename || 'video' });
  await ensureOffscreen();
  sendToOffscreen({ cmd: 'download', job: Object.assign({}, job, { jobId }) });
  return jobId;
}

function findJobByDownloadId(downloadId) {
  return Object.values(state.jobs).find((j) => j.downloadId === downloadId);
}

// React to chrome.downloads completion for both direct files and the final
// save of an assembled HLS blob.
chrome.downloads.onChanged.addListener((delta) => {
  ready.then(() => {
    const job = findJobByDownloadId(delta.id);
    if (!job) return;
    if (delta.state && delta.state.current === 'complete') {
      setJob(job.jobId, { status: 'saved', phase: 'done', progress: 1 });
      if (job.objectUrl) sendToOffscreen({ cmd: 'revoke', url: job.objectUrl });
    } else if (delta.state && delta.state.current === 'interrupted') {
      setJob(job.jobId, { status: 'error', message: (delta.error && delta.error.current) || 'interrupted' });
      if (job.objectUrl) sendToOffscreen({ cmd: 'revoke', url: job.objectUrl });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || msg.target === 'popup') return; // not for us

  // --- from content script ---
  if (msg.cmd === 'pageInfo') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && tabId >= 0) {
      ready.then(() => {
        const bucket = state.media[tabId] || (state.media[tabId] = { title: '', pageUrl: '', items: {} });
        bucket.title = msg.title || bucket.title;
        bucket.pageUrl = msg.url || bucket.pageUrl;
        persist();
      });
    }
    return false;
  }
  if (msg.cmd === 'pageMedia') {
    const tabId = sender.tab && sender.tab.id;
    (msg.items || []).forEach((it) => recordMedia(tabId, it));
    return false;
  }

  // --- from offscreen document ---
  if (msg.cmd === 'progress') {
    setJob(msg.jobId, {
      status: 'downloading',
      phase: msg.phase || 'fetching',
      progress: msg.progress || 0,
      received: msg.received || 0,
      total: msg.total || 0,
    });
    return false;
  }
  if (msg.cmd === 'ready') {
    const job = state.jobs[msg.jobId];
    if (!job) return false;
    const filename = msg.filename || ensureExtension(job.filename, msg.ext || 'mp4');
    setJob(msg.jobId, { status: 'saving', phase: 'saving', objectUrl: msg.objectUrl, size: msg.size || job.total });
    chrome.downloads.download(
      { url: msg.objectUrl, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          setJob(msg.jobId, { status: 'error', message: (chrome.runtime.lastError || {}).message || 'save failed' });
          sendToOffscreen({ cmd: 'revoke', url: msg.objectUrl });
        } else {
          setJob(msg.jobId, { downloadId, filename });
        }
      }
    );
    return false;
  }
  if (msg.cmd === 'error') {
    setJob(msg.jobId, { status: 'error', message: msg.message || 'download failed' });
    return false;
  }

  // --- from popup ---
  if (msg.cmd === 'startDownload') {
    startDownload(msg.job).then((jobId) => sendResponse({ ok: true, jobId }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
  if (msg.cmd === 'cancelJob') {
    ready.then(() => {
      const job = state.jobs[msg.jobId];
      if (!job) return sendResponse({ ok: false });
      if (job.kind === 'hls') sendToOffscreen({ cmd: 'cancel', jobId: msg.jobId });
      if (job.downloadId != null) chrome.downloads.cancel(job.downloadId).catch(() => {});
      setJob(msg.jobId, { status: 'canceled', phase: 'canceled' });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.cmd === 'clearJob') {
    ready.then(() => {
      delete state.jobs[msg.jobId];
      persistNow();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.cmd === 'clearFinishedJobs') {
    ready.then(() => {
      for (const [id, j] of Object.entries(state.jobs)) {
        if (['saved', 'error', 'canceled'].includes(j.status)) delete state.jobs[id];
      }
      persistNow();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.cmd === 'clearMedia') {
    ready.then(() => {
      if (state.media[msg.tabId]) {
        delete state.media[msg.tabId];
        persistNow();
        updateBadge(msg.tabId);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
