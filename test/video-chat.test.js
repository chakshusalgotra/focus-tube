'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTranscript, parseTranscript, validateAnswer, validateNoteDraft, buildContext, streamResponse, createVideoChat, createGeminiProvider } = require('../video-chat');
const { createChatStore, validateChatBackup } = require('../video-chat-store');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');

function storage(context) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE user_data (user_id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1), (2); INSERT INTO user_data VALUES (1), (2); CREATE TABLE video_notes (user_id INTEGER, course_id TEXT, video_id TEXT, document_json TEXT, revision INTEGER);');
  const chat = createChatStore(db);
  context.after(() => db.close());
  return { db, chat };
}

const cues = [
  { start: 0, end: 4, text: 'A partition contains a subset of the data.' },
  { start: 3.5, end: 10, text: 'A shuffle moves data between partitions.' },
];

function clientFixture(options) {
  const elements = new Map();
  const makeElement = tag => {
    const classes = new Set();
    let text = '';
    let id = '';
    return {
      tagName: tag.toUpperCase(), children: [], listeners: {}, attributes: {}, value: '', checked: false, disabled: false,
      scrollHeight: 1000, scrollTop: 100, clientHeight: 120,
      classList: { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value), toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
      set id(value) { id = value; elements.set('#' + value, this); }, get id() { return id; },
      set textContent(value) { text = String(value); if (id === 'chatLiveAnswer') options.onText?.(text); }, get textContent() { return text; },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, listener) { this.listeners[name] = listener; }, focus() {},
    };
  };
  const find = selector => {
    if (!elements.has(selector)) { const element = makeElement('div'); element.id = selector.slice(1); }
    return elements.get(selector);
  };
  const window = { NotebookModel: require('../public/notebook-model'), addEventListener() {} };
  const vm = require('node:vm');
  vm.runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/video-chat.js'), 'utf8'), {
    window, document: { querySelector: find, createElement: makeElement }, fetch: options.fetch, crypto, structuredClone,
    AbortSignal, AbortController, DOMException, TextEncoder, TextDecoder, setTimeout, clearTimeout, confirm: () => true,
  });
  find('#chatScope').value = 'moment';
  const controller = new window.VideoChat(options);
  return { controller, find };
}

test('chat transcripts preserve zero timestamps, overlaps, language and stable source identities', () => {
  const transcript = normalizeTranscript(cues, { language: 'hi-IN' });
  assert.equal(transcript.segments[0].start, 0);
  assert.equal(transcript.segments[1].start, 3.5);
  assert.equal(transcript.segments[0].id, 's1');
  assert.equal(transcript.language, 'hi-IN');
  assert.equal(transcript.hash, normalizeTranscript(cues, { language: 'hi-IN' }).hash);
  assert.notEqual(transcript.hash, normalizeTranscript(cues).hash);
  for (const input of [[], null, [cues[1], cues[0]], [{ start: -1, end: 1, text: 'bad' }],
    [{ start: 0, end: 0, text: 'bad' }], [{ start: 0, end: Infinity, text: 'bad' }],
    [{ start: 0, end: 14402, text: 'long' }], [{ start: 0, end: 1, text: ' ' }],
    Array.from({ length: 200 }, (_, index) => ({ start: index, end: index + 1, text: 'x'.repeat(10000) }))]) {
    assert.throws(() => normalizeTranscript(input));
  }
  assert.throws(() => normalizeTranscript(cues, { durationSeconds: 5 }));
});

test('chat citations resolve only supplied segment IDs and never model timestamps or URLs', () => {
  const transcript = normalizeTranscript(cues);
  const result = validateAnswer({ supported: true, answer: 'A shuffle moves data.', segmentIds: ['s1', 's2', 's1'], seconds: 900, url: 'javascript:alert(1)' }, transcript);
  assert.deepEqual(result.citations.map(citation => citation.seconds), [0, 3]);
  assert.equal(Object.hasOwn(result, 'url'), false);
  for (const segmentIds of [[], ['not-a-segment'], [1]]) {
    assert.throws(() => validateAnswer({ supported: true, answer: 'Answer', segmentIds }, transcript));
  }
  const missing = validateAnswer({ supported: false, answer: 'Unverified model speculation', segmentIds: [] }, transcript);
  assert.equal(missing.supported, false);
  assert.deepEqual(missing.citations, []);
  assert.doesNotMatch(missing.answer, /speculation/);
});

test('SRT and VTT uploads use the subtitle parser and keep timestamps in seconds', () => {
  for (const text of ['1\n00:00:00,000 --> 00:00:04,000\nHello\n', 'WEBVTT\n\n00:00.000 --> 00:04.000\nHello\n']) {
    const transcript = parseTranscript(text);
    assert.equal(transcript.segments[0].start, 0);
    assert.equal(transcript.segments[0].end, 4);
    assert.equal(transcript.segments[0].text, 'Hello');
  }
  assert.throws(() => parseTranscript('An untimed transcript is not valid.'));
});

test('chat records isolate users, enforce revisions and preserve the usage ledger through clears', context => {
  const { db, chat } = storage(context);
  const transcript = normalizeTranscript(cues);
  const thread = chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  assert.equal(chat.get(2, 'course1', 'aqz-KE-bpKQ').transcript, null);
  assert.throws(() => chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false), /changed/);
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'one', revision: thread.revision, maximumCost: 10, budgetMicros: 15 };
  chat.reserve(request);
  assert.throws(() => chat.reserve({ ...request, requestId: crypto.randomUUID() }), /changed/);
  assert.throws(() => chat.clear(1, 'course1', 'aqz-KE-bpKQ', thread.revision), /changed/);
  const answer = validateAnswer({ supported: true, answer: 'Answer', segmentIds: ['s1'] }, transcript);
  const message = { id: request.requestId, question: 'Question?', ...answer, createdAt: new Date().toISOString() };
  chat.finish(request.requestId, 10, message);
  assert.deepEqual(chat.reserve(request).previous.message, message);
  assert.throws(() => chat.reserve({ ...request, userId: 2 }), /changed/);
  const exported = chat.exportRecords(1);
  assert.equal(validateChatBackup(exported)[0].messages[0].citations[0].seconds, 0);
  const cleared = chat.clear(1, 'course1', 'aqz-KE-bpKQ', 2);
  assert.equal(cleared.messages.length, 0);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS spent FROM video_chat_usage').get().spent, 10);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM video_chat_usage').all()), /Question\?|Answer|partition contains/);
  assert.throws(() => chat.reserve({ ...request, requestId: crypto.randomUUID(), revision: cleared.revision }), /budget/);
  assert.throws(() => chat.reserve(request), /changed/);
  db.transaction(() => chat.restore(2, exported))();
  assert.equal(chat.get(2, 'course1', 'aqz-KE-bpKQ').messages.length, 1);
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS spent FROM video_chat_usage').get().spent, 10, 'Account deletion must not erase monthly spending');
});

test('interrupted requests keep conservative charges and malformed backup citations are rejected', context => {
  const { db, chat } = storage(context);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const requestId = crypto.randomUUID();
  chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: 'one', revision: 1, maximumCost: 100, budgetMicros: 100 });
  chat.finish(requestId, null, null);
  assert.equal(db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 100);
  const records = chat.exportRecords(1);
  records[0].messages = [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: 'Question?', answer: 'Unsupported', supported: true, citations: [{ id: 'fake', seconds: 5 }] }];
  assert.throws(() => validateChatBackup(records), /linked/);
});

async function apiFixture(context, overrides = {}) {
  const { db, chat } = storage(context);
  const calls = [];
  const store = { db, chat, getUserById: id => ({ id, is_guest: 0, is_admin: id === 1 ? 1 : 0, account_state: 'active' }),
    getSessionUser: session => ({ id: Number(session), is_guest: 0, account_state: 'active' }),
    getNotebook: (userId, courseId) => ({ notesRevision: 0, records: db.prepare('SELECT * FROM video_notes WHERE user_id = ? AND course_id = ?').all(userId, courseId)
      .map(row => ({ videoId: row.video_id, document: JSON.parse(row.document_json), revision: row.revision })) }),
    getUserData: () => ({ courses: { course1: { title: 'Course', videos: [{ id: 'aqz-KE-bpKQ', title: 'Lesson', durationSeconds: 100 }] } } }) };
  const express = require('express');
  const app = express();
  app.use(express.json());
  const auth = { requireAuth(req, res, next) { if (!req.get('x-test-user')) return res.status(401).end(); req.user = { id: Number(req.get('x-test-user')) }; req.sessionHash = req.get('x-test-user'); next(); } };
  const provider = overrides.provider || {
    async count(prompt) { calls.push(JSON.parse(prompt)); return 500; },
    async generate() { return { text: JSON.stringify({ answer: 'A partition holds part of the data.', supported: true, segmentIds: ['s1'] }), cost: 120, complete: true }; },
  };
  app.use('/chat', createVideoChat(store, auth, { provider, timeoutMs: overrides.timeoutMs, heartbeatMs: overrides.heartbeatMs,
    environment: { VIDEO_CHAT_ENABLED: '1', GEMINI_API_KEY: 'fixture-only', VIDEO_CHAT_ALLOWED_USER_IDS: '2', ...overrides.environment } }).router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/chat/course1/videos/aqz-KE-bpKQ`;
  const request = async (suffix = '', body, user = 1, method = body ? 'POST' : 'GET') => {
    const response = await fetch(endpoint + suffix, { method, headers: { 'x-test-user': String(user), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  return { request, db, chat, calls, endpoint, store };
}

test('chat API requires source consent, owns conversations, and replays completed requests without new inference', async context => {
  const { request, calls } = await apiFixture(context);
  assert.equal((await request('', undefined, 2)).body.transcript, null);
  const body = { requestId: crypto.randomUUID(), question: 'What is a partition?', playhead: 0, revision: 1, consent: true };
  assert.equal((await request('/messages', { ...body, consent: false })).status, 400);
  const response = await request('/messages', body);
  assert.equal(response.status, 200);
  assert.equal(response.body.message.citations[0].seconds, 0);
  assert.equal(calls[0].playhead, 0);
  assert.deepEqual((await request('/messages', body)).body, response.body);
  assert.equal(calls.length, 1);
  assert.equal((await request('/messages', body, 2)).status, 409);
  assert.equal((await request('/transcript', { source: 'upload', text: 'bad', revision: 2 }, 1, 'PUT')).status, 400);
  assert.equal((await request('', { revision: 2 }, 1, 'DELETE')).status, 200);
});

test('disabled chat and excessive context make no generation calls; invalid model citations are not saved', async context => {
  const disabled = await apiFixture(context, { environment: { VIDEO_CHAT_ENABLED: '0' } });
  const body = { requestId: crypto.randomUUID(), question: 'Question?', revision: 1, consent: true };
  assert.equal((await disabled.request('/messages', body)).status, 403);
  assert.equal(disabled.calls.length, 0);
  let generated = 0;
  const oversized = await apiFixture(context, { provider: { async count() { return 100001; }, async generate() { generated++; } } });
  assert.equal((await oversized.request('/messages', body)).status, 413);
  assert.equal(generated, 0);
  assert.equal(oversized.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 0);
  const bad = await apiFixture(context, { provider: { async count() { return 100; }, async generate() {
    return { complete: true, cost: 70, text: JSON.stringify({ answer: 'Fake evidence', supported: true, segmentIds: ['fake'] }) };
  } } });
  assert.equal((await bad.request('/messages', body)).status, 502);
  assert.equal(bad.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.equal(bad.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 70);
});

test('NDJSON delivers provisional text before completion and replays only the committed final', async context => {
  let finish;
  let generations = 0;
  const fixture = await apiFixture(context, { provider: {
    async count() { return 100; },
    async generate(_prompt, _signal, onText) {
      generations++;
      const wait = new Promise(resolve => { finish = resolve; });
      await onText('Early text');
      await wait;
      return { complete: true, cost: 3, text: JSON.stringify({ answer: 'Early text finished', supported: true, segmentIds: ['s1'] }) };
    },
  } });
  const body = { requestId: crypto.randomUUID(), question: 'Question?', revision: 1, consent: true };
  const send = () => fetch(fixture.endpoint + '/messages', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-test-user': '1', accept: 'application/x-ndjson',
  }, body: JSON.stringify(body) });
  const response = await send();
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('Early text')) text += decoder.decode((await reader.read()).value, { stream: true });
  assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.doesNotMatch(text, /"final"|"citations"|"proposal"/);
  finish();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); }
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['start', 'text', 'final']);
  assert.equal(events[2].message.citations[0].seconds, 0);
  const replay = (await (await send()).text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replay.map(event => event.type), ['start', 'final']);
  assert.equal(generations, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 1);
});

test('context scopes use real playheads and the entire selected completed discussion', () => {
  const segments = [0, 45, 190, 300, 361, 450].map((start, index) => ({ id: `s${index + 1}`, start, end: start + 4, text: 'Caption' }));
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: `message-${index}`, question: 'Question', answer: 'Answer', citations: [{ id: 's1' }] }));
  const thread = { transcript: { segments }, messages };
  assert.deepEqual(buildContext(thread, { scope: 'moment', playhead: 300 }).transcript.map(segment => segment.start), [190, 300]);
  assert.equal(buildContext(thread, { scope: 'moment', playhead: 0 }).transcript[0].start, 0);
  assert.throws(() => buildContext(thread, { scope: 'moment', playhead: null }), /playback/);
  assert.equal(buildContext(thread, { scope: 'video' }).recentConversation.length, 4);
  assert.equal(buildContext(thread, { scope: 'discussion' }).recentConversation.length, 8);
  assert.equal(buildContext(thread, { scope: 'discussion' }).transcript.length, 1);
  assert.throws(() => buildContext(thread, { scope: 'discussion', messageIds: ['missing'] }), /completed/);
});

test('a revoked session cannot commit an otherwise valid completed answer', async context => {
  let fixture;
  fixture = await apiFixture(context, { provider: { async count() { return 50; }, async generate() {
    fixture.store.getSessionUser = () => null;
    return { complete: true, cost: 4, text: JSON.stringify({ answer: 'Answer', supported: true, segmentIds: ['s1'] }) };
  } } });
  const result = await fixture.request('/messages', { requestId: crypto.randomUUID(), question: 'Question', revision: 1, consent: true });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'SESSION_CHANGED');
  assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 4);
});

test('chat rejects a stale account header before reading history or reserving provider work', async context => {
  const fixture = await apiFixture(context);
  const response = await fetch(fixture.endpoint, { headers: { 'x-test-user': '2', 'X-Video-Chat-Account': '1' } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SESSION_CHANGED');
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 0);
});

test('the daily cap reuses the ledger and successful replay does not spend another request', context => {
  const { chat, db } = storage(context);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  for (let index = 0; index < 20; index++) {
    const requestId = crypto.randomUUID();
    chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: String(index), revision: 1, maximumCost: 1, budgetMicros: 100 });
    chat.finish(requestId, 0, null);
    db.prepare('UPDATE video_chat_usage SET created_at = ? WHERE request_id = ?').run(today, requestId);
  }
  assert.throws(() => chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'limit', revision: 1, maximumCost: 1, budgetMicros: 100 }), error => error.code === 'CHAT_DAILY_LIMIT');
});

test('stream timeout settles unknown usage, ends the response and never commits a late result', async context => {
  let finish;
  const fixture = await apiFixture(context, { timeoutMs: 40, heartbeatMs: 5, provider: {
    async count() { return 5; }, generate() { return new Promise(resolve => { finish = resolve; }); },
  } });
  const response = await fetch(fixture.endpoint + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': '1', accept: 'application/x-ndjson' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), question: 'Question', revision: 1, consent: true }) });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, 'CHAT_TIMEOUT');
  assert.ok(events.some(event => event.type === 'heartbeat'));
  finish({ complete: true, cost: 1, text: '{}' });
  assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 26536);
});

test('NDJSON writer waits for drain, aborts blocked writes and bounds records', async () => {
  const { EventEmitter } = require('node:events');
  class Response extends EventEmitter {
    status() { return this; }
    set() { return this; }
    flushHeaders() {}
    write(line) { this.last = line; return false; }
    end() { this.writableEnded = true; }
  }
  const response = new Response();
  const controller = new AbortController();
  const delivery = streamResponse(response, controller.signal, 15000);
  try {
    let drained = false;
    const first = delivery.send({ type: 'text', text: 'First' }).then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    response.emit('drain');
    await first;
    assert.equal(drained, true);
    await assert.rejects(delivery.send({ type: 'text', text: 'x'.repeat(129 * 1024) }), /limit/);
    const blocked = delivery.send({ type: 'text', text: 'Blocked' });
    controller.abort();
    await assert.rejects(blocked, { name: 'AbortError' });
    assert.equal(response.listenerCount('drain'), 0);
  } finally { delivery.close(); }
});

test('disconnecting a stream cancels dispatched work and retains its unknown reservation', async context => {
  let began;
  let stopped;
  const started = new Promise(resolve => { began = resolve; });
  const aborted = new Promise(resolve => { stopped = resolve; });
  const fixture = await apiFixture(context, { provider: {
    async count() { return 10; },
    async generate(_prompt, signal, onText) {
      await onText('Partial');
      began();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { stopped(); reject(signal.reason); }, { once: true }));
    },
  } });
  const response = await fetch(fixture.endpoint + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': '1', accept: 'application/x-ndjson' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), question: 'Question', revision: 1, consent: true }) });
  await started;
  await response.body.cancel();
  await aborted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 26536);
  assert.equal(fixture.db.prepare('SELECT state FROM video_chat_usage').get().state, 'failed');
});

test('validated proposals bind source times and completed messages, and backups round-trip them', async context => {
  const fixture = await apiFixture(context);
  const requestId = crypto.randomUUID();
  const result = await fixture.request('/messages', { requestId, question: 'Summarize for my notes', mode: 'note_draft', scope: 'video', revision: 1, consent: true });
  assert.equal(result.status, 200);
  const proposal = result.body.message.proposal;
  assert.equal(proposal.id, `p_${requestId}`);
  assert.equal(proposal.blocks[0].seconds, 0);
  assert.equal(proposal.suggested, true);
  assert.equal(proposal.courseId, 'course1');
  assert.equal(proposal.videoId, 'aqz-KE-bpKQ');
  const records = fixture.chat.exportRecords(1);
  assert.deepEqual(validateChatBackup(records)[0].messages[0].proposal, proposal);
  const transcript = normalizeTranscript(cues);
  const binding = { requestId, courseId: 'course1', videoId: 'aqz-KE-bpKQ' };
  const blocks = [{ kind: 'heading', text: 'Discussion', segmentIds: [], messageIds: [] },
    { text: 'The learner asked about partitions.', messageIds: [requestId], segmentIds: [] }];
  assert.deepEqual(validateNoteDraft({ blocks }, transcript, [{ id: requestId }], binding).blocks.map(block => block.seconds), [null, null]);
  assert.throws(() => validateNoteDraft({ blocks }, transcript, [], binding), /linked/);
  assert.throws(() => validateNoteDraft({ blocks: [{ text: 'No evidence', segmentIds: ['fake'] }] }, transcript, [], binding), /linked/);
  assert.throws(() => validateNoteDraft({ blocks: [{ text: 'Invented time', segmentIds: ['s1'], seconds: 44 }] }, transcript, [], binding), /linked/);
  records[0].messages[0].proposal.blocks[0].seconds = 99;
  assert.throws(() => validateChatBackup(records), /source time/);
  delete records[0].messages[0].proposal;
  assert.equal(validateChatBackup(records)[0].messages[0].proposal, undefined, 'Older chat backups remain valid');
});

test('unsupported and malformed drafts cannot expose actionable notes or persist unchecked content', async context => {
  for (const [supported, segmentIds, noteDraft, expectedStatus] of [[false, [], undefined, 200],
    [true, ['s1'], { blocks: [{ text: 'Fabricated', segmentIds: ['unknown'] }] }, 502]]) {
    const fixture = await apiFixture(context, { provider: { async count() { return 1; }, async generate() {
      return { complete: true, cost: 2, text: JSON.stringify({ answer: 'Unverified', supported, segmentIds, noteDraft }) };
    } } });
    const result = await fixture.request('/messages', { requestId: crypto.randomUUID(), question: 'Summarize', revision: 1, consent: true });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.body.message?.proposal, undefined);
    assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, supported ? 0 : 1);
  }
});

test('note confirmation preflight checks source, latest revision, edited text and profile quota without writing', async context => {
  const fixture = await apiFixture(context);
  const requestId = crypto.randomUUID();
  const answer = await fixture.request('/messages', { requestId, question: 'Question', revision: 1, consent: true });
  const thread = fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ');
  const body = { proposalId: answer.body.message.proposal.id, texts: ['Edited preview'], generation: thread.generation,
    sourceHash: thread.transcript.hash, document: null, noteRevision: 0 };
  const result = await fixture.request('/notes/validate', body);
  assert.equal(result.status, 200);
  assert.equal(result.body.proposal.blocks[0].text, 'Edited preview');
  assert.equal(result.body.proposal.blocks[0].seconds, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_notes').get().count, 0);
  assert.equal((await fixture.request('/notes/validate', { ...body, sourceHash: 'b'.repeat(64) })).status, 409);
  assert.equal((await fixture.request('/notes/validate', { ...body, texts: [''] })).status, 502);
  fixture.db.prepare('INSERT INTO video_notes VALUES (?, ?, ?, ?, ?)').run(1, 'other', 'jNQXAC9IVRw', 'x'.repeat(5 * 1024 * 1024), 1);
  assert.equal((await fixture.request('/notes/validate', body)).status, 413);
  fixture.db.prepare('INSERT INTO video_notes VALUES (?, ?, ?, ?, ?)').run(1, 'course1', 'aqz-KE-bpKQ', JSON.stringify({ version: 1, ops: [
    { insert: 'New manual edit' }, { insert: '\n', attributes: { blockId: 'manual' } },
  ] }), 2);
  assert.equal((await fixture.request('/notes/validate', body)).body.code, 'NOTE_CHANGED');
});

test('profile exports include chats and stale imports cannot reset conversations or the billing ledger', context => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8'), {
    module, Buffer, __dirname: path.join(__dirname, '..'), require(name) {
      if (name === 'better-sqlite3') return class extends Database { constructor() { super(':memory:'); } };
      if (name === 'fs') return { mkdirSync() {} };
      return require(name);
    },
  });
  const store = module.exports;
  context.after(() => store.db.close());
  const owner = store.createUser({ isGuest: true });
  store.saveUserData(owner.id, { courses: {}, stats: {}, settings: {}, workspace: {} }, 0);
  store.chat.saveTranscript(owner.id, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const exported = store.getExportData(owner.id);
  assert.equal(exported.schemaVersion, 3);
  assert.equal(exported.videoChats[0].transcript.segments[0].start, 0);
  assert.equal(exported.source.chatRevision, 1);
  assert.equal(Object.hasOwn(exported, 'video_chat_usage'), false);
  const imported = { ...exported, dailyActivity: [], watchHistory: [] };
  store.chat.clear(owner.id, 'course1', 'aqz-KE-bpKQ', 1, true);
  assert.equal(store.importUserData(owner.id, imported, 1, 0, 1), null);
  assert.equal(store.importUserData(owner.id, imported, 1, 0, 2), 2);
  assert.ok(store.chat.get(owner.id, 'course1', 'aqz-KE-bpKQ').revision > 2);
  const next = store.getUserData(owner.id);
  assert.equal(store.importUserData(owner.id, { ...imported, videoChats: [] }, 2, next.notesRevision, next.chatRevision), 3);
  assert.equal(store.chat.get(owner.id, 'course1', 'aqz-KE-bpKQ').transcript, null);
});

test('cancellation keeps the unknown charge and never stores an interrupted answer', async context => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const fixture = await apiFixture(context, { provider: {
    async count() { return 100; },
    async generate(_prompt, signal) {
      began();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true }));
    },
  } });
  const requestId = crypto.randomUUID();
  const answer = fixture.request('/messages', { requestId, question: 'Question?', revision: 1, consent: true });
  await started;
  assert.equal((await fixture.request('/cancel', { requestId })).status, 204);
  assert.equal((await answer).status, 502);
  assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 26536);
});

test('the official Gemini adapter uses the supported model, minimal thinking and current token prices', async () => {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    assert.match(String(url), /^https:\/\/generativelanguage.googleapis.com\//);
    assert.match(String(url), /models\/gemini-3\.1-flash-lite:/);
    const body = String(url).includes('countTokens') ? { totalTokens: 100 } : {
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '{"answer":"Answer","supported":true,"segmentIds":["s1"]}' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 },
    };
    const streaming = String(url).includes('streamGenerateContent');
    return new Response(streaming ? `data: ${JSON.stringify(body)}\n\n` : JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' },
    });
  };
  try {
    const provider = createGeminiProvider('fixture-key-never-sent');
    assert.equal(await provider.count('Transcript', new AbortController().signal), 612);
    const result = await provider.generate('Transcript', new AbortController().signal);
    assert.equal(result.complete, true);
    assert.equal(result.cost, 70);
    assert.match(requests[1].url, /streamGenerateContent/);
    assert.equal(requests[1].body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(requests[1].body.generationConfig.maxOutputTokens, 1024);
    assert.equal(requests[1].body.tools, undefined);
    assert.match(requests[1].body.systemInstruction.parts[0].text, /untrusted data/);
  } finally { global.fetch = original; }
});

test('Gemini emits parsed answer text before provider completion, including split escapes', async () => {
  const original = global.fetch;
  const encoder = new TextEncoder();
  let release;
  let finished = false;
  const events = [];
  const chunk = (text, final = false) => encoder.encode(`data: ${JSON.stringify({
    candidates: [{ ...(final ? { finishReason: 'STOP' } : {}), content: { role: 'model', parts: [{ text }] } }],
    ...(final ? { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8 } } : {}),
  })}\n\n`);
  global.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(chunk('{"answer":"First '));
    release = () => {
      controller.enqueue(chunk('\\u00'));
      controller.enqueue(chunk('e9\\nlast","supported":true,"segmentIds":["s1"]}', true));
      finished = true;
      controller.close();
    };
  } }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await createGeminiProvider('fixture-only').generate('fixture', new AbortController().signal, async text => {
      events.push(text);
      if (events.length === 1) {
        assert.equal(finished, false);
        assert.equal(text, 'First ');
        release();
      }
    });
    assert.equal(events.join(''), 'First \u00e9\nlast');
    assert.equal(JSON.parse(result.text).answer, events.join(''));
    assert.equal(result.complete, true);
    assert.equal(result.cost, 13);
  } finally { global.fetch = original; }
});

test('Gemini rejects malformed, truncated and oversized structured streams without losing known final usage', async () => {
  const original = global.fetch;
  try {
    for (const text of ['{"answer":"unfinished', '{"answer":"Answer",bad}', '{"answer":"' + 'x'.repeat(66000)]) {
      global.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      await assert.rejects(createGeminiProvider('fixture-only').generate('fixture', new AbortController().signal), error => {
        assert.ok(['INCOMPLETE_ANSWER', 'INVALID_ANSWER', 'ANSWER_TOO_LARGE'].includes(error.code));
        assert.equal(error.chatCost, 40);
        return true;
      });
    }
    global.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"answer":"Answer","supported":true,"segmentIds":["s1"]}' }] } }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    assert.equal((await createGeminiProvider('fixture-only').generate('fixture', new AbortController().signal)).complete, false);
  } finally { global.fetch = original; }
});

test('browser stream reader bounds records, handles split UTF-8, and never accepts a truncated final', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const window = {};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../public/video-chat.js'), 'utf8'), {
    window, TextEncoder, TextDecoder, DOMException,
  });
  const encode = value => new TextEncoder().encode(value);
  const response = text => new Response(new ReadableStream({ start(controller) {
    const bytes = encode(text);
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
  const seen = [];
  const result = await window.VideoChat.readStream(response('{"type":"start"}\n{"type":"text","text":"caf\u00e9"}\n{"type":"heartbeat"}\n{"type":"final","message":{}}\n'),
    new AbortController().signal, event => seen.push(event));
  assert.equal(seen[1].text, 'caf\u00e9');
  assert.equal(result.type, 'final');
  for (const text of ['{"type":"start"}\n{"type":"text","text":"partial"}\n', '{"type":"text","text":"missing start"}\n',
    '{"type":"start"}\n{"type":"final"}', '{"type":"start"}\n{"type":"error","error":"Stopped"}\n',
    '{"type":"start"}\n{"type":"other"}\n']) {
    await assert.rejects(window.VideoChat.readStream(response(text), new AbortController().signal, () => {}));
  }
  await assert.rejects(window.VideoChat.readStream(new Response('{"type":"start"}\n' + 'x'.repeat(129 * 1024)), new AbortController().signal, () => {}), /limit/);
});

test('integrated controller streams provisionally, preserves playback context and Notes switching, and confirms without regeneration', async context => {
  let finish;
  let sawPartial;
  let calls = 0;
  const prompts = [];
  const partial = new Promise(resolve => { sawPartial = resolve; });
  const fixture = await apiFixture(context, { provider: {
    async count(prompt) { prompts.push(JSON.parse(prompt)); return 10; },
    async generate(_prompt, _signal, onText) {
      calls++;
      if (calls === 1) {
        const waiting = new Promise(resolve => { finish = resolve; });
        await onText('Partial answer');
        await waiting;
      }
      return { complete: true, cost: 1, text: JSON.stringify({ answer: 'Completed answer', supported: true, segmentIds: ['s1'] }) };
    },
  } });
  let noteWrites = 0;
  let notesOpen = false;
  let time = 0;
  let serverUser = '1';
  const errors = [];
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getCourseTitle: () => 'Course', getTime: () => time,
    notesOpen: () => notesOpen, setNotesOpen: value => { notesOpen = value; }, onOpen() {}, formatTime: value => String(value), showError: error => errors.push(error),
    onText: text => { if (text === 'Partial answer') sawPartial(); },
    fetch: (url, options) => fetch(url.replace('/api/video-chat/course1/videos/aqz-KE-bpKQ', fixture.endpoint), { ...options, headers: { ...options.headers, 'x-test-user': serverUser } }),
    appendGeneratedNote: async (proposal, binding) => {
      assert.equal(binding.isCurrent(), true);
      assert.equal(proposal.blocks[0].seconds, 0);
      noteWrites++;
      return { saved: true };
    },
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  controller.config = { available: true };
  await controller.load();
  controller.opened = true;
  find('#chatQuestion').value = 'What is here?';
  find('#chatConsent').checked = true;
  const answer = controller.ask();
  await partial;
  assert.equal(controller.data.messages.length, 0);
  assert.equal(controller.preview, null);
  assert.equal(noteWrites, 0);
  assert.equal(find('#chatMessages').scrollTop, 100, 'Streaming must not pull a reader down from earlier messages');
  time = 45;
  const pending = controller.pending;
  controller.selectTab('notes');
  assert.equal(notesOpen, true);
  assert.equal(controller.pending, pending);
  assert.equal(pending.controller.signal.aborted, false);
  finish();
  await answer;
  assert.equal(controller.data.messages.length, 1);
  assert.equal(controller.data.messages[0].context.playhead, 0);
  assert.equal(prompts[0].playhead, 0);
  const add = find('#chatMessages').children[0].children.find(child => child.textContent === 'Add to notes');
  assert.equal(add.disabled, false);
  add.listeners.click();
  assert.equal(noteWrites, 0);
  controller.cancelPreview();
  assert.equal(noteWrites, 0);
  add.listeners.click();
  await controller.appendPreview();
  assert.equal(noteWrites, 1);
  assert.equal(calls, 1, 'Copying a completed answer must not generate again');
  find('#chatQuestion').value = 'Keep my unsent question';
  await controller.ask({ scope: 'discussion', mode: 'note_draft', question: 'Summarize this discussion for notes.' });
  assert.equal(find('#chatQuestion').value, 'Keep my unsent question');
  assert.equal(prompts[1].recentConversation.length, 1);
  assert.equal(controller.preview.saved, false);
  assert.equal(controller.preview.proposal.suggested, true);
  controller.drafts.set(controller.identity.key, 'Private draft');
  serverUser = '2';
  await controller.load();
  assert.equal(controller.data.messages.length, 0);
  assert.equal(controller.previews.size, 0);
  assert.equal(controller.drafts.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(calls, 2);
});

test('note preview cancel writes nothing, confirmation is explicit, and stale sources invalidate previews', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const window = { NotebookModel: require('../public/notebook-model') };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../public/video-chat.js'), 'utf8'), {
    window, structuredClone, document: { querySelector: () => ({ textContent: '' }) },
  });
  const controller = Object.create(window.VideoChat.prototype);
  let writes = 0;
  const requestId = crypto.randomUUID();
  const transcript = normalizeTranscript(cues);
  const draft = validateNoteDraft({ blocks: [{ text: 'Preview', segmentIds: ['s1'] }] }, transcript, [], { requestId, courseId: 'course1', videoId: 'aqz-KE-bpKQ' });
  const message = { id: requestId, supported: true, proposal: draft };
  Object.assign(controller, { identity: { key: 'course1/aqz-KE-bpKQ', courseId: 'course1', videoId: 'aqz-KE-bpKQ', title: 'Lesson' },
    data: { generation: 'source-generation', transcript, messages: [message] }, previews: new Map(), session: 0, generation: 0, render() {},
    options: { getUser: () => ({ id: 1 }), getCourseTitle: () => 'Course', appendGeneratedNote: async (_draft, binding) => { assert.equal(binding.isCurrent(), true); writes++; return { saved: true }; } },
  });
  controller.offerPreview(message);
  assert.equal(writes, 0);
  controller.cancelPreview();
  assert.equal(writes, 0);
  assert.equal(controller.preview, null);
  controller.offerPreview(message);
  await Promise.all([controller.appendPreview(), controller.appendPreview()]);
  assert.equal(writes, 1);
  assert.equal(controller.preview.status, 'Saved to notes');
  controller.data.generation = 'new-source';
  controller.reconcilePreview();
  assert.equal(controller.preview, null);
  assert.equal(controller.previews.size, 0);
});

test('the chat controller ignores late loads after video changes and restores notes without recreating the editor', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const elements = new Map();
  const find = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', checked: false, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(selector);
  };
  let finish;
  const context = vm.createContext({ window: {}, document: { querySelector: find }, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: () => new Promise(resolve => { finish = resolve; }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/video-chat.js'), 'utf8'), context);
  const controller = Object.create(context.window.VideoChat.prototype);
  let notesOpen = true;
  Object.assign(controller, { generation: 0, session: 0, opened: false, pending: null, identity: { key: 'one', path: '/one' }, drafts: new Map(),
    data: { revision: 0, transcript: null, messages: [] }, controls() {}, render() {},
    options: { notesOpen: () => notesOpen, setNotesOpen: value => { notesOpen = value; }, onOpen() {} } });
  const request = controller.load();
  controller.showVideo('course2', 'jNQXAC9IVRw', 'Second video');
  finish({ ok: true, status: 200, json: async () => ({ messages: ['wrong video'], transcript: {} }) });
  await request;
  assert.equal(controller.identity.videoId, 'jNQXAC9IVRw');
  assert.equal(controller.data.messages.length, 0);
  controller.load = () => {};
  controller.open();
  assert.equal(notesOpen, false);
  controller.hide();
  assert.equal(notesOpen, true);
  controller.open();
  notesOpen = true;
  controller.hide(false);
  assert.equal(notesOpen, true, 'Explicit Notes selection must not restore an older panel state');
});