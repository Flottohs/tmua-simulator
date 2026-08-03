const { test, expect } = require('@playwright/test');
const fs = require('fs');
const {
  freshUserDir, launch, startExam, answerKey, paperQuestions,
} = require('./helpers');

test.describe('exam engine', () => {
  let userDir, app, win;

  test.beforeAll(async () => {
    userDir = freshUserDir('exam');
    ({ app, win } = await launch(userDir));
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  test('keyboard shortcuts, flagging, navigator and autosave', async () => {
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });

    // A-H selects an answer
    await win.keyboard.press('c');
    await expect(win.locator('.opt.selected .letter')).toHaveText('C');

    // F flags, and the navigator shows it
    await win.keyboard.press('f');
    await expect(win.locator('.navgrid button').first()).toHaveClass(/flagged/);

    // ArrowRight moves on, ArrowLeft comes back
    await win.keyboard.press('ArrowRight');
    await expect(win.locator('.side strong').first()).toHaveText('Question 2');
    await win.keyboard.press('e');
    await win.keyboard.press('ArrowLeft');
    await expect(win.locator('.side strong').first()).toHaveText('Question 1');
    await expect(win.locator('.opt.selected .letter')).toHaveText('C');

    // clicking the navigator jumps
    await win.locator('.navgrid button').nth(4).click();
    await expect(win.locator('.side strong').first()).toHaveText('Question 5');

    // every action was written straight to SQLite
    const stored = await win.evaluate(async (attemptId) => {
      const a = await window.api.attempt.get(attemptId);
      return a.questions.slice(0, 2).map(q => ({ sel: q.selected, flag: q.flagged }));
    }, id);
    expect(stored[0]).toEqual({ sel: 'C', flag: true });
    expect(stored[1]).toEqual({ sel: 'E', flag: false });

    await win.evaluate(async (attemptId) => {
      await window.api.attempt.abandon(attemptId);
      await go('home');
    }, id);
  });

  test('timer expires, auto-submits, and scores against the official key', async () => {
    const key = answerKey('2019', 2);
    // Answer 13 deliberately: 9 right, 4 wrong; leave 7 unanswered at timeout.
    const plan = key.map((correct, i) => {
      if (i >= 13) return null;
      if (i < 9) return correct;
      return correct === 'A' ? 'B' : 'A';
    });
    const expectedRaw = plan.filter((v, i) => v && v === key[i]).length;
    expect(expectedRaw).toBe(9);

    const id = await startExam(win, {
      mode: 'paper', year: '2019', paper: 2, allowedSec: 12,
    });

    await win.evaluate(async ({ attemptId, plan }) => {
      for (let i = 0; i < plan.length; i++) {
        if (!plan[i]) continue;
        await window.api.attempt.answer({ attemptId, position: i, selected: plan[i] });
        // mark the first three as 'sure' so confidence analytics has data
        if (i < 3) await window.api.attempt.confidence({ attemptId, position: i, confidence: 'sure' });
      }
      State.exam.a.questions.forEach((q, i) => { q.selected = plan[i] || null; });
      State.exam.paintNav();
    }, { attemptId: id, plan });

    // hard auto-submit at 0:00 — no interaction, just wait it out
    await win.waitForSelector('h1:has-text("Results")', { timeout: 40000 });

    const result = await win.evaluate(async (attemptId) =>
      window.api.attempt.get(attemptId), id);

    expect(result.status).toBe('completed');
    expect(result.finishReason).toBe('timeout');
    expect(result.scoreRaw).toBe(expectedRaw);
    expect(result.questions.filter(q => q.correct).length).toBe(expectedRaw);
    expect(result.questions.filter(q => !q.selected).length).toBe(7);

    // marks agree with the official answer key question by question
    for (let i = 0; i < 20; i++) {
      const q = result.questions[i];
      expect(q.question.answer).toBe(key[i]);
      expect(q.correct).toBe(Boolean(plan[i] && plan[i] === key[i]));
    }

    // scaled score comes from the official 2019 Paper 2 conversion table
    const conversions = JSON.parse(fs.readFileSync(require('path')
      .join(__dirname, '..', 'data', 'conversions.json'), 'utf8'));
    expect(result.scoreScaled).toBe(conversions['2019'].paper2[String(expectedRaw)]);

    // results screen reflects it
    await expect(win.locator('.stat .value').first()).toHaveText(`${expectedRaw}/20`);
    await expect(win.locator('.banner')).toContainText('Time expired');
  });

  test('wrong answers land in the log and analytics update', async () => {
    const d = await win.evaluate(() => window.api.analytics.dashboard());
    expect(d.summary.completedCount).toBeGreaterThanOrEqual(1);

    // 11 questions were not correct (4 wrong + 7 unanswered)
    const p2wrong = d.wrong.filter(w => w.year === '2019' && w.paper === 2);
    expect(p2wrong.length).toBe(11);
    expect(p2wrong.filter(w => w.unanswered).length).toBe(7);

    // every logged row carries the real key and topic tags
    for (const w of p2wrong) {
      expect(w.answer).toMatch(/^[A-H]$/);
      expect(w.topics.length).toBeGreaterThan(0);
      expect(w.selected).not.toBe(w.answer);
    }

    // topic accuracy is populated and confidence marking is recorded
    expect(d.topics.length).toBeGreaterThan(0);
    expect(d.topics.every(t => t.accuracy >= 0 && t.accuracy <= 1)).toBe(true);
    expect(d.confidence.sureRight + d.confidence.sureWrong).toBe(3);
    expect(d.pacing.unansweredAtTimeout).toBe(7);
  });

  test('review shows my answer, the key, and the worked solution', async () => {
    const attemptId = await win.evaluate(async () => {
      const rows = await window.api.history.list();
      const a = rows.find(r => r.status === 'completed');
      await go('review', { attemptId: a.id });
      return a.id;
    });
    await win.waitForSelector('.review-item');

    const first = win.locator('.review-item').first();
    await expect(first.locator('.opt.correct')).toHaveCount(1);
    await expect(first.locator('img.qimage')).toBeVisible();

    // question images actually resolve through the custom protocol
    const dims = await first.locator('img.qimage').evaluate(
      img => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(dims.w).toBeGreaterThan(200);
    expect(dims.h).toBeGreaterThan(100);

    // revisit marking persists
    await first.locator('button:has-text("Revisit later")').click();
    const list = await win.evaluate(() => window.api.revisit.list());
    // wrong answers populate this list automatically as well
    expect(list.some(r => r.questionId.startsWith('2019-P2'))).toBe(true);
    void attemptId;
  });

  test('history survives a full app restart', async () => {
    const before = await win.evaluate(() => window.api.history.list());
    const beforeRevisit = await win.evaluate(() => window.api.revisit.list());
    expect(before.length).toBeGreaterThanOrEqual(2);

    await app.close();
    ({ app, win } = await launch(userDir));

    const after = await win.evaluate(() => window.api.history.list());
    const afterRevisit = await win.evaluate(() => window.api.revisit.list());
    expect(after.length).toBe(before.length);
    expect(after[0].scoreRaw).toBe(before[0].scoreRaw);
    expect(after[0].scoreScaled).toBe(before[0].scoreScaled);
    expect(afterRevisit.length).toBe(beforeRevisit.length);

    // launch backup was written
    const backups = fs.readdirSync(require('path').join(userDir, 'data', 'backups'));
    expect(backups.filter(f => f.endsWith('.sqlite')).length).toBeGreaterThanOrEqual(1);
  });

  test('drill from wrong answers builds a real set', async () => {
    const res = await win.evaluate(() => window.api.drill.build({ source: 'wrong', shuffle: false }));
    expect(res.available).toBe(11);
    const ids = res.ids;
    expect(new Set(ids).size).toBe(ids.length);

    const attempt = await win.evaluate(async (qids) => {
      const a = await window.api.attempt.start({
        mode: 'drill', questionIds: qids, untimed: true, label: 'Drill · wrong answers',
      });
      return a;
    }, ids.slice(0, 5));
    expect(attempt.questions.length).toBe(5);
    expect(attempt.allowedSec).toBeNull();
    expect(attempt.remainingSec).toBeNull();
  });

  test('untimed practice has no clock and no auto-submit', async () => {
    const id = await startExam(win, { mode: 'untimed', year: '2016', paper: 1, untimed: true });
    await expect(win.locator('.timer')).toHaveText('Untimed');
    const a = await win.evaluate((attemptId) => window.api.attempt.get(attemptId), id);
    expect(a.allowedSec).toBeNull();
    await win.evaluate(async (attemptId) => {
      await window.api.attempt.abandon(attemptId); await go('home');
    }, id);
  });

  test('full mock runs two separate timers with a break between papers', async () => {
    const group = `mock-test-${Date.now()}`;
    const p1 = await startExam(win, {
      mode: 'mock', year: '2018', paper: 1, mockGroup: group, allowedSec: 8,
    });
    const a1 = await win.evaluate((id) => window.api.attempt.get(id), p1);
    expect(a1.allowedSec).toBe(8);

    // let Paper 1 time out; the break screen should appear next
    await win.waitForSelector('.break', { timeout: 30000 });
    await expect(win.locator('.break h1')).toHaveText('Break');

    await win.locator('button:has-text("Skip break")').click();
    await win.waitForSelector('.exam-bar', { timeout: 20000 });

    const live = await win.evaluate(() => ({
      paper: State.exam.a.paper, allowed: State.exam.allowed, group: State.exam.a.mockGroup,
    }));
    expect(live.paper).toBe(2);
    expect(live.group).toBe(group);
    // Paper 2 gets its own fresh clock, not the remainder of Paper 1's
    expect(live.allowed).toBeGreaterThan(60);

    await win.evaluate(async () => {
      await window.api.attempt.abandon(State.exam.a.id);
      State.exam.teardown();
      await go('home');
    });
  });
});
