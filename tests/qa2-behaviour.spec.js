const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  freshUserDir, launch, startExam, answerKey, paperQuestions, seedPayload, ROOT, CONTENT,
} = require('./helpers');
const { startExam: _se } = require('./helpers');

async function app({ payload, settings, clock } = {}) {
  const userDir = freshUserDir('qa2b');
  const { app: a, win } = await launch(userDir);
  if (clock) await win.evaluate((c) => window.api.debug.setClock(c), clock);
  if (settings) await win.evaluate((s) => window.api.settings.set(s), settings);
  if (payload) await win.evaluate((p) => window.api.data.importPayload(p), payload);
  return { app: a, win, userDir };
}

const FAR = { fixedIso: '2026-07-01T09:00:00+01:00' };   // 103 days out
const NEAR = { fixedIso: '2026-10-01T09:00:00+01:00' };  // 11 days out

// ===========================================================================
test.describe('QA2 §4 — checklist behaviour', () => {
  test('strong Paper 1 / weak Paper 2 names an unsat Paper 2', async () => {
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2017', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2018', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2016', paper: 2, decide: (q, i) => (i < 6 ? 'correct' : 'wrong') },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const sit = ov.checklist.find(i => i.kind === 'paper');
    expect(sit).toBeTruthy();
    expect(sit.action.paper).toBe(2);
    // and it must be one not already sat
    expect(`${sit.action.year}-P2`).not.toBe('2016-P2');
    expect(sit.why).toMatch(/weaker/i);
    await a.close();
  });

  test('all errors tagged careless produces habit fixes and NO topic study', async () => {
    const decide = (q, i) => (i % 3 === 0 ? 'wrong' : 'correct');
    const errorType = (q, i, v) => (v === 'wrong' ? 'careless' : null);
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide, errorType },
      { year: '2020', paper: 1, decide, errorType },
      { year: '2021', paper: 1, decide, errorType },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const ov = await win.evaluate(() => window.api.coach.overview({}));

    expect(ov.checklist.some(i => i.kind === 'habit')).toBe(true);
    // the key negative: no "revise topic X" item
    const study = ov.checklist.filter(i => i.kind === 'study' && i.key.startsWith('study-'));
    expect(study, 'careless errors must not generate topic study').toEqual([]);
    await a.close();
  });

  test('all errors tagged time produces pacing and triage items', async () => {
    const decide = (q, i) => (i % 3 === 0 ? 'wrong' : 'correct');
    const errorType = (q, i, v) => (v === 'wrong' ? 'time' : null);
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide, errorType },
      { year: '2020', paper: 1, decide, errorType },
      { year: '2021', paper: 1, decide, errorType },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const habit = ov.checklist.find(i => i.key.startsWith('habit-time'));
    expect(habit, 'a triage/pacing item').toBeTruthy();
    expect(habit.how).toMatch(/triage|budget|do-now/i);
    expect(ov.checklist.filter(i => i.key.startsWith('study-'))).toEqual([]);
    await a.close();
  });

  test('a question wrong in two separate attempts outranks single misses', async () => {
    const { app: a, win } = await app({ clock: FAR });
    const key = answerKey('2019', 1);
    // sit the same paper twice, wrong on the same two questions both times
    for (let round = 0; round < 2; round++) {
      const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
      await win.evaluate(async ({ attemptId, key }) => {
        for (let i = 0; i < 20; i++) {
          const wrongHere = i < 2 || (i >= 5 && i < 8);
          await window.api.attempt.answer({
            attemptId, position: i,
            selected: wrongHere ? (key[i] === 'A' ? 'B' : 'A') : key[i],
          });
        }
        await State.exam.finish('submitted');
      }, { attemptId: id, key });
      await win.waitForSelector('h1:has-text("Results")');
    }

    const rq = await win.evaluate(() => window.api.review.all());
    const twice = rq.filter(r => r.misses >= 2);
    expect(twice.length).toBeGreaterThanOrEqual(2);

    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const repeat = ov.checklist.find(i => i.key.startsWith('repeat-misses'));
    expect(repeat, 'repeatedly-missed item').toBeTruthy();
    // it must be the top item — a repeated miss beats everything else
    expect(ov.checklist[0].key).toBe(repeat.key);
    expect(repeat.title).toMatch(/missed more than once/);
    await a.close();
  });

  test('a fresh install gives a sensible starter list with no NaN anywhere', async () => {
    const { app: a, win } = await app({ clock: FAR });
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.checklist.length).toBeGreaterThan(0);
    expect(ov.checklist[0].title).toMatch(/first paper/i);
    expect(ov.prediction.ready).toBe(false);

    for (const view of ['home', 'coach', 'plan', 'dashboard']) {
      await win.evaluate((v) => go(v), view);
      await win.waitForTimeout(250);
      const text = await win.evaluate(() => document.body.innerText);
      expect(text, `${view} on a fresh install`).not.toMatch(/NaN|undefined|Infinity|\[object/);
    }
    await a.close();
  });

  test('phases: 10+ weeks favours topic study, 2 weeks favours mocks and no new topics', async () => {
    const decide = (q) => (q.topics.includes('logic-truth') ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide }, { year: '2016', paper: 2, decide },
      { year: '2017', paper: 1, decide },
    ]);

    const far = await app({ payload, clock: FAR });
    let ov = await far.win.evaluate(() => window.api.coach.overview({}));
    expect(ov.phase.key).toBe('fundamentals');
    expect(ov.checklist.some(i => i.kind === 'study' && i.key.startsWith('study-'))).toBe(true);
    await far.app.close();

    const near = await app({ payload, clock: NEAR });
    ov = await near.win.evaluate(() => window.api.coach.overview({}));
    expect(ov.phase.key).toBe('simulation');
    expect(ov.phase.blurb).toMatch(/not start new topics/i);
    // no brand-new topic study this close to the exam
    expect(ov.checklist.filter(i => i.kind === 'study' && i.key.startsWith('study-'))).toEqual([]);
    const sit = ov.checklist.find(i => i.kind === 'paper');
    expect(sit.action.type).toBe('mock');
    await near.app.close();
  });

  test('reserve papers are protected until the final fortnight', async () => {
    // sit 13 papers, leaving 5 unseen
    const specs = [];
    const years = ['2016', '2017', '2018', '2019', '2020', '2021', '2022'];
    let n = 0;
    outer: for (const y of years) {
      for (const p of [1, 2]) {
        if (n >= 13) break outer;
        specs.push({ year: y, paper: p, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') });
        n++;
      }
    }
    const { payload } = seedPayload(specs);

    const far = await app({ payload, clock: FAR });
    const plan = await far.win.evaluate(() => window.api.coach.plan({}));
    expect(plan.reserved.length).toBe(3);
    const buildWeeks = plan.weeks.filter(w => !w.isMockWeek);
    const scheduled = buildWeeks.flatMap(w => w.papers.map(p => p.key));
    for (const r of plan.reserved) {
      expect(scheduled, `${r} must be held back`).not.toContain(r);
    }
    // the coach must not suggest a reserved paper either
    const ov = await far.win.evaluate(() => window.api.coach.overview({}));
    const sit = ov.checklist.find(i => i.kind === 'paper');
    if (sit && sit.action.year) {
      expect(plan.reserved).not.toContain(`${sit.action.year}-P${sit.action.paper}`);
    }
    await far.app.close();
  });

  test('burning through papers too fast raises a warning', async () => {
    // 14 papers all sat inside the last three weeks, only 4 left, 100 days to go
    const nowIso = '2026-07-01T09:00:00+01:00';
    const base = new Date(nowIso).getTime();
    const specs = [];
    const years = ['2016', '2017', '2018', '2019', '2020', '2021', '2022'];
    let n = 0;
    outer: for (const y of years) {
      for (const p of [1, 2]) {
        if (n >= 14) break outer;
        specs.push({
          year: y, paper: p, decide: (q, i) => (i < 12 ? 'correct' : 'wrong'),
          at: base - (n % 20) * 86400000,
        });
        n++;
      }
    }
    const { payload } = seedPayload(specs);
    const { app: a, win } = await app({ payload, clock: FAR });
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const warn = ov.checklist.find(i => i.kind === 'consolidate' && i.key.startsWith('consolidate-burn'));
    expect(warn, 'a pace warning when papers are running out').toBeTruthy();
    expect(warn.why).toMatch(/unseen papers left/);
    await a.close();
  });

  test('the list is capped at five and completing a drill auto-ticks its item', async () => {
    const decide = (q, i) => (i % 2 === 0 ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide }, { year: '2019', paper: 2, decide },
      { year: '2020', paper: 1, decide }, { year: '2020', paper: 2, decide },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    let ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.checklist.length).toBeLessThanOrEqual(5);

    // firing an item's action records it as done and removes it from the list
    const item = ov.checklist.find(i => i.action.type === 'drill') || ov.checklist[0];
    await win.evaluate(() => go('coach'));
    await win.waitForSelector('.coach-item');
    await win.evaluate((it) => runChecklistAction(it), item);
    await win.waitForTimeout(600);

    const history = await win.evaluate(() => window.api.coach.history());
    expect(history.some(h => h.item_key === item.key)).toBe(true);
    ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.checklist.find(i => i.key === item.key)).toBeFalsy();
    await a.close();
  });
});

// ===========================================================================
test.describe('QA2 §5 — study plan', () => {
  test('spans today to exam day, schedules the unseen papers, reserves the last few', async () => {
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2016', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const plan = await win.evaluate(() => window.api.coach.plan({}));

    expect(plan.weeks.length).toBe(Math.ceil(plan.countdown.days / 7));
    expect(plan.weeks[0].weeksToExam).toBe(plan.weeks.length);
    expect(plan.weeks[plan.weeks.length - 1].weeksToExam).toBe(1);

    // every unseen paper except the reserve is scheduled exactly once
    const scheduled = plan.weeks.flatMap(w => w.papers.map(p => p.key));
    expect(new Set(scheduled).size).toBe(scheduled.length);      // no duplicates
    // never schedules a paper already sat
    expect(scheduled).not.toContain('2016-P1');
    expect(scheduled).not.toContain('2016-P2');
    // reserve lands in the final fortnight
    const finalTwo = plan.weeks.slice(-2).flatMap(w => w.papers.map(p => p.key));
    for (const r of plan.reserved) expect(finalTwo).toContain(r);
    await a.close();
  });

  test('weakest topics are scheduled first and revisited later for spacing', async () => {
    const decide = (q) => (q.topics.includes('logic-truth') ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2019', paper: 2, decide }, { year: '2020', paper: 2, decide },
      { year: '2021', paper: 2, decide },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const plan = await win.evaluate(() => window.api.coach.plan({}));

    const withTopics = plan.weeks.filter(w => w.topics.length);
    expect(withTopics.length).toBeGreaterThan(3);
    // the weakest topic leads week 1
    expect(withTopics[0].topics[0].topic).toBe('logic-truth');
    // and it comes back later — spaced, not one-and-done
    const laterMentions = plan.weeks
      .slice(2)
      .filter(w => w.topics.some(t => t.topic === 'logic-truth'));
    expect(laterMentions.length, 'weak topic must be revisited').toBeGreaterThan(0);
    await a.close();
  });

  test('falling two weeks behind produces a still-achievable plan, not a backlog', async () => {
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    // only 6 weeks left with 17 papers unseen
    const { app: a, win } = await app({
      payload, clock: { fixedIso: '2026-08-31T09:00:00+01:00' },
    });
    const plan = await win.evaluate(() => window.api.coach.plan({}));
    expect(plan.weeks.length).toBeGreaterThan(0);
    // it never demands more than is physically sensible in one week
    const maxPerWeek = Math.max(...plan.weeks.map(w => w.papers.length));
    expect(maxPerWeek).toBeLessThanOrEqual(8);
    // and it still holds the reserve back
    expect(plan.reserved.length).toBe(3);
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/NaN|Infinity|null,null/);
    await a.close();
  });
});

// ===========================================================================
test.describe('QA2 §6 — spaced repetition edge cases', () => {
  test('a wrong review resets the interval from any stage', async () => {
    const { app: a, win } = await app({});
    // climb to the +21 slot, then miss
    const out = await win.evaluate(() => window.api.debug.srsSimulate({
      steps: ['wrong', 'correct', 'correct', 'correct', 'wrong'],
      startIso: '2026-01-30T09:00:00Z',
    }));
    expect(out.map(s => s.afterDays)).toEqual([3, 7, 21, 45, 3]);
    expect(out[4].intervalIndex).toBe(0);
    expect(out[4].retired).toBe(false);
    expect(out[4].consecutiveCorrect).toBe(0);
    await a.close();
  });

  test('flagged questions sit below genuine wrong answers', async () => {
    const { app: a, win } = await app({});
    await win.evaluate(() => window.api.debug.srsSeed({
      count: 4, sources: ['flag', 'revisit', 'wrong', 'sure_wrong'], sameDue: true,
    }));
    const sess = await win.evaluate(() => window.api.review.session({}));
    expect(sess.items.map(i => i.source))
      .toEqual(['sure_wrong', 'wrong', 'revisit', 'flag']);
    await a.close();
  });

  test('a 60-day absence yields a large backlog that still respects the cap', async () => {
    const { app: a, win } = await app({});
    await win.evaluate(() => window.api.debug.srsSeed({ count: 60 }));
    const summary = await win.evaluate(() => window.api.review.summary());
    expect(summary.due).toBe(60);
    expect(summary.overdue).toBe(60);

    const sess = await win.evaluate(() => window.api.review.session({}));
    expect(sess.ids.length).toBe(20);
    // most overdue first
    expect(sess.items[0].overdueDays).toBeGreaterThanOrEqual(sess.items[19].overdueDays);

    // the UI copes with the backlog
    await win.evaluate(() => go('coach'));
    await win.waitForSelector('h1');
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).toMatch(/due for review/);
    expect(text).not.toMatch(/NaN|undefined/);
    await a.close();
  });
});

// ===========================================================================
test.describe('QA2 §7 — answer changes and guessing', () => {
  test('exactly 5 helped, 7 hurt, 2 neutral gives net -2 and flips advice with the data', async () => {
    const { app: a, win } = await app({ clock: FAR });
    const qs = paperQuestions('2019', 1);
    const key = qs.map(q => q.answer);
    const other = (q, not) => 'ABCDEFGH'.slice(0, q.options).split('')
      .find(L => L !== q.answer && L !== not);

    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    const plan = [];
    for (let i = 0; i < 5; i++) plan.push({ i, from: other(qs[i]), to: key[i] });          // helped
    for (let i = 5; i < 12; i++) plan.push({ i, from: key[i], to: other(qs[i]) });          // hurt
    for (let i = 12; i < 14; i++) plan.push({ i, from: other(qs[i]), to: other(qs[i], other(qs[i])) }); // neutral

    await win.evaluate(async ({ attemptId, plan }) => {
      for (const p of plan) {
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.from });
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.to });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, plan });
    await win.waitForSelector('h1:has-text("Results")');

    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.changes.total).toBe(14);
    expect(diag.changes.helped).toBe(5);
    expect(diag.changes.hurt).toBe(7);
    expect(diag.changes.neutral).toBe(2);
    expect(diag.changes.net).toBe(-2);
    // 14 is below the 15 threshold, so the coach must stay silent
    expect(diag.changes.enoughData).toBe(false);
    expect(diag.changes.verdict).toBeNull();
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.checklist.find(i => i.key.startsWith('habit-changes'))).toBeFalsy();
    await a.close();
  });

  test('above the threshold the verdict follows the data in BOTH directions', async () => {
    const mkChanges = (helped, hurt) => {
      const qs = paperQuestions('2020', 1);
      const key = qs.map(q => q.answer);
      const other = (q) => 'ABCDEFGH'.slice(0, q.options).split('').find(L => L !== q.answer);
      const plan = [];
      let i = 0;
      for (let n = 0; n < helped; n++, i++) plan.push({ i, from: other(qs[i]), to: key[i] });
      for (let n = 0; n < hurt; n++, i++) plan.push({ i, from: key[i], to: other(qs[i]) });
      return plan;
    };

    // (a) changing mostly HURTS -> "first instinct"
    let { app: a, win } = await app({ clock: FAR });
    let id = await startExam(win, { mode: 'paper', year: '2020', paper: 1 });
    await win.evaluate(async ({ attemptId, plan }) => {
      for (const p of plan) {
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.from });
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.to });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, plan: mkChanges(4, 14) });
    await win.waitForSelector('h1:has-text("Results")');
    let diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.changes.total).toBe(18);
    expect(diag.changes.enoughData).toBe(true);
    expect(diag.changes.verdict).toBe('first instinct');
    let ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.checklist.find(i => i.key.startsWith('habit-changes'))).toBeTruthy();
    await a.close();

    // (b) changing mostly HELPS -> the opposite verdict, and no "stop changing" advice
    ({ app: a, win } = await app({ clock: FAR }));
    id = await startExam(win, { mode: 'paper', year: '2020', paper: 1 });
    await win.evaluate(async ({ attemptId, plan }) => {
      for (const p of plan) {
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.from });
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.to });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, plan: mkChanges(15, 3) });
    await win.waitForSelector('h1:has-text("Results")');
    diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.changes.enoughData).toBe(true);
    expect(diag.changes.verdict, 'advice must flip with the data').toBe('changing helps');
    ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.checklist.find(i => i.key.startsWith('habit-changes')),
      'must not tell me to stop changing when changing helps').toBeFalsy();
    await a.close();
  });

  test('unsure-answer interpretation flips between above-random and at-random', async () => {
    // (a) unsure answers nearly always right
    const good = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i % 10 === 0 ? 'wrong' : 'correct'),
        confidence: () => 'unsure' },
      { year: '2020', paper: 1, decide: (q, i) => (i % 10 === 0 ? 'wrong' : 'correct'),
        confidence: () => 'unsure' },
    ]).payload;
    let { app: a, win } = await app({ payload: good });
    let g = await win.evaluate(() => window.api.coach.diagnostics({}).then(d => d.guessing));
    expect(g.unsureAccuracy).toBeCloseTo(0.9, 5);
    expect(g.unsureVerdict).toBe('trust');
    await a.close();

    // (b) unsure answers at roughly random
    const rnd = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i % 5 === 0 ? 'correct' : 'wrong'),
        confidence: () => 'unsure' },
      { year: '2020', paper: 1, decide: (q, i) => (i % 5 === 0 ? 'correct' : 'wrong'),
        confidence: () => 'unsure' },
    ]).payload;
    ({ app: a, win } = await app({ payload: rnd }));
    g = await win.evaluate(() => window.api.coach.diagnostics({}).then(d => d.guessing));
    expect(g.unsureAccuracy).toBeCloseTo(0.2, 5);
    expect(g.unsureVerdict, 'at random means work on elimination').toBe('eliminate');
    await a.close();
  });

  test('auto-submit at timeout still records and reports the blanks', async () => {
    const { app: a, win } = await app({});
    const key = answerKey('2019', 2);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 2, allowedSec: 4 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 15; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")', { timeout: 25000 });

    const at = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(at.finishReason).toBe('timeout');
    expect(at.questions.filter(q => !q.selected).length).toBe(5);
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.guessing.blanks).toBe(5);
    await a.close();
  });
});

// ===========================================================================
test.describe('QA2 §9 — data safety audit', () => {
  test('every destructive SQL statement is accounted for', () => {
    const src = ['src/db.js', 'src/main.js', 'src/coach.js', 'src/checklist.js',
      'src/srs.js', 'src/pdf.js', 'src/content.js', 'src/analytics.js'];
    const found = [];
    for (const f of src) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\b(DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i.test(line)) {
          found.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    // Each of these is expected; the point is that the list cannot grow silently.
    const expected = [
      'DELETE FROM revisit WHERE question_id',      // un-marking a revisit
      'DELETE FROM review_queue WHERE question_id', // retiring a queue entry
      'DELETE FROM attempt_questions WHERE attempt_id', // explicit attempt delete
      'DELETE FROM attempts WHERE id',              // explicit attempt delete
      'DELETE FROM archives WHERE id',              // restoring an archive
      'DELETE FROM attempt_questions',              // import replaces history
      'DELETE FROM attempts',
      'DELETE FROM revisit',
      'DELETE FROM review_queue',
      'DELETE FROM answer_changes',
      'DELETE FROM checklist_done',
      'DELETE FROM archives',
    ];
    for (const f of found) {
      const ok = expected.some(e => f.includes(e));
      expect(ok, `unaccounted destructive statement: ${f}`).toBe(true);
    }
    // no DROP or TRUNCATE anywhere
    expect(found.filter(f => /DROP|TRUNCATE/i.test(f))).toEqual([]);
    console.log(`destructive statements audited: ${found.length}`);
  });

  test('archiving never loses data and the predictor ignores archived runs', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 15 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 15 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 15 ? 'correct' : 'wrong') },
    ]);
    const { app: a, win, userDir } = await app({ payload, clock: FAR });
    const before = await win.evaluate(() => window.api.data.exportPayload());
    const beforePred = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    expect(beforePred.ready).toBe(true);

    await win.evaluate(() => window.api.archive.create({ name: 'run one' }));
    const after = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    expect(after.ready, 'archived runs must not feed the active predictor').toBe(false);

    const archives = await win.evaluate(() => window.api.archive.list());
    await win.evaluate((id) => window.api.archive.restore(id), archives[0].id);
    const restored = await win.evaluate(() => window.api.data.exportPayload());
    delete before.exportedAt; delete restored.exportedAt;
    expect(restored.attempts).toEqual(before.attempts);
    expect(restored.reviewQueue).toEqual(before.reviewQueue);
    await a.close();
  });

  test('coach data survives a force-kill', async () => {
    const userDir = freshUserDir('qa2-kill');
    let { app: a, win } = await launch(userDir);
    const key = answerKey('2019', 1);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 20; i++) {
        await window.api.attempt.answer({
          attemptId, position: i, selected: i < 6 ? (key[i] === 'A' ? 'B' : 'A') : key[i],
        });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');
    await win.evaluate(() => window.api.archive.create({ name: 'keepme' }));
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    await win.evaluate((it) => window.api.coach.complete({
      itemKey: it.key, title: it.title, kind: it.kind,
    }), ov.checklist[0]);

    const queueBefore = await win.evaluate(() => window.api.review.all());
    process.kill(a.process().pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 1200));

    ({ app: a, win } = await launch(userDir));
    const queueAfter = await win.evaluate(() => window.api.review.all());
    expect(queueAfter.length).toBe(queueBefore.length);
    expect(queueAfter.map(q => q.questionId).sort())
      .toEqual(queueBefore.map(q => q.questionId).sort());
    expect((await win.evaluate(() => window.api.archive.list())).length).toBe(1);
    expect((await win.evaluate(() => window.api.coach.history())).length).toBe(1);
    await a.close();
  });
});

// ===========================================================================
test.describe('QA2 §10 — formatting, offline and advice tone', () => {
  test('new screens are clean at two window sizes with zero console errors', async () => {
    const decide = (q, i) => (q.topics.includes('logic-truth') ? 'wrong' : i < 14 ? 'correct' : 'wrong');
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide }, { year: '2019', paper: 2, decide },
      { year: '2020', paper: 1, decide }, { year: '2020', paper: 2, decide },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const issues = [];
    win.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') issues.push(m.text()); });
    win.on('pageerror', e => issues.push('pageerror: ' + e.message));
    await win.evaluate(() => window.api.debug.srsSeed({ count: 25 }));

    for (const [w, h] of [[1360, 900], [1024, 700]]) {
      await win.setViewportSize({ width: w, height: h });
      for (const view of ['home', 'coach', 'plan', 'offline', 'about', 'settings', 'dashboard']) {
        await win.evaluate((v) => go(v), view);
        await win.waitForTimeout(280);
        const text = await win.evaluate(() => document.body.innerText);
        expect(text, `${view} at ${w}x${h}`).not.toMatch(/NaN|undefined|Infinity|\[object|null\b/);
        const of = await win.evaluate(() => ({
          s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
        expect(of.s, `${view} overflow at ${w}x${h}`).toBeLessThanOrEqual(of.c + 1);
        // percentages are sensibly rounded, dates readable
        const pcts = text.match(/\d+\.\d+%/g) || [];
        expect(pcts, `${view} unrounded percentages`).toEqual([]);
      }
    }

    // dark mode legibility on the new screens
    await win.evaluate(async () => {
      State.settings = await window.api.settings.set({ darkMode: true });
      applyTheme(); await go('coach');
    });
    await win.waitForSelector('h1');
    const bg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    expect((r + g + b) / 3).toBeLessThan(90);

    expect(issues).toEqual([]);
    await a.close();
  });

  test('the coach makes zero network requests under load', async () => {
    const decide = (q, i) => (i % 3 === 0 ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide }, { year: '2019', paper: 2, decide },
      { year: '2020', paper: 1, decide },
    ]);
    const { app: a, win } = await app({ payload, clock: FAR });
    const seen = [];
    win.on('request', r => seen.push(r.url()));
    await win.evaluate(() => window.api.debug.srsSeed({ count: 40 }));
    for (const v of ['home', 'coach', 'plan', 'dashboard', 'offline', 'about', 'settings', 'revisit']) {
      await win.evaluate((x) => go(x), v);
      await win.waitForTimeout(220);
    }
    const blocked = await win.evaluate(() => window.api.debug.blockedRequests());
    expect(blocked).toEqual([]);
    expect(seen.filter(u => !/^(file:|tmua-img:|data:|blob:|devtools:)/i.test(u))).toEqual([]);
    await a.close();
  });

  test('advice samples are specific and never inflate — 20 printed for review', async () => {
    const scenarios = [
      ['weak logic, plenty of time',
        [{ year: '2019', paper: 1 }, { year: '2019', paper: 2 }, { year: '2020', paper: 1 }],
        (q) => (q.topics.includes('logic-truth') ? 'wrong' : 'correct'), null, FAR],
      ['all careless',
        [{ year: '2019', paper: 1 }, { year: '2020', paper: 1 }, { year: '2021', paper: 1 }],
        (q, i) => (i % 3 === 0 ? 'wrong' : 'correct'), 'careless', FAR],
      ['out of time',
        [{ year: '2019', paper: 1 }, { year: '2020', paper: 1 }, { year: '2021', paper: 1 }],
        (q, i) => (i % 3 === 0 ? 'wrong' : 'correct'), 'time', FAR],
      ['two weeks out',
        [{ year: '2016', paper: 1 }, { year: '2016', paper: 2 }, { year: '2017', paper: 1 }],
        (q, i) => (i < 12 ? 'correct' : 'wrong'), null, NEAR],
      ['fresh install', [], () => 'correct', null, FAR],
      ['weak Paper 2',
        [{ year: '2016', paper: 1 }, { year: '2017', paper: 1 }, { year: '2016', paper: 2 }],
        (q, i) => (i < 8 ? 'correct' : 'wrong'), null, FAR],
      ['leaving blanks',
        [{ year: '2019', paper: 1 }, { year: '2019', paper: 2 }, { year: '2020', paper: 1 }],
        (q, i) => (i < 14 ? 'correct' : i < 17 ? 'wrong' : 'blank'), null, FAR],
      ['misreading questions',
        [{ year: '2019', paper: 1 }, { year: '2020', paper: 1 }, { year: '2021', paper: 1 }],
        (q, i) => (i % 3 === 0 ? 'wrong' : 'correct'), 'misread', FAR],
      ['broad weakness, mid-run',
        [{ year: '2016', paper: 1 }, { year: '2016', paper: 2 }, { year: '2017', paper: 1 },
         { year: '2017', paper: 2 }, { year: '2018', paper: 1 }],
        (q, i) => (i % 2 === 0 ? 'wrong' : 'correct'), null,
        { fixedIso: '2026-09-05T09:00:00+01:00' }],
    ];

    const samples = [];
    for (const [name, specs, decide, tag, clock] of scenarios) {
      const payload = specs.length
        ? seedPayload(specs.map(s => ({
          ...s, decide,
          errorType: tag ? ((q, i, v) => (v === 'wrong' ? tag : null)) : undefined,
        }))).payload
        : null;
      const { app: a, win } = await app({ payload, clock });
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      for (const item of ov.checklist) {
        samples.push({ scenario: name, kind: item.kind, title: item.title, why: item.why });
      }
      await a.close();
    }

    expect(samples.length).toBeGreaterThanOrEqual(10);
    const banned = /\b(you got this|keep going|well done|amazing|you will smash|guaranteed|certain to)\b/i;
    for (const s of samples) {
      expect(s.title.length, 'title must say something').toBeGreaterThan(12);
      expect(s.why.length, `why must be specific: ${s.title}`).toBeGreaterThan(25);
      expect(s.title, `filler in: ${s.title}`).not.toMatch(banned);
      expect(s.why, `filler in: ${s.why}`).not.toMatch(banned);
      expect(s.why, `unrendered value in: ${s.why}`).not.toMatch(/NaN|undefined|\[object/);
    }

    const lines = ['', 'SAMPLE GENERATED CHECKLIST ITEMS', '='.repeat(72)];
    samples.slice(0, 20).forEach((s, i) => {
      lines.push(`${String(i + 1).padStart(2)}. [${s.scenario} · ${s.kind}] ${s.title}`);
      lines.push(`    why: ${s.why}`);
    });
    console.log(lines.join('\n'));
  });
});
