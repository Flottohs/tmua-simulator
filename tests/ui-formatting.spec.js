const { test, expect } = require('@playwright/test');
const { freshUserDir, launch, startExam, answerKey } = require('./helpers');

const PLACEHOLDERS = /\b(TODO|FIXME|lorem ipsum|\[object Object\]|undefined|NaN|Infinity)\b/;

// Text that is legitimately allowed to contain the word "null" etc. — none.
function scanText(text) {
  const hits = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (PLACEHOLDERS.test(t)) hits.push(t.slice(0, 120));
    if (/(^|\s)null(\s|$)/.test(t)) hits.push('null: ' + t.slice(0, 120));
  }
  return hits;
}

test.describe('UI formatting sweep', () => {
  let userDir, app, win, consoleIssues;

  test.beforeAll(async () => {
    userDir = freshUserDir('ui');
    ({ app, win } = await launch(userDir));
    consoleIssues = [];
    win.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning') {
        consoleIssues.push(`[${m.type()}] ${m.text()}`);
      }
    });
    win.on('pageerror', e => consoleIssues.push(`[pageerror] ${e.message}`));

    // build real state so every screen has content to render
    const key = answerKey('2019', 1);
    const id = await startExam(win, { mode: 'paper', year: '2019', paper: 1 });
    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < 16; i++) {
        const sel = i < 11 ? key[i] : (key[i] === 'A' ? 'C' : 'A');
        await window.api.attempt.answer({ attemptId, position: i, selected: sel });
        await window.api.attempt.confidence({ attemptId, position: i, confidence: i % 2 ? 'sure' : 'unsure' });
      }
      await window.api.attempt.flag({ attemptId, position: 2, flagged: true });
      await State.exam.finish('submitted');
    }, { attemptId: id, key });
    await win.waitForSelector('h1:has-text("Results")');
    await win.evaluate(() => window.api.revisit.add({ questionId: '2019-P1-Q03' }));
  });

  test.afterAll(async () => { if (app) await app.close().catch(() => {}); });

  const screens = [
    ['home', async (w) => { await w.evaluate(() => go('home')); await w.waitForSelector('h1:has-text("Practise")'); }],
    ['drill builder', async (w) => { await w.evaluate(() => go('drill')); await w.waitForSelector('h1:has-text("Custom drill")'); }],
    ['history', async (w) => { await w.evaluate(() => go('history')); await w.waitForSelector('h1:has-text("History")'); }],
    ['results', async (w) => {
      await w.evaluate(async () => {
        const r = await window.api.history.list();
        await go('results', { attemptId: r.find(x => x.status === 'completed').id });
      });
      await w.waitForSelector('h1:has-text("Results")');
    }],
    ['review', async (w) => {
      await w.evaluate(async () => {
        const r = await window.api.history.list();
        await go('review', { attemptId: r.find(x => x.status === 'completed').id });
      });
      await w.waitForSelector('.review-item');
    }],
    ['analytics', async (w) => { await w.evaluate(() => go('dashboard')); await w.waitForSelector('h1:has-text("Progress")'); }],
    ['revisit list', async (w) => { await w.evaluate(() => go('revisit')); await w.waitForSelector('h1:has-text("Revisit")'); }],
    ['settings', async (w) => { await w.evaluate(() => go('settings')); await w.waitForSelector('h1:has-text("Settings")'); }],
  ];

  for (const [name, open] of screens) {
    test(`${name}: no placeholder text, no overflow, timers formatted`, async () => {
      await open(win);
      await win.waitForTimeout(250);

      const body = await win.evaluate(() => document.body.innerText);
      expect(scanText(body), `${name} placeholder/NaN text`).toEqual([]);

      // no horizontal overflow at laptop width
      const overflow = await win.evaluate(() => {
        const d = document.documentElement;
        return { scroll: d.scrollWidth, client: d.clientWidth };
      });
      expect(overflow.scroll, `${name} horizontal overflow`).toBeLessThanOrEqual(overflow.client + 1);

      // every clock-like string is mm:ss
      const clocks = await win.evaluate(() =>
        [...document.querySelectorAll('.timer, .count, .mono')]
          .map(n => n.textContent.trim())
          .filter(t => /\d+:\d+/.test(t)));
      for (const c of clocks) {
        expect(c, `${name} clock format "${c}"`).toMatch(/^\d{2,3}:\d{2}$/);
      }

      // nothing renders outside the viewport horizontally
      const strays = await win.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return [...document.querySelectorAll('button, .card, .stat, table')]
          .filter(n => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && (r.left < -2 || r.right > vw + 2);
          })
          .map(n => (n.className || n.tagName) + ':' + Math.round(n.getBoundingClientRect().right));
      });
      expect(strays, `${name} elements outside viewport`).toEqual([]);
    });
  }

  test('exam screen: question image fits, is not squashed, at two window sizes', async () => {
    const id = await startExam(win, { mode: 'paper', year: '2021', paper: 2 });

    for (const [w, h] of [[1280, 800], [1024, 660]]) {
      await win.setViewportSize({ width: w, height: h });
      await win.waitForTimeout(350);

      const img = await win.locator('img.qimage').first().evaluate(el => {
        const r = el.getBoundingClientRect();
        return {
          natW: el.naturalWidth, natH: el.naturalHeight,
          w: r.width, h: r.height, left: r.left, right: r.right,
          vw: document.documentElement.clientWidth,
        };
      });
      expect(img.natW, 'image decoded').toBeGreaterThan(0);
      // fits horizontally
      expect(img.right).toBeLessThanOrEqual(img.vw + 1);
      expect(img.left).toBeGreaterThanOrEqual(-1);
      // aspect ratio preserved within 1% (not squashed or stretched)
      const natAspect = img.natW / img.natH;
      const renderedAspect = img.w / img.h;
      expect(Math.abs(natAspect - renderedAspect) / natAspect,
        `aspect distortion at ${w}x${h}`).toBeLessThan(0.01);

      // no horizontal page overflow at this size
      const of = await win.evaluate(() => ({
        s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      expect(of.s, `overflow at ${w}x${h}`).toBeLessThanOrEqual(of.c + 1);

      // the answer letters and submit button are reachable on screen
      await expect(win.locator('.options .opt').first()).toBeVisible();
      await expect(win.locator('button:has-text("Submit paper")')).toBeVisible();
    }

    await win.setViewportSize({ width: 1280, height: 800 });
    await win.evaluate(async (attemptId) => {
      await window.api.attempt.abandon(attemptId);
      if (State.exam) State.exam.teardown();
      await go('home');
    }, id);
  });

  test('dark mode inverts crops instead of leaving a blinding white block', async () => {
    await win.evaluate(async () => {
      State.settings = await window.api.settings.set({ darkMode: true });
      applyTheme();
      const r = await window.api.history.list();
      await go('review', { attemptId: r.find(x => x.status === 'completed').id });
    });
    await win.waitForSelector('.review-item');

    const theme = await win.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('dark');

    const filter = await win.locator('img.qimage').first()
      .evaluate(el => getComputedStyle(el).filter);
    expect(filter, 'crops must be inverted in dark mode').toContain('invert');

    // page background is actually dark
    const bg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    expect((r + g + b) / 3, 'dark background luminance').toBeLessThan(90);

    await win.evaluate(async () => {
      State.settings = await window.api.settings.set({ darkMode: false });
      applyTheme();
    });
  });

  test('zero console errors or warnings across every screen', async () => {
    if (consoleIssues.length) console.log('CONSOLE:\n' + consoleIssues.join('\n'));
    expect(consoleIssues).toEqual([]);
  });
});
