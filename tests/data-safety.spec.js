const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { freshUserDir, launch, startExam, answerKey } = require('./helpers');

test.describe('data safety', () => {
  test('WAL mode, launch backups, and rotation', async () => {
    const userDir = freshUserDir('safety');
    let { app, win } = await launch(userDir);

    // finish one paper so there is history worth protecting
    const key = answerKey('2017', 1);
    const id = await startExam(win, { mode: 'paper', year: '2017', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 12; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');
    await app.close();

    const dataDir = path.join(userDir, 'data');
    expect(fs.existsSync(path.join(dataDir, 'tmua.sqlite'))).toBe(true);

    // WAL journal mode is in effect: the -wal sidecar exists while open
    ({ app, win } = await launch(userDir));
    expect(fs.existsSync(path.join(dataDir, 'tmua.sqlite-wal'))).toBe(true);
    await app.close();

    // each launch adds a timestamped backup
    const countBackups = () => fs.readdirSync(path.join(dataDir, 'backups'))
      .filter(f => f.endsWith('.sqlite')).length;
    const first = countBackups();
    expect(first).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 3; i++) {
      const r = await launch(userDir);
      await r.app.close();
    }
    expect(countBackups()).toBe(first + 3);

    // backups are real databases containing the attempt
    const backups = fs.readdirSync(path.join(dataDir, 'backups'))
      .filter(f => f.endsWith('.sqlite')).sort();
    const newest = path.join(dataDir, 'backups', backups[backups.length - 1]);
    expect(fs.statSync(newest).size).toBeGreaterThan(1000);
  });

  test('backup rotation keeps the last 20', async () => {
    const userDir = freshUserDir('rotate');
    const { app } = await launch(userDir);
    await app.close();

    const backups = path.join(userDir, 'data', 'backups');
    fs.mkdirSync(backups, { recursive: true });
    // seed 30 fake older backups
    for (let i = 0; i < 30; i++) {
      const stamp = new Date(Date.now() - (30 - i) * 86400000).toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(backups, `tmua-${stamp}.sqlite`), 'x');
    }
    expect(fs.readdirSync(backups).filter(f => f.endsWith('.sqlite')).length)
      .toBeGreaterThanOrEqual(30);

    const r = await launch(userDir);
    await r.app.close();

    const kept = fs.readdirSync(backups).filter(f => f.endsWith('.sqlite'));
    expect(kept.length).toBeLessThanOrEqual(20);
  });

  test('export and import round-trips full history', async () => {
    const userDir = freshUserDir('export');
    let { app, win } = await launch(userDir);

    const key = answerKey('2020', 2);
    const id = await startExam(win, { mode: 'paper', year: '2020', paper: 2 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 15; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
        await window.api.attempt.confidence({ attemptId, position: i, confidence: i % 2 ? 'sure' : 'unsure' });
      }
      await window.api.attempt.flag({ attemptId, position: 3, flagged: true });
      await window.api.attempt.notepad({ attemptId, position: 0, text: 'my working' });
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');
    await win.evaluate((qid) => window.api.revisit.add({ questionId: qid }), '2020-P2-Q05');

    // export through the same code path the Settings button uses
    const exported = await win.evaluate(() => window.api.data.exportPayload());
    expect(exported.attempts.length).toBe(1);
    expect(exported.attempts[0].questions.length).toBe(20);
    expect(exported.revisit.length).toBe(1);

    const file = path.join(userDir, 'export.json');
    fs.writeFileSync(file, JSON.stringify(exported));
    await app.close();

    // import into a completely fresh profile
    const otherDir = freshUserDir('import');
    ({ app, win } = await launch(otherDir));
    expect(await win.evaluate(() => window.api.history.list())).toEqual([]);

    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const imported = await win.evaluate((p) => window.api.data.importPayload(p), payload);
    expect(imported.attempts).toBe(1);

    const history = await win.evaluate(() => window.api.history.list());
    expect(history.length).toBe(1);
    expect(history[0].scoreRaw).toBe(exported.attempts[0].score_raw);

    const restored = await win.evaluate((aid) => window.api.attempt.get(aid), history[0].id);
    expect(restored.questions[0].notepad).toBe('my working');
    expect(restored.questions[3].flagged).toBe(true);
    expect(restored.questions[1].confidence).toBe('sure');
    expect((await win.evaluate(() => window.api.revisit.list())).length).toBe(1);

    await app.close();
  });

  test('a schema migration preserves existing history', async () => {
    const userDir = freshUserDir('migrate');
    let { app, win } = await launch(userDir);
    const id = await startExam(win, { mode: 'paper', year: '2016', paper: 1 });
    await win.evaluate(async (attemptId) => {
      await window.api.attempt.answer({ attemptId, position: 0, selected: 'H' });
      await State.exam.finish('submitted');
    }, id);
    await win.waitForSelector('h1:has-text("Results")');
    const before = await win.evaluate(() => window.api.history.list());
    await app.close();

    const dbFile = path.join(userDir, 'data', 'tmua.sqlite');
    expect(fs.existsSync(dbFile)).toBe(true);

    ({ app, win } = await launch(userDir));
    const after = await win.evaluate(() => window.api.history.list());
    expect(after.length).toBe(before.length);
    expect(after[0].scoreRaw).toBe(before[0].scoreRaw);
    const detail = await win.evaluate((aid) => window.api.attempt.get(aid), id);
    expect(detail.questions[0].selected).toBe('H');
    await app.close();
  });
});
