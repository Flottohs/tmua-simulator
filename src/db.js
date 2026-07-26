// SQLite storage: schema, migrations, and all read/write operations.
// Uses Node's built-in node:sqlite (no native dependency), WAL mode, and
// synchronous write-through so every user action hits disk immediately.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

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
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
      .run(String(SCHEMA_VERSION));
  }
  // Future migrations go here as `if (current < N) { ...ALTER...; bump }`.
  // Never drop or recreate tables holding user history.
}

// ---------- attempts ----------

function createAttempt({ mode, year, paper, mockGroup, allowedSec, questionIds, settings, label }) {
  const now = Date.now();
  return tx(() => {
    const info = db.prepare(`
      INSERT INTO attempts (mode, year, paper, mock_group, status, started_at, allowed_sec, settings_json, label)
      VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)
    `).run(mode, year ?? null, paper ?? null, mockGroup ?? null, now, allowedSec ?? null,
           JSON.stringify(settings || {}), label ?? null);
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
  return db.prepare(`SELECT * FROM attempts ORDER BY started_at DESC`).all();
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
  return db.prepare(`SELECT id FROM attempts WHERE status = 'in_progress' ORDER BY started_at DESC`)
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
    attempts: listAttemptsFull(),
    revisit: revisitList(),
    settings: getSettings(),
  };
}

function importAll(payload) {
  if (!payload || !Array.isArray(payload.attempts)) throw new Error('Invalid export file');
  return tx(() => {
    db.exec(`DELETE FROM attempt_questions`);
    db.exec(`DELETE FROM attempts`);
    db.exec(`DELETE FROM revisit`);
    const insA = db.prepare(`
      INSERT INTO attempts (id, mode, year, paper, mock_group, status, started_at, completed_at,
        allowed_sec, elapsed_sec, current_index, finish_reason, score_raw, score_scaled, label, settings_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insQ = db.prepare(`
      INSERT INTO attempt_questions (attempt_id, position, question_id, selected, correct, flagged,
        confidence, time_spent, notepad, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const a of payload.attempts) {
      insA.run(a.id, a.mode, a.year ?? null, a.paper ?? null, a.mock_group ?? null, a.status,
        a.started_at, a.completed_at ?? null, a.allowed_sec ?? null, a.elapsed_sec ?? 0,
        a.current_index ?? 0, a.finish_reason ?? null, a.score_raw ?? null,
        a.score_scaled ?? null, a.label ?? null, a.settings_json ?? null);
      for (const q of a.questions || []) {
        insQ.run(q.attempt_id, q.position, q.question_id, q.selected ?? null, q.correct ?? null,
          q.flagged ?? 0, q.confidence ?? null, q.time_spent ?? 0, q.notepad ?? null,
          q.updated_at ?? null);
      }
    }
    const insR = db.prepare(
      `INSERT OR REPLACE INTO revisit (question_id, added_at, note) VALUES (?,?,?)`);
    for (const r of payload.revisit || []) insR.run(r.question_id, r.added_at, r.note ?? null);
    for (const [k, v] of Object.entries(payload.settings || {})) setSetting(k, v);
    return { attempts: payload.attempts.length };
  });
}

function getDbPath() { return dbFile; }
function close() { if (db) { db.close(); db = null; } }

module.exports = {
  init, createAttempt, getAttempt, listAttempts, listAttemptsFull, inProgressAttempts,
  saveAnswer, setConfidence, setFlag, setNotepad, heartbeat, finishAttempt, abandonAttempt,
  deleteAttempt, revisitAdd, revisitRemove, revisitList, getSettings, setSetting,
  exportAll, importAll, getDbPath, close,
};
