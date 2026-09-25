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

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function appFunction(name) {
  const start = appSource.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} exists in app.js`);
  return appSource.slice(start, appSource.indexOf('\n}', start) + 2);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function profileClient(overrides = {}) {
  const client = {
    authUser: { id: 101, isGuest: false },
    sessionGeneration: 1,
    authClears: 0,
    profileRevision: 1,
    libraryRefreshRequest: null,
    remoteSaveTimer: null,
    remoteSaveInFlight: null,
    remoteSaveQueued: false,
    pendingLegacyImport: false,
    appBooted: true,
    current: null,
    courses: {},
    stats: { seconds: {} },
    workspace: {},
    userName: 'Local learner',
    volume: 60,
    captionsOn: true,
    prefQuality: 'default',
    homeMode: 'list',
    location: { hash: '' },
    homeView: { classList: { contains: () => false } },
    document: { hidden: false },
    renders: 0,
    errors: [],
    timers: [],
    now: 10000,
    Date: class extends Date { static now() { return client.now; } },
    Headers,
    AbortSignal,
    structuredClone,
    queueMicrotask,
    window: {},
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      client.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    renderHome() { client.renders++; },
    renderStreakChip() {},
    toast(message) { client.errors.push(message); },
    fetch: async () => assert.fail('Unexpected profile request'),
    showAuth() {
      client.authClears++;
      client.authUser = null;
      client.sessionGeneration++;
      client.courses = {};
      client.current = null;
      client.appBooted = false;
    },
    ...overrides,
  };
  vm.createContext(client);
  vm.runInContext([
    'api', 'settingsSnapshot', 'scheduleRemoteSave', 'normalizeWorkspace', 'mergeWorkspaceState',
    'mergeRemoteState', 'isLibraryHome', 'refreshLibraryFromServer', 'persistRemoteData',
  ].map(appFunction).join('\n'), client);
  client.workspace = client.normalizeWorkspace(client.workspace);
  return client;
}

function capturedProfile() {
  return {
    revision: 2,
    courses: {
      original: { id: 'original', title: 'Existing course', videos: [{ id: 'original001' }], completed: {}, positions: { original001: 5 } },
      captured: { id: 'captured', title: 'Extension capture', videos: [{ id: 'captured001' }], completed: {}, positions: {} },
    },
    stats: { seconds: { '2026-09-25': 10 } },
    settings: { volume: 100, homeMode: 'grid' },
    workspace: { tasks: { task1: { id: 'task1', title: 'Review', notes: 'Server task notes', createdAt: 1 } } },
  };
}

test('profile API binds GET and PUT to the account captured before fetch', async () => {
  const requests = [];
  const client = profileClient({ fetch: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ revision: 1 });
  } });
  await client.api('/api/data');
  await client.api('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Profile-Account': '999' }, body: '{}',
  });
  assert.equal(requests[0].options.headers.get('X-Profile-Account'), '101');
  assert.equal(requests[1].options.headers.get('X-Profile-Account'), '101');
  assert.equal(requests[1].options.headers.get('Content-Type'), 'application/json');
  assert.equal(requests[1].options.body, '{}');
  assert.equal(client.authClears, 0);
});

test('profile API clears stale UI on 401 and SESSION_CHANGED but protects a newer session', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [409, 'SESSION_CHANGED']]) {
    for (const changed of ['none', 'account', 'generation']) {
      const pending = deferred();
      const client = profileClient({ fetch: () => pending.promise });
      const request = client.api('/api/data');
      if (changed === 'account') client.authUser = { id: 202, isGuest: false };
      if (changed === 'generation') client.sessionGeneration++;
      pending.resolve(Response.json({ error: 'Sign in again.', code }, { status }));
      await assert.rejects(request, error => error.status === status && error.data.code === code);
      assert.equal(client.authClears, changed === 'none' ? 1 : 0, `${status}: ${changed}`);
      if (changed !== 'none') assert.ok(client.authUser);
    }
  }
});

test('queued profile authentication errors recheck the account before clearing UI', async () => {
  const callbacks = [];
  const client = profileClient({
    queueMicrotask: callback => callbacks.push(callback),
    fetch: async () => Response.json({ code: 'SESSION_CHANGED' }, { status: 409 }),
  });
  await assert.rejects(client.api('/api/data'));
  assert.equal(callbacks.length, 1);
  client.authUser = { id: 202, isGuest: false };
  callbacks[0]();
  assert.equal(client.authClears, 0);
});

test('Library refresh merges extension captures without flushing dirty progress, settings or notebook drafts', async () => {
  const pending = deferred();
  const requests = [];
  const remote = capturedProfile();
  const original = structuredClone(remote.courses.original);
  const editor = { document: { ops: [{ insert: 'Unsaved manual notes\n' }] }, history: ['manual edit'], composing: true };
  const notebooks = { editor, notesRevision: 7, dirty: true, reset: () => assert.fail('Do not reset notes') };
  const client = profileClient({
    courses: { original }, notebooks,
    workspace: { tasks: { task1: { title: 'Review', notes: 'Local task notes', createdAt: 1 } } },
    fetch: (url, options) => { requests.push({ url, options }); return pending.promise; },
  });
  client.scheduleRemoteSave();
  const timer = client.remoteSaveTimer;
  const refresh = client.refreshLibraryFromServer();
  original.positions.original001 = 123;
  original.completed.original001 = '2026-09-25T10:00:00Z';
  client.stats.seconds['2026-09-25'] = 60;
  client.workspace.tasks.task1.notes = 'Typed while the GET was pending';
  pending.resolve(Response.json(remote));
  assert.equal(await refresh, true);
  assert.equal(client.courses.captured.title, 'Extension capture');
  assert.equal(client.courses.original, original);
  assert.equal(original.positions.original001, 123);
  assert.equal(original.completed.original001, '2026-09-25T10:00:00Z');
  assert.equal(client.stats.seconds['2026-09-25'], 60);
  assert.equal(client.workspace.tasks.task1.notes, 'Typed while the GET was pending');
  assert.equal(client.volume, 60);
  assert.equal(client.homeMode, 'list');
  assert.equal(client.notebooks, notebooks);
  assert.equal(notebooks.editor, editor);
  assert.equal(editor.document.ops[0].insert, 'Unsaved manual notes\n');
  assert.deepEqual(editor.history, ['manual edit']);
  assert.equal(notebooks.notesRevision, 7);
  assert.equal(notebooks.dirty, true);
  assert.equal(client.remoteSaveTimer, timer);
  assert.equal(timer.cleared, false);
  assert.equal(client.timers.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, undefined);
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.headers.get('X-Profile-Account'), '101');
  assert.equal(client.profileRevision, 2);
  assert.equal(client.renders, 1);
});

test('Library refresh starts only on the visible home of the active booted member', async () => {
  for (const change of [
    client => { client.authUser = null; },
    client => { client.authUser.isGuest = true; },
    client => { client.appBooted = false; },
    client => { client.document.hidden = true; },
    client => { client.current = { course: {}, index: 0 }; },
    client => { client.homeView.classList.contains = () => true; },
    ...['#tasks', '#dashboard', '#notebooks', '#notebook=original', '#c=original', '#roadmaps'].map(hash => client => { client.location.hash = hash; }),
  ]) {
    let requests = 0;
    const client = profileClient({ fetch: async () => { requests++; return Response.json(capturedProfile()); } });
    const courses = client.courses;
    change(client);
    assert.equal(await client.refreshLibraryFromServer(), false);
    assert.equal(requests, 0);
    assert.equal(client.courses, courses);
    assert.equal(client.renders, 0);
  }
});

test('late Library GETs are ignored after account, session, revision, visibility or route changes', async () => {
  for (const change of [
    client => { client.authUser = { id: 202, isGuest: false }; },
    client => { client.sessionGeneration++; },
    client => { client.profileRevision++; },
    client => { client.authUser = null; },
    client => { client.appBooted = false; },
    client => { client.document.hidden = true; },
    client => { client.current = { course: client.courses.original, index: 0 }; },
    client => { client.location.hash = '#tasks'; },
    client => { client.homeView.classList.contains = () => true; },
  ]) {
    const pending = deferred();
    const client = profileClient({ courses: { original: capturedProfile().courses.original }, fetch: () => pending.promise });
    const courses = client.courses;
    const refresh = client.refreshLibraryFromServer();
    change(client);
    pending.resolve(Response.json(capturedProfile()));
    assert.equal(await refresh, false);
    assert.equal(client.courses, courses);
    assert.equal(client.courses.captured, undefined);
    assert.equal(client.renders, 0);
    assert.equal(client.timers.length, 0);
  }
  for (const revision of [0, -1, '2', null]) {
    const client = profileClient({ fetch: async () => Response.json({ ...capturedProfile(), revision }) });
    assert.equal(await client.refreshLibraryFromServer(), false);
    assert.equal(client.profileRevision, 1);
    assert.equal(client.renders, 0);
  }
});

test('a late Library GET cannot apply after a newer profile PUT even with a higher returned revision', async () => {
  const pending = deferred();
  const requests = [];
  const client = profileClient({ fetch: (url, options) => {
    requests.push(options.method || 'GET');
    return options.method === 'PUT' ? Promise.resolve(Response.json({ revision: 2 })) : pending.promise;
  } });
  const refresh = client.refreshLibraryFromServer();
  assert.equal(await client.persistRemoteData(), true);
  pending.resolve(Response.json({ ...capturedProfile(), revision: 3 }));
  assert.equal(await refresh, false);
  assert.equal(client.profileRevision, 2);
  assert.equal(client.courses.captured, undefined);
  assert.equal(client.renders, 0);
  assert.deepEqual(requests, ['GET', 'PUT']);
});

test('a late successful PUT cannot rewind a newer Library refresh revision', async () => {
  const pending = deferred();
  const client = profileClient({ fetch: (url, options) => options.method === 'PUT'
    ? pending.promise : Promise.resolve(Response.json({ ...capturedProfile(), revision: 3 })) });
  const save = client.persistRemoteData();
  assert.equal(await client.refreshLibraryFromServer(), true);
  pending.resolve(Response.json({ revision: 2 }));
  assert.equal(await save, true);
  assert.equal(client.profileRevision, 3);
  assert.equal(client.courses.captured.title, 'Extension capture');
});

test('Library foreground refresh coalesces and throttles, while home re-entry supersedes older requests', async () => {
  const requests = [];
  const client = profileClient({ fetch: () => {
    const pending = deferred();
    requests.push(pending);
    return pending.promise;
  } });
  const first = client.refreshLibraryFromServer();
  assert.equal(client.refreshLibraryFromServer(), first);
  const entered = client.refreshLibraryFromServer({ entering: true });
  assert.equal(requests.length, 2);
  requests[0].resolve(Response.json({ ...capturedProfile(), revision: 4 }));
  assert.equal(await first, false);
  assert.equal(client.libraryRefreshRequest.promise, entered);
  requests[1].resolve(Response.json(capturedProfile()));
  assert.equal(await entered, true);
  assert.equal(await client.refreshLibraryFromServer(), false);
  assert.equal(requests.length, 2);
  client.now += 1000;
  const later = client.refreshLibraryFromServer();
  requests[2].resolve(Response.json(capturedProfile()));
  assert.equal(await later, true);
  assert.equal(client.renders, 1, 'An unchanged revision does not rerender the Library');
  assert.equal(client.timers.length, 0, 'No polling or profile-save timers');
});

test('a failed Library refresh keeps local state and retries only on a later foreground event', async () => {
  let requests = 0;
  const client = profileClient({ fetch: async () => {
    if (++requests === 1) throw new Error('Offline');
    return Response.json(capturedProfile());
  } });
  const courses = client.courses;
  assert.equal(await client.refreshLibraryFromServer(), false);
  assert.equal(client.courses, courses);
  assert.equal(client.profileRevision, 1);
  assert.equal(client.renders, 0);
  assert.equal(await client.refreshLibraryFromServer(), false);
  assert.equal(requests, 1);
  client.now += 1000;
  assert.equal(await client.refreshLibraryFromServer(), true);
  assert.equal(requests, 2);
  assert.equal(client.timers.length, 0);
  assert.equal(client.errors.length, 0);
});

test('Library authentication failures clear stale UI without saving or merging the profile', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [409, 'SESSION_CHANGED']]) {
    let requests = 0;
    const client = profileClient({ courses: capturedProfile().courses, fetch: async () => {
      requests++;
      return Response.json({ code }, { status });
    } });
    assert.equal(await client.refreshLibraryFromServer(), false);
    assert.equal(client.authClears, 1);
    assert.equal(Object.keys(client.courses).length, 0);
    assert.equal(client.renders, 0);
    assert.equal(client.timers.length, 0);
    assert.equal(requests, 1);
  }
});

test('old-profile PUT 409 recovery keeps extension captures and the active course reference', async context => {
  const store = memoryStore(context);
  const user = store.createUser({ isGuest: true });
  const snapshot = capturedProfile();
  const original = structuredClone(snapshot.courses.original);
  original.positions.original001 = 123;
  assert.equal(store.saveUserData(user.id, { ...snapshot, courses: { original: snapshot.courses.original } }, 0), 1);
  assert.equal(store.saveUserData(user.id, snapshot, 1), 2);
  const requests = [];
  const client = profileClient({
    authUser: { id: user.id, isGuest: false }, courses: { original },
    current: { course: original, index: 0 }, location: { hash: '#c=original' },
    fetch: async (url, options) => {
      assert.equal(url, '/api/data');
      assert.equal(options.headers.get('X-Profile-Account'), String(user.id));
      requests.push(options.method || 'GET');
      if (options.method !== 'PUT') return Response.json(store.getUserData(user.id));
      const payload = JSON.parse(options.body);
      const revision = store.saveUserData(user.id, payload, payload.revision);
      return revision == null ? Response.json({ error: 'Profile changed.' }, { status: 409 }) : Response.json({ revision });
    },
  });
  assert.equal(await client.persistRemoteData(), true);
  assert.deepEqual(requests, ['PUT', 'GET', 'PUT']);
  assert.equal(store.getUserData(user.id).courses.captured.title, 'Extension capture');
  assert.equal(store.getUserData(user.id).courses.original.positions.original001, 123);
  assert.equal(client.current.course, original);
  assert.equal(client.courses.original, original);
  client.current.course.positions.original001 = 145;
  assert.equal(await client.persistRemoteData(), true);
  assert.equal(store.getUserData(user.id).courses.original.positions.original001, 145);
  assert.equal(client.renders, 0);
});

test('a conflict-recovery GET cannot rewind state already merged by a newer Library refresh', async () => {
  const pending = deferred();
  const reachedGet = deferred();
  let reads = 0;
  const writes = [];
  const client = profileClient({ fetch: async (url, options) => {
    if (options.method === 'PUT') {
      writes.push(JSON.parse(options.body));
      return writes.length === 1 ? Response.json({}, { status: 409 }) : Response.json({ revision: 4 });
    }
    if (++reads === 1) { reachedGet.resolve(); return pending.promise; }
    return Response.json({ ...capturedProfile(), revision: 3 });
  } });
  const save = client.persistRemoteData();
  await reachedGet.promise;
  assert.equal(await client.refreshLibraryFromServer(), true);
  pending.resolve(Response.json({ ...capturedProfile(), revision: 2 }));
  assert.equal(await save, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].revision, 3);
  assert.equal(writes[1].courses.captured.title, 'Extension capture');
  assert.equal(client.profileRevision, 4);
});

test('a late previous-account PUT cannot clear the current save or authentication state', async () => {
  const requests = [];
  const client = profileClient({ fetch: () => {
    const pending = deferred();
    requests.push(pending);
    return pending.promise;
  } });
  const previous = client.persistRemoteData();
  client.authUser = { id: 202, isGuest: false };
  client.sessionGeneration++;
  client.remoteSaveInFlight = null;
  client.profileRevision = 7;
  const currentSave = client.persistRemoteData();
  const currentRequest = client.remoteSaveInFlight;
  requests[0].resolve(Response.json({ code: 'SESSION_CHANGED' }, { status: 409 }));
  assert.equal(await previous, false);
  assert.equal(client.remoteSaveInFlight, currentRequest);
  assert.equal(client.authClears, 0);
  assert.equal(client.profileRevision, 7);
  requests[1].resolve(Response.json({ revision: 8 }));
  assert.equal(await currentSave, true);
  assert.equal(client.profileRevision, 8);
  assert.equal(client.remoteSaveInFlight, null);
});

test('SESSION_CHANGED on profile PUT clears UI without revision-conflict retry', async () => {
  let requests = 0;
  const client = profileClient({ fetch: async () => {
    requests++;
    return Response.json({ code: 'SESSION_CHANGED' }, { status: 409 });
  } });
  assert.equal(await client.persistRemoteData(), false);
  assert.equal(requests, 1);
  assert.equal(client.authClears, 1);
  assert.equal(client.remoteSaveInFlight, null);
});

test('Library refresh hooks belong to home activation and foreground, not filter rendering or routing', async () => {
  new vm.Script(appSource, { filename: 'public/app.js' });
  assert.match(appFunction('showHome'), /refreshLibraryFromServer\(\{ entering: true \}\)/);
  for (const name of ['renderHome', 'route', 'showAuth', 'finishAuth']) {
    assert.doesNotMatch(appFunction(name), /refreshLibraryFromServer/);
  }
  const hooks = appSource.match(/(?:window|document)\.addEventListener\('(focus|blur|visibilitychange)', (?:refreshLibraryFromServer|\(\) => \{ libraryRefreshRequest = null; \})\);/g);
  assert.equal(hooks.length, 3);
  const events = {};
  const hidden = new Set(['hidden']);
  const view = { classList: { add() {}, remove() {} } };
  let stops = 0;
  let leaves = 0;
  let requests = 0;
  const client = profileClient({
    homeView: { classList: { contains: name => hidden.has(name), remove: name => hidden.delete(name) } },
    notebooks: { leave() { leaves++; } },
    player: { stopVideo() { stops++; } },
    safe: callback => callback(),
    hideOverlays() {},
    setCourseViewVisible() {},
    dashboardView: view, tasksView: view, roadmapView: view, backBtn: view, sideToggle: view,
    fetch: async () => { requests++; return Response.json(capturedProfile()); },
  });
  client.window.addEventListener = client.document.addEventListener = (type, callback) => { events[type] = callback; };
  vm.runInContext(appFunction('showHome') + '\n' + hooks.join('\n'), client);
  client.showHome();
  const beforeBlur = client.libraryRefreshRequest.promise;
  assert.equal(requests, 1);
  assert.equal(stops, 1);
  assert.equal(leaves, 1);
  events.blur();
  const focused = events.focus({ type: 'focus' });
  assert.notEqual(focused, beforeBlur, 'Extension return must not reuse the pre-capture GET');
  assert.equal(events.visibilitychange({ type: 'visibilitychange' }), focused);
  assert.equal(await beforeBlur, false);
  assert.equal(await focused, true);
  assert.equal(requests, 2);
  client.document.hidden = true;
  assert.equal(await events.visibilitychange({ type: 'visibilitychange' }), false);
  client.document.hidden = false;
  assert.equal(await events.visibilitychange({ type: 'visibilitychange' }), true);
  assert.equal(requests, 3, 'A quick tab return must not be lost to the foreground throttle');
  assert.equal(stops, 1, 'Foreground refresh does not run the player navigation lifecycle');
  assert.equal(leaves, 1, 'Foreground refresh does not leave or reload the editor');
});

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
test('server integration requires X-Profile-Account enforcement for GET and PUT /api/data', () => {
  assert.ok(/X-Profile-Account/i.test(serverSource), 'Bind profile GET/PUT to the session account before reading or writing data.');
  for (const method of ['get', 'put']) assert.ok(serverSource.includes(`app.${method}('/api/data', auth.requireAuth, requireProfileAccount,`));
});

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