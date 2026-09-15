'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const pino = require('pino');
const client = require('@prometheus-io/client');

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const routerPrefixes = new Set(['', '/api/auth', '/api/invites', '/api/downloads']);
const assets = new Set(['/', '/index.html', '/policies.html', '/app.js', '/styles.css', '/auth-entry.js', '/theme.js', '/notebooks.js', '/notebook-model.js', '/notebook-editor.js']);
const operations = new Set(['login', 'register', 'upgrade', 'logout', 'email', 'profile', 'password', 'verification', 'invite', 'sqlite', 'smtp', 'captcha', 'health', 'startup', 'shutdown', 'application', 'download']);
const outcomes = new Set(['success', 'rejected', 'unavailable', 'failed', 'busy', 'accepted', 'limited']);

function requestRoute(req) {
  const prefix = req.baseUrl || '';
  const route = req.route?.path;
  if (typeof route === 'string' && route.length <= 160 && routerPrefixes.has(prefix)) return prefix + route;
  const pathname = String(req.url || '').split('?')[0];
  if (assets.has(pathname) || pathname.startsWith('/vendor/')) return 'static';
  return 'unmatched';
}

function createObservability({ environment = process.env, destination, collectRuntime = true, store } = {}) {
  const registry = new client.Registry();
  const deployment = ['local', 'dev', 'production', 'test'].includes(environment.APP_ENV) ? environment.APP_ENV : 'local';
  let fileTransport;
  let fileFailed = false;
  if (!destination && environment.LOG_DIRECTORY) {
    fileTransport = pino.transport({ target: 'pino-roll', options: {
      file: path.join(environment.LOG_DIRECTORY, 'focustube.log'), size: '10m', frequency: 'daily', dateFormat: 'yyyy-MM-dd',
      mkdir: true, mode: 0o640, limit: { count: 4, removeOtherLogFiles: true },
    } });
    fileTransport.on('error', () => {
      fileFailed = true;
      process.stderr.write('{"event":"log_storage_unavailable","service":"focustube"}\n');
    });
    destination = { write(chunk) {
      process.stdout.write(chunk);
      if (!fileFailed) { try { fileTransport.write(chunk); } catch { fileFailed = true; } }
    } };
  }
  const logger = pino({ level: environment.LOG_LEVEL === 'silent' ? 'silent' : 'info',
    base: { service: 'focustube', environment: deployment }, timestamp: pino.stdTimeFunctions.isoTime }, destination);
  registry.setDefaultLabels({ service: 'focustube', environment: deployment });
  if (collectRuntime) client.collectDefaultMetrics({ register: registry, prefix: 'focustube_' });
  const requests = new client.Counter({ name: 'focustube_http_requests_total', help: 'Completed or aborted application HTTP requests.',
    labelNames: ['method', 'route', 'status'], registers: [registry] });
  const duration = new client.Histogram({ name: 'focustube_http_request_duration_seconds', help: 'Application HTTP response duration.',
    labelNames: ['method', 'route'], buckets: [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15], registers: [registry] });
  const inflight = new client.Gauge({ name: 'focustube_http_inflight', help: 'Currently open HTTP requests.', registers: [registry] });
  const events = new client.Counter({ name: 'focustube_operations_total', help: 'Allowlisted operational outcomes.',
    labelNames: ['operation', 'outcome'], registers: [registry] });
  const operationDuration = new client.Histogram({ name: 'focustube_operation_duration_seconds', help: 'External and database operation duration.',
    labelNames: ['operation'], buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30], registers: [registry] });
  const traffic = new Map();
  const token = environment.METRICS_TOKEN || '';
  const expectedToken = crypto.createHash('sha256').update(token).digest();
  const allowedAddresses = String(environment.METRICS_ALLOWED_ADDRESSES || '127.0.0.1,::1').split(',').map(value => value.trim()).filter(Boolean);
  if (allowedAddresses.some(address => !net.isIP(address))) throw new Error('METRICS_ALLOWED_ADDRESSES must contain explicit IP addresses.');
  if (token && (token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token))) throw new Error('METRICS_TOKEN must be a 32-256 character random base64url secret.');

  function observe(operation, outcome, seconds) {
    if (!operations.has(operation) || !outcomes.has(outcome)) return;
    events.inc({ operation, outcome });
    if (Number.isFinite(seconds) && seconds >= 0) operationDuration.observe({ operation }, seconds);
    const level = ['failed', 'unavailable', 'busy'].includes(outcome) ? 'warn' : 'info';
    logger[level]({ event: 'operation', operation, outcome }, 'operation');
  }

  function middleware(req, res, next) {
    const started = performance.now();
    req.requestId = crypto.randomUUID();
    req.monitoring = { observe, reportError };
    res.setHeader('X-Request-Id', req.requestId);
    inflight.inc();
    let recorded = false;
    const finish = () => {
      if (recorded) return;
      recorded = true;
      inflight.dec();
      const seconds = Math.max(0, (performance.now() - started) / 1000);
      const status = res.writableFinished ? res.statusCode : 499;
      const method = methods.has(req.method) ? req.method : 'OTHER';
      const route = requestRoute(req);
      const monitoring = ['/api/health', '/internal/metrics', '/api/admin/monitoring', '/api/presence'].includes(route);
      if (!monitoring) {
        requests.inc({ method, route, status: String(status) });
        duration.observe({ method, route }, seconds);
        const minute = Math.floor(Date.now() / 60000) * 60000;
        const bucket = traffic.get(minute) || { requests: 0, errors: 0, totalSeconds: 0 };
        bucket.requests++;
        if (status >= 500) bucket.errors++;
        bucket.totalSeconds += seconds;
        traffic.set(minute, bucket);
        for (const timestamp of traffic.keys()) if (timestamp < minute - 59 * 60000) traffic.delete(timestamp);
      }
      if (!monitoring || status >= 400) logger[status >= 500 ? 'error' : 'info']({ event: 'http', requestId: req.requestId,
        method, route, status, durationMs: Math.round(seconds * 1000), aborted: !res.writableFinished }, 'request');
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  }

  function reportError(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (/^SQLITE_(BUSY|LOCKED)/.test(code)) observe('sqlite', 'busy');
    else if (code.startsWith('SQLITE_')) observe('sqlite', 'failed');
    else if (!error?.status || error.status >= 500) observe('application', 'failed');
  }

  function metricsAuthorized(req) {
    const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const privateHosts = ['metrics.focustube.internal', `metrics.focustube.internal:${environment.PORT || 3000}`];
    if (!token || req.method !== 'GET' || !privateHosts.includes(req.headers.host) ||
        req.headers.origin || ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip'].some(name => req.headers[name]) ||
        !allowedAddresses.includes(address)) return false;
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ') || authorization.length > 263) return false;
    return crypto.timingSafeEqual(expectedToken, crypto.createHash('sha256').update(authorization.slice(7)).digest());
  }

  async function metricsHandler(req, res) {
    if (!metricsAuthorized(req)) return res.status(404).end();
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': registry.contentType });
    try { res.send(await registry.metrics()); }
    catch { observe('sqlite', 'unavailable'); res.status(503).end(); }
  }

  function systemSnapshot() {
    const result = { uptimeSeconds: Math.floor(process.uptime()), rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed, databaseBytes: null, walBytes: null, diskFreeBytes: null, diskTotalBytes: null };
    if (store?.dataDir) {
      try {
        const disk = fs.statfsSync(store.dataDir);
        result.diskFreeBytes = disk.bavail * disk.bsize;
        result.diskTotalBytes = disk.blocks * disk.bsize;
        result.databaseBytes = fs.statSync(path.join(store.dataDir, 'focustube.db')).size;
        const wal = path.join(store.dataDir, 'focustube.db-wal');
        result.walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
      } catch {}
    }
    return result;
  }

  new client.Gauge({ name: 'focustube_members_active', help: 'Distinct authenticated users with a fresh activity lease.', registers: [registry],
    collect() { this.set(store?.getUsageCounts ? store.getUsageCounts().activeNow : 0); } });
  new client.Gauge({ name: 'focustube_log_storage_ready', help: 'Whether configured rotating log storage is writable.', registers: [registry],
    collect() { this.set(fileFailed ? 0 : 1); } });
  new client.Gauge({ name: 'focustube_database_ready', help: 'Whether the database responds to a lightweight read.', registers: [registry],
    collect() { try { if (!store?.db) { this.reset(); return; } store.db.prepare('SELECT 1').get(); this.set(1); } catch { this.set(0); } } });
  for (const [name, field] of [['database_size_bytes', 'databaseBytes'], ['wal_size_bytes', 'walBytes'], ['disk_free_bytes', 'diskFreeBytes'], ['disk_total_bytes', 'diskTotalBytes']]) {
    new client.Gauge({ name: `focustube_${name}`, help: `Application volume ${field}.`, registers: [registry],
      collect() { const value = systemSnapshot()[field]; if (value !== null) this.set(value); else this.reset(); } });
  }

  function snapshot() {
    const minute = Math.floor(Date.now() / 60000) * 60000;
    return { system: systemSnapshot(), traffic: Array.from({ length: 60 }, (_, index) => {
      const timestamp = minute - (59 - index) * 60000;
      const bucket = traffic.get(timestamp);
      return { timestamp: new Date(timestamp).toISOString(), requests: bucket?.requests || 0, errors: bucket?.errors || 0,
        averageMs: bucket?.requests ? Math.round(bucket.totalSeconds * 1000 / bucket.requests) : null };
    }), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
  }

  function close() {
    return new Promise(resolve => {
      if (!fileTransport || fileTransport.closed || fileFailed) return resolve();
      const deadline = setTimeout(resolve, 5000);
      fileTransport.flush(() => {
        clearTimeout(deadline);
        fileTransport.end();
        resolve();
      });
    });
  }

  return { middleware, observe, reportError, metricsHandler, metricsAuthorized, snapshot, registry, logger, close };
}

module.exports = { createObservability };