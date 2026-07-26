const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { freshUserDir, launch, startExam, ROOT, answerKey } = require('./helpers');

test.describe('offline and privacy', () => {
  test('a full mock makes zero outbound network requests', async () => {
    const userDir = freshUserDir('offline');
    const { app, win } = await launch(userDir);

    // record every request the renderer attempts, at the Chromium level
    const seen = [];
    win.on('request', r => seen.push(r.url()));

    const key = answerKey('2022', 1);
    const group = `mock-offline-${Date.now()}`;

    // Paper 1: answer all 20 correctly, submit, take the break, run Paper 2
    const p1 = await startExam(win, {
      mode: 'mock', year: '2022', paper: 1, mockGroup: group, allowedSec: 300,
    });
    await win.evaluate(async ({ id, key }) => {
      for (let i = 0; i < key.length; i++) {
        await window.api.attempt.answer({ attemptId: id, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, { id: p1, key });

    await win.waitForSelector('.break', { timeout: 20000 });
    await win.locator('button:has-text("Skip break")').click();
    await win.waitForSelector('.exam-bar', { timeout: 20000 });

    const p2key = answerKey('2022', 2);
    await win.evaluate(async (key) => {
      const id = State.exam.a.id;
      for (let i = 0; i < key.length; i++) {
        await window.api.attempt.answer({ attemptId: id, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, p2key);
    await win.waitForSelector('h1:has-text("Results")', { timeout: 20000 });

    // browse the analytics and review screens too — they load many images
    await win.evaluate(() => go('dashboard'));
    await win.waitForSelector('h1:has-text("Progress")');
    await win.evaluate(async () => {
      const rows = await window.api.history.list();
      await go('review', { attemptId: rows[0].id });
    });
    await win.waitForSelector('.review-item');
    await win.waitForTimeout(1500);

    // 1. the main process blocked nothing, because nothing was attempted
    const blocked = await win.evaluate(() => window.api.debug.blockedRequests());
    expect(blocked).toEqual([]);

    // 2. every request the renderer made was local
    const external = seen.filter(u => !/^(file:|tmua-img:|data:|blob:|devtools:)/i.test(u));
    expect(external).toEqual([]);
    expect(seen.some(u => u.startsWith('tmua-img:'))).toBe(true);

    // 3. mock scored 40/40 from local content only
    const summary = await win.evaluate((g) => window.api.mock.summary(g), group);
    expect(summary.rawTotal).toBe(40);
    expect(summary.papers.map(p => p.raw)).toEqual([20, 20]);

    await app.close();
  });

  test('an outbound request is refused if anything ever tries one', async () => {
    const userDir = freshUserDir('offline-block');
    const { app, win } = await launch(userDir);

    const result = await win.evaluate(async () => {
      try {
        const res = await fetch('https://example.com/ping');
        return { ok: true, status: res.status };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    });
    expect(result.ok).toBe(false);

    const img = await win.evaluate(() => new Promise(resolve => {
      const i = new Image();
      i.onload = () => resolve('loaded');
      i.onerror = () => resolve('blocked');
      i.src = 'https://example.com/pixel.png';
      setTimeout(() => resolve('timeout'), 4000);
    }));
    expect(img).not.toBe('loaded');

    await app.close();
  });

  test('no bundled source references a remote origin', async () => {
    const files = [
      'public/index.html', 'public/app.js', 'public/styles.css',
      'src/main.js', 'src/preload.js', 'src/db.js', 'src/content.js', 'src/analytics.js',
    ];
    const offenders = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // allow the string 'https://example.com' nowhere; look for any absolute URL
      const matches = text.match(/https?:\/\/[^\s'"`)]+/g) || [];
      for (const m of matches) offenders.push(`${f}: ${m}`);
    }
    expect(offenders).toEqual([]);
  });
});
