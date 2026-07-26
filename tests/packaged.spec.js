const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchPackaged, freshUserDir, ROOT, answerKey } = require('./helpers');

const APP_SRC = path.join(ROOT, 'dist', 'mac-arm64', 'TMUA Simulator.app');

test.describe('packaged application', () => {
  test.slow();

  test('builds, runs from a clean location with no existing data, and works first try', async () => {
    if (!fs.existsSync(APP_SRC)) {
      execFileSync('npm', ['run', 'dist'], { cwd: ROOT, stdio: 'inherit' });
    }
    expect(fs.existsSync(APP_SRC)).toBe(true);

    // copy the bundle somewhere clean, exactly as dragging it to /Applications
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmua-installed-'));
    execFileSync('cp', ['-R', APP_SRC, cleanDir]);
    const copied = path.join(cleanDir, 'TMUA Simulator.app');
    const exe = path.join(copied, 'Contents', 'MacOS', 'TMUA Simulator');
    expect(fs.existsSync(exe)).toBe(true);

    // bundled content travelled with it
    const resources = path.join(copied, 'Contents', 'Resources', 'content');
    expect(fs.readdirSync(path.join(resources, 'questions')).length).toBe(360);
    expect(fs.readdirSync(path.join(resources, 'solutions')).length).toBe(360);

    // launch with a brand new, empty user-data directory (first-run state)
    const userDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmua-firstrun-')), 'userData');
    const { app, win } = await launchPackaged(exe, userDir);

    // the app initialised its database and loaded all content
    const catalog = await win.evaluate(() => window.api.catalog());
    expect(catalog.counts.questions).toBe(360);
    expect(catalog.papers.length).toBe(18);
    expect(catalog.dbPath).toContain(userDir);
    expect(fs.existsSync(catalog.dbPath)).toBe(true);

    // history starts empty
    const history = await win.evaluate(() => window.api.history.list());
    expect(history).toEqual([]);

    // run a real paper end to end inside the packaged app
    const key = answerKey('2023', 1);
    const id = await win.evaluate(async () => {
      const a = await window.api.attempt.start({ mode: 'paper', year: '2023', paper: 1 });
      await go('exam', { attemptId: a.id });
      return a.id;
    });
    await win.waitForSelector('.exam-bar');

    // default timing is 93:00 — 75 minutes plus 25% extra time
    const allowed = await win.evaluate((attemptId) =>
      window.api.attempt.get(attemptId).then(a => a.allowedSec), id);
    expect(allowed).toBe(93 * 60);
    await expect(win.locator('.timer')).toHaveText(/^9[23]:\d\d$/);

    // question images resolve from inside the bundle
    const dims = await win.locator('img.qimage').first().evaluate(
      img => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(dims.w).toBeGreaterThan(200);

    await win.evaluate(async ({ attemptId, key }) => {
      for (let i = 0; i < key.length; i++) {
        await window.api.attempt.answer({ attemptId, position: i, selected: key[i] });
      }
      await State.exam.finish('submitted');
    }, { attemptId: id, key });

    await win.waitForSelector('h1:has-text("Results")');
    const result = await win.evaluate((attemptId) => window.api.attempt.get(attemptId), id);
    expect(result.scoreRaw).toBe(20);
    expect(result.scoreScaled).toBe(9);

    await app.close();

    // reopening the installed app keeps the history
    const second = await launchPackaged(exe, userDir);
    const after = await second.win.evaluate(() => window.api.history.list());
    expect(after.length).toBe(1);
    expect(after[0].scoreRaw).toBe(20);
    await second.app.close();

    fs.rmSync(cleanDir, { recursive: true, force: true });
  });

  test('no dev tooling or source maps ship inside the bundle', async () => {
    if (!fs.existsSync(APP_SRC)) test.skip();
    const asar = path.join(APP_SRC, 'Contents', 'Resources', 'app.asar');
    expect(fs.existsSync(asar)).toBe(true);
    const listing = execFileSync('npx',
      ['asar', 'list', asar], { cwd: ROOT, encoding: 'utf8' });
    expect(listing).toContain('/src/main.js');
    expect(listing).toContain('/public/app.js');
    expect(listing).not.toContain('/tests/');
    expect(listing).not.toContain('/pipeline/');
    expect(listing).not.toContain('node_modules/playwright');
  });
});
