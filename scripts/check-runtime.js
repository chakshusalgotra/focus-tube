'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

// Run against an isolated instance with AUTH_ALLOW_LOOPBACK_HTTP=1 and providers disabled.
async function checkRuntime(origin = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000') {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200, 'Application health status');
      assert.equal((await response.json()).database, 'ok', 'SQLite health');
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 29) await delay(1000);
    }
  }
  if (lastError) throw lastError;

  const paths = ['/', '/app.js', '/video-chat.js', '/video-chat-admin.js', '/notebook-model.js',
    '/vendor/lucide.js', '/vendor/quill.js', '/vendor/quill.css', '/api/auth/status'];
  for (const pathname of paths) {
    const response = await fetch(new URL(pathname, origin), { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200, pathname);
    assert.ok((await response.text()).length > 0, pathname + ' is not empty');
  }
  for (const pathname of ['/api/data', '/api/admin/video-chat']) {
    const response = await fetch(new URL(pathname, origin), { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 401, pathname + ' requires authentication');
    await response.body?.cancel();
  }
  console.log('PASS: application startup, SQLite, browser assets, auth status and private API guards.');
}

if (require.main === module) {
  checkRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { checkRuntime };
