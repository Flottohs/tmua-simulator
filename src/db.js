// SQLite storage: schema, migrations, and all read/write operations.
// Uses Node's built-in node:sqlite (no native dependency), WAL mode, and
// synchronous write-through so every user action hits disk immediately.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 4;

let db = null;
let dbFile = null;

function init(userDataDir) {
  const dataDir = path.join(userDataDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, 'tmua.sqlite');
  const isNew = !fs.existsSync(dbFile);

  // timestamped backup of the previous DB on every launch, keep last 20
  if (!isNew) backup(dataDir);

  db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  return dbFile;
}

function backup(dataDir) {
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.copyFileSync(dbFile, path.join(backups, `tmua-${stamp}.sqlite`));
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbFile + suffix)) {
        fs.copyFileSync(dbFile + suffix, path.join(backups, `tmua-${stamp}.sqlite${suffix}`));
      }
    }
  } catch (e) {
    console.error('backup failed:', e.message);
    return;
  }
  const stamps = [...new Set(fs.readdirSync(backups)
    .filter(f => f.startsWith('tmua-'))
    .map(f => f.replace(/\.sqlite(-wal|-shm)?$/, '')))].sort();
  while (stamps.length > 20) {
    const old = stamps.shift();
    for (const s of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) {
      const p = path.join(backups, old + s);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  const current = row ? parseInt(row.value, 10) : 0;
  if (current === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        year TEXT,
        paper INTEGER,
        mock_group TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        allowed_sec INTEGER,
        elapsed_sec REAL NOT NULL DEFAULT 0,
        current_index INTEGER NOT NULL DEFAULT 0,
        finish_reason TEXT,
        score_raw INTEGER,
        score_scaled REAL,
        label TEXT,
        settings_json TEXT
      );
      CREATE TABLE IF NOT EXISTS attempt_questions (
        attempt_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        selected TEXT,
        correct INTEGER,
        flagged INTEGER NOT NULL DEFAULT 0,
        confidence TEXT,
        time_spent REAL NOT NULL DEFAULT 0,
        notepad TEXT,
        updated_at INTEGER,
        PRIMARY KEY (attempt_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_aq_question ON attempt_questions(question_id);
      CREATE TABLE IF NOT EXISTS revisit (
        question_id TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    setVersion(1);
  }

  // v2 — Study Coach, spaced repetition, answer-change tracking, archives.
  // Additive only: new columns and new tables, so existing history is untouched.
  if (readVersion() < 2) {
    addColumn('attempts', 'archive_id', 'INTEGER');
    addColumn('attempts', 'source', "TEXT NOT NULL DEFAULT 'app'");
    addColumn('attempt_questions', 'error_type', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS review_queue (
        question_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,              -- wrong | sure_wrong | flag | revisit
        due_at INTEGER NOT NULL,
        interval_index INTEGER NOT NULL DEFAULT 0,
        consecutive_correct INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        retired INTEGER NOT NULL DEFAULT 0,
        last_result TEXT,
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        history TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_rq_due ON review_queue(retired, due_at);
      CREATE TABLE IF NOT EXISTS answer_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        from_letter TEXT,
        to_letter TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ac_attempt ON answer_changes(attempt_id);
      CREATE TABLE IF NOT EXISTS checklist_done (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0
      );
    `);
    setVersion(2);
  }

  // v3 — user edits to the generated study plan, keyed by the week's start date
  // so they survive the plan being recomputed every day.
  if (readVersion() < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_overrides (
        week_start TEXT PRIMARY KEY,      -- YYYY-MM-DD, the Monday-ish week start
        papers TEXT,                      -- JSON array of paper keys, null = keep suggested
        topics TEXT,                      -- JSON array of topic ids, null = keep suggested
        note TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    setVersion(3);
  }

  // v4 — soft deletion, so an explicit delete is undoable for a short window
  // before the rows actually go.
  if (readVersion() < 4) {
    addColumn('attempts', 'deleted_at', 'INTEGER');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_attempts_deleted ON attempts(deleted_at)`);
    setVersion(4);
  }
}

function readVersion() {
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  return row ? parseInt(row.value, 10) : 0;
}
function setVersion(n) {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
    .run(String(n));
}
function addColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// ---------- attempts ----------

function createAttempt({ mode, year, paper, mockGroup, allowedSec, questionIds, settings, label, source }) {
  const now = Date.now();
  return tx(() => {
    const info = db.prepare(`
      INSERT INTO attempts (mode, year, paper, mock_group, status, started_at, allowed_sec, settings_json, label, source)
      VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)
    `).run(mode, year ?? null, paper ?? null, mockGroup ?? null, now, allowedSec ?? null,
           JSON.stringify(settings || {}), label ?? null, source || 'paper');
    const attemptId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO attempt_questions (attempt_id, position, question_id) VALUES (?, ?, ?)`);
    questionIds.forEach((qid, i) => ins.run(attemptId, i, qid));
    return getAttempt(attemptId);
  });
}

function getAttempt(id) {
  const a = db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id);
  if (!a) return null;
  a.questions = db.prepare(
    `SELECT * FROM attempt_questions WHERE attempt_id = ? ORDER BY position`).all(id);
  return a;
}

function listAttempts() {
  return db.prepare(
    `SELECT * FROM attempts WHERE deleted_at IS NULL ORDER BY started_at DESC`).all();
}

function listAttemptsFull() {
  const attempts = listAttempts();
  const qs = db.prepare(`SELECT * FROM attempt_questions ORDER BY attempt_id, position`).all();
  const byAttempt = new Map();
  for (const q of qs) {
    if (!byAttempt.has(q.attempt_id)) byAttempt.set(q.attempt_id, []);
    byAttempt.get(q.attempt_id).push(q);
  }
  for (const a of attempts) a.questions = byAttempt.get(a.id) || [];
  return attempts;
}

function inProgressAttempts() {
  return db.prepare(`SELECT id FROM attempts WHERE status = 'in_progress'
                     AND deleted_at IS NULL ORDER BY started_at DESC`)
    .all().map(r => getAttempt(r.id));
}

function saveAnswer(attemptId, position, { selected, confidence }) {
  db.prepare(`
    UPDATE attempt_questions SET selected = ?, confidence = COALESCE(?, confidence), updated_at = ?
    WHERE attempt_id = ? AND position = ?
  `).run(selected ?? null, confidence ?? null, Date.now(), attemptId, position);
}

function setConfidence(attemptId, position, confidence) {
  db.prepare(`UPDATE attempt_questions SET confidence = ?, updated_at = ?
              WHERE attempt_id = ? AND position = ?`)
    .run(confidence ?? null, Date.now(), attemptId, position);
}

function setFlag(attemptId, position, flagged) {
  db.prepare(`UPDATE attempt_questions SET flagged = ?, updated_at = ?
              WHERE attempt_id = ? AND position = ?`)
    .run(flagged ? 1 : 0, Date.now(), attemptId, position);
}

function setNotepad(attemptId, position, text) {
  db.prepare(`UPDATE attempt_questions SET notepad = ?, updated_at = ?
              WHERE attempt_id = ? AND position = ?`)
    .run(text ?? null, Date.now(), attemptId, position);
}

function heartbeat(attemptId, { elapsedSec, currentIndex, questionTime }) {
  return tx(() => {
    db.prepare(`UPDATE attempts SET elapsed_sec = ?, current_index = ?
                WHERE id = ? AND status = 'in_progress'`)
      .run(elapsedSec, currentIndex, attemptId);
    if (questionTime && questionTime.delta > 0) {
      db.prepare(`UPDATE attempt_questions SET time_spent = time_spent + ?
                  WHERE attempt_id = ? AND position = ?`)
        .run(questionTime.delta, attemptId, questionTime.position);
    }
  });
}

function finishAttempt(attemptId, { reason, elapsedSec, marks, scoreRaw, scoreScaled }) {
  tx(() => {
    db.prepare(`
      UPDATE attempts SET status = 'completed', completed_at = ?, finish_reason = ?,
        elapsed_sec = ?, score_raw = ?, score_scaled = ? WHERE id = ?
    `).run(Date.now(), reason, elapsedSec, scoreRaw, scoreScaled ?? null, attemptId);
    const upd = db.prepare(
      `UPDATE attempt_questions SET correct = ? WHERE attempt_id = ? AND position = ?`);
    for (const m of marks) upd.run(m.correct ? 1 : 0, attemptId, m.position);
  });
  return getAttempt(attemptId);
}

function abandonAttempt(attemptId) {
  db.prepare(`UPDATE attempts SET status = 'abandoned', completed_at = ?,
              finish_reason = 'abandoned' WHERE id = ?`).run(Date.now(), attemptId);
}

function deleteAttempt(attemptId) {
  tx(() => {
    db.prepare(`DELETE FROM attempt_questions WHERE attempt_id = ?`).run(attemptId);
    db.prepare(`DELETE FROM attempts WHERE id = ?`).run(attemptId);
  });
}

// ---------- revisit list ----------

function revisitAdd(questionId, note) {
  db.prepare(`INSERT OR REPLACE INTO revisit (question_id, added_at, note) VALUES (?, ?, ?)`)
    .run(questionId, Date.now(), note ?? null);
}
function revisitRemove(questionId) {
  db.prepare(`DELETE FROM revisit WHERE question_id = ?`).run(questionId);
}
function revisitList() {
  return db.prepare(`SELECT * FROM revisit ORDER BY added_at DESC`).all();
}

// ---------- settings ----------

function getSettings() {
  const out = {};
  for (const r of db.prepare(`SELECT key, value FROM settings`).all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}
function setSetting(key, value) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(key, JSON.stringify(value));
}

// ---------- export / import ----------

function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    attempts: attemptsScoped('all'),
    revisit: revisitList(),
    settings: getSettings(),
    reviewQueue: reviewAll(),
    answerChanges: answerChanges(),
    checklist: checklistDone(1000),
    archives: db.prepare(`SELECT * FROM archives ORDER BY created_at`).all(),
    planOverrides: planOverrides(),
  };
}

function importAll(payload) {
  if (!payload || !Array.isArray(payload.attempts)) throw new Error('Invalid export file');
  return tx(() => {
    db.exec(`DELETE FROM attempt_questions`);
    db.exec(`DELETE FROM attempts`);
    db.exec(`DELETE FROM revisit`);
    db.exec(`DELETE FROM review_queue`);
    db.exec(`DELETE FROM answer_changes`);
    db.exec(`DELETE FROM checklist_done`);
    db.exec(`DELETE FROM archives`);
    db.exec(`DELETE FROM plan_overrides`);
    const insA = db.prepare(`
      INSERT INTO attempts (id, mode, year, paper, mock_group, status, started_at, completed_at,
        allowed_sec, elapsed_sec, current_index, finish_reason, score_raw, score_scaled, label,
        settings_json, archive_id, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insQ = db.prepare(`
      INSERT INTO attempt_questions (attempt_id, position, question_id, selected, correct, flagged,
        confidence, time_spent, notepad, updated_at, error_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const ar of payload.archives || []) {
      db.prepare(`INSERT INTO archives (id, name, created_at, note) VALUES (?,?,?,?)`)
        .run(ar.id, ar.name, ar.created_at, ar.note ?? null);
    }
    for (const a of payload.attempts) {
      insA.run(a.id, a.mode, a.year ?? null, a.paper ?? null, a.mock_group ?? null, a.status,
        a.started_at, a.completed_at ?? null, a.allowed_sec ?? null, a.elapsed_sec ?? 0,
        a.current_index ?? 0, a.finish_reason ?? null, a.score_raw ?? null,
        a.score_scaled ?? null, a.label ?? null, a.settings_json ?? null,
        a.archive_id ?? null, a.source ?? 'app');
      for (const q of a.questions || []) {
        insQ.run(q.attempt_id, q.position, q.question_id, q.selected ?? null, q.correct ?? null,
          q.flagged ?? 0, q.confidence ?? null, q.time_spent ?? 0, q.notepad ?? null,
          q.updated_at ?? null, q.error_type ?? null);
      }
    }
    for (const r of payload.reviewQueue || []) reviewUpsert(r);
    for (const c of payload.answerChanges || []) {
      db.prepare(`INSERT INTO answer_changes (attempt_id, position, question_id, from_letter, to_letter, at)
                  VALUES (?,?,?,?,?,?)`)
        .run(c.attempt_id, c.position, c.question_id, c.from_letter ?? null, c.to_letter ?? null, c.at);
    }
    for (const o of payload.planOverrides || []) planOverrideSet(o);
    for (const c of payload.checklist || []) {
      db.prepare(`INSERT INTO checklist_done (item_key, title, kind, completed_at, dismissed)
                  VALUES (?,?,?,?,?)`)
        .run(c.item_key, c.title, c.kind, c.completed_at, c.dismissed ?? 0);
    }
    const insR = db.prepare(
      `INSERT OR REPLACE INTO revisit (question_id, added_at, note) VALUES (?,?,?)`);
    for (const r of payload.revisit || []) insR.run(r.question_id, r.added_at, r.note ?? null);
    for (const [k, v] of Object.entries(payload.settings || {})) setSetting(k, v);
    return { attempts: payload.attempts.length };
  });
}

// ---------- review queue (spaced repetition) ----------

function reviewGet(questionId) {
  return db.prepare(`SELECT * FROM review_queue WHERE question_id = ?`).get(questionId) || null;
}
function reviewAll() {
  return db.prepare(`SELECT * FROM review_queue ORDER BY due_at`).all();
}
function reviewUpsert(row) {
  db.prepare(`
    INSERT INTO review_queue (question_id, source, due_at, interval_index, consecutive_correct,
      lapses, attempts, hits, retired, last_result, last_seen_at, created_at, history)
    VALUES (@question_id, @source, @due_at, @interval_index, @consecutive_correct,
      @lapses, @attempts, @hits, @retired, @last_result, @last_seen_at, @created_at, @history)
    ON CONFLICT(question_id) DO UPDATE SET
      source = excluded.source, due_at = excluded.due_at,
      interval_index = excluded.interval_index,
      consecutive_correct = excluded.consecutive_correct,
      lapses = excluded.lapses, attempts = excluded.attempts, hits = excluded.hits,
      retired = excluded.retired, last_result = excluded.last_result,
      last_seen_at = excluded.last_seen_at, history = excluded.history
  `).run(row);
}
function reviewRemove(questionId) {
  db.prepare(`DELETE FROM review_queue WHERE question_id = ?`).run(questionId);
}

// ---------- answer changes ----------

function logAnswerChange(row) {
  db.prepare(`
    INSERT INTO answer_changes (attempt_id, position, question_id, from_letter, to_letter, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.attemptId, row.position, row.questionId, row.from ?? null, row.to ?? null, Date.now());
}
function answerChanges() {
  return db.prepare(`SELECT * FROM answer_changes ORDER BY at`).all();
}

// ---------- checklist history ----------

function checklistDone(limit = 100) {
  return db.prepare(`SELECT * FROM checklist_done ORDER BY completed_at DESC LIMIT ?`).all(limit);
}
function checklistComplete({ itemKey, title, kind, dismissed }) {
  db.prepare(`
    INSERT INTO checklist_done (item_key, title, kind, completed_at, dismissed)
    VALUES (?, ?, ?, ?, ?)
  `).run(itemKey, title, kind, Date.now(), dismissed ? 1 : 0);
}
function checklistKeysSince(sinceMs) {
  return db.prepare(`SELECT item_key, dismissed FROM checklist_done WHERE completed_at >= ?`)
    .all(sinceMs);
}

// ---------- archives ----------

function archiveList() {
  const rows = db.prepare(`SELECT * FROM archives ORDER BY created_at DESC`).all();
  for (const r of rows) {
    r.attempts = db.prepare(`SELECT COUNT(*) n FROM attempts WHERE archive_id = ?`)
      .get(r.id).n;
  }
  return rows;
}
function archiveCreate(name, note) {
  return tx(() => {
    const info = db.prepare(`INSERT INTO archives (name, created_at, note) VALUES (?, ?, ?)`)
      .run(name, Date.now(), note ?? null);
    const id = Number(info.lastInsertRowid);
    const res = db.prepare(
      `UPDATE attempts SET archive_id = ? WHERE archive_id IS NULL AND status != 'in_progress'`)
      .run(id);
    return { id, name, moved: res.changes };
  });
}
function archiveRestore(id) {
  return tx(() => {
    const res = db.prepare(`UPDATE attempts SET archive_id = NULL WHERE archive_id = ?`).run(id);
    db.prepare(`DELETE FROM archives WHERE id = ?`).run(id);
    return { restored: res.changes };
  });
}
// archiveId: undefined = active only, number = that archive, 'all' = everything
function attemptsScoped(archiveId) {
  let sql = `SELECT * FROM attempts WHERE deleted_at IS NULL`;
  const args = [];
  if (archiveId === 'all') { /* every archive, still excluding deleted */ }
  else if (archiveId === undefined || archiveId === null) sql += ` AND archive_id IS NULL`;
  else { sql += ` AND archive_id = ?`; args.push(archiveId); }
  sql += ` ORDER BY started_at DESC`;
  const attempts = db.prepare(sql).all(...args);
  const qs = db.prepare(`SELECT * FROM attempt_questions ORDER BY attempt_id, position`).all();
  const byAttempt = new Map();
  for (const q of qs) {
    if (!byAttempt.has(q.attempt_id)) byAttempt.set(q.attempt_id, []);
    byAttempt.get(q.attempt_id).push(q);
  }
  for (const a of attempts) a.questions = byAttempt.get(a.id) || [];
  return attempts;
}

// Mark an attempt as sat on paper, backdating its timestamps.
function markOffline(attemptId, whenMs) {
  db.prepare(`UPDATE attempts SET source = 'offline', started_at = ? WHERE id = ?`)
    .run(whenMs, attemptId);
}

function setErrorType(attemptId, position, errorType) {
  db.prepare(`UPDATE attempt_questions SET error_type = ? WHERE attempt_id = ? AND position = ?`)
    .run(errorType ?? null, attemptId, position);
}

function backupNow() {
  const dataDir = path.dirname(dbFile);
  backup(dataDir);
  return true;
}

// ---------- deletion ----------
//
// Deletion is explicit and cascading. It happens in two stages: a soft delete
// (undoable for a short window) followed by a hard delete that actually removes
// the rows and rebuilds everything derived from them.

function attemptsByIds(ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM attempts WHERE id IN (${marks})`).all(...ids);
  for (const a of rows) {
    a.questions = db.prepare(
      `SELECT * FROM attempt_questions WHERE attempt_id = ? ORDER BY position`).all(a.id);
  }
  return rows;
}

// Live counts for the confirmation dialog — never a generic warning.
function deletePreview(ids, answerFor) {
  const rows = attemptsByIds(ids).filter(a => a.deleted_at === null);
  const marks = ids.length ? ids.map(() => '?').join(',') : 'NULL';
  const changes = ids.length
    ? db.prepare(`SELECT COUNT(*) n FROM answer_changes WHERE attempt_id IN (${marks})`).get(...ids).n
    : 0;

  let wrong = 0, answers = 0, flags = 0;
  const questionIds = new Set();
  for (const a of rows) {
    for (const q of a.questions) {
      questionIds.add(q.question_id);
      if (q.selected) answers++;
      if (q.correct === 0) wrong++;
      if (q.flagged) flags++;
    }
  }

  // which review-queue entries would disappear entirely: those no surviving
  // attempt still justifies
  const surviving = new Set();
  const others = db.prepare(
    `SELECT id FROM attempts WHERE deleted_at IS NULL AND status = 'completed'
     ${ids.length ? `AND id NOT IN (${marks})` : ''}`).all(...(ids.length ? ids : []));
  for (const o of others) {
    for (const q of db.prepare(
      `SELECT question_id, correct, flagged FROM attempt_questions WHERE attempt_id = ?`).all(o.id)) {
      if (q.correct === 0 || q.flagged) surviving.add(q.question_id);
    }
  }
  const queued = db.prepare(`SELECT question_id FROM review_queue`).all().map(r => r.question_id);
  const queueGone = queued.filter(qid => questionIds.has(qid) && !surviving.has(qid)).length;
  const queueKept = queued.filter(qid => questionIds.has(qid) && surviving.has(qid)).length;

  const remaining = db.prepare(
    `SELECT COUNT(*) n FROM attempts WHERE deleted_at IS NULL AND archive_id IS NULL
     AND status = 'completed' AND paper IS NOT NULL
     ${ids.length ? `AND id NOT IN (${marks})` : ''}`).get(...(ids.length ? ids : [])).n;

  return {
    attempts: rows.map(a => ({
      id: a.id, year: a.year, paper: a.paper, mode: a.mode, label: a.label,
      scoreRaw: a.score_raw, total: a.questions.length,
      completedAt: a.completed_at, mockGroup: a.mock_group, status: a.status,
      archived: a.archive_id !== null,
    })),
    answers, wrong, flags, changes,
    reviewRemoved: queueGone,
    reviewRecomputed: queueKept,
    remainingPapers: remaining,
  };
}

function softDelete(ids) {
  if (!ids.length) return { deleted: 0 };
  const marks = ids.map(() => '?').join(',');
  return tx(() => {
    const res = db.prepare(
      `UPDATE attempts SET deleted_at = ? WHERE id IN (${marks}) AND deleted_at IS NULL`)
      .run(Date.now(), ...ids);
    return { deleted: res.changes };
  });
}

function undelete(ids) {
  if (!ids.length) return { restored: 0 };
  const marks = ids.map(() => '?').join(',');
  return tx(() => {
    const res = db.prepare(
      `UPDATE attempts SET deleted_at = NULL WHERE id IN (${marks})`).run(...ids);
    return { restored: res.changes };
  });
}

// Physically remove soft-deleted attempts and everything hanging off them.
// One transaction: either it all goes or nothing does.
function purge(ids) {
  if (!ids.length) return { purged: 0 };
  const marks = ids.map(() => '?').join(',');
  return tx(() => {
    const rows = db.prepare(
      `SELECT id FROM attempts WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).all(...ids);
    const real = rows.map(r => r.id);
    if (!real.length) return { purged: 0 };
    const m2 = real.map(() => '?').join(',');
    db.prepare(`DELETE FROM answer_changes WHERE attempt_id IN (${m2})`).run(...real);
    db.prepare(`DELETE FROM attempt_questions WHERE attempt_id IN (${m2})`).run(...real);
    db.prepare(`DELETE FROM attempts WHERE id IN (${m2})`).run(...real);
    return { purged: real.length };
  });
}

function softDeletedIds(olderThanMs) {
  const rows = olderThanMs
    ? db.prepare(`SELECT id FROM attempts WHERE deleted_at IS NOT NULL AND deleted_at <= ?`)
      .all(olderThanMs)
    : db.prepare(`SELECT id FROM attempts WHERE deleted_at IS NOT NULL`).all();
  return rows.map(r => r.id);
}

function deleteAllHistory() {
  return tx(() => {
    const n = db.prepare(`SELECT COUNT(*) n FROM attempts`).get().n;
    db.exec(`DELETE FROM answer_changes`);
    db.exec(`DELETE FROM attempt_questions`);
    db.exec(`DELETE FROM attempts`);
    db.exec(`DELETE FROM review_queue`);
    db.exec(`DELETE FROM revisit`);
    db.exec(`DELETE FROM checklist_done`);
    db.exec(`DELETE FROM archives`);
    db.exec(`DELETE FROM plan_overrides`);
    return { removed: n };
  });
}

// Rows that reference an attempt which no longer exists (or is soft-deleted).
function orphanCheck() {
  const problems = [];
  const dangling = db.prepare(`
    SELECT DISTINCT aq.attempt_id FROM attempt_questions aq
    LEFT JOIN attempts a ON a.id = aq.attempt_id WHERE a.id IS NULL`).all();
  for (const d of dangling) problems.push(`attempt_questions references missing attempt ${d.attempt_id}`);

  const changes = db.prepare(`
    SELECT DISTINCT ac.attempt_id FROM answer_changes ac
    LEFT JOIN attempts a ON a.id = ac.attempt_id WHERE a.id IS NULL`).all();
  for (const c of changes) problems.push(`answer_changes references missing attempt ${c.attempt_id}`);

  const badArchive = db.prepare(`
    SELECT DISTINCT a.archive_id FROM attempts a
    LEFT JOIN archives ar ON ar.id = a.archive_id
    WHERE a.archive_id IS NOT NULL AND ar.id IS NULL`).all();
  for (const b of badArchive) problems.push(`attempt references missing archive ${b.archive_id}`);

  return problems;
}

function replaceReviewQueue(rows) {
  return tx(() => {
    db.exec(`DELETE FROM review_queue`);
    for (const r of rows) reviewUpsert(r);
    return { rows: rows.length };
  });
}

function setRevisitList(questionIds) {
  return tx(() => {
    const keep = new Set(questionIds);
    for (const r of db.prepare(`SELECT question_id FROM revisit`).all()) {
      if (!keep.has(r.question_id)) {
        db.prepare(`DELETE FROM revisit WHERE question_id = ?`).run(r.question_id);
      }
    }
    return { kept: keep.size };
  });
}

// ---------- study-plan overrides ----------

function planOverrides() {
  const rows = db.prepare(`SELECT * FROM plan_overrides ORDER BY week_start`).all();
  return rows.map(r => ({
    weekStart: r.week_start,
    papers: r.papers ? JSON.parse(r.papers) : null,
    topics: r.topics ? JSON.parse(r.topics) : null,
    note: r.note,
    updatedAt: r.updated_at,
  }));
}

function planOverrideSet({ weekStart, papers, topics, note }) {
  db.prepare(`
    INSERT INTO plan_overrides (week_start, papers, topics, note, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(week_start) DO UPDATE SET
      papers = excluded.papers, topics = excluded.topics,
      note = excluded.note, updated_at = excluded.updated_at
  `).run(
    weekStart,
    papers === null || papers === undefined ? null : JSON.stringify(papers),
    topics === null || topics === undefined ? null : JSON.stringify(topics),
    note ?? null,
    Date.now(),
  );
}

function planOverrideClear(weekStart) {
  if (weekStart) db.prepare(`DELETE FROM plan_overrides WHERE week_start = ?`).run(weekStart);
  else db.exec(`DELETE FROM plan_overrides`);
}

function getDbPath() { return dbFile; }
function close() { if (db) { db.close(); db = null; } }

module.exports = {
  init, createAttempt, getAttempt, listAttempts, listAttemptsFull, inProgressAttempts,
  saveAnswer, setConfidence, setFlag, setNotepad, heartbeat, finishAttempt, abandonAttempt,
  deleteAttempt, revisitAdd, revisitRemove, revisitList, getSettings, setSetting,
  exportAll, importAll, getDbPath, close,
  // v2
  reviewGet, reviewAll, reviewUpsert, reviewRemove,
  logAnswerChange, answerChanges,
  checklistDone, checklistComplete, checklistKeysSince,
  archiveList, archiveCreate, archiveRestore, attemptsScoped,
  setErrorType, backupNow, markOffline,
  planOverrides, planOverrideSet, planOverrideClear,
  deletePreview, softDelete, undelete, purge, softDeletedIds, deleteAllHistory,
  orphanCheck, replaceReviewQueue, setRevisitList, attemptsByIds,
};
