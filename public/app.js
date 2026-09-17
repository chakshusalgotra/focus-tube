/* FocusTube front-end — courses, player, streaks, certificate. */
'use strict';

if (window.Chart) Chart.defaults.font.size = 12 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale')) || 1);

/* ================= tiny helpers ================= */
const $ = (s, r = document) => r.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtLong(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function nVideos(n) {
  return `${n} video${n === 1 ? '' : 's'}`;
}

function showModal(id) {
  const dialog = $('#' + id);
  dialog.classList.remove('hidden');
  if (!dialog.open) dialog.showModal();
}

function hideModal(id) {
  const dialog = $('#' + id);
  if (dialog.open && dialog.confirmClose?.() === false) return false;
  if (dialog.open) dialog.close();
  dialog.classList.add('hidden');
  return true;
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/* ================= icons ================= */
const icon = name => lucide.createElement(lucide.icons[name], { 'aria-hidden': 'true', focusable: 'false', class: 'ui-icon' }).outerHTML;
const I = Object.fromEntries(Object.entries({
  play: 'Play', pause: 'Pause', prev: 'SkipBack', next: 'SkipForward', b10: 'RotateCcw', f10: 'RotateCw',
  vol: 'Volume2', mute: 'VolumeX', fs: 'Maximize', back: 'ArrowLeft', menu: 'PanelLeft', sync: 'RefreshCw',
  trash: 'Trash2', check: 'Check', cc: 'Captions', pin: 'Pin', library: 'LibraryBig', close: 'X', trophy: 'Trophy',
}).map(([key, name]) => [key, icon(name)]));
document.querySelectorAll('[data-ui-icon]').forEach(element => { element.innerHTML = icon(element.dataset.uiIcon); });
document.querySelectorAll('.modal-close, #taskPanelClose').forEach(element => {
  element.innerHTML = I.close;
  element.setAttribute('aria-label', 'Close');
  element.title = 'Close';
});
document.querySelectorAll('.icon-btn[title]').forEach(element => element.setAttribute('aria-label', element.title));

/* ================= storage ================= */
const DB = {
  load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  },
  save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

const legacyCourses = DB.load('ft_courses', {});
const legacyStats = DB.load('ft_stats', { seconds: {}, lastStreakToast: '' });
let courses = {};
let stats = { seconds: {}, lastStreakToast: '' };
let userName = DB.load('ft_name', '');
let volume = DB.load('ft_vol', 100);
let authUser = null;
let remoteSaveTimer = null;
let remoteSaveInFlight = null;
let remoteSaveQueued = false;
let profileRevision = 0;
let pendingLegacyImport = false;
let sessionGeneration = 0;
let appBooted = false;
let showPinnedOnly = false;
let libraryStatus = 'all';
let searchType = 'all';
let searchQuery = '';
let searchData = [];
let searchController = null;
let searchBusy = false;
let importingLink = false;
const pendingCourseImports = new Set();
let workspace = defaultWorkspace(); // board columns, tasks, checklists, sprints
let homeMode = 'grid';
let notebooks = null;
const workspaceNarrowScreen = window.matchMedia('(max-width: 900px)');
let workspaceCollapsePreference = DB.load('ft_workspace_collapsed', null);
let courseToolsCollapsePreference = true;
let courseLayouts = {};

const saveCourses = () => scheduleRemoteSave();
const saveStats = () => scheduleRemoteSave();

function settingsSnapshot() {
  return { userName, volume, captionsOn, prefQuality, homeMode };
}

function scheduleRemoteSave() {
  if (!authUser || authUser.isGuest) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => persistRemoteData(), 800);
}

function mergeRemoteState(remote) {
  const mergedCourses = structuredClone(remote.courses || {});
  for (const [id, local] of Object.entries(courses)) {
    const server = mergedCourses[id];
    if (!server) {
      mergedCourses[id] = local;
      continue;
    }
    const videos = new Map((server.videos || []).map((video) => [video.id, video]));
    for (const video of local.videos || []) videos.set(video.id, video);
    mergedCourses[id] = {
      ...server,
      ...local,
      videos: [...videos.values()],
      completed: { ...(server.completed || {}), ...(local.completed || {}) },
      positions: { ...(server.positions || {}), ...(local.positions || {}) },
      completedAt: local.completedAt || server.completedAt || null,
    };
  }
  const remoteStats = remote.stats || { seconds: {} };
  const mergedSeconds = { ...(remoteStats.seconds || {}) };
  for (const [date, seconds] of Object.entries(stats.seconds || {})) {
    mergedSeconds[date] = Math.max(Number(mergedSeconds[date] || 0), Number(seconds || 0));
  }
  courses = mergedCourses;
  stats = {
    ...remoteStats,
    ...stats,
    seconds: mergedSeconds,
    lastStreakToast: stats.lastStreakToast || remoteStats.lastStreakToast || '',
  };
  mergeWorkspaceState(remote.workspace);
}

async function persistRemoteData({ importLegacy = false } = {}) {
  if (!authUser || authUser.isGuest) return true;
  pendingLegacyImport ||= importLegacy;
  clearTimeout(remoteSaveTimer);
  if (remoteSaveInFlight) {
    remoteSaveQueued = true;
    return remoteSaveInFlight;
  }
  const generation = sessionGeneration;
  remoteSaveInFlight = (async () => {
    let conflictRetries = 0;
    do {
      remoteSaveQueued = false;
      const useLegacyImport = pendingLegacyImport;
      try {
        const result = await api('/api/data', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courses,
            stats,
            settings: settingsSnapshot(),
            workspace,
            revision: profileRevision,
            importLegacy: useLegacyImport,
          }),
        });
        if (generation !== sessionGeneration) return;
        profileRevision = result.revision;
        if (useLegacyImport) pendingLegacyImport = false;
      } catch (err) {
        if (err.status === 409 && conflictRetries++ < 2) {
          try {
            const remote = await api('/api/data');
            if (generation !== sessionGeneration) return false;
            mergeRemoteState(remote);
            profileRevision = remote.revision;
            remoteSaveQueued = true;
            continue;
          } catch (reloadError) {
            err = reloadError;
          }
        }
        if (err.status === 401) showAuth();
        else toast(err.message, { error: true });
        remoteSaveQueued = false;
        return false;
      }
    } while (remoteSaveQueued && generation === sessionGeneration);
    return generation === sessionGeneration;
  })().finally(() => {
    remoteSaveInFlight = null;
  });
  return remoteSaveInFlight;
}

const pendingActivity = new Map();
const failedActivityBatches = [];
let lastInteractionAt = Date.now();
const presenceTabId = crypto.randomUUID();
let presenceRequest = null;
let presenceWasSent = false;

function hasLiveActivity() {
  return !!authUser && !authUser.isGuest && appBooted && !document.hidden &&
    (Date.now() - lastInteractionAt < 120000 || (playerReady && !!current && safe(() => player.getPlayerState()) === 1));
}

function withdrawPresence() {
  presenceRequest?.abort();
  presenceRequest = null;
  if (!presenceWasSent) return;
  presenceWasSent = false;
  fetch('/api/presence', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabId: presenceTabId }), keepalive: true }).catch(() => {});
}

async function updatePresence() {
  if (!hasLiveActivity()) { withdrawPresence(); return; }
  if (presenceRequest) return;
  const generation = sessionGeneration;
  const controller = new AbortController();
  presenceRequest = controller;
  presenceWasSent = true;
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const issued = await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: presenceTabId }), signal: controller.signal });
    if (!issued.ok) return;
    const { challenge } = await issued.json();
    if (generation !== sessionGeneration || !hasLiveActivity() || controller.signal.aborted) return;
    await fetch('/api/presence', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: presenceTabId, challenge }), signal: controller.signal });
  } catch {}
  finally {
    clearTimeout(timeout);
    if (presenceRequest === controller) presenceRequest = null;
  }
}

function activityBucket(date = todayKey()) {
  if (!pendingActivity.has(date)) {
    const random = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingActivity.set(date, { batchId: random, activeSeconds: 0, watch: new Map() });
  }
  return pendingActivity.get(date);
}

function queueSiteSeconds(seconds) {
  if (authUser && !authUser.isGuest && appBooted) activityBucket().activeSeconds += seconds;
}

function queueWatchSeconds(seconds) {
  const c = current?.course;
  const v = curVideo();
  if (!authUser || !c || !v) return;
  const bucket = activityBucket();
  const key = `${c.id}:${v.id}`;
  const item = bucket.watch.get(key) || {
    courseId: c.id,
    courseTitle: c.title,
    videoId: v.id,
    videoTitle: v.title,
    seconds: 0,
  };
  item.seconds += seconds;
  bucket.watch.set(key, item);
}

function queueCompletion(course, video, completedAt) {
  if (!authUser || !course || !video) return;
  const bucket = activityBucket();
  const key = `${course.id}:${video.id}`;
  const item = bucket.watch.get(key) || {
    courseId: course.id,
    courseTitle: course.title,
    videoId: video.id,
    videoTitle: video.title,
    seconds: 0,
  };
  item.completedAt = completedAt || null;
  bucket.watch.set(key, item);
}

async function flushActivity({ beacon = false } = {}) {
  if (!authUser || authUser.isGuest || (!pendingActivity.size && !failedActivityBatches.length)) return true;
  const userId = authUser.id;
  const batches = [
    ...failedActivityBatches.splice(0),
    ...[...pendingActivity.entries()].map(([date, bucket]) => ({ date, bucket })),
  ];
  pendingActivity.clear();
  let allSent = true;
  for (const { date, bucket } of batches) {
    const payload = JSON.stringify({
      batchId: bucket.batchId,
      date,
      activeSeconds: bucket.activeSeconds,
      watch: [...bucket.watch.values()],
    });
    if (beacon && navigator.sendBeacon) {
      const sent = navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
      if (sent) continue;
    }
    try {
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: beacon,
      });
      if (!res.ok) throw new Error('tracking failed');
    } catch {
      allSent = false;
      if (authUser?.id === userId) failedActivityBatches.push({ date, bucket });
    }
  }
  return allSent;
}

/* ================= state ================= */
let current = null; // { course, index }
let player = null;
let playerReady = false;
let seeking = false;
let persistCounter = 0;
let completedAutoGuard = false;
let endedTimer = null;
let rowEls = [];
let endedHandled = false;
let unstartedTicks = 0;
let captionsOn = DB.load('ft_cc', false);
let prefQuality = DB.load('ft_quality', 'default');
let videoExtras = { videoId: null, chapters: [], description: '', durationSeconds: 0 };
let chapterRowEls = [];
let lastChapterIdx = -2;
const extrasCache = new Map(); // videoId -> /api/video payload

const DAY_ACTIVE_SECONDS = 60; // a day counts toward your streak after 1 min of watching

/* ================= element refs ================= */
const homeView = $('#homeView');
const courseView = $('#courseView');
const authView = $('#authView');
const dashboardView = $('#dashboardView');
const topbar = $('#topbar');
const backBtn = $('#backBtn');
const sideToggle = $('#sideToggle');
const streakNum = $('#streakNum');
const urlInput = $('#urlInput');
const addBtn = $('#addBtn');
const addError = $('#addError');
const searchFilters = $('#searchFilters');
const searchSection = $('#searchSection');
const searchSummary = $('#searchSummary');
const searchResults = $('#searchResults');
const searchError = $('#searchError');
const searchYoutubeLink = $('#searchYoutubeLink');
const retrySearchBtn = $('#retrySearchBtn');
const courseGrid = $('#courseGrid');
const pinnedFilterBtn = $('#pinnedFilterBtn');
const pinnedFilterIcon = $('#pinnedFilterIcon');
const videoListEl = $('#videoList');
const sideTitle = $('#sideTitle');
const sideMeta = $('#sideMeta');
const sideProgressFill = $('#sideProgressFill');
const sideProgressLabel = $('#sideProgressLabel');
const certBtn = $('#certBtn');
const playerPane = $('#ytWrap');
const playerControls = $('#controls');
const playBtn = $('#playBtn');
const prevBtn = $('#prevBtn');
const nextBtn = $('#nextBtn');
const seekBar = $('#seekBar');
const curTime = $('#curTime');
const durTime = $('#durTime');
const speedSel = $('#speedSel');
const qualitySel = $('#qualitySel');
const ccBtn = $('#ccBtn');
const muteBtn = $('#muteBtn');
const volBar = $('#volBar');
const fsBtn = $('#fsBtn');
const npTitle = $('#npTitle');
const npMeta = $('#npMeta');
const npComplete = $('#npComplete');
const posterOverlay = $('#posterOverlay');
const posterTitle = $('#posterTitle');
const pauseOverlay = $('#pauseOverlay');
const endedOverlay = $('#endedOverlay');
const endedTitle = $('#endedTitle');
const endedCountdown = $('#endedCountdown');
const endedNext = $('#endedNext');
const endedCancel = $('#endedCancel');
const endedReplay = $('#endedReplay');
const endedCert = $('#endedCert');
const errorOverlay = $('#errorOverlay');
const errorLink = $('#errorLink');
const sideRefreshBtn = $('#sideRefresh');
const seekMarkers = $('#seekMarkers');
const npChapter = $('#npChapter');
const chaptersSection = $('#chaptersSection');
const chaptersList = $('#chaptersList');
const descSection = $('#descSection');
const descBody = $('#descBody');
const dashboardBtn = $('#dashboardBtn');
const profileBtn = $('#profileBtn');
const profileName = $('#profileName');
const profileAvatar = $('#profileAvatar');
const tasksView = $('#tasksView');
const roadmapView = $('#roadmapView');
const boardEl = $('#board');
const taskPanel = $('#taskPanel');

async function api(url, options = {}) {
  const { invitation, ...request } = options;
  const res = invitation ? await window.FocusTubeInvite.submit(url, request) : await fetch(url, request);
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && authUser && data?.code !== 'INVALID_CREDENTIALS') queueMicrotask(showAuth);
    const err = new Error(data?.error || 'Request failed.');
    err.status = res.status;
    err.data = data;
    err.retryAfter = Number(res.headers.get('Retry-After')) || 0;
    throw err;
  }
  return data;
}

/* icon injection */
backBtn.innerHTML = I.back;
playBtn.innerHTML = I.play;
prevBtn.innerHTML = I.prev;
nextBtn.innerHTML = I.next;
$('#back10').innerHTML = I.b10;
$('#fwd10').innerHTML = I.f10;
muteBtn.innerHTML = I.vol;
fsBtn.innerHTML = I.fs;
$('#posterPlay').innerHTML = I.play;
ccBtn.innerHTML = I.cc;
ccBtn.classList.toggle('active', captionsOn);
sideRefreshBtn.innerHTML = I.sync;
pinnedFilterIcon.innerHTML = I.pin;
pinnedFilterBtn.addEventListener('click', () => {
  showPinnedOnly = !showPinnedOnly;
  pinnedFilterBtn.classList.toggle('active', showPinnedOnly);
  renderHome();
});

/* ================= toasts & confetti ================= */
function toast(msg, opts = {}) {
  const t = el('div', { class: 'toast' + (opts.error ? ' error' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 350);
  }, opts.ms || 3200);
}

function smallBurst() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  window.confetti?.({ particleCount: 90, spread: 75, origin: { y: 0.75 }, ticks: 160 });
}

function bigCelebration() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.confetti) return;
  const end = Date.now() + 1800;
  (function frame() {
    confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0, y: 0.7 } });
    confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1, y: 0.7 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
  confetti({ particleCount: 180, spread: 100, origin: { y: 0.6 } });
}

/* ================= authentication ================= */
let authMode = 'login';
let authTransition = 0;
let authBusy = false;
let authRetryUntil = 0;
let authRetryTimer = null;
let authConfiguration = null;
let captchaScript = null;
const captchaWidgets = { auth: null, enrollment: null };
const emailChallenges = { auth: null, enrollment: null };
const emailChallengeVersions = { auth: 0, enrollment: 0 };
const emailResendTimers = { auth: null, enrollment: null };

function loadCaptcha() {
  if (window.turnstile) return Promise.resolve();
  if (!captchaScript) {
    captchaScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => { script.remove(); reject(new Error('The security check could not load.')); }, 10000);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => { clearTimeout(timeout); window.turnstile.ready(resolve); };
      script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('The security check could not load.')); };
      document.head.append(script);
    }).catch(error => { captchaScript = null; throw error; });
  }
  return captchaScript;
}

function syncCaptcha(kind, action) {
  const siteKey = authConfiguration?.captcha?.siteKey;
  const container = $('#' + kind + 'Captcha');
  const old = captchaWidgets[kind];
  if (old?.action === action && siteKey && action) return;
  if (old?.id !== undefined) window.turnstile?.remove(old.id);
  captchaWidgets[kind] = null;
  container.classList.toggle('hidden', !siteKey || !action);
  $('#' + kind + 'CaptchaError').classList.add('hidden');
  if (!siteKey || !action) return;
  const state = { action, token: '' };
  captchaWidgets[kind] = state;
  loadCaptcha().then(() => {
    if (captchaWidgets[kind] !== state) return;
    state.id = window.turnstile.render(container, { sitekey: siteKey, action, size: 'compact', 'response-field': false,
      callback: token => { state.token = token; $('#' + kind + 'CaptchaError').classList.add('hidden'); },
      'expired-callback': () => { state.token = ''; },
      'error-callback': () => { state.token = ''; const error = $('#' + kind + 'CaptchaError'); error.textContent = 'The security check failed. Try again.'; error.classList.remove('hidden'); },
    });
  }).catch(() => {
    if (captchaWidgets[kind] !== state) return;
    captchaWidgets[kind] = null;
    const error = $('#' + kind + 'CaptchaError');
    error.textContent = 'The security check could not load. Retry or check your connection.';
    error.classList.remove('hidden');
  });
}

function captchaToken(kind) {
  if (!authConfiguration?.captcha?.siteKey) return undefined;
  if (!captchaWidgets[kind]?.token) throw new Error('Complete the security check.');
  return captchaWidgets[kind].token;
}

function resetCaptcha(kind) {
  const visible = kind === 'auth' ? !authView.classList.contains('hidden') && !$('#authForm').classList.contains('hidden') :
    $('#profileModal').open && !$('#settingsAccount').classList.contains('hidden') && !$('#emailEnrollment').classList.contains('hidden');
  if (!visible) { syncCaptcha(kind, null); return; }
  const state = captchaWidgets[kind];
  if (state?.id !== undefined) { state.token = ''; window.turnstile?.reset(state.id); }
  else syncCaptcha(kind, kind === 'enrollment' ? 'email' : authMode === 'login' ? 'login' : 'registration');
}

function parseEmailCode(value) {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{1,6}$/.test(digits) ? digits : null;
}

function syncCodeCells(input) {
  const focused = document.activeElement === input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.parentElement.querySelectorAll('.otp-cell').forEach((cell, index) => {
    cell.textContent = input.value[index] || '';
    cell.classList.toggle('filled', index < input.value.length);
    cell.classList.toggle('active', focused && index === Math.min(start, input.maxLength - 1));
    cell.classList.toggle('selected', focused && index >= start && index < end);
  });
}

function setupCodeInput(input) {
  const host = input.parentElement;
  const cells = host.querySelector('.otp-cells');
  cells.replaceChildren(...Array.from({ length: input.maxLength }, () => el('span', { class: 'otp-cell' })));
  host.classList.add('otp-ready');
  input.addEventListener('input', () => {
    const position = input.selectionStart;
    const digits = input.value.replace(/\D/g, '');
    if (digits !== input.value) { input.value = digits; input.setSelectionRange(position, position); }
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
    $(input.id === 'authCode' ? '#authError' : '#enrollmentError').classList.add('hidden');
    syncCodeCells(input);
  });
  for (const event of ['focus', 'blur', 'keyup', 'select']) input.addEventListener(event, () => syncCodeCells(input));
  input.addEventListener('invalid', () => input.setAttribute('aria-invalid', 'true'));
  input.addEventListener('pointerdown', event => {
    if (event.button !== 0 || matchMedia('(forced-colors: active)').matches) return;
    event.preventDefault();
    input.focus();
    const index = [...cells.children].findIndex(cell => event.clientX <= cell.getBoundingClientRect().right);
    const start = Math.min(index < 0 ? input.maxLength : index, input.value.length);
    input.setSelectionRange(start, Math.min(start + 1, input.value.length));
    syncCodeCells(input);
  });
  input.addEventListener('paste', event => {
    event.preventDefault();
    const digits = parseEmailCode(event.clipboardData.getData('text'));
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (digits === null || (digits.length !== input.maxLength && input.value.length - (end - start) + digits.length > input.maxLength)) {
      input.setCustomValidity('Enter the six-digit email code.');
      input.reportValidity();
      return;
    }
    if (digits.length === input.maxLength) { input.value = digits; input.setSelectionRange(digits.length, digits.length); }
    else input.setRangeText(digits, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  syncCodeCells(input);
}

function syncEmailCode(kind) {
  const challenge = emailChallenges[kind];
  const visible = !!challenge && (kind !== 'auth' || authMode !== 'login');
  $('#' + kind + 'CodeBlock').classList.toggle('hidden', !visible);
  $('#' + kind + 'Code').required = visible;
  $('#' + kind + 'Code').disabled = !visible;
  const sent = $('#' + kind + 'CodeSent');
  const message = challenge ? `Code sent to ${challenge.email}` : '';
  if (sent.textContent !== message) sent.textContent = message;
  const button = $('#' + kind + 'Resend');
  const remaining = Math.max(0, Math.ceil((Math.max(challenge?.resendAt || 0, Number(button.dataset.retryUntil || 0)) - Date.now()) / 1000));
  const expires = Math.max(0, Math.ceil((Date.parse(challenge?.expiresAt) - Date.now()) / 1000)) || 0;
  const busy = kind === 'auth' ? authBusy : $('#enrollmentSubmit').getAttribute('aria-busy') === 'true';
  button.disabled = !challenge || remaining > 0 || busy;
  $('#' + kind + 'ResendLabel').textContent = remaining ? `Resend in ${fmtDuration(remaining)}` : 'Resend code';
  $('#' + kind + 'CodeExpiry').textContent = !challenge ? '' : expires ? `Expires in ${fmtDuration(expires)}` : 'Code expired. Request a new code.';
  clearTimeout(emailResendTimers[kind]);
  if (visible && (remaining || expires)) emailResendTimers[kind] = setTimeout(() => syncEmailCode(kind), 1000);
  $('#' + (kind === 'auth' ? 'authSubmit' : 'enrollmentSubmit')).textContent = kind === 'auth' && authMode === 'login' ? 'Sign in' :
    challenge ? kind === 'auth' ? 'Verify and create account' : 'Verify email' : 'Send verification code';
}

function clearEmailCode(kind) {
  emailChallengeVersions[kind]++;
  emailChallenges[kind] = null;
  const input = $('#' + kind + 'Code');
  input.value = '';
  input.setCustomValidity('');
  input.removeAttribute('aria-invalid');
  $('#' + kind + 'Error').classList.add('hidden');
  syncCodeCells(input);
  syncEmailCode(kind);
}

async function requestEmailCode(kind) {
  const input = $(kind === 'auth' ? '#authUsername' : '#enrollmentEmail');
  if (!input.reportValidity()) return;
  const email = input.value.trim().toLowerCase();
  const version = ++emailChallengeVersions[kind];
  const result = await api('/api/auth/verification/request', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, captchaToken: captchaToken(kind) }), invitation: kind === 'auth' });
  if (version !== emailChallengeVersions[kind] || input.value.trim().toLowerCase() !== email) return;
  emailChallenges[kind] = { token: result.verificationToken, email, resendAt: Date.now() + result.resendAfter * 1000, expiresAt: result.expiresAt };
  syncEmailCode(kind);
  const code = $('#' + kind + 'Code');
  code.value = '';
  code.setCustomValidity('');
  code.removeAttribute('aria-invalid');
  $('#' + kind + 'Error').classList.add('hidden');
  code.focus();
  syncCodeCells(code);
}

function emailCodeBody(kind) {
  return { verificationToken: emailChallenges[kind]?.token, verificationCode: $('#' + kind + 'Code').value.trim() };
}

function setAuthBusy(busy) {
  authBusy = busy;
  $('#authSubmit').disabled = busy || Date.now() < authRetryUntil || (authMode !== 'login' && authConfiguration?.emailVerification?.configured === false);
  $('#loginTab').disabled = busy;
  $('#registerTab').disabled = busy;
  $('#authForm').setAttribute('aria-busy', String(busy));
  $('#authSubmit').setAttribute('aria-busy', String(busy));
}

function setAuthMode(mode) {
  authMode = mode;
  const joining = mode !== 'login';
  const hasInvite = window.FocusTubeInvite.has();
  $('#loginTab').classList.toggle('active', mode === 'login');
  $('#registerTab').classList.toggle('active', joining);
  $('#loginTab').setAttribute('aria-pressed', String(mode === 'login'));
  $('#registerTab').setAttribute('aria-pressed', String(joining));
  $('#authTabs').classList.toggle('hidden', !!authUser);
  $('#authForm').classList.toggle('hidden', (joining && !hasInvite) || (!!authUser && !authUser.isGuest));
  $('#inviteRequired').classList.toggle('hidden', !joining || hasInvite || (!!authUser && !authUser.isGuest));
  $('#guestMigration').classList.toggle('hidden', !authUser?.isGuest);
  $('#authDisplayNameField').classList.toggle('hidden', !joining);
  $('#authDisplayName').required = joining;
  $('#authDisplayName').disabled = !joining;
  $('#authHandleField').classList.toggle('hidden', !joining);
  $('#authHandle').disabled = !joining;
  $('#authConfirmField').classList.toggle('hidden', !joining);
  $('#authPasswordConfirmation').required = joining;
  $('#authPasswordConfirmation').disabled = !joining;
  $('#authIdentityLabel').textContent = joining ? 'Email' : 'Email or username';
  $('#authUsername').type = joining ? 'email' : 'text';
  $('#authUsername').autocomplete = joining ? 'email' : 'username';
  $('#authEmailUnavailable').classList.toggle('hidden', !joining || !hasInvite || authConfiguration?.emailVerification?.configured !== false);
  $('#socialAuthOptions').classList.toggle('hidden', !!authUser);
  syncEmailCode('auth');
  syncCaptcha('auth', $('#authForm').classList.contains('hidden') ? null : joining ? 'registration' : 'login');
  setAuthBusy(authBusy);
  $('#authPassword').autocomplete = joining ? 'new-password' : 'current-password';
  $('#authHeading').textContent = authUser?.isGuest ? 'Your guest profile.' : joining ? 'Join FocusTube.' : 'Your learning workspace.';
  $('#authWelcome').textContent = authUser?.isGuest ? 'Export available. An invitation is required to continue learning.' : joining ? 'Invitation-only registration.' : 'Welcome back.';
  $('#authError').classList.add('hidden');
}

function clearIssuedInvite() {
  $('#issuedInviteLink').value = '';
  $('#inviteExpiry').textContent = '';
  $('#inviteResult').classList.add('hidden');
  $('#enrollmentPassword').value = '';
}

function showAccountError(error, target, button) {
  target.textContent = error.message;
  target.classList.remove('hidden');
  if (error.data?.code === 'INVALID_VERIFICATION') {
    const input = $(target.id === 'authError' ? '#authCode' : '#enrollmentCode');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
  if (error.retryAfter > 0) {
    const delay = Math.min(error.retryAfter, 3600) * 1000;
    target.textContent += ` Try again in ${Math.ceil(delay / 60000)} minute(s).`;
    if (button === $('#authSubmit')) {
      authRetryUntil = Date.now() + delay;
      clearTimeout(authRetryTimer);
      authRetryTimer = setTimeout(() => setAuthBusy(authBusy), delay);
    } else {
      button.disabled = true;
      button.dataset.retryUntil = String(Date.now() + delay);
      setTimeout(() => { button.disabled = false; delete button.dataset.retryUntil; }, delay);
    }
  }
}

function resetSessionState() {
  withdrawPresence();
  accountSnapshot = null;
  accountSaveBusy = false;
  accountLoadVersion++;
  clearTimeout(accountRetryTimer);
  accountRetryUntil = 0;
  passwordSaveBusy = false;
  clearTimeout(passwordRetryTimer);
  passwordRetryUntil = 0;
  clearPasswordFields();
  $('#emailEnrollmentForm').inert = false;
  settingsSection = 'account';
  $('#accountForm').reset();
  restoreAppearance();
  clearMonitoring();
  sessionGeneration++;
  notebooks?.reset();
  resetPlayerControls();
  pendingLoad = null;
  resetDiscovery();
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = null;
  remoteSaveQueued = false;
  remoteSaveInFlight = null;
  pendingLegacyImport = false;
  profileRevision = 0;
  pendingActivity.clear();
  failedActivityBatches.length = 0;
  destroyCharts();
  courses = {};
  stats = { seconds: {}, lastStreakToast: '' };
  workspace = defaultWorkspace();
  homeMode = 'grid';
  libraryStatus = 'all';
  showPinnedOnly = false;
  historyItems = [];
  userName = '';
  volume = 100;
  captionsOn = false;
  prefQuality = 'default';
  $('#authUsername').value = '';
  $('#authDisplayName').value = '';
  $('#authPassword').value = '';
  $('#authPasswordConfirmation').value = '';
  $('#authPasswordConfirmation').setCustomValidity('');
  $('#authHandle').value = '';
  $('#enrollmentEmail').value = '';
  $('#enrollmentError').classList.add('hidden');
  $('#inviteError').classList.add('hidden');
  clearEmailCode('auth');
  clearEmailCode('enrollment');
  syncCaptcha('auth', null);
  syncCaptcha('enrollment', null);
  clearIssuedInvite();
}

function showAuth({ preserveInvite = false } = {}) {
  authTransition++;
  if (!preserveInvite) window.FocusTubeInvite.clear();
  setAuthBusy(false);
  resetSessionState();
  authUser = null;
  appBooted = false;
  syncWorkspaceSidebar();
  current = null;
  safe(() => player?.stopVideo());
  topbar.classList.add('hidden');
  $('#workspaceRail').classList.add('hidden');
  document.body.classList.remove('workspace-open', 'roadmaps-open');
  homeView.classList.add('hidden');
  setCourseViewVisible(false);
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  closeTaskPanel();
  document.querySelectorAll('dialog.modal-backdrop').forEach(dialog => hideModal(dialog.id));
  authView.classList.remove('hidden');
  $('#inviteAccountChoice').classList.add('hidden');
  setAuthMode(preserveInvite && (window.FocusTubeInvite.has() || location.hash === '#join') ? 'register' : 'login');
  document.title = 'Sign in — FocusTube';
}

function updateProfileUI() {
  if (!authUser) return;
  const name = authUser.displayName || authUser.username || 'Guest';
  const initial = name.charAt(0).toUpperCase();
  profileName.textContent = name;
  profileAvatar.textContent = initial;
  $('#railAvatar').textContent = initial;
  $('#railProfileName').textContent = name;
  $('#railProfileType').textContent = authUser.isGuest ? 'Guest profile' : 'Personal profile';
  $('#profileModalName').textContent = name;
  $('#profileModalAvatar').textContent = initial;
  $('#profileModalType').textContent = authUser.isGuest
    ? 'Guest profile · inactive profiles are removed after 90 days'
    : authUser.email || 'Legacy username account';
  $('#emailEnrollment').classList.toggle('hidden', authUser.isGuest || authUser.emailVerified === true);
  $('#profileEmailStatus').textContent = authUser.isGuest ? '' : authUser.emailVerified ? 'Email verified' : authUser.email ? 'Email not verified' : 'Email not set';
  $('#enrollmentEmail').readOnly = !!authUser.email;
  if (authUser.email) $('#enrollmentEmail').value = authUser.email;
  $('#enrollmentEmailUnavailable').classList.toggle('hidden', authConfiguration?.emailVerification?.configured !== false);
  $('#enrollmentSubmit').disabled = authConfiguration?.emailVerification?.configured === false;
  syncEmailCode('enrollment');
  $('#inviteAdmin').classList.toggle('hidden', !authUser.isAdmin);
  $('#monitoringBtn').classList.toggle('hidden', !authUser.isAdmin);
}

async function loadProfileData(transition, userId) {
  const remote = await api('/api/data');
  if (transition !== authTransition || authUser?.id !== userId) return false;
  profileRevision = Number(remote.revision || 0);
  if (notebooks) notebooks.notesRevision = Number(remote.notesRevision || 0);
  const hasRemoteCourses = Object.keys(remote.courses || {}).length > 0;
  const hasLegacyCourses = Object.keys(legacyCourses || {}).length > 0;
  const legacyHandledKey = `ft_legacy_handled_v2_${userId}`;
  let importLegacy = false;
  if (!hasRemoteCourses && hasLegacyCourses && !DB.load(legacyHandledKey, false)) {
    importLegacy = confirm(
      `Import the ${Object.keys(legacyCourses).length} course(s) and progress already saved in this browser into this profile?`
    );
    if (!importLegacy) DB.save(legacyHandledKey, true);
  }
  courses = importLegacy ? legacyCourses : remote.courses || {};
  const sourceStats = importLegacy ? legacyStats : remote.stats || {};
  stats = {
    ...sourceStats,
    seconds: sourceStats.seconds || {},
    lastStreakToast: sourceStats.lastStreakToast || '',
  };
  const settings = remote.settings || {};
  userName = settings.userName || '';
  volume = Number.isFinite(settings.volume) ? settings.volume : 100;
  captionsOn = typeof settings.captionsOn === 'boolean' ? settings.captionsOn : false;
  prefQuality = settings.prefQuality || 'default';
  homeMode = settings.homeMode === 'list' ? 'list' : 'grid';
  workspace = normalizeWorkspace(remote.workspace);
  volBar.value = volume;
  volBar.style.setProperty('--fill', volume + '%');
  ccBtn.classList.toggle('active', captionsOn);
  if (importLegacy) {
    const saved = await persistRemoteData({ importLegacy: true });
    if (!saved) throw new Error('Could not import this browser’s existing progress. Please try again.');
    DB.save(legacyHandledKey, true);
  }
  return transition === authTransition && authUser?.id === userId;
}

async function finishAuth(user, transition = ++authTransition) {
  if (transition !== authTransition) return false;
  if (user.isGuest) {
    showAuth({ preserveInvite: true });
    authUser = user;
    setAuthMode('upgrade');
    return true;
  }
  resetSessionState();
  authUser = user;
  authView.classList.add('hidden');
  restoreAppearance(user);
  const railPreference = DB.load(`ft_course_tools_${user.id}`, true);
  courseToolsCollapsePreference = typeof railPreference === 'boolean' ? railPreference : true;
  courseLayouts = {};
  topbar.classList.remove('hidden');
  $('#workspaceRail').classList.remove('hidden');
  document.body.classList.add('workspace-open');
  syncWorkspaceSidebar();
  updateProfileUI();
  try {
    if (!(await loadProfileData(transition, user.id))) return false;
    appBooted = true;
    updatePresence();
    renderStreakChip();
    route();
    return true;
  } catch (err) {
    showAuth();
    $('#authError').textContent = err.message;
    $('#authError').classList.remove('hidden');
    return false;
  }
}

async function bootAuth() {
  const transition = ++authTransition;
  setAuthBusy(true);
  try {
    const configuration = await api('/api/auth/status');
    if (transition !== authTransition) return;
    authConfiguration = configuration;
    const { user } = await api('/api/auth/me');
    if (transition !== authTransition) return;
    if (user && !user.isGuest && window.FocusTubeInvite.has()) {
      showAuth({ preserveInvite: true });
      authUser = user;
      setAuthMode('register');
      $('#inviteAccountName').textContent = `Signed in as ${user.displayName || user.email}.`;
      $('#inviteAccountChoice').classList.remove('hidden');
    } else if (user) await finishAuth(user, transition);
    else showAuth({ preserveInvite: true });
  } catch (error) {
    showAuth({ preserveInvite: true });
    if (error.status !== 401) {
      $('#authError').textContent = error.status ? error.message : 'Could not reach the FocusTube server.';
      $('#authError').classList.remove('hidden');
    }
  } finally {
    if (transition === authTransition) setAuthBusy(false);
  }
}

/* ================= streak / stats ================= */
function activeDaySet() {
  return new Set(
    Object.entries(stats.seconds)
      .filter(([, s]) => s >= DAY_ACTIVE_SECONDS)
      .map(([d]) => d)
  );
}

function currentStreak() {
  const days = activeDaySet();
  const d = new Date();
  if (!days.has(todayKey(d))) d.setDate(d.getDate() - 1); // today not active yet — count up to yesterday
  let streak = 0;
  while (days.has(todayKey(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function bestStreak() {
  const days = [...activeDaySet()].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const key of days) {
    const dt = new Date(key + 'T12:00:00');
    if (prev && dt - prev === 86400000) run++;
    else run = 1;
    best = Math.max(best, run);
    prev = dt;
  }
  return best;
}

function renderStreakChip() {
  streakNum.textContent = currentStreak();
}

function addWatchSeconds(s) {
  const k = todayKey();
  const before = stats.seconds[k] || 0;
  stats.seconds[k] = before + s;
  queueWatchSeconds(s);
  if (before < DAY_ACTIVE_SECONDS && stats.seconds[k] >= DAY_ACTIVE_SECONDS) {
    renderStreakChip();
    if (stats.lastStreakToast !== k) {
      stats.lastStreakToast = k;
      const n = currentStreak();
      toast(n > 1 ? `🔥 ${n}-day streak! Keep it rolling.` : '🔥 Streak started — come back tomorrow!');
    }
    saveStats();
  }
}

function openStats() {
  $('#statStreak').textContent = currentStreak();
  $('#statBest').textContent = bestStreak();
  const total = Object.values(stats.seconds).reduce((a, b) => a + b, 0);
  $('#statTime').textContent = fmtLong(total);
  $('#statDays').textContent = activeDaySet().size;
  renderChartData('statsActivityData', 'Recorded watch time', ['Date', 'Minutes'],
    Object.entries(stats.seconds).sort(([first], [second]) => second.localeCompare(first)).map(([date, seconds]) => [date, Math.round(seconds / 60)]));

  // heatmap: 20 weeks, columns = weeks starting Sunday
  const hm = $('#heatmap');
  hm.innerHTML = '';
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 7 * 19); // Sunday, 19 weeks back
  const cursor = new Date(start);
  const endOfGrid = new Date(start);
  endOfGrid.setDate(start.getDate() + 20 * 7 - 1);
  while (cursor <= endOfGrid) {
    const key = todayKey(cursor);
    const mins = (stats.seconds[key] || 0) / 60;
    let lvl = 'l0';
    if (mins >= 60) lvl = 'l4';
    else if (mins >= 30) lvl = 'l3';
    else if (mins >= 10) lvl = 'l2';
    else if (mins >= 1) lvl = 'l1';
    const cell = el('i', {
      class: `hm-cell ${lvl}${cursor > today ? ' future' : ''}`,
      title: `${key} — ${Math.round(mins)} min`,
    });
    hm.append(cell);
    cursor.setDate(cursor.getDate() + 1);
  }
  showModal('statsModal');
}

/* ================= home view ================= */
const LIBRARY_STATUSES = { all: 'All courses', 'not-started': 'Not started', 'in-progress': 'In progress', completed: 'Completed' };

function summarizeCourse(course) {
  const videos = course.videos || [];
  let done = 0;
  let started = false;
  let totalSeconds = 0;
  let knownDurations = 0;
  for (const video of videos) {
    if (course.completed?.[video.id]) done++;
    const position = course.positions?.[video.id];
    if (Number.isFinite(position) && position > 0) started = true;
    if (Number.isFinite(video.durationSeconds) && video.durationSeconds > 0) {
      totalSeconds += video.durationSeconds;
      knownDurations++;
    }
  }
  const total = videos.length;
  const status = total > 0 && done === total ? 'completed' : done > 0 || started ? 'in-progress' : 'not-started';
  let duration = 'Duration unavailable';
  if (knownDurations && Number.isFinite(totalSeconds)) {
    duration = totalSeconds < 60 ? `${totalSeconds}s` : fmtLong(Math.floor(totalSeconds / 60) * 60);
    if (knownDurations < total) duration = 'At least ' + duration;
  }
  return { course, done, total, pct: total ? Math.round(done / total * 100) : 0, status, duration, totalSeconds, knownDurations };
}

function selectLibraryCourses(summaries, status, pinnedOnly) {
  const eligible = pinnedOnly ? summaries.filter(summary => summary.course.pinned) : summaries;
  const counts = Object.fromEntries(Object.keys(LIBRARY_STATUSES).map(key => [key, key === 'all' ? eligible.length : eligible.filter(summary => summary.status === key).length]));
  const list = eligible.filter(summary => status === 'all' || summary.status === status).sort(
    (first, second) => Number(!!second.course.pinned) - Number(!!first.course.pinned) || second.course.addedAt - first.course.addedAt
  );
  return { list, counts };
}

function renderHome() {
  updateSearchLibraryState();
  const summaries = Object.values(courses).map(summarizeCourse);
  const { list, counts } = selectLibraryCourses(summaries, libraryStatus, showPinnedOnly);
  $('#libraryCourseCount').textContent = summaries.length;
  $('#libraryLearningCount').textContent = summaries.filter(summary => summary.status === 'in-progress').length;
  $('#libraryCompletedCount').textContent = summaries.filter(summary => summary.status === 'completed').length;
  $('#libraryHeading').classList.toggle('hidden', summaries.length === 0);
  $('#libraryControls').classList.toggle('hidden', summaries.length === 0);
  $('#libraryResultCount').textContent = `${list.length} of ${summaries.length}`;
  $('#libraryResultCount').setAttribute('aria-label', `${list.length} of ${summaries.length} courses shown`);
  const statusFilter = $('#libraryStatusFilter');
  for (const option of statusFilter.options) option.textContent = `${LIBRARY_STATUSES[option.value]} (${counts[option.value]})`;
  statusFilter.value = libraryStatus;
  for (const mode of ['grid', 'list']) {
    const button = $('#' + mode + 'ModeBtn');
    button.classList.toggle('active', homeMode === mode);
    button.setAttribute('aria-pressed', String(homeMode === mode));
  }
  courseGrid.classList.toggle('list-view', homeMode === 'list');
  pinnedFilterBtn.classList.toggle('active', showPinnedOnly);
  pinnedFilterBtn.setAttribute('aria-pressed', String(showPinnedOnly));
  renderRoadmapStrip();
  courseGrid.innerHTML = '';
  if (!summaries.length) {
    courseGrid.append(el('div', { class: 'library-empty' }, el('span', { class: 'empty-icon', html: I.library }), el('h2', {}, 'No courses yet.'), el('button', { class: 'btn ghost', onclick: () => urlInput.focus() }, 'Find a course')));
    return;
  }
  if (list.length === 0) {
    courseGrid.append(el('div', { class: 'library-filter-empty' },
      el('p', {}, 'No courses match these filters.'),
      el('button', { class: 'btn ghost slim', type: 'button', onclick: () => {
        libraryStatus = 'all';
        showPinnedOnly = false;
        renderHome();
        $('#libraryStatusFilter').focus();
      } }, 'Clear filters')
    ));
    return;
  }
  for (const { course: c, done, total, pct, status, duration, totalSeconds, knownDurations } of list) {
    const thumbId = c.videos[0]?.id;
    const href = '#c=' + encodeURIComponent(c.id);
    const durationHint = knownDurations === total && total > 0 && Number.isFinite(totalSeconds)
      ? `${fmtDuration(totalSeconds)} total duration` : `${knownDurations} of ${total} lesson durations available`;
    const card = el(
      'article',
      { class: 'course-card' + (c.pinned ? ' is-pinned' : ''), role: 'listitem', 'data-course-id': c.id },
      el('div', { class: 'card-cover' },
        el('a', { class: 'card-thumbnail-link', href, tabindex: '-1', 'aria-label': 'Open ' + c.title },
          thumbId ? el('img', {
            class: 'card-thumb', src: `https://i.ytimg.com/vi/${thumbId}/mqdefault.jpg`, alt: '', loading: 'lazy',
            onerror: event => event.target.replaceWith(el('span', { class: 'card-thumb-placeholder', html: I.library, 'aria-hidden': 'true' })),
          }) : el('span', { class: 'card-thumb-placeholder', html: I.library, 'aria-hidden': 'true' })
        ),
        c.pinned ? el('span', { class: 'card-pin-badge', html: I.pin, 'aria-hidden': 'true' }) : null
      ),
      el(
        'div',
        { class: 'card-body' },
        el('div', { class: 'card-heading' },
          el('a', { class: 'card-title', href, title: c.title }, c.title),
          el('div', { class: 'card-meta card-author' }, c.author || 'YouTube')
        ),
        el('div', { class: 'card-details' },
          el('span', { class: 'card-meta card-lessons' }, `${total} lesson${total === 1 ? '' : 's'}`),
          el('span', { class: 'card-duration', title: durationHint }, duration)
        ),
        el('span', { class: 'course-status', 'data-status': status }, LIBRARY_STATUSES[status]),
        el(
          'div',
          { class: 'card-progress-block' },
          el(
            'div',
            { class: 'card-progress', role: 'progressbar', 'aria-label': 'Course completion', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-valuetext': `${done} of ${total} lessons completed` },
            el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill' + (status === 'completed' ? ' full' : ''), style: `width:${pct}%` })),
            el('span', { class: 'card-pct' }, `${pct}%`)
          ),
          el('span', { class: 'card-meta card-completion' }, `${done} / ${total} completed`)
        ),
        el(
          'div',
          { class: 'card-actions' },
            el('button', {
              class: 'card-pin' + (c.pinned ? ' active' : ''),
              type: 'button',
              title: c.pinned ? 'Remove bookmark' : 'Bookmark course',
              'aria-label': `${c.pinned ? 'Remove bookmark from' : 'Bookmark'} ${c.title}`,
              'aria-pressed': String(!!c.pinned),
              html: I.pin,
              onclick: (e) => {
                e.stopPropagation();
                c.pinned = !c.pinned;
                saveCourses();
                renderHome();
                (courseGrid.querySelector(`[data-course-id="${CSS.escape(c.id)}"] .card-pin`) || pinnedFilterBtn).focus({ preventScroll: true });
              },
            }),
            el('button', {
              class: 'card-del',
              type: 'button',
              title: 'Remove course',
              'aria-label': 'Remove ' + c.title,
              html: I.trash,
              onclick: (e) => {
                e.stopPropagation();
                if (confirm(`Remove "${c.title}"?\nYour progress for it will be deleted. Your notebook will be kept.`)) {
                  delete courses[c.id];
                  cleanupCourseWorkspace(c.id);
                  saveCourses();
                  renderHome();
                  (courseGrid.querySelector('.card-title') || (Object.keys(courses).length ? $('#libraryStatusFilter') : urlInput)).focus({ preventScroll: true });
                }
              },
            })
        )
      )
    );
    courseGrid.append(card);
  }
}

function isCourseLink(value) {
  return /^(?:https?:\/\/|(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/)/i.test(value)
    || /^(?:PL|UU|FL|OL|RD)[A-Za-z0-9_-]{5,}$/.test(value);
}

function updateDiscoveryControls() {
  const query = urlInput.value.trim();
  const isLink = isCourseLink(query);
  addBtn.textContent = importingLink ? 'Creating course...' : isLink ? 'Create course' : searchBusy ? 'Searching...' : 'Search';
  addBtn.disabled = importingLink || (searchBusy && query === searchQuery);
  urlInput.disabled = importingLink;
  searchFilters.disabled = !query || isLink || importingLink;
  searchFilters.classList.toggle('hidden', searchFilters.disabled);
}

function clearCourseSearch({ clearInput = false } = {}) {
  searchController?.abort();
  searchController = null;
  searchBusy = false;
  searchQuery = '';
  searchData = [];
  searchSection.classList.add('hidden');
  searchResults.replaceChildren();
  searchResults.setAttribute('aria-busy', 'false');
  searchSummary.textContent = '';
  searchError.classList.add('hidden');
  retrySearchBtn.classList.add('hidden');
  if (clearInput) urlInput.value = '';
  updateDiscoveryControls();
}

function resetDiscovery() {
  pendingCourseImports.clear();
  importingLink = false;
  searchType = 'all';
  for (const input of searchFilters.querySelectorAll('input')) input.checked = input.value === searchType;
  addError.classList.add('hidden');
  clearCourseSearch({ clearInput: true });
}

function youtubeSearchUrl(query, type) {
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', type === 'course' && !/\bcourse\b/i.test(query) ? `${query} full course` : query);
  url.searchParams.set('hl', 'en');
  if (type === 'video') url.searchParams.set('sp', 'EgIQAQ==');
  if (type === 'playlist') url.searchParams.set('sp', 'EgIQAw==');
  return url.href;
}

function updateSearchLibraryState() {
  for (const row of searchResults.querySelectorAll('.search-result')) {
    const saved = Boolean(courses[row.dataset.resultId]);
    const pending = pendingCourseImports.has(row.dataset.resultUrl);
    const button = $('.search-create-btn', row);
    button.disabled = pending;
    button.textContent = pending ? 'Creating course...' : saved ? 'Open course' : 'Create course';
    $('.search-saved', row).classList.toggle('hidden', !saved);
  }
}

function renderSearchResults() {
  searchResults.replaceChildren();
  for (const result of searchData) {
    const error = el('div', { class: 'add-error hidden', role: 'alert' });
    const button = el('button', {
      type: 'button',
      class: 'btn search-create-btn',
      onclick: () => {
        if (courses[result.id]) location.hash = '#c=' + result.id;
        else addCourse(result.url, { button, errorTarget: error, open: false });
      },
    }, 'Create course');
    const countLabel = result.isCourse ? 'lesson' : 'video';
    const badge = result.type === 'video' ? result.duration
      : result.videoCount === null ? '' : `${result.videoCount} ${countLabel}${result.videoCount === 1 ? '' : 's'}`;
    const youtubeLink = { href: result.url, target: '_blank', rel: 'noopener noreferrer' };
    searchResults.append(el('article', {
      class: 'search-result',
      'data-result-id': result.id,
      'data-result-url': result.url,
    },
    el('a', { ...youtubeLink, class: 'search-thumb', 'aria-label': `Open ${result.title} on YouTube` },
      el('span', { class: 'search-thumb-placeholder', html: result.type === 'video' ? I.play : I.menu, 'aria-hidden': 'true' }),
      result.thumbnail ? el('img', {
        src: result.thumbnail, alt: '', loading: 'lazy', width: '320', height: '180',
        onerror: event => event.currentTarget.remove(),
      }) : null,
      badge ? el('span', { class: 'search-thumb-label' }, badge) : null
    ),
    el('div', { class: 'search-result-body' },
      el('div', { class: 'search-result-kicker' },
        el('span', { class: 'search-result-type' }, result.isCourse ? 'Course' : result.type === 'video' ? 'Video' : 'Playlist'),
        el('span', { class: 'search-saved hidden' }, el('span', { html: I.check, 'aria-hidden': 'true' }), 'In library')
      ),
      el('h3', {}, el('a', { ...youtubeLink, class: 'search-result-title' }, result.title)),
      el('p', { class: 'search-result-author' }, result.author || 'YouTube'),
      result.metadata ? el('p', { class: 'search-result-meta' }, result.metadata) : null
    ),
    result.description ? el('p', { class: 'search-result-description' }, result.description) : null,
    el('div', { class: 'search-result-actions' }, button, error)
    ));
  }
  updateSearchLibraryState();
}

async function searchYouTube(query, type = searchType) {
  query = query.trim();
  if (!query) return;
  addError.classList.add('hidden');
  if (query.length > 200) {
    clearCourseSearch();
    addError.textContent = 'Enter a search term between 1 and 200 characters.';
    addError.classList.remove('hidden');
    return;
  }
  searchController?.abort();
  const controller = new AbortController();
  const generation = sessionGeneration;
  searchController = controller;
  searchQuery = query;
  searchBusy = true;
  searchData = [];
  searchSection.classList.remove('hidden');
  searchResults.replaceChildren();
  searchResults.setAttribute('aria-busy', 'true');
  searchError.classList.add('hidden');
  retrySearchBtn.classList.add('hidden');
  searchSummary.textContent = `Searching for "${query}"...`;
  searchYoutubeLink.href = youtubeSearchUrl(query, type);
  updateDiscoveryControls();
  try {
    const data = await api('/api/search?' + new URLSearchParams({ q: query, type }), { signal: controller.signal });
    if (searchController !== controller || generation !== sessionGeneration) return;
    searchData = data.results;
    searchYoutubeLink.href = data.youtubeUrl;
    const label = { all: 'result', video: 'video result', playlist: 'playlist result', course: 'course-focused result' }[type]
      + (searchData.length === 1 ? '' : 's');
    searchSummary.textContent = searchData.length ? `${searchData.length} ${label} for "${data.query}"` : `No ${label} for "${data.query}".`;
    renderSearchResults();
  } catch (err) {
    if (controller.signal.aborted || searchController !== controller || generation !== sessionGeneration) return;
    if (err.status === 401) return showAuth();
    searchSummary.textContent = `Search unavailable for "${query}"`;
    searchError.textContent = err.message;
    searchError.classList.remove('hidden');
    retrySearchBtn.classList.remove('hidden');
  } finally {
    if (searchController === controller) {
      searchController = null;
      searchBusy = false;
      searchResults.setAttribute('aria-busy', 'false');
      updateDiscoveryControls();
    }
  }
}

async function addCourse(url, { button = addBtn, errorTarget = addError, open = true } = {}) {
  if (pendingCourseImports.has(url)) return;
  const generation = sessionGeneration;
  const direct = button === addBtn;
  pendingCourseImports.add(url);
  errorTarget.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Creating course...';
  if (direct) {
    importingLink = true;
    clearCourseSearch();
  }
  try {
    const source = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(url) ? 'https://' + url : url;
    const res = await fetch('/api/playlist?url=' + encodeURIComponent(source));
    const data = await res.json();
    if (generation !== sessionGeneration) return;
    if (!res.ok) throw new Error(data.error || 'Could not load that video or playlist.');
    const existing = courses[data.id];
    courses[data.id] = {
      id: data.id,
      title: data.title,
      author: data.author,
      addedAt: existing?.addedAt || Date.now(),
      lastSyncedAt: Date.now(),
      videos: data.videos,
      completed: existing?.completed || {},
      positions: existing?.positions || {},
      lastVideoId: existing?.lastVideoId || null,
      speed: existing?.speed || 1,
      completedAt: existing?.completedAt || null,
      pinned: existing?.pinned || false,
    };
    saveCourses();
    if (direct) urlInput.value = '';
    if (data.skipped) toast(`${data.skipped} private/deleted video(s) were skipped.`);
    if (open) {
      const target = '#c=' + data.id;
      if (location.hash === target) route(); // same hash → no hashchange event
      else location.hash = target;
    } else {
      renderHome();
      toast(`Added "${data.title}" to your library.`);
    }
  } catch (err) {
    if (generation !== sessionGeneration) return;
    errorTarget.textContent = err.message;
    errorTarget.classList.remove('hidden');
    if (!errorTarget.isConnected) toast(err.message, { error: true });
  } finally {
    if (generation === sessionGeneration) {
      pendingCourseImports.delete(url);
      if (direct) importingLink = false;
      button.disabled = false;
      button.textContent = 'Create course';
      updateDiscoveryControls();
      updateSearchLibraryState();
    }
  }
}

/* ================= workspace: kanban board, tasks, checklists, sprints ================= */
const AUTO_COLUMNS = [
  { id: 'backlog', title: 'Backlog', kind: 'auto' },
  { id: 'learning', title: 'Learning', kind: 'auto' },
  { id: 'done', title: 'Completed', kind: 'auto' },
];
const PRIORITY_LABEL = { low: 'Low', med: 'Med', high: 'High' };
const PRIORITY_RANK = { high: 0, med: 1, low: 2 };
const expandedChecklists = new Set(); // board cards with an open checklist (session-only)
let editingTaskId = null;
let pendingNewColumnId = null; // column awaiting its first name via inline edit

const uid = () =>
  window.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);

function defaultWorkspace() {
  return normalizeWorkspace({});
}

/** Coerce anything the server (or an older client) stored into a safe workspace shape. */
function normalizeWorkspace(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const board = src.board && typeof src.board === 'object' ? src.board : {};
  const sprints = src.sprints && typeof src.sprints === 'object' ? src.sprints : {};

  const reserved = new Set(['backlog', 'learning', 'done', 'unassigned']);
  const columns = [];
  for (const col of Array.isArray(board.columns) ? board.columns : []) {
    const id = typeof col?.id === 'string' ? col.id : '';
    if (!id || reserved.has(id)) continue;
    reserved.add(id);
    columns.push({ id, title: String(col.title || 'Untitled').slice(0, 60) });
  }

  const overrides = {};
  if (board.overrides && typeof board.overrides === 'object') {
    for (const [key, value] of Object.entries(board.overrides)) {
      if (typeof value === 'string') overrides[key] = value;
    }
  }
  const cardOrder = {};
  if (board.cardOrder && typeof board.cardOrder === 'object') {
    for (const [key, value] of Object.entries(board.cardOrder)) {
      if (Array.isArray(value)) cardOrder[key] = value.filter((item) => typeof item === 'string');
    }
  }

  const tasks = {};
  if (src.tasks && typeof src.tasks === 'object') {
    for (const [id, t] of Object.entries(src.tasks)) {
      if (!t || typeof t !== 'object' || !String(t.title || '').trim()) continue;
      tasks[id] = {
        id,
        title: String(t.title).slice(0, 200),
        notes: String(t.notes || '').slice(0, 2000),
        status: ['todo', 'doing', 'done'].includes(t.status) ? t.status : 'todo',
        priority: ['low', 'med', 'high'].includes(t.priority) ? t.priority : 'med',
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate || '') ? t.dueDate : null,
        courseId: typeof t.courseId === 'string' && t.courseId ? t.courseId : null,
        createdAt: Number(t.createdAt) || Date.now(),
        completedAt: Number(t.completedAt) || null,
      };
    }
  }

  const checklists = {};
  if (src.checklists && typeof src.checklists === 'object') {
    for (const [courseId, items] of Object.entries(src.checklists)) {
      if (!Array.isArray(items)) continue;
      const list = items
        .filter((item) => item && typeof item === 'object' && item.id && String(item.text || '').trim())
        .map((item) => ({ id: String(item.id), text: String(item.text).slice(0, 300), done: !!item.done }));
      if (list.length) checklists[courseId] = list;
    }
  }

  const sprintItems = (Array.isArray(sprints.items) ? sprints.items : [])
    .filter(
      (s) =>
        s && s.id && /^\d{4}-\d{2}-\d{2}$/.test(s.startDate || '') && /^\d{4}-\d{2}-\d{2}$/.test(s.endDate || '')
    )
    .map((s) => ({
      id: String(s.id),
      title: String(s.title || 'Sprint').slice(0, 60),
      startDate: s.startDate,
      endDate: s.endDate,
    }));
  const assignments = {};
  if (sprints.assignments && typeof sprints.assignments === 'object') {
    for (const [key, value] of Object.entries(sprints.assignments)) {
      if (typeof value === 'string') assignments[key] = value;
    }
  }

  const roadmaps = {};
  if (src.roadmaps && typeof src.roadmaps === 'object') {
    for (const [id, r] of Object.entries(src.roadmaps)) {
      if (!r || typeof r !== 'object' || !String(r.title || '').trim()) continue;
      roadmaps[id] = {
        id,
        title: String(r.title).slice(0, 80),
        courseIds: Array.isArray(r.courseIds) ? r.courseIds.filter((item) => typeof item === 'string') : [],
        createdAt: Number(r.createdAt) || Date.now(),
      };
    }
  }

  return {
    board: { mode: board.mode === 'sprint' ? 'sprint' : 'status', columns, overrides, cardOrder },
    sprints: {
      cadence: ['week', 'biweek', 'month'].includes(sprints.cadence) ? sprints.cadence : 'week',
      items: sprintItems,
      assignments,
    },
    tasks,
    checklists,
    roadmaps,
  };
}

/** Conflict merge (409): union by id, local edits win. */
function mergeWorkspaceState(remoteRaw) {
  const remote = normalizeWorkspace(remoteRaw);
  const local = workspace;
  const columns = [...local.board.columns];
  for (const col of remote.board.columns) {
    if (!columns.some((existing) => existing.id === col.id)) columns.push(col);
  }
  const checklists = { ...remote.checklists };
  for (const [courseId, items] of Object.entries(local.checklists)) {
    const merged = new Map((checklists[courseId] || []).map((item) => [item.id, item]));
    for (const item of items) merged.set(item.id, item);
    checklists[courseId] = [...merged.values()];
  }
  workspace = {
    board: {
      mode: local.board.mode,
      columns,
      overrides: { ...remote.board.overrides, ...local.board.overrides },
      cardOrder: { ...remote.board.cardOrder, ...local.board.cardOrder },
    },
    sprints: {
      cadence: local.sprints.cadence,
      items: local.sprints.items.length ? local.sprints.items : remote.sprints.items,
      assignments: { ...remote.sprints.assignments, ...local.sprints.assignments },
    },
    tasks: { ...remote.tasks, ...local.tasks },
    checklists,
    roadmaps: { ...remote.roadmaps, ...local.roadmaps },
  };
}

function cleanupCourseWorkspace(courseId) {
  const key = 'c:' + courseId;
  delete workspace.board.overrides[key];
  delete workspace.sprints.assignments[key];
  delete workspace.checklists[courseId];
  for (const list of Object.values(workspace.board.cardOrder)) {
    const at = list.indexOf(key);
    if (at !== -1) list.splice(at, 1);
  }
  for (const t of Object.values(workspace.tasks)) if (t.courseId === courseId) t.courseId = null;
  for (const r of Object.values(workspace.roadmaps)) {
    r.courseIds = r.courseIds.filter((item) => item !== courseId);
  }
}

/* ---------- column & placement helpers ---------- */
function statusColumns() {
  return [...AUTO_COLUMNS, ...workspace.board.columns.map((col) => ({ ...col, kind: 'custom' }))];
}

function sprintColumns() {
  return [{ id: 'unassigned', title: 'Unassigned' }, ...workspace.sprints.items];
}

function courseAutoColumnId(c) {
  const done = countDone(c);
  if (c.videos.length && done === c.videos.length) return 'done';
  return done > 0 ? 'learning' : 'backlog';
}

function cardColumnId(key) {
  const override = workspace.board.overrides[key];
  if (override && statusColumns().some((col) => col.id === override)) return override;
  if (key.startsWith('c:')) {
    const c = courses[key.slice(2)];
    return c ? courseAutoColumnId(c) : 'backlog';
  }
  const t = workspace.tasks[key.slice(2)];
  if (!t) return 'backlog';
  return t.status === 'done' ? 'done' : t.status === 'doing' ? 'learning' : 'backlog';
}

function orderCards(columnId, keys) {
  const order = workspace.board.cardOrder[columnId] || [];
  const rank = new Map(order.map((key, index) => [key, index]));
  return keys.sort((a, b) => (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9));
}

function allCardKeys() {
  const courseKeys = Object.values(courses)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.addedAt - a.addedAt)
    .map((c) => 'c:' + c.id);
  const taskKeys = Object.values(workspace.tasks)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => 't:' + t.id);
  return [...courseKeys, ...taskKeys];
}

function setTaskStatus(t, status) {
  if (t.status === status) return;
  t.status = status;
  t.completedAt = status === 'done' ? Date.now() : null;
}

/* ---------- card moves ---------- */
function moveCardToColumn(key, columnId, beforeKey = null, visibleOrder = null) {
  if (beforeKey === key) beforeKey = null;
  if (key.startsWith('t:')) {
    const t = workspace.tasks[key.slice(2)];
    if (!t) return;
    const autoStatus = { backlog: 'todo', learning: 'doing', done: 'done' }[columnId];
    if (autoStatus) {
      setTaskStatus(t, autoStatus);
      delete workspace.board.overrides[key];
    } else {
      workspace.board.overrides[key] = columnId;
    }
  } else {
    const c = courses[key.slice(2)];
    if (!c) return;
    if (columnId === courseAutoColumnId(c)) delete workspace.board.overrides[key];
    else workspace.board.overrides[key] = columnId;
  }
  for (const list of Object.values(workspace.board.cardOrder)) {
    const at = list.indexOf(key);
    if (at !== -1) list.splice(at, 1);
  }
  if (visibleOrder) workspace.board.cardOrder[columnId] = visibleOrder.filter((item) => item !== key);
  const list = (workspace.board.cardOrder[columnId] ||= []);
  const at = beforeKey ? list.indexOf(beforeKey) : -1;
  if (at === -1) list.push(key);
  else list.splice(at, 0, key);
  scheduleRemoteSave();
  refreshTaskUIs();
}

function assignCardToSprint(key, columnId) {
  if (columnId === 'unassigned') delete workspace.sprints.assignments[key];
  else workspace.sprints.assignments[key] = columnId;
  scheduleRemoteSave();
  refreshTaskUIs();
}

/* ---------- board rendering ---------- */
function renderBoard() {
  if (!boardEl) return;
  boardEl.innerHTML = '';
  const sprintMode = workspace.board.mode === 'sprint';
  $('#statusBoardBtn').classList.toggle('active', !sprintMode);
  $('#sprintBoardBtn').classList.toggle('active', sprintMode);
  $('#addColumnBtn').classList.toggle('hidden', sprintMode);
  $('#sprintSetupBtn').classList.toggle('hidden', !sprintMode);
  if (sprintMode) renderSprintBoard();
  else renderStatusBoard();
}

function renderStatusBoard() {
  const cols = statusColumns();
  const buckets = new Map(cols.map((col) => [col.id, []]));
  for (const key of allCardKeys()) {
    (buckets.get(cardColumnId(key)) || buckets.get('backlog')).push(key);
  }
  for (const col of cols) {
    const keys = orderCards(col.id, buckets.get(col.id) || []);
    boardEl.append(buildColumn(col, keys, { custom: col.kind === 'custom' }));
  }
  if (pendingNewColumnId) {
    const id = pendingNewColumnId;
    pendingNewColumnId = null;
    const head = boardEl.querySelector(`.board-column[data-col="${CSS.escape(id)}"] .board-col-head`);
    if (head) {
      editColumnTitleInline(head, '', {
        commit: (name) => {
          const col = workspace.board.columns.find((item) => item.id === id);
          if (col) col.title = name;
          scheduleRemoteSave();
          renderBoard();
        },
        cancel: () => {
          workspace.board.columns = workspace.board.columns.filter((item) => item.id !== id);
          renderBoard();
        },
      });
    }
  }
}

function renderSprintBoard() {
  if (!workspace.sprints.items.length) {
    boardEl.append(
      el(
        'div',
        { class: 'board-col-empty', style: 'flex:1;padding:34px 20px' },
        'No sprints yet. ',
        el('button', { class: 'btn ghost slim', type: 'button', onclick: openSprintModal }, 'Set up sprints')
      )
    );
    return;
  }
  const cols = sprintColumns();
  const colIds = new Set(cols.map((col) => col.id));
  const buckets = new Map(cols.map((col) => [col.id, []]));
  for (const key of allCardKeys()) {
    const sprintId = workspace.sprints.assignments[key];
    buckets.get(colIds.has(sprintId) ? sprintId : 'unassigned').push(key);
  }
  const today = todayKey();
  for (const col of cols) {
    const isSprint = col.id !== 'unassigned';
    boardEl.append(
      buildColumn(col, buckets.get(col.id), {
        currentSprint: isSprint && col.startDate <= today && today <= col.endDate,
        ended: isSprint && col.endDate < today,
        dates: isSprint ? `${shortDate(col.startDate)} – ${shortDate(col.endDate)}` : null,
      })
    );
  }
}

function buildColumn(col, keys, opts = {}) {
  const body = el('div', { class: 'board-col-body' });
  for (const key of keys) {
    const card = buildCard(key);
    if (card) body.append(card);
  }
  if (!body.children.length) body.append(el('div', { class: 'board-col-empty' }, 'Drop cards here'));
  const head = el(
    'div',
    { class: 'board-col-head' },
    el('h3', {}, col.title),
    el('span', { class: 'board-col-count' }, String(keys.length)),
    el('span', { class: 'spacer' }),
    opts.currentSprint ? el('span', { class: 'board-col-badge now' }, 'Now') : null,
    opts.ended ? el('span', { class: 'board-col-badge ended' }, 'Ended') : null,
    opts.custom
      ? el('button', {
          class: 'board-col-menu',
          type: 'button',
          title: 'Rename column',
          onclick: (e) => renameColumn(col.id, e.target.closest('.board-col-head')),
        }, '✎')
      : null,
    opts.custom
      ? el('button', { class: 'board-col-menu', type: 'button', title: 'Delete column', onclick: () => deleteColumn(col.id) }, '✕')
      : null
  );
  const column = el(
    'div',
    { class: 'board-column' + (opts.currentSprint ? ' current-sprint' : ''), 'data-col': col.id },
    head,
    opts.dates ? el('div', { class: 'board-col-dates' }, opts.dates) : null,
    body
  );
  column.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    column.classList.add('drag-over');
  });
  column.addEventListener('dragleave', (e) => {
    if (!column.contains(e.relatedTarget)) column.classList.remove('drag-over');
  });
  column.addEventListener('drop', (e) => {
    e.preventDefault();
    column.classList.remove('drag-over');
    const key = e.dataTransfer.getData('text/plain');
    if (!key || !(key.startsWith('c:') || key.startsWith('t:'))) return;
    if (workspace.board.mode === 'sprint') {
      assignCardToSprint(key, col.id);
    } else {
      const beforeKey = e.target.closest?.('.board-card')?.dataset.key || null;
      const visibleOrder = [...body.querySelectorAll('.board-card')].map((node) => node.dataset.key);
      moveCardToColumn(key, col.id, beforeKey, visibleOrder);
    }
  });
  return column;
}

function buildCard(key) {
  if (key.startsWith('c:')) {
    const c = courses[key.slice(2)];
    return c ? buildCourseBoardCard(c) : null;
  }
  const t = workspace.tasks[key.slice(2)];
  return t ? buildTaskBoardCard(t) : null;
}

function makeCardDraggable(card, key) {
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', key);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
}

function moveButtons(key) {
  const sprintMode = workspace.board.mode === 'sprint';
  const cols = sprintMode ? sprintColumns() : statusColumns();
  let currentId;
  if (sprintMode) {
    const assigned = workspace.sprints.assignments[key];
    currentId = cols.some((col) => col.id === assigned) ? assigned : 'unassigned';
  } else {
    currentId = cardColumnId(key);
  }
  const index = cols.findIndex((col) => col.id === currentId);
  const make = (dir, glyph, label) => {
    const target = cols[index + dir];
    return el(
      'button',
      {
        class: 'card-move',
        type: 'button',
        title: target ? `${label}: ${target.title}` : label,
        disabled: target ? null : '',
        onclick: (e) => {
          e.stopPropagation();
          if (!target) return;
          if (sprintMode) assignCardToSprint(key, target.id);
          else moveCardToColumn(key, target.id);
        },
      },
      glyph
    );
  };
  return [make(-1, '◀', 'Move left'), make(1, '▶', 'Move right')];
}

function pinnedPill(key) {
  if (workspace.board.mode !== 'status' || !workspace.board.overrides[key]) return null;
  return el(
    'button',
    {
      class: 'pill pinned-pill',
      type: 'button',
      title: 'Placed manually — click to return to automatic placement',
      onclick: (e) => {
        e.stopPropagation();
        delete workspace.board.overrides[key];
        scheduleRemoteSave();
        refreshTaskUIs();
      },
    },
    'Manual'
  );
}

function buildCourseBoardCard(c) {
  const key = 'c:' + c.id;
  const done = countDone(c);
  const pct = c.videos.length ? Math.round((done / c.videos.length) * 100) : 0;
  const thumbId = c.videos[0]?.id;
  const list = workspace.checklists[c.id] || [];
  const expanded = expandedChecklists.has(c.id);
  const checkedCount = list.filter((item) => item.done).length;

  const children = [
    el(
      'div',
      { class: 'board-card-thumbrow' },
      thumbId
        ? el('img', {
            class: 'board-card-thumb',
            src: `https://i.ytimg.com/vi/${thumbId}/mqdefault.jpg`,
            alt: '',
            loading: 'lazy',
            onerror: (e) => (e.target.style.display = 'none'),
          })
        : null,
      el(
        'div',
        { style: 'min-width:0;flex:1' },
        el('div', { class: 'board-card-title' }, c.title),
        el(
          'div',
          { class: 'card-meta' },
          pct === 100 ? 'Completed' : `${done} / ${c.videos.length} done`
        )
      )
    ),
    el(
      'div',
      { class: 'card-progress' },
      el(
        'div',
        { class: 'progress-track' },
        el('div', { class: 'progress-fill' + (pct === 100 ? ' full' : ''), style: `width:${pct}%` })
      ),
      el('span', { class: 'card-pct' }, pct + '%')
    ),
    el(
      'button',
      {
        class: 'card-checklist-toggle',
        type: 'button',
        onclick: (e) => {
          e.stopPropagation();
          if (expanded) expandedChecklists.delete(c.id);
          else expandedChecklists.add(c.id);
          renderBoard();
        },
      },
      list.length ? `Checklist ${checkedCount}/${list.length}` : 'Add checklist'
    ),
  ];
  if (expanded) {
    const itemsWrap = el('div', { class: 'card-checklist' });
    for (const item of list) itemsWrap.append(checklistItemEl(c.id, item, renderBoard));
    children.push(
      itemsWrap,
      el(
        'form',
        {
          class: 'checklist-add',
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.target.querySelector('input');
            const text = input.value.trim();
            if (!text) return;
            (workspace.checklists[c.id] ||= []).push({ id: 'cl_' + uid(), text: text.slice(0, 300), done: false });
            scheduleRemoteSave();
            renderBoard();
            boardEl.querySelector(`.board-card[data-key="${CSS.escape(key)}"] .checklist-add input`)?.focus();
          },
        },
        el('input', { type: 'text', placeholder: 'Add checklist item…', maxlength: '300' })
      )
    );
  }
  children.push(
    el('div', { class: 'board-card-foot' }, pinnedPill(key), el('span', { class: 'spacer' }), ...moveButtons(key))
  );

  const card = el('div', { class: 'board-card', draggable: 'true', 'data-key': key }, ...children);
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, input, form, a, select')) return;
    location.hash = '#c=' + c.id;
  });
  makeCardDraggable(card, key);
  return card;
}

function buildTaskBoardCard(t) {
  const key = 't:' + t.id;
  const card = el(
    'div',
    { class: 'board-card' + (t.status === 'done' ? ' done-card' : ''), draggable: 'true', 'data-key': key },
    el(
      'div',
      { class: 'board-card-taskrow' },
      taskCheckButton(t),
      el(
        'div',
        { style: 'min-width:0;flex:1' },
        el('div', { class: 'board-card-title' }, t.title),
        t.notes ? el('div', { class: 'card-meta' }, t.notes.length > 90 ? t.notes.slice(0, 90) + '…' : t.notes) : null
      )
    ),
    el('div', { class: 'board-card-meta' }, priorityPill(t), duePill(t), courseChipFor(t), pinnedPill(key)),
    el('div', { class: 'board-card-foot' }, el('span', { class: 'spacer' }), ...moveButtons(key))
  );
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, input, form, a, select')) return;
    openTaskModal(t.id);
  });
  makeCardDraggable(card, key);
  return card;
}

/* ---------- custom columns ---------- */
function editColumnTitleInline(headEl, initial, { commit, cancel }) {
  const h3 = headEl.querySelector('h3');
  if (!h3) return;
  const input = el('input', {
    class: 'col-name-input',
    type: 'text',
    maxlength: '60',
    placeholder: 'Column name…',
    value: initial,
  });
  h3.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (save && name) commit(name.slice(0, 60));
    else cancel();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function addCustomColumn() {
  if (workspace.board.columns.length >= 8) return toast('Up to 8 custom columns are supported.', { error: true });
  const id = 'col_' + uid();
  workspace.board.columns.push({ id, title: 'New column' });
  pendingNewColumnId = id;
  renderBoard();
}

function renameColumn(columnId, headEl) {
  const col = workspace.board.columns.find((item) => item.id === columnId);
  if (!col || !headEl) return;
  editColumnTitleInline(headEl, col.title, {
    commit: (name) => {
      col.title = name;
      scheduleRemoteSave();
      renderBoard();
    },
    cancel: () => renderBoard(),
  });
}

function deleteColumn(columnId) {
  const col = workspace.board.columns.find((item) => item.id === columnId);
  if (!col) return;
  if (!confirm(`Delete column "${col.title}"? Cards on it return to their automatic column.`)) return;
  workspace.board.columns = workspace.board.columns.filter((item) => item.id !== columnId);
  for (const [key, target] of Object.entries(workspace.board.overrides)) {
    if (target === columnId) delete workspace.board.overrides[key];
  }
  delete workspace.board.cardOrder[columnId];
  scheduleRemoteSave();
  renderBoard();
}

/* ---------- sprints ---------- */
function addDays(dateKey, amount) {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + amount);
  return todayKey(d);
}

function addMonths(dateKey, amount) {
  const d = new Date(dateKey + 'T12:00:00');
  d.setMonth(d.getMonth() + amount);
  return todayKey(d);
}

function shortDate(dateKey) {
  return new Date(dateKey + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function generateSprints(cadence, count, startKey) {
  const items = workspace.sprints.items;
  let start = items.length ? addDays(items[items.length - 1].endDate, 1) : startKey;
  for (let i = 0; i < count; i++) {
    const end = cadence === 'month' ? addDays(addMonths(start, 1), -1) : addDays(start, cadence === 'biweek' ? 13 : 6);
    items.push({ id: 'sp_' + uid(), title: `Sprint ${items.length + 1}`, startDate: start, endDate: end });
    start = addDays(end, 1);
  }
  workspace.sprints.cadence = cadence;
}

function openSprintModal() {
  $('#sprintStart').value = todayKey();
  $('#sprintCadence').value = workspace.sprints.cadence;
  $('#sprintClearBtn').classList.toggle('hidden', !workspace.sprints.items.length);
  showModal('sprintModal');
}

/* ---------- tasks ---------- */
function createTask(fields = {}) {
  const id = 'tk_' + uid();
  workspace.tasks[id] = {
    id,
    title: '',
    notes: '',
    status: 'todo',
    priority: 'med',
    dueDate: null,
    courseId: null,
    createdAt: Date.now(),
    completedAt: null,
    ...fields,
  };
  return workspace.tasks[id];
}

function deleteTask(id) {
  delete workspace.tasks[id];
  const key = 't:' + id;
  delete workspace.board.overrides[key];
  delete workspace.sprints.assignments[key];
  for (const list of Object.values(workspace.board.cardOrder)) {
    const at = list.indexOf(key);
    if (at !== -1) list.splice(at, 1);
  }
}

function taskCompare(a, b) {
  const dueA = a.dueDate || '9999-99-99';
  const dueB = b.dueDate || '9999-99-99';
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  }
  return a.createdAt - b.createdAt;
}

function taskCheckButton(t) {
  return el('button', {
    class: 'task-check' + (t.status === 'done' ? ' checked' : ''),
    type: 'button',
    title: t.status === 'done' ? 'Mark as not done' : 'Mark done',
    'aria-label': `Complete ${t.title}`,
    'aria-pressed': String(t.status === 'done'),
    html: I.check,
    onclick: (e) => {
      e.stopPropagation();
      setTaskStatus(t, t.status === 'done' ? 'todo' : 'done');
      scheduleRemoteSave();
      refreshTaskUIs();
    },
  });
}

function priorityPill(t) {
  return el('span', { class: 'pill p-' + t.priority }, PRIORITY_LABEL[t.priority]);
}

function duePill(t) {
  if (!t.dueDate) return null;
  const overdue = t.status !== 'done' && t.dueDate < todayKey();
  return el(
    'span',
    { class: 'pill due' + (overdue ? ' overdue' : '') },
    (overdue ? 'Overdue · ' : 'Due ') + shortDate(t.dueDate)
  );
}

function courseChipFor(t) {
  const c = t.courseId ? courses[t.courseId] : null;
  if (!c) return null;
  return el(
    'button',
    {
      class: 'course-chip',
      type: 'button',
      title: c.title,
      onclick: (e) => {
        e.stopPropagation();
        closeTaskPanel();
        location.hash = '#c=' + c.id;
      },
    },
    c.title
  );
}

/** Re-render every surface that shows tasks/board data. */
function refreshTaskUIs() {
  const focused = document.activeElement;
  const host = focused.closest('#tasksPageList, #taskPanelList');
  const taskId = focused.closest('[data-task-id]')?.dataset.taskId;
  const action = ['task-check', 'task-row-title', 'task-row-del'].find(name => focused.classList.contains(name));
  if (!homeView.classList.contains('hidden')) renderHome();
  if (!tasksView.classList.contains('hidden')) renderTasksPage();
  if (taskPanel.classList.contains('open')) renderTaskPanel();
  if (current?.course && !courseView.classList.contains('hidden')) renderCourseChecklist();
  if (host && taskId && action) (host.querySelector(`[data-task-id="${CSS.escape(taskId)}"] .${action}`) || host.querySelector('.task-row-title') || $(taskPanel.open ? '#quickTaskInput' : '#tasksPageNew')).focus({ preventScroll: true });
}

/* ---------- task editor modal ---------- */
function fillCourseSelect(select, keepValue) {
  const keep = keepValue !== undefined ? keepValue : select.value;
  while (select.options.length > 1) select.remove(1);
  for (const c of Object.values(courses).sort((a, b) => b.addedAt - a.addedAt)) {
    select.append(el('option', { value: c.id }, c.title.slice(0, 80)));
  }
  select.value = keep && courses[keep] ? keep : '';
}

function openTaskModal(taskId = null, defaults = {}) {
  closeTaskPanel();
  editingTaskId = taskId;
  const t = taskId ? workspace.tasks[taskId] : null;
  $('#taskModalTitle').textContent = t ? 'Edit task' : 'New task';
  $('#taskDeleteBtn').classList.toggle('hidden', !t);
  fillCourseSelect($('#taskCourse'), t?.courseId || defaults.courseId || '');
  $('#taskTitle').value = t?.title || defaults.title || '';
  $('#taskNotes').value = t?.notes || '';
  $('#taskDue').value = t?.dueDate || '';
  $('#taskPriority').value = t?.priority || 'med';
  $('#taskStatus').value = t?.status || defaults.status || 'todo';
  showModal('taskModal');
  $('#taskTitle').focus();
}

/* ---------- tasks page ---------- */
function renderTasksPage() {
  fillCourseSelect($('#taskFilterCourse'));
  const wrap = $('#tasksPageList');
  wrap.innerHTML = '';
  const courseFilter = $('#taskFilterCourse').value;
  const priorityFilter = $('#taskFilterPriority').value;
  const all = Object.values(workspace.tasks).filter(
    (t) => (!courseFilter || t.courseId === courseFilter) && (!priorityFilter || t.priority === priorityFilter)
  );
  if (!all.length) {
    wrap.append(
      el('p', { class: 'empty-state' }, 'No tasks yet.')
    );
    return;
  }
  const groups = [
    ['todo', 'To do'],
    ['doing', 'In progress'],
    ['done', 'Done'],
  ];
  for (const [status, label] of groups) {
    const group = all.filter((t) => t.status === status).sort(taskCompare);
    if (!group.length) continue;
    wrap.append(el('div', { class: 'tasks-group-title' }, `${label} · ${group.length}`));
    for (const t of group) wrap.append(buildTaskRow(t));
  }
}

function buildTaskRow(t, { compact = false } = {}) {
  return el(
    'div',
    { class: 'task-row' + (t.status === 'done' ? ' done' : ''), 'data-task-id': t.id, onclick: () => openTaskModal(t.id) },
    taskCheckButton(t),
    el(
      'div',
      { class: 'task-row-main' },
      el('button', { class: 'task-row-title', type: 'button', 'aria-label': `Edit ${t.title}` }, t.title),
      t.notes && !compact ? el('div', { class: 'task-row-notes' }, t.notes) : null,
      el(
        'div',
        { class: 'task-row-meta' },
        priorityPill(t),
        duePill(t),
        courseChipFor(t),
        t.status === 'doing' ? el('span', { class: 'pill p-low' }, 'In progress') : null
      )
    ),
    el('button', {
      class: 'task-row-del',
      type: 'button',
      title: 'Delete task',
      'aria-label': `Delete ${t.title}`,
      html: I.trash,
      onclick: (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${t.title}"?`)) return;
        deleteTask(t.id);
        scheduleRemoteSave();
        refreshTaskUIs();
      },
    })
  );
}

/* ---------- quick task panel ---------- */
function openTaskPanel() {
  if (workspaceNarrowScreen.matches) setWorkspaceCollapsed(true);
  taskPanel.classList.add('open');
  renderTaskPanel();
  if (!taskPanel.open) taskPanel.showModal();
  $('#tasksPanelBtn').setAttribute('aria-expanded', 'true');
  $('#quickTaskInput').focus();
}

function closeTaskPanel() {
  if (taskPanel.open) taskPanel.close();
  taskPanel.classList.remove('open');
  $('#tasksPanelBtn').setAttribute('aria-expanded', 'false');
}

function renderTaskPanel() {
  const wrap = $('#taskPanelList');
  wrap.innerHTML = '';
  const all = Object.values(workspace.tasks);
  if (!all.length) {
    wrap.append(el('p', { class: 'empty-state' }, 'Nothing here yet — add your first task above.'));
    return;
  }
  const open = all.filter((t) => t.status !== 'done').sort(taskCompare);
  const done = all
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, 20);
  if (open.length) wrap.append(el('div', { class: 'panel-group-title' }, `Open · ${open.length}`));
  for (const t of open) wrap.append(buildTaskRow(t, { compact: true }));
  if (done.length) wrap.append(el('div', { class: 'panel-group-title' }, 'Recently done'));
  for (const t of done) wrap.append(buildTaskRow(t, { compact: true }));
}

/* ---------- course checklists ---------- */
function checklistItemEl(courseId, item, rerender) {
  return el(
    'div',
    { class: 'checklist-item' + (item.done ? ' done' : '') },
    el('button', {
      class: 'task-check' + (item.done ? ' checked' : ''),
      type: 'button',
      title: item.done ? 'Mark as not done' : 'Mark done',
      html: I.check,
      onclick: (e) => {
        e.stopPropagation();
        item.done = !item.done;
        scheduleRemoteSave();
        rerender();
      },
    }),
    el('span', {}, item.text),
    el('button', {
      class: 'checklist-del',
      type: 'button',
      title: 'Remove item',
      onclick: (e) => {
        e.stopPropagation();
        const list = workspace.checklists[courseId] || [];
        const at = list.indexOf(item);
        if (at !== -1) list.splice(at, 1);
        if (!list.length) delete workspace.checklists[courseId];
        scheduleRemoteSave();
        rerender();
      },
    }, '✕')
  );
}

function renderCourseChecklist() {
  const c = current?.course;
  if (!c) return;
  const list = workspace.checklists[c.id] || [];
  $('#courseChecklistCount').textContent = list.length
    ? `${list.filter((item) => item.done).length}/${list.length}`
    : '';
  const wrap = $('#courseChecklistItems');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.append(el('p', { class: 'empty-state', style: 'padding:4px 0' }, 'Notes and mini to-dos for this course.'));
  }
  for (const item of list) wrap.append(checklistItemEl(c.id, item, renderCourseChecklist));
}

/* ---------- roadmaps ---------- */
let currentRoadmapId = null;

function roadmapStats(r) {
  let total = 0;
  let done = 0;
  for (const courseId of r.courseIds) {
    const c = courses[courseId];
    if (!c) continue;
    total += c.videos.length;
    done += countDone(c);
  }
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function roadmapNextCourse(r) {
  for (const courseId of r.courseIds) {
    const c = courses[courseId];
    if (c && countDone(c) < c.videos.length) return c;
  }
  return null;
}

function renderRoadmapStrip() {
  const section = $('#roadmapsSection');
  const strip = $('#roadmapStrip');
  const list = Object.values(workspace.roadmaps).sort((a, b) => a.createdAt - b.createdAt);
  const hasCourses = Object.keys(courses).length > 0;
  section.classList.toggle('hidden', !hasCourses && !list.length && location.hash !== '#roadmaps');
  strip.innerHTML = '';
  if (!list.length) {
    strip.append(
      el('p', { class: 'empty-state' }, 'No roadmaps yet.')
    );
    return;
  }
  for (const r of list) {
    const { total, done, pct } = roadmapStats(r);
    const courseCount = r.courseIds.filter((id) => courses[id]).length;
    strip.append(
      el(
        'a',
        { class: 'roadmap-card', href: '#roadmap=' + encodeURIComponent(r.id) },
        el('div', { class: 'roadmap-card-title' }, r.title),
        el('div', { class: 'card-meta' }, `${courseCount} course${courseCount === 1 ? '' : 's'} · ${done} / ${total} videos`),
        el(
          'div',
          { class: 'card-progress' },
          el(
            'div',
            { class: 'progress-track' },
            el('div', { class: 'progress-fill' + (pct === 100 ? ' full' : ''), style: `width:${pct}%` })
          ),
          el('span', { class: 'card-pct' }, pct + '%')
        )
      )
    );
  }
}

function renderRoadmapPage() {
  const r = workspace.roadmaps[currentRoadmapId];
  if (!r) {
    location.hash = '';
    return;
  }
  r.courseIds = r.courseIds.filter((id) => courses[id]); // drop stale references
  document.title = `${r.title} — FocusTube`;
  $('#roadmapTitle').textContent = r.title;
  const { total, done, pct } = roadmapStats(r);
  $('#roadmapMeta').textContent = `${r.courseIds.length} course${r.courseIds.length === 1 ? '' : 's'} · ${nVideos(total)}`;
  $('#roadmapProgressFill').style.width = pct + '%';
  $('#roadmapProgressFill').classList.toggle('full', pct === 100);
  $('#roadmapProgressLabel').textContent = `${done} / ${total} videos · ${pct}%`;
  const next = roadmapNextCourse(r);
  $('#roadmapContinueBtn').disabled = !next;
  $('#roadmapContinueBtn').textContent =
    pct === 100 && total ? 'All complete' : next ? `Continue: ${next.title.slice(0, 28)}${next.title.length > 28 ? '…' : ''}` : 'Continue';

  const wrap = $('#roadmapCourses');
  wrap.innerHTML = '';
  if (!r.courseIds.length) {
    wrap.append(el('p', { class: 'empty-state' }, 'No courses yet — add one below to start the path.'));
  }
  r.courseIds.forEach((courseId, index) => {
    const c = courses[courseId];
    const cDone = countDone(c);
    const cPct = c.videos.length ? Math.round((cDone / c.videos.length) * 100) : 0;
    const thumbId = c.videos[0]?.id;
    const control = (dir, symbol, label) => {
      const target = index + dir;
      return el(
        'button',
        {
          class: 'card-move',
          type: 'button',
          title: label,
          'aria-label': `${label}: ${c.title}`,
          html: icon(symbol),
          disabled: target < 0 || target >= r.courseIds.length ? '' : null,
          onclick: (e) => {
            e.stopPropagation();
            if (target < 0 || target >= r.courseIds.length) return;
            [r.courseIds[index], r.courseIds[target]] = [r.courseIds[target], r.courseIds[index]];
            scheduleRemoteSave();
            renderRoadmapPage();
            $(`[data-roadmap-course="${CSS.escape(c.id)}"] .roadmap-course-main`).focus({ preventScroll: true });
          },
        }
      );
    };
    wrap.append(
      el(
        'div',
        { class: 'roadmap-course' + (cPct === 100 ? ' done' : ''), 'data-roadmap-course': c.id, onclick: () => (location.hash = '#c=' + c.id) },
        el('span', { class: 'roadmap-step' }, cPct === 100 ? '✓' : String(index + 1)),
        thumbId
          ? el('img', {
              class: 'roadmap-course-thumb',
              src: `https://i.ytimg.com/vi/${thumbId}/mqdefault.jpg`,
              alt: '',
              loading: 'lazy',
              onerror: (e) => (e.target.style.display = 'none'),
            })
          : null,
        el(
          'a',
          { class: 'roadmap-course-main', href: '#c=' + encodeURIComponent(c.id) },
          el('div', { class: 'roadmap-course-title' }, c.title),
          el('div', { class: 'card-meta' }, `${cDone} / ${c.videos.length} done`),
          el(
            'div',
            { class: 'card-progress' },
            el(
              'div',
              { class: 'progress-track' },
              el('div', { class: 'progress-fill' + (cPct === 100 ? ' full' : ''), style: `width:${cPct}%` })
            ),
            el('span', { class: 'card-pct' }, cPct + '%')
          )
        ),
        el(
          'div',
          { class: 'roadmap-course-controls' },
          control(-1, 'ChevronUp', 'Move earlier'),
          control(1, 'ChevronDown', 'Move later'),
          el(
            'button',
            {
              class: 'card-move',
              type: 'button',
              title: 'Remove from roadmap (keeps the course)',
              'aria-label': `Remove ${c.title} from roadmap`,
              html: I.close,
              onclick: (e) => {
                e.stopPropagation();
                r.courseIds.splice(index, 1);
                scheduleRemoteSave();
                renderRoadmapPage();
                ($('#roadmapCourses .roadmap-course-main') || $('#roadmapAddSelect')).focus({ preventScroll: true });
              },
            }
          )
        )
      )
    );
  });

  const select = $('#roadmapAddSelect');
  while (select.options.length > 1) select.remove(1);
  for (const c of Object.values(courses).sort((a, b) => b.addedAt - a.addedAt)) {
    if (!r.courseIds.includes(c.id)) select.append(el('option', { value: c.id }, c.title.slice(0, 80)));
  }
  select.value = '';
  select.parentElement.classList.toggle('hidden', select.options.length === 1);
}

function openRoadmapModal() {
  const pick = $('#roadmapCoursePick');
  pick.innerHTML = '';
  const all = Object.values(courses).sort((a, b) => b.addedAt - a.addedAt);
  if (!all.length) {
    pick.append(el('p', { class: 'empty-state' }, 'Add a course first — roadmaps are built from your courses.'));
  }
  for (const c of all) {
    pick.append(
      el(
        'label',
        { class: 'roadmap-pick-row' },
        el('input', { type: 'checkbox', value: c.id }),
        el('span', {}, c.title)
      )
    );
  }
  $('#roadmapName').value = '';
  showModal('roadmapModal');
  $('#roadmapName').focus();
}

function inlineRenameRoadmap() {
  const r = workspace.roadmaps[currentRoadmapId];
  const heading = $('#roadmapTitle');
  if (!r || heading.classList.contains('hidden')) return;
  const input = el('input', {
    class: 'col-name-input roadmap-name-input',
    type: 'text',
    maxlength: '80',
    value: r.title,
  });
  heading.classList.add('hidden');
  heading.before(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    input.remove();
    heading.classList.remove('hidden');
    if (save && name) {
      r.title = name.slice(0, 80);
      scheduleRemoteSave();
    }
    renderRoadmapPage();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ================= YouTube player ================= */
let ytApiPromise = null;
function loadYTApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('Could not load the YouTube player — are you online?'));
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

let playerPromise = null;

function createPlayer(host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Player handshake timed out'));
      }
    }, 7000);
    const instance = new YT.Player('ytFrame', {
      host,
      width: '100%',
      height: '100%',
      playerVars: {
        controls: 0,
        rel: 0,
        modestbranding: 1,
        iv_load_policy: 3,
        disablekb: 1,
        playsinline: 1,
        fs: 0,
        origin: location.origin,
      },
      events: {
        onReady: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          player = instance;
          playerReady = true;
          safe(() => instance.setVolume(volume));
          resolve(instance);
        },
        onStateChange: onPlayerState,
        onError: onPlayerError,
        onPlaybackQualityChange: () => populateQuality(),
        onPlaybackRateChange: (e) => {
          const r = e?.data;
          if (r) speedSel.value = String(r);
        },
      },
    });
    player = instance;
  });
}

function remountFrame() {
  document.querySelector('#ytWrap iframe')?.remove();
  document.querySelector('#ytFrame')?.remove();
  const wrap = document.querySelector('#ytWrap');
  const div = document.createElement('div');
  div.id = 'ytFrame';
  wrap.insertBefore(div, wrap.firstChild);
}

function ensurePlayer() {
  if (playerPromise) return playerPromise;
  playerPromise = loadYTApi().then(() =>
    // Privacy-friendly host first; its API handshake is occasionally flaky,
    // so fall back to the standard embed host if it never becomes ready.
    createPlayer('https://www.youtube-nocookie.com').catch(() => {
      safe(() => player.destroy());
      playerReady = false;
      remountFrame();
      return createPlayer('https://www.youtube.com');
    })
  );
  return playerPromise;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function curVideo() {
  return current ? current.course.videos[current.index] : null;
}

function hideOverlays() {
  posterOverlay.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  endedOverlay.classList.add('hidden');
  errorOverlay.classList.add('hidden');
  clearInterval(endedTimer);
}

function showPauseCover() {
  pauseOverlay.classList.remove('hidden');
}

function overlaysAllHidden() {
  return [posterOverlay, pauseOverlay, endedOverlay, errorOverlay].every((o) =>
    o.classList.contains('hidden')
  );
}

function onPlayerState(e) {
  if (!current) return;
  syncPlayerControls(e.data);
  const S = YT.PlayerState;
  if (e.data === S.PLAYING) {
    hideOverlays();
    playBtn.innerHTML = I.pause;
    endedHandled = false;
    applyCaptions();
    populateQuality();
    applyQuality();
  } else if (e.data === S.PAUSED) {
    playBtn.innerHTML = I.play;
    if (overlaysAllHidden()) showPauseCover();
  } else if (e.data === S.ENDED) {
    playBtn.innerHTML = I.play;
    if (!endedHandled) {
      endedHandled = true;
      onVideoEnded();
    }
  } else if (e.data === S.CUED) {
    playBtn.innerHTML = I.play;
    const v = curVideo();
    if (v && overlaysAllHidden()) {
      posterTitle.textContent = v.title;
      posterOverlay.classList.remove('hidden');
    }
  }
}

function onPlayerError() {
  const v = curVideo();
  if (!v) return;
  hideOverlays();
  errorLink.href = `https://www.youtube.com/watch?v=${v.id}&list=${current.course.id}`;
  errorOverlay.classList.remove('hidden');
}

let pendingLoad = null;

function playVideo(i, { cue = false, startSeconds } = {}) {
  const c = current?.course;
  if (!c || i < 0 || i >= c.videos.length) return;
  const v = c.videos[i];
  resetPlayerControls();
  current.index = i;
  completedAutoGuard = !!c.completed[v.id];
  endedHandled = false;
  unstartedTicks = 0;
  c.lastVideoId = v.id;
  saveCourses();
  hideOverlays();

  if (playerReady) {
    const saved = Math.floor(c.positions[v.id] || 0);
    const explicit = NotebookModel.hasTime(startSeconds);
    const startAt = explicit ? Math.min(startSeconds, v.durationSeconds > 0 ? Math.max(0, v.durationSeconds - 0.1) : startSeconds)
      : saved > 8 && saved < (v.durationSeconds || Infinity) - 20 ? saved - 3 : 0;
    if (explicit && !cue && safe(() => player.getVideoData()?.video_id) === v.id) {
      safe(() => player.seekTo(startAt, true));
      safe(() => player.playVideo());
    } else if (cue) safe(() => player.cueVideoById({ videoId: v.id, startSeconds: startAt }));
    else safe(() => player.loadVideoById({ videoId: v.id, startSeconds: startAt }));
    safe(() => player.setPlaybackRate(c.speed || 1));
    pendingLoad = null;
  } else {
    pendingLoad = { courseId: c.id, videoId: v.id, cue, startSeconds, generation: sessionGeneration };
  }
  if (cue || !playerReady) {
    posterTitle.textContent = v.title;
    posterOverlay.classList.remove('hidden');
  }
  speedSel.value = String(c.speed || 1);

  updateNowPlaying();
  notebooks?.showVideo(c.id, v.id);
  loadVideoExtras(v.id);
  syncCourseUI();
  rowEls[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function nextIndex() {
  const c = current?.course;
  if (!c) return -1;
  return current.index + 1 < c.videos.length ? current.index + 1 : -1;
}

function onVideoEnded() {
  const c = current.course;
  const v = curVideo();
  c.positions[v.id] = 0; // replay starts fresh
  markComplete(v.id, { celebrate: !completedAutoGuard });
  completedAutoGuard = true;

  hideOverlays();
  const ni = nextIndex();
  const allDone = c.videos.every((x) => c.completed[x.id]);

  endedNext.classList.toggle('hidden', ni === -1);
  endedCancel.classList.toggle('hidden', ni === -1);
  endedCert.classList.toggle('hidden', !allDone);
  endedCountdown.classList.add('hidden');
  endedTitle.textContent = allDone ? 'Course complete' : 'Video complete';

  if (ni !== -1 && !allDone) {
    let secs = 5;
    endedCountdown.classList.remove('hidden');
    endedCountdown.textContent = `Next video in ${secs}s…`;
    endedTimer = setInterval(() => {
      secs--;
      if (secs <= 0) {
        clearInterval(endedTimer);
        playVideo(ni);
        return;
      }
      endedCountdown.textContent = `Next video in ${secs}s…`;
    }, 1000);
  }
  endedOverlay.classList.remove('hidden');
}

/* ================= completion ================= */
function countDone(c) {
  return c.videos.filter((v) => c.completed[v.id]).length;
}

function markComplete(videoId, { celebrate = true } = {}) {
  const c = current?.course;
  if (!c || c.completed[videoId]) return;
  c.completed[videoId] = new Date().toISOString();
  const video = c.videos.find((item) => item.id === videoId);
  queueCompletion(c, video, c.completed[videoId]);
  saveCourses();
  syncCourseUI();

  const done = countDone(c);
  const allDone = done === c.videos.length;
  if (celebrate && !allDone) {
    smallBurst();
    toast(`Nice! ${done} / ${c.videos.length} videos done ✅`);
  }
  if (allDone && !c.completedAt) {
    c.completedAt = new Date().toISOString();
    saveCourses();
    bigCelebration();
    const openLinked = Object.values(workspace.tasks).filter(
      (t) => t.courseId === c.id && t.status !== 'done'
    ).length;
    if (openLinked) toast(`This course still has ${openLinked} open task${openLinked === 1 ? '' : 's'} — check ✓ Tasks.`);
    setTimeout(openCertModal, 900);
  }
}

function toggleComplete(videoId) {
  const c = current?.course;
  if (!c) return;
  if (c.completed[videoId]) {
    delete c.completed[videoId];
    queueCompletion(c, c.videos.find((item) => item.id === videoId), null);
    saveCourses();
    syncCourseUI();
  } else {
    markComplete(videoId);
  }
}

/* ================= course view rendering ================= */
function renderSidebar(c) {
  sideTitle.textContent = c.title;
  $('#courseHeading').textContent = c.title;
  $('#courseHeading').title = c.title;
  const total = c.videos.reduce((a, v) => a + (v.durationSeconds || 0), 0);
  $('#courseDuration').textContent = fmtLong(total);
  $('#courseDuration').setAttribute('aria-label', `Total course duration: ${fmtLong(total)}`);
  sideMeta.textContent = `${c.author || 'YouTube'} · ${nVideos(c.videos.length)} · ${fmtLong(total)}`;

  videoListEl.innerHTML = '';
  rowEls = [];
  c.videos.forEach((v, i) => {
    const row = el(
      'li',
      { class: 'video-row' },
      el(
        'button',
        { class: 'lesson-open', type: 'button', onclick: () => playVideo(i) },
        el('span', { class: 'lesson-number', 'aria-hidden': 'true' }, String(i + 1)),
        el('span', { class: 'row-main' },
          el('span', { class: 'row-title' }, v.title),
          el('span', { class: 'row-sub' }, fmtDuration(v.durationSeconds))
        )
      ),
      el('button', {
        class: 'check',
        type: 'button',
        title: 'Toggle complete',
        html: I.check,
        onclick: (e) => {
          e.stopPropagation();
          toggleComplete(v.id);
        },
      })
    );
    videoListEl.append(row);
    rowEls.push(row);
  });
  syncCourseUI();
}

function syncCourseUI() {
  const c = current?.course;
  if (!c) return;
  const done = countDone(c);
  const pct = c.videos.length ? Math.round((done / c.videos.length) * 100) : 0;

  c.videos.forEach((v, i) => {
    const row = rowEls[i];
    if (!row) return;
    row.classList.toggle('done', !!c.completed[v.id]);
    row.classList.toggle('active', i === current.index);
    const lesson = row.querySelector('.lesson-open');
    const completed = !!c.completed[v.id];
    const label = `Lesson ${i + 1}: ${v.title} - ${fmtDuration(v.durationSeconds)} - ${completed ? 'Completed' : 'Not completed'}`;
    lesson.setAttribute('aria-label', label);
    lesson.title = label;
    if (i === current.index) lesson.setAttribute('aria-current', 'step');
    else lesson.removeAttribute('aria-current');
    const check = row.querySelector('.check');
    check.setAttribute('aria-pressed', String(completed));
    check.setAttribute('aria-label', `Mark lesson ${i + 1} ${completed ? 'incomplete' : 'complete'}`);
  });

  sideProgressFill.style.width = pct + '%';
  sideProgressFill.classList.toggle('full', pct === 100);
  const remaining = c.videos.filter((v) => !c.completed[v.id]).reduce((a, v) => a + (v.durationSeconds || 0), 0);
  sideProgressLabel.innerHTML = `<span>${done} / ${c.videos.length} completed</span><span>${
    pct === 100 ? 'Complete' : fmtLong(remaining) + ' left'
  }</span>`;

  certBtn.disabled = pct !== 100;
  certBtn.replaceChildren(el('span', { html: I.trophy }), document.createTextNode(pct === 100 ? 'Get your certificate' : 'Certificate locked'));

  const v = curVideo();
  if (v) {
    const isDone = !!c.completed[v.id];
    npComplete.replaceChildren(el('span', { html: I.check }), document.createTextNode(isDone ? 'Completed' : 'Mark complete'));
    npComplete.classList.toggle('done', isDone);
  }

  prevBtn.disabled = current.index === 0;
  nextBtn.disabled = current.index >= c.videos.length - 1;
  renderStreakChip();
}

function updateNowPlaying() {
  const c = current?.course;
  const v = curVideo();
  if (!c || !v) return;
  npTitle.textContent = v.title;
  npMeta.textContent = `Video ${current.index + 1} of ${c.videos.length} · ${fmtDuration(
    v.durationSeconds
  )}${c.author ? ' · ' + c.author : ''}`;
  document.title = `${v.title} — FocusTube`;
}

/* ================= dashboard ================= */
let dailyChart = null;
let courseChart = null;
let historyPage = 1;
let historyItems = [];

function dateLabel(date) {
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function destroyCharts() {
  dailyChart?.destroy();
  courseChart?.destroy();
  dailyChart = null;
  courseChart = null;
}

function updateDashboardChartTheme() {
  if (!dailyChart && !courseChart) return;
  const styles = getComputedStyle(document.documentElement);
  const color = name => styles.getPropertyValue('--' + name).trim();
  if (dailyChart) {
    dailyChart.data.datasets[0].backgroundColor = color('green');
    dailyChart.data.datasets[1].backgroundColor = color('blue');
    for (const scale of Object.values(dailyChart.options.scales)) {
      scale.ticks.color = color('muted');
      scale.grid.color = color('line');
      scale.border.color = color('line');
      scale.title.color = color('muted');
    }
  }
  if (courseChart) {
    courseChart.data.datasets[0].backgroundColor = ['teal', 'blue', 'olive', 'coral', 'amber', 'green', 'muted'].map(color);
    courseChart.data.datasets[0].borderColor = color('bg');
  }
  for (const chart of [dailyChart, courseChart]) {
    if (!chart) continue;
    chart.options.plugins.legend.labels.color = color('muted');
    chart.update('none');
  }
}

document.addEventListener('themechange', updateDashboardChartTheme);

function renderChartData(id, caption, headings, rows) {
  const table = el('table', {}, el('caption', { class: 'sr-only' }, caption),
    el('thead', {}, el('tr', {}, ...headings.map(heading => el('th', { scope: 'col' }, heading)))),
    el('tbody', {}, ...(rows.length ? rows.map(row => el('tr', {}, ...row.map(value => el('td', {}, String(value))))) :
      [el('tr', {}, el('td', { colspan: String(headings.length) }, 'No activity recorded.'))])));
  $('#' + id).replaceChildren(table);
}

function renderDashboardCharts(daily, split) {
  destroyCharts();
  renderChartData('dailyChartData', 'Daily activity in minutes', ['Date', 'On FocusTube', 'Watching video'],
    daily.map(row => [row.date, Math.round(row.activeSeconds / 60), Math.round(row.watchSeconds / 60)]));
  renderChartData('courseChartData', 'Watch time by course', ['Course', 'Minutes'],
    split.map(row => [row.courseTitle, Math.round(row.seconds / 60)]));
  if (!window.Chart) {
    $('.chart-wrap').textContent = 'The chart could not load. Activity data is available below.';
    return;
  }
  Chart.defaults.font.family = 'IBM Plex Sans';
  const common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { labels: { usePointStyle: true, pointStyle: 'circle' } } },
  };
  dailyChart = new Chart($('#dailyChart'), {
    type: 'bar',
    data: {
      labels: daily.map((row) => dateLabel(row.date)),
      datasets: [
        {
          label: 'On FocusTube',
          data: daily.map((row) => Math.round(row.activeSeconds / 60)),
          borderRadius: 3,
        },
        {
          label: 'Watching video',
          data: daily.map((row) => Math.round(row.watchSeconds / 60)),
          borderRadius: 3,
        },
      ],
    },
    options: {
      ...common,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: false, grid: { display: false }, ticks: { maxTicksLimit: 12 } },
        y: { beginAtZero: true, title: { display: true, text: 'minutes' } },
      },
    },
  });
  courseChart = new Chart($('#courseChart'), {
    type: 'doughnut',
    data: {
      labels: split.map((row) => row.courseTitle),
      datasets: [{ data: split.map((row) => Math.round(row.seconds / 60)), borderWidth: 3 }],
    },
    options: {
      ...common,
      cutout: '66%',
      plugins: {
        ...common.plugins,
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } },
      },
    },
  });
  updateDashboardChartTheme();
}

function renderDashboardHeatmap(daily) {
  const target = $('#dashboardHeatmap');
  target.innerHTML = '';
  const rows = [];
  const map = new Map(daily.map((row) => [row.date, row.activeSeconds]));
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 7 * 19);
  for (let i = 0; i < 140; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = todayKey(date);
    const mins = Number(map.get(key) || 0) / 60;
    if (date <= today) rows.push([key, Math.round(mins)]);
    const level = mins >= 60 ? 4 : mins >= 30 ? 3 : mins >= 10 ? 2 : mins >= 1 ? 1 : 0;
    target.append(
      el('i', {
        class: `hm-cell l${level}${date > today ? ' future' : ''}`,
        title: `${key} — ${Math.round(mins)} min`,
      })
    );
  }
  renderChartData('heatmapData', 'Daily activity over the last 20 weeks', ['Date', 'Minutes'], rows.reverse());
}

function renderDashboardCourses() {
  const target = $('#dashboardCourses');
  target.innerHTML = '';
  const list = Object.values(courses);
  const finished = list.filter((course) => course.videos?.length && course.videos.every((v) => course.completed?.[v.id])).length;
  $('#courseProgressSummary').textContent = `${finished} of ${list.length} complete`;
  if (!list.length) {
    target.append(el('div', { class: 'empty-state' }, 'Add a playlist or video to start tracking progress.'));
    return;
  }
  for (const course of list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))) {
    const done = course.videos.filter((v) => course.completed?.[v.id]).length;
    const pct = Math.round((done / course.videos.length) * 100);
    target.append(
      el(
        'a',
        { class: 'dashboard-course', href: '#c=' + encodeURIComponent(course.id) },
        el(
          'div',
          { class: 'dashboard-course-head' },
          el('strong', {}, course.title),
          el('span', {}, `${done}/${course.videos.length} · ${pct}%`)
        ),
        el('div', { class: 'progress-track' }, el('div', { class: `progress-fill${pct === 100 ? ' full' : ''}`, style: `width:${pct}%` }))
      )
    );
  }
}

function renderHistory() {
  const target = $('#historyList');
  target.innerHTML = '';
  if (!historyItems.length) {
    target.append(el('div', { class: 'empty-state' }, 'Watch a video and your day-by-day history will appear here.'));
    return;
  }
  const groups = new Map();
  for (const item of historyItems) {
    if (!groups.has(item.date)) groups.set(item.date, []);
    groups.get(item.date).push(item);
  }
  for (const [date, items] of groups) {
    const rows = el('div', { class: 'history-items' });
    for (const item of items) {
      rows.append(
        el(
          'div',
          { class: 'history-item' },
          el(
            'div',
            {},
            el('div', { class: 'history-title' }, item.videoTitle),
            el('div', { class: 'history-course' }, item.courseTitle)
          ),
          el(
            'div',
            { class: 'history-time' },
            fmtLong(item.seconds),
            item.completedAt ? el('span', { class: 'complete' }, '✓') : null
          )
        )
      );
    }
    target.append(el('div', { class: 'history-day' }, el('div', { class: 'history-date' }, new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })), rows));
  }
}

async function loadHistory({ reset = false } = {}) {
  if (reset) {
    historyPage = 1;
    historyItems = [];
  }
  const result = await api(`/api/stats/history?page=${historyPage}`);
  historyItems.push(...result.items);
  $('#historyMore').classList.toggle('hidden', result.items.length < 50);
  renderHistory();
}

async function loadDashboard() {
  $('#dashboardLoading').classList.remove('hidden');
  $('#dashboardLoading').textContent = 'Loading your history…';
  $('#dashboardContent').classList.add('hidden');
  let failed = false;
  try {
    await flushActivity();
    await persistRemoteData();
    const range = $('#dashboardRange').value;
    const chartDays = range === 'all' ? 365 : Number(range);
    const dailyDays = Math.max(140, chartDays);
    const localToday = encodeURIComponent(todayKey());
    const [summary, dailyResult, splitResult] = await Promise.all([
      api(`/api/stats/summary?today=${localToday}`),
      api(`/api/stats/daily?days=${dailyDays}&today=${localToday}`),
      api(`/api/stats/courses?days=${range}&today=${localToday}`),
    ]);
    $('#dashSiteTime').textContent = fmtLong(summary.siteSeconds);
    $('#dashWatchTime').textContent = fmtLong(summary.watchSeconds);
    $('#dashStreak').textContent = summary.streak.current;
    $('#dashBest').textContent = summary.streak.best;
    $('#dashVideos').textContent = summary.videosCompleted;
    $('#dashCourses').textContent = `${summary.completedCourses}/${summary.totalCourses}`;
    $('#dashboardContent').classList.remove('hidden');
    renderDashboardCharts(dailyResult.days.slice(-chartDays), splitResult.courses);
    renderDashboardHeatmap(dailyResult.days);
    renderDashboardCourses();
    await loadHistory({ reset: true });
  } catch (err) {
    failed = true;
    $('#dashboardLoading').textContent = err.message;
    return;
  } finally {
    $('#dashboardLoading').classList.toggle('hidden', !failed);
  }
}

function showDashboard() {
  notebooks?.leave();
  current = null;
  safe(() => player?.stopVideo());
  homeView.classList.add('hidden');
  setCourseViewVisible(false);
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  document.title = 'Learning dashboard — FocusTube';
  loadDashboard();
}

function showTasks() {
  notebooks?.leave();
  current = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  homeView.classList.add('hidden');
  setCourseViewVisible(false);
  dashboardView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  tasksView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  document.title = 'Tasks — FocusTube';
  renderTasksPage();
}

function showRoadmap(id) {
  notebooks?.leave();
  current = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  homeView.classList.add('hidden');
  setCourseViewVisible(false);
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  currentRoadmapId = id;
  renderRoadmapPage();
}

/* ================= view switching ================= */
function showHome() {
  notebooks?.leave();
  current = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  setCourseViewVisible(false);
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  homeView.classList.remove('hidden');
  backBtn.classList.add('hidden');
  sideToggle.classList.add('hidden');
  document.title = 'FocusTube — distraction-free courses';
  renderHome();
  renderStreakChip();
}

function setCourseViewVisible(visible) {
  courseView.classList.toggle('hidden', !visible);
  syncWorkspaceSidebar();
}

function syncCourseContent() {
  const overlay = !courseView.classList.contains('hidden') && window.innerWidth <= 1200 && !document.body.classList.contains('side-collapsed');
  $('#courseContentBackdrop').classList.toggle('hidden', !overlay);
  $('#courseView .stage').inert = overlay;
}

function courseLayout(courseId) {
  if (!Object.hasOwn(courseLayouts, courseId)) {
    const saved = DB.load(`ft_course_layout_${authUser.id}_${courseId}`, null);
    courseLayouts[courseId] = { contentCollapsed: saved?.contentCollapsed !== false, notesOpen: saved?.notesOpen === true };
  }
  return courseLayouts[courseId];
}

function saveCourseLayout(change) {
  if (!authUser || !current?.course) return;
  const courseId = current.course.id;
  const layout = courseLayout(courseId);
  Object.assign(layout, change);
  try { DB.save(`ft_course_layout_${authUser.id}_${courseId}`, layout); } catch {}
}

function setPlaylistCollapsed(collapsed, { remember = true } = {}) {
  const restoreFocus = collapsed && $('#sidebar').contains(document.activeElement);
  document.body.classList.toggle('side-collapsed', collapsed);
  sideToggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show course content' : 'Hide course content';
  sideToggle.setAttribute('aria-label', label);
  sideToggle.title = label;
  syncCourseContent();
  if (remember) saveCourseLayout({ contentCollapsed: collapsed });
  if (restoreFocus) sideToggle.focus({ preventScroll: true });
}

async function openCourse(id, { videoId, startSeconds } = {}) {
  const courseChanged = current?.course.id !== id;
  notebooks?.leave();
  const c = courses[id];
  if (!c) return showHome();
  current = { course: c, index: 0 };
  homeView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  if (courseChanged) {
    const layout = courseLayout(id);
    setPlaylistCollapsed(layout.contentCollapsed, { remember: false });
    notebooks.setPanelOpen(layout.notesOpen);
  }
  setCourseViewVisible(true);
  backBtn.classList.add('hidden');
  sideToggle.classList.remove('hidden');
  renderSidebar(c);
  renderCourseChecklist();
  let idx = c.videos.findIndex((v) => v.id === (videoId || c.lastVideoId));
  if (idx === -1) idx = c.videos.findIndex((v) => !c.completed[v.id]);
  playVideo(Math.max(0, idx), { cue: !NotebookModel.hasTime(startSeconds), startSeconds });
  // Auto-refresh: quietly pull newly added playlist videos (at most once a minute).
  if (!c.lastSyncedAt || Date.now() - c.lastSyncedAt > 60_000) syncCourse({ silent: true });
  ensurePlayer()
    .then(() => {
      if (pendingLoad && current?.course === c && pendingLoad.courseId === c.id && pendingLoad.generation === sessionGeneration) {
        const intent = pendingLoad;
        pendingLoad = null;
        playVideo(c.videos.findIndex(video => video.id === intent.videoId), { cue: intent.cue, startSeconds: intent.startSeconds });
      }
    })
    .catch(() => toast('Video player failed to load — check your connection and reload.', { error: true }));
}

function jumpToNote(courseId, videoId, seconds) {
  const course = courses[courseId];
  if (!course?.videos.some(video => video.id === videoId)) {
    const url = NotebookModel.sourceUrl(videoId, seconds);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const params = new URLSearchParams({ c: courseId, v: videoId, t: String(seconds) });
  const hash = '#' + params.toString();
  if (location.hash === hash) route();
  else location.hash = hash;
}

function showNotebooks(courseId, videoId) {
  notebooks.leave();
  current = null;
  pendingLoad = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  for (const view of [homeView, courseView, dashboardView, tasksView, roadmapView]) view.classList.add('hidden');
  syncWorkspaceSidebar();
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  document.title = 'Notebooks - FocusTube';
  notebooks.show(courseId, videoId);
}

function syncWorkspaceSidebar() {
  const courseActive = !$('#courseView').classList.contains('hidden');
  const collapsed = courseActive ? courseToolsCollapsePreference : typeof workspaceCollapsePreference === 'boolean' ? workspaceCollapsePreference : workspaceNarrowScreen.matches;
  document.body.classList.toggle('workspace-collapsed', collapsed);
  const toggle = $('#workspaceToggle');
  const name = courseActive ? 'course tools' : 'workspace sidebar';
  const label = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('aria-controls', courseActive ? 'courseNavigation' : 'workspaceNavigation');
  toggle.title = label;
  toggle.innerHTML = icon(collapsed ? 'PanelLeftOpen' : 'PanelLeftClose');
  $('#workspaceRail').setAttribute('aria-label', courseActive ? 'Course tools' : 'Workspace');
  $('#workspaceBackdrop').setAttribute('aria-label', `Close ${name}`);
  const overlay = !!authUser && workspaceNarrowScreen.matches && !collapsed;
  $('#workspaceBackdrop').classList.toggle('hidden', !overlay);
  document.body.classList.toggle('workspace-drawer-open', overlay);
  document.querySelectorAll('#topbar, main.view').forEach(element => { element.inert = overlay; });
  if (overlay && !$('#workspaceRail').contains(document.activeElement)) toggle.focus({ preventScroll: true });
  $('#workspaceTooltip').classList.add('hidden');
  syncCourseContent();
}

function setWorkspaceCollapsed(collapsed) {
  if (!$('#courseView').classList.contains('hidden')) {
    courseToolsCollapsePreference = collapsed;
    if (authUser) { try { DB.save(`ft_course_tools_${authUser.id}`, collapsed); } catch {} }
  } else {
    workspaceCollapsePreference = collapsed;
    try { DB.save('ft_workspace_collapsed', collapsed); } catch {}
  }
  syncWorkspaceSidebar();
}

function setupWorkspaceSidebar() {
  const rail = $('#workspaceRail');
  const toggle = $('#workspaceToggle');
  const tooltip = $('#workspaceTooltip');
  let tooltipTarget = null;
  const hideTooltip = () => {
    tooltip.classList.add('hidden');
    tooltipTarget?.removeAttribute('aria-describedby');
    tooltipTarget = null;
  };
  const showTooltip = event => {
    const target = event.target.closest('.workspace-link, #workspaceToggle');
    if (!target || !document.body.classList.contains('workspace-collapsed')) return;
    hideTooltip();
    tooltipTarget = target;
    tooltip.textContent = target.getAttribute('aria-label') || target.title;
    tooltip.classList.remove('hidden');
    target.setAttribute('aria-describedby', 'workspaceTooltip');
    const bounds = target.getBoundingClientRect();
    tooltip.style.left = `${rail.getBoundingClientRect().right + 8}px`;
    tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - tooltip.offsetHeight - 8, bounds.top + (bounds.height - tooltip.offsetHeight) / 2))}px`;
  };
  const collapseDrawer = () => {
    hideTooltip();
    setWorkspaceCollapsed(true);
    toggle.focus({ preventScroll: true });
  };
  toggle.addEventListener('click', () => {
    hideTooltip();
    setWorkspaceCollapsed(!document.body.classList.contains('workspace-collapsed'));
  });
  $('#workspaceBackdrop').addEventListener('click', collapseDrawer);
  workspaceNarrowScreen.addEventListener('change', () => {
    hideTooltip();
    syncWorkspaceSidebar();
    if (document.body.classList.contains('workspace-drawer-open')) toggle.focus({ preventScroll: true });
  });
  rail.addEventListener('pointerover', showTooltip);
  rail.addEventListener('focusin', showTooltip);
  rail.addEventListener('pointerout', event => { if (!tooltipTarget?.contains(event.relatedTarget)) hideTooltip(); });
  rail.addEventListener('focusout', hideTooltip);
  rail.addEventListener('scroll', hideTooltip);
  window.addEventListener('resize', () => { hideTooltip(); syncWorkspaceSidebar(); });
  rail.addEventListener('click', event => {
    if (event.target.closest('a.workspace-link, #sideToggle, #courseNotesToggle') && workspaceNarrowScreen.matches && document.body.classList.contains('workspace-drawer-open')) collapseDrawer();
    if (event.target.closest('#sideToggle') && !document.body.classList.contains('side-collapsed') && window.innerWidth <= 1200) $('#courseContentClose').focus({ preventScroll: true });
    if (event.target.closest('#courseNotesToggle') && $('#courseNotesHost').open) {
      if (window.innerWidth <= 1200) setPlaylistCollapsed(true, { remember: false });
      if ($('#studyLayout').clientWidth <= 760) $('#courseNotesHost').scrollIntoView({ block: 'start' });
    }
  });
  rail.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideTooltip();
      if (document.body.classList.contains('workspace-drawer-open')) {
        event.preventDefault();
        event.stopPropagation();
        collapseDrawer();
      }
    }
    if (event.key !== 'Tab' || !document.body.classList.contains('workspace-drawer-open')) return;
    const controls = [...rail.querySelectorAll('button:not(:disabled), a[href]')].filter(element => element.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  syncWorkspaceSidebar();
}

function updateWorkspaceNav() {
  const hash = location.hash;
  const section = hash.startsWith('#notebook') ? 'notebooks' : hash.startsWith('#roadmap') ? 'roadmaps' : hash === '#tasks' ? 'tasks' : hash === '#dashboard' ? 'dashboard' : 'library';
  const labels = { library: 'Library', roadmaps: 'Roadmaps', notebooks: 'Notebooks', tasks: 'Tasks', dashboard: 'Dashboard' };
  $('#workspaceContext').textContent = labels[section];
  document.body.classList.toggle('roadmaps-open', hash === '#roadmaps');
  document.querySelectorAll('.workspace-link[data-section]').forEach(link => {
    const selected = link.dataset.section === section;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function route() {
  if (!appBooted) return;
  if (notebooks?.editor.composing) {
    notebooks.pendingBinding = () => route();
    return;
  }
  resetPlayerControls();
  updateWorkspaceNav();
  if (location.hash === '#roadmaps') return showHome();
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash === '#notebooks') return showNotebooks(null);
  if (NotebookModel.validId(params.get('notebook'))) return showNotebooks(params.get('notebook'), params.get('v') || '');
  if (location.hash === '#dashboard') return showDashboard();
  if (location.hash === '#tasks') return showTasks();
  const rm = location.hash.match(/^#roadmap=(.+)$/);
  if (rm && workspace.roadmaps[rm[1]]) return showRoadmap(rm[1]);
  const courseId = params.get('c');
  if (courseId && Object.hasOwn(courses, courseId)) {
    const videoId = params.get('v');
    if (videoId && !courses[courseId].videos.some(video => video.id === videoId)) {
      jumpToNote(courseId, videoId, Number(params.get('t')));
      return showNotebooks(courseId);
    }
    const startSeconds = params.has('t') && /^\d+$/.test(params.get('t')) ? Number(params.get('t')) : undefined;
    openCourse(courseId, { videoId, startSeconds });
  }
  else showHome();
}

/* ================= playback tick ================= */
setInterval(() => {
  if (!player || !playerReady || !current) return;
  const v = curVideo();
  if (!v) return;
  const state = safe(() => player.getPlayerState());
  const dur = safe(() => player.getDuration()) || v.durationSeconds || 0;
  const t = safe(() => player.getCurrentTime()) || 0;

  if (!seeking && dur > 0) {
    const pct = Math.min(1000, Math.round((t / dur) * 1000));
    seekBar.value = pct;
    seekBar.style.setProperty('--fill', pct / 10 + '%');
    curTime.textContent = fmtDuration(t);
    durTime.textContent = '-' + fmtDuration(dur - t);
  }

  // current chapter tracking
  if (videoExtras.videoId === v.id && videoExtras.chapters.length) {
    let ci = -1;
    for (let i = 0; i < videoExtras.chapters.length; i++) {
      if (t >= videoExtras.chapters[i].start) ci = i;
      else break;
    }
    if (ci !== lastChapterIdx) {
      lastChapterIdx = ci;
      npChapter.textContent = ci >= 0 ? videoExtras.chapters[ci].title : '';
      chapterRowEls.forEach((r, i) => r.classList.toggle('active', i === ci));
    }
  }

  if (state === YT.PlayerState.PLAYING) {
    addWatchSeconds(0.5);
    current.course.positions[v.id] = t;
    if (++persistCounter % 10 === 0) {
      saveCourses();
      saveStats();
    }
    // safety net: mark complete if user scrubbed to the very end
    if (!completedAutoGuard && dur > 0 && t / dur >= 0.99) {
      completedAutoGuard = true;
      markComplete(v.id);
    }
  }

  syncPlayerControls(state);
  const S = YT.PlayerState;
  if (state === S.PLAYING || state === S.BUFFERING) {
    unstartedTicks = 0;
    posterOverlay.classList.add('hidden');
    pauseOverlay.classList.add('hidden');
  } else if (state === S.PAUSED) {
    unstartedTicks = 0;
    if (overlaysAllHidden()) showPauseCover();
  } else if (state === S.CUED) {
    if (overlaysAllHidden()) {
      posterTitle.textContent = v.title;
      posterOverlay.classList.remove('hidden');
    }
  } else if (state === -1 /* unstarted, e.g. blocked autoplay */) {
    if (++unstartedTicks >= 3 && overlaysAllHidden()) {
      posterTitle.textContent = v.title;
      posterOverlay.classList.remove('hidden');
    }
  } else if (state === S.ENDED && !endedHandled) {
    endedHandled = true;
    onVideoEnded();
  }
}, 500);

/* ================= certificate ================= */
function openCertModal() {
  const c = current?.course;
  if (!c) return;
  $('#certCourseName').textContent = c.title;
  $('#certName').value = userName;
  showModal('certModal');
}

function downloadCertificate() {
  const c = current?.course;
  if (!c) return;
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) {
    toast('The PDF library needs an internet connection the first time.', { error: true });
    return;
  }
  userName = $('#certName').value.trim() || 'A Focused Learner';
  DB.save('ft_name', userName);
  scheduleRemoteSave();

  const total = c.videos.reduce((a, v) => a + (v.durationSeconds || 0), 0);
  const dateStr = new Date(c.completedAt || Date.now()).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' }); // 297 × 210
  const CX = 148.5;

  doc.setFillColor(252, 250, 245);
  doc.rect(0, 0, 297, 210, 'F');
  doc.setDrawColor(124, 92, 255);
  doc.setLineWidth(1.5);
  doc.rect(10, 10, 277, 190);
  doc.setLineWidth(0.4);
  doc.rect(14, 14, 269, 182);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(120, 120, 140);
  doc.text('FOCUSTUBE  ·  DISTRACTION-FREE LEARNING', CX, 34, { align: 'center', charSpace: 1.5 });

  doc.setFont('times', 'bold');
  doc.setFontSize(38);
  doc.setTextColor(28, 28, 40);
  doc.text('Certificate of Completion', CX, 58, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(110, 110, 130);
  doc.text('This certifies that', CX, 78, { align: 'center' });

  doc.setFont('times', 'bolditalic');
  doc.setFontSize(30);
  doc.setTextColor(124, 92, 255);
  doc.text(userName, CX, 92, { align: 'center' });
  doc.setDrawColor(200, 195, 215);
  doc.setLineWidth(0.4);
  doc.line(88, 97, 209, 97);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(110, 110, 130);
  doc.text('has watched every single video of', CX, 110, { align: 'center' });

  doc.setFont('times', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(28, 28, 40);
  const lines = doc.splitTextToSize(c.title, 220);
  doc.text(lines, CX, 123, { align: 'center' });
  const afterTitle = 123 + (lines.length - 1) * 9;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(110, 110, 130);
  doc.text(
    `${nVideos(c.videos.length)}  ·  ${fmtLong(total)} of pure focus  ·  completed on ${dateStr}`,
    CX,
    afterTitle + 13,
    { align: 'center' }
  );

  doc.setDrawColor(160, 160, 180);
  doc.line(40, 172, 105, 172);
  doc.line(192, 172, 257, 172);
  doc.setFontSize(10.5);
  doc.text('The Algorithm You Defeated', 72.5, 178, { align: 'center' });
  doc.text('FocusTube', 224.5, 178, { align: 'center' });

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(10);
  doc.setTextColor(150, 150, 165);
  doc.text('This certificate is entirely unofficial — and entirely earned.', CX, 190, {
    align: 'center',
  });

  const slug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  doc.save(`certificate-${slug || 'course'}.pdf`);
}

/* ================= description & chapters ================= */
async function loadVideoExtras(videoId) {
  videoExtras = { videoId, chapters: [], description: '', durationSeconds: 0 };
  renderExtras();
  try {
    let ex = extrasCache.get(videoId);
    if (!ex) {
      const res = await fetch('/api/video/' + encodeURIComponent(videoId));
      if (!res.ok) return;
      ex = await res.json();
      extrasCache.set(videoId, ex);
    }
    if (curVideo()?.id !== videoId) return; // user moved on — stale response
    videoExtras = {
      videoId,
      chapters: ex.chapters || [],
      description: ex.description || '',
      durationSeconds: ex.durationSeconds || 0,
    };
    renderExtras();
  } catch {
    /* extras are optional */
  }
}

function renderExtras() {
  const { chapters, description } = videoExtras;
  lastChapterIdx = -2;
  npChapter.textContent = '';

  chaptersSection.classList.toggle('hidden', chapters.length === 0);
  chaptersList.innerHTML = '';
  chapterRowEls = [];
  for (const ch of chapters) {
    const row = el(
      'button',
      {
        class: 'chapter-row',
        onclick: () => {
          safe(() => player.seekTo(ch.start, true));
          safe(() => player.playVideo());
        },
      },
      el('span', { class: 'ch-time' }, fmtDuration(ch.start)),
      el('span', {}, ch.title)
    );
    chaptersList.append(row);
    chapterRowEls.push(row);
  }

  seekMarkers.innerHTML = '';
  const dur = videoExtras.durationSeconds || curVideo()?.durationSeconds || 0;
  if (chapters.length && dur > 0) {
    for (const ch of chapters) {
      if (ch.start <= 0 || ch.start >= dur) continue;
      seekMarkers.append(el('i', { class: 'seek-marker', style: `left:${(ch.start / dur) * 100}%` }));
    }
  }

  const hasDesc = !!description.trim();
  descSection.classList.toggle('hidden', !hasDesc);
  descBody.innerHTML = '';
  if (hasDesc) descBody.append(buildDescription(description));
}

/** Build description DOM with clickable timestamps and safe external links. */
function buildDescription(text) {
  const frag = document.createDocumentFragment();
  const re = /((?:\d{1,2}:)?\d{1,2}:\d{2})(?![\d:])|(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) {
      const secs = m[1].split(':').reduce((a, p) => a * 60 + Number(p), 0);
      frag.append(
        el(
          'button',
          {
            class: 'ts-link',
            onclick: () => {
              safe(() => player.seekTo(secs, true));
              safe(() => player.playVideo());
            },
          },
          m[1]
        )
      );
    } else {
      frag.append(
        el('a', { class: 'desc-link', href: m[2], target: '_blank', rel: 'noopener noreferrer' }, m[2])
      );
    }
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

/* ================= playlist refresh ================= */
async function syncCourse({ silent = false } = {}) {
  const c = current?.course;
  if (!c) return;
  sideRefreshBtn.disabled = true;
  sideRefreshBtn.classList.add('spin');
  try {
    const res = await fetch('/api/playlist?url=' + encodeURIComponent(c.id));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Refresh failed.');
    const oldIds = new Set(c.videos.map((v) => v.id));
    const newIds = new Set(data.videos.map((v) => v.id));
    const added = data.videos.filter((v) => !oldIds.has(v.id)).length;
    const removed = c.videos.filter((v) => !newIds.has(v.id)).length;
    const changed = added > 0 || removed > 0 || data.title !== c.title;
    c.title = data.title;
    c.author = data.author;
    c.videos = data.videos;
    c.lastSyncedAt = Date.now();
    saveCourses();
    if (changed && current?.course === c) {
      const keepId = curVideo()?.id;
      renderSidebar(c);
      current.index = Math.max(0, c.videos.findIndex((v) => v.id === keepId));
      syncCourseUI();
      updateNowPlaying();
    }
    if (added || removed) {
      const bits = [];
      if (added) bits.push(`+${added} new video${added === 1 ? '' : 's'}`);
      if (removed) bits.push(`${removed} removed`);
      toast(`Playlist updated: ${bits.join(', ')} ✓`);
    } else if (!silent) {
      toast('Playlist is up to date ✓');
    }
  } catch (err) {
    if (!silent) toast(err.message, { error: true });
  } finally {
    sideRefreshBtn.disabled = false;
    sideRefreshBtn.classList.remove('spin');
  }
}

/* ================= captions & quality ================= */
const QUALITY_LABELS = {
  highres: '4320p', hd2880: '2880p', hd2160: '2160p (4K)', hd1440: '1440p',
  hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p',
  small: '240p', tiny: '144p', default: 'Auto', auto: 'Auto',
};

function applyCaptions() {
  if (!playerReady) return;
  if (captionsOn) {
    safe(() => player.loadModule('captions'));
    safe(() => player.loadModule('cc'));
  } else {
    safe(() => player.unloadModule('captions'));
    safe(() => player.unloadModule('cc'));
  }
  ccBtn.classList.toggle('active', captionsOn);
}

function toggleCaptions() {
  captionsOn = !captionsOn;
  DB.save('ft_cc', captionsOn);
  scheduleRemoteSave();
  applyCaptions();
  toast(captionsOn ? 'Captions on — shown when the video has them' : 'Captions off');
}

function populateQuality() {
  if (!playerReady) return;
  const levels = (safe(() => player.getAvailableQualityLevels()) || []).filter(
    (l) => l && l !== 'auto' && l !== 'default'
  );
  if (!levels.length) return;
  const sig = levels.join(',');
  if (qualitySel.dataset.sig === sig) return;
  qualitySel.dataset.sig = sig;
  qualitySel.innerHTML = '';
  qualitySel.append(el('option', { value: 'default' }, 'Auto'));
  for (const q of levels) qualitySel.append(el('option', { value: q }, QUALITY_LABELS[q] || q));
  qualitySel.value = ['default', ...levels].includes(prefQuality) ? prefQuality : 'default';
}

function applyQuality() {
  if (!playerReady) return;
  const q = prefQuality || 'default';
  safe(() => player.setPlaybackQualityRange(q, q));
  safe(() => player.setPlaybackQuality(q));
}

/* ================= player controls ================= */
let controlsHideTimer = null;
let controlsPointerInside = false;
let controlsPointerNearBottom = false;
let controlsPointerDown = false;
let controlsKeyboardFocus = false;
let controlsPlaybackStarted = false;
let controlsTouchSelect = null;
let controlsRevealOnly = false;

function hidePlayerControls() {
  clearTimeout(controlsHideTimer);
  controlsHideTimer = null;
  if (controlsPointerDown || controlsKeyboardFocus || controlsTouchSelect || (controlsPointerInside && controlsPointerNearBottom)) return;
  if (safe(() => playerControls.querySelector('select:open'))) {
    controlsHideTimer = setTimeout(hidePlayerControls, 2500);
    return;
  }
  playerControls.classList.remove('controls-visible');
}

function showPlayerControls() {
  if (!current || courseView.classList.contains('hidden')) return;
  clearTimeout(controlsHideTimer);
  playerControls.classList.add('controls-visible');
  controlsHideTimer = setTimeout(hidePlayerControls, 2500);
}

function resetPlayerControls() {
  clearTimeout(controlsHideTimer);
  controlsHideTimer = null;
  controlsPointerInside = false;
  controlsPointerNearBottom = false;
  controlsPointerDown = false;
  controlsKeyboardFocus = false;
  controlsPlaybackStarted = false;
  controlsTouchSelect = null;
  controlsRevealOnly = false;
  playerControls.classList.remove('controls-visible');
}

function syncPlayerControls(state) {
  const states = YT.PlayerState;
  if ([states.PAUSED, states.CUED, states.ENDED].includes(state)) controlsPlaybackStarted = false;
  if (state === states.PLAYING && !controlsPlaybackStarted) {
    controlsPlaybackStarted = true;
    showPlayerControls();
  }
}

function trackPlayerPointer(event) {
  if (event.pointerType === 'touch') return;
  const bounds = playerPane.getBoundingClientRect();
  controlsPointerInside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  controlsPointerNearBottom = controlsPointerInside && event.clientY >= bounds.bottom - playerControls.offsetHeight;
  if (controlsPointerInside) showPlayerControls();
  else hidePlayerControls();
}

function setupPlayerControls() {
  playerPane.addEventListener('pointerenter', trackPlayerPointer);
  playerPane.addEventListener('pointermove', trackPlayerPointer);
  playerPane.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    controlsPointerInside = false;
    controlsPointerNearBottom = false;
    hidePlayerControls();
  });
  playerPane.addEventListener('pointerdown', event => {
    controlsRevealOnly = event.pointerType === 'touch' && event.target.id === 'shield' && !playerControls.classList.contains('controls-visible');
    controlsKeyboardFocus = false;
    controlsPointerDown = playerControls.contains(event.target);
    controlsTouchSelect = event.pointerType === 'touch' && event.target.tagName === 'SELECT' ? event.target : null;
    showPlayerControls();
  });
  document.addEventListener('pointerdown', event => {
    if (playerPane.contains(event.target)) return;
    controlsTouchSelect = null;
    controlsPointerInside = false;
    controlsPointerNearBottom = false;
    hidePlayerControls();
  });
  const finishPointer = event => {
    if (!controlsPointerDown) return;
    controlsPointerDown = false;
    if (event.pointerType === 'touch') {
      controlsPointerInside = false;
      controlsPointerNearBottom = false;
      showPlayerControls();
    } else trackPlayerPointer(event);
  };
  document.addEventListener('pointerup', finishPointer);
  document.addEventListener('pointercancel', finishPointer);
  playerPane.addEventListener('focusin', event => {
    if (!controlsPointerDown && event.target.matches(':focus-visible')) controlsKeyboardFocus = true;
    showPlayerControls();
  });
  playerPane.addEventListener('keydown', () => {
    controlsKeyboardFocus = true;
    showPlayerControls();
  });
  playerPane.addEventListener('focusout', event => {
    if (event.target === controlsTouchSelect) controlsTouchSelect = null;
    if (playerPane.contains(event.relatedTarget)) return;
    controlsKeyboardFocus = false;
    if (controlsPointerInside) showPlayerControls();
    else hidePlayerControls();
  });
  playerControls.addEventListener('change', event => {
    const touchSelection = event.target === controlsTouchSelect;
    if (touchSelection) controlsTouchSelect = null;
    if (touchSelection || controlsPointerInside || controlsKeyboardFocus) showPlayerControls();
    else hidePlayerControls();
  });
  document.addEventListener('fullscreenchange', () => {
    controlsPointerInside = false;
    controlsPointerNearBottom = false;
    if (document.fullscreenElement) showPlayerControls();
    else hidePlayerControls();
  });
  window.addEventListener('blur', () => {
    controlsPointerDown = false;
    controlsPointerInside = false;
    controlsPointerNearBottom = false;
    hidePlayerControls();
  });
}

function togglePlay() {
  if (!playerReady) return;
  const s = safe(() => player.getPlayerState());
  if (s === YT.PlayerState.PLAYING) safe(() => player.pauseVideo());
  else safe(() => player.playVideo());
}

function seekBy(delta) {
  if (!playerReady) return;
  const t = safe(() => player.getCurrentTime()) || 0;
  safe(() => player.seekTo(Math.max(0, t + delta), true));
}

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function setSpeed(rate) {
  rate = Math.min(4, Math.max(0.25, rate));
  speedSel.value = String(rate);
  if (current) {
    current.course.speed = rate;
    saveCourses();
  }
  if (!playerReady) return;
  safe(() => player.setPlaybackRate(rate));
  // The embedded player may silently clamp the rate (usually at 2×) — verify and be honest.
  clearTimeout(setSpeed._verify);
  setSpeed._verify = setTimeout(() => {
    const actual = safe(() => player.getPlaybackRate());
    if (actual && Math.abs(actual - rate) > 0.01) {
      speedSel.value = String(actual);
      if (current) {
        current.course.speed = actual;
        saveCourses();
      }
      toast(`YouTube caps this embed at ${actual}× — higher speeds aren't allowed for this video.`, {
        error: true,
      });
    }
  }, 500);
}

function stepSpeed(dir) {
  const cur = parseFloat(speedSel.value) || 1;
  let idx = SPEED_STEPS.findIndex((s) => Math.abs(s - cur) < 0.01);
  if (idx === -1) idx = SPEED_STEPS.indexOf(1);
  setSpeed(SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, Math.max(0, idx + dir))]);
}

function toggleMute() {
  if (!playerReady) return;
  if (safe(() => player.isMuted())) {
    safe(() => player.unMute());
    muteBtn.innerHTML = I.vol;
  } else {
    safe(() => player.mute());
    muteBtn.innerHTML = I.mute;
  }
}

function toggleFullscreen() {
  const shell = $('#playerShell');
  if (document.fullscreenElement) document.exitFullscreen();
  else shell.requestFullscreen?.();
}

/* ================= profile ================= */
let accountSnapshot = null;
let accountSaveBusy = false;
let accountLoadVersion = 0;
let accountRetryUntil = 0;
let accountRetryTimer = null;
let passwordSaveBusy = false;
let passwordRetryUntil = 0;
let passwordRetryTimer = null;
let settingsSection = 'account';
let appearance = { reflection: true, reduceTransparency: false };

function restoreAppearance(user = null) {
  const saved = user ? DB.load(`ft_appearance_${user.id}`, null) : null;
  appearance = { reflection: saved?.reflection !== false, reduceTransparency: saved?.reduceTransparency === true };
  applyAppearance();
}

function applyAppearance() {
  document.documentElement.dataset.reflection = String(appearance.reflection);
  document.documentElement.dataset.reduceTransparency = String(appearance.reduceTransparency);
  $('#appearanceReflection').checked = appearance.reflection;
  $('#appearanceTransparency').checked = appearance.reduceTransparency;
  document.dispatchEvent(new Event('appearancechange'));
}

function accountValues() {
  return { displayName: $('#accountDisplayName').value.trim(), username: $('#accountUsername').value.trim().toLowerCase() };
}

function accountDirty() {
  if (!accountSnapshot) return false;
  const values = accountValues();
  return values.displayName !== accountSnapshot.displayName || values.username !== accountSnapshot.username;
}

function confirmAccountDiscard() {
  if (accountSaveBusy || passwordSaveBusy) return false;
  return (!accountDirty() && !passwordDirty()) || confirm('Discard your unsaved account changes?');
}

function syncAccountForm() {
  const busy = accountSaveBusy || passwordSaveBusy;
  const usernameChanged = accountValues().username !== (authUser?.username?.toLowerCase() || '');
  $('#accountPasswordField').classList.toggle('hidden', !usernameChanged);
  $('#accountPassword').required = usernameChanged;
  $('#accountPassword').disabled = busy || !usernameChanged;
  if (!usernameChanged) $('#accountPassword').value = '';
  $('#accountUsername').required = !!authUser?.username;
  $('#accountSave').disabled = busy || !accountDirty() || Date.now() < accountRetryUntil;
  $('#accountCancel').disabled = busy;
  $('#accountSave').setAttribute('aria-busy', String(accountSaveBusy));
  for (const input of [$('#accountDisplayName'), $('#accountUsername')]) input.disabled = busy;
  syncPasswordForm();
}

function fillAccountForm() {
  $('#accountDisplayName').value = authUser?.displayName || '';
  $('#accountUsername').value = authUser?.username || '';
  $('#accountPassword').value = '';
  $('#accountUsername').removeAttribute('aria-invalid');
  $('#accountError').classList.add('hidden');
  $('#accountUsernameError').classList.add('hidden');
  $('#accountSaveStatus').textContent = '';
  const joined = Date.parse(authUser?.createdAt);
  $('#accountJoined').textContent = Number.isFinite(joined) ? `Member since ${new Date(joined).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` : '';
  accountSnapshot = accountValues();
  syncAccountForm();
}

function selectSettingsSection(section, focus = false) {
  const tabs = [...document.querySelectorAll('[data-settings]')];
  if (section === 'admin' && !authUser?.isAdmin) section = 'account';
  if (!tabs.some(tab => tab.dataset.settings === section)) section = 'account';
  settingsSection = section;
  $('#settingsAdminTab').classList.toggle('hidden', !authUser?.isAdmin);
  for (const tab of tabs) {
    const selected = tab.dataset.settings === section;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $('#' + tab.getAttribute('aria-controls')).classList.toggle('hidden', !selected);
    if (selected && focus) tab.focus();
  }
  syncCaptcha('enrollment', section === 'account' && !$('#emailEnrollment').classList.contains('hidden') ? 'email' : null);
}

async function openProfile() {
  if ($('#profileModal').open) return;
  clearPasswordFields();
  $('#passwordError').classList.add('hidden');
  $('#passwordStatus').textContent = '';
  updateProfileUI();
  fillAccountForm();
  showModal('profileModal');
  selectSettingsSection(settingsSection);
  const generation = sessionGeneration;
  const version = ++accountLoadVersion;
  try {
    const result = await api('/api/auth/me', { signal: AbortSignal.timeout(10000) });
    if (generation !== sessionGeneration || version !== accountLoadVersion || !$('#profileModal').open || accountDirty() || accountSaveBusy || passwordSaveBusy) return;
    authUser = result.user;
    updateProfileUI();
    fillAccountForm();
    selectSettingsSection(settingsSection);
  } catch (error) {
    if (generation !== sessionGeneration || version !== accountLoadVersion || !$('#profileModal').open) return;
    $('#accountError').textContent = 'Could not refresh account details. Close settings and try again.';
    $('#accountError').classList.remove('hidden');
  }
}

function setupAccountSettings() {
  const dialog = $('#profileModal');
  dialog.confirmClose = () => {
    if (!confirmAccountDiscard()) return false;
    clearPasswordFields();
    return true;
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); hideModal('profileModal'); });
  dialog.addEventListener('close', () => { accountLoadVersion++; accountSnapshot = null; $('#accountForm').reset(); clearPasswordFields(); });
  const nav = $('.settings-nav');
  const narrow = matchMedia('(max-width: 640px)');
  const orientation = () => nav.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
  narrow.addEventListener('change', orientation);
  orientation();
  nav.addEventListener('click', event => { const tab = event.target.closest('[data-settings]'); if (tab) selectSettingsSection(tab.dataset.settings); });
  nav.addEventListener('keydown', event => {
    const tabs = [...nav.querySelectorAll('[data-settings]:not(.hidden)')];
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const directions = narrow.matches ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
    if (!Object.hasOwn(directions, event.key) && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + directions[event.key] + tabs.length) % tabs.length;
    selectSettingsSection(tabs[next].dataset.settings, true);
  });
  $('#accountForm').addEventListener('input', () => {
    $('#accountUsername').removeAttribute('aria-invalid');
    $('#accountUsernameError').classList.add('hidden');
    $('#accountError').classList.add('hidden');
    $('#accountSaveStatus').textContent = '';
    syncAccountForm();
  });
  $('#accountCancel').addEventListener('click', () => { if (confirmAccountDiscard()) fillAccountForm(); });
  $('#accountForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!accountDirty() || accountSaveBusy || passwordSaveBusy || Date.now() < accountRetryUntil) return;
    const generation = sessionGeneration;
    const values = accountValues();
    accountLoadVersion++;
    if (values.username !== (authUser.username?.toLowerCase() || '')) values.password = $('#accountPassword').value;
    accountSaveBusy = true;
    $('#accountSaveStatus').textContent = 'Saving...';
    $('#accountError').classList.add('hidden');
    $('#accountUsernameError').classList.add('hidden');
    syncAccountForm();
    try {
      const result = await api('/api/auth/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values), signal: AbortSignal.timeout(10000) });
      if (generation !== sessionGeneration) return;
      authUser = result.user;
      updateProfileUI();
      fillAccountForm();
      $('#accountSaveStatus').textContent = 'Changes saved.';
    } catch (error) {
      if (generation !== sessionGeneration) return;
      const duplicate = error.data?.code === 'USERNAME_TAKEN';
      const target = $(duplicate ? '#accountUsernameError' : '#accountError');
      target.textContent = error.name === 'TimeoutError' ? 'The server did not respond. Reopen settings to check your account before trying again.' : error.message;
      target.classList.remove('hidden');
      $('#accountSaveStatus').textContent = '';
      if (duplicate) $('#accountUsername').setAttribute('aria-invalid', 'true');
      if (error.retryAfter) {
        accountRetryUntil = Date.now() + Math.min(error.retryAfter, 3600) * 1000;
        target.textContent += ` Try again in ${Math.ceil(error.retryAfter / 60)} minute(s).`;
        clearTimeout(accountRetryTimer);
        accountRetryTimer = setTimeout(syncAccountForm, accountRetryUntil - Date.now());
      }
    } finally {
      if (generation === sessionGeneration) {
        accountSaveBusy = false;
        $('#accountPassword').value = '';
        syncAccountForm();
        if ($('#accountUsername').getAttribute('aria-invalid') === 'true') $('#accountUsername').focus();
      }
    }
  });
  for (const [selector, key] of [['#appearanceReflection', 'reflection'], ['#appearanceTransparency', 'reduceTransparency']]) {
    $(selector).addEventListener('change', event => {
      appearance[key] = event.target.checked;
      if (authUser) { try { DB.save(`ft_appearance_${authUser.id}`, appearance); } catch {} }
      applyAppearance();
    });
  }
  window.addEventListener('beforeunload', event => { if (accountDirty() || passwordDirty() || passwordSaveBusy) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { $('#accountPassword').value = ''; clearPasswordFields(); });
}

function passwordDirty() {
  return [...$('#passwordForm').querySelectorAll('input')].some(input => input.value.length > 0);
}

function clearPasswordFields() {
  $('#passwordForm').reset();
  for (const input of $('#passwordForm').querySelectorAll('input')) {
    input.value = '';
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
  }
}

function validatePasswordFields() {
  const current = $('#passwordCurrent');
  const next = $('#passwordNew');
  const confirmation = $('#passwordConfirmation');
  next.setCustomValidity(next.value && next.value === current.value ? 'Choose a different password.' : '');
  confirmation.setCustomValidity(confirmation.value && confirmation.value !== next.value ? 'Passwords do not match.' : '');
}

function syncPasswordForm() {
  const busy = passwordSaveBusy || accountSaveBusy || $('#enrollmentSubmit').getAttribute('aria-busy') === 'true';
  for (const input of $('#passwordForm').querySelectorAll('input')) input.disabled = busy;
  $('#passwordSubmit').disabled = busy || Date.now() < passwordRetryUntil;
  $('#passwordCancel').disabled = busy;
  $('#passwordForm').setAttribute('aria-busy', String(passwordSaveBusy));
  $('#passwordSubmit').setAttribute('aria-busy', String(passwordSaveBusy));
  $('#emailEnrollmentForm').inert = passwordSaveBusy;
}

function setupPasswordSettings() {
  const form = $('#passwordForm');
  form.addEventListener('input', () => {
    validatePasswordFields();
    $('#passwordError').classList.add('hidden');
    $('#passwordStatus').textContent = '';
    for (const input of form.querySelectorAll('input')) input.removeAttribute('aria-invalid');
  });
  form.addEventListener('invalid', event => event.target.setAttribute('aria-invalid', 'true'), true);
  $('#passwordCancel').addEventListener('click', () => {
    clearPasswordFields();
    $('#passwordError').classList.add('hidden');
    $('#passwordStatus').textContent = '';
    $('#passwordCurrent').focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (passwordSaveBusy || accountSaveBusy || authBusy || $('#importDataBtn').disabled ||
      $('#enrollmentSubmit').getAttribute('aria-busy') === 'true' || Date.now() < passwordRetryUntil) return;
    validatePasswordFields();
    if (!form.reportValidity()) return;
    const generation = sessionGeneration;
    const values = { currentPassword: $('#passwordCurrent').value, newPassword: $('#passwordNew').value,
      passwordConfirmation: $('#passwordConfirmation').value };
    passwordSaveBusy = true;
    accountLoadVersion++;
    $('#passwordError').classList.add('hidden');
    $('#passwordStatus').textContent = 'Changing password...';
    syncAccountForm();
    try {
      const result = await api('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values), signal: AbortSignal.timeout(15000) });
      if (generation !== sessionGeneration) return;
      authUser = result.user;
      $('#accountPassword').value = '';
      $('#enrollmentPassword').value = '';
      clearEmailCode('enrollment');
      updateProfileUI();
      resetCaptcha('enrollment');
      withdrawPresence();
      updatePresence();
      $('#passwordStatus').textContent = 'Password changed. Other sessions have been signed out.';
    } catch (error) {
      if (generation !== sessionGeneration) return;
      const target = $('#passwordError');
      target.textContent = !error.status || error.status >= 500 ?
        'The password change could not be confirmed. Try signing in again to check which password is active.' : error.message;
      target.classList.remove('hidden');
      $('#passwordStatus').textContent = '';
      if (error.retryAfter > 0) {
        const delay = Math.min(error.retryAfter, 3600) * 1000;
        passwordRetryUntil = Date.now() + delay;
        target.textContent += ` Try again in ${Math.ceil(delay / 60000)} minute(s).`;
        clearTimeout(passwordRetryTimer);
        passwordRetryTimer = setTimeout(syncPasswordForm, delay);
      }
    } finally {
      if (generation === sessionGeneration) {
        clearPasswordFields();
        passwordSaveBusy = false;
        syncAccountForm();
        if (!$('#passwordError').classList.contains('hidden')) $('#passwordError').focus();
      }
    }
  });
}

function setupGlassReflection() {
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  const limits = ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map(query => matchMedia(query));
  let active = null;
  let frame = null;
  let idle = null;
  let position = { x: 0, y: 0 };
  const clear = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    clearTimeout(idle);
    frame = idle = null;
    active?.classList.remove('glass-tracking');
    active = null;
  };
  document.addEventListener('pointermove', event => {
    const target = event.target.closest('[data-glass]');
    if (!target || event.pointerType !== 'mouse' || !pointer.matches || limits.some(limit => limit.matches) ||
      !appearance.reflection || appearance.reduceTransparency || document.hidden) { clear(); return; }
    if (active !== target) { clear(); active = target; }
    position = { x: event.clientX, y: event.clientY };
    clearTimeout(idle);
    idle = setTimeout(clear, 650);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const bounds = active.getBoundingClientRect();
      active.style.setProperty('--reflection-position', `${position.x - bounds.left + (position.y - bounds.top) * 0.35}px`);
      active.classList.add('glass-tracking');
    });
  }, { passive: true });
  document.addEventListener('pointerout', event => { if (active && !active.contains(event.relatedTarget)) clear(); }, { passive: true });
  document.addEventListener('visibilitychange', clear);
  document.addEventListener('appearancechange', clear);
  window.addEventListener('blur', clear);
  window.addEventListener('pagehide', clear);
  window.addEventListener('scroll', clear, { passive: true, capture: true });
  for (const media of [pointer, ...limits]) media.addEventListener('change', clear);
}

let monitoringPage = 1;
let monitoringRequest = null;
let monitoringData = null;
let monitoringTrafficChart = null;
let monitoringUsersChart = null;

function clearMonitoring() {
  monitoringRequest?.abort();
  monitoringRequest = null;
  monitoringData = null;
  monitoringTrafficChart?.destroy();
  monitoringUsersChart?.destroy();
  monitoringTrafficChart = null;
  monitoringUsersChart = null;
  $('#monitoringContent').classList.add('hidden');
  $('#monitoringUsers').replaceChildren();
  $('#monitoringEvents').replaceChildren();
  $('#monitoringTrafficData').replaceChildren();
  $('#monitoringUsersData').replaceChildren();
  $('#monitoringError').classList.add('hidden');
}

function monitoringDate(value) {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}

function monitoringBytes(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function renderMonitoring(data) {
  const { usage, system, traffic } = data;
  const since = Date.parse(data.startedAt);
  renderChartData('monitoringTrafficData', 'Origin traffic per minute', ['Time', 'Requests', 'Server errors'],
    traffic.map(point => [monitoringDate(point.timestamp), ...[point.requests, point.errors].map(value => Date.parse(point.timestamp) + 60000 <= since ? 'Not collected' : value)]));
  renderChartData('monitoringUsersData', 'Active members per UTC day', ['Date (UTC)', 'Members'], usage.daily.map(day => [day.date, day.users]));
  for (const [id, value] of Object.entries({ monitoringActive: usage.activeNow, monitoringToday: usage.activeToday,
    monitoringWeek: usage.activeWeek, monitoringMembers: usage.members })) $('#' + id).textContent = Number(value).toLocaleString();
  $('#monitoringUpdated').textContent = `Updated ${new Date(usage.generatedAt).toLocaleTimeString()}`;
  $('#monitoringUptime').textContent = fmtLong(system.uptimeSeconds);
  $('#monitoringMemory').textContent = monitoringBytes(system.rssBytes);
  $('#monitoringHeap').textContent = monitoringBytes(system.heapUsedBytes);
  $('#monitoringDisk').textContent = system.diskFreeBytes === null ? 'Unavailable' : `${monitoringBytes(system.diskFreeBytes)} free`;
  $('#monitoringDatabase').textContent = monitoringBytes(system.databaseBytes);
  $('#monitoringWal').textContent = monitoringBytes(system.walBytes);
  $('#monitoringSince').textContent = `Since ${monitoringDate(data.startedAt)}`;
  $('#monitoringCollector').textContent = data.collection.metricsEnabled ? 'Private metrics enabled' : 'External collection not configured';
  for (const [name, id] of [['grafana', 'monitoringGrafana'], ['uptime', 'monitoringUptimeLink']]) {
    const anchor = $('#' + id);
    const url = data.links[name];
    anchor.classList.toggle('hidden', !url);
    if (url) anchor.href = url;
    else anchor.removeAttribute('href');
  }
  $('#monitoringOutageState').textContent = data.links.uptime ? 'External availability history' : 'External uptime monitor not configured';
  const userRows = usage.users.map(user => el('tr', {},
    el('td', {}, user.username || `Member #${user.id}`),
    el('td', {}, el('span', { class: user.active ? 'monitoring-online' : 'muted' }, user.active ? 'Active' : user.accountState === 'disabled' ? 'Disabled' : 'Idle')),
    el('td', {}, user.isAdmin ? 'Administrator' : 'Member'),
    el('td', {}, monitoringDate(user.lastLoginAt)), el('td', {}, monitoringDate(user.lastActiveAt))));
  $('#monitoringUsers').replaceChildren(...(userRows.length ? userRows : [el('tr', {}, el('td', { colspan: '5' }, 'No members recorded.'))]));
  $('#monitoringPage').textContent = `Page ${usage.page} of ${usage.pages}`;
  $('#monitoringPrevious').disabled = usage.page <= 1;
  $('#monitoringNext').disabled = usage.page >= usage.pages;
  const eventNames = { login: 'Signed in', register: 'Account created', upgrade: 'Guest converted', email: 'Email verified', logout: 'Signed out' };
  const eventRows = usage.events.map(event => el('li', {}, el('span', {}, event.username || `Member #${event.userId}`),
    el('span', {}, eventNames[event.event] || 'Account event'), el('time', { datetime: event.createdAt }, monitoringDate(event.createdAt))));
  $('#monitoringEvents').replaceChildren(...(eventRows.length ? eventRows : [el('li', { class: 'muted' }, 'No account events recorded yet.')]));
  const styles = getComputedStyle(document.documentElement);
  const text = styles.getPropertyValue('--muted').trim();
  const border = styles.getPropertyValue('--border').trim();
  const accent = styles.getPropertyValue('--teal').trim();
  const error = styles.getPropertyValue('--red').trim();
  const options = { responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: text, font: { family: 'IBM Plex Sans' } } } },
    scales: { x: { ticks: { color: text, maxTicksLimit: 6 }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: text, precision: 0 }, grid: { color: border } } } };
  monitoringTrafficChart?.destroy();
  monitoringUsersChart?.destroy();
  monitoringTrafficChart = new Chart($('#monitoringTrafficChart'), { type: 'line', options,
    data: { labels: traffic.map(point => new Date(point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), datasets: [
      { label: 'Requests / minute', data: traffic.map(point => Date.parse(point.timestamp) + 60000 <= since ? null : point.requests), borderColor: accent, backgroundColor: accent, pointRadius: 0, borderWidth: 2 },
      { label: 'Server errors', data: traffic.map(point => Date.parse(point.timestamp) + 60000 <= since ? null : point.errors), borderColor: error, backgroundColor: error, pointRadius: 0, borderWidth: 2 },
    ] } });
  monitoringUsersChart = new Chart($('#monitoringUsersChart'), { type: 'bar', options,
    data: { labels: usage.daily.map(day => day.date), datasets: [{ label: 'Active members / day (UTC)', data: usage.daily.map(day => day.users), backgroundColor: accent, borderRadius: 2 }] } });
}

async function refreshMonitoring() {
  if (!authUser?.isAdmin || !$('#monitoringModal').open || document.hidden || monitoringRequest) return;
  const controller = new AbortController();
  const generation = sessionGeneration;
  monitoringRequest = controller;
  $('#monitoringRefresh').disabled = true;
  $('#monitoringLoading').classList.toggle('hidden', !!monitoringData);
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await api(`/api/admin/monitoring?page=${monitoringPage}`, { signal: controller.signal });
    if (controller.signal.aborted || generation !== sessionGeneration || !$('#monitoringModal').open) return;
    monitoringData = result;
    $('#monitoringContent').classList.remove('hidden');
    $('#monitoringError').classList.add('hidden');
    renderMonitoring(result);
  } catch (error) {
    if (generation !== sessionGeneration || !$('#monitoringModal').open) return;
    if (error.status === 403) { hideModal('monitoringModal'); toast('Administrator access is required.', { error: true }); return; }
    $('#monitoringError').textContent = monitoringData ? 'Refresh failed. Displayed values are from the last successful update.' : 'Monitoring is unavailable. Try refreshing.';
    $('#monitoringError').classList.remove('hidden');
  } finally {
    clearTimeout(timeout);
    if (monitoringRequest === controller) monitoringRequest = null;
    $('#monitoringLoading').classList.add('hidden');
    $('#monitoringRefresh').disabled = false;
  }
}

function openMonitoring() {
  if (!authUser?.isAdmin) return;
  if (!hideModal('profileModal')) return;
  if (workspaceNarrowScreen.matches) setWorkspaceCollapsed(true);
  clearMonitoring();
  monitoringPage = 1;
  showModal('monitoringModal');
  refreshMonitoring();
}

async function exportProfileData() {
  const button = authUser?.isGuest ? $('#guestExport') : $('#exportDataBtn');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing export…';
  try {
    if (!authUser?.isGuest) {
      if (!(await notebooks.flush())) throw new Error('Resolve unsaved notes before exporting your profile.');
      const activitySaved = await flushActivity();
      const profileSaved = await persistRemoteData();
      if (!activitySaved || !profileSaved) throw new Error('Could not sync the latest progress. Check your connection and try again.');
    }
    const response = await fetch('/api/export');
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Could not export your data.');
    }
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `focustube-export-${todayKey()}.json`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Your FocusTube data was exported ✓');
  } catch (err) {
    toast(err.message, { error: true, ms: 5000 });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function importProfileData(file) {
  if (passwordSaveBusy) return;
  const button = $('#importDataBtn');
  const exportButton = $('#exportDataBtn');
  const originalText = button.textContent;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a JSON export smaller than 25 MB.');
    let imported;
    try {
      imported = JSON.parse(await file.text());
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (imported?.schema !== 'focustube-user-export' || ![1, 2].includes(imported?.schemaVersion)) {
      throw new Error('Choose a FocusTube user export (schema version 1 or 2).');
    }
    const courseCount =
      imported.courses && typeof imported.courses === 'object' && !Array.isArray(imported.courses)
        ? Object.keys(imported.courses).length
        : 0;
    const historyCount = Array.isArray(imported.dashboard?.watchHistory)
      ? imported.dashboard.watchHistory.length
      : 0;
    if (
      !confirm(
        `Import ${courseCount} course(s), ${historyCount} watch-history record(s), and ${imported.notebooks?.length || 0} video note(s) from "${file.name}"?\n\n` +
          'This replaces all progress and notebooks in your current profile. Your username and password will not change.' +
          (imported.schemaVersion === 1 ? '\nThis older export has no notebooks; your current notes will be cleared.' : '')
      )
    ) {
      return;
    }

    button.disabled = true;
    exportButton.disabled = true;
    button.textContent = 'Importing…';
    if (!(await notebooks.flush())) throw new Error('Resolve unsaved notes before importing a profile.');
    const activitySaved = await flushActivity();
    const profileSaved = await persistRemoteData();
    if (!activitySaved || !profileSaved) {
      throw new Error('Could not sync the latest progress. Check your connection and try again.');
    }
    await notebooks.request('/api/notebooks');
    const result = await api(`/api/import?revision=${profileRevision}&notesRevision=${notebooks.notesRevision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(imported),
    });
    button.textContent = 'Import complete';
    hideModal('profileModal');
    if (await finishAuth(result.user || authUser)) toast('Your FocusTube data was imported ✓');
  } catch (err) {
    toast(err.message, { error: true, ms: 5000 });
  } finally {
    button.disabled = false;
    exportButton.disabled = false;
    button.textContent = originalText;
    $('#importDataInput').value = '';
  }
}

/* ================= event wiring ================= */
$('#loginTab').addEventListener('click', () => { window.FocusTubeInvite.clear(); clearEmailCode('auth'); setAuthMode('login'); });
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#authUsername').addEventListener('input', () => clearEmailCode('auth'));
$('#enrollmentEmail').addEventListener('input', () => clearEmailCode('enrollment'));
for (const selector of ['#authPassword', '#authPasswordConfirmation']) $(selector).addEventListener('input', () => {
  const confirmation = $('#authPasswordConfirmation');
  confirmation.setCustomValidity(confirmation.value && confirmation.value !== $('#authPassword').value ? 'Passwords do not match.' : '');
});
document.querySelectorAll('.auth-provider').forEach(button => button.addEventListener('click', event => event.preventDefault()));
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (authBusy || Date.now() < authRetryUntil) return;
  const transition = ++authTransition;
  const error = $('#authError');
  setAuthBusy(true);
  error.classList.add('hidden');
  try {
    const joining = authMode !== 'login';
    const identity = joining ? 'email' : 'identifier';
    const body = { [identity]: $('#authUsername').value.trim(), password: $('#authPassword').value };
    if (joining) {
      body.displayName = $('#authDisplayName').value.trim();
      body.username = $('#authHandle').value.trim();
      body.passwordConfirmation = $('#authPasswordConfirmation').value;
      if (body.passwordConfirmation !== body.password) throw new Error('Passwords do not match.');
      if (!emailChallenges.auth) { await requestEmailCode('auth'); return; }
      Object.assign(body, emailCodeBody('auth'));
    }
    body.captchaToken = captchaToken('auth');
    const result = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      invitation: joining,
    });
    if (transition !== authTransition) return;
    $('#authPassword').value = '';
    $('#authPasswordConfirmation').value = '';
    window.FocusTubeInvite.clear();
    await finishAuth(result.user, transition);
  } catch (err) {
    if (transition !== authTransition) return;
    if (!err.status || err.status >= 500) {
      try {
        const result = await api('/api/auth/me');
        if (transition !== authTransition) return;
        if (result.user && !result.user.isGuest) {
          window.FocusTubeInvite.clear();
          await finishAuth(result.user, transition);
          return;
        }
      } catch {}
    }
    if (err.data?.code === 'INVALID_INVITATION') {
      window.FocusTubeInvite.clear();
      setAuthMode(authMode);
    }
    $('#authPassword').value = '';
    $('#authPasswordConfirmation').value = '';
    $('#authPasswordConfirmation').setCustomValidity('');
    showAccountError(err, error, $('#authSubmit'));
  } finally {
    if (transition === authTransition) {
      setAuthBusy(false);
      if (!authView.classList.contains('hidden')) resetCaptcha('auth');
    }
  }
});
$('#emailEnrollmentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#enrollmentSubmit');
  if (button.disabled || passwordSaveBusy) return;
  const userId = authUser?.id;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  syncPasswordForm();
  $('#enrollmentError').classList.add('hidden');
  try {
    if (!emailChallenges.enrollment) { await requestEmailCode('enrollment'); return; }
    const result = await api('/api/auth/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#enrollmentEmail').value.trim(), password: $('#enrollmentPassword').value,
        ...emailCodeBody('enrollment'), captchaToken: captchaToken('enrollment') }),
    });
    if (authUser?.id !== userId) return;
    authUser = result.user;
    clearEmailCode('enrollment');
    syncCaptcha('enrollment', null);
    $('#enrollmentPassword').value = '';
    updateProfileUI();
    toast('Email verified.');
  } catch (err) {
    $('#enrollmentPassword').value = '';
    if (authUser?.id === userId) showAccountError(err, $('#enrollmentError'), button);
  } finally {
    button.disabled = Number(button.dataset.retryUntil || 0) > Date.now();
    button.setAttribute('aria-busy', 'false');
    syncPasswordForm();
    if (authUser?.id === userId && !authUser.emailVerified) resetCaptcha('enrollment');
  }
});
for (const kind of ['auth', 'enrollment']) setupCodeInput($('#' + kind + 'Code'));
for (const kind of ['auth', 'enrollment']) $('#' + kind + 'Resend').addEventListener('click', async () => {
  const button = $('#' + kind + 'Resend');
  if (button.disabled || (kind === 'auth' ? authBusy : passwordSaveBusy || $('#enrollmentSubmit').disabled)) return;
  button.disabled = true;
  $('#enrollmentSubmit').setAttribute('aria-busy', String(kind === 'enrollment'));
  syncPasswordForm();
  if (kind === 'auth') setAuthBusy(true); else $('#enrollmentSubmit').disabled = true;
  try { await requestEmailCode(kind); }
  catch (error) { showAccountError(error, $(kind === 'auth' ? '#authError' : '#enrollmentError'), button); }
  finally {
    resetCaptcha(kind);
    $('#enrollmentSubmit').setAttribute('aria-busy', 'false');
    syncPasswordForm();
    if (kind === 'auth') setAuthBusy(false); else $('#enrollmentSubmit').disabled = false;
    button.disabled = Number(button.dataset.retryUntil || 0) > Date.now() || Date.now() < (emailChallenges[kind]?.resendAt || 0);
  }
});
$('#inviteForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#createInvite');
  const limit = $('#inviteMaxUses');
  if (button.disabled || !event.currentTarget.reportValidity()) return;
  const maxUses = limit.valueAsNumber;
  const generation = sessionGeneration;
  button.disabled = true;
  limit.disabled = true;
  clearIssuedInvite();
  $('#inviteError').classList.add('hidden');
  try {
    const result = await api('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses }) });
    if (generation !== sessionGeneration || !$('#profileModal').open) return;
    $('#issuedInviteLink').value = result.inviteUrl;
    $('#inviteExpiry').textContent = `Limit: ${result.maxUses} signup${result.maxUses === 1 ? '' : 's'}. Expires ${new Date(result.expiresAt).toLocaleString()}`;
    $('#inviteResult').classList.remove('hidden');
  } catch (err) {
    if (generation === sessionGeneration) showAccountError(err, $('#inviteError'), button);
  } finally {
    button.disabled = Number(button.dataset.retryUntil || 0) > Date.now();
    limit.disabled = false;
  }
});
$('#copyInvite').addEventListener('click', async () => {
  const value = $('#issuedInviteLink').value;
  if (!value) return;
  try { await navigator.clipboard.writeText(value); toast('Invitation copied.'); }
  catch { $('#issuedInviteLink').focus(); $('#issuedInviteLink').select(); toast('Clipboard access is unavailable.', { error: true }); }
});
$('#profileModal').addEventListener('close', clearIssuedInvite);
$('#profileModal').addEventListener('close', () => { clearEmailCode('enrollment'); syncCaptcha('enrollment', null); });
window.addEventListener('pagehide', clearIssuedInvite);
window.addEventListener('pagehide', () => { clearEmailCode('auth'); clearEmailCode('enrollment'); });
window.addEventListener('invitationchange', () => bootAuth());
$('#inviteContinue').addEventListener('click', async () => {
  window.FocusTubeInvite.clear();
  if (authUser) await finishAuth(authUser);
});
$('#guestExport').addEventListener('click', exportProfileData);

async function signOut() {
  if (authBusy || passwordSaveBusy) return;
  if ($('#profileModal').open && !confirmAccountDiscard()) return;
  setAuthBusy(true);
  try {
    if (appBooted && !authUser?.isGuest) {
      if (!(await notebooks.flush())) throw new Error('Your notes are not saved yet. Resolve the save error before signing out.');
      const activitySaved = await flushActivity();
      const profileSaved = await persistRemoteData();
      if (!activitySaved || !profileSaved) throw new Error('Could not sync everything yet. Check your connection before signing out.');
    }
    await api('/api/auth/logout', { method: 'POST' });
    accountSnapshot = null;
    clearPasswordFields();
    hideModal('profileModal');
    location.hash = '';
    showAuth();
  } catch (error) {
    if (appBooted) toast(error.message, { error: true });
    else showAccountError(error, $('#authError'), $('#authSubmit'));
  } finally {
    setAuthBusy(false);
  }
}
for (const selector of ['#logoutBtn', '#guestSignOut', '#inviteSignOut']) $(selector).addEventListener('click', signOut);
for (const selector of ['#monitoringBtn', '#profileMonitoring']) $(selector).addEventListener('click', openMonitoring);
$('#monitoringRefresh').addEventListener('click', refreshMonitoring);
$('#monitoringPrevious').addEventListener('click', () => { if (!monitoringRequest) { monitoringPage = Math.max(1, monitoringPage - 1); refreshMonitoring(); } });
$('#monitoringNext').addEventListener('click', () => { if (!monitoringRequest) { monitoringPage++; refreshMonitoring(); } });
$('#monitoringModal').addEventListener('close', clearMonitoring);
document.addEventListener('themechange', () => { if (monitoringData && $('#monitoringModal').open) renderMonitoring(monitoringData); });
document.addEventListener('visibilitychange', () => { updatePresence(); if (!document.hidden) refreshMonitoring(); });
window.addEventListener('pagehide', withdrawPresence);

$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = urlInput.value.trim();
  if (!value) return;
  if (isCourseLink(value)) addCourse(value);
  else searchYouTube(value);
});
urlInput.addEventListener('input', () => {
  addError.classList.add('hidden');
  if (!urlInput.value.trim() || isCourseLink(urlInput.value.trim())) clearCourseSearch();
  updateDiscoveryControls();
});
searchFilters.addEventListener('change', event => {
  searchType = event.target.value;
  const query = urlInput.value.trim();
  if (query && !isCourseLink(query)) searchYouTube(query);
});
$('#clearSearchBtn').innerHTML = I.back;
$('#clearSearchBtn').addEventListener('click', () => {
  clearCourseSearch({ clearInput: true });
  urlInput.focus();
});
retrySearchBtn.addEventListener('click', () => {
  const query = urlInput.value.trim();
  if (query && !isCourseLink(query)) searchYouTube(query);
});

$('#brand').addEventListener('click', () => (location.hash = ''));
setupWorkspaceSidebar();
$('#videoChatBtn').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
$('#workspaceBoardBtn').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
$('#railLogoutBtn').addEventListener('click', () => $('#logoutBtn').click());
$('#mobileLogoutBtn').addEventListener('click', () => $('#logoutBtn').click());
$('#skipContent').addEventListener('click', event => {
  event.preventDefault();
  const view = document.querySelector('main:not(.hidden)');
  if (view) { view.tabIndex = -1; view.focus(); }
});
backBtn.addEventListener('click', () => (location.hash = !$('#notebooksView').classList.contains('hidden') && notebooks.reviewCourse ? '#notebooks' : ''));
sideToggle.addEventListener('click', () => setPlaylistCollapsed(!document.body.classList.contains('side-collapsed')));
for (const id of ['courseContentClose', 'courseContentBackdrop']) {
  $('#' + id).addEventListener('click', () => { setPlaylistCollapsed(true); sideToggle.focus({ preventScroll: true }); });
}
$('#sidebar').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  setPlaylistCollapsed(true);
});
videoListEl.addEventListener('click', event => {
  if (window.innerWidth <= 1200 && event.target.closest('.lesson-open')) setPlaylistCollapsed(true, { remember: false });
});
$('#streakChip').addEventListener('click', () => (location.hash = '#dashboard'));
dashboardBtn.addEventListener('click', () => (location.hash = '#dashboard'));

/* library & tasks */
function setHomeMode(mode) {
  mode = mode === 'list' ? 'list' : 'grid';
  if (homeMode === mode) return;
  homeMode = mode;
  scheduleRemoteSave();
  renderHome();
}
$('#gridModeBtn').addEventListener('click', () => setHomeMode('grid'));
$('#listModeBtn').addEventListener('click', () => setHomeMode('list'));
$('#libraryStatusFilter').addEventListener('change', event => {
  libraryStatus = Object.hasOwn(LIBRARY_STATUSES, event.target.value) ? event.target.value : 'all';
  renderHome();
});
$('#tasksPageNew').addEventListener('click', () => openTaskModal());
$('#taskFilterCourse').addEventListener('change', renderTasksPage);
$('#taskFilterPriority').addEventListener('change', renderTasksPage);
$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#taskTitle').value.trim();
  if (!title) return;
  const t = editingTaskId ? workspace.tasks[editingTaskId] : createTask();
  if (!t) return;
  t.title = title.slice(0, 200);
  t.notes = $('#taskNotes').value.trim().slice(0, 2000);
  t.dueDate = $('#taskDue').value || null;
  t.priority = $('#taskPriority').value;
  t.courseId = $('#taskCourse').value || null;
  setTaskStatus(t, $('#taskStatus').value);
  editingTaskId = null;
  hideModal('taskModal');
  scheduleRemoteSave();
  refreshTaskUIs();
});
$('#taskDeleteBtn').addEventListener('click', () => {
  const t = editingTaskId ? workspace.tasks[editingTaskId] : null;
  if (!t || !confirm(`Delete "${t.title}"?`)) return;
  deleteTask(t.id);
  editingTaskId = null;
  hideModal('taskModal');
  scheduleRemoteSave();
  refreshTaskUIs();
});
$('#sprintForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cadence = $('#sprintCadence').value;
  const count = Math.max(1, Math.min(12, Number($('#sprintCount').value) || 4));
  const start = /^\d{4}-\d{2}-\d{2}$/.test($('#sprintStart').value) ? $('#sprintStart').value : todayKey();
  generateSprints(cadence, count, start);
  hideModal('sprintModal');
  scheduleRemoteSave();
  renderBoard();
});
$('#sprintClearBtn').addEventListener('click', () => {
  if (!confirm('Remove all sprints? Card assignments to sprints will be cleared.')) return;
  workspace.sprints.items = [];
  workspace.sprints.assignments = {};
  hideModal('sprintModal');
  scheduleRemoteSave();
  renderBoard();
});
$('#tasksPanelBtn').addEventListener('click', () => {
  if (taskPanel.classList.contains('open')) closeTaskPanel();
  else openTaskPanel();
});
$('#taskPanelClose').addEventListener('click', closeTaskPanel);
$('#taskPanelAllBtn').addEventListener('click', () => {
  closeTaskPanel();
  location.hash = '#tasks';
});
taskPanel.addEventListener('cancel', event => { event.preventDefault(); closeTaskPanel(); });
taskPanel.addEventListener('click', event => {
  const bounds = taskPanel.getBoundingClientRect();
  if (event.target === taskPanel && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeTaskPanel();
});
$('#quickTaskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#quickTaskInput').value.trim();
  if (!title) return;
  createTask({ title: title.slice(0, 200), courseId: current?.course?.id || null });
  $('#quickTaskInput').value = '';
  scheduleRemoteSave();
  refreshTaskUIs();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && taskPanel.open) { e.preventDefault(); closeTaskPanel(); }
});
$('#courseChecklistToggle').addEventListener('click', () => $('#courseChecklistBody').classList.toggle('hidden'));
$('#courseChecklistForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = current?.course;
  const text = $('#courseChecklistInput').value.trim();
  if (!c || !text) return;
  (workspace.checklists[c.id] ||= []).push({ id: 'cl_' + uid(), text: text.slice(0, 300), done: false });
  $('#courseChecklistInput').value = '';
  scheduleRemoteSave();
  renderCourseChecklist();
});

/* roadmaps */
$('#newRoadmapBtn').addEventListener('click', openRoadmapModal);
$('#roadmapForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#roadmapName').value.trim();
  if (!name) return;
  const courseIds = [...$('#roadmapCoursePick').querySelectorAll('input:checked')].map((n) => n.value);
  const id = 'rm_' + uid();
  workspace.roadmaps[id] = { id, title: name.slice(0, 80), courseIds, createdAt: Date.now() };
  hideModal('roadmapModal');
  scheduleRemoteSave();
  location.hash = '#roadmap=' + id;
});
$('#roadmapContinueBtn').addEventListener('click', () => {
  const r = workspace.roadmaps[currentRoadmapId];
  const next = r && roadmapNextCourse(r);
  if (next) location.hash = '#c=' + next.id;
});
$('#roadmapRenameBtn').addEventListener('click', inlineRenameRoadmap);
$('#roadmapDeleteBtn').addEventListener('click', () => {
  const r = workspace.roadmaps[currentRoadmapId];
  if (!r) return;
  if (!confirm(`Delete roadmap "${r.title}"? Your courses and progress are kept.`)) return;
  delete workspace.roadmaps[r.id];
  scheduleRemoteSave();
  location.hash = '';
});
$('#roadmapAddSelect').addEventListener('change', () => {
  const r = workspace.roadmaps[currentRoadmapId];
  const courseId = $('#roadmapAddSelect').value;
  if (!r || !courseId || !courses[courseId] || r.courseIds.includes(courseId)) return;
  r.courseIds.push(courseId);
  scheduleRemoteSave();
  renderRoadmapPage();
});

profileBtn.addEventListener('click', openProfile);
$('#exportDataBtn').addEventListener('click', exportProfileData);
$('#importDataBtn').addEventListener('click', () => {
  const input = $('#importDataInput');
  input.value = '';
  input.click();
});
$('#importDataInput').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (file) importProfileData(file);
});
$('#dashboardRange').addEventListener('change', loadDashboard);
$('#historyMore').addEventListener('click', async () => {
  historyPage++;
  await loadHistory();
});

sideRefreshBtn.addEventListener('click', () => syncCourse());
$('#chaptersToggle').addEventListener('click', () => chaptersSection.classList.toggle('open'));
$('#descToggle').addEventListener('click', () => descSection.classList.toggle('open'));

setupPlayerControls();
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', () => playVideo(current.index - 1));
nextBtn.addEventListener('click', () => playVideo(current.index + 1));
$('#back10').addEventListener('click', () => seekBy(-10));
$('#fwd10').addEventListener('click', () => seekBy(10));
muteBtn.addEventListener('click', toggleMute);
fsBtn.addEventListener('click', toggleFullscreen);
speedSel.addEventListener('change', () => setSpeed(parseFloat(speedSel.value)));

volBar.addEventListener('input', () => {
  volume = Number(volBar.value);
  safe(() => player?.setVolume(volume));
  if (volume > 0) safe(() => player?.unMute());
  muteBtn.innerHTML = volume === 0 ? I.mute : I.vol;
  DB.save('ft_vol', volume);
  scheduleRemoteSave();
});
volBar.value = volume;
volBar.style.setProperty('--fill', volume + '%');
volBar.addEventListener('input', () => volBar.style.setProperty('--fill', volBar.value + '%'));

seekBar.addEventListener('input', () => {
  seeking = true;
  const v = curVideo();
  const dur = safe(() => player?.getDuration()) || v?.durationSeconds || 0;
  curTime.textContent = fmtDuration((seekBar.value / 1000) * dur);
  seekBar.style.setProperty('--fill', seekBar.value / 10 + '%');
});
seekBar.addEventListener('change', () => {
  const v = curVideo();
  const dur = safe(() => player?.getDuration()) || v?.durationSeconds || 0;
  safe(() => player.seekTo((seekBar.value / 1000) * dur, true));
  seeking = false;
});

$('#shield').addEventListener('click', () => {
  if (!controlsRevealOnly) togglePlay();
  controlsRevealOnly = false;
});
$('#shield').addEventListener('dblclick', toggleFullscreen);
$('#posterPlay').addEventListener('click', () => safe(() => player.playVideo()));
pauseOverlay.addEventListener('click', () => safe(() => player.playVideo()));
ccBtn.addEventListener('click', toggleCaptions);
qualitySel.addEventListener('change', () => {
  prefQuality = qualitySel.value;
  DB.save('ft_quality', prefQuality);
  scheduleRemoteSave();
  applyQuality();
});

endedReplay.addEventListener('click', () => {
  clearInterval(endedTimer);
  hideOverlays();
  safe(() => player.seekTo(0, true));
  safe(() => player.playVideo());
});
endedNext.addEventListener('click', () => {
  clearInterval(endedTimer);
  playVideo(nextIndex());
});
endedCancel.addEventListener('click', () => {
  clearInterval(endedTimer);
  endedCountdown.classList.add('hidden');
});
endedCert.addEventListener('click', openCertModal);
$('#errorSkip').addEventListener('click', () => {
  const v = curVideo();
  if (v) markComplete(v.id, { celebrate: false });
  const ni = nextIndex();
  if (ni !== -1) playVideo(ni);
});

npComplete.addEventListener('click', () => {
  const v = curVideo();
  if (v) toggleComplete(v.id);
});
certBtn.addEventListener('click', openCertModal);
$('#certDownload').addEventListener('click', downloadCertificate);

document.querySelectorAll('.modal-close').forEach((b) =>
  b.addEventListener('click', () => hideModal(b.dataset.close))
);
document.querySelectorAll('.modal-backdrop').forEach((m) => {
  const heading = m.querySelector('h2');
  if (heading) {
    if (!heading.id) heading.id = m.id + 'Title';
    m.setAttribute('aria-labelledby', heading.id);
  }
  m.addEventListener('close', () => m.classList.add('hidden'));
  m.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    hideModal(m.id);
  });
  m.addEventListener('click', (e) => {
    if (e.target === m) hideModal(m.id);
  })
});

/* keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable || e.target.closest('button, a, summary, .note-toolbar, .ql-toolbar, .ql-tooltip, .course-notes-toggle, .note-resize-handle, dialog')) return;
  if (!current) return;
  const k = e.key;
  if (k === ' ' || k.toLowerCase() === 'k') {
    e.preventDefault();
    togglePlay();
  } else if (k === 'ArrowLeft') seekBy(-5);
  else if (k === 'ArrowRight') seekBy(5);
  else if (k.toLowerCase() === 'j') seekBy(-10);
  else if (k.toLowerCase() === 'l') seekBy(10);
  else if (k === 'ArrowUp') {
    e.preventDefault();
    volBar.value = Math.min(100, Number(volBar.value) + 5);
    volBar.dispatchEvent(new Event('input'));
  } else if (k === 'ArrowDown') {
    e.preventDefault();
    volBar.value = Math.max(0, Number(volBar.value) - 5);
    volBar.dispatchEvent(new Event('input'));
  } else if (k === '>') stepSpeed(1);
  else if (k === '<') stepSpeed(-1);
  else if (k.toLowerCase() === 'm') toggleMute();
  else if (k.toLowerCase() === 'c') toggleCaptions();
  else if (k.toLowerCase() === 'f') toggleFullscreen();
  else if (k.toLowerCase() === 'n') {
    if (current.index < current.course.videos.length - 1) playVideo(current.index + 1);
  } else if (k.toLowerCase() === 'p') {
    if (current.index > 0) playVideo(current.index - 1);
  } else if (k === '[') sideToggle.click();
});

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => {
  flushActivity({ beacon: true });
});

/* ================= boot ================= */
setupAccountSettings();
setupPasswordSettings();
setupGlassReflection();
notebooks = new Notebooks({
  getUser: () => authUser,
  getCourses: () => courses,
  onPanelToggle: open => saveCourseLayout({ notesOpen: open }),
  getTime(courseId, videoId) {
    if (!playerReady || current?.course.id !== courseId || curVideo()?.id !== videoId || safe(() => player.getVideoData()?.video_id) !== videoId) return null;
    const seconds = safe(() => player.getCurrentTime());
    return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
  },
  onJump: jumpToNote,
  ensureCourseSaved: () => persistRemoteData(),
  showError: message => toast(message, { error: true, ms: 5000 }),
});
for (const event of ['pointerdown', 'keydown', 'scroll']) {
  window.addEventListener(event, () => (lastInteractionAt = Date.now()), { passive: true });
}
setInterval(() => {
  if (authUser && !document.hidden && Date.now() - lastInteractionAt < 120_000) queueSiteSeconds(10);
}, 10_000);
setInterval(() => flushActivity(), 15_000);
setInterval(updatePresence, 30_000);
setInterval(refreshMonitoring, 30_000);
bootAuth();
