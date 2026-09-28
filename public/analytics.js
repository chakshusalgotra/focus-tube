'use strict';

window.ProductAnalytics = class ProductAnalytics {
  constructor({ getAccount, el, chartTable }) {
    this.getAccount = getAccount;
    this.el = el;
    this.chartTable = chartTable;
    this.get = id => document.getElementById(id);
    this.version = 0;
    this.preferenceVersion = 0;
    this.viewVersion = 0;
    this.controllers = new Set();
    this.charts = [];
    this.collecting = false;
    this.surveyVersion = 0;
    this.get('surveyForm').addEventListener('submit', event => { event.preventDefault(); this.changeSurvey('save'); });
    this.get('surveyForm').addEventListener('change', () => { this.surveyDirty = true; });
    this.get('surveyRefresh').addEventListener('click', () => this.loadSurvey());
    this.get('surveyRemove').addEventListener('click', () => { if (confirm('Remove your saved learning profile answers?')) this.changeSurvey('remove'); });
    this.get('accountLearningProfile').addEventListener('toggle', () => { if (this.get('accountLearningProfile').open) this.loadSurvey(); });
    this.get('analyticsConsent').addEventListener('change', () => this.savePreference());
    this.get('analyticsPreferenceRefresh').addEventListener('click', () => this.loadPreference());
    this.get('analyticsExport').addEventListener('click', () => this.exportOwn());
    this.get('analyticsRefresh').addEventListener('click', () => this.refresh());
    this.get('analyticsRange').addEventListener('change', () => this.refresh());
    this.get('analyticsModal').addEventListener('close', () => this.closeView());
    this.tabs = [...document.querySelectorAll('[data-analytics-tab]')];
    for (const tab of this.tabs) tab.addEventListener('click', () => this.select(tab.dataset.analyticsTab));
    this.get('analyticsTabs').addEventListener('keydown', event => {
      const index = this.tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + this.tabs.length) % this.tabs.length;
      this.select(this.tabs[next].dataset.analyticsTab);
      this.tabs[next].focus();
    });
    document.addEventListener('themechange', () => { if (this.data && this.get('analyticsModal').open) this.render(this.data); });
    window.addEventListener('pagehide', () => this.reset());
    window.addEventListener('pageshow', event => { if (event.persisted) this.configure(); });
  }
  reset() {
    this.version++;
    this.preferenceVersion++;
    this.saving = false;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.collecting = false;
    this.account = null;
    this.preference = null;
    this.clearSurvey();
    this.closeView();
    this.get('analyticsConsent').checked = false;
    this.get('analyticsConsent').disabled = true;
    this.get('analyticsPreferenceStatus').textContent = '';
  }
  configure() {
    const account = this.getAccount();
    if (this.account?.id === account?.id && this.account?.generation === account?.generation && this.account?.isAdmin === account?.isAdmin) return;
    this.reset();
    if (!account?.id || account.isGuest) return;
    this.account = { ...account };
    this.loadPreference();
  }
  matches(version) {
    const account = this.getAccount();
    return !!this.account && version === this.version && account?.id === this.account.id && account.generation === this.account.generation && account.isAdmin === this.account.isAdmin;
  }
  async request(path, method = 'GET', body, controller = new AbortController()) {
    const version = this.version;
    const account = this.account;
    if (!this.matches(version)) throw new Error('Your account changed. Reopen Settings.');
    this.controllers.add(controller);
    try {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        headers: { 'Content-Type': 'application/json', 'X-Analytics-Account': String(account.id) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!this.matches(version) || controller.signal.aborted) throw new Error('Analytics request interrupted.');
      if ([401, 403].includes(response.status)) { this.reset(); throw new Error('Your account access changed. Reopen Settings.'); }
      if (response.headers.get('X-Analytics-Account') !== String(account.id)) { this.reset(); throw new Error('The analytics account could not be verified.'); }
      const data = await response.json();
      if (!this.matches(version) || controller.signal.aborted) throw new Error('Analytics request interrupted.');
      if (response.status === 409 && data.code !== 'AUDIENCE_CHANGED') { this.reset(); throw new Error('Your account access changed. Reopen Settings.'); }
      if (!response.ok) throw Object.assign(new Error(response.status === 429 ? 'Too many requests. Wait a few minutes and refresh.' : data.error || 'Analytics is unavailable.'), { code: data.code });
      return data;
    } finally { this.controllers.delete(controller); }
  }
  showPreference(data) {
    this.preference = data;
    this.collecting = data.available && data.consent && !data.excluded;
    this.get('analyticsConsent').checked = data.consent;
    this.get('analyticsConsent').disabled = !data.consent && (!data.available || data.excluded);
    this.get('analyticsPreferenceStatus').textContent = data.excluded ? 'Administrators and excluded test accounts are not included.' :
      !data.available ? 'Optional analytics is not enabled on this installation.' : data.consent ? 'Optional analytics is on.' : 'Optional analytics is off.';
    if (!this.collecting) this.clearSurvey();
  }
  clearSurvey() {
    this.surveyVersion++;
    this.survey = null;
    this.surveyBusy = false;
    this.surveyDirty = false;
    this.surveyNeedsRefresh = false;
    for (const id of ['surveyRole', 'surveyGoal', 'surveySource']) { this.get(id).value = ''; this.get(id).disabled = true; }
    for (const id of ['surveySave', 'surveyRemove']) this.get(id).disabled = true;
    this.get('surveyStatus').textContent = '';
    this.get('surveyError').textContent = '';
    this.get('surveyError').classList.add('hidden');
  }
  confirmSurveyClose() {
    if (this.surveyBusy) return false;
    if (this.surveyDirty && !confirm('Discard unsaved learning profile answers?')) return false;
    this.clearSurvey();
    return true;
  }
  renderSurvey(data, replace = false) {
    this.survey = data;
    if (replace || !this.surveyDirty) {
      for (const [id, key] of [['surveyRole', 'role'], ['surveyGoal', 'goal'], ['surveySource', 'source']]) this.get(id).value = data.answers[key] || '';
      this.surveyDirty = false;
    }
    this.syncSurvey();
    this.get('surveyStatus').textContent = !data.available ? 'Optional analytics must be enabled and opted in. Administrators and excluded test accounts cannot submit answers.' :
      data.state === 'answered' ? 'Learning profile saved.' : 'All questions are optional.';
  }
  syncSurvey() {
    const unavailable = !this.survey?.available || this.surveyBusy;
    for (const id of ['surveyRole', 'surveyGoal', 'surveySource']) this.get(id).disabled = unavailable;
    this.get('surveySave').disabled = unavailable || this.surveyNeedsRefresh;
    this.get('surveyRemove').disabled = this.surveyBusy || this.surveyNeedsRefresh || this.survey?.state !== 'answered';
    this.get('surveyRefresh').disabled = this.surveyBusy;
  }
  async loadSurvey() {
    if (!this.account || this.surveyBusy) return;
    const version = this.version;
    const request = ++this.surveyVersion;
    this.get('surveyStatus').textContent = 'Loading learning profile...';
    try {
      const data = await this.request('/api/analytics/audience');
      if (!this.matches(version) || request !== this.surveyVersion) return;
      this.surveyNeedsRefresh = false;
      this.renderSurvey(data);
      this.get('surveyError').classList.add('hidden');
      if (this.surveyDirty) this.get('surveyStatus').textContent = 'Latest version loaded. Review your unsaved answers before saving.';
    } catch (error) { if (this.matches(version) && request === this.surveyVersion) this.surveyError(error); }
  }
  surveyError(error) {
    this.get('surveyError').textContent = `${error.message} Your entered answers are kept. Refresh before retrying.`;
    this.get('surveyError').classList.remove('hidden');
    this.surveyNeedsRefresh = true;
    this.syncSurvey();
  }
  async changeSurvey(action) {
    if (!this.survey || this.surveyBusy || this.surveyNeedsRefresh) return;
    const version = this.version;
    const request = ++this.surveyVersion;
    const body = { action, notice: this.survey.notice, revision: this.survey.revision };
    if (action === 'save') body.answers = { role: this.get('surveyRole').value || null, goal: this.get('surveyGoal').value || null, source: this.get('surveySource').value || null };
    this.surveyBusy = true;
    this.syncSurvey();
    try {
      const data = await this.request('/api/analytics/audience', 'PUT', body);
      if (!this.matches(version) || request !== this.surveyVersion) return;
      this.renderSurvey(data, true);
      this.get('surveyError').classList.add('hidden');
      if (action === 'remove') this.get('surveyStatus').textContent = 'Answers removed. You will not be prompted again.';
    } catch (error) { if (this.matches(version) && request === this.surveyVersion) this.surveyError(error); }
    finally { if (request === this.surveyVersion) { this.surveyBusy = false; this.syncSurvey(); } }
  }
  async loadPreference() {
    if (!this.account || this.saving) return;
    const version = this.version;
    const request = ++this.preferenceVersion;
    this.get('analyticsConsent').disabled = true;
    try {
      const data = await this.request('/api/analytics/preferences');
      if (request === this.preferenceVersion && this.matches(version)) this.showPreference(data);
    } catch (error) { if (request === this.preferenceVersion && this.matches(version)) { this.collecting = false; this.get('analyticsPreferenceStatus').textContent = error.message; } }
  }
  async savePreference() {
    if (!this.preference || this.saving) return;
    const version = this.version;
    this.saving = true;
    const request = ++this.preferenceVersion;
    const consent = this.get('analyticsConsent').checked;
    this.collecting = false;
    this.get('analyticsConsent').disabled = true;
    this.get('analyticsPreferenceStatus').textContent = 'Saving preference...';
    try {
      const data = await this.request('/api/analytics/preferences', 'PUT', { consent, notice: this.preference.notice });
      if (request === this.preferenceVersion && this.matches(version)) this.showPreference(data);
    }
    catch (error) {
      if (request === this.preferenceVersion && this.matches(version)) {
        this.get('analyticsConsent').checked = this.preference.consent;
        this.get('analyticsConsent').disabled = false;
        this.get('analyticsPreferenceStatus').textContent = `${error.message} Refresh to confirm the saved preference.`;
      }
    } finally { if (request === this.preferenceVersion) this.saving = false; }
  }
  async exportOwn() {
    const version = this.version;
    try {
      const data = await this.request('/api/analytics/export');
      if (!this.matches(version)) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const anchor = this.el('a', { href: url, download: 'focustube-optional-analytics.json' });
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (this.matches(version)) this.get('analyticsPreferenceStatus').textContent = error.message; }
  }
  select(section) {
    const previous = this.section;
    this.section = section;
    this.get('analyticsRange').closest('label').classList.toggle('hidden', section === 'audience');
    for (const tab of this.tabs) {
      const selected = tab.dataset.analyticsTab === section;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      this.get(tab.getAttribute('aria-controls')).classList.toggle('hidden', !selected);
    }
    for (const chart of this.charts) chart.resize();
    if (previous && previous !== section && (previous === 'audience' || section === 'audience')) this.refresh();
  }
  closeView() {
    this.viewVersion++;
    this.viewController?.abort();
    for (const chart of this.charts) chart.destroy();
    this.charts = [];
    this.data = null;
    this.get('analyticsContent').classList.add('hidden');
    for (const id of ['analyticsTrendData', 'analyticsFeatureData', 'analyticsCohorts', 'analyticsFunnel', 'audienceRoleData', 'audienceGoalData', 'audienceSourceData']) this.get(id).replaceChildren();
    this.section = null;
    this.get('audienceCoverage').textContent = '';
    this.get('analyticsUpdated').textContent = '';
    this.get('analyticsError').textContent = '';
  }
  open() {
    this.closeView();
    this.select('overview');
    this.get('analyticsRange').value = '30';
    this.refresh();
  }
  async refresh() {
    if (!this.account?.isAdmin || !this.get('analyticsModal').open) return;
    this.viewController?.abort();
    const controller = new AbortController();
    this.viewController = controller;
    const version = this.version;
    const view = ++this.viewVersion;
    this.get('analyticsRefresh').disabled = true;
    this.get('analyticsStatus').textContent = 'Loading analytics...';
    this.get('analyticsError').textContent = '';
    try {
      const data = await this.request(this.section === 'audience' ? '/api/admin/analytics/audience' : `/api/admin/analytics?days=${this.get('analyticsRange').value}`, 'GET', null, controller);
      if (view !== this.viewVersion || !this.matches(version) || !this.get('analyticsModal').open) return;
      this.data = data;
      this.get('analyticsContent').classList.remove('hidden');
      this.get('analyticsStatus').textContent = data.dimensions ? '' : !data.enabled ? 'Collection is disabled. Historical records, if any, are retained until expiry or withdrawal.' :
        !data.participants ? 'No opted-in members yet.' : `${data.participants} opted-in members; ${data.eligibleMembers} active non-admin accounts. Administrators and excluded test accounts are omitted.`;
      this.render(data);
    } catch (error) {
      if (view === this.viewVersion && this.matches(version)) {
        this.get('analyticsStatus').textContent = '';
        this.get('analyticsError').textContent = this.data ? `${error.message} Displayed results are from the last successful refresh and may not match the selected range.` : error.message;
      }
    } finally { if (view === this.viewVersion) this.get('analyticsRefresh').disabled = false; }
  }
  render(data) {
    if (data.dimensions) return this.renderAudience(data);
    const display = value => value === null ? 'Not collected' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
    for (const [id, value] of Object.entries({ analyticsDaily: data.dau, analyticsWeekly: data.wau, analyticsMonthly: data.mau, analyticsLearners: data.weeklyLearners,
      analyticsMedian: data.medianWatchMinutes, analyticsPeriodActive: data.periodActive })) this.get(id).textContent = display(value);
    this.get('analyticsUpdated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · UTC dates`;
    this.get('analyticsCoverage').textContent = `Collection started: ${data.collectionStart === null ? 'Not started' : new Date(data.collectionStart).toLocaleString()}. ${data.trend.filter(day => day.complete).length} fully observed days in this range. Today is partial.${data.droppedSignals ? ' Some activity signals could not be recorded.' : ''}`;
    this.chartTable('analyticsTrendData', 'Recorded activity by UTC day', ['Date', 'Active members', 'Watch minutes', 'Coverage'], data.trend.map(day => [day.date, display(day.users), day.watchSeconds === null ? 'Not collected' : display(day.watchSeconds / 60), day.partial ? 'Partial today' : day.complete ? 'Observed' : 'Incomplete']));
    const labels = { course: 'Saved a course', notes: 'Saved notes', chat: 'Received a chat answer', extension: 'Saved with extension' };
    this.chartTable('analyticsFeatureData', 'Feature usage', ['Feature', 'Members'], data.features.map(feature => [labels[feature.name], feature.users]));
    const activation = data.activation;
    this.get('analyticsFunnel').replaceChildren(...[['Eligible opt-ins', activation.eligible], ['Saved a new course within 7 days', activation.courseSaved], ['Then watched at least 5 minutes', activation.activated]]
      .map(([label, count]) => this.el('li', {}, this.el('span', {}, label), this.el('strong', {}, String(count)))));
    this.get('analyticsActivationStatus').textContent = `${activation.pendingOrUnobserved} opt-ins pending or missing observation coverage. Cohorts begin at opt-in, not signup. Existing library items and imported history do not count.`;
    const cell = metric => metric.eligible ? `${metric.returned}/${metric.eligible} (${Math.round(metric.returned / metric.eligible * 100)}%)${metric.pending || metric.unknown ? `; ${metric.pending} pending, ${metric.unknown} unobserved` : ''}` : metric.pending ? 'Pending' : 'Not collected';
    this.chartTable('analyticsCohorts', 'Exact-day return after analytics opt-in', ['Opt-in week (UTC)', 'Members', 'Day 7 return', 'Day 30 return'], data.cohorts.map(cohort => [cohort.week, cohort.enrolled, cell(cohort.d7), cell(cohort.d30)]));
    for (const chart of this.charts) chart.destroy();
    const styles = getComputedStyle(document.documentElement);
    const text = styles.getPropertyValue('--muted').trim();
    const accent = styles.getPropertyValue('--teal').trim();
    const options = { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { color: text } } }, scales: { x: { ticks: { color: text, maxTicksLimit: 7 }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: text, precision: 0 } } } };
    this.charts = [new Chart(this.get('analyticsTrendChart'), { type: 'line', options, data: { labels: data.trend.map(day => day.date), datasets: [{ label: 'Recorded active members', data: data.trend.map(day => day.users), borderColor: accent, backgroundColor: accent, spanGaps: false, pointRadius: 2 }] } }),
      new Chart(this.get('analyticsFeatureChart'), { type: 'bar', options, data: { labels: data.features.map(feature => labels[feature.name]), datasets: [{ label: 'Unique members', data: data.features.map(feature => feature.users), backgroundColor: accent }] } })];
  }
  renderAudience(data) {
    for (const chart of this.charts) chart.destroy();
    this.charts = [];
    this.get('analyticsUpdated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · UTC dates`;
    this.get('audienceCoverage').textContent = `${data.window.start} to ${data.window.endExclusive} (end excluded). ${data.eligible === null ? 'Fewer than 10 eligible members.' : `${data.eligible} eligible members.`} ${data.respondents === null ? 'Response coverage withheld for small groups.' : `${data.respondents} respondents (${data.responsePercent}%).`}`;
    const names = { student: 'Student', professional: 'Professional', 'job-seeker': 'Job seeker', other: 'Other', 'prefer-not': 'Prefer not to say', unknown: 'Unknown', coursework: 'Coursework', upskilling: 'Upskilling', interview: 'Interview preparation', interest: 'General interest', friend: 'Friend / invitation', linkedin: 'LinkedIn', twitter: 'X / Twitter', reddit: 'Reddit', instagram: 'Instagram', youtube: 'YouTube', search: 'Search engine' };
    const styles = getComputedStyle(document.documentElement);
    for (const dimension of data.dimensions) {
      const title = dimension.name[0].toUpperCase() + dimension.name.slice(1);
      const prefix = `audience${title}`;
      this.get(prefix + 'Plot').classList.toggle('hidden', dimension.suppressed);
      this.get(prefix + 'Status').textContent = dimension.suppressed ? 'Breakdown withheld: at least one group has fewer than 10 members.' : 'Percentages include Unknown and use all eligible members, not just respondents.';
      this.get(prefix + 'Data').replaceChildren();
      if (dimension.suppressed) continue;
      const rate = value => value ? `${value.percent}% (${value.successful}/${value.eligible})` : 'Withheld or incomplete';
      this.chartTable(prefix + 'Data', `${title} breakdown`, ['Group', 'Members', 'Share', '7-day activation', 'Day 7 return'], dimension.buckets.map(bucket => [names[bucket.value], bucket.count, `${bucket.percent}%`, dimension.name === 'source' ? 'Not compared' : rate(bucket.activation), dimension.name === 'source' ? 'Not compared' : rate(bucket.d7)]));
      this.charts.push(new Chart(this.get(prefix + 'Chart'), { type: 'bar', options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: styles.getPropertyValue('--muted').trim(), precision: 0 } }, y: { ticks: { color: styles.getPropertyValue('--muted').trim() } } } },
        data: { labels: dimension.buckets.map(bucket => names[bucket.value]), datasets: [{ label: 'Members', data: dimension.buckets.map(bucket => bucket.count), backgroundColor: styles.getPropertyValue('--teal').trim() }] } }));
    }
  }
};