'use strict';

const crypto = require('node:crypto');
const DAY = 86400000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

class ExtensionError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function createExtensionStore(store) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_receipts (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS extension_receipts_created ON extension_receipts(created_at);
    CREATE TABLE IF NOT EXISTS extension_codes (
      code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 64),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      extension_id TEXT NOT NULL, origin TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL, state_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS extension_codes_expiry ON extension_codes(expires_at);
    CREATE INDEX IF NOT EXISTS extension_codes_session ON extension_codes(session_hash);
    CREATE INDEX IF NOT EXISTS extension_codes_user ON extension_codes(user_id);
    CREATE TABLE IF NOT EXISTS extension_grants (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      extension_id TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(session_hash, extension_id, origin)
    );
    CREATE INDEX IF NOT EXISTS extension_grants_expiry ON extension_grants(expires_at);
    CREATE INDEX IF NOT EXISTS extension_grants_user ON extension_grants(user_id);
    CREATE TABLE IF NOT EXISTS extension_session_revocations (
      session_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE
    );
  `);

  function principal(credentials, expectedAccount) {
    if (credentials.deadline && Date.now() >= credentials.deadline) throw new ExtensionError(504, 'CAPTURE_TIMEOUT', 'The save could not finish. Retry with the same request.');
    const cookieUser = credentials.sessionHash ? store.getSessionUser(credentials.sessionHash) : null;
    const grant = credentials.grantHash ? db.prepare('SELECT * FROM extension_grants WHERE token_hash = ?').get(credentials.grantHash) : null;
    if ((credentials.sessionHash && !cookieUser) || (credentials.grantHash && (!grant || grant.expires_at <= Date.now() || grant.extension_id !== credentials.extensionId || grant.origin !== credentials.origin))) {
      throw new ExtensionError(401, 'CONNECTION_EXPIRED', 'The connection expired. Connect FocusTube again.');
    }
    const sessionHash = grant?.session_hash || credentials.sessionHash;
    const user = grant ? store.getSessionUser(sessionHash) : cookieUser;
    if (!user) throw new ExtensionError(401, 'CONNECTION_EXPIRED', 'Connect FocusTube to continue.');
    if (user.is_guest || user.account_state !== 'active') throw new ExtensionError(403, 'MEMBER_REQUIRED', 'A current FocusTube member account is required.');
    if (db.prepare('SELECT 1 FROM extension_session_revocations WHERE session_hash = ?').get(sessionHash)) throw new ExtensionError(401, 'CONNECTION_EXPIRED', 'The browser session changed. Connect FocusTube again.');
    if ((grant && grant.user_id !== user.id) || (cookieUser && grant && (cookieUser.id !== user.id || credentials.sessionHash !== sessionHash)) || (expectedAccount !== undefined && user.id !== expectedAccount)) {
      throw new ExtensionError(409, 'ACCOUNT_CHANGED', 'The FocusTube account or session changed. Connect again before saving.');
    }
    const session = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sessionHash);
    return { ...credentials, parentSessionHash: sessionHash, userId: user.id,
      account: { id: user.id, name: String(user.display_name || user.username || `Member ${user.id}`).slice(0, 80) },
      expiresAt: new Date(Math.min(Date.parse(session.expires_at), grant?.expires_at || Infinity)).toISOString(), authentication: grant ? 'grant' : 'session' };
  }

  function reserve(scope, subject, limit) {
    const retryAfter = store.reserveBudgets([{ key: hash(JSON.stringify(['extension', scope, subject])), limit }]);
    if (retryAfter) throw new ExtensionError(429, 'RATE_LIMITED', 'Too many attempts. Try again after the waiting period.', retryAfter);
  }

  function cleanup() {
    db.prepare('DELETE FROM extension_receipts WHERE rowid IN (SELECT rowid FROM extension_receipts WHERE created_at <= ? ORDER BY created_at LIMIT 100)').run(Date.now() - 30 * DAY);
    db.prepare('DELETE FROM extension_codes WHERE code_hash IN (SELECT code_hash FROM extension_codes WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').run(Date.now());
    db.prepare('DELETE FROM extension_grants WHERE token_hash IN (SELECT token_hash FROM extension_grants WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').run(Date.now());
    db.prepare('DELETE FROM extension_session_revocations WHERE session_hash IN (SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT 100)').run(new Date().toISOString());
  }

  const authorize = db.transaction((credentials, input) => {
    const actor = principal(credentials, input.expectedAccount);
    if (actor.authentication !== 'session') throw new ExtensionError(403, 'CONSENT_REQUIRED', 'Sign in to FocusTube to approve this connection.');
    cleanup();
    if (db.prepare('SELECT count(*) AS count FROM extension_codes').get().count >= 2000 || db.prepare('SELECT count(*) AS count FROM extension_codes WHERE user_id = ?').get(actor.userId).count >= 10) {
      throw new ExtensionError(429, 'CONNECTION_LIMIT', 'Too many connection attempts. Try again in five minutes.', 300);
    }
    const code = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO extension_codes (code_hash, user_id, session_hash, extension_id, origin, redirect_uri, challenge, state_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(hash(code), actor.userId, actor.parentSessionHash, input.extensionId, credentials.origin, input.redirectUri, input.codeChallenge, hash(input.state), Math.min(Date.now() + 5 * 60000, Date.parse(actor.expiresAt)));
    return code;
  });

  const exchange = db.transaction((credentials, input) => {
    cleanup();
    const code = db.prepare('SELECT * FROM extension_codes WHERE code_hash = ?').get(hash(input.code));
    const challenge = crypto.createHash('sha256').update(input.codeVerifier).digest('base64url');
    if (!code || code.expires_at <= Date.now() || code.extension_id !== credentials.extensionId || code.origin !== credentials.origin ||
        code.redirect_uri !== input.redirectUri || code.state_hash !== hash(input.state) || code.challenge !== challenge) {
      throw new ExtensionError(400, 'INVALID_CODE', 'The connection code is invalid or expired. Connect again.');
    }
    const actor = principal({ sessionHash: code.session_hash }, code.user_id);
    if (credentials.sessionHash) {
      const cookieActor = principal(credentials, actor.userId);
      if (cookieActor.parentSessionHash !== code.session_hash) throw new ExtensionError(409, 'ACCOUNT_CHANGED', 'The browser session changed. Connect again.');
    }
    db.prepare('DELETE FROM extension_grants WHERE session_hash = ? AND extension_id = ? AND origin = ?').run(code.session_hash, credentials.extensionId, credentials.origin);
    if (db.prepare('SELECT count(*) AS count FROM extension_grants WHERE user_id = ?').get(actor.userId).count >= 32 || db.prepare('SELECT count(*) AS count FROM extension_grants').get().count >= 10000) {
      throw new ExtensionError(429, 'CONNECTION_LIMIT', 'Too many active extension connections. Disconnect an older connection first.', 300);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Math.min(Date.now() + 30 * DAY, Date.parse(actor.expiresAt));
    db.prepare('DELETE FROM extension_codes WHERE code_hash = ?').run(hash(input.code));
    db.prepare('INSERT INTO extension_grants (token_hash, user_id, session_hash, extension_id, origin, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(token), actor.userId, code.session_hash, credentials.extensionId, credentials.origin, expiresAt);
    return { token, account: actor.account, expiresAt: new Date(expiresAt).toISOString(), authentication: 'grant' };
  });

  const disconnect = db.transaction((credentials, expectedAccount) => {
    const actor = principal(credentials, expectedAccount);
    db.prepare('DELETE FROM extension_grants WHERE session_hash = ? AND extension_id = ? AND origin = ?').run(actor.parentSessionHash, credentials.extensionId, credentials.origin);
    db.prepare('DELETE FROM extension_codes WHERE session_hash = ? AND extension_id = ? AND origin = ?').run(actor.parentSessionHash, credentials.extensionId, credentials.origin);
  });

  const revokeSession = db.transaction(sessionHash => {
    if (typeof sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(sessionHash)) return;
    db.prepare('INSERT OR IGNORE INTO extension_session_revocations (session_hash) SELECT token_hash FROM sessions WHERE token_hash = ?').run(sessionHash);
    db.prepare('DELETE FROM extension_grants WHERE session_hash = ?').run(sessionHash);
    db.prepare('DELETE FROM extension_codes WHERE session_hash = ?').run(sessionHash);
  });

  function existingCourse(courses, videoId) {
    return Object.entries(courses).filter(([, course]) => Array.isArray(course?.videos) && course.videos.some(video => video?.id === videoId))
      .sort(([leftId, left], [rightId, right]) => Number(right.videos.length === 1) - Number(left.videos.length === 1) || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0))[0];
  }

  const capture = db.transaction((credentials, input, metadata) => {
    if (!input || typeof input.videoId !== 'string' || !VIDEO_ID.test(input.videoId) || typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId) || !Number.isSafeInteger(input.expectedAccount) || input.expectedAccount < 1) {
      throw new ExtensionError(400, 'INVALID_CAPTURE', 'Choose a valid YouTube video and account.');
    }
    const actor = principal(credentials, input.expectedAccount);
    cleanup();
    const fingerprint = hash(JSON.stringify([input.expectedAccount, input.videoId]));
    const old = db.prepare('SELECT fingerprint, receipt_json FROM extension_receipts WHERE user_id = ? AND request_id = ?').get(actor.userId, input.requestId);
    const snapshot = store.getUserData(actor.userId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ExtensionError(409, 'REQUEST_CONFLICT', 'This save request belongs to a different video.');
      const receipt = JSON.parse(old.receipt_json);
      return { ...receipt, present: !!snapshot.courses[receipt.courseId]?.videos?.some(video => video?.id === input.videoId) };
    }
    const existing = existingCourse(snapshot.courses, input.videoId);
    const entries = Object.values(snapshot.courses);
    if (!existing && (entries.length >= 250 || entries.some(course => !Array.isArray(course?.videos) || course.videos.length > 5000) || entries.reduce((count, course) => count + course.videos.length, 0) >= 20000)) {
      throw new ExtensionError(413, 'LIBRARY_QUOTA', 'The library is full. Remove a course before saving another video.');
    }
    if (!existing && !metadata) return null;
    if (db.prepare('SELECT COUNT(*) AS count FROM extension_receipts WHERE user_id = ?').get(actor.userId).count >= 10000 || db.prepare('SELECT COUNT(*) AS count FROM extension_receipts').get().count >= 100000) {
      throw new ExtensionError(503, 'RECEIPT_CAPACITY', 'Save receipts are at capacity. Try again later.', 3600);
    }
    let courseId = existing?.[0];
    let course = existing?.[1];
    let revision = snapshot.revision;
    if (!existing) {
      const video = metadata?.videos?.[0];
      if (metadata?.id !== input.videoId || !Array.isArray(metadata?.videos) || metadata.videos.length !== 1 || video?.id !== input.videoId ||
          typeof metadata.title !== 'string' || !metadata.title.trim() || typeof video.title !== 'string' || !video.title.trim() ||
          !Number.isFinite(video.durationSeconds) || video.durationSeconds < 0 || video.durationSeconds > 864000) {
        throw new ExtensionError(502, 'VIDEO_UNAVAILABLE', 'YouTube did not return a usable public video. Try again later.');
      }
      const timestamp = Date.now();
      courseId = Object.hasOwn(snapshot.courses, input.videoId) ? `capture_${crypto.randomUUID()}` : input.videoId;
      course = { id: courseId, title: metadata.title.trim().slice(0, 500), author: typeof metadata.author === 'string' ? metadata.author.trim().slice(0, 200) : '',
        addedAt: timestamp, lastSyncedAt: timestamp, videos: [{ id: input.videoId, title: video.title.trim().slice(0, 500), durationSeconds: video.durationSeconds }],
        completed: {}, positions: {}, lastVideoId: null, speed: 1, completedAt: null, pinned: false };
      const courses = { ...snapshot.courses, [courseId]: course };
      if (Buffer.byteLength(JSON.stringify({ ...snapshot, courses })) > 3 * 1024 * 1024 - 1024) {
        throw new ExtensionError(413, 'LIBRARY_QUOTA', 'The library is full. Remove a course before saving another video.');
      }
      principal(credentials, input.expectedAccount);
      const updated = db.prepare('UPDATE user_data SET courses_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?')
        .run(JSON.stringify(courses), new Date(timestamp).toISOString(), actor.userId, snapshot.revision);
      if (updated.changes !== 1) throw new ExtensionError(409, 'LIBRARY_CHANGED', 'The library changed. Retry this save.');
      revision++;
    }
    const video = course.videos.find(item => item?.id === input.videoId);
    const receipt = { requestId: input.requestId, accountId: actor.userId, videoId: input.videoId, courseId, revision,
      outcome: existing ? 'existing' : 'saved', present: true, title: String(video.title || course.title || 'YouTube video').slice(0, 500) };
    db.prepare('INSERT INTO extension_receipts (user_id, request_id, fingerprint, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actor.userId, input.requestId, fingerprint, JSON.stringify(receipt), Date.now());
    return receipt;
  });

  return { principal, reserve, capture: (...args) => capture.immediate(...args),
    authorize: (...args) => authorize.immediate(...args), exchange: (...args) => exchange.immediate(...args),
    disconnect: (...args) => disconnect.immediate(...args), revokeSession: sessionHash => revokeSession.immediate(sessionHash) };
}

module.exports = { createExtensionStore, ExtensionError };