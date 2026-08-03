'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'focustube.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

const now = () => new Date().toISOString();

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
    INSERT OR IGNORE INTO user_data (user_id, courses_json, stats_json, settings_json, revision, updated_at)
    VALUES (?, '{}', '{}', '{}', 0, ?)
  `),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
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
    WHERE s.token_hash = ? AND s.expires_at > ?
  `),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  dataByUser: db.prepare('SELECT * FROM user_data WHERE user_id = ?'),
  saveData: db.prepare(`
    UPDATE user_data SET
      courses_json = @courses,
      stats_json = @stats,
      settings_json = @settings,
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
    displayName: row.is_guest ? `Guest ${row.id}` : row.username,
    isGuest: !!row.is_guest,
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
  stmts.deleteSession.run(tokenHash);
}

function revokeUserSessions(userId) {
  stmts.deleteUserSessions.run(userId);
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
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at,
  };
}

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
  (userId, { courses = {}, stats = {}, settings = {} }, expectedRevision, importLegacy) => {
  const result = stmts.saveData.run({
    userId,
    courses: JSON.stringify(courses),
    stats: JSON.stringify(stats),
    settings: JSON.stringify(settings),
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

function getExportData(userId) {
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
    schemaVersion: 1,
    exportedAt: now(),
    profile: publicUser(user),
    courses: data.courses,
    stats: data.stats,
    settings: data.settings,
    dashboard: {
      summary: getStatsSummary(userId),
      dailyActivity: activity,
      watchHistory,
    },
    source: {
      app: 'FocusTube',
      profileRevision: data.revision,
      profileUpdatedAt: data.updatedAt,
    },
  };
}

function cleanup() {
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const batchCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  stmts.cleanupSessions.run(now());
  stmts.cleanupGuests.run(cutoff);
  stmts.cleanupBatches.run(batchCutoff);
}

function importLegacyData(userId, courses, stats) {
  return db.transaction(importLegacyRows)(userId, courses, stats);
}

cleanup();

module.exports = {
  db,
  publicUser,
  createUser,
  getUserByName,
  getUserById,
  touchUser,
  upgradeGuest,
  setDownloadQuality,
  createSession,
  getSessionUser,
  deleteSession,
  revokeUserSessions,
  getUserData,
  saveUserData,
  track,
  getStatsSummary,
  getDailyStats,
  getCourseSplit,
  getHistory,
  getExportData,
  importLegacyData,
  cleanup,
};