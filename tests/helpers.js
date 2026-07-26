const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const CONTENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/questions.json'), 'utf8'));

function freshUserDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tmua-${name}-`));
  return dir;
}

async function launch(userDir, extraArgs = []) {
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userDir}`, ...extraArgs],
  });
  const win = await app.firstWindow();
  win.on('dialog', d => d.accept().catch(() => {}));
  await win.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return { app, win };
}

async function launchPackaged(exePath, userDir) {
  const app = await electron.launch({
    executablePath: exePath,
    args: [`--user-data-dir=${userDir}`],
  });
  const win = await app.firstWindow();
  win.on('dialog', d => d.accept().catch(() => {}));
  await win.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return { app, win };
}

// Start an attempt through the real IPC surface and open the exam screen.
async function startExam(win, opts) {
  const id = await win.evaluate(async (o) => {
    const a = await window.api.attempt.start(o);
    await go('exam', { attemptId: a.id });
    return a.id;
  }, opts);
  await win.waitForSelector('.exam-bar', { timeout: 15000 });
  // wait until the Exam controller has finished mounting, otherwise keyboard
  // input can race the listener registration
  await win.waitForFunction(
    () => typeof State !== 'undefined' && State.exam && State.exam.navEl,
    null, { timeout: 15000 });
  return id;
}

function paperQuestions(year, paper) {
  return CONTENT.questions
    .filter(q => q.year === year && q.paper === paper)
    .sort((a, b) => a.number - b.number);
}

function answerKey(year, paper) {
  return paperQuestions(year, paper).map(q => q.answer);
}

module.exports = {
  ROOT, CONTENT, freshUserDir, launch, launchPackaged, startExam, paperQuestions, answerKey,
};

// ---------------------------------------------------------------------------
// Seeding helpers for the coach/refinement suites. Builds an import payload
// directly so a whole history can be created without sitting papers.
const BASE = Date.UTC(2026, 6, 1, 9, 0, 0);   // 1 July 2026

function wrongLetter(q) {
  return 'ABCDEFGH'.slice(0, q.options).split('').find(L => L !== q.answer);
}

// decide(q, index) -> 'correct' | 'wrong' | 'blank'
function seedAttempt({ id, year, paper, decide, at, confidence, errorType, elapsed = 5400 }) {
  const qs = paperQuestions(year, paper);
  let raw = 0;
  const questions = qs.map((q, i) => {
    const verdict = decide(q, i);
    const selected = verdict === 'correct' ? q.answer : verdict === 'wrong' ? wrongLetter(q) : null;
    const correct = verdict === 'correct' ? 1 : 0;
    if (correct) raw++;
    return {
      attempt_id: id, position: i, question_id: q.id, selected, correct,
      flagged: 0,
      confidence: confidence ? confidence(q, i, verdict) : null,
      time_spent: 200 + i, notepad: null, updated_at: at,
      error_type: errorType ? errorType(q, i, verdict) : null,
    };
  });
  return {
    attempt: {
      id, mode: 'paper', year, paper, mock_group: null, status: 'completed',
      started_at: at, completed_at: at + elapsed * 1000,
      allowed_sec: 5580, elapsed_sec: elapsed, current_index: 19,
      finish_reason: 'submitted', score_raw: raw, score_scaled: null,
      label: null, settings_json: '{}', archive_id: null, source: 'app',
      questions,
    },
    raw,
  };
}

function seedPayload(specs) {
  const attempts = [];
  const raws = [];
  specs.forEach((spec, i) => {
    const built = seedAttempt({
      id: i + 1,
      at: spec.at ?? BASE + i * 3 * 86400000,
      ...spec,
    });
    attempts.push(built.attempt);
    raws.push(built.raw);
  });
  return { payload: { attempts, revisit: [], settings: {} }, raws };
}

module.exports.BASE = BASE;
module.exports.wrongLetter = wrongLetter;
module.exports.seedAttempt = seedAttempt;
module.exports.seedPayload = seedPayload;
