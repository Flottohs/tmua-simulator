const { test, expect } = require('@playwright/test');
const { freshUserDir, launch, startExam } = require('./helpers');

// Set up an in-progress exam, park it on question 5 with two answers saved,
// then kill the app the given way and check the reopened app restores the
// exact question, the answers, and the correct remaining time.
async function interruptAndResume(t, killer) {
  const userDir = freshUserDir('crash');
  let { app, win } = await launch(userDir);

  const id = await startExam(win, { mode: 'paper', year: '2021', paper: 1, allowedSec: 600 });

  await win.keyboard.press('b');            // answer Q1
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('d');            // answer Q2
  await win.locator('.navgrid button').nth(4).click();   // park on Q5
  await expect(win.locator('.side strong').first()).toHaveText('Question 5');

  // let the clock run and the heartbeat persist
  await win.waitForTimeout(3000);
  const before = await win.evaluate(() => ({
    remaining: State.exam.remaining,
    index: State.exam.index,
  }));
  expect(before.index).toBe(4);
  expect(before.remaining).toBeLessThan(600);

  await killer(app, win);

  ({ app, win } = await launch(userDir));
  const resumable = await win.evaluate(() => window.api.attempt.resumable());
  expect(resumable.length).toBe(1);
  const r = resumable[0];

  expect(r.id).toBe(id);
  expect(r.currentIndex).toBe(4);
  expect(r.questions[0].selected).toBe('B');
  expect(r.questions[1].selected).toBe('D');

  // Remaining time is preserved. Persisted elapsed lags live elapsed by at
  // most one 1s heartbeat, so a crash can only ever hand time back — never
  // take it away.
  expect(r.remainingSec).toBeGreaterThanOrEqual(before.remaining - 0.1);
  expect(r.remainingSec).toBeLessThanOrEqual(before.remaining + 1.5);

  // and the UI genuinely reopens on question 5 with the clock where it was
  await win.evaluate((attemptId) => go('exam', { attemptId }), id);
  await win.waitForSelector('.exam-bar');
  await expect(win.locator('.side strong').first()).toHaveText('Question 5');
  const live = await win.evaluate(() => State.exam.remaining);
  expect(live).toBeLessThanOrEqual(before.remaining + 1.5);

  await app.close().catch(() => {});
}

test.describe('crash and quit resume', () => {
  test('SIGKILL (hard crash) resumes at the same question and time', async () => {
    await interruptAndResume(test, async (app) => {
      const proc = app.process();
      process.kill(proc.pid, 'SIGKILL');
      await new Promise(r => setTimeout(r, 1200));
    });
  });

  test('Cmd+Q (app quit) resumes at the same question and time', async () => {
    await interruptAndResume(test, async (app) => {
      await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
      await new Promise(r => setTimeout(r, 1200));
    });
  });

  test('closing the window resumes at the same question and time', async () => {
    await interruptAndResume(test, async (app) => {
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) w.close();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 800));
      await app.close().catch(() => {});
    });
  });

  test('an interrupted attempt is never silently scored', async () => {
    const userDir = freshUserDir('crash-unscored');
    let { app, win } = await launch(userDir);
    const id = await startExam(win, { mode: 'paper', year: '2020', paper: 1, allowedSec: 600 });
    await win.keyboard.press('a');
    await win.waitForTimeout(2500);
    process.kill(app.process().pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 1200));

    ({ app, win } = await launch(userDir));
    const hist = await win.evaluate(() => window.api.history.list());
    const row = hist.find(h => h.id === id);
    expect(row.status).toBe('in_progress');
    expect(row.scoreRaw).toBeNull();
    await app.close().catch(() => {});
  });
});
