# TMUA Simulator — QA & Test Report

**Final result: everything is green.**

```bash
npm test
```

runs the content integrity check followed by the full Playwright/Electron suite:
**185 tests, 185 passed, 0 failed, 0 skipped** (about 2m 50s, including building the `.app`
from scratch and launching it from a clean directory).

Three passes so far: the exam engine and content (85 tests), the Study Coach and refinements
(120), and an adversarial pass over everything built on the history data (168). See
[QA pass 2](#qa-pass-2--study-coach-predictor-and-refinements) at the end for the most recent
work and the six defects it found.

Nothing was left un-green. Two things need your own eyes rather than an assertion, and both
have a page built for them — see [What needs your eyes](#what-needs-your-eyes).

---

## Bugs found and fixed

Five real product bugs were found by this pass. All are fixed and each now has a regression test.

### 1. The timer could hand back exam time (serious)

The countdown accumulated `setInterval` deltas. When a renderer is throttled — a backgrounded
window, or a laptop that sleeps mid-exam — the interval stops firing, so elapsed time stopped
advancing and you would wake up with time you had actually used. On a timed exam that is a
correctness bug, not a cosmetic one.

Elapsed is now derived from wall-clock timestamps (`baseElapsed + (Date.now() - sessionStart)`),
so suspending the window changes nothing about how much time you have left.

*Test:* `timer.spec.js` → "elapsed is wall-clock derived…" jumps the system clock forward two
minutes **without running any timers** and asserts two minutes were consumed. The old
implementation would have consumed zero.

### 2. Settings accepted nonsense values

`baseMinutes: 0`, negatives, `99999`, `"sixty"`, `NaN`, a string for a boolean, and entirely
unknown keys were all written to the database. A zero or negative timer produces an unusable exam.

Settings are now validated and **rejected** with a message (base 1–300 min, extra time 0–200%,
break 0–120 min, booleans must be booleans, unknown keys refused) rather than silently clamped.

*Test:* `edge-cases.spec.js` → "invalid timer settings are rejected, not silently clamped"
tries ten bad payloads and confirms stored settings are untouched.

### 3. Starting a new exam gave no warning about one in progress

The in-progress attempt was never actually destroyed — it stayed resumable — but nothing said so,
so it looked like you had just thrown away a half-finished paper.

Starting a paper or mock while attempts are open now confirms first, and says explicitly that the
existing attempts are kept and where to resume them.

*Test:* `edge-cases.spec.js` → "starting a new exam warns and never destroys the in-progress one"
captures the dialog text and then verifies the original attempt still holds its answers.

### 4. The wrong-answer log had no filters

The spec called for a log filterable by topic, paper and year; it rendered as a flat table.
It now has all three filters, combinable, with a live "N of M shown" count.

*Test:* `analytics-seeded.spec.js` → "the wrong-answer log filters by topic, paper and year"
checks each filter and a combined one against hand-computed row counts.

### 5. Two app instances could share one database

Nothing stopped a second launch from opening the same SQLite file, which could interleave writes
during an exam. The app now takes a single-instance lock per data directory: a second launch
focuses the running window and exits.

*Test:* `edge-cases.spec.js` → "a second launch on the same data directory does not open a rival
window", which also confirms the first instance's in-progress exam is unharmed.

### Bugs in the QA tooling itself (worth recording, no product impact)

- **OCR read 6 as 9 and vice versa.** Cropping to just the question-number corner left Vision with
  no orientation context. 14 questions were falsely flagged as mis-numbered. Verified by eye that
  the crops were correct, then fixed the analyser to read the number from the full-image pass.
- **The answer-key spot-check compared the wrong row.** On side-by-side key layouts it took the
  first row matching a question number, which is Paper 1's — so all nine Paper 2 samples looked
  like mismatches. Candidate rows are now ordered by (page, x, y), which picks the right paper
  for all three key layouts (side-by-side, stacked, interleaved).
- **`clock.runFor` with multi-hour deltas stalled** the suite by firing the 250 ms tick tens of
  thousands of times; replaced with a time jump plus a short run.

---

## 1. Content completeness audit — PASS

`tests/audit-content.spec.js` (13 tests), logic in `tests/lib/audit.js`.

| Check | Result |
| --- | --- |
| 16 core papers, 2016–2023 × P1/P2 | **16/16**, none missing |
| Extra papers | specimen P1 + P2, intentional bonus (flagged as extra, not an error) |
| 20 questions per paper, numbered 1–20 | **all 18 papers**, no gaps, no duplicates |
| Core questions | **320/320** (360 shipped including specimen) |
| Crop exists, non-zero, decodes | **360/360** — PNG signature, per-chunk CRC32, IHDR read |
| Crop resolution | min 900px wide / 300px tall enforced; median height 944px |
| Blank / near-blank crops | none (ink ratio measured on every crop) |
| Crop height outliers | none (>3× or <0.28× median would flag a double or truncated crop) |
| Question number in crop matches its label | **360/360** via OCR |
| Answer-key entry present and A–H | **360/360** |
| Answer within the options actually present | **360/360**; OCR never sees a letter beyond the recorded count |
| Topic tags from the fixed taxonomy | **360/360**; whitespace, casing, duplicates and off-taxonomy tags all checked |
| Worked solution linked and decodable | **360/360** — no gaps |
| Conversion tables | 8 years × (P1 21 rows, P2 21 rows, overall 41 rows), all 1.0–9.0, all monotonic |
| Orphans | none — no stray images, answers, option counts or tags |
| Unused taxonomy entries | none |

All 16 taxonomy topics are used. Tag typos of the `"algebra "` vs `"algebra"` kind are caught by
explicit whitespace and lower-case assertions, not just membership.

## 2. Answer-key integrity — PASS

- **Independent re-parse.** `pipeline/reparse_keys.py` shares no code with the build-time parser
  and uses a different technique: the build parser pairs words by coordinates and clusters columns;
  the QA parser consumes the raw reading-order token stream looking for `number → letter` pairs and
  splits papers when the sequence restarts at 1, with a separate path for the row-interleaved
  layouts. **All 360 answers agree.** A disagreement is treated as a stop-the-world failure.
- **Uniformity.** Every paper has between 6 and 8 distinct answer letters across its 20 questions;
  the all-one-letter signature of a parse failure would be caught (the test requires ≥4).
- **Spot check.** 20 questions sampled across every paper, each showing the row cropped straight
  out of the official mark-scheme PDF beside the stored answer. **All 20 agree.**

## 3. Crop and formatting quality — PASS

Automated image checks are listed in §1. In-app rendering and UI checks
(`tests/ui-formatting.spec.js`, 11 tests):

| Check | Result |
| --- | --- |
| Every screen free of `TODO` / `lorem` / `undefined` / `NaN` / `null` / `[object Object]` | pass (8 screens) |
| No horizontal overflow | pass |
| No element rendered outside the viewport | pass |
| Every clock string is `mm:ss` | pass |
| Question image fits at 1280×800 **and** 1024×660 | pass |
| Image aspect ratio preserved within 1% (not squashed) | pass |
| Answer letters and Submit reachable at both sizes | pass |
| Dark mode inverts crops instead of showing a white block | pass (computed `filter` contains `invert`, body luminance < 90) |
| **Zero console errors or warnings across every screen** | pass — none at all |

## 4. Exam engine — PASS

`tests/timer.spec.js` (9) and `tests/exam.spec.js` (8).

- Default **93:00** = 75 min + 25% extra time (whole minutes, so 93:00 not 93:45).
- Settings respected: 75+0%→75:00, 60+25%→75:00, 50+20%→60:00, 75+50%→112:00.
- Warnings fire at exactly 15:00, 5:00 and 1:00, **each once**.
- Hard auto-submit at 0:00; the exam controller is torn down and no later write can reach it.
- Both a mocked clock (fast) and a **real-time smoke test** of the final seconds.
- Wall-clock timing verified against a simulated suspend (see bug 1).
- Full mock: Paper 1 → break with its own 15:00 countdown → skippable → Paper 2 on a **fresh full
  clock**, not Paper 1's remainder; the break also auto-advances at 0:00.
- Navigator states, jump-to-question, answer changes, flag persistence.
- Keyboard: A–H, ←/→, F; harmless on results and break screens.
- Per-question times sum to elapsed exam time within 1.5s.
- Modes: single paper, untimed (no clock, never auto-submits — verified across a simulated four
  hours), and custom drill whose filters are checked against the question bank directly.

## 5. Scoring and results — PASS

`tests/scoring.spec.js` (7). Expected values are computed inside the tests, never via app code.

- All correct → **20/20**; all wrong → **0/20**; both scaled scores match the official table.
- A fixed mixed pattern → exact raw score **and an exact per-topic breakdown**, compared row by row
  against the independently computed map.
- Unanswered at timeout stay `null` — never a fabricated guess — are marked incorrect, and are
  counted on the results screen.
- Scaled score checked at raw 0, 1, 10, 19 and 20 against `conversions.json`, including what the
  screen actually displays.
- Specimen papers have no official table: shows "—" and "no official table", no crash, no fake number.
- Review shows your answer, the correct answer, the worked-solution image (asserted to actually
  decode), and time spent.

## 6. Persistence and crash safety — PASS

`tests/crash.spec.js` (4) and `tests/data-safety.spec.js` (7).

- Resume after **`kill -9`**, after **Cmd+Q**, and after **closing the window** — same question,
  same answers, same flags, correct remaining time.
- **An answer survives a `kill -9` fired immediately after it**, with no heartbeat and no flush —
  proving write-through, not just eventual persistence.
- Remaining time on resume can only ever round **in your favour** (at most one 1-second heartbeat
  is handed back); it can never take time away.
- An interrupted attempt is never silently scored — it stays `in_progress` with a null score.
- Three completed attempts survive a restart: full export and full analytics compared and **deep-equal**.
- WAL mode confirmed in effect; backups written on every launch and pruned to 20.
- **A launch backup genuinely restores**: the live database is deliberately corrupted, the backup
  copied over it, and the history comes back intact.
- Export → fresh profile → import is lossless, including notepads, flags and confidence marks.
- Concurrency: single-instance lock, second launch focuses the first and exits (bug 5).

## 7. Analytics — PASS

`tests/analytics-seeded.spec.js` (10). A fabricated 5-attempt history is seeded where every
`logic & truth` question and every question in positions 16–20 is wrong, with one blank per paper.
Expected figures are computed by hand from the same rules.

- Wrong-answer log contains **exactly** the seeded wrong answers, no correct ones leaking in.
- Every topic's seen/correct/accuracy matches the hand-computed value exactly;
  `logic & truth` ranks first at **0%**, with revision and drill advice attached.
- Pacing buckets match exactly; Q16–20 accuracy is 0% and the late-paper pattern **is** reported.
- Score trend, Paper 1 vs Paper 2 totals, and papers-not-attempted all match the seed.
- "Drill this topic" returns exactly the set of that topic's questions and nothing else.
- Edge states: zero history, and a single all-correct attempt — no division by zero, no `NaN`,
  no `Infinity`, sensible empty-state messages.

## 8. Edge cases and abuse — PASS

`tests/edge-cases.spec.js` (11) plus `tests/offline.spec.js` (3) and `tests/packaged.spec.js` (2).

- Submit with zero answers → 0/20, no crash.
- Double submit (fired concurrently) → one attempt, one scoring; a third direct call is idempotent.
- A burst of answers racing the exact auto-submit moment → marks always agree with stored answers.
- Leaving the break screen keeps Paper 1 recorded and Paper 2 outstanding.
- Redo a paper: previous attempt untouched, new attempt separate and blank, and the live attempt
  **never carries answer keys in its payload** — asserted, so a second attempt cannot leak them.
- Revisit list: add from review → appears → one-click redo builds a drill of exactly that question
  → unmark removes it.
- **Offline:** a complete mock plus dashboard and review browsing produced **zero outbound
  requests** at the Chromium level and zero blocked ones (nothing was even attempted); a deliberate
  `fetch` and a remote `<img>` are both refused; no bundled source references any remote origin.
- **Fresh app:** `.app` built, copied to a clean directory, launched with an **empty** data folder —
  initialises, loads all 360 questions, defaults to 93:00, renders images from inside the bundle,
  scores a full paper 20/20, and keeps the history when reopened. No dev tooling, tests or pipeline
  code ships inside the bundle.

---

## What needs your eyes

Two pages are generated for human review. Both are local files; open them directly.

1. **`qa/gallery.html`** — all 360 question crops and their worked solutions in a grid, labelled
   `year-paper-Qn` with option count, answer, pixel size and ink ratio. Each card has a
   **mark bad** button; marks persist in the browser and **Download fix list JSON** exports them.
   To fix a crop: put its id in `data/crop-overrides.json` with corrected `y0`/`y1` and re-run
   `pipeline/crop.py` (full instructions in the README).

2. **`qa/spotcheck.html`** — 20 sampled questions with the mark-scheme row cropped straight from
   the official PDF beside the stored answer. Automated diffing already passed on all 360; this is
   for your own confidence in the source of truth.

Regenerate either with `npm run qa:pages` (and `npm run qa:ocr` after re-cropping).

---

## Known limitations

- **Specimen papers have no official score conversion table.** None was ever published. Those
  papers show "—" for the estimated score rather than inventing one. All 8 real years (2016–2023)
  have complete tables.
- **The app ships 18 papers, not 16.** The two specimen papers are included as a deliberate bonus.
  The audit reports them as "extra (intentional bonus)" so the 16-paper requirement is still
  checked strictly.
- **OCR under-detects option letters.** Vision frequently merges an option letter into the maths
  beside it. This is used *only* as a lower bound — seeing a letter proves it exists — so it can
  contradict a too-small option count but cannot produce false failures. Option counts themselves
  come from the PDF text layer and are separately cross-checked against every answer.
- **The `.app` is unsigned.** There is no Apple Developer ID involved. A locally built app has no
  quarantine attribute so it double-clicks open normally; if you ever move it between machines by
  download or AirDrop, macOS will quarantine it and you will need right-click → Open once.
- **Per-question timing granularity is 1 second** (the heartbeat interval), and a crash can hand
  back up to one second of exam time. This always rounds in the candidate's favour.
- **Tests run serially** (`--workers=1`) because several drive real Electron processes and
  kill them; parallel workers would fight over ports and processes.

---

## Test inventory

| File | Tests | Covers |
| --- | ---: | --- |
| `tests/audit-content.spec.js` | 13 | §1 completeness, §2 key diff, §3 image checks |
| `tests/timer.spec.js` | 9 | §4 timing, warnings, auto-submit, break |
| `tests/exam.spec.js` | 8 | §4 navigation, shortcuts, modes, mock |
| `tests/scoring.spec.js` | 7 | §5 exact scoring, conversions, review |
| `tests/analytics-seeded.spec.js` | 10 | §7 seeded analytics and edge states |
| `tests/edge-cases.spec.js` | 11 | §8 abuse, redo, revisit, settings, single instance |
| `tests/data-safety.spec.js` | 7 | §6 WAL, backups, restore, export/import, durability |
| `tests/crash.spec.js` | 4 | §6 kill -9 / Cmd+Q / window close resume |
| `tests/ui-formatting.spec.js` | 11 | §3 formatting sweep, console errors, dark mode |
| `tests/offline.spec.js` | 3 | §8 zero network |
| `tests/packaged.spec.js` | 2 | §8 fresh packaged app |
| `tests/coach.spec.js` | 15 | Study Coach: countdown, predictor, diagnostics, checklist, plan |
| `tests/refinements.spec.js` | 20 | SRS, answer changes, guessing, PDF, offline entry, archive |
| `tests/qa2-coach.spec.js` | 23 | QA2: harness safety, diagnostics, predictor, countdown |
| `tests/qa2-behaviour.spec.js` | 25 | QA2: checklist, plan, SRS, stats, data safety, tone |
| `tests/plan-edit.spec.js` | 6 | Editable study plan: overrides, pinning, reset, persistence |
| `tests/delete.spec.js` | 11 | Deletion: cascade, shared questions, undo, atomicity, orphans |
| **Total** | **185** | |

Supporting QA tooling: `pipeline/ocr_crops.py` (independent image + OCR analysis),
`pipeline/reparse_keys.py` (independent key parser), `pipeline/qa_pages.py` (review pages),
`scripts/verify-content.js` (fast pre-flight integrity check).


---

## Study Coach and refinements

Added after the QA pass above: countdown and status bar, diagnostic engine, grade predictor,
action checklist, study plan, question-level spaced repetition, answer-change tracking, guessing
and confidence strategy stats, printable PDF export, offline attempt entry, archives, and the
2024 format-change notice. 35 further tests, all green.

### Bugs found while building it

**1. The printable PDF contained almost no questions.** The export page was loaded as a
`data:text/html` URL, which has an opaque origin and therefore silently refuses to load the
`file://` question images. The PDF rendered with 2 images instead of 20 — and it failed silently,
producing a plausible-looking file. Fixed by writing the page to a temp file and loading it over
`file://`, plus explicitly awaiting every image decode before printing. The test now inspects the
real PDF with PyMuPDF and asserts the image count, so this cannot regress quietly.

**2. Analytics ignored archives.** `analytics:dashboard`, `history:list` and `drill:build` all read
every attempt, so archiving would not have reset the active dashboard. They now take an archive
scope, with active (non-archived) as the default.

**3. Export/import would have dropped the new tables.** The round-trip predates the review queue,
answer-change log, checklist history and archives. Extended before shipping, so an export taken
today still restores everything — verified by the existing lossless round-trip test.

### What is verified

**Countdown** — day counts across month boundaries, on exam day (`0`, "today"), and after the exam
(negative days reported as "N days ago", never a negative countdown; the plan screen empties
gracefully). Deadline warnings fire inside 21 days and clear when ticked off.

**Grade predictor** — refuses to predict under 3 papers and says so rather than showing a number.
Scaled scores checked against the official tables for **every published year, both papers, at raw
0, 1, 7, 13, 19 and 20**. Papers with no published table (the specimens) are flagged `estimated`,
never invented. Recent papers are weighted above old ones (an improving 4→18 history predicts above
the flat mean). Paper 1 and Paper 2 are predicted separately, and the overall figure comes from the
official *overall* table on the combined raw total rather than an average of two scaled scores.
The gap to 7.0 is stated in raw marks, and the raw needed is cross-checked against the table.

**Diagnostics** — a topic needs 5 attempted questions before it can be called a weakness; thinner
topics report "need N more" and are excluded from ranking. Weakness ranking is by
`(1 − accuracy) × questions per paper`, verified against the question bank's own topic frequency —
so a 50% topic appearing 4× ranks above a 40% topic appearing once.

**Checklist behaviour** — a weak Paper 2 pushes Paper 2; errors concentrated in one topic produce a
study item naming the sub-skill; **all-careless errors produce habit fixes and no topic study**;
two weeks out the phase switches to `Exam simulation`, a full mock replaces single papers, new topic
study stops, and every planned week is a mock week. With ten weeks left, three reserve papers are
held back and never appear in the build weeks. The list is capped at 5 and completing an item
removes it and records it in history.

**Spaced repetition** — schedule asserted at **+3, +7, +21, +45** including across a month boundary
(30 Jan → 2 Feb → 9 Feb → 2 Mar). A wrong answer resets to the start and increments lapses. One
correct review does **not** retire a question; two consecutive do; a lapse in between prevents it.
Sessions are capped at 20 and ordered most-overdue first. Stubborn questions (2+ lapses) are
surfaced and drive a top-priority checklist item. A confidently-wrong answer is recorded as
`sure_wrong` and outranks ordinary wrong answers when equally overdue.

**Answer changes** — a scripted attempt with 3 wrong→right, 2 right→wrong and 1 wrong→wrong asserts
exactly those counts and a net of +1. Setting an answer for the first time is not counted as a
change. The coach refuses to give advice below 15 changes.

**Guessing** — blank counts and the marks-thrown-away figure computed against the bank's own
average random-guess rate. Sure vs unsure accuracy checked against hand-computed values, with the
verdict (`trust` vs `eliminate`) judged against random. The pre-submit warning lists the blank
question numbers (1-based) and says there is no negative marking.

**PDF export** — the real PDF is opened with PyMuPDF: page count, at least one image per question,
cover text present, and **no mark scheme in the questions-only version**. With the mark scheme
opted in, every one of the 20 answers is present in that section.

**Offline entry** — a paper sat on physical paper is recorded, scored (14/20 from a known pattern),
counted in history and analytics, and rejects malformed input.

**Archive** — archiving takes a backup first, moves attempts out of the active scope, empties the
active dashboard and the coach prediction, keeps the archived run fully readable via an archive
scope, and restores byte-identically (export and dashboard both deep-equal the pre-archive
snapshot). An archive with no name is rejected.

**Offline** — the coach, plan, dashboard, offline-entry and about screens together produce zero
outbound requests and zero blocked ones.

### Known limitations of the coach

- **The predictor is a projection, not a promise.** It rests on your own past papers under your own
  conditions, and it says so: sample size and confidence are shown on the Coach screen, and it
  refuses outright below three papers.
- **Scaled scores for the specimen papers are estimated** from the mean of the eight published
  tables, and labelled as such wherever they appear.
- **Error-type analysis needs you to tag.** The app suggests a tag from timing signals, but until
  around five wrong answers are tagged the coach will not claim a dominant error type.
- **The trajectory fit is linear** over your completed papers. With few papers, or a flat run, it
  reports a small slope rather than pretending to detect a trend.


---

## QA pass 2 — Study Coach, predictor and refinements

An adversarial pass over everything computed from history data, on the principle that **wrong
numbers are worse than no numbers**. Every figure is checked against an expectation hand-computed
inside the test from the question bank and the official conversion tables — never against the
app's own output. 48 further tests (`qa2-coach.spec.js`, `qa2-behaviour.spec.js`).

### Harness

- **An injectable clock** in the main process (`debug:setClock`). Countdowns, spaced-repetition
  due dates and study phases are all tested at frozen instants rather than relative to "now",
  so none of it is flaky.
- **Seeded histories** with chosen right/wrong per question, per-question times, confidence marks,
  answer changes, error tags and back-dated attempt dates.
- **Scratch-database safety is asserted, not assumed.** A test resolves the live database path
  through the IPC surface, follows symlinks (macOS `/var` → `/private/var`), and asserts it sits
  inside the scratch directory and *not* inside the real profile. A test that wiped real attempt
  history would be catastrophic, so it is checked explicitly.

### Defects found and fixed

**1. The predicted range could reach above any paper actually sat (the inflation failure).**
On a strongly improving run (4→18 raw), the optimistic end of the range reached **9.0 when the best
real paper was 8.3**. That is precisely the failure mode that would hurt: it tells you that you are
already good enough. The range is now capped at your best-ever paper **+0.5**, and the headline
figure is capped at the same ceiling. Six differently-shaped histories (rising, falling, flat,
volatile, very weak, very strong) assert the prediction never exceeds demonstrated performance.

**2. The trajectory was fitted on a different scale from the prediction.** Each paper's scaled
score came from its own year's conversion table, while the prediction used the most recent table as
the exam-day reference. A perfectly flat history therefore appeared to be moving — the projection
sat 1.1 grades away from the prediction. Both now use the reference table, and a flat history is
asserted to project flat (slope < 0.05/week).

**3. A perfectly consistent history produced a zero-width range.** With identical results the
standard deviation is zero, so the app reported a single point as though it were certain. A minimum
half-width of 0.3 now applies, and the range is asserted to widen with volatility.

**4. "Missed twice" did not count as repeatedly missed.** The checklist keyed off *lapses*, which
only increments from the second miss onwards, so a question wrong in two separate attempts needed a
third miss to surface. It now keys off total misses ≥ 2, which is what "missed more than once"
means. Asserted by sitting the same paper twice with the same questions wrong.

**5. A brand-new user was told to keep their papers balanced.** On a fresh install the first
checklist item read "Sit 2016 Paper 1 under timed conditions — you have done 0 Paper 1s and
0 Paper 2s, keep them balanced", which is nonsense before you have sat anything. First run now
produces "Sit your first paper", explaining that the coach needs one real paper first.

**6. Four wording defects, found by reading the generated advice rather than asserting on it.**
"1 Paper 2s" (bad pluralisation); "you have left 0 question(s) blank at timeout" (a vacuous clause
that undercut the point); "0 held back as clean mocks" (noise); and "worth about 3.06 marks a
paper" (false precision). All fixed. Twenty generated items are now printed into the test output
for human review — see [Advice samples](#advice-samples).

### What is verified

**§1 Diagnostics.** Topic accuracy and counts asserted exactly against a per-question expectation
built from the bank. Topics below five attempted questions are labelled "need N more", excluded
from the ranking, and sorted below every topic that has enough data — never ranked at 0%.

*The decisive ranking case*: the most frequent topic answered at **50%** versus the rarest answered
at **40%**, across all 16 core papers. The 50% topic must rank first, because it loses more marks
per paper. Asserted both on the ordering and on the arithmetic
(`(1 − accuracy) × questions per paper`, recomputed in the test).

Error-type suggestions follow the timing signals (very fast + wrong → careless; very slow + wrong →
conceptual; unanswered at timeout → time), and a manual tag always overrides and persists. Pacing
figures (average time, Q1–10 vs Q11–20 accuracy, overruns) match hand-computed values. Trend
detection is asserted to use **attempt date order, not insertion order**, by deliberately inserting
a history newest-first and checking it is still classified as improving; the reverse history is
classified as regressing.

**§2 Predictor.** Conversion checked for every published year, both papers, at raw 0, 1, 7, 13, 19
and 20. Years without a table produce a fitted estimate flagged `estimated`. Recency weighting is
tested in **both** directions — an improving run predicts above the lifetime mean, a declining run
below it — so a predictor that ignored recency could not pass. Range width, refusal under three
papers (with the UI asserted to show no digits at all), the Paper 1/Paper 2 split, and the
gap-to-7.0 arithmetic are all checked against the official tables. The gap breakdown can never
claim more marks in a topic than that topic actually contains per paper.

**§3 Countdown.** Frozen-clock assertions on exam day, the day before, the day after, across a
month boundary and across a year boundary. **The BST→GMT change** (clocks go back 25 October 2026)
is tested either side and on the day itself — 8, 7 and 6 days to 1 November, with no off-by-one.
The **6pm deadline cutoff** is tested at 17:59 (not passed) and 18:01 (passed) on the deadline day.
Warnings appear inside 21 days, clear when ticked off, and a custom exam date overrides the
12 October default in the countdown, the status bar and the plan.

**§4 Checklist.** Each scenario asserts the *specific* item generated: strong P1/weak P2 names an
unsat Paper 2; one weak topic produces a study item naming the sub-skill; **all-careless errors
produce habit fixes and no topic study at all** (the key negative test); all-time errors produce
triage items; a question missed in two attempts becomes the top item; a fresh install says "sit your
first paper". Phases switch correctly at ten weeks and two weeks, with no new-topic study inside
the final fortnight. Reserve papers are held back and never suggested. Consuming papers too fast
raises a pace warning. The list is capped at five, and firing an item records it in history and
removes it.

**§5 Study plan.** Spans today to exam day, schedules every unseen paper exactly once, never
schedules a paper already sat, and places the reserve in the final fortnight. The weakest topic
leads week 1 **and is revisited later** for spacing. Falling six weeks behind with 17 papers unseen
still produces a bounded plan rather than an impossible backlog.

**§6 Spaced repetition.** Intervals asserted at +3/+7/+21/+45 across a month boundary; a wrong
review resets from **any** stage including the deepest; retirement needs two consecutive successes;
flagged and revisit questions sit below genuine wrong answers, and confidently-wrong sits above
them (`sure_wrong → wrong → revisit → flag`); a 60-day absence produces a 60-item backlog that
still respects the 20-question cap and orders most-overdue first without breaking the UI.

**§7 Changes and guessing.** A scripted 5 helped / 7 hurt / 2 neutral attempt asserts exactly those
counts and **net −2**. Below 15 changes the coach stays silent. Above it, the verdict is asserted
in **both** directions — a mostly-hurting history says "first instinct", a mostly-helping history
says "changing helps" and produces no advice to stop changing. Hard-coded advice would fail this.
Unsure-answer interpretation likewise flips between "trust" (90% accuracy) and "eliminate" (20%,
about random). Auto-submit at timeout still records and reports the blanks.

**§9 Data safety.** Every `DELETE`/`DROP`/`TRUNCATE` in the source is enumerated by a test and
matched against a list of accounted-for statements, so a new destructive statement cannot be added
silently. There are no `DROP` or `TRUNCATE` statements at all. The fourteen `DELETE` statements are:
un-marking a revisit, removing a retired queue entry, the two for an explicit attempt delete,
removing an archive row on restore, resetting one study-plan week, and the eight that clear tables
before an import replaces history. (This audit earned its keep immediately: adding the editable
study plan introduced two new `DELETE` statements and the test failed until they were justified.) Archiving is asserted to leave the export byte-identical after restore, to remove archived
runs from the active predictor, and coach data (review queue, archives, checklist history) is
asserted to survive a `kill -9`.

**§10 Formatting, offline and tone.** The new screens are swept at 1360×900 and 1024×700 for
overflow, `NaN`/`undefined`/`null`/`Infinity`, unrounded percentages and console errors, plus dark
mode legibility. The whole coach under load (40 queued reviews, eight screens) makes **zero**
network requests. Generated advice is asserted to be specific (titles > 12 chars, reasons > 25)
and free of motivational filler.

### Advice samples

Twenty generated checklist items are printed into the test output for you to read:

```bash
npx playwright test tests/qa2-behaviour.spec.js -g "advice samples"
```

A representative selection:

- *Sit your first paper — 2016 Paper 1* — "The coach needs at least one real paper before it can
  tell you anything useful about your maths. Sit it under timed conditions so the numbers mean
  something."
- *Drill a checking routine — your errors are slips, not gaps* — "100% of your tagged wrong answers
  are careless slips. More topic revision will not fix these."
- *Study Equations & inequalities — worth about 2.4 marks a paper* — "You are 38% on Equations &
  inequalities over 16 questions, and it appears about 3.8 times per paper. That is your biggest
  single leak."
- *Stop leaving blanks — 9 across your papers* — "There is no negative marking. At random-guess
  rate those blanks are about 1.5 marks thrown away."
- *Sit 2016 Paper 2 under timed conditions* — "Paper 2 is your weaker paper (7.6 vs 9 scaled).
  15 papers still unseen, 3 held back as clean mocks for the final fortnight."

### Language

User-facing text is British English throughout. American spellings that remain are API surfaces
that cannot change: Electron's `canceled` property on dialog results, PyMuPDF's `csGRAY`, and CSS
keywords such as `color` and `justify-content: center`.


---

## Editable study plan

The week-by-week plan is now editable: any week's papers, topic focus and a free-text note can be
changed, and the edits persist as the plan recalculates each day.

Overrides live in a new `plan_overrides` table (schema v3, additive) keyed by the week's start
date, so they survive the plan being regenerated. A paper pinned to a week is removed from the
auto-scheduling pool, so it can never be scheduled twice. Anything pinned that no longer fits is
surfaced as "not currently scheduled anywhere" rather than silently dropped. Individual weeks reset
to the suggestion, and there is a reset-all.

Verified (`plan-edit.spec.js`, 6 tests): an edit survives recalculation; a pinned paper appears
exactly once across the whole plan and no paper is ever duplicated; per-week reset restores the
original suggestion and reset-all clears everything; invalid edits are rejected (bad date, unknown
paper, duplicate paper, unknown topic, wrong type); edits survive a restart and travel through
export/import; and the UI path itself edits and saves a week.


---

## Deleting attempts, with cascade

Explicit deletion is now supported, and cascades so nothing derived from a deleted attempt is left
behind. Automatic or accidental loss is still prevented; only deletions requested by name happen.

**What can be deleted:** a single attempt from the history list or its own results screen; a full
mock as one unit or one of its papers alone; several attempts at once via multi-select; and all
history at once from Settings.

**How it cascades.** Deletion is two-stage. A soft delete hides the attempt immediately and is
undoable for 30 seconds; the hard delete then removes the rows. Both stages run in a single
transaction, so a failure rolls back completely.

The interesting part is the review queue. Rather than trying to subtract one attempt's contribution,
the queue is **rebuilt by replaying the scheduler over the surviving attempts in date order**. That
makes the shared-question case correct by construction: a question missed in both a deleted and a
surviving attempt keeps its entry with a schedule derived only from what remains, and disappears
only when nothing justifies it. Revisit marks survive only if a surviving attempt still flags them.
Topic accuracy, weakness ranking, pacing, trends, the predictor, the checklist and the plan all
recompute because they are all derived from the same filtered attempt set.

**Safety.** The confirmation names the attempt and its real counts — computed, not generic:
"Delete 2019 Paper 1 (12/20, sat 3 Aug)? This also removes 8 wrong answers, 6 review-queue items…",
plus a warning when the deletion would drop you below the predictor's minimum, and a reminder that
archiving is the non-destructive alternative. Multi-delete requires typing DELETE; delete-all
requires DELETE ALL. A backup is taken immediately before every deletion. An orphan check runs after
every delete and throws if any row references a missing attempt.

**Verified** (`delete.spec.js`, 11 tests): preview counts are real; the cascade removes exactly the
expected rows with zero orphans, and topic accuracy afterwards matches values computed in the test
from the survivors alone; the shared-question case survives one delete and disappears on the second;
dropping below three papers reverts the predictor to "not enough data" with no stale number left in
the UI; undo restores the attempt and every derived record (export and dashboard both deep-equal the
pre-delete snapshot); a backup exists before each delete; multi-delete refuses without the typed
word; deleting never touches archived runs; a `kill -9` mid-delete leaves the database consistent
and the pending delete recoverable; delete-all clears history while keeping papers and settings; and
the history screen path works end to end with the undo affordance shown.

**One real gap this work exposed:** importing a history that carried no review queue (a hand-built
payload, or an export predating the queue) left the queue silently empty rather than reconstructing
it from the imported attempts. Import now rebuilds it.
