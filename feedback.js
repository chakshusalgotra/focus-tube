'use strict';

const express = require('express');
const crypto = require('node:crypto');
const sharp = require('sharp');

const screenshotBytes = 5 * 1024 * 1024;
let imageRequests = 0;

const messages = {
  INVALID_FEEDBACK: [400, 'Check the feedback fields and try again.'],
  PUBLIC_CONSENT_REQUIRED: [400, 'Confirm that this report may be read by anyone on the internet.'],
  UNAUTHENTICATED: [401, 'Sign in to continue.'],
  FORBIDDEN: [403, 'Administrator access is required.'],
  FEEDBACK_NOT_FOUND: [404, 'This report is unavailable.'],
  FEEDBACK_CONFLICT: [409, 'This report changed or the submission key was reused. Refresh before trying again.'],
  FEEDBACK_LOCKED: [409, 'This conversation is locked or hidden.'],
  RATE_LIMITED: [429, 'Too many feedback requests. Try again later.'],
  INVALID_SCREENSHOT: [400, 'Choose a valid PNG, JPEG, or WebP screenshot, up to 5 MiB and 16 megapixels.'],
  SCREENSHOT_TOO_LARGE: [413, 'A screenshot is too large. Choose an image up to 5 MiB; crop or resize it if needed.'],
  SCREENSHOT_LIMIT: [400, 'Attach up to three screenshots per report or reply.'],
  SCREENSHOT_STORAGE_LIMIT: [413, 'Screenshot storage is full for this account or site. Remove the attachments or contact the administrator.'],
  SCREENSHOT_BUSY: [503, 'Other screenshots are being processed. Try submitting again shortly.'],
};

function screenshotFailure(code) {
  return Object.assign(new Error(code), { code });
}

async function prepareScreenshots(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 3) throw screenshotFailure('SCREENSHOT_LIMIT');
  if (!values.length) return [];
  if (imageRequests >= 2) throw screenshotFailure('SCREENSHOT_BUSY');
  imageRequests++;
  try {
    const images = [];
    for (const encoded of values) {
      if (typeof encoded !== 'string' || !encoded.length) throw screenshotFailure('INVALID_SCREENSHOT');
      if (encoded.length > Math.ceil(screenshotBytes / 3) * 4) throw screenshotFailure('SCREENSHOT_TOO_LARGE');
      const input = Buffer.from(encoded, 'base64');
      if (input.length > screenshotBytes) throw screenshotFailure('SCREENSHOT_TOO_LARGE');
      if (input.toString('base64') !== encoded) throw screenshotFailure('INVALID_SCREENSHOT');
      const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
      const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
      if (!png && !jpeg && !webp) throw screenshotFailure('INVALID_SCREENSHOT');
      const image = sharp(input, { failOn: 'warning', limitInputPixels: 16000000, limitInputChannels: 4, autoOrient: true });
      try {
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1 ||
            !metadata.width || !metadata.height || metadata.width * metadata.height > 16000000) throw screenshotFailure('INVALID_SCREENSHOT');
        const { data, info } = await image.resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 8 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
        if (data.length > 4 * 1024 * 1024) throw screenshotFailure('SCREENSHOT_TOO_LARGE');
        images.push({ data, width: info.width, height: info.height, sourceHash: crypto.createHash('sha256').update(input).digest('hex') });
      } finally { image.destroy(); }
    }
    return images;
  } catch (error) {
    if (messages[error.code]) throw error;
    throw screenshotFailure('INVALID_SCREENSHOT');
  } finally { imageRequests--; }
}

function queryOptions(query, fields) {
  if (Object.keys(query).some(key => !fields.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) {
    throw Object.assign(new Error('INVALID_FEEDBACK'), { code: 'INVALID_FEEDBACK' });
  }
  return query;
}

function createFeedback(store, auth, { environment = process.env, observe = () => {} } = {}) {
  const router = express.Router();
  const adminRouter = express.Router();
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const listOptions = query => queryOptions(query, ['page', 'category', 'status', 'q']);
  const smallJson = express.json({ limit: '64kb' });
  const imageJson = express.json({ limit: '21mb' });
  let uploads = 0;

  function parseBody(req, res, next) {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send feedback as JSON.', code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    const uploading = req.method === 'POST' && req.get('X-Feedback-Screenshots') === '1' && req.baseUrl === '/api/feedback' &&
      (req.path === '/' || /^\/[a-f0-9-]{36}\/replies$/.test(req.path));
    if (!uploading) return smallJson(req, res, next);
    auth.optionalAuth(req, res, () => auth.requireAuth(req, res, () => accountGuard(req, res, () => {
      try {
        if (uploads >= 2) throw screenshotFailure('SCREENSHOT_BUSY');
        auth.reserveFeedbackBudget(req, 'screenshot');
        req.screenshotBudgetReserved = true;
        uploads++;
        res.once('close', () => { uploads--; });
        imageJson(req, res, next);
      } catch (error) { errorHandler(error, req, res, next); }
    })));
  }

  async function postInput(req, fields) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => ![...fields, 'screenshots'].includes(key))) {
      throw screenshotFailure('INVALID_FEEDBACK');
    }
    const { screenshots, ...input } = req.body;
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw Object.assign(new Error('Request too large'), { code: 'INVALID_FEEDBACK' });
    if (screenshots?.length && !req.screenshotBudgetReserved) auth.reserveFeedbackBudget(req, 'screenshot');
    return { input, images: await prepareScreenshots(screenshots) };
  }

  function accountGuard(req, res, next) {
    const expected = req.get('X-Feedback-Account');
    const actual = req.user && !req.user.is_guest ? String(req.user.id) : 'anonymous';
    if (expected && expected !== actual) {
      return res.status(409).json({ error: 'Your signed-in account changed. Reopen the report before continuing.', code: 'FEEDBACK_ACCOUNT_CHANGED' });
    }
    next();
  }
  router.use(accountGuard);
  adminRouter.use(accountGuard, auth.requireAdmin);

  router.get('/viewer', route((req, res) => res.json({ user: req.user && !req.user.is_guest
    ? { id: req.user.id, name: req.user.username || 'Tester', isAdmin: !!req.user.is_admin } : null })));
  router.get('/', route((req, res) => res.json(store.listFeedback(req.sessionHash, 'public', listOptions(req.query)))));
  router.get('/mine', auth.requireAuth, route((req, res) => res.json(store.listFeedback(req.sessionHash, 'mine', listOptions(req.query)))));
  router.get('/:id', route((req, res) => res.json({ thread: store.getFeedback(req.sessionHash, req.params.id) })));
  router.get('/:id/replies', route((req, res) => res.json(store.getFeedbackReplies(req.sessionHash, req.params.id, queryOptions(req.query, ['page'])))));
  router.get('/:id/screenshots/:screenshotId', route((req, res) => {
    const image = store.getFeedbackScreenshot(req.sessionHash, req.params.id, req.params.screenshotId);
    res.status(200).set({ 'Content-Type': 'image/png', 'Content-Length': String(image.data.length),
      'Content-Disposition': 'inline; filename="screenshot.png"', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox" }).end(image.data);
  }));
  router.post('/', auth.requireAuth, route(async (req, res) => {
    const { input, images } = await postInput(req, ['submissionId', 'category', 'visibility', 'publicConsent', 'title', 'body', 'steps', 'expected', 'actual', 'context']);
    const result = store.createFeedback(req.sessionHash, input, environment.APP_ENV, () => auth.reserveFeedbackBudget(req, 'report'), images);
    observe('feedback', 'success');
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  router.post('/:id/replies', auth.requireAuth, route(async (req, res) => {
    store.getFeedback(req.sessionHash, req.params.id);
    const { input, images } = await postInput(req, ['submissionId', 'body']);
    const result = store.addFeedbackReply(req.sessionHash, req.params.id, input, () => auth.reserveFeedbackBudget(req, 'reply'), images);
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  adminRouter.get('/', route((req, res) => res.json(store.listFeedback(req.sessionHash, 'all', listOptions(req.query)))));
  adminRouter.patch('/:id', route((req, res) => {
    auth.reserveFeedbackBudget(req, 'moderate');
    res.json({ thread: store.updateFeedback(req.sessionHash, req.params.id, req.body) });
  }));
  adminRouter.patch('/:id/replies/:replyId', route((req, res) => {
    auth.reserveFeedbackBudget(req, 'moderate');
    res.json(store.moderateFeedbackReply(req.sessionHash, req.params.id, req.params.replyId, req.body));
  }));

  function errorHandler(error, req, res, _next) {
    const [status, message] = messages[error.code] || [503, 'Feedback is temporarily unavailable. Try again shortly.'];
    if (status === 503) res.set('Retry-After', '15');
    observe('feedback', status === 429 ? 'limited' : status >= 500 ? 'failed' : 'rejected');
    req.monitoring?.reportError(error);
    res.status(status).json({ error: message, code: messages[error.code] ? error.code : 'FEEDBACK_UNAVAILABLE' });
  }
  router.use(errorHandler);
  adminRouter.use(errorHandler);
  return { router, adminRouter, parseBody };
}

module.exports = { createFeedback, prepareScreenshots };