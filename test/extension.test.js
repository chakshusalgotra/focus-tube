'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const { createExtension } = require('../extension');
const { createExtensionStore } = require('../extension-store');
const { createAuth } = require('../auth');

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionOrigin = `chrome-extension://${extensionId}`;
const publicOrigin = 'https://focustube.neuralnest.co.in';
const environment = { EXTENSION_ENABLED: '1', EXTENSION_ALLOWED_IDS: extensionId, EXTENSION_PUBLIC_ORIGIN: publicOrigin };
const request = (originalUrl, origin = extensionOrigin, method = 'POST') => ({ originalUrl, method, get: name => name === 'origin' ? origin : undefined });

test('popup sizing gives Chrome a stable intrinsic width without viewport feedback', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/popup.css'), 'utf8');
  const rootRule = css.match(/(?:^|\n)html\s*\{([^}]+)\}/)[1];
  const bodyRule = css.match(/(?:^|\n)body\s*\{([^}]+)\}/)[1];
  assert.match(rootRule, /\bwidth:\s*360px/);
  assert.match(rootRule, /\bmin-width:\s*360px/);
  assert.match(rootRule, /\bheight:\s*520px/);
  assert.match(rootRule, /\boverflow:\s*hidden/);
  assert.doesNotMatch(rootRule, /(?:max-width|width):[^;]*(?:vw|%)/);
  assert.match(bodyRule, /\bwidth:\s*360px/);
  assert.match(bodyRule, /\bmax-height:\s*100dvh/);
  assert.match(css, /main\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
});

test('popup keeps primary actions outside scrolling content and bounds long video titles', () => {
  const directory = path.join(__dirname, '../extension');
  const html = fs.readFileSync(path.join(directory, 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(directory, 'popup.css'), 'utf8');
  const script = fs.readFileSync(path.join(directory, 'popup.js'), 'utf8');
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  assert.doesNotMatch(main, /id="(?:connect|save|open)"/);
  for (const id of ['connect', 'save', 'open']) assert.equal(html.match(new RegExp(`id="${id}"`, 'g')).length, 1);
  assert.match(css, /\.topbar, \.commands, footer\s*\{\s*flex:\s*none/);
  assert.match(css, /h1\s*\{[^}]*-webkit-line-clamp:\s*4[^}]*overflow:\s*hidden/);
  assert.match(css, /\.video-copy p\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(script, /element\('videoTitle'\)\.title = element\('videoTitle'\)\.textContent/);
});

test('extension origin exception is default-off and matches only exact routes, methods and installed IDs', () => {
  assert.equal(createExtension(null, null, { environment: {} }).isAllowedRequest(request('/api/extension/session')), false);
  const extension = createExtension(null, null, { environment });
  for (const path of ['session', 'videos', 'token', 'disconnect']) assert.equal(extension.isAllowedRequest(request(`/api/extension/${path}`)), true);
  for (const path of ['/api/extension/authorize', '/api/data', '/api/extension/session/', '/api/extension/session?x=1', '/api/extension/SESSION', '/api/extension/%73ession', '/api/extension/videos/../session']) {
    assert.equal(extension.isAllowedRequest(request(path)), false, path);
  }
  for (const origin of [null, '', 'null', publicOrigin, `${extensionOrigin}/`, `${extensionOrigin}.evil.test`, 'chrome-extension://pppppppppppppppppppppppppppppppp']) {
    assert.equal(extension.isAllowedRequest(request('/api/extension/session', origin)), false);
  }
  assert.equal(extension.isAllowedRequest({ ...request('/api/extension/session'), get: () => undefined }), false);
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'post']) assert.equal(extension.isAllowedRequest(request('/api/extension/session', extensionOrigin, method)), false);
  assert.throws(() => createExtension(null, null, { environment: { ...environment, EXTENSION_ALLOWED_IDS: '*' } }));
  assert.throws(() => createExtension(null, null, { environment: { ...environment, EXTENSION_PUBLIC_ORIGIN: `${publicOrigin}/` } }));
});

test('local capture requires an explicit opt-in, exact preview origin and loopback-only listener', () => {
  const local = { ...environment, EXTENSION_PUBLIC_ORIGIN: 'http://127.0.0.1:3110', EXTENSION_ALLOW_LOOPBACK_HTTP: '1',
    HOST: '127.0.0.1', AUTH_ALLOW_LOOPBACK_HTTP: '1' };
  assert.equal(createExtension(null, null, { environment: local }).isAllowedRequest(request('/api/extension/session')), true);
  for (const change of [
    { EXTENSION_ALLOW_LOOPBACK_HTTP: undefined }, { EXTENSION_ALLOW_LOOPBACK_HTTP: '0' }, { AUTH_ALLOW_LOOPBACK_HTTP: '0' },
    { HOST: '0.0.0.0' }, { HOST: 'localhost' }, { TRUST_PROXY: '1' },
    { EXTENSION_PUBLIC_ORIGIN: 'http://127.0.0.1:3002' }, { EXTENSION_PUBLIC_ORIGIN: 'http://localhost:3110' },
    { EXTENSION_PUBLIC_ORIGIN: 'http://192.168.1.2:3110' }, { EXTENSION_PUBLIC_ORIGIN: 'http://dev-ft.neuralnest.co.in' },
  ]) assert.throws(() => createExtension(null, null, { environment: { ...local, ...change } }));
  assert.equal(createExtension(null, null, { environment: { ...local, EXTENSION_ENABLED: '0', EXTENSION_ALLOW_LOOPBACK_HTTP: '0' } }).isAllowedRequest(request('/api/extension/session')), false);
  assert.equal(createExtension(null, null, { environment }).isAllowedRequest(request('/api/extension/session')), true);
});

test('the signed-in application resumes only the approved extension connection before normal routing', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.ok(html.indexOf('src="extension-connect.js"') < html.indexOf('src="app.js"'));
  const finish = app.slice(app.indexOf('async function finishAuth('), app.indexOf('async function bootAuth('));
  assert.match(finish, /if \(window\.FocusTubeExtensionConnect\?\.resumeAfterSignIn\(\)\) return true;/);
  assert.ok(finish.indexOf('resumeAfterSignIn') < finish.indexOf('route();'));
});

test('real HTTP extension router denies foreign origins and does not bypass approved host origin', async context => {
  const app = express();
  const extension = createExtension(null, null, { environment });
  app.use((req, _res, next) => { req.authOrigin = req.get('x-test-origin') || publicOrigin; next(); });
  app.use('/api/extension', extension.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [{}, { origin: 'null' }, { origin: `${extensionOrigin}/` }, { origin: extensionOrigin, 'x-test-origin': 'https://dev-ft.neuralnest.co.in' }]) {
    const response = await fetch(`${address}/api/extension/session`, { method: 'POST', headers });
    assert.equal(response.status, 403);
  }
});

function memoryStore(context, filename = ':memory:') {
  const module = { exports: {} };
  const directory = path.join(__dirname, '..');
  const localRequire = createRequire(path.join(directory, 'db.js'));
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'db.js'), 'utf8'), {
    module, __dirname: directory,
    require(name) {
      if (name === 'better-sqlite3') return class MemoryDatabase extends Database { constructor() { super(filename); } };
      if (name === 'fs') return { mkdirSync() {} };
      return localRequire(name);
    },
  }, { filename: 'db.js' });
  context.after(() => { if (module.exports.db.open) module.exports.db.close(); });
  return module.exports;
}

function member(store, username = 'capture-member') {
  const user = store.createUser({ username });
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
  store.createSession(sessionHash, user.id, new Date(Date.now() + 86400000).toISOString());
  return { user, token, sessionHash };
}

const videoId = 'aqz-KE-bpKQ';
const metadata = (id = videoId) => ({ id, title: 'A public lesson', author: 'Fixture', videos: [{ id, title: 'A public lesson', durationSeconds: 120 }] });
const captureInput = (accountId, id = videoId) => ({ videoId: id, requestId: crypto.randomUUID(), expectedAccount: accountId });

test('capture uses latest profile and preserves all non-course columns, notes and chat', context => {
  const store = memoryStore(context);
  const account = member(store);
  const snapshot = { courses: { keep: { id: 'keep', title: 'Keep', videos: [{ id: 'abcdefghijk', title: 'Original' }], completed: { abcdefghijk: true }, positions: { abcdefghijk: 32 } } }, stats: {}, settings: { volume: 23 }, workspace: { tasks: { keep: { title: 'Do not change' } } } };
  store.saveUserData(account.user.id, snapshot, 0);
  const original = store.db.prepare('SELECT stats_json, settings_json, workspace_json, notes_revision, chat_revision FROM user_data WHERE user_id = ?').get(account.user.id);
  const extension = createExtensionStore(store);
  const input = captureInput(account.user.id);
  assert.equal(extension.capture(account, input), null);
  const changed = store.getUserData(account.user.id);
  changed.courses.keep.positions.abcdefghijk = 78;
  store.saveUserData(account.user.id, { ...changed, stats: {} }, changed.revision);
  const receipt = extension.capture(account, input, metadata());
  assert.equal(receipt.outcome, 'saved');
  assert.equal(receipt.revision, 3);
  const saved = store.getUserData(account.user.id);
  assert.equal(saved.courses.keep.positions.abcdefghijk, 78);
  assert.equal(saved.courses[videoId].lastVideoId, null);
  assert.equal(JSON.stringify(saved.courses[videoId].completed), '{}');
  assert.equal(JSON.stringify(saved.courses[videoId].positions), '{}');
  assert.deepEqual(store.db.prepare('SELECT stats_json, settings_json, workspace_json, notes_revision, chat_revision FROM user_data WHERE user_id = ?').get(account.user.id), original);
  assert.deepEqual(extension.capture(account, input), receipt);
  assert.throws(() => extension.capture(account, { ...input, videoId: 'abcdefghijk' }), error => error.code === 'REQUEST_CONFLICT');
  delete saved.courses[videoId];
  store.saveUserData(account.user.id, saved, saved.revision);
  assert.equal(extension.capture(account, input).present, false);
  assert.equal(Object.hasOwn(store.getUserData(account.user.id).courses, videoId), false);
});

test('browser session replacement revokes extension access atomically and rolls back on revocation failure', context => {
  const store = memoryStore(context);
  const account = member(store);
  const extension = createExtensionStore(store);
  const beforeSessions = store.db.prepare('SELECT count(*) AS count FROM sessions').get().count;
  const replacement = crypto.createHash('sha256').update('new-synthetic-session').digest('hex');
  assert.throws(() => store.passwordSession({ user: store.getUserById(account.user.id), sessionHash: replacement, sessionMs: 86400000,
    onSessionReplaced: () => { extension.revokeSession(account.sessionHash); throw new Error('Injected revocation failure'); } }), /Injected revocation failure/);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM sessions').get().count, beforeSessions);
  assert.equal(extension.principal(account).userId, account.user.id);
  store.passwordSession({ user: store.getUserById(account.user.id), sessionHash: replacement, sessionMs: 86400000,
    onSessionReplaced: () => extension.revokeSession(account.sessionHash) });
  assert.throws(() => extension.principal(account), error => error.code === 'CONNECTION_EXPIRED');
  assert.equal(store.getSessionUser(account.sessionHash).id, account.user.id);
  assert.equal(store.getSessionUser(replacement).id, account.user.id);
});

test('capture prefers standalone duplicates, then stable course keys, with no revision bump', context => {
  const store = memoryStore(context);
  const account = member(store);
  const courses = { zed: { videos: [{ id: videoId }, { id: 'abcdefghijk' }] }, alpha: { videos: [{ id: videoId }, { id: 'abcdefghijk' }] }, single: { videos: [{ id: videoId }] } };
  store.saveUserData(account.user.id, { courses }, 0);
  const extension = createExtensionStore(store);
  assert.equal(extension.capture(account, captureInput(account.user.id)).courseId, 'single');
  delete courses.single;
  store.saveUserData(account.user.id, { courses }, 1);
  const receipt = extension.capture(account, captureInput(account.user.id));
  assert.equal(receipt.courseId, 'alpha');
  assert.equal(receipt.outcome, 'existing');
  assert.equal(store.getUserData(account.user.id).revision, 2);
});

test('capture quotas and inactive principals fail without profile or receipt writes', context => {
  const store = memoryStore(context);
  const account = member(store);
  const other = member(store, 'other');
  const extension = createExtensionStore(store);
  assert.throws(() => extension.capture(account, captureInput(other.user.id), metadata()), error => error.code === 'ACCOUNT_CHANGED');
  const courses = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`course${index}`, { videos: [] }]));
  store.saveUserData(account.user.id, { courses }, 0);
  assert.throws(() => extension.capture(account, captureInput(account.user.id), metadata()), error => error.code === 'LIBRARY_QUOTA');
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(account.user.id);
  assert.throws(() => extension.capture(account, captureInput(account.user.id), metadata()), error => error.code === 'CONNECTION_EXPIRED');
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM extension_receipts').get().count, 0);
});

async function apiFixture(context, overrides = {}) {
  const store = memoryStore(context);
  const account = member(store);
  const other = member(store, 'other');
  const auth = createAuth(store, { rateSecret: Buffer.alloc(32, 7), services: { captchaSiteKey: '', emailConfigured: false } });
  const extension = createExtension(store, auth, { environment, fetchVideo: async id => metadata(id), ...overrides });
  const app = express();
  app.use((req, res, next) => {
    req.authOrigin = overrides.environment?.EXTENSION_PUBLIC_ORIGIN || publicOrigin;
    if (req.method === 'POST' && req.get('origin') !== req.authOrigin && !extension.isAllowedRequest(req)) return res.status(403).json({ code: 'INVALID_ORIGIN' });
    next();
  });
  app.use(auth.optionalAuth);
  app.use('/api/extension', extension.router);
  app.post('/api/data', auth.requireAuth, (_req, res) => res.json({ protected: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const send = async (suffix, payload = {}, headers = {}) => {
    const response = await fetch(`${endpoint}/api/extension${suffix}`, { method: 'POST', headers: { origin: extensionOrigin, 'content-type': 'application/json', cookie: `ft_session=${account.token}`, ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  return { store, account, other, extension, send, endpoint };
}

test('opted-in local HTTP reports Local identity and preserves PKCE, account and replay guards', async context => {
  const origin = 'http://127.0.0.1:3110';
  const fixture = await apiFixture(context, { environment: { ...environment, EXTENSION_PUBLIC_ORIGIN: origin,
    EXTENSION_ALLOW_LOOPBACK_HTTP: '1', AUTH_ALLOW_LOOPBACK_HTTP: '1', HOST: '127.0.0.1' } });
  const session = await fixture.send('/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.environment, 'local');
  assert.equal(session.body.origin, origin);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const redirectUri = `https://${extensionId}.chromiumapp.org/`;
  const consent = await fixture.send('/authorize', { extensionId, redirectUri, codeChallengeMethod: 'S256',
    codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state, consent: true, expectedAccount: fixture.account.user.id }, { origin });
  assert.equal(consent.status, 200);
  const code = new URLSearchParams(new URL(consent.body.redirectUrl).hash.slice(1)).get('code');
  const token = await fixture.send('/token', { code, codeVerifier: verifier, state, extensionId, redirectUri });
  assert.equal(token.status, 200);
  assert.equal(token.body.environment, 'local');
  const headers = { cookie: '', authorization: `Bearer ${token.body.token}` };
  const input = captureInput(fixture.account.user.id);
  const saved = await fixture.send('/videos', input, headers);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.outcome, 'saved');
  assert.equal((await fixture.send('/videos', input, headers)).body.requestId, saved.body.requestId);
  assert.equal((await fixture.send('/session', {}, { ...headers, origin: publicOrigin })).status, 403);
  assert.equal((await fixture.send('/videos', { ...input, requestId: crypto.randomUUID(), expectedAccount: fixture.other.user.id }, headers)).status, 409);
  fixture.store.deleteSession(fixture.account.sessionHash);
  assert.equal((await fixture.send('/session', {}, headers)).status, 401);
});

test('actual server scopes extension access without weakening account, invitation or profile origin guards', async context => {
  const store = memoryStore(context);
  const account = member(store);
  store.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(account.user.id);
  store.saveUserData(account.user.id, { courses: { [videoId]: metadata() } }, 0);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const root = path.join(__dirname, '..');
  const localRequire = createRequire(path.join(root, 'server.js'));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('const cleanupTimer =')[0] + '\nmodule.exports = app;', {
    module, __dirname: root, console, URL, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout,
    process: { env: { PORT: String(server.address().port), HOST: '127.0.0.1', TRUST_PROXY: '1', AUTH_PUBLIC_ORIGINS: publicOrigin,
      LOG_LEVEL: 'silent', APP_ENV: 'test', ...environment } },
    require(name) {
      if (name === './db') return store;
      if (name === './auth') return { createAuth: (target, options) => createAuth(target, { ...options, rateSecret: Buffer.alloc(32, 9), services: { captchaSiteKey: '', emailConfigured: false } }) };
      if (name === './downloads') return { createDownloads: () => ({ router: express.Router() }) };
      return localRequire(name);
    },
  }, { filename: 'server.js' });
  server.on('request', module.exports);
  const send = (endpoint, { method = 'POST', origin = extensionOrigin, payload = {}, headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint, method,
      headers: { Host: new URL(publicOrigin).host, Origin: origin, 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json',
        Cookie: `ft_session=${account.token}`, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null }); });
    });
    outgoing.on('error', reject);
    outgoing.end(['GET', 'OPTIONS'].includes(method) ? undefined : JSON.stringify(payload));
  });
  const session = await send('/api/extension/session');
  assert.equal(session.status, 200, session.body?.code);
  assert.equal(session.body.account.id, account.user.id);
  assert.equal((await send('/api/extension/videos', { payload: captureInput(account.user.id) })).body.outcome, 'existing');
  for (const endpoint of ['/api/data', '/api/auth/logout', '/api/invites', '/api/extension/authorize']) {
    assert.equal((await send(endpoint, { method: endpoint === '/api/data' ? 'PUT' : 'POST' })).status, 403, endpoint);
  }
  assert.equal((await send('/api/extension/session', { origin: 'null' })).status, 403);
  assert.equal((await send('/api/extension/session', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await send('/api/extension/session', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })).status, 204);
  assert.equal((await send('/api/invites/1', { method: 'PATCH', origin: publicOrigin, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const invitations = await send('/api/invites', { method: 'GET', origin: publicOrigin, headers: { 'X-Invite-Account': String(account.user.id) } });
  assert.equal(invitations.status, 200);
  assert.equal(invitations.headers['x-invite-account'], String(account.user.id));
  assert.equal((await send('/api/invites', { method: 'GET', origin: publicOrigin, headers: { 'X-Invite-Account': String(account.user.id + 1) } })).body.code, 'INVITATION_ACCOUNT_CHANGED');
  assert.equal((await send('/api/notebooks', { method: 'GET', origin: publicOrigin, headers: { 'X-Notebook-Account': String(account.user.id + 1) } })).body.code, 'SESSION_CHANGED');
  assert.equal((await send(`/api/notebooks/${videoId}/videos/${videoId}`, { method: 'PUT', origin: publicOrigin, headers: { 'X-Notebook-Account': String(account.user.id + 1) }, payload: { revision: 0, document: null } })).body.code, 'SESSION_CHANGED');
  assert.equal(store.getNotebook(account.user.id, videoId).records.length, 0);
  for (const method of ['GET', 'PUT']) {
    for (const headers of [{}, { 'X-Profile-Account': String(account.user.id + 1) }, { 'X-Profile-Account': '01' }]) {
      assert.equal((await send('/api/data', { method, origin: publicOrigin, headers })).body.code, 'SESSION_CHANGED');
    }
  }
  const profile = await send('/api/data', { method: 'GET', origin: publicOrigin, headers: { 'X-Profile-Account': String(account.user.id) } });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.revision, 1);
  assert.equal(profile.body.courses[videoId].videos[0].id, videoId);
});

test('server video metadata fetch is ID-only, abortable, redirect-free and byte-bounded', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const module = { exports: {} };
  const requests = [];
  vm.runInNewContext(source.slice(source.indexOf('async function readVideoResponse'), source.indexOf('/** Chapters as YouTube')) + '\nmodule.exports = { fetchVideo, readVideoResponse };', {
    module, Buffer, AbortSignal, VIDEO_ID_RE: /^[A-Za-z0-9_-]{11}$/, UA: 'test',
    HttpError: class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } },
    extractJson: () => null,
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(url.includes('/oembed?') ? JSON.stringify({ title: 'Bounded video', author_name: 'Fixture' }) : '<html></html>');
    },
  });
  const controller = new AbortController();
  const result = await module.exports.fetchVideo(videoId, { signal: controller.signal });
  assert.equal(result.title, 'Bounded video');
  assert.equal(requests.length, 2);
  for (const call of requests) {
    assert.equal(call.url.origin, 'https://www.youtube.com');
    assert.equal(call.options.signal, controller.signal);
    assert.equal(call.options.redirect, 'error');
  }
  await assert.rejects(module.exports.fetchVideo('https://private.invalid'), /Invalid video/);
  assert.equal(requests.length, 2);
  await assert.rejects(module.exports.readVideoResponse(new Response('too large', { headers: { 'Content-Length': '9000000' } }), controller.signal), /too large/);
  await assert.rejects(module.exports.readVideoResponse(new Response('abcdef'), controller.signal, 5), /too large/);
  controller.abort();
  await assert.rejects(module.exports.readVideoResponse(new Response('small'), controller.signal), { name: 'AbortError' });
});

test('HTTP capture revalidates revoked sessions after awaited metadata and never leaks full profiles', async context => {
  let resolveMetadata;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { resolveMetadata = resolve; });
  const fixture = await apiFixture(context, { fetchVideo: async () => { started(); return pending; } });
  const session = await fixture.send('/session');
  assert.equal(session.status, 200);
  assert.deepEqual(Object.keys(session.body.account).sort(), ['id', 'name']);
  assert.equal(Object.hasOwn(session.body, 'courses'), false);
  const saving = fixture.send('/videos', captureInput(fixture.account.user.id));
  await entered;
  fixture.store.deleteSession(fixture.account.sessionHash);
  resolveMetadata(metadata());
  assert.equal((await saving).status, 401);
  assert.equal(fixture.store.getUserData(fixture.account.user.id).revision, 0);
});

function connectInput(accountId) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, consent: { extensionId, redirectUri: `https://${extensionId}.chromiumapp.org/`,
    codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256',
    state: crypto.randomBytes(32).toString('base64url'), expectedAccount: accountId, consent: true } };
}

async function connection(fixture) {
  const input = connectInput(fixture.account.user.id);
  const issued = await fixture.send('/authorize', input.consent, { origin: publicOrigin });
  assert.equal(issued.status, 200);
  const redirect = new URL(issued.body.redirectUrl);
  assert.equal(`${redirect.origin}${redirect.pathname}`, input.consent.redirectUri);
  const params = new URLSearchParams(redirect.hash.slice(1));
  return { ...input, code: params.get('code'), exchange: { code: params.get('code'), codeVerifier: input.verifier, state: input.consent.state, extensionId, redirectUri: input.consent.redirectUri } };
}

test('PKCE consent is same-origin only; wrong state, verifier, callback and client cannot redeem a single-use code', async context => {
  const fixture = await apiFixture(context);
  const input = connectInput(fixture.account.user.id);
  assert.equal((await fixture.send('/authorize', input.consent)).status, 403);
  assert.equal((await fixture.send('/authorize', { ...input.consent, consent: false }, { origin: publicOrigin })).status, 400);
  assert.equal((await fixture.send('/authorize', { ...input.consent, redirectUri: 'https://evil.test/' }, { origin: publicOrigin })).status, 400);
  const linked = await connection(fixture);
  for (const replacement of [{ state: crypto.randomBytes(32).toString('base64url') }, { codeVerifier: 'x'.repeat(43) }, { redirectUri: `${linked.consent.redirectUri}?next=https://evil.test` }, { extensionId: 'pppppppppppppppppppppppppppppppp' }]) {
    assert.equal((await fixture.send('/token', { ...linked.exchange, ...replacement })).status, 400);
  }
  const grant = await fixture.send('/token', linked.exchange, { cookie: '' });
  assert.equal(grant.status, 200);
  assert.equal(Buffer.from(grant.body.token, 'base64url').length, 32);
  assert.equal((await fixture.send('/token', linked.exchange)).status, 400);
  const codeRowCount = fixture.store.db.prepare('SELECT count(*) AS count FROM extension_codes').get().count;
  const grantRow = fixture.store.db.prepare('SELECT token_hash, expires_at FROM extension_grants').get();
  assert.equal(codeRowCount, 0);
  assert.equal(grantRow.token_hash === crypto.createHash('sha256').update(grant.body.token).digest('hex'), true);
  assert.equal(grantRow.token_hash.includes(grant.body.token), false);
  assert.ok(grantRow.expires_at <= Date.now() + 86400000);
  const session = await fixture.send('/session', {}, { cookie: '', authorization: `Bearer ${grant.body.token}` });
  assert.equal(session.status, 200);
  assert.equal(session.body.authentication, 'grant');
  assert.equal(session.body.account.id, fixture.account.user.id);
});

test('grant capture is account-bound, cannot authorize ordinary APIs, and disconnect preserves app sessions', async context => {
  let fetchCount = 0;
  const fixture = await apiFixture(context, { fetchVideo: async id => { fetchCount++; return metadata(id); } });
  const linked = await connection(fixture);
  const redeemed = await fixture.send('/token', linked.exchange);
  const headers = { cookie: '', authorization: `Bearer ${redeemed.body.token}` };
  assert.equal((await fixture.send('/session', {}, { ...headers, cookie: `ft_session=${fixture.other.token}` })).status, 409);
  assert.equal((await fixture.send('/session', {}, { ...headers, cookie: 'ft_session=invalid' })).status, 401);
  assert.equal((await fixture.send('/videos', captureInput(fixture.other.user.id), headers)).status, 409);
  const input = captureInput(fixture.account.user.id);
  const saved = await fixture.send('/videos', input, headers);
  assert.equal(saved.status, 200);
  assert.deepEqual((await fixture.send('/videos', input, headers)).body, saved.body);
  assert.equal(fetchCount, 1);
  const ordinary = await fetch(`${fixture.endpoint}/api/data`, { method: 'POST', headers: { origin: publicOrigin, authorization: headers.authorization } });
  assert.equal(ordinary.status, 401);
  assert.equal((await fixture.send('/disconnect', { expectedAccount: fixture.account.user.id }, headers)).status, 204);
  assert.equal((await fixture.send('/session', {}, headers)).status, 401);
  assert.equal(!!fixture.store.getSessionUser(fixture.account.sessionHash), true);
});

test('cookie replacement revokes codes, grants and in-flight capture even while the old app session remains valid', async context => {
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const fixture = await apiFixture(context, { fetchVideo: async () => { entered(); return waiting; } });
  const linked = await connection(fixture);
  const redeemed = await fixture.send('/token', linked.exchange);
  await connection(fixture);
  const saving = fixture.send('/videos', captureInput(fixture.account.user.id), { cookie: '', authorization: `Bearer ${redeemed.body.token}` });
  await started;
  fixture.extension.revokeSession(fixture.account.sessionHash);
  finish(metadata());
  assert.equal((await saving).status, 401);
  assert.equal(fixture.store.getUserData(fixture.account.user.id).revision, 0);
  assert.equal(fixture.store.db.prepare('SELECT count(*) AS count FROM extension_codes').get().count, 0);
  assert.equal(fixture.store.db.prepare('SELECT count(*) AS count FROM extension_grants').get().count, 0);
  assert.equal(!!fixture.store.getSessionUser(fixture.account.sessionHash), true);
  assert.equal((await fixture.send('/session')).status, 401);
});

test('exact extension preflight supports credentials without widening consent or ordinary API routes', async context => {
  const fixture = await apiFixture(context);
  for (const [suffix, header, expected] of [['/session', 'content-type, authorization', 204], ['/authorize', 'content-type', 403], ['/videos', 'x-arbitrary-header', 403], ['/session?x=1', 'content-type', 403]]) {
    const response = await fetch(`${fixture.endpoint}/api/extension${suffix}`, { method: 'OPTIONS', headers: { origin: extensionOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': header } });
    assert.equal(response.status, expected);
    if (expected === 204) assert.equal(response.headers.get('access-control-allow-origin'), extensionOrigin);
  }
});

const { parseVideoUrl, createCaptureWorker, ORIGINS } = require('../extension/service-worker');

test('extension URL parsing captures only canonical supported YouTube videos, stripping playlist, time and tracking', () => {
  for (const url of [`https://www.youtube.com/watch?v=${videoId}&list=PLstuff&t=72&utm_source=tracker`, `https://youtu.be/${videoId}?si=tracking`, `https://m.youtube.com/shorts/${videoId}`, `https://www.youtube.com/live/${videoId}`, `https://www.youtube-nocookie.com/embed/${videoId}`]) {
    assert.deepEqual(parseVideoUrl(url), { videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
  }
  for (const url of [`https://youtube.com.evil.test/watch?v=${videoId}`, `https://evil.test@youtube.com/watch?v=${videoId}`, `javascript:alert(1)`, `https://youtube.com:8443/watch?v=${videoId}`,
    `https://youtube.com/watch?v=${videoId}&v=abcdefghijk`, `https://youtube.com/watch?v=too-short`, 'https://youtube.com/playlist?list=PLstuff', 'https://youtube.com/@channel', `https://youtu.be/${videoId}/extra`, `https://www.youtube.com\\@evil.test/watch?v=${videoId}`]) assert.equal(parseVideoUrl(url), null, url);
});

function workerFixture(overrides = {}) {
  const local = {};
  const session = {};
  const access = [];
  const area = values => ({
    async get(key) { return key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) }; },
    async set(valuesToSet) { Object.assign(values, structuredClone(valuesToSet)); },
    async remove(keys) { for (const key of [].concat(keys)) delete values[key]; },
    async setAccessLevel(value) { access.push(value.accessLevel); },
  });
  const browser = { storage: { local: area(local), session: area(session) }, permissions: { async contains() { return true; } },
    action: { async setBadgeText() {}, async openPopup() {} }, runtime: { id: extensionId },
    identity: { getRedirectURL: () => `https://${extensionId}.chromiumapp.org/`, async launchWebAuthFlow() { throw new Error('Not configured'); } } };
  const requests = [];
  const network = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, credentials: options.credentials, hasGrant: !!options.headers.Authorization });
    if (overrides.fetch) return overrides.fetch(url, options, local);
    const environmentName = Object.keys(ORIGINS).find(name => ORIGINS[name] === new URL(url).origin);
    const accountId = { production: 1, development: 2, local: 3 }[environmentName];
    if (url.endsWith('/session')) return Response.json({ account: { id: accountId, name: environmentName }, environment: environmentName, origin: ORIGINS[environmentName], authentication: 'session', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    if (url.endsWith('/videos')) {
      assert.equal(local.capture.pending.some(item => item.requestId === body.requestId), true, 'Persist the operation before network dispatch');
      return Response.json({ requestId: body.requestId, accountId: body.expectedAccount, videoId: body.videoId, courseId: body.videoId, outcome: 'saved', present: true, title: 'Saved lesson' });
    }
    return new Response(null, { status: 204 });
  };
  const create = () => createCaptureWorker(browser, network, overrides.now || Date.now);
  return { local, session, browser, requests, access, create, worker: create() };
}

test('worker initializes trusted storage inside a request and recovers from No SW without reading or sending data', async () => {
  const fixture = workerFixture();
  assert.equal(fixture.access.length, 0, 'Constructing the worker must not start an unobserved Chrome API promise');
  let unavailable = true;
  const setAccess = fixture.browser.storage.session.setAccessLevel;
  fixture.browser.storage.session.setAccessLevel = async options => {
    if (unavailable) throw new Error('No SW');
    await setAccess(options);
  };
  const result = await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(result.state, null);
  assert.deepEqual(fixture.local, {});
  assert.deepEqual(fixture.session, {});
  assert.equal(fixture.requests.length, 0);
  unavailable = false;
  const recovered = await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.account.id, 1);
  assert.ok(fixture.access.every(value => value === 'TRUSTED_CONTEXTS'));
  const configured = fixture.access.length;
  await fixture.worker.handle({ type: 'state' });
  assert.equal(fixture.access.length, configured, 'Successful storage initialization is reused');
});

test('worker Chrome entrypoints handle No SW, menu installation errors and closed response channels', async () => {
  const fixture = workerFixture();
  const listeners = {};
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  const menus = [];
  let badgeAttempts = 0;
  let menuFailure = true;
  fixture.browser.runtime = { id: extensionId, getURL: filename => `${extensionOrigin}/${filename}`, onInstalled: event('installed'), onMessage: event('message') };
  fixture.browser.contextMenus = {
    async removeAll() { if (menuFailure) throw new Error('No SW'); menus.length = 0; },
    create(options, callback) { menus.push(options); callback(); }, onClicked: event('click'),
  };
  fixture.browser.permissions.onRemoved = event('removed');
  fixture.browser.action.openPopup = async () => { throw new Error('No SW'); };
  fixture.browser.action.setBadgeText = async () => { badgeAttempts++; throw new Error('No SW'); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/service-worker.js'), 'utf8'), {
    chrome: fixture.browser, crypto: crypto.webcrypto, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('Fixture network unavailable'); },
  });
  assert.equal(fixture.access.length, 0);
  listeners.installed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(badgeAttempts, 1);
  assert.equal(menus.length, 0);
  menuFailure = false;
  listeners.installed();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(menus.map(menu => menu.id), ['focustube-link', 'focustube-page']);
  const sender = { id: extensionId, url: `${extensionOrigin}/popup.html` };
  let replies = 0;
  assert.equal(listeners.message({ type: 'state' }, sender, () => { replies++; throw new Error('Response channel closed'); }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies, 1);
  assert.equal(listeners.message({ type: 'state' }, { ...sender, url: `${extensionOrigin}/other.html` }, () => { throw new Error('Unexpected reply'); }), false);
  listeners.click({ menuItemId: 'focustube-link', linkUrl: `https://youtu.be/${videoId}` }, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(badgeAttempts, 2);
  assert.equal(fixture.session.view.error.code, 'NETWORK_ERROR');
  assert.equal(fixture.local.capture.pending.length, 0);
  fixture.browser.contextMenus.create = (_options, callback) => {
    fixture.browser.runtime.lastError = { message: 'Menu registration unavailable' };
    callback();
    delete fixture.browser.runtime.lastError;
  };
  listeners.installed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(badgeAttempts, 3);
});

test('worker persists saves before dispatch and isolates production from development without reading profiles', async () => {
  const fixture = workerFixture();
  const opened = await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}`, title: 'Video' });
  assert.equal(opened.state.account.id, 1);
  const saved = await fixture.worker.handle({ type: 'save' });
  assert.equal(saved.state.receipt.outcome, 'saved');
  assert.equal(fixture.local.capture.pending.length, 0);
  assert.ok(fixture.access.every(value => value === 'TRUSTED_CONTEXTS'));
  await fixture.worker.handle({ type: 'environment', environment: 'development' });
  await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  assert.equal((await fixture.worker.handle({ type: 'save' })).state.account.id, 2);
  const saves = fixture.requests.filter(item => item.url.endsWith('/videos'));
  assert.equal(saves.length, 2);
  assert.equal(saves[0].body.expectedAccount, 1);
  assert.equal(saves[1].body.expectedAccount, 2);
  assert.ok(fixture.requests.every(item => item.credentials === 'include' && /\/api\/extension\/(session|videos)$/.test(item.url)));
});

test('Local testing stays bound to the exact preview origin and isolated from hosted accounts', async () => {
  const fixture = workerFixture();
  const checkedPermissions = [];
  fixture.browser.permissions.contains = async value => { checkedPermissions.push(...value.origins); return true; };
  await fixture.worker.handle({ type: 'environment', environment: 'local' });
  const opened = await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  assert.equal(opened.state.origin, 'http://127.0.0.1:3110');
  assert.equal(opened.state.account.id, 3);
  const saved = await fixture.worker.handle({ type: 'save' });
  assert.equal(saved.state.receipt.accountId, 3);
  assert.equal(fixture.requests.every(item => item.url.startsWith('http://127.0.0.1:3110/api/extension/')), true);
  assert.equal(checkedPermissions.every(value => value === 'http://127.0.0.1/*'), true);
  await fixture.worker.handle({ type: 'environment', environment: 'development' });
  assert.equal((await fixture.worker.handle({ type: 'state' })).state.account, null);
  await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  assert.equal((await fixture.worker.handle({ type: 'state' })).state.account.id, 2);
  await fixture.worker.permissionsRemoved({ origins: ['http://127.0.0.1/*'] });
  assert.equal(fixture.local.capture.connections.local.paused, true);
  assert.equal(fixture.local.capture.connections.development.paused, false);
});

test('worker restart keeps uncertain request IDs, enforces retry time, and never transfers pending accounts', async () => {
  let fail = true;
  let accountId = 1;
  const fixture = workerFixture({ fetch: async (url, options, local) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/session')) return Response.json({ account: { id: accountId, name: 'Member' }, environment: 'production', origin: publicOrigin, authentication: 'session', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(local.capture.pending[0].requestId, body.requestId);
    if (fail) throw new TypeError('Offline');
    return Response.json({ ...body, accountId: body.expectedAccount, courseId: body.videoId, outcome: 'saved', present: true, title: 'Receipt' });
  } });
  await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  assert.equal((await fixture.worker.handle({ type: 'save' })).state.phase, 'uncertain');
  const requestId = fixture.local.capture.pending[0].requestId;
  const restarted = fixture.create();
  accountId = 2;
  assert.equal((await restarted.handle({ type: 'save', requestId })).error.code, 'ACCOUNT_CHANGED');
  assert.equal(fixture.local.capture.pending[0].accountId, 1);
  accountId = 1;
  fixture.local.capture.connections.production.paused = false;
  fail = false;
  assert.equal((await restarted.handle({ type: 'save', requestId })).state.receipt.requestId, requestId);
  assert.equal(fixture.local.capture.pending.length, 0);
});

test('worker queue is bounded to 20, expires after 24 hours, and never queues an unbound or permission-denied action', async () => {
  let clock = Date.now();
  const fixture = workerFixture({ now: () => clock });
  fixture.browser.permissions.contains = async () => false;
  await fixture.worker.contextMenu({ linkUrl: `https://youtu.be/${videoId}` }, {});
  assert.equal(fixture.local.capture.pending.length, 0);
  assert.equal(fixture.requests.length, 0);
  fixture.browser.permissions.contains = async () => true;
  await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  fixture.local.capture.pending = Array.from({ length: 20 }, () => ({ requestId: crypto.randomUUID(), videoId: 'abcdefghijk', accountId: 1, environment: 'production', createdAt: clock, retryAt: 0 }));
  assert.equal((await fixture.worker.handle({ type: 'save' })).error.code, 'QUEUE_FULL');
  clock += 86400001;
  const expired = await fixture.worker.handle({ type: 'state' });
  assert.equal(expired.state.pendingCount, 0);
  assert.equal(expired.state.expired, true);
});

test('worker PKCE survives popup closure, keeps verifier in session storage and exposes no token to the popup', async () => {
  const grant = crypto.randomBytes(32).toString('base64url');
  const code = crypto.randomBytes(32).toString('base64url');
  let expectedChallenge;
  let expectedState;
  const fixture = workerFixture({ fetch: async (url, options) => {
    if (url.endsWith('/session')) return Response.json({ code: 'CONNECTION_EXPIRED', error: 'Connect first.' }, { status: 401 });
    const body = JSON.parse(options.body);
    assert.equal(body.code, code);
    assert.equal(body.state, expectedState);
    assert.equal(crypto.createHash('sha256').update(body.codeVerifier).digest('base64url'), expectedChallenge);
    return Response.json({ token: grant, account: { id: 1, name: 'Member' }, environment: 'production', origin: publicOrigin, authentication: 'grant', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  } });
  fixture.browser.identity.launchWebAuthFlow = async ({ url, interactive }) => {
    assert.equal(interactive, true);
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    expectedChallenge = params.get('codeChallenge');
    expectedState = params.get('state');
    assert.equal(!!fixture.session.pkce.verifier, true);
    assert.equal(JSON.stringify(fixture.local).includes(fixture.session.pkce.verifier), false);
    return `https://${extensionId}.chromiumapp.org/#${new URLSearchParams({ code, state: expectedState })}`;
  };
  const result = await fixture.worker.handle({ type: 'connect' });
  assert.equal(result.ok, true);
  assert.equal(result.state.account.id, 1);
  assert.equal(fixture.local.capture.connections.production.token === grant, true);
  assert.equal(fixture.session.pkce, undefined);
  assert.equal(JSON.stringify(result).includes(grant), false);
});

test('a late save cannot repaint another environment; 429 keeps the same request and respects Retry-After', async () => {
  let release;
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const fixture = workerFixture({ fetch: async url => {
    if (url.endsWith('/session')) return Response.json({ account: { id: 1, name: 'Member' }, environment: 'production', origin: publicOrigin, authentication: 'session', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    entered();
    await waiting;
    return Response.json({ code: 'RATE_LIMITED', error: 'Wait before retrying.' }, { status: 429, headers: { 'Retry-After': '60' } });
  } });
  await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  const saving = fixture.worker.handle({ type: 'save' });
  await reached;
  await fixture.worker.handle({ type: 'environment', environment: 'development' });
  release();
  await saving;
  const view = await fixture.worker.handle({ type: 'state' });
  assert.equal(view.state.environment, 'development');
  assert.equal(view.state.error, null);
  assert.equal(view.state.receipt, null);
  assert.equal(fixture.local.capture.pending[0].environment, 'production');
  const requestId = fixture.local.capture.pending[0].requestId;
  await fixture.worker.handle({ type: 'environment', environment: 'production' });
  assert.equal((await fixture.worker.handle({ type: 'save', requestId })).error.code, 'RATE_LIMITED');
  assert.equal(fixture.requests.filter(item => item.url.endsWith('/videos')).length, 1);
});

test('extension artifact has only the approved permissions and deterministic local fonts, icons and ZIP', async context => {
  const { packageExtension } = require('../scripts/package-extension');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'focustube-extension-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = await packageExtension(directory);
  const second = await packageExtension(directory);
  assert.equal(first.sha256, second.sha256);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['contextMenus', 'activeTab', 'storage', 'identity']);
  assert.deepEqual(manifest.optional_host_permissions, Object.values(ORIGINS).map(origin => { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }));
  assert.match(manifest.content_security_policy.extension_pages, /connect-src[^;]*http:\/\/127\.0\.0\.1:3110/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /http:\/\/localhost|http:\/\/\*|http:\/\/127\.0\.0\.1:\*/);
  assert.match(fs.readFileSync(path.join(__dirname, '../extension/popup.html'), 'utf8'), /<option value="local">Local testing<\/option>/);
  assert.equal(manifest.minimum_chrome_version, '127');
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe|\*/);
  assert.equal(first.files.length, 16);
  assert.ok(first.files.every(filename => !/(\.env|\.pem|\.key|server|database|\.zip|\.map)/i.test(filename)));
  const image = require('sharp')(path.join(directory, 'assets/icon-128.png'));
  assert.equal((await image.metadata()).width, 128);
  const pixels = await image.stats();
  assert.ok(pixels.channels[0].max > pixels.channels[0].min);
  for (const file of ['service-worker.js', 'popup.js', 'assets/icons.js']) new vm.Script(fs.readFileSync(path.join(directory, file), 'utf8'));
  const popup = fs.readFileSync(path.join(directory, 'popup.js'), 'utf8');
  assert.doesNotMatch(popup, /innerHTML|eval\(|storage\.sync|cookies\./);
});

test('first-party login return is bounded, fixed-origin and does not intercept invitations or ordinary sign-in', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/extension-connect.js'), 'utf8');
  const record = { ...connectInput(1).consent, origin: publicOrigin, createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  const replacements = [];
  let stored = JSON.stringify(record);
  const location = { origin: publicOrigin, hash: '#extension-connect', replace: value => replacements.push(value) };
  const sandbox = { window: {}, document: { getElementById: () => null }, location, Date,
    sessionStorage: { getItem: () => stored, removeItem: () => { stored = null; } } };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.window.FocusTubeExtensionConnect.resumeAfterSignIn(), true);
  assert.deepEqual(replacements, ['/extension-connect.html']);
  for (const hash of ['#join=private-fixture', '#dashboard', '']) { location.hash = hash; assert.equal(sandbox.window.FocusTubeExtensionConnect.resumeAfterSignIn(), false); }
  location.hash = '#extension-connect';
  stored = JSON.stringify({ ...record, redirectUri: 'https://evil.test/' });
  assert.equal(sandbox.window.FocusTubeExtensionConnect.resumeAfterSignIn(), false);
  stored = JSON.stringify({ ...record, expiresAt: Date.now() - 1000 });
  assert.equal(sandbox.window.FocusTubeExtensionConnect.resumeAfterSignIn(), false);
  const html = fs.readFileSync(path.join(__dirname, '../public/extension-connect.html'), 'utf8');
  assert.doesNotMatch(html, /type="password"|unsafe-inline|on(?:click|submit)=/);
  assert.match(html, /id="connectForm" class="auth-form hidden" hidden/);
  assert.match(source, /classList\.toggle\('hidden', !shown\)/);
  assert.ok(source.indexOf("element('connectCancel').addEventListener") < source.indexOf('if (location.hash)'));
  new vm.Script(source);
});

test('a receipt-insert failure rolls back the course and revision, and the same request can recover', async context => {
  const fixture = await apiFixture(context);
  await fixture.send('/session');
  fixture.store.db.exec("CREATE TEMP TRIGGER reject_capture BEFORE INSERT ON extension_receipts BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;");
  const input = captureInput(fixture.account.user.id);
  const rejected = await fixture.send('/videos', input);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.code, 'CAPTURE_UNAVAILABLE');
  assert.equal(fixture.store.getUserData(fixture.account.user.id).revision, 0);
  assert.equal(fixture.store.db.prepare('SELECT count(*) AS count FROM extension_receipts').get().count, 0);
  fixture.store.db.exec('DROP TRIGGER reject_capture');
  assert.equal((await fixture.send('/videos', input)).body.outcome, 'saved');
  assert.equal(fixture.store.getUserData(fixture.account.user.id).revision, 1);
});

test('capture input is closed, injected metadata receives only a canonical ID and signal, and blocked metadata writes nothing', async context => {
  let mode = 'blocked';
  let fetchCount = 0;
  const fixture = await apiFixture(context, { fetchVideo: async (id, options) => {
    fetchCount++;
    assert.equal(id, videoId);
    assert.equal(options.signal instanceof AbortSignal, true);
    if (mode === 'blocked') throw new Error('Private provider details must not leave the server');
    if (mode === 'mismatch') return metadata('abcdefghijk');
    return metadata(id);
  } });
  const input = captureInput(fixture.account.user.id);
  for (const payload of [{ ...input, videoId: 12345678901 }, { ...input, url: 'https://evil.test/' }, { ...input, courses: {} }, { ...input, expectedAccount: String(input.expectedAccount) }, { ...input, requestId: 'not-an-id' }]) {
    assert.equal((await fixture.send('/videos', payload)).status, 400);
  }
  assert.equal(fetchCount, 0);
  const unavailable = await fixture.send('/videos', input);
  assert.equal(unavailable.status, 502);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /Private provider/);
  mode = 'mismatch';
  assert.equal((await fixture.send('/videos', input)).status, 502);
  assert.equal(fixture.store.getUserData(fixture.account.user.id).revision, 0);
  mode = 'ready';
  assert.equal((await fixture.send('/videos', input)).status, 200);
  assert.equal((await fixture.send('/videos', { ...input, videoId: 'abcdefghijk' })).status, 409);
  assert.equal(fetchCount, 3);
});

test('grants expire with their parent, are capped at thirty days and reject other allowed clients and origins', async context => {
  const secondId = 'pppppppppppppppppppppppppppppppp';
  const fixture = await apiFixture(context, { environment: { ...environment, EXTENSION_ALLOWED_IDS: `${extensionId},${secondId}` } });
  fixture.store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() + 365 * 86400000).toISOString(), fixture.account.sessionHash);
  const linked = await connection(fixture);
  const value = await fixture.send('/token', linked.exchange);
  assert.equal(value.status, 200);
  assert.ok(Date.parse(value.body.expiresAt) <= Date.now() + 30 * 86400000);
  const headers = { cookie: '', authorization: `Bearer ${value.body.token}` };
  assert.equal((await fixture.send('/session', {}, { ...headers, origin: `chrome-extension://${secondId}` })).status, 401);
  const extension = createExtensionStore(fixture.store);
  assert.throws(() => extension.principal({ grantHash: crypto.createHash('sha256').update(value.body.token).digest('hex'), extensionId, origin: ORIGINS.development }), error => error.code === 'CONNECTION_EXPIRED');
  fixture.store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1000).toISOString(), fixture.account.sessionHash);
  assert.equal((await fixture.send('/session', {}, headers)).status, 401);
  const renewed = member(fixture.store, 'fresh-session');
  const input = connectInput(renewed.user.id);
  const issued = await fixture.send('/authorize', input.consent, { origin: publicOrigin, cookie: `ft_session=${renewed.token}` });
  assert.equal(issued.status, 200);
  const code = new URLSearchParams(new URL(issued.body.redirectUrl).hash.slice(1)).get('code');
  fixture.store.db.prepare('UPDATE extension_codes SET expires_at = ?').run(Date.now() - 1000);
  assert.equal((await fixture.send('/token', { ...linked.exchange, code, state: input.consent.state, codeVerifier: input.verifier }, { cookie: '' })).status, 400);
});

test('receipt retention outlives pending requests and cleanup removes at most one hundred expired rows', context => {
  const store = memoryStore(context);
  const account = member(store);
  const extension = createExtensionStore(store);
  const input = captureInput(account.user.id);
  extension.capture(account, input, metadata());
  const old = Date.now() - 31 * 86400000;
  const insert = store.db.prepare('INSERT INTO extension_receipts (user_id, request_id, fingerprint, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)');
  store.db.transaction(() => {
    for (let index = 0; index < 205; index++) insert.run(account.user.id, crypto.randomUUID(), 'fixture', '{}', old);
  })();
  const original = store.db.prepare('SELECT receipt_json FROM extension_receipts WHERE user_id = ? AND request_id = ?').get(account.user.id, input.requestId).receipt_json;
  store.db.prepare('UPDATE extension_receipts SET created_at = ? WHERE request_id = ?').run(Date.now() - 29 * 86400000, input.requestId);
  assert.deepEqual(extension.capture(account, input), JSON.parse(original));
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM extension_receipts WHERE created_at = ?').get(old).count, 105);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM extension_receipts WHERE request_id = ?').get(input.requestId).count, 1);
});

test('source abuse budget returns bounded Retry-After and stores no raw network identifiers', async context => {
  const fixture = await apiFixture(context);
  for (let attempt = 0; attempt < 180; attempt++) assert.equal((await fixture.send('/session')).status, 200);
  const limited = await fixture.send('/session');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.ok(Number(limited.headers.get('retry-after')) <= 900);
  const keys = fixture.store.db.prepare('SELECT budget_key_hash FROM login_budgets').all();
  assert.ok(keys.every(row => /^[a-f0-9]{64}$/.test(row.budget_key_hash)));
});

test('independent SQLite workers capture once, preserve simultaneous app edits and replay after reopening', { timeout: 15000 }, async context => {
  const { Worker } = require('node:worker_threads');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'focustube-capture-sqlite-'));
  const filename = path.join(directory, 'fixture.db');
  const store = memoryStore(context, filename);
  const account = member(store);
  const extension = createExtensionStore(store);
  const input = captureInput(account.user.id);
  assert.equal(extension.capture(account, input), null);
  const second = memoryStore(context, filename);
  second.saveUserData(account.user.id, { courses: { manual: { id: 'manual', title: 'App edit', videos: [], completed: {}, positions: {} } }, stats: { seconds: { today: 42 } }, settings: { volume: 17 }, workspace: { tasks: { keep: { title: 'Concurrent task' } } } }, 0);
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const path = require('node:path');
    const localRequire = require('node:module').createRequire(path.join(workerData.root, 'db.js'));
    const Database = localRequire('better-sqlite3');
    const container = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(workerData.root, 'db.js'), 'utf8'), {
      module: container, __dirname: workerData.root,
      require(name) {
        if (name === 'better-sqlite3') return class FixtureDatabase extends Database { constructor() { super(workerData.filename); } };
        if (name === 'fs') return { mkdirSync() {} };
        return localRequire(name);
      }
    });
    const store = container.exports;
    const extension = localRequire('./extension-store').createExtensionStore(store);
    parentPort.once('message', () => {
      try {
        const receipt = extension.capture({ sessionHash: workerData.sessionHash }, workerData.input, workerData.metadata);
        store.db.close();
        parentPort.postMessage({ receipt });
      } catch (error) {
        if (store.db.open) store.db.close();
        throw error;
      }
    });
    parentPort.postMessage({ ready: true });
  `;
  const workers = [input, captureInput(account.user.id)].map(payload => {
    const worker = new Worker(workerCode, { eval: true, workerData: { root: path.join(__dirname, '..'), filename, sessionHash: account.sessionHash, input: payload, metadata: metadata() } });
    let receipt;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    worker.on('message', value => { if (value.ready) readyResolve(); else receipt = value.receipt; });
    const complete = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error('SQLite worker failed')); else resolve(receipt); });
    });
    context.after(async () => { if (worker.threadId !== -1) await worker.terminate(); });
    return { worker, ready, complete };
  });
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.worker.postMessage('capture');
  const receipts = await Promise.all(workers.map(worker => worker.complete));
  assert.equal(receipts[0].courseId, receipts[1].courseId);
  assert.deepEqual(receipts.map(receipt => receipt.outcome).sort(), ['existing', 'saved']);
  const data = store.getUserData(account.user.id);
  assert.equal(data.revision, 2);
  assert.equal(Object.keys(data.courses).length, 2);
  assert.equal(data.workspace.tasks.keep.title, 'Concurrent task');
  assert.equal(data.stats.seconds.today, 42);
  assert.equal(data.settings.volume, 17);
  store.db.close();
  const reopened = memoryStore(context, filename);
  assert.equal(createExtensionStore(reopened).capture(account, input).courseId, videoId);
  assert.equal(reopened.db.pragma('quick_check')[0].quick_check, 'ok');
  assert.equal(reopened.db.pragma('foreign_key_check').length, 0);
  reopened.db.close();
});

test('restarted workers expose interrupted saves without dispatching and reject stale popup bindings', async () => {
  const fixture = workerFixture();
  await fixture.worker.handle({ type: 'open', url: `https://youtu.be/${videoId}` });
  fixture.local.capture.pending.push({ requestId: crypto.randomUUID(), videoId, environment: 'production', accountId: 1, createdAt: Date.now(), retryAt: 0 });
  fixture.session.view.phase = 'saving';
  const requestCount = fixture.requests.length;
  const restarted = fixture.create();
  const result = await restarted.handle({ type: 'state' });
  assert.equal(result.state.phase, 'uncertain');
  assert.equal(result.state.pending[0].running, false);
  assert.equal(fixture.requests.length, requestCount);
  const changed = await restarted.handle({ type: 'save', environment: 'development', expectedAccount: 1, videoId });
  assert.equal(changed.error.code, 'ACTION_CHANGED');
  assert.equal(fixture.requests.length, requestCount);
});