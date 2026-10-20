'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTranscript, parseTranscript, validateAnswer, validateNoteDraft, buildContext, streamResponse, createVideoChat, createGeminiProvider } = require('../video-chat');
const { createChatStore, validateChatBackup } = require('../video-chat-store');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const { CACHE_CONSENT, EMBEDDING_VERSION, MAXIMUM_EMBEDDING_COST, createGeminiEmbeddingProvider,
  normalizeEmbedding, commonQuestionTask, canonicalQuestionTask, answerCacheDescriptor, selectSemanticAnswer, publicVideoMetadata } = require('../video-chat');

function storage(context, options) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE user_data (user_id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1), (2); INSERT INTO user_data VALUES (1), (2); CREATE TABLE video_notes (user_id INTEGER, course_id TEXT, video_id TEXT, document_json TEXT, revision INTEGER);');
  const chat = createChatStore(db, undefined, options);
  context.after(() => db.close());
  return { db, chat };
}

const cues = [
  { start: 0, end: 4, text: 'A partition contains a subset of the data.' },
  { start: 3.5, end: 10, text: 'A shuffle moves data between partitions.' },
];

test('admin settings persist, reject stale saves and immediately control budget reservations', context => {
  const { db, chat } = storage(context);
  const defaults = { monthlyBudgetCents: 100, paused: false, cacheEnabled: false, sharedCacheEnabled: false, semanticCacheEnabled: false };
  assert.equal(chat.getSettings(defaults).source, 'environment');
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'live-budget',
    revision: 1, maximumCost: 1100000, budgetMicros: 1000000 };
  assert.throws(() => chat.reserve(request), error => error.code === 'CHAT_BUDGET');
  assert.equal(chat.getQuota(1).used, 0);
  const changed = { ...defaults, monthlyBudgetCents: 500, revision: 0 };
  assert.equal(chat.saveSettings(1, changed, defaults, () => {}).revision, 1);
  chat.reserve(request);
  assert.equal(chat.getQuota(1).used, 1);
  assert.equal(createChatStore(db).getSettings(defaults).monthlyBudgetCents, 500);
  assert.throws(() => chat.saveSettings(2, changed, defaults, () => {}), error => error.code === 'CHAT_SETTINGS_CHANGED');
  assert.throws(() => chat.saveSettings(1, { ...changed, revision: 1, monthlyBudgetCents: 600 }, defaults, () => { throw new Error('Revoked administrator'); }), /Revoked/);
  assert.equal(chat.getSettings(defaults).monthlyBudgetCents, 500);
  chat.saveSettings(1, { ...changed, revision: 1, monthlyBudgetCents: 100 }, defaults, () => {});
  assert.throws(() => chat.reserveCost(request.requestId, 'generation', 1200000, 5000000), error => error.code === 'CHAT_BUDGET');
  chat.saveSettings(1, { ...changed, revision: 2, paused: true }, defaults, () => {});
  assert.throws(() => chat.reserveCost(request.requestId, 'embedding', 10, 5000000), error => error.code === 'CHAT_PAUSED');
  chat.finish(request.requestId, null, null);
  assert.equal(db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 1100000);
  for (const amount of [-1, 0.5, 100001, NaN, Infinity, '100']) assert.throws(() => chat.saveSettings(1, { ...changed, revision: 3, monthlyBudgetCents: amount }, defaults, () => {}), error => error.code === 'INVALID_CHAT_SETTINGS');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_settings_audit').get().count, 3);
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(chat.getSettings(defaults).monthlyBudgetCents, 500);
  assert.equal(chat.getSettings(defaults).updatedBy, null);
});

test('admin audit is bounded and saved settings survive database reopen outside member exports', async context => {
  const { db, chat } = storage(context);
  const defaults = { monthlyBudgetCents: 100, paused: false, cacheEnabled: false, sharedCacheEnabled: false, semanticCacheEnabled: false };
  chat.saveSettings(1, { ...defaults, revision: 0, monthlyBudgetCents: 250 }, defaults, () => {});
  const insert = db.prepare('INSERT INTO video_chat_settings_audit(revision, actor_id, before_json, after_json, created_at) VALUES (?, 1, ?, ?, ?)');
  db.transaction(() => {
    for (let revision = 2; revision <= 1003; revision++) insert.run(revision, JSON.stringify(defaults), JSON.stringify(defaults), Date.now());
    insert.run(0, JSON.stringify(defaults), JSON.stringify(defaults), Date.now() - 91 * 86400000);
    db.prepare('UPDATE video_chat_settings SET revision = 1003').run();
  })();
  chat.saveSettings(1, { ...defaults, revision: 1003, monthlyBudgetCents: 300 }, defaults, () => {});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_settings_audit').get().count, 1000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_settings_audit WHERE revision = 0').get().count, 0);
  assert.equal(chat.adminSnapshot(defaults).changes.length, 20);
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'chat-settings-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'settings.db');
  await db.backup(filename);
  const reopened = new Database(filename);
  try {
    reopened.pragma('foreign_keys = ON');
    const restored = createChatStore(reopened);
    assert.equal(restored.getSettings(defaults).monthlyBudgetCents, 300);
    assert.equal(restored.getSettings(defaults).revision, 1004);
    const exported = restored.exportRecords(1);
    assert.deepEqual(exported, []);
    restored.restore(1, exported);
    assert.equal(restored.getSettings(defaults).monthlyBudgetCents, 300);
    assert.equal(restored.adminSnapshot(defaults).changes.length, 20);
    assert.equal(reopened.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(reopened.pragma('foreign_key_check').length, 0);
  } finally { reopened.close(); }
});

test('admin currency input is exact and privileged controller bindings exist in the real markup', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../public/video-chat-admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const context = { window: {} };
  require('node:vm').runInNewContext(source, context);
  for (const [value, expected] of [['0', 0], ['5.25', 525], ['1000.00', 100000], ['1000.01', null], ['-1', null], ['1e2', null], ['1.001', null], ['', null]]) {
    assert.equal(context.window.VideoChatAdmin.cents(value), expected);
  }
  for (const match of source.matchAll(/this\.get\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), match[1]);
  assert.match(source, /AbortSignal\.timeout\(15000\)/);
  assert.match(source, /this\.ownerKey\(\)/);
  assert.doesNotMatch(source, /loadMonitoring|monitoringUsers|data-settings/);
  assert.match(source, /this\.modal\.confirmClose = \(\) => this\.requestClose\(\)/);
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /globalThis\.videoChatAdmin\?\.reset\(\)/);
  assert.match(app, /globalThis\.videoChatAdmin\?\.open\(\)/);
  assert.match(source, /values\.monthlyBudgetCents > previous\.monthlyBudgetCents/);
  assert.match(source, /capabilities\.requestsPerWindow/);
  assert.match(source, /capabilities\.requestWindowSeconds \/ 3600/);
  assert.doesNotMatch(source, /requestsPerDay|UTC day per account/);
});

test('admin spending distinguishes known, pending, retained and legacy costs without rewriting money', context => {
  const { db, chat } = storage(context);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const reserve = amount => {
    const requestId = crypto.randomUUID();
    chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: requestId, revision: 1, maximumCost: amount, budgetMicros: 1000000 });
    return requestId;
  };
  const known = reserve(30);
  chat.reserveCost(known, 'embedding', 5, 1000000);
  chat.markDispatched(known, 'embedding');
  chat.settleEmbedding(known, 3);
  chat.markDispatched(known, 'generation');
  chat.finish(known, 12, null);
  const unknown = reserve(7);
  chat.markDispatched(unknown, 'generation');
  chat.finish(unknown, null, null);
  reserve(20);
  db.prepare(`INSERT INTO video_chat_usage(request_id, user_id, course_id, video_id, generation, fingerprint, state, month, cost_micros, created_at)
    VALUES (?, NULL, 'operator', 'legacy', 'legacy', 'legacy', 'failed', ?, 10, ?)`).run(crypto.randomUUID(), new Date().toISOString().slice(0, 7), Date.now());
  const snapshot = chat.adminSnapshot({ monthlyBudgetCents: 100 });
  assert.equal(snapshot.usage.accountedMicros, 52);
  assert.equal(snapshot.usage.knownMicros, 15);
  assert.equal(snapshot.usage.pendingMicros, 20);
  assert.equal(snapshot.usage.retainedMicros, 7);
  assert.equal(snapshot.usage.legacyMicros, 10);
  assert.equal(snapshot.usage.embeddingMicros, 3);
  assert.equal(snapshot.usage.remainingMicros, 999948);
  assert.equal(chat.adminSnapshot({ monthlyBudgetCents: 100 }, Date.parse(snapshot.usage.resetsAt)).usage.accountedMicros, 0);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 52);
});

function clientFixture(options) {
  const elements = new Map();
  const events = new Map();
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
  const window = { NotebookModel: require('../public/notebook-model'), addEventListener(name, handler) { events.set('window:' + name, handler); } };
  const vm = require('node:vm');
  vm.runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/video-chat.js'), 'utf8'), {
    window, document: { querySelector: find, createElement: makeElement,
      querySelectorAll: () => [...(elements.get('#chatStarters')?.children || []), ...(elements.get('#chatFollowUps')?.children || [])],
      addEventListener(name, handler) { events.set('document:' + name, handler); } }, fetch: options.fetch, crypto, structuredClone,
    AbortSignal, AbortController, DOMException, TextEncoder, TextDecoder,
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout, confirm: options.confirm || (() => true),
  });
  find('#chatScope').value = 'moment';
  const controller = new window.VideoChat(options);
  return { controller, find, events };
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

test('YouTube captions tolerate small end drift without changing starts or relaxing source limits', () => {
  const input = [{ start: 1095, end: 1098.4, text: 'Final caption.' }];
  const options = { source: 'youtube', language: 'en', durationSeconds: 1097 };
  const transcript = normalizeTranscript(input, options);
  assert.deepEqual(transcript.segments, [{ id: 's1', start: 1095, end: 1097, text: 'Final caption.' }]);
  assert.equal(input[0].end, 1098.4);
  assert.equal(normalizeTranscript(transcript.segments, options).hash, transcript.hash);
  assert.equal(normalizeTranscript([{ ...input[0], end: 1099 }], options).segments[0].end, 1097);
  assert.throws(() => normalizeTranscript([{ ...input[0], end: 1099.01 }], options));
  assert.throws(() => normalizeTranscript([{ ...input[0], start: 1097 }], options));
  assert.throws(() => normalizeTranscript([{ ...input[0], end: Infinity }], options));
  assert.throws(() => normalizeTranscript([{ start: 14399, end: 14400.1, text: 'Too long.' }], { source: 'youtube' }));
  assert.throws(() => normalizeTranscript(input, { durationSeconds: 1097 }));
  assert.equal(normalizeTranscript(cues, { source: 'youtube', durationSeconds: 10 }).segments[0].start, 0);
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

test('follow-up suggestions are bounded, optional and preserved in conversation backups', context => {
  const { chat } = storage(context);
  const transcript = normalizeTranscript(cues);
  const answer = { answer: 'A shuffle moves data.', supported: true, segmentIds: ['s2'], followUps: [' Why does a shuffle happen? ', 'How do partitions help?'] };
  const checked = validateAnswer(answer, transcript);
  assert.deepEqual(checked.followUps, ['Why does a shuffle happen?', 'How do partitions help?']);
  for (const followUps of [['One', 'Two', 'Three'], ['x'.repeat(161)], [' '], [123], 'Not an array']) {
    assert.throws(() => validateAnswer({ ...answer, followUps }, transcript), error => error.code === 'INVALID_ANSWER');
  }
  assert.equal(validateAnswer({ ...answer, supported: false, segmentIds: [] }, transcript).followUps, undefined);
  chat.restore(1, [{ courseId: 'course1', videoId: 'aqz-KE-bpKQ', transcript, messages: [
    { id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: 'What moves?', ...checked },
  ] }]);
  assert.deepEqual(validateChatBackup(chat.exportRecords(1))[0].conversations[0].messages[0].followUps, checked.followUps);
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
  assert.throws(() => chat.reserve({ ...request, requestId: crypto.randomUUID() }), error => error.code === 'CHAT_BUSY');
  assert.throws(() => chat.clear(1, 'course1', 'aqz-KE-bpKQ', thread.revision), /changed/);
  const answer = validateAnswer({ supported: true, answer: 'Answer', segmentIds: ['s1'] }, transcript);
  const message = { id: request.requestId, question: 'Question?', ...answer, createdAt: new Date().toISOString() };
  chat.finish(request.requestId, 10, message);
  assert.deepEqual(chat.reserve(request).previous.message, message);
  assert.throws(() => chat.reserve({ ...request, userId: 2 }), /changed/);
  const exported = chat.exportRecords(1);
  assert.equal(validateChatBackup(exported)[0].conversations[0].messages[0].citations[0].seconds, 0);
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

test('six-hour quota admits thirty attempts, resets at the boundary, and persists independently of chats', context => {
  let timestamp = Date.parse('2030-01-01T09:20:00Z');
  const started = timestamp;
  const { db, chat } = storage(context, { clock: () => timestamp });
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  assert.equal(chat.getQuota(1).remaining, 30);
  assert.equal(chat.getQuota(1).resetAt, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_quota_windows').get().count, 0);
  const request = () => ({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(),
    fingerprint: 'quota', revision: 1, maximumCost: 1, budgetMicros: 1000 });
  for (let index = 0; index < 30; index++) {
    const attempt = request();
    chat.reserve(attempt);
    chat.finish(attempt.requestId, 1, null);
    assert.equal(chat.getQuota(1).remaining, 29 - index);
    timestamp += 61000;
  }
  const resetAt = started + 6 * 60 * 60 * 1000;
  assert.equal(chat.getQuota(1).resetAt, new Date(resetAt).toISOString());
  assert.equal(chat.getQuota(2).remaining, 30);
  assert.throws(() => chat.reserve(request()), error => error.code === 'CHAT_WINDOW_LIMIT' && error.status === 429 &&
    error.quota.remaining === 0 && error.retryAfterSeconds === Math.ceil((resetAt - timestamp) / 1000));
  timestamp = started - 1000;
  assert.equal(chat.getQuota(1).remaining, 0, 'Clock rollback must not reset a window');
  timestamp = resetAt - 1;
  assert.throws(() => chat.reserve(request()), error => error.code === 'CHAT_WINDOW_LIMIT' && error.retryAfterSeconds === 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 30);
  timestamp = resetAt;
  assert.equal(chat.getQuota(1).remaining, 30);
  assert.equal(chat.getQuota(1).resetAt, null);
  const renewed = request();
  chat.reserve(renewed);
  chat.finish(renewed.requestId, 1, null);
  assert.equal(chat.getQuota(1).windowStartedAt, new Date(resetAt).toISOString());
  assert.equal(chat.getQuota(1).used, 1);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS spent FROM video_chat_usage').get().spent, 31);
  const reopened = createChatStore(db, undefined, { clock: () => timestamp });
  assert.deepEqual(reopened.getQuota(1), chat.getQuota(1));
  reopened.clear(1, 'course1', 'aqz-KE-bpKQ', 1);
  reopened.restore(1, []);
  assert.equal(reopened.getQuota(1).used, 1);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_quota_windows').get().count, 0);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS spent FROM video_chat_usage').get().spent, 31);
});

test('six-hour quota reservations roll back on rejection and repeated request IDs do not spend twice', context => {
  const timestamp = Date.parse('2030-01-01T09:20:00Z');
  const { db, chat } = storage(context, { clock: () => timestamp });
  const transcript = normalizeTranscript(cues);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(),
    fingerprint: 'same-operation', revision: 1, maximumCost: 10, budgetMicros: 100, requestLimit: 1 };
  for (const invalid of [{ revision: 0 }, { budgetMicros: 0 }, { requestLimit: 0 }, { courseId: 'missing' }]) {
    assert.throws(() => chat.reserve({ ...request, ...invalid }));
    assert.equal(chat.getQuota(1).used, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 0);
  }
  chat.reserve(request);
  assert.equal(chat.getQuota(1, 1).remaining, 0);
  assert.throws(() => chat.reserve(request), error => error.code === 'REQUEST_USED');
  const message = { id: request.requestId, question: 'Question?', ...validateAnswer({ answer: 'Answer', supported: true, segmentIds: ['s1'] }, transcript), createdAt: new Date(timestamp).toISOString() };
  const completed = chat.finish(request.requestId, 2, message);
  assert.deepEqual(chat.reserve(request).previous.message, message);
  assert.equal(chat.getQuota(1, 1).used, 1);
  assert.throws(() => chat.reserve({ ...request, fingerprint: 'changed' }), error => error.code === 'CHAT_CHANGED');
  db.exec("CREATE TRIGGER fail_quota_usage BEFORE INSERT ON video_chat_usage BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END;");
  assert.throws(() => chat.reserve({ ...request, requestId: crypto.randomUUID(), revision: completed.revision, requestLimit: 30 }), /synthetic reservation failure/);
  assert.equal(chat.getQuota(1).used, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 1);
});

test('six-hour quota migration creates a fresh window state without rewriting chats or spending', context => {
  const { db, chat } = storage(context);
  const transcript = normalizeTranscript(cues);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'legacy', revision: 1, maximumCost: 10, budgetMicros: 100 };
  chat.reserve(request);
  chat.finish(request.requestId, 10, { id: request.requestId, question: 'Saved question', ...validateAnswer({ answer: 'Saved answer', supported: true, segmentIds: ['s1'] }, transcript), createdAt: new Date().toISOString() });
  const saved = chat.exportRecords(1);
  const ledgerHash = crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM video_chat_usage').all())).digest('hex');
  db.exec('DROP TABLE video_chat_quota_windows');
  const migrated = createChatStore(db);
  assert.deepEqual(migrated.exportRecords(1), saved);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM video_chat_usage').all())).digest('hex'), ledgerHash);
  assert.equal(migrated.getQuota(1).remaining, 30);
  assert.equal(migrated.getQuota(1).resetAt, null);
  assert.throws(() => migrated.reserve({ ...request, requestId: crypto.randomUUID(), revision: 2, budgetMicros: 10 }), error => error.code === 'CHAT_BUDGET');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_quota_windows').get().count, 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('one generating reply per account is enforced across videos without blocking other members', context => {
  const { chat } = storage(context);
  const transcript = normalizeTranscript(cues);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  chat.saveTranscript(1, 'course2', 'jNQXAC9IVRw', transcript, 0, false);
  chat.saveTranscript(2, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  const first = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'first', revision: 1, maximumCost: 10, budgetMicros: 100 };
  const second = { ...first, courseId: 'course2', videoId: 'jNQXAC9IVRw', requestId: crypto.randomUUID(), fingerprint: 'second' };
  chat.reserve(first);
  assert.throws(() => chat.reserve(second), error => error.code === 'CHAT_BUSY');
  assert.doesNotThrow(() => chat.reserve({ ...first, userId: 2, requestId: crypto.randomUUID() }));
  chat.finish(first.requestId, null, null);
  assert.doesNotThrow(() => chat.reserve(second));
});

test('interrupted requests keep conservative charges and malformed backup citations are rejected', context => {
  const { db, chat } = storage(context);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const requestId = crypto.randomUUID();
  chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: 'one', revision: 1, maximumCost: 100, budgetMicros: 100 });
  chat.finish(requestId, null, null);
  assert.equal(db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 100);
  const records = chat.exportRecords(1);
  records[0].conversations[0].messages = [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: 'Question?', answer: 'Unsupported', supported: true, citations: [{ id: 'fake', seconds: 5 }] }];
  assert.throws(() => validateChatBackup(records), /linked/);
});

test('cache admission and staged provider reservations retain one request and all incurred costs', context => {
  const { db, chat } = storage(context);
  const transcript = normalizeTranscript(cues);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'staged', revision: 1, maximumCost: 0, budgetMicros: 100 };
  chat.reserve(request);
  assert.equal(chat.getQuota(1).used, 1);
  chat.reserveCost(request.requestId, 'embedding', 10, 100);
  chat.settleEmbedding(request.requestId, 3);
  assert.throws(() => chat.reserveCost(request.requestId, 'generation', 100, 100), error => error.code === 'CHAT_BUDGET');
  chat.reserveCost(request.requestId, 'generation', 90, 100);
  chat.finish(request.requestId, null, null);
  assert.deepEqual(db.prepare('SELECT cost_micros, embedding_cost_micros, state FROM video_chat_usage').get(),
    { cost_micros: 93, embedding_cost_micros: 3, state: 'failed' });
  assert.equal(chat.getQuota(1).used, 1);
  const hit = { ...request, requestId: crypto.randomUUID(), fingerprint: 'hit', budgetMicros: 1 };
  chat.reserve(hit);
  const message = { id: hit.requestId, question: 'Summary', ...validateAnswer({ supported: true, answer: 'Answer', segmentIds: ['s1'] }, transcript), createdAt: new Date().toISOString() };
  chat.finish(hit.requestId, 0, message);
  assert.equal(chat.reserve(hit).previous.message.id, hit.requestId);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS cost, COUNT(*) AS count FROM video_chat_usage').get().cost, 93);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 2);
  assert.equal(chat.getQuota(1).used, 2);
  const interrupted = { ...request, requestId: crypto.randomUUID(), revision: 2 };
  chat.reserve(interrupted);
  chat.reserveCost(interrupted.requestId, 'embedding', 5, 100);
  chat.settleEmbedding(interrupted.requestId, null);
  chat.finish(interrupted.requestId, 0, null);
  assert.equal(db.prepare('SELECT cost_micros FROM video_chat_usage WHERE request_id = ?').get(interrupted.requestId).cost_micros, 5);
  assert.equal(chat.getQuota(1, 3).remaining, 0);
  assert.throws(() => chat.reserve({ ...interrupted, requestId: crypto.randomUUID(), requestLimit: 3 }), error => error.code === 'CHAT_WINDOW_LIMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 3);
});

test('answer cache persists bounded private and canonical shared entries without importing trust', context => {
  const { db, chat } = storage(context);
  const transcript = normalizeTranscript(cues, { source: 'youtube', language: 'en' });
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false, undefined, true);
  const descriptor = { key: 'private', userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', sourceHash: transcript.hash,
    contextHash: 'context', question: 'Summarize this video.', task: 'summary' };
  const value = { answer: 'A partition holds data.', supported: true, segmentIds: ['s1'] };
  assert.equal(chat.putCachedAnswer(descriptor, value, [1, 0], 'fixture'), true);
  assert.deepEqual(chat.getCachedAnswer(descriptor).value, value);
  assert.equal(chat.getCachedAnswer({ ...descriptor, userId: 2 }), null);
  assert.equal(chat.getCachedAnswer({ ...descriptor, sourceHash: 'different' }), null);
  assert.equal(chat.cacheCandidates(descriptor, 'different').length, 0);
  assert.deepEqual(chat.cachedEmbedding(1, descriptor.question, 'fixture'), [1, 0]);
  assert.equal(chat.cachedEmbedding(2, descriptor.question, 'fixture'), null);
  const shared = { ...descriptor, key: 'shared', userId: null, courseId: null };
  assert.equal(chat.putCachedAnswer(shared, value), true);
  assert.equal(chat.putCachedAnswer({ ...shared, key: 'personal', question: 'My private summary' }, value), false);
  assert.equal(chat.putCachedAnswer({ ...descriptor, key: 'unsupported' }, { ...value, supported: false }), false);
  const reopened = createChatStore(db);
  assert.deepEqual(reopened.getCachedAnswer(descriptor).value, value);
  const exported = chat.exportRecords(1);
  assert.doesNotMatch(JSON.stringify(exported), /trustedSourceHash|trusted_source_hash|answer_cache|contextHash/);
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ').trustedSourceHash, transcript.hash);
  chat.restore(1, exported);
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ').trustedSourceHash, null);
  assert.equal(chat.getCachedAnswer(descriptor), null);
  assert.ok(chat.getCachedAnswer(shared));
  const current = chat.get(1, 'course1', 'aqz-KE-bpKQ');
  assert.equal(chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, current.revision, false, undefined, true).trustedSourceHash, transcript.hash);
  for (let index = 0; index < 201; index++) chat.putCachedAnswer({ ...descriptor, key: 'entry-' + index }, value);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_answer_cache WHERE user_id = 1').get().count, 200);
  db.prepare('UPDATE video_chat_answer_cache SET created_at = ?, expires_at = ? WHERE cache_key = ?').run(Date.now() - 20000, Date.now() - 10000, 'shared');
  assert.equal(chat.getCachedAnswer(shared), null);
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_answer_cache WHERE user_id IS NOT NULL').get().count, 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('cache migration preserves populated histories, revisions and legacy spending without trusting imported captions', context => {
  const { db, chat } = storage(context);
  const transcript = normalizeTranscript(cues, { source: 'youtube' });
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  const requestId = crypto.randomUUID();
  chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: 'legacy', revision: 1, maximumCost: 99, budgetMicros: 100 });
  chat.finish(requestId, 99, { id: requestId, question: 'Legacy question', ...validateAnswer({ answer: 'Legacy answer', supported: true, segmentIds: ['s1'] }, transcript), createdAt: new Date().toISOString() });
  const records = chat.exportRecords(1);
  const revision = chat.get(1, 'course1', 'aqz-KE-bpKQ').revision;
  db.exec('DROP TABLE video_chat_answer_cache; ALTER TABLE video_chat_usage DROP COLUMN embedding_cost_micros; ALTER TABLE video_chats DROP COLUMN trusted_source_hash;');
  const before = db.prepare('SELECT * FROM video_chat_usage').all();
  for (let index = 0; index < 2; index++) {
    const migrated = createChatStore(db);
    assert.deepEqual(migrated.exportRecords(1), records);
    assert.equal(migrated.get(1, 'course1', 'aqz-KE-bpKQ').revision, revision);
    assert.equal(migrated.get(1, 'course1', 'aqz-KE-bpKQ').trustedSourceHash, null);
    assert.deepEqual(db.prepare('SELECT * FROM video_chat_usage').all().map(({ embedding_cost_micros, ...row }) => {
      assert.equal(embedding_cost_micros, 0); return row;
    }), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_answer_cache').get().count, 0);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  }
});

test('conversation migration keeps existing messages, revisions, sources and spending exactly once', context => {
  const { db } = storage(context);
  db.exec('DROP TABLE video_chat_conversations');
  const transcript = normalizeTranscript(cues);
  const generation = crypto.randomUUID();
  const message = { id: crypto.randomUUID(), question: 'Existing question', ...validateAnswer({ answer: 'Existing answer', supported: true, segmentIds: ['s1'] }, transcript), createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO video_chats (user_id, course_id, video_id, generation, transcript_json, messages_json, revision, updated_at) VALUES (1, ?, ?, ?, ?, ?, 7, ?)')
    .run('course1', 'aqz-KE-bpKQ', generation, JSON.stringify(transcript), JSON.stringify([message]), message.createdAt);
  db.prepare("INSERT INTO video_chat_usage (request_id, user_id, course_id, video_id, generation, fingerprint, state, month, cost_micros, created_at) VALUES (?, 1, ?, ?, ?, 'legacy', 'completed', ?, 123, ?)")
    .run(message.id, 'course1', 'aqz-KE-bpKQ', generation, new Date().toISOString().slice(0, 7), Date.now());
  for (let attempt = 0; attempt < 2; attempt++) {
    const chat = createChatStore(db);
    const thread = chat.get(1, 'course1', 'aqz-KE-bpKQ');
    assert.equal(thread.conversationId, 'default');
    assert.equal(thread.revision, 7);
    assert.equal(thread.generation, generation);
    assert.deepEqual(thread.messages, [message]);
    assert.equal(thread.transcript.hash, transcript.hash);
    assert.equal(thread.conversations.length, 1);
    assert.equal(db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 123);
  }
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('multiple conversations share one transcript, isolate messages and survive backup restore', context => {
  const { chat, db } = storage(context);
  const transcript = normalizeTranscript(cues);
  let current = chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 0, false);
  const originalGeneration = current.generation;
  const id = crypto.randomUUID();
  current = chat.createConversation(1, 'course1', 'aqz-KE-bpKQ', current.revision, id);
  assert.equal(current.conversationId, id);
  assert.equal(current.conversations.length, 2);
  assert.equal(current.transcript.hash, transcript.hash);
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ', 'default').generation, originalGeneration);
  assert.throws(() => chat.get(2, 'course1', 'aqz-KE-bpKQ', id), error => error.code === 'CHAT_NOT_FOUND');
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', conversationId: id, requestId: crypto.randomUUID(), fingerprint: 'second-chat', revision: current.revision, maximumCost: 10, budgetMicros: 100 };
  chat.reserve(request);
  assert.throws(() => chat.reserve({ ...request, conversationId: 'default', requestId: crypto.randomUUID() }), error => error.code === 'CHAT_BUSY');
  const message = { id: request.requestId, question: 'A separate discussion', ...validateAnswer({ answer: 'A separate answer', supported: true, segmentIds: ['s1'] }, transcript), createdAt: new Date().toISOString() };
  const completed = chat.finish(request.requestId, 3, message);
  assert.equal(completed.title, message.question);
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ', 'default').messages.length, 0);
  assert.deepEqual(chat.reserve(request).previous.message, message);
  assert.throws(() => chat.reserve({ ...request, conversationId: 'default' }), /changed/);
  current = chat.renameConversation(1, 'course1', 'aqz-KE-bpKQ', id, 'Shuffle follow-ups', completed.revision);
  const exported = chat.exportRecords(1);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].conversations.length, 2);
  chat.restore(2, exported);
  assert.equal(chat.get(2, 'course1', 'aqz-KE-bpKQ', id).title, 'Shuffle follow-ups');
  assert.deepEqual(chat.get(2, 'course1', 'aqz-KE-bpKQ', id).messages, [message]);
  chat.deleteConversation(1, 'course1', 'aqz-KE-bpKQ', id, current.revision);
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ').conversations.length, 1);
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ').transcript.hash, transcript.hash);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 3);
  assert.throws(() => chat.get(1, 'course1', 'aqz-KE-bpKQ', id), error => error.code === 'CHAT_NOT_FOUND');
});

test('conversation limits, stale edits and transcript replacement are atomic and retain legacy backups', context => {
  const { chat } = storage(context);
  const transcript = normalizeTranscript(cues);
  const legacy = [{ courseId: 'course1', videoId: 'aqz-KE-bpKQ', transcript, messages: [] }];
  chat.restore(1, legacy);
  let current = chat.get(1, 'course1', 'aqz-KE-bpKQ');
  for (let count = 1; count < 20; count++) current = chat.createConversation(1, 'course1', 'aqz-KE-bpKQ', current.revision, crypto.randomUUID());
  assert.throws(() => chat.createConversation(1, 'course1', 'aqz-KE-bpKQ', current.revision, crypto.randomUUID()), error => error.code === 'CHAT_LIMIT');
  assert.equal(chat.get(1, 'course1', 'aqz-KE-bpKQ').revision, current.revision);
  assert.throws(() => chat.renameConversation(1, 'course1', 'aqz-KE-bpKQ', current.conversationId, 'Old edit', current.revision - 1), /changed/);
  const changed = normalizeTranscript([{ start: 0, end: 2, text: 'New source.' }]);
  assert.throws(() => chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', changed, current.revision, false), error => error.code === 'REPLACE_TRANSCRIPT');
  const replaced = chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', changed, current.revision, true);
  assert.equal(replaced.conversations.length, 1);
  assert.equal(replaced.transcript.hash, changed.hash);
  assert.equal(replaced.messages.length, 0);
  const removed = chat.clear(1, 'course1', 'aqz-KE-bpKQ', replaced.revision, true);
  assert.equal(removed.conversations.length, 0);
  assert.equal(removed.transcript, null);
});

async function apiFixture(context, overrides = {}) {
  const { db, chat } = storage(context, { clock: overrides.clock });
  const calls = [];
  const store = { db, chat, getUserById: id => ({ id, is_guest: 0, is_admin: id === 1 ? 1 : 0, account_state: 'active' }),
    reserveBudgets: () => 0,
    getSessionUser: session => ({ id: Number(session), is_guest: 0, account_state: 'active' }),
    getNotebook: (userId, courseId) => ({ notesRevision: 0, records: db.prepare('SELECT * FROM video_notes WHERE user_id = ? AND course_id = ?').all(userId, courseId)
      .map(row => ({ videoId: row.video_id, document: JSON.parse(row.document_json), revision: row.revision })) }),
    getUserData: () => ({ courses: { course1: { title: 'Course', videos: [{ id: 'aqz-KE-bpKQ', title: 'Lesson', durationSeconds: 100 }] } } }) };
  const express = require('express');
  const app = express();
  app.use(express.json());
  if (overrides.observe) app.use((req, _res, next) => { req.monitoring = { observe: overrides.observe }; next(); });
  const auth = { requireAuth(req, res, next) { if (!req.get('x-test-user')) return res.status(401).end(); req.user = { id: Number(req.get('x-test-user')) }; req.sessionHash = req.get('x-test-user'); next(); } };
  auth.requireAdmin = (req, res, next) => auth.requireAuth(req, res, () => store.getUserById(req.user.id)?.is_admin ? next() : res.status(403).json({ error: 'Administrator access is required.' }));
  const provider = overrides.provider || {
    async count(prompt) { calls.push(JSON.parse(prompt)); return 500; },
    async generate() { return { text: JSON.stringify({ answer: 'A partition holds part of the data.', supported: true, segmentIds: ['s1'] }), cost: 120, complete: true }; },
  };
  const service = createVideoChat(store, auth, { provider, embeddingProvider: overrides.embeddingProvider, verifyPublicVideo: overrides.verifyPublicVideo,
    loadCaptions: overrides.loadCaptions, timeoutMs: overrides.timeoutMs, heartbeatMs: overrides.heartbeatMs,
    environment: { VIDEO_CHAT_ENABLED: '1', GEMINI_API_KEY: 'fixture-only', ...overrides.environment } });
  app.use('/chat', service.router);
  app.use('/admin/video-chat', service.adminRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/chat/course1/videos/aqz-KE-bpKQ`;
  const request = async (suffix = '', body, user = 1, method = body ? 'POST' : 'GET') => {
    const response = await fetch(endpoint + suffix, { method, headers: { 'x-test-user': String(user), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  const adminRequest = async (body, user = 1, expectedUser = user) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/video-chat${body ? '/settings' : ''}`, {
      method: body ? 'PATCH' : 'GET', headers: { 'x-test-user': String(user), 'X-Video-Chat-Account': String(expectedUser), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  return { request, adminRequest, db, chat, calls, endpoint, store };
}

test('admin API changes the same running chat budget and enforces account, role and calibration gates', async context => {
  const fixture = await apiFixture(context, { environment: { VIDEO_CHAT_MONTHLY_BUDGET_USD: '0.10' } });
  const before = await fixture.adminRequest();
  assert.equal(before.status, 200);
  assert.equal(before.body.settings.monthlyBudgetCents, 10);
  assert.equal(before.body.capabilities.requestsPerWindow, 30);
  assert.equal(before.body.capabilities.requestWindowSeconds, 21600);
  assert.equal(before.body.capabilities.requestsPerDay, undefined);
  assert.equal(before.headers.get('cache-control'), 'no-store');
  assert.equal(before.headers.get('x-video-chat-account'), '1');
  assert.equal((await fixture.adminRequest(undefined, 2)).status, 403);
  assert.equal((await fixture.adminRequest(undefined, 1, 2)).status, 409);
  assert.doesNotMatch(JSON.stringify(before.body), /fixture-only|salt|password|partition contains/);
  const input = { revision: 0, monthlyBudgetCents: 500, paused: false, cacheEnabled: true, sharedCacheEnabled: false, semanticCacheEnabled: false };
  assert.equal((await fixture.adminRequest(input)).status, 200);
  assert.equal((await fixture.adminRequest(input)).status, 409);
  assert.equal((await fixture.adminRequest({ ...input, revision: 1, requestsPerWindow: 100 })).body.code, 'INVALID_CHAT_SETTINGS');
  assert.equal((await fixture.adminRequest({ ...input, revision: 1, semanticCacheEnabled: true })).body.code, 'SEMANTIC_NOT_READY');
  const body = { requestId: crypto.randomUUID(), revision: 1, question: 'What is a partition?', consent: true };
  assert.equal((await fixture.request('/messages', body)).status, 200);
  assert.equal(fixture.calls.length, 1);
  assert.equal((await fixture.adminRequest({ ...input, revision: 1, paused: true })).status, 200);
  assert.equal((await fixture.request()).body.config.available, false);
  assert.equal((await fixture.request('/messages', { ...body, requestId: crypto.randomUUID(), revision: 2 })).status, 403);
  assert.equal((await fixture.adminRequest({ ...input, revision: 2, monthlyBudgetCents: 0 })).status, 200);
  assert.equal((await fixture.request()).body.config.available, false);
  assert.equal(fixture.chat.getQuota(1).used, 1);
});

test('configured model preserves deployed pricing and isolates answer caches without changing the default', async context => {
  const modelName = 'gemini-3.1-flash-lite';
  const fixture = await apiFixture(context, { environment: { VIDEO_CHAT_MODEL: modelName, VIDEO_CHAT_MONTHLY_BUDGET_USD: '0.20' } });
  const snapshot = (await fixture.adminRequest()).body;
  assert.equal(snapshot.capabilities.configured, true);
  assert.equal(snapshot.capabilities.model, modelName);
  assert.equal(snapshot.capabilities.maximumGenerationMicros, 263680);
  assert.equal((await fixture.request()).body.config.model, modelName);
  const body = { requestId: crypto.randomUUID(), revision: 1, question: 'What is a partition?', consent: true };
  assert.equal((await fixture.request('/messages', body)).body.code, 'CHAT_BUDGET');
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.adminRequest({ revision: 0, monthlyBudgetCents: 30, paused: false,
    cacheEnabled: false, sharedCacheEnabled: false, semanticCacheEnabled: false })).status, 200);
  assert.equal((await fixture.request('/messages', body)).status, 200);
  const transcript = normalizeTranscript(cues);
  const contextValue = { question: 'Summarize this video.', transcript: transcript.segments };
  const descriptor = { userId: null, courseId: null, videoId: 'aqz-KE-bpKQ', task: 'summary' };
  assert.notEqual(answerCacheDescriptor(contextValue, transcript, descriptor).contextHash,
    answerCacheDescriptor(contextValue, transcript, { ...descriptor, modelName }).contextHash);
  assert.throws(() => createGeminiProvider('fixture-only', 'constructor'), /Unsupported/);
});

test('a budget decrease after embedding blocks generation without refunding the lookup', async context => {
  let fixture;
  fixture = await cacheFixture(context, { embeddingProvider: { async embed() {
    const settings = (await fixture.adminRequest()).body.settings;
    const saved = await fixture.adminRequest({ revision: settings.revision, monthlyBudgetCents: 10, paused: false, cacheEnabled: true, sharedCacheEnabled: true, semanticCacheEnabled: true });
    assert.equal(saved.status, 200);
    return { cost: 6, embedding: Array(768).fill(1) };
  } } });
  const response = await fixture.request('/messages', fixture.body(1));
  assert.equal(response.status, 429);
  assert.equal(response.body.code, 'CHAT_BUDGET');
  assert.equal(fixture.counts.generate, 0);
  assert.deepEqual(fixture.db.prepare('SELECT cost_micros, embedding_cost_basis, generation_cost_basis FROM video_chat_usage').get(),
    { cost_micros: 6, embedding_cost_basis: 'known', generation_cost_basis: 'known' });
});

test('pausing blocks undispatched generation but preserves a response that was already dispatched', async context => {
  for (const stage of ['count', 'generate']) {
    let fixture;
    let generated = 0;
    const pause = async () => {
      const settings = (await fixture.adminRequest()).body.settings;
      assert.equal((await fixture.adminRequest({ revision: settings.revision, monthlyBudgetCents: 500, paused: true,
        cacheEnabled: false, sharedCacheEnabled: false, semanticCacheEnabled: false })).status, 200);
    };
    fixture = await apiFixture(context, { provider: {
      async count() { if (stage === 'count') await pause(); return 100; },
      async generate() { generated++; if (stage === 'generate') await pause(); return { complete: true, cost: 12,
        text: JSON.stringify({ answer: 'A partition holds data.', supported: true, segmentIds: ['s1'] }) }; },
    } });
    const response = await fixture.request('/messages', { requestId: crypto.randomUUID(), revision: 1, question: 'What is a partition?', consent: true });
    assert.equal(response.status, stage === 'count' ? 403 : 200);
    assert.equal(generated, stage === 'count' ? 0 : 1);
    assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, stage === 'count' ? 0 : 12);
    assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, stage === 'count' ? 0 : 1);
  }
});

test('admin mutations are rate limited and commit-time role revocation rolls back settings and audit', async context => {
  const fixture = await apiFixture(context);
  const input = { revision: 0, monthlyBudgetCents: 600, paused: false, cacheEnabled: false, sharedCacheEnabled: false, semanticCacheEnabled: false };
  fixture.store.reserveBudgets = () => 45;
  const limited = await fixture.adminRequest(input);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '45');
  assert.equal(fixture.chat.getSettings().revision, 0);
  const user = fixture.store.getUserById;
  fixture.store.reserveBudgets = () => { fixture.store.getUserById = id => ({ ...user(id), is_admin: 0 }); return 0; };
  assert.equal((await fixture.adminRequest(input)).status, 403);
  assert.equal(fixture.chat.getSettings().revision, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_settings_audit').get().count, 0);
});

test('disabling shared caching at commit blocks late cache writes and delivery without losing paid answers', async context => {
  for (const stage of ['write', 'read']) {
    const fixture = await cacheFixture(context);
    if (stage === 'read') assert.equal((await fixture.request('/messages', fixture.body(1))).status, 200);
    const settings = (await fixture.adminRequest()).body.settings;
    const finish = fixture.chat.finish;
    fixture.chat.finish = (...args) => {
      if (args[2]) fixture.chat.saveSettings(1, { revision: settings.revision, monthlyBudgetCents: 500, paused: false,
        cacheEnabled: true, sharedCacheEnabled: false, semanticCacheEnabled: true }, settings, () => {});
      return finish(...args);
    };
    const userId = stage === 'read' ? 2 : 1;
    const response = await fixture.request('/messages', fixture.body(userId), userId);
    assert.equal(response.status, stage === 'write' ? 200 : 409);
    if (stage === 'read') assert.equal(response.body.code, 'CHAT_SETTINGS_CHANGED');
    assert.equal(fixture.chat.get(userId, 'course1', 'aqz-KE-bpKQ').messages.length, stage === 'write' ? 1 : 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_answer_cache').get().count, stage === 'write' ? 0 : 1);
    assert.equal(fixture.db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 126);
    assert.equal(fixture.counts.generate, 1);
  }
});

test('six-hour quota API gives active members access and rejects invalid configuration or inactive accounts', async context => {
  const fixture = await apiFixture(context);
  const configuration = new URL('/chat/config', fixture.endpoint);
  assert.equal((await fetch(configuration)).status, 401);
  for (const userId of [1, 2]) {
    const response = await fetch(configuration, { headers: { 'x-test-user': String(userId), 'X-Video-Chat-Account': String(userId) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.equal(config.available, true);
    assert.equal(config.quota.limit, 30);
    assert.equal(config.quota.remaining, 30);
    assert.equal(config.quota.resetAt, null);
    assert.equal(config.quota.windowSeconds, 21600);
  }
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_quota_windows').get().count, 0);
  assert.equal((await fetch(configuration, { headers: { 'x-test-user': '2', 'X-Video-Chat-Account': '1' } })).status, 409);
  const currentAccount = fixture.store.getUserById;
  for (const state of [{ is_guest: 1 }, { account_state: 'disabled' }, { account_state: 'deleted' }]) {
    fixture.store.getUserById = userId => ({ ...currentAccount(userId), ...state });
    const config = await (await fetch(configuration, { headers: { 'x-test-user': '2' } })).json();
    assert.equal(config.available, false);
    assert.equal(config.quota, null);
    assert.equal((await fixture.request('/messages', { requestId: crypto.randomUUID(), question: 'No access', revision: 1, consent: true }, 2)).status, 403);
  }
  for (const limit of ['0', '-1', '1.5', '1001', 'not-a-number', '']) {
    const invalid = await apiFixture(context, { environment: { VIDEO_CHAT_REQUESTS_PER_WINDOW: limit } });
    const config = (await invalid.request()).body.config;
    assert.equal(config.available, false);
    assert.equal(config.quota, null);
    assert.match(config.reason, /quota is not configured/);
    const administration = (await invalid.adminRequest()).body;
    assert.equal(administration.capabilities.configured, false);
    assert.equal(administration.capabilities.requestsPerWindow, null);
    assert.equal((await invalid.request('/messages', { requestId: crypto.randomUUID(), question: 'No quota', revision: 1, consent: true })).status, 403);
    assert.equal(invalid.calls.length, 0);
  }
});

test('six-hour quota API returns retry metadata before streaming and permits history and free replay', async context => {
  let timestamp = Date.parse('2030-01-01T09:20:00Z');
  const fixture = await apiFixture(context, { clock: () => timestamp, environment: { VIDEO_CHAT_REQUESTS_PER_WINDOW: '1' } });
  assert.equal((await fixture.adminRequest()).body.capabilities.requestsPerWindow, 1);
  fixture.chat.saveTranscript(2, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const question = { requestId: crypto.randomUUID(), question: 'Question?', revision: 1, consent: true };
  const answer = await fixture.request('/messages', question, 2);
  assert.equal(answer.status, 200);
  const next = { ...question, requestId: crypto.randomUUID(), revision: answer.body.revision };
  const blocked = await fetch(fixture.endpoint + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': '2', accept: 'application/x-ndjson' }, body: JSON.stringify(next) });
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get('content-type'), /application\/json/);
  assert.equal(blocked.headers.get('retry-after'), '21600');
  const exhausted = await blocked.json();
  assert.equal(exhausted.code, 'CHAT_WINDOW_LIMIT');
  assert.equal(exhausted.quota.remaining, 0);
  assert.equal(exhausted.quota.resetAt, '2030-01-01T15:20:00.000Z');
  assert.equal(exhausted.retryAfterSeconds, 21600);
  const history = await fixture.request('', undefined, 2);
  assert.equal(history.status, 200);
  assert.equal(history.body.config.available, true);
  assert.equal(history.body.config.quota.remaining, 0);
  assert.deepEqual((await fixture.request('/messages', question, 2)).body.message, answer.body.message);
  assert.equal(fixture.calls.length, 1);
  timestamp += 6 * 60 * 60 * 1000;
  assert.equal((await fixture.request('', undefined, 2)).body.config.quota.remaining, 1);
  assert.equal((await fixture.request('/messages', question, 2)).status, 200);
  assert.equal(fixture.chat.getQuota(2, 1).resetAt, null, 'Replay after expiry must not start the next window');
  assert.equal(fixture.calls.length, 1);
  assert.equal((await fixture.request('/messages', next, 2)).status, 200);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.chat.getQuota(2, 1).used, 1);
  assert.equal(fixture.db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 240);
});

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

test('shared exact answers skip all model calls and bind a new message to each permitted learner', async context => {
  const counts = { count: 0, generate: 0, embed: 0 };
  const prompts = [];
  const fixture = await apiFixture(context, {
    environment: { VIDEO_CHAT_CACHE_ENABLED: '1', VIDEO_CHAT_SHARED_CACHE_ENABLED: '1' },
    verifyPublicVideo: async videoId => ({ public: true, videoId, title: 'Verified public title' }),
    provider: { async count(prompt) { counts.count++; prompts.push(JSON.parse(prompt)); return 50; },
      async generate() { counts.generate++; return { complete: true, cost: 120, text: JSON.stringify({ answer: 'A partition holds data.', supported: true, segmentIds: ['s1'] }) }; } },
    embeddingProvider: { async embed() { counts.embed++; throw new Error('Unexpected embedding'); } },
  });
  const transcript = normalizeTranscript(cues, { source: 'youtube', language: 'en' });
  fixture.chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 1, true, undefined, true);
  fixture.chat.saveTranscript(2, 'course1', 'aqz-KE-bpKQ', transcript, 0, false, undefined, true);
  const firstBody = { requestId: crypto.randomUUID(), question: 'Summarize this video.', playhead: 0, revision: 2, consent: true, cacheConsent: CACHE_CONSENT };
  const first = await fixture.request('/messages', firstBody);
  assert.equal(first.status, 200);
  const secondBody = { ...firstBody, requestId: crypto.randomUUID(), playhead: 50, revision: 1 };
  const second = await fixture.request('/messages', secondBody, 2);
  assert.equal(second.status, 200);
  assert.equal(second.body.message.responseSource, 'cache_exact');
  assert.deepEqual(counts, { count: 1, generate: 1, embed: 0 });
  assert.equal(prompts[0].playhead, null);
  assert.deepEqual(prompts[0].recentConversation, []);
  assert.equal(prompts[0].videoTitle, 'Verified public title');
  assert.notEqual(second.body.message.id, first.body.message.id);
  assert.equal(second.body.message.proposal.id, 'p_' + secondBody.requestId);
  assert.equal(second.body.message.citations[0].seconds, 0);
  assert.deepEqual((await fixture.request('/messages', secondBody, 2)).body, second.body);
  assert.deepEqual(fixture.db.prepare('SELECT user_id, cost_micros FROM video_chat_usage ORDER BY user_id').all(),
    [{ user_id: 1, cost_micros: 120 }, { user_id: 2, cost_micros: 0 }]);
  assert.equal(fixture.chat.get(2, 'course1', 'aqz-KE-bpKQ').messages.length, 1);
});

test('semantic public paraphrases pay embedding only and do not seed transitive shared matches', async context => {
  let generated = 0;
  const embedded = [];
  const fixture = await apiFixture(context, {
    environment: { VIDEO_CHAT_CACHE_ENABLED: '1', VIDEO_CHAT_SHARED_CACHE_ENABLED: '1', VIDEO_CHAT_SEMANTIC_CACHE_ENABLED: '1',
      VIDEO_CHAT_SEMANTIC_MIN_SCORE: '0.98', VIDEO_CHAT_SEMANTIC_MIN_MARGIN: '0.03' },
    verifyPublicVideo: async videoId => ({ public: true, videoId, title: 'Lesson' }),
    provider: { async count() { return 50; }, async generate() { generated++; return { complete: true, cost: 120,
      text: JSON.stringify({ answer: 'A partition holds data.', supported: true, segmentIds: ['s1'] }) }; } },
    embeddingProvider: { async embed(question) { embedded.push(question); return { cost: 6, embedding: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) }; } },
  });
  const transcript = normalizeTranscript(cues, { source: 'youtube', language: 'en' });
  fixture.chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 1, true, undefined, true);
  fixture.chat.saveTranscript(2, 'course1', 'aqz-KE-bpKQ', transcript, 0, false, undefined, true);
  const body = { requestId: crypto.randomUUID(), question: 'Summarize this video.', revision: 2, consent: true, cacheConsent: CACHE_CONSENT };
  assert.equal((await fixture.request('/messages', body)).status, 200);
  const paraphrase = { ...body, requestId: crypto.randomUUID(), revision: 1, question: 'Give me an overview of this video.' };
  const response = await fixture.request('/messages', paraphrase, 2);
  assert.equal(response.status, 200);
  assert.equal(response.body.message.question, paraphrase.question);
  assert.equal(response.body.message.responseSource, 'cache_semantic');
  assert.equal(generated, 1);
  assert.deepEqual(embedded, [body.question, paraphrase.question]);
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage WHERE request_id = ?').get(paraphrase.requestId).cost_micros, 6);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_answer_cache').get().count, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 2);
});

async function cacheFixture(context, overrides = {}) {
  const counts = { count: 0, generate: 0, embed: 0, verify: 0 };
  const prompts = [];
  const fixture = await apiFixture(context, {
    verifyPublicVideo: async videoId => { counts.verify++; return { public: true, videoId, title: 'Public lesson' }; },
    provider: { async count(prompt) { counts.count++; prompts.push(JSON.parse(prompt)); return 50; },
      async generate() { counts.generate++; return { complete: true, cost: 120, text: JSON.stringify({ answer: 'A partition holds data.', supported: true, segmentIds: ['s1'] }) }; } },
    embeddingProvider: { async embed() { counts.embed++; return { cost: 6, embedding: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) }; } },
    ...overrides,
    environment: { VIDEO_CHAT_CACHE_ENABLED: '1', VIDEO_CHAT_SHARED_CACHE_ENABLED: '1', VIDEO_CHAT_SEMANTIC_CACHE_ENABLED: '1',
      VIDEO_CHAT_SEMANTIC_MIN_SCORE: '0.98', VIDEO_CHAT_SEMANTIC_MIN_MARGIN: '0.03', ...overrides.environment },
  });
  const transcript = normalizeTranscript(cues, { source: 'youtube', language: 'en' });
  fixture.chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', transcript, 1, true, undefined, true);
  fixture.chat.saveTranscript(2, 'course1', 'aqz-KE-bpKQ', transcript, 0, false, undefined, true);
  const body = (userId, question = 'Summarize this video.') => ({ requestId: crypto.randomUUID(), question, playhead: 0, consent: true,
    cacheConsent: CACHE_CONSENT, revision: fixture.chat.get(userId, 'course1', 'aqz-KE-bpKQ').revision });
  return { ...fixture, counts, prompts, transcript, body };
}

test('shared cache excludes imported sources, old consent, private metadata and contextual follow-ups', async context => {
  for (const scenario of ['imported', 'old-client', 'private-video', 'history', 'personalized']) {
    const fixture = await cacheFixture(context, scenario === 'private-video' ? { verifyPublicVideo: async () => null } : {});
    assert.equal((await fixture.request('/messages', fixture.body(1))).status, 200);
    if (scenario === 'imported') fixture.chat.restore(2, fixture.chat.exportRecords(2));
    if (scenario === 'history') {
      const requestId = crypto.randomUUID();
      fixture.chat.reserve({ userId: 2, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: 'history', revision: 1, maximumCost: 0, budgetMicros: 5000000 });
      fixture.chat.finish(requestId, 0, { id: requestId, question: 'My private project', answer: 'Earlier response', supported: true, citations: [{ id: 's1' }], createdAt: new Date().toISOString() });
    }
    const body = fixture.body(2, scenario === 'personalized' ? 'Summarize this video for my private project.' : 'Summarize this video.');
    if (scenario === 'old-client') delete body.cacheConsent;
    const result = await fixture.request('/messages', body, 2);
    assert.equal(result.status, 200, scenario);
    assert.equal(result.body.message.responseSource, 'generated', scenario);
    assert.equal(fixture.counts.generate, 2, scenario);
    const sharedRows = fixture.db.prepare('SELECT question, answer_json FROM video_chat_answer_cache WHERE user_id IS NULL').all();
    assert.doesNotMatch(JSON.stringify(sharedRows), /private project|Earlier response/);
    if (scenario === 'history') assert.equal(fixture.prompts[1].recentConversation.length, 1);
    if (scenario === 'private-video') assert.equal(sharedRows.length, 0);
  }
});

test('private exact cache respects ownership and the full playback and conversation context', async context => {
  const fixture = await cacheFixture(context, { environment: { VIDEO_CHAT_SHARED_CACHE_ENABLED: '0', VIDEO_CHAT_SEMANTIC_CACHE_ENABLED: '0' } });
  const first = await fixture.request('/messages', fixture.body(1, 'What is a partition?'));
  assert.equal(first.status, 200);
  const next = fixture.chat.createConversation(1, 'course1', 'aqz-KE-bpKQ', first.body.revision, crypto.randomUUID());
  const body = { ...fixture.body(1, 'What is a partition?'), conversationId: next.conversationId };
  const hit = await fixture.request('/messages', body);
  assert.equal(hit.body.message.responseSource, 'cache_exact');
  assert.equal(fixture.counts.generate, 1);
  const other = await fixture.request('/messages', fixture.body(2, 'What is a partition?'), 2);
  assert.equal(other.body.message.responseSource, 'generated');
  const changed = fixture.chat.createConversation(1, 'course1', 'aqz-KE-bpKQ', hit.body.revision, crypto.randomUUID());
  assert.equal((await fixture.request('/messages', { ...fixture.body(1, 'What is a partition?'), conversationId: changed.conversationId, playhead: 20 })).body.message.responseSource, 'generated');
  assert.equal(fixture.counts.generate, 3);
});

test('exact hits work at exhausted monthly budget but still consume the minute request allowance', async context => {
  const fixture = await cacheFixture(context);
  assert.equal((await fixture.request('/messages', fixture.body(1))).status, 200);
  fixture.db.prepare('UPDATE video_chat_usage SET cost_micros = 6000000').run();
  for (let index = 0; index < 5; index++) {
    const result = await fixture.request('/messages', fixture.body(2), 2);
    assert.equal(result.status, 200);
    assert.equal(result.body.message.responseSource, 'cache_exact');
    fixture.chat.clear(2, 'course1', 'aqz-KE-bpKQ', result.body.revision);
  }
  const limited = await fixture.request('/messages', fixture.body(2), 2);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal(fixture.counts.generate, 1);
  assert.equal(fixture.counts.embed, 1);
  assert.equal(fixture.db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 6000000);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage WHERE user_id = 2').get().count, 5);
});

test('corrupt and expired cache entries generate fresh answers and cache-only failure cannot lose a committed answer', async context => {
  for (const scenario of ['corrupt', 'expired', 'write-failure']) {
    const fixture = await cacheFixture(context, { environment: { VIDEO_CHAT_SEMANTIC_CACHE_ENABLED: '0' },
      ...(scenario === 'write-failure' ? { observe() { throw new Error('Fixture telemetry unavailable'); } } : {}) });
    if (scenario === 'write-failure') {
      fixture.db.exec("CREATE TRIGGER reject_cache BEFORE INSERT ON video_chat_answer_cache BEGIN SELECT RAISE(ABORT, 'Fixture cache failure'); END");
      const body = fixture.body(1);
      const result = await fixture.request('/messages', body);
      assert.equal(result.status, 200);
      assert.deepEqual((await fixture.request('/messages', body)).body, result.body);
      assert.equal(fixture.counts.generate, 1);
      assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 1);
      assert.equal(fixture.db.prepare('SELECT state FROM video_chat_usage').get().state, 'completed');
      continue;
    }
    assert.equal((await fixture.request('/messages', fixture.body(1))).status, 200);
    if (scenario === 'corrupt') fixture.db.prepare('UPDATE video_chat_answer_cache SET answer_json = ?').run(JSON.stringify({ answer: 'Invalid', supported: true, segmentIds: ['s9999'] }));
    else fixture.db.prepare('UPDATE video_chat_answer_cache SET created_at = ?, expires_at = ?').run(Date.now() - 20000, Date.now() - 10000);
    const result = await fixture.request('/messages', fixture.body(2), 2);
    assert.equal(result.status, 200);
    assert.equal(result.body.message.responseSource, 'generated');
    assert.equal(fixture.counts.generate, 2);
    assert.equal(JSON.parse(fixture.db.prepare('SELECT answer_json FROM video_chat_answer_cache').get().answer_json).answer, 'A partition holds data.');
  }
});

test('embedding failures and invalid vectors fall back once while retaining known or unknown lookup cost', async context => {
  for (const scenario of ['unknown', 'known', 'invalid']) {
    const fixture = await cacheFixture(context, { embeddingProvider: { async embed() {
      if (scenario === 'invalid') return { cost: 6, embedding: [1] };
      throw Object.assign(new Error('Fixture embedding unavailable'), scenario === 'known' ? { embeddingCost: 4 } : {});
    } } });
    const result = await fixture.request('/messages', fixture.body(1));
    assert.equal(result.status, 200);
    assert.equal(fixture.counts.generate, 1);
    const expected = scenario === 'unknown' ? MAXIMUM_EMBEDDING_COST : scenario === 'known' ? 4 : 6;
    assert.deepEqual(fixture.db.prepare('SELECT cost_micros, embedding_cost_micros FROM video_chat_usage').get(),
      { cost_micros: 120 + expected, embedding_cost_micros: expected });
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 1);
  }
});

test('lookup budget rejection settles embedding only and NDJSON clients keep the question without an interrupted answer', async context => {
  const fixture = await cacheFixture(context, { environment: { VIDEO_CHAT_MONTHLY_BUDGET_USD: '0.10' } });
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getTime: () => 0,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {},
    fetch: (url, options) => fetch(url.replace('/api/video-chat/course1/videos/aqz-KE-bpKQ', fixture.endpoint), { ...options, headers: { ...options.headers, 'x-test-user': '1' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  await controller.load();
  find('#chatQuestion').value = 'Summarize this video.';
  await controller.ask();
  assert.equal(find('#chatQuestion').value, 'Summarize this video.');
  assert.equal(controller.needsReload, false);
  assert.equal(controller.provisional, null);
  assert.match(find('#chatError').textContent, /similarity lookup may still incur a charge/);
  assert.deepEqual(fixture.counts, { count: 0, generate: 0, embed: 1, verify: 1 });
  assert.deepEqual(fixture.db.prepare('SELECT cost_micros, state FROM video_chat_usage').get(), { cost_micros: 6, state: 'failed' });
});

test('an immediate cached NDJSON final reaches the real controller and yields a fresh validated note preview', async context => {
  const fixture = await cacheFixture(context);
  const first = await fixture.request('/messages', fixture.body(1));
  assert.equal(first.status, 200);
  const { controller, find } = clientFixture({ getUser: () => ({ id: 2 }), getTime: () => 42,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {},
    fetch: (url, options) => fetch(url.replace('/api/video-chat/course1/videos/aqz-KE-bpKQ', fixture.endpoint), { ...options, headers: { ...options.headers, 'x-test-user': '2' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  await controller.load();
  find('#chatQuestion').value = 'Summarize this video.';
  await controller.ask();
  assert.equal(controller.data.messages.length, 1);
  const message = controller.data.messages[0];
  assert.equal(message.responseSource, 'cache_exact');
  assert.notEqual(message.id, first.body.message.id);
  assert.equal(controller.provisional, null);
  assert.equal(controller.needsReload, false);
  assert.equal(find('#chatQuestion').value, '');
  assert.equal(fixture.counts.generate, 1);
  assert.equal(fixture.counts.embed, 1);
  const checked = await fixture.request('/notes/validate', { conversationId: controller.data.conversationId,
    sourceHash: fixture.transcript.hash, generation: controller.data.generation, proposalId: message.proposal.id,
    texts: message.proposal.blocks.map(block => block.text), document: require('../public/notebook-model').empty(), noteRevision: 0 }, 2);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.proposal.id, message.proposal.id);
  assert.equal(checked.body.proposal.blocks[0].seconds, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_notes').get().count, 0);
});

test('canceling an embedding cannot generate, cache or commit a late result', async context => {
  let release;
  const fixture = await cacheFixture(context, { timeoutMs: 40, embeddingProvider: { embed() { return new Promise(resolve => { release = resolve; }); } } });
  const result = await fixture.request('/messages', fixture.body(1));
  assert.equal(result.status, 504);
  assert.equal(result.body.attempt.generationDispatched, false);
  assert.equal(result.body.attempt.embeddingDispatched, true);
  assert.equal(result.body.attempt.settled, true);
  assert.equal(fixture.counts.generate, 0);
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, MAXIMUM_EMBEDDING_COST);
  release({ cost: 1, embedding: Array(768).fill(1) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.chat.get(1, 'course1', 'aqz-KE-bpKQ').messages.length, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_answer_cache').get().count, 0);
});

test('cache configuration is opt-in and semantic matching requires explicit valid calibration settings', async context => {
  const defaults = await apiFixture(context);
  assert.deepEqual((await defaults.request()).body.config.cache, { enabled: false, shared: false, semantic: false, consentVersion: CACHE_CONSENT });
  for (const value of [undefined, '', 'NaN', '0', '1.1', 'Infinity']) {
    const fixture = await cacheFixture(context, { environment: { VIDEO_CHAT_SEMANTIC_MIN_SCORE: value } });
    assert.equal((await fixture.request()).body.config.cache.semantic, false);
    assert.equal((await fixture.request('/messages', fixture.body(1))).status, 200);
    assert.equal(fixture.counts.embed, 0);
  }
  const disabled = await cacheFixture(context, { environment: { VIDEO_CHAT_CACHE_ENABLED: '0' } });
  assert.deepEqual((await disabled.request()).body.config.cache, { enabled: false, shared: false, semantic: false, consentVersion: CACHE_CONSENT });
});

test('conversation HTTP actions isolate histories, bind replies and reject other-account IDs', async context => {
  const { request, calls } = await apiFixture(context);
  const id = crypto.randomUUID();
  const created = await request('/conversations', { id, revision: 1 });
  assert.equal(created.status, 200);
  assert.equal(created.body.conversations.length, 2);
  assert.equal(created.body.conversationId, id);
  assert.equal(created.body.messages.length, 0);
  const renamed = await request('/conversations/' + id, { title: 'Second discussion', revision: created.body.revision }, 1, 'PATCH');
  assert.equal(renamed.status, 200);
  const body = { requestId: crypto.randomUUID(), question: 'What is a partition?', conversationId: id, revision: renamed.body.revision, consent: true };
  const answer = await request('/messages', body);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.conversationId, id);
  assert.equal(answer.body.message.proposal.conversationId, id);
  assert.equal((await request('?conversationId=default')).body.messages.length, 0);
  const current = await request('?conversationId=' + id);
  assert.equal(current.body.messages.length, 1);
  assert.equal(current.body.title, 'Second discussion');
  assert.equal(current.body.config.inputTokenLimit, 1048576);
  assert.equal((await request('?conversationId=' + id, undefined, 2)).status, 404);
  assert.equal((await request('/messages', { ...body, conversationId: 'default' })).status, 409);
  assert.equal(calls.length, 1);
  const removed = await request('/conversations/' + id, { revision: current.body.revision }, 1, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.conversations.length, 1);
  assert.equal(removed.body.transcript.hash, current.body.transcript.hash);
  assert.equal((await request('?conversationId=' + id)).status, 404);
});

test('an empty history list retains its transcript and can start a fresh conversation', async context => {
  const { request } = await apiFixture(context);
  const empty = await request('/conversations/default', { revision: 1 }, 1, 'DELETE');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.conversationId, null);
  const source = '1\n00:00:00,000 --> 00:00:04,000\nA partition contains a subset of the data.\n\n2\n00:00:03,500 --> 00:00:10,000\nA shuffle moves data between partitions.\n';
  const prepared = await request('/transcript', { revision: empty.body.revision, source: 'upload', text: source, rightsConfirmed: true, replace: true }, 1, 'PUT');
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.transcript.hash, empty.body.transcript.hash);
  const created = await request('/conversations', { id: crypto.randomUUID(), revision: prepared.body.revision });
  assert.equal(created.status, 200);
  assert.equal(created.body.conversations.length, 1);
  assert.equal(created.body.messages.length, 0);
});

test('independent SQLite workers allow only one active conversation for an account', async context => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Worker } = require('node:worker_threads');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'focustube-chat-race-'));
  const filename = path.join(directory, 'chat.db');
  const db = new Database(filename);
  context.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE user_data (user_id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1); INSERT INTO user_data VALUES (1);');
  const chat = createChatStore(db);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const second = chat.createConversation(1, 'course1', 'aqz-KE-bpKQ', 1, crypto.randomUUID());
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModule);
    const db = new Database(workerData.filename, { timeout: 5000 });
    try {
      const chat = require(workerData.storeModule).createChatStore(db);
      chat.reserve(workerData.request);
      parentPort.postMessage('reserved');
    } catch (error) { parentPort.postMessage(error.code || error.message); }
    finally { db.close(); }
  `;
  const outcomes = await Promise.all(['default', second.conversationId].map(conversationId => new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { filename, databaseModule: require.resolve('better-sqlite3'), storeModule: require.resolve('../video-chat-store'),
      request: { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', conversationId, requestId: crypto.randomUUID(), fingerprint: conversationId, revision: second.revision, maximumCost: 10, budgetMicros: 100 } } });
    let outcome;
    worker.on('message', value => { outcome = value; });
    worker.once('error', reject);
    worker.once('exit', exitCode => exitCode === 0 ? resolve(outcome) : reject(new Error('Chat worker exited unsuccessfully.')));
  })));
  assert.deepEqual(outcomes.sort(), ['CHAT_BUSY', 'reserved']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_chat_usage WHERE state = 'pending'").get().count, 1);
});

test('independent SQLite workers cannot over-reserve monthly headroom during cache-miss top-ups', async context => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Worker } = require('node:worker_threads');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'focustube-cache-cost-race-'));
  const filename = path.join(directory, 'chat.db');
  const db = new Database(filename);
  context.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE user_data (user_id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1), (2); INSERT INTO user_data VALUES (1), (2);');
  const chat = createChatStore(db);
  const requests = [1, 2].map(userId => {
    chat.saveTranscript(userId, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
    const requestId = crypto.randomUUID();
    chat.reserve({ userId, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: String(userId), revision: 1, maximumCost: 0, budgetMicros: 100 });
    chat.reserveCost(requestId, 'embedding', 5, 100);
    chat.settleEmbedding(requestId, 3);
    return requestId;
  });
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModule);
    const db = new Database(workerData.filename, { timeout: 5000 });
    try {
      const chat = require(workerData.storeModule).createChatStore(db);
      chat.reserveCost(workerData.requestId, 'generation', 70, 100);
      parentPort.postMessage('reserved');
    } catch (error) { parentPort.postMessage(error.code); }
    finally { db.close(); }
  `;
  const outcomes = await Promise.all(requests.map(requestId => new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { filename, requestId, databaseModule: require.resolve('better-sqlite3'), storeModule: require.resolve('../video-chat-store') } });
    let outcome;
    worker.once('message', value => { outcome = value; });
    worker.once('error', reject);
    worker.once('exit', exitCode => exitCode === 0 ? resolve(outcome) : reject(new Error('Cache cost worker exited unsuccessfully.')));
  })));
  assert.deepEqual(outcomes.sort(), ['CHAT_BUDGET', 'reserved']);
  assert.equal(db.prepare('SELECT SUM(cost_micros) AS cost FROM video_chat_usage').get().cost, 76);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 2);
});

test('six-hour quota last-slot race is serialized across SQLite workers and survives reconnect', async context => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Worker } = require('node:worker_threads');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'focustube-quota-race-'));
  const filename = path.join(directory, 'chat.db');
  const db = new Database(filename);
  context.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE user_data (user_id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1); INSERT INTO user_data VALUES (1);');
  const chat = createChatStore(db);
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  db.prepare('INSERT INTO video_chat_quota_windows VALUES(1,?,29)').run(Date.now());
  const barrier = new SharedArrayBuffer(4);
  let ready = 0;
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModule);
    const db = new Database(workerData.filename, { timeout: 5000 });
    try {
      const chat = require(workerData.storeModule).createChatStore(db);
      const barrier = new Int32Array(workerData.barrier);
      parentPort.postMessage('ready');
      Atomics.wait(barrier, 0, 0, 5000);
      if (Atomics.load(barrier, 0) !== 1) throw new Error('Worker barrier did not open');
      db.transaction(() => { chat.reserve(workerData.request); chat.finish(workerData.request.requestId, 0, null); }).immediate();
      parentPort.postMessage('reserved');
    } catch (error) { parentPort.postMessage(error.code || error.message); }
    finally { db.close(); }
  `;
  const outcomes = await Promise.all([0, 1].map(index => new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { filename, barrier, databaseModule: require.resolve('better-sqlite3'), storeModule: require.resolve('../video-chat-store'),
      request: { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: String(index), revision: 1, maximumCost: 1, budgetMicros: 100 } } });
    let outcome;
    worker.on('message', value => {
      if (value !== 'ready') { outcome = value; return; }
      if (++ready === 2) { const shared = new Int32Array(barrier); Atomics.store(shared, 0, 1); Atomics.notify(shared, 0); }
    });
    worker.once('error', reject);
    worker.once('exit', exitCode => exitCode === 0 ? resolve(outcome) : reject(new Error('Quota worker exited unsuccessfully')));
  })));
  assert.deepEqual(outcomes.sort(), ['CHAT_WINDOW_LIMIT', 'reserved']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 1);
  const reopened = new Database(filename);
  try { assert.equal(createChatStore(reopened).getQuota(1).used, 30); } finally { reopened.close(); }
});

test('six-hour quota configuration keeps generation disabled by default and preserves environment budgets', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [filename, budget] of [['compose.yaml', 5], ['compose.dev.yaml', 1], ['compose.prod.yaml', 4]]) {
    const config = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    assert.ok(config.includes('VIDEO_CHAT_REQUESTS_PER_WINDOW: ${VIDEO_CHAT_REQUESTS_PER_WINDOW:-30}'));
    assert.ok(config.includes('VIDEO_CHAT_ENABLED: ${VIDEO_CHAT_ENABLED:-0}'));
    assert.ok(config.includes('VIDEO_CHAT_MONTHLY_BUDGET_USD: ${VIDEO_CHAT_MONTHLY_BUDGET_USD:-' + budget + '}'));
    assert.doesNotMatch(config, /VIDEO_CHAT_ALLOWED_USER_IDS/);
  }
  const example = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
  assert.match(example, /^VIDEO_CHAT_REQUESTS_PER_WINDOW=30$/m);
  assert.match(example, /^GEMINI_API_KEY=$/m);
  assert.doesNotMatch(example, /VIDEO_CHAT_ALLOWED_USER_IDS/);
});

test('disabled chat and excessive context make no generation calls; invalid model citations are not saved', async context => {
  const disabled = await apiFixture(context, { environment: { VIDEO_CHAT_ENABLED: '0' } });
  const body = { requestId: crypto.randomUUID(), question: 'Question?', revision: 1, consent: true };
  assert.equal((await disabled.request('/messages', body)).status, 403);
  assert.equal(disabled.calls.length, 0);
  let generated = 0;
  const oversized = await apiFixture(context, { provider: { async count() { return 1048577; }, async generate() { generated++; } } });
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
  assert.equal(buildContext(thread, { scope: 'video' }).recentConversation.length, 8);
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

test('the minute burst limit remains separate from the six-hour allowance', context => {
  let timestamp = Date.parse('2030-01-01T09:20:00Z');
  const { chat } = storage(context, { clock: () => timestamp });
  chat.saveTranscript(1, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  for (let index = 0; index < 5; index++) {
    const requestId = crypto.randomUUID();
    chat.reserve({ userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId, fingerprint: String(index), revision: 1, maximumCost: 1, budgetMicros: 100 });
    chat.finish(requestId, 0, null);
  }
  const request = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'limit', revision: 1, maximumCost: 1, budgetMicros: 100 };
  assert.throws(() => chat.reserve(request), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 60);
  assert.equal(chat.getQuota(1).remaining, 25);
  timestamp += 59999;
  assert.throws(() => chat.reserve(request), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 1);
  timestamp++;
  chat.reserve(request);
  assert.equal(chat.getQuota(1).remaining, 24);
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
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 105268);
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
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 105268);
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
  assert.deepEqual(validateChatBackup(records)[0].conversations[0].messages[0].proposal, proposal);
  const transcript = normalizeTranscript(cues);
  const binding = { requestId, courseId: 'course1', videoId: 'aqz-KE-bpKQ' };
  const blocks = [{ kind: 'heading', text: 'Discussion', segmentIds: [], messageIds: [] },
    { text: 'The learner asked about partitions.', messageIds: [requestId], segmentIds: [] }];
  assert.deepEqual(validateNoteDraft({ blocks }, transcript, [{ id: requestId }], binding).blocks.map(block => block.seconds), [null, null]);
  assert.throws(() => validateNoteDraft({ blocks }, transcript, [], binding), /linked/);
  assert.throws(() => validateNoteDraft({ blocks: [{ text: 'No evidence', segmentIds: ['fake'] }] }, transcript, [], binding), /linked/);
  assert.throws(() => validateNoteDraft({ blocks: [{ text: 'Invented time', segmentIds: ['s1'], seconds: 44 }] }, transcript, [], binding), /linked/);
  records[0].conversations[0].messages[0].proposal.blocks[0].seconds = 99;
  assert.throws(() => validateChatBackup(records), /source time/);
  delete records[0].conversations[0].messages[0].proposal;
  assert.equal(validateChatBackup(records)[0].conversations[0].messages[0].proposal, undefined, 'Older chat backups remain valid');
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
  const quotaRequest = { userId: owner.id, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(), fingerprint: 'profile-import', revision: 1, maximumCost: 1, budgetMicros: 100 };
  store.chat.reserve(quotaRequest);
  store.chat.finish(quotaRequest.requestId, 0, null);
  const exported = store.getExportData(owner.id);
  assert.equal(exported.schemaVersion, 4);
  assert.equal(exported.videoChats[0].transcript.segments[0].start, 0);
  assert.equal(exported.source.chatRevision, 1);
  assert.equal(Object.hasOwn(exported, 'video_chat_usage'), false);
  assert.equal(Object.hasOwn(exported, 'video_chat_quota_windows'), false);
  const imported = { ...exported, dailyActivity: [], watchHistory: [] };
  store.chat.clear(owner.id, 'course1', 'aqz-KE-bpKQ', 1, true);
  assert.equal(store.importUserData(owner.id, imported, 1, 0, 1), null);
  assert.equal(store.importUserData(owner.id, imported, 1, 0, 2), 2);
  assert.ok(store.chat.get(owner.id, 'course1', 'aqz-KE-bpKQ').revision > 2);
  const next = store.getUserData(owner.id);
  assert.equal(store.importUserData(owner.id, { ...imported, videoChats: [] }, 2, next.notesRevision, next.chatRevision), 3);
  assert.equal(store.chat.get(owner.id, 'course1', 'aqz-KE-bpKQ').transcript, null);
  assert.equal(store.chat.getQuota(owner.id).used, 1, 'Learning imports must not restore request allowances');
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
  assert.equal(fixture.db.prepare('SELECT cost_micros FROM video_chat_usage').get().cost_micros, 105268);
});

test('the official Gemini adapter uses model-specific thinking and current token prices', async () => {
  const original = global.fetch;
  const requests = [];
  let modelName;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    assert.match(String(url), /^https:\/\/generativelanguage.googleapis.com\//);
    assert.ok(String(url).includes(`/models/${modelName}:`));
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
    for (const [selectedModel, cost, thinking] of [['gemini-2.5-flash-lite', 22, { thinkingBudget: 0 }],
      ['gemini-3.1-flash-lite', 70, { thinkingLevel: 'MINIMAL' }]]) {
    modelName = selectedModel;
    requests.length = 0;
    const provider = createGeminiProvider('fixture-key-never-sent', modelName);
    assert.equal(await provider.count('Transcript', new AbortController().signal), 612);
    const result = await provider.generate('Transcript', new AbortController().signal);
    assert.equal(result.complete, true);
    assert.equal(result.cost, cost);
    assert.match(requests[1].url, /streamGenerateContent/);
    assert.deepEqual(requests[1].body.generationConfig.thinkingConfig, thinking);
    assert.equal(requests[1].body.generationConfig.maxOutputTokens, 1024);
    assert.equal(requests[1].body.tools, undefined);
    assert.match(requests[1].body.systemInstruction.parts[0].text, /untrusted data/);
    }
  } finally { global.fetch = original; }
});

test('shared-source verification requires positive public metadata, not caption access or an imported label', () => {
  const videoId = 'aqz-KE-bpKQ';
  const player = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: 'Public lesson', isPrivate: false, isCrawlable: true },
    microformat: { playerMicroformatRenderer: { isUnlisted: false } } };
  assert.deepEqual(publicVideoMetadata(player, videoId), { public: true, videoId, title: 'Public lesson' });
  for (const variant of [null, {}, { ...player, playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    { ...player, videoDetails: { ...player.videoDetails, isPrivate: true } },
    { ...player, videoDetails: { ...player.videoDetails, isCrawlable: false } },
    { ...player, videoDetails: { ...player.videoDetails, videoId: 'jNQXAC9IVRw' } },
    { ...player, microformat: {} }, { ...player, microformat: { playerMicroformatRenderer: { isUnlisted: true } } }]) {
    assert.equal(publicVideoMetadata(variant, videoId), null);
  }
});

test('embedding adapter meters real SDK response bytes without generation or retries', async () => {
  const original = global.fetch;
  const requests = [];
  const values = Array.from({ length: 768 }, (_, index) => index === 0 ? 2 : 0);
  let responseBody = { embeddings: [{ values }], usageMetadata: { promptTokenCount: 30 } };
  let status = 200;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = createGeminiEmbeddingProvider('fixture-only');
    const result = await provider.embed('Summarize this video.', new AbortController().signal);
    assert.equal(result.cost, 6);
    assert.equal(result.embedding.length, 768);
    assert.equal(result.embedding[0], 1);
    assert.match(requests[0].url, /models\/gemini-embedding-2:batchEmbedContents$/);
    assert.equal(requests[0].body.requests.length, 1);
    assert.equal(requests[0].body.requests[0].outputDimensionality, 768);
    assert.equal(requests[0].body.requests[0].taskType, undefined);
    assert.match(requests[0].body.requests[0].content.parts[0].text, /^task: sentence similarity \| query: Summarize/);
    responseBody = { embeddings: [{ values }] };
    assert.equal((await provider.embed('Question', new AbortController().signal)).cost, null);
    responseBody = { embeddings: [{ values: [1] }], usageMetadata: { promptTokenCount: 20 } };
    await assert.rejects(provider.embed('Question', new AbortController().signal), error => error.code === 'INVALID_EMBEDDING' && error.embeddingCost === 4);
    status = 503;
    responseBody = { error: { code: 503, message: 'Fixture unavailable' } };
    const before = requests.length;
    await assert.rejects(provider.embed('Question', new AbortController().signal));
    assert.equal(requests.length, before + 1);
  } finally { global.fetch = original; }
});

test('cache keys bind effective context and semantic matching rejects constraints and ambiguous vectors', () => {
  const transcript = normalizeTranscript(cues);
  const context = buildContext({ transcript, messages: [] }, { scope: 'video', mode: 'answer', playhead: 0, question: 'Summarize this video.', videoTitle: 'Lesson' });
  const identity = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', task: 'summary' };
  const key = answerCacheDescriptor(context, transcript, identity);
  assert.equal(answerCacheDescriptor({ ...context }, transcript, identity).key, key.key);
  for (const changed of [{ playhead: 1 }, { videoTitle: 'Edited' }, { scope: 'moment' }, { recentConversation: [{ answer: 'Private' }] }, { question: 'Other' }]) {
    assert.notEqual(answerCacheDescriptor({ ...context, ...changed }, transcript, identity).key, key.key);
  }
  assert.notEqual(answerCacheDescriptor(context, transcript, { ...identity, userId: 2 }).key, key.key);
  assert.equal(commonQuestionTask('Give me an overview of this video.'), 'summary');
  assert.equal(canonicalQuestionTask('Give me an overview of this video.'), null);
  for (const question of ['Do not summarize this video.', 'Summarize minute 2.', 'Summarize this video in Hindi.', 'Summarize this video in three bullets.', 'Summarize my previous answer.', 'Summarize this video for my exam.']) {
    assert.equal(commonQuestionTask(question), null, question);
  }
  const vector = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  const candidate = { key: 'one', task: 'summary', question: 'Summarize this video.', expiresAt: Date.now() + 60000, embedding: vector };
  assert.equal(selectSemanticAnswer(vector, [candidate], 'summary', 0.98, 0.03).key, 'one');
  assert.equal(selectSemanticAnswer(vector, [candidate, { ...candidate, key: 'two' }], 'summary', 0.98, 0.03), null);
  assert.equal(selectSemanticAnswer(vector, [candidate], 'ideas', 0.98, 0.03), null);
  assert.equal(selectSemanticAnswer(vector, [{ ...candidate, expiresAt: 0 }], 'summary', 0.98, 0.03), null);
  for (const invalid of [[], [1], Array(768), Array(768).fill(0), [NaN, ...vector.slice(1)]]) assert.throws(() => normalizeEmbedding(invalid));
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
    assert.equal(result.cost, 4);
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
        assert.equal(error.chatCost, 14);
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
    fetch: (url, options) => fetch(url.replace('/api/video-chat', new URL('/chat', fixture.endpoint).href), { ...options, headers: { ...options.headers, 'x-test-user': serverUser } }),
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
  const add = find('#chatMessages').children.flatMap(child => child.children).find(child => child.textContent === 'Add to notes');
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

test('first question prepares available captions after one permission prompt and reuses them for follow-ups', async context => {
  let prepared = 0;
  let permission = false;
  let prompts = 0;
  const fixture = await apiFixture(context, { environment: { VIDEO_CHAT_AUTO_CAPTIONS: '1' }, loadCaptions: async () => {
    prepared++;
    return normalizeTranscript(cues, { source: 'youtube', language: 'en' });
  } });
  fixture.chat.clear(1, 'course1', 'aqz-KE-bpKQ', 1, true);
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getTime: () => 0,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {}, ensureCourseSaved: async () => true,
    confirm() { prompts++; return permission; },
    fetch: (url, options) => fetch(url.replace('/api/video-chat', new URL('/chat', fixture.endpoint).href), { ...options, headers: { ...options.headers, 'x-test-user': '1' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  await controller.load();
  assert.equal(find('#chatQuestion').disabled, false);
  find('#chatQuestion').value = 'What is this about?';
  find('#chatQuestion').listeners.input();
  assert.equal(find('#chatSend').disabled, false);
  await controller.ask();
  assert.equal(prepared, 0, 'Declining permission must not retrieve captions');
  assert.equal(fixture.calls.length, 0);
  permission = true;
  await controller.ask();
  assert.equal(prepared, 1);
  assert.equal(controller.data.messages.length, 1);
  assert.equal(controller.data.conversationId, 'default');
  assert.equal(find('#chatQuestion').value, '');
  find('#chatQuestion').value = 'Can you explain that further?';
  await controller.ask();
  assert.equal(controller.data.messages.length, 2);
  assert.equal(prepared, 1);
  assert.equal(prompts, 2, 'Permission is not requested again after acceptance');
  assert.equal(fixture.calls[1].recentConversation.length, 1);
  assert.equal(find('#chatMessages').children.some(element => element.id === 'chatStarters'), false);
  assert.equal(find('#chatFollowUps').children.length, 2);
});

test('budget rejection preserves the question without an interrupted assistant response', async context => {
  const fixture = await apiFixture(context, { environment: { VIDEO_CHAT_MONTHLY_BUDGET_USD: '0.10' } });
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getTime: () => 0,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {},
    fetch: (url, options) => fetch(url.replace('/api/video-chat/course1/videos/aqz-KE-bpKQ', fixture.endpoint), { ...options, headers: { ...options.headers, 'x-test-user': '1' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  await controller.load();
  find('#chatQuestion').value = 'Keep my question';
  await controller.ask();
  assert.equal(find('#chatQuestion').value, 'Keep my question');
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage').get().count, 0);
  assert.equal(controller.needsReload, false);
  assert.equal(controller.provisional, null);
  assert.match(find('#chatError').textContent, /monthly video chat budget/);
});

test('caption retrieval failure keeps the question and never dispatches generation or suggests an upload', async context => {
  const fixture = await apiFixture(context, { loadCaptions: async () => { throw new (require('../video-chat').ChatError)(502, 'CAPTIONS_UNAVAILABLE', 'Upload an SRT or VTT file.'); } });
  fixture.chat.clear(1, 'course1', 'aqz-KE-bpKQ', 1, true);
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getTime: () => 0, notesOpen: () => false, setNotesOpen() {}, onOpen() {},
    formatTime: String, showError() {}, ensureCourseSaved: async () => true,
    fetch: (url, options) => fetch(url.replace('/api/video-chat', new URL('/chat', fixture.endpoint).href), { ...options, headers: { ...options.headers, 'x-test-user': '1' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  await controller.load();
  assert.equal(controller.config.autoCaptions, true);
  find('#chatQuestion').value = 'Keep my question';
  await controller.ask();
  assert.equal(find('#chatQuestion').value, 'Keep my question');
  assert.equal(fixture.calls.length, 0);
  assert.equal(controller.needsReload, false);
  assert.equal(controller.provisional, null, 'Preparation failure must not render an interrupted assistant response');
  assert.equal(find('#chatSend').disabled, false, 'A pre-generation failure leaves the question retryable');
  assert.match(find('#chatError').textContent, /could not access captions/);
  assert.doesNotMatch(find('#chatError').textContent, /upload|SRT|VTT/i);
  const disabled = await apiFixture(context, { environment: { VIDEO_CHAT_AUTO_CAPTIONS: '0' } });
  assert.equal((await disabled.request()).body.config.autoCaptions, false);
});

test('six-hour quota composer preserves drafts and history, rechecks the deadline, and recovers from offline status', async context => {
  let timestamp = Date.parse('2030-01-01T09:20:00Z');
  let offline = false;
  const timers = new Set();
  const fixture = await apiFixture(context, { clock: () => timestamp, environment: { VIDEO_CHAT_REQUESTS_PER_WINDOW: '1' } });
  fixture.chat.saveTranscript(2, 'course1', 'aqz-KE-bpKQ', normalizeTranscript(cues), 0, false);
  const { controller, find, events } = clientFixture({ getUser: () => ({ id: 2 }), getTime: () => 0,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {}, ensureCourseSaved: async () => true,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); },
    fetch: (url, options) => {
      if (offline) return Promise.reject(new Error('Offline'));
      return fetch(url.replace('/api/video-chat', new URL('/chat', fixture.endpoint).href), { ...options, headers: { ...options.headers, 'x-test-user': '2' } });
    },
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  controller.opened = true;
  await controller.load();
  find('#chatQuestion').value = 'What is a partition?';
  await controller.ask();
  assert.equal(fixture.calls.length, 1);
  assert.match(find('#chatQuotaRemaining').textContent, /0 of 1/);
  assert.match(find('#chatQuotaReset').textContent, /Resets/);
  find('#chatQuestion').value = 'Keep this draft';
  find('#chatQuestion').listeners.input();
  assert.equal(find('#chatSend').disabled, true);
  assert.equal(find('#chatQuestion').disabled, false);
  assert.equal(find('#chatHistory').disabled, false);
  assert.equal(find('#chatNew').disabled, false);
  assert.equal(find('#chatFollowUps').children.every(button => button.disabled), true);
  const add = find('#chatMessages').children.flatMap(child => child.children).find(child => child.textContent === 'Add to notes');
  assert.equal(add.disabled, false);
  await controller.ask();
  assert.equal(fixture.calls.length, 1);
  const deadline = [...timers].find(timer => timer.delay === 21600100);
  assert.ok(deadline);
  timestamp += 21600000;
  offline = true;
  await deadline.callback();
  assert.equal(find('#chatSend').disabled, true);
  assert.equal(find('#chatQuestion').value, 'Keep this draft');
  assert.equal(find('#chatQuotaRemaining').textContent, 'Allowance unavailable');
  offline = false;
  await events.get('window:focus')();
  assert.match(find('#chatQuotaRemaining').textContent, /1 of 1/);
  assert.equal(find('#chatQuotaReset').textContent, '');
  assert.equal(find('#chatSend').disabled, false);
  assert.equal(fixture.calls.length, 1, 'Reset must not automatically send a question');
  await controller.ask();
  assert.equal(fixture.calls.length, 2);
  const nextDeadline = [...timers].find(timer => timer.delay === 21600100);
  let finishOperation;
  const updating = controller.perform('Updating chat...', () => new Promise(resolve => { finishOperation = resolve; }));
  timestamp += 21600000;
  await nextDeadline.callback();
  assert.equal(controller.quotaExpired, true);
  finishOperation(null);
  await updating;
  assert.equal(controller.quotaExpired, false);
  assert.equal(controller.config.quota.remaining, 1);
  assert.equal(fixture.calls.length, 2);
  controller.reset();
  assert.equal(find('#chatQuota').classList.contains('hidden'), true);
});

test('six-hour quota refresh ignores late responses and does not apply another account status', async () => {
  let owner = 1;
  const waiting = [];
  const { controller, find } = clientFixture({ getUser: () => ({ id: owner }), notesOpen: () => false, setNotesOpen() {}, onOpen() {},
    fetch: () => new Promise(resolve => waiting.push(resolve)) });
  const quota = remaining => ({ available: true, quota: { remaining, limit: 30, used: 30 - remaining, resetAt: null, serverNow: new Date().toISOString(), windowSeconds: 21600 } });
  const first = controller.configure();
  const latest = controller.configure();
  waiting[1]({ ok: true, status: 200, json: async () => quota(12) });
  await latest;
  waiting[0]({ ok: true, status: 200, json: async () => quota(30) });
  await first;
  assert.equal(controller.config.quota.remaining, 12);
  const oldAccount = controller.configure();
  owner = 2;
  const newAccount = controller.configure();
  assert.equal(find('#chatQuotaRemaining').textContent, 'Checking allowance...');
  waiting[3]({ ok: true, status: 200, json: async () => quota(4) });
  await newAccount;
  waiting[2]({ ok: true, status: 200, json: async () => quota(29) });
  await oldAccount;
  assert.equal(controller.config.quota.remaining, 4);
});

test('six-hour quota rejection after another tab spends the last slot keeps the question retryable', async context => {
  const fixture = await apiFixture(context, { environment: { VIDEO_CHAT_REQUESTS_PER_WINDOW: '1' } });
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getTime: () => 0,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {}, ensureCourseSaved: async () => true,
    fetch: (url, options) => fetch(url.replace('/api/video-chat', new URL('/chat', fixture.endpoint).href), { ...options, headers: { ...options.headers, 'x-test-user': '1' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  await controller.load();
  const otherTab = { userId: 1, courseId: 'course1', videoId: 'aqz-KE-bpKQ', requestId: crypto.randomUUID(),
    fingerprint: 'another-tab', revision: 1, maximumCost: 1, budgetMicros: 100, requestLimit: 1 };
  fixture.chat.reserve(otherTab);
  fixture.chat.finish(otherTab.requestId, 0, null);
  find('#chatQuestion').value = 'Keep my unsent question';
  await controller.ask();
  assert.equal(controller.needsReload, false);
  assert.equal(controller.provisional, null);
  assert.equal(find('#chatQuestion').value, 'Keep my unsent question');
  assert.equal(find('#chatQuestion').disabled, false);
  assert.equal(find('#chatSend').disabled, true);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.chat.getQuota(1, 1).used, 1);
  assert.match(find('#chatError').textContent, /six-hour/);
});

test('chat controller creates named histories, restores drafts and previews, and keeps keyboard entry conversational', async context => {
  const fixture = await apiFixture(context);
  const { controller, find } = clientFixture({ getUser: () => ({ id: 1 }), getCourseTitle: () => 'Course', getTime: () => 0,
    notesOpen: () => false, setNotesOpen() {}, onOpen() {}, formatTime: String, showError() {}, ensureCourseSaved: async () => true,
    fetch: (url, options) => fetch(url.replace('/api/video-chat', new URL('/chat', fixture.endpoint).href), { ...options, headers: { ...options.headers, 'x-test-user': '1' } }),
  });
  controller.showVideo('course1', 'aqz-KE-bpKQ', 'Lesson');
  controller.config = { available: true };
  await controller.load();
  const original = controller.data.conversationId;
  find('#chatQuestion').value = 'Draft in the original chat';
  find('#chatQuestion').listeners.input();
  await controller.newConversation();
  const second = controller.data.conversationId;
  assert.notEqual(second, original);
  assert.equal(controller.data.conversations.length, 2);
  assert.equal(find('#chatQuestion').value, '');
  find('#chatName').value = 'Follow-up questions';
  await controller.renameConversation();
  assert.equal(controller.data.title, 'Follow-up questions');
  find('#chatQuestion').value = 'What is a partition?';
  find('#chatConsent').checked = true;
  await controller.ask();
  const turns = find('#chatMessages').children;
  assert.equal(turns[0].className, 'chat-turn chat-user');
  assert.equal(turns[1].className, 'chat-turn chat-assistant');
  controller.offerPreview(controller.data.messages[0]);
  const preview = controller.preview;
  preview.proposal.blocks[0].text = 'Keep this edit';
  find('#chatQuestion').value = 'Draft in the second chat';
  find('#chatQuestion').listeners.input();
  await controller.load(original);
  assert.equal(controller.data.messages.length, 0);
  assert.equal(controller.preview, null);
  assert.equal(find('#chatQuestion').value, 'Draft in the original chat');
  await controller.load(second);
  assert.equal(find('#chatQuestion').value, 'Draft in the second chat');
  assert.equal(controller.preview, preview);
  assert.equal(controller.preview.proposal.blocks[0].text, 'Keep this edit');
  let sends = 0;
  let prevented = 0;
  controller.ask = () => { sends++; };
  const keydown = values => find('#chatQuestion').listeners.keydown({ key: 'Enter', preventDefault() { prevented++; }, ...values });
  keydown({ shiftKey: true });
  keydown({ isComposing: true });
  find('#chatQuestion').listeners.compositionstart();
  keydown({});
  find('#chatQuestion').listeners.compositionend();
  keydown({});
  assert.equal(sends, 1);
  assert.equal(prevented, 1);
  controller.pending = { controller: new AbortController() };
  const before = controller.data.conversationId;
  await controller.load(original);
  assert.equal(controller.data.conversationId, before);
  controller.pending = null;
  await controller.deleteConversation();
  assert.equal(controller.data.conversationId, original);
  assert.equal(controller.previews.size, 0);
  await controller.load(second);
  assert.equal(controller.data.conversationId, original, 'A deleted selection reloads the actual history list');
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