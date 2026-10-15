'use strict';

window.VideoChatAdmin = class VideoChatAdmin {
  constructor({ getAccount }) {
    this.getAccount = getAccount;
    this.get = id => document.getElementById(id);
    this.fields = { paused: 'adminChatPaused', cacheEnabled: 'adminChatCache', sharedCacheEnabled: 'adminChatShared', semanticCacheEnabled: 'adminChatSemantic' };
    this.version = 0;
    this.modal = this.get('monitoringModal');
    this.reset();
    this.modal.confirmClose = () => this.requestClose();
    this.modal.addEventListener('cancel', event => { event.preventDefault(); window.hideModal('monitoringModal'); });
    this.get('adminChatForm').addEventListener('submit', event => { event.preventDefault(); this.save(); });
    this.get('adminChatForm').addEventListener('input', () => {
      this.dirty = true;
      if (!this.get('adminChatCache').checked) this.get('adminChatShared').checked = this.get('adminChatSemantic').checked = false;
      this.sync();
    });
    this.get('adminChatCancel').addEventListener('click', () => { this.fill(); this.message('adminChatStatus', 'Changes discarded.'); });
    this.get('adminChatReview').addEventListener('click', () => {
      if (!this.data) return;
      this.revision = this.data.settings.revision;
      this.stale = false;
      this.message('adminChatError', '');
      this.message('adminChatStatus', 'Latest settings loaded. Review the pending changes before saving.');
      this.sync();
    });
    window.addEventListener('pagehide', () => this.reset());
    window.addEventListener('focus', () => { this.syncAccount(); if (this.modal.open) this.refresh(); });
  }

  ownerKey() {
    const account = this.getAccount();
    return account?.isAdmin && !account.isGuest ? `${account.id}:${account.generation}` : null;
  }

  syncAccount() {
    const key = this.ownerKey();
    if (this.owner && this.owner !== key) this.reset();
    const allowed = !!key && this.deniedOwner !== key;
    for (const id of ['monitoringBtn', 'settingsAdminTab']) {
      this.get(id).classList.toggle('hidden', !allowed);
      this.get(id).hidden = !allowed;
    }
  }

  reset() {
    this.version++;
    this.controller?.abort();
    this.owner = null; this.data = null; this.loading = false; this.busy = false; this.dirty = false; this.stale = false;
    this.get('adminChatForm').reset();
    this.get('adminChatChanges').replaceChildren();
    for (const element of this.modal.querySelectorAll('[data-chat-value]')) element.textContent = '';
    for (const id of ['adminChatError', 'adminChatStatus']) this.message(id, '');
    this.sync();
  }

  message(id, text) {
    this.get(id).textContent = text;
    this.get(id).classList.toggle('hidden', !text);
  }

  open() {
    this.syncAccount();
    if (!this.ownerKey() || this.deniedOwner === this.ownerKey()) return;
    this.owner = this.ownerKey();
    this.refresh();
  }

  requestClose() {
    if (this.busy) { this.message('adminChatStatus', 'Wait for the save to finish.'); return false; }
    if (this.dirty && !confirm('Discard unsaved video chat settings?')) return false;
    this.reset();
    return true;
  }

  static cents(value) {
    if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(value)) return null;
    const [whole, fraction = ''] = value.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return cents <= 100000 ? cents : null;
  }

  values() {
    return { monthlyBudgetCents: VideoChatAdmin.cents(this.get('adminChatBudget').value),
      ...Object.fromEntries(Object.entries(this.fields).map(([key, id]) => [key, this.get(id).checked])) };
  }

  sync() {
    const blocked = !this.owner || !this.data || this.busy;
    this.get('adminChatBudget').disabled = blocked;
    for (const id of Object.values(this.fields)) this.get(id).disabled = blocked;
    this.get('adminChatShared').disabled ||= !this.get('adminChatCache').checked;
    this.get('adminChatSemantic').disabled ||= !this.get('adminChatCache').checked || !this.data?.capabilities.semanticReady;
    this.get('adminChatPaused').disabled ||= !this.data?.capabilities.configured;
    this.get('adminChatSave').disabled = blocked || this.loading || this.stale || !this.dirty || this.values().monthlyBudgetCents === null;
    this.get('adminChatCancel').disabled = blocked || !this.dirty;
    this.get('adminChatReview').classList.toggle('hidden', !this.stale);
    this.get('adminChatReview').disabled = blocked || this.loading;
    this.get('adminChatForm').setAttribute('aria-busy', String(this.busy));
  }

  fill() {
    if (!this.data) return;
    this.get('adminChatBudget').value = (this.data.settings.monthlyBudgetCents / 100).toFixed(2);
    for (const [key, id] of Object.entries(this.fields)) this.get(id).checked = this.data.settings[key];
    this.revision = this.data.settings.revision; this.dirty = false; this.stale = false;
    this.sync();
  }

  money(micros) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1000000); }
  date(value) { return value ? new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : 'Not recorded'; }
  cell(tag, value) { const element = document.createElement(tag); element.textContent = String(value ?? ''); return element; }

  render() {
    const { settings, usage, capabilities, environment, changes } = this.data;
    const entries = { adminChatEnvironment: environment, adminChatMonth: `${usage.month} (UTC)`, adminChatLimit: this.money(usage.budgetMicros),
      adminChatAccounted: this.money(usage.accountedMicros), adminChatRemaining: this.money(usage.remainingMicros),
      adminChatKnown: this.money(usage.knownMicros), adminChatPending: this.money(usage.pendingMicros), adminChatRetained: this.money(usage.retainedMicros),
      adminChatLegacy: this.money(usage.legacyMicros), adminChatEmbedding: this.money(usage.embeddingMicros), adminChatGeneration: this.money(usage.generationMicros),
      adminChatNext: this.money(capabilities.maximumGenerationMicros), adminChatResets: this.date(usage.resetsAt), adminChatModel: capabilities.model,
      adminChatRequests: `${usage.requests} this month; ${capabilities.requestsPerMinute}/minute and ${capabilities.requestsPerDay}/UTC day per account`,
      adminChatSource: settings.source === 'dashboard' ? `Dashboard settings, revision ${settings.revision}` : 'Environment defaults',
      adminChatReadiness: !capabilities.deploymentEnabled ? 'Deployment disabled' : !capabilities.keyConfigured ? 'Provider key not configured' :
        !capabilities.configured ? 'Provider configuration unavailable' : settings.paused || !settings.monthlyBudgetCents ? 'Paused' : 'Configured',
      adminChatCalibration: capabilities.semanticReady ? 'Thresholds configured' : 'Calibration required',
      adminChatOver: usage.overLimitMicros ? `${this.money(usage.overLimitMicros)} above the current limit` : '' };
    for (const [id, value] of Object.entries(entries)) this.get(id).textContent = value;
    this.get('adminChatOver').classList.toggle('hidden', !usage.overLimitMicros);
    this.get('adminChatChanges').replaceChildren(...changes.map(change => {
      const row = document.createElement('tr');
      const labels = { monthlyBudgetCents: 'Monthly budget', paused: 'Paused', cacheEnabled: 'Answer cache', sharedCacheEnabled: 'Public sharing', semanticCacheEnabled: 'Semantic matching' };
      const details = Object.keys(labels).filter(key => change.before[key] !== change.after[key]).map(key => {
        const format = value => key === 'monthlyBudgetCents' ? this.money(value * 10000) : value ? 'on' : 'off';
        return `${labels[key]}: ${format(change.before[key])} to ${format(change.after[key])}`;
      }).join('; ');
      row.append(this.cell('td', this.date(change.createdAt)), this.cell('td', change.actorId === null ? 'Removed account' : `Admin #${change.actorId}`), this.cell('td', details));
      return row;
    }));
    this.get('adminChatAuditEmpty').classList.toggle('hidden', changes.length > 0);
    this.sync();
  }

  async request(url, options = {}) {
    const owner = this.owner;
    const version = this.version;
    const response = await fetch(url, { ...options, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      headers: { 'Content-Type': 'application/json', 'X-Video-Chat-Account': String(this.getAccount().id) } });
    const data = await response.json();
    if (owner !== this.ownerKey() || owner !== this.owner || version !== this.version || !this.modal.open) throw new DOMException('Admin view changed', 'AbortError');
    if (!response.ok) {
      if ([401, 403].includes(response.status) || data.code === 'SESSION_CHANGED') {
        this.reset(); this.deniedOwner = owner; this.syncAccount(); window.hideModal('monitoringModal');
      }
      throw Object.assign(new Error(data.error || 'Administration is unavailable.'), { status: response.status, code: data.code });
    }
    if (url.startsWith('/api/admin/video-chat') && response.headers.get('X-Video-Chat-Account') !== String(this.getAccount().id)) throw new Error('Your account changed. Reopen administration.');
    return data;
  }

  async refresh() {
    if (!this.modal.open || !this.owner || this.loading || this.busy) return;
    this.syncAccount();
    if (!this.owner) return;
    const version = this.version;
    this.loading = true; this.controller = new AbortController(); this.sync();
    try {
      const data = await this.request('/api/admin/video-chat');
      this.data = data;
      if (!this.dirty) this.fill();
      else if (data.settings.revision !== this.revision) {
        this.stale = true;
        this.message('adminChatError', 'Settings changed in another session. Review the latest settings before saving your draft.');
      }
      this.render();
      if (!this.stale) this.message('adminChatError', '');
    } catch (error) {
      if (version === this.version && error.name !== 'AbortError') this.message('adminChatError', error.message);
    } finally {
      if (version === this.version) { this.loading = false; this.sync(); }
    }
  }

  async save() {
    if (this.get('adminChatSave').disabled) return;
    const values = this.values();
    const previous = this.data.settings;
    const raisesRisk = values.monthlyBudgetCents > previous.monthlyBudgetCents || (!values.paused && previous.paused) ||
      (values.sharedCacheEnabled && !previous.sharedCacheEnabled) || (values.semanticCacheEnabled && !previous.semanticCacheEnabled) ||
      values.monthlyBudgetCents * 10000 < this.data.usage.accountedMicros;
    if (raisesRisk && !confirm(`Apply these settings to ${this.data.environment}?\nMonthly budget: ${this.money(previous.monthlyBudgetCents * 10000)} to ${this.money(values.monthlyBudgetCents * 10000)}.\nPaused: ${values.paused ? 'yes' : 'no'}. Public sharing: ${values.sharedCacheEnabled ? 'on' : 'off'}. Semantic matching: ${values.semanticCacheEnabled ? 'on' : 'off'}.\nExisting costs and dispatched requests are not refunded.`)) return;
    const version = this.version;
    this.busy = true; this.controller = new AbortController(); this.sync(); this.message('adminChatError', '');
    this.message('adminChatStatus', 'Saving...');
    let refresh = false;
    try {
      this.data = await this.request('/api/admin/video-chat/settings', { method: 'PATCH', body: JSON.stringify({ revision: this.revision, ...values }) });
      this.fill(); this.render(); this.message('adminChatStatus', 'Settings saved.');
    } catch (error) {
      if (version === this.version && error.name !== 'AbortError') {
        this.message('adminChatStatus', ''); this.message('adminChatError', error.message);
        this.stale = true; refresh = true;
      }
    } finally {
      if (version === this.version) { this.busy = false; this.sync(); if (refresh) await this.refresh(); }
    }
  }

};