'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const express = require('express');
const { createObservability } = require('../observability');

function fixture(environment = {}) {
  const lines = [];
  const monitor = createObservability({ environment: { APP_ENV: 'test', ...environment }, collectRuntime: false,
    destination: { write(chunk) { lines.push(JSON.parse(chunk)); } } });
  return { monitor, lines };
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = true;
  res.setHeader = () => {};
  return res;
}

test('request monitoring counts once and logs only safe templates and generated identifiers', async () => {
  const { monitor, lines } = fixture();
  const req = { method: 'GET', baseUrl: '', route: { path: '/api/notebooks/:courseId' },
    url: '/api/notebooks/private-course?token=SECRET_QUERY', headers: { cookie: 'SECRET_COOKIE', authorization: 'SECRET_AUTH' },
    body: { password: 'SECRET_PASSWORD', email: 'private@example.com' }, user: { id: 345 } };
  const res = response();
  monitor.middleware(req, res, () => {});
  res.emit('finish');
  res.emit('close');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].route, '/api/notebooks/:courseId');
  assert.match(lines[0].requestId, /^[a-f0-9-]{36}$/);
  const output = JSON.stringify(lines) + await monitor.registry.metrics();
  for (const secret of ['SECRET_', 'private-course', 'private@example.com', '"user":', '"body":']) assert.equal(output.includes(secret), false, secret);
  const counters = await monitor.registry.getSingleMetric('focustube_http_requests_total').get();
  assert.equal(counters.values[0].value, 1);
  assert.equal((await monitor.registry.getSingleMetric('focustube_http_inflight').get()).values[0].value, 0);
});

test('forum route metrics use templates without leaking report content or account details', async () => {
  const { monitor, lines } = fixture();
  for (const [baseUrl, route] of [['/api/feedback', '/:id/replies'], ['/api/admin/feedback', '/:id']]) {
    const req = { method: 'POST', baseUrl, route: { path: route }, url: '/PRIVATE_ID?q=PRIVATE_QUERY',
      headers: { cookie: 'PRIVATE_COOKIE' }, body: { title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY', email: 'private@example.test' } };
    const res = response(); monitor.middleware(req, res, () => {}); res.emit('finish');
    assert.equal(lines.at(-1).route, baseUrl + route);
  }
  monitor.observe('feedback', 'success');
  const output = JSON.stringify(lines) + await monitor.registry.metrics();
  assert.doesNotMatch(output, /PRIVATE_|private@example\.test/);
  assert.match(output, /feedback/);
});

test('aborts, unknown paths, unusual methods and health probes have bounded labels', async () => {
  const { monitor, lines } = fixture();
  for (const req of [{ method: 'SECRET_METHOD', url: '/SECRET_PATH', headers: {} },
    { method: 'GET', url: '/api/health', route: { path: '/api/health' }, headers: {} }]) {
    const res = response();
    monitor.middleware(req, res, () => {});
    res.writableFinished = false;
    res.emit('close');
    res.emit('finish');
  }
  assert.equal(lines[0].route, 'unmatched');
  assert.equal(lines[0].method, 'OTHER');
  assert.equal(lines[0].status, 499);
  assert.equal(monitor.snapshot().traffic.reduce((sum, point) => sum + point.requests, 0), 1);
  assert.equal((await monitor.registry.metrics()).includes('SECRET_'), false);
});

test('metric access is disabled by default and requires private host, address, and independent bearer token', () => {
  const token = 'A'.repeat(43);
  const request = { method: 'GET', headers: { host: 'metrics.focustube.internal', authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(fixture().monitor.metricsAuthorized(request), false);
  const { monitor } = fixture({ METRICS_TOKEN: token });
  assert.equal(monitor.metricsAuthorized(request), true);
  for (const headers of [{ host: 'localhost:3002' }, { authorization: 'Bearer wrong' }, { origin: 'http://localhost:3002' }, { 'x-forwarded-for': '127.0.0.1' }]) {
    assert.equal(monitor.metricsAuthorized({ ...request, headers: { ...request.headers, ...headers } }), false);
  }
  assert.equal(monitor.metricsAuthorized({ ...request, socket: { remoteAddress: '192.168.1.2' } }), false);
  monitor.observe('smtp', 'failed', 1);
  monitor.observe('SECRET_EVENT', 'failed', 1);
  assert.throws(() => fixture({ METRICS_TOKEN: 'short' }), /METRICS_TOKEN/);
});

test('analytics client rejects stale preferences and clears collection state across account changes', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, replaceChildren() {} });
    return elements.get(id);
  };
  const account = { id: 1, generation: 1, isAdmin: false, isGuest: false };
  const requests = [];
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, AbortController, AbortSignal, setTimeout, clearTimeout,
    document: { hidden: true, getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    fetch(url) { return new Promise(resolve => requests.push({ url, resolve })); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/analytics.js'), 'utf8'), context);
  const ui = new window.ProductAnalytics({ getAccount: () => account, el() {}, chartTable() {} });
  const respond = (request, data, owner = '1') => request.resolve({ ok: true, status: 200,
    headers: { get: () => owner }, json: async () => data });
  ui.configure();
  const latest = ui.loadPreference();
  respond(requests[1], { available: true, consent: true, excluded: false, notice: '2026-09-28' });
  await latest;
  assert.equal(ui.collecting, true);
  respond(requests[0], { available: true, consent: false, excluded: false, notice: '2026-09-28' });
  await new Promise(setImmediate);
  assert.equal(ui.collecting, true);
  const stale = ui.loadPreference();
  account.id = 2;
  account.generation++;
  ui.configure();
  assert.equal(ui.collecting, false);
  respond(requests[2], { available: true, consent: true, excluded: false });
  await stale;
  assert.equal(ui.collecting, false);
  respond(requests[3], { available: true, consent: false, excluded: false }, '2');
  await new Promise(setImmediate);
  ui.reset();
  assert.equal(ui.account, null);
  assert.equal(element('analyticsConsent').checked, false);
});

test('audience client retains drafts on version conflicts and requires refresh before retrying', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, replaceChildren() {} });
    return elements.get(id);
  };
  const account = { id: 1, generation: 1, isAdmin: false, isGuest: false };
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, AbortController, AbortSignal, setTimeout, clearTimeout, confirm: () => false,
    document: { hidden: true, getElementById: element, querySelectorAll: () => [], addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/analytics.js'), 'utf8'), context);
  const ui = new window.ProductAnalytics({ getAccount: () => account, el() {}, chartTable() {} });
  ui.account = account;
  ui.renderSurvey({ available: true, revision: 'first', notice: 'notice', state: 'answered', answers: { role: 'student', goal: null, source: null } });
  element('surveyRole').value = 'professional';
  ui.surveyDirty = true;
  ui.request = async () => { throw Object.assign(new Error('Survey changed'), { code: 'AUDIENCE_CHANGED' }); };
  await ui.changeSurvey('save');
  assert.equal(element('surveyRole').value, 'professional');
  assert.equal(element('surveySave').disabled, true);
  assert.equal(ui.confirmSurveyClose(), false);
  ui.request = async () => ({ available: true, revision: 'second', notice: 'notice', state: 'answered', answers: { role: 'other', goal: null, source: null } });
  await ui.loadSurvey();
  assert.equal(ui.survey.revision, 'second');
  assert.equal(element('surveyRole').value, 'professional');
  assert.equal(element('surveySave').disabled, false);
  ui.clearSurvey();
  assert.equal(element('surveyRole').value, '');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const signOut = app.slice(app.indexOf('async function signOut()'), app.indexOf("for (const selector of ['#logoutBtn'"));
  assert.ok(signOut.indexOf('confirmSurveyClose()') < signOut.indexOf("await api('/api/auth/logout'"));
});

test('analytics route metrics never include account identifiers or query contents', async () => {
  const { monitor, lines } = fixture();
  const req = { method: 'PUT', baseUrl: '/api/admin/analytics', route: { path: '/exclusions/:id' },
    url: '/exclusions/PRIVATE_ACCOUNT?query=PRIVATE_QUERY', headers: {}, body: { private: 'PRIVATE_BODY' } };
  const res = response();
  monitor.middleware(req, res, () => {});
  res.emit('finish');
  assert.equal(lines[0].route, '/api/admin/analytics/exclusions/:id');
  assert.doesNotMatch(JSON.stringify(lines) + await monitor.registry.metrics(), /PRIVATE_/);
});

test('foreground presence excludes guests, hidden tabs and idle sessions but permits active playback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const block = source.slice(source.indexOf('function hasLiveActivity()'), source.indexOf('function withdrawPresence()'));
  const context = { authUser: { id: 1, isGuest: false }, appBooted: true, document: { hidden: false }, lastInteractionAt: Date.now(),
    playerReady: false, current: null, safe: callback => callback(), player: { getPlayerState: () => 1 } };
  vm.runInNewContext(block, context);
  assert.equal(context.hasLiveActivity(), true);
  context.document.hidden = true;
  assert.equal(context.hasLiveActivity(), false);
  context.document.hidden = false;
  context.lastInteractionAt = 0;
  assert.equal(context.hasLiveActivity(), false);
  context.playerReady = true;
  context.current = {};
  assert.equal(context.hasLiveActivity(), true);
  context.authUser.isGuest = true;
  assert.equal(context.hasLiveActivity(), false);
});

test('admin monitoring uses a responsive wide dialog without changing other dialogs', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /#monitoringModal\s*\{\s*width:\s*min\(1080px, calc\(100% - 32px\)\)/);
  assert.match(css, /\.monitoring-table-wrap\s*\{\s*overflow-x:\s*auto/);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="monitoringModal"[^>]+aria-labelledby="monitoringTitle"/);
  assert.match(html, /id="monitoringBtn"[^>]+hidden/);
  for (const [section, panel] of [['Overview', 'Overview'], ['Members', 'MembersPanel'], ['Events', 'EventsPanel'], ['System', 'System']]) {
    assert.match(html, new RegExp(`id="monitoring${section}Tab"[^>]+role="tab"[^>]+aria-controls="monitoring${panel}"`));
    assert.match(html, new RegExp(`id="monitoring${panel}"[^>]+role="tabpanel"[^>]+aria-labelledby="monitoring${section}Tab"`));
  }
  assert.match(css, /\.admin-tabs\s*\{\s*display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /id="monitoringSearch"[^>]+type="search"[^>]+maxlength="100"/);
});

test('monitoring sections retain filters and only the latest open-view request can render', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: '', textContent: '', attributes: {},
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
        setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
        replaceChildren() {}, focus() { this.focused = true; } });
    }
    return nodes.get(id);
  };
  const tabs = ['overview', 'members', 'events', 'system'].map(section => {
    const tab = node(`tab-${section}`);
    tab.dataset = { monitoringSection: section };
    tab.setAttribute('aria-controls', `panel-${section}`);
    return tab;
  });
  const fields = Object.entries({ monitoringSearch: 'query', monitoringRole: 'role', monitoringActivity: 'activity', monitoringSort: 'sort', monitoringEventType: 'event', monitoringEventDays: 'days' })
    .map(([id, name]) => Object.assign(node(id), { name }));
  const requests = [];
  const renders = [];
  const context = vm.createContext({ AbortController, URLSearchParams, setTimeout, clearTimeout, renders,
    $: selector => node(selector.slice(1)), authUser: { id: 1, isAdmin: true }, sessionGeneration: 1,
    document: { hidden: false, querySelectorAll: selector => selector === '[data-monitoring-section]' ? tabs : fields },
    api(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); },
  });
  vm.runInContext(source.slice(source.indexOf('let monitoringPage ='), source.indexOf('async function exportProfileData(')), context);
  vm.runInContext('renderMonitoring = data => renders.push(data);', context);
  context.clearMonitoring();
  node('monitoringModal').open = true;
  const first = context.refreshMonitoring();
  node('monitoringSearch').value = 'alpha & beta';
  node('monitoringRole').value = 'admin';
  const second = context.applyMonitoringFilters();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(new URL(requests[1].url, 'http://local.test').searchParams.get('query'), 'alpha & beta');
  context.selectMonitoringSection('members', true);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].focused, true);
  assert.equal(node('panel-overview').classList.contains('hidden'), true);
  assert.equal(node('panel-members').classList.contains('hidden'), false);
  assert.equal(node('monitoringSearch').value, 'alpha & beta');
  requests[1].resolve({ usage: { page: 1, pages: 2 } });
  await second;
  requests[0].resolve({ usage: { page: 9, pages: 9 } });
  await first;
  assert.equal(renders.length, 1);
  assert.equal(renders[0].usage.page, 1);
  assert.equal(node('monitoringRefresh').disabled, false);
  assert.equal(node('monitoringNext').disabled, false);
  node('monitoringActivity').value = 'disabled';
  const failed = context.applyMonitoringFilters();
  requests[2].reject(Object.assign(new Error('Unavailable'), { status: 503 }));
  await failed;
  assert.equal(node('monitoringNext').disabled, true);
  assert.match(node('monitoringError').textContent, /may not match the selected filters/);
  const pending = context.refreshMonitoring();
  context.clearMonitoring();
  node('monitoringModal').open = false;
  requests[3].resolve({ usage: { page: 2, pages: 2 } });
  await pending;
  assert.equal(renders.length, 1);
  assert.equal(node('monitoringSearch').value, '');
  assert.equal(node('monitoringRole').value, 'all');
  assert.equal(node('monitoringContent').classList.contains('hidden'), true);
});

test('rotating log output contains only sanitized structured events and closes cleanly', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-monitoring-log-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['-e', `
    const { createObservability } = require('./observability');
    const monitor = createObservability({ environment: { LOG_DIRECTORY: process.argv[1], APP_ENV: 'test' }, collectRuntime: false });
    monitor.observe('startup', 'success');
    monitor.observe('smtp', 'failed', 0.2);
    monitor.close().then(() => console.log('CLOSED'));
  `, directory], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('CLOSED'));
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.log'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(directory, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].operation, 'smtp');
});

test('concurrent HTTP traffic produces bounded time series and a private scrape never exposes request secrets', async context => {
  const { monitor, lines } = fixture({ METRICS_TOKEN: 'A'.repeat(43) });
  const app = express();
  app.use(monitor.middleware);
  app.all('/internal/metrics', monitor.metricsHandler);
  app.get('/api/items/:itemId', (req, res) => res.status(req.params.itemId.startsWith('failure') ? 503 : 200).json({ ok: true }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let batch = 0; batch < 3; batch++) await Promise.all(Array.from({ length: 20 }, (_, index) => fetch(
    `${origin}/api/items/${index < 2 ? 'failure' : 'PRIVATE_ITEM'}-${batch}-${index}?inviteToken=SECRET_INVITE`,
    { headers: { 'X-Request-Id': 'SECRET_CLIENT_ID', Cookie: 'SECRET_COOKIE' } }
  ).then(response => response.arrayBuffer())));
  const totals = await monitor.registry.getSingleMetric('focustube_http_requests_total').get();
  assert.equal(totals.values.length, 2);
  assert.equal(totals.values.reduce((sum, value) => sum + value.value, 0), 60);
  const traffic = monitor.snapshot().traffic;
  assert.equal(traffic.reduce((sum, point) => sum + point.requests, 0), 60);
  assert.equal(traffic.reduce((sum, point) => sum + point.errors, 0), 6);
  assert.equal((await fetch(origin + '/internal/metrics', { headers: { Authorization: `Bearer ${'A'.repeat(43)}` } })).status, 404);
  const scrape = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/internal/metrics', { headers: { Host: 'metrics.focustube.internal', Authorization: `Bearer ${'A'.repeat(43)}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });
  assert.equal(scrape.status, 200);
  assert.match(scrape.body, /focustube_http_request_duration_seconds_bucket/);
  for (const secret of ['SECRET_', 'PRIVATE_ITEM', 'A'.repeat(43)]) assert.equal((scrape.body + JSON.stringify(lines)).includes(secret), false, secret);
  assert.equal((await monitor.registry.getSingleMetric('focustube_http_inflight').get()).values[0].value, 0);
});