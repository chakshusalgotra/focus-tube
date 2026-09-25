'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../public/notebook-model');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const express = require('express');
const http = require('node:http');

function memoryStore(context) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8'), {
    module, Buffer, __dirname: path.join(__dirname, '..'),
    require(name) {
      if (name === 'better-sqlite3') return class extends Database { constructor() { super(':memory:'); } };
      if (name === 'fs') return { mkdirSync() {} };
      return require(name);
    },
  }, { filename: 'db.js' });
  context.after(() => module.exports.db.close());
  return module.exports;
}

function profile(store) {
  const user = store.createUser({ isGuest: true });
  const courses = { course1: { id: 'course1', title: 'Sample course', videos: [{ id: 'aqz-KE-bpKQ', title: 'First lesson' }, { id: 'jNQXAC9IVRw', title: 'Second lesson' }] } };
  store.saveUserData(user.id, { courses, stats: {}, settings: {}, workspace: {} }, 0);
  return user;
}

function controllerFixture() {
  const storage = new Map();
  const elements = new Map();
  const elementFor = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      const properties = new Map();
      elements.set(selector, {
        classList: {
          add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
          toggle(value, force) { if (force) classes.add(value); else classes.delete(value); },
        },
        attributes: {}, listeners: {}, rectangle: { width: 380, height: 600 }, clientWidth: 1000, open: true,
        style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name), getPropertyValue: name => properties.get(name) || '' },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; }, replaceChildren() {},
        getBoundingClientRect() { return this.rectangle; },
        setPointerCapture() {}, hasPointerCapture() { return false; },
        append(child) { child.parentElement = this; },
      });
    }
    return elements.get(selector);
  };
  const window = { NotebookModel: model, addEventListener() {} };
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/notebooks.js'), 'utf8'), {
    window, document: { querySelector: elementFor, body: elementFor('body') }, NotebookEditor: { render() {} }, localStorage, clearTimeout, setTimeout,
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
  });
  const controller = Object.create(window.Notebooks.prototype);
  Object.assign(controller, {
    generation: 0, notesRevision: 0, tabId: 'test-tab', states: new Map(), status() {},
    binding: 0, active: null, mode: 'read', editor: { composing: false, load() {}, enable() {} },
    loadCourse: async () => {},
    options: { getUser: () => ({ id: 1 }), getCourses: () => ({}), ensureCourseSaved: async () => true },
  });
  return { controller, storage, elementFor };
}

const note = (text = 'First thought', seconds = 0, id = 'block-one') => ({ version: 1, ops: [
  { insert: text }, { insert: '\n', attributes: { blockId: id, anchorSeconds: seconds } },
] });

test('notes validate hidden zero-second anchors and omit empty documents', () => {
  assert.equal(model.validate(note()).ops[1].attributes.anchorSeconds, 0);
  assert.equal(model.validate(model.empty()), null);
  assert.equal(model.validate({ version: 1, ops: [{ insert: '  \n' }] }), null);
  for (const document of [
    note('Bad time', -1),
    { version: 1, ops: [{ insert: { image: 'https://example.com/image' } }] },
    { version: 1, ops: [{ insert: 'Bad link', attributes: { link: 'javascript:alert(1)' } }, ...note().ops.slice(1)] },
    { version: 1, ops: [...note().ops, ...note().ops] },
    note('x'.repeat(model.MAX_BYTES)),
  ]) assert.throws(() => model.validate(document));
});

test('first input captures time; later edits and splits retain the source time', () => {
  let counter = 0;
  const id = () => `new-${++counter}`;
  const created = model.anchorChanges(model.empty(), { ops: [{ insert: 'Hello\n' }] }, { ops: [{ insert: 'Hello' }] }, 0, id);
  assert.equal(model.lines(created)[0].attributes.anchorSeconds, 0);
  const edited = model.anchorChanges(created, { ops: [{ insert: 'Hello again\n' }] }, { ops: [{ retain: 5 }, { insert: ' again' }] }, 90, id);
  assert.deepEqual(model.lines(edited)[0].attributes, model.lines(created)[0].attributes);
  const split = model.anchorChanges(edited, { ops: [{ insert: 'Hello\n again\n' }] }, { ops: [{ retain: 5 }, { insert: '\n' }] }, 100, id);
  const splitBlocks = model.lines(split);
  assert.equal(splitBlocks[1].attributes.anchorSeconds, 0);
  assert.notEqual(splitBlocks[0].attributes.blockId, splitBlocks[1].attributes.blockId);
  const appended = model.anchorChanges(split, { ops: [{ insert: 'Hello\n again\nNew idea\n' }] }, { ops: [{ retain: 13 }, { insert: 'New idea\n' }] }, 120, id);
  assert.equal(model.lines(appended)[2].attributes.anchorSeconds, 120);
  assert.doesNotThrow(() => model.validate(appended));
});

const proposal = () => ({ id: 'p_11111111-1111-4111-8111-111111111111', courseId: 'course1', videoId: 'aqz-KE-bpKQ', sourceHash: 'a'.repeat(64), blocks: [
  { kind: 'heading', text: 'Summary', seconds: null, segmentIds: [], messageIds: [] },
  { kind: 'paragraph', text: 'Start of the lesson', seconds: 0, segmentIds: ['s1'], messageIds: [] },
  { kind: 'paragraph', text: 'A later example', seconds: 45, segmentIds: ['s2'], messageIds: [] },
] });

test('generated blocks retain validated zero times and stable identities, with partial-duplicate rejection', () => {
  const draft = proposal();
  const blocks = model.generatedBlocks(draft);
  const document = model.fromLines(blocks);
  assert.deepEqual(blocks.map(block => block.attributes.anchorSeconds), [undefined, 0, 45]);
  assert.deepEqual(model.generatedBlocks(draft), blocks);
  assert.equal(model.generatedStatus(note(), draft), 'absent');
  assert.equal(model.generatedStatus(document, draft), 'present');
  assert.throws(() => model.generatedStatus(model.fromLines(blocks.slice(1)), draft), /Part of/);
  assert.throws(() => model.generatedStatus(document, { ...draft, blocks: draft.blocks.map(block => ({ ...block, text: 'Changed' })) }), /edited/);
  assert.throws(() => model.generatedBlocks({ ...draft, blocks: [{ ...draft.blocks[1], seconds: -1 }] }), /invalid/);
  assert.throws(() => model.generatedBlocks({ ...draft, blocks: [{ ...draft.blocks[1], segmentIds: [] }] }), /invalid/);
  assert.match(model.markdown(document, draft.videoId), /t=0/);
  assert.match(model.markdown(document, draft.videoId), /t=45/);
});

test('validated editor append bypasses recapture, preserves selection and history, and emits one change', () => {
  const Delta = require('quill-delta');
  const registered = {};
  class History {
    constructor(quill) { this.quill = quill; this.stack = { undo: [], redo: [] }; this.cutoffs = 0; }
    cutoff() { this.cutoffs++; }
    undo() {
      const change = this.stack.undo.pop();
      this.stack.redo.push(change.invert(this.quill.delta));
      this.quill.updateContents(change, 'user');
    }
    redo() {
      const change = this.stack.redo.pop();
      this.stack.undo.push(change.invert(this.quill.delta));
      this.quill.updateContents(change, 'user');
    }
  }
  class Quill {
    static import(name) { return name === 'delta' ? Delta : name === 'modules/history' ? History : { Attributor: class {}, Scope: {} }; }
    static register(name, value) { if (typeof name === 'string') registered[name] = value; }
    constructor() {
      this.delta = new Delta(note('Manual draft', 17).ops);
      this.root = { setAttribute() {}, addEventListener() {} };
      this.clipboard = { addMatcher() {} };
      this.listeners = {};
      this.history = new registered['modules/history'](this);
      this.selection = { index: 3, length: 2 };
    }
    on(name, handler) { this.listeners[name] = handler; }
    update() {}
    getContents() { return this.delta; }
    getLength() { return this.delta.length(); }
    getSelection() { return this.selection; }
    setSelection(index, length) { this.selection = { index, length }; }
    updateContents(change, source) {
      const old = this.delta;
      if (!this.history.restoring) this.history.stack.undo.push(change.invert(old));
      this.delta = old.compose(change);
      this.listeners['text-change'](change, old, source);
    }
  }
  const window = { NotebookModel: model, Quill };
  const selection = { value: '', selectedIndex: 0 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/notebook-editor.js'), 'utf8'), {
    window, document: { createElement: () => ({ querySelector: () => selection }) }, crypto: require('node:crypto'), Node: { ELEMENT_NODE: 1 }, queueMicrotask,
  });
  let changes = 0;
  const editor = new window.NotebookEditor.Editor({ replaceChildren() {} }, { getTime: () => 900, onChange: () => changes++ });
  const before = JSON.stringify(editor.snapshot());
  editor.appendValidatedBlocks(model.generatedBlocks(proposal()));
  assert.equal(changes, 1);
  assert.equal(editor.changing, false);
  assert.deepEqual(model.lines(editor.snapshot()).map(block => block.attributes.anchorSeconds), [17, undefined, 0, 45]);
  assert.deepEqual(editor.quill.selection, { index: 3, length: 2 });
  assert.equal(editor.quill.history.cutoffs, 2);
  assert.equal(editor.quill.history.stack.undo.length, 1);
  const appended = JSON.stringify(editor.snapshot());
  editor.quill.history.undo();
  assert.equal(JSON.stringify(editor.snapshot()), before);
  editor.quill.history.redo();
  assert.equal(JSON.stringify(editor.snapshot()), appended);
  editor.composing = true;
  assert.throws(() => editor.appendValidatedBlocks(model.generatedBlocks(proposal())), /composition/);
  editor.composing = false;
  editor.quill.updateContents = () => { throw new Error('Controlled editor error'); };
  assert.throws(() => editor.appendValidatedBlocks(model.generatedBlocks({ ...proposal(), id: 'p_22222222-2222-4222-8222-222222222222' })), /Controlled/);
  assert.equal(editor.changing, false);
});

test('player note jumps bypass resume heuristics and queue stable video identities', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const implementation = source.slice(source.indexOf('function playVideo('), source.indexOf('function nextIndex('));
  const requests = [];
  let controlsResets = 0;
  const context = vm.createContext({
    NotebookModel: model, requests, sessionGeneration: 7,
    current: { course: { id: 'course1', videos: [{ id: 'aqz-KE-bpKQ', durationSeconds: 120 }], completed: {}, positions: { 'aqz-KE-bpKQ': 90 } } },
    playerReady: true, player: {
      getVideoData: () => ({ video_id: 'other' }),
      loadVideoById: value => requests.push(value),
      cueVideoById: value => requests.push(value),
      setPlaybackRate() {},
    },
    safe: callback => callback(), saveCourses() {}, hideOverlays() {}, updateNowPlaying() {}, loadVideoExtras() {}, syncCourseUI() {},
    resetPlayerControls() { controlsResets++; },
    notebooks: { showVideo() {} }, videoChat: null, speedSel: {}, rowEls: [], posterTitle: {}, posterOverlay: { classList: { remove() {} } },
  });
  vm.runInContext('let pendingLoad = null;\n' + implementation + '\nplayVideo(0, {startSeconds: 0});', context);
  assert.equal(requests[0].startSeconds, 0);
  assert.equal(requests[0].videoId, 'aqz-KE-bpKQ');
  vm.runInContext('playerReady = false; playVideo(0, {startSeconds: 65});', context);
  const queued = vm.runInContext('pendingLoad', context);
  assert.equal(queued.videoId, 'aqz-KE-bpKQ');
  assert.equal(queued.startSeconds, 65);
  assert.equal(queued.generation, 7);
  assert.equal(controlsResets, 2);
});

test('note mode stays in Read through source-video binds until Edit is explicitly selected', async () => {
  const { controller, elementFor } = controllerFixture();
  controller.stateFor('course1', 'aqz-KE-bpKQ', { document: note(), revision: 1 });
  await controller.showVideo('course1', 'aqz-KE-bpKQ');
  await controller.showVideo('course1', 'aqz-KE-bpKQ');
  assert.equal(controller.mode, 'read');
  assert.equal(elementFor('#noteEditor').classList.contains('hidden'), true);
  assert.equal(elementFor('#noteRead').classList.contains('hidden'), false);
  controller.active = null;
  await controller.showVideo('course1', 'jNQXAC9IVRw');
  assert.equal(controller.mode, 'read');
  controller.reviewCourse = 'course1';
  await controller.selectVideo('aqz-KE-bpKQ', 'edit');
  assert.equal(controller.mode, 'edit');
  assert.equal(elementFor('#noteEditor').classList.contains('hidden'), false);
  await controller.showVideo('course1', 'jNQXAC9IVRw');
  assert.equal(controller.mode, 'edit');
  controller.renderDocuments = () => {};
  controller.selectVideo('');
  await controller.showVideo('course1', 'aqz-KE-bpKQ');
  assert.equal(controller.mode, 'read');
});

test('a delayed note load respects a newer Read selection', async () => {
  const { controller, elementFor } = controllerFixture();
  let finishLoad;
  controller.loadCourse = () => new Promise(resolve => { finishLoad = resolve; });
  const pending = controller.bind('course1', 'aqz-KE-bpKQ', elementFor('#courseNotesHost'), 'edit');
  controller.setMode('read');
  finishLoad();
  await pending;
  assert.equal(controller.mode, 'read');
  assert.equal(elementFor('#noteEditor').classList.contains('hidden'), true);
});

test('the notes toolbar button keeps native keyboard activation without controlling playback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const keyboard = source.slice(source.indexOf('/* keyboard shortcuts */'), source.indexOf("window.addEventListener('hashchange'"));
  let handler;
  let playbackToggles = 0;
  let prevented = false;
  vm.runInNewContext(keyboard, {
    document: { addEventListener: (_event, callback) => { handler = callback; } },
    current: {}, togglePlay: () => playbackToggles++,
  });
  const target = { tagName: 'BUTTON', closest: selector => selector.includes('.course-notes-toggle') ? {} : null };
  handler({ key: ' ', target, preventDefault: () => { prevented = true; } });
  assert.equal(playbackToggles, 0);
  assert.equal(prevented, false);
  handler({ key: ' ', target: { tagName: 'BODY', closest: () => null }, preventDefault: () => {} });
  assert.equal(playbackToggles, 1);
});

test('notes resizing clamps dimensions and preserves the active document and mode', () => {
  const { controller, elementFor, storage } = controllerFixture();
  const active = { document: note('Unchanged note') };
  controller.active = active;
  controller.setupPanelSize();
  const width = elementFor('#notesWidthHandle');
  const height = elementFor('#notesHeightHandle');
  const layout = elementFor('#studyLayout');
  width.listeners.pointerdown({ button: 0, pointerId: 1, clientX: 600, preventDefault() {} });
  width.listeners.pointermove({ pointerId: 1, clientX: -100 });
  width.listeners.pointerup({ pointerId: 1 });
  assert.equal(layout.style.getPropertyValue('--notes-width'), '564px');
  height.listeners.keydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.equal(layout.style.getPropertyValue('--notes-height'), '616px');
  assert.deepEqual(JSON.parse(storage.get('ft_notes_size')), { width: 564, height: 616 });
  assert.equal(controller.active, active);
  assert.equal(controller.mode, 'read');
  assert.equal(elementFor('body').classList.contains('notes-resizing-width'), false);
  width.listeners.keydown({ key: 'Home', preventDefault() {}, stopPropagation() {} });
  assert.equal(layout.style.getPropertyValue('--notes-width'), '300px');
  height.listeners.dblclick();
  assert.equal(layout.style.getPropertyValue('--notes-height'), '');
});

test('notes sizing restores valid device preferences without applying invalid values', () => {
  const { controller, elementFor, storage } = controllerFixture();
  storage.set('ft_notes_size', JSON.stringify({ width: 520, height: -1 }));
  controller.setupPanelSize();
  const layout = elementFor('#studyLayout');
  assert.equal(layout.style.getPropertyValue('--notes-width'), '520px');
  assert.equal(layout.style.getPropertyValue('--notes-height'), '');
  assert.equal(elementFor('#notesWidthHandle').attributes['aria-valuemax'], '564');
});

test('the toolbar Notes toggle preserves the document, mode, and size preferences', () => {
  const { controller, elementFor, storage } = controllerFixture();
  const active = { document: note('Keep this note') };
  controller.active = active;
  storage.set('ft_notes_size', JSON.stringify({ width: 460, height: 520 }));
  controller.setupPanelSize();
  const pane = elementFor('#courseNotesHost');
  const toggle = elementFor('#courseNotesToggle');
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(toggle.attributes['aria-label'], 'Hide notes');
  toggle.listeners.click();
  assert.equal(pane.open, false);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(toggle.title, 'Show notes');
  toggle.listeners.click();
  assert.equal(pane.open, true);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(controller.active, active);
  assert.equal(controller.mode, 'read');
  assert.deepEqual(JSON.parse(storage.get('ft_notes_size')), { width: 460, height: 520 });
  pane.open = false;
  pane.listeners.toggle();
  assert.equal(toggle.attributes['aria-expanded'], 'false');
});

test('joining paragraphs keeps the first surviving anchor and never invents unavailable times', () => {
  const before = { version: 1, ops: [...note('First', 10).ops, ...note('Second', 20, 'block-two').ops] };
  const joined = model.anchorChanges(before, { ops: [{ insert: 'FirstSecond\n' }] }, { ops: [{ retain: 5 }, { delete: 1 }] }, 100, () => 'fresh');
  assert.equal(model.lines(joined)[0].attributes.anchorSeconds, 10);
  const unanchored = model.anchorChanges(model.empty(), { ops: [{ insert: 'Offline thought\n' }] }, { ops: [{ insert: 'Offline thought' }] }, null, () => 'fresh');
  assert.equal(model.lines(unanchored)[0].attributes.anchorSeconds, undefined);
  assert.doesNotThrow(() => model.validate(unanchored));
});

test('replacing a paragraph retains its anchor and large edits avoid spread limits', () => {
  const replaced = model.anchorChanges(note('Old', 0), { ops: [{ insert: 'Replacement\n' }] }, { ops: [{ insert: 'Replacement' }, { delete: 3 }] }, 90, () => 'fresh');
  assert.equal(model.lines(replaced)[0].attributes.anchorSeconds, 0);
  assert.equal(model.lines(replaced)[0].attributes.blockId, 'block-one');
  const text = 'x'.repeat(180_000);
  const edited = model.anchorChanges(note(text, 5), { ops: [{ insert: text + '!\n' }] }, { ops: [{ retain: text.length }, { insert: '!' }] }, 90, () => 'fresh');
  assert.equal(model.lines(edited)[0].attributes.anchorSeconds, 5);
  const pasted = model.anchorChanges(note('Old', 5), { ops: [{ insert: 'Old paste\nNew line\n' }] }, { ops: [{ retain: 3 }, { insert: ' paste\nNew line' }] }, 90, () => 'fresh');
  assert.equal(model.lines(pasted)[1].attributes.anchorSeconds, 90);
});

test('Markdown preserves source links without visible timestamps or nested links', () => {
  const plain = model.markdown(note('A thought', 760), 'aqz-KE-bpKQ');
  assert.match(plain, /\[A thought\]\(https:\/\/www.youtube.com\/watch\?v=aqz-KE-bpKQ&t=760\)/);
  assert.doesNotMatch(plain, /12:40/);
  const linked = note('Read this', 5);
  linked.ops[0].attributes = { link: 'https://example.com/' };
  assert.match(model.markdown(linked, 'aqz-KE-bpKQ'), /\[Source\]/);
  const code = note('const answer = 42;', 5);
  code.ops[1].attributes['code-block'] = 'plain';
  assert.match(model.markdown(code, 'aqz-KE-bpKQ'), /```\nconst answer = 42;\n```\n\n\[Source\]/);
  const multiline = { version: 1, ops: [...code.ops, { insert: '\n', attributes: { 'code-block': true } }, { insert: 'return answer;' }, { insert: '\n', attributes: { blockId: 'code-two', anchorSeconds: 10, 'code-block': true } }] };
  assert.match(model.markdown(multiline, 'aqz-KE-bpKQ'), /```\nconst answer = 42;\n\nreturn answer;\n```/);
  assert.match(model.markdown(multiline, 'aqz-KE-bpKQ'), /\[Source 2\]/);
  const bold = note(' bold with spaces ', 0);
  bold.ops[0].attributes = { bold: true };
  assert.match(model.markdown(bold, 'aqz-KE-bpKQ'), / \*\*bold with spaces\*\* /);
});

test('autosave sends newer edits after an in-flight save without marking them saved early', async () => {
  const { controller } = controllerFixture();
  const state = controller.stateFor('course1', 'aqz-KE-bpKQ', { document: note('First'), revision: 1 });
  state.dirty = true;
  controller.keepDraft(state);
  let acknowledge;
  const requests = [];
  controller.request = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Promise(resolve => { acknowledge = resolve; });
    return { record: { revision: 3 } };
  };
  const pending = controller.save(state);
  state.document = note('Newer typing');
  state.sequence++;
  assert.equal(state.dirty, true);
  acknowledge({ record: { revision: 2 } });
  assert.equal(await pending, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].revision, 2);
  assert.equal(requests[1].document.ops[0].insert, 'Newer typing');
  assert.equal(state.dirty, false);
  assert.equal(state.revision, 3);
});

test('conflicting autosaves keep the draft and require explicit resolution', async () => {
  const { controller, storage } = controllerFixture();
  const state = controller.stateFor('course1', 'aqz-KE-bpKQ', { document: note('Local draft'), revision: 1 });
  state.dirty = true;
  controller.keepDraft(state);
  let requests = 0;
  controller.request = async () => {
    requests++;
    throw Object.assign(new Error('Conflict'), { status: 409, body: { record: { document: note('Remote draft'), revision: 2 }, notesRevision: 2 } });
  };
  assert.equal(await controller.save(state), false);
  assert.equal(await controller.save(state), false);
  assert.equal(requests, 1);
  assert.equal(state.document.ops[0].insert, 'Local draft');
  assert.equal(state.conflict.record.document.ops[0].insert, 'Remote draft');
  assert.equal(storage.size, 1);
});

test('confirmed append preserves the latest draft and mode, and retries a lost save without duplicate blocks', async () => {
  const { controller, storage } = controllerFixture();
  const draft = proposal();
  controller.options.getCourses = () => ({ course1: { videos: [{ id: draft.videoId }] } });
  const state = controller.stateFor('course1', draft.videoId, { document: note('Latest manual draft', 90), revision: 1 });
  controller.active = state;
  let appends = 0;
  let puts = 0;
  let renders = 0;
  controller.setMode = mode => { assert.equal(mode, 'read'); renders++; };
  controller.editor.quill = { update() {} };
  controller.editor.appendValidatedBlocks = blocks => {
    appends++;
    controller.change(model.validate({ version: 1, ops: [...state.document.ops, ...model.fromLines(blocks).ops] }));
  };
  controller.request = async (url, options) => {
    if (url.endsWith('/validate')) return { proposal: draft, noteRevision: 1 };
    puts++;
    if (puts === 1) throw new Error('Offline after submission');
    throw Object.assign(new Error('Lost receipt'), { status: 409, body: { record: { document: JSON.parse(options.body).document, revision: 2 } } });
  };
  const binding = { ownerId: 1, sourceGeneration: 'source', isCurrent: () => true };
  assert.equal((await controller.appendGeneratedNote(draft, binding)).saved, false);
  assert.equal(state.dirty, true);
  assert.equal(storage.size, 1);
  const [first, second] = await Promise.all([controller.appendGeneratedNote(draft, binding), controller.appendGeneratedNote(draft, binding)]);
  assert.equal(first.saved, true);
  assert.equal(second.saved, true);
  assert.equal(appends, 1);
  assert.equal(renders, 1);
  assert.equal(state.dirty, false);
  assert.equal(state.document.ops[0].insert, 'Latest manual draft');
  assert.equal(storage.size, 0);
  assert.equal(model.generatedStatus(state.document, draft), 'present');
  assert.equal((await controller.appendGeneratedNote(draft, binding)).saved, true);
  assert.equal(appends, 1);
});

test('an account mismatch is never accepted as an identical-document notebook conflict receipt', async () => {
  const { controller } = controllerFixture();
  const state = controller.stateFor('course1', 'aqz-KE-bpKQ', { document: null, revision: 1 });
  state.dirty = true;
  controller.request = async () => { throw Object.assign(new Error('Account changed'), { status: 409, body: { code: 'SESSION_CHANGED' } }); };
  assert.equal(await controller.save(state), false);
  assert.equal(state.dirty, true);
  assert.equal(state.revision, 1);
  assert.equal(state.conflict, null);
});

test('append blocks IME, conflict, quota, late source changes and manual edits made during preflight', async () => {
  for (const scenario of ['ime', 'conflict', 'quota', 'source', 'typing']) {
    const { controller } = controllerFixture();
    const draft = proposal();
    controller.options.getCourses = () => ({ course1: { videos: [{ id: draft.videoId }] } });
    const state = controller.stateFor('course1', draft.videoId, { document: note('Keep manual'), revision: 1 });
    controller.active = state;
    controller.editor.quill = { update() {} };
    controller.editor.appendValidatedBlocks = () => assert.fail('No insertion is permitted');
    controller.editor.composing = scenario === 'ime';
    if (scenario === 'conflict') state.conflict = {};
    let current = true;
    controller.request = async () => {
      if (scenario === 'quota') throw Object.assign(new Error('Notebook storage is full'), { status: 413 });
      if (scenario === 'source') current = false;
      if (scenario === 'typing') { state.sequence++; state.document = note('Newer manual'); }
      return { proposal: draft, noteRevision: 1 };
    };
    await assert.rejects(controller.appendGeneratedNote(draft, { ownerId: 1, sourceGeneration: 'source', isCurrent: () => current }));
    assert.equal(state.document.ops[0].insert, scenario === 'typing' ? 'Newer manual' : 'Keep manual');
    assert.equal(controller.mode, 'read');
  }
});

test('draft recovery compares server revisions and keeps zero-second anchors', () => {
  const { controller, storage } = controllerFixture();
  storage.set('ft_note_draft:1:course1:aqz-KE-bpKQ:test-tab', JSON.stringify({ document: note('Recovered', 0), revision: 1 }));
  const state = controller.stateFor('course1', 'aqz-KE-bpKQ', { document: note('Saved elsewhere', 50), revision: 2 });
  assert.equal(state.dirty, true);
  assert.equal(state.recovered, true);
  assert.equal(state.document.ops[1].attributes.anchorSeconds, 0);
  assert.equal(state.conflict.record.revision, 2);
});

test('notes save independently, reject stale writes, and retain deletion revisions', context => {
  const store = memoryStore(context);
  const user = profile(store);
  assert.equal(store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', null, 0).record, null);
  assert.equal(store.getNotebook(user.id, 'course1').records.length, 0);
  assert.equal(store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', note(), 0).record.revision, 1);
  assert.equal(store.saveNote(user.id, 'course1', 'jNQXAC9IVRw', note('Second'), 0).record.revision, 1);
  assert.equal(store.getUserData(user.id).revision, 1);
  assert.equal(store.getUserData(user.id).notesRevision, 2);
  assert.equal(store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', note('Stale'), 0).conflict, true);
  assert.equal(store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', null, 1).record.revision, 2);
  assert.equal(store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', note('Resurrect'), 1).conflict, true);
  assert.equal(store.getNotebooks(user.id).notebooks[0].count, 1);
});

test('notebooks remain private and survive course removal', context => {
  const store = memoryStore(context);
  const first = profile(store);
  const second = profile(store);
  store.saveNote(first.id, 'course1', 'aqz-KE-bpKQ', note('Private thought'), 0);
  assert.equal(store.getNotebook(second.id, 'course1').records.length, 0);
  store.saveUserData(first.id, { courses: {}, stats: {}, settings: {} }, 1);
  assert.equal(store.getNotebooks(first.id).notebooks[0].archived, true);
  assert.equal(store.saveNote(first.id, 'course1', 'aqz-KE-bpKQ', note('Archived edit'), 1).record.revision, 2);
  assert.throws(() => store.saveNote(first.id, 'course1', 'jNQXAC9IVRw', note(), 0));
  assert.equal(store.deleteNotebook(first.id, 'course1', 1), null);
  store.deleteNotebook(first.id, 'course1', 2);
  assert.equal(store.getNotebooks(first.id).notebooks.length, 0);
  assert.equal(store.saveNote(first.id, 'course1', 'aqz-KE-bpKQ', note('Stale'), 2).conflict, true);
});

test('full backups round-trip notebooks and reject stale restores without overwriting data', context => {
  const store = memoryStore(context);
  const user = profile(store);
  store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', note('Original', 760), 0);
  const exported = store.getExportData(user.id);
  assert.equal(exported.schemaVersion, 3);
  const imported = { ...exported, dailyActivity: [], watchHistory: [] };
  store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', note('Newer', 800), 1);
  assert.equal(store.importUserData(user.id, imported, 1, 1), null);
  assert.equal(store.getNotebook(user.id, 'course1').records[0].document.ops[0].insert, 'Newer');
  assert.equal(store.importUserData(user.id, imported, 1, 2), 2);
  const restored = store.getNotebook(user.id, 'course1').records[0];
  assert.equal(restored.document.ops[1].attributes.anchorSeconds, 760);
  assert.ok(restored.revision > 2);
  assert.equal(store.saveNote(user.id, 'course1', 'aqz-KE-bpKQ', note('Old tab'), 2).conflict, true);
  assert.equal(store.importUserData(user.id, { ...imported, notebooks: [] }, 2, 3), 3);
  assert.equal(store.getNotebooks(user.id).notebooks.length, 0);
});

test('notebook HTTP endpoints enforce authentication, validation, ownership, and revisions', async context => {
  const store = memoryStore(context);
  const user = profile(store);
  const other = profile(store);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').split('const cleanupTimer =')[0];
  vm.runInNewContext(source + '\nmodule.exports = app;', {
    module, console, URL, Buffer, __dirname: path.join(__dirname, '..'),
    process: { env: { PORT: String(server.address().port), ALLOWED_HOSTS: 'notebook.test', LOG_LEVEL: 'silent', APP_ENV: 'test' } },
    require(name) {
      if (name === './db') return store;
      if (name === './downloads') return { createDownloads: () => ({ router: express.Router() }) };
      if (name === './auth') return { createAuth: () => ({
        router: express.Router(),
        invitesRouter: express.Router(),
        optionalAuth(req, _res, next) { req.user = [user, other].find(owner => String(owner.id) === req.get('x-test-user')); next(); },
        requireAuth(req, res, next) { if (!req.user) return res.status(401).json({ error: 'Sign in' }); next(); },
        requireSession(req, res, next) { if (!req.user) return res.status(401).json({ error: 'Sign in' }); next(); },
        requireAdmin(req, res, next) { if (!req.user?.is_admin) return res.status(403).json({ error: 'Administrator required' }); next(); },
      }) };
      return name.startsWith('.') ? require(path.join(__dirname, '..', name)) : require(name);
    },
  });
  server.on('request', module.exports);
  const request = (endpoint, { owner = user.id, body, ...options } = {}) => fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    ...options, headers: { Origin: `http://127.0.0.1:${server.address().port}`, 'Content-Type': 'application/json', ...(owner ? { 'x-test-user': String(owner) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await request('/api/notebooks', { owner: null })).status, 401);
  const endpoint = '/api/notebooks/course1/videos/aqz-KE-bpKQ';
  assert.equal((await request(endpoint, { method: 'PUT', body: { document: note(), revision: 0 } })).status, 200);
  const conflict = await request(endpoint, { method: 'PUT', body: { document: note('Old'), revision: 0 } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).record.document.ops[0].insert, 'First thought');
  assert.equal((await (await request('/api/notebooks/course1', { owner: other.id })).json()).records.length, 0);
  assert.equal((await request(endpoint, { method: 'PUT', body: { document: note('Invalid', -10), revision: 1 } })).status, 400);
  assert.equal((await request(endpoint, { method: 'PUT', body: { document: note('x'.repeat(310 * 1024)), revision: 1 } })).status, 413);
  const exported = await (await request('/api/export')).json();
  assert.equal(exported.schemaVersion, 3);
  assert.equal((await request('/api/import?revision=1&notesRevision=0', { method: 'POST', body: exported })).status, 409);
  assert.equal((await request('/api/import?revision=1&notesRevision=1', { method: 'POST', body: exported })).status, 200);
  assert.equal((await request('/api/notebooks/course1?notesRevision=1', { method: 'DELETE' })).status, 409);
});