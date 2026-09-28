'use strict';

const crypto = require('node:crypto');
const { ChatError, normalizeTranscript, validateAnswer, validateNoteDraft } = require('./video-chat');
const MAX_PROFILE_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATIONS = 20;
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
  `);
  if (!db.pragma('table_info(video_chat_usage)').some(column => column.name === 'conversation_id')) {
    db.exec("ALTER TABLE video_chat_usage ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'default'");
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
  const saveTranscript = db.transaction((userId, courseId, videoId, transcript, expectedRevision, replace, conversationId) => {
    const old = get(userId, courseId, videoId, conversationId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    if (old.transcript?.hash === transcript.hash) return old;
    if (old.transcript && !replace) throw new ChatError(409, 'REPLACE_TRANSCRIPT', 'Replacing the transcript clears every conversation for this video. Confirm before continuing.');
    if (old.transcript) db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ?').run(userId, courseId, videoId);
    return write(userId, courseId, videoId, transcript, { id: old.conversationId || 'default', title: old.title });
  }).immediate;
  const clear = db.transaction((userId, courseId, videoId, expectedRevision, removeTranscript = false, conversationId) => {
    const old = get(userId, courseId, videoId, conversationId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    if (removeTranscript) {
      db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ? AND course_id = ? AND video_id = ?').run(userId, courseId, videoId);
      db.prepare('UPDATE video_chats SET transcript_json = NULL, generation = ? WHERE user_id = ? AND course_id = ? AND video_id = ?').run(crypto.randomUUID(), userId, courseId, videoId);
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
    if (spent + maximumCost > budgetMicros) throw new ChatError(429, 'CHAT_BUDGET', 'The monthly video chat budget has been reached.');
    db.prepare(`INSERT INTO video_chat_usage (request_id, user_id, course_id, video_id, conversation_id, generation, fingerprint, state, month, cost_micros, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(requestId, userId, courseId, videoId, thread.conversationId, thread.generation, fingerprint, month, maximumCost, Date.now());
    return { thread };
  }).immediate;
  const finish = db.transaction((requestId, costMicros, message, validateCommit) => {
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
    db.prepare('UPDATE video_chat_usage SET cost_micros = ?, state = ? WHERE request_id = ?')
      .run(costMicros === null ? request.cost_micros : costMicros, accepted ? 'completed' : 'failed', requestId);
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
    db.prepare('DELETE FROM video_chat_conversations WHERE user_id = ?').run(userId);
    const updated = db.prepare("UPDATE video_chats SET transcript_json = NULL, generation = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?")
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
  return { get, list, saveTranscript, clear, createConversation, renameConversation, deleteConversation, reserve, finish, exportRecords, restore, hasPending };
}

module.exports = { createChatStore, validateChatBackup, validConversationId, MAX_CONVERSATIONS };