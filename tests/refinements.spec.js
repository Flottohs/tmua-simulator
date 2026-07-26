const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  freshUserDir, launch, startExam, answerKey, paperQuestions, seedPayload, ROOT, CONTENT,
} = require('./helpers');

const PY = path.join(ROOT, 'pipeline', '.venv', 'bin', 'python');

// ---------------------------------------------------------------------------
// The SRS scheduler is pure, so it is exercised directly in the main process
// with an injected clock rather than by waiting three real days.
async function srsRun(win, steps, startIso = '2026-01-30T09:00:00Z') {
  return win.evaluate(({ steps, startIso }) => window.api.debug.srsSimulate({ steps, startIso }),
    { steps, startIso });
}

const DAY = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

test.describe('spaced repetition', () => {
  test('schedules +3, +7 then +21 days after a wrong answer', async () => {
    const userDir = freshUserDir('srs');
    const { app, win } = await launch(userDir);
    // wrong on day 0, then correct, correct, correct
    const out = await srsRun(win, ['wrong', 'correct', 'correct', 'correct']);
    expect(out.map(s => s.afterDays)).toEqual([3, 7, 21, 45]);
    // due dates land on the right calendar days, crossing a month boundary
    expect(out[0].dueOn).toBe('2026-02-02');   // 30 Jan + 3
    expect(out[1].dueOn).toBe('2026-02-09');   // +7
    expect(out[2].dueOn).toBe('2026-03-02');   // +21
    await app.close();
  });

  test('a wrong answer resets the interval to the start', async () => {
    const userDir = freshUserDir('srs-reset');
    const { app, win } = await launch(userDir);
    const out = await srsRun(win, ['wrong', 'correct', 'wrong', 'correct']);
    expect(out.map(s => s.afterDays)).toEqual([3, 7, 3, 7]);
    expect(out[2].intervalIndex).toBe(0);
    expect(out[2].consecutiveCorrect).toBe(0);
    expect(out[2].lapses).toBe(1);
    expect(out[2].retired).toBe(false);
    await app.close();
  });

  test('retirement needs two consecutive spaced successes, not one', async () => {
    const userDir = freshUserDir('srs-retire');
    const { app, win } = await launch(userDir);
    const out = await srsRun(win, ['wrong', 'correct', 'correct']);
    expect(out[1].consecutiveCorrect).toBe(1);
    expect(out[1].retired, 'one success must not retire it').toBe(false);
    expect(out[2].consecutiveCorrect).toBe(2);
    expect(out[2].retired, 'two in a row retires it').toBe(true);

    // and a lapse in between prevents retirement
    const out2 = await srsRun(win, ['wrong', 'correct', 'wrong', 'correct']);
    expect(out2[3].retired).toBe(false);
    expect(out2[3].consecutiveCorrect).toBe(1);
    await app.close();
  });

  test('wrong answers enter the queue and correct ones advance it, end to end', async () => {
    const userDir = freshUserDir('srs-e2e');
    const { app, win } = await launch(userDir);
    const key = answerKey('2019', 1);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 20; i++) {
        // wrong on the first five, right on the rest
        const sel = i < 5 ? (key[i] === 'A' ? 'B' : 'A') : key[i];
        await window.api.attempt.answer({ attemptId, position: i, selected: sel });
        if (i === 0) await window.api.attempt.confidence({ attemptId, position: i, confidence: 'sure' });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');

    const all = await win.evaluate(() => window.api.review.all());
    expect(all.length).toBe(5);
    // the confidently-wrong one is tracked as the highest-risk source
    expect(all.find(r => r.questionId === '2019-P1-Q01').source).toBe('sure_wrong');
    expect(all.filter(r => r.source === 'wrong').length).toBe(4);
    for (const r of all) {
      expect(r.retired).toBe(false);
      expect(r.nextIntervalDays).toBe(3);
    }
    await app.close();
  });

  test('a session is capped and ordered most-overdue first', async () => {
    const userDir = freshUserDir('srs-session');
    const { app, win } = await launch(userDir);
    const seeded = await win.evaluate(() => window.api.debug.srsSeed({ count: 30 }));
    expect(seeded.inserted).toBe(30);

    const sess = await win.evaluate(() => window.api.review.session({}));
    expect(sess.ids.length).toBe(20);                 // capped
    const overdue = sess.items.map(i => i.overdueDays);
    // non-increasing overdue: the most overdue come first
    for (let i = 1; i < overdue.length; i++) {
      expect(overdue[i]).toBeLessThanOrEqual(overdue[i - 1]);
    }
    expect(overdue[0]).toBeGreaterThan(overdue[overdue.length - 1]);

    const summary = await win.evaluate(() => window.api.review.summary());
    expect(summary.due).toBe(30);
    expect(summary.cap).toBe(20);
    await app.close();
  });

  test('stubborn questions are surfaced and the coach builds study from them', async () => {
    const userDir = freshUserDir('srs-stubborn');
    const { app, win } = await launch(userDir);
    await win.evaluate(() => window.api.debug.srsSeed({ count: 6, lapses: 3 }));
    const stubborn = await win.evaluate(() => window.api.review.stubborn());
    expect(stubborn.length).toBe(6);
    for (const s of stubborn) {
      expect(s.lapses).toBeGreaterThanOrEqual(2);
      expect(s.stubborn).toBe(true);
      expect(s.trend).toBe('keeps resetting');
    }
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const item = ov.checklist.find(i => i.key.startsWith('repeat-misses'));
    expect(item, 'stubborn questions produce a top checklist item').toBeTruthy();
    expect(item.priority).toBeGreaterThanOrEqual(95);
    expect(item.action.questionIds.length).toBeGreaterThanOrEqual(3);
    await app.close();
  });
});

test.describe('answer-change tracking', () => {
  test('counts helped, hurt and neutral changes exactly', async () => {
    const userDir = freshUserDir('changes');
    const { app, win } = await launch(userDir);
    const qs = paperQuestions('2019', 1);
    const key = qs.map(q => q.answer);
    const other = (q, not) => 'ABCDEFGH'.slice(0, q.options).split('')
      .find(L => L !== q.answer && L !== not);

    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });

    // 3 wrong->right (helped), 2 right->wrong (hurt), 1 wrong->wrong (neutral)
    const plan = [];
    for (let i = 0; i < 3; i++) plan.push({ i, from: other(qs[i]), to: key[i], kind: 'helped' });
    for (let i = 3; i < 5; i++) plan.push({ i, from: key[i], to: other(qs[i]), kind: 'hurt' });
    plan.push({ i: 5, from: other(qs[5]), to: other(qs[5], other(qs[5])), kind: 'neutral' });

    await win.evaluate(async ({ attemptId, plan }) => {
      for (const p of plan) {
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.from });
        await window.api.attempt.answer({ attemptId, position: p.i, selected: p.to });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, plan });
    await win.waitForSelector('h1:has-text("Results")');

    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.changes.total).toBe(6);
    expect(diag.changes.helped).toBe(3);
    expect(diag.changes.hurt).toBe(2);
    expect(diag.changes.neutral).toBe(1);
    expect(diag.changes.net).toBe(1);
    // below the sample floor the coach must not draw a conclusion
    expect(diag.changes.enoughData).toBe(false);
    expect(diag.changes.verdict).toBeNull();
    await app.close();
  });

  test('setting an answer for the first time is not a change', async () => {
    const userDir = freshUserDir('changes-first');
    const { app, win } = await launch(userDir);
    const id = await startExam(win, { mode: 'paper', year: '2020', paper: 1 });
    await win.evaluate(async (attemptId) => {
      for (let i = 0; i < 5; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: 'A' });
      }
      await State.exam.finish('submitted');
    }, id);
    await win.waitForSelector('h1:has-text("Results")');
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(diag.changes.total).toBe(0);
    await app.close();
  });
});

test.describe('guessing and confidence strategy', () => {
  test('counts blanks and values them against the random-guess rate', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 16 ? 'correct' : i < 18 ? 'wrong' : 'blank') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 17 ? 'correct' : 'blank') },
    ]);
    const userDir = freshUserDir('guessing');
    const { app, win } = await launch(userDir);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);

    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    // 2 blank in the first paper, 3 in the second
    expect(diag.guessing.blanks).toBe(5);
    expect(diag.guessing.marksThrownAway).toBeGreaterThan(0);
    expect(diag.guessing.marksThrownAway)
      .toBeCloseTo(Math.round(5 * diag.guessing.randomRate * 10) / 10, 5);

    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const item = ov.checklist.find(i => i.key.startsWith('habit-blanks'));
    expect(item, 'blanks produce a habit item').toBeTruthy();
    expect(item.why).toContain('no negative marking');
    await app.close();
  });

  test('sure vs unsure accuracy is reported and judged against random', async () => {
    // unsure answers right 80% of the time — well above random
    const { payload } = seedPayload([
      {
        year: '2019', paper: 1,
        decide: (q, i) => (i % 5 === 0 ? 'wrong' : 'correct'),
        confidence: (q, i) => (i % 2 ? 'sure' : 'unsure'),
      },
      {
        year: '2020', paper: 1,
        decide: (q, i) => (i % 5 === 0 ? 'wrong' : 'correct'),
        confidence: (q, i) => (i % 2 ? 'sure' : 'unsure'),
      },
    ]);
    const userDir = freshUserDir('confidence');
    const { app, win } = await launch(userDir);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    const g = diag.guessing;

    // hand-computed: positions 0,5,10,15 wrong in each paper; even positions unsure
    // wrong+unsure = 0,10 (even) x2 papers = 4 ; wrong+sure = 5,15 x2 = 4
    expect(g.sureWrong).toBe(4);
    expect(g.unsureWrong).toBe(4);
    expect(g.sureRight + g.sureWrong + g.unsureRight + g.unsureWrong).toBe(40);
    expect(g.unsureAccuracy).toBeCloseTo(g.unsureRight / (g.unsureRight + g.unsureWrong), 6);
    expect(g.unsureVerdict).toBe('trust');
    await app.close();
  });

  test('confidently wrong answers outrank ordinary wrong answers in the queue', async () => {
    const userDir = freshUserDir('surewrong');
    const { app, win } = await launch(userDir);
    const key = answerKey('2021', 1);
    const id = await startExam(win, { mode: 'paper', year: '2021', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 4; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] === 'A' ? 'B' : 'A' });
        // only the last one is marked "sure"
        if (i === 3) await window.api.attempt.confidence({ attemptId, position: i, confidence: 'sure' });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');

    // a just-missed question is scheduled for +3 days, so nothing is due today
    const today = await win.evaluate(() => window.api.review.session({}));
    expect(today.ids.length).toBe(0);

    // the confidently-wrong one is recorded as the higher-risk source
    const all = await win.evaluate(() => window.api.review.all());
    expect(all.filter(r => r.source === 'sure_wrong').length).toBe(1);
    expect(all.find(r => r.source === 'sure_wrong').questionId).toBe('2021-P1-Q04');

    // and when equally overdue, sure_wrong sorts ahead of ordinary wrong
    await win.evaluate(() => window.api.debug.srsSeed({
      count: 4, sources: ['wrong', 'wrong', 'sure_wrong', 'wrong'], sameDue: true,
    }));
    const ranked = await win.evaluate(() => window.api.review.session({}));
    expect(ranked.items[0].source).toBe('sure_wrong');
    await app.close();
  });

  test('the submit warning lists which questions are blank', async () => {
    const userDir = freshUserDir('blankwarn');
    const { app, win } = await launch(userDir);
    const key = answerKey('2019', 2);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 2 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 20; i++) {
        if (i === 2 || i === 7 || i === 19) continue;      // leave three blank
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
        State.exam.a.questions[i].selected = key[i];
      }
      State.exam.paintNav();
    }, { attemptId: id, key });

    let dialogText = null;
    win.once('dialog', d => { dialogText = d.message(); });
    await win.locator('button:has-text("Submit paper")').click();
    await win.waitForSelector('h1:has-text("Results")');

    expect(dialogText).toBeTruthy();
    expect(dialogText).toContain('3 questions still blank');
    expect(dialogText).toContain('3, 8, 20');       // 1-based question numbers
    expect(dialogText).toContain('no negative marking');

    // accepting the warning submits, and the blanks are recorded as blanks
    const a = await win.evaluate((i) => window.api.attempt.get(i), id);
    expect(a.status).toBe('completed');
    expect(a.questions.filter(q => !q.selected).map(q => q.position)).toEqual([2, 7, 19]);
    await app.close();
  });
});

test.describe('PDF export', () => {
  test('exports a printable paper with every question and no answers', async () => {
    const userDir = freshUserDir('pdf');
    const { app, win } = await launch(userDir);
    const out = path.join(userDir, 'paper.pdf');

    const res = await win.evaluate((o) =>
      window.api.pdf.paperTo({ year: '2019', paper: 1, outPath: o }), out);
    expect(res.bytes).toBeGreaterThan(20000);
    expect(fs.existsSync(out)).toBe(true);

    // inspect the real PDF with PyMuPDF
    const probe = execFileSync(PY, ['-c', `
import fitz, json, sys
d = fitz.open(sys.argv[1])
text = "".join(d[i].get_text("text") for i in range(d.page_count))
imgs = sum(len(d[i].get_images(full=True)) for i in range(d.page_count))
print(json.dumps({"pages": d.page_count, "images": imgs, "text": text[:4000]}))
`, out], { encoding: 'utf8' });
    const info = JSON.parse(probe);

    expect(info.pages).toBeGreaterThanOrEqual(6);
    // one image per question, at least
    expect(info.images).toBeGreaterThanOrEqual(20);
    expect(info.text).toContain('TMUA 2019');
    expect(info.text).toContain('Paper 1');
    expect(info.text).toContain('no negative marking');
    // the questions-only export must not leak the mark scheme
    expect(info.text).not.toContain('Mark scheme');
    await app.close();
  });

  test('the mark scheme is a separate opt-in section carrying every answer', async () => {
    const userDir = freshUserDir('pdf-ms');
    const { app, win } = await launch(userDir);
    const out = path.join(userDir, 'paper-ms.pdf');
    await win.evaluate((o) => window.api.pdf.paperTo({
      year: '2019', paper: 1, outPath: o, includeAnswerSheet: true, includeMarkScheme: true,
    }), out);

    const probe = execFileSync(PY, ['-c', `
import fitz, json, sys
d = fitz.open(sys.argv[1])
print(json.dumps({"text": "".join(d[i].get_text("text") for i in range(d.page_count))[-2500:]}))
`, out], { encoding: 'utf8' });
    const tail = JSON.parse(probe).text;
    expect(tail).toContain('Answer sheet');
    expect(tail).toContain('Mark scheme');
    const key = answerKey('2019', 1);
    // every answer letter appears in the mark-scheme tail
    const scheme = tail.slice(tail.indexOf('Mark scheme'));
    for (let i = 0; i < 20; i++) {
      expect(scheme, `answer for Q${i + 1}`).toContain(key[i]);
    }
    await app.close();
  });

  test('a custom drill exports too', async () => {
    const userDir = freshUserDir('pdf-drill');
    const { app, win } = await launch(userDir);
    const out = path.join(userDir, 'drill.pdf');
    const ids = CONTENT.questions.filter(q => q.topics.includes('integration'))
      .slice(0, 6).map(q => q.id);
    const res = await win.evaluate(({ o, ids }) =>
      window.api.pdf.drillTo({ questionIds: ids, outPath: o, title: 'Integration drill' }),
      { o: out, ids });
    expect(res.bytes).toBeGreaterThan(10000);
    const probe = execFileSync(PY, ['-c', `
import fitz, json, sys
d = fitz.open(sys.argv[1])
print(json.dumps({"pages": d.page_count,
  "images": sum(len(d[i].get_images(full=True)) for i in range(d.page_count)),
  "text": "".join(d[i].get_text("text") for i in range(d.page_count))[:800]}))
`, out], { encoding: 'utf8' });
    const info = JSON.parse(probe);
    expect(info.images).toBeGreaterThanOrEqual(6);
    expect(info.text).toContain('Integration drill');
    await app.close();
  });
});

test.describe('offline attempt entry', () => {
  test('records a paper sat on paper and scores it into history', async () => {
    const userDir = freshUserDir('offline-entry');
    const { app, win } = await launch(userDir);
    const key = answerKey('2018', 1);
    // 14 right, 3 wrong, 3 blank
    const answers = key.map((k, i) => {
      if (i >= 17) return null;
      if (i < 14) return k;
      return k === 'A' ? 'B' : 'A';
    });

    const res = await win.evaluate(({ answers }) => window.api.offline.record({
      year: '2018', paper: 1, answers, minutes: 88, when: '2026-07-01',
    }), { answers });

    expect(res.scoreRaw).toBe(14);
    expect(res.status).toBe('completed');
    expect(res.questions.filter(q => !q.selected).length).toBe(3);

    const hist = await win.evaluate(() => window.api.history.list());
    expect(hist.length).toBe(1);
    expect(hist[0].scoreRaw).toBe(14);

    // it counts toward the predictor and analytics like any other attempt
    const dash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(dash.summary.completedCount).toBe(1);

    // bad input is rejected
    const bad = await win.evaluate(() => window.api.offline.record({
      year: '2018', paper: 1, answers: ['Z'], minutes: 60,
    }).then(() => 'accepted').catch(e => e.message));
    expect(bad).toMatch(/Expected 20 answers/);
    await app.close();
  });
});

test.describe('archive and clean slate', () => {
  test('archiving is non-destructive, resets active analytics, and restores identically', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 9 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 14 ? 'correct' : 'wrong') },
    ]);
    const userDir = freshUserDir('archive');
    const { app, win } = await launch(userDir);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);

    const before = await win.evaluate(() => window.api.data.exportPayload());
    const beforeDash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(beforeDash.summary.completedCount).toBe(3);

    const backupsDir = path.join(userDir, 'data', 'backups');
    const backupsBefore = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter(f => f.endsWith('.sqlite')).length : 0;

    const res = await win.evaluate(() =>
      window.api.archive.create({ name: 'pre-September run' }));
    expect(res.moved).toBe(3);

    // a backup was taken before archiving
    const backupsAfter = fs.readdirSync(backupsDir).filter(f => f.endsWith('.sqlite')).length;
    expect(backupsAfter).toBeGreaterThan(backupsBefore);

    // active analytics are empty, and nothing was deleted
    const activeDash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(activeDash.summary.completedCount).toBe(0);
    expect(activeDash.wrong).toEqual([]);
    expect(await win.evaluate(() => window.api.history.list())).toEqual([]);

    const archives = await win.evaluate(() => window.api.archive.list());
    expect(archives.length).toBe(1);
    expect(archives[0].name).toBe('pre-September run');
    expect(archives[0].attempts).toBe(3);

    // the archived run is still fully readable and comparable
    const archivedDash = await win.evaluate((id) =>
      window.api.analytics.dashboard({ archiveId: id }), archives[0].id);
    expect(archivedDash.summary.completedCount).toBe(3);
    expect(archivedDash.summary.trend.length).toBe(3);

    // the coach starts fresh too
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.prediction.ready).toBe(false);

    // restoring returns everything identically
    await win.evaluate((id) => window.api.archive.restore(id), archives[0].id);
    const after = await win.evaluate(() => window.api.data.exportPayload());
    delete before.exportedAt; delete after.exportedAt;
    expect(after.attempts).toEqual(before.attempts);
    const afterDash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(afterDash).toEqual(beforeDash);
    expect(await win.evaluate(() => window.api.archive.list())).toEqual([]);
    await app.close();
  });

  test('an archive needs a name', async () => {
    const userDir = freshUserDir('archive-name');
    const { app, win } = await launch(userDir);
    const res = await win.evaluate(() => window.api.archive.create({ name: '  ' })
      .then(() => 'accepted').catch(e => e.message));
    expect(res).toMatch(/needs a name/);
    await app.close();
  });
});

test.describe('format-change notice', () => {
  test('the About screen states the 2024 provider change permanently', async () => {
    const userDir = freshUserDir('about');
    const { app, win } = await launch(userDir);
    await win.evaluate(() => go('about'));
    await win.waitForSelector('h1:has-text("About")');
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).toContain('Cambridge Assessment era, 2016–2023');
    expect(text).toContain('UAT-UK took over');
    expect(text).toMatch(/specimen or practice paper from the current provider/);
    expect(text).toContain('no network requests');
    await app.close();
  });

  test('the final month adds a current-provider checklist item', async () => {
    const { payload } = seedPayload([
      { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2019', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
      { year: '2020', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    ]);
    const userDir = freshUserDir('format-item');
    const { app, win } = await launch(userDir);
    const soon = new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10);
    await win.evaluate((d) => window.api.settings.set({ examDate: d }), soon);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);

    const ov = await win.evaluate(() => window.api.coach.overview({}));
    const item = ov.checklist.find(i => i.key === 'format-current-provider');
    expect(item, 'format familiarity item inside the final month').toBeTruthy();
    expect(item.why).toContain('2024');
    expect(item.action.type).toBe('offline-entry');
    await app.close();
  });
});
