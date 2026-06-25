# HLS Video Downloader

A Manifest V3 Chrome extension that detects and downloads videos from web
pages — built around **HLS (`.m3u8`) streaming download**, the way
[Video DownloadHelper](https://chromewebstore.google.com/detail/video-downloadhelper/lmjnegcaeklhafolokijcfjliaokphfk)
does. It sniffs network traffic for streaming manifests, lets you pick a
quality, then fetches every segment, decrypts it if needed, and stitches it
into a single playable file.

> **Use responsibly.** Only download streams you own or have the right to
> download. Many sites' terms of service prohibit downloading, and DRM‑protected
> content is intentionally not supported.

---

## Features

- **Automatic HLS detection** — watches network requests for `.m3u8` manifests
  (and direct media files) on any tab and shows a badge count on the toolbar
  icon.
- **Quality selection** — parses master playlists and lets you choose a
  variant (e.g. *1080p · 4.2 Mbps*) or download the best one in a single click.
- **Real downloading, not just link‑grabbing** — downloads all segments with
  bounded concurrency + automatic retries, then assembles them.
- **AES‑128 decryption** — fetches the `EXT-X-KEY`, derives the IV (explicit or
  from the media sequence) and decrypts each segment with the Web Crypto API.
- **TS → MP4 transmuxing** — MPEG‑TS streams are converted to a browser‑playable
  `.mp4` using [mux.js](https://github.com/videojs/mux.js); fragmented‑MP4
  (fMP4) streams are assembled natively. Falls back to raw `.ts` if transmuxing
  fails.
- **Seekable output** — every MP4 is remuxed to a *progressive* file with a
  proper duration and sample index, so you can scrub the timeline and change
  playback speed (fragmented MP4 output can't be scrubbed in most players).
- **Byte‑range, discontinuity and fMP4 init‑segment support.**
- **Vimeo adaptive support** — recognises Vimeo's custom `master.json` /
  `playlist.json` manifest (the `vimeocdn.com` adaptive CDN), lets you pick a
  quality, downloads the separate video + audio tracks and **merges them into a
  single MP4** with a built‑in fMP4 muxer (no ffmpeg needed). Individual Vimeo
  segments are no longer shown as dozens of stray "files".
- **Direct file downloads** — `.mp4` / `.webm` / `.mkv` / `.m4a` … seen in
  traffic or referenced by `<video>` / `<source>` tags.
- **Live progress** — per‑download progress, with cancel, in a Downloads tab.
  Downloads keep running even if you close the popup.
- **Scan a site (batch download)** — visits each page linked from the current
  page in a temporary background tab, detects the video on each, shows you the
  list of titles, and downloads them all (max 3 at a time).

---

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave…).
3. Toggle **Developer mode** on (top‑right).
4. Click **Load unpacked** and select the repository folder (the one containing
   `manifest.json`).
5. Pin the **HLS Video Downloader** icon to your toolbar.

Requires Chrome 116+ (uses the offscreen documents and `chrome.runtime.getContexts` APIs).

## Usage

1. Open a page and start playing a video.
2. Click the extension icon. Detected streams appear under **On this page**.
3. For an HLS stream, click **Download** to grab the best quality, or click the
   **▾** caret to expand and choose a specific resolution / audio track.
4. Watch progress in the **Downloads** tab. The finished file lands in your
   browser's download folder.

### Scan a whole site

To grab every video across a set of pages (e.g. all lessons of a course):

1. Open a page that **links to** the videos you want (a course index, a
   playlist page…).
2. Open the popup → **Scan site** tab → **Scan linked pages**.
3. A temporary background tab visits each same‑site link, lets its player load,
   and detects the video. Found titles appear in the list as it goes. **Keep
   the popup open while it scans.**
4. Click **Download all** — the videos queue up and download (3 at a time) in
   the Downloads tab.

Notes: it follows the links on the current page only (one level), same site.
Detection depends on each page's player actually loading its video, and Vimeo's
signed URLs are short‑lived, so start the downloads soon after scanning.

---

## How it works

```
┌─────────────┐   webRequest    ┌──────────────────┐
│  any tab    │ ───────────────▶│ background (SW)  │  detection + routing
└─────────────┘                 │  storage.session │  per‑tab media registry
                                 └───────┬──────────┘
        reads media/jobs ▲               │ download job
        (storage.session)│               ▼
                  ┌───────┴──────┐   ┌──────────────────────────────┐
                  │   popup UI   │   │ offscreen document           │
                  │ pick quality │   │  fetch segments (concurrent) │
                  └──────────────┘   │  AES‑128 decrypt (WebCrypto) │
                                     │  TS→MP4 (mux.js) / fMP4 concat│
                                     │  Blob → object URL           │
                                     └───────────────┬──────────────┘
                                                     │ object URL
                                                     ▼
                                            chrome.downloads ⇒ disk
```

- **`src/background.js`** — service worker. Uses `chrome.webRequest` to detect
  manifests/media, stores a per‑tab registry in `chrome.storage.session`,
  manages the offscreen document, and triggers `chrome.downloads`.
- **`src/offscreen/`** — a hidden offscreen document that does the heavy,
  long‑running work (network, crypto, muxing) where a service worker would risk
  being killed. It has DOM APIs: `fetch`, Web Crypto, Blob URLs and mux.js.
- **`src/popup/`** — the UI. Reads state from `storage.session`, parses HLS
  manifests on demand to offer qualities, and dispatches download jobs.
- **`src/content/content.js`** — reports the page title (for filenames) and any
  `<video>`/`<source>` URLs as a supplement to network detection.
- **`src/lib/m3u8-parser.js`** — dependency‑free HLS parser (master + media
  playlists, keys, maps, byte‑ranges).
- **`src/lib/vimeo-parser.js`** — parser for Vimeo's adaptive JSON manifest.
- **`src/lib/fmp4-muxer.js`** — tiny dependency‑free fMP4 → **progressive** MP4
  remuxer. It demuxes one or more fragmented MP4 buffers and rebuilds a single
  `moov` with full sample tables, so the result has a real duration and a
  seek index. It's the final stage for every MP4 the extension produces
  (Vimeo's separate video+audio, HLS fMP4, and HLS‑TS via mux.js) — without it,
  the output is a fragmented MP4 that can't be scrubbed or speed‑adjusted.
- **`src/lib/mux.min.js`** — vendored [mux.js](https://github.com/videojs/mux.js)
  6.3.0 (Apache‑2.0) for MPEG‑TS → MP4.

Cross‑origin segment fetches work because the extension requests the
`<all_urls>` host permission, which lets it read responses that ordinary page
scripts couldn't (no CORS wall).

---

## Supported vs. not supported

| Stream | Status |
| --- | --- |
| HLS, MPEG‑TS segments (muxed A/V) | ✅ downloaded and transmuxed to MP4 |
| HLS, fMP4 segments (muxed A/V) | ✅ assembled natively to MP4 |
| HLS with AES‑128 (`identity` key) | ✅ decrypted |
| **Vimeo** adaptive (`master.json` / `playlist.json`) | ✅ quality pick + video/audio merged into one MP4 |
| Direct `.mp4` / `.webm` / `.mkv` / `.m4a` … | ✅ downloaded |
| HLS with **separate** audio + video renditions | ⚠️ downloaded as two files; merge with e.g. ffmpeg (see below) |
| Live streams | ⚠️ best‑effort: only currently‑listed segments |
| DRM (Widevine / FairPlay / PlayReady, `SAMPLE-AES`) | ❌ not supported by design |
| DASH (`.mpd`) | ❌ not handled in this version |

### Vimeo

Many sites (e.g. course platforms) embed Vimeo, which streams via a custom JSON
manifest plus byte‑range segments rather than `.m3u8`/`.mpd`. The extension
detects the manifest, shows the available qualities, and downloads the chosen
video together with the best audio, **muxing them into a single `.mp4`** in the
browser. If muxing ever fails it falls back to saving the video and audio as two
files. Detection happens when the player first loads the manifest (usually on
page load, before you press play) — if you only see segments, reload the page
with the extension active. Vimeo's signed manifest URLs are short‑lived, so
download soon after the video loads.

### Separate audio/video

Some modern HLS playlists serve audio as a separate `EXT-X-MEDIA` rendition. In
that case a video variant downloads **without sound**. The popup flags these as
"video only" and lists the audio tracks separately so you can download both and
merge them, e.g.:

```bash
ffmpeg -i "video 1080p.mp4" -i "audio English.mp4" -c copy output.mp4
```

Single‑file (muxed) playlists — the most common case — download with audio
automatically.

### Referer / cookie‑gated streams

Segment requests are made from the extension with your cookies where possible,
but some CDNs require a specific `Referer`/`Origin` that browsers don't let
extensions set. Such streams may fail to download even though they're detected.

---

## Development

No build step and no runtime dependencies — it's plain JS loaded directly by
Chrome.

```bash
# run the parser + utils unit tests
npm test            # == node tests/parser.test.cjs

# regenerate the toolbar icons (pure‑Python, no deps)
npm run icons

# package a zip for upload / sharing
npm run zip
```

After editing files, hit the ↻ reload button on the extension card in
`chrome://extensions`. To debug:

- **Service worker**: "Inspect views: service worker" on the extension card.
- **Offscreen document**: appears under "Inspect views" while a download runs.
- **Popup**: right‑click the popup → Inspect.

### Project layout

```
manifest.json
icons/                 generated PNG icons (16/32/48/128)
scripts/make-icons.py  dependency‑free icon generator
src/
  background.js        service worker: detection, registry, download routing
  content/content.js   page title + <video> src reporter
  offscreen/           hidden worker: fetch + decrypt + mux + Blob
  popup/               toolbar UI
  lib/
    m3u8-parser.js     HLS manifest parser
    util.js            filename/format helpers
    mux.min.js         vendored mux.js (Apache‑2.0)
tests/parser.test.cjs  Node test suite for the pure logic
```

## Automated builds & releases

A GitHub Actions workflow (`.github/workflows/release.yml`) packages the
extension on **every push to any branch**. It runs the test suite, zips the
extension (`manifest.json` + `icons/` + `src/`), and publishes it to a single
rolling pre-release tagged **`latest`** — so the newest build is always one
download away:

```
https://github.com/onepersonhere/videodownloadplugin/releases/download/latest/hls-video-downloader.zip
```

The release is only updated when tests pass, so a broken commit never replaces
the last good build. Concurrent pushes are serialized (newest wins) so they
can't collide on the shared `latest` tag. You can also run it manually from the
Actions tab (**Run workflow**).

## License

MIT for the extension code in this repository. Bundled **mux.js** is licensed
under Apache‑2.0 (see the header in `src/lib/mux.min.js`).
