/*
 * Popup UI controller.
 *
 * Reads detected media + active jobs from chrome.storage.session (written by
 * the service worker) and renders them. HLS manifests are fetched and parsed
 * on demand to offer quality choices. Downloads are dispatched to the worker.
 */
'use strict';

const U = self.VDUtil;
const manifestCache = new Map(); // url -> parsed manifest
const expandedUrls = new Set(); // media URLs whose quality dropdown is open
let lastMediaSig = ''; // signature of the rendered media list (skip needless rebuilds)
let activeTabId = null;
let currentTitle = '';
let currentPageUrl = '';
let pollTimer = null;

/* ---------- tiny DOM helpers ---------- */
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
const $ = (sel) => document.querySelector(sel);

function setStatus(text) {
  $('#status-text').textContent = text || '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function baseName(item) {
  // Prefer the page title; fall back to the page URL rather than the (hashy)
  // manifest/segment URL so filenames never become a random hash.
  return U.deriveBaseName(currentTitle, currentPageUrl || item.url);
}

/* ---------- state ---------- */
async function loadState() {
  const { media = {}, jobs = {}, crawl = null } = await chrome.storage.session.get(['media', 'jobs', 'crawl']);
  return { media, jobs, crawl };
}

async function startJob(job) {
  setStatus('Starting download…');
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'startDownload', job });
    if (res && res.ok) {
      switchTab('downloads');
      setStatus('');
    } else {
      setStatus('Error: ' + ((res && res.error) || 'could not start'));
    }
  } catch (e) {
    setStatus('Error: ' + e.message);
  }
}

/* ---------- HLS manifest fetching ---------- */
async function fetchManifest(url) {
  if (manifestCache.has(url)) return manifestCache.get(url);
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const parsed = M3U8.parse(await res.text(), url);
  manifestCache.set(url, parsed);
  return parsed;
}

function optRow(name, meta, onClick, ghost) {
  return el('div', { class: 'opt-row' }, [
    el('div', { class: 'opt-label' }, [
      el('div', { class: 'opt-name', text: name }),
      meta ? el('div', { class: 'opt-meta', text: meta }) : null,
    ]),
    el('button', { class: 'btn' + (ghost ? ' ghost' : ''), text: 'Download', onclick: onClick }),
  ]);
}

function noticeNode(text, isErr) {
  return el('div', { class: 'notice' + (isErr ? ' err' : ''), text });
}
function sectionTitle(text) {
  return el('div', { class: 'opt-section-title', text });
}

async function buildVimeoOptions(item, optionsEl) {
  optionsEl.replaceChildren(el('div', { class: 'opt-loading', text: 'Loading stream info…' }));
  let man = manifestCache.get(item.url);
  try {
    if (!man) {
      const res = await fetch(item.url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      man = VimeoManifest.parse(await res.text(), item.url);
      manifestCache.set(item.url, man);
    }
  } catch (e) {
    optionsEl.replaceChildren(
      noticeNode('Could not read this Vimeo stream (' + e.message + ').', true),
      optRow('Best quality', '', () => startJob({ kind: 'vimeo', url: item.url, filename: baseName(item), title: currentTitle }))
    );
    return;
  }

  const nodes = [];
  nodes.push(noticeNode(man.audio.length ? 'Audio is merged into the MP4 automatically.' : 'No separate audio track was found.'));
  const dur = man.video[0] && man.video[0].duration ? U.formatDuration(man.video[0].duration) : '';
  nodes.push(sectionTitle('Video quality' + (dur ? ' · ' + dur : '')));
  if (!man.video.length) nodes.push(noticeNode('No video renditions found.', true));
  man.video.forEach((v) => {
    const label = v.height ? v.height + 'p' : `${v.width}×${v.height}`;
    const meta = [`${v.width}×${v.height}`, U.humanBitrate(v.bitrate), (v.codecs || '').split('.')[0]].filter(Boolean).join(' · ');
    nodes.push(
      optRow(label, meta, () =>
        startJob({ kind: 'vimeo', url: item.url, videoId: v.id, filename: `${baseName(item)} ${label}`, title: currentTitle })
      )
    );
  });
  optionsEl.replaceChildren(...nodes);
}

async function buildOptions(item, optionsEl) {
  if (item.kind === 'vimeo') return buildVimeoOptions(item, optionsEl);
  optionsEl.replaceChildren(el('div', { class: 'opt-loading', text: 'Loading stream info…' }));
  let parsed;
  try {
    parsed = await fetchManifest(item.url);
  } catch (e) {
    optionsEl.replaceChildren(
      noticeNode('Could not read this playlist (' + e.message + '). You can still try downloading it.', true),
      optRow('Stream', '', () => startJob({ kind: 'hls', url: item.url, filename: baseName(item), title: currentTitle, mux: true }))
    );
    return;
  }

  const nodes = [];
  if (parsed.type === 'master') {
    const audios = parsed.media.filter((m) => m.mediaType === 'AUDIO' && m.uri);
    nodes.push(sectionTitle('Video quality'));
    if (!parsed.variants.length) nodes.push(noticeNode('No variants listed in this master playlist.', true));
    parsed.variants.forEach((v) => {
      const label = U.variantLabel(v);
      const separate = v.audioGroup && audios.some((a) => a.groupId === v.audioGroup);
      const metaParts = [];
      if (v.resolution) metaParts.push(`${v.resolution.width}×${v.resolution.height}`);
      if (v.codecs) metaParts.push(v.codecs.split(',')[0]);
      if (separate) metaParts.push('video only');
      nodes.push(
        optRow(label, metaParts.join(' · '), () =>
          startJob({ kind: 'hls', url: v.uri, filename: `${baseName(item)} ${label}`, title: currentTitle, mux: true })
        )
      );
    });
    if (audios.length) {
      nodes.push(sectionTitle('Audio tracks (separate)'));
      nodes.push(noticeNode('Audio is delivered separately here. The video qualities above download without sound — grab an audio track too and merge them (e.g. with ffmpeg).'));
      audios.forEach((a) => {
        const name = a.name || a.language || 'Audio';
        const meta = [a.language, a.channels ? a.channels + ' ch' : '', a.isDefault ? 'default' : ''].filter(Boolean).join(' · ');
        nodes.push(
          optRow(name, meta, () =>
            startJob({ kind: 'hls', url: a.uri, filename: `${baseName(item)} ${name}`, title: currentTitle, mux: true })
          )
        );
      });
    }
  } else {
    const meta = [];
    if (parsed.totalDuration) meta.push(U.formatDuration(parsed.totalDuration));
    meta.push(parsed.segments.length + ' segments');
    if (parsed.fmp4) meta.push('fMP4');
    if (parsed.encryption !== 'NONE') meta.push(parsed.encryption);
    if (parsed.isLive) meta.push('LIVE');

    const supported =
      parsed.encryption === 'NONE' ||
      (parsed.encryption === 'AES-128' && (!parsed.keyFormat || parsed.keyFormat === 'identity'));

    if (!supported) nodes.push(noticeNode('This stream is DRM-protected (' + parsed.encryption + ') and cannot be downloaded.', true));
    if (parsed.isLive) nodes.push(noticeNode('Live stream — only the currently available segments will be captured.'));

    const row = optRow(parsed.fmp4 ? 'Download (MP4)' : 'Download (MP4)', meta.join(' · '), () =>
      startJob({ kind: 'hls', url: item.url, filename: baseName(item), title: currentTitle, mux: true })
    );
    if (!supported) row.querySelector('button').disabled = true;
    nodes.push(row);
  }
  optionsEl.replaceChildren(...nodes);
}

/* ---------- media rendering ---------- */
function mediaCard(item) {
  const isHls = item.kind === 'hls';
  const isVimeo = item.kind === 'vimeo';
  const isStream = isHls || isVimeo;
  const title = (() => {
    if (isVimeo) return currentTitle || 'Vimeo video';
    try {
      const u = new URL(item.url);
      const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      return decodeURIComponent(last);
    } catch (e) {
      return item.url;
    }
  })();

  const subParts = [hostOf(item.url)];
  if (item.size) subParts.push(U.humanSize(item.size));
  if (item.mime) subParts.push(item.mime);
  if (item.fromPage) subParts.push('in page');

  const startOpen = isStream && expandedUrls.has(item.url);
  const optionsEl = el('div', { class: 'options' });
  optionsEl.style.display = startOpen ? 'block' : 'none';
  let built = false;

  const caret = el('span', { class: 'caret' + (startOpen ? ' open' : ''), text: '▾' });
  const expandBtn = isStream
    ? el('button', { class: 'icon-btn', title: 'Choose quality' }, [caret])
    : null;
  if (startOpen) {
    built = true;
    buildOptions(item, optionsEl);
  }

  const quickBtn = el('button', {
    class: 'btn',
    text: 'Download',
    onclick: () => {
      if (isVimeo) {
        startJob({ kind: 'vimeo', url: item.url, filename: baseName(item), title: currentTitle });
      } else if (isHls) {
        startJob({ kind: 'hls', url: item.url, filename: baseName(item), title: currentTitle, mux: true });
      } else {
        startJob({ kind: 'direct', url: item.url, filename: baseName(item), title: currentTitle });
      }
    },
  });

  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const open = optionsEl.style.display === 'none';
      optionsEl.style.display = open ? 'block' : 'none';
      caret.classList.toggle('open', open);
      if (open) expandedUrls.add(item.url);
      else expandedUrls.delete(item.url);
      if (open && !built) {
        built = true;
        buildOptions(item, optionsEl);
      }
    });
  }

  const head = el('div', { class: 'card-head' }, [
    el('span', { class: 'badge ' + (isStream ? 'hls' : 'direct'), text: isVimeo ? 'VIMEO' : isHls ? 'HLS' : 'FILE' }),
    el('div', { class: 'card-main' }, [
      el('div', { class: 'card-title', title: item.url, text: title }),
      el('div', { class: 'card-sub', text: subParts.filter(Boolean).join(' · ') }),
    ]),
    quickBtn,
    expandBtn,
  ]);

  return el('div', { class: 'card' }, [head, optionsEl]);
}

function renderMedia(bucket) {
  const list = $('#media-list');
  const items = bucket ? Object.values(bucket.items) : [];
  // Streams (HLS/Vimeo) first, then direct files; newest first within a group.
  const rank = (k) => (k === 'direct' ? 1 : 0);
  items.sort((a, b) => (rank(a.kind) === rank(b.kind) ? b.ts - a.ts : rank(a.kind) - rank(b.kind)));

  // Cheap, state-preserving updates run every poll.
  $('#media-count').textContent = String(items.length);
  $('#media-empty').classList.toggle('show', items.length === 0);
  const host = bucket && bucket.pageUrl ? hostOf(bucket.pageUrl) : '';
  if (host) $('#page-host').textContent = host;

  // Only rebuild the cards (which would collapse any open dropdown) when the
  // set of detected media actually changes.
  const sig = items.map((i) => i.kind + ':' + i.url).join('|');
  if (sig === lastMediaSig) return;
  lastMediaSig = sig;
  list.replaceChildren(...items.map(mediaCard));
}

/* ---------- jobs rendering ---------- */
function jobStatusText(job) {
  const pct = Math.round((job.progress || 0) * 100);
  switch (job.status) {
    case 'starting': return ['Starting…', ''];
    case 'downloading':
      if (job.phase === 'assembling') return ['Processing…', ''];
      if (job.kind === 'direct') return ['Downloading…', ''];
      return [`Downloading ${pct}%` + (job.received ? ' · ' + U.humanSize(job.received) : ''), ''];
    case 'saving': return ['Saving…', ''];
    case 'saved': return ['Saved' + (job.size ? ' · ' + U.humanSize(job.size) : '') + (job.note ? ' · ' + job.note : ''), 'ok'];
    case 'error': return ['Failed: ' + (job.message || 'unknown error'), 'err'];
    case 'canceled': return ['Canceled', ''];
    default: return [job.status || '', ''];
  }
}

function jobCard(job) {
  const active = ['starting', 'downloading', 'saving'].includes(job.status);
  const indeterminate =
    active && (job.phase === 'assembling' || job.status === 'saving' || (job.kind === 'direct' && job.status === 'downloading') || !job.progress);

  const bar = el('div', { class: 'bar' });
  bar.style.width = job.status === 'saved' ? '100%' : Math.round((job.progress || 0) * 100) + '%';
  const progress = el('div', { class: 'progress' + (indeterminate ? ' indeterminate' : '') }, [bar]);
  if (job.status === 'saved') progress.querySelector('.bar').style.background = 'var(--green)';
  if (job.status === 'error') { progress.classList.remove('indeterminate'); bar.style.background = 'var(--red)'; bar.style.width = '100%'; }

  const [statusText, statusCls] = jobStatusText(job);

  const actionBtn = active
    ? el('button', { class: 'icon-btn', title: 'Cancel', text: '✕', onclick: () => chrome.runtime.sendMessage({ cmd: 'cancelJob', jobId: job.jobId }) })
    : el('button', { class: 'icon-btn', title: 'Remove', text: '🗑', onclick: () => chrome.runtime.sendMessage({ cmd: 'clearJob', jobId: job.jobId }) });

  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('span', { class: 'badge ' + (job.kind === 'direct' ? 'direct' : 'hls'), text: job.kind === 'vimeo' ? 'VIMEO' : job.kind === 'hls' ? 'HLS' : 'FILE' }),
      el('div', { class: 'card-main' }, [
        el('div', { class: 'card-title', text: job.filename || job.title || 'video' }),
      ]),
    ]),
    progress,
    el('div', { class: 'job-foot' }, [
      el('span', { class: 'job-status ' + statusCls, text: statusText }),
      actionBtn,
    ]),
  ]);
}

function renderJobs(jobs) {
  const arr = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
  $('#jobs-list').replaceChildren(...arr.map(jobCard));
  $('#jobs-count').textContent = String(arr.length);
  $('#jobs-empty').classList.toggle('show', arr.length === 0);
}

/* ---------- site scan ---------- */
function resultToJob(r) {
  // Name by the page title; fall back to the page URL (never the hashy manifest URL).
  const base = U.deriveBaseName(r.title, r.pageUrl || r.url);
  if (r.kind === 'vimeo') return { kind: 'vimeo', url: r.url, filename: base, title: r.title };
  if (r.kind === 'hls') return { kind: 'hls', url: r.url, filename: base, title: r.title, mux: true };
  return { kind: 'direct', url: r.url, filename: base, title: r.title };
}

function scanCard(r) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('span', { class: 'badge ' + (r.kind === 'direct' ? 'direct' : 'hls'), text: r.kind === 'vimeo' ? 'VIMEO' : r.kind === 'hls' ? 'HLS' : 'FILE' }),
      el('div', { class: 'card-main' }, [
        el('div', { class: 'card-title', title: r.pageUrl, text: r.title || r.url }),
        el('div', { class: 'card-sub', text: hostOf(r.pageUrl) }),
      ]),
    ]),
  ]);
}

function renderScan(crawl) {
  const c = crawl || { status: 'idle', results: [] };
  const results = c.results || [];
  const scanning = c.status === 'scanning';
  $('#site-count').textContent = String(results.length);
  $('#scan-start').hidden = scanning;
  $('#scan-cancel').hidden = !scanning;
  $('#scan-download').hidden = results.length === 0;
  $('#scan-download').textContent = results.length ? `Download all (${results.length})` : 'Download all';
  $('#scan-clear').hidden = scanning || !c.status || c.status === 'idle';

  let s = '';
  if (scanning) {
    if (c.phase === 'Resolving videos') s = `Resolving ${c.scanned}/${c.total}… ${results.length} ready`;
    else s = `Scanning ${c.scanned} page(s)… ${c.found || 0} video(s) found`;
  } else if (c.status === 'done') s = `Done — ${results.length} video(s) found`;
  else if (c.status === 'canceled') s = `Stopped — found ${results.length} so far`;
  else if (c.status === 'error') s = `Error: ${c.error || 'scan failed'}`;
  $('#scan-status').textContent = s;

  $('#scan-list').replaceChildren(...results.map(scanCard));
}

/* ---------- tabs ---------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#panel-media').classList.toggle('active', name === 'media');
  $('#panel-site').classList.toggle('active', name === 'site');
  $('#panel-downloads').classList.toggle('active', name === 'downloads');
}

/* ---------- refresh loop ---------- */
async function refresh() {
  const { media, jobs, crawl } = await loadState();
  renderMedia(media[activeTabId]);
  renderJobs(jobs);
  renderScan(crawl);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    currentTitle = tab.title || '';
    currentPageUrl = tab.url || '';
    $('#page-host').textContent = hostOf(tab.url || '') || '—';
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#clear-media').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ cmd: 'clearMedia', tabId: activeTabId });
    refresh();
  });
  $('#clear-finished').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ cmd: 'clearFinishedJobs' });
    refresh();
  });

  // Site scan controls.
  $('#scan-start').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ cmd: 'startCrawl' });
    if (res && !res.ok) setStatus('Scan: ' + (res.error || 'could not start'));
    refresh();
  });
  $('#scan-cancel').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'cancelCrawl' }));
  $('#scan-clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ cmd: 'clearCrawl' });
    refresh();
  });
  $('#scan-download').addEventListener('click', async () => {
    const { crawl } = await loadState();
    const jobs = ((crawl && crawl.results) || []).map(resultToJob);
    if (!jobs.length) return;
    await chrome.runtime.sendMessage({ cmd: 'downloadCrawl', jobs });
    switchTab('downloads');
  });

  // Live updates: storage events + a slow poll as a safety net.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.media || changes.jobs || changes.crawl)) refresh();
  });
  pollTimer = setInterval(refresh, 800);
  window.addEventListener('unload', () => clearInterval(pollTimer));

  // Pull a fresh page title from the active tab for filenames.
  if (activeTabId != null) {
    const { media = {} } = await loadState();
    const bucket = media[activeTabId];
    if (bucket && bucket.title) currentTitle = bucket.title;
  }

  refresh();
}

document.addEventListener('DOMContentLoaded', init);
