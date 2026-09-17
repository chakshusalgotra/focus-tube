'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { createAuth } = require('../auth');
const sharp = require('sharp');
const { prepareScreenshots } = require('../feedback');

const root = path.join(__dirname, '..');

function fixture(context, filename = ':memory:') {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'db.js'), 'utf8'), {
    module, Buffer, __dirname: root,
    require(name) {
      if (name === 'better-sqlite3') return class extends Database { constructor() { super(filename); } };
      if (name === 'fs') return filename === ':memory:' ? { mkdirSync() {} } : fs;
      return require(name);
    },
  }, { filename: 'db.js' });
  const store = module.exports;
  context.after(() => { if (store.db.open) store.db.close(); });
  function member(username, admin = false, guest = false) {
    const timestamp = new Date().toISOString();
    const result = store.db.prepare(`INSERT INTO users
      (username, display_name, email_normalized, email_verified_at, password_hash, salt, is_admin, is_guest, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(username, 'Private full name', guest ? null : `${username}@example.test`, guest ? null : timestamp,
        guest ? null : 'fixture-hash', guest ? null : 'fixture-salt', Number(admin), Number(guest), timestamp, timestamp);
    const token = crypto.randomBytes(32).toString('base64url');
    const session = crypto.createHash('sha256').update(token).digest('hex');
    store.createSession(session, result.lastInsertRowid, new Date(Date.now() + 86400000).toISOString());
    return { id: Number(result.lastInsertRowid), session, token };
  }
  return { store, member };
}

function report(extra = {}) {
  return { submissionId: crypto.randomUUID(), category: 'bug', visibility: 'private', title: 'Playback did not start', body: 'The play button remained paused.', ...extra };
}

function screenshot() {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  return { data, width: 1, height: 1, sourceHash: crypto.createHash('sha256').update(data).digest('hex') };
}

test('screenshot processing checks decoded format and size, strips metadata, and bounds dimensions', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#217364' } })
      .withExif({ IFD0: { Artist: 'PRIVATE_METADATA_CANARY' } }).toFormat(format).toBuffer();
    const [image] = await prepareScreenshots([original.toString('base64')]);
    const metadata = await sharp(image.data).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 120);
    assert.equal(metadata.height, 80);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(image.sourceHash, crypto.createHash('sha256').update(original).digest('hex'));
    assert.equal(image.data.includes(Buffer.from('PRIVATE_METADATA_CANARY')), false);
  }
  const large = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#fafafa' } }).png().toBuffer();
  const [resized] = await prepareScreenshots([large.toString('base64')]);
  assert.equal(resized.width, 2560); assert.equal(resized.height, 1280);
  for (const value of ['not base64', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'),
    Buffer.from('GIF89a').toString('base64'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]).toString('base64'),
    `data:image/png;base64,${screenshot().data.toString('base64')}`]) await assert.rejects(prepareScreenshots([value]), { code: 'INVALID_SCREENSHOT' });
  await assert.rejects(prepareScreenshots(Array(4).fill(screenshot().data.toString('base64'))), { code: 'SCREENSHOT_LIMIT' });
  await assert.rejects(prepareScreenshots(['A'.repeat(7 * 1024 * 1024)]), { code: 'SCREENSHOT_TOO_LARGE' });
  const excessivePixels = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(prepareScreenshots([excessivePixels.toString('base64')]), { code: 'INVALID_SCREENSHOT' });
  const frame = { create: { width: 20, height: 20, channels: 3, background: '#217364' } };
  const animated = await sharp([frame, { create: { ...frame.create, background: '#ffffff' } }], { join: { animated: true } }).webp({ delay: [100, 200] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(prepareScreenshots([animated.toString('base64')]), { code: 'INVALID_SCREENSHOT' });
  const truncated = (await sharp(frame).jpeg().toBuffer()).subarray(0, 150);
  await assert.rejects(prepareScreenshots([truncated.toString('base64')]), { code: 'INVALID_SCREENSHOT' });
  const noisy = await sharp(crypto.randomBytes(1300 * 1300 * 3), { raw: { width: 1300, height: 1300, channels: 3 } }).png().toBuffer();
  assert.ok(noisy.length < 5 * 1024 * 1024);
  await assert.rejects(prepareScreenshots([noisy.toString('base64')]), { code: 'SCREENSHOT_TOO_LARGE' });
});

test('screenshot storage quotas roll back report, reply, revision, and creation budget together', context => {
  const { store, member } = fixture(context); const owner = member('owner');
  const image = screenshot(); const input = report();
  const original = store.createFeedback(owner.session, input, 'test', undefined, [image]);
  const insert = store.db.prepare(`INSERT INTO feedback_screenshots (id, thread_id, owner_id, position, width, height, data, created_at)
    VALUES (?, ?, ?, 0, 1, 1, zeroblob(?), ?)`);
  for (let index = 0; index < 25; index++) {
    const thread = store.createFeedback(owner.session, report()).thread;
    insert.run(crypto.randomUUID(), thread.id, owner.id, 4 * 1024 * 1024 - (index === 0 ? image.data.length : 0), new Date().toISOString());
  }
  assert.equal(store.db.prepare('SELECT sum(length(data)) AS bytes FROM feedback_screenshots').get().bytes, 100 * 1024 * 1024);
  assert.equal(store.createFeedback(owner.session, input, 'test', undefined, [image]).replayed, true);
  const count = store.listFeedback(owner.session, 'mine').total;
  const reserve = () => store.reserveBudgets([{ key: crypto.createHash('sha256').update('screenshot-rollback-fixture').digest('hex'), limit: 5 }]);
  assert.throws(() => store.createFeedback(owner.session, report(), 'test', reserve, [image]), { code: 'SCREENSHOT_STORAGE_LIMIT', status: 413 });
  assert.equal(store.listFeedback(owner.session, 'mine').total, count);
  assert.throws(() => store.addFeedbackReply(owner.session, original.thread.id, { submissionId: crypto.randomUUID(), body: 'Over quota' }, reserve, [image]), { code: 'SCREENSHOT_STORAGE_LIMIT' });
  assert.equal(store.getFeedback(owner.session, original.thread.id).revision, 1);
  assert.equal(store.getFeedbackReplies(owner.session, original.thread.id).total, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM login_budgets').get().count, 0);
  assert.equal(store.createFeedback(owner.session, report()).replayed, false);
  const other = member('other');
  assert.equal(store.createFeedback(other.session, report(), 'test', undefined, [image]).replayed, false);
});

test('screenshots commit with their report or reply, and retries preserve attachment identities', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const input = report();
  const images = [screenshot()];
  store.db.exec("CREATE TRIGGER reject_screenshot BEFORE INSERT ON feedback_screenshots BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.createFeedback(owner.session, input, 'test', undefined, images), /injected/);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM feedback_threads').get().count, 0);
  store.db.exec('DROP TRIGGER reject_screenshot');
  const first = store.createFeedback(owner.session, input, 'test', undefined, images);
  const replay = store.createFeedback(owner.session, input, 'test', undefined, images);
  assert.equal(first.thread.screenshots[0].id, replay.thread.screenshots[0].id);
  assert.equal(first.thread.screenshots[0].bytes, images[0].data.length);
  assert.equal('data' in first.thread.screenshots[0], false);
  assert.throws(() => store.createFeedback(owner.session, input), { status: 409 });
  assert.throws(() => store.createFeedback(owner.session, input, 'test', undefined, [{ ...images[0], sourceHash: 'a'.repeat(64) }]), { status: 409 });
  const reply = { submissionId: crypto.randomUUID(), body: 'Reply with screenshot' };
  store.db.exec("CREATE TRIGGER reject_screenshot BEFORE INSERT ON feedback_screenshots BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.addFeedbackReply(owner.session, first.thread.id, reply, undefined, images), /injected/);
  assert.equal(store.getFeedbackReplies(owner.session, first.thread.id).total, 0);
  assert.equal(store.getFeedback(owner.session, first.thread.id).revision, 1);
  store.db.exec('DROP TRIGGER reject_screenshot');
  const result = store.addFeedbackReply(owner.session, first.thread.id, reply, undefined, images);
  assert.equal(store.addFeedbackReply(owner.session, first.thread.id, reply, undefined, images).id, result.id);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM feedback_screenshots').get().count, 2);
});

test('screenshot direct reads inherit private, hidden-thread and hidden-reply access', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const other = member('other');
  const admin = member('admin', true);
  const privateThread = store.createFeedback(owner.session, report(), 'test', undefined, [screenshot()]).thread;
  const publicThread = store.createFeedback(owner.session, report({ visibility: 'public', publicConsent: true }), 'test', undefined, [screenshot()]).thread;
  for (const session of [null, other.session]) assert.throws(() => store.getFeedbackScreenshot(session, privateThread.id, privateThread.screenshots[0].id), { status: 404 });
  for (const session of [owner.session, admin.session]) assert.equal(store.getFeedbackScreenshot(session, privateThread.id, privateThread.screenshots[0].id).data.equals(screenshot().data), true);
  assert.equal(store.getFeedbackScreenshot(null, publicThread.id, publicThread.screenshots[0].id).width, 1);
  assert.throws(() => store.getFeedbackScreenshot(admin.session, publicThread.id, privateThread.screenshots[0].id), { status: 404 });
  const reply = store.addFeedbackReply(other.session, publicThread.id, { submissionId: crypto.randomUUID(), body: 'Public reply' }, undefined, [screenshot()]);
  const image = store.getFeedbackReplies(null, publicThread.id).items[0].screenshots[0];
  store.moderateFeedbackReply(admin.session, publicThread.id, reply.id, { revision: 2, hidden: true });
  for (const session of [null, other.session, owner.session]) assert.throws(() => store.getFeedbackScreenshot(session, publicThread.id, image.id), { status: 404 });
  assert.equal(store.getFeedbackScreenshot(admin.session, publicThread.id, image.id).width, 1);
  store.updateFeedback(admin.session, publicThread.id, { revision: 3, hidden: true });
  assert.throws(() => store.getFeedbackScreenshot(other.session, publicThread.id, publicThread.screenshots[0].id), { status: 404 });
  assert.equal(store.getFeedbackScreenshot(owner.session, publicThread.id, publicThread.screenshots[0].id).width, 1);
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(admin.id);
  assert.throws(() => store.getFeedbackScreenshot(admin.session, privateThread.id, privateThread.screenshots[0].id), { status: 404 });
  assert.equal(store.db.pragma('foreign_key_check').length, 0);
});

test('forum v1 saves idempotent reports without notification jobs or external integration', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const input = report();
  let reservations = 0;
  const reserve = () => { reservations++; };
  const first = store.createFeedback(owner.session, input, 'test', reserve);
  assert.equal(first.replayed, false);
  assert.equal(store.createFeedback(owner.session, input, 'test', reserve).thread.id, first.thread.id);
  assert.equal(reservations, 1);
  assert.throws(() => store.createFeedback(owner.session, { ...input, body: 'Changed' }), { status: 409 });
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'feedback_jobs'").get().count, 0);
  assert.equal('github' in first.thread, false);
  assert.equal('notification' in first, false);
  assert.equal(store.getUserData(owner.id).revision, 0);
});

test('forum private reports and replies are restricted to the reporter and current admins', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const other = member('other');
  const admin = member('admin', true);
  const guest = member('guest', false, true);
  const privateId = store.createFeedback(owner.session, report({ title: 'Private needle' })).thread.id;
  const publicId = store.createFeedback(owner.session, report({ visibility: 'public', publicConsent: true })).thread.id;
  for (const session of [null, other.session, guest.session]) {
    assert.throws(() => store.getFeedback(session, privateId), { code: 'FEEDBACK_NOT_FOUND', status: 404 });
    assert.throws(() => store.getFeedbackReplies(session, privateId), { status: 404 });
    assert.equal(store.listFeedback(session).total, 1);
    assert.equal(store.listFeedback(session, 'public', { q: 'Private needle' }).total, 0);
    assert.equal(store.getFeedback(session, publicId).visibility, 'public');
  }
  for (const session of [owner.session, admin.session]) store.addFeedbackReply(session, privateId, { submissionId: crypto.randomUUID(), body: 'Follow-up' });
  assert.equal(store.getFeedbackReplies(owner.session, privateId).total, 2);
  assert.throws(() => store.addFeedbackReply(other.session, privateId, { submissionId: crypto.randomUUID(), body: 'Forbidden' }), { status: 404 });
  assert.throws(() => store.addFeedbackReply(guest.session, publicId, { submissionId: crypto.randomUUID(), body: 'Forbidden' }), { status: 401 });
  assert.equal(store.listFeedback(admin.session, 'public').total, 1);
  assert.equal(store.listFeedback(admin.session, 'all').total, 2);
  assert.equal(store.listFeedback(other.session, 'mine').total, 0);
  assert.throws(() => store.listFeedback(other.session, 'all'), { status: 403 });
  assert.doesNotMatch(JSON.stringify(store.getFeedback(null, publicId)), /email|example\.test|Private full name|password|salt|reporter_id/);
});

test('forum public consent and bounded input are enforced by the store, not only the form', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  for (const consent of [undefined, false]) assert.throws(() => store.createFeedback(owner.session, report({ visibility: 'public', publicConsent: consent })), { code: 'PUBLIC_CONSENT_REQUIRED' });
  for (const input of [report({ category: 'other' }), report({ visibility: 'unlisted' }), report({ publicConsent: 'true' }),
    report({ title: 'a\nb' }), report({ body: 'x'.repeat(20001) }), report({ userId: owner.id }), report({ submissionId: 'invalid' }),
    report({ title: '   ' }), report({ body: 'x'.repeat(16000), steps: 'y'.repeat(8000) })]) {
    assert.throws(() => store.createFeedback(owner.session, input), { status: 400 });
  }
  const id = store.createFeedback(owner.session, report()).thread.id;
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(owner.id);
  assert.throws(() => store.getFeedback(owner.session, id), { status: 404 });
  assert.throws(() => store.createFeedback(owner.session, report()), { status: 401 });
});

test('forum reply and parent revision roll back together; retries do not consume another slot', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const id = store.createFeedback(owner.session, report()).thread.id;
  const input = { submissionId: crypto.randomUUID(), body: '<script>literal text</script>' };
  store.db.exec("CREATE TRIGGER fail_reply_revision BEFORE UPDATE ON feedback_threads BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.addFeedbackReply(owner.session, id, input), /injected/);
  assert.equal(store.getFeedbackReplies(owner.session, id).total, 0);
  store.db.exec('DROP TRIGGER fail_reply_revision');
  let reservations = 0;
  const first = store.addFeedbackReply(owner.session, id, input, () => { reservations++; });
  assert.equal(store.addFeedbackReply(owner.session, id, input, () => { reservations++; }).id, first.id);
  assert.equal(reservations, 1);
  assert.equal(store.getFeedbackReplies(owner.session, id).items[0].body, input.body);
  assert.equal(store.getFeedback(owner.session, id).revision, 2);
  assert.throws(() => store.addFeedbackReply(owner.session, id, { ...input, body: 'Changed' }), { status: 409 });
});

test('forum admin status, hiding and locking use revisions and parent-level permissions', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const other = member('other');
  const admin = member('admin', true);
  const id = store.createFeedback(owner.session, report({ visibility: 'public', publicConsent: true })).thread.id;
  const second = store.createFeedback(owner.session, report()).thread.id;
  const replyId = store.addFeedbackReply(other.session, id, { submissionId: crypto.randomUUID(), body: 'Reply' }).id;
  assert.throws(() => store.updateFeedback(owner.session, id, { revision: 2, hidden: true }), { status: 403 });
  assert.throws(() => store.updateFeedback(admin.session, id, { revision: 1, locked: true }), { status: 409 });
  assert.throws(() => store.updateFeedback(admin.session, id, { revision: 2, visibility: 'private' }), { status: 400 });
  assert.throws(() => store.moderateFeedbackReply(admin.session, second, replyId, { revision: 1, hidden: true }), { status: 404 });
  store.moderateFeedbackReply(admin.session, id, replyId, { revision: 2, hidden: true });
  assert.equal(store.getFeedbackReplies(null, id).total, 0);
  assert.equal(store.getFeedback(null, id).replyCount, 0);
  assert.equal(store.getFeedbackReplies(admin.session, id).total, 1);
  store.updateFeedback(admin.session, id, { revision: 3, locked: true, status: 'in_progress' });
  assert.throws(() => store.addFeedbackReply(other.session, id, { submissionId: crypto.randomUUID(), body: 'More' }), { code: 'FEEDBACK_LOCKED' });
  assert.equal(store.getFeedback(admin.session, id).canReply, true);
  store.updateFeedback(admin.session, id, { revision: 4, hidden: true });
  assert.throws(() => store.getFeedback(other.session, id), { status: 404 });
  assert.equal(store.listFeedback(null).total, 0);
  assert.equal(store.getFeedback(owner.session, id).hidden, true);
  assert.equal(store.getFeedback(admin.session, id).canReply, false);
  store.updateFeedback(admin.session, id, { revision: 5, hidden: false, locked: false, status: 'resolved' });
  assert.equal(store.listFeedback(null).total, 1);
  assert.equal(store.getFeedback(other.session, id).status, 'resolved');
});

async function httpFixture(context) {
  const { store, member } = fixture(context);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const module = { exports: {} };
  const services = { emailConfigured: false, captchaSiteKey: null, async verifyCaptcha() {}, async sendVerification() { throw new Error('No email in forum tests'); } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('const cleanupTimer =')[0] + '\nmodule.exports = app;', {
    module, Buffer, URL, __dirname: root, process: { env: { PORT: String(server.address().port), LOG_LEVEL: 'silent', APP_ENV: 'test' } },
    require(name) {
      if (name === './db') return store;
      if (name === './auth') return { createAuth: (target, options) => createAuth(target, { ...options, rateSecret: Buffer.alloc(32, 1), services }) };
      if (name === './downloads') return { createDownloads: () => ({ router: require('express').Router() }) };
      return name.startsWith('.') ? require(path.join(root, name)) : require(name);
    },
  });
  server.on('request', module.exports);
  const request = (endpoint, { user, body, headers = {}, ...options } = {}) => fetch(origin + endpoint, {
    ...options, headers: { Origin: origin, 'Content-Type': 'application/json', ...(user ? { Cookie: `ft_session=${user.token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, member, request, origin };
}

test('screenshot HTTP upload validates files and direct image URLs enforce parent access and safe headers', async context => {
  const { member, request, store } = await httpFixture(context);
  const owner = member('owner'); const other = member('other'); const admin = member('admin', true);
  const image = await sharp({ create: { width: 100, height: 50, channels: 3, background: '#4a718b' } }).jpeg().toBuffer();
  const input = report({ screenshots: [image.toString('base64')] });
  const headers = { 'X-Feedback-Screenshots': '1' };
  assert.equal((await request('/api/feedback', { method: 'POST', body: input, headers })).status, 401);
  const created = await request('/api/feedback', { method: 'POST', user: owner, body: input, headers });
  assert.equal(created.status, 201);
  const thread = (await created.json()).thread;
  const url = thread.screenshots[0].url;
  const read = await request(url, { user: owner });
  assert.equal(read.status, 200); assert.equal(read.headers.get('content-type'), 'image/png');
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(read.headers.get('cross-origin-resource-policy'), 'same-origin');
  const metadata = await sharp(Buffer.from(await read.arrayBuffer())).metadata();
  assert.equal(metadata.width, 100);
  assert.equal((await request(url)).status, 404);
  assert.equal((await request(url, { user: other })).status, 404);
  assert.equal((await request(url, { user: admin })).status, 200);
  assert.equal((await request(url, { user: admin, headers: { 'X-Feedback-Account': String(owner.id) } })).status, 409);
  const replay = await request('/api/feedback', { method: 'POST', user: owner, body: input, headers });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).thread.screenshots[0].url, url);
  const invalid = await request('/api/feedback', { method: 'POST', user: owner, body: report({ screenshots: [Buffer.from('not a png').toString('base64')] }), headers });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'INVALID_SCREENSHOT');
  assert.equal(store.listFeedback(owner.session, 'mine').total, 1);
  const publicResponse = await request('/api/feedback', { method: 'POST', user: owner, body: report({ visibility: 'public', publicConsent: true, screenshots: [image.toString('base64')] }), headers });
  const publicThread = (await publicResponse.json()).thread;
  assert.equal((await request(publicThread.screenshots[0].url)).status, 200);
  const replyInput = { submissionId: crypto.randomUUID(), body: 'Attached', screenshots: [image.toString('base64')] };
  const reply = await request(`/api/feedback/${publicThread.id}/replies`, { method: 'POST', user: other, body: replyInput, headers });
  assert.equal(reply.status, 201);
  const replies = await (await request(`/api/feedback/${publicThread.id}/replies`)).json();
  assert.equal(replies.items[0].screenshots.length, 1);
  store.moderateFeedbackReply(admin.session, publicThread.id, replies.items[0].id, { revision: 2, hidden: true });
  assert.equal((await request(replies.items[0].screenshots[0].url, { user: other })).status, 404);
  assert.equal((await request(replies.items[0].screenshots[0].url, { user: admin })).status, 200);
  store.updateFeedback(admin.session, publicThread.id, { revision: 3, locked: true });
  assert.equal((await request(`/api/feedback/${publicThread.id}/replies`, { method: 'POST', user: other, body: replyInput, headers })).status, 200);
  assert.equal((await request(`/api/feedback/${publicThread.id}/replies`, { method: 'POST', user: other, body: { ...replyInput, submissionId: crypto.randomUUID() }, headers })).status, 409);
});

test('screenshot uploads keep small JSON limits, reject origin/account changes and bound upload attempts', async context => {
  const { member, request, store } = await httpFixture(context);
  const owner = member('owner'); const guest = member('guest', false, true);
  const headers = { 'X-Feedback-Screenshots': '1' };
  const oversized = report({ screenshots: ['A'.repeat(70000)] });
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: oversized })).status, 413);
  assert.equal((await request('/api/feedback', { user: guest, method: 'POST', body: oversized, headers })).status, 403);
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: oversized, headers: { ...headers, Origin: 'https://example.test' } })).status, 403);
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: oversized, headers: { ...headers, 'X-Feedback-Account': 'anonymous' } })).status, 409);
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: report({ body: 'x'.repeat(70000) }), headers })).status, 400);
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: report({ screenshots: ['A'.repeat(22 * 1024 * 1024)] }), headers })).status, 413);
  for (let attempt = 0; attempt < 28; attempt++) {
    assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: report({ screenshots: ['invalid'] }), headers })).status, 400);
  }
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: report({ screenshots: ['invalid'] }), headers })).status, 429);
  assert.equal((await request('/api/feedback', { user: owner, method: 'POST', body: report() })).status, 201);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM feedback_screenshots').get().count, 0);
});

test('forum HTTP gates auth, consent, origin, body limits and cross-account drafts', async context => {
  const { member, request } = await httpFixture(context);
  const owner = member('owner');
  const other = member('other');
  const admin = member('admin', true);
  const guest = member('guest', false, true);
  assert.equal((await request('/api/feedback')).status, 200);
  assert.equal((await (await request('/api/feedback/viewer')).json()).user, null);
  const viewer = await (await request('/api/feedback/viewer', { user: owner })).json();
  assert.deepEqual(Object.keys(viewer.user).sort(), ['id', 'isAdmin', 'name']);
  assert.equal((await request('/api/feedback', { method: 'POST', body: report() })).status, 401);
  assert.equal((await request('/api/feedback', { method: 'POST', user: guest, body: report() })).status, 403);
  for (const origin of ['', 'null', 'https://foreign.example']) assert.equal((await request('/api/feedback', {
    method: 'POST', user: owner, body: report(), headers: { Origin: origin },
  })).status, 403);
  assert.equal((await request('/api/feedback', { method: 'POST', user: owner, body: report(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/feedback', { method: 'POST', user: owner, body: report({ body: 'x'.repeat(70000) }) })).status, 413);
  assert.equal((await request('/api/feedback', { method: 'POST', user: owner, body: report({ visibility: 'public' }) })).status, 400);
  const input = report();
  const created = await request('/api/feedback', { method: 'POST', user: owner, body: input });
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal('notification' in result, false);
  const id = result.thread.id;
  assert.equal((await request('/api/feedback', { method: 'POST', user: owner, body: input })).status, 200);
  const denied = await request(`/api/feedback/${id}`, { user: other });
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), await (await request(`/api/feedback/${crypto.randomUUID()}`, { user: other })).json());
  assert.equal((await request(`/api/feedback/${id}/replies`, { user: other })).status, 404);
  const own = await request(`/api/feedback/${id}`, { user: owner });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/admin/feedback', { user: other })).status, 403);
  assert.equal((await request('/api/feedback/mine')).status, 401);
  for (const endpoint of ['/api/feedback/mine', `/api/feedback/${id}`]) {
    const mismatch = await request(endpoint, { user: other, headers: { 'X-Feedback-Account': String(owner.id) } });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, 'FEEDBACK_ACCOUNT_CHANGED');
  }
  assert.equal((await request('/api/feedback', { method: 'POST', user: other, body: report(), headers: { 'X-Feedback-Account': String(owner.id) } })).status, 409);
  assert.equal((await request('/api/feedback?page=0')).status, 400);
  assert.equal((await request('/api/feedback?q[nested]=x')).status, 400);
  for (const endpoint of [`/api/admin/feedback/${id}/publish`, `/api/admin/feedback/jobs/${id}/retry`]) {
    assert.equal((await request(endpoint, { user: admin, method: 'POST', body: {} })).status, 404);
  }
  assert.equal((await request('/api/admin/feedback/jobs', { user: admin })).status, 404);
});

test('forum creation budgets do not charge idempotent replays or anonymous reads', async context => {
  const { member, request, store } = await httpFixture(context);
  const owner = member('owner');
  const inputs = Array.from({ length: 5 }, () => report());
  for (const input of inputs) assert.equal((await request('/api/feedback', { method: 'POST', user: owner, body: input })).status, 201);
  const limited = await request('/api/feedback', { method: 'POST', user: owner, body: report() });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await request('/api/feedback', { method: 'POST', user: owner, body: inputs[4] })).status, 200);
  const budgets = store.db.prepare('SELECT count(*) AS count FROM login_budgets').get().count;
  for (let index = 0; index < 6; index++) assert.equal((await request('/api/feedback')).status, 200);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM login_budgets').get().count, budgets);
});

test('forum page is publicly served with no v2 controls and no account email serialization', async context => {
  const { member, request } = await httpFixture(context);
  const owner = member('owner');
  const response = await request('/feedback');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /src="\/feedback\.js"/);
  assert.doesNotMatch(html, /id="feedback(?:Publish|Delivery|Job)|github|src="\/(?:app|quill)\.js/i);
  const script = await (await request('/feedback.js')).text();
  assert.doesNotMatch(script, /innerHTML|localStorage|sessionStorage|github|notification/i);
  assert.equal((await request('/api/feedback/viewer', { headers: { 'X-Feedback-Account': 'anonymous' } })).status, 200);
  assert.equal((await request('/api/feedback/viewer', { user: owner, headers: { 'X-Feedback-Account': 'anonymous' } })).status, 409);
});

test('forum pagination, filters and reply counts never include private or hidden records', context => {
  const { store, member } = fixture(context);
  const owner = member('owner');
  const admin = member('admin', true);
  for (let index = 0; index < 26; index++) store.createFeedback(owner.session, report({ visibility: 'public', publicConsent: true, title: `Public report ${index}`, category: index % 2 ? 'bug' : 'request' }));
  const hiddenId = store.createFeedback(owner.session, report({ visibility: 'public', publicConsent: true, title: 'Hidden needle' })).thread.id;
  store.updateFeedback(admin.session, hiddenId, { revision: 1, hidden: true });
  store.createFeedback(owner.session, report({ title: 'Private needle' }));
  const first = store.listFeedback(null);
  const second = store.listFeedback(null, 'public', { page: 2 });
  assert.equal(first.total, 26); assert.equal(first.items.length, 25); assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 26);
  assert.equal(store.listFeedback(null, 'public', { category: 'request' }).total, 13);
  assert.equal(store.listFeedback(null, 'public', { q: 'needle' }).total, 0);
  assert.equal(store.listFeedback(owner.session, 'mine').total, 28);
  assert.equal(store.listFeedback(admin.session, 'all').total, 28);
  const id = first.items[0].id;
  for (let index = 0; index < 26; index++) store.addFeedbackReply(owner.session, id, { submissionId: crypto.randomUUID(), body: `Reply ${index}` });
  assert.equal(store.getFeedbackReplies(null, id).items.length, 25);
  assert.equal(store.getFeedbackReplies(null, id, { page: 2 }).items.length, 1);
  assert.equal(store.getFeedback(null, id).replyCount, 26);
});

test('forum restart preserves prior accounts, learning data and dormant legacy integration rows', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-forum-restart-'));
  const opened = [];
  context.after(() => { for (const store of opened) if (store.db.open) store.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'fixture.db');
  const initial = fixture(context, filename); opened.push(initial.store);
  const owner = initial.member('owner');
  const admin = initial.member('admin', true);
  const thread = initial.store.createFeedback(owner.session, report()).thread;
  const replyId = initial.store.addFeedbackReply(owner.session, thread.id, { submissionId: crypto.randomUUID(), body: 'Existing private reply' }).id;
  initial.store.db.prepare('INSERT INTO user_data (user_id, courses_json, updated_at) VALUES (?, ?, ?)')
    .run(owner.id, JSON.stringify({ fixture: { title: 'Preserved course', videos: [] } }), new Date().toISOString());
  initial.store.db.exec(`ALTER TABLE feedback_threads ADD COLUMN github_url TEXT;
    CREATE TABLE feedback_jobs (id TEXT PRIMARY KEY, thread_id TEXT, state TEXT, payload_json TEXT);`);
  initial.store.db.prepare('UPDATE feedback_threads SET github_url = ? WHERE id = ?').run('https://github.com/example/old/issues/1', thread.id);
  initial.store.db.prepare('INSERT INTO feedback_jobs VALUES (?, ?, ?, ?)').run('legacy-job', thread.id, 'pending', 'private-legacy-canary');
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const accountDigest = digest(initial.store.db.prepare('SELECT * FROM users ORDER BY id').all());
  const jobDigest = digest(initial.store.db.prepare('SELECT * FROM feedback_jobs').all());
  const imageReport = initial.store.createFeedback(owner.session, report(), 'test', undefined, [screenshot()]).thread;
  const imageReply = initial.store.addFeedbackReply(owner.session, imageReport.id, { submissionId: crypto.randomUUID(), body: 'Persisted screenshot' }, undefined, [screenshot()]);
  const imageDigest = digest(initial.store.db.prepare('SELECT * FROM feedback_screenshots ORDER BY id').all());
  initial.store.db.close();
  const reopened = fixture(context, filename); opened.push(reopened.store);
  assert.equal(digest(reopened.store.db.prepare('SELECT * FROM users ORDER BY id').all()) === accountDigest, true);
  assert.equal(digest(reopened.store.db.prepare('SELECT * FROM feedback_screenshots ORDER BY id').all()), imageDigest);
  assert.equal(reopened.store.getFeedbackScreenshot(owner.session, imageReport.id, imageReport.screenshots[0].id).data.equals(screenshot().data), true);
  assert.equal(reopened.store.getUserData(owner.id).courses.fixture.title, 'Preserved course');
  assert.equal(reopened.store.getFeedbackReplies(owner.session, thread.id).items[0].id, replyId);
  assert.equal(reopened.store.getFeedback(admin.session, thread.id).visibility, 'private');
  assert.doesNotMatch(JSON.stringify(reopened.store.getFeedback(admin.session, thread.id)), /github|legacy-canary/);
  reopened.store.createFeedback(owner.session, report());
  assert.equal(digest(reopened.store.db.prepare('SELECT * FROM feedback_jobs').all()) === jobDigest, true);
  reopened.store.db.prepare('DELETE FROM users WHERE id = ?').run(owner.id);
  assert.equal(reopened.store.getFeedback(admin.session, thread.id).visibility, 'private');
  assert.throws(() => reopened.store.getFeedback(null, thread.id), { status: 404 });
  assert.equal(reopened.store.getFeedbackScreenshot(admin.session, imageReport.id, imageReport.screenshots[0].id).data.equals(screenshot().data), true);
  assert.throws(() => reopened.store.getFeedbackScreenshot(null, imageReport.id, imageReport.screenshots[0].id), { status: 404 });
  reopened.store.db.prepare('DELETE FROM feedback_replies WHERE id = ?').run(imageReply.id);
  assert.equal(reopened.store.db.prepare('SELECT count(*) AS count FROM feedback_screenshots').get().count, 1);
  reopened.store.db.prepare('DELETE FROM feedback_threads WHERE id = ?').run(imageReport.id);
  assert.equal(reopened.store.db.prepare('SELECT count(*) AS count FROM feedback_screenshots').get().count, 0);
  assert.equal(reopened.store.db.pragma('foreign_key_check').length, 0);
});

test('forum independent connections serialize duplicate reports and replies', { timeout: 15000 }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-forum-race-'));
  const { store, member } = fixture(context, path.join(directory, 'focustube.db'));
  context.after(() => { if (store.db.open) store.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const owner = member('owner');
  async function race(input, threadId) {
    const barrier = new SharedArrayBuffer(4);
    const workers = Array.from({ length: 2 }, () => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      process.env.FOCUSTUBE_DATA_DIR = workerData.directory;
      const store = require(workerData.root + '/db');
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const data = Buffer.from(workerData.image, 'base64');
        const images = [{ data, width: 1, height: 1, sourceHash: require('node:crypto').createHash('sha256').update(data).digest('hex') }];
        const result = workerData.threadId ? store.addFeedbackReply(workerData.session, workerData.threadId, workerData.input, undefined, images)
          : store.createFeedback(workerData.session, workerData.input, 'test', undefined, images);
        parentPort.postMessage({ id: result.thread?.id || result.id });
      } catch (error) { parentPort.postMessage({ error: error.code || error.name }); }
      finally { store.db.close(); }
    `, { eval: true, workerData: { root, directory, session: owner.session, input, threadId, barrier, image: screenshot().data.toString('base64') } }));
    try {
      const finished = workers.map(worker => new Promise((resolve, reject) => {
        let result;
        worker.on('message', message => { if (!message.ready) result = message; }); worker.once('error', reject);
        worker.once('exit', code => { if (code === 0 && result) resolve(result); else reject(new Error(`SQLite worker exited with code ${code}`)); });
      }));
      await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
        worker.on('message', result => { if (result.ready) resolve(); }); worker.once('error', reject);
      })));
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      return await Promise.all(finished);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  }
  const reports = await race(report());
  assert.equal(reports.every(result => !result.error && !!result.id), true);
  assert.equal(reports[0].id, reports[1].id);
  const replies = await race({ submissionId: crypto.randomUUID(), body: 'Once only' }, reports[0].id);
  assert.equal(replies.every(result => !result.error && !!result.id), true);
  assert.equal(replies[0].id, replies[1].id);
  assert.equal(store.getFeedback(owner.session, reports[0].id).revision, 2);
  assert.equal(store.getFeedbackReplies(owner.session, reports[0].id).total, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM feedback_screenshots').get().count, 2);
});