'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const Database = require('better-sqlite3');

async function main() {
  const { values, positionals } = parseArgs({ options: {
    'data-dir': { type: 'string' }, origin: { type: 'string' }, 'max-members': { type: 'string' },
  }, allowPositionals: true });
  const command = positionals[0];
  if (positionals.length !== 1 || !['bootstrap', 'set-limit'].includes(command) || !values['data-dir']) {
    throw new Error('Usage: node scripts/auth-admin.js bootstrap --data-dir PATH --origin ORIGIN, or set-limit --data-dir PATH --max-members N');
  }
  const limit = values['max-members'] === undefined ? undefined : Number(values['max-members']);
  if (command === 'bootstrap' && limit !== undefined) throw new Error('Use set-limit separately before issuing a bootstrap invitation.');
  if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) || (command === 'set-limit' && limit === undefined)) {
    throw new Error('A positive integer member limit is required.');
  }
  let origin;
  if (command === 'bootstrap') {
    try { origin = new URL(values.origin); } catch { throw new Error('An exact application origin is required.'); }
    if (origin.origin !== values.origin || !['http:', 'https:'].includes(origin.protocol) ||
        (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
      throw new Error('Use an exact HTTPS origin or a loopback HTTP origin.');
    }
  }
  const directory = path.resolve(values['data-dir']);
  const filename = path.join(directory, 'focustube.db');
  if (!fs.existsSync(filename)) throw new Error('No FocusTube database exists in that directory. Start the intended instance first.');
  const existing = new Database(filename, { readonly: true });
  try {
    const backups = path.join(directory, 'backups');
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    await existing.backup(path.join(backups, `before-auth-admin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`));
  } finally { existing.close(); }
  process.env.FOCUSTUBE_DATA_DIR = directory;
  const store = require('../db');
  try {
    if (limit !== undefined) store.setMemberLimit(limit);
    if (command === 'set-limit') {
      console.log(JSON.stringify({ database: filename, maxMembers: limit }));
      return;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const invitation = store.issueInvitation({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), bootstrap: true });
    console.log(JSON.stringify({ database: filename, ...invitation, inviteUrl: `${origin.origin}/#join=${token}` }));
  } finally { store.db.close(); }
}

main().catch(error => {
  const message = error.code === 'ADMIN_EXISTS' ? 'An active administrator already exists. Bootstrap is not permitted.' :
    error.code?.startsWith('SQLITE_') ? 'The database operation failed. No invitation link is available.' : error.message;
  console.error(message);
  process.exitCode = 1;
});