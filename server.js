/* FocusTube — tiny server that turns YouTube playlists into distraction-free courses. */
'use strict';

const express = require('express');
const path = require('path');
const store = require('./db');
const { createAuth } = require('./auth');
const { createDownloads } = require('./downloads');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
const allowedHosts = new Set(
  [
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
    ...String(process.env.ALLOWED_HOSTS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ]
);
app.use((req, res, next) => {
  const requestHost = String(req.get('host') || '').toLowerCase();
  if (!allowedHosts.has(requestHost)) return res.status(400).send('Invalid Host header.');
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
      "connect-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
      "img-src 'self' data: https://i.ytimg.com",
      "style-src 'self' 'unsafe-inline'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '3mb' }));
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
  } catch {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
  next();
});

const auth = createAuth(store);
app.use('/api/auth', auth.router);
app.use('/api', auth.optionalAuth);
const downloads = createDownloads(store, auth.requireAuth);
app.use('/api/downloads', downloads.router);
app.get('/api/health', (_req, res) => {
  try {
    store.db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});
app.get('/vendor/confetti.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/canvas-confetti/dist/confetti.browser.js'))
);
app.get('/vendor/jspdf.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jspdf/dist/jspdf.umd.min.js'))
);
app.get('/vendor/chart.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.js'))
);
app.use(express.static(path.join(__dirname, 'public')));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- helpers ---------- */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Work out what the user pasted: a playlist or a single video. */
function extractTarget(input) {
  if (!input) return null;
  const raw = String(input).trim();
  // Raw ids pasted directly
  if (VIDEO_ID_RE.test(raw)) return { kind: 'video', id: raw };
  if (/^(PL|UU|FL|OL|RD)[A-Za-z0-9_-]{5,}$/.test(raw) && !raw.includes('/')) {
    return { kind: 'playlist', id: raw };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be' && host !== 'youtube-nocookie.com') return null;

  const list = url.searchParams.get('list');
  let videoId = null;
  const vParam = url.searchParams.get('v');
  if (vParam && VIDEO_ID_RE.test(vParam)) videoId = vParam;
  if (!videoId && host === 'youtu.be') {
    const seg = url.pathname.split('/')[1] || '';
    if (VIDEO_ID_RE.test(seg)) videoId = seg;
  }
  if (!videoId) {
    const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
    if (m) videoId = m[1];
  }

  // Real playlists win; auto-generated Mixes (RD…) fall back to the video if present.
  if (list && !/^RD/.test(list)) return { kind: 'playlist', id: list };
  if (videoId) return { kind: 'video', id: videoId };
  if (list) return { kind: 'playlist', id: list };
  return null;
}

function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join('');
  return '';
}

/** Extract the first balanced JSON object that follows `marker` in `html`. */
function extractJson(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseDurationText(t) {
  if (!t || !/^\d+(:\d{2})+$/.test(String(t).trim())) return 0;
  return String(t)
    .trim()
    .split(':')
    .reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Find the "11:53" style duration badge anywhere inside a lockup's contentImage. */
function findDurationBadge(node) {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      const s = findDurationBadge(item);
      if (s) return s;
    }
    return 0;
  }
  if (node.thumbnailBadgeViewModel) {
    const s = parseDurationText(node.thumbnailBadgeViewModel.text);
    if (s) return s;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const s = findDurationBadge(v);
      if (s) return s;
    }
  }
  return 0;
}

/** Deep-walk any innertube payload, collecting playlist videos.
 *  Handles both the classic `playlistVideoRenderer` and the 2024+ `lockupViewModel` formats. */
function collectVideos(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideos(item, out);
    return;
  }
  if (node.playlistVideoRenderer) {
    const r = node.playlistVideoRenderer;
    if (r.videoId) {
      out.push({
        id: r.videoId,
        title: textOf(r.title) || '(untitled)',
        durationSeconds: Number(r.lengthSeconds || 0),
        playlistId: null,
        playable: r.isPlayable !== false,
      });
    }
    return; // nothing useful nested deeper
  }
  if (node.lockupViewModel) {
    const l = node.lockupViewModel;
    if (l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const we = l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
      const videoId = we?.videoId || l.contentId;
      if (videoId) {
        out.push({
          id: videoId,
          title: l.metadata?.lockupMetadataViewModel?.title?.content || '(untitled)',
          durationSeconds: findDurationBadge(l.contentImage),
          playlistId: we?.playlistId || null,
          playable: true,
        });
      }
    }
    return;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') collectVideos(v, out);
  }
}

/** Collect every continuation token in a payload (covers old and new UI shapes). */
function findContinuationTokens(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findContinuationTokens(item, out);
    return out;
  }
  if (node.continuationCommand?.token) out.add(node.continuationCommand.token);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') findContinuationTokens(v, out);
  }
  return out;
}

/** Breadth-first search for the first value stored under `wantedKey`. */
function deepFind(obj, wantedKey) {
  const queue = [obj];
  let guard = 0;
  while (queue.length && guard++ < 100000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && node[wantedKey] !== undefined) return node[wantedKey];
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return undefined;
}

function playlistMeta(data, html) {
  const md = data?.metadata?.playlistMetadataRenderer;
  const ph = data?.header?.playlistHeaderRenderer;
  const pageHeader = data?.header?.pageHeaderRenderer;
  let title = md?.title || textOf(ph?.title) || pageHeader?.pageTitle || '';
  if (!title) {
    const m = html.match(/<title>([^<]*)<\/title>/);
    title = m ? m[1].replace(/\s*-\s*YouTube\s*$/, '').trim() : '';
  }
  let author = textOf(ph?.ownerText) || '';
  if (!author) {
    const owner = deepFind(data, 'videoOwnerRenderer');
    author = textOf(owner?.title) || '';
  }
  if (!author) {
    // New UI: owner lives in the page header's metadata rows.
    const phvm = deepFind(data, 'pageHeaderViewModel');
    const rows = deepFind(phvm || {}, 'metadataRows');
    const firstText = rows?.[0]?.metadataParts?.[0]?.text?.content;
    if (firstText) author = firstText;
  }
  return { title: title || 'Untitled course', author };
}

async function fetchPlaylist(playlistId) {
  const pageUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}&hl=en`;
  const res = await fetch(pageUrl, {
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      cookie: 'CONSENT=YES+cb; SOCS=CAI',
    },
  });
  if (res.status === 404) throw new HttpError(404, 'Playlist not found. Is it public?');
  if (!res.ok) throw new HttpError(502, `YouTube responded with status ${res.status}.`);
  const html = await res.text();

  const data =
    extractJson(html, 'var ytInitialData = ') || extractJson(html, 'window["ytInitialData"] = ');
  if (!data) throw new HttpError(500, 'Could not read the playlist page. Try again in a moment.');

  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const clientVersion =
    (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '2.20240401.00.00';

  const all = [];
  collectVideos(data, all);

  // Playlists longer than 100 videos page through "continuations". The page exposes
  // several candidate tokens; follow whichever one actually yields more videos.
  const tried = new Set();
  let candidates = [...findContinuationTokens(data)];
  let guard = 0;
  while (candidates.length && apiKey && guard++ < 50) {
    let progressed = false;
    for (const token of candidates) {
      if (tried.has(token)) continue;
      tried.add(token);
      const contRes = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': UA },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } },
            continuation: token,
          }),
        }
      );
      if (!contRes.ok) continue;
      const contData = await contRes.json();
      const before = all.length;
      collectVideos(contData, all);
      if (all.length > before) {
        candidates = [...findContinuationTokens(contData)];
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }

  const seen = new Set();
  const videos = all
    .filter(
      (v) =>
        v.playable &&
        v.title !== '[Private video]' &&
        v.title !== '[Deleted video]' &&
        (!v.playlistId || v.playlistId === playlistId) // drop unrelated lockups (e.g. sidebar suggestions)
    )
    .filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
    .map(({ id, title, durationSeconds }) => ({ id, title, durationSeconds }));

  const meta = playlistMeta(data, html);
  return {
    id: playlistId,
    title: meta.title,
    author: meta.author,
    videoCount: videos.length,
    skipped: all.length - videos.length,
    videos,
  };
}

async function fetchWatchHtml(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      cookie: 'CONSENT=YES+cb; SOCS=CAI',
    },
  });
  if (!res.ok) throw new HttpError(502, `YouTube responded with status ${res.status}.`);
  return res.text();
}

async function fetchVideo(videoId) {
  const html = await fetchWatchHtml(videoId);
  const pr =
    extractJson(html, 'var ytInitialPlayerResponse = ') ||
    extractJson(html, 'window["ytInitialPlayerResponse"] = ');
  const vd = pr?.videoDetails;
  if (pr?.playabilityStatus?.status === 'ERROR') {
    throw new HttpError(404, 'This video is unavailable — it may be private or deleted.');
  }
  let title = vd?.title || '';
  let author = vd?.author || '';
  const durationSeconds = Number(vd?.lengthSeconds || 0);
  if (!title) {
    // Fallback: oEmbed gives title/author (but no duration).
    const oe = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        'https://www.youtube.com/watch?v=' + videoId
      )}&format=json`,
      { headers: { 'user-agent': UA } }
    );
    if (oe.ok) {
      const j = await oe.json();
      title = j.title || '';
      author = author || j.author_name || '';
    }
  }
  if (!title) throw new HttpError(404, 'Could not load that video — is it public?');
  return {
    id: videoId,
    title,
    author,
    videoCount: 1,
    skipped: 0,
    type: 'video',
    videos: [{ id: videoId, title, durationSeconds }],
  };
}

/** Chapters as YouTube renders them on the player bar (manual or auto). */
function parseChaptersFromData(data) {
  const chapters = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.chapterRenderer?.title) {
      chapters.push({
        start: Math.round(Number(n.chapterRenderer.timeRangeStartMillis || 0) / 1000),
        title: textOf(n.chapterRenderer.title).slice(0, 200),
      });
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  })(data);
  const seen = new Set();
  return chapters
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
    .sort((a, b) => a.start - b.start);
}

/** Fallback: timestamps listed in the description ("0:00 Intro" style). */
function parseChaptersFromDescription(desc, durationSeconds) {
  const out = [];
  for (const line of String(desc || '').split(/\r?\n/)) {
    const m = line.match(/(?:^|[\s(\u005b])((?:\d{1,2}:)?\d{1,2}:\d{2})(?![\d:])/);
    if (!m) continue;
    const start = parseDurationText(m[1]);
    if (durationSeconds && start > durationSeconds) continue;
    let title = line
      .replace(m[1], '')
      .replace(/^[\s\-\u2013\u2014:.)\u005d]+|[\s\-\u2013\u2014:.(\u005b]+$/g, '')
      .trim();
    if (!title) title = `Chapter · ${m[1]}`;
    out.push({ start, title: title.slice(0, 200) });
  }
  const seen = new Set();
  const sorted = out
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
    .sort((a, b) => a.start - b.start);
  // Only treat as chapters if it looks like a real chapter list.
  if (sorted.length >= 2 && sorted[0].start <= 15) return sorted;
  return [];
}

/* ---------- routes ---------- */

app.get('/api/data', auth.requireAuth, (req, res) => {
  res.json(store.getUserData(req.user.id));
});

app.get('/api/export', auth.requireAuth, (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  const owner = String(req.user.username || `guest-${req.user.id}`)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 40);
  res.attachment(`focustube-${owner}-${date}.json`);
  res.type('application/json').send(JSON.stringify(store.getExportData(req.user.id), null, 2));
});

app.put('/api/data', auth.requireAuth, (req, res) => {
  try {
    const courses = req.body?.courses;
    const stats = req.body?.stats;
    const settings = req.body?.settings;
    if (!courses || typeof courses !== 'object' || Array.isArray(courses)) {
      throw new HttpError(400, 'Courses must be an object.');
    }
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      throw new HttpError(400, 'Stats must be an object.');
    }
    const courseList = Object.values(courses);
    if (courseList.length > 250) throw new HttpError(413, 'A profile can store up to 250 courses.');
    let videoCount = 0;
    for (const course of courseList) {
      if (!course || !Array.isArray(course.videos)) throw new HttpError(400, 'A course has invalid videos.');
      videoCount += course.videos.length;
      if (course.videos.length > 5000) throw new HttpError(413, 'A course can contain up to 5,000 videos.');
    }
    if (videoCount > 20_000) throw new HttpError(413, 'A profile can store up to 20,000 videos.');
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision) || revision < 0) throw new HttpError(400, 'A profile revision is required.');
    const nextRevision = store.saveUserData(
      req.user.id,
      { courses, stats, settings: settings || {} },
      revision,
      req.body?.importLegacy === true
    );
    if (nextRevision === null) {
      return res.status(409).json({ error: 'Progress changed in another tab. Reload before saving again.' });
    }
    res.json({ ok: true, revision: nextRevision, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save progress.' });
  }
});

app.post('/api/track', auth.requireAuth, (req, res) => {
  try {
    if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(req.body?.batchId || '')) {
      throw new HttpError(400, 'Invalid activity batch id.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '')) {
      throw new HttpError(400, 'Invalid activity date.');
    }
    if (!Array.isArray(req.body?.watch) || req.body.watch.length > 100) {
      throw new HttpError(400, 'Invalid watch activity.');
    }
    for (const item of req.body.watch) {
      if (!item?.courseId || !item?.videoId) throw new HttpError(400, 'Activity is missing a course or video id.');
    }
    store.track(req.user.id, req.body);
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not record activity.' });
  }
});

app.get('/api/stats/summary', auth.requireAuth, (req, res) => {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : undefined;
  res.json(store.getStatsSummary(req.user.id, today));
});

app.get('/api/stats/daily', auth.requireAuth, (req, res) => {
  const days = Math.max(7, Math.min(365, Number(req.query.days) || 30));
  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : undefined;
  res.json({ days: store.getDailyStats(req.user.id, days, today) });
});

app.get('/api/stats/courses', auth.requireAuth, (req, res) => {
  const days = req.query.days === 'all' ? 0 : Math.max(7, Math.min(365, Number(req.query.days) || 30));
  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : undefined;
  res.json({ courses: store.getCourseSplit(req.user.id, days, today) });
});

app.get('/api/stats/history', auth.requireAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  res.json({ page, items: store.getHistory(req.user.id, page, 50) });
});

app.put('/api/profile/download-quality', auth.requireAuth, (req, res) => {
  const quality = String(req.body?.quality || '');
  if (!['1080', '720', '480', '360', 'audio'].includes(quality)) {
    return res.status(400).json({ error: 'Unsupported download quality.' });
  }
  const user = store.setDownloadQuality(req.user.id, quality);
  res.json({ user: store.publicUser(user) });
});

app.get('/api/playlist', async (req, res) => {
  try {
    const target = extractTarget(req.query.url);
    if (!target) {
      throw new HttpError(
        400,
        'That does not look like a YouTube playlist or video link. Paste a playlist URL (with "list=") or a video URL.'
      );
    }
    if (target.kind === 'video') {
      res.json(await fetchVideo(target.id));
      return;
    }
    if (/^RD/.test(target.id)) {
      throw new HttpError(400, 'That is an auto-generated YouTube Mix. Please use a real playlist.');
    }
    const result = await fetchPlaylist(target.id);
    if (!result.videos.length) {
      throw new HttpError(404, 'No playable videos found — the playlist may be private or empty.');
    }
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (!err.status) console.error(err);
    res.status(status).json({ error: err.message || 'Something went wrong.' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!VIDEO_ID_RE.test(id)) throw new HttpError(400, 'Bad video id.');
    const html = await fetchWatchHtml(id);
    const pr =
      extractJson(html, 'var ytInitialPlayerResponse = ') ||
      extractJson(html, 'window["ytInitialPlayerResponse"] = ');
    const data =
      extractJson(html, 'var ytInitialData = ') || extractJson(html, 'window["ytInitialData"] = ');
    const vd = pr?.videoDetails;
    const description = vd?.shortDescription || '';
    const durationSeconds = Number(vd?.lengthSeconds || 0);
    let chapters = parseChaptersFromData(data);
    if (!chapters.length) chapters = parseChaptersFromDescription(description, durationSeconds);
    res.json({
      id,
      title: vd?.title || '',
      author: vd?.author || '',
      durationSeconds,
      description,
      chapters,
    });
  } catch (err) {
    const status = err.status || 500;
    if (!err.status) console.error(err);
    res.status(status).json({ error: err.message || 'Something went wrong.' });
  }
});

const cleanupTimer = setInterval(() => store.cleanup(), 6 * 60 * 60_000);
cleanupTimer.unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  FocusTube running →  http://localhost:${PORT}\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Try: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});
