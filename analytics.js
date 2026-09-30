'use strict';

const express = require('express');
const crypto = require('node:crypto');

function createAnalytics(store, auth, environment = process.env) {
  store.analytics.configure(environment.PRODUCT_ANALYTICS_ENABLED === '1');
  const router = express.Router();
  const adminRouter = express.Router();
  const bound = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.get('X-Analytics-Account') !== String(req.user.id)) return res.status(409).json({ error: 'Your account changed. Reopen Settings.', code: 'SESSION_CHANGED' });
    res.set('X-Analytics-Account', String(req.user.id));
    const key = crypto.createHash('sha256').update(`analytics:${req.user.id}`).digest('hex');
    const retry = store.reserveBudgets([{ key, limit: 120 }]);
    if (retry) return res.status(429).set('Retry-After', String(retry)).json({ error: 'Too many analytics requests. Try again later.' });
    next();
  };
  const handle = action => (req, res, next) => { try { action(req, res); } catch (error) { next(error); } };
  const body = (req, keys) => {
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => !keys.includes(key))) throw Object.assign(new Error('Invalid analytics request.'), { status: 400 });
  };
  router.use(auth.requireAuth, bound);
  router.get('/preferences', handle((req, res) => res.json(store.analytics.preference(req.user.id))));
  router.put('/preferences', handle((req, res) => {
    body(req, ['consent', 'notice']);
    res.json(store.analytics.setPreference(req.user.id, req.body.consent, req.body.notice));
  }));
  router.get('/audience', handle((req, res) => res.json(store.analytics.audience(req.user.id))));
  router.put('/audience', handle((req, res) => {
    body(req, ['action', 'revision', 'notice', 'answers']);
    res.json(store.analytics.saveAudience(req.user.id, req.body));
  }));
  router.get('/export', handle((req, res) => {
    store.analytics.cleanup();
    res.json({ preference: store.analytics.preference(req.user.id), audience: store.analytics.audience(req.user.id),
      enrollment: store.db.prepare('SELECT enrolled_at,first_course_at,activated_at FROM analytics_members WHERE user_id=?').get(req.user.id) || null,
      daily: store.db.prepare('SELECT date,watch_seconds,course,notes,chat,extension FROM analytics_daily WHERE user_id=? ORDER BY date').all(req.user.id) });
  }));
  adminRouter.use(auth.requireAdmin, bound);
  adminRouter.get('/audience', handle((req, res) => {
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'Audience reports use the fixed previous 30 UTC days.' });
    res.json(store.analytics.audienceSummary());
  }));
  adminRouter.get('/', handle((req, res) => {
    if (Object.keys(req.query).some(key => key !== 'days') || req.query.days !== undefined && !['7', '30', '90'].includes(req.query.days)) {
      return res.status(400).json({ error: 'Choose 7, 30, or 90 days.' });
    }
    res.json(store.analytics.summary(Number(req.query.days || 30)));
  }));
  adminRouter.put('/exclusions/:id', handle((req, res) => {
    body(req, ['excluded']);
    const id = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id) || !store.getUserById(id)) return res.status(404).json({ error: 'Member not found.' });
    const result = store.analytics.exclude(id, req.body.excluded);
    res.json({ userId: id, excluded: result.excluded });
  }));
  for (const target of [router, adminRouter]) target.use((error, req, res, _next) => {
    if (error.code === 'AUDIENCE_CHANGED') return res.status(409).json({ code: error.code, error: error.message });
    if (error.status !== 400) req.monitoring?.reportError(error);
    res.status(error.status === 400 ? 400 : 503).json({ error: error.status === 400 ? error.message : 'Analytics is temporarily unavailable.' });
  });
  return { router, adminRouter };
}

module.exports = { createAnalytics };