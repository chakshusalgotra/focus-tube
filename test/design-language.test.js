'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('email code boxes preserve six digits, leading zeroes, and native input semantics', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function parseEmailCode('), source.indexOf('function setupCodeInput('));
  const cells = Array.from({ length: 6 }, () => ({ classList: { toggle(name, value) { this[name] = value; } } }));
  const input = { value: '012345', maxLength: 6, selectionStart: 2, selectionEnd: 4, parentElement: { querySelectorAll: () => cells } };
  const context = vm.createContext({ input, document: { activeElement: input } });
  vm.runInContext(implementation, context);
  for (const [value, expected] of [['012345', '012345'], ['012 345', '012345'], ['012-345', '012345'], ['12345678', null], ['12x345', null], ['', null]]) {
    context.value = value;
    assert.equal(vm.runInContext('parseEmailCode(value)', context), expected);
  }
  vm.runInContext('syncCodeCells(input)', context);
  assert.equal(cells.map(cell => cell.textContent).join(''), '012345');
  assert.equal(cells[2].classList.active, true);
  assert.equal(cells.filter(cell => cell.classList.selected).length, 2);
  input.value = '';
  input.selectionStart = input.selectionEnd = 0;
  context.document.activeElement = null;
  vm.runInContext('syncCodeCells(input)', context);
  assert.equal(cells.every(cell => !cell.textContent && !cell.classList.active && !cell.classList.filled), true);
  const html = read('public/index.html');
  for (const kind of ['auth', 'enrollment']) {
    const markup = html.match(new RegExp(`<input id="${kind}Code"[^>]+>`))[0];
    assert.match(markup, /inputmode="numeric"/);
    assert.match(markup, /autocomplete="one-time-code"/);
    assert.match(markup, /pattern="\[0-9\]\{6\}" maxlength="6"/);
    assert.match(markup, /aria-describedby=/);
  }
  assert.match(read('public/styles.css'), /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
});

test('library status and duration reflect only current lessons and recorded playback', () => {
  const source = read('public/app.js');
  const formatting = source.slice(source.indexOf('function fmtLong('), source.indexOf('function nVideos('));
  const implementation = source.slice(source.indexOf('function summarizeCourse('), source.indexOf('function renderHome()'));
  const context = vm.createContext({});
  vm.runInContext(formatting + implementation, context);
  const course = { videos: [{ id: 'first', durationSeconds: 1200 }, { id: 'second', durationSeconds: 2400 }], completed: {}, positions: {}, lastVideoId: 'first' };
  const summarize = value => { context.course = value; return vm.runInContext('summarizeCourse(course)', context); };
  assert.equal(summarize(course).status, 'not-started', 'Opening a lesson is not recorded playback');
  assert.equal(summarize(course).duration, '1h 0m');
  assert.equal(summarize({ ...course, positions: { first: 0.5 } }).status, 'in-progress');
  assert.equal(summarize({ ...course, completed: { first: true } }).status, 'in-progress');
  assert.equal(summarize({ ...course, completed: { first: true, second: true } }).status, 'completed');
  assert.equal(summarize({ ...course, completed: { removed: true }, positions: { removed: 60 }, completedAt: 100 }).status, 'not-started');
  for (const position of [0, -1, NaN, Infinity, '20']) {
    assert.equal(summarize({ ...course, positions: { first: position } }).status, 'not-started');
  }
  const extended = { ...course, completed: { first: true, second: true }, videos: [...course.videos, { id: 'new', durationSeconds: 600 }] };
  assert.equal(summarize(extended).status, 'in-progress', 'New lessons reopen a completed course');
  assert.equal(summarize(extended).pct, 67);
  assert.equal(summarize({ videos: [] }).status, 'not-started');
  assert.equal(summarize({ videos: [] }).duration, 'Duration unavailable');
  assert.equal(summarize({ videos: [{ id: 'live', durationSeconds: 0 }] }).duration, 'Duration unavailable');
  for (const unknown of [undefined, 0, -60, Infinity, NaN, '1200']) {
    const partial = summarize({ videos: [course.videos[0], { id: 'unknown', durationSeconds: unknown }] });
    assert.equal(partial.duration, 'At least 20m');
    assert.equal(partial.knownDurations, 1);
  }
  assert.equal(summarize({ videos: [{ id: 'short', durationSeconds: 20 }] }).duration, '20s');
  assert.equal(summarize({ videos: [{ id: 'hour', durationSeconds: 7199 }] }).duration, '1h 59m');
});

test('library filtering combines status and bookmarks with stable ordering and counts', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('const LIBRARY_STATUSES ='), source.indexOf('function renderHome()'));
  const context = vm.createContext({ fmtLong: seconds => `${seconds}s` });
  vm.runInContext(implementation, context);
  context.courses = [
    { id: 'unstarted', addedAt: 3, videos: [{ id: 'first' }] },
    { id: 'partial', addedAt: 2, pinned: true, videos: [{ id: 'first' }], positions: { first: 20 } },
    { id: 'complete', addedAt: 4, pinned: true, videos: [{ id: 'first' }], completed: { first: true } },
    { id: 'later', addedAt: 5, videos: [{ id: 'first' }], positions: { first: 10 } },
  ];
  const original = JSON.stringify(context.courses);
  const select = (status, pinnedOnly) => {
    context.status = status;
    context.pinnedOnly = pinnedOnly;
    return JSON.parse(vm.runInContext('JSON.stringify(selectLibraryCourses(courses.map(summarizeCourse), status, pinnedOnly))', context));
  };
  assert.deepEqual(select('all', false).list.map(summary => summary.course.id), ['complete', 'partial', 'later', 'unstarted']);
  assert.deepEqual(select('in-progress', false).list.map(summary => summary.course.id), ['partial', 'later']);
  assert.deepEqual(select('in-progress', true).list.map(summary => summary.course.id), ['partial']);
  assert.deepEqual(select('all', true).counts, { all: 2, 'not-started': 0, 'in-progress': 1, completed: 1 });
  assert.deepEqual(select('not-started', true).list, []);
  assert.equal(JSON.stringify(context.courses), original, 'Filters do not mutate saved courses');
});

test('Grid and List replace the active board while old preferences and planning data remain safe', () => {
  const source = read('public/app.js');
  const html = read('public/index.html');
  const home = source.slice(source.indexOf('function renderHome()'), source.indexOf('function isCourseLink('));
  const implementation = source.slice(source.indexOf('function setHomeMode('), source.indexOf("$('#gridModeBtn').addEventListener"));
  const workspace = { board: { overrides: { 'c:course': 'custom' } }, sprints: { items: [{ id: 'saved' }] }, tasks: {} };
  const context = vm.createContext({ homeMode: 'grid', libraryStatus: 'in-progress', showPinnedOnly: true, workspace, scheduleRemoteSave() {}, renderHome() {} });
  vm.runInContext(implementation + '\nsetHomeMode("list");', context);
  assert.equal(context.homeMode, 'list');
  assert.equal(context.libraryStatus, 'in-progress');
  assert.equal(context.showPinnedOnly, true);
  vm.runInContext('setHomeMode("board");', context);
  assert.equal(context.homeMode, 'grid');
  assert.equal(context.workspace, workspace);
  const restore = source.match(/homeMode = settings\.homeMode[^;]+;/)[0];
  for (const saved of ['board', 'grid', 'list', null, 'unknown']) {
    context.settings = { homeMode: saved };
    vm.runInContext(restore, context);
    assert.equal(context.homeMode, saved === 'list' ? 'list' : 'grid');
  }
  assert.doesNotMatch(html, /id="(?:boardWrap|boardModeBtn|board|statusBoardBtn|sprintBoardBtn|newTaskBtn|addColumnBtn|sprintSetupBtn)"/);
  assert.match(html, /id="workspaceBoardBtn"[^>]*aria-disabled="true"[^>]*aria-label="Board, coming soon"/);
  assert.match(html, /id="listModeBtn"[^>]*aria-label="List view"/);
  assert.match(home, /selectLibraryCourses\(summaries, libraryStatus, showPinnedOnly\)/);
  assert.doesNotMatch(home, /renderBoard\(|boardMode/);
  assert.match(home, /el\('a', \{ class: 'card-title', href, title: c\.title \}/);
});

test('YouTube result types appear only for keyword input and clearing cancels search state', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function isCourseLink('), source.indexOf('function resetDiscovery()'));
  const classes = () => ({
    hidden: true,
    toggle(_name, hidden) { this.hidden = hidden; },
    add() { this.hidden = true; },
  });
  let aborted = false;
  const context = vm.createContext({
    urlInput: { value: '' }, addBtn: {}, importingLink: false, searchBusy: false, searchQuery: '',
    searchFilters: { classList: classes() }, searchSection: { classList: classes() },
    searchController: { abort() { aborted = true; } }, searchData: [{ id: 'old' }],
    searchResults: { replaceChildren() { this.empty = true; }, setAttribute(name, value) { this[name] = value; } },
    searchSummary: {}, searchError: { classList: classes() }, retrySearchBtn: { classList: classes() },
    libraryStatus: 'in-progress', showPinnedOnly: true,
  });
  vm.runInContext(implementation, context);
  for (const [value, visible, label] of [
    ['', false, 'Search'], ['   ', false, 'Search'], ['  Python course  ', true, 'Search'],
    ['https://www.youtube.com/watch?v=rfscVS0vtbw', false, 'Create course'],
    ['youtu.be/rfscVS0vtbw', false, 'Create course'], ['PL_course_navigation_check', false, 'Create course'],
  ]) {
    context.urlInput.value = value;
    vm.runInContext('updateDiscoveryControls();', context);
    assert.equal(context.searchFilters.classList.hidden, !visible, value);
    assert.equal(context.searchFilters.disabled, !visible, value);
    assert.equal(context.addBtn.textContent, label);
  }
  context.urlInput.value = 'Python';
  context.importingLink = true;
  vm.runInContext('updateDiscoveryControls();', context);
  assert.equal(context.searchFilters.classList.hidden, true);
  context.importingLink = false;
  context.searchBusy = true;
  vm.runInContext('clearCourseSearch({ clearInput: true });', context);
  assert.equal(aborted, true);
  assert.equal(context.searchController, null);
  assert.equal(context.searchBusy, false);
  assert.equal(context.searchResults.empty, true);
  assert.equal(context.searchFilters.classList.hidden, true);
  assert.equal(context.libraryStatus, 'in-progress');
  assert.equal(context.showPinnedOnly, true);
  assert.match(read('public/index.html'), /id="searchFilters" class="search-filters hidden"[^>]*disabled/);
});

test('the theme toggle sits beside streak and restores a valid choice before styles load', () => {
  const html = read('public/index.html');
  assert.match(html, /id="streakChip"[^]*?<\/button>\s*<button id="themeToggle"[^>]*aria-label="Dark mode"[^>]*aria-pressed="false"/);
  assert.ok(html.indexOf('<script src="theme.js"></script>') < html.indexOf('<link rel="stylesheet"'));
  const fixture = ({ saved = null, dark = false, blocked = false } = {}) => {
    const listeners = {};
    const root = { dataset: {} };
    const toggle = { setAttribute(name, value) { this[name] = value; }, addEventListener(name, callback) { this[name] = callback; } };
    const systemTheme = { matches: dark, addEventListener(_name, callback) { this.change = callback; } };
    let ready = false;
    let stored = saved;
    const context = vm.createContext({
      Event: class { constructor(type) { this.type = type; } },
      window: { matchMedia: () => systemTheme },
      localStorage: {
        getItem() { if (blocked) throw new Error('Storage blocked'); return stored; },
        setItem(key, value) { assert.equal(key, 'ft_theme'); if (blocked) throw new Error('Storage blocked'); stored = value; },
      },
      document: {
        documentElement: root, getElementById: () => ready ? toggle : null,
        addEventListener(name, callback) { listeners[name] = callback; }, dispatchEvent() {},
      },
    });
    vm.runInContext(read('public/theme.js'), context);
    const initial = root.dataset.theme;
    ready = true;
    listeners.DOMContentLoaded();
    return { root, toggle, systemTheme, initial, stored: () => stored };
  };
  const savedDark = fixture({ saved: '"dark"' });
  assert.equal(savedDark.initial, 'dark');
  assert.equal(savedDark.toggle['aria-pressed'], 'true');
  assert.equal(savedDark.toggle.title, 'Switch to light mode');
  savedDark.toggle.click();
  assert.equal(savedDark.root.dataset.theme, 'light');
  assert.equal(savedDark.stored(), '"light"');
  assert.equal(savedDark.toggle['aria-pressed'], 'false');
  assert.equal(savedDark.toggle['aria-label'], 'Dark mode');
  assert.equal(fixture({ saved: savedDark.stored(), dark: true }).initial, 'light');
  savedDark.toggle.click();
  assert.equal(savedDark.root.dataset.theme, 'dark');

  const automatic = fixture();
  assert.equal(automatic.initial, 'light');
  automatic.systemTheme.matches = true;
  automatic.systemTheme.change();
  assert.equal(automatic.root.dataset.theme, 'dark');
  automatic.toggle.click();
  automatic.systemTheme.change();
  assert.equal(automatic.root.dataset.theme, 'light', 'An explicit choice overrides the system preference');
  for (const saved of ['invalid JSON', '"unexpected"', 'true']) assert.equal(fixture({ saved, dark: true }).initial, 'dark');
  const blocked = fixture({ blocked: true });
  assert.doesNotThrow(() => blocked.toggle.click());
  assert.equal(blocked.root.dataset.theme, 'dark', 'Switching still works when storage is unavailable');
});

test('theme changes recolor existing dashboard charts without replacing their data', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function updateDashboardChartTheme()'), source.indexOf('function renderDashboardCharts('));
  const createChart = () => ({
    data: { datasets: [{ data: [12, 18] }, { data: [8, 10] }] },
    options: { plugins: { legend: { labels: {} } }, scales: { x: { ticks: {}, grid: {}, border: {}, title: {} }, y: { ticks: {}, grid: {}, border: {}, title: {} } } },
    updates: 0,
    update(mode) { assert.equal(mode, 'none'); this.updates++; },
  });
  const dailyChart = createChart();
  const courseChart = createChart();
  const data = dailyChart.data.datasets[0].data;
  let palette = { muted: '#a9adb3', line: '#3b3f43', green: '#7ed4ae', blue: '#9bc3df', bg: '#151617', teal: '#7edac2' };
  let onThemeChange;
  const context = vm.createContext({
    dailyChart, courseChart,
    document: { documentElement: {}, addEventListener(name, callback) { assert.equal(name, 'themechange'); onThemeChange = callback; } },
    getComputedStyle: () => ({ getPropertyValue: name => palette[name.slice(2)] || '#c4ca80' }),
  });
  vm.runInContext(implementation, context);
  onThemeChange();
  assert.equal(dailyChart.options.scales.x.ticks.color, palette.muted);
  assert.equal(dailyChart.options.scales.y.grid.color, palette.line);
  assert.equal(dailyChart.options.scales.y.title.color, palette.muted);
  assert.equal(dailyChart.data.datasets[0].backgroundColor, palette.green);
  assert.equal(courseChart.data.datasets[0].backgroundColor[0], palette.teal);
  assert.equal(courseChart.data.datasets[0].borderColor, palette.bg);
  assert.equal(courseChart.options.plugins.legend.labels.color, palette.muted);
  palette = { ...palette, bg: '#fafafa', muted: '#62676b' };
  onThemeChange();
  assert.equal(courseChart.data.datasets[0].borderColor, palette.bg);
  assert.equal(dailyChart.options.plugins.legend.labels.color, palette.muted);
  assert.equal(dailyChart.updates, 2);
  assert.equal(dailyChart.data.datasets[0].data, data);
  context.dailyChart = null;
  context.courseChart = null;
  assert.doesNotThrow(onThemeChange);
});

test('paused playback offers one consistent resume indicator without cover bars', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  const source = read('public/app.js');
  assert.match(html, /<button id="pauseOverlay"[^>]*type="button"[^>]*aria-label="Resume playback"/);
  assert.match(html, /class="pause-symbol"[^>]*aria-hidden="true"><span data-ui-icon="Play"/);
  assert.doesNotMatch(html, /class="pause-symbol"[^>]*>[^]*?data-ui-icon="Pause"/);
  const playerStyles = css.slice(css.indexOf('.pause-cover {'), css.indexOf('@container (max-width: 700px) {'));
  assert.match(playerStyles, /#ytWrap:has\(#controls\.controls-visible\) \.pause-symbol \{ opacity: 0; \}/);
  assert.match(css, /\.pause-cover\s*\{[^}]*place-items: center;[^}]*background: rgba\(0, 0, 0, 0\.18\)/);
  assert.doesNotMatch(html + css + source, /cover-bar|pause-hint|peekBtn|peekRestore|peek-restore|pause-cover\.peek/);
  const classes = new Set(['hidden']);
  const context = vm.createContext({ pauseOverlay: { classList: { remove: name => classes.delete(name) } } });
  const implementation = source.slice(source.indexOf('function showPauseCover()'), source.indexOf('function overlaysAllHidden()'));
  vm.runInContext(implementation + '\nshowPauseCover();', context);
  assert.equal(classes.has('hidden'), false);
});

test('player controls auto-hide without interrupting pointer, keyboard, or slider interactions', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('let controlsHideTimer ='), source.indexOf('function togglePlay()'));
  const classes = new Set();
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  let menuOpen = false;
  const target = (properties = {}) => ({
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    ...properties,
  });
  const control = { matches: () => true };
  const select = { tagName: 'SELECT', matches: () => false };
  const playerControls = target({
    offsetHeight: 92,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    contains: element => element === control || element === select,
    querySelector: () => menuOpen,
  });
  const playerPane = target({
    contains: element => element === control || element === select,
    getBoundingClientRect: () => ({ left: 0, right: 640, top: 0, bottom: 360 }),
  });
  const document = target();
  const window = target();
  const playBtn = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const context = vm.createContext({
    playerPane, playerControls, playBtn, I: { play: 'play', pause: 'pause' }, document, window, current: {},
    courseView: { classList: { contains: () => false } },
    YT: { PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5, ENDED: 0 } },
    safe: callback => callback(),
    setTimeout(callback, delay) { const timer = ++nextTimer; timers.set(timer, { at: clock + delay, callback }); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(implementation + '\nsetupPlayerControls();', context);
  const run = code => vm.runInContext(code, context);
  const visible = () => classes.has('controls-visible');
  const fire = (element, name, event = {}) => element.listeners[name]({ pointerType: 'mouse', clientX: 200, clientY: 100, ...event });
  const advance = milliseconds => {
    clock += milliseconds;
    for (const [timer, scheduled] of [...timers]) {
      if (scheduled.at <= clock && timers.delete(timer)) scheduled.callback();
    }
  };

  run('syncPlayerControls(1)');
  assert.equal(visible(), true);
  assert.equal(playBtn.innerHTML, 'pause');
  advance(2000);
  run('syncPlayerControls(3); syncPlayerControls(1)');
  advance(500);
  assert.equal(visible(), false, 'Buffering and repeat PLAYING events must not restart the preview');

  fire(playerPane, 'pointermove');
  assert.equal(visible(), true);
  advance(2500);
  assert.equal(visible(), false, 'A stationary pointer above the lower controls must not pin them');
  fire(playerPane, 'pointermove', { clientY: 340 });
  advance(3000);
  assert.equal(visible(), true, 'Hovering the lower region keeps controls available');
  fire(playerPane, 'pointerleave');
  assert.equal(visible(), false);
  run('syncPlayerControls(2)');
  assert.equal(playBtn.innerHTML, 'play', 'Polling must clear a stale pause icon even without a state callback');
  assert.equal(playBtn['aria-label'], 'Resume playback');
  fire(playerPane, 'pointerenter');
  fire(playerPane, 'pointerleave');
  assert.equal(visible(), false, 'Pausing must not pin controls after pointer exit');

  fire(playerPane, 'pointerdown', { target: control });
  fire(playerPane, 'focusin', { target: control });
  fire(playerPane, 'pointerleave');
  advance(3000);
  assert.equal(visible(), true, 'Dragging outside the player must keep the slider usable');
  fire(document, 'pointerup', { clientX: 700 });
  assert.equal(visible(), false, 'Mouse focus alone must not pin controls after release');

  fire(playerPane, 'focusin', { target: control });
  fire(playerPane, 'pointerleave');
  advance(3000);
  assert.equal(visible(), true, 'Keyboard focus keeps the controls visible');
  fire(playerPane, 'focusout', { relatedTarget: null });
  assert.equal(visible(), false);

  menuOpen = true;
  run('showPlayerControls()');
  advance(2500);
  assert.equal(visible(), true, 'A native select popup must not lose its control');
  menuOpen = false;
  advance(2500);
  assert.equal(visible(), false);

  fire(playerPane, 'pointerdown', { target: control, pointerType: 'touch' });
  fire(document, 'pointerup', { pointerType: 'touch' });
  fire(playerPane, 'pointerleave', { pointerType: 'touch' });
  assert.equal(visible(), true, 'Touch release must not hide the bar before click delivery');
  advance(2500);
  assert.equal(visible(), false, 'Touch use must not leave a permanent hover state');

  fire(playerPane, 'pointerdown', { target: select, pointerType: 'touch' });
  fire(playerPane, 'focusin', { target: select });
  fire(document, 'pointerup', { target: select, pointerType: 'touch' });
  fire(playerPane, 'pointerleave', { pointerType: 'touch' });
  advance(10000);
  assert.equal(visible(), true, 'A touched native select stays visible even without select:open support');
  fire(playerControls, 'change', { target: select });
  assert.equal(visible(), true, 'A completed touch selection retains the normal preview interval');
  advance(2500);
  assert.equal(visible(), false);
  fire(playerPane, 'pointerdown', { target: select, pointerType: 'touch' });
  fire(document, 'pointerup', { pointerType: 'touch' });
  fire(document, 'pointerdown', { target: {}, pointerType: 'touch' });
  assert.equal(visible(), false, 'Tapping outside clears a cancelled select interaction');
  fire(playerPane, 'pointerdown', { target: select, pointerType: 'touch' });
  fire(document, 'pointerup', { pointerType: 'touch' });
  fire(playerPane, 'focusout', { target: select, relatedTarget: null });
  assert.equal(visible(), false, 'Leaving select focus clears its hold');
  fire(playerPane, 'pointerdown', { target: { id: 'shield' }, pointerType: 'touch' });
  assert.equal(run('controlsRevealOnly'), true, 'The first surface tap reveals hidden controls without toggling playback');
  fire(playerPane, 'pointerdown', { target: { id: 'shield' }, pointerType: 'touch' });
  assert.equal(run('controlsRevealOnly'), false, 'A later surface tap can toggle playback');
  run('showPlayerControls(); resetPlayerControls()');
  assert.equal(visible(), false);
  assert.equal(timers.size, 0, 'Navigation and lesson changes cancel pending timers');
  run('syncPlayerControls(1)');
  assert.equal(visible(), true, 'A new lesson gets its own preview');
  context.current = null;
  run('resetPlayerControls(); showPlayerControls()');
  assert.equal(visible(), false);
  assert.match(source, /syncPlayerControls\(e\.data\)/);
  assert.match(source, /syncPlayerControls\(state\)/);
});

test('resuming through buffering removes the paused overlay immediately', () => {
  const source = read('public/app.js');
  const overlay = () => {
    const classes = new Set(['hidden']);
    return { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
  };
  const pauseOverlay = overlay();
  const posterOverlay = overlay();
  const playBtn = { dataset: {}, setAttribute() {} };
  const context = vm.createContext({
    pauseOverlay, posterOverlay, endedOverlay: overlay(), errorOverlay: overlay(),
    playBtn, I: { play: 'play', pause: 'pause' }, current: {}, controlsPlaybackStarted: false,
    YT: { PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, ENDED: 0, CUED: 5 } },
    endedTimer: null, endedHandled: false, clearInterval() {}, showPlayerControls() {}, applyCaptions() {}, populateQuality() {}, applyQuality() {},
  });
  const controls = source.slice(source.indexOf('function syncPlayerControls('), source.indexOf('function trackPlayerPointer('));
  const playback = source.slice(source.indexOf('function hideOverlays()'), source.indexOf('function onPlayerError()'));
  vm.runInContext(controls + playback, context);
  for (const state of [1, 2, 3, 1, 2, 1]) {
    vm.runInContext(`onPlayerState({ data: ${state} });`, context);
    assert.equal(pauseOverlay.classList.contains('hidden'), state !== 2);
    assert.equal(posterOverlay.classList.contains('hidden'), true);
    assert.equal(playBtn.innerHTML, state === 2 ? 'play' : 'pause');
  }
  let pauses = 0;
  let plays = 0;
  context.playerReady = true;
  context.safe = callback => callback();
  context.player = { getPlayerState: () => 3, pauseVideo: () => pauses++, playVideo: () => plays++ };
  const toggle = source.slice(source.indexOf('function togglePlay()'), source.indexOf('function seekBy('));
  vm.runInContext(toggle + '\ntogglePlay();', context);
  assert.equal(pauses, 1, 'The Pause action must also pause a buffering player');
  assert.equal(plays, 0);
});

test('full-frame start, end, and error actions stay above hidden media controls', () => {
  const html = read('public/index.html');
  assert.match(read('public/styles.css'), /\.overlay:not\(\.hidden\) ~ #controls\s*\{\s*visibility: hidden;/);
  for (const id of ['posterOverlay', 'endedOverlay', 'errorOverlay']) {
    assert.match(html, new RegExp(`id="${id}" class="overlay hidden"`));
  }
});

test('the light design uses local fonts and icons with unique accessible navigation targets', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /name="color-scheme" content="light dark"/);
  assert.match(css, /--teal:\s*#0e7566/);
  assert.match(css, /--ink:\s*#202124/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /#7c5cff|rgba\(124,\s*92,\s*255|font-size:[^;]*(?:vw|clamp)/);
  for (const section of ['library', 'roadmaps', 'notebooks', 'tasks', 'dashboard']) {
    assert.match(html, new RegExp(`data-section="${section}"[^>]*aria-label="[^"]+"`));
  }
  for (const file of [
    'node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2',
    'node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2',
    'node_modules/lucide/dist/umd/lucide.min.js',
  ]) assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file);
  for (const id of ['statsModal', 'profileModal', 'taskModal', 'sprintModal', 'roadmapModal', 'certModal']) {
    assert.match(html, new RegExp(`<dialog id="${id}"`));
  }
});

test('both theme palettes keep readable text and distinct interaction colors', () => {
  const css = read('public/styles.css');
  const root = css.match(/:root\s*\{([^}]+)\}/)[1];
  const dark = css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1];
  const colorsIn = source => Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[\da-f]{3,6});/gi)].map(match => [match[1], match[2]]));
  const luminance = hex => {
    const digits = hex.length === 4 ? hex.slice(1).split('').map(digit => digit + digit).join('') : hex.slice(1);
    const channels = digits.match(/../g).map(channel => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels.reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  };
  for (const [theme, colors] of [['light', colorsIn(root)], ['dark', { ...colorsIn(root), ...colorsIn(dark) }]]) {
    const contrast = (foreground, background) => {
      const values = [luminance(colors[foreground]), luminance(colors[background])].sort((first, second) => second - first);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    for (const surface of ['bg', 'panel', 'panel2', 'notes-bg', 'teal-light']) {
      for (const text of ['ink', 'muted', 'teal']) assert.ok(contrast(text, surface) >= 4.5, `${theme}: ${text} on ${surface}`);
      assert.ok(contrast('control-border', surface) >= 3, `${theme}: Control boundary on ${surface}`);
    }
    assert.notEqual(colors['teal-light'], colors['notes-bg'], `${theme}: Note body is distinct from its pane`);
    assert.ok(contrast('green', 'teal-light') >= 4.5, `${theme}: Note source links`);
    assert.ok(contrast('on-accent', 'teal') >= 4.5, `${theme}: Primary button label`);
    assert.ok(contrast('teal', 'teal-light') >= 4.5, `${theme}: Selected navigation label`);
    assert.ok(contrast('coral', 'coral-light') >= 4.5, `${theme}: Streak indicator`);
    assert.ok(contrast('player-muted', 'player-bg') >= 4.5, `${theme}: Player overlay text`);
  }
  assert.match(css, /\.workspace-rail\s*\{[^}]*background: var\(--panel2\)/);
  assert.match(css, /\.workspace-link\.active\s*\{[^}]*color: var\(--teal\)/);
  assert.match(css, /\.brand-dot\s*\{\s*color: var\(--coral\)/);
});

test('course note body has a distinct themed surface in both read and edit modes', () => {
  const css = read('public/styles.css');
  assert.match(read('public/index.html'), /id="noteEmpty" class="empty-state note-reader hidden"/);
  const surface = css.match(/\.course-notes \.note-editor \.ql-container\.ql-snow,\s*\.course-notes \.note-reader\s*\{([^}]+)\}/)[1];
  assert.match(surface, /background: var\(--teal-light\)/);
  assert.match(surface, /border: 0;/);
  assert.match(surface, /border-radius: var\(--radius-control\)/);
  assert.match(css, /\.course-notes \.note-editor \.ql-container\.ql-snow:focus-within\s*\{[^}]*outline: 2px solid var\(--teal\)/);
});

test('course controls leave no tool rail and keep one button for each action', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  const actions = html.match(/<div class="lesson-actions"[\s\S]*?<\/div>/)[0];
  assert.match(html, /id="brand"[^>]*href="#"[^>]*aria-label="FocusTube library"/);
  assert.deepEqual([...actions.matchAll(/<button id="([^"]+)"/g)].map(match => match[1]), ['npComplete', 'courseNotesToggle', 'videoChatBtn']);
  for (const id of ['sideToggle', 'npComplete', 'courseNotesToggle', 'videoChatBtn']) assert.equal(html.split(`id="${id}"`).length, 2, id + ' must be unique');
  assert.doesNotMatch(html + css, /courseNavigation|course-navigation/);
  assert.match(css, /:has\(> #courseView:not\(\.hidden\)\) \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /:has\(> #courseView:not\(\.hidden\)\) > #courseView \{ grid-column: 1 \/ -1;/);
  assert.match(css, /:has\(> #courseView:not\(\.hidden\)\) :is\(#workspaceRail,[^}]+display: none/);
  assert.match(css, /body\.side-collapsed #sidebar\s*\{\s*display: none/);
  assert.doesNotMatch(css, /side-collapsed #sidebar\s*\{[^}]*width: 64px|margin-left: 64px/);
  assert.match(html, /<aside id="sidebar"[\s\S]*id="courseContentClose"[\s\S]*id="videoList"/);
  assert.match(css, /--workspace-width: 176px/);
  assert.match(css, /\.workspace-open\.workspace-collapsed\s*\{\s*--workspace-width: 52px/);
  assert.match(html, /id="workspaceToggle"[^>]*aria-controls="workspaceNavigation"/);
  assert.match(html, /id="notesWidthHandle"[^>]*role="separator"[^>]*aria-orientation="vertical"/);
  assert.match(html, /id="notesHeightHandle"[^>]*role="separator"[^>]*aria-orientation="horizontal"/);
  assert.match(css, /var\(--notes-width, 38%\)/);
  assert.match(css, /var\(--notes-height,/);
});

test('workspace sidebar state persists independently of player panels and handles narrow screens', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function syncWorkspaceSidebar()'), source.indexOf('function setupWorkspaceSidebar()'));
  const classes = new Set(['side-collapsed']);
  let focusCount = 0;
  const button = { setAttribute(name, value) { this[name] = value; }, focus() { focusCount++; } };
  const backdrop = { setAttribute(name, value) { this[name] = value; }, classList: { toggle(_name, hidden) { this.hidden = hidden; } } };
  const tooltip = { classList: { add(name) { this.hidden = name === 'hidden'; } } };
  const rail = { contains: () => false, setAttribute(name, value) { this[name] = value; } };
  const courseView = { hidden: true, classList: { contains() { return courseView.hidden; } } };
  const content = [{ inert: false }, { inert: false }];
  const topbar = { inert: false };
  const saves = [];
  const context = vm.createContext({
    workspaceCollapsePreference: null, workspaceNarrowScreen: { matches: false }, authUser: { id: 1 },
    $: selector => ({ '#workspaceToggle': button, '#workspaceBackdrop': backdrop, '#workspaceRail': rail, '#workspaceTooltip': tooltip, '#courseView': courseView })[selector], icon: name => name,
    syncCourseContent() {},
    DB: { save: (key, value) => saves.push({ key, value }) },
    document: { body: { classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } }, querySelectorAll: selector => selector.includes('#topbar') ? [topbar, ...content] : content },
  });
  vm.runInContext(implementation + '\nsyncWorkspaceSidebar();', context);
  assert.equal(button['aria-expanded'], 'true');
  assert.equal(classes.has('side-collapsed'), true);
  vm.runInContext('setWorkspaceCollapsed(true);', context);
  assert.equal(classes.has('workspace-collapsed'), true);
  assert.equal(button['aria-label'], 'Expand workspace sidebar');
  assert.deepEqual(saves[0], { key: 'ft_workspace_collapsed', value: true });
  context.workspaceNarrowScreen.matches = true;
  vm.runInContext('setWorkspaceCollapsed(false);', context);
  assert.equal(content.every(element => element.inert), true);
  assert.equal(topbar.inert, false, 'The taskbar toggle remains usable while the lower drawer is open');
  assert.equal(backdrop.classList.hidden, false);
  assert.equal(focusCount, 1);
  courseView.hidden = false;
  vm.runInContext('syncWorkspaceSidebar();', context);
  assert.equal(button['aria-expanded'], 'false', 'Course entry suspends the workspace rail');
  assert.equal(content.every(element => !element.inert), true, 'A hidden workspace drawer cannot block the course');
  assert.equal(backdrop.classList.hidden, true);
  assert.equal(classes.has('workspace-drawer-open'), false);
  const savedCount = saves.length;
  vm.runInContext('setWorkspaceCollapsed(false);', context);
  assert.equal(saves.length, savedCount, 'Course controls must not write the workspace preference');
  assert.equal(button['aria-controls'], 'workspaceNavigation');
  assert.equal(backdrop.classList.hidden, true);
  assert.equal(content.every(element => !element.inert), true);
  assert.equal(classes.has('side-collapsed'), true, 'Rail changes must not open course content');
  assert.equal(context.workspaceCollapsePreference, false, 'Keep the workspace preference for other views');
  courseView.hidden = true;
  vm.runInContext('syncWorkspaceSidebar();', context);
  assert.equal(button['aria-controls'], 'workspaceNavigation');
  assert.equal(rail['aria-label'], 'Workspace');
  assert.equal(backdrop.classList.hidden, false);
  vm.runInContext('setWorkspaceCollapsed(true);', context);
  assert.equal(content.every(element => !element.inert), true);
  context.workspaceCollapsePreference = saves.at(-1).value;
  vm.runInContext('syncWorkspaceSidebar();', context);
  assert.equal(button['aria-expanded'], 'false');
  context.workspaceCollapsePreference = null;
  vm.runInContext('syncWorkspaceSidebar();', context);
  assert.equal(button['aria-expanded'], 'false');
  context.DB.save = () => { throw new Error('Storage unavailable'); };
  assert.doesNotThrow(() => vm.runInContext('setWorkspaceCollapsed(false);', context));
  context.authUser = null;
  vm.runInContext('syncWorkspaceSidebar();', context);
  assert.equal(content.every(element => !element.inert), true);
  assert.equal(backdrop.classList.hidden, true);
  assert.equal(tooltip.classList.hidden, true);
  assert.match(source, /window\.addEventListener\('resize', \(\) => \{ hideTooltip\(\); syncWorkspaceSidebar\(\); \}\)/);
});

test('taskbar toggles precede the brand while the collapsed workspace keeps its icons', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  assert.match(css, /padding: 0 var\(--taskbar-inset\)/);
  assert.match(css, /\.taskbar-main > :is\(#workspaceToggle, #sideToggle\) \{ translate: calc\(26px - var\(--taskbar-inset\) - 50%\) 0; \}/);
  const header = html.match(/<header id="topbar"[\s\S]*?<\/header>/)[0];
  const rail = html.match(/<aside id="workspaceRail"[\s\S]*?<\/aside>/)[0];
  const main = header.split('id="headerNavActions"')[0];
  const navigation = header.split('id="headerNavActions"')[1];
  assert.match(main, /class="taskbar-main"[\s\S]*id="brand"[\s\S]*class="brand-wordmark"[\s\S]*id="streakChip"[\s\S]*id="profileBtn"/);
  assert.doesNotMatch(rail, /id="(?:brand|workspaceToggle)"/);
  assert.equal(html.split('id="workspaceToggle"').length, 2);
  assert.match(main, /id="workspaceToggle"[\s\S]*id="sideToggle"[\s\S]*id="brand"/);
  assert.doesNotMatch(html + css, /courseBrand|course-brand/);
  assert.match(css, /@media \(max-width: 360px\) \{\s*#topbar \.brand-wordmark \{ display: none;/);
  assert.equal([...css.matchAll(/brand-wordmark\s*\{/g)].length, 1, 'Only the narrow taskbar hides the wordmark');
  assert.match(css, /\.workspace-backdrop \{[^}]*position: absolute;[^}]*grid-row: 2;/);
  assert.match(css, /\.workspace-collapsed \.workspace-link \{[^}]*width: 44px;/);
  assert.match(css, /\.workspace-collapsed \.workspace-rail :is\([^}]*\.nav-text[^}]*display: none;/);
  assert.match(main, /id="sideToggle"[^>]*aria-controls="sidebar"[\s\S]*id="brand"/);
  assert.match(main, /id="brand"[\s\S]*id="courseHeading"[\s\S]*id="courseDuration"[\s\S]*id="streakChip"/);
  assert.match(navigation, /id="backBtn"[^>]*aria-label="Back to library"/);
  assert.doesNotMatch(navigation, /id="(?:sideToggle|courseHeading|courseNotesToggle|videoChatBtn)"/);
  assert.doesNotMatch(rail, /id="(?:sideToggle|courseNotesToggle|videoChatBtn)"/);
  assert.match(html, /id="courseNotesToggle"[^>]*aria-controls="courseNotesHost"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /<summary[^>]*id="courseNotesToggle"/);
  assert.match(css, /\.course-notes:not\(\[open\]\)\s*\{\s*display: none/);
  assert.match(css, /#topbar\s*\{[^}]*flex-direction: column/);
});

test('drawer keyboard navigation includes the relocated taskbar toggle', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function setupWorkspaceSidebar()'), source.indexOf('function updateWorkspaceNav()'));
  const listeners = {};
  let open = true;
  const document = { activeElement: null, body: { classList: { contains: name => name === 'workspace-drawer-open' && open } }, addEventListener: (name, handler) => { listeners[name] = handler; } };
  const control = () => ({ addEventListener() {}, getClientRects: () => [{}], focus() { document.activeElement = this; }, closest: () => null });
  const toggle = control();
  const first = control();
  const last = control();
  const rail = { addEventListener() {}, querySelectorAll: () => [first, last] };
  const tooltip = { classList: { add() {} } };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, workspaceNarrowScreen: { addEventListener() {} },
    $: selector => ({ '#workspaceRail': rail, '#workspaceToggle': toggle, '#workspaceTooltip': tooltip, '#workspaceBackdrop': control() })[selector],
    syncWorkspaceSidebar() {}, setWorkspaceCollapsed: collapsed => { open = !collapsed; },
  });
  vm.runInContext(implementation + '\nsetupWorkspaceSidebar();', context);
  const press = (key, shiftKey = false) => listeners.keydown({ key, shiftKey, target: document.activeElement, preventDefault() {}, stopPropagation() {} });
  toggle.focus(); press('Tab'); assert.equal(document.activeElement, first);
  press('Tab'); assert.equal(document.activeElement, last);
  press('Tab'); assert.equal(document.activeElement, toggle);
  press('Tab', true); assert.equal(document.activeElement, last);
  press('Escape'); assert.equal(open, false); assert.equal(document.activeElement, toggle);
});

test('Notes and Ask sit beside completion with accessible icons and no AI workflow', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  const source = read('public/app.js');
  assert.match(html, /class="lesson-actions"[^>]*aria-label="Lesson actions"/);
  assert.match(html, /id="videoChatBtn"[^>]*aria-disabled="true"[^>]*aria-label="Ask about video, coming soon"/);
  assert.match(html, /id="videoChatBtn"[^>]*><span data-ui-icon="Sparkles"/);
  assert.match(html, /class="coming-soon">Coming soon/);
  assert.match(source, /\$\('#videoChatBtn'\)\.addEventListener\('click', event => \{ event\.preventDefault\(\); event\.stopPropagation\(\); \}\)/);
  assert.doesNotMatch(source, /fetch\([^\n]*(?:transcript|\/chat)/);
  assert.match(html, /id="workspaceTooltip"[^>]*role="tooltip"/);
  assert.match(css, /\.lesson-actions \.icon-btn::after \{ content: attr\(title\);/);
  assert.match(css, /\.lesson-actions #npComplete \{ width: 148px;/);
  assert.match(css, /@container \(max-width: 600px\) \{\s*\.now-playing \{ flex-direction: column;/);
});

test('only the taskbar refresh is removed, without leaving startup handlers behind', () => {
  const html = read('public/index.html');
  const source = read('public/app.js');
  assert.doesNotMatch(html + source + read('public/styles.css'), /resyncBtn/);
  assert.match(html, /id="sideRefresh"/);
  assert.match(source, /sideRefreshBtn\.addEventListener\('click', \(\) => syncCourse\(\)\)/);
});

test('playlist collapse state and accessible button labels stay in sync', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function setPlaylistCollapsed('), source.indexOf('async function openCourse('));
  const classes = {};
  const button = { setAttribute(name, value) { this[name] = value; } };
  const context = vm.createContext({
    sideToggle: button, icon: name => name,
    $: () => ({ contains: () => false }), syncCourseContent() {}, saveCourseLayout() {},
    document: { body: { classList: { toggle(name, value) { classes[name] = value; } } } },
  });
  vm.runInContext(implementation, context);
  for (const collapsed of [true, false, true]) {
    vm.runInContext(`setPlaylistCollapsed(${collapsed})`, context);
    assert.equal(classes['side-collapsed'], collapsed);
    assert.equal(button['aria-expanded'], String(!collapsed));
    assert.equal(button['aria-label'], collapsed ? 'Show course content' : 'Hide course content');
    assert.equal(button.title, button['aria-label']);
    assert.equal(button.innerHTML, collapsed ? 'PanelLeftOpen' : 'PanelLeftClose');
  }
  assert.match(source, /sideToggle\.addEventListener\('click', \(\) => \{[^]*?setPlaylistCollapsed\(collapsed\);[^]*?#courseContentClose/);
  assert.match(source, /else if \(k === '\['\) sideToggle\.click\(\)/);
});

test('course content overlays only narrow players and releases focus when dismissed', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function syncCourseContent()'), source.indexOf('async function openCourse('));
  const classes = new Set(['workspace-collapsed', 'side-collapsed']);
  const content = { inert: false };
  const backdrop = { classList: { toggle(_name, hidden) { this.hidden = hidden; } } };
  const sidebar = { contains: element => element === sidebar };
  const courseView = { hidden: false, classList: { contains() { return courseView.hidden; } } };
  let focusCount = 0;
  const context = vm.createContext({
    courseView, window: { innerWidth: 900 }, authUser: null, icon: name => name,
    sideToggle: { setAttribute() {}, focus() { focusCount++; } },
    $: selector => ({ '#courseContentBackdrop': backdrop, '#courseView .stage': content, '#sidebar': sidebar })[selector],
    document: { activeElement: sidebar, body: { classList: {
      contains: name => classes.has(name),
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
    } } },
  });
  vm.runInContext(implementation + '\nsetPlaylistCollapsed(false);', context);
  assert.equal(backdrop.classList.hidden, false);
  assert.equal(content.inert, true);
  assert.equal(classes.has('workspace-collapsed'), true, 'Opening course content must not expand the tool rail');
  vm.runInContext('setPlaylistCollapsed(true);', context);
  assert.equal(content.inert, false);
  assert.equal(backdrop.classList.hidden, true);
  assert.equal(focusCount, 1);
  context.window.innerWidth = 1440;
  vm.runInContext('setPlaylistCollapsed(false);', context);
  assert.equal(content.inert, false, 'Desktop keeps the player and notes interactive beside the lesson list');
  assert.equal(backdrop.classList.hidden, true);
  context.window.innerWidth = 375;
  vm.runInContext('syncCourseContent();', context);
  assert.equal(content.inert, true);
  courseView.hidden = true;
  vm.runInContext('syncCourseContent();', context);
  assert.equal(content.inert, false, 'Leaving the course must release the content overlay');
  assert.equal(backdrop.classList.hidden, true);
});

test('Notes owns mobile panel behavior after moving outside the workspace rail', () => {
  const source = read('public/app.js');
  const callback = source.match(/onPanelToggle: open => \{[^]*?\n  \},/)[0];
  const saved = [];
  const collapsed = [];
  let scrolled = 0;
  const layout = { clientWidth: 700 };
  const context = vm.createContext({
    saveCourseLayout: value => saved.push(value.notesOpen),
    setPlaylistCollapsed: (value, options) => collapsed.push({ value, remember: options.remember }),
    window: { innerWidth: 768 },
    $: selector => selector === '#studyLayout' ? layout : { scrollIntoView: () => scrolled++ },
  });
  vm.runInContext(`const options = { ${callback} }; options.onPanelToggle(true); options.onPanelToggle(false);`, context);
  assert.deepEqual(saved, [true, false]);
  assert.deepEqual(collapsed, [{ value: true, remember: false }]);
  assert.equal(scrolled, 1);
  context.window.innerWidth = 1440;
  layout.clientWidth = 1100;
  vm.runInContext('options.onPanelToggle(true);', context);
  assert.equal(collapsed.length, 1);
  assert.equal(scrolled, 1);
  assert.doesNotMatch(source.slice(source.indexOf('function setupWorkspaceSidebar()'), source.indexOf('function updateWorkspaceNav()')), /courseNotesToggle|#sideToggle/);
});

test('workspace navigation follows course, notebook, roadmap, task, and dashboard routes', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function updateWorkspaceNav()'), source.indexOf('function route()'));
  const links = ['library', 'roadmaps', 'notebooks', 'tasks', 'dashboard'].map(section => ({
    dataset: { section }, classList: { toggle() {} },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  }));
  const contextLabel = {};
  const classes = {};
  const context = vm.createContext({
    location: { hash: '' }, $: () => contextLabel,
    document: { querySelectorAll: () => links, body: { classList: { toggle: (name, value) => { classes[name] = value; } } } },
  });
  vm.runInContext(implementation, context);
  for (const [hash, section, title] of [
    ['', 'library', 'Library'], ['#c=python', 'library', 'Library'],
    ['#roadmaps', 'roadmaps', 'Roadmaps'], ['#roadmap=backend', 'roadmaps', 'Roadmaps'],
    ['#notebooks', 'notebooks', 'Notebooks'], ['#notebook=python', 'notebooks', 'Notebooks'],
    ['#tasks', 'tasks', 'Tasks'], ['#dashboard', 'dashboard', 'Dashboard'],
  ]) {
    context.location.hash = hash;
    vm.runInContext('updateWorkspaceNav()', context);
    assert.equal(links.filter(link => link['aria-current'] === 'page').length, 1);
    assert.equal(links.find(link => link['aria-current'])?.dataset.section, section);
    assert.equal(contextLabel.textContent, title);
    assert.equal(classes['roadmaps-open'], hash === '#roadmaps');
  }
});

test('the taskbar uses the current course title and total duration', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function renderSidebar('), source.indexOf('function syncCourseUI()'));
  const heading = {};
  const duration = { setAttribute(name, value) { this[name] = value; } };
  const course = { title: 'Distributed systems', videos: [{ durationSeconds: 600 }, { durationSeconds: 1200 }, {}] };
  const context = vm.createContext({
    course, sideTitle: {}, sideMeta: {}, videoListEl: { append() {} }, rowEls: [],
    $: selector => ({ '#courseHeading': heading, '#courseDuration': duration })[selector],
    el: () => ({}), I: { check: '' }, nVideos: count => `${count} lessons`,
    fmtLong: seconds => `${seconds / 60} min`, fmtDuration: seconds => String(seconds || 0), syncCourseUI() {},
  });
  vm.runInContext(implementation + '\nrenderSidebar(course);', context);
  assert.equal(heading.textContent, course.title);
  assert.equal(heading.title, course.title);
  assert.equal(duration.textContent, '30 min');
  assert.equal(duration['aria-label'], 'Total course duration: 30 min');
});

test('shared dialog commands open and close native dialogs without duplicate opens', () => {
  const source = read('public/app.js');
  const implementation = source.slice(source.indexOf('function showModal('), source.indexOf('function todayKey('));
  let openings = 0;
  const classes = new Set(['hidden']);
  const dialog = {
    open: false,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    showModal() { this.open = true; openings++; },
    close() { this.open = false; },
  };
  const context = vm.createContext({ $: () => dialog });
  vm.runInContext(implementation + '\nshowModal("profileModal"); showModal("profileModal");', context);
  assert.equal(openings, 1);
  assert.equal(classes.has('hidden'), false);
  vm.runInContext('hideModal("profileModal");', context);
  assert.equal(dialog.open, false);
  assert.equal(classes.has('hidden'), true);
});

test('task editing and course navigation expose native keyboard controls', () => {
  const source = read('public/app.js');
  const nodes = [];
  const context = vm.createContext({
    el(tag, attrs, ...children) { const node = { tag, ...attrs, children }; nodes.push(node); return node; },
    taskCheckButton: () => ({}), priorityPill: () => null, duePill: () => null, courseChipFor: () => null, I: { trash: '' },
  });
  vm.runInContext(source.slice(source.indexOf('function buildTaskRow('), source.indexOf('/* ---------- quick task panel')), context);
  vm.runInContext('buildTaskRow({ id: "task1", title: "Review notes", status: "todo" })', context);
  assert.ok(nodes.some(node => node.tag === 'button' && node.class === 'task-row-title' && node['aria-label'] === 'Edit Review notes'));
  for (const selector of ['roadmap-card', 'roadmap-course-main', 'dashboard-course']) {
    assert.match(source, new RegExp(`'a',\\s*\\{ class: '${selector}', href:`));
  }
  const html = read('public/index.html');
  assert.match(html, /<dialog id="taskPanel"[^>]*aria-labelledby="taskPanelTitle"/);
  assert.doesNotMatch(html + source, /taskPanelBackdrop/);
  assert.match(source, /if \(!taskPanel.open\) taskPanel.showModal\(\)/);
  assert.match(source, /if \(taskPanel.open\) taskPanel.close\(\)/);
});

test('chart equivalents retain data, safe text, headings, and empty states', () => {
  const source = read('public/app.js');
  let table;
  const context = vm.createContext({
    el: (tag, attrs, ...children) => ({ tag, ...attrs, children }),
    $: () => ({ replaceChildren(value) { table = value; } }),
  });
  vm.runInContext(source.slice(source.indexOf('function renderChartData('), source.indexOf('function renderDashboardCharts(')), context);
  vm.runInContext('renderChartData("data", "Watch time", ["Course", "Minutes"], [["<script>example</script>", 42]])', context);
  assert.equal(table.tag, 'table');
  assert.equal(table.children[0].tag, 'caption');
  assert.equal(table.children[1].children[0].children[0].scope, 'col');
  assert.equal(table.children[2].children[0].children[0].children[0], '<script>example</script>');
  assert.equal(table.children[2].children[0].children[1].children[0], '42');
  vm.runInContext('renderChartData("data", "Watch time", ["Course", "Minutes"], [])', context);
  assert.equal(table.children[2].children[0].children[0].children[0], 'No activity recorded.');
  for (const id of ['dailyChart', 'courseChart', 'monitoringTrafficChart', 'monitoringUsersChart']) {
    const canvas = read('public/index.html').match(new RegExp(`<canvas id="${id}"[^>]+>`))[0];
    assert.match(canvas, /role="img"/);
    assert.match(canvas, /aria-describedby=/);
  }
});

test('shared refinement uses modest corners and motion with accessible fallbacks', () => {
  const css = read('public/styles.css');
  assert.match(css, /body \{\s*margin: 0;\s*min-width: 0;/);
  assert.match(css, /--radius-small: 4px/);
  assert.match(css, /--radius-control: 6px/);
  assert.match(css, /--radius: 8px/);
  assert.match(css, /--motion-fast: 140ms/);
  assert.match(css, /--motion-normal: 220ms/);
  assert.match(css, /@keyframes surface-reveal/);
  assert.match(css, /@keyframes drawer-reveal/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^]*animation: none !important; transition: none !important/);
  assert.match(css, /@media \(forced-colors: active\)[^]*\.otp-ready input[^]*opacity: 1/);
  assert.match(css, /\.task-check \{ width: 44px; height: 44px; min-width: 44px/);
});

test('compact chrome reduces component footprint without shrinking text or touch targets', () => {
  const css = read('public/styles.css');
  assert.match(css, /:root\s*\{[^}]*--text-scale: 1;/);
  assert.match(css, /#topbar \{[^}]*min-height: 50px;/);
  assert.match(css, /\.taskbar-main \{[^}]*min-height: 50px;/);
  assert.match(css, /#topbar :is\(#tasksPanelBtn, #mobileLogoutBtn\), #topbar #headerNavActions \{ display: none;/);
  assert.match(read('public/index.html'), /href="#tasks"/);
  assert.match(read('public/index.html'), /class="workspace-footer"/);
  assert.match(css, /#sidebar \{\s*width: 224px; min-width: 224px;/);
  assert.match(css, /\.workspace-collapsed \.workspace-rail \{ padding-inline: 3px;/);
  assert.match(css, /min-resolution: 2dppx[^}]*--hairline: 0\.5px;/);
  assert.match(css, /prefers-contrast: more[^}]*--hairline: 1px;/);
  assert.match(css, /font: calc\(14px \* var\(--text-scale\)\)\/1\.5/);
  assert.match(css, /h1 \{ font-size: calc\(30px \* var\(--text-scale\)\)/);
  assert.match(css, /@media print\s*\{\s*:root \{ --text-scale: 1; \}/);
  assert.doesNotMatch(css, /\bzoom\s*:|transform:\s*scale\(0\.8\)|text-size-adjust:\s*none/);
  assert.match(css, /#controls \.icon-btn \{ width: 44px; height: 44px;/);
  const fontDeclarations = [...css.matchAll(/\b(?:font-size|font)\s*:\s*([^;{}]+)(?=;|})/g)].map(match => match[1]);
  assert.ok(fontDeclarations.every(value => !/\dpx\b/.test(value) || value.includes('--text-scale')), 'All fixed on-screen fonts use the shared text scale');
  assert.match(read('public/app.js'), /Chart\.defaults\.font\.size = 12 \* .*getPropertyValue\('--text-scale'\)/);
});

test('narrow notes keep formatting in one scrollable row with a native heading selector', () => {
  const css = read('public/styles.css');
  const start = css.indexOf('@container (max-width: 600px) {');
  const compact = css.slice(start, css.indexOf('@container (max-width: 760px) {', start));
  assert.match(css, /\.note-editor \{ container-type: inline-size; \}/);
  assert.match(compact, /\.ql-toolbar\.ql-snow \{ display: flex;[^}]*overflow-x: auto;/);
  assert.match(compact, /\.ql-formats \{ display: flex;[^}]*flex-shrink: 0; margin: 0;/);
  assert.match(compact, /select\.ql-header \{ display: block !important;/);
  assert.match(compact, /\.ql-picker \{ display: none;/);
  assert.match(compact, /:focus-visible \{ outline-offset: -2px;/);
  assert.match(css, /\.ql-toolbar button \{ width: 44px; height: 44px;/);
  assert.match(css, /\.ql-toolbar select\.ql-header \{ min-height: 44px;/);
  assert.match(css, /\.ql-toolbar button \{ display: grid; place-items: center;/);
  assert.match(css, /\.ql-toolbar button svg \{ width: 18px; height: 18px;/);
});

test('the native paragraph selector keeps a labeled value when editor focus leaves', () => {
  const source = read('public/notebook-editor.js');
  assert.match(source, /<option value="" selected>Normal<\/option>/);
  assert.match(source, /<option value="2">Heading 2<\/option>/);
  const start = source.indexOf('const headingSelect =');
  const implementation = source.slice(start, source.indexOf("this.quill.root.setAttribute('aria-label'", start));
  const heading = { value: '', selectedIndex: 0 };
  let sync;
  const quill = { on(event, handler) { assert.equal(event, 'editor-change'); sync = handler; } };
  vm.runInNewContext(`(function () { ${implementation} }).call({ quill });`, { quill, toolbar: { querySelector: () => heading } });
  heading.value = '3'; heading.selectedIndex = 2; sync();
  heading.value = ''; heading.selectedIndex = -1; sync();
  assert.equal(heading.value, '3');
  heading.value = ''; heading.selectedIndex = 0; sync();
  heading.selectedIndex = -1; sync();
  assert.equal(heading.value, '');
});

test('compact player controls remain reachable without wrapping outside the video', () => {
  const css = read('public/styles.css');
  const start = css.indexOf('@container (max-width: 480px) {\n  #controls');
  const compact = css.slice(start, css.indexOf('\n.icon-btn.active', start));
  assert.match(compact, /#controls \.btn-row \{[^}]*flex-wrap: nowrap; overflow-x: auto/);
  assert.match(compact, /#controls \.btn-row \.spacer \{ flex: 0 0 4px/);
  assert.match(compact, /flex-shrink: 0/);
  assert.doesNotMatch(compact, /display: none/);
  const touch = css.slice(css.indexOf('@media (pointer: coarse), (hover: none), (any-pointer: coarse) {'), css.indexOf('@media (prefers-contrast: more),'));
  assert.match(touch, /#controls \.icon-btn \{ width: 44px; height: 44px;/);
  assert.match(touch, /#controls #speedSel \{ width: 82px;/);
  assert.match(touch, /#controls #qualitySel \{ width: 96px;/);
  assert.match(touch, /#controls \.icon-btn > \* \{ pointer-events: none;/);
  assert.match(touch, /#controls \.btn-row \{ flex-wrap: nowrap; overflow-x: auto;/);
});

test('course layout defaults are closed and explicit choices persist per account and course', () => {
  const source = read('public/app.js');
  const stored = new Map();
  const context = vm.createContext({
    authUser: { id: 1 }, current: { course: { id: 'python' } }, courseLayouts: {},
    DB: { load: key => stored.get(key), save: (key, value) => stored.set(key, structuredClone(value)) },
  });
  vm.runInContext(source.slice(source.indexOf('function courseLayout('), source.indexOf('function setPlaylistCollapsed(')), context);
  assert.equal(vm.runInContext('courseLayout("python").notesOpen', context), false);
  assert.equal(vm.runInContext('courseLayout("python").contentCollapsed', context), true);
  vm.runInContext('saveCourseLayout({notesOpen: true, contentCollapsed: false}); courseLayouts = {};', context);
  assert.equal(vm.runInContext('courseLayout("python").notesOpen', context), true);
  assert.equal(vm.runInContext('courseLayout("python").contentCollapsed', context), false);
  assert.equal(vm.runInContext('courseLayout("sql").notesOpen', context), false);
  context.authUser = { id: 2 };
  context.courseLayouts = {};
  assert.equal(vm.runInContext('courseLayout("python").notesOpen', context), false);
  context.DB.save = () => { throw new Error('Storage unavailable'); };
  assert.doesNotThrow(() => vm.runInContext('saveCourseLayout({notesOpen: true})', context));
  assert.equal(vm.runInContext('courseLayout("python").notesOpen', context), true);
});

test('settings account drafts survive section changes and block accidental dismissal', () => {
  const source = read('public/app.js');
  const fields = { '#accountDisplayName': { value: 'Learner' }, '#accountUsername': { value: 'first.user' } };
  const context = vm.createContext({ $: selector => fields[selector], accountSnapshot: { displayName: 'Learner', username: 'first.user' }, accountSaveBusy: false, passwordSaveBusy: false, passwordDirty: () => false, confirm: () => false });
  vm.runInContext(source.slice(source.indexOf('function accountValues('), source.indexOf('function syncAccountForm(')), context);
  assert.equal(vm.runInContext('accountDirty()', context), false);
  fields['#accountUsername'].value = 'another.user';
  assert.equal(vm.runInContext('accountDirty()', context), true);
  assert.equal(vm.runInContext('confirmAccountDiscard()', context), false);
  context.confirm = () => true;
  assert.equal(vm.runInContext('confirmAccountDiscard()', context), true);
  context.accountSaveBusy = true;
  assert.equal(vm.runInContext('confirmAccountDiscard()', context), false);
  context.accountSaveBusy = false;
  context.passwordSaveBusy = true;
  assert.equal(vm.runInContext('confirmAccountDiscard()', context), false);
  context.passwordSaveBusy = false;
  context.passwordDirty = () => true;
  context.confirm = () => false;
  assert.equal(vm.runInContext('confirmAccountDiscard()', context), false);
  const sections = source.slice(source.indexOf('function selectSettingsSection('), source.indexOf('async function openProfile('));
  assert.doesNotMatch(sections, /fillAccountForm|\.reset\(/);
  const html = read('public/index.html');
  for (const section of ['Account', 'Appearance', 'Data', 'Policies', 'Admin']) {
    assert.match(html, new RegExp(`id="settings${section}"[^>]*role="tabpanel"[^>]*aria-labelledby="settings${section}Tab"`));
  }
  assert.doesNotMatch(html, /Pending publication/);
  for (const section of ['terms', 'privacy']) assert.match(html, new RegExp(`href="/policies.html#${section}" target="_blank" rel="noopener noreferrer"`));
});

test('public policies have separate terms and privacy sections without loading workspace or video scripts', () => {
  const html = read('public/policies.html');
  for (const section of ['terms', 'privacy', 'contact']) assert.match(html, new RegExp(`<section id="${section}"`));
  assert.match(html, /datetime="2026-09-15"/);
  assert.match(html, /salted scrypt hashes/);
  assert.match(html, /Changing your password revokes old sessions/);
  assert.doesNotMatch(html, /Pending publication|<iframe|src="(?:app|\/app|https:)/);
  assert.match(html, /<script src="\/theme.js"><\/script>/);
  let ready;
  const root = { dataset: {} };
  const context = vm.createContext({
    document: { documentElement: root, getElementById: () => null, dispatchEvent() {}, addEventListener(_name, callback) { ready = callback; } },
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }) },
    localStorage: { getItem: () => null }, Event: class {},
  });
  vm.runInContext(read('public/theme.js'), context);
  assert.doesNotThrow(() => ready());
  assert.equal(root.dataset.theme, 'dark');
});

test('password settings validate confirmation and clear secrets without resetting the workspace', () => {
  const source = read('public/app.js');
  const field = value => ({ value, message: '', setCustomValidity(message) { this.message = message; }, removeAttribute() {} });
  const current = field('current-password');
  const next = field('new-password');
  const confirmation = field('wrong-confirmation');
  const inputs = [current, next, confirmation];
  const form = { reset() {}, querySelectorAll: () => inputs };
  const context = vm.createContext({ $: selector => ({ '#passwordCurrent': current, '#passwordNew': next, '#passwordConfirmation': confirmation, '#passwordForm': form })[selector] });
  vm.runInContext(source.slice(source.indexOf('function passwordDirty('), source.indexOf('function syncPasswordForm(')), context);
  vm.runInContext('validatePasswordFields()', context);
  assert.equal(confirmation.message, 'Passwords do not match.');
  next.value = current.value;
  confirmation.value = next.value;
  vm.runInContext('validatePasswordFields()', context);
  assert.equal(next.message, 'Choose a different password.');
  assert.equal(confirmation.message, '');
  assert.equal(vm.runInContext('passwordDirty()', context), true);
  vm.runInContext('clearPasswordFields()', context);
  assert.equal(inputs.every(input => input.value === '' && input.message === ''), true);
  assert.equal(vm.runInContext('passwordDirty()', context), false);
  context.dialog = {};
  context.confirmAccountDiscard = () => false;
  current.value = 'unsaved-password';
  vm.runInContext(source.match(/dialog\.confirmClose = \(\) => \{[^]*?\n  \};/)[0], context);
  assert.equal(context.dialog.confirmClose(), false);
  assert.equal(current.value, 'unsaved-password');
  context.confirmAccountDiscard = () => true;
  assert.equal(context.dialog.confirmClose(), true);
  assert.equal(current.value, '', 'Approved close clears secrets before the deferred dialog close event');
  const implementation = source.slice(source.indexOf('function setupPasswordSettings('), source.indexOf('function setupGlassReflection('));
  assert.match(implementation, /api\('\/api\/auth\/password'/);
  assert.match(implementation, /finally[^]*clearPasswordFields\(\)/);
  assert.doesNotMatch(implementation, /localStorage|sessionStorage|DB\.save|finishAuth\(/);
  const html = read('public/index.html');
  for (const [id, autocomplete] of [['passwordCurrent', 'current-password'], ['passwordNew', 'new-password'], ['passwordConfirmation', 'new-password']]) {
    assert.match(html, new RegExp(`id="${id}" type="password" autocomplete="${autocomplete}" minlength="8" maxlength="128" required`));
  }
});

test('glass reflection coalesces pointer work and stops when idle, hidden, or reduced', () => {
  const source = read('public/app.js');
  const handlers = {};
  const frames = new Map();
  const timers = new Map();
  const media = [];
  const classes = new Set();
  let sequence = 0;
  let paints = 0;
  const properties = {};
  const surface = { classList: { add: name => classes.add(name), remove: name => classes.delete(name) }, style: { setProperty(name, value) { paints++; properties[name] = value; } },
    getBoundingClientRect: () => ({ left: 0, top: 0 }), contains: target => target === surface };
  const context = vm.createContext({
    appearance: { reflection: true, reduceTransparency: false },
    matchMedia(query) { const value = { matches: query.includes('pointer: fine'), addEventListener() {} }; media.push(value); return value; },
    document: { hidden: false, addEventListener: (name, handler) => { handlers[name] = handler; } }, window: { addEventListener() {} },
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source.slice(source.indexOf('function setupGlassReflection('), source.indexOf('let monitoringPage =')), context);
  vm.runInContext('setupGlassReflection()', context);
  const move = (onGlass = true) => handlers.pointermove({ target: { closest: selector => {
    assert.equal(selector, '[data-glass]');
    return onGlass ? surface : null;
  } }, pointerType: 'mouse', clientX: 40, clientY: 10 });
  move(); move(); move();
  assert.equal(frames.size, 1);
  const frame = [...frames.values()][0]; frames.clear(); frame();
  assert.equal(paints, 1);
  assert.equal(properties['--reflection-position'], '43.5px');
  assert.equal(classes.has('glass-tracking'), true);
  [...timers.values()][0]();
  assert.equal(classes.size, 0);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  move(false);
  assert.equal(frames.size, 0, 'Main pages, cards, dialogs and video do not activate the reflection');
  move();
  assert.equal(frames.size, 1);
  move(false);
  assert.equal(frames.size, 0, 'Entering main content cancels queued navigation reflection');
  assert.equal(timers.size, 0);
  media[1].matches = true;
  move();
  assert.equal(frames.size, 0);
  media[1].matches = false;
  context.document.hidden = true;
  move();
  assert.equal(frames.size, 0);
  const html = read('public/index.html');
  assert.equal((html.match(/\sdata-glass(?=[ >])/g) || []).length, 3);
  assert.doesNotMatch(html.match(/<details id="courseNotesHost"[^>]*>/)[0], /data-glass| open/);
  assert.match(source, /closest\('\[data-glass\]'\)/);
});

test('the original glass sheen is confined to navigation without cursor effects on content', () => {
  const css = read('public/styles.css');
  const html = read('public/index.html');
  assert.match(css, /--glass-reflection: rgba\(255, 255, 255, 0\.75\)/);
  assert.match(css, /--glass-reflection: rgba\(220, 235, 244, 0\.12\)/);
  assert.match(css, /\[data-glass\]::before \{[^}]*background: linear-gradient\(110deg/);
  assert.match(css, /\[data-glass\]\.glass-tracking::before \{ opacity: 1; \}/);
  assert.doesNotMatch(css, /--reflection-(?:blue|teal|x|y|scroll)|radial-gradient\(circle/);
  assert.doesNotMatch(css, /:is\([^\n]*main[^\n]*\)::before/);
  for (const selector of ['id="topbar"', 'id="workspaceRail"', 'class="settings-nav"']) {
    assert.match(html, new RegExp(selector + '[^>]*data-glass'));
  }
  assert.doesNotMatch(css, /(?:main|\.course-card|\.roadmap-card)[^{\n]*\{[^}]*backdrop-filter/);
});