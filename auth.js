'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const express = require('express');
const { createAuthServices } = require('./auth-services');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'ft_session';
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = crypto.scryptSync(crypto.randomBytes(32), DUMMY_SALT, 64).toString('hex');
let activeHashes = 0;

const errors = {
  INVALID_REQUEST: [400, 'Check the submitted account details.'],
  PASSWORD_MISMATCH: [400, 'Passwords do not match.'],
  PASSWORD_UNCHANGED: [400, 'Choose a new password that differs from your current password.'],
  PROFILE_PASSWORD_INVALID: [400, 'The current password is incorrect.'],
  INVALID_USERNAME: [400, 'Choose a username with 3-32 letters, numbers, dots, dashes, or underscores.'],
  USERNAME_TAKEN: [409, 'This username is already taken. Try another.'],
  PROFILE_CHANGED: [409, 'Your account details changed in another session. Reopen settings and try again.'],
  INVALID_VERIFICATION: [400, 'The email code is invalid or expired. Request a new code if needed.'],
  VERIFICATION_COOLDOWN: [429, 'Wait a minute before requesting another email code.'],
  EMAIL_NOT_CONFIGURED: [503, 'Email verification is not configured. Contact the administrator.'],
  EMAIL_DELIVERY_FAILED: [503, 'The verification email could not be sent. Try again later.'],
  CAPTCHA_REQUIRED: [400, 'Complete the security check.'],
  CAPTCHA_FAILED: [400, 'The security check expired or failed. Try it again.'],
  CAPTCHA_UNAVAILABLE: [503, 'The security check is temporarily unavailable. Try again later.'],
  INVALID_INVITATION: [400, 'This invitation is invalid or unavailable.'],
  INVALID_INVITATION_LIMIT: [400, 'Allowed signups must be a whole number between 1 and 1,000.'],
  INVALID_INVITATION_EXPIRY: [400, 'Use a future UTC expiry in YYYY-MM-DDTHH:mm:ss.sssZ format, no more than 365 days from now.'],
  INVITATION_NOT_FOUND: [404, 'This member invitation was not found.'],
  INVITATION_CHANGED: [409, 'This invitation changed. Refresh the list before trying again.'],
  INVITATION_REVOKED: [409, 'This invitation was revoked. Create a new invitation.'],
  INVITATION_EXHAUSTED: [409, 'This invitation has no signups remaining. Create a new invitation.'],
  INVITATION_REACTIVATION_REQUIRED: [409, 'Confirm reactivation before extending an expired invitation.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Send account details as JSON.'],
  INVALID_CREDENTIALS: [401, 'Invalid email or password.'],
  UNAUTHENTICATED: [401, 'Sign in to continue.'],
  FORBIDDEN: [403, 'This action is not allowed.'],
  INVITATION_REQUIRED: [403, 'An invitation is required to create an account.'],
  GUEST_MIGRATION_REQUIRED: [403, 'Export your guest data or join with an invitation.'],
  REGISTRATION_CONFLICT: [409, 'Registration could not be completed with these details.'],
  RATE_LIMITED: [429, 'Too many attempts. Try again later.'],
  AUTH_UNAVAILABLE: [503, 'Account access is temporarily unavailable. Try again shortly.'],
};

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) &&
    Buffer.from(token, 'base64url').length === 32 && Buffer.from(token, 'base64url').toString('base64url') === token;
}

function sessionToken(header = '') {
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  try {
    const token = decodeURIComponent(matches[0].slice(SESSION_COOKIE.length + 1));
    return validToken(token) ? token : null;
  } catch {
    return null;
  }
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (activeHashes >= 4) fail('AUTH_UNAVAILABLE');
  activeHashes++;
  try {
    return { salt, passwordHash: Buffer.from(await scrypt(password, salt, 64)).toString('hex') };
  } finally {
    activeHashes--;
  }
}

async function verifyPassword(password, user) {
  const salt = user?.salt || DUMMY_SALT;
  const expected = Buffer.from(user?.password_hash || DUMMY_HASH, 'hex');
  const actual = Buffer.from((await hashPassword(password, salt)).passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || /[^\x00-\x7f]/.test(value)) fail('INVALID_REQUEST');
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  if (email.length > 254 || parts.length !== 2 || parts[0].length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..') ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(parts[1]) || parts[1].split('.').some(label => label.length > 63)) {
    fail('INVALID_REQUEST');
  }
  return email;
}

function validateBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) fail('INVALID_REQUEST');
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('INVALID_REQUEST');
}

function normalizeUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(username)) fail('INVALID_USERNAME');
  return username;
}

function loadRateSecret(dataDir) {
  const filename = path.join(dataDir, '.auth-rate-key');
  try {
    fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Could not initialize the authentication rate key.');
  }
  const secret = fs.readFileSync(filename);
  if (secret.length !== 32) throw new Error('The authentication rate key must contain exactly 32 bytes.');
  return secret;
}

function respondError(error, req, res, _next) {
  const code = /^SQLITE_(BUSY|LOCKED|IOERR|FULL|READONLY|CANTOPEN|CORRUPT|NOTADB)/.test(error.code || '') ? 'AUTH_UNAVAILABLE' : error.code;
  const [status, message] = errors[code] || [500, 'Could not complete the account request.'];
  const operation = ({ '/login': 'login', '/register': 'register', '/upgrade': 'upgrade', '/logout': 'logout', '/email': 'email', '/profile': 'profile', '/password': 'password', '/verification/request': 'verification', '/': 'invite', '/:id': 'invite' })[req.route?.path];
  req.monitoring?.observe(operation, status === 429 ? 'limited' : status >= 500 ? 'failed' : 'rejected');
  if (/^SQLITE_/.test(error.code || '')) req.monitoring?.reportError(error);
  if (status === 503) res.set('Retry-After', '5');
  if (code === 'VERIFICATION_COOLDOWN') res.set('Retry-After', '60');
  res.status(status).json({ error: message, code: errors[code] ? code : 'INTERNAL_ERROR' });
}

function createAuth(store, options = {}) {
  const rateSecret = options.rateSecret || loadRateSecret(store.dataDir);
  const observe = options.observe || (() => {});
  const services = options.services || createAuthServices(process.env, { observe });
  const sessionDays = Number(process.env.AUTH_SESSION_DAYS || 30);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error('AUTH_SESSION_DAYS must be between 1 and 365.');
  const sessionMs = sessionDays * 86400000;
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const budgetKey = (...parts) => crypto.createHmac('sha256', rateSecret).update(JSON.stringify(parts)).digest('hex');

  function verificationContext(req, email, inviteHash = null) {
    return { email, inviteHash, userId: req.user?.id || null, currentSessionHash: req.user ? req.sessionHash : null,
      purpose: req.user ? req.user.is_guest ? 'upgrade' : 'email' : 'registration' };
  }

  function verificationInput(req, context) {
    if (!validToken(req.body.verificationToken) || typeof req.body.verificationCode !== 'string' || !/^\d{6}$/.test(req.body.verificationCode)) fail('INVALID_VERIFICATION');
    const verificationHash = tokenHash(req.body.verificationToken);
    const verificationCodeHash = budgetKey('email-code', verificationHash, req.body.verificationCode);
    const values = { ...context, verificationHash, verificationCodeHash };
    if (!store.checkEmailVerification(values)) fail('INVALID_VERIFICATION');
    return { verificationHash, verificationCodeHash };
  }

  function verifyCaptcha(req, action) {
    return services.verifyCaptcha(req.body.captchaToken, { origin: req.authOrigin, action, remoteAddress: req.ip });
  }

  function reserve(req, budgets) {
    const retryAfter = store.reserveBudgets(budgets);
    if (retryAfter) {
      req.res.set('Retry-After', String(retryAfter));
      fail('RATE_LIMITED');
    }
  }

  function actionBudget(req, _res, next) {
    try {
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !(req.method === 'POST' && req.path === '/username/check')) {
        reserve(req, [{ key: budgetKey('auth-source', req.ip), limit: 100 }]);
      }
      next();
    } catch (error) { next(error); }
  }

  function setSessionCookie(req, res, token, expiresAt) {
    const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
  }

  function optionalAuth(req, _res, next) {
    try {
      const token = sessionToken(req.headers.cookie);
      req.sessionHash = token ? tokenHash(token) : null;
      req.user = req.sessionHash ? store.getSessionUser(req.sessionHash) || null : null;
      next();
    } catch (error) { next(error); }
  }

  function requireSession(req, res, next) {
    if (!req.user) return res.status(401).json({ error: errors.UNAUTHENTICATED[1], code: 'UNAUTHENTICATED' });
    next();
  }

  function requireAuth(req, res, next) {
    requireSession(req, res, () => {
      if (req.user.is_guest) return res.status(403).json({ error: errors.GUEST_MIGRATION_REQUIRED[1], code: 'GUEST_MIGRATION_REQUIRED' });
      store.touchUser(req.user.id);
      next();
    });
  }

  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (!req.user.is_admin) return res.status(403).json({ error: 'Administrator access is required.' });
      next();
    });
  }

  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(optionalAuth, actionBudget);
  router.get('/status', (req, res) => res.json({ registration: 'invite-only', authenticated: !!req.user,
    emailVerification: { required: true, configured: services.emailConfigured }, captcha: { siteKey: services.captchaSiteKey } }));
  router.get('/me', requireSession, (req, res) => res.json({ user: store.publicUser(req.user) }));

  router.post('/username/check', route((req, res) => {
    reserve(req, [{ key: budgetKey('username-source', req.ip), limit: 180 }]);
    validateBody(req.body, ['username', 'inviteToken']);
    const member = req.user && !req.user.is_guest;
    if (member ? Object.hasOwn(req.body, 'inviteToken') : !validToken(req.body.inviteToken)) fail('INVALID_INVITATION');
    if (!member && !store.invitationAvailable(tokenHash(req.body.inviteToken))) fail('INVALID_INVITATION');
    const username = normalizeUsername(req.body.username);
    const owner = store.getUserByName(username);
    res.json({ username, available: !owner || !!(member && owner.id === req.user.id) });
  }));

  router.post('/verification/request', route(async (req, res) => {
    reserve(req, [{ key: budgetKey('verification-source', req.ip), limit: 5 }]);
    validateBody(req.body, ['email', 'inviteToken', 'captchaToken']);
    const email = normalizeEmail(req.body.email);
    const member = req.user && !req.user.is_guest;
    if (member ? Object.hasOwn(req.body, 'inviteToken') : !validToken(req.body.inviteToken)) fail('INVALID_INVITATION');
    if (member && (req.user.email_verified_at || (req.user.email_normalized && req.user.email_normalized !== email))) fail('REGISTRATION_CONFLICT');
    const inviteHash = member ? null : tokenHash(req.body.inviteToken);
    if (inviteHash && !store.invitationAvailable(inviteHash)) fail('INVALID_INVITATION');
    if (!services.emailConfigured) fail('EMAIL_NOT_CONFIGURED');
    reserve(req, [{ key: budgetKey('verification-recipient', email), limit: 3 }]);
    await verifyCaptcha(req, member ? 'email' : 'registration');
    const verificationToken = crypto.randomBytes(32).toString('base64url');
    const code = String(crypto.randomInt(1000000)).padStart(6, '0');
    const verificationHash = tokenHash(verificationToken);
    const verification = store.issueEmailVerification({ ...verificationContext(req, email, inviteHash), verificationHash,
      verificationCodeHash: budgetKey('email-code', verificationHash, code) });
    try {
      await services.sendVerification({ email, code, origin: req.authOrigin });
      store.markEmailVerificationSent(verificationHash);
    } catch (error) {
      store.deleteEmailVerification(verificationHash);
      throw error;
    }
    res.status(202).json({ verificationToken, ...verification, resendAfter: 60 });
  }));

  async function register(req, res, upgrade) {
    reserve(req, [{ key: budgetKey('registration-source', req.ip), limit: 10 }]);
    validateBody(req.body, ['inviteToken', 'email', 'username', 'displayName', 'password', 'passwordConfirmation', 'verificationToken', 'verificationCode', 'captchaToken']);
    if (!validToken(req.body.inviteToken)) fail('INVALID_INVITATION');
    const email = normalizeEmail(req.body.email);
    const username = normalizeUsername(req.body.username);
    const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
    if (!displayName || displayName.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(displayName)) fail('INVALID_REQUEST');
    validatePassword(req.body.password);
    if (req.body.password !== req.body.passwordConfirmation) fail('PASSWORD_MISMATCH');
    if (upgrade ? !req.user?.is_guest : !!req.user) fail('REGISTRATION_CONFLICT');
    const inviteHash = tokenHash(req.body.inviteToken);
    if (!store.invitationAvailable(inviteHash)) fail('INVALID_INVITATION');
    const verification = verificationInput(req, verificationContext(req, email, inviteHash));
    await verifyCaptcha(req, 'registration');
    const hashed = await hashPassword(req.body.password);
    const token = crypto.randomBytes(32).toString('base64url');
    const result = store.redeemInvitation({ inviteHash, email, username, displayName, ...hashed, ...verification,
      sessionHash: tokenHash(token), sessionMs, guestSessionHash: upgrade ? req.sessionHash : null });
    setSessionCookie(req, res, token, result.expiresAt);
    observe(upgrade ? 'upgrade' : 'register', 'success');
    res.status(upgrade ? 200 : 201).json({ user: store.publicUser(result.user) });
  }

  router.post('/register', route((req, res) => register(req, res, false)));
  router.post('/upgrade', requireSession, route((req, res) => register(req, res, true)));
  router.post('/guest', (_req, _res, next) => { try { fail('INVITATION_REQUIRED'); } catch (error) { next(error); } });

  router.post('/login', route(async (req, res) => {
    validateBody(req.body, ['email', 'username', 'identifier', 'password', 'captchaToken']);
    validatePassword(req.body.password);
    const fields = ['email', 'username', 'identifier'].filter(field => Object.hasOwn(req.body, field));
    if (fields.length !== 1 || typeof req.body[fields[0]] !== 'string') fail('INVALID_REQUEST');
    const supplied = req.body[fields[0]].trim();
    const legacy = fields[0] === 'username' || (fields[0] === 'identifier' && !supplied.includes('@'));
    const identity = legacy ? supplied.toLowerCase() : normalizeEmail(supplied);
    if (legacy && !USERNAME_RE.test(identity)) fail('INVALID_REQUEST');
    const user = legacy ? store.getUserByName(identity) : store.getUserByEmail(identity);
    reserve(req, [{ key: budgetKey('login', req.ip, user ? `user:${user.id}` : `${legacy ? 'username' : 'email'}:${identity}`), limit: 5 }]);
    await verifyCaptcha(req, 'login');
    const eligible = user && !user.is_guest && user.account_state === 'active';
    const valid = await verifyPassword(req.body.password, eligible ? user : null);
    if (!eligible || !valid) fail('INVALID_CREDENTIALS');
    const token = crypto.randomBytes(32).toString('base64url');
    const result = store.passwordSession({ user, sessionHash: tokenHash(token), sessionMs,
      onSessionReplaced: req.sessionHash && options.onSessionReplaced ? () => options.onSessionReplaced(req.sessionHash) : undefined });
    observe('login', 'success');
    setSessionCookie(req, res, token, result.expiresAt);
    res.json({ user: store.publicUser(result.user) });
  }));

  router.post('/email', requireAuth, route(async (req, res) => {
    reserve(req, [{ key: budgetKey('email-enrollment', req.user.id), limit: 5 }]);
    validateBody(req.body, ['email', 'password', 'verificationToken', 'verificationCode', 'captchaToken']);
    const email = normalizeEmail(req.body.email);
    validatePassword(req.body.password);
    const verification = verificationInput(req, verificationContext(req, email));
    await verifyCaptcha(req, 'email');
    if (!await verifyPassword(req.body.password, req.user)) fail('INVALID_CREDENTIALS');
    const token = crypto.randomBytes(32).toString('base64url');
    const result = store.passwordSession({ user: req.user, currentSessionHash: req.sessionHash, email, ...verification, sessionHash: tokenHash(token), sessionMs });
    observe('email', 'success');
    setSessionCookie(req, res, token, result.expiresAt);
    res.json({ user: store.publicUser(result.user) });
  }));

  router.post('/profile', requireAuth, route(async (req, res) => {
    reserve(req, [{ key: budgetKey('profile-update', req.user.id), limit: 10 }]);
    validateBody(req.body, ['displayName', 'username', 'password']);
    const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
    const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : null;
    if (!displayName || displayName.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(displayName) || username === null ||
      (username ? !USERNAME_RE.test(username) : !!req.user.username)) fail('INVALID_REQUEST');
    if ((username || null) !== (req.user.username?.toLowerCase() || null)) {
      validatePassword(req.body.password);
      if (!await verifyPassword(req.body.password, req.user)) fail('PROFILE_PASSWORD_INVALID');
    }
    const user = store.updateAccountProfile({ user: req.user, currentSessionHash: req.sessionHash, displayName, username: username || null });
    observe('profile', 'success');
    res.json({ user: store.publicUser(user) });
  }));

  router.post('/password', requireAuth, route(async (req, res) => {
    reserve(req, [{ key: budgetKey('password-change', req.user.id), limit: 5 }]);
    validateBody(req.body, ['currentPassword', 'newPassword', 'passwordConfirmation']);
    validatePassword(req.body.currentPassword);
    validatePassword(req.body.newPassword);
    if (req.body.newPassword !== req.body.passwordConfirmation) fail('PASSWORD_MISMATCH');
    if (req.body.newPassword === req.body.currentPassword) fail('PASSWORD_UNCHANGED');
    if (!await verifyPassword(req.body.currentPassword, req.user)) fail('PROFILE_PASSWORD_INVALID');
    const hashed = await hashPassword(req.body.newPassword);
    const token = crypto.randomBytes(32).toString('base64url');
    const result = store.passwordSession({ user: req.user, currentSessionHash: req.sessionHash, ...hashed,
      sessionHash: tokenHash(token), sessionMs });
    setSessionCookie(req, res, token, result.expiresAt);
    observe('password', 'success');
    res.json({ user: store.publicUser(result.user) });
  }));

  router.post('/logout', route((req, res) => {
    if (req.sessionHash) {
      try { store.deleteSession(req.sessionHash); } catch { fail('AUTH_UNAVAILABLE'); }
    }
    setSessionCookie(req, res, '', new Date(0).toISOString());
    observe('logout', 'success');
    res.status(204).end();
  }));
  router.use(respondError);

  function invitationInteger(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_REQUEST');
    return Number(value);
  }

  const invitesRouter = express.Router();
  invitesRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  invitesRouter.use(optionalAuth, actionBudget, requireAuth);
  invitesRouter.use((req, res, next) => {
    try {
      if (!req.user.is_admin) fail('FORBIDDEN');
      const expectedAccount = req.get('X-Invite-Account');
      if (expectedAccount !== undefined && expectedAccount !== String(req.user.id)) {
        return res.status(409).json({ code: 'INVITATION_ACCOUNT_CHANGED', error: 'Your account changed. Reopen Administration before continuing.' });
      }
      res.set('X-Invite-Account', String(req.user.id));
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        reserve(req, [{ key: budgetKey('invite-issuer', req.user.id), limit: 20 }]);
        if (!req.is('application/json')) fail('UNSUPPORTED_MEDIA_TYPE');
      }
      next();
    } catch (error) { next(error); }
  });
  invitesRouter.get('/', route((req, res) => {
    validateBody(req.query, ['before', 'limit']);
    res.json(store.listInvitations({ actorSessionHash: req.sessionHash,
      beforeId: req.query.before === undefined ? null : invitationInteger(req.query.before),
      limit: req.query.limit === undefined ? 50 : invitationInteger(req.query.limit) }));
  }));
  invitesRouter.post('/', route((req, res) => {
    validateBody(req.body, ['maxUses', 'expiresAt']);
    const maxUses = req.body.maxUses === undefined ? 1 : req.body.maxUses;
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) fail('INVALID_INVITATION_LIMIT');
    const token = crypto.randomBytes(32).toString('base64url');
    const result = store.issueInvitation({ tokenHash: tokenHash(token), actorSessionHash: req.sessionHash, maxUses, expiresAt: req.body.expiresAt });
    observe('invite', 'success');
    res.status(201).json({ ...result, inviteUrl: `${req.authOrigin}/#join=${token}` });
  }));
  invitesRouter.patch('/:id', route((req, res) => {
    validateBody(req.body, ['expiresAt', 'revision', 'reactivate']);
    const result = store.updateInvitation({ actorSessionHash: req.sessionHash, id: invitationInteger(req.params.id),
      expiresAt: req.body.expiresAt, revision: req.body.revision, reactivate: req.body.reactivate });
    observe('invite', 'success');
    res.json(result);
  }));
  invitesRouter.delete('/:id', route((req, res) => {
    validateBody(req.body, ['revision']);
    const result = store.revokeInvitation({ actorSessionHash: req.sessionHash, id: invitationInteger(req.params.id), revision: req.body.revision });
    observe('invite', 'success');
    res.json(result);
  }));
  invitesRouter.use(respondError);

  function reserveFeedbackBudget(req, action) {
    const limit = { report: 5, reply: 30, moderate: 60, screenshot: 30 }[action];
    if (!limit || !req.user || req.user.is_guest) fail('FORBIDDEN');
    reserve(req, [{ key: budgetKey('feedback', action, req.user.id), limit }]);
  }

  return { router, invitesRouter, optionalAuth, requireAuth, requireAdmin, requireSession, reserveFeedbackBudget, captchaSiteKey: services.captchaSiteKey };
}

module.exports = { createAuth, hashPassword, verifyPassword, tokenHash, validToken, normalizeEmail };