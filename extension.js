'use strict';

const { createExtensionStore, ExtensionError } = require('./extension-store');
const { tokenHash, validToken } = require('./auth');
const ORIGINS = Object.freeze({
  production: 'https://focustube.neuralnest.co.in',
  development: 'https://dev-ft.neuralnest.co.in',
  local: 'http://127.0.0.1:3110',
});
const EXTENSION_ID = /^[a-p]{32}$/;
const POST_PATHS = new Set(['session', 'videos', 'token', 'disconnect'].map(name => `/api/extension/${name}`));

function createExtension(store, auth, { environment = process.env, fetchVideo } = {}) {
  const enabled = environment.EXTENSION_ENABLED === '1';
  const origin = environment.EXTENSION_PUBLIC_ORIGIN;
  const environmentName = Object.keys(ORIGINS).find(name => ORIGINS[name] === origin);
  const localAllowed = environmentName !== 'local' || (environment.EXTENSION_ALLOW_LOOPBACK_HTTP === '1' &&
    environment.AUTH_ALLOW_LOOPBACK_HTTP === '1' && environment.HOST === '127.0.0.1' &&
    (!environment.TRUST_PROXY || environment.TRUST_PROXY === '0'));
  const ids = String(environment.EXTENSION_ALLOWED_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (enabled && (!environmentName || !localAllowed || !ids.length || ids.some(id => !EXTENSION_ID.test(id)))) {
    throw new Error('Extension capture requires an exact supported EXTENSION_PUBLIC_ORIGIN and EXTENSION_ALLOWED_IDS.');
  }
  const allowedOrigins = new Set(ids.filter(id => EXTENSION_ID.test(id)).map(id => `chrome-extension://${id}`));
  const isAllowedRequest = req => enabled && req.method === 'POST' && POST_PATHS.has(req.originalUrl) && allowedOrigins.has(req.get('origin'));
  let records;
  const storage = () => records ||= createExtensionStore(store);
  const active = new Map();
  let activeCount = 0;
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const credentials = req => {
    if (!req.sessionHash && /(?:^|;\s*)ft_session=/.test(req.get('cookie') || '')) throw new ExtensionError(401, 'CONNECTION_EXPIRED', 'The browser session is invalid. Connect FocusTube again.');
    const authorization = req.get('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (authorization && !validToken(token)) throw new ExtensionError(401, 'CONNECTION_EXPIRED', 'Connect FocusTube again.');
    return { sessionHash: req.sessionHash || null, grantHash: token ? tokenHash(token) : null,
      extensionId: req.get('origin')?.slice('chrome-extension://'.length), origin };
  };
  const body = (req, fields) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !fields.includes(key)) || Buffer.byteLength(JSON.stringify(req.body)) > 8192) {
      throw new ExtensionError(400, 'INVALID_REQUEST', 'Invalid extension request.');
    }
    return req.body;
  };
  const expectedAccount = value => {
    if (!Number.isSafeInteger(value) || value < 1) throw new ExtensionError(400, 'INVALID_REQUEST', 'A current account is required.');
    return value;
  };
  const connectionInput = (input, extensionId) => {
    if (!ids.includes(input.extensionId) || input.extensionId !== extensionId || input.redirectUri !== `https://${extensionId}.chromiumapp.org/` || !validToken(input.state)) {
      throw new ExtensionError(400, 'INVALID_CONNECTION', 'This extension connection is not allowed.');
    }
  };
  const router = require('express').Router({ caseSensitive: true, strict: true });
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!enabled) return res.status(404).json({ code: 'EXTENSION_DISABLED', error: 'Extension capture is not enabled.' });
    const preflight = req.method === 'OPTIONS' && POST_PATHS.has(req.originalUrl) && allowedOrigins.has(req.get('origin')) && req.get('access-control-request-method') === 'POST' &&
      String(req.get('access-control-request-headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean).every(value => ['content-type', 'authorization'].includes(value));
    if (req.authOrigin !== origin || (!isAllowedRequest(req) && !preflight && !(req.method === 'POST' && req.originalUrl === '/api/extension/authorize' && req.get('origin') === origin))) {
      return res.status(403).json({ code: 'INVALID_ORIGIN', error: 'This extension request is not allowed.' });
    }
    if (allowedOrigins.has(req.get('origin'))) {
      res.vary('Origin');
      res.set({ 'Access-Control-Allow-Origin': req.get('origin'), 'Access-Control-Allow-Credentials': 'true' });
    }
    if (preflight) return res.status(204).set({ 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' }).end();
    next();
  });
  router.use((req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Send extension requests as JSON.' });
    next();
  }, require('express').json({ limit: '8kb', strict: true }));
  router.use((req, _res, next) => {
    try { storage().reserve('source', req.ip, 180); next(); } catch (error) { next(error); }
  });

  router.post('/session', route((req, res) => {
    body(req, []);
    const actor = storage().principal(credentials(req));
    res.json({ account: actor.account, origin, environment: environmentName,
      authentication: actor.authentication, expiresAt: actor.expiresAt });
  }));

  router.post('/authorize', route((req, res) => {
    const input = body(req, ['extensionId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod', 'state', 'expectedAccount', 'consent']);
    connectionInput(input, input.extensionId);
    expectedAccount(input.expectedAccount);
    if (req.get('authorization') || input.consent !== true || input.codeChallengeMethod !== 'S256' || !validToken(input.codeChallenge)) {
      throw new ExtensionError(400, 'CONSENT_REQUIRED', 'Confirm this connection from your signed-in FocusTube account.');
    }
    const bound = { sessionHash: req.sessionHash, extensionId: input.extensionId, origin };
    const actor = storage().principal(bound, input.expectedAccount);
    storage().reserve('authorize', actor.userId, 10);
    const code = storage().authorize(bound, input);
    const redirect = new URL(input.redirectUri);
    redirect.hash = new URLSearchParams({ code, state: input.state }).toString();
    res.json({ redirectUrl: redirect.href });
  }));

  router.post('/token', route((req, res) => {
    const input = body(req, ['code', 'codeVerifier', 'state', 'extensionId', 'redirectUri']);
    const bound = credentials(req);
    connectionInput(input, bound.extensionId);
    if (bound.grantHash || !validToken(input.code) || typeof input.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
      throw new ExtensionError(400, 'INVALID_CODE', 'The connection code is invalid or expired. Connect again.');
    }
    const result = storage().exchange(bound, input);
    res.json({ ...result, origin, environment: environmentName });
  }));

  router.post('/disconnect', route((req, res) => {
    const input = body(req, ['expectedAccount']);
    storage().disconnect(credentials(req), expectedAccount(input.expectedAccount));
    res.status(204).end();
  }));

  router.post('/videos', route(async (req, res) => {
    const input = body(req, ['videoId', 'requestId', 'expectedAccount']);
    expectedAccount(input.expectedAccount);
    const bound = { ...credentials(req), deadline: Date.now() + 20000 };
    const actor = storage().principal(bound, input.expectedAccount);
    const previous = storage().capture(bound, input);
    if (previous) return res.json(previous);
    storage().reserve('capture', actor.userId, 30);
    storage().reserve('capture-minute', [actor.userId, Math.floor(Date.now() / 60000)], 5);
    if (typeof fetchVideo !== 'function') throw new ExtensionError(503, 'CAPTURE_UNAVAILABLE', 'Video capture is not configured.');
    if (activeCount >= 4 || (active.get(actor.userId) || 0) >= 2) throw new ExtensionError(429, 'CAPTURE_BUSY', 'A save is still running. Retry shortly.', 2);
    active.set(actor.userId, (active.get(actor.userId) || 0) + 1);
    activeCount++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, Math.min(15000, bound.deadline - Date.now())));
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', closed);
    try {
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new ExtensionError(504, 'CAPTURE_TIMEOUT', 'The save could not finish. Retry with the same request.')), { once: true }));
      let metadata;
      try { metadata = await Promise.race([Promise.resolve().then(() => fetchVideo(input.videoId, { signal: controller.signal })), aborted]); }
      catch (error) {
        if (error instanceof ExtensionError) throw error;
        throw new ExtensionError(502, 'VIDEO_UNAVAILABLE', 'YouTube metadata is unavailable or blocked. Retry later.');
      }
      storage().principal(bound, input.expectedAccount);
      if (controller.signal.aborted) throw new ExtensionError(504, 'CAPTURE_TIMEOUT', 'The save could not finish. Retry with the same request.');
      const receipt = storage().capture(bound, input, metadata);
      res.json(receipt);
    } finally {
      clearTimeout(timeout);
      res.removeListener('close', closed);
      const remaining = active.get(actor.userId) - 1;
      if (remaining) active.set(actor.userId, remaining); else active.delete(actor.userId);
      activeCount--;
    }
  }));
  router.use((error, _req, res, _next) => {
    if (res.headersSent || res.destroyed) return;
    const known = error instanceof ExtensionError;
    const status = known ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 503;
    if (known && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(status).json({ code: known ? error.code : status < 500 ? 'INVALID_REQUEST' : 'CAPTURE_UNAVAILABLE',
      error: known ? error.message : status < 500 ? 'Invalid extension request.' : 'Capture is temporarily unavailable. Retry this save.' });
  });
  return { router, isAllowedRequest, revokeSession: sessionHash => {
    if (records || store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extension_grants'").get()) storage().revokeSession(sessionHash);
  } };
}

module.exports = { createExtension };