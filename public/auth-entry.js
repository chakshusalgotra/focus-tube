'use strict';

(() => {
  let invitation = null;
  function clear() { invitation = null; }
  function capture() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.hash.slice(1));
    if (!params.has('join')) return false;
    const token = params.get('join');
    invitation = params.getAll('join').length === 1 && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token) ? token : null;
    url.hash = 'join';
    try { window.history.replaceState(null, '', url.pathname + url.search + url.hash); }
    catch {
      clear();
      if (window.location.hash !== '#join') window.location.replace(url.pathname + url.search + url.hash);
    }
    return true;
  }
  capture();
  window.FocusTubeInvite = Object.freeze({
    has: () => invitation !== null,
    clear,
    submit(endpoint, options) {
      if (!invitation || !['/api/auth/register', '/api/auth/upgrade', '/api/auth/verification/request'].includes(endpoint)) {
        return Promise.reject(new Error('An invitation is required.'));
      }
      const body = { ...JSON.parse(options.body), inviteToken: invitation };
      return fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    },
  });
  window.addEventListener('hashchange', () => {
    if (capture()) window.dispatchEvent(new CustomEvent('invitationchange'));
  });
  window.addEventListener('pagehide', clear);
})();