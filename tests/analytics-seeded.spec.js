const { test, expect } = require('@playwright/test');
const { freshUserDir, launch, paperQuestions, CONTENT } = require('./helpers');

// ---------------------------------------------------------------------------
// A fabricated history with a deliberate shape:
//   - every question tagged 'logic-truth' is answered WRONG
//   - every question in positions 16-20 is answered WRONG
//   - one question per paper is left blank
//   - everything else is CORRECT
// Expected analytics are computed here, by hand, from the same rules.
// ---------------------------------------------------------------------------
const SEED_PAPERS = [
  ['2019', 1], ['2019', 2], ['2020', 1], ['2020', 2], ['2021', 1],
];
const BASE_TIME = Date.UTC(2026, 4, 4, 9, 0, 0);   // a Monday

function wrongLetterFor(q) {
  const letters = 'ABCDEFGH'.slice(0, q.options).split('');
  return letters.find(L => L !== q.answer);
}

function buildSeed() {
  const attempts = [];
  const expected = {
    wrong: [],            // {questionId, selected, answer, unanswered}
    perAttempt: [],       // {year, paper, raw}
    topic: new Map(),     // topic -> {seen, correct}
    bucket: [0, 1, 2, 3].map(() => ({ seen: 0, correct: 0 })),
    unansweredCount: 0,
  };

  SEED_PAPERS.forEach(([year, paper], ai) => {
    const qs = paperQuestions(year, paper);
    const questions = [];
    let raw = 0;

    qs.forEach((q, i) => {
      const isLogic = q.topics.includes('logic-truth');
      const isLate = i >= 15;
      const isBlank = i === 7;                    // one blank per paper
      let selected = null, correct = false;

      if (isBlank) {
        selected = null;
        expected.unansweredCount++;
      } else if (isLogic || isLate) {
        selected = wrongLetterFor(q);
      } else {
        selected = q.answer;
        correct = true;
      }
      if (correct) raw++;
      if (!correct) {
        expected.wrong.push({
          questionId: q.id, selected, answer: q.answer,
          unanswered: selected === null, year, paper, topics: q.topics,
        });
      }
      for (const t of q.topics) {
        if (!expected.topic.has(t)) expected.topic.set(t, { seen: 0, correct: 0 });
        const s = expected.topic.get(t);
        s.seen++;
        if (correct) s.correct++;
      }
      const b = expected.bucket[Math.min(3, Math.floor(i / 5))];
      b.seen++;
      if (correct) b.correct++;

      questions.push({
        attempt_id: ai + 1, position: i, question_id: q.id,
        selected, correct: correct ? 1 : 0, flagged: i === 3 ? 1 : 0,
        confidence: i % 2 ? 'sure' : 'unsure',
        time_spent: 30 + i, notepad: null, updated_at: BASE_TIME,
      });
    });

    expected.perAttempt.push({ year, paper, raw });
    attempts.push({
      id: ai + 1, mode: 'paper', year, paper, mock_group: null, status: 'completed',
      started_at: BASE_TIME + ai * 86400000,
      completed_at: BASE_TIME + ai * 86400000 + 5400000,
      allowed_sec: 5580, elapsed_sec: 5400, current_index: 19,
      finish_reason: 'submitted', score_raw: raw, score_scaled: null,
      label: null, settings_json: '{}', questions,
    });
  });

  return { payload: { attempts, revisit: [], settings: {} }, expected };
}

const { payload: SEED, expected: EXP } = buildSeed();

test.describe('analytics on seeded data', () => {
  let userDir, app, win, dash;

  test.beforeAll(async () => {
    userDir = freshUserDir('analytics');
    ({ app, win } = await launch(userDir));
    await win.evaluate((p) => window.api.data.importPayload(p), SEED);
    dash = await win.evaluate(() => window.api.analytics.dashboard());
  });
  test.afterAll(async () => { if (app) await app.close().catch(() => {}); });

  test('the seed is shaped as intended', () => {
    expect(SEED.attempts.length).toBe(5);
    expect(EXP.wrong.length).toBeGreaterThan(20);
    expect(EXP.unansweredCount).toBe(5);
    const logic = EXP.topic.get('logic-truth');
    expect(logic.correct).toBe(0);
    expect(logic.seen).toBeGreaterThan(3);
  });

  test('wrong-answer log contains exactly the seeded wrong answers', () => {
    expect(dash.wrong.length).toBe(EXP.wrong.length);
    const got = new Map(dash.wrong.map(w => [w.questionId, w]));
    for (const e of EXP.wrong) {
      const w = got.get(e.questionId);
      expect(w, `missing ${e.questionId}`).toBeTruthy();
      expect(w.answer).toBe(e.answer);
      expect(w.selected).toBe(e.selected);
      expect(Boolean(w.unanswered)).toBe(e.unanswered);
      expect(w.year).toBe(e.year);
      expect(w.paper).toBe(e.paper);
    }
    // nothing correct leaked into the log
    for (const w of dash.wrong) {
      expect(w.selected === null || w.selected !== w.answer).toBe(true);
    }
  });

  test('weakness ranking puts logic & truth on top with the exact accuracy', () => {
    const logic = dash.topics.find(t => t.topic === 'logic-truth');
    const exp = EXP.topic.get('logic-truth');
    expect(logic.seen).toBe(exp.seen);
    expect(logic.correct).toBe(0);
    expect(logic.accuracy).toBe(0);
    // topics are ordered worst-first
    expect(dash.topics[0].accuracy).toBeLessThanOrEqual(dash.topics[1].accuracy);
    expect(dash.weaknesses[0].topic).toBe('logic-truth');
    expect(dash.weaknesses[0].advice.revise).toBeTruthy();
    expect(dash.weaknesses[0].advice.drill).toBeTruthy();

    // every topic figure matches the hand-computed value
    for (const t of dash.topics) {
      const e = EXP.topic.get(t.topic);
      expect(e, `unexpected topic ${t.topic}`).toBeTruthy();
      expect(t.seen, `${t.topic} seen`).toBe(e.seen);
      expect(t.correct, `${t.topic} correct`).toBe(e.correct);
      expect(t.accuracy).toBeCloseTo(e.correct / e.seen, 10);
    }
  });

  test('the late-paper pacing pattern is detected and quantified', () => {
    const b = dash.pacing.buckets;
    expect(b.length).toBe(4);
    b.forEach((bucket, i) => {
      expect(bucket.seen).toBe(EXP.bucket[i].seen);
      expect(bucket.correct).toBe(EXP.bucket[i].correct);
    });
    // by construction the last five questions are always wrong
    expect(b[3].accuracy).toBe(0);
    expect(b[0].accuracy).toBeGreaterThan(0.5);
    expect(dash.pacing.note, 'pacing note should be raised').toBeTruthy();
    expect(dash.pacing.note).toMatch(/Q16-20|pacing/);
    expect(dash.pacing.avgSecPerQuestion).toBeGreaterThan(0);
  });

  test('score trend and Paper 1 vs Paper 2 match the seeded results', () => {
    expect(dash.summary.completedCount).toBe(5);
    const trend = dash.summary.trend;
    expect(trend.length).toBe(5);
    trend.forEach((t, i) => {
      expect(t.year).toBe(EXP.perAttempt[i].year);
      expect(t.paper).toBe(EXP.perAttempt[i].paper);
      expect(t.raw).toBe(EXP.perAttempt[i].raw);
    });

    const p1 = EXP.perAttempt.filter(a => a.paper === 1);
    const p2 = EXP.perAttempt.filter(a => a.paper === 2);
    expect(dash.summary.byPaperType[1].n).toBe(p1.length);
    expect(dash.summary.byPaperType[1].raw).toBe(p1.reduce((s, a) => s + a.raw, 0));
    expect(dash.summary.byPaperType[2].n).toBe(p2.length);
    expect(dash.summary.byPaperType[2].raw).toBe(p2.reduce((s, a) => s + a.raw, 0));

    // papers not attempted excludes the five seeded ones
    const done = new Set(SEED_PAPERS.map(([y, p]) => `${y}-P${p}`));
    for (const p of dash.summary.notDone) expect(done.has(p.key)).toBe(false);
    expect(dash.summary.notDone.length).toBe(18 - SEED_PAPERS.length);
  });

  test('the wrong-answer log filters by topic, paper and year', async () => {
    await win.evaluate(() => go('dashboard'));
    await win.waitForSelector('.wrong-row');

    const countRows = () => win.locator('.wrong-row').count();
    const total = await countRows();
    expect(total).toBe(Math.min(EXP.wrong.length, 200));

    // filter by topic
    await win.selectOption('#filter-topic', 'logic-truth');
    const logicRows = await countRows();
    const expLogic = EXP.wrong.filter(w => w.topics.includes('logic-truth')).length;
    expect(logicRows).toBe(expLogic);
    await win.selectOption('#filter-topic', 'all');

    // filter by paper
    await win.selectOption('#filter-paper', '2');
    const p2Rows = await countRows();
    expect(p2Rows).toBe(EXP.wrong.filter(w => w.paper === 2).length);
    await win.selectOption('#filter-paper', 'all');

    // filter by year
    await win.selectOption('#filter-year', '2020');
    const y2020 = await countRows();
    expect(y2020).toBe(EXP.wrong.filter(w => w.year === '2020').length);

    // combined filter
    await win.selectOption('#filter-paper', '1');
    const combo = await countRows();
    expect(combo).toBe(EXP.wrong.filter(w => w.year === '2020' && w.paper === 1).length);

    await win.selectOption('#filter-year', 'all');
    await win.selectOption('#filter-paper', 'all');
  });

  test('"drill this topic" builds a set containing only that topic', async () => {
    const res = await win.evaluate(() =>
      window.api.drill.build({ source: 'all', topics: ['logic-truth'], shuffle: false }));
    expect(res.ids.length).toBeGreaterThan(10);
    const byId = new Map(CONTENT.questions.map(q => [q.id, q]));
    for (const id of res.ids) {
      expect(byId.get(id).topics, `${id} topics`).toContain('logic-truth');
    }
    // and it is exactly the set of logic-truth questions in the bank
    const expectedIds = CONTENT.questions
      .filter(q => q.topics.includes('logic-truth')).map(q => q.id).sort();
    expect(res.ids.slice().sort()).toEqual(expectedIds);
  });

  test('confidence and study-log figures match the seed', () => {
    // odd positions were marked 'sure', even 'unsure'
    const c = dash.confidence;
    const total = c.sureRight + c.sureWrong + c.unsureRight + c.unsureWrong + c.unmarked;
    expect(total).toBe(5 * 20);
    expect(c.unmarked).toBe(0);
    expect(c.sureRight + c.sureWrong).toBe(50);
    expect(dash.study.weeks.length).toBeGreaterThanOrEqual(1);
    expect(dash.study.weeks.reduce((s, w) => s + w.papers, 0)).toBe(5);
  });
});

test.describe('analytics edge states', () => {
  let userDir, app, win;
  test.beforeEach(async () => {
    userDir = freshUserDir('analytics-edge');
    ({ app, win } = await launch(userDir));
  });
  test.afterEach(async () => { if (app) await app.close().catch(() => {}); });

  test('zero history renders an empty state without dividing by zero', async () => {
    const d = await win.evaluate(() => window.api.analytics.dashboard());
    expect(d.summary.completedCount).toBe(0);
    expect(d.topics).toEqual([]);
    expect(d.weaknesses).toEqual([]);
    expect(d.wrong).toEqual([]);
    expect(Number.isFinite(d.pacing.avgSecPerQuestion)).toBe(true);
    expect(d.pacing.avgSecPerQuestion).toBe(0);

    await win.evaluate(() => go('dashboard'));
    await win.waitForSelector('h1:has-text("Progress")');
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).toContain('Complete a paper to unlock analytics');
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  test('a single all-correct attempt yields sensible, finite analytics', async () => {
    const qs = paperQuestions('2023', 1);
    const payload = {
      attempts: [{
        id: 1, mode: 'paper', year: '2023', paper: 1, mock_group: null, status: 'completed',
        started_at: BASE_TIME, completed_at: BASE_TIME + 3600000,
        allowed_sec: 5580, elapsed_sec: 3600, current_index: 19,
        finish_reason: 'submitted', score_raw: 20, score_scaled: 9, label: null, settings_json: '{}',
        questions: qs.map((q, i) => ({
          attempt_id: 1, position: i, question_id: q.id, selected: q.answer, correct: 1,
          flagged: 0, confidence: null, time_spent: 60, notepad: null, updated_at: BASE_TIME,
        })),
      }],
      revisit: [], settings: {},
    };
    await win.evaluate((p) => window.api.data.importPayload(p), payload);

    const d = await win.evaluate(() => window.api.analytics.dashboard());
    expect(d.summary.completedCount).toBe(1);
    expect(d.wrong).toEqual([]);
    expect(d.weaknesses).toEqual([]);           // nothing below 70%
    expect(d.topics.every(t => t.accuracy === 1)).toBe(true);
    expect(d.pacing.note).toBeNull();           // no drop-off to report
    expect(d.pacing.buckets.every(b => b.accuracy === 1)).toBe(true);
    expect(Number.isFinite(d.pacing.avgSecPerQuestion)).toBe(true);

    await win.evaluate(() => go('dashboard'));
    await win.waitForSelector('h1:has-text("Progress")');
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
    expect(text).toContain('No topic is below 70%');
    expect(text).toContain('No wrong answers recorded');
  });
});
