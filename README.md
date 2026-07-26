# TMUA Simulator

An offline macOS desktop app for practising the **Test of Mathematics for University Admission**,
built around every official past paper from **2016–2023** plus the specimen papers —
360 questions, official answer keys, official worked solutions, and official score conversion tables.

- Two papers per year, 20 multiple-choice questions each, no calculator.
- Default timer is **93:00 per paper** (75 minutes + 25% extra time), fully configurable.
- Everything runs locally. **The app makes no network requests, ever** — this is enforced in code and tested.
- All history lives in one SQLite file on your machine, backed up on every launch.

---

## Running it

### The built app (normal use)

```bash
npm run dist
```

That produces `dist/mac-arm64/TMUA Simulator.app`. Drag it to `/Applications` and double-click it.
No terminal, no server, no internet connection required.

### Development mode

```bash
npm start
```

Same app, launched from source with the repo's `assets/` and `data/` folders instead of the bundled copies.

---

## What it does

**Exam modes**

| Mode | Behaviour |
| --- | --- |
| Single paper | Any year, Paper 1 or Paper 2, on the clock |
| Full mock | Paper 1 → 15:00 break (skippable) → Paper 2, with two separate timers |
| Untimed practice | Any paper, no clock, no auto-submit |
| Custom drill | Built from filters: wrong answers, flagged, revisit list, topic, year, paper |

**During the exam** — one question at a time; a navigator grid showing answered/flagged questions;
flag for review; per-question scratch notepad; confidence marking (sure/unsure);
countdown with a hide toggle and warnings at 15, 5 and 1 minutes; **hard auto-submit at 0:00**.

Keyboard: <kbd>A</kbd>–<kbd>H</kbd> select an answer, <kbd>←</kbd> <kbd>→</kbd> move between questions, <kbd>F</kbd> flag.

**After the exam** — raw score, percentage, estimated 1.0–9.0 score from the official conversion table
for that year, per-topic breakdown, and per-question timings. Review every question against the
official worked solution, and mark anything for a persistent revisit list.

**Progress dashboard** — score trend, Paper 1 vs Paper 2 comparison, papers not yet attempted,
a filterable wrong-answer log, per-topic accuracy with concrete revision advice and a one-click
"drill this topic" button, pacing analysis (including a warning when accuracy falls off in the last
five questions), confidence analysis ("sure but wrong" vs "unsure but right"), and a weekly study streak.

---

## Your data

Everything is stored in a single SQLite database in Electron's `userData` folder:

```
~/Library/Application Support/TMUA Simulator/data/tmua.sqlite
```

The exact path is shown in **Settings**, with a button to reveal it in Finder.

- **WAL mode + write-through.** Every answer, flag, note and timer tick is committed immediately.
- **Crash resume.** If the app or the machine dies mid-exam, reopening restores the exact question
  and the correct remaining time. Time is only ever handed *back* (at most one 1-second heartbeat),
  never taken away.
- **Automatic backups.** A timestamped copy is taken on every launch; the last 20 are kept, in
  `data/backups/`.
- **Export / import.** Settings → *Export history (JSON)* writes your complete history to a file;
  *Import history* restores it. Import replaces current history, so export first if unsure.
- **Migrations preserve history.** Schema changes are additive and versioned in the `meta` table;
  user rows are never dropped or recreated.

To back up manually, copy the whole `data/` folder while the app is closed.

---

## Fixing a bad question crop

Question images are cropped from the original PDFs by a Python pipeline. Crop boundaries live in
data files, so a bad crop is a data edit — not a code change.

1. **See the problem.** Open `qa/gallery.html` in a browser: all 360 crops and their worked
   solutions in a grid, each with its option count, answer and pixel size. Click **mark bad** on
   anything that looks wrong, then **Download fix list JSON** to get the ids.
2. **Find the id**, e.g. `2019-P1-Q07`. Its current boundaries are in `data/crop-manifest.json`.
3. **Override it** in `data/crop-overrides.json` (create the entry if absent). Coordinates are PDF
   points, measured from the top of the page:

   ```json
   {
     "2019-P1-Q07": {
       "segments": [{ "page": 8, "y0": 90, "y1": 520 }]
     }
   }
   ```

   A question that spans two pages simply lists two segments; they are stacked vertically into one image.
4. **Re-run the cropper**, then rebuild the QA page and check:

   ```bash
   pipeline/.venv/bin/python pipeline/crop.py
   npm run qa:ocr && npm run qa:pages
   ```

If a question's *option count* is wrong (this happens when the options are diagrams rather than text
rows), set it explicitly in `data/option-overrides.json` and re-run `crop.py`.

---

## Verification

```bash
npm test
```

Runs the content integrity check and then the full Playwright/Electron suite — **85 tests**.
See [TEST-REPORT.md](TEST-REPORT.md) for the full QA pass, the bugs it found, and the two
human-review pages (`qa/gallery.html`, `qa/spotcheck.html`).

Regenerate the QA artefacts with `npm run qa:ocr`, `npm run qa:keys`, `npm run qa:pages`.

`verify-content.js` checks that every paper has exactly 20 questions and that every question has a
crop, an answer that agrees with the answer key, at least one topic tag, a worked solution, and a
plausible option count; it also checks that every conversion table is complete and monotonic.

The Playwright suite drives the real packaged Electron app and covers:

- keyboard shortcuts, flagging, the navigator, and instant autosave
- **timer expiry → hard auto-submit → scoring checked question-by-question against the official key**,
  including the scaled score from the official conversion table
- wrong answers reaching the log, and analytics updating
- **crash resume after `kill -9`, after Cmd+Q, and after closing the window** — same question, same remaining time
- an interrupted attempt never being silently scored
- **zero outbound network requests during a full mock**, plus an assertion that any attempted request is refused
- WAL mode, launch backups and their rotation, JSON export/import round-trip, and migration safety
- **building the `.app`, copying it somewhere clean, and launching it with no existing data** — it must work first try

---

## How the content was produced

`assets/papers/` holds the original PDFs. The maths is never transcribed — transcription errors would
poison the whole simulator. Instead:

1. `pipeline/detect.py` finds question boundaries from the PDF text layer. The papers span five
   different typesetting eras, including two with broken font encodings where digits are stored as
   private-use glyphs, so it decodes those before matching.
2. `pipeline/crop.py` renders pages through **macOS Quartz** (the same engine as Preview) rather than
   the default rasteriser, because several papers contain embedded font subsets that the default
   renderer drops silently — which would have produced questions with missing symbols. It crops each
   question, whitens page furniture, and stitches multi-page questions together.
3. `pipeline/keys.py` and `pipeline/conversions.py` parse the answer keys and conversion tables
   coordinate-wise and cross-check them against a second copy of the same tables.
4. `pipeline/solutions.py` crops the official worked solution for each question and verifies every
   "the answer is X" statement it can find against the parsed answer key.
5. `pipeline/topics.py` attaches topic tags from the fixed TMUA-spec taxonomy and writes
   `data/questions.json`, the file the app actually reads.

All 360 answer-key entries were additionally verified by eye against the rendered key tables.

---

## Layout

```
assets/papers/      original PDFs (papers, mark schemes, answer keys, conversion tables)
assets/questions/   360 question crops
assets/solutions/   360 worked-solution crops
data/               questions.json, answers.json, conversions.json, crop manifests + overrides
pipeline/           Python PDF→content pipeline, plus qa.html
src/                Electron main process, preload, SQLite layer, analytics
public/             the single-page frontend
scripts/            content verification
tests/              Playwright + Electron end-to-end suite
```

Sources: the 2016–2023 papers are the Cambridge-era TMUA materials, mirrored at
jzmaths.com and vantageadmissions.co.uk. The current official site only hosts 2024+ papers.
