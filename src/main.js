// Electron main process: window, offline enforcement, IPC handlers.
// All persistence and all scoring happen here; the renderer never holds
// answer keys for a live attempt.
const { app, BrowserWindow, ipcMain, protocol, net, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const url = require('url');

const db = require('./db');
const content = require('./content');
const analytics = require('./analytics');

const DEFAULT_SETTINGS = {
  baseMinutes: 75,
  extraTimePercent: 25,     // 75 * 1.25 = 93:00
  breakMinutes: 15,
  hideTimer: false,
  darkMode: false,
  sound: true,
};

let mainWindow = null;

// ---------- offline enforcement ----------
// Nothing in this app may reach the network. Anything that is not a local
// file or our own image protocol is cancelled and logged.
const blockedRequests = [];

function enforceOffline(ses) {
  const allowed = /^(file:|devtools:|tmua-img:|blob:|data:|chrome-extension:)/i;
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (allowed.test(details.url)) return callback({ cancel: false });
    blockedRequests.push({ url: details.url, at: Date.now() });
    console.warn('[offline] blocked outbound request:', details.url);
    callback({ cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

// ---------- image protocol ----------
// Question and solution PNGs live outside the asar/app dir, so they are
// served through a scheme restricted to known question ids.
function registerImageProtocol() {
  protocol.handle('tmua-img', (request) => {
    const u = new URL(request.url);
    const kind = u.hostname;                       // 'question' | 'solution'
    const id = decodeURIComponent(u.pathname).replace(/^\//, '');
    const file = content.imageFileFor(kind, id);
    if (!file || !fs.existsSync(file)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(url.pathToFileURL(file).toString());
  });
}

// ---------- exam helpers ----------

// Whole minutes, rounded down: 75 min + 25% extra time = 93:00 (not 93:45).
function allowedMinutes(settings) {
  const base = Number(settings.baseMinutes ?? DEFAULT_SETTINGS.baseMinutes);
  const extra = Number(settings.extraTimePercent ?? DEFAULT_SETTINGS.extraTimePercent);
  return Math.max(1, Math.floor(base * (1 + extra / 100)));
}
function allowedSeconds(settings) {
  return allowedMinutes(settings) * 60;
}

function currentSettings() {
  return { ...DEFAULT_SETTINGS, ...db.getSettings() };
}

function attemptPayload(attempt, { reveal }) {
  const questions = attempt.questions.map(q => {
    const meta = content.get(q.question_id);
    const view = reveal ? content.fullQuestion(meta) : content.publicQuestion(meta);
    return {
      position: q.position,
      selected: q.selected,
      flagged: Boolean(q.flagged),
      confidence: q.confidence,
      timeSpent: q.time_spent,
      notepad: q.notepad,
      correct: q.correct === null ? null : Boolean(q.correct),
      question: view,
    };
  });
  const remaining = attempt.allowed_sec === null
    ? null
    : Math.max(0, attempt.allowed_sec - attempt.elapsed_sec);
  return {
    id: attempt.id, mode: attempt.mode, year: attempt.year, paper: attempt.paper,
    mockGroup: attempt.mock_group, status: attempt.status, label: attempt.label,
    allowedSec: attempt.allowed_sec, elapsedSec: attempt.elapsed_sec,
    remainingSec: remaining, currentIndex: attempt.current_index,
    finishReason: attempt.finish_reason, scoreRaw: attempt.score_raw,
    scoreScaled: attempt.score_scaled, startedAt: attempt.started_at,
    completedAt: attempt.completed_at, questions,
  };
}

function scoreAttempt(attempt, reason, elapsedSec) {
  const marks = attempt.questions.map(q => {
    const meta = content.get(q.question_id);
    return { position: q.position, correct: Boolean(q.selected && meta && q.selected === meta.answer) };
  });
  const raw = marks.filter(m => m.correct).length;
  let scaled = null;
  if (attempt.mode !== 'drill' && attempt.year && attempt.paper && attempt.questions.length === 20) {
    scaled = content.scaledScore(attempt.year, attempt.paper, raw);
  }
  return db.finishAttempt(attempt.id, {
    reason, elapsedSec: elapsedSec ?? attempt.elapsed_sec, marks, scoreRaw: raw, scoreScaled: scaled,
  });
}

// ---------- IPC ----------

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return { ok: false, error: err.message };
    }
  });

  handle('catalog', () => ({
    papers: content.papers(),
    taxonomy: content.getTaxonomy(),
    conversions: Object.fromEntries(content.papers().map(p => [p.year, content.hasConversion(p.year)])),
    settings: currentSettings(),
    dbPath: db.getDbPath(),
    counts: { questions: content.all().length },
  }));

  handle('settings:get', () => currentSettings());
  handle('settings:set', (patch) => {
    for (const [k, v] of Object.entries(patch)) db.setSetting(k, v);
    return currentSettings();
  });

  handle('attempt:resumable', () => db.inProgressAttempts()
    .map(a => attemptPayload(a, { reveal: false })));

  handle('attempt:start', ({ mode, year, paper, questionIds, mockGroup, label, untimed, allowedSec }) => {
    const settings = currentSettings();
    let ids = questionIds;
    if (!ids) ids = content.paperQuestions(year, paper).map(q => q.id);
    if (!ids.length) throw new Error('No questions matched');
    const timed = mode !== 'untimed' && !untimed;
    // allowedSec is an explicit override used by the verification suite to
    // exercise timer expiry; the UI never passes it.
    const seconds = Number.isFinite(allowedSec) ? allowedSec : allowedSeconds(settings);
    const attempt = db.createAttempt({
      mode, year, paper, mockGroup, label,
      allowedSec: timed ? seconds : null,
      questionIds: ids,
      settings: { baseMinutes: settings.baseMinutes, extraTimePercent: settings.extraTimePercent },
    });
    return attemptPayload(attempt, { reveal: false });
  });

  handle('attempt:get', (id) => {
    const a = db.getAttempt(id);
    if (!a) throw new Error('Attempt not found');
    return attemptPayload(a, { reveal: a.status === 'completed' });
  });

  handle('attempt:answer', ({ attemptId, position, selected, confidence }) => {
    db.saveAnswer(attemptId, position, { selected, confidence });
    return true;
  });
  handle('attempt:confidence', ({ attemptId, position, confidence }) => {
    db.setConfidence(attemptId, position, confidence);
    return true;
  });
  handle('attempt:flag', ({ attemptId, position, flagged }) => {
    db.setFlag(attemptId, position, flagged);
    return true;
  });
  handle('attempt:notepad', ({ attemptId, position, text }) => {
    db.setNotepad(attemptId, position, text);
    return true;
  });
  handle('attempt:heartbeat', ({ attemptId, elapsedSec, currentIndex, questionTime }) => {
    db.heartbeat(attemptId, { elapsedSec, currentIndex, questionTime });
    return true;
  });

  handle('attempt:finish', ({ attemptId, reason, elapsedSec }) => {
    const a = db.getAttempt(attemptId);
    if (!a) throw new Error('Attempt not found');
    if (a.status === 'completed') return attemptPayload(a, { reveal: true });
    const done = scoreAttempt(a, reason || 'submitted', elapsedSec);
    return attemptPayload(done, { reveal: true });
  });

  handle('attempt:abandon', (attemptId) => { db.abandonAttempt(attemptId); return true; });
  handle('attempt:delete', (attemptId) => { db.deleteAttempt(attemptId); return true; });

  handle('history:list', () => {
    const attempts = db.listAttemptsFull();
    return attempts.map(a => ({
      id: a.id, mode: a.mode, year: a.year, paper: a.paper, status: a.status,
      label: a.label, mockGroup: a.mock_group,
      startedAt: a.started_at, completedAt: a.completed_at,
      allowedSec: a.allowed_sec, elapsedSec: a.elapsed_sec,
      scoreRaw: a.score_raw, scoreScaled: a.score_scaled,
      finishReason: a.finish_reason, total: a.questions.length,
    }));
  });

  handle('analytics:dashboard', () => analytics.dashboard(db.listAttemptsFull()));

  handle('revisit:list', () => db.revisitList().map(r => {
    const meta = content.get(r.question_id);
    return {
      questionId: r.question_id, addedAt: r.added_at, note: r.note,
      year: meta.year, paper: meta.paper, number: meta.number, topics: meta.topics,
    };
  }));
  handle('revisit:add', ({ questionId, note }) => { db.revisitAdd(questionId, note); return true; });
  handle('revisit:remove', (questionId) => { db.revisitRemove(questionId); return true; });

  // Build a custom drill set from filters.
  handle('drill:build', (filters) => {
    const attempts = db.listAttemptsFull().filter(a => a.status === 'completed');
    const wrong = new Set();
    const flagged = new Set();
    for (const a of attempts) {
      for (const q of a.questions) {
        if (q.correct === 0) wrong.add(q.question_id);
        if (q.flagged) flagged.add(q.question_id);
      }
    }
    const revisit = new Set(db.revisitList().map(r => r.question_id));
    let pool = content.all();
    if (filters.source === 'wrong') pool = pool.filter(q => wrong.has(q.id));
    else if (filters.source === 'flagged') pool = pool.filter(q => flagged.has(q.id));
    else if (filters.source === 'revisit') pool = pool.filter(q => revisit.has(q.id));
    if (filters.topics && filters.topics.length) {
      pool = pool.filter(q => q.topics.some(t => filters.topics.includes(t)));
    }
    if (filters.years && filters.years.length) pool = pool.filter(q => filters.years.includes(q.year));
    if (filters.papers && filters.papers.length) {
      pool = pool.filter(q => filters.papers.includes(q.paper));
    }
    const ids = pool.map(q => q.id);
    if (filters.shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }
    const limited = filters.limit ? ids.slice(0, filters.limit) : ids;
    return { ids: limited, available: ids.length };
  });

  handle('mock:next', ({ mockGroup, year }) => {
    const attempts = db.listAttempts().filter(a => a.mock_group === mockGroup);
    const donePapers = new Set(attempts.filter(a => a.status === 'completed').map(a => a.paper));
    if (donePapers.has(1) && !donePapers.has(2)) return { next: 2, year };
    return { next: null, year };
  });

  handle('mock:summary', (mockGroup) => {
    const attempts = db.listAttemptsFull()
      .filter(a => a.mock_group === mockGroup && a.status === 'completed')
      .sort((a, b) => a.paper - b.paper);
    if (!attempts.length) return null;
    const rawTotal = attempts.reduce((s, a) => s + (a.score_raw || 0), 0);
    const year = attempts[0].year;
    return {
      year,
      papers: attempts.map(a => ({
        id: a.id, paper: a.paper, raw: a.score_raw, scaled: a.score_scaled,
        total: a.questions.length,
      })),
      rawTotal,
      overallScaled: attempts.length === 2 ? content.overallScaled(year, rawTotal) : null,
    };
  });

  // Dialog-free forms: used by the verification suite, and by the dialog
  // handlers below so both paths share one implementation.
  handle('data:exportPayload', () => db.exportAll());
  handle('data:importPayload', (payload) => db.importAll(payload));

  handle('data:export', async () => {
    const payload = db.exportAll();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export TMUA history',
      defaultPath: `tmua-history-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return { canceled: false, filePath, attempts: payload.attempts.length };
  });

  handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import TMUA history (replaces current history)',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const payload = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const res = db.importAll(payload);
    return { canceled: false, ...res };
  });

  handle('data:reveal', () => {
    shell.showItemInFolder(db.getDbPath());
    return true;
  });

  // used by the offline test
  handle('debug:blockedRequests', () => blockedRequests);
}

// ---------- app lifecycle ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900, minWidth: 900, minHeight: 640,
    backgroundColor: '#0f172a',
    title: 'TMUA Simulator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  // never navigate anywhere but our own page; never open external windows
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'tmua-img', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
]);

app.whenReady().then(() => {
  db.init(app.getPath('userData'));
  content.init({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  enforceOffline(session.defaultSession);
  registerImageProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // WAL + write-through means there is nothing to flush, but close cleanly
  try { db.close(); } catch { /* ignore */ }
});
