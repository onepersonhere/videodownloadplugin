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
let activeTabId = null;
let currentTitle = '';
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
  return U.deriveBaseName(currentTitle, item.url);
}

/* ---------- state ---------- */
async function loadState() {
  const { media = {}, jobs = {} } = await chrome.storage.session.get(['media', 'jobs']);
  return { media, jobs };
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

async function buildOptions(item, optionsEl) {
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
  const title = (() => {
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

  const optionsEl = el('div', { class: 'options' });
  optionsEl.style.display = 'none';
  let built = false;

  const caret = el('span', { class: 'caret', text: '▾' });
  const expandBtn = isHls
    ? el('button', { class: 'icon-btn', title: 'Choose quality' }, [caret])
    : null;

  const quickBtn = el('button', {
    class: 'btn',
    text: 'Download',
    onclick: () => {
      if (isHls) {
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
      if (open && !built) {
        built = true;
        buildOptions(item, optionsEl);
      }
    });
  }

  const head = el('div', { class: 'card-head' }, [
    el('span', { class: 'badge ' + (isHls ? 'hls' : 'direct'), text: isHls ? 'HLS' : 'FILE' }),
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
  // HLS first, then direct; newest first within each group.
  items.sort((a, b) => (a.kind === b.kind ? b.ts - a.ts : a.kind === 'hls' ? -1 : 1));

  list.replaceChildren(...items.map(mediaCard));
  $('#media-count').textContent = String(items.length);
  $('#media-empty').classList.toggle('show', items.length === 0);

  const host = bucket && bucket.pageUrl ? hostOf(bucket.pageUrl) : '';
  if (host) $('#page-host').textContent = host;
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
    case 'saved': return ['Saved' + (job.size ? ' · ' + U.humanSize(job.size) : ''), 'ok'];
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
      el('span', { class: 'badge ' + (job.kind === 'hls' ? 'hls' : 'direct'), text: job.kind === 'hls' ? 'HLS' : 'FILE' }),
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

/* ---------- tabs ---------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#panel-media').classList.toggle('active', name === 'media');
  $('#panel-downloads').classList.toggle('active', name === 'downloads');
}

/* ---------- refresh loop ---------- */
async function refresh() {
  const { media, jobs } = await loadState();
  renderMedia(media[activeTabId]);
  renderJobs(jobs);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    currentTitle = tab.title || '';
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

  // Live updates: storage events + a slow poll as a safety net.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.media || changes.jobs)) refresh();
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
