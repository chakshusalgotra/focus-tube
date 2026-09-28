'use strict';

const DAY = 86400000;
const NOTICE = '2026-09-28';
const FEATURES = ['course', 'notes', 'chat', 'extension'];
const crypto = require('node:crypto');
const AUDIENCE_NOTICE = '2026-09-28-audience';
const AUDIENCE_OPTIONS = {
  role: ['student', 'professional', 'job-seeker', 'other', 'prefer-not'],
  goal: ['coursework', 'upskilling', 'interview', 'interest', 'other', 'prefer-not'],
  source: ['friend', 'linkedin', 'twitter', 'reddit', 'instagram', 'youtube', 'search', 'other', 'prefer-not'],
};

function createAnalyticsStore(db, { enabled = false, clock = Date.now } = {}) {
  const audienceSchema = `CREATE TABLE IF NOT EXISTS analytics_audience (
    user_id INTEGER PRIMARY KEY REFERENCES analytics_members(user_id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('unseen','offered','skipped','answered')),
    role TEXT CHECK(role IS NULL OR role IN ('student','professional','job-seeker','other','prefer-not')),
    goal TEXT CHECK(goal IS NULL OR goal IN ('coursework','upskilling','interview','interest','other','prefer-not')),
    source TEXT CHECK(source IS NULL OR source IN ('friend','linkedin','twitter','reddit','instagram','youtube','search','other','prefer-not')),
    notice TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      consent INTEGER NOT NULL CHECK(consent IN (0,1)),
      excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
      notice TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analytics_members (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enrolled_at INTEGER NOT NULL, first_course_at INTEGER, activated_at INTEGER,
      sample_at INTEGER, watching INTEGER NOT NULL DEFAULT 0, activation_seconds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS analytics_daily (
      user_id INTEGER NOT NULL REFERENCES analytics_members(user_id) ON DELETE CASCADE,
      date TEXT NOT NULL, watch_seconds INTEGER NOT NULL DEFAULT 0,
      course INTEGER NOT NULL DEFAULT 0, notes INTEGER NOT NULL DEFAULT 0,
      chat INTEGER NOT NULL DEFAULT 0, extension INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,date)
    );
    CREATE INDEX IF NOT EXISTS analytics_daily_date ON analytics_daily(date,user_id);
    CREATE TABLE IF NOT EXISTS analytics_coverage (start INTEGER PRIMARY KEY, finish INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_metadata (id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER NOT NULL);
  `);
  db.transaction(() => {
    const previous = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_audience'").get();
    if (previous && !previous.sql.includes("'reddit'")) {
      db.exec(audienceSchema.replace('analytics_audience', 'analytics_audience_next'));
      db.exec('INSERT INTO analytics_audience_next SELECT * FROM analytics_audience');
      db.exec('DROP TABLE analytics_audience');
      db.exec('ALTER TABLE analytics_audience_next RENAME TO analytics_audience');
    } else db.exec(audienceSchema);
  }).immediate();
  const date = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  let droppedSignals = 0;
  const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_REQUEST' }); };
  const eligible = userId => db.prepare(`SELECT p.user_id FROM analytics_preferences p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? AND p.consent=1 AND p.excluded=0 AND p.notice=? AND u.is_guest=0 AND u.is_admin=0 AND u.account_state='active'`).get(userId, NOTICE);
  function preference(userId) {
    const row = db.prepare('SELECT consent,excluded,notice FROM analytics_preferences WHERE user_id=?').get(userId);
    const user = db.prepare('SELECT is_admin,is_guest FROM users WHERE id=?').get(userId);
    return { available: enabled, consent: row?.consent === 1 && row.notice === NOTICE,
      excluded: !!row?.excluded || !!user?.is_admin || !!user?.is_guest, notice: NOTICE };
  }
  function setPreference(userId, consent, notice) {
    if (typeof consent !== 'boolean' || notice !== NOTICE) fail('Choose a valid analytics preference.');
    if (consent && !enabled) fail('Optional analytics is not enabled on this installation.');
    return db.transaction(() => {
      const previous = preference(userId);
      db.prepare(`INSERT INTO analytics_preferences(user_id,consent,notice,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET consent=excluded.consent,notice=excluded.notice,updated_at=excluded.updated_at`).run(userId, +consent, NOTICE, clock());
      if (!consent) db.prepare('DELETE FROM analytics_members WHERE user_id=?').run(userId);
      else if (!previous.consent && eligible(userId)) db.prepare('INSERT OR IGNORE INTO analytics_members(user_id,enrolled_at) VALUES(?,?)').run(userId, clock());
      return preference(userId);
    }).immediate();
  }
  function exclude(userId, excluded) {
    if (typeof excluded !== 'boolean') fail('Invalid analytics exclusion.');
    return db.transaction(() => {
      db.prepare(`INSERT INTO analytics_preferences(user_id,consent,excluded,notice,updated_at) VALUES(?,0,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET excluded=excluded.excluded,consent=0,updated_at=excluded.updated_at`).run(userId, +excluded, NOTICE, clock());
      db.prepare('DELETE FROM analytics_members WHERE user_id=?').run(userId);
      return preference(userId);
    }).immediate();
  }
  function coverage(timestamp = clock()) {
    if (!enabled) return;
    db.prepare('INSERT OR IGNORE INTO analytics_metadata(id,started_at) VALUES(1,?)').run(timestamp);
    const last = db.prepare('SELECT start,finish FROM analytics_coverage ORDER BY start DESC LIMIT 1').get();
    if (last && timestamp >= last.finish && timestamp - last.finish <= 90000) db.prepare('UPDATE analytics_coverage SET finish=? WHERE start=?').run(timestamp, last.start);
    else db.prepare('INSERT OR IGNORE INTO analytics_coverage(start,finish) VALUES(?,?)').run(timestamp, timestamp);
  }
  function audience(userId) {
    const available = enabled && !!eligible(userId);
    if (available && db.prepare('SELECT 1 FROM analytics_members WHERE user_id=?').get(userId)) {
      db.prepare(`INSERT OR IGNORE INTO analytics_audience(user_id,revision,state,notice,updated_at)
        VALUES(?,?,'unseen',?,?)`).run(userId, crypto.randomUUID(), AUDIENCE_NOTICE, clock());
    }
    const row = db.prepare('SELECT revision,state,role,goal,source,notice,updated_at FROM analytics_audience WHERE user_id=?').get(userId);
    return { available, notice: AUDIENCE_NOTICE, revision: row?.revision ?? null, state: row?.state ?? 'unseen',
      answers: { role: row?.role ?? null, goal: row?.goal ?? null, source: row?.source ?? null },
      canOffer: false };
  }
  function validateAnswers(answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
      Object.keys(answers).some(key => !Object.hasOwn(AUDIENCE_OPTIONS, key))) fail('Choose valid audience options.');
    for (const [key, values] of Object.entries(AUDIENCE_OPTIONS)) if (answers[key] != null && !values.includes(answers[key])) fail('Choose valid audience options.');
  }
  function validateOnboarding(input) {
    if (input === undefined) return;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['consent', 'notice', 'audienceNotice', 'answers'].includes(key)) ||
      typeof input.consent !== 'boolean') fail('Invalid onboarding preferences.');
    if (!input.consent) {
      if (input.answers !== undefined) fail('Answers require explicit optional analytics consent.');
      return;
    }
    if (!enabled || input.notice !== NOTICE || input.audienceNotice !== AUDIENCE_NOTICE) fail('Refresh optional onboarding preferences before joining.');
    validateAnswers(input.answers);
  }
  function saveOnboarding(userId, input) {
    validateOnboarding(input);
    if (!input?.consent || db.prepare('SELECT is_admin FROM users WHERE id=?').get(userId)?.is_admin) return;
    setPreference(userId, true, NOTICE);
    const current = audience(userId);
    saveAudience(userId, { action: 'save', revision: current.revision, notice: AUDIENCE_NOTICE, answers: input.answers });
  }
  function saveAudience(userId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['action', 'revision', 'notice', 'answers'].includes(key)) ||
      !['offer', 'skip', 'save', 'remove'].includes(input.action) || input.notice !== AUDIENCE_NOTICE) fail('Invalid audience request.');
    if (input.action === 'save') {
      validateAnswers(input.answers);
    } else if (input.answers !== undefined) fail('This action does not accept answers.');
    return db.transaction(() => {
      const current = audience(userId);
      if (!current.revision || input.revision !== current.revision) throw Object.assign(new Error('Your survey changed. Refresh it before saving again.'), { status: 409, code: 'AUDIENCE_CHANGED' });
      if (input.action !== 'remove' && !current.available) fail('Opt in to optional analytics before sharing a learning profile.');
      if (input.action === 'offer' && !current.canOffer) fail('The survey is not due.');
      if (input.action === 'skip' && current.state === 'answered') fail('Use Remove answers to delete a saved learning profile.');
      const state = input.action === 'offer' ? 'offered' : input.action === 'save' ? 'answered' : 'skipped';
      const answers = input.action === 'save' ? input.answers : {};
      db.prepare('UPDATE analytics_audience SET revision=?,state=?,role=?,goal=?,source=?,notice=?,updated_at=? WHERE user_id=?')
        .run(crypto.randomUUID(), state, answers.role ?? null, answers.goal ?? null, answers.source ?? null, AUDIENCE_NOTICE, clock(), userId);
      return audience(userId);
    }).immediate();
  }
  function member(userId, timestamp) {
    if (!enabled || !eligible(userId)) return null;
    db.prepare('INSERT OR IGNORE INTO analytics_members(user_id,enrolled_at) VALUES(?,?)').run(userId, timestamp);
    return db.prepare('SELECT * FROM analytics_members WHERE user_id=?').get(userId);
  }
  function activity(userId, watching, timestamp = clock()) {
    return db.transaction(() => {
      const record = member(userId, timestamp);
      if (!record) return;
      coverage(timestamp);
      const elapsed = record.sample_at === null ? 0 : timestamp - record.sample_at;
      if (elapsed < 0) return;
      const seconds = watching && record.watching && elapsed <= 45000 ? Math.floor(Math.min(elapsed, 30000) / 1000) : 0;
      db.prepare('INSERT OR IGNORE INTO analytics_daily(user_id,date) VALUES(?,?)').run(userId, date(timestamp));
      if (seconds) {
        const midnight = Date.parse(date(timestamp));
        const todaySeconds = Math.min(seconds, Math.floor((timestamp - midnight) / 1000));
        for (const [day, amount] of [[date(timestamp), todaySeconds], [date(timestamp - DAY), seconds - todaySeconds]]) {
          if (amount) db.prepare(`INSERT INTO analytics_daily(user_id,date,watch_seconds) VALUES(?,?,?)
            ON CONFLICT(user_id,date) DO UPDATE SET watch_seconds=MIN(86400,watch_seconds+excluded.watch_seconds)`).run(userId, day, amount);
        }
      }
      db.prepare('UPDATE analytics_members SET sample_at=?,watching=? WHERE user_id=?').run(timestamp, +!!watching, userId);
      if (record.first_course_at !== null && record.activated_at === null && timestamp - record.enrolled_at < 7 * DAY) {
        const total = record.activation_seconds + (record.sample_at >= record.first_course_at ? seconds : 0);
        db.prepare('UPDATE analytics_members SET activation_seconds=? WHERE user_id=?').run(total, userId);
        if (total >= 300) db.prepare('UPDATE analytics_members SET activated_at=? WHERE user_id=?').run(timestamp, userId);
      }
    }).immediate();
  }
  function feature(userId, name, timestamp = clock()) {
    if (!FEATURES.includes(name)) fail('Invalid analytics feature.');
    return db.transaction(() => {
      const record = member(userId, timestamp);
      if (!record) return;
      coverage(timestamp);
      db.prepare(`INSERT INTO analytics_daily(user_id,date,${name}) VALUES(?,?,1)
        ON CONFLICT(user_id,date) DO UPDATE SET ${name}=1`).run(userId, date(timestamp));
      if (name === 'course' && record.first_course_at === null) db.prepare('UPDATE analytics_members SET first_course_at=? WHERE user_id=?').run(timestamp, userId);
    }).immediate();
  }
  function cleanup(timestamp = clock()) {
    const cutoff = timestamp - 90 * DAY;
    db.prepare('DELETE FROM analytics_daily WHERE date<?').run(date(timestamp - 89 * DAY));
    db.prepare('DELETE FROM analytics_coverage WHERE finish<?').run(cutoff);
    db.prepare(`DELETE FROM analytics_members WHERE user_id IN (SELECT m.user_id FROM analytics_members m JOIN users u ON u.id=m.user_id
      WHERE u.is_admin=1 OR u.is_guest=1 OR u.account_state!='active')`).run();
    db.prepare('UPDATE analytics_members SET first_course_at=NULL WHERE first_course_at<?').run(cutoff);
    db.prepare('UPDATE analytics_members SET activated_at=NULL WHERE activated_at<?').run(cutoff);
    db.prepare('UPDATE analytics_members SET sample_at=NULL,watching=0 WHERE sample_at<?').run(cutoff);
    db.prepare('UPDATE analytics_members SET activation_seconds=0 WHERE enrolled_at<?').run(cutoff);
    db.prepare("UPDATE analytics_audience SET role=NULL,goal=NULL,source=NULL,state='skipped',revision=?,updated_at=? WHERE updated_at<? AND state='answered'")
      .run(crypto.randomUUID(), timestamp, cutoff);
  }
  function audienceSummary(timestamp = clock()) {
    cleanup(timestamp);
    const end = Date.parse(date(timestamp));
    const start = end - 30 * DAY;
    const rows = db.prepare(`SELECT m.user_id,m.enrolled_at,m.first_course_at,m.activated_at,a.state,a.role,a.goal,a.source
      FROM analytics_members m JOIN analytics_preferences p ON p.user_id=m.user_id JOIN users u ON u.id=m.user_id
      LEFT JOIN analytics_audience a ON a.user_id=m.user_id AND a.notice=?
      WHERE p.consent=1 AND p.excluded=0 AND p.notice=? AND u.is_admin=0 AND u.is_guest=0 AND u.account_state='active'
      AND EXISTS(SELECT 1 FROM analytics_daily d WHERE d.user_id=m.user_id AND d.date>=? AND d.date<?)`)
      .all(AUDIENCE_NOTICE, NOTICE, date(start), date(end));
    const periods = db.prepare('SELECT start,finish FROM analytics_coverage WHERE finish>=?').all(start);
    const covered = (from, until) => periods.some(period => period.start <= from && period.finish >= until);
    const safeCount = count => count === 0 || count >= 10;
    const responded = rows.filter(row => row.state === 'answered' && [row.role, row.goal, row.source].some(value => value !== null)).length;
    const responseVisible = rows.length >= 10 && safeCount(responded) && safeCount(rows.length - responded);
    const dimensions = Object.entries(AUDIENCE_OPTIONS).map(([name, options]) => {
      const groups = [...options, 'unknown'].map(value => {
        const members = rows.filter(row => (row[name] || 'unknown') === value);
        return { value, members };
      });
      const visible = rows.length >= 10 && groups.every(group => safeCount(group.members.length));
      if (!visible) return { name, suppressed: true, buckets: [] };
      const buckets = groups.map(({ value, members }) => {
        const activation = members.filter(member => member.enrolled_at >= start && member.enrolled_at + 7 * DAY <= end && covered(member.enrolled_at, member.enrolled_at + 7 * DAY));
        const activated = activation.filter(member => member.activated_at !== null).length;
        const retained = members.filter(member => {
          const target = Date.parse(date(member.enrolled_at)) + 7 * DAY;
          return member.enrolled_at >= start && target + DAY <= end && covered(target, target + DAY);
        });
        const returned = retained.filter(member => db.prepare('SELECT 1 FROM analytics_daily WHERE user_id=? AND date=?')
          .get(member.user_id, date(Date.parse(date(member.enrolled_at)) + 7 * DAY))).length;
        const rate = (success, total) => success >= 10 && total - success >= 10 ? { eligible: total, successful: success, percent: Math.round(success / total * 100) } : null;
        return { value, count: members.length, percent: Math.round(members.length / rows.length * 100),
          activation: name === 'source' ? null : rate(activated, activation.length),
          d7: name === 'source' ? null : rate(returned, retained.length) };
      });
      for (const metric of ['activation', 'd7']) if (buckets.some(bucket => bucket.count && bucket[metric] === null)) {
        for (const bucket of buckets) bucket[metric] = null;
      }
      return { name, suppressed: false, buckets };
    });
    return { generatedAt: new Date(timestamp).toISOString(), window: { start: date(start), endExclusive: date(end) },
      minimumGroup: 10, eligible: rows.length >= 10 ? rows.length : null, respondents: responseVisible ? responded : null,
      responsePercent: responseVisible ? Math.round(responded / rows.length * 100) : null, dimensions };
  }
  function summary(days = 30, timestamp = clock()) {
    if (![7, 30, 90].includes(days)) fail('Choose 7, 30, or 90 days.');
    cleanup(timestamp);
    coverage(timestamp);
    const today = date(timestamp);
    const firstDay = date(timestamp - (days - 1) * DAY);
    const valid = `JOIN analytics_preferences p ON p.user_id=d.user_id JOIN users u ON u.id=d.user_id
      WHERE p.consent=1 AND p.excluded=0 AND p.notice='${NOTICE}' AND u.is_admin=0 AND u.is_guest=0 AND u.account_state='active'`;
    const daily = db.prepare(`SELECT d.date,COUNT(*) AS users,SUM(watch_seconds) AS watchSeconds FROM analytics_daily d ${valid}
      AND d.date>=? GROUP BY d.date ORDER BY d.date`).all(firstDay);
    const periods = db.prepare('SELECT start,finish FROM analytics_coverage WHERE finish>=? ORDER BY start').all(timestamp - 91 * DAY);
    const complete = day => periods.some(period => period.start <= Date.parse(day) && period.finish >= Date.parse(day) + DAY);
    const trend = Array.from({ length: days }, (_, index) => {
      const day = date(Date.parse(firstDay) + index * DAY);
      const row = daily.find(item => item.date === day);
      return { date: day, users: row?.users ?? (complete(day) ? 0 : null), watchSeconds: row?.watchSeconds ?? (complete(day) ? 0 : null), complete: complete(day), partial: day === today };
    });
    const active = duration => db.prepare(`SELECT COUNT(DISTINCT d.user_id) AS count FROM analytics_daily d ${valid} AND d.date>=?`).get(date(timestamp - (duration - 1) * DAY)).count;
    const learners = db.prepare(`SELECT SUM(d.watch_seconds) AS seconds FROM analytics_daily d ${valid} AND d.date>=? GROUP BY d.user_id`).all(firstDay).map(row => row.seconds).sort((left, right) => left - right);
    const weeklyLearners = db.prepare(`SELECT COUNT(*) AS count FROM (SELECT d.user_id FROM analytics_daily d ${valid} AND d.date>=? GROUP BY d.user_id HAVING SUM(watch_seconds)>=300)`).get(date(timestamp - 6 * DAY)).count;
    const features = FEATURES.map(name => ({ name, users: db.prepare(`SELECT COUNT(DISTINCT d.user_id) AS count FROM analytics_daily d ${valid} AND d.date>=? AND d.${name}=1`).get(firstDay).count }));
    const members = db.prepare(`SELECT m.enrolled_at,m.first_course_at,m.activated_at,m.user_id FROM analytics_members m JOIN analytics_preferences p ON p.user_id=m.user_id JOIN users u ON u.id=m.user_id
      WHERE p.consent=1 AND p.excluded=0 AND p.notice=? AND u.is_admin=0 AND u.is_guest=0 AND u.account_state='active' AND m.enrolled_at>=?`).all(NOTICE, Date.parse(firstDay));
    const cohorts = new Map();
    for (const record of members) {
      const enrolled = new Date(record.enrolled_at);
      const week = date(Date.parse(date(record.enrolled_at)) - ((enrolled.getUTCDay() + 6) % 7) * DAY);
      if (!cohorts.has(week)) cohorts.set(week, { week, enrolled: 0, d7: { eligible: 0, returned: 0, pending: 0, unknown: 0 }, d30: { eligible: 0, returned: 0, pending: 0, unknown: 0 } });
      const cohort = cohorts.get(week);
      cohort.enrolled++;
      for (const offset of [7, 30]) {
        const target = date(Date.parse(date(record.enrolled_at)) + offset * DAY);
        const metric = cohort[`d${offset}`];
        if (target >= today) metric.pending++;
        else if (!complete(target)) metric.unknown++;
        else {
          metric.eligible++;
          if (db.prepare('SELECT 1 FROM analytics_daily WHERE user_id=? AND date=?').get(record.user_id, target)) metric.returned++;
        }
      }
    }
    const mature = members.filter(record => timestamp >= record.enrolled_at + 7 * DAY && periods.some(period => period.start <= record.enrolled_at && period.finish >= record.enrolled_at + 7 * DAY));
    const middle = Math.floor(learners.length / 2);
    return { enabled, droppedSignals, notice: NOTICE, generatedAt: new Date(timestamp).toISOString(), days, timezone: 'UTC',
      collectionStart: db.prepare('SELECT started_at FROM analytics_metadata WHERE id=1').get()?.started_at ?? null,
      eligibleMembers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_guest=0 AND is_admin=0 AND account_state='active'").get().count,
      participants: db.prepare(`SELECT COUNT(*) AS count FROM analytics_preferences p JOIN users u ON u.id=p.user_id WHERE p.consent=1 AND p.excluded=0 AND p.notice=? AND u.is_guest=0 AND u.is_admin=0 AND u.account_state='active'`).get(NOTICE).count,
      dau: active(1), wau: active(7), mau: active(30), weeklyLearners, periodActive: active(days),
      medianWatchMinutes: learners.length ? (learners.length % 2 ? learners[middle] : (learners[middle - 1] + learners[middle]) / 2) / 60 : null,
      trend, features, cohorts: [...cohorts.values()],
      activation: { enrolled: members.length, eligible: mature.length, pendingOrUnobserved: members.length - mature.length,
        courseSaved: mature.filter(record => record.first_course_at !== null && record.first_course_at < record.enrolled_at + 7 * DAY).length,
        activated: mature.filter(record => record.activated_at !== null).length } };
  }
  function capture(operation, ...args) {
    if (!enabled) return;
    try {
      if (operation === 'activity') activity(...args);
      else if (operation === 'coverage') coverage(...args);
      else if (operation === 'stop') db.prepare('UPDATE analytics_members SET sample_at=NULL,watching=0 WHERE user_id=?').run(args[0]);
      else feature(args[0], operation, args[1]);
    } catch { droppedSignals = Math.min(droppedSignals + 1, Number.MAX_SAFE_INTEGER); }
  }
  function configure(value) {
    enabled = value === true;
    db.prepare('UPDATE analytics_members SET sample_at=NULL,watching=0').run();
    cleanup();
    capture('coverage');
  }
  return { preference, setPreference, exclude, activity, feature, coverage, cleanup,
    onboardingConfig: () => ({ available: enabled, notice: NOTICE, audienceNotice: AUDIENCE_NOTICE }), validateOnboarding, saveOnboarding,
    audience, saveAudience, audienceSummary: (...args) => db.transaction(() => audienceSummary(...args)).immediate(),
    summary: (...args) => db.transaction(() => summary(...args)).immediate(), capture, configure };
}

module.exports = { createAnalyticsStore, NOTICE, AUDIENCE_NOTICE };