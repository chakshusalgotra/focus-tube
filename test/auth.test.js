'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const authModule = require('../auth');
const { createAuthServices } = require('../auth-services');

const root = path.join(__dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function memoryStore(context, filename = ':memory:') {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'db.js'), 'utf8'), {
    module, Buffer, __dirname: root,
    require(name) {
      if (name === 'better-sqlite3') return class extends Database { constructor() { super(filename); } };
      if (name === 'fs') return filename === ':memory:' ? { mkdirSync() {} } : fs;
      return require(name);
    },
  }, { filename: 'db.js' });
  context.after(() => module.exports.db.close());
  return module.exports;
}

function invitation(store, name = 'invite', actorSessionHash) {
  return store.issueInvitation({ tokenHash: digest(name), bootstrap: !actorSessionHash, actorSessionHash });
}

function registration(store, invite = 'invite', email = 'member@example.com', extra = {}) {
  const values = { inviteHash: digest(invite), email, displayName: 'Member', passwordHash: 'test-password-hash', salt: 'test-salt',
    sessionHash: digest(`session:${email}`), sessionMs: 30 * 86400000, ...extra,
    verificationHash: digest(`verification:${invite}:${email}`), verificationCodeHash: digest('12345678') };
  if (store.invitationAvailable(values.inviteHash) && !store.db.prepare('SELECT 1 FROM email_verifications WHERE token_hash = ?').get(values.verificationHash)) {
    store.issueEmailVerification({ ...values, purpose: extra.guestSessionHash ? 'upgrade' : 'registration',
      userId: extra.guestSessionHash ? store.getSessionUser(extra.guestSessionHash).id : null, currentSessionHash: extra.guestSessionHash || null });
    store.markEmailVerificationSent(values.verificationHash);
  }
  return values;
}

test('invite redemption atomically creates a member, profile, session, and one-time consumption', context => {
  const store = memoryStore(context);
  invitation(store);
  const values = registration(store);
  const result = store.redeemInvitation(values);
  assert.equal(result.user.email_normalized, values.email);
  assert.equal(result.user.is_admin, 1);
  assert.equal(store.getSessionUser(values.sessionHash).id, result.user.id);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM user_data').get().count, 1);
  assert.equal(store.invitationAvailable(values.inviteHash), false);
  assert.throws(() => store.redeemInvitation(registration(store, 'invite', 'other@example.com')), { code: 'INVALID_INVITATION' });
  assert.throws(() => invitation(store, 'next-bootstrap'), { code: 'ADMIN_EXISTS' });
});

test('session insert failure rolls back every registration write', context => {
  const store = memoryStore(context);
  invitation(store);
  store.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.redeemInvitation(registration(store)), /injected/);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM user_data').get().count, 0);
  assert.equal(store.db.prepare('SELECT consumed_at FROM invitations').get().consumed_at, null);
});

test('bootstrap rechecks active administrators and member invitations never inherit administrator status', context => {
  const store = memoryStore(context);
  invitation(store, 'first');
  invitation(store, 'second');
  const adminValues = registration(store, 'first', 'admin@example.com');
  store.redeemInvitation(adminValues);
  assert.throws(() => store.redeemInvitation(registration(store, 'second')), { code: 'REGISTRATION_CONFLICT' });
  invitation(store, 'member', adminValues.sessionHash);
  const member = store.redeemInvitation(registration(store, 'member')).user;
  assert.equal(member.is_admin, 0);
  assert.throws(() => invitation(store, 'forbidden', registration(store, 'member').sessionHash), { code: 'FORBIDDEN' });
});

test('durable budgets reserve atomically and disabled sessions stop authenticating', context => {
  const store = memoryStore(context);
  const budgets = [{ key: digest('login'), limit: 2 }];
  const timestamp = Date.now();
  assert.equal(store.reserveBudgets(budgets, timestamp), 0);
  assert.equal(store.reserveBudgets(budgets, timestamp), 0);
  assert.equal(store.reserveBudgets(budgets, timestamp), 900);
  assert.equal(store.reserveBudgets(budgets, timestamp + 900000), 0);
  invitation(store);
  const values = registration(store);
  const { user } = store.redeemInvitation(values);
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(user.id);
  assert.equal(store.getSessionUser(values.sessionHash), undefined);
});

function downloadFixture() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'downloads.js'), 'utf8'), {
    module, console, Buffer, setInterval: () => ({ unref() {} }), setImmediate() {},
    require(name) {
      if (name === 'fs') return { ...fs, readdirSync: () => [], mkdtempSync: () => '/disposable-download-not-created' };
      if (name === 'child_process') return { spawnSync: () => ({ status: 0 }), spawn() { throw new Error('Downloads must not run in auth tests.'); } };
      return require(name);
    },
  });
  return module.exports;
}

async function httpFixture(context, environment = {}, suppliedServices) {
  const store = memoryStore(context);
  const emails = [];
  const services = suppliedServices || { emailConfigured: true, captchaSiteKey: null,
    async sendVerification(message) { emails.push(message); }, async verifyCaptcha() {} };
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('const cleanupTimer =')[0];
  vm.runInNewContext(source + '\nmodule.exports = app;', {
    module, console, URL, Buffer, __dirname: root, process: { env: { PORT: String(server.address().port), LOG_LEVEL: 'silent', APP_ENV: 'test', ...environment,
      ...(environment.TRUST_PROXY ? { AUTH_PUBLIC_ORIGINS: origin.replace('http:', 'https:') } : {}) } },
    require(name) {
      if (name === './db') return store;
      if (name === './auth') return { createAuth: (target, options) => authModule.createAuth(target, { ...options, rateSecret: Buffer.alloc(32, 1), services }) };
      if (name === './downloads') return downloadFixture();
      return name.startsWith('.') ? require(path.join(root, name)) : require(name);
    },
  });
  server.on('request', module.exports);
  const request = (endpoint, { body, headers = {}, ...options } = {}) => fetch(origin + endpoint, {
    ...options, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const verify = async (body, headers = {}) => {
    const response = await request('/api/auth/verification/request', { method: 'POST', headers,
      body: { email: body.email, ...(body.inviteToken ? { inviteToken: body.inviteToken } : {}) } });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    return { ...body, verificationToken: (await response.json()).verificationToken, verificationCode: emails.at(-1).code };
  };
  return { store, request, origin, verify, emails };
}

function bootstrapToken(store) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.issueInvitation({ tokenHash: digest(token), bootstrap: true });
  return token;
}

const joinBody = token => ({ inviteToken: token, email: 'Admin@Example.com', displayName: 'Administrator', password: 'test-password-123', passwordConfirmation: 'test-password-123' });
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];

test('terms and privacy are publicly readable without signing in or issuing a session', async context => {
  const { request } = await httpFixture(context);
  const response = await request('/policies.html');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /id="terms"/);
  assert.match(html, /id="privacy"/);
  assert.match(html, /Terms and conditions/);
  assert.match(html, /Privacy policy/);
});

test('real HTTP auth requires invitations, creates only member invites, and logs in without an invitation', async context => {
  const { store, request, verify } = await httpFixture(context);
  assert.equal((await request('/api/auth/me')).status, 401);
  assert.equal((await request('/api/auth/guest', { method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: joinBody('invalid') })).status, 400);
  const response = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/);
  const user = (await response.json()).user;
  assert.equal(user.email, 'admin@example.com');
  assert.equal(user.isAdmin, true);
  assert.equal(user.password_hash, undefined);
  const cookie = cookieOf(response);
  const created = await request('/api/invites', { method: 'POST', headers: { Cookie: cookie }, body: {} });
  assert.equal(created.status, 201);
  const memberInvite = (await created.json()).inviteUrl.split('#join=')[1];
  const member = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(memberInvite), email: 'member@example.com' }) });
  assert.equal(member.status, 201);
  assert.equal((await member.json()).user.isAdmin, false);
  assert.equal((await request('/api/invites', { method: 'POST', headers: { Cookie: cookieOf(member) }, body: {} })).status, 403);
  assert.equal((await request('/api/invites', { method: 'POST', headers: { Cookie: cookie }, body: { isAdmin: true } })).status, 400);
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 204);
  assert.equal((await request('/api/data', { headers: { Cookie: cookie } })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password: 'test-password-123' } });
  assert.equal(login.status, 200);
  assert.notEqual(cookieOf(login), cookie);
});

test('password confirmation is required on the backend before an invitation can be consumed', async context => {
  const { store, request } = await httpFixture(context);
  const token = bootstrapToken(store);
  for (const passwordConfirmation of [undefined, '', 'different-password']) {
    const response = await request('/api/auth/register', { method: 'POST', body: { ...joinBody(token), passwordConfirmation } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'PASSWORD_MISMATCH');
  }
  assert.equal(store.invitationAvailable(digest(token)), true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
});

test('optional usernames are unique case-insensitively and support email or username login', async context => {
  const { store, request, verify } = await httpFixture(context);
  const response = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(bootstrapToken(store)), username: ' New.Member ' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).user.username, 'new.member');
  for (const identifier of ['NEW.MEMBER', 'admin@example.com']) {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier, password: 'test-password-123' } })).status, 200);
  }
  const admin = store.db.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash;
  invitation(store, 'username-conflict', admin);
  assert.throws(() => store.redeemInvitation({ ...registration(store, 'username-conflict', 'another@example.com'), username: 'NEW.MEMBER' }), { code: 'REGISTRATION_CONFLICT' });
  assert.equal(store.invitationAvailable(digest('username-conflict')), true);
});

test('email challenges bind context, expire, limit code guesses and do not mark users verified', context => {
  const store = memoryStore(context);
  invitation(store);
  const values = { verificationHash: digest('verification'), verificationCodeHash: digest('12345678'), email: 'member@example.com',
    inviteHash: digest('invite'), userId: null, currentSessionHash: null, purpose: 'registration' };
  store.issueEmailVerification(values);
  assert.equal(store.checkEmailVerification(values), false);
  store.markEmailVerificationSent(values.verificationHash);
  assert.equal(store.checkEmailVerification({ ...values, email: 'other@example.com' }), false);
  assert.equal(store.checkEmailVerification(values), true);
  assert.throws(() => store.issueEmailVerification({ ...values, verificationHash: digest('new') }), { code: 'VERIFICATION_COOLDOWN' });
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(store.checkEmailVerification({ ...values, verificationCodeHash: digest('wrong') }), false);
  assert.equal(store.checkEmailVerification(values), false);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  store.db.prepare('UPDATE email_verifications SET attempts = 0, created_at = ?, expires_at = ?')
    .run(new Date(Date.now() - 60000).toISOString(), new Date(Date.now() - 1000).toISOString());
  assert.equal(store.checkEmailVerification(values), false);
});

test('exact-origin mutations, bounded JSON, and malformed cookies fail safely', async context => {
  const { request, origin } = await httpFixture(context);
  for (const value of ['null', 'http://other.test', origin.replace('http:', 'https:'), `${origin}/`, `${origin}/bad`, '']) {
    const response = await request('/api/auth/login', { method: 'POST', body: {}, headers: { Origin: value } });
    assert.equal(response.status, 403, value);
  }
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: {} })).status, 415);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'x'.repeat(9000) } })).status, 413);
  for (const cookie of ['ft_session=%zz', 'ft_session=short', `ft_session=${'a'.repeat(43)}; ft_session=${'b'.repeat(43)}`]) {
    assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  }
  const response = await request('/api/auth/login', { method: 'POST', body: { email: 'unknown@example.com', password: 'wrong-password' }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_CREDENTIALS');
});

test('invalid, expired, duplicate, and capacity conflicts do not consume invitations', context => {
  const store = memoryStore(context);
  invitation(store);
  const first = registration(store);
  store.redeemInvitation(first);
  invitation(store, 'unused', first.sessionHash);
  assert.throws(() => store.redeemInvitation(registration(store, 'unused')), { code: 'REGISTRATION_CONFLICT' });
  assert.equal(store.invitationAvailable(digest('unused')), true);
  store.setMemberLimit(1);
  assert.throws(() => store.redeemInvitation(registration(store, 'unused', 'new@example.com')), { code: 'REGISTRATION_CONFLICT' });
  store.db.exec("UPDATE users SET account_state = 'disabled'");
  assert.throws(() => store.redeemInvitation(registration(store, 'unused', 'new@example.com')), { code: 'REGISTRATION_CONFLICT' });
  store.setMemberLimit(10);
  store.db.prepare('UPDATE invitations SET created_at = ?, expires_at = ? WHERE token_hash = ?').run('2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', digest('unused'));
  assert.throws(() => store.redeemInvitation(registration(store, 'unused', 'new@example.com')), { code: 'INVALID_INVITATION' });
  assert.throws(() => store.redeemInvitation(registration(store, 'not-found')), { code: 'INVALID_INVITATION' });
  store.db.exec('DELETE FROM auth_workspace');
  assert.throws(() => invitation(store, 'missing-policy'), { code: 'AUTH_UNAVAILABLE' });
});

test('each admission write and deferred commit failure roll back the account and invite', context => {
  for (const table of ['users', 'user_data', 'invitations', 'sessions', 'commit']) {
    const store = memoryStore(context);
    invitation(store);
    if (table === 'commit') {
      store.db.exec(`CREATE TABLE commit_guard (user_id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER fail_commit AFTER INSERT ON sessions BEGIN INSERT INTO commit_guard VALUES (-999); END;`);
    } else {
      store.db.exec(`CREATE TRIGGER fail_write AFTER ${table === 'invitations' ? 'UPDATE' : 'INSERT'} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    }
    assert.throws(() => store.redeemInvitation(registration(store)));
    for (const name of ['users', 'user_data', 'sessions']) assert.equal(store.db.prepare(`SELECT count(*) AS count FROM ${name}`).get().count, 0, `${table}: ${name}`);
    assert.equal(store.db.prepare('SELECT consumed_at FROM invitations').get().consumed_at, null, table);
    assert.equal(store.db.inTransaction, false);
  }
});

test('guest conversion preserves identity/data and rolls back revocation on failure', context => {
  const store = memoryStore(context);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  invitation(store, 'guest-invite', admin.sessionHash);
  const guest = store.createUser({ isGuest: true });
  const oldSession = digest('guest-session');
  store.createSession(oldSession, guest.id, new Date(Date.now() + 86400000).toISOString());
  store.saveUserData(guest.id, { courses: { saved: { title: 'Private course', videos: [] } }, stats: {}, settings: {}, workspace: {} }, 0);
  const values = registration(store, 'guest-invite', 'guest@example.com', { guestSessionHash: oldSession });
  store.db.exec("CREATE TRIGGER fail_guest_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.redeemInvitation(values));
  assert.equal(store.getUserById(guest.id).is_guest, 1);
  assert.equal(store.getSessionUser(oldSession).id, guest.id);
  assert.equal(store.invitationAvailable(values.inviteHash), true);
  store.db.exec('DROP TRIGGER fail_guest_session');
  assert.equal(store.redeemInvitation(values).user.id, guest.id);
  assert.equal(store.getSessionUser(oldSession), undefined);
  assert.equal(store.getUserData(guest.id).courses.saved.title, 'Private course');
});

test('email enrollment preserves legacy accounts, revokes sessions, and rejects stale credentials', async context => {
  const { store, request, verify } = await httpFixture(context);
  const hashed = await authModule.hashPassword('legacy-password');
  const user = store.createUser({ username: 'legacy.user', ...hashed });
  const login = await request('/api/auth/login', { method: 'POST', body: { username: 'LEGACY.USER', password: 'legacy-password' } });
  assert.equal(login.status, 200);
  const oldCookie = cookieOf(login);
  const enrolled = await request('/api/auth/email', { method: 'POST', headers: { Cookie: oldCookie }, body: await verify({ email: 'Legacy@Example.com', password: 'legacy-password' }, { Cookie: oldCookie }) });
  assert.equal(enrolled.status, 200);
  assert.equal((await enrolled.json()).user.id, user.id);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'legacy.user', password: 'legacy-password' } })).status, 200);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'legacy@example.com', password: 'legacy-password' } })).status, 200);
  const captured = store.getUserById(user.id);
  store.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('changed', user.id);
  assert.throws(() => store.passwordSession({ user: captured, sessionHash: digest('stale'), sessionMs: 10000 }), { code: 'INVALID_CREDENTIALS' });
});

test('account profile edits protect username changes and preserve identity, data, and verification', async context => {
  const { store, request } = await httpFixture(context);
  const hashed = await authModule.hashPassword('profile-password');
  const user = store.createUser({ username: 'original.name', ...hashed });
  store.db.prepare('UPDATE users SET email_normalized = ?, email_verified_at = ? WHERE id = ?').run('profile@example.com', '2026-09-01', user.id);
  store.saveUserData(user.id, { courses: { private: { title: 'Private course', videos: [] } }, stats: {}, settings: {}, workspace: {} }, 0);
  const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'original.name', password: 'profile-password' } });
  const headers = { Cookie: cookieOf(login) };
  const body = { displayName: 'New display name', username: 'NEW.NAME' };
  assert.equal((await request('/api/auth/profile', { method: 'POST', body })).status, 401);
  assert.equal((await request('/api/auth/profile', { method: 'POST', headers, body })).status, 400);
  assert.equal((await request('/api/auth/profile', { method: 'POST', headers, body: { ...body, password: 'wrong-password' } })).status, 400);
  assert.equal(store.getUserById(user.id).username, 'original.name');
  const saved = await request('/api/auth/profile', { method: 'POST', headers, body: { ...body, password: 'profile-password' } });
  assert.equal(saved.status, 200);
  const changed = (await saved.json()).user;
  assert.equal(changed.id, user.id);
  assert.equal(changed.username, 'new.name');
  assert.equal(changed.displayName, body.displayName);
  assert.equal(changed.emailVerified, true);
  assert.equal(changed.email, 'profile@example.com');
  assert.equal(store.getUserData(user.id).courses.private.title, 'Private course');
  assert.equal((await request('/api/auth/profile', { method: 'POST', headers, body: { ...body, displayName: 'Another name' } })).status, 200);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: 'original.name', password: 'profile-password' } })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: 'new.name', password: 'profile-password' } })).status, 200);
  for (const invalid of [{ username: '' }, { username: 'x' }, { username: 'not valid' }, { isAdmin: true }]) {
    assert.equal((await request('/api/auth/profile', { method: 'POST', headers, body: { ...body, ...invalid } })).status, 400);
  }
});

test('account profile claims are case-insensitive and reject stale or revoked changes', async context => {
  const { store, request } = await httpFixture(context);
  const hashed = await authModule.hashPassword('profile-password');
  const users = ['first.user', 'second.user'].map(username => store.createUser({ username, ...hashed }));
  const cookies = await Promise.all(users.map(async user => cookieOf(await request('/api/auth/login', { method: 'POST', body: { identifier: user.username, password: 'profile-password' } }))));
  const results = await Promise.all(cookies.map((cookie, index) => request('/api/auth/profile', { method: 'POST', headers: { Cookie: cookie }, body: {
    username: index ? 'CLAIMED.NAME' : 'claimed.name', displayName: 'Member', password: 'profile-password',
  } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const rejected = results.find(result => result.status === 409);
  assert.deepEqual(await rejected.json(), { error: 'This username is already taken. Try another.', code: 'USERNAME_TAKEN' });
  const winnerIndex = results.findIndex(result => result.status === 200);
  const user = store.getUserById(users[winnerIndex].id);
  const currentSessionHash = digest(cookies[winnerIndex].split('=')[1]);
  store.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Changed elsewhere', user.id);
  assert.throws(() => store.updateAccountProfile({ user, currentSessionHash, displayName: 'Stale change', username: user.username }), { code: 'PROFILE_CHANGED' });
  store.deleteSession(currentSessionHash);
  assert.throws(() => store.updateAccountProfile({ user, currentSessionHash, displayName: 'Revoked change', username: user.username }), { code: 'UNAUTHENTICATED' });
  const captured = { ...user, username: 'old.alias' };
  assert.throws(() => store.passwordSession({ user: captured, sessionHash: digest('stale-username'), sessionMs: 10000 }), { code: 'INVALID_CREDENTIALS' });
});

test('members without usernames can add one and profile updates have a persistent account budget', async context => {
  const { store, request, verify } = await httpFixture(context);
  const body = await verify(joinBody(bootstrapToken(store)));
  const registered = await request('/api/auth/register', { method: 'POST', body });
  const headers = { Cookie: cookieOf(registered) };
  const user = (await registered.json()).user;
  assert.equal(user.username, null);
  const update = { displayName: 'Learner', username: 'added.name', password: body.password };
  assert.equal((await request('/api/auth/profile', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: update })).status, 403);
  const added = await request('/api/auth/profile', { method: 'POST', headers, body: update });
  assert.equal(added.status, 200);
  assert.equal((await added.json()).user.username, 'added.name');
  for (let attempt = 0; attempt < 9; attempt++) assert.equal((await request('/api/auth/profile', { method: 'POST', headers, body: update })).status, 200);
  const limited = await request('/api/auth/profile', { method: 'POST', headers, body: update });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(store.getUserById(user.id).id, user.id);
});

test('password changes rotate sessions while preserving account identity and learning data', async context => {
  const { store, request, emails } = await httpFixture(context);
  const currentPassword = 'current-password-123';
  const newPassword = 'new-password-456';
  const user = store.createUser({ username: 'security.user', ...await authModule.hashPassword(currentPassword) });
  store.db.prepare('UPDATE users SET email_normalized = ?, email_verified_at = ? WHERE id = ?').run('security@example.com', '2026-09-01', user.id);
  store.saveUserData(user.id, { courses: { saved: { title: 'Keep this course', videos: [] } }, stats: {}, settings: {}, workspace: {} }, 0);
  const data = store.getUserData(user.id);
  const before = store.getUserById(user.id);
  const login = () => request('/api/auth/login', { method: 'POST', body: { username: 'security.user', password: currentPassword } });
  const oldCookies = [cookieOf(await login()), cookieOf(await login())];
  const challengeHash = digest('password-change-email-challenge');
  store.issueEmailVerification({ email: 'security@example.com', purpose: 'email', userId: user.id,
    inviteHash: null, currentSessionHash: digest(oldCookies[0].split('=')[1]), verificationHash: challengeHash, verificationCodeHash: digest('000042') });
  const auditCount = store.db.prepare('SELECT count(*) AS count FROM auth_audit WHERE user_id = ?').get(user.id).count;
  const other = store.createUser({ username: 'other.security', ...await authModule.hashPassword(currentPassword) });
  const otherCookie = cookieOf(await request('/api/auth/login', { method: 'POST', body: { username: other.username, password: currentPassword } }));
  const changed = await request('/api/auth/password', { method: 'POST', headers: { Cookie: oldCookies[0] },
    body: { currentPassword, newPassword, passwordConfirmation: newPassword } });
  assert.equal(changed.status, 200);
  const response = await changed.json();
  assert.deepEqual(response.user, JSON.parse(JSON.stringify(store.publicUser(before))));
  assert.deepEqual(Object.keys(response), ['user']);
  const replacement = cookieOf(changed);
  assert.ok(!oldCookies.includes(replacement));
  assert.match(changed.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  for (const cookie of oldCookies) assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: replacement } })).status, 200);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: otherCookie } })).status, 200);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id = ?').get(user.id).count, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM email_verifications WHERE user_id = ?').get(user.id).count, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM auth_audit WHERE user_id = ?').get(user.id).count, auditCount);
  const after = store.getUserById(user.id);
  assert.notEqual(after.password_hash, before.password_hash);
  assert.notEqual(after.salt, before.salt);
  assert.deepEqual(store.getUserData(user.id), data);
  assert.equal((await login()).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'security@example.com', password: newPassword } })).status, 200);
  assert.equal(emails.length, 0);
});

test('password changes reject bad input, foreign origins and guests with bounded attempts', async context => {
  const { store, request } = await httpFixture(context);
  const currentPassword = 'current-password-123';
  const user = store.createUser({ username: 'protected.user', ...await authModule.hashPassword(currentPassword) });
  const cookie = cookieOf(await request('/api/auth/login', { method: 'POST', body: { username: user.username, password: currentPassword } }));
  const body = { currentPassword, newPassword: 'replacement-password', passwordConfirmation: 'replacement-password' };
  assert.equal((await request('/api/auth/password', { method: 'POST', body })).status, 401);
  assert.equal((await request('/api/auth/password', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://foreign.example' }, body })).status, 403);
  const guest = store.createUser({ isGuest: true });
  const guestToken = crypto.randomBytes(32).toString('base64url');
  store.createSession(digest(guestToken), guest.id, new Date(Date.now() + 60000).toISOString());
  assert.equal((await request('/api/auth/password', { method: 'POST', headers: { Cookie: `ft_session=${guestToken}` }, body })).status, 403);
  for (const [change, code] of [
    [{ currentPassword: 'incorrect-password' }, 'PROFILE_PASSWORD_INVALID'],
    [{ passwordConfirmation: 'different-password' }, 'PASSWORD_MISMATCH'],
    [{ newPassword: currentPassword, passwordConfirmation: currentPassword }, 'PASSWORD_UNCHANGED'],
    [{ newPassword: 'short' }, 'INVALID_REQUEST'],
    [{ userId: guest.id }, 'INVALID_REQUEST'],
  ]) {
    const rejected = await request('/api/auth/password', { method: 'POST', headers: { Cookie: cookie }, body: { ...body, ...change } });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, code);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  const limited = await request('/api/auth/password', { method: 'POST', headers: { Cookie: cookie }, body });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(store.getUserById(user.id).password_hash, user.password_hash);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
});

test('password rotation rolls back on session failure and concurrent changes cannot reuse stale credentials', async context => {
  const { store, request } = await httpFixture(context);
  const currentPassword = 'current-password-123';
  const user = store.createUser({ username: 'rotation.user', ...await authModule.hashPassword(currentPassword) });
  const cookie = cookieOf(await request('/api/auth/login', { method: 'POST', body: { username: user.username, password: currentPassword } }));
  const change = newPassword => request('/api/auth/password', { method: 'POST', headers: { Cookie: cookie }, body: { currentPassword, newPassword, passwordConfirmation: newPassword } });
  const challengeHash = digest('rollback-password-email-challenge');
  store.issueEmailVerification({ email: 'rotation@example.com', purpose: 'email', userId: user.id,
    inviteHash: null, currentSessionHash: digest(cookie.split('=')[1]), verificationHash: challengeHash, verificationCodeHash: digest('000042') });
  store.db.exec("CREATE TRIGGER fail_password_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const failed = await change('replacement-password');
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal(store.getUserById(user.id).password_hash, user.password_hash);
  assert.equal(store.getUserById(user.id).salt, user.salt);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM email_verifications WHERE token_hash = ?').get(challengeHash).count, 1);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  store.db.exec('DROP TRIGGER fail_password_session');
  const candidates = ['replacement-one', 'replacement-two'];
  const results = await Promise.all(candidates.map(change));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  const winner = results.findIndex(result => result.status === 200);
  assert.equal(await authModule.verifyPassword(candidates[winner], store.getUserById(user.id)), true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id = ?').get(user.id).count, 1);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookieOf(results[winner]) } })).status, 200);
  assert.throws(() => store.passwordSession({ user, currentSessionHash: digest(cookie.split('=')[1]),
    passwordHash: 'stale', salt: 'stale', sessionHash: digest('stale-password-change'), sessionMs: 60000 }), { code: 'INVALID_CREDENTIALS' });
});

async function raceRedemptions(directory, values) {
  const workers = values.map(value => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    process.env.FOCUSTUBE_DATA_DIR = workerData.directory;
    const store = require(workerData.root + '/db');
    parentPort.once('message', () => {
      try { store.redeemInvitation(workerData.values); parentPort.postMessage('ok'); }
      catch (error) { parentPort.postMessage(error.code); }
      finally { store.db.close(); parentPort.close(); }
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { directory, root, values: value } }));
  try {
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
    const results = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
    for (const worker of workers) worker.postMessage('redeem');
    return await Promise.all(results);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test('independent SQLite connections serialize invitation, bootstrap, email, and last-slot races', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-auth-race-'));
  const store = memoryStore(context, path.join(directory, 'focustube.db'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  invitation(store, 'bootstrap-one');
  invitation(store, 'bootstrap-two');
  const adminResults = await raceRedemptions(directory, [registration(store, 'bootstrap-one', 'one@example.com'), registration(store, 'bootstrap-two', 'two@example.com')]);
  assert.equal(adminResults.filter(result => result === 'ok').length, 1);
  assert.equal(adminResults.filter(result => result === 'REGISTRATION_CONFLICT').length, 1);
  const adminSession = store.db.prepare('SELECT token_hash FROM sessions').get().token_hash;
  invitation(store, 'shared', adminSession);
  const shared = await raceRedemptions(directory, [registration(store, 'shared', 'three@example.com'), registration(store, 'shared', 'four@example.com')]);
  assert.equal(shared.filter(result => result === 'ok').length, 1);
  assert.equal(shared.filter(result => result === 'INVALID_INVITATION').length, 1);
  invitation(store, 'email-one', adminSession);
  invitation(store, 'email-two', adminSession);
  const emails = await raceRedemptions(directory, [registration(store, 'email-one', 'same@example.com'), registration(store, 'email-two', 'same@example.com')]);
  assert.equal(emails.filter(result => result === 'ok').length, 1);
  assert.equal(emails.filter(result => result === 'REGISTRATION_CONFLICT').length, 1);
  store.setMemberLimit(4);
  invitation(store, 'slot-one', adminSession);
  invitation(store, 'slot-two', adminSession);
  const slots = await raceRedemptions(directory, [registration(store, 'slot-one', 'last-one@example.com'), registration(store, 'slot-two', 'last-two@example.com')]);
  assert.equal(slots.filter(result => result === 'ok').length, 1);
  assert.equal(slots.filter(result => result === 'REGISTRATION_CONFLICT').length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 4);
});

test('invitation entry scrubs secrets before other scripts and never persists or previews them', async () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.ok(html.indexOf('src="auth-entry.js"') < html.indexOf('src="theme.js"'));
  const source = fs.readFileSync(path.join(root, 'public/auth-entry.js'), 'utf8');
  const token = crypto.randomBytes(32).toString('base64url');
  const listeners = new Map();
  const requests = [];
  const window = {
    location: new URL(`http://localhost:3002/#join=${token}`),
    history: { replaceState(state, _title, target) { assert.equal(state, null); window.location = new URL(target, window.location); } },
    addEventListener(name, callback) { listeners.set(name, callback); }, dispatchEvent() {},
  };
  vm.runInNewContext(source, { window, URL, URLSearchParams, CustomEvent: class {},
    fetch(endpoint, options) { requests.push({ endpoint, options }); return Promise.resolve({ status: 201 }); },
  });
  assert.equal(window.location.hash, '#join');
  assert.equal(window.FocusTubeInvite.has(), true);
  assert.equal(requests.length, 0);
  await assert.rejects(window.FocusTubeInvite.submit('https://other.test', { body: '{}' }));
  await window.FocusTubeInvite.submit('/api/auth/register', { body: JSON.stringify({ email: 'test@example.com' }) });
  assert.equal(JSON.parse(requests[0].options.body).inviteToken, token);
  assert.equal(requests[0].endpoint.includes(token), false);
  listeners.get('pagehide')();
  assert.equal(window.FocusTubeInvite.has(), false);
  await assert.rejects(window.FocusTubeInvite.submit('/api/auth/register', { body: '{}' }));
});

test('old populated databases are backed up and migrated without changing account IDs or password material', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-auth-migration-'));
  const filename = path.join(directory, 'focustube.db');
  const legacy = new Database(filename);
  legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT COLLATE NOCASE UNIQUE,
    password_hash TEXT, salt TEXT, is_guest INTEGER NOT NULL DEFAULT 0, download_quality TEXT NOT NULL DEFAULT '720',
    created_at TEXT NOT NULL, last_active_at TEXT NOT NULL);
    INSERT INTO users VALUES (7, 'original', 'original-hash', 'original-salt', 0, '720', '2026-01-01T00:00:00.000Z', '2026-09-13T00:00:00.000Z');`);
  legacy.close();
  const store = memoryStore(context, filename);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const user = store.getUserByName('ORIGINAL');
  assert.equal(user.id, 7);
  assert.equal(user.password_hash, 'original-hash');
  assert.equal(user.salt, 'original-salt');
  assert.equal(user.email_normalized, null);
  assert.equal(user.is_admin, 0);
  assert.equal(user.account_state, 'active');
  const backups = fs.readdirSync(path.join(directory, 'backups'));
  assert.equal(backups.length, 1);
  const backup = new Database(path.join(directory, 'backups', backups[0]), { readonly: true });
  try {
    assert.equal(backup.prepare('SELECT username FROM users WHERE id = 7').get().username, 'original');
    assert.equal(backup.pragma('table_info(users)').some(column => column.name === 'email_normalized'), false);
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
  } finally { backup.close(); }
  const reopened = memoryStore(context, filename);
  assert.equal(reopened.getUserById(7).password_hash, user.password_hash);
  assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1);
});

test('operator bootstrap is local-only, refuses an existing admin, and supports explicit capacity changes', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-auth-operator-'));
  const store = memoryStore(context, path.join(directory, 'focustube.db'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/auth-admin.js'), ...args, '--data-dir', directory], { encoding: 'utf8' });
  const issued = command('bootstrap', '--origin', 'http://localhost:3101');
  assert.equal(issued.status, 0, issued.stderr);
  const token = new URL(JSON.parse(issued.stdout).inviteUrl).hash.slice('#join='.length);
  assert.equal(authModule.validToken(token), true);
  store.redeemInvitation(registration(store, token));
  const refused = command('bootstrap', '--origin', 'http://localhost:3101');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /active administrator/);
  assert.equal(refused.stdout, '');
  assert.equal(command('set-limit', '--max-members', '250').status, 0);
  assert.equal(store.getAuthWorkspace().max_members, 250);
  assert.equal(command('bootstrap', '--origin', 'http://remote.example').status, 1);
});

test('rate budgets survive restart and never evict active identifiers to admit new keys', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-auth-budgets-'));
  const filename = path.join(directory, 'focustube.db');
  const store = memoryStore(context, filename);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timestamp = Date.now();
  const budget = [{ key: digest('persistent'), limit: 1 }];
  assert.equal(store.reserveBudgets(budget, timestamp), 0);
  const second = memoryStore(context, filename);
  assert.equal(second.reserveBudgets(budget, timestamp), 900);
  store.db.transaction(() => {
    const insert = store.db.prepare('INSERT INTO login_budgets VALUES (?, 1, ?)');
    for (let index = 1; index < 5000; index++) insert.run(digest(`budget:${index}`), new Date(timestamp).toISOString());
  })();
  assert.equal(second.reserveBudgets([{ key: digest('new-key'), limit: 5 }], timestamp), 900);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM login_budgets').get().count, 5000);
  assert.equal(store.db.prepare('SELECT attempt_count FROM login_budgets WHERE budget_key_hash = ?').get(digest('persistent')).attempt_count, 1);
});

test('login and registration limits count failed and malformed attempts without creating users', async context => {
  const { store, request } = await httpFixture(context);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'unknown@example.com', password: 'wrong-password' } })).status, 401);
  }
  const limited = await request('/api/auth/login', { method: 'POST', body: { email: 'UNKNOWN@example.com', password: 'wrong-password' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('/api/auth/register', { method: 'POST', body: {} })).status, 400);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: {} })).status, 429);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  assert.ok(store.db.prepare('SELECT budget_key_hash FROM login_budgets').all().every(row => /^[a-f0-9]{64}$/.test(row.budget_key_hash)));
});

test('session expiry, lifecycle changes, logout errors, and guest isolation are enforced by real middleware', async context => {
  const { store, request, verify } = await httpFixture(context);
  const registrationResponse = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const cookie = cookieOf(registrationResponse);
  const user = (await registrationResponse.json()).user;
  store.db.exec("CREATE TRIGGER fail_logout BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 503);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  store.db.exec('DROP TRIGGER fail_logout');
  store.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(new Date().toISOString(), user.id);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM sessions').get().count, 1);
  const guest = store.createUser({ isGuest: true });
  const token = crypto.randomBytes(32).toString('base64url');
  store.createSession(digest(token), guest.id, new Date(Date.now() + 86400000).toISOString());
  const guestHeaders = { Cookie: `ft_session=${token}` };
  assert.equal((await request('/api/auth/me', { headers: guestHeaders })).status, 200);
  assert.equal((await request('/api/export', { headers: guestHeaders })).status, 200);
  for (const endpoint of ['/api/data', '/api/notebooks', '/api/stats/summary', '/api/search?q=test', '/api/downloads/current']) assert.equal((await request(endpoint, { headers: guestHeaders })).status, 403, endpoint);
  assert.equal((await request('/api/auth/upgrade', { method: 'POST', headers: guestHeaders, body: {} })).status, 400);
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(guest.id);
  assert.equal((await request('/api/export', { headers: guestHeaders })).status, 401);
});

test('Secure cookies require a trusted HTTPS proxy and HTTP remains confined to approved loopback deployments', async context => {
  const { store, request, origin, verify } = await httpFixture(context, { TRUST_PROXY: 'loopback' });
  const headers = { Origin: origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' };
  const registered = await request('/api/auth/register', { method: 'POST', headers, body: await verify(joinBody(bootstrapToken(store)), headers) });
  assert.equal(registered.status, 201);
  assert.match(registered.headers.get('set-cookie'), /; Secure/);
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { ...headers, Cookie: cookieOf(registered) } });
  assert.match(logout.headers.get('set-cookie'), /SameSite=Strict; Max-Age=0; Secure/);
  const unapproved = await httpFixture(context, { HOST: '0.0.0.0' });
  assert.equal((await unapproved.request('/api/auth/status')).status, 403);
  for (const endpoint of ['/api/auth/login', '/api/auth/logout', '/api/auth/register', '/api/auth/upgrade', '/api/auth/email', '/api/invites', '/api/import', '/api/track']) {
    assert.equal((await request(endpoint, { method: 'POST', headers: { Origin: 'http://foreign.test' }, body: {} })).status, 403, endpoint);
  }
  assert.equal((await fetch(origin + '/api/auth/logout', { method: 'POST' })).status, 403);
});

test('real member sessions isolate profile data, notebooks, imports, exports and statistics even from administrators', async context => {
  const { store, request, verify } = await httpFixture(context);
  const first = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const adminCookie = cookieOf(first);
  const admin = (await first.json()).user;
  const invite = await request('/api/invites', { method: 'POST', headers: { Cookie: adminCookie }, body: {} });
  const token = new URL((await invite.json()).inviteUrl).hash.slice('#join='.length);
  const second = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(token), email: 'private@example.com' }) });
  const memberCookie = cookieOf(second);
  const member = (await second.json()).user;
  store.saveUserData(member.id, { courses: { secret: { id: 'secret', title: 'Private course', videos: [{ id: 'aqz-KE-bpKQ', title: 'Private lesson' }] } }, stats: {}, settings: {}, workspace: {} }, 0);
  store.saveNote(member.id, 'secret', 'aqz-KE-bpKQ', { version: 1, ops: [
    { insert: 'Private note' }, { insert: '\n', attributes: { blockId: 'block-private', anchorSeconds: 0 } },
  ] }, 0);
  const memberExport = await (await request('/api/export', { headers: { Cookie: memberCookie } })).json();
  assert.ok(memberExport.courses.secret);
  for (const endpoint of ['/api/data', '/api/export']) {
    const response = await request(`${endpoint}?userId=${member.id}`, { headers: { Cookie: adminCookie, 'x-test-user': String(member.id) } });
    assert.equal(JSON.stringify(await response.json()).includes('Private course'), false);
  }
  const adminNotes = await request('/api/notebooks/secret', { headers: { Cookie: adminCookie } });
  assert.equal(adminNotes.status, 200);
  assert.equal((await adminNotes.json()).records.length, 0);
  assert.equal((await request('/api/notebooks/secret?notesRevision=0', { method: 'DELETE', headers: { Cookie: adminCookie } })).status, 200);
  assert.equal(store.getNotebook(member.id, 'secret').records.length, 1);
  assert.equal((await request('/api/stats/summary', { headers: { Cookie: adminCookie } })).status, 200);
  const adminNotesRevision = store.getUserData(admin.id).notesRevision;
  const imported = await request(`/api/import?revision=0&notesRevision=${adminNotesRevision}`, { method: 'POST', headers: { Cookie: adminCookie }, body: { ...memberExport, userId: member.id, profile: { isAdmin: true, id: member.id } } });
  assert.equal(imported.status, 200);
  assert.equal(store.getUserById(member.id).is_admin, 0);
  assert.equal(store.getUserById(admin.id).is_admin, 1);
  assert.equal(store.getUserData(member.id).revision, 1);
  const createdJob = await request('/api/downloads', { method: 'POST', headers: { Cookie: memberCookie }, body: { courseId: 'secret', authorized: true } });
  assert.equal(createdJob.status, 202);
  const job = (await createdJob.json()).job;
  assert.equal((await (await request('/api/downloads/current', { headers: { Cookie: adminCookie } })).json()).job, null);
  for (const [method, suffix] of [['GET', '/file'], ['GET', '/events'], ['DELETE', '']]) {
    assert.equal((await request(`/api/downloads/${job.id}${suffix}`, { method, headers: { Cookie: adminCookie } })).status, 404);
  }
  assert.equal((await request(`/api/downloads/${job.id}/file`, { headers: { Cookie: memberCookie } })).status, 409);
  const events = await request(`/api/downloads/${job.id}/events`, { headers: { Cookie: memberCookie } });
  assert.equal(events.status, 200);
  await events.body.cancel();
  assert.equal((await request(`/api/downloads/${job.id}`, { method: 'DELETE', headers: { Cookie: memberCookie } })).status, 204);
});

test('email normalization is explicit and unknown users perform the same scrypt work', async () => {
  assert.equal(authModule.normalizeEmail(' Person+course@Example.COM '), 'person+course@example.com');
  for (const value of ['.person@example.com', 'person..name@example.com', 'person@-example.com', 'person@example..com', '\u212a@example.com', null, ['person@example.com']]) {
    assert.throws(() => authModule.normalizeEmail(value), { code: 'INVALID_REQUEST' });
  }
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'auth.js'), 'utf8'), {
    module, Buffer, process,
    require(name) {
      if (name === 'crypto') return { ...crypto, scrypt(...args) { calls.push({ keyLength: args[2], options: args.length }); return crypto.scrypt(...args); } };
      return name.startsWith('.') ? require(path.join(root, name)) : require(name);
    },
  });
  const hashed = await authModule.hashPassword('verification-password');
  assert.equal(await module.exports.verifyPassword('verification-password', { salt: hashed.salt, password_hash: hashed.passwordHash }), true);
  assert.equal(await module.exports.verifyPassword('verification-password', null), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test('SMTP verification fails closed without delivery settings and requires encrypted transport', async () => {
  const disabled = createAuthServices({});
  assert.equal(disabled.emailConfigured, false);
  await assert.rejects(disabled.sendVerification({ email: 'member@example.com', code: '12345678' }), { code: 'EMAIL_NOT_CONFIGURED' });
  assert.throws(() => createAuthServices({ SMTP_HOST: 'smtp.example.com' }), /SMTP_FROM/);
  let mail;
  const services = createAuthServices({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'noreply@example.com', SMTP_USER: 'sender', SMTP_PASSWORD: 'test-password' }, {
    createTransport(options) {
      assert.equal(options.requireTLS, true);
      assert.equal(options.tls.rejectUnauthorized, true);
      assert.equal(options.debug, false);
      return { async sendMail(value) { mail = value; return { accepted: [value.to.address] }; } };
    },
  });
  await services.sendVerification({ email: 'member@example.com', code: '12345678', origin: 'http://localhost:3002' });
  assert.equal(mail.to.address, 'member@example.com');
  assert.ok(mail.text.includes('12345678'));
  assert.ok(!mail.text.includes('test-password'));
});

test('optional Turnstile validates hostname, action, expiry, failure and missing tokens on the server', async () => {
  const values = { origin: 'http://localhost:3002', action: 'login', remoteAddress: '127.0.0.1' };
  await createAuthServices({}).verifyCaptcha(undefined, values);
  assert.throws(() => createAuthServices({ TURNSTILE_SITE_KEY: 'site' }), /both TURNSTILE/);
  let result = { success: true, hostname: 'localhost', action: 'login', challenge_ts: new Date().toISOString() };
  let calls = 0;
  const services = createAuthServices({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' }, {
    async fetch(url, options) {
      calls++;
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(JSON.parse(options.body).secret, 'secret');
      return { ok: true, json: async () => result };
    },
  });
  await assert.rejects(services.verifyCaptcha('', values), { code: 'CAPTCHA_REQUIRED' });
  assert.equal(calls, 0);
  await services.verifyCaptcha('challenge', values);
  for (const change of [{ success: false }, { hostname: 'evil.example' }, { action: 'registration' }, { challenge_ts: '2020-01-01T00:00:00Z' }]) {
    result = { success: true, hostname: 'localhost', action: 'login', challenge_ts: new Date().toISOString(), ...change };
    await assert.rejects(services.verifyCaptcha('challenge', values), { code: 'CAPTCHA_FAILED' });
  }
});

test('email ownership is required and verification consumption rolls back with failed registration', async context => {
  context.mock.method(crypto, 'randomInt', maximum => { assert.equal(maximum, 1000000); return 42; });
  const { store, request, verify, emails } = await httpFixture(context);
  const token = bootstrapToken(store);
  const body = joinBody(token);
  const missing = await request('/api/auth/register', { method: 'POST', body });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'INVALID_VERIFICATION');
  assert.equal(store.invitationAvailable(digest(token)), true);
  const verified = await verify(body);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].email, 'admin@example.com');
  assert.match(emails[0].code, /^\d{6}$/);
  assert.equal(emails[0].code, '000042');
  const row = store.db.prepare('SELECT * FROM email_verifications').get();
  assert.notEqual(row.code_hash, digest(emails[0].code));
  assert.equal(row.token_hash, digest(verified.verificationToken));
  assert.equal(row.consumed_at, null);
  for (const change of [{ verificationCode: '12345' }, { verificationCode: '12345678' },
    { verificationCode: verified.verificationCode === '000000' ? '111111' : '000000' }, { email: 'other@example.com' }]) {
    const rejected = await request('/api/auth/register', { method: 'POST', body: { ...verified, ...change } });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'INVALID_VERIFICATION');
  }
  assert.equal(store.db.prepare('SELECT attempts FROM email_verifications').get().attempts, 1);
  store.db.exec("CREATE TRIGGER fail_verified_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.equal((await request('/api/auth/register', { method: 'POST', body: verified })).status, 500);
  assert.equal(store.db.prepare('SELECT consumed_at FROM email_verifications').get().consumed_at, null);
  assert.equal(store.invitationAvailable(digest(token)), true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  store.db.exec('DROP TRIGGER fail_verified_session');
  const accepted = await request('/api/auth/register', { method: 'POST', body: verified });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).user.emailVerified, true);
  assert.ok(store.db.prepare('SELECT consumed_at FROM email_verifications').get().consumed_at);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: verified })).status, 400);
});

test('resending supersedes only the matching email challenge and expired codes cannot register', async context => {
  const { store, request, verify } = await httpFixture(context);
  const body = joinBody(bootstrapToken(store));
  const first = await verify(body);
  const cool = await request('/api/auth/verification/request', { method: 'POST', body: { email: body.email, inviteToken: body.inviteToken } });
  assert.equal(cool.status, 429);
  assert.equal(cool.headers.get('retry-after'), '60');
  store.db.prepare('UPDATE email_verifications SET created_at = ?').run(new Date(Date.now() - 61000).toISOString());
  const second = await verify(body);
  assert.notEqual(second.verificationToken, first.verificationToken);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM email_verifications').get().count, 1);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: first })).status, 400);
  store.db.prepare('UPDATE email_verifications SET created_at = ?, expires_at = ?')
    .run(new Date(Date.now() - 60000).toISOString(), new Date(Date.now() - 1000).toISOString());
  const expired = await request('/api/auth/register', { method: 'POST', body: second });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).code, 'INVALID_VERIFICATION');
  assert.equal(store.invitationAvailable(digest(body.inviteToken)), true);
});

test('unconfigured or failed mail delivery cannot create usable proofs, accounts, or consumed invitations', async context => {
  for (const configured of [false, true]) {
    const services = { emailConfigured: configured, captchaSiteKey: null, async verifyCaptcha() {},
      async sendVerification() { throw Object.assign(new Error('private provider details'), { code: 'EMAIL_DELIVERY_FAILED' }); } };
    const { store, request } = await httpFixture(context, {}, services);
    const inviteToken = bootstrapToken(store);
    const response = await request('/api/auth/verification/request', { method: 'POST', body: { email: 'member@example.com', inviteToken } });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.code, configured ? 'EMAIL_DELIVERY_FAILED' : 'EMAIL_NOT_CONFIGURED');
    assert.equal(JSON.stringify(result).includes('private provider'), false);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM email_verifications').get().count, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
    assert.equal(store.invitationAvailable(digest(inviteToken)), true);
  }
});

test('existing email verification is bound to the logged-in account and rotates every old session', async context => {
  const { store, request, verify } = await httpFixture(context);
  const user = store.createUser({ username: 'existing', ...await authModule.hashPassword('existing-password') });
  store.db.prepare('UPDATE users SET email_normalized = ? WHERE id = ?').run('existing@example.com', user.id);
  assert.equal(store.publicUser(store.getUserById(user.id)).emailVerified, false);
  const login = () => request('/api/auth/login', { method: 'POST', body: { identifier: 'existing', password: 'existing-password' } });
  const first = await login();
  const second = await login();
  const body = await verify({ email: 'existing@example.com', password: 'existing-password' }, { Cookie: cookieOf(first) });
  const wrongSession = await request('/api/auth/email', { method: 'POST', headers: { Cookie: cookieOf(second) }, body });
  assert.equal(wrongSession.status, 400);
  const accepted = await request('/api/auth/email', { method: 'POST', headers: { Cookie: cookieOf(first) }, body });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).user.emailVerified, true);
  for (const cookie of [cookieOf(first), cookieOf(second)]) assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookieOf(accepted) } })).status, 200);
});

test('enabled CAPTCHA is required for code delivery, registration and login and never exposes its secret', async context => {
  let delivered;
  const consumed = new Set();
  const services = { emailConfigured: true, captchaSiteKey: 'public-site-key',
    async sendVerification(value) { delivered = value; },
    async verifyCaptcha(token, { action }) {
      if (!token || !token.startsWith(`${action}-`) || consumed.has(token)) throw Object.assign(new Error('CAPTCHA_FAILED'), { code: 'CAPTCHA_FAILED' });
      consumed.add(token);
    } };
  const { store, request } = await httpFixture(context, {}, services);
  const body = joinBody(bootstrapToken(store));
  assert.equal((await request('/api/auth/verification/request', { method: 'POST', body: { email: body.email, inviteToken: body.inviteToken } })).status, 400);
  assert.equal(delivered, undefined);
  const sent = await request('/api/auth/verification/request', { method: 'POST', body: { email: body.email, inviteToken: body.inviteToken, captchaToken: 'registration-send' } });
  assert.equal(sent.status, 202);
  const receipt = await sent.json();
  assert.equal(JSON.stringify(receipt).includes(delivered.code), false);
  const verified = { ...body, verificationToken: receipt.verificationToken, verificationCode: delivered.code };
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { ...verified, captchaToken: 'registration-send' } })).status, 400);
  const accepted = await request('/api/auth/register', { method: 'POST', body: { ...verified, captchaToken: 'registration-final' } });
  assert.equal(accepted.status, 201);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: body.email, password: body.password } })).status, 400);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: body.email, password: body.password, captchaToken: 'login-once' } })).status, 200);
  const status = await request('/api/auth/status');
  assert.equal((await status.json()).captcha.siteKey, 'public-site-key');
  assert.match(status.headers.get('content-security-policy'), /https:\/\/challenges\.cloudflare\.com/);
});

test('hidden authentication forms remove CAPTCHA and future providers remain disabled', () => {
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const block = source.slice(source.indexOf('function resetCaptcha(kind)'), source.indexOf('function syncEmailCode(kind)'));
  const removed = [];
  let reset = false;
  vm.runInNewContext(block + '\nresetCaptcha("auth"); resetCaptcha("enrollment");', {
    authView: { classList: { contains: () => true } },
    $: () => ({ open: false, classList: { contains: () => true } }),
    syncCaptcha: (kind, action) => removed.push([kind, action]),
    captchaWidgets: { auth: { id: 1 }, enrollment: { id: 2 } },
    window: { turnstile: { reset: () => { reset = true; } } },
  });
  assert.deepEqual(removed, [['auth', null], ['enrollment', null]]);
  assert.equal(reset, false);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="authPasswordConfirmation"[^>]+type="password"/);
  assert.match(html, /id="authHandle"/);
  assert.equal((html.match(/class="btn ghost auth-provider" type="button" aria-disabled="true"/g) || []).length, 2);
});

test('live activity requires a fresh single-use challenge, deduplicates tabs and expires on logout or inactivity', context => {
  const store = memoryStore(context);
  invitation(store);
  const values = registration(store);
  const { user } = store.redeemInvitation(values);
  const timestamp = Date.now();
  const challenge = digest('fresh-presence');
  assert.equal(store.getUsageCounts(timestamp).activeNow, 0);
  store.issuePresenceChallenge(values.sessionHash, 'first-tab', challenge, timestamp);
  store.confirmPresence(values.sessionHash, 'first-tab', challenge, timestamp + 1000);
  assert.throws(() => store.confirmPresence(values.sessionHash, 'first-tab', challenge, timestamp + 2000), { code: 'INVALID_REQUEST' });
  store.issuePresenceChallenge(values.sessionHash, 'second-tab', challenge, timestamp);
  store.confirmPresence(values.sessionHash, 'second-tab', challenge, timestamp + 1000);
  assert.equal(store.getUsageCounts(timestamp + 2000).activeNow, 1);
  assert.equal(store.getUsageCounts(timestamp + 2000).activeToday, 1);
  store.clearPresence(values.sessionHash, 'first-tab');
  assert.equal(store.getUsageCounts(timestamp + 2000).activeNow, 1);
  assert.equal(store.getUsageCounts(timestamp + 301001).activeNow, 0);
  store.issuePresenceChallenge(values.sessionHash, 'stale-tab', challenge, timestamp);
  assert.throws(() => store.confirmPresence(values.sessionHash, 'stale-tab', challenge, timestamp + 45000), { code: 'INVALID_REQUEST' });
  const usage = store.getAdminUsage(1, timestamp + 2000);
  assert.equal(usage.users[0].id, user.id);
  assert.equal(usage.users[0].email, undefined);
  assert.equal(usage.users[0].password_hash, undefined);
  assert.equal(usage.events[0].event, 'register');
  store.deleteSession(values.sessionHash);
  assert.equal(store.getUsageCounts(timestamp + 2000).activeNow, 0);
  assert.equal(store.getAdminUsage(1, timestamp + 2000).events[0].event, 'logout');
});

test('ordinary API touches and delayed learning batches never mark a user currently active', context => {
  const store = memoryStore(context);
  invitation(store);
  const values = registration(store);
  const { user } = store.redeemInvitation(values);
  store.touchUser(user.id);
  store.track(user.id, { batchId: 'old-batch-id', date: '2020-01-01', activeSeconds: 60, watch: [] });
  assert.equal(store.getUsageCounts().activeNow, 0);
  assert.equal(store.getUsageCounts().activeToday, 0);
  store.issuePresenceChallenge(values.sessionHash, 'tab', digest('presence'));
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(user.id);
  assert.throws(() => store.confirmPresence(values.sessionHash, 'tab', digest('presence')), { code: 'UNAUTHENTICATED' });
});

test('monitoring API is admin-only and presence uses server-owned sessions instead of supplied user IDs', async context => {
  const { store, request, verify } = await httpFixture(context);
  assert.equal((await request('/api/admin/monitoring')).status, 401);
  const registered = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const cookie = cookieOf(registered);
  const user = (await registered.json()).user;
  const headers = { Cookie: cookie };
  const tabId = crypto.randomUUID();
  const issued = await request('/api/presence', { method: 'POST', headers, body: { tabId } });
  assert.equal(issued.status, 200);
  const challenge = (await issued.json()).challenge;
  assert.equal((await request('/api/presence', { method: 'PUT', headers, body: { tabId, challenge, userId: 999 } })).status, 400);
  assert.equal((await request('/api/presence', { method: 'PUT', headers, body: { tabId, challenge } })).status, 204);
  const response = await request('/api/admin/monitoring', { headers });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.activeNow, 1);
  assert.equal(result.usage.users[0].id, user.id);
  assert.equal(JSON.stringify(result).includes('admin@example.com'), false);
  for (const secret of ['password_hash', 'token_hash', 'courses_json', 'document_json']) assert.equal(JSON.stringify(result).includes(secret), false);
  store.db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(user.id);
  assert.equal((await request('/api/admin/monitoring', { headers })).status, 403);
  assert.equal((await request('/api/presence', { method: 'DELETE', headers, body: { tabId } })).status, 204);
  assert.equal(store.getUsageCounts().activeNow, 0);
  assert.equal((await request('/internal/metrics', { headers })).status, 404);
});