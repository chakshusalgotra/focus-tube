'use strict';

const crypto = require('node:crypto');
const { ChatError, normalizeTranscript, validateAnswer, validateNoteDraft } = require('./video-chat');
const MAX_PROFILE_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATIONS = 20;
const CACHE_TTL_MS = 7 * 86400000;
const CACHE_LIMITS = { entries: 5000, bytes: 64 * 1024 * 1024, privateEntries: 200, privateBytes: 5 * 1024 * 1024 };
const SETTING_KEYS = ['monthlyBudgetCents', 'paused', 'cacheEnabled', 'sharedCacheEnabled', 'semanticCacheEnabled'];
const validConversationId = value => typeof value === 'string' && (value === 'default' || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value));
const validTitle = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\u0000-\u001f]/.test(value);

function validateChatBackup(records) {
  if (!Array.isArray(records) || records.length > 50 || Buffer.byteLength(JSON.stringify(records)) > MAX_PROFILE_BYTES) {
    throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Chat backups are limited to 50 videos and 10 MB.');
  }
  const keys = new Set();
  const requestIds = new Set();
  return records.map(record => {
    if (!record || typeof record.courseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.courseId) ||
        !/^[A-Za-z0-9_-]{11}$/.test(record.videoId)) {
      throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid video chat record.');
    }
    const key = record.courseId + '/' + record.videoId;
    if (keys.has(key)) throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Duplicate video chat record.');
    keys.add(key);
    const transcript = record.transcript === null ? null : normalizeTranscript(record.transcript?.segments, record.transcript || {});
    const histories = record.conversations ?? [{ id: 'default', title: 'New chat', messages: record.messages }];
    if (!Array.isArray(histories) || histories.length > MAX_CONVERSATIONS) throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'A video can have up to 20 conversations.');
    const conversationIds = new Set();
    const conversations = histories.map(history => {
      if (!history || !validConversationId(history.id) || conversationIds.has(history.id) || !validTitle(history.title) ||
          !Array.isArray(history.messages) || history.messages.length > 100 || (!transcript && history.messages.length) ||
          [history.createdAt, history.updatedAt].some(value => value !== undefined && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))) {
        throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid conversation.');
      }
      conversationIds.add(history.id);
      const messages = [];
      for (const message of history.messages) {
      if (!message || typeof message.question !== 'string' || !message.question.trim() || message.question.length > 2000 ||
          !/^[a-f0-9-]{36}$/.test(message.id) || requestIds.has(message.id) || typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt)) || !Array.isArray(message.citations)) {
        throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid chat message.');
      }
      requestIds.add(message.id);
      const checked = validateAnswer({ answer: message.answer, supported: message.supported,
        segmentIds: message.citations?.map(citation => citation.id), followUps: message.followUps }, transcript);
      let proposal;
      if (message.proposal !== undefined) {
        const raw = message.proposal;
        if (!checked.supported || !raw || raw.id !== `p_${message.id}` || raw.courseId !== record.courseId || raw.videoId !== record.videoId ||
            raw.sourceHash !== transcript.hash || typeof raw.suggested !== 'boolean' || !Array.isArray(raw.blocks) ||
            (raw.conversationId !== undefined && raw.conversationId !== history.id)) {
          throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid note proposal binding.');
        }
        proposal = validateNoteDraft({ blocks: raw.blocks.map(block => ({ kind: block.kind, text: block.text, segmentIds: block.segmentIds, messageIds: block.messageIds })) },
          transcript, messages, { requestId: message.id, courseId: record.courseId, videoId: record.videoId, suggested: raw.suggested });
        if (raw.conversationId !== undefined) proposal.conversationId = raw.conversationId;
        if (proposal.blocks.some((block, index) => block.seconds !== raw.blocks[index].seconds)) throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid proposal source time.');
      }
      const context = message.context;
      if (context !== undefined && (!context || !['moment', 'video', 'discussion'].includes(context.scope) || !['answer', 'note_draft'].includes(context.mode) ||
          (context.playhead !== null && (!Number.isSafeInteger(context.playhead) || context.playhead < 0 || context.playhead > 14400)))) {
        throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid chat context.');
      }
      messages.push({ id: message.id, question: message.question, ...checked, createdAt: message.createdAt,
        ...(proposal ? { proposal } : {}), ...(context ? { context: { scope: context.scope, playhead: context.playhead, mode: context.mode } } : {}) });
      }
      return { id: history.id, title: history.title.trim(), messages,
        ...(history.createdAt ? { createdAt: history.createdAt } : {}), ...(history.updatedAt ? { updatedAt: history.updatedAt } : {}) };
    });
    return { courseId: record.courseId, videoId: record.videoId, transcript, conversations };
  });
}

function createChatStore(db, onCompleted = () => {}) {
  if (!db.pragma('table_info(user_data)').some(column => column.name === 'chat_revision')) db.exec('ALTER TABLE user_data ADD COLUMN chat_revision INTEGER NOT NULL DEFAULT 0');
  db.transaction(() => {
  const migrateConversations = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'video_chat_conversations'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_chats (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL, video_id TEXT NOT NULL, generation TEXT NOT NULL,
      transcript_json TEXT, messages_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, course_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS video_chat_usage (
      request_id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      course_id TEXT NOT NULL, video_id TEXT NOT NULL, generation TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'failed')),
      month TEXT NOT NULL, cost_micros INTEGER NOT NULL CHECK(cost_micros >= 0),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS video_chat_usage_month ON video_chat_usage(month);
    CREATE INDEX IF NOT EXISTS video_chat_usage_user ON video_chat_usage(user_id, created_at);
    CREATE TABLE IF NOT EXISTS video_chat_conversations (
      user_id INTEGER NOT NULL, course_id TEXT NOT NULL, video_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, title TEXT NOT NULL, generation TEXT NOT NULL,
      messages_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, course_id, video_id, conversation_id),
      FOREIGN KEY (user_id, course_id, video_id) REFERENCES video_chats(user_id, course_id, video_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS video_chat_answer_cache (
      cache_key TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT, video_id TEXT NOT NULL, source_hash TEXT NOT NULL, context_hash TEXT NOT NULL,
      question TEXT NOT NULL, task TEXT NOT NULL,
      answer_json TEXT NOT NULL, embedding_json TEXT, embedding_version TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 131072),
      CHECK(expires_at > created_at),
      CHECK((user_id IS NOT NULL AND course_id IS NOT NULL) OR
        (user_id IS NULL AND course_id IS NULL AND task IN ('summary', 'ideas')))
    );
    CREATE INDEX IF NOT EXISTS video_chat_cache_context ON video_chat_answer_cache(user_id, course_id, video_id, source_hash, context_hash);
    CREATE INDEX IF NOT EXISTS video_chat_cache_expiry ON video_chat_answer_cache(expires_at);
    CREATE TABLE IF NOT EXISTS video_chat_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      monthly_budget_cents INTEGER CHECK(monthly_budget_cents BETWEEN 0 AND 100000),
      paused INTEGER CHECK(paused IN (0, 1)), cache_enabled INTEGER CHECK(cache_enabled IN (0, 1)),
      shared_cache_enabled INTEGER CHECK(shared_cache_enabled IN (0, 1)), semantic_cache_enabled INTEGER CHECK(semantic_cache_enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT OR IGNORE INTO video_chat_settings(id) VALUES (1);
    CREATE TABLE IF NOT EXISTS video_chat_settings_audit (
      revision INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  if (!db.pragma('table_info(video_chats)').some(column => column.name === 'trusted_source_hash')) {
    db.exec('ALTER TABLE video_chats ADD COLUMN trusted_source_hash TEXT');
  }
  if (!db.pragma('table_info(video_chat_usage)').some(column => column.name === 'conversation_id')) {
    db.exec("ALTER TABLE video_chat_usage ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!db.pragma('table_info(video_chat_usage)').some(column => column.name === 'embedding_cost_micros')) {
    db.exec('ALTER TABLE video_chat_usage ADD COLUMN embedding_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(embedding_cost_micros >= 0)');
  }
  for (const column of ['generation_cost_basis', 'embedding_cost_basis']) {
    if (!db.pragma('table_info(video_chat_usage)').some(value => value.name === column)) {
      db.exec(`ALTER TABLE video_chat_usage ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'legacy' CHECK(${column} IN ('legacy', 'known', 'reserved', 'unknown'))`);
    }
  }
  if (migrateConversations) {
    const insert = db.prepare(`INSERT INTO video_chat_conversations
      (user_id, course_id, video_id, conversation_id, title, generation, messages_json, created_at, updated_at)
      VALUES (?, ?, ?, 'default', ?, ?, ?, ?, ?)`);
    for (const row of db.prepare('SELECT * FROM video_chats').all()) {
      const messages = JSON.parse(row.messages_json);
      if (!row.transcript_json && !messages.length) continue;
      const title = messages[0]?.question.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New chat';
      insert.run(row.user_id, row.course_id, row.video_id, title, row.generation, row.messages_json,
        messages[0]?.createdAt || row.updated_at, row.updated_at);
    }
    db.exec("UPDATE video_chats SET messages_json = '[]'");
  }
  }).immediate();
  const pruneSettingsAudit = () => {
    db.prepare('DELETE FROM video_chat_settings_audit WHERE created_at < ?').run(Date.now() - 90 * 86400000);
    db.exec('DELETE FROM video_chat_settings_audit WHERE revision IN (SELECT revision FROM video_chat_settings_audit ORDER BY revision DESC LIMIT -1 OFFSET 1000)');
  };
  pruneSettingsAudit();
  const getSettings = (defaults = {}) => {
    const row = db.prepare('SELECT * FROM video_chat_settings WHERE id = 1').get();
    return { monthlyBudgetCents: row.monthly_budget_cents ?? defaults.monthlyBudgetCents ?? 500,
      paused: row.paused === null ? !!defaults.paused : row.paused === 1,
      cacheEnabled: row.cache_enabled === null ? !!defaults.cacheEnabled : row.cache_enabled === 1,
      sharedCacheEnabled: row.shared_cache_enabled === null ? !!defaults.sharedCacheEnabled : row.shared_cache_enabled === 1,
      semanticCacheEnabled: row.semantic_cache_enabled === null ? !!defaults.semanticCacheEnabled : row.semantic_cache_enabled === 1,
      revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by, source: row.revision ? 'dashboard' : 'environment' };
  };
  const saveSettings = db.transaction((userId, input, defaults, validateCommit) => {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !['revision', ...SETTING_KEYS].includes(key)) ||
        !Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(input.monthlyBudgetCents) ||
        input.monthlyBudgetCents < 0 || input.monthlyBudgetCents > 100000 || SETTING_KEYS.slice(1).some(key => typeof input[key] !== 'boolean') ||
        (!input.cacheEnabled && (input.sharedCacheEnabled || input.semanticCacheEnabled))) {
      throw new ChatError(400, 'INVALID_CHAT_SETTINGS', 'Use a budget from $0.00 to $1,000.00 and valid cache settings.');
    }
    if (typeof validateCommit !== 'function') throw new TypeError('An administrator commit check is required.');
    validateCommit();
    const current = getSettings(defaults);
    if (current.revision !== input.revision) throw new ChatError(409, 'CHAT_SETTINGS_CHANGED', 'Another administrator changed these settings. Refresh and review your changes.');
    const values = value => Object.fromEntries(SETTING_KEYS.map(key => [key, value[key]]));
    const before = JSON.stringify(values(current));
    const after = JSON.stringify(values(input));
    if (before === after) return current;
    db.prepare(`UPDATE video_chat_settings SET monthly_budget_cents = ?, paused = ?, cache_enabled = ?, shared_cache_enabled = ?,
      semantic_cache_enabled = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 1`)
      .run(input.monthlyBudgetCents, Number(input.paused), Number(input.cacheEnabled), Number(input.sharedCacheEnabled), Number(input.semanticCacheEnabled), new Date().toISOString(), userId);
    db.prepare('INSERT INTO video_chat_settings_audit(revision, actor_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(current.revision + 1, userId, before, after, Date.now());
    pruneSettingsAudit();
    return getSettings(defaults);
  }).immediate;
  const currentBudget = fallback => {
    const row = db.prepare('SELECT monthly_budget_cents, paused FROM video_chat_settings WHERE id = 1').get();
    const amount = row.monthly_budget_cents === null ? fallback : row.monthly_budget_cents * 10000;
    if (row.paused === 1 || amount === 0) throw new ChatError(403, 'CHAT_PAUSED', 'Video chat is paused by the administrator.');
    return amount;
  };
  const adminSnapshot = db.transaction((defaults, timestamp = Date.now()) => {
    const date = new Date(timestamp);
    const month = date.toISOString().slice(0, 7);
    const settings = getSettings(defaults);
    const totals = db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(state = 'pending'), 0) AS pendingRequests,
      COALESCE(SUM(cost_micros), 0) AS accountedMicros, COALESCE(SUM(embedding_cost_micros), 0) AS embeddingMicros
      FROM video_chat_usage WHERE month = ?`).get(month);
    const breakdown = db.prepare(`WITH stages AS (
      SELECT state, generation_cost_basis AS basis, cost_micros - embedding_cost_micros AS cost FROM video_chat_usage WHERE month = ?
      UNION ALL SELECT state, embedding_cost_basis AS basis, embedding_cost_micros AS cost FROM video_chat_usage WHERE month = ?
    ) SELECT COALESCE(SUM(CASE WHEN basis = 'known' THEN cost ELSE 0 END), 0) AS knownMicros,
      COALESCE(SUM(CASE WHEN basis IN ('reserved', 'unknown') AND state = 'pending' THEN cost ELSE 0 END), 0) AS pendingMicros,
      COALESCE(SUM(CASE WHEN basis IN ('reserved', 'unknown') AND state != 'pending' THEN cost ELSE 0 END), 0) AS retainedMicros,
      COALESCE(SUM(CASE WHEN basis = 'legacy' THEN cost ELSE 0 END), 0) AS legacyMicros FROM stages`).get(month, month);
    const budgetMicros = settings.monthlyBudgetCents * 10000;
    const changes = db.prepare(`SELECT revision, actor_id, before_json, after_json, created_at FROM video_chat_settings_audit
      WHERE created_at >= ? ORDER BY revision DESC LIMIT 20`).all(timestamp - 90 * 86400000)
      .map(row => ({ revision: row.revision, actorId: row.actor_id, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), createdAt: new Date(row.created_at).toISOString() }));
    return { settings, usage: { month, ...totals, ...breakdown, generationMicros: totals.accountedMicros - totals.embeddingMicros,
      budgetMicros, remainingMicros: Math.max(0, budgetMicros - totals.accountedMicros), overLimitMicros: Math.max(0, totals.accountedMicros - budgetMicros),
      resetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(), serverNow: date.toISOString() }, changes };
  }).deferred;
  db.prepare('DELETE FROM video_chat_answer_cache WHERE expires_at <= ?').run(Date.now());
  const purgePrivateCache = (userId, courseId, videoId) => {
    db.prepare(`DELETE FROM video_chat_answer_cache WHERE user_id = ? ${courseId === undefined ? '' : 'AND course_id = ? AND video_id = ?'}`)
      .run(...(courseId === undefined ? [userId] : [userId, courseId, videoId]));
  };
  const decodeCache = row => {
    if (!row) return null;
    try {
      return { key: row.cache_key, question: row.question, task: row.task, value: JSON.parse(row.answer_json),
        embedding: row.embedding_json ? JSON.parse(row.embedding_json) : null, embeddingVersion: row.embedding_version, expiresAt: row.expires_at };
    } catch { return null; }
  };
  const cacheScope = descriptor => [descriptor.userId, descriptor.courseId, descriptor.videoId, descriptor.sourceHash, descriptor.contextHash];
  const cacheWhere = 'user_id IS ? AND course_id IS ? AND video_id = ? AND source_hash = ? AND context_hash = ? AND expires_at > ?';
  const getCachedAnswer = descriptor => {
    const row = db.prepare(`SELECT * FROM video_chat_answer_cache WHERE cache_key = ? AND ${cacheWhere}`)
      .get(descriptor.key, ...cacheScope(descriptor), Date.now());
    if (row) db.prepare('UPDATE video_chat_answer_cache SET accessed_at = ? WHERE cache_key = ?').run(Date.now(), row.cache_key);
    return decodeCache(row);
  };
  const cacheCandidates = (descriptor, embeddingVersion) => db.prepare(`SELECT * FROM video_chat_answer_cache
    WHERE ${cacheWhere} AND embedding_version = ? AND embedding_json IS NOT NULL AND task = ?
    ORDER BY accessed_at DESC, cache_key LIMIT 100`)
    .all(...cacheScope(descriptor), Date.now(), embeddingVersion, descriptor.task).map(decodeCache).filter(Boolean);
  const cachedEmbedding = (userId, question, embeddingVersion) => {
    const row = db.prepare(`SELECT * FROM video_chat_answer_cache WHERE user_id IS ? AND question = ? AND embedding_version = ?
      AND embedding_json IS NOT NULL AND expires_at > ? ORDER BY accessed_at DESC LIMIT 1`).get(userId, question, embeddingVersion, Date.now());
    return decodeCache(row)?.embedding || null;
  };
  const putCachedAnswer = db.transaction((descriptor, value, embedding = null, embeddingVersion = null) => {
    if (!value?.supported || typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 16000 ||
        value.noteDraft !== undefined || !Array.isArray(value.segmentIds) || !value.segmentIds.length || value.segmentIds.length > 8) return false;
    if (descriptor.userId === null && !((descriptor.task === 'summary' && descriptor.question === 'Summarize this video.') ||
        (descriptor.task === 'ideas' && descriptor.question === 'Explain the key ideas in this video.'))) return false;
    const payload = JSON.stringify({ answer: value.answer, supported: true, segmentIds: value.segmentIds,
      ...(value.followUps?.length ? { followUps: value.followUps } : {}) });
    if (Buffer.byteLength(payload) > 65536) return false;
    const vector = embedding ? JSON.stringify(embedding) : null;
    const bytes = Buffer.byteLength(payload) + Buffer.byteLength(vector || '') + Buffer.byteLength(JSON.stringify(descriptor));
    if (bytes > 131072) return false;
    const now = Date.now();
    db.prepare('DELETE FROM video_chat_answer_cache WHERE expires_at <= ?').run(now);
    db.prepare(`INSERT INTO video_chat_answer_cache
      (cache_key, user_id, course_id, video_id, source_hash, context_hash, question, task, answer_json, embedding_json, embedding_version, created_at, expires_at, accessed_at, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET
      answer_json = excluded.answer_json, embedding_json = excluded.embedding_json, embedding_version = excluded.embedding_version,
      created_at = excluded.created_at, expires_at = excluded.expires_at, accessed_at = excluded.accessed_at, bytes = excluded.bytes`)
      .run(descriptor.key, ...cacheScope(descriptor), descriptor.question, descriptor.task, payload, vector, vector ? embeddingVersion : null,
        now, now + CACHE_TTL_MS, now, bytes);
    const prune = (userId, entries, maximumBytes) => {
      const condition = userId === undefined ? '' : 'WHERE user_id = ?';
      const parameters = userId === undefined ? [] : [userId];
      const usage = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM video_chat_answer_cache ${condition}`).get(...parameters);
      if (usage.count <= entries && usage.bytes <= maximumBytes) return;
      const oldest = db.prepare(`SELECT cache_key, bytes FROM video_chat_answer_cache ${condition} ORDER BY accessed_at, cache_key`).all(...parameters);
      for (const row of oldest) {
        if (usage.count <= entries && usage.bytes <= maximumBytes) break;
        db.prepare('DELETE FROM video_chat_answer_cache WHERE cache_key = ?').run(row.cache_key);
        usage.count--;
        usage.bytes -= row.bytes;
      }
    };
    if (descriptor.userId !== null) prune(descriptor.userId, CACHE_LIMITS.privateEntries, CACHE_LIMITS.privateBytes);
    prune(undefined, CACHE_LIMITS.entries, CACHE_LIMITS.bytes);
    return true;
  }).immediate;
  const rowByKey = db.prepare('SELECT * FROM video_chats WHERE user_id = ? AND course_id = ? AND video_id = ?');
  const conversationByKey = db.prepare('SELECT * FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ? AND conversation_id = ?');
  const bump = db.prepare('UPDATE user_data SET chat_revision = chat_revision + 1 WHERE user_id = ?');
  const list = (userId, courseId, videoId) => db.prepare(`SELECT conversation_id, title, created_at, updated_at,
    json_array_length(messages_json) AS message_count FROM video_chat_conversations
    WHERE user_id = ? AND course_id = ? AND video_id = ? ORDER BY updated_at DESC, conversation_id`).all(userId, courseId, videoId)
    .map(row => ({ id: row.conversation_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, messageCount: row.message_count }));
  const get = (userId, courseId, videoId, conversationId) => {
    if (conversationId !== undefined && !validConversationId(conversationId)) throw new ChatError(400, 'INVALID_CONVERSATION', 'Choose a valid conversation.');
    const row = rowByKey.get(userId, courseId, videoId);
    const conversations = list(userId, courseId, videoId);
    const selected = conversationId ?? conversations.find(item => item.id === 'default')?.id ?? conversations[0]?.id;
    const conversation = selected ? conversationByKey.get(userId, courseId, videoId, selected) : null;
    if (conversationId !== undefined && !conversation) throw new ChatError(404, 'CHAT_NOT_FOUND', 'This conversation no longer exists. Reload the chat list.');
    return { revision: row?.revision || 0, generation: conversation?.generation || '', conversationId: conversation?.conversation_id || null,
      title: conversation?.title || 'New chat', conversations, transcript: JSON.parse(row?.transcript_json || 'null'),
      trustedSourceHash: row?.trusted_source_hash || null,
      messages: JSON.parse(conversation?.messages_json || '[]'), updatedAt: conversation?.updated_at || row?.updated_at };
  };
  const conflict = () => { throw new ChatError(409, 'CHAT_CHANGED', 'Chat changed in another tab. Reload it before continuing.'); };
  const hasPending = (userId, courseId, videoId) => {
    db.prepare("UPDATE video_chat_usage SET state = 'failed' WHERE state = 'pending' AND created_at < ?").run(Date.now() - 120000);
    return !!db.prepare(`SELECT 1 FROM video_chat_usage WHERE user_id = ? AND state = 'pending'
      ${courseId === undefined ? '' : 'AND course_id = ? AND video_id = ?'} LIMIT 1`).get(...(courseId === undefined ? [userId] : [userId, courseId, videoId]));
  };
  const touch = (userId, courseId, videoId) => {
    db.prepare('UPDATE video_chats SET revision = revision + 1, updated_at = ? WHERE user_id = ? AND course_id = ? AND video_id = ?')
      .run(new Date().toISOString(), userId, courseId, videoId);
    bump.run(userId);
  };
  const checkQuota = userId => {
    const transcripts = db.prepare('SELECT COALESCE(SUM(length(CAST(transcript_json AS BLOB))), 0) AS bytes FROM video_chats WHERE user_id = ?').get(userId).bytes;
    const conversations = db.prepare('SELECT COALESCE(SUM(length(CAST(messages_json AS BLOB)) + length(CAST(title AS BLOB))), 0) AS bytes FROM video_chat_conversations WHERE user_id = ?').get(userId).bytes;
    if (transcripts + conversations > MAX_PROFILE_BYTES) throw new ChatError(413, 'CHAT_QUOTA', 'Chat storage is full. Export or delete a conversation before continuing.');
    const videos = db.prepare(`SELECT COUNT(*) AS count FROM video_chats WHERE user_id = ? AND (transcript_json IS NOT NULL OR EXISTS
      (SELECT 1 FROM video_chat_conversations WHERE user_id = video_chats.user_id AND course_id = video_chats.course_id AND video_id = video_chats.video_id))`).get(userId).count;
    if (videos > 50) throw new ChatError(413, 'CHAT_QUOTA', 'Chat is limited to 50 saved videos.');
  };
  const write = (userId, courseId, videoId, transcript, { id = 'default', title = 'New chat', messages = [], generation = crypto.randomUUID(), createdAt, updatedAt }) => {
    const transcriptJson = transcript ? JSON.stringify(transcript) : null;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO video_chats (user_id, course_id, video_id, generation, transcript_json, messages_json, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, '[]', 0, ?) ON CONFLICT(user_id, course_id, video_id) DO UPDATE SET transcript_json = excluded.transcript_json`)
      .run(userId, courseId, videoId, generation, transcriptJson, now);
    db.prepare(`INSERT INTO video_chat_conversations (user_id, course_id, video_id, conversation_id, title, generation, messages_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, course_id, video_id, conversation_id) DO UPDATE SET
      title = excluded.title, generation = excluded.generation, messages_json = excluded.messages_json, updated_at = excluded.updated_at`)
      .run(userId, courseId, videoId, id, title, generation, JSON.stringify(messages), createdAt || now, updatedAt || now);
    if (list(userId, courseId, videoId).length > MAX_CONVERSATIONS) throw new ChatError(413, 'CHAT_LIMIT', 'This video has 20 conversations. Delete one before starting another.');
    checkQuota(userId);
    touch(userId, courseId, videoId);
    return get(userId, courseId, videoId, id);
  };
  const saveTranscript = db.transaction((userId, courseId, videoId, transcript, expectedRevision, replace, conversationId, trustedSource = false) => {
    const old = get(userId, courseId, videoId, conversationId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    const trustedHash = trustedSource && transcript.source === 'youtube' ? transcript.hash : null;
    if (old.transcript?.hash === transcript.hash) {
      db.prepare('UPDATE video_chats SET trusted_source_hash = ? WHERE user_id = ? AND course_id = ? AND video_id = ?').run(trustedHash, userId, courseId, videoId);
      return get(userId, courseId, videoId, conversationId);
    }
    if (old.transcript && !replace) throw new ChatError(409, 'REPLACE_TRANSCRIPT', 'Replacing the transcript clears every conversation for this video. Confirm before continuing.');
    if (old.transcript) db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ?').run(userId, courseId, videoId);
    purgePrivateCache(userId, courseId, videoId);
    const saved = write(userId, courseId, videoId, transcript, { id: old.conversationId || 'default', title: old.title });
    db.prepare('UPDATE video_chats SET trusted_source_hash = ? WHERE user_id = ? AND course_id = ? AND video_id = ?').run(trustedHash, userId, courseId, videoId);
    return { ...saved, trustedSourceHash: trustedHash };
  }).immediate;
  const clear = db.transaction((userId, courseId, videoId, expectedRevision, removeTranscript = false, conversationId) => {
    const old = get(userId, courseId, videoId, conversationId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    purgePrivateCache(userId, courseId, videoId);
    if (removeTranscript) {
      db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ?').run(userId, courseId, videoId);
      db.prepare('UPDATE video_chats SET transcript_json = NULL, trusted_source_hash = NULL, generation = ? WHERE user_id = ? AND course_id = ? AND video_id = ?').run(crypto.randomUUID(), userId, courseId, videoId);
      touch(userId, courseId, videoId);
      return get(userId, courseId, videoId);
    }
    if (!old.conversationId) return old;
    return write(userId, courseId, videoId, old.transcript, { id: old.conversationId, title: old.title });
  }).immediate;
  const createConversation = db.transaction((userId, courseId, videoId, expectedRevision, id, title = 'New chat') => {
    if (!validConversationId(id) || id === 'default' || !validTitle(title)) throw new ChatError(400, 'INVALID_CONVERSATION', 'Use a valid conversation ID and a name up to 80 characters.');
    if (conversationByKey.get(userId, courseId, videoId, id)) return get(userId, courseId, videoId, id);
    const old = get(userId, courseId, videoId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    return write(userId, courseId, videoId, old.transcript, { id, title: title.trim() });
  }).immediate;
  const renameConversation = db.transaction((userId, courseId, videoId, id, title, expectedRevision) => {
    if (!validTitle(title)) throw new ChatError(400, 'INVALID_CONVERSATION', 'Use a conversation name up to 80 characters.');
    const old = get(userId, courseId, videoId, id);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    return write(userId, courseId, videoId, old.transcript, { id, title: title.trim(), messages: old.messages, generation: old.generation });
  }).immediate;
  const deleteConversation = db.transaction((userId, courseId, videoId, id, expectedRevision) => {
    const old = get(userId, courseId, videoId, id);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    purgePrivateCache(userId, courseId, videoId);
    db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ? AND conversation_id = ?').run(userId, courseId, videoId, id);
    touch(userId, courseId, videoId);
    return get(userId, courseId, videoId);
  }).immediate;
  const reserve = db.transaction(({ userId, courseId, videoId, conversationId, requestId, fingerprint, revision, maximumCost, budgetMicros }) => {
    const thread = get(userId, courseId, videoId, conversationId);
    const previous = db.prepare('SELECT * FROM video_chat_usage WHERE request_id = ?').get(requestId);
    if (previous) {
      if (previous.user_id !== userId || previous.course_id !== courseId || previous.video_id !== videoId ||
          previous.conversation_id !== thread.conversationId || previous.fingerprint !== fingerprint || previous.generation !== thread.generation) conflict();
      const message = thread.messages.find(item => item.id === requestId);
      if (previous.state === 'completed' && message) return { previous: { message, revision: thread.revision, conversationId: thread.conversationId, title: thread.title } };
      throw new ChatError(409, 'REQUEST_USED', 'This request is pending or already attempted. Reload chat before sending a new request.');
    }
    if (thread.revision !== revision) conflict();
    budgetMicros = currentBudget(budgetMicros);
    if (hasPending(userId)) throw new ChatError(409, 'CHAT_BUSY', 'Another chat is answering. Stop it or wait before sending another message.');
    if (!thread.transcript) throw new ChatError(409, 'NO_TRANSCRIPT', 'Load a timed transcript before asking a question.');
    if (!thread.conversationId) throw new ChatError(409, 'CHAT_NOT_FOUND', 'Start a new conversation before asking a question.');
    if (thread.messages.length >= 100) throw new ChatError(413, 'CHAT_FULL', 'This chat has reached 100 answers. Start a new conversation to continue.');
    const recent = db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage WHERE user_id = ? AND created_at > ?').get(userId, Date.now() - 60000).count;
    if (recent >= 5) throw new ChatError(429, 'RATE_LIMITED', 'Wait a minute before asking another question.');
    const today = Math.floor(Date.now() / 86400000) * 86400000;
    const daily = db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage WHERE user_id = ? AND created_at >= ?').get(userId, today).count;
    if (daily >= 20) throw new ChatError(429, 'CHAT_DAILY_LIMIT', 'You have reached 20 video chat requests for today. Try again after midnight UTC.');
    const month = new Date().toISOString().slice(0, 7);
    const spent = db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM video_chat_usage WHERE month = ?').get(month).spent;
    if (maximumCost > 0 && spent + maximumCost > budgetMicros) throw new ChatError(429, 'CHAT_BUDGET', 'The monthly video chat budget has been reached.');
    db.prepare(`INSERT INTO video_chat_usage (request_id, user_id, course_id, video_id, conversation_id, generation, fingerprint, state, month, cost_micros, created_at, generation_cost_basis, embedding_cost_basis)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'known')`).run(requestId, userId, courseId, videoId, thread.conversationId, thread.generation, fingerprint, month, maximumCost, Date.now(), maximumCost > 0 ? 'reserved' : 'known');
    return { thread };
  }).immediate;
  const reserveCost = db.transaction((requestId, stage, maximumCost, budgetMicros) => {
    if (!['embedding', 'generation'].includes(stage) || !Number.isSafeInteger(maximumCost) || maximumCost < 0 ||
        !Number.isSafeInteger(budgetMicros) || budgetMicros < 0) throw new TypeError('Invalid chat cost reservation.');
    const request = db.prepare("SELECT * FROM video_chat_usage WHERE request_id = ? AND state = 'pending'").get(requestId);
    if (!request) conflict();
    budgetMicros = currentBudget(budgetMicros);
    const previousCost = stage === 'embedding' ? request.embedding_cost_micros : request.cost_micros - request.embedding_cost_micros;
    const increase = Math.max(0, maximumCost - previousCost);
    const spent = db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM video_chat_usage WHERE month = ?').get(request.month).spent;
    if (increase > 0 && spent + increase > budgetMicros) throw new ChatError(429, 'CHAT_BUDGET', 'The monthly video chat budget has been reached.');
    const basisColumn = stage === 'embedding' ? 'embedding_cost_basis' : 'generation_cost_basis';
    db.prepare(`UPDATE video_chat_usage SET cost_micros = cost_micros + ?, embedding_cost_micros = embedding_cost_micros + ?${increase ? `, ${basisColumn} = 'reserved'` : ''} WHERE request_id = ?`)
      .run(increase, stage === 'embedding' ? increase : 0, requestId);
  }).immediate;
  const markDispatched = (requestId, stage) => {
    if (!['embedding', 'generation'].includes(stage)) throw new TypeError('Invalid provider stage.');
    const column = stage === 'embedding' ? 'embedding_cost_basis' : 'generation_cost_basis';
    if (!db.prepare(`UPDATE video_chat_usage SET ${column} = 'unknown' WHERE request_id = ? AND state = 'pending'`).run(requestId).changes) conflict();
  };
  const settleEmbedding = (requestId, costMicros) => {
    if (costMicros === null) return;
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new TypeError('Invalid embedding cost.');
    db.prepare(`UPDATE video_chat_usage SET cost_micros = cost_micros - embedding_cost_micros + ?, embedding_cost_micros = ?, embedding_cost_basis = 'known'
      WHERE request_id = ? AND state = 'pending'`).run(costMicros, costMicros, requestId);
  };
  const finish = db.transaction((requestId, costMicros, message, validateCommit, cacheEntry) => {
    const request = db.prepare('SELECT * FROM video_chat_usage WHERE request_id = ?').get(requestId);
    if (!request || request.state !== 'pending') return null;
    const existing = request.user_id && conversationByKey.get(request.user_id, request.course_id, request.video_id, request.conversation_id);
    const thread = existing ? get(request.user_id, request.course_id, request.video_id, request.conversation_id) : null;
    const accepted = message && thread && thread.generation === request.generation;
    let result = null;
    if (accepted) {
      validateCommit?.();
      const title = !thread.messages.length && thread.title === 'New chat' ? message.question.replace(/\s+/g, ' ').trim().slice(0, 80) : thread.title;
      const updated = write(request.user_id, request.course_id, request.video_id, thread.transcript,
        { id: thread.conversationId, title, messages: [...thread.messages, message], generation: thread.generation });
      result = { message, revision: updated.revision, conversationId: updated.conversationId, title: updated.title };
    }
    db.prepare('UPDATE video_chat_usage SET cost_micros = ?, generation_cost_basis = ?, state = ? WHERE request_id = ?')
      .run(costMicros === null ? request.cost_micros : costMicros + request.embedding_cost_micros,
        costMicros === null ? request.generation_cost_basis === 'legacy' ? 'legacy' : 'unknown' : 'known', accepted ? 'completed' : 'failed', requestId);
    if (accepted && cacheEntry) {
      try {
        if (!cacheEntry.isEnabled || cacheEntry.isEnabled()) putCachedAnswer(cacheEntry.descriptor, cacheEntry.value, cacheEntry.embedding, cacheEntry.embeddingVersion);
      }
      catch { cacheEntry.onFailure?.(); }
    }
    if (accepted) onCompleted(request.user_id);
    return result;
  }).immediate;
  const exportRecords = userId => db.prepare(`SELECT course_id, video_id, transcript_json FROM video_chats WHERE user_id = ? AND
    (transcript_json IS NOT NULL OR EXISTS (SELECT 1 FROM video_chat_conversations WHERE user_id = video_chats.user_id AND course_id = video_chats.course_id AND video_id = video_chats.video_id))
    ORDER BY course_id, video_id`).all(userId).map(row => ({ courseId: row.course_id, videoId: row.video_id, transcript: JSON.parse(row.transcript_json || 'null'),
      conversations: db.prepare('SELECT * FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ? ORDER BY created_at, conversation_id').all(userId, row.course_id, row.video_id)
        .map(conversation => ({ id: conversation.conversation_id, title: conversation.title, messages: JSON.parse(conversation.messages_json), createdAt: conversation.created_at, updatedAt: conversation.updated_at })) }));
  const restore = db.transaction((userId, records) => {
    const checked = validateChatBackup(records);
    if (hasPending(userId)) conflict();
    purgePrivateCache(userId);
    db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ?').run(userId);
    const updated = db.prepare("UPDATE video_chats SET transcript_json = NULL, trusted_source_hash = NULL, generation = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?")
      .run(crypto.randomUUID(), new Date().toISOString(), userId);
    if (updated.changes) bump.run(userId);
    for (const record of checked) {
      if (!record.conversations.length) {
        const temporary = write(userId, record.courseId, record.videoId, record.transcript, {});
        deleteConversation(userId, record.courseId, record.videoId, temporary.conversationId, temporary.revision);
      }
      for (const conversation of record.conversations) write(userId, record.courseId, record.videoId, record.transcript, conversation);
    }
  }).immediate;
  return { get, list, saveTranscript, clear, createConversation, renameConversation, deleteConversation, reserve, reserveCost, settleEmbedding, finish, exportRecords, restore, hasPending,
    getCachedAnswer, putCachedAnswer, cacheCandidates, cachedEmbedding, getSettings, saveSettings, adminSnapshot, markDispatched };
}

module.exports = { createChatStore, validateChatBackup, validConversationId, MAX_CONVERSATIONS };