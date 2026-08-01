const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  freshUserDir, launch, startExam, answerKey, paperQuestions, seedPayload, CONTENT,
} = require('./helpers');

const CLOCK = { fixedIso: '2026-07-01T09:00:00+01:00' };

async function appWith(specs, extra = {}) {
  const userDir = freshUserDir('del');
  const { app, win } = await launch(userDir);
  await win.evaluate((c) => window.api.debug.setClock(c), CLOCK);
  if (specs) {
    const { payload } = seedPayload(specs);
    if (extra.mutate) extra.mutate(payload);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);
  }
  return { app, win, userDir };
}

// expectation computed here, from the surviving seed only
function expectedTopics(specs) {
  const m = new Map();
  for (const sp of specs) {
    for (const [i, q] of paperQuestions(sp.year, sp.paper).entries()) {
      const v = sp.decide(q, i);
      for (const t of q.topics) {
        if (!m.has(t)) m.set(t, { seen: 0, correct: 0 });
        const e = m.get(t); e.seen++; if (v === 'correct') e.correct++;
      }
    }
  }
  return m;
}

test.describe('deleting attempts', () => {
  const A = { year: '2019', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') };
  const B = { year: '2019', paper: 2, decide: (q, i) => (i < 9 ? 'correct' : 'wrong') };
  const C = { year: '2020', paper: 1, decide: (q, i) => (i < 15 ? 'correct' : 'wrong') };

  test('preview reports real counts, not a generic warning', async () => {
    const { app, win } = await appWith([A, B, C]);
    const pv = await win.evaluate(() => window.api.del.preview([1]));

    // paper 1 of 2019: 8 wrong by construction
    expect(pv.attempts.length).toBe(1);
    expect(pv.attempts[0].year).toBe('2019');
    expect(pv.wrong).toBe(8);
    expect(pv.answers).toBe(20);
    expect(pv.remainingPapers).toBe(2);
    expect(pv.reviewRemoved + pv.reviewRecomputed).toBeGreaterThan(0);
    await app.close();
  });

  test('deleting cascades exactly, leaves no orphans, and recomputes everything', async () => {
    const { app, win } = await appWith([A, B, C]);
    const before = await win.evaluate(() => window.api.coach.diagnostics({}));
    expect(before.topics.length).toBeGreaterThan(0);

    await win.evaluate(() => window.api.del.attempts({ ids: [1] }));
    await win.evaluate(() => window.api.del.commit([1]));

    // rows gone
    const hist = await win.evaluate(() => window.api.history.list());
    expect(hist.map(h => h.id).sort()).toEqual([2, 3]);
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);

    // wrong-answer log no longer mentions it
    const dash = await win.evaluate(() => window.api.analytics.dashboard({}));
    expect(dash.wrong.some(w => w.attemptId === 1)).toBe(false);
    expect(dash.summary.completedCount).toBe(2);

    // topic accuracy matches a value computed from the survivors alone
    const exp = expectedTopics([B, C]);
    const diag = await win.evaluate(() => window.api.coach.diagnostics({}));
    for (const row of diag.topics) {
      const e = exp.get(row.topic);
      expect(e, `topic ${row.topic} should not exist`).toBeTruthy();
      expect(row.seen, `${row.topic} seen`).toBe(e.seen);
      expect(row.correct, `${row.topic} correct`).toBe(e.correct);
    }
    // and the checklist / plan regenerate without referencing the deleted one
    const ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(JSON.stringify(ov.checklist)).not.toContain('"attemptId":1');
    const plan = await win.evaluate(() => window.api.coach.plan({}));
    // 2019 P1 is unseen again, so it may be scheduled
    expect(plan.weeks.flatMap(w => w.papers.map(p => p.key))).toContain('2019-P1');
    await app.close();
  });

  test('THE SHARED QUESTION: an entry survives if another attempt still justifies it', async () => {
    // the same paper sat twice, wrong on the same questions both times
    const twice = [
      { year: '2019', paper: 1, decide: (q, i) => (i < 5 ? 'wrong' : 'correct') },
      { year: '2019', paper: 1, decide: (q, i) => (i < 5 ? 'wrong' : 'correct') },
    ];
    const { app, win } = await appWith(twice);
    const qid = paperQuestions('2019', 1)[0].id;

    let entry = await win.evaluate((id) => window.api.review.all().then(
      r => r.find(x => x.questionId === id)), qid);
    expect(entry.misses).toBe(2);

    // delete attempt A — the entry must survive, rescheduled from B alone
    await win.evaluate(() => window.api.del.attempts({ ids: [1] }));
    await win.evaluate(() => window.api.del.commit([1]));
    entry = await win.evaluate((id) => window.api.review.all().then(
      r => r.find(x => x.questionId === id)), qid);
    expect(entry, 'entry must survive while B still justifies it').toBeTruthy();
    expect(entry.misses, 'schedule recomputed from B alone').toBe(1);
    expect(entry.lapses).toBe(0);

    // delete B too — now nothing justifies it
    await win.evaluate(() => window.api.del.attempts({ ids: [2] }));
    await win.evaluate(() => window.api.del.commit([2]));
    entry = await win.evaluate((id) => window.api.review.all().then(
      r => r.find(x => x.questionId === id)), qid);
    expect(entry, 'entry must be gone once nothing justifies it').toBeFalsy();
    expect(await win.evaluate(() => window.api.review.all())).toEqual([]);
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);
    await app.close();
  });

  test('falling below the sample floor reverts the predictor to "not enough data"', async () => {
    const { app, win } = await appWith([A, B, C]);
    expect((await win.evaluate(() => window.api.coach.overview({}))).prediction.ready).toBe(true);

    await win.evaluate(() => window.api.del.attempts({ ids: [1] }));
    await win.evaluate(() => window.api.del.commit([1]));

    const ov = await win.evaluate(() => window.api.coach.overview({}));
    expect(ov.prediction.ready).toBe(false);
    expect(ov.prediction.overall).toBeNull();
    expect(ov.prediction.message).toMatch(/at least 3/);

    await win.evaluate(() => go('home'));
    await win.waitForSelector('.statusbar');
    const block = await win.evaluate(() =>
      document.querySelector('.statusbar .sb-block.grow').innerText);
    expect(block, 'no stale number may remain').not.toMatch(/\d\.\d/);
    await app.close();
  });

  test('undo restores the attempt and every derived record exactly', async () => {
    const { app, win } = await appWith([A, B, C]);
    const before = await win.evaluate(() => window.api.data.exportPayload());
    const beforeDash = await win.evaluate(() => window.api.analytics.dashboard({}));

    await win.evaluate(() => window.api.del.attempts({ ids: [1] }));
    expect((await win.evaluate(() => window.api.history.list())).length).toBe(2);

    await win.evaluate(() => window.api.del.undo([1]));
    const after = await win.evaluate(() => window.api.data.exportPayload());
    const afterDash = await win.evaluate(() => window.api.analytics.dashboard({}));

    delete before.exportedAt; delete after.exportedAt;
    expect(after.attempts).toEqual(before.attempts);
    expect(after.reviewQueue).toEqual(before.reviewQueue);
    expect(afterDash).toEqual(beforeDash);
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);
    await app.close();
  });

  test('a backup is written before every deletion', async () => {
    const { app, win, userDir } = await appWith([A, B, C]);
    const dir = path.join(userDir, 'data', 'backups');
    const count = () => fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).length;
    const before = fs.existsSync(dir) ? count() : 0;

    await win.evaluate(() => window.api.del.attempts({ ids: [1] }));
    expect(count()).toBeGreaterThan(before);

    const mid = count();
    await win.evaluate(() => window.api.del.attempts({ ids: [2] }));
    expect(count()).toBeGreaterThan(mid);
    await app.close();
  });

  test('multi-delete needs a typed confirmation', async () => {
    const { app, win } = await appWith([A, B, C]);
    const refused = await win.evaluate(() => window.api.del.attempts({ ids: [1, 2] })
      .then(() => 'accepted').catch(e => e.message));
    expect(refused).toMatch(/typing DELETE/i);
    expect((await win.evaluate(() => window.api.history.list())).length).toBe(3);

    const wrongWord = await win.evaluate(() => window.api.del.attempts({ ids: [1, 2], confirm: 'yes' })
      .then(() => 'accepted').catch(e => e.message));
    expect(wrongWord).toMatch(/typing DELETE/i);

    const ok = await win.evaluate(() => window.api.del.attempts({ ids: [1, 2], confirm: 'DELETE' }));
    expect(ok.softDeleted).toEqual([1, 2]);
    await app.close();
  });

  test('deleting never touches archived runs or other attempts', async () => {
    const { app, win } = await appWith([A, B, C]);
    await win.evaluate(() => window.api.archive.create({ name: 'old run' }));
    // new active attempts after archiving
    const { payload } = seedPayload([
      { year: '2021', paper: 1, decide: (q, i) => (i < 10 ? 'correct' : 'wrong') },
    ]);
    payload.attempts[0].id = 99;
    payload.attempts[0].questions.forEach(q => { q.attempt_id = 99; });
    await win.evaluate(async (p) => {
      // import replaces wholesale, so append to the current export
      const cur = await window.api.data.exportPayload();
      cur.attempts.push(p.attempts[0]);
      await window.api.data.importPayload(cur);
    }, payload);

    const archivedBefore = await win.evaluate(() => window.api.archive.list());
    await win.evaluate(() => window.api.del.attempts({ ids: [99] }));
    await win.evaluate(() => window.api.del.commit([99]));

    const archivedAfter = await win.evaluate(() => window.api.archive.list());
    expect(archivedAfter).toEqual(archivedBefore);
    expect(archivedAfter[0].attempts).toBe(3);
    // the archived attempts are all still readable
    const arch = await win.evaluate((id) => window.api.analytics.dashboard({ archiveId: id }),
      archivedAfter[0].id);
    expect(arch.summary.completedCount).toBe(3);
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);
    await app.close();
  });

  test('a force-kill mid-delete leaves the database consistent', async () => {
    const userDir = freshUserDir('del-kill');
    let { app, win } = await launch(userDir);
    const { payload } = seedPayload([A, B, C]);
    await win.evaluate((p) => window.api.data.importPayload(p), payload);

    // soft-delete, then kill before the commit ever runs
    await win.evaluate(() => window.api.del.attempts({ ids: [1] }));
    process.kill(app.process().pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 1200));

    ({ app, win } = await launch(userDir));
    // consistent: the attempt is either fully present or fully gone, never partial
    const hist = await win.evaluate(() => window.api.history.list());
    const rows = await win.evaluate(() => window.api.debug.pendingDeletes());
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);
    if (hist.some(h => h.id === 1)) {
      // restored view — must be complete
      const a = await win.evaluate(() => window.api.attempt.get(1));
      expect(a.questions.length).toBe(20);
    } else {
      expect(rows).toContain(1);       // still pending, recoverable
    }
    // committing the pending delete finishes cleanly
    await win.evaluate(() => window.api.del.commit([]));
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);
    await app.close();
  });

  test('delete all history clears everything but keeps papers and settings', async () => {
    const { app, win } = await appWith([A, B, C]);
    await win.evaluate(() => window.api.settings.set({ targetScore: 8 }));
    await win.evaluate(() => window.api.archive.create({ name: 'x' }));

    const refused = await win.evaluate(() => window.api.del.allHistory({ confirm: 'nope' })
      .then(() => 'accepted').catch(e => e.message));
    expect(refused).toMatch(/DELETE ALL/);

    const res = await win.evaluate(() => window.api.del.allHistory({ confirm: 'DELETE ALL' }));
    expect(res.removed).toBe(3);
    expect(await win.evaluate(() => window.api.history.list())).toEqual([]);
    expect(await win.evaluate(() => window.api.review.all())).toEqual([]);
    expect(await win.evaluate(() => window.api.archive.list())).toEqual([]);
    expect(await win.evaluate(() => window.api.debug.orphanCheck())).toEqual([]);

    // papers and settings intact
    const cat = await win.evaluate(() => window.api.catalog());
    expect(cat.counts.questions).toBe(360);
    expect((await win.evaluate(() => window.api.settings.get())).targetScore).toBe(8);
    await app.close();
  });

  test('deleting through the history screen works end to end', async () => {
    const { app, win } = await appWith([A, B, C]);
    win.on('dialog', d => {
      if (d.type() === 'prompt') d.accept('DELETE').catch(() => {});
      else d.accept().catch(() => {});
    });
    await win.evaluate(() => go('history'));
    await win.waitForSelector('table');
    expect(await win.locator('tbody tr').count()).toBe(3);

    await win.locator('tbody tr .sel-attempt').first().check();
    await win.locator('button:has-text("Delete 1 selected")').click();
    await win.waitForTimeout(800);

    const hist = await win.evaluate(() => window.api.history.list());
    expect(hist.length).toBe(2);
    // the undo affordance is offered
    const toastText = await win.evaluate(() => document.getElementById('toast').innerText);
    expect(toastText).toMatch(/Undo/);
    await app.close();
  });
});
