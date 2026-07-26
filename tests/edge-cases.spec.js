const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { freshUserDir, launch, startExam, answerKey, paperQuestions, ROOT } = require('./helpers');

test.describe('edge cases and abuse', () => {
  let userDir, app, win;
  test.beforeEach(async () => {
    userDir = freshUserDir('edge');
    ({ app, win } = await launch(userDir));
  });
  test.afterEach(async () => { if (app) await app.close().catch(() => {}); });

  test('submitting with zero answers scores 0/20 and does not crash', async () => {
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    await win.evaluate(() => State.exam.finish('submitted'));
    await win.waitForSelector('h1:has-text("Results")');

    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.scoreRaw).toBe(0);
    expect(a.questions.every(q => q.selected === null)).toBe(true);
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
    expect(text).toContain('0/20');
  });

  test('double submit creates no duplicate attempt and no second scoring', async () => {
    const key = answerKey('2019', 2);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 2 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 5; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
    }, { attemptId: id, key });

    // fire finish twice concurrently, as a double-click would
    await win.evaluate(() => {
      const e = State.exam;
      return Promise.all([e.finish('submitted'), e.finish('submitted')]);
    });
    await win.waitForSelector('h1:has-text("Results")');

    const history = await win.evaluate(() => window.api.history.list());
    expect(history.length).toBe(1);
    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.status).toBe('completed');
    expect(a.scoreRaw).toBe(5);

    // a third, direct finish call must be idempotent
    const again = await win.evaluate((i) =>
      window.api.attempt.finish({ attemptId: i, reason: 'submitted' }), id);
    expect(again.scoreRaw).toBe(5);
    expect((await win.evaluate(() => window.api.history.list())).length).toBe(1);
  });

  test('answering at the exact auto-submit moment leaves consistent data', async () => {
    const key = answerKey('2020', 1);
    const id = await startExam(win, { mode: 'paper', year: '2020', paper: 1, allowedSec: 3 });
    // race a burst of answers against expiry
    await win.evaluate(async ({ attemptId, key }) => {
      const writes = [];
      for (let i = 0; i < 20; i++) {
        writes.push(window.api.attempt.answer({ attemptId, position: i, selected: key[i] }));
      }
      await Promise.allSettled(writes);
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")', { timeout: 20000 });

    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.status).toBe('completed');
    // whatever landed before scoring, the marks must agree with the answers
    for (const q of a.questions) {
      const expectCorrect = Boolean(q.selected && q.selected === q.question.answer);
      expect(q.correct).toBe(expectCorrect);
    }
    expect(a.scoreRaw).toBe(a.questions.filter(q => q.correct).length);
    expect((await win.evaluate(() => window.api.history.list())).length).toBe(1);
  });

  test('starting a new exam warns and never destroys the in-progress one', async () => {
    const first = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    await win.evaluate(async (i) => {
      await window.api.attempt.answer({ attemptId: i, position: 0, selected: 'B' });
      if (State.exam) State.exam.teardown();
      await go('home');
    }, first);
    await win.waitForSelector('h1:has-text("Practise")');

    // capture the confirm text shown when starting another paper
    let dialogText = null;
    win.once('dialog', d => { dialogText = d.message(); });
    await win.locator('button:has-text("Start timed")').click();
    await win.waitForTimeout(600);

    expect(dialogText, 'a warning must be shown').toBeTruthy();
    expect(dialogText).toMatch(/in progress/i);
    expect(dialogText).toMatch(/resume/i);

    // the original attempt is untouched and still resumable
    const a = await win.evaluate((i) => window.api.attempt.get(i), first);
    expect(a.status).toBe('in_progress');
    expect(a.questions[0].selected).toBe('B');
    const resumable = await win.evaluate(() => window.api.attempt.resumable());
    expect(resumable.some(r => r.id === first)).toBe(true);
  });

  test('redoing a paper keeps the old attempt and hides its answers', async () => {
    const key = answerKey('2018', 2);
    const firstId = await startExam(win, { mode: 'paper', year: '2018', paper: 2 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 8; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, { attemptId: firstId, key });
    await win.waitForSelector('h1:has-text("Results")');
    const first = await win.evaluate((i) => window.api.attempt.get(i), firstId);
    expect(first.scoreRaw).toBe(8);

    // second attempt at the same paper
    const secondId = await startExam(win, { mode: 'paper', year: '2018', paper: 2 });
    expect(secondId).not.toBe(firstId);
    const second = await win.evaluate((i) => window.api.attempt.get(i), secondId);
    expect(second.questions.every(q => q.selected === null)).toBe(true);
    expect(second.questions.every(q => q.correct === null)).toBe(true);

    // the rendered exam shows no prior selection and no answer key
    expect(await win.locator('.opt.selected').count()).toBe(0);
    const leaked = await win.evaluate(() =>
      State.exam.a.questions.some(q => q.question.answer !== undefined));
    expect(leaked, 'answers must not be exposed during a live attempt').toBe(false);

    // the first attempt is unchanged
    const firstAfter = await win.evaluate((i) => window.api.attempt.get(i), firstId);
    expect(firstAfter.scoreRaw).toBe(8);
    expect(firstAfter.questions[0].selected).toBe(key[0]);
    const history = await win.evaluate(() => window.api.history.list());
    expect(history.filter(h => h.year === '2018' && h.paper === 2).length).toBe(2);
  });

  test('revisit list: add from review, redo it, then unmark', async () => {
    const key = answerKey('2017', 1);
    const id = await startExam(win, { mode: 'paper', year: '2017', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 3; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');

    await win.evaluate((i) => go('review', { attemptId: i }), id);
    await win.waitForSelector('.review-item');
    await win.locator('.review-item').first().locator('button:has-text("Revisit later")').click();
    await win.waitForTimeout(200);

    let list = await win.evaluate(() => window.api.revisit.list());
    expect(list.length).toBe(1);
    const qid = list[0].questionId;

    // it appears on the revisit screen
    await win.evaluate(() => go('revisit'));
    await win.waitForSelector('h1:has-text("Revisit list")');
    expect(await win.locator('tbody tr').count()).toBe(1);

    // one-click redo builds a drill of exactly that question
    await win.locator('button:has-text("Redo all as a drill")').click();
    await win.waitForSelector('.exam-bar');
    const drill = await win.evaluate(() => ({
      n: State.exam.a.questions.length,
      id: State.exam.a.questions[0].question.id,
      mode: State.exam.a.mode,
    }));
    expect(drill.n).toBe(1);
    expect(drill.id).toBe(qid);
    expect(drill.mode).toBe('drill');

    // unmark removes it
    await win.evaluate(async () => {
      await window.api.attempt.abandon(State.exam.a.id);
      State.exam.teardown();
      await go('revisit');
    });
    await win.waitForSelector('h1:has-text("Revisit list")');
    await win.locator('button:has-text("Remove")').click();
    await win.waitForTimeout(250);
    list = await win.evaluate(() => window.api.revisit.list());
    expect(list.length).toBe(0);
  });

  test('invalid timer settings are rejected, not silently clamped', async () => {
    const bad = [
      { baseMinutes: 0 }, { baseMinutes: -10 }, { baseMinutes: 99999 },
      { extraTimePercent: -5 }, { extraTimePercent: 5000 },
      { breakMinutes: -1 }, { baseMinutes: 'sixty' }, { baseMinutes: NaN },
      { hideTimer: 'yes' }, { nonsense: 1 },
    ];
    for (const patch of bad) {
      const res = await win.evaluate(async (p) => {
        try { await window.api.settings.set(p); return 'accepted'; }
        catch (e) { return 'rejected: ' + e.message; }
      }, patch);
      expect(res, `setting ${JSON.stringify(patch)}`).toMatch(/^rejected/);
    }
    // the stored settings are untouched
    const s = await win.evaluate(() => window.api.settings.get());
    expect(s.baseMinutes).toBe(75);
    expect(s.extraTimePercent).toBe(25);
    expect(s.breakMinutes).toBe(15);

    // valid values still work
    const ok = await win.evaluate(() =>
      window.api.settings.set({ baseMinutes: 90, extraTimePercent: 0 }));
    expect(ok.baseMinutes).toBe(90);
  });

  test('changing settings mid-exam does not alter the running exam', async () => {
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    const before = await win.evaluate(() => State.exam.allowed);
    expect(before).toBe(93 * 60);

    await win.evaluate(() => window.api.settings.set({ baseMinutes: 20, extraTimePercent: 0 }));
    await win.waitForTimeout(400);

    const after = await win.evaluate(() => State.exam.allowed);
    expect(after).toBe(before);
    const stored = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(stored.allowedSec).toBe(93 * 60);

    // but the next exam picks the new setting up
    await win.evaluate(async (i) => {
      await window.api.attempt.abandon(i);
      State.exam.teardown();
      await go('home');
    }, id);
    const next = await startExam(win, { mode: 'paper', year: '2019', paper: 2 });
    const a = await win.evaluate((i) => window.api.attempt.get(i), next);
    expect(a.allowedSec).toBe(20 * 60);
  });

  test('a drill built from filters returns exactly the matching questions', async () => {
    const res = await win.evaluate(() => window.api.drill.build({
      source: 'all', topics: ['integration'], years: ['2019'], papers: [1], shuffle: false,
    }));
    const expected = paperQuestions('2019', 1)
      .filter(q => q.topics.includes('integration')).map(q => q.id);
    expect(res.ids.slice().sort()).toEqual(expected.sort());
    expect(res.available).toBe(expected.length);
  });

  test('navigating away from the break does not lose the mock', async () => {
    const group = `mock-edge-${Date.now()}`;
    await startExam(win, { mode: 'mock', year: '2018', paper: 1, mockGroup: group, allowedSec: 3 });
    await win.waitForSelector('.break', { timeout: 25000 });

    // leave the break for the results screen, as the button offers
    await win.locator('button:has-text("View Paper 1 results")').click();
    await win.waitForSelector('h1:has-text("Results")');

    // paper 1 is safely recorded and the mock knows paper 2 is outstanding
    const summary = await win.evaluate((g) => window.api.mock.summary(g), group);
    expect(summary.papers.length).toBe(1);
    expect(summary.papers[0].paper).toBe(1);
    const next = await win.evaluate((g) => window.api.mock.next({ mockGroup: g, year: '2018' }), group);
    expect(next.next).toBe(2);
  });
});

test.describe('single instance', () => {
  test('a second launch on the same data directory does not open a rival window', async () => {
    const userDir = freshUserDir('single');
    const { app, win } = await launch(userDir);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    await win.evaluate((i) =>
      window.api.attempt.answer({ attemptId: i, position: 0, selected: 'C' }), id);

    // second process, same userData
    let secondOpened = false;
    let second = null;
    try {
      second = await electron.launch({
        args: [ROOT, `--user-data-dir=${userDir}`],
        timeout: 15000,
      });
      await second.firstWindow({ timeout: 6000 });
      secondOpened = true;
    } catch {
      secondOpened = false;
    } finally {
      if (second) await second.close().catch(() => {});
    }
    expect(secondOpened, 'second instance must not open its own window').toBe(false);

    // the first instance is unharmed and its data intact
    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.status).toBe('in_progress');
    expect(a.questions[0].selected).toBe('C');
    await app.close();
  });
});
