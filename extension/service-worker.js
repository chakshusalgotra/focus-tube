'use strict';

const ORIGINS = Object.freeze({ production: 'https://focustube.neuralnest.co.in', development: 'https://dev-ft.neuralnest.co.in', local: 'http://127.0.0.1:3110' });
const hostPermission = environment => { const url = new URL(ORIGINS[environment]); return `${url.protocol}//${url.hostname}/*`; };
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY = 86400000;
const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com'];

function parseVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.includes(url.hostname) || url.username || url.password || url.port) return null;
    let id;
    if (url.hostname === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    else if (url.pathname === '/watch' && !url.hostname.endsWith('youtube-nocookie.com')) {
      if (url.searchParams.getAll('v').length !== 1) return null;
      id = url.searchParams.get('v');
    } else id = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    return VIDEO_ID.test(id || '') ? { videoId: id, url: `https://www.youtube.com/watch?v=${id}` } : null;
  } catch { return null; }
}

class CaptureError extends Error {
  constructor(code, message, retryAt = 0) { super(message); this.code = code; this.retryAt = retryAt; }
}

async function showUnavailable(browser) {
  try { await browser.action.setBadgeText({ text: '!' }); } catch {}
}

function createCaptureWorker(browser, fetchImpl = fetch, now = Date.now) {
  let ready;
  let writes = Promise.resolve();
  const running = new Map();
  let contextOpening = Promise.resolve();
  let connecting = false;
  const exclusive = operation => {
    const result = writes.catch(() => {}).then(() => {
      ready ||= Promise.resolve().then(() => Promise.all([
        browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
        browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      ])).catch(() => {
        ready = null;
        throw new CaptureError('STORAGE_UNAVAILABLE', 'Extension storage is unavailable. Reload FocusTube in your browser extensions, then reopen the popup.');
      });
      return ready;
    }).then(operation);
    writes = result.catch(() => {});
    return result;
  };
  const validAccount = value => Number.isSafeInteger(value) && value > 0;

  async function read() {
    const raw = (await browser.storage.local.get('capture')).capture || {};
    const environment = Object.hasOwn(ORIGINS, raw.environment) ? raw.environment : 'production';
    const connections = {};
    for (const name of Object.keys(ORIGINS)) {
      const connection = raw.connections?.[name];
      if (connection && validAccount(connection.accountId)) connections[name] = { accountId: connection.accountId, name: String(connection.name || '').slice(0, 80),
        mode: connection.mode === 'grant' ? 'grant' : 'session', token: TOKEN.test(connection.token || '') ? connection.token : null,
        expiresAt: typeof connection.expiresAt === 'string' ? connection.expiresAt : '', paused: !!connection.paused, disconnectPending: !!connection.disconnectPending };
    }
    const pending = (Array.isArray(raw.pending) ? raw.pending : []).filter(item => item && REQUEST_ID.test(item.requestId) && VIDEO_ID.test(item.videoId) &&
      validAccount(item.accountId) && Object.hasOwn(ORIGINS, item.environment) && Number.isFinite(item.createdAt) && item.createdAt <= now() + 30000 && now() - item.createdAt < DAY)
      .slice(0, 20).map(item => ({ requestId: item.requestId, videoId: item.videoId, accountId: item.accountId, environment: item.environment, createdAt: item.createdAt,
        retryAt: Number.isFinite(item.retryAt) ? Math.min(item.retryAt, item.createdAt + DAY) : 0, code: typeof item.code === 'string' ? item.code.slice(0, 40) : '' }));
    const expired = (raw.pending?.length || 0) > pending.length;
    const state = { environment, epoch: REQUEST_ID.test(raw.epoch || '') ? raw.epoch : crypto.randomUUID(), connections, pending, expired: expired || !!raw.expired };
    if (JSON.stringify(raw) !== JSON.stringify(state)) await browser.storage.local.set({ capture: state });
    const view = (await browser.storage.session.get('view')).view;
    if (view?.environment === environment) return { state, view };
    const initialView = { environment, nonce: crypto.randomUUID(), target: null, phase: 'ready' };
    await browser.storage.session.set({ view: initialView });
    return { state, view: initialView };
  }

  const snapshot = () => exclusive(read);
  const permission = environment => browser.permissions.contains({ origins: [hostPermission(environment)] });
  const failure = error => ({ code: error instanceof CaptureError ? error.code : 'UNAVAILABLE',
    message: error instanceof CaptureError ? error.message : 'Capture is unavailable. Reopen the popup and retry.', retryAt: error.retryAt || 0 });

  async function paint(bound, fields) {
    return exclusive(async () => {
      const current = await read();
      if (current.state.environment !== bound.environment || current.state.epoch !== bound.epoch || bound.nonce && current.view.nonce !== bound.nonce) return false;
      await browser.storage.session.set({ view: { ...current.view, ...fields } });
      return true;
    });
  }

  async function request(environment, endpoint, payload, token = null, controller = new AbortController()) {
    if (!Object.hasOwn(ORIGINS, environment) || !['session', 'videos', 'token', 'disconnect'].includes(endpoint)) throw new CaptureError('INVALID_REQUEST', 'This request is not supported.');
    if (!await permission(environment)) throw new CaptureError('PERMISSION_REQUIRED', 'Allow access to the selected FocusTube site to continue.');
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetchImpl(`${ORIGINS[environment]}/api/extension/${endpoint}`, { method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: controller.signal });
      if (response.status === 204) return null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16384) { await reader.cancel(); throw new CaptureError('INVALID_RESPONSE', 'FocusTube returned an unexpected response.'); }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      let value;
      try { value = JSON.parse(text + decoder.decode()); } catch { throw new CaptureError('INVALID_RESPONSE', 'FocusTube returned an unexpected response.'); }
      if (!response.ok) {
        const seconds = Number(response.headers.get('retry-after'));
        const retryAt = Number.isFinite(seconds) && seconds > 0 ? now() + Math.min(86400, seconds) * 1000 : 0;
        throw new CaptureError(typeof value.code === 'string' ? value.code.slice(0, 40) : 'UNAVAILABLE', typeof value.error === 'string' ? value.error.slice(0, 300) : 'The save could not finish. Retry later.', retryAt);
      }
      return value;
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw new CaptureError('NETWORK_ERROR', 'No save receipt was received. Check your connection, then retry.');
    } finally { clearTimeout(timeout); }
  }

  function identity(value, environment) {
    if (!value || value.origin !== ORIGINS[environment] || value.environment !== environment || !validAccount(value.account?.id) || typeof value.account.name !== 'string' ||
        !['session', 'grant'].includes(value.authentication) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()) {
      throw new CaptureError('INVALID_RESPONSE', 'FocusTube returned an unexpected account. Connect again.');
    }
    return { id: value.account.id, name: value.account.name.slice(0, 80) };
  }

  async function probe(bound, { allowPaused = false } = {}) {
    const current = await snapshot();
    if (current.state.epoch !== bound.epoch || current.state.environment !== bound.environment) throw new CaptureError('ACTION_CHANGED', 'The selected environment changed.');
    const known = current.state.connections[bound.environment];
    if (known?.paused && !allowPaused) throw new CaptureError('CONNECTION_REQUIRED', 'Connect FocusTube before saving.');
    try {
      const response = await request(bound.environment, 'session', {}, known?.token);
      const account = identity(response, bound.environment);
      if (known && known.accountId !== account.id) throw new CaptureError('ACCOUNT_CHANGED', 'The FocusTube account changed. Connect again before saving.');
      await exclusive(async () => {
        const latest = await read();
        if (latest.state.epoch !== bound.epoch || latest.state.environment !== bound.environment) throw new CaptureError('ACTION_CHANGED', 'The selected environment changed.');
        latest.state.connections[bound.environment] = { accountId: account.id, name: account.name, mode: response.authentication, token: known?.token || null, expiresAt: response.expiresAt, paused: false, disconnectPending: false };
        await browser.storage.local.set({ capture: latest.state });
      });
      return account;
    } catch (error) {
      if (['ACCOUNT_CHANGED', 'CONNECTION_EXPIRED', 'MEMBER_REQUIRED'].includes(error.code)) await exclusive(async () => {
        const latest = await read();
        if (latest.state.epoch !== bound.epoch) return;
        if (latest.state.connections[bound.environment]) latest.state.connections[bound.environment].paused = true;
        await browser.storage.local.set({ capture: latest.state });
      });
      throw error;
    }
  }

  async function stateView() {
    const { state, view } = await snapshot();
    const connection = state.connections[state.environment];
    const account = connection && !connection.paused && Date.parse(connection.expiresAt) > now() ? { id: connection.accountId, name: connection.name } : null;
    const activeTarget = state.pending.some(item => item.environment === state.environment && item.videoId === view.target?.videoId && running.has(item.requestId));
    const interrupted = view.phase === 'connecting' && !connecting;
    const phase = view.phase === 'saving' && !activeTarget ? 'uncertain' : interrupted ? 'ready' : view.phase || 'ready';
    return { environment: state.environment, origin: ORIGINS[state.environment], account,
      permission: await permission(state.environment), hasConnection: !!connection && (!!connection.token || !connection.paused), disconnectPending: !!connection?.disconnectPending,
      target: view.target || null, phase, error: interrupted ? { code: 'CONNECT_INTERRUPTED', message: 'The connection was interrupted. Connect again.' } : view.error || null, receipt: view.receipt || null, expired: state.expired,
      pending: state.pending.filter(item => item.environment === state.environment && account && item.accountId === account.id)
        .map(item => ({ ...item, running: running.has(item.requestId) })), pendingCount: state.pending.length };
  }

  async function selectTarget(url, title, context = false) {
    return exclusive(async () => {
      const { state, view } = await read();
      const parsed = parseVideoUrl(url);
      const target = parsed ? { ...parsed, title: typeof title === 'string' ? title.slice(0, 500) : '' } : null;
      const keep = !context && target && view.target?.videoId === target.videoId;
      const nextView = keep ? { ...view, unclaimed: false } : { environment: state.environment, nonce: crypto.randomUUID(), target, phase: 'ready', unclaimed: context, error: target ? null : { code: 'UNSUPPORTED_URL', message: 'This page has no supported YouTube video.' }, receipt: null };
      await browser.storage.session.set({ view: nextView });
      return { environment: state.environment, epoch: state.epoch, nonce: nextView.nonce };
    });
  }

  async function open(url, title) {
    await contextOpening;
    const current = await snapshot();
    let bound;
    if (current.view.unclaimed) {
      bound = { environment: current.state.environment, epoch: current.state.epoch, nonce: current.view.nonce };
      await paint(bound, { unclaimed: false });
    } else bound = await selectTarget(url, title);
    try { await probe(bound); await paint(bound, { error: null }); }
    catch (error) { await paint(bound, { error: failure(error) }); }
    await browser.action.setBadgeText({ text: '' });
    return stateView();
  }

  async function save(requestId, intended) {
    let current = await snapshot();
    if (intended && (intended.environment !== current.state.environment || intended.epoch !== current.state.epoch || intended.nonce !== current.view.nonce)) throw new CaptureError('ACTION_CHANGED', 'The selected video or environment changed.');
    if (requestId) {
      const pending = current.state.pending.find(item => item.requestId === requestId);
      if (!pending) throw new CaptureError('REQUEST_EXPIRED', 'This pending save expired or was discarded. Check your library.');
      if (pending.environment !== current.state.environment || pending.accountId !== current.state.connections[current.state.environment]?.accountId) throw new CaptureError('ACCOUNT_CHANGED', 'This request belongs to another account or environment.');
      if (current.view.target?.videoId !== pending.videoId) {
        await selectTarget(`https://www.youtube.com/watch?v=${pending.videoId}`, 'YouTube video');
        current = await snapshot();
      }
    }
    const bound = { environment: current.state.environment, epoch: current.state.epoch, nonce: current.view.nonce };
    const target = current.view.target;
    if (!requestId && !target) throw new CaptureError('UNSUPPORTED_URL', 'Choose a supported YouTube video.');
    const account = await probe(bound);
    const operation = await exclusive(async () => {
      const latest = await read();
      if (latest.state.epoch !== bound.epoch || latest.view.nonce !== bound.nonce) throw new CaptureError('ACTION_CHANGED', 'The selected video or environment changed.');
      let pending = requestId ? latest.state.pending.find(item => item.requestId === requestId) : latest.state.pending.find(item => item.environment === bound.environment && item.accountId === account.id && item.videoId === target.videoId);
      if (requestId && !pending) throw new CaptureError('REQUEST_EXPIRED', 'This pending save expired or was discarded. Check your library.');
      if (pending && (pending.environment !== bound.environment || pending.accountId !== account.id)) throw new CaptureError('ACCOUNT_CHANGED', 'This request belongs to another account or environment.');
      if (pending?.retryAt > now()) throw new CaptureError('RATE_LIMITED', 'Wait until the retry time before trying again.', pending.retryAt);
      if (!pending) {
        if (latest.state.pending.length >= 20) throw new CaptureError('QUEUE_FULL', 'Twenty saves are awaiting receipts. Retry or discard older saves first.');
        pending = { requestId: crypto.randomUUID(), videoId: target.videoId, accountId: account.id, environment: bound.environment, createdAt: now(), retryAt: 0, code: '' };
        latest.state.pending.push(pending);
      }
      await browser.storage.local.set({ capture: latest.state });
      return { ...pending, token: latest.state.connections[bound.environment]?.token || null };
    });
    if (running.has(operation.requestId)) return stateView();
    const controller = new AbortController();
    running.set(operation.requestId, { controller, environment: bound.environment });
    await paint(bound, { phase: 'saving', error: null, receipt: null });
    try {
      const receipt = await request(operation.environment, 'videos', { videoId: operation.videoId, requestId: operation.requestId, expectedAccount: operation.accountId }, operation.token, controller);
      if (receipt?.requestId !== operation.requestId || receipt.videoId !== operation.videoId || receipt.accountId !== operation.accountId || typeof receipt.courseId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.courseId) || !['saved', 'existing'].includes(receipt.outcome) || typeof receipt.present !== 'boolean' || typeof receipt.title !== 'string') {
        throw new CaptureError('INVALID_RECEIPT', 'No valid save receipt was received. Retry this same request.');
      }
      const result = { requestId: receipt.requestId, videoId: receipt.videoId, courseId: receipt.courseId, accountId: receipt.accountId,
        outcome: receipt.outcome, present: receipt.present, title: receipt.title.slice(0, 500) };
      await paint(bound, { phase: 'done', receipt: result, error: null });
      await exclusive(async () => {
        const latest = await read();
        latest.state.pending = latest.state.pending.filter(item => item.requestId !== operation.requestId);
        await browser.storage.local.set({ capture: latest.state });
      });
    } catch (error) {
      await exclusive(async () => {
        const latest = await read();
        const pending = latest.state.pending.find(item => item.requestId === operation.requestId);
        if (pending) { pending.code = failure(error).code; pending.retryAt = error.retryAt || 0; }
        if (['ACCOUNT_CHANGED', 'CONNECTION_EXPIRED', 'MEMBER_REQUIRED'].includes(error.code) && latest.state.connections[operation.environment]) latest.state.connections[operation.environment].paused = true;
        await browser.storage.local.set({ capture: latest.state });
      });
      await paint(bound, { phase: 'uncertain', error: failure(error) });
    } finally { running.delete(operation.requestId); }
    return stateView();
  }

  const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function connectFlow() {
    const current = await snapshot();
    const bound = { environment: current.state.environment, epoch: current.state.epoch, nonce: current.view.nonce };
    if (!await permission(bound.environment)) throw new CaptureError('PERMISSION_REQUIRED', 'Allow access to this FocusTube site first.');
    const known = current.state.connections[bound.environment];
    if (!known?.paused && !known?.token) {
      try { await probe(bound); await paint(bound, { error: null, phase: 'ready' }); return stateView(); }
      catch (error) { if (!['CONNECTION_EXPIRED', 'ACCOUNT_CHANGED', 'CONNECTION_REQUIRED'].includes(error.code)) throw error; }
    }
    const verifier = randomToken();
    const state = randomToken();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const redirectUri = browser.identity.getRedirectURL();
    if (redirectUri !== `https://${browser.runtime.id}.chromiumapp.org/`) throw new CaptureError('INVALID_CALLBACK', 'The extension callback is not supported.');
    await browser.storage.session.set({ pkce: { verifier, state, environment: bound.environment, epoch: bound.epoch, expiresAt: now() + 10 * 60000 } });
    const params = new URLSearchParams({ extensionId: browser.runtime.id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', state });
    await paint(bound, { phase: 'connecting', error: null });
    try {
      let returned;
      try { returned = await browser.identity.launchWebAuthFlow({ url: `${ORIGINS[bound.environment]}/extension-connect.html#${params}`, interactive: true }); }
      catch { throw new CaptureError('CONNECT_CANCELLED', 'Connection was not completed.'); }
      const callback = new URL(returned);
      const values = new URLSearchParams(callback.hash.slice(1));
      const proof = (await browser.storage.session.get('pkce')).pkce;
      const latest = await snapshot();
      if (callback.origin + callback.pathname !== redirectUri || callback.username || callback.password || callback.search || values.getAll('state').length !== 1 || values.get('state') !== state ||
          !proof || proof.state !== state || proof.verifier !== verifier || proof.environment !== bound.environment || proof.epoch !== bound.epoch || proof.expiresAt <= now() || latest.state.epoch !== bound.epoch) {
        throw new CaptureError('INVALID_CALLBACK', 'The connection changed or expired. Connect again.');
      }
      if (values.has('error')) throw new CaptureError('CONNECT_CANCELLED', 'Connection was not approved.');
      if (values.getAll('code').length !== 1 || !TOKEN.test(values.get('code') || '') || [...values.keys()].some(key => !['code', 'state'].includes(key))) throw new CaptureError('INVALID_CALLBACK', 'The connection response was invalid.');
      const response = await request(bound.environment, 'token', { code: values.get('code'), codeVerifier: verifier, state, extensionId: browser.runtime.id, redirectUri });
      const account = identity(response, bound.environment);
      if (!TOKEN.test(response.token || '') || response.authentication !== 'grant') throw new CaptureError('INVALID_RESPONSE', 'The connection response was invalid.');
      await exclusive(async () => {
        const latestState = await read();
        if (latestState.state.epoch !== bound.epoch) throw new CaptureError('ACTION_CHANGED', 'The selected environment changed.');
        for (const active of running.values()) if (active.environment === bound.environment) active.controller.abort();
        latestState.state.connections[bound.environment] = { accountId: account.id, name: account.name, mode: 'grant', token: response.token, expiresAt: response.expiresAt, paused: false, disconnectPending: false };
        latestState.state.epoch = crypto.randomUUID();
        await browser.storage.local.set({ capture: latestState.state });
        await browser.storage.session.set({ view: { ...latestState.view, nonce: crypto.randomUUID(), phase: 'ready', error: null, receipt: null } });
      });
    } finally {
      const proof = (await browser.storage.session.get('pkce')).pkce;
      if (proof?.state === state) await browser.storage.session.remove('pkce');
    }
    return stateView();
  }

  async function connect() {
    if (connecting) throw new CaptureError('CONNECT_RUNNING', 'A connection window is already open.');
    connecting = true;
    try { return await connectFlow(); } finally { connecting = false; }
  }

  async function switchEnvironment(environment) {
    if (!Object.hasOwn(ORIGINS, environment)) throw new CaptureError('INVALID_ENVIRONMENT', 'Choose Production, Development or Local testing.');
    for (const active of running.values()) active.controller.abort();
    await exclusive(async () => {
      const { state } = await read();
      state.environment = environment;
      state.epoch = crypto.randomUUID();
      await browser.storage.local.set({ capture: state });
      await browser.storage.session.remove(['view', 'pkce']);
    });
    return stateView();
  }

  async function disconnect() {
    const { state, view } = await snapshot();
    const bound = { environment: state.environment, epoch: state.epoch, nonce: view.nonce };
    const connection = state.connections[state.environment];
    if (!connection) return stateView();
    for (const active of running.values()) if (active.environment === state.environment) active.controller.abort();
    await exclusive(async () => {
      const latest = await read();
      if (latest.state.epoch !== bound.epoch) throw new CaptureError('ACTION_CHANGED', 'The selected environment changed.');
      latest.state.connections[state.environment].paused = true;
      latest.state.connections[state.environment].disconnectPending = true;
      await browser.storage.local.set({ capture: latest.state });
    });
    try { await request(state.environment, 'disconnect', { expectedAccount: connection.accountId }, connection.token); }
    catch (error) { if (!['CONNECTION_EXPIRED', 'MEMBER_REQUIRED'].includes(error.code)) throw error; }
    await exclusive(async () => {
      const latest = await read();
      if (latest.state.epoch !== bound.epoch) return;
      latest.state.connections[state.environment] = { ...connection, token: null, paused: true, disconnectPending: false };
      latest.state.epoch = crypto.randomUUID();
      await browser.storage.local.set({ capture: latest.state });
      await browser.storage.session.remove(['view', 'pkce']);
    });
    return stateView();
  }

  async function handle(message) {
    let actionBound;
    try {
      if (!message || typeof message.type !== 'string') throw new CaptureError('INVALID_REQUEST', 'This request is not supported.');
      const initial = await snapshot();
      actionBound = { environment: initial.state.environment, epoch: initial.state.epoch, nonce: initial.view.nonce };
      if (message.type === 'state') return { ok: true, state: await stateView() };
      if (message.type === 'open') return { ok: true, state: await open(message.url, message.title) };
      if (message.type === 'save') {
        if (message.environment !== undefined && (message.environment !== initial.state.environment || message.expectedAccount !== initial.state.connections[initial.state.environment]?.accountId ||
            !message.requestId && message.videoId !== initial.view.target?.videoId)) throw new CaptureError('ACTION_CHANGED', 'The selected account, video or environment changed.');
        return { ok: true, state: await save(message.requestId, actionBound) };
      }
      if (message.type === 'connect') return { ok: true, state: await connect() };
      if (message.type === 'environment') return { ok: true, state: await switchEnvironment(message.environment) };
      if (message.type === 'disconnect') return { ok: true, state: await disconnect() };
      if (message.type === 'discard') {
        await exclusive(async () => {
          const { state } = await read();
          const operation = state.pending.find(item => item.requestId === message.requestId);
          if (!operation || operation.environment !== state.environment || operation.accountId !== state.connections[state.environment]?.accountId || running.has(operation.requestId)) throw new CaptureError('INVALID_REQUEST', 'This pending save cannot be discarded now.');
          state.pending = state.pending.filter(item => item.requestId !== message.requestId);
          await browser.storage.local.set({ capture: state });
        });
        return { ok: true, state: await stateView() };
      }
      throw new CaptureError('INVALID_REQUEST', 'This request is not supported.');
    } catch (error) {
      const current = await snapshot().catch(() => null);
      if (current && actionBound) await paint(actionBound, { phase: 'ready', error: failure(error) }).catch(() => {});
      return { ok: false, error: failure(error), state: current ? await stateView().catch(() => null) : null };
    }
  }

  async function contextMenu(info, tab) {
    if (tab?.incognito) return;
    const popup = browser.action.openPopup(tab?.windowId === undefined ? {} : { windowId: tab.windowId }).catch(() => showUnavailable(browser));
    contextOpening = selectTarget(info.linkUrl || info.pageUrl || tab?.url, info.linkUrl ? '' : tab?.title, true);
    const bound = await contextOpening;
    await popup;
    try { await probe(bound); await save(undefined, bound); }
    catch (error) { await paint(bound, { error: failure(error), phase: 'ready' }); }
  }

  async function permissionsRemoved(removed) {
    await exclusive(async () => {
      const { state } = await read();
      for (const name of Object.keys(ORIGINS)) if (removed.origins?.includes(hostPermission(name))) {
        if (state.connections[name]) state.connections[name] = { ...state.connections[name], token: null, paused: true, disconnectPending: false };
        for (const active of running.values()) if (active.environment === name) active.controller.abort();
        if (state.environment === name) { state.epoch = crypto.randomUUID(); await browser.storage.session.remove(['view', 'pkce']); }
      }
      await browser.storage.local.set({ capture: state });
    });
  }

  return { handle, contextMenu, permissionsRemoved };
}

if (typeof module !== 'undefined') module.exports = { parseVideoUrl, createCaptureWorker, ORIGINS };
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const worker = createCaptureWorker(chrome);
  chrome.runtime.onInstalled.addListener(() => {
    (async () => {
      await chrome.contextMenus.removeAll();
      const patterns = HOSTS.map(host => `*://${host}/*`);
      for (const options of [
        { id: 'focustube-link', title: 'Add to FocusTube', contexts: ['link'], targetUrlPatterns: patterns },
        { id: 'focustube-page', title: 'Add to FocusTube', contexts: ['page'], documentUrlPatterns: patterns },
      ]) await new Promise((resolve, reject) => {
        chrome.contextMenus.create(options, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message)); else resolve();
        });
      });
    })().catch(() => showUnavailable(chrome));
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => { if (['focustube-link', 'focustube-page'].includes(info.menuItemId)) worker.contextMenu(info, tab).catch(() => showUnavailable(chrome)); });
  chrome.permissions.onRemoved.addListener(permissions => worker.permissionsRemoved(permissions).catch(() => {}));
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
    const reply = value => { try { respond(value); } catch {} };
    worker.handle(message).then(reply, () => reply({ ok: false, state: null,
      error: { code: 'UNAVAILABLE', message: 'Capture is unavailable. Reopen the popup and retry.', retryAt: 0 } }));
    return true;
  });
}