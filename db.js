'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const noteModel = require(path.join(__dirname, 'public/notebook-model'));

const dataDir = require('node:process').env.FOCUSTUBE_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'focustube.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const previousUserColumns = db.pragma('table_info(users)');
if (db.name !== ':memory:' && previousUserColumns.length && !previousUserColumns.some(column => column.name === 'email_verified_at')) {
  const backups = path.join(path.dirname(db.name), 'backups');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const backup = path.join(backups, `before-invite-auth-${Date.now()}-${require('crypto').randomBytes(4).toString('hex')}.db`);
  db.prepare('VACUUM INTO ?').run(backup);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT COLLATE NOCASE UNIQUE,
    password_hash TEXT,
    salt TEXT,
    is_guest INTEGER NOT NULL DEFAULT 0,
    download_quality TEXT NOT NULL DEFAULT '720',
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_data (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    courses_json TEXT NOT NULL DEFAULT '{}',
    stats_json TEXT NOT NULL DEFAULT '{}',
    settings_json TEXT NOT NULL DEFAULT '{}',
    workspace_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    active_seconds REAL NOT NULL DEFAULT 0,
    last_active_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS watch_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    course_id TEXT NOT NULL,
    course_title TEXT NOT NULL,
    video_id TEXT NOT NULL,
    video_title TEXT NOT NULL,
    seconds_watched REAL NOT NULL DEFAULT 0,
    completed_at TEXT,
    last_watched_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date, course_id, video_id)
  );

  CREATE INDEX IF NOT EXISTS watch_log_user_date_idx ON watch_log(user_id, date DESC);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS video_notes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    course_title TEXT NOT NULL,
    video_title TEXT NOT NULL,
    document_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, course_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS activity_batches (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, batch_id)
  );
`);

try {
  db.exec('ALTER TABLE user_data ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

try {
  db.exec("ALTER TABLE user_data ADD COLUMN workspace_json TEXT NOT NULL DEFAULT '{}'");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

try {
  db.exec('ALTER TABLE user_data ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

db.transaction(() => {
  const columns = new Set(db.pragma('table_info(users)').map(column => column.name));
  for (const [name, definition] of Object.entries({
    email_normalized: "TEXT CHECK(email_normalized IS NULL OR (length(email_normalized) BETWEEN 3 AND 254 AND email_normalized = lower(trim(email_normalized)) AND is_guest = 0 AND password_hash IS NOT NULL AND salt IS NOT NULL))",
    display_name: "TEXT CHECK(display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 80)",
    is_admin: 'INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1) AND (is_admin = 0 OR is_guest = 0))',
    account_state: "TEXT NOT NULL DEFAULT 'active' CHECK(account_state IN ('active', 'disabled', 'deleted'))",
    email_verified_at: 'TEXT CHECK(email_verified_at IS NULL OR email_normalized IS NOT NULL)',
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
  const firstSetup = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_workspace'").get();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email_normalized);
    CREATE INDEX IF NOT EXISTS users_admin_state_idx ON users(is_admin, account_state);
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_workspace (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      max_members INTEGER NOT NULL CHECK(max_members > 0)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK(typeof(max_uses) = 'integer' AND max_uses BETWEEN 1 AND 1000 AND (is_admin = 0 OR max_uses = 1)),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(use_count) = 'integer' AND use_count BETWEEN 0 AND max_uses),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK(expires_at > created_at),
      consumed_at TEXT CHECK(consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at))
    );
    CREATE INDEX IF NOT EXISTS invitations_expiry_idx ON invitations(expires_at);
    CREATE TABLE IF NOT EXISTS login_budgets (
      budget_key_hash TEXT PRIMARY KEY CHECK(length(budget_key_hash) = 64 AND budget_key_hash NOT GLOB '*[^0-9a-f]*'),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      window_started_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_budgets_window_idx ON login_budgets(window_started_at);
    CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
      code_hash TEXT NOT NULL CHECK(length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
      email_normalized TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'upgrade', 'email')),
      invite_hash TEXT REFERENCES invitations(token_hash) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK(expires_at > created_at),
      sent_at TEXT,
      consumed_at TEXT,
      CHECK((purpose = 'registration' AND invite_hash IS NOT NULL AND user_id IS NULL AND session_hash IS NULL)
        OR (purpose = 'upgrade' AND invite_hash IS NOT NULL AND user_id IS NOT NULL AND session_hash IS NOT NULL)
        OR (purpose = 'email' AND invite_hash IS NULL AND user_id IS NOT NULL AND session_hash IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS email_verifications_expiry_idx ON email_verifications(expires_at);
    CREATE INDEX IF NOT EXISTS email_verifications_target_idx ON email_verifications(email_normalized, purpose, invite_hash, session_hash);
    CREATE TABLE IF NOT EXISTS user_usage (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_login_at TEXT,
      last_active_at TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_days (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      PRIMARY KEY(user_id, date)
    );
    CREATE INDEX IF NOT EXISTS usage_days_date_idx ON usage_days(date);
    CREATE TABLE IF NOT EXISTS presence_leases (
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      tab_id TEXT NOT NULL,
      challenge_hash TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT,
      PRIMARY KEY(session_hash, tab_id)
    );
    CREATE INDEX IF NOT EXISTS presence_active_idx ON presence_leases(last_active_at);
    CREATE TABLE IF NOT EXISTS auth_audit (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event TEXT NOT NULL CHECK(event IN ('login', 'register', 'upgrade', 'email', 'logout')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_audit_time_idx ON auth_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS feedback_threads (
      id TEXT PRIMARY KEY,
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submission_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('bug', 'usability', 'request')),
      visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private')),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
      steps TEXT NOT NULL DEFAULT '',
      expected TEXT NOT NULL DEFAULT '',
      actual TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
      hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
      locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
      moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      moderated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(reporter_id, submission_id)
    );
    CREATE INDEX IF NOT EXISTS feedback_public_idx ON feedback_threads(visibility, hidden, created_at DESC, id);
    CREATE INDEX IF NOT EXISTS feedback_owner_idx ON feedback_threads(reporter_id, created_at DESC, id);
    CREATE TABLE IF NOT EXISTS feedback_replies (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submission_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
      hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
      moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      moderated_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(author_id, submission_id)
    );
    CREATE INDEX IF NOT EXISTS feedback_replies_thread_idx ON feedback_replies(thread_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_reply_parent_idx ON feedback_replies(id, thread_id);
    CREATE TABLE IF NOT EXISTS feedback_screenshots (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
      reply_id TEXT,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 2),
      width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 2560),
      height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 2560),
      data BLOB NOT NULL CHECK(typeof(data) = 'blob' AND length(data) BETWEEN 1 AND 4194304),
      created_at TEXT NOT NULL,
      FOREIGN KEY(reply_id, thread_id) REFERENCES feedback_replies(id, thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS feedback_screenshots_parent_idx ON feedback_screenshots(thread_id, reply_id, position);
    CREATE INDEX IF NOT EXISTS feedback_screenshots_owner_idx ON feedback_screenshots(owner_id);
  `);
  const invitationColumns = new Set(db.pragma('table_info(invitations)').map(column => column.name));
  if (!invitationColumns.has('max_uses')) {
    db.exec("ALTER TABLE invitations ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1 CHECK(typeof(max_uses) = 'integer' AND max_uses BETWEEN 1 AND 1000 AND (is_admin = 0 OR max_uses = 1))");
  }
  if (!invitationColumns.has('use_count')) {
    db.exec("ALTER TABLE invitations ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(use_count) = 'integer' AND use_count BETWEEN 0 AND max_uses)");
    db.exec('UPDATE invitations SET use_count = 1 WHERE consumed_at IS NOT NULL');
  }
  if (firstSetup) db.prepare('INSERT INTO auth_workspace (id, max_members) VALUES (1, 100)').run();
}).immediate();

const now = () => new Date().toISOString();

function authFailure(code) {
  return Object.assign(new Error(code), { code });
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const stmts = {
  createUser: db.prepare(`
    INSERT INTO users (username, password_hash, salt, is_guest, created_at, last_active_at)
    VALUES (@username, @passwordHash, @salt, @isGuest, @createdAt, @createdAt)
  `),
  createData: db.prepare(`
    INSERT OR IGNORE INTO user_data (user_id, courses_json, stats_json, settings_json, workspace_json, revision, updated_at)
    VALUES (?, '{}', '{}', '{}', '{}', 0, ?)
  `),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email_normalized = ?'),
  touchUser: db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?'),
  upgradeGuest: db.prepare(`
    UPDATE users SET username = ?, password_hash = ?, salt = ?, is_guest = 0, last_active_at = ?
    WHERE id = ? AND is_guest = 1
  `),
  setQuality: db.prepare('UPDATE users SET download_quality = ? WHERE id = ?'),
  createSession: db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
  `),
  sessionUser: db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.account_state = 'active'
  `),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  dataByUser: db.prepare('SELECT * FROM user_data WHERE user_id = ?'),
  noteByKey: db.prepare('SELECT * FROM video_notes WHERE user_id = ? AND course_id = ? AND video_id = ?'),
  notesByUser: db.prepare('SELECT * FROM video_notes WHERE user_id = ? ORDER BY course_id, created_at, video_id'),
  notesByCourse: db.prepare('SELECT * FROM video_notes WHERE user_id = ? AND course_id = ? ORDER BY created_at, video_id'),
  noteUsage: db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(document_json AS BLOB))), 0) AS bytes FROM video_notes WHERE user_id = ?'),
  bumpNotes: db.prepare('UPDATE user_data SET notes_revision = notes_revision + 1 WHERE user_id = ?'),
  clearNotes: db.prepare('UPDATE video_notes SET document_json = NULL, revision = revision + 1, updated_at = ? WHERE user_id = ?'),
  clearNotebook: db.prepare('UPDATE video_notes SET document_json = NULL, revision = revision + 1, updated_at = ? WHERE user_id = ? AND course_id = ?'),
  writeNote: db.prepare(`
    INSERT INTO video_notes (user_id, course_id, video_id, course_title, video_title, document_json, revision, created_at, updated_at)
    VALUES (@userId, @courseId, @videoId, @courseTitle, @videoTitle, @document, 1, @updatedAt, @updatedAt)
    ON CONFLICT(user_id, course_id, video_id) DO UPDATE SET
      course_title = excluded.course_title, video_title = excluded.video_title,
      document_json = excluded.document_json, revision = video_notes.revision + 1, updated_at = excluded.updated_at
  `),
  saveData: db.prepare(`
    UPDATE user_data SET
      courses_json = @courses,
      stats_json = @stats,
      settings_json = @settings,
      workspace_json = @workspace,
      revision = revision + 1,
      updated_at = @updatedAt
    WHERE user_id = @userId AND revision = @expectedRevision
  `),
  insertBatch: db.prepare(`
    INSERT OR IGNORE INTO activity_batches (user_id, batch_id, created_at) VALUES (?, ?, ?)
  `),
  addActivity: db.prepare(`
    INSERT INTO activity_log (user_id, date, active_seconds, last_active_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      active_seconds = active_seconds + excluded.active_seconds,
      last_active_at = excluded.last_active_at
  `),
  insertActivity: db.prepare(`
    INSERT INTO activity_log (user_id, date, active_seconds, last_active_at)
    VALUES (?, ?, ?, ?)
  `),
  watchRow: db.prepare(`
    SELECT completed_at FROM watch_log WHERE user_id = ? AND date = ? AND course_id = ? AND video_id = ?
  `),
  addWatch: db.prepare(`
    INSERT INTO watch_log (
      user_id, date, course_id, course_title, video_id, video_title,
      seconds_watched, completed_at, last_watched_at
    ) VALUES (
      @userId, @date, @courseId, @courseTitle, @videoId, @videoTitle,
      @seconds, @completedAt, @lastWatchedAt
    )
    ON CONFLICT(user_id, date, course_id, video_id) DO UPDATE SET
      course_title = excluded.course_title,
      video_title = excluded.video_title,
      seconds_watched = seconds_watched + excluded.seconds_watched,
      completed_at = excluded.completed_at,
      last_watched_at = excluded.last_watched_at
  `),
  insertWatch: db.prepare(`
    INSERT INTO watch_log (
      user_id, date, course_id, course_title, video_id, video_title,
      seconds_watched, completed_at, last_watched_at
    ) VALUES (
      @userId, @date, @courseId, @courseTitle, @videoId, @videoTitle,
      @seconds, @completedAt, @lastWatchedAt
    )
  `),
  deleteActivity: db.prepare('DELETE FROM activity_log WHERE user_id = ?'),
  deleteWatch: db.prepare('DELETE FROM watch_log WHERE user_id = ?'),
  deleteBatches: db.prepare('DELETE FROM activity_batches WHERE user_id = ?'),
  activityRows: db.prepare(`
    SELECT date, active_seconds FROM activity_log WHERE user_id = ? ORDER BY date ASC
  `),
  watchDaily: db.prepare(`
    SELECT date, SUM(seconds_watched) AS watch_seconds
    FROM watch_log WHERE user_id = ? GROUP BY date ORDER BY date ASC
  `),
  watchTotal: db.prepare(`
    SELECT COALESCE(SUM(seconds_watched), 0) AS seconds FROM watch_log WHERE user_id = ?
  `),
  siteTotal: db.prepare(`
    SELECT COALESCE(SUM(active_seconds), 0) AS seconds FROM activity_log WHERE user_id = ?
  `),
  completedTotal: db.prepare(`
    SELECT COUNT(DISTINCT course_id || ':' || video_id) AS count
    FROM watch_log WHERE user_id = ? AND completed_at IS NOT NULL
  `),
  courseSplit: db.prepare(`
    SELECT course_id, MAX(course_title) AS course_title, SUM(seconds_watched) AS seconds
    FROM watch_log WHERE user_id = ? AND date >= ?
    GROUP BY course_id ORDER BY seconds DESC
  `),
  history: db.prepare(`
    SELECT date, course_id, course_title, video_id, video_title,
           seconds_watched, completed_at, last_watched_at
    FROM watch_log WHERE user_id = ?
    ORDER BY date DESC, last_watched_at DESC LIMIT ? OFFSET ?
  `),
  exportWatch: db.prepare(`
    SELECT date, course_id, course_title, video_id, video_title,
           seconds_watched, completed_at, last_watched_at
    FROM watch_log WHERE user_id = ?
    ORDER BY date ASC, last_watched_at ASC
  `),
  cleanupSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  cleanupGuests: db.prepare(`
    DELETE FROM users WHERE is_guest = 1 AND last_active_at < ?
  `),
  cleanupBatches: db.prepare('DELETE FROM activity_batches WHERE created_at < ?'),
};

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email_normalized,
    emailVerified: !!row.email_verified_at,
    displayName: row.display_name || (row.is_guest ? `Guest ${row.id}` : row.username),
    isGuest: !!row.is_guest,
    isAdmin: !!row.is_admin,
    accountState: row.account_state,
    downloadQuality: row.download_quality || '720',
    createdAt: row.created_at,
  };
}

const createUserTx = db.transaction((values) => {
  const result = stmts.createUser.run(values);
  stmts.createData.run(result.lastInsertRowid, values.createdAt);
  return stmts.userById.get(result.lastInsertRowid);
});

function createUser({ username = null, passwordHash = null, salt = null, isGuest = false }) {
  return createUserTx({
    username,
    passwordHash,
    salt,
    isGuest: isGuest ? 1 : 0,
    createdAt: now(),
  });
}

function getUserByName(username) {
  return stmts.userByName.get(username);
}

function getUserByEmail(email) {
  return stmts.userByEmail.get(email);
}

function getUserById(id) {
  return stmts.userById.get(id);
}

function touchUser(id) {
  stmts.touchUser.run(now(), id);
}

function upgradeGuest(id, username, passwordHash, salt) {
  const result = stmts.upgradeGuest.run(username, passwordHash, salt, now(), id);
  return result.changes ? stmts.userById.get(id) : null;
}

function setDownloadQuality(id, quality) {
  stmts.setQuality.run(quality, id);
  return stmts.userById.get(id);
}

function createSession(tokenHash, userId, expiresAt) {
  stmts.createSession.run(tokenHash, userId, now(), expiresAt);
}

function getSessionUser(tokenHash) {
  return stmts.sessionUser.get(tokenHash, now());
}

function deleteSession(tokenHash) {
  db.transaction(() => {
    const user = getSessionUser(tokenHash);
    stmts.deleteSession.run(tokenHash);
    if (user) recordAuthEvent(user.id, 'logout', now());
  }).immediate();
}

function revokeUserSessions(userId) {
  stmts.deleteUserSessions.run(userId);
}

function getAuthWorkspace() {
  const workspace = db.prepare('SELECT * FROM auth_workspace WHERE id = 1').get();
  if (!workspace) throw authFailure('AUTH_UNAVAILABLE');
  return workspace;
}

function setMemberLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw authFailure('INVALID_REQUEST');
  return db.transaction(() => {
    getAuthWorkspace();
    db.prepare('UPDATE auth_workspace SET max_members = ? WHERE id = 1').run(limit);
  }).immediate();
}

const activeAdmin = db.prepare("SELECT 1 FROM users WHERE is_admin = 1 AND account_state = 'active' LIMIT 1");
const inviteByHash = db.prepare('SELECT * FROM invitations WHERE token_hash = ?');

const issueInvitationTx = db.transaction(({ tokenHash, actorSessionHash, bootstrap = false, maxUses = 1 }) => {
  getAuthWorkspace();
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000 || (bootstrap && maxUses !== 1)) throw authFailure('INVALID_REQUEST');
  const createdAt = now();
  if (bootstrap) {
    if (activeAdmin.get()) throw authFailure('ADMIN_EXISTS');
  } else {
    const actor = stmts.sessionUser.get(actorSessionHash, createdAt);
    if (!actor) throw authFailure('UNAUTHENTICATED');
    if (!actor.is_admin || actor.is_guest) throw authFailure('FORBIDDEN');
  }
  const expiresAt = new Date(Date.parse(createdAt) + 86400000).toISOString();
  const result = db.prepare(`
    INSERT INTO invitations (token_hash, is_admin, max_uses, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, bootstrap ? 1 : 0, maxUses, createdAt, expiresAt);
  return { id: Number(result.lastInsertRowid), expiresAt, maxUses, useCount: 0 };
});

function issueInvitation(values) {
  return issueInvitationTx.immediate(values);
}

function invitationAvailable(inviteHash) {
  const invitation = inviteByHash.get(inviteHash);
  return !!invitation && !invitation.consumed_at && invitation.use_count < invitation.max_uses && invitation.expires_at > now();
}

const issueEmailVerificationTx = db.transaction(values => {
  const createdAt = now();
  db.prepare('DELETE FROM email_verifications WHERE expires_at <= ?').run(createdAt);
  if (db.prepare('SELECT count(*) AS count FROM email_verifications').get().count >= 5000) throw authFailure('AUTH_UNAVAILABLE');
  if (values.purpose !== 'email' && !invitationAvailable(values.inviteHash)) throw authFailure('INVALID_INVITATION');
  if (values.purpose !== 'registration') {
    const user = stmts.sessionUser.get(values.currentSessionHash, createdAt);
    if (!user || user.id !== values.userId) throw authFailure('UNAUTHENTICATED');
    if (values.purpose === 'upgrade' ? !user.is_guest : user.is_guest || (user.email_normalized && user.email_normalized !== values.email)) {
      throw authFailure('REGISTRATION_CONFLICT');
    }
  }
  const previous = db.prepare(`SELECT created_at FROM email_verifications WHERE email_normalized = ? AND purpose = ?
    AND invite_hash IS ? AND session_hash IS ? ORDER BY created_at DESC LIMIT 1`).get(values.email, values.purpose, values.inviteHash, values.currentSessionHash);
  if (previous && Date.parse(createdAt) - Date.parse(previous.created_at) < 60000) throw authFailure('VERIFICATION_COOLDOWN');
  db.prepare(`DELETE FROM email_verifications WHERE email_normalized = ? AND purpose = ? AND invite_hash IS ? AND session_hash IS ?`)
    .run(values.email, values.purpose, values.inviteHash, values.currentSessionHash);
  const expiresAt = new Date(Date.parse(createdAt) + 10 * 60_000).toISOString();
  db.prepare(`INSERT INTO email_verifications (token_hash, code_hash, email_normalized, purpose, invite_hash, user_id, session_hash, created_at, expires_at)
    VALUES (@verificationHash, @verificationCodeHash, @email, @purpose, @inviteHash, @userId, @currentSessionHash, @createdAt, @expiresAt)`)
    .run({ ...values, createdAt, expiresAt });
  return { expiresAt };
});

function issueEmailVerification(values) {
  return issueEmailVerificationTx.immediate(values);
}

function markEmailVerificationSent(hash) {
  const result = db.prepare('UPDATE email_verifications SET sent_at = ? WHERE token_hash = ? AND expires_at > ? AND consumed_at IS NULL').run(now(), hash, now());
  if (result.changes !== 1) throw authFailure('INVALID_VERIFICATION');
}

function deleteEmailVerification(hash) {
  db.prepare('DELETE FROM email_verifications WHERE token_hash = ?').run(hash);
}

function matchingEmailVerification(values, timestamp) {
  if (!values?.verificationHash || !values?.verificationCodeHash) return null;
  const row = db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?').get(values.verificationHash);
  if (!row || !row.sent_at || row.consumed_at || row.attempts >= 5 || row.expires_at <= timestamp ||
      row.email_normalized !== values.email || row.purpose !== values.purpose || row.invite_hash !== values.inviteHash ||
      row.user_id !== values.userId || row.session_hash !== values.currentSessionHash) return null;
  return row;
}

function verificationCodeMatches(row, values) {
  const actual = Buffer.from(values.verificationCodeHash, 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  return actual.length === expected.length && require('crypto').timingSafeEqual(actual, expected);
}

const checkEmailVerificationTx = db.transaction(values => {
  const row = matchingEmailVerification(values, now());
  if (!row) return false;
  if (verificationCodeMatches(row, values)) return true;
  db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE token_hash = ? AND attempts < 5').run(values.verificationHash);
  return false;
});

function checkEmailVerification(values) {
  return checkEmailVerificationTx.immediate(values);
}

function consumeEmailVerification(values, timestamp) {
  const row = matchingEmailVerification(values, timestamp);
  if (!row || !verificationCodeMatches(row, values)) throw authFailure('INVALID_VERIFICATION');
  db.prepare('UPDATE email_verifications SET consumed_at = ? WHERE token_hash = ?').run(timestamp, values.verificationHash);
}

const redeemInvitationTx = db.transaction(values => {
  const workspace = getAuthWorkspace();
  const createdAt = now();
  const invitation = inviteByHash.get(values.inviteHash);
  if (!invitation || invitation.consumed_at || invitation.use_count >= invitation.max_uses || invitation.expires_at <= createdAt) throw authFailure('INVALID_INVITATION');
  const guest = values.guestSessionHash ? stmts.sessionUser.get(values.guestSessionHash, createdAt) : null;
  if (values.guestSessionHash && !guest) throw authFailure('UNAUTHENTICATED');
  if (guest && (!guest.is_guest || invitation.is_admin)) throw authFailure('REGISTRATION_CONFLICT');
  if (invitation.is_admin && activeAdmin.get()) throw authFailure('REGISTRATION_CONFLICT');
  const members = db.prepare("SELECT count(*) AS count FROM users WHERE is_guest = 0 AND account_state != 'deleted'").get().count;
  if (members >= workspace.max_members || stmts.userByEmail.get(values.email) || (values.username && stmts.userByName.get(values.username))) throw authFailure('REGISTRATION_CONFLICT');
  consumeEmailVerification({ ...values, purpose: guest ? 'upgrade' : 'registration', userId: guest?.id || null,
    currentSessionHash: guest ? values.guestSessionHash : null }, createdAt);
  let userId;
  if (guest) {
    userId = guest.id;
    db.prepare(`UPDATE users SET email_normalized = ?, username = ?, display_name = ?, password_hash = ?, salt = ?,
      is_guest = 0, last_active_at = ? WHERE id = ?`).run(values.email, values.username || null, values.displayName, values.passwordHash, values.salt, createdAt, userId);
    stmts.deleteUserSessions.run(userId);
  } else {
    const result = db.prepare(`INSERT INTO users (email_normalized, username, display_name, password_hash, salt, is_admin, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(values.email, values.username || null, values.displayName, values.passwordHash, values.salt, invitation.is_admin, createdAt, createdAt);
    userId = Number(result.lastInsertRowid);
    stmts.createData.run(userId, createdAt);
  }
  const consumed = db.prepare(`UPDATE invitations SET use_count = use_count + 1,
    consumed_at = CASE WHEN use_count + 1 = max_uses THEN ? ELSE NULL END
    WHERE token_hash = ? AND consumed_at IS NULL AND use_count < max_uses AND expires_at > ?`).run(createdAt, values.inviteHash, createdAt);
  if (consumed.changes !== 1) throw authFailure('INVALID_INVITATION');
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(createdAt, userId);
  const expiresAt = new Date(Date.parse(createdAt) + values.sessionMs).toISOString();
  stmts.createSession.run(values.sessionHash, userId, createdAt, expiresAt);
  recordAuthEvent(userId, guest ? 'upgrade' : 'register', createdAt);
  return { user: stmts.userById.get(userId), expiresAt };
});

function redeemInvitation(values) {
  try {
    return redeemInvitationTx.immediate(values);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw authFailure('REGISTRATION_CONFLICT');
    throw error;
  }
}

const passwordSessionTx = db.transaction(({ user, sessionHash, sessionMs, email, currentSessionHash, verificationHash, verificationCodeHash, passwordHash, salt }) => {
  if (passwordHash !== undefined && (!currentSessionHash || email !== undefined)) throw authFailure('INVALID_REQUEST');
  const createdAt = now();
  const current = currentSessionHash ? stmts.sessionUser.get(currentSessionHash, createdAt) : stmts.userById.get(user.id);
  if (!current || current.id !== user.id || current.is_guest || current.account_state !== 'active' ||
      current.password_hash !== user.password_hash || current.salt !== user.salt || current.email_normalized !== user.email_normalized || current.username !== user.username) {
    throw authFailure('INVALID_CREDENTIALS');
  }
  if (email !== undefined) {
    const owner = stmts.userByEmail.get(email);
    if (current.email_verified_at || (current.email_normalized && current.email_normalized !== email) || (owner && owner.id !== user.id)) throw authFailure('REGISTRATION_CONFLICT');
    consumeEmailVerification({ email, verificationHash, verificationCodeHash, currentSessionHash, userId: user.id, inviteHash: null, purpose: 'email' }, createdAt);
    db.prepare('UPDATE users SET email_normalized = ?, email_verified_at = ?, display_name = COALESCE(display_name, username) WHERE id = ?').run(email, createdAt, user.id);
    stmts.deleteUserSessions.run(user.id);
  }
  if (passwordHash !== undefined) {
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(passwordHash, salt, user.id);
    stmts.deleteUserSessions.run(user.id);
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
  }
  const expiresAt = new Date(Date.parse(createdAt) + sessionMs).toISOString();
  stmts.createSession.run(sessionHash, user.id, createdAt, expiresAt);
  stmts.touchUser.run(createdAt, user.id);
  if (passwordHash === undefined) recordAuthEvent(user.id, email === undefined ? 'login' : 'email', createdAt);
  return { user: stmts.userById.get(user.id), expiresAt };
});

function passwordSession(values) {
  return passwordSessionTx.immediate(values);
}

const updateAccountProfileTx = db.transaction(({ user, currentSessionHash, displayName, username }) => {
  const current = stmts.sessionUser.get(currentSessionHash, now());
  if (!current || current.id !== user.id || current.is_guest || current.account_state !== 'active' ||
    current.password_hash !== user.password_hash || current.salt !== user.salt) throw authFailure('UNAUTHENTICATED');
  if (current.username !== user.username || current.display_name !== user.display_name) throw authFailure('PROFILE_CHANGED');
  const owner = username ? stmts.userByName.get(username) : null;
  if (owner && owner.id !== current.id) throw authFailure('USERNAME_TAKEN');
  db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?').run(username, displayName, current.id);
  return stmts.userById.get(current.id);
});

function updateAccountProfile(values) {
  try { return updateAccountProfileTx.immediate(values); }
  catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw authFailure('USERNAME_TAKEN');
    throw error;
  }
}

const reserveBudgetsTx = db.transaction((budgets, timestamp) => {
  const windowMs = 15 * 60_000;
  const cutoff = new Date(timestamp - windowMs).toISOString();
  db.prepare('DELETE FROM login_budgets WHERE window_started_at <= ?').run(cutoff);
  const rows = budgets.map(budget => ({ ...budget, row: db.prepare('SELECT * FROM login_budgets WHERE budget_key_hash = ?').get(budget.key) }));
  const blocked = rows.filter(budget => budget.row && budget.row.attempt_count >= budget.limit);
  if (blocked.length) return Math.max(...blocked.map(budget => Math.max(1, Math.ceil((Date.parse(budget.row.window_started_at) + windowMs - timestamp) / 1000))));
  const count = db.prepare('SELECT count(*) AS count FROM login_budgets').get().count;
  if (count + rows.filter(budget => !budget.row).length > 5000) return 900;
  const reserve = db.prepare(`INSERT INTO login_budgets (budget_key_hash, attempt_count, window_started_at) VALUES (?, 1, ?)
    ON CONFLICT(budget_key_hash) DO UPDATE SET attempt_count = attempt_count + 1`);
  for (const budget of rows) reserve.run(budget.key, new Date(timestamp).toISOString());
  return 0;
});

function reserveBudgets(budgets, timestamp = Date.now()) {
  return reserveBudgetsTx.immediate(budgets, timestamp);
}

function recordAuthEvent(userId, event, timestamp) {
  db.prepare('INSERT INTO auth_audit (user_id, event, created_at) VALUES (?, ?, ?)').run(userId, event, timestamp);
  db.prepare('DELETE FROM auth_audit WHERE id <= (SELECT id FROM auth_audit ORDER BY id DESC LIMIT 1 OFFSET 10000)').run();
  if (event !== 'logout' && event !== 'email') db.prepare(`INSERT INTO user_usage (user_id, last_login_at) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_login_at = excluded.last_login_at`).run(userId, timestamp);
}

function presenceUser(sessionHash, timestamp) {
  const user = stmts.sessionUser.get(sessionHash, timestamp);
  if (!user || user.is_guest) throw authFailure('UNAUTHENTICATED');
  return user;
}

function issuePresenceChallenge(sessionHash, tabId, challengeHash, timestamp = Date.now()) {
  return db.transaction(() => {
    const issuedAt = new Date(timestamp).toISOString();
    presenceUser(sessionHash, issuedAt);
    const cutoff = new Date(timestamp - 5 * 60000).toISOString();
    db.prepare('DELETE FROM presence_leases WHERE issued_at <= ? AND (last_active_at IS NULL OR last_active_at <= ?)').run(cutoff, cutoff);
    const previous = db.prepare('SELECT * FROM presence_leases WHERE session_hash = ? AND tab_id = ?').get(sessionHash, tabId);
    if (previous && timestamp - Date.parse(previous.issued_at) < 15000) throw authFailure('RATE_LIMITED');
    if (!previous && db.prepare('SELECT count(*) AS count FROM presence_leases WHERE session_hash = ?').get(sessionHash).count >= 10) throw authFailure('RATE_LIMITED');
    const expiresAt = new Date(timestamp + 45000).toISOString();
    db.prepare(`INSERT INTO presence_leases (session_hash, tab_id, challenge_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_hash, tab_id) DO UPDATE SET challenge_hash = excluded.challenge_hash, issued_at = excluded.issued_at, expires_at = excluded.expires_at`)
      .run(sessionHash, tabId, challengeHash, issuedAt, expiresAt);
    return { expiresAt };
  }).immediate();
}

function confirmPresence(sessionHash, tabId, challengeHash, timestamp = Date.now()) {
  return db.transaction(() => {
    const activeAt = new Date(timestamp).toISOString();
    const user = presenceUser(sessionHash, activeAt);
    const changed = db.prepare(`UPDATE presence_leases SET challenge_hash = NULL, last_active_at = ?
      WHERE session_hash = ? AND tab_id = ? AND challenge_hash = ? AND expires_at > ? AND issued_at <= ?`)
      .run(activeAt, sessionHash, tabId, challengeHash, activeAt, activeAt);
    if (!changed.changes) throw authFailure('INVALID_REQUEST');
    db.prepare(`INSERT INTO user_usage (user_id, last_active_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_active_at = excluded.last_active_at`).run(user.id, activeAt);
    db.prepare('INSERT OR IGNORE INTO usage_days (user_id, date) VALUES (?, ?)').run(user.id, activeAt.slice(0, 10));
  }).immediate();
}

function clearPresence(sessionHash, tabId) {
  db.prepare('UPDATE presence_leases SET challenge_hash = NULL, last_active_at = NULL WHERE session_hash = ? AND tab_id = ?').run(sessionHash, tabId);
}

function getUsageCounts(timestamp = Date.now()) {
  const current = new Date(timestamp).toISOString();
  const cutoff = new Date(timestamp - 5 * 60000).toISOString();
  const activeNow = db.prepare(`SELECT count(DISTINCT sessions.user_id) AS count FROM presence_leases
    JOIN sessions ON sessions.token_hash = presence_leases.session_hash JOIN users ON users.id = sessions.user_id
    WHERE presence_leases.last_active_at > ? AND sessions.expires_at > ? AND users.account_state = 'active' AND users.is_guest = 0`).get(cutoff, current).count;
  const activeToday = db.prepare(`SELECT count(*) AS count FROM usage_days JOIN users ON users.id = user_id
    WHERE date = ? AND users.account_state = 'active' AND users.is_guest = 0`).get(current.slice(0, 10)).count;
  const activeWeek = db.prepare(`SELECT count(DISTINCT user_id) AS count FROM usage_days JOIN users ON users.id = user_id
    WHERE date >= ? AND users.account_state = 'active' AND users.is_guest = 0`).get(new Date(timestamp - 6 * 86400000).toISOString().slice(0, 10)).count;
  const members = db.prepare("SELECT count(*) AS count FROM users WHERE is_guest = 0 AND account_state = 'active'").get().count;
  return { activeNow, activeToday, activeWeek, members };
}

function getAdminUsage(page = 1, timestamp = Date.now()) {
  const current = new Date(timestamp).toISOString();
  const cutoff = new Date(timestamp - 5 * 60000).toISOString();
  const counts = getUsageCounts(timestamp);
  const totalUsers = db.prepare("SELECT count(*) AS count FROM users WHERE is_guest = 0 AND account_state != 'deleted'").get().count;
  const users = db.prepare(`SELECT u.id, u.username, u.account_state AS accountState, u.is_admin AS isAdmin,
    usage.last_login_at AS lastLoginAt, usage.last_active_at AS lastActiveAt,
    EXISTS(SELECT 1 FROM presence_leases p JOIN sessions s ON s.token_hash = p.session_hash
      WHERE s.user_id = u.id AND s.expires_at > ? AND p.last_active_at > ? AND u.account_state = 'active') AS active
    FROM users u LEFT JOIN user_usage usage ON usage.user_id = u.id WHERE u.is_guest = 0 AND u.account_state != 'deleted'
    ORDER BY active DESC, usage.last_active_at DESC, u.id DESC LIMIT 25 OFFSET ?`).all(current, cutoff, (page - 1) * 25);
  const daily = db.prepare(`SELECT date, count(*) AS users FROM usage_days JOIN users ON users.id = user_id
    WHERE date >= ? AND users.account_state != 'deleted' GROUP BY date ORDER BY date`)
    .all(new Date(timestamp - 29 * 86400000).toISOString().slice(0, 10));
  const events = db.prepare(`SELECT a.id, a.user_id AS userId, u.username, a.event, a.created_at AS createdAt
    FROM auth_audit a JOIN users u ON u.id = a.user_id WHERE a.created_at >= ? AND u.account_state != 'deleted'
    ORDER BY a.id DESC LIMIT 30`).all(new Date(timestamp - 30 * 86400000).toISOString());
  return { ...counts, totalUsers, page, pages: Math.max(1, Math.ceil(totalUsers / 25)), users, daily, events, generatedAt: current };
}

function getUserData(userId) {
  stmts.createData.run(userId, now());
  const row = stmts.dataByUser.get(userId);
  const parsedStats = parseJson(row.stats_json, {});
  return {
    courses: parseJson(row.courses_json, {}),
    stats: {
      ...parsedStats,
      seconds: parsedStats.seconds || {},
      lastStreakToast: parsedStats.lastStreakToast || '',
    },
    settings: parseJson(row.settings_json, {}),
    workspace: parseJson(row.workspace_json, {}),
    revision: Number(row.revision || 0),
    notesRevision: Number(row.notes_revision || 0),
    updatedAt: row.updated_at,
  };
}

function noteRecord(row) {
  return {
    courseId: row.course_id, videoId: row.video_id,
    courseTitle: row.course_title, videoTitle: row.video_title,
    document: parseJson(row.document_json, null), revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function getNotebook(userId, courseId) {
  return { records: stmts.notesByCourse.all(userId, courseId).map(noteRecord), notesRevision: getUserData(userId).notesRevision };
}

function getNotebooks(userId) {
  const data = getUserData(userId);
  const notebooks = new Map();
  for (const row of stmts.notesByUser.all(userId)) {
    if (!row.document_json) continue;
    const notebook = notebooks.get(row.course_id) || {
      courseId: row.course_id, title: data.courses[row.course_id]?.title || row.course_title,
      archived: !Object.hasOwn(data.courses, row.course_id), count: 0, updatedAt: row.updated_at,
    };
    notebook.count++;
    if (row.updated_at > notebook.updatedAt) notebook.updatedAt = row.updated_at;
    notebooks.set(row.course_id, notebook);
  }
  return { notebooks: [...notebooks.values()], notesRevision: data.notesRevision };
}

const saveNote = db.transaction((userId, courseId, videoId, document, expectedRevision) => {
  if (!noteModel.validId(courseId) || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw Object.assign(new Error('Invalid notebook video.'), { status: 400 });
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new Error('A note revision is required.'), { status: 400 });
  let checked;
  try { checked = noteModel.validate(document); } catch (err) { throw Object.assign(err, { status: 400 }); }
  const data = getUserData(userId);
  const row = stmts.noteByKey.get(userId, courseId, videoId);
  if ((row?.revision || 0) !== expectedRevision) {
    return { conflict: true, record: row ? noteRecord(row) : null, notesRevision: data.notesRevision };
  }
  const course = Object.hasOwn(data.courses, courseId) ? data.courses[courseId] : null;
  const video = course?.videos?.find(item => item.id === videoId);
  if (!row && !video) throw Object.assign(new Error('Save this course before adding notes.'), { status: 404 });
  if (!row && !checked) return { record: null, notesRevision: data.notesRevision };
  const serialized = checked ? JSON.stringify(checked) : null;
  const usage = stmts.noteUsage.get(userId);
  if ((!row && usage.count >= noteModel.MAX_DOCUMENTS) || usage.bytes - Buffer.byteLength(row?.document_json || '') + Buffer.byteLength(serialized || '') > noteModel.MAX_PROFILE_BYTES) {
    throw Object.assign(new Error('Notebook storage limit reached (5 MiB per profile). Export or remove notes before saving more.'), { status: 413 });
  }
  stmts.writeNote.run({
    userId, courseId, videoId,
    courseTitle: String(course?.title || row?.course_title || 'Untitled course').slice(0, 500),
    videoTitle: String(video?.title || row?.video_title || 'Untitled video').slice(0, 500),
    document: serialized, updatedAt: now(),
  });
  stmts.bumpNotes.run(userId);
  return { record: noteRecord(stmts.noteByKey.get(userId, courseId, videoId)), notesRevision: data.notesRevision + 1 };
});

const deleteNotebook = db.transaction((userId, courseId, expectedNotesRevision) => {
  if (getUserData(userId).notesRevision !== expectedNotesRevision) return null;
  stmts.clearNotebook.run(now(), userId, courseId);
  stmts.bumpNotes.run(userId);
  return getNotebook(userId, courseId);
});

function importLegacyRows(userId, courses, stats) {
  const batchId = `legacy-import:${userId}`;
  if (!stmts.insertBatch.run(userId, batchId, now()).changes) return false;
  for (const [date, seconds] of Object.entries(stats?.seconds || {})) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    if (safeSeconds) stmts.addActivity.run(userId, date, safeSeconds, now());
  }
  for (const course of Object.values(courses || {})) {
    for (const video of course.videos || []) {
      const completedAt = course.completed?.[video.id];
      if (!completedAt) continue;
      const date = String(completedAt).slice(0, 10);
      stmts.addWatch.run({
        userId,
        date,
        courseId: String(course.id).slice(0, 128),
        courseTitle: String(course.title || 'Untitled course').slice(0, 500),
        videoId: String(video.id).slice(0, 32),
        videoTitle: String(video.title || 'Untitled video').slice(0, 500),
        seconds: 0,
        completedAt,
        lastWatchedAt: completedAt,
      });
    }
  }
  return true;
}

const saveUserDataTx = db.transaction(
  (userId, { courses = {}, stats = {}, settings = {}, workspace = {} }, expectedRevision, importLegacy) => {
  const result = stmts.saveData.run({
    userId,
    courses: JSON.stringify(courses),
    stats: JSON.stringify(stats),
    settings: JSON.stringify(settings),
    workspace: JSON.stringify(workspace),
    expectedRevision,
    updatedAt: now(),
  });
  if (!result.changes) return null;
    if (importLegacy) importLegacyRows(userId, courses, stats);
  return Number(stmts.dataByUser.get(userId).revision);
  }
);

function saveUserData(userId, data, expectedRevision, importLegacy = false) {
  return saveUserDataTx(userId, data, expectedRevision, importLegacy);
}

const importUserDataTx = db.transaction((userId, data, expectedRevision, expectedNotesRevision) => {
  const importedAt = now();
  stmts.createData.run(userId, importedAt);
  if (getUserData(userId).notesRevision !== expectedNotesRevision) return null;
  const notebooks = noteModel.validateRecords(data.notebooks || []);
  const existingKeys = new Set(stmts.notesByUser.all(userId).map(row => row.course_id + '/' + row.video_id));
  for (const record of notebooks) existingKeys.add(record.courseId + '/' + record.videoId);
  if (existingKeys.size > noteModel.MAX_DOCUMENTS) throw new Error('Too many notebook documents.');
  const result = stmts.saveData.run({
    userId,
    courses: JSON.stringify(data.courses),
    stats: JSON.stringify(data.stats),
    settings: JSON.stringify(data.settings),
    workspace: JSON.stringify(data.workspace || {}),
    expectedRevision,
    updatedAt: importedAt,
  });
  if (!result.changes) return null;

  stmts.clearNotes.run(importedAt, userId);
  for (const record of notebooks) {
    if (!record.document) continue;
    stmts.writeNote.run({ ...record, userId, document: JSON.stringify(record.document), updatedAt: importedAt });
  }
  stmts.bumpNotes.run(userId);
  stmts.deleteActivity.run(userId);
  stmts.deleteWatch.run(userId);
  stmts.deleteBatches.run(userId);
  for (const row of data.dailyActivity) {
    stmts.insertActivity.run(userId, row.date, row.activeSeconds, importedAt);
  }
  for (const row of data.watchHistory) {
    stmts.insertWatch.run({
      userId,
      date: row.date,
      courseId: row.courseId,
      courseTitle: row.courseTitle,
      videoId: row.videoId,
      videoTitle: row.videoTitle,
      seconds: row.secondsWatched,
      completedAt: row.completedAt,
      lastWatchedAt: row.lastWatchedAt,
    });
  }
  if (data.downloadQuality) stmts.setQuality.run(data.downloadQuality, userId);
  stmts.touchUser.run(importedAt, userId);
  return Number(stmts.dataByUser.get(userId).revision);
});

function importUserData(userId, data, expectedRevision, expectedNotesRevision = 0) {
  return importUserDataTx(userId, data, expectedRevision, expectedNotesRevision);
}

const trackTx = db.transaction((userId, payload) => {
  if (!stmts.insertBatch.run(userId, payload.batchId, now()).changes) return false;
  const date = payload.date;
  const trackedAt = now();
  const activeSeconds = Math.max(0, Math.min(3600, Number(payload.activeSeconds) || 0));
  if (activeSeconds) stmts.addActivity.run(userId, date, activeSeconds, trackedAt);

  for (const item of payload.watch || []) {
    const seconds = Math.max(0, Math.min(3600, Number(item.seconds) || 0));
    const previous = stmts.watchRow.get(userId, date, item.courseId, item.videoId);
    let completedAt = previous?.completed_at || null;
    if (Object.hasOwn(item, 'completedAt')) completedAt = item.completedAt || null;
    stmts.addWatch.run({
      userId,
      date,
      courseId: String(item.courseId || '').slice(0, 128),
      courseTitle: String(item.courseTitle || 'Untitled course').slice(0, 500),
      videoId: String(item.videoId || '').slice(0, 32),
      videoTitle: String(item.videoTitle || 'Untitled video').slice(0, 500),
      seconds,
      completedAt,
      lastWatchedAt: trackedAt,
    });
  }
  stmts.touchUser.run(trackedAt, userId);
  return true;
});

function track(userId, payload) {
  return trackTx(userId, payload);
}

function shiftDate(date, amount) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function streaks(activeDates, currentDate) {
  const days = new Set(activeDates);
  let cursor = currentDate;
  if (!days.has(cursor)) cursor = shiftDate(cursor, -1);
  let current = 0;
  while (days.has(cursor)) {
    current++;
    cursor = shiftDate(cursor, -1);
  }

  let best = 0;
  let run = 0;
  let previous = null;
  for (const date of [...days].sort()) {
    const time = Date.parse(date + 'T00:00:00Z');
    run = previous !== null && time - previous === 86400000 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = time;
  }
  return { current, best };
}

function courseCompletionCounts(userId) {
  const { courses } = getUserData(userId);
  let completedCourses = 0;
  let completedVideos = 0;
  let totalCourses = 0;
  for (const course of Object.values(courses || {})) {
    if (!Array.isArray(course.videos) || !course.videos.length) continue;
    totalCourses++;
    completedVideos += course.videos.filter((video) => course.completed?.[video.id]).length;
    if (course.videos.every((video) => course.completed?.[video.id])) completedCourses++;
  }
  return { completedCourses, completedVideos, totalCourses };
}

function getStatsSummary(userId, currentDate = new Date().toISOString().slice(0, 10)) {
  const activity = stmts.activityRows.all(userId);
  const activeDates = activity.filter((row) => row.active_seconds >= 60).map((row) => row.date);
  const siteSeconds = Number(stmts.siteTotal.get(userId).seconds || 0);
  const watchSeconds = Number(stmts.watchTotal.get(userId).seconds || 0);
  const completion = courseCompletionCounts(userId);
  const recentStart = shiftDate(currentDate, -29);
  const recent = activity.filter((row) => row.date >= recentStart && row.active_seconds > 0);
  const recentSeconds = recent.reduce((total, row) => total + Number(row.active_seconds || 0), 0);
  return {
    siteSeconds,
    watchSeconds,
    daysActive: activeDates.length,
    averageDailySeconds30d: recent.length ? recentSeconds / recent.length : 0,
    videosCompleted: completion.completedVideos,
    ...completion,
    streak: streaks(activeDates, currentDate),
  };
}

function getDailyStats(userId, days = 30, currentDate = new Date().toISOString().slice(0, 10)) {
  const start = shiftDate(currentDate, -(days - 1));
  const activity = new Map(
    stmts.activityRows.all(userId).filter((row) => row.date >= start).map((row) => [row.date, row.active_seconds])
  );
  const watched = new Map(
    stmts.watchDaily.all(userId).filter((row) => row.date >= start).map((row) => [row.date, row.watch_seconds])
  );
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDate(currentDate, -i);
    rows.push({
      date,
      activeSeconds: Number(activity.get(date) || 0),
      watchSeconds: Number(watched.get(date) || 0),
    });
  }
  return rows;
}

function getCourseSplit(userId, days = 30, currentDate = new Date().toISOString().slice(0, 10)) {
  const start = days === 0 ? '0000-00-00' : shiftDate(currentDate, -(days - 1));
  return stmts.courseSplit.all(userId, start).map((row) => ({
    courseId: row.course_id,
    courseTitle: row.course_title,
    seconds: Number(row.seconds || 0),
  }));
}

function getHistory(userId, page = 1, pageSize = 50) {
  const safeSize = Math.max(1, Math.min(100, pageSize));
  const safePage = Math.max(1, page);
  return stmts.history.all(userId, safeSize, (safePage - 1) * safeSize).map((row) => ({
    date: row.date,
    courseId: row.course_id,
    courseTitle: row.course_title,
    videoId: row.video_id,
    videoTitle: row.video_title,
    seconds: Number(row.seconds_watched || 0),
    completedAt: row.completed_at,
    lastWatchedAt: row.last_watched_at,
  }));
}

const getExportData = db.transaction(userId => {
  const user = getUserById(userId);
  const data = getUserData(userId);
  const activity = stmts.activityRows.all(userId).map((row) => ({
    date: row.date,
    activeSeconds: Number(row.active_seconds || 0),
  }));
  const watchHistory = stmts.exportWatch.all(userId).map((row) => ({
    date: row.date,
    courseId: row.course_id,
    courseTitle: row.course_title,
    videoId: row.video_id,
    videoTitle: row.video_title,
    secondsWatched: Number(row.seconds_watched || 0),
    completedAt: row.completed_at,
    lastWatchedAt: row.last_watched_at,
  }));
  return {
    schema: 'focustube-user-export',
    schemaVersion: 2,
    exportedAt: now(),
    profile: publicUser(user),
    courses: data.courses,
    stats: data.stats,
    settings: data.settings,
    workspace: data.workspace,
    notebooks: stmts.notesByUser.all(userId).filter(row => row.document_json).map(noteRecord),
    dashboard: {
      summary: getStatsSummary(userId),
      dailyActivity: activity,
      watchHistory,
    },
    source: {
      app: 'FocusTube',
      profileRevision: data.revision,
      notesRevision: data.notesRevision,
      profileUpdatedAt: data.updatedAt,
    },
  };
});

function feedbackFailure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function feedbackInput(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw feedbackFailure('INVALID_FEEDBACK');
  }
}

function feedbackText(value, maximum, required = false, singleLine = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value) ||
      (singleLine && /[\r\n\t]/.test(value)) || (required && !value.trim())) throw feedbackFailure('INVALID_FEEDBACK');
  return value.trim();
}

function feedbackId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw feedbackFailure('INVALID_FEEDBACK');
  return value;
}

function feedbackViewer(sessionHash, required = false, admin = false) {
  const user = sessionHash ? getSessionUser(sessionHash) : null;
  const member = user && !user.is_guest ? user : null;
  if (required && !member) throw feedbackFailure('UNAUTHENTICATED', 401);
  if (admin && !member?.is_admin) throw feedbackFailure('FORBIDDEN', 403);
  return member;
}

const feedbackHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const feedbackSelect = `SELECT thread.*, CASE WHEN author.account_state != 'deleted' THEN author.username END AS author_name,
  CASE WHEN author.account_state = 'active' THEN author.is_admin ELSE 0 END AS author_admin,
  (SELECT count(*) FROM feedback_replies reply WHERE reply.thread_id = thread.id AND reply.hidden = 0) AS reply_count
  FROM feedback_threads thread LEFT JOIN users author ON author.id = thread.reporter_id`;

function feedbackRow(viewer, id) {
  const row = db.prepare(`${feedbackSelect} WHERE thread.id = ? AND
    ((thread.visibility = 'public' AND thread.hidden = 0) OR thread.reporter_id = ? OR ? = 1)`)
    .get(id, viewer?.id || null, viewer?.is_admin ? 1 : 0);
  if (!row) throw feedbackFailure('FEEDBACK_NOT_FOUND', 404);
  return row;
}

function feedbackSummary(row, viewer, detail = false) {
  return { id: row.id, title: row.title, category: row.category, visibility: row.visibility, status: row.status,
    hidden: !!row.hidden, locked: !!row.locked, revision: row.revision, replyCount: row.reply_count,
    author: { name: row.author_name || 'Tester', isAdmin: !!row.author_admin },
    isOwner: !!viewer && viewer.id === row.reporter_id,
    canReply: !!viewer && !row.hidden && (!row.locked || !!viewer.is_admin),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(detail ? { body: row.body, steps: row.steps, expected: row.expected, actual: row.actual, context: row.context,
      screenshots: feedbackScreenshotList(row.id) } : {}) };
}

function feedbackScreenshotList(threadId, replyId = null) {
  return db.prepare(`SELECT id, width, height, length(data) AS bytes FROM feedback_screenshots
    WHERE thread_id = ? AND reply_id IS ? ORDER BY position`).all(threadId, replyId)
    .map(row => ({ ...row, url: `/api/feedback/${threadId}/screenshots/${row.id}` }));
}

function validatedFeedbackScreenshots(screenshots) {
  if (!Array.isArray(screenshots) || screenshots.length > 3 || screenshots.some(image => !image ||
      !Buffer.isBuffer(image.data) || image.data.length < 1 || image.data.length > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 2560 ||
      !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 2560 ||
      typeof image.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(image.sourceHash))) throw feedbackFailure('INVALID_SCREENSHOT');
  return screenshots;
}

function saveFeedbackScreenshots(ownerId, threadId, replyId, screenshots) {
  if (!screenshots.length) return;
  const bytes = screenshots.reduce((total, image) => total + image.data.length, 0);
  const userBytes = db.prepare('SELECT COALESCE(sum(length(data)), 0) AS bytes FROM feedback_screenshots WHERE owner_id = ?').get(ownerId).bytes;
  const totalBytes = db.prepare('SELECT COALESCE(sum(length(data)), 0) AS bytes FROM feedback_screenshots').get().bytes;
  if (userBytes + bytes > 100 * 1024 * 1024 || totalBytes + bytes > 1024 * 1024 * 1024) throw feedbackFailure('SCREENSHOT_STORAGE_LIMIT', 413);
  const insert = db.prepare(`INSERT INTO feedback_screenshots (id, thread_id, reply_id, owner_id, position, width, height, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  screenshots.forEach((image, position) => insert.run(crypto.randomUUID(), threadId, replyId, ownerId, position, image.width, image.height, image.data, now()));
}

function getFeedbackScreenshot(sessionHash, threadId, screenshotId) {
  const viewer = feedbackViewer(sessionHash);
  feedbackRow(viewer, threadId);
  const image = db.prepare(`SELECT image.data, image.width, image.height FROM feedback_screenshots image
    LEFT JOIN feedback_replies reply ON reply.id = image.reply_id AND reply.thread_id = image.thread_id
    WHERE image.thread_id = ? AND image.id = ? AND (image.reply_id IS NULL OR reply.hidden = 0 OR ? = 1)`)
    .get(threadId, screenshotId, viewer?.is_admin ? 1 : 0);
  if (!image) throw feedbackFailure('FEEDBACK_NOT_FOUND', 404);
  return image;
}

function feedbackPage(options = {}) {
  const page = Number(options.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw feedbackFailure('INVALID_FEEDBACK');
  return { page, limit: 25, offset: (page - 1) * 25 };
}

function createFeedback(sessionHash, input, environment = 'local', reserve, images = []) {
  feedbackInput(input, ['submissionId', 'category', 'visibility', 'publicConsent', 'title', 'body', 'steps', 'expected', 'actual', 'context']);
  const submissionId = feedbackId(input.submissionId);
  if (!['bug', 'usability', 'request'].includes(input.category) || !['public', 'private'].includes(input.visibility) ||
      (input.publicConsent !== undefined && typeof input.publicConsent !== 'boolean')) throw feedbackFailure('INVALID_FEEDBACK');
  if (input.visibility === 'public' && input.publicConsent !== true) throw feedbackFailure('PUBLIC_CONSENT_REQUIRED');
  const values = { category: input.category, visibility: input.visibility, title: feedbackText(input.title, 160, true, true),
    body: feedbackText(input.body, 20000, true), steps: feedbackText(input.steps, 8000), expected: feedbackText(input.expected, 8000),
    actual: feedbackText(input.actual, 8000), context: feedbackText(input.context, 1000) };
  if (Object.values(values).join('').length > 20000) throw feedbackFailure('INVALID_FEEDBACK');
  const screenshots = validatedFeedbackScreenshots(images);
  const hash = feedbackHash(screenshots.length ? { ...values, screenshotHashes: screenshots.map(image => image.sourceHash) } : values);
  return db.transaction(() => {
    const viewer = feedbackViewer(sessionHash, true);
    const existing = db.prepare('SELECT id, payload_hash FROM feedback_threads WHERE reporter_id = ? AND submission_id = ?').get(viewer.id, submissionId);
    if (existing && existing.payload_hash !== hash) throw feedbackFailure('FEEDBACK_CONFLICT', 409);
    if (existing) return { thread: feedbackSummary(feedbackRow(viewer, existing.id), viewer, true), replayed: true };
    reserve?.();
    const id = crypto.randomUUID();
    const timestamp = now();
    db.prepare(`INSERT INTO feedback_threads (id, reporter_id, submission_id, payload_hash, category, visibility,
      title, body, steps, expected, actual, context, environment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, viewer.id, submissionId, hash, values.category, values.visibility, values.title, values.body,
        values.steps, values.expected, values.actual, values.context,
        ['local', 'dev', 'production', 'test'].includes(environment) ? environment : 'local', timestamp, timestamp);
      saveFeedbackScreenshots(viewer.id, id, null, screenshots);
    return { thread: feedbackSummary(feedbackRow(viewer, id), viewer, true), replayed: false };
  }).immediate();
}

function listFeedback(sessionHash, scope = 'public', options = {}) {
  const viewer = feedbackViewer(sessionHash, scope !== 'public', scope === 'all');
  const { page, limit, offset } = feedbackPage(options);
  const filters = [];
  const parameters = [];
  if (scope === 'public') filters.push("thread.visibility = 'public' AND thread.hidden = 0");
  else if (scope === 'mine') { filters.push('thread.reporter_id = ?'); parameters.push(viewer.id); }
  else if (scope !== 'all') throw feedbackFailure('INVALID_FEEDBACK');
  for (const [key, allowed] of [['category', ['bug', 'usability', 'request']], ['status', ['open', 'in_progress', 'resolved', 'closed']]]) {
    if (options[key]) {
      if (!allowed.includes(options[key])) throw feedbackFailure('INVALID_FEEDBACK');
      filters.push(`thread.${key} = ?`); parameters.push(options[key]);
    }
  }
  if (options.q) { filters.push('instr(lower(thread.title), lower(?)) > 0'); parameters.push(feedbackText(options.q, 100, false, true)); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) AS count FROM feedback_threads thread ${where}`).get(...parameters).count;
  const items = db.prepare(`${feedbackSelect} ${where} ORDER BY thread.created_at DESC, thread.id DESC LIMIT ? OFFSET ?`)
    .all(...parameters, limit, offset).map(row => feedbackSummary(row, viewer));
  return { items, total, page, pageSize: limit };
}

function getFeedback(sessionHash, id) {
  const viewer = feedbackViewer(sessionHash);
  return feedbackSummary(feedbackRow(viewer, id), viewer, true);
}

function getFeedbackReplies(sessionHash, id, options = {}) {
  const viewer = feedbackViewer(sessionHash);
  feedbackRow(viewer, id);
  const { page, limit, offset } = feedbackPage(options);
  const visible = viewer?.is_admin ? '1 = 1' : 'reply.hidden = 0';
  const total = db.prepare(`SELECT count(*) AS count FROM feedback_replies reply WHERE thread_id = ? AND ${visible}`).get(id).count;
  const items = db.prepare(`SELECT reply.id, reply.body, reply.hidden, reply.created_at,
    CASE WHEN author.account_state != 'deleted' THEN author.username END AS author_name,
    CASE WHEN author.account_state = 'active' THEN author.is_admin ELSE 0 END AS author_admin
    FROM feedback_replies reply LEFT JOIN users author ON author.id = reply.author_id
    WHERE reply.thread_id = ? AND ${visible} ORDER BY reply.created_at, reply.id LIMIT ? OFFSET ?`)
    .all(id, limit, offset).map(row => ({ id: row.id, body: row.body, hidden: !!row.hidden, createdAt: row.created_at,
      author: { name: row.author_name || 'Tester', isAdmin: !!row.author_admin }, screenshots: feedbackScreenshotList(id, row.id) }));
  return { items, total, page, pageSize: limit };
}

function addFeedbackReply(sessionHash, threadId, input, reserve, images = []) {
  feedbackInput(input, ['submissionId', 'body']);
  const submissionId = feedbackId(input.submissionId);
  const body = feedbackText(input.body, 8000, true);
  const screenshots = validatedFeedbackScreenshots(images);
  const hash = feedbackHash(screenshots.length ? { threadId, body, screenshotHashes: screenshots.map(image => image.sourceHash) } : { threadId, body });
  return db.transaction(() => {
    const viewer = feedbackViewer(sessionHash, true);
    const thread = feedbackRow(viewer, threadId);
    const existing = db.prepare('SELECT id, payload_hash FROM feedback_replies WHERE author_id = ? AND submission_id = ?').get(viewer.id, submissionId);
    if (existing && existing.payload_hash !== hash) throw feedbackFailure('FEEDBACK_CONFLICT', 409);
    if (existing) return { id: existing.id, replayed: true };
    if (thread.hidden || (thread.locked && !viewer.is_admin)) throw feedbackFailure('FEEDBACK_LOCKED', 409);
    reserve?.();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO feedback_replies (id, thread_id, author_id, submission_id, payload_hash, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, threadId, viewer.id, submissionId, hash, body, now());
    saveFeedbackScreenshots(viewer.id, threadId, id, screenshots);
    db.prepare('UPDATE feedback_threads SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), threadId);
    return { id, replayed: false };
  }).immediate();
}

function feedbackRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw feedbackFailure('INVALID_FEEDBACK');
}

function updateFeedback(sessionHash, id, input) {
  feedbackInput(input, ['revision', 'status', 'hidden', 'locked']);
  feedbackRevision(input.revision);
  if (input.status !== undefined && !['open', 'in_progress', 'resolved', 'closed'].includes(input.status)) throw feedbackFailure('INVALID_FEEDBACK');
  for (const key of ['hidden', 'locked']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw feedbackFailure('INVALID_FEEDBACK');
  if (Object.keys(input).length < 2) throw feedbackFailure('INVALID_FEEDBACK');
  return db.transaction(() => {
    const viewer = feedbackViewer(sessionHash, true, true);
    const thread = feedbackRow(viewer, id);
    if (thread.revision !== input.revision) throw feedbackFailure('FEEDBACK_CONFLICT', 409);
    db.prepare(`UPDATE feedback_threads SET status = ?, hidden = ?, locked = ?, moderated_by = ?, moderated_at = ?,
      updated_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(input.status ?? thread.status, Number(input.hidden ?? thread.hidden), Number(input.locked ?? thread.locked), viewer.id, now(), now(), id);
    return feedbackSummary(feedbackRow(viewer, id), viewer, true);
  }).immediate();
}

function moderateFeedbackReply(sessionHash, threadId, replyId, input) {
  feedbackInput(input, ['revision', 'hidden']);
  feedbackRevision(input.revision);
  if (typeof input.hidden !== 'boolean') throw feedbackFailure('INVALID_FEEDBACK');
  return db.transaction(() => {
    const viewer = feedbackViewer(sessionHash, true, true);
    const thread = feedbackRow(viewer, threadId);
    if (thread.revision !== input.revision) throw feedbackFailure('FEEDBACK_CONFLICT', 409);
    const result = db.prepare('UPDATE feedback_replies SET hidden = ?, moderated_by = ?, moderated_at = ? WHERE id = ? AND thread_id = ?')
      .run(Number(input.hidden), viewer.id, now(), replyId, threadId);
    if (!result.changes) throw feedbackFailure('FEEDBACK_NOT_FOUND', 404);
    db.prepare('UPDATE feedback_threads SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), threadId);
    return { ok: true };
  }).immediate();
}

function cleanup() {
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const batchCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  stmts.cleanupSessions.run(now());
  stmts.cleanupGuests.run(cutoff);
  stmts.cleanupBatches.run(batchCutoff);
  db.prepare('DELETE FROM login_budgets WHERE window_started_at <= ?').run(new Date(Date.now() - 15 * 60_000).toISOString());
  db.prepare('DELETE FROM invitations WHERE expires_at <= ?').run(batchCutoff);
  db.prepare('DELETE FROM email_verifications WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM auth_audit WHERE created_at < ?').run(batchCutoff);
  db.prepare('DELETE FROM usage_days WHERE date < ?').run(cutoff.slice(0, 10));
  db.prepare('UPDATE user_usage SET last_login_at = NULL WHERE last_login_at < ?').run(batchCutoff);
  db.prepare('UPDATE user_usage SET last_active_at = NULL WHERE last_active_at < ?').run(batchCutoff);
  db.prepare('DELETE FROM presence_leases WHERE issued_at <= ?').run(new Date(Date.now() - 5 * 60000).toISOString());
}

function importLegacyData(userId, courses, stats) {
  return db.transaction(importLegacyRows)(userId, courses, stats);
}

cleanup();

module.exports = {
  db,
  dataDir,
  publicUser,
  createUser,
  getUserByName,
  getUserByEmail,
  getUserById,
  touchUser,
  upgradeGuest,
  setDownloadQuality,
  createSession,
  getSessionUser,
  deleteSession,
  revokeUserSessions,
  getAuthWorkspace,
  setMemberLimit,
  issueInvitation,
  invitationAvailable,
  issueEmailVerification,
  markEmailVerificationSent,
  deleteEmailVerification,
  checkEmailVerification,
  redeemInvitation,
  passwordSession,
  updateAccountProfile,
  reserveBudgets,
  issuePresenceChallenge,
  confirmPresence,
  clearPresence,
  getUsageCounts,
  getAdminUsage,
  getUserData,
  getNotebooks,
  getNotebook,
  saveNote,
  deleteNotebook,
  saveUserData,
  importUserData,
  track,
  getStatsSummary,
  getDailyStats,
  getCourseSplit,
  getHistory,
  getExportData,
  importLegacyData,
  createFeedback,
  listFeedback,
  getFeedback,
  getFeedbackReplies,
  getFeedbackScreenshot,
  addFeedbackReply,
  updateFeedback,
  moderateFeedbackReply,
  cleanup,
};