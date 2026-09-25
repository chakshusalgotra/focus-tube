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

function memoryStore(context, filename = ':memory:', Clock = Date) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'db.js'), 'utf8'), {
    module, Buffer, Date: Clock, __dirname: root,
    require(name) {
      if (name === 'better-sqlite3') return class extends Database { constructor() { super(filename); } };
      if (name === 'fs') return filename === ':memory:' ? { mkdirSync() {} } : fs;
      return require(name);
    },
  }, { filename: 'db.js' });
  context.after(() => { if (module.exports.db.open) module.exports.db.close(); });
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

test('a reusable invitation counts only completed signups and stops at its limit', context => {
  const store = memoryStore(context);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const issued = store.issueInvitation({ tokenHash: digest('shared'), actorSessionHash: admin.sessionHash, maxUses: 2 });
  assert.equal(issued.maxUses, 2);
  assert.equal(issued.useCount, 0);
  const first = registration(store, 'shared', 'first@example.com');
  const second = registration(store, 'shared', 'second@example.com');
  const extra = registration(store, 'shared', 'extra@example.com');
  const usage = () => store.db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(first.inviteHash);
  assert.equal(usage().use_count, 0, 'Requesting verification must not reserve a signup');
  assert.equal(store.redeemInvitation(first).user.is_admin, 0);
  assert.equal(usage().use_count, 1);
  assert.equal(usage().consumed_at, null);
  assert.equal(store.invitationAvailable(first.inviteHash), true);
  assert.throws(() => store.redeemInvitation(first), { code: 'REGISTRATION_CONFLICT' });
  store.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.redeemInvitation(second), /injected/);
  assert.equal(usage().use_count, 1, 'Failed transactions must not spend a use');
  assert.equal(store.getUserByEmail(second.email), undefined);
  assert.equal(store.db.prepare('SELECT consumed_at FROM email_verifications WHERE token_hash = ?').get(second.verificationHash).consumed_at, null);
  store.db.exec('DROP TRIGGER fail_session');
  assert.equal(store.redeemInvitation(second).user.is_admin, 0);
  assert.equal(usage().use_count, 2);
  assert.ok(usage().consumed_at);
  assert.equal(store.invitationAvailable(first.inviteHash), false);
  assert.throws(() => store.redeemInvitation(extra), { code: 'INVALID_INVITATION' });
  assert.equal(store.getUserByEmail(extra.email), undefined);
  assert.equal(usage().use_count, 2);
});

test('new member invitations default to seven days, accept custom UTC expiry, and keep bootstrap at 24 hours', context => {
  const store = memoryStore(context);
  const customExpiry = new Date(Date.now() + 30 * 86400000).toISOString();
  assert.throws(() => store.issueInvitation({ tokenHash: digest('custom-bootstrap'), bootstrap: true, expiresAt: customExpiry }), { code: 'INVALID_INVITATION_EXPIRY' });
  const bootstrap = invitation(store);
  const createdAt = id => store.db.prepare('SELECT created_at FROM invitations WHERE id = ?').get(id).created_at;
  assert.equal(Date.parse(bootstrap.expiresAt) - Date.parse(createdAt(bootstrap.id)), 86400000);
  assert.equal(bootstrap.maxUses, 1);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const member = invitation(store, 'default-member', admin.sessionHash);
  assert.equal(Date.parse(member.expiresAt) - Date.parse(createdAt(member.id)), 7 * 86400000);
  const custom = store.issueInvitation({ tokenHash: digest('custom-member'), actorSessionHash: admin.sessionHash, expiresAt: customExpiry, maxUses: 3 });
  assert.equal(custom.expiresAt, customExpiry);
  assert.equal(custom.maxUses, 3);
  assert.equal(custom.useCount, 0);
});

test('invitation expiry is canonical UTC, strictly future, and bounded from each operation including equality', context => {
  let timestamp = Date.parse('2030-01-01T12:00:00.000Z');
  class Clock extends Date {
    constructor(...values) { super(...(values.length ? values : [timestamp])); }
    static now() { return timestamp; }
  }
  const store = memoryStore(context, ':memory:', Clock);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const actorSessionHash = admin.sessionHash;
  const issued = invitation(store, 'valid-expiry', actorSessionHash);
  const valid = new Date(timestamp + 86400000).toISOString();
  const invalid = [null, true, 0, NaN, Infinity, {}, [], new Date(valid), '', 'never', '2030-02-30T12:00:00.000Z',
    valid.replace('.000Z', 'Z'), valid.replace('Z', '+00:00'), valid.toLowerCase(), ` ${valid}`, `${valid} `,
    new Date(timestamp).toISOString(), new Date(timestamp - 1).toISOString(),
    new Date(timestamp + 365 * 86400000 + 1).toISOString(), '9999-12-31T23:59:59.999Z'];
  for (const expiresAt of invalid) {
    assert.throws(() => store.issueInvitation({ actorSessionHash, tokenHash: digest('invalid-expiry'), expiresAt }), { code: 'INVALID_INVITATION_EXPIRY' });
    assert.throws(() => store.updateInvitation({ actorSessionHash, id: issued.id, revision: 1, expiresAt }), { code: 'INVALID_INVITATION_EXPIRY' });
  }
  assert.throws(() => store.updateInvitation({ actorSessionHash, id: issued.id, revision: 1 }), { code: 'INVALID_INVITATION_EXPIRY' });
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM invitations').get().count, 2);
  assert.equal(store.listInvitations({ actorSessionHash }).invitations[0].revision, 1);
  const boundary = store.issueInvitation({ actorSessionHash, tokenHash: digest('maximum-expiry'), expiresAt: new Date(timestamp + 365 * 86400000).toISOString() });
  timestamp += 86400000;
  const extended = store.updateInvitation({ actorSessionHash, id: boundary.id, revision: 1, expiresAt: new Date(timestamp + 365 * 86400000).toISOString() });
  assert.equal(Date.parse(extended.expiresAt) - Date.parse(boundary.expiresAt), 86400000);
  const immediate = store.issueInvitation({ actorSessionHash, tokenHash: digest('equality'), expiresAt: new Date(timestamp + 1).toISOString() });
  const pending = registration(store, 'equality', 'boundary@example.com');
  assert.equal(store.invitationAvailable(pending.inviteHash), true);
  timestamp++;
  assert.equal(store.invitationAvailable(pending.inviteHash), false);
  assert.throws(() => store.redeemInvitation(pending), { code: 'INVALID_INVITATION' });
  assert.equal(store.listInvitations({ actorSessionHash }).invitations.find(row => row.id === immediate.id).status, 'expired');
  assert.equal(store.db.prepare('SELECT consumed_at FROM email_verifications WHERE token_hash = ?').get(pending.verificationHash).consumed_at, null);
  assert.equal(store.getUserByEmail(pending.email), undefined);
});

test('member expiry edits preserve signup slots, require reactivation, and conflict with redemption revisions', context => {
  const store = memoryStore(context);
  const bootstrap = invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const actorSessionHash = admin.sessionHash;
  const issued = store.issueInvitation({ tokenHash: digest('editable'), actorSessionHash, maxUses: 2 });
  const keys = ['id', 'createdAt', 'expiresAt', 'maxUses', 'useCount', 'remaining', 'status', 'revision'].sort();
  assert.deepEqual(Object.keys(issued).sort(), keys);
  assert.equal(issued.revision, 1);
  assert.equal(issued.status, 'active');
  assert.equal(issued.remaining, 2);
  const expiresAt = new Date(Date.now() + 2 * 86400000).toISOString();
  const shortened = store.updateInvitation({ actorSessionHash, id: issued.id, revision: 1, expiresAt });
  assert.deepEqual(Object.keys(shortened).sort(), keys);
  assert.equal(shortened.expiresAt, expiresAt);
  assert.equal(shortened.revision, 2);
  store.redeemInvitation(registration(store, 'editable', 'first@example.com'));
  assert.throws(() => store.updateInvitation({ actorSessionHash, id: issued.id, revision: 2, expiresAt }), { code: 'INVITATION_CHANGED' });
  const pending = registration(store, 'editable', 'second@example.com');
  store.db.prepare('UPDATE invitations SET created_at = ?, expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 120000).toISOString(), new Date(Date.now() - 60000).toISOString(), issued.id);
  const expired = store.listInvitations({ actorSessionHash }).invitations[0];
  assert.equal(expired.status, 'expired');
  assert.equal(expired.revision, 3);
  assert.equal(expired.useCount, 1);
  assert.equal(expired.remaining, 1);
  for (const reactivate of [undefined, false]) {
    assert.throws(() => store.updateInvitation({ actorSessionHash, id: issued.id, revision: 3, expiresAt, reactivate }), { code: 'INVITATION_REACTIVATION_REQUIRED' });
  }
  const reactivated = store.updateInvitation({ actorSessionHash, id: issued.id, revision: 3, expiresAt, reactivate: true });
  assert.equal(reactivated.status, 'active');
  assert.equal(reactivated.revision, 4);
  assert.equal(reactivated.useCount, 1);
  assert.equal(reactivated.maxUses, 2);
  assert.equal(reactivated.remaining, 1);
  store.redeemInvitation(pending);
  const exhausted = store.listInvitations({ actorSessionHash }).invitations[0];
  assert.equal(exhausted.status, 'exhausted');
  assert.equal(exhausted.revision, 5);
  assert.equal(exhausted.remaining, 0);
  const values = { actorSessionHash, id: issued.id, revision: 5, expiresAt, reactivate: true };
  assert.throws(() => store.updateInvitation(values), { code: 'INVITATION_EXHAUSTED' });
  assert.throws(() => store.revokeInvitation(values), { code: 'INVITATION_EXHAUSTED' });
  assert.throws(() => store.updateInvitation({ ...values, id: bootstrap.id }), { code: 'INVITATION_NOT_FOUND' });
  assert.throws(() => store.revokeInvitation({ ...values, id: bootstrap.id }), { code: 'INVITATION_NOT_FOUND' });
  assert.throws(() => store.db.prepare('UPDATE invitations SET expires_at = consumed_at WHERE id = ?').run(issued.id), /CHECK constraint failed/);
});

test('revocation atomically invalidates outstanding invitation proofs without changing accounts or signup counts', context => {
  const store = memoryStore(context);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const actorSessionHash = admin.sessionHash;
  const issued = store.issueInvitation({ tokenHash: digest('revocable'), actorSessionHash, maxUses: 3 });
  store.redeemInvitation(registration(store, 'revocable', 'first@example.com'));
  const pending = registration(store, 'revocable', 'pending@example.com');
  invitation(store, 'unrelated', actorSessionHash);
  const other = registration(store, 'unrelated', 'other@example.com');
  const proofCount = hash => store.db.prepare('SELECT count(*) AS count FROM email_verifications WHERE token_hash = ?').get(hash).count;
  const accountDigest = () => digest(JSON.stringify(['users', 'sessions', 'user_data'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())));
  const before = accountDigest();
  const values = { actorSessionHash, id: issued.id, revision: 2 };
  store.db.exec("CREATE TRIGGER fail_revoke BEFORE DELETE ON email_verifications BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.revokeInvitation(values), /injected/);
  assert.equal(store.invitationAvailable(pending.inviteHash), true);
  assert.equal(store.listInvitations({ actorSessionHash }).invitations.find(row => row.id === issued.id).revision, 2);
  assert.equal(proofCount(pending.verificationHash), 1);
  store.db.exec('DROP TRIGGER fail_revoke');
  const revoked = store.revokeInvitation(values);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revision, 3);
  assert.equal(revoked.useCount, 1);
  assert.equal(revoked.remaining, 2);
  assert.equal(proofCount(pending.verificationHash), 0);
  assert.equal(proofCount(other.verificationHash), 1);
  assert.equal(accountDigest(), before);
  assert.equal(store.invitationAvailable(pending.inviteHash), false);
  assert.throws(() => store.redeemInvitation(pending), { code: 'INVALID_INVITATION' });
  assert.throws(() => store.issueEmailVerification({ ...pending, purpose: 'registration', userId: null, currentSessionHash: null }), { code: 'INVALID_INVITATION' });
  assert.throws(() => store.updateInvitation({ ...values, revision: 3, expiresAt: issued.expiresAt, reactivate: true }), { code: 'INVITATION_REVOKED' });
  assert.throws(() => store.revokeInvitation({ ...values, revision: 3 }), { code: 'INVITATION_REVOKED' });
  assert.equal(accountDigest(), before);
});

test('invitation usage limits reject invalid counts and keep bootstrap single-use', context => {
  const store = memoryStore(context);
  for (const maxUses of [0, -1, 1.5, 1001, '10', null, true, NaN, Infinity, 2]) {
    assert.throws(() => store.issueInvitation({ tokenHash: digest('invalid'), bootstrap: true, maxUses }), { code: 'INVALID_REQUEST' });
  }
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  for (const maxUses of [0, -1, 1.5, 1001, '10', null, true]) {
    assert.throws(() => store.issueInvitation({ tokenHash: digest('invalid'), actorSessionHash: admin.sessionHash, maxUses }), { code: 'INVALID_REQUEST' });
  }
  assert.equal(store.issueInvitation({ tokenHash: digest('upper-bound'), actorSessionHash: admin.sessionHash, maxUses: 1000 }).maxUses, 1000);
  assert.throws(() => store.db.prepare('UPDATE invitations SET max_uses = 2 WHERE is_admin = 1').run(), /CHECK constraint failed/);
  assert.throws(() => store.db.prepare('UPDATE invitations SET use_count = max_uses + 1').run(), /CHECK constraint failed/);
});

test('invitation usage migration preserves existing unused and consumed links across restarts', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-invite-migration-'));
  const filename = path.join(directory, 'focustube.db');
  const legacy = new Database(filename);
  legacy.exec(`CREATE TABLE invitations (
    id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
  )`);
  const createdAt = new Date(Date.now() - 60000).toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const insert = legacy.prepare('INSERT INTO invitations (token_hash, is_admin, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)');
  insert.run(digest('unused'), 0, createdAt, expiresAt, null);
  insert.run(digest('used'), 0, createdAt, expiresAt, new Date().toISOString());
  insert.run(digest('bootstrap'), 1, createdAt, expiresAt, null);
  legacy.close();
  const store = memoryStore(context, filename);
  const restarted = memoryStore(context, filename);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const database of [store, restarted]) {
    const rows = database.db.prepare('SELECT * FROM invitations ORDER BY id').all();
    assert.deepEqual(Array.from(rows, row => [row.max_uses, row.use_count]), [[1, 0], [1, 1], [1, 0]]);
    for (const row of rows) {
      assert.equal(row.created_at, createdAt);
      assert.equal(row.expires_at, expiresAt);
      assert.equal(row.revoked_at, null);
      assert.equal(row.revision, 1);
    }
    assert.equal(database.invitationAvailable(digest('unused')), true);
    assert.equal(database.invitationAvailable(digest('used')), false);
    assert.equal(database.invitationAvailable(digest('bootstrap')), true);
  }
});

test('lifecycle migration preserves reusable counters and expiry, and reopened revocation stays final', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-invite-lifecycle-'));
  const filename = path.join(directory, 'focustube.db');
  const legacy = new Database(filename);
  legacy.exec(`CREATE TABLE auth_workspace (id INTEGER PRIMARY KEY CHECK(id = 1), max_members INTEGER NOT NULL);
    INSERT INTO auth_workspace VALUES (1, 100);
    CREATE TABLE invitations (
    id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at > created_at),
    consumed_at TEXT CHECK(consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at))
  )`);
  const timestamp = Date.now();
  const createdAt = new Date(timestamp - 120000).toISOString();
  const expiresAt = new Date(timestamp + 86400000).toISOString();
  const consumedAt = new Date(timestamp - 60000).toISOString();
  const insert = legacy.prepare('INSERT INTO invitations (token_hash, max_uses, use_count, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(digest('legacy-partial'), 4, 2, createdAt, expiresAt, null);
  insert.run(digest('legacy-exhausted'), 3, 3, createdAt, expiresAt, consumedAt);
  const preserved = database => digest(JSON.stringify(database.prepare('SELECT id, token_hash, is_admin, max_uses, use_count, created_at, expires_at, consumed_at FROM invitations WHERE id <= 2 ORDER BY id').all()));
  const before = preserved(legacy);
  legacy.close();
  const store = memoryStore(context, filename);
  assert.equal(preserved(store.db), before);
  assert.equal(store.invitationAvailable(digest('legacy-partial')), true);
  assert.equal(store.invitationAvailable(digest('legacy-exhausted')), false);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const actorSessionHash = admin.sessionHash;
  const listed = store.listInvitations({ actorSessionHash }).invitations;
  assert.equal(listed.length, 2);
  const partial = listed.find(row => row.status === 'active');
  assert.equal(partial.revision, 1);
  assert.equal(partial.maxUses, 4);
  assert.equal(partial.useCount, 2);
  assert.equal(partial.expiresAt, expiresAt);
  const changedExpiry = new Date(timestamp + 5 * 86400000).toISOString();
  store.updateInvitation({ actorSessionHash, id: partial.id, revision: 1, expiresAt: changedExpiry });
  store.revokeInvitation({ actorSessionHash, id: partial.id, revision: 2 });
  for (const revision of [0, -1, 1.5, null]) {
    assert.throws(() => store.db.prepare('UPDATE invitations SET revision = ? WHERE id = ?').run(revision, partial.id), /constraint failed/);
  }
  store.db.close();
  const reopened = memoryStore(context, filename);
  const final = reopened.listInvitations({ actorSessionHash }).invitations.find(row => row.id === partial.id);
  assert.equal(final.status, 'revoked');
  assert.equal(final.revision, 3);
  assert.equal(final.maxUses, 4);
  assert.equal(final.useCount, 2);
  assert.equal(final.expiresAt, changedExpiry);
  assert.equal(reopened.invitationAvailable(digest('legacy-partial')), false);
  assert.equal(reopened.db.prepare('SELECT consumed_at FROM invitations WHERE id = 2').get().consumed_at, consumedAt);
  assert.throws(() => reopened.db.prepare('UPDATE invitations SET expires_at = consumed_at WHERE id = 2').run(), /CHECK constraint failed/);
  assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(reopened.db.pragma('foreign_key_check').length, 0);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('pruned invitations cannot reuse a stale admin target ID after reopening', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-invite-cursor-'));
  const filename = path.join(directory, 'focustube.db');
  const store = memoryStore(context, filename);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const actorSessionHash = admin.sessionHash;
  const pruned = invitation(store, 'pruned-link', actorSessionHash);
  store.db.prepare('UPDATE invitations SET created_at = ?, expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 32 * 86400000).toISOString(), new Date(Date.now() - 31 * 86400000).toISOString(), pruned.id);
  store.cleanup();
  assert.equal(store.listInvitations({ actorSessionHash }).invitations.length, 0);
  store.db.close();
  const reopened = memoryStore(context, filename);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fresh = invitation(reopened, 'fresh-link', actorSessionHash);
  assert.ok(fresh.id > pruned.id, 'A stale invitation ID must never identify a newly issued secret');
  const values = { actorSessionHash, id: pruned.id, revision: 1, expiresAt: fresh.expiresAt };
  assert.throws(() => reopened.updateInvitation(values), { code: 'INVITATION_NOT_FOUND' });
  assert.throws(() => reopened.revokeInvitation(values), { code: 'INVITATION_NOT_FOUND' });
  const final = reopened.listInvitations({ actorSessionHash }).invitations[0];
  assert.equal(final.id, fresh.id);
  assert.equal(final.revision, 1);
  assert.equal(final.status, 'active');
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
  return { store, request, origin, verify, emails, app: module.exports };
}

function bootstrapToken(store) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.issueInvitation({ tokenHash: digest(token), bootstrap: true });
  return token;
}

const joinBody = token => ({ inviteToken: token, email: 'Admin@Example.com', username: 'member_' + crypto.randomBytes(6).toString('hex'), displayName: 'Administrator', password: 'test-password-123', passwordConfirmation: 'test-password-123' });
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];

test('registration requires a valid username before spending an invitation', async context => {
  const { store, request, verify } = await httpFixture(context);
  const token = bootstrapToken(store);
  for (const username of [undefined, null, '', '  ', 'ab', 'has spaces', 'x'.repeat(33), 123]) {
    const response = await request('/api/auth/register', { method: 'POST', body: { ...joinBody(token), username } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_USERNAME');
  }
  assert.equal(store.invitationAvailable(digest(token)), true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  const response = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(token), username: '  Chosen.Name  ' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).user.username, 'chosen.name');
});

test('password reveal controls preserve values and reset to masked input', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const controls = [...html.matchAll(/<button[^>]*data-password-for="([^"]+)"[^>]*>/g)];
  assert.deepEqual(controls.map(match => match[1]), ['authPassword', 'authPasswordConfirmation']);
  for (const [markup, id] of controls) {
    assert.match(markup, /type="button"/);
    assert.ok(markup.includes(`aria-controls="${id}"`));
  }
  assert.match(css, /\.password-control \.password-toggle \{[^}]*width: 44px; height: 44px;/);
  assert.match(css, /\.password-control input \{[^}]*padding-inline-end: 52px;/);
  const input = { type: 'password', value: 'local-test-password' };
  const button = { dataset: { passwordFor: 'authPassword', passwordLabel: 'password' }, setAttribute(name, value) { this[name] = value; } };
  const context = vm.createContext({ $: () => input, icon: name => name, document: { querySelectorAll: () => [button] }, button });
  vm.runInContext(source.slice(source.indexOf('function setPasswordVisibility('), source.indexOf('function passwordFeedback(')), context);
  vm.runInContext('setPasswordVisibility(button, true);', context);
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'local-test-password');
  assert.equal(button['aria-label'], 'Hide password');
  assert.equal(button['aria-pressed'], 'true');
  assert.equal(button.innerHTML, 'EyeOff');
  vm.runInContext('resetAuthPasswordVisibility();', context);
  assert.equal(input.type, 'password');
  assert.equal(button['aria-label'], 'Show password');
  assert.equal(button['aria-pressed'], 'false');
  assert.match(source, /window\.addEventListener\('pagehide', \(\) => \{ resetAuthHandleCheck\(\); resetAuthPasswordVisibility\(\); \}\)/);
});

test('password feedback is local and synchronous for every input character and confirmation edit', () => {
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, { value: '', dataset: {}, classList: { toggle(_name, hidden) { this.hidden = hidden; } }, setCustomValidity(value) { this.validity = value; }, setAttribute(name, value) { this[name] = value; } });
    return fields.get(id);
  };
  const context = vm.createContext({ window: { zxcvbn: require('zxcvbn') }, authMode: 'register', $: field,
    setTimeout() { throw new Error('Password feedback must not wait for typing to stop'); }, fetch() { throw new Error('Passwords must stay local'); } });
  vm.runInContext(source.slice(source.indexOf('function passwordFeedback('), source.indexOf('function loadCaptcha(')), context);
  for (let length = 1; length <= 12; length++) {
    field('#authPassword').value = 'a'.repeat(length);
    vm.runInContext('syncAuthPasswordFeedback();', context);
    assert.match(field('#authPasswordLength').textContent, new RegExp(`Length: ${length}(?:/| )`));
    assert.equal(field('#authPasswordLength').dataset.state, length < 8 ? 'invalid' : 'valid');
    assert.equal(field('#authPasswordMeter').value, 0, 'Repeated characters must not look strong just because they are long');
  }
  field('#authPassword').value = 'wQ7!eR9$uT3@iP6#oY2%aS8';
  vm.runInContext('syncAuthPasswordFeedback();', context);
  assert.equal(field('#authPasswordStrength').textContent, 'Strength estimate: Strong');
  field('#authPasswordConfirmation').value = 'different';
  vm.runInContext('syncAuthPasswordFeedback();', context);
  assert.equal(field('#authPasswordMatch').textContent, 'Passwords do not match.');
  assert.equal(field('#authPasswordConfirmation').validity, 'Passwords do not match.');
  field('#authPasswordConfirmation').value = field('#authPassword').value;
  vm.runInContext('syncAuthPasswordFeedback();', context);
  assert.equal(field('#authPasswordMatch').textContent, 'Passwords match.');
  field('#authPassword').value += 'x';
  vm.runInContext('syncAuthPasswordFeedback();', context);
  assert.equal(field('#authPasswordMatch').dataset.state, 'invalid');
  context.authMode = 'login';
  vm.runInContext('syncAuthPasswordFeedback();', context);
  assert.equal(field('#authPasswordFeedback').classList.hidden, true);
  assert.equal(field('#authPasswordConfirmation').validity, '');
  assert.match(source, /addEventListener\('input', syncAuthPasswordFeedback\)/);
});

test('username feedback ignores stale responses, aborts edits, and recovers from failures', async () => {
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const input = { value: '', setCustomValidity(value) { this.validity = value; }, setAttribute(name, value) { this[name] = value; } };
  const status = { dataset: {}, textContent: '' };
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let clock = 0;
  const context = vm.createContext({
    authMode: 'register', window: { FocusTubeInvite: { has: () => true } }, AbortController,
    Date: { now: () => clock }, $: selector => selector === '#authHandle' ? input : status,
    api(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source.slice(source.indexOf('let authHandleVersion ='), source.indexOf('function setPasswordVisibility(')), context);
  const check = () => vm.runInContext('checkAuthHandle()', context);
  input.value = 'ab';
  assert.equal(await check(), false);
  assert.equal(requests.length, 0);
  assert.equal(status.dataset.state, 'invalid');
  input.value = ' padded ';
  assert.equal(await check(), false);
  assert.equal(requests.length, 0);
  assert.equal(status.dataset.state, 'invalid');
  input.value = 'first';
  const first = check();
  assert.equal(status.dataset.state, 'checking');
  assert.equal(requests[0].url, '/api/auth/username/check');
  assert.equal(requests[0].options.invitation, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), { username: 'first' });
  input.value = 'second';
  const second = check();
  assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve({ username: 'first', available: false });
  await first;
  assert.equal(status.dataset.state, 'checking');
  requests[1].resolve({ username: 'second', available: true });
  assert.equal(await second, true);
  assert.equal(status.dataset.state, 'available');
  assert.equal(input.validity, '');
  assert.equal(await check(), true);
  assert.equal(requests.length, 2, 'Submit reuses the current completed check');
  input.value = 'taken';
  const taken = check();
  requests.at(-1).resolve({ username: 'taken', available: false });
  assert.equal(await taken, false);
  assert.equal(status.dataset.state, 'taken');
  assert.match(input.validity, /already taken/);
  input.value = 'network';
  const failed = check();
  requests.at(-1).reject(new Error('Network unavailable'));
  assert.equal(await failed, false);
  assert.equal(status.dataset.state, 'error');
  const retry = check();
  requests.at(-1).resolve({ username: 'network', available: true });
  assert.equal(await retry, true);
  input.value = 'limited';
  const limited = check();
  requests.at(-1).reject(Object.assign(new Error('Limited'), { retryAfter: 30 }));
  assert.equal(await limited, false);
  const count = requests.length;
  input.value = 'another';
  assert.equal(await check(), false);
  assert.equal(requests.length, count);
  clock = 31000;
  const afterLimit = check();
  requests.at(-1).resolve({ username: 'another', available: true });
  assert.equal(await afterLimit, true);
  input.value = 'departing';
  const departed = check();
  context.authMode = 'login';
  vm.runInContext('resetAuthHandleCheck();', context);
  assert.equal(requests.at(-1).options.signal.aborted, true);
  requests.at(-1).resolve({ username: 'departing', available: false });
  await departed;
  assert.equal(status.dataset.state, 'idle');
  assert.equal(timers.size, 0);
});

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
  const invitationResult = await created.json();
  assert.equal(invitationResult.maxUses, 1);
  assert.equal(invitationResult.useCount, 0);
  const memberInvite = invitationResult.inviteUrl.split('#join=')[1];
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

test('admin HTTP invitations validate reusable limits and stop verified signups at capacity', async context => {
  const { store, request, verify } = await httpFixture(context);
  assert.equal((await request('/api/invites', { method: 'POST', body: { maxUses: 10 } })).status, 401);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  assert.equal(admin.status, 201);
  const headers = { Cookie: cookieOf(admin) };
  for (const maxUses of [0, -1, 1.5, 1001, '10', null, true, {}, []]) {
    const response = await request('/api/invites', { method: 'POST', headers, body: { maxUses } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_INVITATION_LIMIT');
  }
  for (const extra of [{ isAdmin: true }, { useCount: 0 }]) {
    assert.equal((await request('/api/invites', { method: 'POST', headers, body: { maxUses: 2, ...extra } })).status, 400);
  }
  const created = await request('/api/invites', { method: 'POST', headers, body: { maxUses: 2 } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const link = await created.json();
  assert.equal(link.maxUses, 2);
  assert.equal(link.useCount, 0);
  const token = new URL(link.inviteUrl).hash.slice('#join='.length);
  const bodies = [];
  for (const email of ['first@example.com', 'second@example.com', 'third@example.com']) bodies.push(await verify({ ...joinBody(token), email }));
  for (const body of bodies.slice(0, 2)) {
    const joined = await request('/api/auth/register', { method: 'POST', body });
    assert.equal(joined.status, 201);
    assert.equal((await joined.json()).user.isAdmin, false);
    assert.equal((await request('/api/invites', { method: 'POST', headers: { Cookie: cookieOf(joined) }, body: { maxUses: 20 } })).status, 403);
  }
  const exhausted = await request('/api/auth/register', { method: 'POST', body: bodies[2] });
  assert.equal(exhausted.status, 400);
  assert.equal((await exhausted.json()).code, 'INVALID_INVITATION');
  assert.equal(store.db.prepare('SELECT use_count FROM invitations WHERE token_hash = ?').get(digest(token)).use_count, 2);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 3);
  assert.equal((await request('/api/auth/verification/request', { method: 'POST', body: { email: 'fourth@example.com', inviteToken: token } })).status, 400);
});

test('admin HTTP invitation lifecycle exposes only safe metadata and invalidates revoked signup proofs', async context => {
  const { store, request, verify, origin } = await httpFixture(context);
  assert.equal((await request('/api/invites')).status, 401);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  assert.equal(admin.status, 201);
  const headers = { Cookie: cookieOf(admin) };
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const created = await request('/api/invites', { method: 'POST', headers, body: { maxUses: 3, expiresAt } });
  assert.equal(created.status, 201);
  const issued = await created.json();
  const token = new URL(issued.inviteUrl).hash.slice('#join='.length);
  assert.equal(new URL(issued.inviteUrl).origin, origin);
  assert.equal(issued.expiresAt, expiresAt);
  assert.equal(issued.revision, 1);
  assert.equal(issued.remaining, 3);
  assert.equal(issued.status, 'active');
  const metadataKeys = ['id', 'createdAt', 'expiresAt', 'maxUses', 'useCount', 'remaining', 'status', 'revision'].sort();
  assert.deepEqual(Object.keys(issued).sort(), [...metadataKeys, 'inviteUrl'].sort());
  const safe = metadata => {
    assert.deepEqual(Object.keys(metadata).sort(), metadataKeys);
    const text = JSON.stringify(metadata);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(digest(token)), false);
  };
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM invitations').all()).includes(token), false);
  const list = await request('/api/invites', { headers });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const listed = await list.json();
  assert.equal(listed.invitations.length, 1, 'Bootstrap invitations must not be listed');
  assert.equal(listed.nextCursor, null);
  safe(listed.invitations[0]);
  const endpoint = `/api/invites/${issued.id}`;
  const shortened = await request(endpoint, { method: 'PATCH', headers,
    body: { expiresAt: new Date(Date.now() + 86400000).toISOString(), revision: 1 } });
  assert.equal(shortened.status, 200);
  assert.equal(shortened.headers.get('cache-control'), 'no-store');
  const updated = await shortened.json();
  safe(updated);
  assert.equal(updated.revision, 2);
  for (const method of ['PATCH', 'DELETE']) {
    const stale = await request(endpoint, { method, headers, body: { revision: 1, ...(method === 'PATCH' ? { expiresAt } : {}) } });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'INVITATION_CHANGED');
  }
  const member = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(token), email: 'first@example.com' }) });
  assert.equal(member.status, 201);
  const pending = await verify({ ...joinBody(token), email: 'pending@example.com' });
  store.db.prepare('UPDATE invitations SET created_at = ?, expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 120000).toISOString(), new Date(Date.now() - 60000).toISOString(), issued.id);
  assert.equal((await (await request('/api/invites', { headers })).json()).invitations[0].status, 'expired');
  const confirmation = await request(endpoint, { method: 'PATCH', headers, body: { expiresAt, revision: 3 } });
  assert.equal(confirmation.status, 409);
  assert.equal((await confirmation.json()).code, 'INVITATION_REACTIVATION_REQUIRED');
  const reactivated = await request(endpoint, { method: 'PATCH', headers, body: { expiresAt, revision: 3, reactivate: true } });
  assert.equal(reactivated.status, 200);
  const active = await reactivated.json();
  safe(active);
  assert.equal(active.status, 'active');
  assert.equal(active.revision, 4);
  assert.equal(active.maxUses, 3);
  assert.equal(active.useCount, 1);
  assert.equal(active.remaining, 2);
  const revoked = await request(endpoint, { method: 'DELETE', headers, body: { revision: 4 } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.headers.get('cache-control'), 'no-store');
  const result = await revoked.json();
  safe(result);
  assert.equal(result.status, 'revoked');
  assert.equal(result.revision, 5);
  assert.equal(result.useCount, 1);
  assert.equal(result.remaining, 2);
  for (const method of ['PATCH', 'DELETE']) {
    const rejected = await request(endpoint, { method, headers, body: { revision: 5, ...(method === 'PATCH' ? { expiresAt, reactivate: true } : {}) } });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'INVITATION_REVOKED');
  }
  for (const [path, body] of [
    ['/api/auth/register', pending],
    ['/api/auth/username/check', { username: 'another.name', inviteToken: token }],
    ['/api/auth/verification/request', { email: 'another@example.com', inviteToken: token }],
  ]) {
    const rejected = await request(path, { method: 'POST', body });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'INVALID_INVITATION');
  }
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM email_verifications WHERE token_hash = ?').get(digest(pending.verificationToken)).count, 0);
  assert.equal(store.getUserByEmail(pending.email), undefined);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookieOf(member) } })).status, 200);
});

test('admin invitation listing uses a bounded descending ID cursor without repeating concurrent inserts', async context => {
  const { store, request, verify } = await httpFixture(context);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const headers = { Cookie: cookieOf(admin) };
  const actorSessionHash = digest(headers.Cookie.split('=')[1]);
  const ids = [];
  for (let index = 0; index < 53; index++) ids.push(invitation(store, `page-${index}`, actorSessionHash).id);
  const first = await request('/api/invites', { headers });
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.equal(page.invitations.length, 50);
  assert.equal(page.nextCursor, page.invitations.at(-1).id);
  const inserted = invitation(store, 'concurrent-new-invite', actorSessionHash);
  const second = await request(`/api/invites?before=${page.nextCursor}`, { headers });
  assert.equal(second.status, 200);
  const last = await second.json();
  assert.equal(last.invitations.length, 3);
  assert.equal(last.nextCursor, null);
  const observed = [...page.invitations, ...last.invitations].map(row => row.id);
  assert.deepEqual(observed, ids.reverse());
  assert.equal(observed.includes(inserted.id), false);
  const limited = await (await request('/api/invites?limit=1', { headers })).json();
  assert.equal(limited.invitations.length, 1);
  assert.equal(limited.invitations[0].id, inserted.id);
  for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=01', 'before=0', 'before=-1', 'before=1e3',
    'before=9007199254740992', 'before=abc', 'before=1&before=2', 'before=', 'unknown=1']) {
    const response = await request(`/api/invites?${query}`, { headers });
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
  }
});

test('invitation HTTP validation rejects invalid expiry, revisions, IDs and attempts to add signup slots', async context => {
  const { store, request, verify } = await httpFixture(context);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const headers = { Cookie: cookieOf(admin) };
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  for (const expiry of [null, '', 123, 'never', expiresAt.replace('Z', '+00:00'),
    new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 366 * 86400000).toISOString()]) {
    const response = await request('/api/invites', { method: 'POST', headers, body: { expiresAt: expiry } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_INVITATION_EXPIRY');
  }
  const created = await request('/api/invites', { method: 'POST', headers, body: {} });
  assert.equal(created.status, 201);
  const issued = await created.json();
  assert.equal(Date.parse(issued.expiresAt) - Date.parse(issued.createdAt), 7 * 86400000);
  const endpoint = `/api/invites/${issued.id}`;
  for (const body of [{ expiresAt }, { expiresAt, revision: '1' }, { expiresAt, revision: 0 },
    { expiresAt, revision: 1.5 }, { expiresAt, revision: 1, maxUses: 10 }, { expiresAt, revision: 1, reactivate: 'true' }]) {
    const response = await request(endpoint, { method: 'PATCH', headers, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
  }
  const missingExpiry = await request(endpoint, { method: 'PATCH', headers, body: { revision: 1 } });
  assert.equal(missingExpiry.status, 400);
  assert.equal((await missingExpiry.json()).code, 'INVALID_INVITATION_EXPIRY');
  for (const id of ['01', '1e2', '9007199254740992']) {
    const invalidId = await request(`/api/invites/${id}`, { method: 'DELETE', headers, body: { revision: 1 } });
    assert.equal(invalidId.status, 400);
    assert.equal((await invalidId.json()).code, 'INVALID_REQUEST');
  }
  const metadata = (await (await request('/api/invites', { headers })).json()).invitations[0];
  assert.equal(metadata.revision, 1);
  assert.equal(metadata.maxUses, 1);
  assert.equal(metadata.useCount, 0);
  assert.equal(metadata.expiresAt, issued.expiresAt);
});

test('invite management remains administrator-only with exact origins, host validation and bounded JSON', async context => {
  const { store, request, verify, origin } = await httpFixture(context);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const headers = { Cookie: cookieOf(admin) };
  const actorSessionHash = digest(headers.Cookie.split('=')[1]);
  const issued = invitation(store, 'security-member-invite', actorSessionHash);
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const endpoint = `/api/invites/${issued.id}`;
  for (const isGuest of [false, true]) {
    const user = store.createUser({ username: isGuest ? null : 'ordinary-member', isGuest });
    const token = crypto.randomBytes(32).toString('base64url');
    store.createSession(digest(token), user.id, expiresAt);
    for (const [method, path, body] of [['GET', '/api/invites', undefined], ['POST', '/api/invites', {}],
      ['PATCH', endpoint, { revision: 1, expiresAt }], ['DELETE', endpoint, { revision: 1 }]]) {
      assert.equal((await request(path, { method, body })).status, 401);
      assert.equal((await request(path, { method, body, headers: { Cookie: `ft_session=${token}` } })).status, 403);
    }
  }
  for (const method of ['PATCH', 'DELETE']) {
    const body = { revision: 1, ...(method === 'PATCH' ? { expiresAt } : {}) };
    for (const Origin of ['', 'null', 'https://untrusted.example', origin.replace('http:', 'https:'), `${origin}/`]) {
      assert.equal((await request(endpoint, { method, body, headers: { ...headers, Origin } })).status, 403);
    }
    assert.equal((await fetch(origin + endpoint, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
    const text = await request(endpoint, { method, headers: { ...headers, 'Content-Type': 'text/plain' }, body });
    assert.equal(text.status, 415);
    assert.equal((await text.json()).code, 'UNSUPPORTED_MEDIA_TYPE');
    const malformed = await fetch(origin + endpoint, { method, headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await request(endpoint, { method, headers, body: { ...body, extra: 'x'.repeat(9000) } })).status, 413);
    const missing = await request('/api/invites/999999', { method, headers, body });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'INVITATION_NOT_FOUND');
    const bootstrapId = store.db.prepare('SELECT id FROM invitations WHERE is_admin = 1').get().id;
    const bootstrap = await request(`/api/invites/${bootstrapId}`, { method, headers, body });
    assert.equal(bootstrap.status, 404);
    assert.equal((await bootstrap.json()).code, 'INVITATION_NOT_FOUND');
  }
  const blockedHost = await new Promise((resolve, reject) => {
    const outgoing = http.request(origin + endpoint, { method: 'PATCH', headers: { ...headers, Host: 'untrusted.example',
      Origin: origin, 'Content-Type': 'application/json' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ expiresAt, revision: 1 }));
  });
  assert.equal(blockedHost.status, 400);
  assert.equal(blockedHost.body, 'Invalid Host header.');
  assert.equal(store.listInvitations({ actorSessionHash }).invitations[0].revision, 1);
});

test('invite transactions reject stale admin roles and the exact disabled, expired or revoked session after middleware', async context => {
  const { store, request, verify } = await httpFixture(context);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const user = (await admin.json()).user;
  const headers = { Cookie: cookieOf(admin) };
  const actorSessionHash = digest(headers.Cookie.split('=')[1]);
  const issued = invitation(store, 'stale-admin-invite', actorSessionHash);
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  store.createSession(digest('another-admin-session'), user.id, expiresAt);
  const count = () => store.db.prepare('SELECT count(*) AS count FROM invitations').get().count;
  const before = count();
  for (const [invalidate, status, code] of [
    [() => store.db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(user.id), 403, 'FORBIDDEN'],
    [() => store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE id = ?").run(user.id), 401, 'UNAUTHENTICATED'],
    [() => store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(actorSessionHash), 401, 'UNAUTHENTICATED'],
    [() => store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1000).toISOString(), actorSessionHash), 401, 'UNAUTHENTICATED'],
  ]) {
    for (const [method, path, operation, body] of [
      ['GET', '/api/invites', 'listInvitations', undefined],
      ['POST', '/api/invites', 'issueInvitation', {}],
      ['PATCH', `/api/invites/${issued.id}`, 'updateInvitation', { revision: 1, expiresAt }],
      ['DELETE', `/api/invites/${issued.id}`, 'revokeInvitation', { revision: 1 }],
    ]) {
      const original = store[operation];
      let invoked = false;
      store[operation] = values => {
        invoked = true;
        invalidate();
        return original(values);
      };
      try {
        const response = await request(path, { method, body, headers });
        assert.equal(response.status, status, `${operation}: ${code}`);
        assert.equal((await response.json()).code, code);
        assert.equal(invoked, true, 'Exercise the transaction after middleware accepted the previous account snapshot');
        assert.equal(count(), before);
      } finally {
        store[operation] = original;
        store.db.prepare("UPDATE users SET is_admin = 1, account_state = 'active' WHERE id = ?").run(user.id);
        store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(actorSessionHash);
        store.createSession(actorSessionHash, user.id, expiresAt);
      }
    }
  }
  const final = store.listInvitations({ actorSessionHash }).invitations[0];
  assert.equal(final.revision, 1);
  assert.equal(final.status, 'active');
  assert.equal(store.getSessionUser(digest('another-admin-session')).id, user.id);
});

test('POST, PATCH and DELETE invitations share the durable issuer and source mutation budgets', async context => {
  const { store, request, verify } = await httpFixture(context);
  const admin = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(bootstrapToken(store))) });
  const headers = { Cookie: cookieOf(admin) };
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  for (let attempt = 0; attempt < 20; attempt++) {
    const method = attempt % 2 ? 'PATCH' : 'DELETE';
    const response = await request('/api/invites/999999', { method, headers, body: { revision: 1, ...(method === 'PATCH' ? { expiresAt } : {}) } });
    assert.equal(response.status, 404);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const limited = await request(method === 'POST' ? '/api/invites' : '/api/invites/999999', { method, headers, body: {} });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }
  assert.equal((await request('/api/invites', { headers })).status, 200, 'Mutation budgets must not prevent refreshing stale metadata');
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM invitations WHERE is_admin = 0').get().count, 0);
  const anonymous = await httpFixture(context);
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await anonymous.request('/api/invites/1', { method: attempt % 2 ? 'PATCH' : 'DELETE', body: { revision: 1 } });
    assert.equal(response.status, 401);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const limited = await anonymous.request('/api/invites', { method, body: {} });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }
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

test('required usernames are unique case-insensitively and support email or username login', async context => {
  const { store, request, verify } = await httpFixture(context);
  const response = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(bootstrapToken(store)), username: ' New.Member ' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).user.username, 'new.member');
  for (const identifier of ['NEW.MEMBER', 'admin@example.com']) {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier, password: 'test-password-123' } })).status, 200);
  }
  const admin = store.db.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash;
  invitation(store, 'username-conflict', admin);
  assert.throws(() => store.redeemInvitation({ ...registration(store, 'username-conflict', 'another@example.com'), username: 'NEW.MEMBER' }), { code: 'USERNAME_TAKEN' });
  assert.equal(store.invitationAvailable(digest('username-conflict')), true);
});

test('username availability requires an invitation or member and exposes no account details', async context => {
  const { store, request, verify } = await httpFixture(context);
  const check = (body, headers) => request('/api/auth/username/check', { method: 'POST', body, headers });
  assert.equal((await check({ username: 'chosen' })).status, 400);
  const token = bootstrapToken(store);
  const free = await check({ inviteToken: token, username: ' Chosen.Name ' });
  assert.equal(free.status, 200);
  assert.equal(free.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await free.json(), { username: 'chosen.name', available: true });
  assert.equal(store.invitationAvailable(digest(token)), true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM email_verifications').get().count, 0);
  for (const username of ['', 'ab', 'x'.repeat(33), 'two words', 123, null]) {
    const response = await check({ inviteToken: token, username });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_USERNAME');
  }
  assert.equal((await check({ inviteToken: token, username: 'chosen', email: 'private@example.com' })).status, 400);
  assert.equal((await check({ inviteToken: token, username: 'chosen' }, { Origin: 'https://untrusted.example' })).status, 403);
  const registered = await request('/api/auth/register', { method: 'POST', body: await verify({ ...joinBody(token), username: 'chosen.name' }) });
  assert.equal(registered.status, 201);
  const cookie = cookieOf(registered);
  assert.deepEqual(await (await check({ username: 'CHOSEN.NAME' }, { Cookie: cookie })).json(), { username: 'chosen.name', available: true });
  assert.equal((await check({ inviteToken: token, username: 'other' })).status, 400, 'Spent invitations cannot enumerate usernames');
  const issued = await request('/api/invites', { method: 'POST', headers: { Cookie: cookie }, body: { maxUses: 2 } });
  const inviteToken = new URL((await issued.json()).inviteUrl).hash.slice('#join='.length);
  const unavailable = await check({ inviteToken, username: 'CHOSEN.NAME' });
  assert.deepEqual(await unavailable.json(), { username: 'chosen.name', available: false });
  store.createUser({ username: 'disabled.name', passwordHash: 'hash', salt: 'salt' });
  store.db.prepare("UPDATE users SET account_state = 'disabled' WHERE username = ?").run('disabled.name');
  assert.equal((await (await check({ inviteToken, username: 'disabled.name' })).json()).available, false);
  const first = await verify({ ...joinBody(inviteToken), email: 'first@example.com', username: 'shared.name' });
  const second = await verify({ ...joinBody(inviteToken), email: 'second@example.com', username: 'SHARED.NAME' });
  assert.equal((await (await check({ inviteToken, username: 'shared.name' })).json()).available, true);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: first })).status, 201);
  const conflict = await request('/api/auth/register', { method: 'POST', body: second });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'USERNAME_TAKEN');
  assert.equal(store.db.prepare('SELECT use_count FROM invitations WHERE token_hash = ?').get(digest(inviteToken)).use_count, 1);
  assert.equal(store.db.prepare('SELECT consumed_at FROM email_verifications WHERE token_hash = ?').get(digest(second.verificationToken)).consumed_at, null);
});

test('username checks have a separate durable limit without exhausting signup attempts', async context => {
  const { store, request, verify } = await httpFixture(context);
  const inviteToken = bootstrapToken(store);
  for (let attempt = 0; attempt < 180; attempt++) {
    const response = await request('/api/auth/username/check', { method: 'POST', body: { inviteToken, username: 'available.name' } });
    assert.equal(response.status, 200);
  }
  const limited = await request('/api/auth/username/check', { method: 'POST', body: { inviteToken, username: 'available.name' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const registered = await request('/api/auth/register', { method: 'POST', body: await verify(joinBody(inviteToken)) });
  assert.equal(registered.status, 201);
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

test('legacy members without usernames can add one and profile updates have a persistent account budget', async context => {
  const { store, request, verify } = await httpFixture(context);
  const body = await verify(joinBody(bootstrapToken(store)));
  const registered = await request('/api/auth/register', { method: 'POST', body });
  const headers = { Cookie: cookieOf(registered) };
  const user = (await registered.json()).user;
  store.db.prepare('UPDATE users SET username = NULL WHERE id = ?').run(user.id);
  assert.equal((await (await request('/api/auth/me', { headers })).json()).user.username, null);
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

async function raceRedemptions(directory, values, mutations = []) {
  const operations = [...values.map(value => ({ action: 'redeemInvitation', values: value })), ...mutations];
  const workers = operations.map(operation => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    process.env.FOCUSTUBE_DATA_DIR = workerData.directory;
    const store = require(workerData.root + '/db');
    parentPort.once('message', () => {
      try { store[workerData.action](workerData.values); parentPort.postMessage('ok'); }
      catch (error) { parentPort.postMessage(error.code); }
      finally { store.db.close(); parentPort.close(); }
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { directory, root, ...operation } }));
  const exits = workers.map(worker => new Promise(resolve => worker.once('exit', resolve)));
  try {
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
    const results = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
    for (const worker of workers) worker.postMessage('redeem');
    const [outcomes, exitCodes] = await Promise.all([Promise.all(results), Promise.all(exits)]);
    assert.ok(exitCodes.every(code => code === 0), 'Every SQLite worker must exit normally before fixture cleanup');
    return outcomes;
  } finally { await Promise.all(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate())); }
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

test('reusable invitation races enforce both remaining uses and the workspace member limit', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-shared-invite-race-'));
  const store = memoryStore(context, path.join(directory, 'focustube.db'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  store.issueInvitation({ tokenHash: digest('shared-race'), actorSessionHash: admin.sessionHash, maxUses: 3 });
  store.redeemInvitation(registration(store, 'shared-race', 'first@example.com'));
  const candidates = ['second@example.com', 'third@example.com', 'fourth@example.com'].map(email => registration(store, 'shared-race', email));
  const results = await raceRedemptions(directory, candidates);
  assert.equal(results.filter(result => result === 'ok').length, 2);
  assert.equal(results.filter(result => result === 'INVALID_INVITATION').length, 1);
  assert.equal(store.db.prepare('SELECT use_count FROM invitations WHERE token_hash = ?').get(digest('shared-race')).use_count, 3);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 4);
  store.setMemberLimit(5);
  store.issueInvitation({ tokenHash: digest('shared-capacity'), actorSessionHash: admin.sessionHash, maxUses: 20 });
  const slots = await raceRedemptions(directory, ['last-one@example.com', 'last-two@example.com'].map(email => registration(store, 'shared-capacity', email)));
  assert.equal(slots.filter(result => result === 'ok').length, 1);
  assert.equal(slots.filter(result => result === 'REGISTRATION_CONFLICT').length, 1);
  assert.equal(store.db.prepare('SELECT use_count FROM invitations WHERE token_hash = ?').get(digest('shared-capacity')).use_count, 1);
  assert.equal(store.invitationAvailable(digest('shared-capacity')), true);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM users').get().count, 5);
});

test('independent SQLite workers serialize last-use signup against revocation, shortening and extension', async context => {
  for (const action of ['revoke', 'shorten', 'extend']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `focustube-invite-${action}-race-`));
    const store = memoryStore(context, path.join(directory, 'focustube.db'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    invitation(store);
    const admin = registration(store, 'invite', 'admin@example.com');
    store.redeemInvitation(admin);
    const actorSessionHash = admin.sessionHash;
    const issued = invitation(store, 'last-use', actorSessionHash);
    const candidate = registration(store, 'last-use', 'last@example.com');
    const expiresAt = new Date(Date.now() + (action === 'shorten' ? 1 : 30) * 86400000).toISOString();
    const results = await raceRedemptions(directory, [candidate], [{
      action: action === 'revoke' ? 'revokeInvitation' : 'updateInvitation',
      values: { actorSessionHash, id: issued.id, revision: 1, ...(action === 'revoke' ? {} : { expiresAt }) },
    }]);
    assert.ok(['ok', 'INVITATION_CHANGED'].includes(results[1]));
    const final = store.listInvitations({ actorSessionHash }).invitations[0];
    const proof = store.db.prepare('SELECT consumed_at FROM email_verifications WHERE token_hash = ?').get(candidate.verificationHash);
    if (action === 'revoke' && results[1] === 'ok') {
      assert.equal(results[0], 'INVALID_INVITATION');
      assert.equal(final.status, 'revoked');
      assert.equal(final.useCount, 0);
      assert.equal(final.revision, 2);
      assert.equal(proof, undefined);
      assert.equal(store.getUserByEmail(candidate.email), undefined);
      assert.equal(store.getSessionUser(candidate.sessionHash), undefined);
    } else {
      assert.equal(results[0], 'ok');
      assert.equal(final.status, 'exhausted');
      assert.equal(final.useCount, 1);
      assert.equal(final.remaining, 0);
      assert.equal(final.revision, results[1] === 'ok' ? 3 : 2);
      assert.equal(final.expiresAt, results[1] === 'ok' ? expiresAt : issued.expiresAt);
      assert.ok(proof.consumed_at);
      assert.ok(store.getUserByEmail(candidate.email));
      assert.ok(store.getSessionUser(candidate.sessionHash));
    }
    for (const table of ['users', 'user_data', 'sessions']) {
      assert.equal(store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, results[0] === 'ok' ? 2 : 1, table);
    }
    assert.equal(store.invitationAvailable(candidate.inviteHash), false);
    assert.throws(() => store.redeemInvitation(registration(store, 'last-use', 'extra@example.com')), { code: 'INVALID_INVITATION' });
    assert.equal(store.db.inTransaction, false);
  }
});

test('last workspace slot races with invite mutations preserve losing proofs, capacity and account-session atomicity', async context => {
  for (const action of ['revoke', 'shorten', 'extend']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `focustube-capacity-${action}-race-`));
    const store = memoryStore(context, path.join(directory, 'focustube.db'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    invitation(store);
    const admin = registration(store, 'invite', 'admin@example.com');
    store.redeemInvitation(admin);
    const actorSessionHash = admin.sessionHash;
    store.setMemberLimit(2);
    const issued = store.issueInvitation({ actorSessionHash, tokenHash: digest('capacity-race'), maxUses: 3 });
    const candidates = ['one@example.com', 'two@example.com'].map(email => registration(store, 'capacity-race', email));
    const results = await raceRedemptions(directory, candidates, [{
      action: action === 'revoke' ? 'revokeInvitation' : 'updateInvitation',
      values: { actorSessionHash, id: issued.id, revision: 1,
        ...(action === 'revoke' ? {} : { expiresAt: new Date(Date.now() + (action === 'shorten' ? 1 : 30) * 86400000).toISOString() }) },
    }]);
    assert.ok(['ok', 'INVITATION_CHANGED'].includes(results[2]));
    const signups = results.slice(0, 2);
    const admitted = signups.filter(result => result === 'ok').length;
    const revoked = action === 'revoke' && results[2] === 'ok';
    assert.equal(admitted, revoked ? 0 : 1);
    const final = store.listInvitations({ actorSessionHash }).invitations[0];
    assert.equal(final.status, revoked ? 'revoked' : 'active');
    assert.equal(final.maxUses, 3);
    assert.equal(final.useCount, admitted);
    assert.equal(final.revision, 1 + admitted + Number(results[2] === 'ok'));
    assert.equal(signups.filter(result => result === (revoked ? 'INVALID_INVITATION' : 'REGISTRATION_CONFLICT')).length, revoked ? 2 : 1);
    for (const table of ['users', 'user_data', 'sessions']) {
      assert.equal(store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1 + admitted, table);
    }
    for (const [index, candidate] of candidates.entries()) {
      const succeeded = signups[index] === 'ok';
      const proof = store.db.prepare('SELECT consumed_at FROM email_verifications WHERE token_hash = ?').get(candidate.verificationHash);
      if (revoked) assert.equal(proof, undefined);
      else assert.equal(!!proof.consumed_at, succeeded);
      assert.equal(!!store.getUserByEmail(candidate.email), succeeded);
      assert.equal(!!store.getSessionUser(candidate.sessionHash), succeeded);
    }
    if (!revoked) {
      store.setMemberLimit(3);
      const retry = candidates[signups.indexOf('REGISTRATION_CONFLICT')];
      assert.equal(store.redeemInvitation(retry).user.email_normalized, retry.email);
      assert.equal(store.listInvitations({ actorSessionHash }).invitations[0].useCount, 2);
    }
    assert.equal(store.db.pragma('foreign_key_check').length, 0);
  }
});

test('independent admin edit and revoke races reject stale revisions without resetting signup counts', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-admin-invite-race-'));
  const store = memoryStore(context, path.join(directory, 'focustube.db'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  const actorSessionHash = admin.sessionHash;
  for (const action of ['updateInvitation', 'revokeInvitation']) {
    const issued = store.issueInvitation({ actorSessionHash, tokenHash: digest(action), maxUses: 3 });
    store.redeemInvitation(registration(store, action, `${action.toLowerCase()}@example.com`));
    const firstExpiry = new Date(Date.now() + 86400000).toISOString();
    const secondExpiry = new Date(Date.now() + 30 * 86400000).toISOString();
    const values = { actorSessionHash, id: issued.id, revision: 2 };
    const results = await raceRedemptions(directory, [], [
      { action: 'updateInvitation', values: { ...values, expiresAt: firstExpiry } },
      { action, values: { ...values, ...(action === 'updateInvitation' ? { expiresAt: secondExpiry } : {}) } },
    ]);
    assert.deepEqual([...results].sort(), ['INVITATION_CHANGED', 'ok']);
    const final = store.listInvitations({ actorSessionHash }).invitations.find(row => row.id === issued.id);
    assert.equal(final.revision, 3);
    assert.equal(final.useCount, 1);
    assert.equal(final.maxUses, 3);
    assert.equal(final.remaining, 2);
    assert.equal(final.status, action === 'revokeInvitation' && results[1] === 'ok' ? 'revoked' : 'active');
    assert.equal(final.expiresAt, results[0] === 'ok' ? firstExpiry : action === 'updateInvitation' ? secondExpiry : issued.expiresAt);
  }
});

test('reusable invitations retain usage after guest conversion and reopening, and still expire', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focustube-shared-invite-state-'));
  const filename = path.join(directory, 'focustube.db');
  const store = memoryStore(context, filename);
  invitation(store);
  const admin = registration(store, 'invite', 'admin@example.com');
  store.redeemInvitation(admin);
  store.issueInvitation({ tokenHash: digest('shared-state'), actorSessionHash: admin.sessionHash, maxUses: 3 });
  const guest = store.createUser({ isGuest: true });
  const guestSessionHash = digest('shared-guest-session');
  store.createSession(guestSessionHash, guest.id, new Date(Date.now() + 86400000).toISOString());
  store.saveUserData(guest.id, { courses: {}, stats: {}, settings: {}, workspace: { tasks: { saved: { title: 'Keep my task' } } } }, 0);
  const conversion = registration(store, 'shared-state', 'guest@example.com', { guestSessionHash });
  assert.equal(store.redeemInvitation(conversion).user.id, guest.id);
  assert.equal(store.getSessionUser(guestSessionHash), undefined);
  assert.equal(store.getUserData(guest.id).workspace.tasks.saved.title, 'Keep my task');
  const reopened = memoryStore(context, filename);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const row = reopened.db.prepare('SELECT max_uses, use_count, consumed_at FROM invitations WHERE token_hash = ?').get(digest('shared-state'));
  assert.deepEqual(row, { max_uses: 3, use_count: 1, consumed_at: null });
  assert.equal(reopened.invitationAvailable(digest('shared-state')), true);
  const candidate = registration(reopened, 'shared-state', 'late@example.com');
  reopened.db.prepare('UPDATE invitations SET created_at = ?, expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() - 60000).toISOString(), new Date(Date.now() - 1000).toISOString(), candidate.inviteHash);
  assert.equal(reopened.invitationAvailable(candidate.inviteHash), false);
  assert.throws(() => reopened.redeemInvitation(candidate), { code: 'INVALID_INVITATION' });
  assert.equal(reopened.db.prepare('SELECT use_count FROM invitations WHERE token_hash = ?').get(candidate.inviteHash).use_count, 1);
  assert.equal(reopened.getUserByEmail(candidate.email), undefined);
});

function invitationUiHarness({ autoList = true, active = true } = {}) {
  const elements = new Map();
  const makeNode = (tag = 'div') => {
    const classes = new Set();
    const listeners = new Map();
    const node = { tagName: tag.toUpperCase(), value: '', textContent: '', disabled: false, checked: false, dataset: {}, attributes: {}, children: [],
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle(name, enabled = !classes.has(name)) { if (enabled) classes.add(name); else classes.delete(name); } },
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
      setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') elements.set(value, this); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      removeAttribute(name) { delete this.attributes[name]; },
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { return !this.validationMessage && this.valid !== false; },
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
      async fire(name, event = {}) { for (const callback of listeners.get(name) || []) await callback({ preventDefault() {}, currentTarget: this, target: this, ...event }); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      focus() { this.focused = true; }, select() { this.selected = true; },
    };
    return node;
  };
  const element = id => { if (!elements.has(id)) elements.set(id, makeNode()); return elements.get(id); };
  const account = { id: 11, generation: 1, isAdmin: true, isGuest: false };
  const requests = [];
  const reads = [];
  const timers = new Map();
  let timestamp = Date.parse('2030-01-01T12:00:00.000Z');
  let timerId = 0;
  class Clock extends Date { constructor(...values) { super(...(values.length ? values : [timestamp])); } static now() { return timestamp; } }
  const window = { location: new URL('https://example.test/') };
  const context = vm.createContext({
    window, account, URL, AbortController, Date: Clock,
    document: { getElementById: element, createElement: makeNode },
    navigator: { clipboard: { async writeText(value) { context.copied = value; } } },
    fetch(url, options) {
      if (autoList && options.method === 'GET') {
        reads.push({ url, options });
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => String(account.id) }, json: async () => ({ invitations: [], nextCursor: null }) });
      }
      return new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); });
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: timestamp + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('function el('), app.indexOf('function fmtDuration(')), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/invitations.js'), 'utf8'), context);
  vm.runInContext('window.invitationSettings = new window.InvitationSettings({ getAccount: () => account, el, icon: name => name });', context);
  const ui = window.invitationSettings;
  element('inviteForm').reportValidity = () => element('inviteForm').valid !== false &&
    ['inviteMaxUses', 'inviteCustomExpiry'].every(id => element(id).disabled || !element(id).validationMessage);
  element('inviteEditForm').reportValidity = () => element('inviteEditForm').valid !== false &&
    (element('inviteEditExpiry').disabled || !element('inviteEditExpiry').validationMessage) &&
    (!element('inviteReactivate').required || element('inviteReactivate').checked);
  element('profileModal').open = true;
  ui.open();
  const ready = ui.activate(active);
  return { ui, account, context, element, requests, reads, ready, timers,
    respond(request, data, status = 200, headers = {}) { request.resolve({ ok: status < 400, status,
      headers: { get(name) { return Object.hasOwn(headers, name) ? headers[name] : name === 'X-Invite-Account' ? String(account.id) : null; } },
      json: async () => data }); },
    advance(milliseconds) { timestamp += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= timestamp) { timers.delete(id); timer.callback(); } },
  };
}

function invitationUiItem(id = 100, overrides = {}) {
  return { id, revision: 1, createdAt: '2030-01-01T12:00:00.000Z', expiresAt: '2030-01-08T12:00:00.000Z',
    maxUses: 10, useCount: 0, remaining: 10, status: 'active', ...overrides };
}

test('admin invitation form sends the chosen signup limit and discards stale results', async () => {
  const { ui, account, element, requests, respond, ready } = invitationUiHarness();
  await ready;
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const administration = html.slice(html.indexOf('<section id="settingsAdmin"'), html.indexOf('</section>', html.indexOf('<section id="settingsAdmin"')));
  assert.match(administration, /<form id="inviteForm"[^>]*>[\s\S]*<label>Allowed signups<input id="inviteMaxUses" type="number" min="1" max="1000" step="1" value="1" inputmode="numeric" required/);
  assert.match(administration, /id="createInvite"[^>]*type="submit"/);
  assert.match(administration, /id="profileMonitoring"[^>]*type="button"/);
  element('inviteMaxUses').value = '10';
  const pending = element('inviteForm').fire('submit');
  assert.equal(element('createInvite').disabled, true);
  assert.equal(element('inviteMaxUses').disabled, true);
  await element('inviteForm').fire('submit');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/invites');
  assert.deepEqual(JSON.parse(requests[0].options.body), { maxUses: 10 });
  assert.equal(requests[0].options.headers['X-Invite-Account'], '11');
  assert.equal(requests[0].options.cache, 'no-store');
  element('inviteMaxUses').value = '20';
  const result = { ...invitationUiItem(), inviteUrl: `https://example.test/#join=${'a'.repeat(43)}` };
  respond(requests[0], result);
  await pending;
  assert.equal(element('issuedInviteLink').value, result.inviteUrl);
  assert.match(element('inviteExpiry').textContent, /^Limit: 10 signups\. Expires /);
  assert.equal(element('inviteResult').classList.contains('hidden'), false);
  assert.equal(element('createInvite').disabled, false);
  assert.equal(element('inviteMaxUses').value, '20');
  assert.equal(element('inviteMaxUses').disabled, false);
  element('inviteForm').valid = false;
  await ui.create();
  assert.equal(requests.length, 1);
  element('inviteForm').valid = true;
  const closed = ui.create();
  element('profileModal').open = false;
  respond(requests[1], result);
  await closed;
  assert.equal(element('issuedInviteLink').value, '');
  element('profileModal').open = true;
  ui.open(); await ui.activate(true);
  const stale = ui.create();
  account.generation++;
  respond(requests[2], result);
  await stale;
  assert.equal(element('issuedInviteLink').value, '');
  assert.equal(element('inviteResult').classList.contains('hidden'), true);
  ui.open(); await ui.activate(true);
  const failed = ui.create();
  requests[3].reject(new Error('Request failed'));
  await failed;
  assert.match(element('inviteError').textContent, /could not be confirmed/);
  assert.equal(element('createInvite').disabled, false);
  assert.equal(element('inviteMaxUses').disabled, false);
});

test('invitation UI converts each expiry choice to canonical UTC and resets only on a new profile opening', async () => {
  const { ui, element, requests, respond, ready, context } = invitationUiHarness();
  await ready;
  assert.equal(element('inviteLifetime').value, '7');
  assert.ok(element('inviteTimezone').textContent.startsWith('Time zone: '));
  for (const lifetime of ['1', '7', '30', 'custom']) {
    element('inviteLifetime').value = lifetime;
    await element('inviteLifetime').fire('change');
    element('inviteCustomExpiry').value = '2030-01-04T18:30:15';
    element('inviteMaxUses').value = '23';
    const pending = ui.create();
    const request = requests.at(-1);
    const body = JSON.parse(request.options.body);
    assert.equal(body.maxUses, 23);
    const expiry = lifetime === 'custom' ? new Date('2030-01-04T18:30:15').toISOString() : new Date(context.Date.now() + Number(lifetime) * 86400000).toISOString();
    if (lifetime === '7') assert.equal(Object.hasOwn(body, 'expiresAt'), false);
    else assert.equal(body.expiresAt, expiry);
    respond(request, { ...invitationUiItem(100, { maxUses: 23, remaining: 23, expiresAt: expiry }), inviteUrl: `https://example.test/#join=${'a'.repeat(43)}` });
    await pending;
    assert.ok(element('inviteExpiry').textContent.includes(expiry));
  }
  const previousLink = element('issuedInviteLink').value;
  ui.activate(false);
  await ui.activate(true);
  assert.equal(element('issuedInviteLink').value, previousLink);
  assert.equal(element('inviteLifetime').value, 'custom');
  ui.close(); ui.open();
  assert.equal(element('inviteLifetime').value, '7');
  assert.equal(element('inviteMaxUses').value, '1');
  assert.equal(element('inviteCustomExpiry').value, '');
  assert.equal(element('inviteCustomExpiry').disabled, true);
  assert.equal(element('issuedInviteLink').value, '');
});

test('invitation UI retains form and copy-once link on invalid dates, offline, validation errors and rate limits', async () => {
  const { ui, element, requests, respond, ready, advance } = invitationUiHarness();
  await ready;
  element('inviteLifetime').value = 'custom';
  await element('inviteLifetime').fire('change');
  for (const value of ['', '2030-02-30T12:00', '2029-12-31T12:00', '2032-01-01T12:00', '2030-01-04T12:00Z']) {
    element('inviteCustomExpiry').value = value;
    await element('inviteCustomExpiry').fire('input');
    await ui.create();
    assert.equal(requests.length, 0);
    assert.equal(element('inviteCustomExpiry').value, value);
    assert.ok(element('inviteCustomExpiry').validationMessage);
  }
  element('inviteCustomExpiry').value = '2030-01-04T18:30';
  await element('inviteCustomExpiry').fire('input');
  element('inviteMaxUses').value = '17';
  element('issuedInviteLink').value = 'copy-once-fixture';
  for (const status of [0, 400, 429]) {
    const pending = ui.create();
    const request = requests.at(-1);
    if (!status) request.reject(new TypeError('offline'));
    else respond(request, { code: status === 400 ? 'INVALID_INVITATION_EXPIRY' : 'RATE_LIMITED', error: 'Expiry is invalid.' }, status, { 'Retry-After': '30' });
    await pending;
    assert.equal(element('inviteMaxUses').value, '17');
    assert.equal(element('inviteCustomExpiry').value, '2030-01-04T18:30');
    assert.equal(element('issuedInviteLink').value, 'copy-once-fixture');
    assert.equal(element('inviteError').classList.contains('hidden'), false);
  }
  const count = requests.length;
  assert.equal(element('createInvite').disabled, true);
  await ui.create();
  assert.equal(requests.length, count);
  advance(30000);
  assert.equal(element('createInvite').disabled, false);
});

test('invitation UI lists only on Administration activation and paginates with safe descending cursors', async () => {
  const { ui, element, requests, respond, advance } = invitationUiHarness({ autoList: false, active: false });
  assert.equal(requests.length, 0);
  const first = ui.activate(true);
  assert.equal(requests[0].url, '/api/invites?limit=50');
  assert.equal(element('inviteList').getAttribute('aria-busy'), 'true');
  const rows = Array.from({ length: 50 }, (_, index) => invitationUiItem(100 - index));
  respond(requests[0], { invitations: rows, nextCursor: 51 });
  await first;
  assert.equal(element('inviteList').children.length, 50);
  assert.equal(element('invitePrevious').disabled, true);
  assert.equal(element('inviteNext').disabled, false);
  const next = element('inviteNext').fire('click');
  assert.equal(requests[1].url, '/api/invites?limit=50&before=51');
  respond(requests[1], { invitations: [], nextCursor: null });
  await next;
  assert.equal(ui.page, 1);
  assert.equal(element('invitePrevious').disabled, false);
  assert.equal(element('inviteNext').disabled, true);
  assert.match(element('inviteListStatus').textContent, /No older invitations/);
  const previous = element('invitePrevious').fire('click');
  assert.equal(requests[2].url, '/api/invites?limit=50');
  respond(requests[2], { invitations: [invitationUiItem(101), ...rows.slice(0, 49)], nextCursor: 52 });
  await previous;
  assert.equal(ui.page, 0);
  const failed = element('inviteNext').fire('click');
  requests[3].reject(new TypeError('offline'));
  await failed;
  assert.equal(ui.page, 0);
  assert.equal(ui.items[0].id, 101);
  assert.match(element('inviteListError').textContent, /last successful load/);
  await ui.activate(true);
  await ui.activate(true);
  advance(60000);
  assert.equal(requests.length, 4, 'No background polling or duplicate activation reads');
  ui.activate(false);
  const reentered = ui.activate(true);
  assert.equal(requests.length, 5, 'Entering Administration again refreshes its current page');
  respond(requests[4], { invitations: rows, nextCursor: 51 });
  await reentered;
});

test('invitation UI labels unavailable unused slots and rejects other-account data before reading it', async () => {
  const { ui, element, requests, respond, ready, account } = invitationUiHarness({ autoList: false });
  respond(requests[0], { invitations: [invitationUiItem(4), invitationUiItem(3, { status: 'expired' }),
    invitationUiItem(2, { status: 'exhausted', useCount: 10, remaining: 0 }), invitationUiItem(1, { status: 'revoked' })], nextCursor: null });
  await ready;
  const text = node => typeof node === 'string' ? node : node.textContent + node.children.map(text).join(' ');
  assert.match(text(element('inviteList')), /Active[\s\S]*Expired[\s\S]*Exhausted[\s\S]*Revoked/);
  assert.match(text(element('inviteList').children[3]), /10 unused slots; 0 available now/);
  const pending = ui.loadPage();
  let decoded = false;
  requests[1].resolve({ ok: true, status: 200, headers: { get: () => '22' }, json: async () => { decoded = true; return { invitations: [invitationUiItem(99)], nextCursor: null }; } });
  await pending;
  assert.equal(decoded, false);
  assert.equal(element('inviteList').children.length, 0);
  assert.match(element('inviteError').textContent, /account could not be verified/);
  ui.open();
  const stale = ui.activate(true);
  account.id = 22;
  ui.syncAccount();
  respond(requests[2], { invitations: [invitationUiItem()], nextCursor: null }, 200, { 'X-Invite-Account': '11' });
  await stale;
  assert.equal(element('inviteList').children.length, 0);
  assert.equal(requests[2].options.signal.aborted, true);
  assert.equal(element('issuedInviteLink').value, '');
});

test('invitation UI expiry edits send the displayed revision and expired reactivation needs explicit confirmation', async () => {
  const { ui, element, requests, respond, ready } = invitationUiHarness({ autoList: false });
  respond(requests[0], { invitations: [invitationUiItem(100, { revision: 5 }), invitationUiItem(99, { status: 'expired', expiresAt: '2029-12-31T12:00:00.000Z' })], nextCursor: null });
  await ready;
  await element('invitation-edit-100').fire('click');
  assert.equal(element('inviteEditExpiry').focused, true);
  assert.equal(element('inviteEditForm').classList.contains('hidden'), false);
  element('inviteEditExpiry').value = '2030-02-01T09:15:20';
  const saved = element('inviteEditForm').fire('submit');
  assert.equal(requests[1].url, '/api/invites/100');
  assert.equal(requests[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].options.body), { revision: 5, expiresAt: new Date('2030-02-01T09:15:20').toISOString() });
  await ui.saveEdit();
  assert.equal(requests.length, 2);
  respond(requests[1], invitationUiItem(100, { revision: 6, expiresAt: '2030-02-01T09:15:20.000Z' }));
  await saved;
  assert.equal(ui.items[0].revision, 6);
  assert.equal(element('inviteEditForm').classList.contains('hidden'), true);
  await element('invitation-edit-99').fire('click');
  element('inviteEditExpiry').value = '2030-01-15T12:00';
  await ui.saveEdit();
  assert.equal(requests.length, 2);
  assert.equal(element('inviteReactivateField').classList.contains('hidden'), false);
  assert.equal(element('inviteReactivate').required, true);
  assert.match(element('inviteEditError').textContent, /Confirm reactivation/);
  element('inviteReactivate').checked = true;
  const reactivated = ui.saveEdit();
  assert.deepEqual(JSON.parse(requests[2].options.body), { revision: 1, expiresAt: new Date('2030-01-15T12:00').toISOString(), reactivate: true });
  respond(requests[2], invitationUiItem(99, { revision: 2, expiresAt: '2030-01-15T12:00:00.000Z' }));
  await reactivated;
  assert.equal(ui.items[1].status, 'active');
});

test('invitation UI revocation is an inline explicit confirmation and sends only the captured revision', async () => {
  const { ui, element, requests, respond, ready } = invitationUiHarness({ autoList: false });
  const item = invitationUiItem(100, { revision: 7, useCount: 3, remaining: 7 });
  respond(requests[0], { invitations: [item], nextCursor: null });
  await ready;
  await element('invitation-revoke-100').fire('click');
  assert.equal(requests.length, 1);
  assert.match(element('inviteEditWarning').textContent, /cannot be undone/);
  assert.equal(element('inviteEditCancel').focused, true);
  assert.equal(element('inviteEditExpiry').disabled, true);
  await element('inviteEditCancel').fire('click');
  assert.equal(requests.length, 1);
  await element('invitation-revoke-100').fire('click');
  const revoked = element('inviteEditForm').fire('submit');
  assert.equal(requests[1].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[1].options.body), { revision: 7 });
  respond(requests[1], { ...item, revision: 8, status: 'revoked' });
  await revoked;
  assert.equal(ui.items[0].status, 'revoked');
  assert.equal(ui.items[0].useCount, 3);
  assert.equal(ui.rowButtons.length, 0);
  assert.equal(element('issuedInviteLink').value, '');
  ui.beginEdit(100, 'edit');
  assert.equal(ui.editing, null);
});

test('invitation UI keeps the latest entered expiry through revision conflicts and requires reviewed retry', async () => {
  const { ui, element, requests, respond, ready } = invitationUiHarness({ autoList: false });
  respond(requests[0], { invitations: [invitationUiItem(100, { revision: 2 })], nextCursor: null });
  await ready;
  ui.beginEdit(100, 'edit');
  element('inviteEditExpiry').value = '2030-02-01T09:15';
  const conflict = ui.saveEdit();
  respond(requests[1], { code: 'INVITATION_CHANGED', error: 'Changed' }, 409);
  await conflict;
  assert.equal(ui.editing.item.revision, 2);
  assert.equal(element('inviteEditExpiry').value, '2030-02-01T09:15');
  assert.equal(element('inviteEditSubmit').disabled, true);
  await ui.saveEdit();
  assert.equal(requests.length, 2);
  const review = element('inviteEditRefresh').fire('click');
  assert.equal(requests[2].url, '/api/invites?limit=50&before=101');
  element('inviteEditExpiry').value = '2030-03-02T10:20';
  respond(requests[2], { invitations: [invitationUiItem(100, { revision: 3, useCount: 1, remaining: 9 })], nextCursor: null });
  await review;
  assert.equal(ui.editing.item.revision, 3);
  assert.equal(element('inviteEditExpiry').value, '2030-03-02T10:20');
  assert.equal(element('inviteEditSubmit').disabled, false);
  assert.equal(requests.length, 3, 'Review must not automatically retry a mutation');
  const retry = ui.saveEdit();
  assert.deepEqual(JSON.parse(requests[3].options.body), { revision: 3, expiresAt: new Date('2030-03-02T10:20').toISOString() });
  respond(requests[3], invitationUiItem(100, { revision: 4, expiresAt: new Date('2030-03-02T10:20').toISOString(), useCount: 1, remaining: 9 }));
  await retry;
  assert.equal(ui.items[0].useCount, 1);
});

test('invitation UI preserves edit drafts on each server rejection and shares mutation cooldowns with creation', async () => {
  for (const [code, status] of [['INVALID_INVITATION_EXPIRY', 400], ['INVALID_REQUEST', 400], ['INVITATION_NOT_FOUND', 404],
    ['INVITATION_REVOKED', 409], ['INVITATION_EXHAUSTED', 409], ['INVITATION_REACTIVATION_REQUIRED', 409], ['RATE_LIMITED', 429], ['UNAVAILABLE', 503]]) {
    const { ui, element, requests, respond, ready, advance } = invitationUiHarness({ autoList: false });
    respond(requests[0], { invitations: [invitationUiItem()], nextCursor: null });
    await ready;
    ui.beginEdit(100, 'edit');
    element('inviteEditExpiry').value = '2030-01-20T10:30';
    const pending = ui.saveEdit();
    respond(requests[1], { code, error: 'Request rejected.' }, status, { 'Retry-After': '60' });
    await pending;
    assert.equal(element('inviteEditExpiry').value, '2030-01-20T10:30', code);
    assert.equal(element('inviteEditError').classList.contains('hidden'), false, code);
    if (code === 'INVITATION_REACTIVATION_REQUIRED') {
      assert.equal(element('inviteReactivateField').classList.contains('hidden'), false);
      assert.equal(element('inviteReactivate').checked, false);
    }
    if (['INVITATION_REVOKED', 'INVITATION_EXHAUSTED', 'INVITATION_NOT_FOUND'].includes(code)) assert.equal(element('inviteEditSubmit').disabled, true);
    if (status === 429) {
      ui.cancelEdit();
      assert.equal(element('createInvite').disabled, true);
      ui.beginEdit(100, 'revoke');
      assert.equal(element('inviteEditSubmit').disabled, true);
      await ui.saveEdit();
      assert.equal(requests.length, 2);
      advance(60000);
      assert.equal(element('inviteEditSubmit').disabled, false);
    }
  }
});

test('invitation UI late reads and writes cannot paint after close, generation change or role loss', async () => {
  for (const operation of ['list', 'create', 'edit', 'review']) {
    for (const boundary of ['close', 'account', 'generation', 'role']) {
      const { ui, account, element, requests, respond, ready } = invitationUiHarness({ autoList: false });
      respond(requests[0], { invitations: [invitationUiItem()], nextCursor: null });
      await ready;
      if (['edit', 'review'].includes(operation)) { ui.beginEdit(100, 'edit'); element('inviteEditExpiry').value = '2030-02-01T12:00'; }
      const pending = operation === 'list' ? ui.loadPage() : operation === 'create' ? ui.create() : operation === 'edit' ? ui.saveEdit() : ui.refreshEdit();
      const request = requests.at(-1);
      assert.equal(request.options.headers['X-Invite-Account'], '11');
      let finishDecode;
      let beganDecode;
      const decoding = new Promise(resolve => { beganDecode = resolve; });
      request.resolve({ ok: true, status: 200, headers: { get: () => '11' }, json() {
        beganDecode(); return new Promise(resolve => { finishDecode = resolve; });
      } });
      await decoding;
      if (boundary === 'close') { element('profileModal').open = false; ui.close(); }
      if (boundary === 'account') account.id = 22;
      if (boundary === 'generation') account.generation++;
      if (boundary === 'role') account.isAdmin = false;
      ui.syncAccount();
      finishDecode(['list', 'review'].includes(operation) ? { invitations: [invitationUiItem()], nextCursor: null } :
        { ...invitationUiItem(100, { revision: 2 }), inviteUrl: `https://example.test/#join=${'b'.repeat(43)}` });
      await pending;
      assert.equal(element('inviteList').children.length, 0, `${operation}: ${boundary}`);
      assert.equal(element('issuedInviteLink').value, '', `${operation}: ${boundary}`);
      assert.equal(element('inviteEditSummary').textContent, '', `${operation}: ${boundary}`);
      assert.equal(request.options.signal.aborted, true, `${operation}: ${boundary}`);
      assert.equal(element('createInvite').disabled, true, `${operation}: ${boundary}`);
    }
  }
});

test('invitation UI ignores an old completion while a reopened profile has a newer operation', async () => {
  const { ui, element, requests, respond, ready } = invitationUiHarness();
  await ready;
  const older = ui.create();
  ui.close(); ui.open(); await ui.activate(true);
  element('inviteMaxUses').value = '27';
  const newer = ui.create();
  requests[0].reject(new Error('old offline response'));
  await older;
  assert.equal(element('createInvite').disabled, true);
  assert.equal(element('inviteMaxUses').value, '27');
  assert.equal(element('inviteError').textContent, '');
  respond(requests[1], { ...invitationUiItem(101, { maxUses: 27, remaining: 27 }), inviteUrl: `https://example.test/#join=${'c'.repeat(43)}` });
  await newer;
  assert.ok(element('issuedInviteLink').value.endsWith('c'.repeat(43)));
  assert.equal(element('createInvite').disabled, false);
});

test('invitation UI fails closed without a verified owner and guards late clipboard feedback', async () => {
  const { ui, element, requests, ready } = invitationUiHarness();
  await ready;
  const unverified = ui.create();
  let decoded = false;
  requests[0].resolve({ ok: true, status: 201, headers: { get: () => null }, json() { decoded = true; return {}; } });
  await unverified;
  assert.equal(decoded, false);
  assert.equal(element('issuedInviteLink').value, '');
  assert.equal(element('createInvite').disabled, true);
  const fixture = invitationUiHarness();
  await fixture.ready;
  fixture.element('issuedInviteLink').value = 'copy-once-fixture';
  fixture.ui.sync();
  let clipboardFailed;
  fixture.context.navigator.clipboard.writeText = () => new Promise((_resolve, reject) => { clipboardFailed = reject; });
  const copying = fixture.ui.copy();
  fixture.ui.close(); fixture.ui.open();
  clipboardFailed(new Error('clipboard denied'));
  await copying;
  assert.equal(fixture.element('inviteError').textContent, '');
  assert.notEqual(fixture.element('issuedInviteLink').focused, true);
});

test('invitation UI keeps cursor bounds after create refresh failure and makes read cooldowns recoverable', async () => {
  const { ui, element, requests, respond, ready, advance } = invitationUiHarness({ autoList: false });
  respond(requests[0], { invitations: [invitationUiItem(100)], nextCursor: 100 });
  await ready;
  const next = ui.loadPage(100, 1);
  respond(requests[1], { invitations: [invitationUiItem(99)], nextCursor: null });
  await next;
  const creation = ui.create();
  let readStarted;
  const refreshing = new Promise(resolve => { readStarted = resolve; });
  const originalFetch = ui.getAccount;
  const originalRequest = ui.request.bind(ui);
  ui.request = (...args) => {
    const pending = originalRequest(...args);
    if (args[2] === undefined) readStarted();
    return pending;
  };
  respond(requests[2], { ...invitationUiItem(101), inviteUrl: `https://example.test/#join=${'d'.repeat(43)}` });
  await refreshing;
  assert.equal(requests[3].url, '/api/invites?limit=50&before=100');
  requests[3].reject(new TypeError('offline'));
  await creation;
  assert.equal(ui.page, 1);
  assert.equal(ui.cursors[1], 100);
  assert.match(element('invitePage').textContent, /^Page 2\./);
  assert.equal(element('invitePrevious').disabled, false);
  assert.ok(element('issuedInviteLink').value.endsWith('d'.repeat(43)));
  const limited = ui.loadPage(100, 1);
  respond(requests[4], { code: 'RATE_LIMITED', error: 'Wait' }, 429, { 'Retry-After': '30' });
  await limited;
  ui.close(); ui.open();
  await ui.activate(true);
  assert.equal(requests.length, 5);
  assert.match(element('inviteListError').textContent, /rate limited/);
  assert.equal(element('inviteRefresh').disabled, true);
  advance(30000);
  assert.equal(element('inviteRefresh').disabled, false);
  assert.equal(ui.getAccount, originalFetch);
});

test('invitation settings hooks preserve rejected-close drafts and bind the current account generation', () => {
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  new vm.Script(source, { filename: 'app.js' });
  new vm.Script(fs.readFileSync(path.join(root, 'public/invitations.js'), 'utf8'), { filename: 'invitations.js' });
  const guard = source.match(/dialog\.confirmClose = \(\) => \{[\s\S]*?\n  \};/)[0];
  let allowClose = false;
  let passwordsCleared = 0;
  let invitationsCleared = 0;
  const window = { invitationSettings: { close() { invitationsCleared++; } }, InvitationSettings: class { constructor(options) { this.getAccount = options.getAccount; } } };
  const context = vm.createContext({ window, dialog: {}, confirmAccountDiscard: () => allowClose,
    clearPasswordFields() { passwordsCleared++; }, authUser: { id: 11, isAdmin: true }, sessionGeneration: 1, el() {}, icon() {} });
  vm.runInContext(guard, context);
  assert.equal(context.dialog.confirmClose(), false);
  assert.equal(invitationsCleared, 0);
  assert.equal(passwordsCleared, 0);
  allowClose = true;
  assert.equal(context.dialog.confirmClose(), true);
  assert.equal(invitationsCleared, 1);
  assert.equal(passwordsCleared, 1);
  const wiring = source.slice(source.indexOf('window.invitationSettings = new window.InvitationSettings('), source.indexOf("$('#profileModal').addEventListener('close', () => { if"));
  vm.runInContext(wiring, context);
  const first = window.invitationSettings.getAccount();
  context.authUser = { id: 22, isAdmin: false };
  context.sessionGeneration++;
  assert.equal(first.id, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(window.invitationSettings.getAccount())), { id: 22, isAdmin: false, isGuest: false, generation: 2 });
  assert.match(source, /if \(!\$\('#profileModal'\)\.open\) clearIssuedInvite\(\)/);
  assert.match(source.slice(source.indexOf('function selectSettingsSection('), source.indexOf('async function openProfile(')), /invitationSettings\?\.activate\(section === 'admin'\)/);
  assert.match(source.slice(source.indexOf('function resetSessionState('), source.indexOf('function showAuth(')), /clearIssuedInvite\(\)/);
  assert.match(source.slice(source.indexOf('function updateProfileUI('), source.indexOf('async function loadProfileData(')), /invitationSettings\?\.syncAccount\(\)/);
});

test('invitation creation keeps allowed signups and offers seven-day default with native custom expiry', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const form = html.slice(html.indexOf('<form id="inviteForm"'), html.indexOf('<div id="inviteResult"'));
  assert.match(form, /Allowed signups<input id="inviteMaxUses"[^>]*min="1"[^>]*max="1000"/);
  assert.match(form, /<select id="inviteLifetime"[^>]*aria-describedby="inviteTimezone"/);
  for (const days of [1, 7, 30]) assert.match(form, new RegExp(`<option value="${days}"${days === 7 ? ' selected' : ''}>`));
  assert.match(form, /<option value="custom">Custom date and time<\/option>/);
  assert.match(form, /id="inviteCustomExpiry"[^>]*type="datetime-local"[^>]*disabled/);
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
  const controller = new AbortController();
  await window.FocusTubeInvite.submit('/api/auth/username/check', { body: JSON.stringify({ username: 'candidate' }), signal: controller.signal });
  assert.deepEqual(JSON.parse(requests[1].options.body), { username: 'candidate', inviteToken: token });
  assert.equal(requests[1].options.signal, controller.signal);
  assert.equal(requests[1].options.method, 'POST');
  controller.abort();
  assert.equal(requests[1].options.signal.aborted, true);
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
  assert.deepEqual(Object.keys(JSON.parse(issued.stdout)).sort(), ['database', 'id', 'expiresAt', 'maxUses', 'useCount', 'inviteUrl'].sort());
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

test('numeric proxy hop settings admit approved HTTPS without allowing HTTP or foreign origins', async context => {
  const environment = { HOST: '0.0.0.0', TRUST_PROXY: '1' };
  const { app, store, request, origin } = await httpFixture(context, environment);
  const trust = app.get('trust proxy fn');
  assert.equal(trust('172.18.0.1', 0), true);
  assert.equal(trust('172.18.0.1', 1), false, 'Only the configured immediate proxy hop is trusted');
  const headers = { Origin: origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' };
  assert.equal((await request('/api/auth/status', { headers })).status, 200);
  for (const protocol of ['', 'http']) {
    const response = await request('/api/auth/status', { headers: { ...headers, 'X-Forwarded-Proto': protocol } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'UNAPPROVED_ORIGIN');
  }
  const foreign = await request('/api/auth/login', {
    method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: {},
  });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, 'INVALID_ORIGIN');
  store.createUser({ username: 'proxy.member', ...await authModule.hashPassword('proxy-test-password') });
  const login = await request('/api/auth/login', {
    method: 'POST', headers, body: { identifier: 'proxy.member', password: 'proxy-test-password' },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  const direct = await httpFixture(context, { ...environment, TRUST_PROXY: '0' });
  assert.equal((await direct.request('/api/auth/status', { headers })).status, 403, 'An untrusted request cannot claim HTTPS');
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
    const response = await request(`${endpoint}?userId=${member.id}`, { headers: { Cookie: adminCookie, 'x-test-user': String(member.id), 'X-Profile-Account': String(admin.id) } });
    assert.equal(response.status, 200);
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