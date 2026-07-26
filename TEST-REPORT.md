# TMUA Simulator — QA & Test Report

**Final result: everything is green.**

```bash
npm test
```

runs the content integrity check followed by the full Playwright/Electron suite:
**85 tests, 85 passed, 0 failed, 0 skipped** (about 1m 50s, including building the `.app`
from scratch and launching it from a clean directory).

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
| **Total** | **85** | |

Supporting QA tooling: `pipeline/ocr_crops.py` (independent image + OCR analysis),
`pipeline/reparse_keys.py` (independent key parser), `pipeline/qa_pages.py` (review pages),
`scripts/verify-content.js` (fast pre-flight integrity check).
