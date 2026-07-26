const { test, expect } = require('@playwright/test');
const { freshUserDir, launch, seedPayload } = require('./helpers');

const CLOCK = { fixedIso: '2026-07-01T09:00:00+01:00' };

async function planApp() {
  const userDir = freshUserDir('planedit');
  const { app, win } = await launch(userDir);
  await win.evaluate((c) => window.api.debug.setClock(c), CLOCK);
  const { payload } = seedPayload([
    { year: '2016', paper: 1, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
    { year: '2016', paper: 2, decide: (q, i) => (i < 12 ? 'correct' : 'wrong') },
  ]);
  await win.evaluate((p) => window.api.data.importPayload(p), payload);
  return { app, win, userDir };
}

test.describe('editable study plan', () => {
  test('a week can be edited and the edit survives recalculation', async () => {
    const { app, win } = await planApp();
    const before = await win.evaluate(() => window.api.coach.plan({}));
    const week = before.weeks[1];
    expect(week.edited).toBe(false);

    await win.evaluate((ws) => window.api.coach.setWeek({
      weekStart: ws, papers: ['2019-P1', '2019-P2'],
      topics: ['integration'], note: 'half term — lighter week',
    }), week.startsOn);

    const after = await win.evaluate(() => window.api.coach.plan({}));
    const edited = after.weeks.find(w => w.startsOn === week.startsOn);
    expect(edited.edited).toBe(true);
    expect(edited.papers.map(p => p.key)).toEqual(['2019-P1', '2019-P2']);
    expect(edited.topics.map(t => t.topic)).toEqual(['integration']);
    expect(edited.note).toBe('half term — lighter week');
    expect(after.editedWeeks).toBe(1);
    await app.close();
  });

  test('a pinned paper is never also auto-scheduled elsewhere', async () => {
    const { app, win } = await planApp();
    const before = await win.evaluate(() => window.api.coach.plan({}));
    const target = before.weeks[3];

    await win.evaluate((ws) => window.api.coach.setWeek({
      weekStart: ws, papers: ['2022-P1', '2022-P2'], topics: null, note: null,
    }), target.startsOn);

    const after = await win.evaluate(() => window.api.coach.plan({}));
    const all = after.weeks.flatMap(w => w.papers.map(p => p.key));
    // each pinned paper appears exactly once across the whole plan
    for (const k of ['2022-P1', '2022-P2']) {
      expect(all.filter(x => x === k).length, `${k} scheduled once`).toBe(1);
    }
    // and no paper is duplicated anywhere
    expect(new Set(all).size).toBe(all.length);
    await app.close();
  });

  test('resetting a week restores the suggestion, and reset-all clears everything', async () => {
    const { app, win } = await planApp();
    const before = await win.evaluate(() => window.api.coach.plan({}));
    const w0 = before.weeks[0].startsOn;
    const w1 = before.weeks[1].startsOn;
    const suggested = before.weeks[0].papers.map(p => p.key);

    await win.evaluate(({ a, b }) => Promise.all([
      window.api.coach.setWeek({ weekStart: a, papers: [], topics: null, note: 'rest' }),
      window.api.coach.setWeek({ weekStart: b, papers: ['2023-P1'], topics: null, note: null }),
    ]), { a: w0, b: w1 });
    expect((await win.evaluate(() => window.api.coach.plan({}))).editedWeeks).toBe(2);

    await win.evaluate((ws) => window.api.coach.resetWeek(ws), w0);
    let plan = await win.evaluate(() => window.api.coach.plan({}));
    expect(plan.weeks[0].edited).toBe(false);
    expect(plan.weeks[0].papers.map(p => p.key)).toEqual(suggested);
    expect(plan.editedWeeks).toBe(1);

    await win.evaluate(() => window.api.coach.resetWeek(null));
    plan = await win.evaluate(() => window.api.coach.plan({}));
    expect(plan.editedWeeks).toBe(0);
    expect(plan.weeks.every(w => !w.edited)).toBe(true);
    await app.close();
  });

  test('invalid edits are rejected', async () => {
    const { app, win } = await planApp();
    const plan = await win.evaluate(() => window.api.coach.plan({}));
    const ws = plan.weeks[0].startsOn;
    const bad = [
      { weekStart: 'not-a-date', papers: [] },
      { weekStart: ws, papers: ['9999-P3'] },
      { weekStart: ws, papers: ['2019-P1', '2019-P1'] },
      { weekStart: ws, topics: ['not-a-topic'] },
      { weekStart: ws, papers: 'nope' },
    ];
    for (const patch of bad) {
      const res = await win.evaluate((pp) => window.api.coach.setWeek(pp)
        .then(() => 'accepted').catch(e => 'rejected: ' + e.message), patch);
      expect(res, JSON.stringify(patch)).toMatch(/^rejected/);
    }
    expect((await win.evaluate(() => window.api.coach.plan({}))).editedWeeks).toBe(0);
    await app.close();
  });

  test('edits survive a restart and travel through export/import', async () => {
    const { app, win, userDir } = await planApp();
    const plan = await win.evaluate(() => window.api.coach.plan({}));
    const ws = plan.weeks[2].startsOn;
    await win.evaluate((w) => window.api.coach.setWeek({
      weekStart: w, papers: ['2021-P2'], topics: ['trigonometry'], note: 'exam week at school',
    }), ws);
    const exported = await win.evaluate(() => window.api.data.exportPayload());
    expect(exported.planOverrides.length).toBe(1);
    await app.close();

    // restart
    const again = await launch(userDir);
    await again.win.evaluate((c) => window.api.debug.setClock(c), CLOCK);
    const after = await again.win.evaluate(() => window.api.coach.plan({}));
    const w = after.weeks.find(x => x.startsOn === ws);
    expect(w.edited).toBe(true);
    expect(w.note).toBe('exam week at school');
    await again.app.close();

    // import into a clean profile
    const fresh = await launch(freshUserDir('planimport'));
    await fresh.win.evaluate((c) => window.api.debug.setClock(c), CLOCK);
    await fresh.win.evaluate((p) => window.api.data.importPayload(p), exported);
    const imported = await fresh.win.evaluate(() => window.api.coach.plan({}));
    expect(imported.weeks.find(x => x.startsOn === ws).note).toBe('exam week at school');
    await fresh.app.close();
  });

  test('the plan screen edits a week through the UI', async () => {
    const { app, win } = await planApp();
    await win.evaluate(() => go('plan'));
    await win.waitForSelector('table');

    await win.locator('tbody tr button:has-text("Edit")').first().click();
    await win.waitForSelector('.week-editor');

    // toggle a paper chip and save
    await win.locator('.week-editor .chip').first().click();
    await win.locator('.week-editor button:has-text("Save week")').click();
    await win.waitForTimeout(600);

    const plan = await win.evaluate(() => window.api.coach.plan({}));
    expect(plan.editedWeeks).toBe(1);
    await expect(win.locator('tr.edited-week')).toHaveCount(1);
    const text = await win.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/NaN|undefined|\[object/);
    await app.close();
  });
});
