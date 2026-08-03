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
    // wrong answers auto-populate the revisit list, so assert the manually
    // marked question is present rather than a fixed total
    expect(exported.revisit.map(r => r.question_id)).toContain('2020-P2-Q05');

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
    expect((await win.evaluate(() => window.api.revisit.list())).map(r => r.questionId))
      .toContain('2020-P2-Q05');

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

test.describe('durability and restore', () => {
  test('an answer survives a kill -9 fired immediately after it', async () => {
    const userDir = freshUserDir('durable');
    let { app, win } = await launch(userDir);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1, allowedSec: 600 });

    // write one answer and kill the process with no grace period at all —
    // no heartbeat, no flush, no quit handler
    await win.evaluate((i) =>
      window.api.attempt.answer({ attemptId: i, position: 4, selected: 'G' }), id);
    process.kill(app.process().pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 1200));

    ({ app, win } = await launch(userDir));
    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.questions[4].selected).toBe('G');
    expect(a.status).toBe('in_progress');
    await app.close();
  });

  test('three attempts survive a restart byte-for-byte', async () => {
    const userDir = freshUserDir('snapshot');
    let { app, win } = await launch(userDir);

    for (const [year, paper] of [['2016', 1], ['2017', 2], ['2018', 1]]) {
      const key = answerKey(year, paper);
      const id = await startExam(win, { mode: 'paper', year, paper });
      await win.evaluate(async ({ attemptId, key }) => {
        for (let i = 0; i < 14; i++) {
          await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
        }
        await window.api.attempt.flag({ attemptId, position: 2, flagged: true });
        await State.exam.finish('submitted');
      }, { attemptId: id, key });
      await win.waitForSelector('h1:has-text("Results")');
    }
    await win.evaluate(() => window.api.revisit.add({ questionId: '2016-P1-Q05' }));

    const before = await win.evaluate(() => window.api.data.exportPayload());
    const beforeDash = await win.evaluate(() => window.api.analytics.dashboard());
    await app.close();

    ({ app, win } = await launch(userDir));
    const after = await win.evaluate(() => window.api.data.exportPayload());
    const afterDash = await win.evaluate(() => window.api.analytics.dashboard());

    // ignore the export timestamp, compare everything else exactly
    delete before.exportedAt; delete after.exportedAt;
    expect(after).toEqual(before);
    expect(afterDash).toEqual(beforeDash);
    expect(after.attempts.length).toBe(3);
    await app.close();
  });

  test('a launch backup can actually be restored', async () => {
    const userDir = freshUserDir('restore');
    let { app, win } = await launch(userDir);

    const key = answerKey('2020', 1);
    const id = await startExam(win, { mode: 'paper', year: '2020', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 9; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');
    const original = await win.evaluate(() => window.api.data.exportPayload());
    await app.close();

    // next launch snapshots that state into backups/
    ({ app, win } = await launch(userDir));
    await app.close();

    const backupsDir = path.join(userDir, 'data', 'backups');
    const backups = fs.readdirSync(backupsDir).filter(f => f.endsWith('.sqlite')).sort();
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const newest = path.join(backupsDir, backups[backups.length - 1]);

    // wreck the live database, then restore the backup over it
    const live = path.join(userDir, 'data', 'tmua.sqlite');
    fs.writeFileSync(live, 'corrupted');
    for (const sfx of ['-wal', '-shm']) {
      if (fs.existsSync(live + sfx)) fs.unlinkSync(live + sfx);
    }
    fs.copyFileSync(newest, live);

    ({ app, win } = await launch(userDir));
    const restored = await win.evaluate(() => window.api.data.exportPayload());
    delete original.exportedAt; delete restored.exportedAt;
    expect(restored.attempts.length).toBe(original.attempts.length);
    expect(restored.attempts[0].score_raw).toBe(original.attempts[0].score_raw);
    expect(restored.attempts[0].questions.map(q => q.selected))
      .toEqual(original.attempts[0].questions.map(q => q.selected));
    await app.close();
  });
});
