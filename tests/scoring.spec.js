const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { freshUserDir, launch, startExam, paperQuestions, answerKey, ROOT } = require('./helpers');

const CONV = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'conversions.json'), 'utf8'));

// Run a paper with a caller-supplied answer plan and return the stored attempt.
async function runPaper(win, { year, paper, plan, allowedSec, reason = 'submitted' }) {
  const id = await startExam(win, { mode: 'paper', year, paper, allowedSec });
  await win.evaluate(async ({ attemptId, plan }) => {
    for (let i = 0; i < plan.length; i++) {
      if (plan[i]) await window.api.attempt.answer({ attemptId, position: i, selected: plan[i] });
    }
  }, { attemptId: id, plan });
  if (reason === 'timeout') {
    await win.waitForSelector('h1:has-text("Results")', { timeout: 30000 });
  } else {
    await win.evaluate(() => State.exam.finish('submitted'));
    await win.waitForSelector('h1:has-text("Results")', { timeout: 20000 });
  }
  return win.evaluate((i) => window.api.attempt.get(i), id);
}

test.describe('scoring and results', () => {
  let userDir, app, win;
  test.beforeAll(async () => {
    userDir = freshUserDir('scoring');
    ({ app, win } = await launch(userDir));
  });
  test.afterAll(async () => { if (app) await app.close().catch(() => {}); });

  test('all correct scores 20/20 and the top scaled score', async () => {
    const key = answerKey('2022', 1);
    const a = await runPaper(win, { year: '2022', paper: 1, plan: key });
    expect(a.scoreRaw).toBe(20);
    expect(a.questions.every(q => q.correct)).toBe(true);
    expect(a.scoreScaled).toBe(CONV['2022'].paper1['20']);
    await expect(win.locator('.stat .value').first()).toHaveText('20/20');
  });

  test('all wrong scores 0/20 and the bottom scaled score', async () => {
    const key = answerKey('2022', 2);
    const opts = paperQuestions('2022', 2).map(q => q.options);
    // pick a valid but wrong letter for every question
    const plan = key.map((correct, i) => {
      const letters = 'ABCDEFGH'.slice(0, opts[i]).split('');
      return letters.find(L => L !== correct);
    });
    const a = await runPaper(win, { year: '2022', paper: 2, plan });
    expect(a.scoreRaw).toBe(0);
    expect(a.questions.every(q => q.correct === false)).toBe(true);
    expect(a.scoreScaled).toBe(CONV['2022'].paper2['0']);
  });

  test('a fixed mixed pattern gives the exact score and exact per-topic breakdown', async () => {
    const year = '2021', paper = 1;
    const qs = paperQuestions(year, paper);
    const key = qs.map(q => q.answer);

    // deterministic pattern: correct on every 3rd question, wrong elsewhere,
    // last three left blank
    const plan = key.map((correct, i) => {
      if (i >= 17) return null;
      if (i % 3 === 0) return correct;
      const letters = 'ABCDEFGH'.slice(0, qs[i].options).split('');
      return letters.find(L => L !== correct);
    });

    // expected values computed here, independently of the app
    const expectedCorrect = plan.filter((v, i) => v && v === key[i]).length;
    const expectedTopics = new Map();
    plan.forEach((sel, i) => {
      const right = Boolean(sel && sel === key[i]);
      for (const t of qs[i].topics) {
        if (!expectedTopics.has(t)) expectedTopics.set(t, { seen: 0, correct: 0 });
        const s = expectedTopics.get(t);
        s.seen++;
        if (right) s.correct++;
      }
    });

    const a = await runPaper(win, { year, paper, plan });
    expect(a.scoreRaw).toBe(expectedCorrect);
    expect(a.scoreScaled).toBe(CONV[year].paper1[String(expectedCorrect)]);

    // per-question marks match exactly
    a.questions.forEach((q, i) => {
      expect(q.correct, `Q${i + 1}`).toBe(Boolean(plan[i] && plan[i] === key[i]));
      expect(q.selected).toBe(plan[i] ?? null);
    });

    // the app's own per-topic table matches the independently computed values
    const shown = await win.evaluate(() =>
      [...document.querySelectorAll('.card table tbody tr')].map(tr => {
        const c = tr.querySelectorAll('td');
        return { topic: c[0].textContent.trim(), fraction: c[1].textContent.trim() };
      }));
    const tax = await win.evaluate(() => State.catalog.taxonomy);
    for (const [topic, s] of expectedTopics) {
      const label = tax[topic];
      const row = shown.find(r => r.topic === label);
      expect(row, `topic row for ${label}`).toBeTruthy();
      expect(row.fraction, `${label} breakdown`).toBe(`${s.correct}/${s.seen}`);
    }
    expect(shown.length).toBe(expectedTopics.size);
  });

  test('unanswered questions at timeout are unanswered, not wrong guesses', async () => {
    const year = '2020', paper = 2;
    const key = answerKey(year, paper);
    const plan = key.map((k, i) => (i < 6 ? k : null));   // 6 answered, 14 blank

    const a = await runPaper(win, { year, paper, plan, allowedSec: 6, reason: 'timeout' });
    expect(a.finishReason).toBe('timeout');
    expect(a.scoreRaw).toBe(6);

    const blanks = a.questions.filter(q => !q.selected);
    expect(blanks.length).toBe(14);
    // blank means selected === null and correct === false; never a fabricated letter
    for (const q of blanks) {
      expect(q.selected).toBeNull();
      expect(q.correct).toBe(false);
    }
    // and the results screen counts them
    const unansweredStat = await win.evaluate(() =>
      [...document.querySelectorAll('.stat')]
        .find(s => s.textContent.includes('Unanswered'))
        .querySelector('.value').textContent.trim());
    expect(unansweredStat).toBe('14');
  });

  test('scaled scores match the official table at every raw score including 0 and 20', async () => {
    const year = '2019', paper = 1;
    const qs = paperQuestions(year, paper);
    const key = qs.map(q => q.answer);

    for (const target of [0, 1, 10, 19, 20]) {
      const plan = key.map((correct, i) => {
        if (i < target) return correct;
        const letters = 'ABCDEFGH'.slice(0, qs[i].options).split('');
        return letters.find(L => L !== correct);
      });
      const a = await runPaper(win, { year, paper, plan });
      expect(a.scoreRaw, `target ${target}`).toBe(target);
      expect(a.scoreScaled, `scaled for raw ${target}`).toBe(CONV[year].paper1[String(target)]);

      const shown = await win.evaluate(() =>
        [...document.querySelectorAll('.stat')]
          .find(s => s.textContent.includes('Estimated'))
          .querySelector('.value').textContent.trim());
      expect(shown).toBe(CONV[year].paper1[String(target)].toFixed(1));
    }
  });

  test('a paper with no conversion table degrades gracefully', async () => {
    const key = answerKey('specimen', 1);
    const a = await runPaper(win, { year: 'specimen', paper: 1, plan: key });
    expect(a.scoreRaw).toBe(20);
    expect(a.scoreScaled).toBeNull();

    const shown = await win.evaluate(() =>
      [...document.querySelectorAll('.stat')]
        .find(s => s.textContent.includes('Estimated')).textContent);
    expect(shown).toContain('—');
    expect(shown).toContain('no official table');
    expect(shown).not.toMatch(/NaN|undefined|null/);
  });

  test('review shows my answer, the correct answer, the solution and my time', async () => {
    const year = '2018', paper = 1;
    const qs = paperQuestions(year, paper);
    const key = qs.map(q => q.answer);
    const plan = key.map((correct, i) => {
      if (i === 0) return correct;
      if (i === 1) return 'ABCDEFGH'.slice(0, qs[i].options).split('').find(L => L !== correct);
      return null;
    });
    const a = await runPaper(win, { year, paper, plan });

    await win.evaluate((id) => go('review', { attemptId: id }), a.id);
    await win.waitForSelector('.review-item');

    const items = win.locator('.review-item');
    // Q1 correct
    await expect(items.nth(0).locator('.pill.good')).toHaveText('Correct');
    // Q2 wrong, and it names the letter chosen
    await expect(items.nth(1).locator('.pill.bad')).toContainText(`you chose ${plan[1]}`);
    // Q3 unanswered
    await expect(items.nth(2).locator('.pill.bad')).toHaveText('Not answered');

    // the correct answer is marked on every item, and the solution image loads
    for (const i of [0, 1, 2]) {
      const item = items.nth(i);
      await expect(item.locator('.opt.correct')).toHaveCount(1);
      const letter = await item.locator('.opt.correct .letter').textContent();
      expect(letter.trim()).toBe(key[i]);

      await item.locator('summary:has-text("Official worked solution")').click();
      const dims = await item.locator('img.solution-img').evaluate(
        img => new Promise(res => {
          if (img.complete) return res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => res({ w: 0, h: 0 });
        }));
      expect(dims.w, `solution image for Q${i + 1}`).toBeGreaterThan(200);
    }

    // time spent is shown per question
    const timePill = await items.nth(0).locator('.pill').filter({ hasText: /\d+(s|m)/ }).first().textContent();
    expect(timePill).toMatch(/^\d+(s|m \d+s)$/);
  });
});
