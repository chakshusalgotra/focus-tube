'use strict';

(() => {
  const key = 'ft_extension_consent';
  const origins = ['https://focustube.neuralnest.co.in', 'https://dev-ft.neuralnest.co.in', 'http://127.0.0.1:3110'];
  const fields = ['extensionId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod', 'state'];
  const token = /^[A-Za-z0-9_-]{43}$/;

  function valid(record) {
    return record && origins.includes(location.origin) && record.origin === location.origin && /^[a-p]{32}$/.test(record.extensionId) &&
      record.redirectUri === `https://${record.extensionId}.chromiumapp.org/` && record.codeChallengeMethod === 'S256' && token.test(record.codeChallenge) && token.test(record.state) &&
      Number.isFinite(record.createdAt) && record.createdAt <= Date.now() + 30000 && record.expiresAt > Date.now() && record.expiresAt <= record.createdAt + 10 * 60000;
  }

  function pending() {
    try {
      const raw = sessionStorage.getItem(key);
      const record = raw && raw.length <= 2048 ? JSON.parse(raw) : null;
      if (valid(record)) return record;
      sessionStorage.removeItem(key);
    } catch {}
    return null;
  }

  window.FocusTubeExtensionConnect = {
    resumeAfterSignIn() {
      if (location.hash !== '#extension-connect' || !pending()) return false;
      location.replace('/extension-connect.html');
      return true;
    },
  };
  if (!document.getElementById('extensionConsent')) return;
  const element = id => document.getElementById(id);
  let record;
  let account;
  let busy = false;

  function visible(id, shown) {
    element(id).hidden = !shown;
    element(id).classList.toggle('hidden', !shown);
  }

  function showError(message) {
    element('connectError').textContent = message;
    visible('connectError', true);
  }

  element('connectCancel').addEventListener('click', () => {
    try { sessionStorage.removeItem(key); } catch {}
    if (!valid(record)) { location.replace('/'); return; }
    const callback = new URL(record.redirectUri);
    callback.hash = new URLSearchParams({ error: 'access_denied', state: record.state }).toString();
    location.replace(callback.href);
  });

  try {
    if (location.hash) {
      const fragment = location.hash.slice(1);
      history.replaceState(null, '', '/extension-connect.html');
      sessionStorage.removeItem(key);
      if (fragment.length > 1024) throw new Error('Invalid connection request.');
      const params = new URLSearchParams(fragment);
      if ([...params.keys()].some(name => !fields.includes(name)) || fields.some(name => params.getAll(name).length !== 1)) throw new Error('Invalid connection request.');
      record = { ...Object.fromEntries(params), origin: location.origin, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60000 };
      if (!valid(record)) throw new Error('This extension connection is not allowed.');
      sessionStorage.setItem(key, JSON.stringify(record));
    } else record = pending();
    if (!record) throw new Error('This connection expired. Start Connect again from the extension.');
  } catch (error) { showError(error.message); element('connectAccount').textContent = 'Connection unavailable'; return; }

  const site = location.origin === origins[0] ? 'Production' : location.origin === origins[1] ? 'Development' : 'Local testing';
  element('connectSite').textContent = `${site} - ${location.host}`;
  for (const node of document.querySelectorAll('[data-connect-icon]')) {
    const icon = window.lucide?.icons[node.dataset.connectIcon];
    if (icon) node.append(window.lucide.createElement(icon, { 'aria-hidden': 'true', class: 'ui-icon' }));
  }

  async function loadAccount() {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status === 401) {
      account = null;
      element('connectAccount').textContent = 'Sign in to approve this connection.';
      visible('connectForm', false);
      visible('connectLogin', true);
      return;
    }
    if (!response.ok) throw new Error('Your account could not be checked. Reopen Connect from the extension.');
    const value = await response.json();
    if (!Number.isSafeInteger(value.user?.id) || value.user.id < 1 || value.user.isGuest || value.user.accountState !== 'active') throw new Error('A current FocusTube member account is required.');
    account = { id: value.user.id, name: String(value.user.displayName || value.user.username || `Member ${value.user.id}`).slice(0, 80) };
    element('connectAccount').textContent = `Account: ${account.name}`;
    visible('connectForm', true);
    visible('connectLogin', false);
  }

  element('connectConsent').addEventListener('change', () => { element('connectApprove').disabled = busy || !element('connectConsent').checked || !account; });
  element('connectForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !account || !element('connectConsent').checked) return;
    if (!valid(record)) { showError('This connection expired. Start Connect again from the extension.'); return; }
    busy = true;
    element('connectApprove').disabled = true;
    visible('connectError', false);
    try {
      const payload = Object.fromEntries(fields.map(field => [field, record[field]]));
      const response = await fetch('/api/extension/authorize', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, expectedAccount: account.id, consent: true }), signal: AbortSignal.timeout(10000) });
      const value = await response.json();
      if (!response.ok) {
        if (response.status === 409 || response.status === 401) { element('connectConsent').checked = false; await loadAccount(); }
        throw new Error(typeof value.error === 'string' ? value.error.slice(0, 300) : 'The connection was not approved. Try again.');
      }
      const callback = new URL(value.redirectUrl);
      const params = new URLSearchParams(callback.hash.slice(1));
      if (callback.origin + callback.pathname !== record.redirectUri || callback.username || callback.password || callback.search || params.getAll('code').length !== 1 || params.getAll('state').length !== 1 ||
          params.get('state') !== record.state || !token.test(params.get('code') || '') || [...params.keys()].some(name => !['code', 'state'].includes(name))) throw new Error('Invalid connection response. Start Connect again from the extension.');
      sessionStorage.removeItem(key);
      location.replace(callback.href);
    } catch (error) { showError(error instanceof TypeError ? 'The connection could not finish. Check your connection and try again.' : error.message); }
    finally { busy = false; element('connectApprove').disabled = !element('connectConsent').checked || !account; }
  });
  loadAccount().catch(error => showError(error.message));
})();