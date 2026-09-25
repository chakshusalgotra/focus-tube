'use strict';

const crypto = require('node:crypto');
const { ChatError, normalizeTranscript, validateAnswer, validateNoteDraft } = require('./video-chat');
const MAX_PROFILE_BYTES = 10 * 1024 * 1024;

function validateChatBackup(records) {
  if (!Array.isArray(records) || records.length > 50 || Buffer.byteLength(JSON.stringify(records)) > MAX_PROFILE_BYTES) {
    throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Chat backups are limited to 50 videos and 10 MB.');
  }
  const keys = new Set();
  return records.map(record => {
    if (!record || typeof record.courseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.courseId) ||
        !/^[A-Za-z0-9_-]{11}$/.test(record.videoId) || !Array.isArray(record.messages) || record.messages.length > 100) {
      throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid video chat record.');
    }
    const key = record.courseId + '/' + record.videoId;
    if (keys.has(key)) throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Duplicate video chat record.');
    keys.add(key);
    const transcript = normalizeTranscript(record.transcript?.segments, record.transcript || {});
    const messages = [];
    for (const message of record.messages) {
      if (!message || typeof message.question !== 'string' || !message.question.trim() || message.question.length > 2000 ||
          !/^[a-f0-9-]{36}$/.test(message.id) || typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt)) || !Array.isArray(message.citations)) {
        throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid chat message.');
      }
      const checked = validateAnswer({ answer: message.answer, supported: message.supported,
        segmentIds: message.citations?.map(citation => citation.id) }, transcript);
      let proposal;
      if (message.proposal !== undefined) {
        const raw = message.proposal;
        if (!checked.supported || !raw || raw.id !== `p_${message.id}` || raw.courseId !== record.courseId || raw.videoId !== record.videoId ||
            raw.sourceHash !== transcript.hash || typeof raw.suggested !== 'boolean' || !Array.isArray(raw.blocks)) {
          throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Invalid note proposal binding.');
        }
        proposal = validateNoteDraft({ blocks: raw.blocks.map(block => ({ kind: block.kind, text: block.text, segmentIds: block.segmentIds, messageIds: block.messageIds })) },
          transcript, messages, { requestId: message.id, courseId: record.courseId, videoId: record.videoId, suggested: raw.suggested });
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
    if (new Set(messages.map(message => message.id)).size !== messages.length) throw new ChatError(400, 'INVALID_CHAT_BACKUP', 'Duplicate chat message.');
    return { courseId: record.courseId, videoId: record.videoId, transcript, messages };
  });
}

function createChatStore(db) {
  if (!db.pragma('table_info(user_data)').some(column => column.name === 'chat_revision')) db.exec('ALTER TABLE user_data ADD COLUMN chat_revision INTEGER NOT NULL DEFAULT 0');
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
  `);
  const rowByKey = db.prepare('SELECT * FROM video_chats WHERE user_id = ? AND course_id = ? AND video_id = ?');
  const bump = db.prepare('UPDATE user_data SET chat_revision = chat_revision + 1 WHERE user_id = ?');
  const decode = row => row ? { revision: row.revision, generation: row.generation,
    transcript: JSON.parse(row.transcript_json || 'null'), messages: JSON.parse(row.messages_json), updatedAt: row.updated_at } :
    { revision: 0, generation: '', transcript: null, messages: [] };
  const get = (userId, courseId, videoId) => decode(rowByKey.get(userId, courseId, videoId));
  const conflict = () => { throw new ChatError(409, 'CHAT_CHANGED', 'Chat changed in another tab. Reload it before continuing.'); };
  const hasPending = (userId, courseId, videoId) => {
    db.prepare("UPDATE video_chat_usage SET state = 'failed' WHERE state = 'pending' AND created_at < ?").run(Date.now() - 120000);
    return !!db.prepare(`SELECT 1 FROM video_chat_usage WHERE user_id = ? AND state = 'pending'
      ${courseId === undefined ? '' : 'AND course_id = ? AND video_id = ?'} LIMIT 1`).get(...(courseId === undefined ? [userId] : [userId, courseId, videoId]));
  };
  const write = (userId, courseId, videoId, transcript, messages, generation = crypto.randomUUID()) => {
    const transcriptJson = transcript ? JSON.stringify(transcript) : null;
    const messagesJson = JSON.stringify(messages);
    const size = db.prepare('SELECT COALESCE(SUM(length(CAST(transcript_json AS BLOB)) + length(CAST(messages_json AS BLOB))), 0) AS bytes FROM video_chats WHERE user_id = ? AND NOT (course_id = ? AND video_id = ?)').get(userId, courseId, videoId).bytes;
    if (size + Buffer.byteLength(transcriptJson || '') + Buffer.byteLength(messagesJson) > MAX_PROFILE_BYTES) {
      throw new ChatError(413, 'CHAT_QUOTA', 'Chat storage is full. Remove a saved transcript before continuing.');
    }
    const count = db.prepare('SELECT COUNT(*) AS count FROM video_chats WHERE user_id = ? AND transcript_json IS NOT NULL').get(userId).count;
    if (transcript && !get(userId, courseId, videoId).transcript && count >= 50) throw new ChatError(413, 'CHAT_QUOTA', 'Chat is limited to 50 saved video transcripts.');
    db.prepare(`INSERT INTO video_chats (user_id, course_id, video_id, generation, transcript_json, messages_json, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(user_id, course_id, video_id) DO UPDATE SET
      generation = excluded.generation, transcript_json = excluded.transcript_json, messages_json = excluded.messages_json,
      revision = video_chats.revision + 1, updated_at = excluded.updated_at`).run(userId, courseId, videoId, generation, transcriptJson, messagesJson, new Date().toISOString());
    bump.run(userId);
    return get(userId, courseId, videoId);
  };
  const saveTranscript = db.transaction((userId, courseId, videoId, transcript, expectedRevision, replace) => {
    const old = get(userId, courseId, videoId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    if (old.transcript?.hash === transcript.hash) return old;
    if (old.transcript && !replace) throw new ChatError(409, 'REPLACE_TRANSCRIPT', 'Replacing the transcript clears this chat. Confirm before continuing.');
    return write(userId, courseId, videoId, transcript, []);
  });
  const clear = db.transaction((userId, courseId, videoId, expectedRevision, removeTranscript = false) => {
    const old = get(userId, courseId, videoId);
    if (old.revision !== expectedRevision || hasPending(userId, courseId, videoId)) conflict();
    if (!old.transcript) return old;
    return write(userId, courseId, videoId, removeTranscript ? null : old.transcript, []);
  });
  const reserve = db.transaction(({ userId, courseId, videoId, requestId, fingerprint, revision, maximumCost, budgetMicros }) => {
    const thread = get(userId, courseId, videoId);
    const previous = db.prepare('SELECT * FROM video_chat_usage WHERE request_id = ?').get(requestId);
    if (previous) {
      if (previous.user_id !== userId || previous.course_id !== courseId || previous.video_id !== videoId ||
          previous.fingerprint !== fingerprint || previous.generation !== thread.generation) conflict();
      const message = thread.messages.find(item => item.id === requestId);
      if (previous.state === 'completed' && message) return { previous: { message, revision: thread.revision } };
      throw new ChatError(409, 'REQUEST_USED', 'This request is pending or already attempted. Reload chat before sending a new request.');
    }
    if (thread.revision !== revision || hasPending(userId, courseId, videoId)) conflict();
    if (!thread.transcript) throw new ChatError(409, 'NO_TRANSCRIPT', 'Load a timed transcript before asking a question.');
    if (thread.messages.length >= 100) throw new ChatError(413, 'CHAT_FULL', 'This chat has reached 100 answers. Export it or clear it to continue.');
    const recent = db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage WHERE user_id = ? AND created_at > ?').get(userId, Date.now() - 60000).count;
    if (recent >= 5) throw new ChatError(429, 'RATE_LIMITED', 'Wait a minute before asking another question.');
    const today = Math.floor(Date.now() / 86400000) * 86400000;
    const daily = db.prepare('SELECT COUNT(*) AS count FROM video_chat_usage WHERE user_id = ? AND created_at >= ?').get(userId, today).count;
    if (daily >= 20) throw new ChatError(429, 'CHAT_DAILY_LIMIT', 'You have reached 20 video chat requests for today. Try again after midnight UTC.');
    const month = new Date().toISOString().slice(0, 7);
    const spent = db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM video_chat_usage WHERE month = ?').get(month).spent;
    if (spent + maximumCost > budgetMicros) throw new ChatError(429, 'CHAT_BUDGET', 'The monthly video chat budget has been reached.');
    db.prepare(`INSERT INTO video_chat_usage (request_id, user_id, course_id, video_id, generation, fingerprint, state, month, cost_micros, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(requestId, userId, courseId, videoId, thread.generation, fingerprint, month, maximumCost, Date.now());
    return { thread };
  }).immediate;
  const finish = db.transaction((requestId, costMicros, message, validateCommit) => {
    const request = db.prepare('SELECT * FROM video_chat_usage WHERE request_id = ?').get(requestId);
    if (!request || request.state !== 'pending') return null;
    const thread = get(request.user_id, request.course_id, request.video_id);
    const accepted = message && request.user_id && thread.generation === request.generation;
    let result = null;
    if (accepted) {
      validateCommit?.();
      const updated = write(request.user_id, request.course_id, request.video_id, thread.transcript, [...thread.messages, message], thread.generation);
      result = { message, revision: updated.revision };
    }
    db.prepare('UPDATE video_chat_usage SET cost_micros = ?, state = ? WHERE request_id = ?')
      .run(costMicros === null ? request.cost_micros : costMicros, accepted ? 'completed' : 'failed', requestId);
    return result;
  }).immediate;
  const exportRecords = userId => db.prepare('SELECT course_id, video_id, transcript_json, messages_json FROM video_chats WHERE user_id = ? AND transcript_json IS NOT NULL').all(userId)
    .map(row => ({ courseId: row.course_id, videoId: row.video_id, transcript: JSON.parse(row.transcript_json), messages: JSON.parse(row.messages_json) }));
  const restore = (userId, records) => {
    const checked = validateChatBackup(records);
    if (hasPending(userId)) conflict();
    const old = exportRecords(userId);
    for (const record of old) write(userId, record.courseId, record.videoId, null, []);
    for (const record of checked) write(userId, record.courseId, record.videoId, record.transcript, record.messages);
  };
  return { get, saveTranscript, clear, reserve, finish, exportRecords, restore, hasPending };
}

module.exports = { createChatStore, validateChatBackup };