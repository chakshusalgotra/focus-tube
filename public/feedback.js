'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const categories = { bug: 'Bug', usability: 'Usability', request: 'Feature request' };
  const statuses = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
  const state = { user: null, ready: false, busy: false, accessVersion: 0, viewVersion: 0, reader: null,
    view: 'public', page: 1, replyPage: 1, replyTotal: 0, thread: null, lastHash: location.hash,
    reportAttempt: null, replyAttempt: null, moderationDraft: null };
  const drafts = Object.fromEntries(['Report', 'Reply'].map(kind => [kind, { images: [], urls: new Set(), version: 0, reader: null, reading: false }]));
  const imageUrls = new Set();
  const imageLoaders = new WeakMap();
  const imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { imageObserver.unobserve(entry.target); void imageLoaders.get(entry.target)?.(); }
  }, { rootMargin: '160px' });

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function icon(name) { const element = node('i'); element.dataset.lucide = name; element.setAttribute('aria-hidden', 'true'); return element; }
  function icons() { window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
  function action(label, symbol, handler) {
    const button = node('button', 'icon-btn'); button.type = 'button'; button.title = label;
    button.setAttribute('aria-label', label); button.append(icon(symbol)); button.addEventListener('click', handler); return button;
  }
  function stamp(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '';
  }
  function badge(label, value) { const element = node('span', 'feedback-badge', label); element.dataset.state = value; return element; }
  function notice(text) { byId('feedbackNotice').textContent = text; }
  function clearError(id) { byId(id).hidden = true; byId(id).textContent = ''; }
  function showError(id, error) {
    byId(id).textContent = `${error.message}${error.retryAfter ? ` Try again in ${error.retryAfter} seconds.` : ''}`;
    byId(id).hidden = false;
  }

  async function api(url, { method = 'GET', body, signal, account = true, image = false } = {}) {
    const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(body?.screenshots?.length ? { 'X-Feedback-Screenshots': '1' } : {}),
        ...(account ? { 'X-Feedback-Account': state.user ? String(state.user.id) : 'anonymous' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(body?.screenshots?.length ? 60000 : 15000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw Object.assign(new Error(result.error || 'The request could not be completed.'), {
        status: response.status, code: result.code, retryAfter: Math.min(900, Number(response.headers.get('retry-after')) || 0),
      });
    }
    if (image) {
      if (response.headers.get('content-type') !== 'image/png') throw new Error('Screenshot unavailable.');
      return response.blob();
    }
    return response.json();
  }

  function revokeUrls(urls) { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  function clearDraftPreviews(kind) { revokeUrls(drafts[kind].urls); byId(`feedback${kind}Previews`).replaceChildren(); }
  function clearImageViews() {
    imageObserver.disconnect();
    byId('feedbackImageDialog').close(); byId('feedbackImage').removeAttribute('src'); byId('feedbackImageDownload').removeAttribute('href');
    for (const image of document.querySelectorAll('[data-saved-screenshot]')) image.removeAttribute('src');
    revokeUrls(imageUrls);
  }
  function renderDraftScreenshots(kind) {
    clearDraftPreviews(kind); if (!state.ready || document.hidden) return;
    const draft = drafts[kind]; const list = byId(`feedback${kind}Previews`);
    draft.images.forEach((image, index) => {
      const item = node('li', 'feedback-shot'); const preview = node('img'); preview.alt = `Selected screenshot ${index + 1}`;
      preview.src = URL.createObjectURL(image.file); draft.urls.add(preview.src);
      const caption = node('div', 'feedback-shot-caption'); caption.append(node('span', '', image.file.name));
      caption.append(action(`Remove screenshot ${index + 1}`, 'x', () => {
        if (state.busy || state[`${kind.toLowerCase()}Attempt`] || draft.reading) return;
        draft.images.splice(index, 1); renderDraftScreenshots(kind); screenshotStatus(kind);
        byId(`feedback${kind}Screenshots`).focus();
      }));
      item.append(preview, caption); list.append(item);
    });
    icons();
  }
  function screenshotStatus(kind) {
    const count = drafts[kind].images.length;
    byId(`feedback${kind}ScreenshotStatus`).textContent = count ? `${count} ${count === 1 ? 'screenshot' : 'screenshots'} selected.` : '';
  }
  async function selectScreenshots(kind, input) {
    const files = [...input.files]; input.value = '';
    const draft = drafts[kind];
    if (!files.length || !state.user || state.busy || draft.reading || state[`${kind.toLowerCase()}Attempt`]) return;
    clearError(`feedback${kind}Error`);
    if (draft.images.length + files.length > 3) return showError(`feedback${kind}Error`, { message: 'Attach up to three screenshots.' });
    const version = draft.version; const owner = state.user.id;
    draft.reading = true; input.disabled = true; byId(`feedback${kind}ScreenshotStatus`).textContent = 'Reading screenshots...';
    try {
      const selected = [];
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) {
          throw new Error('Choose PNG, JPEG, or WebP images up to 5 MiB each.');
        }
        const bitmap = await createImageBitmap(file);
        const pixels = bitmap.width * bitmap.height; bitmap.close();
        if (version !== draft.version || owner !== state.user?.id) return;
        if (pixels > 16000000) throw new Error('Crop or resize screenshots to 16 megapixels or fewer.');
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader(); draft.reader = reader;
          reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
          reader.onerror = reader.onabort = () => reject(new Error('The screenshot could not be read. Select it again.'));
          reader.readAsDataURL(file);
        });
        if (version !== draft.version || owner !== state.user?.id) return;
        selected.push({ file, encoded });
      }
      draft.images.push(...selected); renderDraftScreenshots(kind);
    } catch (error) {
      if (version === draft.version && owner === state.user?.id) showError(`feedback${kind}Error`, {
        message: error.name === 'InvalidStateError' ? 'This file could not be decoded as an image. Choose another screenshot.' : error.message,
      });
    } finally {
      if (version === draft.version) { draft.reading = false; draft.reader = null; input.disabled = false; screenshotStatus(kind); }
    }
  }
  function screenshotGallery(container, screenshots = []) {
    if (!screenshots.length) return;
    const list = node('ul', 'feedback-screenshots'); const version = state.viewVersion; const access = state.accessVersion;
    for (const [index, screenshot] of screenshots.entries()) {
      const item = node('li', 'feedback-shot'); const button = node('button', 'feedback-shot-open'); const preview = node('img');
      const label = `Screenshot ${index + 1}`; button.type = 'button'; button.disabled = true;
      button.title = `Open ${label.toLowerCase()}`; button.setAttribute('aria-label', button.title);
      preview.alt = label; preview.width = screenshot.width; preview.height = screenshot.height; preview.dataset.savedScreenshot = '';
      const progress = node('span', 'muted', 'Loading screenshot...'); button.append(progress); item.append(button); list.append(item);
      imageLoaders.set(button, async () => {
        try {
          const image = await api(screenshot.url, { image: true, signal: AbortSignal.any([state.reader.signal, AbortSignal.timeout(15000)]) });
          if (version !== state.viewVersion || access !== state.accessVersion || !state.ready || document.hidden) return;
          const url = URL.createObjectURL(image); imageUrls.add(url); preview.src = url; button.replaceChildren(preview); button.disabled = false;
          button.addEventListener('click', () => {
            if (!state.ready || !imageUrls.has(url)) return;
            byId('feedbackImage').src = url; byId('feedbackImage').alt = label; byId('feedbackImageTitle').textContent = label;
            byId('feedbackImageDownload').href = url; byId('feedbackImageDialog').showModal();
          });
        } catch (error) {
          if (version !== state.viewVersion || access !== state.accessVersion) return;
          if (!authError(error)) progress.textContent = 'Screenshot unavailable.';
        }
      });
      imageObserver.observe(button);
    }
    container.append(list);
  }

  function resetForm(kind) {
    const draft = drafts[kind]; draft.version++; draft.reader?.abort(); draft.reader = null; draft.reading = false; draft.images = [];
    clearDraftPreviews(kind); byId(`feedback${kind}Screenshots`).disabled = false; screenshotStatus(kind);
    byId(`feedback${kind}Form`).reset(); byId(`feedback${kind}Fields`).disabled = false;
    state[`${kind.toLowerCase()}Attempt`] = null; clearError(`feedback${kind}Error`);
    if (kind === 'Report') updateAudience();
  }
  function clearPrivateState() {
    clearImageViews();
    if (byId('feedbackReportDialog').open) byId('feedbackReportDialog').close();
    resetForm('Report'); resetForm('Reply'); state.moderationDraft = null; state.thread = null;
    for (const id of ['feedbackList', 'feedbackReplies', 'feedbackThreadBody', 'feedbackThreadMeta', 'feedbackPagination', 'feedbackReplyPagination']) byId(id).replaceChildren();
    for (const id of ['feedbackIdentity', 'feedbackThreadTitle', 'feedbackCount', 'feedbackReplyUnavailable']) byId(id).textContent = '';
    byId('feedbackListPanel').hidden = true; byId('feedbackThreadPanel').hidden = true; byId('feedbackAdminTools').hidden = true;
  }
  function identity() {
    byId('feedbackIdentity').textContent = state.user?.name || '';
    byId('feedbackSignIn').hidden = !!state.user; byId('feedbackNew').hidden = !state.user;
    for (const link of document.querySelectorAll('[data-view]')) link.hidden = link.dataset.view === 'mine' ? !state.user : link.dataset.view === 'all' ? !state.user?.isAdmin : false;
  }
  function suspend() {
    state.accessVersion++; state.viewVersion++; state.ready = false; state.reader?.abort();
    clearImageViews(); clearDraftPreviews('Report'); clearDraftPreviews('Reply');
    document.body.classList.add('feedback-auth-pending');
  }
  async function refreshSession() {
    suspend(); const version = state.accessVersion; clearError('feedbackError');
    try {
      const { user } = await api('/api/feedback/viewer', { account: false });
      if (version !== state.accessVersion) return;
      if (state.user?.id !== user?.id || state.user?.isAdmin !== user?.isAdmin) clearPrivateState();
      state.user = user; state.ready = true; identity(); updateAudience();
      renderDraftScreenshots('Report'); renderDraftScreenshots('Reply');
      await loadView();
    } catch (error) {
      if (version !== state.accessVersion) return;
      clearPrivateState(); state.user = null; identity();
      showError('feedbackError', { message: 'Sign-in status could not be checked. Refresh feedback to try again.' });
    } finally {
      if (version === state.accessVersion) { document.body.classList.remove('feedback-auth-pending'); byId('feedbackLoading').hidden = true; }
    }
  }
  function authError(error) {
    if (error.status !== 401 && error.status !== 403 && error.code !== 'FEEDBACK_ACCOUNT_CHANGED') return false;
    suspend(); clearPrivateState(); state.user = null; identity();
    notice('Your sign-in changed. Reopen the report before continuing.'); void refreshSession(); return true;
  }
  function pagination(id, result, change) {
    const container = byId(id); container.replaceChildren(); const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (pages === 1) return;
    const previous = action('Previous page', 'chevron-left', () => change(result.page - 1));
    const next = action('Next page', 'chevron-right', () => change(result.page + 1));
    previous.disabled = result.page <= 1; next.disabled = result.page >= pages;
    container.append(previous, node('span', 'muted', `Page ${result.page} of ${pages}`), next);
  }
  function metadata(thread) {
    const fragment = document.createDocumentFragment();
    fragment.append(badge(statuses[thread.status], thread.status), badge(categories[thread.category], thread.category),
      badge(thread.visibility === 'private' ? 'Private' : 'Public', thread.visibility), node('span', '', thread.author.name), node('time', '', stamp(thread.createdAt)));
    if (thread.author.isAdmin) fragment.append(badge('Admin', 'admin'));
    if (thread.hidden) fragment.append(badge('Hidden', 'hidden'));
    if (thread.locked) fragment.append(badge('Locked', 'closed'));
    return fragment;
  }
  function renderList(result) {
    const list = byId('feedbackList'); list.replaceChildren();
    byId('feedbackCount').textContent = `${result.total} ${result.total === 1 ? 'report' : 'reports'}`;
    byId('feedbackEmpty').hidden = result.items.length !== 0;
    for (const thread of result.items) {
      const item = node('li', 'feedback-list-row'); const symbol = node('span', 'feedback-row-symbol');
      symbol.append(icon(thread.category === 'bug' ? 'bug' : thread.category === 'request' ? 'lightbulb' : 'message-square'));
      const content = node('div', 'feedback-row-content'); const heading = node('h2'); const link = node('a', '', thread.title);
      link.href = `#thread=${thread.id}`; heading.append(link); const meta = node('div', 'feedback-meta'); meta.append(metadata(thread));
      meta.append(node('span', '', `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`));
      content.append(heading, meta); item.append(symbol, content); list.append(item);
    }
    pagination('feedbackPagination', result, page => { state.page = page; void loadView(); });
  }
  function prose(container, title, text) {
    if (!text) return;
    if (title) container.append(node('h3', '', title));
    container.append(node('p', '', text));
  }
  function renderThread(thread, replies) {
    state.thread = thread; state.replyTotal = replies.total;
    byId('feedbackThreadTitle').textContent = thread.title; byId('feedbackThreadMeta').replaceChildren(metadata(thread));
    const body = byId('feedbackThreadBody'); body.replaceChildren(); prose(body, '', thread.body);
    for (const [title, field] of [['Steps to reproduce', 'steps'], ['Expected behavior', 'expected'], ['Actual behavior', 'actual'], ['Page area and device', 'context']]) prose(body, title, thread[field]);
    screenshotGallery(body, thread.screenshots);
    byId('feedbackBack').href = `#${state.view}`; byId('feedbackAdminTools').hidden = !state.user?.isAdmin;
    if (state.user?.isAdmin && !state.moderationDraft) {
      byId('feedbackEditStatus').value = thread.status; byId('feedbackHidden').checked = thread.hidden; byId('feedbackLocked').checked = thread.locked;
    }
    const list = byId('feedbackReplies'); list.replaceChildren();
    for (const reply of replies.items) {
      const item = node('li', 'feedback-reply'); const head = node('div', 'feedback-meta');
      head.append(node('strong', '', reply.author.name), node('time', '', stamp(reply.createdAt)));
      if (reply.author.isAdmin) head.append(badge('Admin', 'admin'));
      if (reply.hidden) head.append(badge('Hidden', 'hidden'));
      if (state.user?.isAdmin) head.append(action(reply.hidden ? 'Restore reply' : 'Hide reply', reply.hidden ? 'eye' : 'eye-off', () => {
        void mutate(null, () => api(`/api/admin/feedback/${thread.id}/replies/${reply.id}`, {
          method: 'PATCH', body: { revision: thread.revision, hidden: !reply.hidden },
        }), () => notice('Reply visibility updated.'));
      }));
      const text = node('div', 'feedback-prose'); prose(text, '', reply.body); screenshotGallery(text, reply.screenshots); item.append(head, text); list.append(item);
    }
    byId('feedbackRepliesTitle').textContent = `Conversation (${replies.total})`;
    byId('feedbackReplyForm').hidden = !thread.canReply;
    byId('feedbackReplyUnavailable').textContent = !state.user ? 'Sign in to reply.' : thread.hidden ? 'This thread is hidden.' : !thread.canReply ? 'Tester replies are locked.'
      : thread.visibility === 'public' ? 'Replies and their screenshots are public.' : 'Replies and their screenshots are visible only to the reporter and administrators.';
    pagination('feedbackReplyPagination', replies, page => { state.replyPage = page; void loadView(); });
  }

  async function loadView() {
    if (!state.ready) return;
    clearImageViews();
    const version = ++state.viewVersion; const accessVersion = state.accessVersion;
    state.reader?.abort(); state.reader = new AbortController();
    const signal = AbortSignal.any([state.reader.signal, AbortSignal.timeout(15000)]);
    const threadId = location.hash.match(/^#thread=([a-f0-9-]{36})$/)?.[1];
    if (!threadId) {
      const requested = location.hash.slice(1); state.view = ['public', 'mine', 'all'].includes(requested) ? requested : 'public';
      if ((state.view === 'mine' && !state.user) || (state.view === 'all' && !state.user?.isAdmin)) state.view = 'public';
      state.thread = null;
    }
    for (const link of document.querySelectorAll('[data-view]')) {
      if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    byId('feedbackFilters').hidden = !!threadId; byId('feedbackLoading').hidden = false;
    byId('feedbackListPanel').hidden = true; byId('feedbackThreadPanel').hidden = true;
    clearError('feedbackError');
    try {
      if (threadId) {
        const [detail, replies] = await Promise.all([api(`/api/feedback/${threadId}`, { signal }), api(`/api/feedback/${threadId}/replies?page=${state.replyPage}`, { signal })]);
        if (version !== state.viewVersion || accessVersion !== state.accessVersion) return;
        renderThread(detail.thread, replies); byId('feedbackThreadPanel').hidden = false;
      } else {
        const query = new URLSearchParams({ page: String(state.page), q: byId('feedbackQuery').value.trim(), category: byId('feedbackCategory').value, status: byId('feedbackStatus').value });
        const endpoint = state.view === 'mine' ? '/api/feedback/mine' : state.view === 'all' ? '/api/admin/feedback' : '/api/feedback';
        const result = await api(`${endpoint}?${query}`, { signal, account: state.view !== 'public' });
        if (version !== state.viewVersion || accessVersion !== state.accessVersion) return;
        renderList(result); byId('feedbackListPanel').hidden = false;
      }
      icons();
    } catch (error) {
      if (version !== state.viewVersion || accessVersion !== state.accessVersion || error.name === 'AbortError') return;
      if (threadId) { state.thread = null; byId('feedbackThreadBody').replaceChildren(); byId('feedbackThreadTitle').textContent = ''; }
      if (!authError(error)) showError('feedbackError', error);
    } finally {
      if (version === state.viewVersion) { byId('feedbackLoading').hidden = true; document.body.dataset.loaded = String(version); }
    }
  }

  function freezeAttempt(kind) {
    if (!kind || !state[`${kind.toLowerCase()}Attempt`]) return;
    byId(`feedback${kind}Fields`).disabled = true;
    showError(`feedback${kind}Error`, { message: 'The result is not confirmed. Submit again to retry the same request without changing it.' });
  }
  async function mutate(kind, operation, success) {
    if (state.busy || !state.ready) return;
    const errorId = kind ? `feedback${kind}Error` : 'feedbackError'; clearError(errorId);
    const accessVersion = state.accessVersion; const userId = state.user?.id;
    const fields = kind ? byId(`feedback${kind}Fields`) : null;
    const buttons = [...document.querySelectorAll('button')].map(button => [button, button.disabled]);
    state.busy = true; if (fields) fields.disabled = true;
    for (const [button] of buttons) button.disabled = true;
    try {
      const result = await operation();
      if (accessVersion !== state.accessVersion) { if (userId === state.user?.id) freezeAttempt(kind); return; }
      if (fields) fields.disabled = false;
      success?.(result); await loadView();
    } catch (error) {
      if (accessVersion !== state.accessVersion) { if (userId === state.user?.id) freezeAttempt(kind); return; }
      if (authError(error)) return;
      if (kind && (!error.status || error.status >= 500)) freezeAttempt(kind);
      else {
        if (kind) { state[`${kind.toLowerCase()}Attempt`] = null; fields.disabled = false; }
        showError(errorId, error);
      }
    } finally {
      state.busy = false;
      for (const [button, disabled] of buttons) if (button.isConnected) button.disabled = disabled;
    }
  }
  function updateAudience() {
    const isPublic = byId('feedbackReportForm').elements.visibility.value === 'public';
    byId('feedbackPublicConsentLabel').hidden = !isPublic; byId('feedbackPublicConsent').required = isPublic;
    byId('feedbackAudience').textContent = isPublic
        ? `Anyone can read and copy this report, its replies, and screenshots. Your public name is ${state.user?.name || 'Tester'}. Do not include private account or learning data.`
        : 'Only you and administrators can read, reply, and view screenshots. Do not include passwords, verification codes, or invitation links.';
  }
      function reportDirty() { return !!state.reportAttempt || drafts.Report.images.length || drafts.Report.reading || [...byId('feedbackReportForm').querySelectorAll('input[type="text"], textarea')].some(input => input.value.trim()); }
      function replyDirty() { return !!state.replyAttempt || byId('feedbackReplyBody').value.trim() || drafts.Reply.images.length || drafts.Reply.reading; }
  function closeReport(force = false) {
    if (!force && (state.busy || (reportDirty() && !confirm('Discard this draft? An unconfirmed submission may already have been saved.')))) return;
    byId('feedbackReportDialog').close(); resetForm('Report');
  }
  byId('feedbackNew').addEventListener('click', () => {
    if (!state.user || !state.ready || state.busy) return;
    resetForm('Report'); byId('feedbackReportDialog').showModal();
  });
  byId('feedbackReportForm').addEventListener('change', updateAudience);
  for (const kind of ['Report', 'Reply']) byId(`feedback${kind}Screenshots`).addEventListener('change', event => { void selectScreenshots(kind, event.currentTarget); });
  byId('feedbackReportForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    if (!state.user || !state.ready || state.busy || !form.reportValidity()) return;
    if (drafts.Report.reading) return showError('feedbackReportError', { message: 'Wait for the screenshots to finish loading.' });
    if (!state.reportAttempt) {
      state.reportAttempt = { submissionId: crypto.randomUUID(), publicConsent: byId('feedbackPublicConsent').checked };
      for (const name of ['category', 'visibility', 'title', 'body', 'steps', 'expected', 'actual', 'context']) state.reportAttempt[name] = form.elements[name].value;
      if (drafts.Report.images.length) state.reportAttempt.screenshots = drafts.Report.images.map(image => image.encoded);
    }
    const attempt = state.reportAttempt;
    void mutate('Report', () => api('/api/feedback', { method: 'POST', body: attempt }), result => {
      closeReport(true); notice('Report saved.'); state.replyPage = 1; state.moderationDraft = null;
      state.lastHash = `#thread=${result.thread.id}`; location.hash = state.lastHash;
    });
  });
  byId('feedbackReplyForm').addEventListener('submit', event => {
    event.preventDefault(); if (!state.ready || state.busy || !state.thread?.canReply || !event.currentTarget.reportValidity()) return;
    if (drafts.Reply.reading) return showError('feedbackReplyError', { message: 'Wait for the screenshots to finish loading.' });
    if (!state.replyAttempt) state.replyAttempt = { submissionId: crypto.randomUUID(), body: byId('feedbackReplyBody').value,
      ...(drafts.Reply.images.length ? { screenshots: drafts.Reply.images.map(image => image.encoded) } : {}) };
    const threadId = state.thread.id; const attempt = state.replyAttempt;
    void mutate('Reply', () => api(`/api/feedback/${threadId}/replies`, { method: 'POST', body: attempt }), result => {
      resetForm('Reply'); state.replyPage = Math.max(1, Math.ceil((state.replyTotal + (result.replayed ? 0 : 1)) / 25)); notice('Reply added.');
    });
  });
  byId('feedbackModeration').addEventListener('change', () => {
    if (!state.thread) return;
    state.moderationDraft = { revision: state.moderationDraft?.revision || state.thread.revision,
      status: byId('feedbackEditStatus').value, hidden: byId('feedbackHidden').checked, locked: byId('feedbackLocked').checked };
  });
  byId('feedbackModeration').addEventListener('submit', event => {
    event.preventDefault(); if (!state.thread || !state.user?.isAdmin || !state.moderationDraft) return;
    const threadId = state.thread.id; const draft = state.moderationDraft;
    void mutate(null, () => api(`/api/admin/feedback/${threadId}`, { method: 'PATCH', body: draft }), () => { state.moderationDraft = null; notice('Report status updated.'); });
  });
  for (const button of document.querySelectorAll('[data-dismiss]')) button.addEventListener('click', () => closeReport());
  byId('feedbackReportDialog').addEventListener('cancel', event => { event.preventDefault(); closeReport(); });
  byId('feedbackImageClose').addEventListener('click', () => byId('feedbackImageDialog').close());
  byId('feedbackImageDialog').addEventListener('close', () => {
    byId('feedbackImage').removeAttribute('src'); byId('feedbackImageDownload').removeAttribute('href');
    byId('feedbackImageDialog').classList.remove('is-zoomed'); byId('feedbackImageZoom').setAttribute('aria-pressed', 'false');
  });
  byId('feedbackImageZoom').addEventListener('click', () => {
    const zoomed = byId('feedbackImageDialog').classList.toggle('is-zoomed'); byId('feedbackImageZoom').setAttribute('aria-pressed', String(zoomed));
  });
  byId('feedbackFilters').addEventListener('submit', event => { event.preventDefault(); state.page = 1; void loadView(); });
  for (const id of ['feedbackCategory', 'feedbackStatus']) byId(id).addEventListener('change', () => { state.page = 1; void loadView(); });
  byId('feedbackRefresh').addEventListener('click', () => { state.moderationDraft = null; void refreshSession(); });
  window.addEventListener('hashchange', () => {
    if (location.hash === state.lastHash) return;
    if (state.busy || ((replyDirty() || state.moderationDraft) && !confirm('Discard the unsaved changes on this thread?'))) {
      history.replaceState(null, '', state.lastHash || '#public'); return;
    }
    resetForm('Reply'); state.moderationDraft = null; state.lastHash = location.hash; state.page = 1; state.replyPage = 1; notice(''); void loadView();
  });
  window.addEventListener('focus', () => { void refreshSession(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void refreshSession(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else void refreshSession(); });
  window.addEventListener('pagehide', () => { suspend(); clearPrivateState(); state.user = null; identity(); });
  window.addEventListener('beforeunload', event => {
    if (state.busy || replyDirty() || state.moderationDraft || (byId('feedbackReportDialog').open && reportDirty())) {
      event.preventDefault(); event.returnValue = '';
    }
  });
  document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('feedbackContent').focus(); });
  icons(); void refreshSession();
})();