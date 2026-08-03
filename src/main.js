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
const coach = require('./coach');
const srs = require('./srs');
const checklist = require('./checklist');
const pdf = require('./pdf');

const DEFAULT_SETTINGS = {
  baseMinutes: 75,
  extraTimePercent: 25,     // 75 * 1.25 = 93:00
  breakMinutes: 15,
  hideTimer: false,
  darkMode: false,
  sound: true,
  ...require('./coach').DEFAULTS,
};

let mainWindow = null;
const UNDO_WINDOW_MS = 30000;   // how long a delete stays undoable
let rebuildDerivedRef = () => {};

// Injectable clock. Production always reads the real time; the verification
// suite freezes it so date-dependent logic (countdowns, spaced repetition,
// study phases) is deterministic instead of flaky.
let clockOffset = 0;
let clockFixed = null;
function nowMs() {
  return clockFixed !== null ? clockFixed : Date.now() + clockOffset;
}

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

// Where an attempt came from, so history can always tell exam conditions from
// a relaxed drill.
const SOURCE_LABELS = {
  paper: 'Timed paper', mock: 'Full mock', untimed: 'Untimed practice',
  drill: 'Drill', review: 'Review session', offline: 'Sat on paper',
};
function sourceOf({ mode, label }) {
  if (mode === 'mock') return 'mock';
  if (mode === 'untimed') return 'untimed';
  if (mode === 'drill') return /^Review /.test(label || '') ? 'review' : 'drill';
  return 'paper';
}

function currentSettings() {
  return { ...DEFAULT_SETTINGS, ...db.getSettings() };
}

function attemptPayload(attempt, { reveal }) {
  const times = attempt.questions.map(q => q.time_spent).filter(t => t > 0).sort((a, b) => a - b);
  const medianTime = times.length ? times[Math.floor(times.length / 2)] : 0;
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
      errorType: q.error_type || null,
      suggestedError: reveal && q.correct === 0 ? coach.suggestErrorType(q, medianTime) : null,
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
  const done = db.finishAttempt(attempt.id, {
    reason, elapsedSec: elapsedSec ?? attempt.elapsed_sec, marks, scoreRaw: raw, scoreScaled: scaled,
  });
  updateReviewQueue(done, nowMs());
  return done;
}

// Every scored attempt feeds the spaced-repetition queue: wrong answers enter
// (or reset), correct ones advance the schedule, flags enter at low priority.
function updateReviewQueue(attempt, now = Date.now()) {
  for (const q of attempt.questions) {
    const meta = content.get(q.question_id);
    if (!meta) continue;
    const correct = q.correct === null ? null : Boolean(q.correct);
    let source = null;
    if (correct === false) {
      source = q.confidence === 'sure' ? 'sure_wrong' : 'wrong';
    } else if (q.flagged) {
      source = 'flag';
    }
    const existing = db.reviewGet(q.question_id);
    // a correct answer only matters if the question is already being tracked
    if (!existing && correct !== false && !q.flagged) continue;
    const row = srs.applyResult(existing, {
      questionId: q.question_id,
      source: source || (existing ? existing.source : 'wrong'),
      correct,
      now,
    });
    db.reviewUpsert(row);
    // A miss is a miss whatever produced it — a drill answer is not a lesser
    // event than a paper answer, so it lands on the revisit list too.
    if (correct === false || q.flagged) db.revisitAdd(q.question_id, null);
  }
  // anything on the manual revisit list is tracked too, at low priority
  for (const r of db.revisitList()) {
    if (!db.reviewGet(r.question_id)) {
      db.reviewUpsert(srs.applyResult(null, {
        questionId: r.question_id, source: 'revisit', correct: null, now,
      }));
    }
  }
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
    // Validate before writing: a zero, negative or absurd timer would produce
    // an unusable exam, so bad values are rejected rather than clamped
    // silently.
    const numeric = {
      baseMinutes: [1, 300],
      extraTimePercent: [0, 200],
      breakMinutes: [0, 120],
    };
    const boolean = ['hideTimer', 'darkMode', 'sound', 'accessArranged', 'examBooked'];
    const dates = ['examDate', 'examWindowEnd', 'resultsDate'];
    const isoish = ['accessDeadline', 'bookingDeadline'];
    for (const [k, v] of Object.entries(patch)) {
      if (numeric[k]) {
        const [lo, hi] = numeric[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new Error(`${k} must be a number`);
        }
        if (v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
      } else if (k === 'targetScore') {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 9) {
          throw new Error('targetScore must be between 1.0 and 9.0');
        }
      } else if (dates.includes(k)) {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)
            || Number.isNaN(Date.parse(`${v}T09:00:00`))) {
          throw new Error(`${k} must be a date as YYYY-MM-DD`);
        }
      } else if (isoish.includes(k)) {
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
          throw new Error(`${k} must be a valid date-time`);
        }
      } else if (boolean.includes(k)) {
        if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
      } else {
        throw new Error(`unknown setting '${k}'`);
      }
    }
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
      source: sourceOf({ mode, label }),
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
    const before = db.getAttempt(attemptId);
    const prev = before && before.questions[position] ? before.questions[position].selected : null;
    db.saveAnswer(attemptId, position, { selected, confidence });
    // a change is replacing one letter with a different letter, not first entry
    if (prev && selected && prev !== selected) {
      db.logAnswerChange({
        attemptId, position, questionId: before.questions[position].question_id,
        from: prev, to: selected,
      });
    }
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

  handle('history:list', ({ archiveId } = {}) => {
    const attempts = db.attemptsScoped(archiveId);
    return attempts.map(a => ({
      id: a.id, mode: a.mode, year: a.year, paper: a.paper, status: a.status,
      label: a.label, mockGroup: a.mock_group,
      startedAt: a.started_at, completedAt: a.completed_at,
      allowedSec: a.allowed_sec, elapsedSec: a.elapsed_sec,
      scoreRaw: a.score_raw, scoreScaled: a.score_scaled,
      finishReason: a.finish_reason, total: a.questions.length,
      source: a.source === 'offline' ? 'offline' : sourceOf({ mode: a.mode, label: a.label }),
      sourceLabel: SOURCE_LABELS[a.source === 'offline' ? 'offline'
        : sourceOf({ mode: a.mode, label: a.label })],
      countsTowardPrediction: a.status === 'completed' && a.paper !== null
        && a.questions.length === 20 && a.mode !== 'drill',
    }));
  });

  handle('analytics:dashboard', ({ archiveId } = {}) => analytics.dashboard(db.attemptsScoped(archiveId)));

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
    const attempts = db.attemptsScoped(filters.archiveId).filter(a => a.status === 'completed');
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
  handle('data:importPayload', (payload) => {
    const res = db.importAll(payload);
    // An import that carries no review queue (a hand-built payload, or an
    // export from before the queue existed) must still end up with one that
    // matches the imported history, rather than silently empty.
    if (!payload.reviewQueue || !payload.reviewQueue.length) rebuildDerivedRef();
    return res;
  });

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

  // ---------- Study Coach ----------

  const scopedAttempts = (archiveId) => db.attemptsScoped(archiveId);

  handle('coach:overview', ({ archiveId } = {}) => {
    const attempts = scopedAttempts(archiveId);
    const settings = currentSettings();
    const now = nowMs();
    const reviewRows = db.reviewAll();
    const doneKeys = new Set(db.checklistKeysSince(now - 7 * 86400000).map(r => r.item_key));
    const list = checklist.build({
      attempts, reviewRows, changes: db.answerChanges(), settings, now, doneKeys,
    });
    const attempted = new Set(coach.fullPapers(attempts).map(a => `${a.year}-P${a.paper}`));
    return {
      countdown: list.countdown,
      phase: list.phase,
      prediction: coach.predict(attempts, settings, now),
      checklist: list.items,
      suppressed: list.suppressed,
      context: list.context,
      review: srs.summary(reviewRows, now),
      papersLeft: content.papers().filter(p => !attempted.has(p.key)).length,
      corePapersLeft: content.papers()
        .filter(p => p.year !== 'specimen' && !attempted.has(p.key)).length,
      totalCorePapers: content.papers().filter(p => p.year !== 'specimen').length,
      settings,
    };
  });

  handle('coach:diagnostics', ({ archiveId } = {}) => {
    const attempts = scopedAttempts(archiveId);
    return {
      topics: coach.topicDiagnostics(attempts),
      split: coach.paperSplit(attempts),
      errors: coach.errorMix(attempts),
      pacing: coach.pacing(attempts),
      guessing: coach.guessing(attempts),
      changes: coach.answerChangeStats(db.answerChanges(), attempts),
      minSample: coach.MIN_TOPIC_SAMPLE,
    };
  });

  // exposed so the verification suite can check the conversion maths directly
  handle('coach:scaled', ({ year, paper, raw }) => coach.scaledFor(year, paper, raw));

  handle('coach:plan', ({ archiveId } = {}) =>
    checklist.plan({
      attempts: scopedAttempts(archiveId), settings: currentSettings(),
      now: nowMs(), overrides: db.planOverrides(),
    }));

  handle('plan:setWeek', ({ weekStart, papers, topics, note }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || ''))) {
      throw new Error('weekStart must be a date as YYYY-MM-DD');
    }
    if (papers != null) {
      if (!Array.isArray(papers)) throw new Error('papers must be a list');
      const valid = new Set(content.papers().map(p => p.key));
      for (const k of papers) {
        if (!valid.has(k)) throw new Error(`unknown paper '${k}'`);
      }
      if (new Set(papers).size !== papers.length) throw new Error('duplicate paper in week');
    }
    if (topics != null) {
      if (!Array.isArray(topics)) throw new Error('topics must be a list');
      const tax = content.getTaxonomy();
      for (const t of topics) if (!tax[t]) throw new Error(`unknown topic '${t}'`);
    }
    db.planOverrideSet({ weekStart, papers, topics, note });
    return db.planOverrides();
  });

  handle('plan:resetWeek', (weekStart) => {
    db.planOverrideClear(weekStart || null);
    return db.planOverrides();
  });

  handle('coach:complete', ({ itemKey, title, kind, dismissed }) => {
    db.checklistComplete({ itemKey, title, kind, dismissed });
    return db.checklistDone(50);
  });
  handle('coach:history', () => db.checklistDone(100));

  handle('coach:tagError', ({ attemptId, position, errorType }) => {
    const allowed = Object.keys(coach.ERROR_TYPES);
    if (errorType !== null && !allowed.includes(errorType)) {
      throw new Error(`unknown error type '${errorType}'`);
    }
    db.setErrorType(attemptId, position, errorType);
    return true;
  });

  // ---------- spaced repetition ----------

  handle('review:summary', () => srs.summary(db.reviewAll(), nowMs()));
  handle('review:list', () => srs.dueList(db.reviewAll(), nowMs()));
  handle('review:all', () => db.reviewAll().map(r => srs.decorate(r, nowMs())));
  handle('review:stubborn', () => srs.stubborn(db.reviewAll(), nowMs()));
  handle('review:session', ({ cap } = {}) => {
    const picked = srs.session(db.reviewAll(), nowMs(), cap || srs.SESSION_CAP);
    return { ids: picked.map(p => p.questionId), items: picked };
  });

  rebuildDerivedRef = rebuildDerived;

  // ---------- deletion ----------
  //
  // Rebuild the review queue from the surviving attempts only. Replaying the
  // scheduler over the remaining history in date order is what makes the
  // shared-question case correct: a question missed in a deleted attempt AND a
  // surviving one keeps its entry, with a schedule derived from what is left.
  function rebuildDerived() {
    const surviving = db.attemptsScoped('all')
      .filter(a => a.status === 'completed')
      .sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));

    const rows = new Map();
    for (const a of surviving) {
      for (const q of a.questions) {
        if (!content.get(q.question_id)) continue;
        const correct = q.correct === null ? null : Boolean(q.correct);
        let source = null;
        if (correct === false) source = q.confidence === 'sure' ? 'sure_wrong' : 'wrong';
        else if (q.flagged) source = 'flag';
        const existing = rows.get(q.question_id) || null;
        if (!existing && correct !== false && !q.flagged) continue;
        rows.set(q.question_id, srs.applyResult(existing, {
          questionId: q.question_id,
          source: source || (existing ? existing.source : 'wrong'),
          correct,
          now: a.completed_at || Date.now(),
        }));
      }
    }
    db.replaceReviewQueue([...rows.values()]);

    // a revisit mark survives only if a surviving attempt still justifies it
    const stillJustified = new Set();
    for (const a of surviving) {
      for (const q of a.questions) {
        if (q.flagged || q.correct === 0) stillJustified.add(q.question_id);
      }
    }
    const keep = db.revisitList()
      .map(r => r.question_id)
      .filter(qid => stillJustified.has(qid));
    db.setRevisitList(keep);
    for (const qid of stillJustified) {
      if (!db.revisitList().some(r => r.question_id === qid)) db.revisitAdd(qid, null);
    }

    const orphans = db.orphanCheck();
    if (orphans.length) {
      console.error('[integrity] orphans after delete:', orphans);
      throw new Error(`Integrity check failed: ${orphans[0]}`);
    }
    return orphans;
  }

  handle('delete:preview', (ids) => db.deletePreview(Array.isArray(ids) ? ids : [ids]));

  handle('delete:attempts', ({ ids, confirm }) => {
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
    if (!list.length) throw new Error('Nothing selected to delete');
    if (list.length > 1 && String(confirm || '').trim().toUpperCase() !== 'DELETE') {
      throw new Error('Deleting several attempts requires typing DELETE to confirm');
    }
    db.backupNow();                       // a backup before every deletion, always
    const preview = db.deletePreview(list);
    db.softDelete(list);
    rebuildDerived();
    return { ...preview, softDeleted: list, undoWindowMs: UNDO_WINDOW_MS };
  });

  handle('delete:undo', (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
    const res = db.undelete(list);
    rebuildDerived();
    return res;
  });

  // Called when the undo window expires, and on startup for anything left over
  // from a previous session.
  handle('delete:commit', (ids) => {
    const list = ids && ids.length
      ? ids.map(Number).filter(Number.isFinite)
      : db.softDeletedIds();
    const res = db.purge(list);
    rebuildDerived();
    return res;
  });

  handle('delete:allHistory', ({ confirm }) => {
    if (String(confirm || '').trim().toUpperCase() !== 'DELETE ALL') {
      throw new Error('Type DELETE ALL to confirm');
    }
    db.backupNow();
    const res = db.deleteAllHistory();
    const orphans = db.orphanCheck();
    if (orphans.length) throw new Error(`Integrity check failed: ${orphans[0]}`);
    return res;
  });

  handle('debug:orphanCheck', () => db.orphanCheck());
  handle('debug:pendingDeletes', () => db.softDeletedIds());

  // ---------- archives ----------

  handle('archive:list', () => db.archiveList());
  handle('archive:create', ({ name, note }) => {
    if (!name || !String(name).trim()) throw new Error('An archive needs a name');
    db.backupNow();                       // never archive without a backup first
    return db.archiveCreate(String(name).trim(), note);
  });
  handle('archive:restore', (id) => {
    db.backupNow();
    return db.archiveRestore(id);
  });

  // ---------- offline (paper) attempt entry ----------

  handle('offline:record', ({ year, paper, answers, minutes, when }) => {
    const questions = content.paperQuestions(year, paper);
    if (!questions.length) throw new Error('No such paper');
    if (!Array.isArray(answers) || answers.length !== questions.length) {
      throw new Error(`Expected ${questions.length} answers`);
    }
    for (const a of answers) {
      if (a !== null && !/^[A-H]$/.test(a)) throw new Error(`Invalid answer '${a}'`);
    }
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0 || mins > 600) {
      throw new Error('Minutes must be between 1 and 600');
    }
    const attempt = db.createAttempt({
      mode: 'paper', year, paper,
      allowedSec: Math.round(mins * 60),
      questionIds: questions.map(q => q.id),
      settings: {}, label: 'Sat on paper',
    });
    answers.forEach((sel, i) => {
      if (sel) db.saveAnswer(attempt.id, i, { selected: sel });
    });
    db.markOffline(attempt.id, when ? new Date(when).getTime() : Date.now());
    const fresh = db.getAttempt(attempt.id);
    const done = scoreAttempt(fresh, 'submitted', Math.round(mins * 60));
    return attemptPayload(done, { reveal: true });
  });

  // ---------- PDF export ----------

  handle('pdf:paper', async ({ year, paper, includeAnswerSheet, includeMarkScheme, working }) => {
    const label = year === 'specimen' ? 'Specimen' : year;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export paper as PDF',
      defaultPath: `TMUA ${label} Paper ${paper}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const res = await pdf.exportPaper({
      year, paper, outPath: filePath,
      working: working !== false,
      includeAnswerSheet: Boolean(includeAnswerSheet),
      includeMarkScheme: Boolean(includeMarkScheme),
      minutes: allowedMinutes(currentSettings()),
    });
    return { canceled: false, ...res };
  });

  handle('pdf:drill', async ({ questionIds, title, includeMarkScheme }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export drill as PDF',
      defaultPath: `${(title || 'TMUA drill').replace(/[^\w -]/g, '')}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const res = await pdf.exportDrill({
      questionIds, outPath: filePath, title: title || 'TMUA custom drill',
      includeMarkScheme: Boolean(includeMarkScheme),
    });
    return { canceled: false, ...res };
  });

  // dialog-free variants for the verification suite
  handle('pdf:paperTo', ({ year, paper, outPath, includeAnswerSheet, includeMarkScheme }) =>
    pdf.exportPaper({
      year, paper, outPath,
      includeAnswerSheet: Boolean(includeAnswerSheet),
      includeMarkScheme: Boolean(includeMarkScheme),
      minutes: allowedMinutes(currentSettings()),
    }));
  handle('pdf:drillTo', ({ questionIds, outPath, title, includeMarkScheme }) =>
    pdf.exportDrill({ questionIds, outPath, title, includeMarkScheme: Boolean(includeMarkScheme) }));

  // ---- verification hooks for the pure SRS scheduler ----
  // The schedule spans weeks, so it is driven with an injected clock rather
  // than by waiting real days.
  handle('debug:srsSimulate', ({ steps, startIso }) => {
    let now = new Date(startIso).getTime();
    let row = null;
    const out = [];
    for (const step of steps) {
      row = srs.applyResult(row, {
        questionId: 'sim-q', source: 'wrong',
        correct: step === 'correct', now,
      });
      const days = Math.round((row.due_at - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
      out.push({
        step,
        afterDays: days,
        dueOn: new Date(row.due_at).toISOString().slice(0, 10),
        intervalIndex: row.interval_index,
        consecutiveCorrect: row.consecutive_correct,
        lapses: row.lapses,
        retired: Boolean(row.retired),
      });
      now = row.due_at;                     // next review happens when it is due
    }
    return out;
  });

  handle('debug:srsSeed', ({ count, lapses = 0, sources = null, sameDue = false }) => {
    const ids = content.all().slice(0, count).map(q => q.id);
    const now = Date.now();
    ids.forEach((id, i) => {
      db.reviewUpsert({
        question_id: id,
        source: sources ? sources[i % sources.length] : 'wrong',
        due_at: sameDue ? now - 86400000 : now - (i + 1) * 86400000,
        interval_index: 0, consecutive_correct: 0,
        lapses, attempts: lapses + 1, hits: 0, retired: 0,
        last_result: 'wrong', last_seen_at: now, created_at: now, history: '[]',
      });
    });
    return { inserted: ids.length };
  });

  handle('debug:setClock', ({ fixedIso, offsetMs }) => {
    clockFixed = fixedIso ? new Date(fixedIso).getTime() : null;
    clockOffset = Number(offsetMs) || 0;
    return { now: new Date(nowMs()).toISOString(), frozen: clockFixed !== null };
  });
  handle('debug:now', () => new Date(nowMs()).toISOString());
  handle('debug:dbPath', () => db.getDbPath());

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

// One instance per data directory. Two processes writing the same SQLite file
// could interleave an in-progress exam, so a second launch hands focus to the
// running window and exits instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
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
