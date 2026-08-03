'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'ft_session';
const SESSION_MS = 30 * 86400000;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const attempts = new Map();
const actions = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_RATE_KEYS = 5000;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))])
  );
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, passwordHash: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, salt, expectedHex) {
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validCredentials(username, password) {
  if (!USERNAME_RE.test(username || '')) return 'Username must be 3–32 letters, numbers, dots, dashes, or underscores.';
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return 'Password must be 8–128 characters.';
  }
  return null;
}

function sourceAddress(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function prune(map) {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, value] of map) {
    if (value.startedAt < cutoff) map.delete(key);
  }
  while (map.size > MAX_RATE_KEYS) map.delete(map.keys().next().value);
}

function rateKey(req, username) {
  return `${sourceAddress(req)}:${String(username || '').toLowerCase()}`;
}

function rateLimited(req, username) {
  prune(attempts);
  const key = rateKey(req, username);
  const current = attempts.get(key);
  const now = Date.now();
  if (!current || now - current.startedAt > WINDOW_MS) return false;
  return current.count >= 5;
}

function recordFailure(req, username) {
  const key = rateKey(req, username);
  const current = attempts.get(key);
  if (!current || Date.now() - current.startedAt > WINDOW_MS) {
    attempts.set(key, { count: 1, startedAt: Date.now() });
  } else {
    current.count++;
  }
}

function clearFailures(req, username) {
  attempts.delete(rateKey(req, username));
}

function actionLimited(req, action, limit) {
  prune(actions);
  const key = `${sourceAddress(req)}:${action}`;
  const current = actions.get(key);
  if (!current || Date.now() - current.startedAt > WINDOW_MS) {
    actions.set(key, { count: 1, startedAt: Date.now() });
    return false;
  }
  current.count++;
  return current.count > limit;
}

function createAuth(store) {
  function setSessionCookie(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_MS);
    store.createSession(tokenHash(token), userId, expires.toISOString());
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.append(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
        SESSION_MS / 1000
      )}${secure ? '; Secure' : ''}`
    );
  }

  function clearSessionCookie(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) store.deleteSession(tokenHash(token));
    res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function optionalAuth(req, _res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) req.user = store.getSessionUser(tokenHash(token)) || null;
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    store.touchUser(req.user.id);
    next();
  }

  const router = express.Router();

  router.get('/me', optionalAuth, (req, res) => {
    res.json({ user: store.publicUser(req.user) });
  });

  router.post('/register', async (req, res) => {
    try {
      if (actionLimited(req, 'register', 10)) {
        return res.status(429).json({ error: 'Too many accounts created. Try again later.' });
      }
      const username = String(req.body?.username || '').trim();
      const password = req.body?.password;
      const problem = validCredentials(username, password);
      if (problem) return res.status(400).json({ error: problem });
      if (store.getUserByName(username)) return res.status(409).json({ error: 'That username is already taken.' });
      const hashed = await hashPassword(password);
      const user = store.createUser({ username, ...hashed });
      setSessionCookie(req, res, user.id);
      res.status(201).json({ user: store.publicUser(user) });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That username is already taken.' });
      console.error(err);
      res.status(500).json({ error: 'Could not create the account.' });
    }
  });

  router.post('/login', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = req.body?.password;
    if (rateLimited(req, username)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }
    try {
      const user = store.getUserByName(username);
      const ok = user && !user.is_guest && (await verifyPassword(password || '', user.salt, user.password_hash));
      if (!ok) {
        recordFailure(req, username);
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      clearFailures(req, username);
      setSessionCookie(req, res, user.id);
      store.touchUser(user.id);
      res.json({ user: store.publicUser(user) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not sign in.' });
    }
  });

  router.post('/guest', (req, res) => {
    try {
      if (actionLimited(req, 'guest', 20)) {
        return res.status(429).json({ error: 'Too many guest profiles created. Try again later.' });
      }
      const user = store.createUser({ isGuest: true });
      setSessionCookie(req, res, user.id);
      res.status(201).json({ user: store.publicUser(user) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not start a guest session.' });
    }
  });

  router.post('/upgrade', optionalAuth, requireAuth, async (req, res) => {
    if (!req.user.is_guest) return res.status(400).json({ error: 'This profile already has an account.' });
    try {
      const username = String(req.body?.username || '').trim();
      const password = req.body?.password;
      const problem = validCredentials(username, password);
      if (problem) return res.status(400).json({ error: problem });
      if (store.getUserByName(username)) return res.status(409).json({ error: 'That username is already taken.' });
      const hashed = await hashPassword(password);
      const user = store.upgradeGuest(req.user.id, username, hashed.passwordHash, hashed.salt);
      store.revokeUserSessions(req.user.id);
      setSessionCookie(req, res, user.id);
      res.json({ user: store.publicUser(user) });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That username is already taken.' });
      console.error(err);
      res.status(500).json({ error: 'Could not upgrade the profile.' });
    }
  });

  router.post('/logout', optionalAuth, (req, res) => {
    clearSessionCookie(req, res);
    res.status(204).end();
  });

  return { router, optionalAuth, requireAuth };
}

module.exports = { createAuth };