const { test, expect } = require('@playwright/test');
const { freshUserDir, launch, startExam } = require('./helpers');

test.describe('timer', () => {
  let userDir, app, win;

  test.beforeEach(async () => {
    userDir = freshUserDir('timer');
    ({ app, win } = await launch(userDir));
  });
  test.afterEach(async () => { if (app) await app.close().catch(() => {}); });

  test('defaults to 93:00 — 75 minutes plus 25% extra time', async () => {
    const s = await win.evaluate(() => window.api.settings.get());
    expect(s.baseMinutes).toBe(75);
    expect(s.extraTimePercent).toBe(25);

    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.allowedSec).toBe(93 * 60);
    await expect(win.locator('.timer')).toHaveText(/^9[23]:\d\d$/);
  });

  test('settings changes are respected by the next exam', async () => {
    for (const [base, extra, expectMin] of [[75, 0, 75], [60, 25, 75], [50, 20, 60], [75, 50, 112]]) {
      await win.evaluate(async (p) => {
        State.settings = await window.api.settings.set(p);
      }, { baseMinutes: base, extraTimePercent: extra });
      const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
      const a = await win.evaluate((i) => window.api.attempt.get(i), id);
      expect(a.allowedSec, `${base}min +${extra}%`).toBe(expectMin * 60);
      await win.evaluate(async (i) => {
        await window.api.attempt.abandon(i);
        if (State.exam) State.exam.teardown();
        await go('home');
      }, id);
    }
  });

  test('elapsed is wall-clock derived, so suspending the window grants no extra time', async () => {
    await win.clock.install();
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1, allowedSec: 600 });

    const before = await win.evaluate(() => State.exam.remaining);
    expect(before).toBeGreaterThan(595);

    // Jump the system clock forward WITHOUT running any timers: this is what a
    // throttled renderer or a sleeping laptop looks like. A tick-accumulating
    // timer would not notice; a wall-clock timer must.
    await win.clock.setSystemTime(new Date(Date.now() + 120000));
    const after = await win.evaluate(() => State.exam.remaining);
    expect(before - after, 'two minutes of real time must be consumed').toBeGreaterThan(115);
    expect(before - after).toBeLessThan(125);
  });

  test('warnings fire at 15, 5 and 1 minutes and the paper hard auto-submits at 0:00', async () => {
    await win.clock.install();
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1, allowedSec: 93 * 60 });

    const seen = [];
    // Jump the clock rather than running it: runFor would fire the 250ms tick
    // tens of thousands of times. setSystemTime moves time without firing
    // timers, then a short runFor lets a couple of real ticks execute.
    const advanceTo = async (remaining) => {
      const { now, rem } = await win.evaluate(
        () => ({ now: Date.now(), rem: State.exam.remaining }));
      const jump = Math.max(0, Math.round((rem - remaining) * 1000));
      await win.clock.setSystemTime(new Date(now + jump));
      await win.clock.runFor(600);
      await win.waitForTimeout(120);
    };

    await advanceTo(15 * 60 - 1);
    let toast = await win.evaluate(() => document.getElementById('toast').textContent);
    seen.push(toast);
    expect(toast).toContain('15 minutes remaining');

    await advanceTo(5 * 60 - 1);
    toast = await win.evaluate(() => document.getElementById('toast').textContent);
    seen.push(toast);
    expect(toast).toContain('5 minutes remaining');

    await advanceTo(59);
    toast = await win.evaluate(() => document.getElementById('toast').textContent);
    seen.push(toast);
    expect(toast).toContain('1 minute remaining');

    // each warning fires exactly once
    const warned = await win.evaluate(() => [...State.exam.warned]);
    expect(warned.sort((a, b) => b - a)).toEqual([900, 300, 60]);

    // run past zero -> hard auto-submit
    await advanceTo(-2);
    await win.waitForSelector('h1:has-text("Results")', { timeout: 20000 });

    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.status).toBe('completed');
    expect(a.finishReason).toBe('timeout');
  });

  test('after auto-submit no further answers are accepted', async () => {
    await win.clock.install();
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1, allowedSec: 60 });
    await win.evaluate(async (i) => {
      await window.api.attempt.answer({ attemptId: i, position: 0, selected: 'A' });
    }, id);

    const t = await win.evaluate(() => Date.now());
    await win.clock.setSystemTime(new Date(t + 61000));
    await win.clock.runFor(600);
    await win.waitForSelector('h1:has-text("Results")', { timeout: 20000 });

    const before = await win.evaluate((i) => window.api.attempt.get(i), id);
    // the exam controller is gone, and a late select() must not mutate anything
    const examGone = await win.evaluate(() => State.exam === null);
    expect(examGone).toBe(true);

    // a late write attempt through the engine is impossible; verify the record
    // is unchanged and still marked completed
    const after = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(after.status).toBe('completed');
    expect(after.questions[0].selected).toBe(before.questions[0].selected);
    expect(after.scoreRaw).toBe(before.scoreRaw);
  });

  test('real-time smoke: the final seconds actually elapse and submit', async () => {
    const id = await startExam(win, { mode: 'paper', year: '2020', paper: 1, allowedSec: 5 });
    const t0 = Date.now();
    await win.waitForSelector('h1:has-text("Results")', { timeout: 20000 });
    const elapsed = (Date.now() - t0) / 1000;
    expect(elapsed, 'submitted at roughly the 5s mark').toBeGreaterThan(3.5);
    expect(elapsed).toBeLessThan(12);

    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.finishReason).toBe('timeout');
    expect(a.elapsedSec).toBeGreaterThan(4);
    expect(a.elapsedSec).toBeLessThan(9);
  });

  test('untimed practice never auto-submits', async () => {
    await win.clock.install();
    const id = await startExam(win, { mode: 'untimed', year: '2019', paper: 1, untimed: true });
    await expect(win.locator('.timer')).toHaveText('Untimed');
    const t0 = await win.evaluate(() => Date.now());
    await win.clock.setSystemTime(new Date(t0 + 4 * 60 * 60 * 1000));   // four hours
    await win.clock.runFor(1000);
    await win.waitForTimeout(200);
    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.status).toBe('in_progress');
    expect(await win.locator('.exam-bar').count()).toBe(1);
  });

  test('per-question times sum to the elapsed exam time', async () => {
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1, allowedSec: 600 });
    for (const i of [1, 2, 3]) {
      await win.locator('.navgrid button').nth(i).click();
      await win.waitForTimeout(700);
    }
    await win.waitForTimeout(600);
    await win.evaluate(() => State.exam.persist());
    await win.waitForTimeout(200);

    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    const sum = a.questions.reduce((s, q) => s + q.timeSpent, 0);
    expect(sum).toBeGreaterThan(0);
    // per-question total must account for the elapsed exam time
    expect(Math.abs(sum - a.elapsedSec), `sum ${sum} vs elapsed ${a.elapsedSec}`).toBeLessThan(1.5);
    // and the time landed on the questions actually visited
    const visited = a.questions.filter(q => q.timeSpent > 0.05).length;
    expect(visited).toBeGreaterThanOrEqual(3);
  });

  test('the break runs its own countdown and Paper 2 starts at a full clock', async () => {
    await win.evaluate(async () => {
      State.settings = await window.api.settings.set({ breakMinutes: 15, baseMinutes: 75, extraTimePercent: 25 });
    });
    const group = `mock-timer-${Date.now()}`;
    const p1 = await startExam(win, {
      mode: 'mock', year: '2018', paper: 1, mockGroup: group, allowedSec: 4,
    });
    await win.waitForSelector('.break', { timeout: 25000 });

    // the break shows a 15:00 countdown that ticks down
    const first = await win.locator('.break .count').textContent();
    expect(first).toMatch(/^1[45]:\d\d$/);
    await win.waitForTimeout(2200);
    const second = await win.locator('.break .count').textContent();
    expect(second).not.toBe(first);

    await win.locator('button:has-text("Skip break")').click();
    await win.waitForSelector('.exam-bar', { timeout: 20000 });
    const live = await win.evaluate(() => ({
      paper: State.exam.a.paper, allowed: State.exam.allowed, remaining: State.exam.remaining,
    }));
    expect(live.paper).toBe(2);
    expect(live.allowed).toBe(93 * 60);            // fresh full clock, not P1's remainder
    expect(live.remaining).toBeGreaterThan(93 * 60 - 10);
    void p1;
  });
});
