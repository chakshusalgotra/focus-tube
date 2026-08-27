'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const archiver = require('archiver');
const express = require('express');

const QUALITY_FORMATS = {
  '1080': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720': 'bv*[height<=720]+ba/b[height<=720]',
  '480': 'bv*[height<=480]+ba/b[height<=480]',
  '360': 'bv*[height<=360]+ba/b[height<=360]',
  audio: 'ba/b',
};
const MAX_JOB_BYTES = 20 * 1024 * 1024 * 1024;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 2 * 60 * 60_000;
const JOB_TIMEOUT_MS = 12 * 60 * 60_000;

function commandAvailable(command, args = ['--version']) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

function safeName(value, fallback = 'course') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 _.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

function createDownloads(store, requireAuth) {
  const router = express.Router();
  const jobs = new Map();
  let toolsCache = null;

  function sweepTempDirs() {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('focustube-')) continue;
      const target = path.join(os.tmpdir(), name);
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > 24 * 60 * 60_000) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {
        /* stale temp cleanup is best effort */
      }
    }
  }
  sweepTempDirs();
  const sweepTimer = setInterval(sweepTempDirs, 60 * 60_000);
  sweepTimer.unref();

  function directoryBytes(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      total += entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size;
    }
    return total;
  }

  function assertDiskBudget(job) {
    const free = fs.statfsSync(job.tempDir).bavail * fs.statfsSync(job.tempDir).bsize;
    if (free < MIN_FREE_BYTES) throw new Error('Less than 2 GB of free disk space remains.');
    if (directoryBytes(job.tempDir) > MAX_JOB_BYTES) throw new Error('This course exceeded the 20 GB download limit.');
  }

  function prerequisites() {
    if (toolsCache && Date.now() - toolsCache.checkedAt < 60_000) return toolsCache.value;
    const ytDlp = commandAvailable('yt-dlp');
    const ffmpeg = commandAvailable('ffmpeg', ['-version']);
    const value = {
      ready: ytDlp && ffmpeg,
      ytDlp,
      ffmpeg,
      installCommand: 'brew install yt-dlp ffmpeg',
    };
    toolsCache = { checkedAt: Date.now(), value };
    return value;
  }

  function publicJob(job) {
    return {
      id: job.id,
      status: job.status,
      courseTitle: job.courseTitle,
      quality: job.quality,
      currentVideo: job.currentVideo,
      totalVideos: job.totalVideos,
      videoPercent: job.videoPercent,
      overallPercent: job.overallPercent,
      message: job.message,
      error: job.error,
      ready: job.status === 'ready',
    };
  }

  function emit(job) {
    const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
    for (const response of job.listeners) response.write(payload);
  }

  function cleanupJob(job, delay = 0) {
    const run = () => {
      fs.rmSync(job.tempDir, { recursive: true, force: true });
      jobs.delete(job.id);
    };
    if (delay) setTimeout(run, delay).unref();
    else run();
  }

  async function runJob(job, course) {
    job.status = 'downloading';
    const jobTimeout = setTimeout(() => {
      job.timedOut = true;
      job.process?.kill('SIGTERM');
    }, JOB_TIMEOUT_MS);
    jobTimeout.unref();
    emit(job);
    try {
      for (let index = 0; index < course.videos.length; index++) {
        if (job.cancelled) throw new Error('Download cancelled.');
        if (job.timedOut) throw new Error('Download exceeded the 12-hour limit.');
        assertDiskBudget(job);
        const video = course.videos[index];
        job.currentVideo = index + 1;
        job.videoPercent = 0;
        job.message = video.title;
        emit(job);

        const number = String(index + 1).padStart(String(course.videos.length).length, '0');
        const extension = job.quality === 'audio' ? 'm4a' : 'mp4';
        const output = path.join(job.tempDir, `${number} - ${safeName(video.title, 'video')}.${extension}`);
        const args = [
          '--newline',
          '--no-playlist',
          '--no-overwrites',
          '--restrict-filenames',
          '--format',
          QUALITY_FORMATS[job.quality],
          '--output',
          output,
        ];
        if (job.quality === 'audio') {
          args.push('--extract-audio', '--audio-format', 'm4a');
        } else {
          args.push('--merge-output-format', 'mp4');
        }
        args.push(`https://www.youtube.com/watch?v=${video.id}`);

        await new Promise((resolve, reject) => {
          const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
          job.process = child;
          job.resourceError = null;
          let lastBudgetCheck = 0;
          const videoTimeout = setTimeout(() => child.kill('SIGTERM'), VIDEO_TIMEOUT_MS);
          videoTimeout.unref();
          let stderr = '';
          const onChunk = (chunk) => {
            const text = chunk.toString();
            stderr = (stderr + text).slice(-4000);
            if (Date.now() - lastBudgetCheck > 5000) {
              lastBudgetCheck = Date.now();
              try {
                assertDiskBudget(job);
              } catch (err) {
                job.resourceError = err.message;
                child.kill('SIGTERM');
              }
            }
            const matches = [...text.matchAll(/\[download\]\s+([\d.]+)%/g)];
            if (matches.length) {
              job.videoPercent = Math.min(100, Number(matches.at(-1)[1]));
              job.overallPercent = Math.round(
                ((index + job.videoPercent / 100) / course.videos.length) * 100
              );
              emit(job);
            }
          };
          child.stdout.on('data', onChunk);
          child.stderr.on('data', onChunk);
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(videoTimeout);
            job.process = null;
            if (job.cancelled) reject(new Error('Download cancelled.'));
            else if (job.resourceError) reject(new Error(job.resourceError));
            else if (job.timedOut) reject(new Error('Download exceeded the 12-hour limit.'));
            else if (code === 0) resolve();
            else reject(new Error(stderr.trim().split('\n').at(-1) || `yt-dlp exited with ${code}`));
          });
        });
        assertDiskBudget(job);
        job.videoPercent = 100;
        job.overallPercent = Math.round(((index + 1) / course.videos.length) * 100);
        emit(job);
      }
      job.status = 'ready';
      job.readyAt = Date.now();
      job.message = 'ZIP ready';
      emit(job);
      cleanupJob(job, 60 * 60_000);
    } catch (err) {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = err.message;
      emit(job);
      cleanupJob(job, 60_000);
    } finally {
      clearTimeout(jobTimeout);
    }
  }

  router.get('/status', requireAuth, (_req, res) => {
    res.json(prerequisites());
  });

  router.get('/current', requireAuth, (req, res) => {
    const job = [...jobs.values()].find(
      (candidate) => candidate.userId === req.user.id && candidate.status !== 'cancelled'
    );
    res.json({ job: job ? publicJob(job) : null });
  });

  router.post('/', requireAuth, (req, res) => {
    const tools = prerequisites();
    if (!tools.ready) {
      return res.status(503).json({
        error: `Downloads require yt-dlp and ffmpeg. Run: ${tools.installCommand}`,
        ...tools,
      });
    }
    if (req.body?.authorized !== true) {
      return res.status(400).json({ error: 'Confirm that you have permission to download this course.' });
    }
    const quality = String(req.body?.quality || req.user.download_quality || '720');
    if (!QUALITY_FORMATS[quality]) return res.status(400).json({ error: 'Unsupported quality.' });
    const data = store.getUserData(req.user.id);
    const course = data.courses?.[req.body?.courseId];
    if (!course || !Array.isArray(course.videos) || !course.videos.length) {
      return res.status(404).json({ error: 'Course not found in your profile.' });
    }
    if (course.videos.length > 500) {
      return res.status(413).json({ error: 'Course ZIP downloads are limited to 500 videos.' });
    }
    const active = [...jobs.values()].find(
      (job) => job.userId === req.user.id && ['queued', 'downloading'].includes(job.status)
    );
    if (active) return res.status(409).json({ error: 'You already have a download in progress.', job: publicJob(active) });
    const globallyActive = [...jobs.values()].find((job) => ['queued', 'downloading'].includes(job.status));
    if (globallyActive) {
      return res.status(429).json({ error: 'Another course download is running. Try again when it finishes.' });
    }

    store.setDownloadQuality(req.user.id, quality);
    const id = crypto.randomBytes(12).toString('hex');
    const job = {
      id,
      userId: req.user.id,
      status: 'queued',
      quality,
      courseTitle: course.title,
      currentVideo: 0,
      totalVideos: course.videos.length,
      videoPercent: 0,
      overallPercent: 0,
      message: 'Preparing download',
      error: null,
      tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-')),
      listeners: new Set(),
      process: null,
      cancelled: false,
      timedOut: false,
    };
    jobs.set(id, job);
    setImmediate(() => runJob(job, course));
    res.status(202).json({ job: publicJob(job) });
  });

  router.get('/:id/events', requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).end();
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    job.listeners.add(res);
    emit(job);
    req.on('close', () => job.listeners.delete(res));
  });

  router.delete('/:id', requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Download not found.' });
    job.cancelled = true;
    job.process?.kill('SIGTERM');
    if (job.status === 'ready') cleanupJob(job);
    res.status(204).end();
  });

  router.get('/:id/file', requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Download not found.' });
    if (job.status !== 'ready') return res.status(409).json({ error: 'Download is not ready yet.' });

    const filename = `${safeName(job.courseTitle, 'course')}-${job.quality}.zip`;
    res.attachment(filename);
    res.set('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
    });
    archive.pipe(res);
    archive.directory(job.tempDir, false);
    archive.finalize();
  });

  return { router, prerequisites };
}

module.exports = { createDownloads };