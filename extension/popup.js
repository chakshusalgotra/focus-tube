'use strict';

(() => {
  const ORIGINS = { production: 'https://focustube.neuralnest.co.in', development: 'https://dev-ft.neuralnest.co.in', local: 'http://127.0.0.1:3110' };
  const element = id => document.getElementById(id);
  let state = null;
  let generation = 0;
  let busy = false;
  let refreshScheduled = false;
  let retryTimer;

  function icon(container, name) {
    const nodes = globalThis.CaptureIcons?.[name];
    if (!nodes) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    for (const [name, attributes] of nodes) {
      const child = document.createElementNS('http://www.w3.org/2000/svg', name);
      for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
      svg.append(child);
    }
    container.replaceChildren(svg);
  }

  function pendingButton(name, title, callback, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.disabled = disabled;
    icon(button, name);
    button.addEventListener('click', callback);
    return button;
  }

  function render(next) {
    if (!next || !Object.hasOwn(ORIGINS, next.environment) || next.origin !== ORIGINS[next.environment]) return;
    state = next;
    element('environment').value = state.environment;
    element('destination').textContent = new URL(state.origin).host;
    element('account').textContent = state.account?.name || 'Not connected';
    element('accountStatus').textContent = state.disconnectPending ? 'Disconnect not yet confirmed' : state.account ? 'Current Chrome profile' : state.permission ? 'Connect your member account' : 'Site access not granted';
    element('disconnect').hidden = !state.hasConnection && !state.disconnectPending;
    element('disconnect').disabled = busy || state.phase === 'connecting';
    const receipt = state.receipt;
    element('videoTitle').textContent = receipt?.title || state.target?.title || (state.target ? 'YouTube video' : 'No video selected');
    element('videoTitle').title = element('videoTitle').textContent;
    element('source').textContent = state.target ? 'youtube.com' : 'YouTube';
    const thumbnail = element('thumbnail');
    const image = state.target ? `https://i.ytimg.com/vi/${state.target.videoId}/mqdefault.jpg` : '';
    if (image && thumbnail.getAttribute('src') !== image) { thumbnail.src = image; thumbnail.hidden = false; }
    if (!image) { thumbnail.removeAttribute('src'); thumbnail.hidden = true; }
    const pending = state.pending.find(item => item.videoId === state.target?.videoId);
    const saving = state.phase === 'saving' || !!pending?.running;
    const connecting = state.phase === 'connecting';
    let title = state.target ? 'Ready to save' : 'No video selected';
    let message = state.target ? state.account ? `Save to ${state.account.name}'s library.` : 'Connect FocusTube to continue.' : 'A YouTube watch, Shorts, or live video is required.';
    let statusIcon = 'Link';
    if (receipt) { title = !receipt.present ? 'Already processed' : receipt.outcome === 'existing' ? 'Already in your library' : 'Saved to your library'; message = receipt.present ? 'Your save receipt is confirmed.' : 'This video is no longer in your library.'; statusIcon = 'Check'; }
    if (pending && !saving) { title = 'Save receipt missing'; message = 'Retry checks the original save. No second copy is added.'; statusIcon = 'CircleAlert'; }
    if (state.error) { title = state.error.code === 'PERMISSION_REQUIRED' ? 'Site access required' : 'Action needed'; message = state.error.message; statusIcon = 'CircleAlert'; }
    if (saving) { title = 'Saving video'; message = 'Waiting for the FocusTube receipt.'; statusIcon = 'LoaderCircle'; }
    if (connecting) { title = 'Connect in FocusTube'; message = 'Waiting for your approval.'; statusIcon = 'LoaderCircle'; }
    const retryAt = Math.max(pending?.retryAt || 0, state.error?.retryAt || 0);
    if (retryAt > Date.now()) message += ` Retry after ${new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    element('statusTitle').textContent = title;
    element('statusMessage').textContent = message;
    element('statusIcon').classList.toggle('spinning', saving || connecting);
    element('statusIcon').parentElement.dataset.error = String(!!state.error);
    icon(element('statusIcon'), statusIcon);
    element('connect').hidden = !!state.account && state.permission;
    element('connect').disabled = busy || connecting;
    element('save').hidden = !state.account || !state.permission || !!receipt || !state.target;
    element('save').disabled = busy || saving || connecting || retryAt > Date.now();
    element('saveLabel').textContent = saving ? 'Saving...' : pending ? 'Retry save' : 'Save video';
    icon(element('saveIcon'), pending ? 'RefreshCw' : 'Plus');
    element('open').hidden = !receipt?.present || receipt.accountId !== state.account?.id;
    if (!element('open').hidden) element('open').href = `${state.origin}/#c=${encodeURIComponent(receipt.courseId)}&v=${encodeURIComponent(receipt.videoId)}`;
    else element('open').removeAttribute('href');
    element('pendingSection').hidden = !state.pending.length;
    element('pendingLabel').textContent = `Pending saves (${state.pending.length})`;
    const rows = state.pending.map(item => {
      const row = document.createElement('li');
      const label = document.createElement('div');
      const heading = document.createElement('span');
      heading.textContent = item.videoId;
      const detail = document.createElement('small');
      detail.textContent = item.running ? 'Saving' : item.retryAt > Date.now() ? 'Waiting to retry' : 'Receipt missing';
      label.append(heading, detail);
      row.append(label, pendingButton('RefreshCw', `Retry save ${item.videoId}`, () => command({ type: 'save', requestId: item.requestId }), busy || item.running || item.retryAt > Date.now()),
        pendingButton('X', `Discard pending request ${item.videoId}`, () => command({ type: 'discard', requestId: item.requestId }), busy || item.running));
      return row;
    });
    element('pending').replaceChildren(...rows);
    element('expired').hidden = !state.expired;
    clearTimeout(retryTimer);
    const times = [retryAt, ...state.pending.map(item => item.retryAt)].filter(time => time > Date.now());
    if (times.length) retryTimer = setTimeout(refresh, Math.min(...times) - Date.now() + 50);
  }

  async function refresh() {
    const current = generation;
    try { const result = await chrome.runtime.sendMessage({ type: 'state' }); if (current === generation) render(result.state); }
    catch { element('statusTitle').textContent = 'Capture unavailable'; element('statusMessage').textContent = 'Reopen the popup and retry.'; }
  }

  async function command(message) {
    if (message.type === 'save' && state) message = { ...message, environment: state.environment, expectedAccount: state.account?.id, videoId: state.target?.videoId };
    const current = ++generation;
    busy = true;
    if (state) render(state);
    try {
      const result = await chrome.runtime.sendMessage(message);
      if (current === generation) {
        render(result.state);
        if (!result.state && result.error) element('statusMessage').textContent = result.error.message;
      }
    } catch { if (current === generation) element('statusMessage').textContent = 'No receipt received. Reopen the popup to retry.'; }
    finally { if (current === generation) { busy = false; if (state) render(state); } }
  }

  async function openCurrent() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    await command({ type: 'open', url: tab?.incognito ? '' : tab?.url || '', title: tab?.incognito ? '' : tab?.title || '' });
  }

  for (const node of document.querySelectorAll('[data-icon]')) icon(node, node.dataset.icon);
  element('thumbnail').addEventListener('error', () => { element('thumbnail').hidden = true; });
  element('save').addEventListener('click', () => command({ type: 'save' }));
  element('disconnect').addEventListener('click', () => command({ type: 'disconnect' }));
  element('connect').addEventListener('click', async () => {
    const environment = element('environment').value;
    const current = generation;
    try {
      const origin = new URL(ORIGINS[environment]);
      const allowed = await chrome.permissions.request({ origins: [`${origin.protocol}//${origin.hostname}/*`] });
      if (current !== generation) return;
      if (!allowed) { element('statusTitle').textContent = 'Site access declined'; element('statusMessage').textContent = 'Nothing was saved.'; return; }
      await command({ type: 'connect' });
    } catch { element('statusMessage').textContent = 'Site access could not be requested. Try again.'; }
  });
  element('environment').addEventListener('change', async () => {
    await command({ type: 'environment', environment: element('environment').value });
    await openCurrent();
  });
  chrome.storage.onChanged.addListener(changes => {
    if (!changes.capture && !changes.view || refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => { refreshScheduled = false; refresh(); });
  });
  window.addEventListener('pagehide', () => { generation++; clearTimeout(retryTimer); });
  openCurrent().catch(() => { element('statusMessage').textContent = 'The current tab is unavailable. Reopen the popup on a YouTube video.'; });
})();