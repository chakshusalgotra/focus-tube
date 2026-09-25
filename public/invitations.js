'use strict';

window.InvitationSettings = class InvitationSettings {
  constructor({ getAccount, el, icon }) {
    this.getAccount = getAccount;
    this.el = el;
    this.icon = icon;
    this.get = id => document.getElementById(id);
    this.version = 0;
    this.controllers = new Set();
    this.retryUntil = 0;
    this.listRetryUntil = 0;
    this.retryOwner = null;
    this.close();
    this.get('inviteForm').addEventListener('submit', event => { event.preventDefault(); return this.create(); });
    this.get('inviteLifetime').addEventListener('change', () => this.syncLifetime());
    this.get('inviteCustomExpiry').addEventListener('input', () => this.get('inviteCustomExpiry').setCustomValidity(''));
    this.get('inviteMaxUses').addEventListener('input', () => this.get('inviteMaxUses').setCustomValidity(''));
    this.get('copyInvite').addEventListener('click', () => this.copy());
    this.get('inviteRefresh').addEventListener('click', () => this.loadPage(this.cursors[this.page], this.page));
    this.get('invitePrevious').addEventListener('click', () => {
      if (this.page > 0) return this.loadPage(this.cursors[this.page - 1], this.page - 1);
    });
    this.get('inviteNext').addEventListener('click', () => {
      if (this.nextCursor !== null) return this.loadPage(this.nextCursor, this.page + 1);
    });
    this.get('inviteEditForm').addEventListener('submit', event => { event.preventDefault(); return this.saveEdit(); });
    this.get('inviteEditCancel').addEventListener('click', () => this.cancelEdit());
    this.get('inviteEditRefresh').addEventListener('click', () => this.refreshEdit());
    this.get('inviteEditExpiry').addEventListener('input', () => this.get('inviteEditExpiry').setCustomValidity(''));
  }

  static localValue(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  static expiry(value) {
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value) || !Number.isFinite(date.getTime()) ||
      InvitationSettings.localValue(date).slice(0, value.length) !== value) {
      throw new Error('Choose a valid local date and time. Times skipped by a clock change are not valid.');
    }
    const remaining = date.getTime() - Date.now();
    if (remaining <= 0 || remaining > 365 * 86400000) throw new Error('Expiry must be in the future and within 365 days.');
    return date.toISOString();
  }

  static item(value) {
    if (!value || !['id', 'revision', 'maxUses', 'useCount', 'remaining'].every(key => Number.isSafeInteger(value[key])) ||
      value.id <= 0 || value.id >= Number.MAX_SAFE_INTEGER || value.revision < 1 || value.maxUses < 1 || value.maxUses > 1000 ||
      value.useCount < 0 || value.useCount > value.maxUses || value.remaining < 0 || value.remaining > value.maxUses - value.useCount ||
      !['active', 'expired', 'exhausted', 'revoked'].includes(value.status) ||
      !['createdAt', 'expiresAt'].every(key => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key])) && new Date(value[key]).toISOString() === value[key])) {
      throw new Error('Invalid invitation details.');
    }
    return Object.fromEntries(['id', 'createdAt', 'expiresAt', 'maxUses', 'useCount', 'remaining', 'status', 'revision'].map(key => [key, value[key]]));
  }

  static pageData(data, before = null) {
    if (!Array.isArray(data.invitations) || data.invitations.length > 50) throw new Error('Invalid invitation page.');
    const items = data.invitations.map(InvitationSettings.item);
    if (items.some((item, index) => item.id >= (index ? items[index - 1].id : before ?? Number.MAX_SAFE_INTEGER)) ||
      (data.nextCursor !== null && (!Number.isSafeInteger(data.nextCursor) || !items.length || data.nextCursor !== items.at(-1).id))) {
      throw new Error('Invalid invitation cursor.');
    }
    return { items, nextCursor: data.nextCursor };
  }

  status(item) {
    return item.status === 'active' && Date.parse(item.expiresAt) <= Date.now() ? 'expired' : item.status;
  }

  date(value) {
    return new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  }

  message(id, text) {
    const target = this.get(id);
    target.textContent = text;
    target.classList.toggle('hidden', !text);
  }

  close() {
    this.version++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    clearTimeout(this.retryTimer);
    this.owner = null;
    this.active = false;
    this.busy = false;
    this.loading = null;
    this.items = [];
    this.rowButtons = [];
    this.issuedItem = null;
    this.cursors = [null];
    this.page = 0;
    this.nextCursor = null;
    this.loaded = false;
    this.get('inviteList').replaceChildren();
    this.get('invitePage').textContent = '';
    this.message('inviteListStatus', '');
    this.message('inviteListError', '');
    this.get('inviteMaxUses').value = '1';
    this.get('inviteMaxUses').setCustomValidity('');
    this.get('inviteLifetime').value = '7';
    this.get('inviteCustomExpiry').value = '';
    this.get('issuedInviteLink').value = '';
    this.get('inviteExpiry').textContent = '';
    this.get('inviteResult').classList.add('hidden');
    this.message('inviteError', '');
    this.message('inviteStatus', '');
    this.cancelEdit(false);
    this.syncLifetime();
  }

  open() {
    this.close();
    const account = this.getAccount();
    if (!account?.id || !account.isAdmin || account.isGuest || !this.get('profileModal').open) return;
    this.owner = { id: account.id, generation: account.generation };
    const retryOwner = `${account.id}:${account.generation}`;
    if (this.retryOwner !== retryOwner) this.retryUntil = this.listRetryUntil = 0;
    this.retryOwner = retryOwner;
    this.get('inviteTimezone').textContent = `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time'}.`;
    for (const [until, target] of [[this.retryUntil, 'inviteError'], [this.listRetryUntil, 'inviteListError']]) {
      if (until > Date.now()) this.message(target, `Invitations are rate limited. Try again after ${this.date(new Date(until).toISOString())}.`);
    }
    this.sync();
    this.scheduleRetry();
  }

  syncAccount() {
    if (this.owner && !this.matches(this.snapshot())) this.close();
  }

  activate(active) {
    this.syncAccount();
    const entering = active && !this.active;
    this.active = active && !!this.owner;
    if (this.active && (entering || !this.loaded) && !this.loading) return this.loadPage(this.cursors[this.page], this.page);
  }

  snapshot() {
    return { ...this.owner, version: this.version };
  }

  matches(snapshot) {
    const account = this.getAccount();
    return !!this.owner && snapshot.version === this.version && snapshot.id === this.owner.id &&
      snapshot.id === account?.id && snapshot.generation === account.generation && account.isAdmin &&
      !account.isGuest && this.get('profileModal').open;
  }

  accept(snapshot) {
    if (this.matches(snapshot)) return true;
    if (snapshot.version === this.version) this.close();
    return false;
  }

  syncLifetime() {
    const custom = this.get('inviteLifetime').value === 'custom';
    this.get('inviteCustomField').classList.toggle('hidden', !custom);
    this.get('inviteCustomExpiry').required = custom;
    this.get('inviteCustomExpiry').setCustomValidity('');
    this.sync();
  }

  sync() {
    const unavailable = !this.owner || this.busy;
    this.get('createInvite').disabled = unavailable || !!this.loading || !!this.editing || Date.now() < this.retryUntil;
    this.get('createInvite').setAttribute('aria-busy', String(this.busy));
    this.get('inviteForm').setAttribute('aria-busy', String(this.busy));
    this.get('inviteMaxUses').disabled = unavailable;
    this.get('inviteLifetime').disabled = unavailable;
    this.get('inviteCustomExpiry').disabled = unavailable || this.get('inviteLifetime').value !== 'custom';
    this.get('copyInvite').disabled = !this.owner || !this.get('issuedInviteLink').value || !!this.issuedItem && this.status(this.issuedItem) !== 'active';
    const readBlocked = unavailable || !!this.loading || !!this.reviewing || Date.now() < this.listRetryUntil;
    this.get('inviteList').setAttribute('aria-busy', String(!!this.loading));
    this.get('inviteRefresh').disabled = readBlocked;
    this.get('invitePrevious').disabled = readBlocked || !!this.editing || this.page === 0;
    this.get('inviteNext').disabled = readBlocked || !!this.editing || this.nextCursor === null;
    for (const button of this.rowButtons) button.disabled = unavailable || !!this.loading || !!this.editing;
    const editor = this.editing;
    const editable = editor && !editor.missing && !editor.stale && ['active', 'expired'].includes(this.status(editor.item));
    this.get('inviteEditSubmit').disabled = unavailable || !!this.loading || !!this.reviewing || !editable || Date.now() < this.retryUntil;
    this.get('inviteEditCancel').disabled = this.busy;
    this.get('inviteEditRefresh').disabled = readBlocked || !editor;
    this.get('inviteEditExpiry').disabled = unavailable || editor?.action !== 'edit';
    this.get('inviteReactivate').disabled = unavailable || editor?.action !== 'edit' || this.status(editor.item) !== 'expired';
    this.get('inviteEditForm').setAttribute('aria-busy', String(this.busy && !!editor || !!this.reviewing));
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const snapshot = this.snapshot();
    const delays = [this.retryUntil, this.listRetryUntil].map(until => until - Date.now()).filter(delay => delay > 0);
    if (delays.length) this.retryTimer = setTimeout(() => {
      if (this.accept(snapshot)) { this.sync(); this.scheduleRetry(); }
    }, Math.min(...delays));
  }

  async request(url, snapshot, method = 'GET', body) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      if (!this.accept(snapshot)) throw new Error('Invitation view closed.');
      const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Invite-Account': String(snapshot.id) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!this.accept(snapshot) || controller.signal.aborted) throw new Error('Invitation request interrupted.');
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Administrator access is no longer available. Close Settings and sign in again.'), { status: response.status });
      if (response.headers.get('X-Invite-Account') !== String(snapshot.id)) {
        throw Object.assign(new Error('Invitation account could not be verified. Close Settings and reopen.'), { code: 'INVITATION_ACCOUNT_CHANGED' });
      }
      const data = await response.json();
      if (!this.accept(snapshot) || controller.signal.aborted) throw new Error('Invitation request interrupted.');
      if (!response.ok) throw Object.assign(new Error(data.error || 'Invitation request failed.'), {
        status: response.status, code: data.code, retryAfter: Number(response.headers.get('Retry-After')) || 0,
      });
      return data;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  failure(error, target = 'inviteError', read = false) {
    if ([401, 403].includes(error.status) || error.code === 'INVITATION_ACCOUNT_CHANGED') {
      this.close();
      this.message('inviteError', error.message);
      return;
    }
    let message = error.message;
    if (error.status === 429) {
      const seconds = Math.min(Math.max(error.retryAfter || 60, 1), 3600);
      const until = Date.now() + seconds * 1000;
      this[read ? 'listRetryUntil' : 'retryUntil'] = until;
      message = `Too many invitation ${read ? 'requests' : 'changes'}. Try again after ${this.date(new Date(until).toISOString())}. Your form is kept.`;
      this.scheduleRetry();
    } else if (!error.status || error.status >= 500) {
      message = read ? 'Could not load invitations. Check your connection and refresh. Any displayed invitations are from the last successful load.' :
        'The request could not be confirmed. Check your connection and refresh invitations before retrying; the change may already have completed.';
    }
    this.message(target, message);
  }

  async loadPage(before = null, page = 0) {
    const snapshot = this.snapshot();
    if (!this.accept(snapshot) || !this.active || this.loading || this.busy || this.reviewing || this.editing && page !== this.page || Date.now() < this.listRetryUntil) return;
    const loading = {};
    this.loading = loading;
    this.message('inviteListError', '');
    this.message('inviteListStatus', 'Loading invitations...');
    this.sync();
    try {
      const data = await this.request(`/api/invites?limit=50${before === null ? '' : `&before=${before}`}`, snapshot);
      if (!this.accept(snapshot) || this.loading !== loading || !this.active) return;
      const { items, nextCursor } = InvitationSettings.pageData(data, before);
      this.items = items;
      this.page = page;
      this.cursors = [...this.cursors.slice(0, page), before];
      this.nextCursor = nextCursor;
      this.loaded = true;
      this.renderList();
      const latest = items.find(item => item.id === this.editing?.item.id);
      if (latest && latest.revision !== this.editing.item.revision) {
        this.editing.stale = true;
        this.message('inviteEditError', 'This invitation changed. Your date is kept. Refresh its details before saving again.');
      }
      this.message('inviteListStatus', items.length ? `Updated ${this.date(new Date().toISOString())}.` :
        page === 0 ? 'No member invitations yet.' : 'No older invitations remain on this page. Previous pages are still available.');
    } catch (error) {
      if (!this.accept(snapshot) || this.loading !== loading || !this.active) return;
      this.message('inviteListStatus', '');
      this.failure(error, 'inviteListError', true);
    } finally {
      if (this.matches(snapshot) && this.loading === loading) { this.loading = null; this.sync(); }
    }
  }

  renderList() {
    this.rowButtons = [];
    const snapshot = this.snapshot();
    this.get('inviteList').replaceChildren(...this.items.map(item => {
      const status = this.status(item);
      const actions = this.el('div', { class: 'invitation-row-actions' });
      if (['active', 'expired'].includes(status)) {
        for (const [action, label, symbol] of [['edit', 'Edit expiry', 'CalendarClock'], ['revoke', 'Revoke', 'Ban']]) {
          const button = this.el('button', { type: 'button', class: 'btn ghost slim', id: `invitation-${action}-${item.id}`,
            'aria-label': `${label} for invitation #${item.id}`, 'aria-controls': 'inviteEditForm',
            onclick: () => { if (this.accept(snapshot)) this.beginEdit(item.id, action); } }, this.el('span', { html: this.icon(symbol) }), label);
          this.rowButtons.push(button);
          actions.append(button);
        }
      }
      return this.el('li', { class: 'invitation-row', id: `invitation-row-${item.id}` },
        this.el('div', { class: 'invitation-row-heading' }, this.el('strong', { id: `invitation-heading-${item.id}`, tabindex: '-1' }, `Invitation #${item.id}`),
          this.el('span', { class: 'invitation-state', 'data-status': status }, status[0].toUpperCase() + status.slice(1))),
        this.el('p', { class: 'invitation-counts' }, `${item.useCount} of ${item.maxUses} signups used. ${item.maxUses - item.useCount} unused slots; ${status === 'active' ? item.remaining : 0} available now.`),
        this.el('div', { class: 'invitation-dates' },
          this.el('span', {}, 'Expires ', this.el('time', { datetime: item.expiresAt, title: item.expiresAt }, this.date(item.expiresAt))),
          this.el('span', {}, 'Created ', this.el('time', { datetime: item.createdAt, title: item.createdAt }, this.date(item.createdAt)))), actions);
    }));
    this.get('invitePage').textContent = `Page ${this.page + 1}. ${this.items.length} invitations shown.${this.nextCursor === null ? ' End of list.' : ''}`;
    const issued = this.items.find(item => item.id === this.issuedItem?.id);
    if (issued && issued.revision >= this.issuedItem.revision) this.renderIssued(issued);
  }

  renderIssued(item) {
    this.issuedItem = item;
    const status = this.status(item);
    this.get('inviteExpiry').textContent = `Limit: ${item.maxUses} signup${item.maxUses === 1 ? '' : 's'}. Expires ${this.date(item.expiresAt)} (${item.expiresAt}). ${status[0].toUpperCase() + status.slice(1)}.`;
  }

  beginEdit(id, action) {
    if (!this.accept(this.snapshot()) || !this.active || this.busy || this.loading || this.editing) return;
    const item = this.items.find(candidate => candidate.id === id);
    if (!item || !['active', 'expired'].includes(this.status(item)) || !['edit', 'revoke'].includes(action)) return;
    this.editing = { item, action, stale: false, missing: false };
    this.get('inviteEditExpiry').value = InvitationSettings.localValue(new Date(item.expiresAt));
    this.get('inviteEditExpiry').setCustomValidity('');
    this.get('inviteReactivate').checked = false;
    this.message('inviteEditError', '');
    this.message('inviteEditStatus', '');
    this.renderEdit();
    this.get(action === 'edit' ? 'inviteEditExpiry' : 'inviteEditCancel').focus();
  }

  renderEdit() {
    const editor = this.editing;
    if (!editor) return;
    const { item, action } = editor;
    const status = this.status(item);
    const editing = action === 'edit';
    this.get('inviteEditForm').classList.remove('hidden');
    this.get('inviteEditHeading').textContent = `${editing ? 'Edit expiry for' : 'Revoke'} invitation #${item.id}`;
    this.get('inviteEditSummary').textContent = `${status[0].toUpperCase() + status.slice(1)}. ${item.useCount} of ${item.maxUses} signups used. ${item.maxUses - item.useCount} unused slots. Current expiry: ${this.date(item.expiresAt)} (${item.expiresAt}).`;
    this.message('inviteEditWarning', editing ? '' : 'Revocation immediately prevents further signups and cannot be undone. Existing accounts are unchanged.');
    this.get('inviteEditExpiryField').classList.toggle('hidden', !editing);
    this.get('inviteEditExpiry').required = editing;
    this.get('inviteReactivateField').classList.toggle('hidden', !editing || status !== 'expired');
    this.get('inviteReactivate').required = editing && status === 'expired';
    this.get('inviteEditSubmit').classList.toggle('danger', !editing);
    this.get('inviteEditSubmit').replaceChildren(this.el('span', { html: this.icon(editing ? 'Check' : 'Ban') }),
      editing ? status === 'expired' ? 'Reactivate invitation' : 'Save expiry' : 'Revoke invitation');
    this.sync();
  }

  cancelEdit(focus = true) {
    if (this.busy) return;
    const editor = this.editing;
    this.editing = null;
    this.reviewing = null;
    this.get('inviteEditForm').classList.add('hidden');
    this.get('inviteEditHeading').textContent = '';
    this.get('inviteEditSummary').textContent = '';
    this.get('inviteEditExpiry').value = '';
    this.get('inviteEditExpiry').setCustomValidity('');
    this.get('inviteReactivate').checked = false;
    this.message('inviteEditError', '');
    this.message('inviteEditStatus', '');
    this.message('inviteEditWarning', '');
    this.sync();
    if (focus && this.active && editor) this.get(`invitation-heading-${editor.item.id}`)?.focus();
  }

  async refreshEdit() {
    const snapshot = this.snapshot();
    const editor = this.editing;
    if (!editor || !this.accept(snapshot) || !this.active || this.busy || this.loading || this.reviewing || Date.now() < this.listRetryUntil) return;
    this.reviewing = editor;
    this.message('inviteEditStatus', 'Checking latest invitation details...');
    this.sync();
    try {
      const data = await this.request(`/api/invites?limit=50&before=${editor.item.id + 1}`, snapshot);
      if (!this.accept(snapshot) || this.editing !== editor || this.reviewing !== editor) return;
      const latest = InvitationSettings.pageData(data, editor.item.id + 1).items.find(item => item.id === editor.item.id);
      if (!latest) {
        editor.missing = true;
        this.message('inviteEditError', 'This invitation no longer exists. Your chosen date is kept; cancel to create a new invitation.');
        this.message('inviteEditStatus', '');
        return;
      }
      if (latest.revision !== editor.item.revision || this.status(latest) !== this.status(editor.item)) this.get('inviteReactivate').checked = false;
      editor.item = latest;
      editor.stale = editor.missing = false;
      this.items = this.items.map(item => item.id === latest.id ? latest : item);
      if (this.issuedItem?.id === latest.id) this.renderIssued(latest);
      this.renderList();
      this.renderEdit();
      this.message('inviteEditError', ['revoked', 'exhausted'].includes(this.status(latest)) ? 'This invitation cannot be changed or reactivated. Create a new invitation instead.' : '');
      this.message('inviteEditStatus', 'Latest details loaded. Review them before confirming. Your chosen date is unchanged.');
    } catch (error) {
      if (this.accept(snapshot) && this.editing === editor) { this.message('inviteEditStatus', ''); this.failure(error, 'inviteEditError', true); }
    } finally {
      if (this.matches(snapshot) && this.reviewing === editor) { this.reviewing = null; this.sync(); }
    }
  }

  async saveEdit() {
    const snapshot = this.snapshot();
    const editor = this.editing;
    if (!editor || !this.accept(snapshot) || !this.active || this.busy || this.loading || this.reviewing || editor.stale || editor.missing || Date.now() < this.retryUntil) return;
    const status = this.status(editor.item);
    if (!['active', 'expired'].includes(status)) return;
    this.renderEdit();
    const body = { revision: editor.item.revision };
    if (editor.action === 'edit') {
      try { body.expiresAt = InvitationSettings.expiry(this.get('inviteEditExpiry').value); }
      catch (error) {
        this.get('inviteEditExpiry').setCustomValidity(error.message);
        this.message('inviteEditError', error.message);
        this.get('inviteEditForm').reportValidity();
        return;
      }
      if (status === 'expired') {
        if (!this.get('inviteReactivate').checked) {
          this.message('inviteEditError', 'Confirm reactivation of this expired invitation before saving.');
          this.get('inviteEditForm').reportValidity();
          return;
        }
        body.reactivate = true;
      }
    }
    if (!this.get('inviteEditForm').reportValidity()) return;
    this.busy = true;
    this.sync();
    this.message('inviteEditError', '');
    this.message('inviteEditStatus', editor.action === 'edit' ? 'Saving expiry...' : 'Revoking invitation...');
    try {
      const data = await this.request(`/api/invites/${editor.item.id}`, snapshot, editor.action === 'edit' ? 'PATCH' : 'DELETE', body);
      if (!this.accept(snapshot) || this.editing !== editor) return;
      const item = InvitationSettings.item(data);
      if (item.id !== editor.item.id || item.revision <= editor.item.revision) throw new Error('Invalid invitation update.');
      this.items = this.items.map(previous => previous.id === item.id ? item : previous);
      if (this.issuedItem?.id === item.id) this.renderIssued(item);
      this.renderList();
      this.busy = false;
      this.cancelEdit();
      this.message('inviteListStatus', editor.action === 'edit' ? `Invitation #${item.id} expiry saved: ${this.date(item.expiresAt)} (${item.expiresAt}).` : `Invitation #${item.id} revoked.`);
    } catch (error) {
      if (!this.accept(snapshot) || this.editing !== editor) return;
      const messages = {
        INVITATION_CHANGED: 'This invitation changed. Your date is kept. Refresh its details before saving again.',
        INVITATION_REVOKED: 'This invitation was revoked and cannot be reactivated. Refresh its details; your date is kept.',
        INVITATION_EXHAUSTED: 'All signup slots have been used. Refresh its details; this invitation cannot be reactivated.',
        INVITATION_REACTIVATION_REQUIRED: 'This invitation expired. Confirm reactivation before saving.',
        INVITATION_NOT_FOUND: 'This invitation no longer exists. Your date is kept; cancel to create a new invitation.',
      };
      if (['INVITATION_CHANGED', 'INVITATION_REVOKED', 'INVITATION_EXHAUSTED'].includes(error.code)) editor.stale = true;
      if (error.code === 'INVITATION_NOT_FOUND') editor.missing = true;
      if (error.code === 'INVITATION_REACTIVATION_REQUIRED') { editor.item = { ...editor.item, status: 'expired' }; this.get('inviteReactivate').checked = false; }
      this.message('inviteEditStatus', '');
      this.renderEdit();
      this.failure(Object.assign(error, { message: messages[error.code] || error.message }), 'inviteEditError');
    } finally {
      if (this.matches(snapshot)) { this.busy = false; this.sync(); }
    }
  }

  async create() {
    const snapshot = this.snapshot();
    if (!this.accept(snapshot) || !this.active || this.busy || this.loading || this.editing || Date.now() < this.retryUntil) return;
    const limit = this.get('inviteMaxUses');
    const maxUses = limit.valueAsNumber;
    limit.setCustomValidity(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 1000 ? '' : 'Choose 1 to 1000 allowed signups.');
    const body = { maxUses };
    const lifetime = this.get('inviteLifetime').value;
    try {
      if (lifetime === 'custom') body.expiresAt = InvitationSettings.expiry(this.get('inviteCustomExpiry').value);
      else if (lifetime === '1' || lifetime === '30') body.expiresAt = new Date(Date.now() + Number(lifetime) * 86400000).toISOString();
      else if (lifetime !== '7') throw new Error('Choose an invitation lifetime.');
    } catch (error) {
      this.get('inviteCustomExpiry').setCustomValidity(error.message);
      this.message('inviteError', error.message);
      this.get('inviteForm').reportValidity();
      return;
    }
    if (!this.get('inviteForm').reportValidity()) return;
    this.busy = true;
    this.sync();
    this.message('inviteError', '');
    this.message('inviteStatus', 'Creating invitation...');
    let created = false;
    try {
      const result = await this.request('/api/invites', snapshot, 'POST', body);
      if (!this.accept(snapshot)) return;
      const item = InvitationSettings.item(result);
      const url = new URL(result.inviteUrl);
      if (url.origin !== window.location.origin || url.pathname !== '/' || url.search || !/^#join=[A-Za-z0-9_-]{43}$/.test(url.hash) || url.username || url.password) throw new Error('Invalid invitation response.');
      this.get('issuedInviteLink').value = result.inviteUrl;
      this.renderIssued(item);
      this.get('inviteResult').classList.remove('hidden');
      this.message('inviteStatus', 'Invitation created. This link is only available until Settings closes.');
      this.loaded = false;
      created = true;
    } catch (error) {
      if (!this.accept(snapshot)) return;
      this.message('inviteStatus', '');
      this.failure(error);
    } finally {
      if (this.matches(snapshot)) {
        this.busy = false;
        this.sync();
        if (created && this.active) await this.loadPage(this.cursors[this.page], this.page);
      }
    }
  }

  async copy() {
    const snapshot = this.snapshot();
    const value = this.get('issuedInviteLink').value;
    if (!value || !this.accept(snapshot) || this.get('copyInvite').disabled) return;
    try {
      await navigator.clipboard.writeText(value);
      if (this.accept(snapshot) && value === this.get('issuedInviteLink').value) this.message('inviteStatus', 'Invitation copied.');
    } catch {
      if (!this.accept(snapshot) || value !== this.get('issuedInviteLink').value) return;
      this.get('issuedInviteLink').focus();
      this.get('issuedInviteLink').select();
      this.message('inviteError', 'Clipboard access is unavailable. The link is selected for copying.');
    }
  }
};