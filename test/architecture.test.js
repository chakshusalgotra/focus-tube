'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const docs = require('../scripts/update-architecture');
const root = path.resolve(__dirname, '..');

test('architecture catalog covers current flows and keeps draft automation distinct', () => {
  const catalog = docs.loadCatalog();
  assert.equal(catalog.diagrams.length, 9);
  assert.equal(catalog.diagrams.filter(item => item.state === 'draft').length, 1);
  for (const id of ['system', 'account', 'learning', 'notes', 'chat', 'capture', 'feedback', 'deployment']) {
    assert.equal(catalog.diagrams.find(item => item.id === id)?.state, 'current');
  }
  const inventory = docs.sourceInventory(catalog);
  assert.equal(inventory.tables.length, 26);
  assert.equal(inventory.tables.filter(table => table.source === 'extension-store.js').length, 4);
  assert.ok(inventory.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256)));
  assert.equal(inventory.sources.some(source => source.path === '.env' || source.path.startsWith('data/')), false);
});

test('architecture viewers are offline models with editable source and draft disclosure', () => {
  const catalog = docs.loadCatalog();
  const html = docs.indexHtml(catalog);
  assert.match(html, /Animated paths explain the model; they are not live traffic/);
  assert.match(html, /Draft proposal; not implemented automation/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /id="diagram"/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"/);
  assert.doesNotMatch(html, /fetch\(|https?:\/\/[^< ]+\.(?:js|css)/);
  const source = fs.readFileSync(path.join(root, 'scripts/update-architecture.js'), 'utf8');
  assert.match(source, /ARCHIFY_UPDATE_CHECK_DISABLED: '1'/);
  assert.doesNotMatch(source, /require\('\.\.\/db'\)|require\('\.\.\/server'\)/);
});