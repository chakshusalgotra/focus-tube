/* FocusTube front-end — courses, player, streaks, certificate. */
'use strict';

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

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/* ================= icons ================= */
const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
  b10: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5.5 5.5 0 1 1-5.5 5.5H4.5A7.5 7.5 0 1 0 12 5z"/><text x="8" y="17" font-size="7.5" font-weight="700">10</text></svg>',
  f10: '<svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a5.5 5.5 0 1 0 5.5 5.5h2A7.5 7.5 0 1 1 12 5z"/><text x="8" y="17" font-size="7.5" font-weight="700">10</text></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.25 4.25a7 7 0 0 1-2.25 1.2v2.06a9 9 0 0 0 3.69-1.81L19.7 21l1.3-1.3zM12 4 9.9 6.1 12 8.2z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08a6 6 0 1 1-1.41-6.24L13 11h7V4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zm3-9h2v7H9zm4 0h2v7h-2zM15.5 4l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4zm5.1 5.4c.4 0 .8.2 1 .5l1.3-1.2a3.3 3.3 0 0 0-2.4-1c-2 0-3.4 1.5-3.4 3.3s1.4 3.3 3.4 3.3c1 0 1.8-.4 2.4-1l-1.3-1.2c-.2.3-.6.5-1 .5-1 0-1.6-.7-1.6-1.6s.7-1.6 1.6-1.6zm7 0c.4 0 .8.2 1 .5l1.3-1.2a3.3 3.3 0 0 0-2.4-1c-2 0-3.4 1.5-3.4 3.3s1.4 3.3 3.4 3.3c1 0 1.8-.4 2.4-1l-1.3-1.2c-.2.3-.6.5-1 .5-1 0-1.6-.7-1.6-1.6s.7-1.6 1.6-1.6z"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>',
};

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
let searchType = 'all';
let searchQuery = '';
let searchData = [];
let searchController = null;
let searchBusy = false;
let importingLink = false;
const pendingCourseImports = new Set();
let workspace = defaultWorkspace(); // board columns, tasks, checklists, sprints
let homeMode = 'grid'; // 'grid' | 'board' — persisted in profile settings

const saveCourses = () => scheduleRemoteSave();
const saveStats = () => scheduleRemoteSave();

function settingsSnapshot() {
  return { userName, volume, captionsOn, prefQuality, homeMode };
}

function scheduleRemoteSave() {
  if (!authUser) return;
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
  if (!authUser) return true;
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

function activityBucket(date = todayKey()) {
  if (!pendingActivity.has(date)) {
    const random = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingActivity.set(date, { batchId: random, activeSeconds: 0, watch: new Map() });
  }
  return pendingActivity.get(date);
}

function queueSiteSeconds(seconds) {
  if (authUser) activityBucket().activeSeconds += seconds;
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
  if (!authUser || (!pendingActivity.size && !failedActivityBatches.length)) return true;
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
const resyncBtn = $('#resyncBtn');
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
const coursesHeading = $('#coursesHeading');
const pinnedFilterBtn = $('#pinnedFilterBtn');
const pinnedFilterIcon = $('#pinnedFilterIcon');
const videoListEl = $('#videoList');
const sideTitle = $('#sideTitle');
const sideMeta = $('#sideMeta');
const sideProgressFill = $('#sideProgressFill');
const sideProgressLabel = $('#sideProgressLabel');
const certBtn = $('#certBtn');
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
const boardWrap = $('#boardWrap');
const boardEl = $('#board');
const homeViewToggle = $('#homeViewToggle');
const taskPanel = $('#taskPanel');
const taskPanelBackdrop = $('#taskPanelBackdrop');

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && authUser) queueMicrotask(showAuth);
    const err = new Error(data?.error || 'Request failed.');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* icon injection */
backBtn.innerHTML = I.back;
sideToggle.innerHTML = I.menu;
resyncBtn.innerHTML = I.sync;
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
  window.confetti?.({ particleCount: 90, spread: 75, origin: { y: 0.75 }, ticks: 160 });
}

function bigCelebration() {
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

function setAuthBusy(busy) {
  authBusy = busy;
  $('#authSubmit').disabled = busy;
  $('#guestLogin').disabled = busy;
  $('#loginTab').disabled = busy;
  $('#registerTab').disabled = busy;
}

function setAuthMode(mode) {
  authMode = mode;
  $('#loginTab').classList.toggle('active', mode === 'login');
  $('#registerTab').classList.toggle('active', mode === 'register');
  $('#authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authError').classList.add('hidden');
}

function resetSessionState() {
  sessionGeneration++;
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
  historyItems = [];
  userName = '';
  volume = 100;
  captionsOn = false;
  prefQuality = 'default';
  $('#authPassword').value = '';
  $('#upgradePassword').value = '';
}

function showAuth() {
  authTransition++;
  setAuthBusy(false);
  resetSessionState();
  authUser = null;
  appBooted = false;
  current = null;
  safe(() => player?.stopVideo());
  topbar.classList.add('hidden');
  homeView.classList.add('hidden');
  courseView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  closeTaskPanel();
  $('#taskModal').classList.add('hidden');
  $('#sprintModal').classList.add('hidden');
  $('#roadmapModal').classList.add('hidden');
  authView.classList.remove('hidden');
  document.title = 'Sign in — FocusTube';
}

function updateProfileUI() {
  if (!authUser) return;
  const name = authUser.displayName || authUser.username || 'Guest';
  const initial = name.charAt(0).toUpperCase();
  profileName.textContent = name;
  profileAvatar.textContent = initial;
  $('#profileModalName').textContent = name;
  $('#profileModalAvatar').textContent = initial;
  $('#profileModalType').textContent = authUser.isGuest
    ? 'Guest profile · inactive profiles are removed after 90 days'
    : 'FocusTube account';
  $('#upgradeBlock').classList.toggle('hidden', !authUser.isGuest);
}

async function loadProfileData(transition, userId) {
  const remote = await api('/api/data');
  if (transition !== authTransition || authUser?.id !== userId) return false;
  profileRevision = Number(remote.revision || 0);
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
  homeMode = settings.homeMode === 'board' ? 'board' : 'grid';
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
  resetSessionState();
  authUser = user;
  authView.classList.add('hidden');
  topbar.classList.remove('hidden');
  updateProfileUI();
  try {
    if (!(await loadProfileData(transition, user.id))) return false;
    appBooted = true;
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
    const { user } = await api('/api/auth/me');
    if (transition !== authTransition) return;
    if (user) await finishAuth(user, transition);
    else showAuth();
  } catch {
    showAuth();
    $('#authError').textContent = 'Could not reach the FocusTube server.';
    $('#authError').classList.remove('hidden');
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
  $('#statsModal').classList.remove('hidden');
}

/* ================= home view ================= */
function renderHome() {
  updateSearchLibraryState();
  const all = Object.values(courses);
  const hasBoardContent = all.length > 0 || Object.keys(workspace.tasks).length > 0;
  homeViewToggle.classList.toggle('hidden', !hasBoardContent);
  if (!hasBoardContent && homeMode === 'board') homeMode = 'grid';
  const boardMode = homeMode === 'board';
  $('#gridModeBtn').classList.toggle('active', !boardMode);
  $('#boardModeBtn').classList.toggle('active', boardMode);
  coursesHeading.textContent = boardMode ? 'Your board' : 'Your courses';
  coursesHeading.classList.toggle('hidden', !hasBoardContent);
  boardWrap.classList.toggle('hidden', !boardMode);
  courseGrid.classList.toggle('hidden', boardMode);
  pinnedFilterBtn.classList.toggle('hidden', boardMode || all.length === 0);
  renderRoadmapStrip();
  if (boardMode) return renderBoard();
  const list = (showPinnedOnly ? all.filter((c) => c.pinned) : all).sort(
    (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.addedAt - a.addedAt
  );
  courseGrid.innerHTML = '';
  if (showPinnedOnly && list.length === 0) {
    courseGrid.append(el('p', { class: 'empty-pinned' }, 'No bookmarked courses yet. Pin a course to see it here.'));
    return;
  }
  for (const c of list) {
    const done = c.videos.filter((v) => c.completed[v.id]).length;
    const pct = c.videos.length ? Math.round((done / c.videos.length) * 100) : 0;
    const thumbId = c.videos[0]?.id;
    const card = el(
      'div',
      { class: 'course-card' + (c.pinned ? ' is-pinned' : ''), onclick: () => (location.hash = '#c=' + c.id) },
      c.pinned ? el('div', { class: 'card-pin-badge', html: I.pin }) : null,
      thumbId
        ? el('img', {
            class: 'card-thumb',
            src: `https://i.ytimg.com/vi/${thumbId}/mqdefault.jpg`,
            alt: '',
            loading: 'lazy',
            onerror: (e) => (e.target.style.visibility = 'hidden'),
          })
        : null,
      el(
        'div',
        { class: 'card-body' },
        el('div', { class: 'card-title' }, c.title),
        el('div', { class: 'card-meta' }, `${c.author || 'YouTube'} · ${nVideos(c.videos.length)}`),
        el(
          'div',
          { class: 'card-progress' },
          el(
            'div',
            { class: 'progress-track' },
            el('div', { class: 'progress-fill' + (pct === 100 ? ' full' : ''), style: `width:${pct}%` })
          ),
          el('span', { class: 'card-pct' }, `${pct}%`)
        ),
        el(
          'div',
          { class: 'card-actions' },
          pct === 100
            ? el('span', { class: 'card-done-badge' }, '✓ Completed')
            : el('span', { class: 'card-meta' }, `${done} / ${c.videos.length} done`),
          el(
            'span',
            {},
            el('button', {
              class: 'card-pin' + (c.pinned ? ' active' : ''),
              title: c.pinned ? 'Unpin course' : 'Pin course to top',
              html: I.pin,
              onclick: (e) => {
                e.stopPropagation();
                c.pinned = !c.pinned;
                saveCourses();
                renderHome();
              },
            }),
            el('button', {
              class: 'card-del',
              title: 'Remove course',
              html: I.trash,
              onclick: (e) => {
                e.stopPropagation();
                if (confirm(`Remove "${c.title}"?\nYour progress for it will be deleted.`)) {
                  delete courses[c.id];
                  cleanupCourseWorkspace(c.id);
                  saveCourses();
                  renderHome();
                }
              },
            })
          )
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
  const isLink = isCourseLink(urlInput.value.trim());
  addBtn.textContent = importingLink ? 'Creating course...' : isLink ? 'Create course' : searchBusy ? 'Searching...' : 'Search';
  addBtn.disabled = importingLink || (searchBusy && urlInput.value.trim() === searchQuery);
  urlInput.disabled = importingLink;
  searchFilters.disabled = isLink || importingLink;
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
    '📌 Manual'
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
          pct === 100 ? '✓ Completed' : `${done} / ${c.videos.length} done`
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
      list.length ? `☑ Checklist ${checkedCount}/${list.length}` : '＋ Checklist'
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
  $('#sprintModal').classList.remove('hidden');
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
  if (!homeView.classList.contains('hidden')) renderHome();
  if (!tasksView.classList.contains('hidden')) renderTasksPage();
  if (taskPanel.classList.contains('open')) renderTaskPanel();
  if (current?.course && !courseView.classList.contains('hidden')) renderCourseChecklist();
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
  $('#taskModal').classList.remove('hidden');
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
      el('p', { class: 'empty-state' }, 'No tasks here yet. Add one with “＋ New task” — you can link it to a course.')
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
    { class: 'task-row' + (t.status === 'done' ? ' done' : ''), onclick: () => openTaskModal(t.id) },
    taskCheckButton(t),
    el(
      'div',
      { class: 'task-row-main' },
      el('div', { class: 'task-row-title' }, t.title),
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
  taskPanel.classList.add('open');
  taskPanel.setAttribute('aria-hidden', 'false');
  taskPanelBackdrop.classList.remove('hidden');
  renderTaskPanel();
  $('#quickTaskInput').focus();
}

function closeTaskPanel() {
  taskPanel.classList.remove('open');
  taskPanel.setAttribute('aria-hidden', 'true');
  taskPanelBackdrop.classList.add('hidden');
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
  section.classList.toggle('hidden', !hasCourses && !list.length);
  strip.innerHTML = '';
  if (!list.length) {
    strip.append(
      el('p', { class: 'empty-state' }, 'Group courses into an ordered learning path with combined progress.')
    );
    return;
  }
  for (const r of list) {
    const { total, done, pct } = roadmapStats(r);
    const courseCount = r.courseIds.filter((id) => courses[id]).length;
    strip.append(
      el(
        'div',
        { class: 'roadmap-card', onclick: () => (location.hash = '#roadmap=' + r.id) },
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
    pct === 100 && total ? '🎉 All done' : next ? `▶ Continue: ${next.title.slice(0, 28)}${next.title.length > 28 ? '…' : ''}` : '▶ Continue';

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
    const control = (dir, glyph, label) => {
      const target = index + dir;
      return el(
        'button',
        {
          class: 'card-move',
          type: 'button',
          title: label,
          disabled: target < 0 || target >= r.courseIds.length ? '' : null,
          onclick: (e) => {
            e.stopPropagation();
            if (target < 0 || target >= r.courseIds.length) return;
            [r.courseIds[index], r.courseIds[target]] = [r.courseIds[target], r.courseIds[index]];
            scheduleRemoteSave();
            renderRoadmapPage();
          },
        },
        glyph
      );
    };
    wrap.append(
      el(
        'div',
        { class: 'roadmap-course' + (cPct === 100 ? ' done' : ''), onclick: () => (location.hash = '#c=' + c.id) },
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
          'div',
          { class: 'roadmap-course-main' },
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
          control(-1, '▲', 'Move earlier'),
          control(1, '▼', 'Move later'),
          el(
            'button',
            {
              class: 'card-move',
              type: 'button',
              title: 'Remove from roadmap (keeps the course)',
              onclick: (e) => {
                e.stopPropagation();
                r.courseIds.splice(index, 1);
                scheduleRemoteSave();
                renderRoadmapPage();
              },
            },
            '✕'
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
  $('#roadmapModal').classList.remove('hidden');
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
  pauseOverlay.classList.remove('peek');
  endedOverlay.classList.add('hidden');
  errorOverlay.classList.add('hidden');
  clearInterval(endedTimer);
}

/** Fresh pause cover: bars shown (any previous "peek" is reset). */
function showPauseCover() {
  pauseOverlay.classList.remove('peek');
  pauseOverlay.classList.remove('hidden');
}

function overlaysAllHidden() {
  return [posterOverlay, pauseOverlay, endedOverlay, errorOverlay].every((o) =>
    o.classList.contains('hidden')
  );
}

function onPlayerState(e) {
  if (!current) return;
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

let pendingLoad = null; // queued {index, cue} while the player is still booting

function playVideo(i, { cue = false } = {}) {
  const c = current?.course;
  if (!c || i < 0 || i >= c.videos.length) return;
  const v = c.videos[i];
  current.index = i;
  completedAutoGuard = !!c.completed[v.id];
  endedHandled = false;
  unstartedTicks = 0;
  c.lastVideoId = v.id;
  saveCourses();
  hideOverlays();

  if (playerReady) {
    const saved = Math.floor(c.positions[v.id] || 0);
    const startAt = saved > 8 && saved < (v.durationSeconds || Infinity) - 20 ? saved - 3 : 0;
    if (cue) safe(() => player.cueVideoById({ videoId: v.id, startSeconds: startAt }));
    else safe(() => player.loadVideoById({ videoId: v.id, startSeconds: startAt }));
    safe(() => player.setPlaybackRate(c.speed || 1));
  } else {
    pendingLoad = { index: i, cue };
  }
  if (cue || !playerReady) {
    posterTitle.textContent = v.title;
    posterOverlay.classList.remove('hidden');
  }
  speedSel.value = String(c.speed || 1);

  updateNowPlaying();
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
  endedTitle.textContent = allDone ? 'Course complete! 🏆' : 'Video complete!';

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
  const total = c.videos.reduce((a, v) => a + (v.durationSeconds || 0), 0);
  sideMeta.textContent = `${c.author || 'YouTube'} · ${nVideos(c.videos.length)} · ${fmtLong(total)}`;

  videoListEl.innerHTML = '';
  rowEls = [];
  c.videos.forEach((v, i) => {
    const row = el(
      'li',
      { class: 'video-row', onclick: () => playVideo(i) },
      el('button', {
        class: 'check',
        title: 'Toggle complete',
        html: I.check,
        onclick: (e) => {
          e.stopPropagation();
          toggleComplete(v.id);
        },
      }),
      el(
        'div',
        { class: 'row-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'row-num' }, String(i + 1)), v.title),
        el('div', { class: 'row-sub' }, fmtDuration(v.durationSeconds))
      )
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
  });

  sideProgressFill.style.width = pct + '%';
  sideProgressFill.classList.toggle('full', pct === 100);
  const remaining = c.videos.filter((v) => !c.completed[v.id]).reduce((a, v) => a + (v.durationSeconds || 0), 0);
  sideProgressLabel.innerHTML = `<span>${done} / ${c.videos.length} completed</span><span>${
    pct === 100 ? 'done! 🎉' : fmtLong(remaining) + ' left'
  }</span>`;

  certBtn.disabled = pct !== 100;
  certBtn.textContent = pct === 100 ? '🏆 Get your certificate' : '🏆 Finish every video to unlock';

  const v = curVideo();
  if (v) {
    const isDone = !!c.completed[v.id];
    npComplete.textContent = isDone ? '✓ Completed' : '✓ Mark complete';
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

function renderDashboardCharts(daily, split) {
  destroyCharts();
  if (!window.Chart) {
    $('.chart-wrap').textContent = 'Charts need an internet connection the first time.';
    return;
  }
  const grid = 'rgba(139, 147, 167, 0.12)';
  const ticks = '#8b93a7';
  const common = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: ticks, usePointStyle: true, pointStyle: 'circle' } } },
  };
  dailyChart = new Chart($('#dailyChart'), {
    type: 'bar',
    data: {
      labels: daily.map((row) => dateLabel(row.date)),
      datasets: [
        {
          label: 'On FocusTube',
          data: daily.map((row) => Math.round(row.activeSeconds / 60)),
          backgroundColor: 'rgba(47, 213, 123, 0.72)',
          borderRadius: 3,
        },
        {
          label: 'Watching video',
          data: daily.map((row) => Math.round(row.watchSeconds / 60)),
          backgroundColor: 'rgba(124, 92, 255, 0.78)',
          borderRadius: 3,
        },
      ],
    },
    options: {
      ...common,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: false, grid: { display: false }, ticks: { color: ticks, maxTicksLimit: 12 } },
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: ticks }, title: { display: true, text: 'minutes', color: ticks } },
      },
    },
  });
  const colors = ['#7c5cff', '#2fd57b', '#ffb74d', '#6ea8ff', '#ff6b8a', '#66c7c2', '#c0a1ff'];
  courseChart = new Chart($('#courseChart'), {
    type: 'doughnut',
    data: {
      labels: split.map((row) => row.courseTitle),
      datasets: [{ data: split.map((row) => Math.round(row.seconds / 60)), backgroundColor: colors, borderColor: '#12151d', borderWidth: 3 }],
    },
    options: {
      ...common,
      cutout: '66%',
      plugins: {
        ...common.plugins,
        legend: { position: 'bottom', labels: { color: ticks, usePointStyle: true, boxWidth: 8 } },
      },
    },
  });
}

function renderDashboardHeatmap(daily) {
  const target = $('#dashboardHeatmap');
  target.innerHTML = '';
  const map = new Map(daily.map((row) => [row.date, row.activeSeconds]));
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 7 * 19);
  for (let i = 0; i < 140; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = todayKey(date);
    const mins = Number(map.get(key) || 0) / 60;
    const level = mins >= 60 ? 4 : mins >= 30 ? 3 : mins >= 10 ? 2 : mins >= 1 ? 1 : 0;
    target.append(
      el('i', {
        class: `hm-cell l${level}${date > today ? ' future' : ''}`,
        title: `${key} — ${Math.round(mins)} min`,
      })
    );
  }
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
        'div',
        { class: 'dashboard-course', onclick: () => (location.hash = '#c=' + course.id) },
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
  current = null;
  safe(() => player?.stopVideo());
  homeView.classList.add('hidden');
  courseView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  resyncBtn.classList.add('hidden');
  document.title = 'Learning dashboard — FocusTube';
  loadDashboard();
}

function showTasks() {
  current = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  homeView.classList.add('hidden');
  courseView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  tasksView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  resyncBtn.classList.add('hidden');
  document.title = 'Tasks — FocusTube';
  renderTasksPage();
}

function showRoadmap(id) {
  current = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  homeView.classList.add('hidden');
  courseView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.add('hidden');
  resyncBtn.classList.add('hidden');
  currentRoadmapId = id;
  renderRoadmapPage();
}

/* ================= view switching ================= */
function showHome() {
  current = null;
  safe(() => player?.stopVideo());
  hideOverlays();
  courseView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  homeView.classList.remove('hidden');
  backBtn.classList.add('hidden');
  sideToggle.classList.add('hidden');
  resyncBtn.classList.add('hidden');
  document.title = 'FocusTube — distraction-free courses';
  renderHome();
  renderStreakChip();
}

async function openCourse(id) {
  const c = courses[id];
  if (!c) return showHome();
  current = { course: c, index: 0 };
  homeView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  tasksView.classList.add('hidden');
  roadmapView.classList.add('hidden');
  courseView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  sideToggle.classList.remove('hidden');
  resyncBtn.classList.remove('hidden');
  document.body.classList.toggle('side-collapsed', window.innerWidth < 900);
  renderSidebar(c);
  renderCourseChecklist();
  let idx = c.videos.findIndex((v) => v.id === c.lastVideoId);
  if (idx === -1) idx = c.videos.findIndex((v) => !c.completed[v.id]);
  playVideo(Math.max(0, idx), { cue: true }); // UI renders immediately; player load is queued
  // Auto-refresh: quietly pull newly added playlist videos (at most once a minute).
  if (!c.lastSyncedAt || Date.now() - c.lastSyncedAt > 60_000) syncCourse({ silent: true });
  ensurePlayer()
    .then(() => {
      if (pendingLoad && current?.course === c) {
        const p = pendingLoad;
        pendingLoad = null;
        playVideo(p.index, { cue: p.cue });
      }
    })
    .catch(() => toast('Video player failed to load — check your connection and reload.', { error: true }));
}

function route() {
  if (!appBooted) return;
  if (location.hash === '#dashboard') return showDashboard();
  if (location.hash === '#tasks') return showTasks();
  const rm = location.hash.match(/^#roadmap=(.+)$/);
  if (rm && workspace.roadmaps[rm[1]]) return showRoadmap(rm[1]);
  const m = location.hash.match(/^#c=(.+)$/);
  if (m && courses[m[1]]) openCourse(m[1]);
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

  // Self-healing overlays: even if a state event was missed, YouTube's own
  // UI (More videos, logo, title…) must never stay visible.
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
  $('#certModal').classList.remove('hidden');
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
  resyncBtn.disabled = true;
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
    resyncBtn.disabled = false;
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
function openProfile() {
  updateProfileUI();
  $('#profileModal').classList.remove('hidden');
}

async function exportProfileData() {
  const button = $('#exportDataBtn');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing export…';
  try {
    const activitySaved = await flushActivity();
    const profileSaved = await persistRemoteData();
    if (!activitySaved || !profileSaved) {
      throw new Error('Could not sync the latest progress. Check your connection and try again.');
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
    if (imported?.schema !== 'focustube-user-export' || imported?.schemaVersion !== 1) {
      throw new Error('Choose a FocusTube user export (schema version 1).');
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
        `Import ${courseCount} course(s) and ${historyCount} watch-history record(s) from "${file.name}"?\n\n` +
          'This replaces the data in your current profile. Your username and password will not change.'
      )
    ) {
      return;
    }

    button.disabled = true;
    exportButton.disabled = true;
    button.textContent = 'Importing…';
    const activitySaved = await flushActivity();
    const profileSaved = await persistRemoteData();
    if (!activitySaved || !profileSaved) {
      throw new Error('Could not sync the latest progress. Check your connection and try again.');
    }
    const result = await api(`/api/import?revision=${profileRevision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(imported),
    });
    button.textContent = 'Import complete';
    $('#profileModal').classList.add('hidden');
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
$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (authBusy) return;
  const transition = ++authTransition;
  const error = $('#authError');
  setAuthBusy(true);
  error.classList.add('hidden');
  try {
    const result = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#authUsername').value.trim(), password: $('#authPassword').value }),
    });
    if (transition !== authTransition) return;
    $('#authPassword').value = '';
    await finishAuth(result.user, transition);
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  } finally {
    if (transition === authTransition) setAuthBusy(false);
  }
});
$('#guestLogin').addEventListener('click', async () => {
  if (authBusy) return;
  const transition = ++authTransition;
  setAuthBusy(true);
  try {
    const result = await api('/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (transition !== authTransition) return;
    await finishAuth(result.user, transition);
  } catch (err) {
    $('#authError').textContent = err.message;
    $('#authError').classList.remove('hidden');
  } finally {
    if (transition === authTransition) setAuthBusy(false);
  }
});
$('#upgradeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#upgradeError');
  error.classList.add('hidden');
  try {
    const result = await api('/api/auth/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#upgradeUsername').value.trim(), password: $('#upgradePassword').value }),
    });
    authUser = result.user;
    updateProfileUI();
    $('#upgradeBlock').classList.add('hidden');
    toast('Guest progress is now saved to your account ✓');
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});
$('#logoutBtn').addEventListener('click', async () => {
  const activitySaved = await flushActivity();
  const profileSaved = await persistRemoteData();
  if (!activitySaved || !profileSaved) {
    toast('Could not sync everything yet. Check your connection before signing out.', { error: true });
    return;
  }
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  $('#profileModal').classList.add('hidden');
  location.hash = '';
  showAuth();
});

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
backBtn.addEventListener('click', () => (location.hash = ''));
sideToggle.addEventListener('click', () => document.body.classList.toggle('side-collapsed'));
$('#streakChip').addEventListener('click', () => (location.hash = '#dashboard'));
dashboardBtn.addEventListener('click', () => (location.hash = '#dashboard'));

/* board & tasks */
function setHomeMode(mode) {
  if (homeMode === mode) return;
  homeMode = mode;
  scheduleRemoteSave();
  renderHome();
}
$('#gridModeBtn').addEventListener('click', () => setHomeMode('grid'));
$('#boardModeBtn').addEventListener('click', () => setHomeMode('board'));
$('#statusBoardBtn').addEventListener('click', () => {
  if (workspace.board.mode === 'status') return;
  workspace.board.mode = 'status';
  scheduleRemoteSave();
  renderBoard();
});
$('#sprintBoardBtn').addEventListener('click', () => {
  if (workspace.board.mode === 'sprint') return;
  workspace.board.mode = 'sprint';
  scheduleRemoteSave();
  renderBoard();
});
$('#addColumnBtn').addEventListener('click', addCustomColumn);
$('#sprintSetupBtn').addEventListener('click', openSprintModal);
$('#newTaskBtn').addEventListener('click', () => openTaskModal());
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
  $('#taskModal').classList.add('hidden');
  scheduleRemoteSave();
  refreshTaskUIs();
});
$('#taskDeleteBtn').addEventListener('click', () => {
  const t = editingTaskId ? workspace.tasks[editingTaskId] : null;
  if (!t || !confirm(`Delete "${t.title}"?`)) return;
  deleteTask(t.id);
  editingTaskId = null;
  $('#taskModal').classList.add('hidden');
  scheduleRemoteSave();
  refreshTaskUIs();
});
$('#sprintForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cadence = $('#sprintCadence').value;
  const count = Math.max(1, Math.min(12, Number($('#sprintCount').value) || 4));
  const start = /^\d{4}-\d{2}-\d{2}$/.test($('#sprintStart').value) ? $('#sprintStart').value : todayKey();
  generateSprints(cadence, count, start);
  $('#sprintModal').classList.add('hidden');
  scheduleRemoteSave();
  renderBoard();
});
$('#sprintClearBtn').addEventListener('click', () => {
  if (!confirm('Remove all sprints? Card assignments to sprints will be cleared.')) return;
  workspace.sprints.items = [];
  workspace.sprints.assignments = {};
  $('#sprintModal').classList.add('hidden');
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
taskPanelBackdrop.addEventListener('click', closeTaskPanel);
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
  if (e.key === 'Escape' && taskPanel.classList.contains('open')) closeTaskPanel();
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
  $('#roadmapModal').classList.add('hidden');
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

resyncBtn.addEventListener('click', () => syncCourse());
sideRefreshBtn.addEventListener('click', () => syncCourse());
$('#chaptersToggle').addEventListener('click', () => chaptersSection.classList.toggle('open'));
$('#descToggle').addEventListener('click', () => descSection.classList.toggle('open'));

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

$('#shield').addEventListener('click', togglePlay);
$('#shield').addEventListener('dblclick', toggleFullscreen);
$('#posterPlay').addEventListener('click', () => safe(() => player.playVideo()));
pauseOverlay.addEventListener('click', () => safe(() => player.playVideo()));
$('#peekBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  pauseOverlay.classList.add('peek');
});
$('#peekRestore').addEventListener('click', (e) => {
  e.stopPropagation();
  pauseOverlay.classList.remove('peek');
});
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
  b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden'))
);
document.querySelectorAll('.modal-backdrop').forEach((m) =>
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.add('hidden');
  })
);

/* keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
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
  } else if (k === '[') document.body.classList.toggle('side-collapsed');
});

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => {
  flushActivity({ beacon: true });
});

/* ================= boot ================= */
for (const event of ['pointerdown', 'keydown', 'scroll']) {
  window.addEventListener(event, () => (lastInteractionAt = Date.now()), { passive: true });
}
setInterval(() => {
  if (authUser && !document.hidden && Date.now() - lastInteractionAt < 120_000) queueSiteSeconds(10);
}, 10_000);
setInterval(() => flushActivity(), 15_000);
bootAuth();
