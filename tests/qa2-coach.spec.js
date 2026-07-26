const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  freshUserDir, launch, paperQuestions, seedPayload, ROOT, CONTENT,
} = require('./helpers');

const CONV = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'conversions.json'), 'utf8'));
const LATEST = Object.keys(CONV).sort().slice(-1)[0];
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8')).taxonomy;

// Questions carrying a topic, per paper, computed here from the bank so the
// expectation never comes from the app's own code.
function perPaper(topic) {
  const n = CONTENT.questions.filter(q => q.topics.includes(topic)).length;
  const papers = new Set(CONTENT.questions.map(q => `${q.year}-${q.paper}`)).size;
  return n / papers;
}

async function coachApp({ payload, settings, clock } = {}) {
  const userDir = freshUserDir('qa2');
  const { app, win } = await launch(userDir);
  if (clock) await win.evaluate((c) => window.api.debug.setClock(c), clock);
  if (settings) await win.evaluate((s) => window.api.settings.set(s), settings);
  if (payload) await win.evaluate((p) => window.api.data.importPayload(p), payload);
  return { app, win, userDir };
}

// ===========================================================================
test.describe('QA2 §0 — harness safety', () => {
  test('tests never touch the real user data directory', async () => {
    const { app, win, userDir } = await coachApp({});
    const dbPath = await win.evaluate(() => window.api.debug.dbPath());

    // macOS tmpdir is a symlink (/var -> /private/var), so compare real paths
    const realScratch = fs.realpathSync(userDir);
    const realDb = fs.realpathSync(path.dirname(dbPath));
    expect(realDb.startsWith(realScratch)).toBe(true);
    // and must not be the real profile
    const real = path.join(os.homedir(), 'Library', 'Application Support', 'TMUA Simulator');
    expect(dbPath.startsWith(real)).toBe(false);
    expect(dbPath).toContain(path.join('data', 'tmua.sqlite'));
    await app.close();
  });

  test('the clock can be frozen deterministically', async () => {
    const { app, win } = await coachApp({ clock: { fixedIso: '2026-09-01T12:00:00Z' } });
    const a = await win.evaluate(() => window.api.debug.now());
    await new Promise(r => setTimeout(r, 300));
    const b = await win.evaluate(() => window.api.debug.now());
    expect(a).toBe(b);
    expect(a).toBe('2026-09-01T12:00:00.000Z');
    await app.close();
  });
});

// ===========================================================================
test.describe('QA2 §1 — diagnostic engine', () => {
  test('topic accuracy and counts are exact, and thin topics are excluded from ranking', async () => {
    // 2019 P2: wrong on every logic-truth question, right on everything else
    const decide = (q) => (q.topics.includes('logic-truth') ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2019', paper: 2, decide },
      { year: '2020', paper: 2, decide },
      { year: '2021', paper: 2, decide },
    ]);

    // hand-compute the expected counts from the bank
    const expected = new Map();
    for (const [year, paper] of [['2019', 2], ['2020', 2], ['2021', 2]]) {
      for (const q of paperQuestions(year, paper)) {
        const right = !q.topics.includes('logic-truth');
        for (const t of q.topics) {
          if (!expected.has(t)) expected.set(t, { seen: 0, correct: 0 });
          const e = expected.get(t);
          e.seen++; if (right) e.correct++;
        }
      }
    }

    const { app, win } = await coachApp({ payload });
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));

    for (const row of diag.topics) {
      const e = expected.get(row.topic);
      expect(e, `unexpected topic ${row.topic}`).toBeTruthy();
      expect(row.seen, `${row.topic} seen`).toBe(e.seen);
      expect(row.correct, `${row.topic} correct`).toBe(e.correct);
      expect(row.accuracy).toBeCloseTo(e.correct / e.seen, 10);
      if (e.seen >= 5) {
        expect(row.enoughData).toBe(true);
        expect(row.expectedMarksLost).not.toBeNull();
      } else {
        // thin topics are labelled, not ranked at 0%
        expect(row.enoughData).toBe(false);
        expect(row.expectedMarksLost).toBeNull();
        expect(row.needMore).toBe(5 - e.seen);
      }
    }
    // and thin topics sort below every topic that has enough data
    const firstThin = diag.topics.findIndex(t => !t.enoughData);
    if (firstThin >= 0) {
      expect(diag.topics.slice(firstThin).every(t => !t.enoughData)).toBe(true);
    }
    await app.close();
  });

  test('THE DECISIVE CASE: 50% on a frequent topic outranks 40% on a rare one', async () => {
    // pick a genuinely frequent topic and a genuinely rare one from the bank
    const freq = [...Object.keys(TAX)].map(t => ({ t, n: perPaper(t) }))
      .sort((a, b) => b.n - a.n);
    const A = freq[0].t;                                  // most frequent
    const B = freq[freq.length - 1].t;                    // least frequent
    expect(perPaper(A)).toBeGreaterThan(perPaper(B) * 2);

    // Topic A answered 50% right, Topic B answered 40% right.
    // A must rank first even though its accuracy is HIGHER.
    let aSeen = 0, bSeen = 0;
    const decide = (q) => {
      if (q.topics.includes(A) && !q.topics.includes(B)) return (aSeen++ % 2 === 0) ? 'correct' : 'wrong';
      if (q.topics.includes(B)) return (bSeen++ % 5 < 2) ? 'correct' : 'wrong';
      return 'correct';
    };
    const everyPaper = [];
    for (const y of ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023']) {
      for (const pp of [1, 2]) everyPaper.push({ year: y, paper: pp, decide });
    }
    const { payload } = seedPayload(everyPaper);

    const { app, win } = await coachApp({ payload });
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    const rowA = diag.topics.find(t => t.topic === A);
    const rowB = diag.topics.find(t => t.topic === B);

    expect(rowA.enoughData).toBe(true);
    // A's accuracy is higher than B's, yet A must lose more marks per paper
    expect(rowA.accuracy).toBeGreaterThan(rowB.accuracy - 0.0001);
    expect(rowA.expectedMarksLost).toBeGreaterThan(rowB.expectedMarksLost ?? 0);
    expect(diag.topics.indexOf(rowA)).toBeLessThan(diag.topics.indexOf(rowB));

    // and the figure equals (1 - accuracy) x questions per paper, computed here
    expect(rowA.expectedMarksLost)
      .toBeCloseTo(Math.round((1 - rowA.accuracy) * perPaper(A) * 100) / 100, 2);
    await app.close();
  });

  test('error-type suggestions follow the timing signals, and my tag always wins', async () => {
    const { app, win } = await coachApp({});
    const qs = paperQuestions('2019', 1);
    const id = await win.evaluate(async () => {
      const a = await window.api.attempt.start({ mode: 'paper', year: '2019', paper: 1 });
      return a.id;
    });

    // craft times: q0 very fast + wrong, q1 very slow + wrong, q2 unanswered
    await win.evaluate(async ({ attemptId, wrong }) => {
      for (let i = 0; i < 20; i++) {
        if (i === 2) continue;                       // leave blank
        await window.api.attempt.answer({ attemptId, position: i, selected: wrong[i] });
      }
      // give every question a baseline time, then skew two of them
      for (let i = 0; i < 20; i++) {
        await window.api.attempt.heartbeat({
          attemptId, elapsedSec: 100 * (i + 1), currentIndex: i,
          questionTime: { position: i, delta: i === 0 ? 4 : i === 1 ? 400 : 100 },
        });
      }
      await window.api.attempt.finish({ attemptId, reason: 'timeout', elapsedSec: 5580 });
    }, { attemptId: id, wrong: qs.map(q => (q.answer === 'A' ? 'B' : 'A')) });

    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.questions[0].suggestedError).toBe('careless');    // very short time
    expect(a.questions[1].suggestedError).toBe('conceptual');  // long time
    expect(a.questions[2].suggestedError).toBe('time');        // unanswered

    // a manual tag overrides the suggestion and persists
    await win.evaluate((i) => window.api.coach.tagError({
      attemptId: i, position: 0, errorType: 'conceptual',
    }), id);
    const after = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(after.questions[0].errorType).toBe('conceptual');
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.errors.counts.conceptual).toBe(1);
    await app.close();
  });

  test('pacing figures match hand-computed values', async () => {
    // 20 questions, positions 0-9 all right, 10-19 all wrong, fixed times
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
    ]);
    // seedAttempt writes time_spent = 200 + i
    const times = Array.from({ length: 20 }, (_, i) => 200 + i);
    const expectedAvg = times.reduce((a, b) => a + b, 0) / 20;
    const budget = 5580 / 20;                       // 279s per question
    const expectedOverruns = times.filter(t => t > budget * 1.5).length;

    const { app, win } = await coachApp({ payload });
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.pacing.avgSecPerQuestion).toBeCloseTo(expectedAvg, 6);
    expect(diag.pacing.overruns).toBe(expectedOverruns);
    expect(diag.pacing.firstHalfAccuracy).toBe(1);
    expect(diag.pacing.secondHalfAccuracy).toBe(0);
    expect(diag.pacing.note).toMatch(/Q1–10|Q11–20/);
    await app.close();
  });

  test('trend uses attempt date order even when rows are inserted out of order', async () => {
    const T = 'logic-truth';
    const day = 86400000;
    const base = Date.UTC(2026, 3, 1);
    // improving over time: earliest attempt all wrong, latest all right
    const mk = (year, paper, at, right) => ({
      year, paper, at,
      decide: (q) => (q.topics.includes(T) ? (right ? 'correct' : 'wrong') : 'correct'),
    });
    // deliberately built newest-first so insertion order contradicts date order
    const { payload } = seedPayload([
      mk('2023', 2, base + 60 * day, true),
      mk('2022', 2, base + 45 * day, true),
      mk('2021', 2, base + 30 * day, true),
      mk('2020', 2, base + 15 * day, false),
      mk('2019', 2, base + 0 * day, false),
    ]);
    payload.attempts.reverse();                        // scramble insertion order

    const { app, win } = await coachApp({ payload });
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    const logic = diag.topics.find(t => t.topic === T);
    expect(logic.trend).toBe('improving');

    // and the reverse history is classified as regressing
    const { payload: p2 } = seedPayload([
      mk('2019', 2, base + 0 * day, true),
      mk('2020', 2, base + 15 * day, true),
      mk('2021', 2, base + 30 * day, true),
      mk('2022', 2, base + 45 * day, false),
      mk('2023', 2, base + 60 * day, false),
    ]);
    await win.evaluate((p) => window.api.data.importPayload(p), p2);
    const diag2 = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag2.topics.find(t => t.topic === T).trend).toBe('regressing');
    await app.close();
  });
});

// ===========================================================================
test.describe('QA2 §2 — grade predictor', () => {
  test('recency weighting moves the prediction up on an improving run', async () => {
    const rising = [4, 6, 9, 12, 15, 18];
    const { payload } = seedPayload(rising.map((n, i) => ({
      year: ['2016', '2017', '2018', '2019', '2020', '2021'][i], paper: 1,
      decide: (q, j) => (j < n ? 'correct' : 'wrong'),
      at: Date.UTC(2026, 3, 1) + i * 7 * 86400000,
    })));
    const mean = rising.reduce((a, b) => a + b, 0) / rising.length;   // 10.67

    const { app, win } = await coachApp({ payload });
    const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    expect(p.perPaper[1].predictedRaw).toBeGreaterThan(mean + 2);
    expect(p.perPaper[1].predictedRaw).toBeLessThanOrEqual(18);
    expect(p.trajectory.perWeek).toBeGreaterThan(0);
    await app.close();
  });

  test('recency weighting moves the prediction DOWN on a declining run', async () => {
    const falling = [18, 15, 12, 9, 6, 4];
    const { payload } = seedPayload(falling.map((n, i) => ({
      year: ['2016', '2017', '2018', '2019', '2020', '2021'][i], paper: 1,
      decide: (q, j) => (j < n ? 'correct' : 'wrong'),
      at: Date.UTC(2026, 3, 1) + i * 7 * 86400000,
    })));
    const mean = falling.reduce((a, b) => a + b, 0) / falling.length;

    const { app, win } = await coachApp({ payload });
    const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    expect(p.perPaper[1].predictedRaw).toBeLessThan(mean - 2);
    expect(p.perPaper[1].predictedRaw).toBeGreaterThanOrEqual(4);
    expect(p.trajectory.perWeek).toBeLessThan(0);
    await app.close();
  });

  test('the range is never zero-width and widens with variability', async () => {
    // perfectly consistent history
    const { payload: steady } = seedPayload([1, 2, 3, 4].map((_, i) => ({
      year: ['2016', '2017', '2018', '2019'][i], paper: 1,
      decide: (q, j) => (j < 12 ? 'correct' : 'wrong'),
    })));
    const { app, win } = await coachApp({ payload: steady });
    const a = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    expect(a.overall.high).toBeGreaterThan(a.overall.low);   // never zero-width
    const steadyWidth = a.perPaper[1].high - a.perPaper[1].low;
    expect(steadyWidth).toBeGreaterThan(0);

    // wildly variable history
    const wild = [3, 19, 5, 18];
    const { payload: noisy } = seedPayload(wild.map((n, i) => ({
      year: ['2016', '2017', '2018', '2019'][i], paper: 1,
      decide: (q, j) => (j < n ? 'correct' : 'wrong'),
    })));
    await win.evaluate((p) => window.api.data.importPayload(p), noisy);
    const b = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    const noisyWidth = b.perPaper[1].high - b.perPaper[1].low;
    expect(noisyWidth).toBeGreaterThan(steadyWidth);
    await app.close();
  });

  test('refuses to predict on 0, 1 and 2 papers and shows no number at all', async () => {
    const { app, win } = await coachApp({});
    for (const n of [0, 1, 2]) {
      if (n > 0) {
        const { payload } = seedPayload(Array.from({ length: n }, (_, i) => ({
          year: ['2016', '2017'][i], paper: 1,
          decide: (q, j) => (j < 13 ? 'correct' : 'wrong'),
        })));
        await win.evaluate((p) => window.api.data.importPayload(p), payload);
      }
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.prediction.ready, `${n} papers`).toBe(false);
      expect(ov.prediction.overall).toBeNull();
      expect(ov.prediction.message).toMatch(/at least 3/);

      await win.evaluate(() => go('home'));
      await win.waitForSelector('.statusbar');
      const block = await win.evaluate(() =>
        document.querySelector('.statusbar .sb-block.grow').innerText);
      expect(block, `${n} papers must show no number`).not.toMatch(/\d\.\d/);
      expect(block).toContain('—');
    }
    await app.close();
  });

  test('never inflates: the prediction stays at or below the best actual paper', async () => {
    const shapes = [
      [4, 6, 9, 12, 15, 18],
      [18, 15, 12, 9, 6, 4],
      [10, 10, 10, 10, 10, 10],
      [3, 19, 5, 18, 4, 17],
      [1, 2, 3, 2, 1, 2],
      [19, 20, 19, 20, 19, 20],
    ];
    const { app, win } = await coachApp({});
    for (const shape of shapes) {
      const { payload } = seedPayload(shape.map((n, i) => ({
        year: ['2016', '2017', '2018', '2019', '2020', '2021'][i], paper: 1,
        decide: (q, j) => (j < n ? 'correct' : 'wrong'),
        at: Date.UTC(2026, 3, 1) + i * 7 * 86400000,
      })));
      await win.evaluate((p) => window.api.data.importPayload(p), payload);
      const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));

      const bestRaw = Math.max(...shape);
      const bestScaled = CONV[LATEST].paper1[String(bestRaw)];
      // the headline prediction must never exceed the best real paper
      expect(p.perPaper[1].scaled,
        `shape ${shape}: predicted ${p.perPaper[1].scaled} (raw ${p.perPaper[1].predictedRaw}) vs best actual ${bestScaled} (raw ${bestRaw})`)
        .toBeLessThanOrEqual(bestScaled + 0.001);
      // even the optimistic end of the range stays within a small margin
      expect(p.perPaper[1].high).toBeLessThanOrEqual(bestScaled + 0.6);
    }
    await app.close();
  });

  test('gap-to-target is arithmetically right and never over-claims a topic', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 11 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 11 ? 'correct' : 'wrong') },
      { year: '2020', paper: 2, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
    ]);
    const { app, win } = await coachApp({ payload });
    const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));

    for (const paper of [1, 2]) {
      const need = p.gap.byPaper[paper].rawNeeded;
      const table = CONV[LATEST][`paper${paper}`];
      // rawNeeded is the lowest raw score reaching 7.0 on the official table
      expect(table[String(need)]).toBeGreaterThanOrEqual(7);
      expect(table[String(need - 1)]).toBeLessThan(7);
      // marks short = need - predicted raw
      expect(p.gap.byPaper[paper].marksShort)
        .toBeCloseTo(Math.max(0, Math.round((need - p.perPaper[paper].predictedRaw) * 10) / 10), 5);
    }

    // a topic can never offer more marks than it actually contains per paper
    for (const r of p.gap.recoverable) {
      expect(r.marks, `${r.label} claims more than exists`)
        .toBeLessThanOrEqual(perPaper(r.topic) + 0.001);
      expect(r.marks).toBeGreaterThan(0);
    }
    await app.close();
  });

  test('a flat history projects flat rather than inventing improvement', async () => {
    const { payload } = seedPayload([0, 1, 2, 3, 4, 5].map((_, i) => ({
      year: ['2016', '2017', '2018', '2019', '2020', '2021'][i], paper: 1,
      decide: (q, j) => (j < 12 ? 'correct' : 'wrong'),
      at: Date.UTC(2026, 3, 1) + i * 7 * 86400000,
    })));
    const { app, win } = await coachApp({ payload });
    const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
    expect(Math.abs(p.trajectory.perWeek)).toBeLessThan(0.05);
    expect(Math.abs(p.trajectory.projected - p.perPaper[1].scaled)).toBeLessThan(0.35);
    await app.close();
  });
});

// ===========================================================================
test.describe('QA2 §3 — countdown and deadlines', () => {
  const cases = [
    ['2026-10-12T09:00:00+01:00', 0, 'today'],
    ['2026-10-11T09:00:00+01:00', 1, '1 days'],
    ['2026-10-13T09:00:00+01:00', -1, '1 days ago'],
    ['2026-09-30T09:00:00+01:00', 12, '12 days'],      // crosses a month
    ['2025-12-31T09:00:00Z', 285, '285 days'],          // crosses a year
  ];

  for (const [iso, days, label] of cases) {
    test(`frozen at ${iso} the countdown reads ${days} days`, async () => {
      const { app, win } = await coachApp({ clock: { fixedIso: iso } });
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.countdown.days).toBe(days);
      expect(ov.countdown.daysLabel).toBe(label);
      expect(ov.countdown.weeks).toBeGreaterThanOrEqual(0);
      await app.close();
    });
  }

  test('the BST to GMT change on 25 October 2026 does not cause an off-by-one', async () => {
    // UK clocks go back on the last Sunday of October 2026 = 25 October.
    // A date either side of it must still count whole days correctly.
    const { app, win } = await coachApp({
      settings: { examDate: '2026-11-01' },
      clock: { fixedIso: '2026-10-24T12:00:00+01:00' },   // still BST
    });
    let ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.days).toBe(8);

    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-10-26T12:00:00Z' })); // GMT
    ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.days).toBe(6);

    // and the day the clocks change itself
    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-10-25T12:00:00Z' }));
    ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.days).toBe(7);
    await app.close();
  });

  test('the 6pm deadline cutoff is respected to the minute', async () => {
    // access-arrangements deadline: 14 September 2026, 6pm BST
    const { app, win } = await coachApp({
      clock: { fixedIso: '2026-09-14T17:59:00+01:00' },
    });
    let ov = await win.evaluate(() => window.api.coach.overview({}));
    let access = ov.countdown.deadlines.find(d => d.key === 'access');
    expect(access.passed, 'at 17:59 the deadline has not passed').toBe(false);
    expect(access.warn).toBe(true);

    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-09-14T18:01:00+01:00' }));
    ov = await win.evaluate(() => window.api.coach.overview({}));
    access = ov.countdown.deadlines.find(d => d.key === 'access');
    expect(access.passed, 'at 18:01 the deadline has passed').toBe(true);
    await app.close();
  });

  test('warnings appear under 21 days, and clear when ticked off', async () => {
    const { app, win } = await coachApp({
      clock: { fixedIso: '2026-08-20T09:00:00+01:00' },   // 25 days before 14 Sep
    });
    let ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.deadlines.find(d => d.key === 'access').warn).toBe(false);

    await win.evaluate(() => window.api.debug.setClock({ fixedIso: '2026-08-30T09:00:00+01:00' }));
    ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.deadlines.find(d => d.key === 'access').warn).toBe(true);

    await win.evaluate(() => window.api.settings.set({ accessArranged: true }));
    ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.deadlines.find(d => d.key === 'access').warn).toBe(false);
    await app.close();
  });

  test('my own exam date overrides the 12 October default everywhere', async () => {
    const { app, win } = await coachApp({
      settings: { examDate: '2026-10-15' },
      clock: { fixedIso: '2026-09-15T09:00:00+01:00' },
    });
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.countdown.examDate).toBe('2026-10-15');
    expect(ov.countdown.days).toBe(30);

    await win.evaluate(() => go('home'));
    await win.waitForSelector('.statusbar');
    const bar = await win.evaluate(() => document.querySelector('.statusbar').innerText);
    expect(bar).toContain('2026-10-15');
    expect(bar).not.toContain('2026-10-12');

    const plan = await win.evaluate(() => window.api.coach.plan({}));
    expect(plan.countdown.examDate).toBe('2026-10-15');
    await app.close();
  });
});
