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
