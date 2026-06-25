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
const ready = SESSION.get(['media', 'jobs', 'crawl'])
  .then((s) => {
    state.media = s.media || {};
    state.jobs = s.jobs || {};
    // A crawl left "scanning" means the previous worker died mid-scan; mark it
    // stopped so the popup isn't stuck and a new scan can be started.
    if (s.crawl && s.crawl.status === 'scanning') {
      SESSION.set({ crawl: Object.assign({}, s.crawl, { status: 'canceled' }) }).catch(() => {});
    }
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
const VIMEO_MANIFEST = /\/(master|playlist)\.json(\?|#|$)/i;

function isVimeoHost(url) {
  try {
    return /(^|\.)vimeocdn\.com$/i.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

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

  // Vimeo adaptive delivery: surface only the JSON manifest, never the many
  // byte-range segments (which would otherwise appear as dozens of "files").
  if (isVimeoHost(url)) {
    if (VIMEO_MANIFEST.test(url)) return { kind: 'vimeo' };
    if (/\.m3u8(\?|#|$)/i.test(url)) return { kind: 'hls' };
    return null;
  }

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
    if (isVimeoHost(details.url) && VIMEO_MANIFEST.test(details.url)) {
      recordMedia(details.tabId, { url: details.url, kind: 'vimeo', mime: '', size: 0 });
    } else if (/\.m3u8(\?|#|$)/i.test(details.url)) {
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
  return Object.values(state.jobs).find(
    (j) => j.downloadId === downloadId || (j.downloads || []).some((d) => d.downloadId === downloadId)
  );
}

// React to chrome.downloads completion for direct files and for each assembled
// blob a job saves (an HLS/Vimeo job may emit more than one file).
chrome.downloads.onChanged.addListener((delta) => {
  ready.then(() => {
    const job = findJobByDownloadId(delta.id);
    if (!job) return;
    const dl = (job.downloads || []).find((d) => d.downloadId === delta.id);
    const cur = delta.state && delta.state.current;
    if (cur === 'complete') {
      if (dl) { dl.done = true; sendToOffscreen({ cmd: 'revoke', url: dl.objectUrl }); }
      else if (job.objectUrl) sendToOffscreen({ cmd: 'revoke', url: job.objectUrl });
      const multi = job.downloads && job.downloads.length;
      const allDone = multi
        ? job.downloads.length >= (job.expectedOutputs || 1) && job.downloads.every((d) => d.done)
        : true;
      if (allDone) { setJob(job.jobId, { status: 'saved', phase: 'done', progress: 1 }); pumpDownloads(); }
      else persist();
    } else if (cur === 'interrupted') {
      setJob(job.jobId, { status: 'error', message: (delta.error && delta.error.current) || 'interrupted' });
      sendToOffscreen({ cmd: 'revoke', url: dl ? dl.objectUrl : job.objectUrl });
      pumpDownloads();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Download queue (used by "Download all" from a site scan)
 * ------------------------------------------------------------------ */

const MAX_CONCURRENT_DOWNLOADS = 3;
const downloadQueue = [];
let startingDownloads = 0;

function activeDownloadCount() {
  return Object.values(state.jobs).filter((j) => ['starting', 'downloading', 'saving'].includes(j.status)).length;
}
function pumpDownloads() {
  while (downloadQueue.length && activeDownloadCount() + startingDownloads < MAX_CONCURRENT_DOWNLOADS) {
    const job = downloadQueue.shift();
    startingDownloads++;
    startDownload(job).catch(() => {}).finally(() => { startingDownloads--; pumpDownloads(); });
  }
}

/* ------------------------------------------------------------------ *
 * Site crawl: open linked pages in a hidden tab and harvest videos
 * ------------------------------------------------------------------ */

let crawl = null; // { status, total, scanned, found, results:[], canceled }
function saveCrawl() {
  return chrome.storage.session.set({ crawl }).catch(() => {});
}

const SKIP_LINK_EXT = /\.(jpg|jpeg|png|gif|webp|svg|css|js|mjs|json|pdf|zip|rar|ico|woff2?|ttf|eot|mp3|xml|rss)(\?|#|$)/i;
function stripHashUrl(u) {
  try { const x = new URL(u); x.hash = ''; return x.href; } catch (e) { return u; }
}
function filterPages(links, activeUrl) {
  let origin = null;
  try { origin = new URL(activeUrl).origin; } catch (e) { /* ignore */ }
  const current = stripHashUrl(activeUrl);
  const seen = new Set();
  const out = [];
  for (const ln of links || []) {
    let u;
    try { u = new URL(ln.url); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (origin && u.origin !== origin) continue;
    if (SKIP_LINK_EXT.test(u.pathname)) continue;
    u.hash = '';
    const key = u.href;
    if (key === current || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, text: (ln.text || '').trim().slice(0, 120) });
    if (out.length >= 80) break;
  }
  return out;
}

function delayMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Crawl tuning.
const MAX_PAGES = 120;     // max pages whose HTML we fetch
const MAX_DEPTH = 6;       // BFS depth from the start page
const HTML_CONCURRENCY = 6;
const NAV_WAIT_MS = 14000;
const VIDEO_WAIT_MS = 9000;

/* ---- HTML parsing (regex; service workers have no DOMParser) ---- */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, ' ');
}
function extractTitle(html) {
  const m = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html) ||
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}
function extractLinks(html, base) {
  const out = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*["']([^"'#\s]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.add(new URL(m[1], base).href); } catch (e) { /* ignore */ }
    if (out.size > 500) break;
  }
  return [...out];
}
function extractVimeo(html) {
  const m = /player\.vimeo\.com\/video\/(\d+)(?:\/([0-9a-f]{6,}))?/i.exec(html) ||
    /vimeo\.com\/(\d+)(?:\/([0-9a-f]{6,}))?/i.exec(html);
  if (!m) return null;
  let hash = m[2] || null;
  if (!hash) { const h = /[?&]h=([0-9a-f]{6,})/i.exec(html); if (h) hash = h[1]; }
  return { id: m[1], hash };
}
function matchUrl(html, base, re) {
  const m = re.exec(html);
  if (!m) return null;
  try { return new URL(m[0].replace(/\\\//g, '/'), base).href; } catch (e) { return null; }
}
function videoSignal(html, base) {
  const manifest =
    matchUrl(html, base, /https?:\\?\/\\?\/[^\s"'<>]+?\.m3u8(\?[^\s"'<>]*)?/i) ||
    matchUrl(html, base, /https?:[^\s"'<>]+?\/(?:master|playlist)\.json[^\s"'<>]*/i);
  const vimeo = extractVimeo(html);
  const media = matchUrl(html, base, /https?:\\?\/\\?\/[^\s"'<>]+?\.(mp4|webm|m4v)(\?[^\s"'<>]*)?/i);
  return { has: !!(manifest || vimeo || media || /<video[\s>]/i.test(html)), manifest, vimeo, media };
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (ct && !/text\/html|application\/xhtml|application\/xml/i.test(ct)) return '';
    return (await res.text()).slice(0, 1500000);
  } catch (e) {
    return '';
  }
}

// Resolve a Vimeo video id (+ optional unlisted hash) to a downloadable URL via
// the player config endpoint — no tab needed when this succeeds.
async function resolveVimeoConfig(id, hash) {
  try {
    const url = `https://player.vimeo.com/video/${id}/config` + (hash ? `?h=${hash}` : '');
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const f = ((await res.json()).request || {}).files || {};
    if (f.dash && f.dash.cdns) { const c = f.dash.cdns[f.dash.default_cdn]; if (c && c.url) return { kind: 'vimeo', url: c.url }; }
    if (f.hls && f.hls.cdns) { const c = f.hls.cdns[f.hls.default_cdn]; if (c && c.url) return { kind: 'hls', url: c.url }; }
    if (Array.isArray(f.progressive) && f.progressive.length) {
      const b = f.progressive.slice().sort((x, y) => (y.width || 0) - (x.width || 0))[0];
      if (b && b.url) return { kind: 'direct', url: b.url };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function navigateTab(tabId, url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve(ok);
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.update(tabId, { url }).catch(() => finish(false));
  });
}

async function waitForVideo(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (crawl && crawl.canceled) return null;
    const bucket = state.media[tabId];
    if (bucket) {
      const items = Object.values(bucket.items);
      const pick = items.find((i) => i.kind === 'vimeo') || items.find((i) => i.kind === 'hls') || items.find((i) => i.kind === 'direct');
      if (pick) return pick;
    }
    await delayMs(250);
  }
  return null;
}

function pickFromBucket(bucket) {
  if (!bucket) return null;
  const items = Object.values(bucket.items);
  return items.find((i) => i.kind === 'vimeo') || items.find((i) => i.kind === 'hls') || items.find((i) => i.kind === 'direct') || null;
}

// Turn a discovered video page into a downloadable {kind,url,title,pageUrl}.
// Tries cheap resolution first; only loads the page in an (active) tab when it
// must — the player needs a visible tab to fetch its manifest.
async function resolveVideoPage(vp, getScanTab) {
  if (vp.resolved) return vp.resolved;
  const sig = vp.sig || {};
  if (sig.manifest) {
    const kind = /\.m3u8(\?|$)/i.test(sig.manifest) ? 'hls' : 'vimeo';
    return { kind, url: sig.manifest, title: vp.title, pageUrl: vp.url };
  }
  if (sig.vimeo) {
    const r = await resolveVimeoConfig(sig.vimeo.id, sig.vimeo.hash);
    if (r) return { kind: r.kind, url: r.url, title: vp.title, pageUrl: vp.url };
  }
  if (sig.media) return { kind: 'direct', url: sig.media, title: vp.title, pageUrl: vp.url };

  const tabId = await getScanTab();
  if (tabId == null) return null;
  await navigateTab(tabId, vp.url, NAV_WAIT_MS);
  const item = await waitForVideo(tabId, VIDEO_WAIT_MS);
  if (!item) return null;
  let title = vp.title;
  try { const t = await chrome.tabs.get(tabId); if (t && t.title) title = t.title; } catch (e) { /* ignore */ }
  return { kind: item.kind, url: item.url, title, pageUrl: vp.url };
}

async function runCrawl(activeTab) {
  let seedLinks = null;
  try {
    const resp = await chrome.tabs.sendMessage(activeTab.id, { cmd: 'getLinks' });
    seedLinks = resp && resp.links;
  } catch (e) { /* content script unavailable on this page */ }

  const seedUrl = stripHashUrl(activeTab.url || '');
  let origin = '';
  try { origin = new URL(seedUrl).origin; } catch (e) { /* ignore */ }

  crawl = { status: 'scanning', phase: 'Finding videos', total: 0, scanned: 0, found: 0, results: [], canceled: false };
  await saveCrawl();

  const visited = new Set([seedUrl]);
  const videoSeen = new Set();
  const videoPages = [];

  // The start page is already loaded/active — use anything detected on it.
  const seedItem = pickFromBucket(state.media[activeTab.id]);
  if (seedItem) {
    videoSeen.add(seedUrl);
    videoPages.push({ url: seedUrl, title: activeTab.title || seedUrl, resolved: { kind: seedItem.kind, url: seedItem.url, title: activeTab.title || seedUrl, pageUrl: seedUrl } });
  }

  // BFS, seeded from the start page's (rendered) links; a page only expands its
  // own links if it contains a video.
  let queue = filterPages(seedLinks, seedUrl).map((c) => ({ url: c.url, depth: 1, hint: c.text }));

  while (queue.length && visited.size < MAX_PAGES && !crawl.canceled) {
    const batch = [];
    while (queue.length && batch.length < HTML_CONCURRENCY && visited.size < MAX_PAGES) {
      const n = queue.shift();
      const k = stripHashUrl(n.url);
      if (visited.has(k)) continue;
      visited.add(k);
      batch.push(Object.assign(n, { url: k }));
    }
    crawl.total = visited.size;
    await saveCrawl();

    await Promise.all(batch.map(async (n) => {
      if (crawl.canceled) return;
      const html = await fetchHtml(n.url);
      crawl.scanned++;
      if (!html) return;
      const sig = videoSignal(html, n.url);
      if (!sig.has || videoSeen.has(n.url)) return;
      videoSeen.add(n.url);
      videoPages.push({ url: n.url, title: extractTitle(html) || n.hint || n.url, sig });
      crawl.found = videoPages.length;
      if (n.depth < MAX_DEPTH) {
        for (const link of extractLinks(html, n.url)) {
          const k = stripHashUrl(link);
          if (visited.has(k) || SKIP_LINK_EXT.test(k)) continue;
          try { if (new URL(k).origin !== origin) continue; } catch (e) { continue; }
          queue.push({ url: k, depth: n.depth + 1 });
        }
      }
    }));
    await saveCrawl();
  }

  // Resolution: cheap paths first; lazily open ONE active tab for the rest.
  crawl.phase = 'Resolving videos';
  crawl.total = videoPages.length;
  crawl.scanned = 0;
  await saveCrawl();

  let scanTabId = null;
  const getScanTab = async () => {
    if (scanTabId != null) return scanTabId;
    try {
      const t = await chrome.tabs.create({ url: 'about:blank', active: true, windowId: activeTab.windowId });
      scanTabId = t.id;
    } catch (e) { scanTabId = null; }
    return scanTabId;
  };

  for (const vp of videoPages) {
    if (crawl.canceled) break;
    let result = null;
    try { result = await resolveVideoPage(vp, getScanTab); } catch (e) { /* skip */ }
    if (result) crawl.results.push(result);
    crawl.scanned++;
    crawl.found = crawl.results.length;
    await saveCrawl();
  }

  if (scanTabId != null) {
    try { await chrome.tabs.update(activeTab.id, { active: true }); } catch (e) { /* ignore */ }
    try { await chrome.tabs.remove(scanTabId); } catch (e) { /* ignore */ }
  }
  crawl.status = crawl.canceled ? 'canceled' : 'done';
  crawl.phase = '';
  await saveCrawl();
}

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
    // offscreen provides one or more outputs (a Vimeo job that can't be muxed
    // falls back to separate video + audio files).
    const outputs = msg.outputs || [{ objectUrl: msg.objectUrl, filename: msg.filename, size: msg.size }];
    job.downloads = [];
    job.expectedOutputs = outputs.length;
    let totalSize = 0;
    outputs.forEach((o) => { totalSize += o.size || 0; });
    setJob(msg.jobId, { status: 'saving', phase: 'saving', size: totalSize || job.total, note: msg.note || '' });
    outputs.forEach((o) => {
      const filename = o.filename || ensureExtension(job.filename, 'mp4');
      chrome.downloads.download(
        { url: o.objectUrl, filename, conflictAction: 'uniquify', saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId == null) {
            setJob(msg.jobId, { status: 'error', message: (chrome.runtime.lastError || {}).message || 'save failed' });
            sendToOffscreen({ cmd: 'revoke', url: o.objectUrl });
          } else {
            job.downloads.push({ downloadId, objectUrl: o.objectUrl, done: false });
            persist();
          }
        }
      );
    });
    return false;
  }
  if (msg.cmd === 'error') {
    setJob(msg.jobId, { status: 'error', message: msg.message || 'download failed' });
    pumpDownloads();
    return false;
  }

  // --- from popup ---
  if (msg.cmd === 'startDownload') {
    startDownload(msg.job).then((jobId) => sendResponse({ ok: true, jobId }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
  if (msg.cmd === 'startCrawl') {
    ready.then(async () => {
      if (crawl && crawl.status === 'scanning') return sendResponse({ ok: false, error: 'already scanning' });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return sendResponse({ ok: false, error: 'no active tab' });
      runCrawl(tab); // runs in the background; progress is written to storage.session
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.cmd === 'cancelCrawl') {
    if (crawl) crawl.canceled = true;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === 'clearCrawl') {
    crawl = null;
    chrome.storage.session.remove('crawl').catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === 'downloadCrawl') {
    ready.then(() => {
      const jobs = msg.jobs || [];
      downloadQueue.push.apply(downloadQueue, jobs);
      pumpDownloads();
      sendResponse({ ok: true, queued: jobs.length });
    });
    return true;
  }
  if (msg.cmd === 'cancelJob') {
    ready.then(() => {
      const job = state.jobs[msg.jobId];
      if (!job) return sendResponse({ ok: false });
      if (job.kind === 'hls' || job.kind === 'vimeo') sendToOffscreen({ cmd: 'cancel', jobId: msg.jobId });
      if (job.downloadId != null) chrome.downloads.cancel(job.downloadId).catch(() => {});
      (job.downloads || []).forEach((d) => chrome.downloads.cancel(d.downloadId).catch(() => {}));
      setJob(msg.jobId, { status: 'canceled', phase: 'canceled' });
      pumpDownloads();
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
