const { test, expect } = require('@playwright/test');
const { freshUserDir, launch, startExam, answerKey, paperQuestions, seedPayload } = require('./helpers');

const CLOCK = { fixedIso: '2026-07-01T09:00:00+01:00' };

async function boot(specs) {
  const userDir = freshUserDir('drillfb');
  const { app, win } = await launch(userDir);
  await win.evaluate((c) => window.api.debug.setClock(c), CLOCK);
  if (specs) {
    const { payload } = seedPayload(specs);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);
  }
  return { app, win };
}

// sit a drill over the given questions, wrong on the ones named
async function sitDrill(win, ids, wrongIds, opts = {}) {
  return win.evaluate(async ({ ids, wrongIds, opts }) => {
    const at = await window.api.attempt.start({
      mode: 'drill', questionIds: ids, untimed: true,
      label: opts.label || 'Drill · test',
    });
    for (let i = 0; i < ids.length; i++) {
      const meta = at.questions[i].question;
      const letters = 'ABCDEFGH'.slice(0, meta.options).split('');
      // the renderer never sees the key, so ask the main process afterwards;
      // here we simply pick a letter and let scoring decide
      const wrong = wrongIds.includes(ids[i]);
      await window.api.attempt.answer({
        attemptId: at.id, position: i,
        selected: wrong ? '__WRONG__' : '__RIGHT__',
      });
    }
    return at.id;
  }, { ids, wrongIds, opts });
}

test.describe('drill results feed the review system', () => {
  test('a wrong drill answer reaches the wrong log, revisit list and review queue', async () => {
    const { app, win } = await boot();
    const qs = paperQuestions('2019', 1).slice(0, 6);
    const ids = qs.map(q => q.id);
    const key = qs.map(q => q.answer);
    const wrongIdx = [0, 1, 2];        // three wrong, three right

    const id = await win.evaluate(async ({ ids, key, wrongIdx }) => {
      const at = await window.api.attempt.start({
        mode: 'drill', questionIds: ids, untimed: true, label: 'Drill · test',
      });
      for (let i = 0; i < ids.length; i++) {
        const sel = wrongIdx.includes(i) ? (key[i] === 'A' ? 'B' : 'A') : key[i];
        await window.api.attempt.answer({ attemptId: at.id, position: i, selected: sel });
        if (i === 0) await window.api.attempt.confidence({ attemptId: at.id, position: i, confidence: 'sure' });
      }
      await window.api.attempt.flag({ attemptId: at.id, position: 5, flagged: true });
      await window.api.attempt.finish({ attemptId: at.id, reason: 'submitted' });
      return at.id;
    }, { ids, key, wrongIdx });

    // wrong-answer log
    const dash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(dash.wrong.length).toBe(3);
    expect(dash.wrong.every(w => w.attemptId === id)).toBe(true);

    // revisit list — the three wrong plus the flagged one
    const revisit = await win.evaluate(() => window.api.revisit.list());
    const revisitIds = revisit.map(r => r.questionId).sort();
    expect(revisitIds).toEqual([ids[0], ids[1], ids[2], ids[5]].sort());

    // review queue, on identical terms to a paper: +3 days, correct source
    const rq = await win.evaluate(() => window.api.review.all());
    expect(rq.length).toBe(4);
    const first = rq.find(r => r.questionId === ids[0]);
    expect(first.source).toBe('sure_wrong');          // sure but wrong outranks
    expect(first.nextIntervalDays).toBe(3);
    expect(rq.find(r => r.questionId === ids[1]).source).toBe('wrong');
    expect(rq.find(r => r.questionId === ids[5]).source).toBe('flag');

    // and a sure-but-wrong drill answer outranks ordinary wrong answers
    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-07-10T09:00:00+01:00' }));
    const sess = await win.evaluate(() => window.api.review.session({}));
    expect(sess.items[0].source).toBe('sure_wrong');
    await app.close();
  });

  test('a wrong drill answer resets a queued question, a right one advances it', async () => {
    const { app, win } = await boot();
    const qs = paperQuestions('2019', 1).slice(0, 3);
    const ids = qs.map(q => q.id);
    const key = qs.map(q => q.answer);

    const runDrill = (allCorrect) => win.evaluate(async ({ ids, key, allCorrect }) => {
      const at = await window.api.attempt.start({
        mode: 'drill', questionIds: ids, untimed: true, label: 'Drill · test',
      });
      for (let i = 0; i < ids.length; i++) {
        await window.api.attempt.answer({
          attemptId: at.id, position: i,
          selected: allCorrect ? key[i] : (key[i] === 'A' ? 'B' : 'A'),
        });
      }
      await window.api.attempt.finish({ attemptId: at.id, reason: 'submitted' });
    }, { ids, key, allCorrect });

    // wrong in a drill -> queued at +3
    await runDrill(false);
    let e = await win.evaluate((i) => window.api.review.all().then(r =>
      r.find(x => x.questionId === i)), ids[0]);
    expect(e.intervalIndex).toBe(0);
    expect(e.consecutiveCorrect).toBe(0);

    // right in a later drill -> advances the schedule
    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-07-05T09:00:00+01:00' }));
    await runDrill(true);
    e = await win.evaluate((i) => window.api.review.all().then(r =>
      r.find(x => x.questionId === i)), ids[0]);
    expect(e.consecutiveCorrect).toBe(1);
    expect(e.intervalIndex).toBe(1);
    expect(e.nextIntervalDays).toBe(7);

    // wrong again in a drill -> back to the start, a lapse recorded
    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-07-15T09:00:00+01:00' }));
    await runDrill(false);
    e = await win.evaluate((i) => window.api.review.all().then(r =>
      r.find(x => x.questionId === i)), ids[0]);
    expect(e.intervalIndex, 'a drill miss resets like any other').toBe(0);
    expect(e.consecutiveCorrect).toBe(0);
    expect(e.lapses).toBe(1);
    expect(e.nextIntervalDays).toBe(3);
    await app.close();
  });

  test('drill answers move topic accuracy and the coach, but NOT the predictor', async () => {
    // three real papers so the predictor is live
    const { app, win } = await boot([
      { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    const predBefore = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    const diagBefore = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(predBefore.ready).toBe(true);

    // a drill of 8 questions, all wrong
    const qs = paperQuestions('2021', 1).slice(0, 8);
    await win.evaluate(async ({ ids, key }) => {
      const at = await window.api.attempt.start({
        mode: 'drill', questionIds: ids, untimed: true, label: 'Drill · test',
      });
      for (let i = 0; i < ids.length; i++) {
        await window.api.attempt.answer({
          attemptId: at.id, position: i, selected: key[i] === 'A' ? 'B' : 'A' });
      }
      await window.api.attempt.finish({ attemptId: at.id, reason: 'submitted' });
    }, { ids: qs.map(q => q.id), key: qs.map(q => q.answer) });

    const predAfter = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    const diagAfter = await win.evaluate(() => window.api.coach.diagnostics({}));

    // the prediction is byte-identical: drills are excluded by design
    expect(predAfter.papers).toBe(predBefore.papers);
    expect(predAfter.perPaper).toEqual(predBefore.perPaper);
    expect(predAfter.overall).toEqual(predBefore.overall);

    // but topic accuracy moved
    const seenBefore = diagBefore.topics.reduce((s, t) => s + t.seen, 0);
    const seenAfter = diagAfter.topics.reduce((s, t) => s + t.seen, 0);
    expect(seenAfter).toBeGreaterThan(seenBefore);
    const wrongBefore = diagBefore.topics.reduce((s, t) => s + (t.seen - t.correct), 0);
    const wrongAfter = diagAfter.topics.reduce((s, t) => s + (t.seen - t.correct), 0);
    expect(wrongAfter).toBeGreaterThan(wrongBefore);

    // and the coach sees them
    const dash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(dash.wrong.filter(w => w.year === '2021').length).toBe(8);
    await app.close();
  });

  test('every attempt carries a source, and history filters by it', async () => {
    const { app, win } = await boot();
    const ids = paperQuestions('2019', 1).slice(0, 3).map(q => q.id);

    await win.evaluate(async (ids) => {
      const p = await window.api.attempt.start({ mode: 'paper', year: '2016', paper: 1 });
      await window.api.attempt.finish({ attemptId: p.id, reason: 'submitted' });
      const d = await window.api.attempt.start({
        mode: 'drill', questionIds: ids, untimed: true, label: 'Drill · topic' });
      await window.api.attempt.finish({ attemptId: d.id, reason: 'submitted' });
      const r = await window.api.attempt.start({
        mode: 'drill', questionIds: ids, untimed: true, label: 'Review · 3 due' });
      await window.api.attempt.finish({ attemptId: r.id, reason: 'submitted' });
      const u = await window.api.attempt.start({
        mode: 'untimed', year: '2017', paper: 1, untimed: true });
      await window.api.attempt.finish({ attemptId: u.id, reason: 'submitted' });
      await window.api.offline.record({
        year: '2018', paper: 1, answers: Array(20).fill('A'), minutes: 90 });
    }, ids);

    const hist = await win.evaluate(() => window.api.history.list());
    const sources = hist.map(h => h.source).sort();
    expect(sources).toEqual(['drill', 'offline', 'paper', 'review', 'untimed']);
    for (const h of hist) expect(h.sourceLabel, h.source).toBeTruthy();

    // only real timed papers (and the offline sitting) count toward prediction
    const counting = hist.filter(h => h.countsTowardPrediction).map(h => h.source).sort();
    expect(counting).toEqual(['offline', 'paper', 'untimed']);
    expect(hist.find(h => h.source === 'drill').countsTowardPrediction).toBe(false);
    expect(hist.find(h => h.source === 'review').countsTowardPrediction).toBe(false);

    // the history screen filters by source
    await win.evaluate(() => go('history'));
    await win.waitForSelector('table');
    expect(await win.locator('tbody tr').count()).toBe(5);
    await win.selectOption('#filter-source', 'drill');
    await win.waitForTimeout(400);
    expect(await win.locator('tbody tr').count()).toBe(1);
    await app.close();
  });

  test('the UI explains why a drill did not move the prediction', async () => {
    const { app, win } = await boot([
      { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    await win.evaluate(() => go('coach'));
    await win.waitForSelector('h1');
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).toMatch(/do not move your predicted score/i);
    expect(text).toMatch(/wrong-answer log, the review queue/i);
    await app.close();
  });
});
