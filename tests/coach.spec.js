const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  freshUserDir, launch, paperQuestions, seedPayload, BASE, ROOT, CONTENT,
} = require('./helpers');

const CONV = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'conversions.json'), 'utf8'));
const LATEST = Object.keys(CONV).sort().slice(-1)[0];

async function withSeed(payload, fn, settings) {
  const userDir = freshUserDir('coach');
  const { app, win } = await launch(userDir);
  try {
    if (settings) await win.evaluate((s) => window.api.settings.set(s), settings);
    if (payload) await win.evaluate((p) => window.api.data.importPayload(p), payload);
    return await fn(win, app, userDir);
  } finally {
    await app.close().catch(() => {});
  }
}

test.describe('study coach — countdown', () => {
  test('counts down correctly, including across month boundaries', async () => {
    await withSeed(null, async (win) => {
      const cases = [
        // examDate, "today" is real; use explicit dates far apart to cross months
        ['2026-10-12'],
        ['2026-08-01'],
        ['2026-12-31'],
      ];
      for (const [date] of cases) {
        await win.evaluate((d) => window.api.settings.set({ examDate: d }), date);
        const ov = await win.evaluate(() => window.api.coach.overview({}));
        const expected = Math.round(
          (new Date(`${date}T09:00:00`).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0))
          / 86400000);
        expect(ov.countdown.days, `days to ${date}`).toBe(expected);
        expect(ov.countdown.examDate).toBe(date);
        // weeks never negative, label always sensible
        expect(ov.countdown.weeks).toBeGreaterThanOrEqual(0);
        expect(ov.countdown.daysLabel).not.toContain('-');
      }
    });
  });

  test('exam day and past-exam states degrade gracefully with no negative days', async () => {
    await withSeed(null, async (win) => {
      const today = new Date();
      const iso = (d) => d.toISOString().slice(0, 10);

      await win.evaluate((d) => window.api.settings.set({ examDate: d }), iso(today));
      let ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.countdown.days).toBe(0);
      expect(ov.countdown.isExamDay).toBe(true);
      expect(ov.countdown.daysLabel).toBe('today');
      expect(ov.countdown.weeks).toBe(0);

      const past = new Date(today.getTime() - 10 * 86400000);
      await win.evaluate((d) => window.api.settings.set({ examDate: d }), iso(past));
      ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.countdown.days).toBe(-10);
      expect(ov.countdown.isPast).toBe(true);
      expect(ov.countdown.daysLabel).toBe('10 days ago');
      expect(ov.countdown.weeks).toBe(0);
      expect(ov.phase.key).toBe('past');

      // the plan screen must not explode after the exam
      const plan = await win.evaluate(() => window.api.coach.plan({}));
      expect(plan.weeks).toEqual([]);
      expect(plan.note).toContain('passed');
      await win.evaluate(() => go('plan'));
      await win.waitForSelector('h1:has-text("Study plan")');
      const text = await win.evaluate(() => document.body.innerText);
      expect(text).not.toMatch(/NaN|undefined|-\d+ days/);
    });
  });

  test('deadline warnings fire inside 21 days and clear when ticked off', async () => {
    await withSeed(null, async (win) => {
      const soon = new Date(Date.now() + 10 * 86400000).toISOString();
      await win.evaluate((d) => window.api.settings.set({
        accessDeadline: d, accessArranged: false,
      }), soon);
      let ov = await win.evaluate(() => window.api.coach.overview({}));
      let access = ov.countdown.deadlines.find(d => d.key === 'access');
      expect(access.warn).toBe(true);
      expect(access.days).toBe(10);

      await win.evaluate(() => go('home'));
      await win.waitForSelector('.statusbar');
      expect(await win.evaluate(() => document.body.innerText))
        .toContain('Access arrangements');

      // ticking it off silences the warning
      await win.evaluate(() => window.api.settings.set({ accessArranged: true }));
      ov = await win.evaluate(() => window.api.coach.overview({}));
      access = ov.countdown.deadlines.find(d => d.key === 'access');
      expect(access.warn).toBe(false);
      expect(access.done).toBe(true);

      // a far-off deadline does not warn
      const far = new Date(Date.now() + 120 * 86400000).toISOString();
      await win.evaluate((d) => window.api.settings.set({
        bookingDeadline: d, examBooked: false,
      }), far);
      ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.countdown.deadlines.find(d => d.key === 'booking').warn).toBe(false);
    });
  });
});

test.describe('study coach — grade predictor', () => {
  test('refuses to predict from a single attempt', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    await withSeed(payload, async (win) => {
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.prediction.ready).toBe(false);
      expect(ov.prediction.papers).toBe(1);
      expect(ov.prediction.message).toContain('at least 3');
      expect(ov.prediction.overall).toBeNull();

      await win.evaluate(() => go('home'));
      await win.waitForSelector('.statusbar');
      const text = await win.evaluate(() => document.querySelector('.statusbar').innerText);
      expect(text).toContain('—');
      expect(text).not.toMatch(/NaN|undefined/);
    });
  });

  test('scaled scores match the official tables at every raw score including 0 and 20', async () => {
    await withSeed(null, async (win) => {
      for (const year of Object.keys(CONV)) {
        for (const paper of [1, 2]) {
          for (const raw of [0, 1, 7, 13, 19, 20]) {
            const got = await win.evaluate(
              ({ y, p, r }) => window.api.coach.scaled({ year: y, paper: p, raw: r }),
              { y: year, p: paper, r: raw });
            expect(got.value, `${year} P${paper} raw ${raw}`)
              .toBe(CONV[year][`paper${paper}`][String(raw)]);
            expect(got.estimated).toBe(false);
          }
        }
      }
      // a year with no published table is flagged as estimated, not invented
      const spec = await win.evaluate(
        () => window.api.coach.scaled({ year: 'specimen', paper: 1, raw: 14 }));
      expect(spec.estimated).toBe(true);
      expect(spec.value).toBeGreaterThan(1);
      expect(spec.value).toBeLessThanOrEqual(9);
    });
  });

  test('predicts a range weighted to recent papers, and splits Paper 1 from Paper 2', async () => {
    // strong Paper 1 (18/20), weak Paper 2 (8/20), four papers total
    const { payload, raws } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 8 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2020', paper: 2, decide: (q, i) => (i < 8 ? 'correct' : 'wrong') },
    ]);
    expect(raws).toEqual([18, 8, 18, 8]);

    await withSeed(payload, async (win) => {
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      const p = ov.prediction;
      expect(p.ready).toBe(true);
      expect(p.papers).toBe(4);

      // every paper was 18 or 8, so the weighted raw must be exactly that
      expect(p.perPaper[1].predictedRaw).toBeCloseTo(18, 5);
      expect(p.perPaper[2].predictedRaw).toBeCloseTo(8, 5);
      expect(p.perPaper[1].scaled).toBe(CONV[LATEST].paper1['18']);
      expect(p.perPaper[2].scaled).toBe(CONV[LATEST].paper2['8']);

      // overall comes from the official overall table on the combined raw
      expect(p.overall.rawTotal).toBeCloseTo(26, 5);
      expect(p.overall.mostLikely).toBe(CONV[LATEST].overall['26']);
      // identical results per paper means no spread
      expect(p.overall.low).toBeLessThanOrEqual(p.overall.mostLikely);
      expect(p.overall.high).toBeGreaterThanOrEqual(p.overall.mostLikely);

      // the split is reported and Paper 2 named as the weaker
      const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
      expect(diag.split.weaker).toBe(2);
      expect(diag.split.paper1.avgRaw).toBe(18);
      expect(diag.split.paper2.avgRaw).toBe(8);
    });
  });

  test('weights recent papers above old ones', async () => {
    // improving: 6, 8, 10, 12, 14, 16 -> the prediction must sit well above the mean (11)
    const specs = [4, 6, 8, 10, 14, 18].map((n, i) => ({
      year: ['2016', '2017', '2018', '2019', '2020', '2021'][i], paper: 1,
      decide: (q, j) => (j < n ? 'correct' : 'wrong'),
      at: BASE + i * 5 * 86400000,
    }));
    const { payload } = seedPayload(specs);
    await withSeed(payload, async (win) => {
      const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
      const flatMean = (4 + 6 + 8 + 10 + 14 + 18) / 6;    // 10
      expect(p.perPaper[1].predictedRaw).toBeGreaterThan(flatMean);
      expect(p.perPaper[1].predictedRaw).toBeLessThanOrEqual(18);
      // improving trend must be detected and projected forward
      expect(p.trajectory).toBeTruthy();
      expect(p.trajectory.perWeek).toBeGreaterThan(0);
      expect(p.trajectory.projected).toBeGreaterThan(p.perPaper[1].scaled - 2);
    });
  });

  test('states the gap to 7.0 in raw marks and attributes it to weak topics', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
    ]);
    await withSeed(payload, async (win) => {
      const p = await win.evaluate(() => window.api.coach.overview({}).then(o => o.prediction));
      expect(p.ready).toBe(true);
      expect(p.gap.totalMarksShort).toBeGreaterThan(0);

      // the raw needed for 7.0 must agree with the official table
      const need1 = p.gap.byPaper[1].rawNeeded;
      expect(CONV[LATEST].paper1[String(need1)]).toBeGreaterThanOrEqual(7);
      expect(CONV[LATEST].paper1[String(need1 - 1)]).toBeLessThan(7);

      // recoverable marks are attributed to real topics
      for (const r of p.gap.recoverable) {
        expect(Object.keys(CONV).length).toBeGreaterThan(0);
        expect(r.marks).toBeGreaterThan(0);
        expect(typeof r.label).toBe('string');
      }
    });
  });
});

test.describe('study coach — diagnostics and checklist', () => {
  test('a weak topic ranks first by expected marks lost, not raw accuracy', async () => {
    // Wrong on every 'logic-truth' question, plus a few scattered misses
    const decide = (q, i) => (q.topics.includes('logic-truth') ? 'wrong'
      : i % 7 === 0 ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2019', paper: 2, decide },
      { year: '2020', paper: 2, decide },
      { year: '2021', paper: 2, decide },
    ]);

    await withSeed(payload, async (win) => {
      const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
      const logic = diag.topics.find(t => t.topic === 'logic-truth');
      expect(logic.accuracy).toBe(0);
      expect(logic.enoughData).toBe(true);
      expect(diag.topics[0].topic).toBe('logic-truth');

      // expected marks lost = (1 - accuracy) x questions per paper
      const perPaper = CONTENT.questions.filter(q => q.topics.includes('logic-truth')).length
        / new Set(CONTENT.questions.map(q => `${q.year}-${q.paper}`)).size;
      expect(logic.questionsPerPaper).toBeCloseTo(Math.round(perPaper * 100) / 100, 2);
      expect(logic.expectedMarksLost).toBeCloseTo(Math.round(perPaper * 100) / 100, 2);

      // a topic below the sample floor is labelled, not ranked
      const thin = diag.topics.filter(t => !t.enoughData);
      for (const t of thin) {
        expect(t.expectedMarksLost).toBeNull();
        expect(t.needMore).toBeGreaterThan(0);
      }

      // and it produces a study item naming the sub-skill
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      const study = ov.checklist.find(i => i.kind === 'study' && i.key.includes('logic-truth'));
      expect(study, 'a study item for the weakest topic').toBeTruthy();
      expect(study.title).toContain('Logic');
      expect(study.how).toMatch(/quantifiers|negating/);
      expect(study.action.topics).toEqual(['logic-truth']);
    });
  });

  test('a weaker Paper 2 pushes Paper 2 in the checklist', async () => {
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2017', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2018', paper: 1, decide: (q, i) => (i < 18 ? 'correct' : 'wrong') },
      { year: '2016', paper: 2, decide: (q, i) => (i < 7 ? 'correct' : 'wrong') },
    ]);
    await withSeed(payload, async (win) => {
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      const sit = ov.checklist.find(i => i.kind === 'paper');
      expect(sit, 'a paper to sit next').toBeTruthy();
      expect(sit.action.paper ?? 1).toBe(2);
      expect(sit.why).toMatch(/Paper 2 is your weaker paper|weaker/i);
    });
  });

  test('all-careless errors produce habit fixes, not topic study', async () => {
    const decide = (q, i) => (i % 3 === 0 ? 'wrong' : 'correct');
    const errorType = (q, i, verdict) => (verdict === 'wrong' ? 'careless' : null);
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide, errorType },
      { year: '2020', paper: 1, decide, errorType },
      { year: '2021', paper: 1, decide, errorType },
    ]);
    await withSeed(payload, async (win) => {
      const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
      expect(diag.errors.dominant.type).toBe('careless');
      expect(diag.errors.counts.careless).toBeGreaterThan(10);
      expect(diag.errors.untagged).toBe(0);

      const ov = await win.evaluate(() => window.api.coach.overview({}));
      const habit = ov.checklist.find(i => i.kind === 'habit' && i.key.startsWith('habit-careless'));
      expect(habit, 'a careless-error habit fix').toBeTruthy();
      expect(habit.how).toMatch(/re-read|checking/i);
      // and no topic-study item, because the problem is not knowledge
      expect(ov.checklist.find(i => i.kind === 'study' && i.key.startsWith('study-')))
        .toBeFalsy();
    });
  });

  test('two weeks out the phase switches to mocks and reserve papers are released', async () => {
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2016', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2017', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    const soon = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10);

    await withSeed(payload, async (win) => {
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.phase.key).toBe('simulation');
      expect(ov.phase.label).toBe('Exam simulation');
      expect(ov.phase.blurb).toMatch(/do not start new topics/i);

      // a full mock is pushed, not a single paper
      const sit = ov.checklist.find(i => i.kind === 'paper');
      expect(sit).toBeTruthy();
      expect(sit.action.type).toBe('mock');
      expect(sit.title).toMatch(/full timed mock/i);

      // no new topic study while in simulation phase
      expect(ov.checklist.find(i => i.key.startsWith('study-') && i.kind === 'study'
        && !i.key.includes('format'))).toBeFalsy();

      // the plan is mocks-only in the final fortnight
      const plan = await win.evaluate(() => window.api.coach.plan({}));
      expect(plan.weeks.length).toBeGreaterThan(0);
      for (const w of plan.weeks) {
        expect(w.isMockWeek).toBe(true);
        expect(w.topics).toEqual([]);
      }
    }, { examDate: soon });
  });

  test('with ten weeks left the plan protects reserve papers and favours topic study', async () => {
    const { payload } = seedPayload([
      { year: '2016', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2016', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2017', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    const far = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10);
    await withSeed(payload, async (win) => {
      const ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.phase.key).toBe('fundamentals');

      const plan = await win.evaluate(() => window.api.coach.plan({}));
      expect(plan.reserved.length).toBe(3);
      // reserved papers never appear in the build weeks
      const buildWeeks = plan.weeks.filter(w => !w.isMockWeek);
      const scheduled = buildWeeks.flatMap(w => w.papers.map(p => p.key));
      for (const r of plan.reserved) expect(scheduled).not.toContain(r);
      // build weeks carry topic focus, mock weeks do not
      expect(buildWeeks.some(w => w.topics.length > 0)).toBe(true);
      expect(plan.weeks.filter(w => w.isMockWeek).length).toBeGreaterThan(0);
    }, { examDate: far });
  });

  test('the checklist is capped and completing an item removes it', async () => {
    const decide = (q, i) => (i % 2 === 0 ? 'wrong' : 'correct');
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide }, { year: '2019', paper: 2, decide },
      { year: '2020', paper: 1, decide }, { year: '2020', paper: 2, decide },
    ]);
    await withSeed(payload, async (win) => {
      let ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.checklist.length).toBeLessThanOrEqual(5);
      expect(ov.checklist.length).toBeGreaterThan(0);
      const first = ov.checklist[0];

      await win.evaluate((i) => window.api.coach.complete({
        itemKey: i.key, title: i.title, kind: i.kind, dismissed: true,
      }), first);

      ov = await win.evaluate(() => window.api.coach.overview({}));
      expect(ov.checklist.find(i => i.key === first.key)).toBeFalsy();

      const history = await win.evaluate(() => window.api.coach.history());
      expect(history.length).toBe(1);
      expect(history[0].item_key).toBe(first.key);
      expect(history[0].dismissed).toBe(1);
    });
  });
});

test.describe('study coach — offline', () => {
  test('the whole coach works with zero outbound requests', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 9 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 14 ? 'correct' : 'wrong') },
    ]);
    const userDir = freshUserDir('coach-offline');
    const { app, win } = await launch(userDir);
    const seen = [];
    win.on('request', r => seen.push(r.url()));
    await win.evaluate((p) => window.api.data.importPayload(p), payload);

    for (const view of ['home', 'coach', 'plan', 'dashboard', 'offline', 'about']) {
      await win.evaluate((v) => go(v), view);
      await win.waitForTimeout(300);
    }
    const blocked = await win.evaluate(() => window.api.debug.blockedRequests());
    expect(blocked).toEqual([]);
    const external = seen.filter(u => !/^(file:|tmua-img:|data:|blob:|devtools:)/i.test(u));
    expect(external).toEqual([]);
    await app.close();
  });
});
