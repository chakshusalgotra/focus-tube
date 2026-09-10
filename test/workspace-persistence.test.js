'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

function memoryStore(context) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8'), {
    module,
    __dirname: path.join(__dirname, '..'),
    require(name) {
      if (name === 'better-sqlite3') return class MemoryDatabase extends Database {
        constructor() { super(':memory:'); }
      };
      if (name === 'fs') return { mkdirSync() {} };
      return require(name);
    },
  }, { filename: 'db.js' });
  context.after(() => module.exports.db.close());
  return module.exports;
}

function importPayload(snapshot) {
  return { ...snapshot, dailyActivity: [], watchHistory: [], downloadQuality: null };
}

test('workspace saves, exports, and imports without losing learning plans', context => {
  const store = memoryStore(context);
  const user = store.createUser({ isGuest: true });
  const workspace = {
    board: { mode: 'status', columns: [{ id: 'custom', title: 'This week' }] },
    tasks: { task1: { id: 'task1', title: 'Review SQL joins' } },
    checklists: { course1: [{ id: 'check1', text: 'Finish project', done: true }] },
    sprints: { cadence: 'week', items: [{ id: 'sprint1' }], assignments: {} },
    roadmaps: { roadmap1: { id: 'roadmap1', title: 'Data engineering', courseIds: [] } },
  };
  const snapshot = { courses: {}, stats: { seconds: {} }, settings: { homeMode: 'board' }, workspace };
  assert.equal(store.saveUserData(user.id, snapshot, 0), 1);
  const exported = store.getExportData(user.id);
  assert.deepEqual(JSON.parse(JSON.stringify(exported.workspace)), workspace);
  assert.equal(store.saveUserData(user.id, { ...snapshot, workspace: {} }, 1), 2);
  assert.equal(store.importUserData(user.id, importPayload(exported), 2), 3);
  const restored = store.getUserData(user.id);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.workspace)), workspace);
  assert.equal(restored.settings.homeMode, 'board');
  assert.equal(store.getUserById(user.id).is_guest, 1);
});

test('legacy exports without workspace restore an empty workspace', context => {
  const store = memoryStore(context);
  const user = store.createUser({ isGuest: true });
  const snapshot = { courses: {}, stats: { seconds: {} }, settings: {} };
  assert.equal(store.saveUserData(user.id, { ...snapshot, workspace: { tasks: { old: {} } } }, 0), 1);
  assert.equal(store.importUserData(user.id, importPayload(snapshot), 1), 2);
  assert.equal(JSON.stringify(store.getUserData(user.id).workspace), '{}');
});

test('stale imports do not overwrite newer workspace state', context => {
  const store = memoryStore(context);
  const user = store.createUser({ isGuest: true });
  const snapshot = { courses: {}, stats: { seconds: {} }, settings: {}, workspace: { tasks: { latest: { title: 'Keep this' } } } };
  assert.equal(store.saveUserData(user.id, snapshot, 0), 1);
  assert.equal(store.importUserData(user.id, importPayload({ ...snapshot, workspace: {} }), 0), null);
  assert.equal(store.getUserData(user.id).workspace.tasks.latest.title, 'Keep this');
  assert.equal(store.getUserData(user.id).revision, 1);
});