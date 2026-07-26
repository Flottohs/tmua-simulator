// Study Coach: diagnostics, grade prediction, action checklist and study plan.
// Everything is derived from stored attempt history — no network, no guessing
// beyond what the data supports.
const content = require('./content');
const { ADVICE } = require('./analytics');

const MIN_TOPIC_SAMPLE = 5;      // below this a topic is "insufficient data"
const MIN_PAPERS_TO_PREDICT = 3; // below this the predictor refuses
const EWMA_WINDOW = 6;           // papers considered, most recent weighted highest
const EWMA_LAMBDA = 0.72;
const RESERVE_PAPERS = 3;        // unseen papers held back for the final fortnight
const CHANGE_SAMPLE_MIN = 15;    // answer-change advice needs this many changes
// Even a perfectly consistent run carries real uncertainty on the day, so the
// reported range never collapses to a single point.
const MIN_RANGE_HALFWIDTH = 0.3;
// How far above your best-ever paper the optimistic end of the range may reach.
const BEST_EVER_MARGIN = 0.5;

const DEFAULTS = {
  targetScore: 7.0,
  examDate: '2026-10-12',
  examWindowEnd: '2026-10-16',
  accessDeadline: '2026-09-14T18:00:00+01:00',
  bookingDeadline: '2026-09-28T18:00:00+01:00',
  resultsDate: '2026-11-16',
  accessArranged: false,
  examBooked: false,
};

// ---------------------------------------------------------------- countdown

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysBetween(fromMs, toMs) {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / 86400000);
}

function countdown(settings, now = Date.now()) {
  const s = { ...DEFAULTS, ...settings };
  const examMs = new Date(`${s.examDate}T09:00:00`).getTime();
  const days = daysBetween(now, examMs);
  const deadlines = [
    {
      key: 'access', label: 'Access arrangements (25% extra time)',
      at: new Date(s.accessDeadline).getTime(), done: Boolean(s.accessArranged),
    },
    {
      key: 'booking', label: 'Book your test at a Pearson centre',
      at: new Date(s.bookingDeadline).getTime(), done: Boolean(s.examBooked),
    },
  ].map(d => ({
    ...d,
    days: daysBetween(now, d.at),
    passed: now > d.at,
    // warn inside three weeks while still outstanding
    warn: !d.done && daysBetween(now, d.at) <= 21,
  }));

  return {
    examDate: s.examDate,
    days,                                     // negative once the exam has passed
    weeks: days > 0 ? Math.floor(days / 7) : 0,
    daysLabel: days > 0 ? `${days} days` : days === 0 ? 'today' : `${Math.abs(days)} days ago`,
    isExamDay: days === 0,
    isPast: days < 0,
    resultsDate: s.resultsDate,
    resultsDays: daysBetween(now, new Date(`${s.resultsDate}T09:00:00`).getTime()),
    deadlines,
    target: s.targetScore,
  };
}

// ---------------------------------------------------------------- conversion

// Mean of the published tables, used only for papers whose year has none
// (the specimen papers). Always labelled as estimated.
let fittedCache = null;
function fittedTable(paper) {
  if (!fittedCache) {
    const years = content.conversionYears();
    const acc = { paper1: [], paper2: [] };
    for (const key of ['paper1', 'paper2']) {
      for (let raw = 0; raw <= 20; raw++) {
        const vals = years.map(y => content.rawTable(y, key)[String(raw)])
          .filter(v => typeof v === 'number');
        acc[key][raw] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }
    fittedCache = acc;
  }
  return paper === 1 ? fittedCache.paper1 : fittedCache.paper2;
}

// Scaled score for a (possibly fractional) raw score, interpolating the table.
function scaledFor(year, paper, raw) {
  const key = paper === 1 ? 'paper1' : paper === 2 ? 'paper2' : 'overall';
  const table = content.rawTable(year, key);
  let estimated = false;
  let lookup;
  if (table) {
    lookup = (r) => table[String(r)];
  } else {
    estimated = true;
    const fit = fittedTable(paper);
    lookup = (r) => fit[r];
  }
  const max = paper === 'overall' ? 40 : 20;
  const clamped = Math.max(0, Math.min(max, raw));
  const lo = Math.floor(clamped), hi = Math.ceil(clamped);
  const a = lookup(lo), b = lookup(hi);
  if (typeof a !== 'number' || typeof b !== 'number') return { value: null, estimated };
  const t = hi === lo ? 0 : clamped - lo;
  return { value: Math.round((a + (b - a) * t) * 10) / 10, estimated };
}

// Raw marks needed on a paper to reach a target scaled score, using the most
// recent published table as the reference for exam day.
function rawNeededFor(paper, target) {
  const year = content.conversionYears().slice(-1)[0];
  const key = paper === 1 ? 'paper1' : 'paper2';
  const table = content.rawTable(year, key);
  if (!table) return null;
  for (let raw = 0; raw <= 20; raw++) {
    if (table[String(raw)] >= target) return raw;
  }
  return null;
}

// ---------------------------------------------------------------- diagnostics

function completed(attempts) {
  return attempts.filter(a => a.status === 'completed');
}

// full papers only — drills distort per-paper statistics
function fullPapers(attempts) {
  return completed(attempts).filter(a => a.paper && a.questions.length === 20);
}

function topicDiagnostics(attempts) {
  const perPaperCount = content.topicsPerPaper();   // avg questions per paper by topic
  const stats = new Map();
  for (const a of completed(attempts)) {
    for (const q of a.questions) {
      const meta = content.get(q.question_id);
      if (!meta || q.correct === null) continue;
      for (const t of meta.topics) {
        if (!stats.has(t)) stats.set(t, { topic: t, seen: 0, correct: 0, byDate: [] });
        const s = stats.get(t);
        s.seen++;
        if (q.correct) s.correct++;
        s.byDate.push({ at: a.completed_at, correct: q.correct ? 1 : 0 });
      }
    }
  }

  const rows = [...stats.values()].map(s => {
    const accuracy = s.seen ? s.correct / s.seen : 0;
    const perPaper = perPaperCount[s.topic] || 0;
    const enough = s.seen >= MIN_TOPIC_SAMPLE;
    return {
      topic: s.topic,
      label: content.getTaxonomy()[s.topic] || s.topic,
      seen: s.seen,
      correct: s.correct,
      accuracy,
      questionsPerPaper: Math.round(perPaper * 100) / 100,
      // the ranking that actually matters: marks lost per paper
      expectedMarksLost: enough ? Math.round((1 - accuracy) * perPaper * 100) / 100 : null,
      enoughData: enough,
      needMore: enough ? 0 : MIN_TOPIC_SAMPLE - s.seen,
      trend: trendOf(s.byDate),
    };
  });

  rows.sort((a, b) => {
    if (a.enoughData !== b.enoughData) return a.enoughData ? -1 : 1;
    return (b.expectedMarksLost ?? -1) - (a.expectedMarksLost ?? -1);
  });
  return rows;
}

// improving / flat / regressing, comparing first half against second half in date order
function trendOf(points) {
  if (points.length < 6) return 'insufficient';
  const sorted = points.slice().sort((a, b) => a.at - b.at);
  const half = Math.floor(sorted.length / 2);
  const mean = (arr) => arr.reduce((s, p) => s + p.correct, 0) / arr.length;
  const before = mean(sorted.slice(0, half));
  const after = mean(sorted.slice(half));
  const delta = after - before;
  if (delta >= 0.15) return 'improving';
  if (delta <= -0.15) return 'regressing';
  return 'flat';
}

function paperSplit(attempts) {
  const out = { 1: { n: 0, raw: 0, scaled: [] }, 2: { n: 0, raw: 0, scaled: [] } };
  for (const a of fullPapers(attempts)) {
    const b = out[a.paper];
    if (!b) continue;
    b.n++;
    b.raw += a.score_raw;
    const sc = scaledFor(a.year, a.paper, a.score_raw);
    if (sc.value !== null) b.scaled.push(sc.value);
  }
  const summarise = (b) => ({
    attempts: b.n,
    avgRaw: b.n ? Math.round((b.raw / b.n) * 10) / 10 : null,
    avgScaled: b.scaled.length
      ? Math.round((b.scaled.reduce((x, y) => x + y, 0) / b.scaled.length) * 10) / 10 : null,
  });
  const p1 = summarise(out[1]), p2 = summarise(out[2]);
  let weaker = null, gap = null;
  if (p1.avgScaled !== null && p2.avgScaled !== null) {
    gap = Math.round(Math.abs(p1.avgScaled - p2.avgScaled) * 10) / 10;
    if (gap >= 0.4) weaker = p1.avgScaled < p2.avgScaled ? 1 : 2;
  }
  return { paper1: p1, paper2: p2, weaker, gap };
}

const ERROR_TYPES = {
  conceptual: 'Conceptual gap',
  careless: 'Careless / arithmetic slip',
  misread: 'Misread the question',
  time: 'Ran out of time / rushed',
  guess: 'Guessed blind',
};

// Suggest a tag from signals already recorded, so tagging is a confirmation
// rather than data entry.
function suggestErrorType(q, medianTime) {
  if (!q.selected) return 'time';
  if (medianTime > 0 && q.time_spent > 0 && q.time_spent < medianTime * 0.35) return 'careless';
  if (medianTime > 0 && q.time_spent > medianTime * 1.8) return 'conceptual';
  return null;
}

function errorMix(attempts) {
  const counts = {};
  for (const k of Object.keys(ERROR_TYPES)) counts[k] = 0;
  let tagged = 0, untagged = 0;
  const suggestions = [];
  for (const a of completed(attempts)) {
    const times = a.questions.map(q => q.time_spent).filter(t => t > 0).sort((x, y) => x - y);
    const median = times.length ? times[Math.floor(times.length / 2)] : 0;
    for (const q of a.questions) {
      if (q.correct !== 0) continue;
      if (q.error_type && counts[q.error_type] !== undefined) {
        counts[q.error_type]++;
        tagged++;
      } else {
        untagged++;
        suggestions.push({
          attemptId: a.id, position: q.position, questionId: q.question_id,
          suggested: suggestErrorType(q, median),
        });
      }
    }
  }
  const total = tagged || 1;
  const share = {};
  for (const k of Object.keys(counts)) share[k] = counts[k] / total;
  const dominant = tagged >= 5
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    : null;
  return {
    counts, share, tagged, untagged, suggestions,
    labels: ERROR_TYPES,
    dominant: dominant && dominant[1] > 0 ? { type: dominant[0], count: dominant[1] } : null,
  };
}

function pacing(attempts) {
  const papers = fullPapers(attempts).filter(a => a.allowed_sec);
  let totalTime = 0, totalQ = 0, unanswered = 0, timeouts = 0, overruns = 0;
  const firstHalf = { seen: 0, correct: 0 };
  const secondHalf = { seen: 0, correct: 0 };
  for (const a of papers) {
    if (a.finish_reason === 'timeout') timeouts++;
    const budget = a.allowed_sec / a.questions.length;
    for (const q of a.questions) {
      totalTime += q.time_spent; totalQ++;
      if (!q.selected) unanswered++;
      if (q.time_spent > budget * 1.5) overruns++;
      const half = q.position < 10 ? firstHalf : secondHalf;
      if (q.correct !== null) { half.seen++; if (q.correct) half.correct++; }
    }
  }
  const acc = (h) => (h.seen ? h.correct / h.seen : null);
  const a1 = acc(firstHalf), a2 = acc(secondHalf);
  let note = null;
  if (a1 !== null && a2 !== null && secondHalf.seen >= 10 && a1 - a2 >= 0.15) {
    note = `Accuracy falls from ${Math.round(a1 * 100)}% on Q1–10 to ${Math.round(a2 * 100)}% ` +
      `on Q11–20. Even with 93 minutes, the back half of the paper is costing you marks.`;
  } else if (unanswered > 0 && timeouts > 0) {
    note = `${unanswered} question${unanswered === 1 ? '' : 's'} left blank when time ran out.`;
  }
  return {
    papers: papers.length,
    avgSecPerQuestion: totalQ ? totalTime / totalQ : 0,
    overruns, unanswered, timeouts,
    firstHalfAccuracy: a1, secondHalfAccuracy: a2,
    note,
  };
}

// ---------------------------------------------------------------- guessing

function guessing(attempts) {
  let blanks = 0, sureRight = 0, sureWrong = 0, unsureRight = 0, unsureWrong = 0;
  let unmarked = 0, marked = 0;
  const papers = fullPapers(attempts);
  for (const a of papers) {
    for (const q of a.questions) {
      if (!q.selected) blanks++;
      if (q.correct === null) continue;
      if (!q.confidence) { unmarked++; continue; }
      marked++;
      if (q.confidence === 'sure') q.correct ? sureRight++ : sureWrong++;
      else q.correct ? unsureRight++ : unsureWrong++;
    }
  }
  const unsureTotal = unsureRight + unsureWrong;
  const sureTotal = sureRight + sureWrong;
  const unsureAccuracy = unsureTotal ? unsureRight / unsureTotal : null;
  const sureAccuracy = sureTotal ? sureRight / sureTotal : null;
  // average options per question across the bank sets the random-guess baseline
  const randomRate = content.averageRandomRate();
  let unsureVerdict = null;
  if (unsureTotal >= 8) {
    unsureVerdict = unsureAccuracy > randomRate * 1.5
      ? 'trust'      // educated guesses are worth making
      : 'eliminate'; // guesses are near random — work on elimination
  }
  return {
    papers: papers.length, blanks,
    marksThrownAway: Math.round(blanks * randomRate * 10) / 10,
    randomRate: Math.round(randomRate * 100) / 100,
    sureRight, sureWrong, unsureRight, unsureWrong, unmarked, marked,
    sureAccuracy, unsureAccuracy, unsureVerdict,
  };
}

function answerChangeStats(changes, attempts) {
  const byAttempt = new Map(completed(attempts).map(a => [a.id, a]));
  let helped = 0, hurt = 0, neutral = 0;
  for (const c of changes) {
    const a = byAttempt.get(c.attempt_id);
    if (!a) continue;
    const meta = content.get(c.question_id);
    if (!meta) continue;
    const wasRight = c.from_letter === meta.answer;
    const nowRight = c.to_letter === meta.answer;
    if (!wasRight && nowRight) helped++;
    else if (wasRight && !nowRight) hurt++;
    else neutral++;
  }
  const total = helped + hurt + neutral;
  return {
    total, helped, hurt, neutral,
    net: helped - hurt,
    enoughData: total >= CHANGE_SAMPLE_MIN,
    minSample: CHANGE_SAMPLE_MIN,
    verdict: total >= CHANGE_SAMPLE_MIN
      ? (helped > hurt ? 'changing helps' : hurt > helped ? 'first instinct' : 'neutral')
      : null,
  };
}

// ---------------------------------------------------------------- predictor

function weightedRaw(papers) {
  // exponentially weighted over the most recent EWMA_WINDOW papers
  const recent = papers.slice(-EWMA_WINDOW);
  let num = 0, den = 0;
  recent.forEach((p, i) => {
    const age = recent.length - 1 - i;           // 0 = most recent
    const w = Math.pow(EWMA_LAMBDA, age);
    num += w * p.raw;
    den += w;
  });
  return den ? num / den : null;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function refYear() { return content.conversionYears().slice(-1)[0]; }

function predict(attempts, settings, now = Date.now()) {
  const s = { ...DEFAULTS, ...settings };
  const papers = fullPapers(attempts)
    .slice()
    .sort((a, b) => a.completed_at - b.completed_at)
    .map(a => {
      const sc = scaledFor(a.year, a.paper, a.score_raw);
      // Also express every paper on the reference (most recent) table, so the
      // trajectory fit and the prediction are on the same scale. Mixing a 2016
      // scaled score with a 2023-referenced prediction made a flat history look
      // like it was moving.
      const ref = scaledFor(refYear(), a.paper, a.score_raw);
      return {
        id: a.id, at: a.completed_at, year: a.year, paper: a.paper,
        raw: a.score_raw, scaled: sc.value, refScaled: ref.value, estimated: sc.estimated,
      };
    });

  const base = {
    papers: papers.length,
    minPapers: MIN_PAPERS_TO_PREDICT,
    target: s.targetScore,
    anyEstimated: papers.some(p => p.estimated),
  };

  if (papers.length < MIN_PAPERS_TO_PREDICT) {
    return {
      ...base, ready: false,
      message: `Need at least ${MIN_PAPERS_TO_PREDICT} completed papers before a prediction is ` +
        `worth anything — you have ${papers.length}.`,
      perPaper: null, overall: null, trajectory: null, gap: null,
    };
  }

  const perPaper = {};
  for (const p of [1, 2]) {
    const list = papers.filter(x => x.paper === p);
    if (!list.length) { perPaper[p] = null; continue; }
    const raw = weightedRaw(list);
    const sc = scaledFor(content.conversionYears().slice(-1)[0], p, raw);
    const observed = stdev(list.slice(-EWMA_WINDOW).map(x => x.refScaled).filter(v => v !== null));
    const spread = Math.max(observed, MIN_RANGE_HALFWIDTH);
    // Under-promise: the optimistic end of the range is capped just above the
    // best paper actually produced. Telling someone they might score higher
    // than they ever have is the one failure mode that would really cost them.
    const bestSoFar = Math.max(...list.map(x => x.refScaled ?? 0));
    const ceiling = Math.min(9, bestSoFar + BEST_EVER_MARGIN);
    perPaper[p] = {
      attempts: list.length,
      predictedRaw: Math.round(raw * 10) / 10,
      scaled: Math.min(sc.value, ceiling),
      low: Math.max(1, Math.round((sc.value - spread) * 10) / 10),
      high: Math.min(ceiling, Math.round((sc.value + spread) * 10) / 10),
      bestSoFar,
      spread: Math.round(spread * 100) / 100,
      observedSpread: Math.round(observed * 100) / 100,
    };
  }

  // Overall uses the official overall table on the combined raw total, which is
  // how TMUA actually reports it — not an average of the two scaled scores.
  let overall = null;
  if (perPaper[1] && perPaper[2]) {
    const rawTotal = perPaper[1].predictedRaw + perPaper[2].predictedRaw;
    const refYear = content.conversionYears().slice(-1)[0];
    const mid = scaledFor(refYear, 'overall', rawTotal).value;
    const spread = Math.max(MIN_RANGE_HALFWIDTH,
      (perPaper[1].spread + perPaper[2].spread) / 2);
    const bestOverall = Math.max(...papers.map(x => x.refScaled ?? 0));
    const ceiling = Math.min(9, bestOverall + BEST_EVER_MARGIN);
    overall = {
      rawTotal: Math.round(rawTotal * 10) / 10,
      mostLikely: Math.min(mid, ceiling),
      low: Math.max(1, Math.round((mid - spread) * 10) / 10),
      high: Math.min(ceiling, Math.round((mid + spread) * 10) / 10),
      bestSoFar: bestOverall,
    };
  } else {
    // only one paper type attempted — report it, do not invent the other
    const only = perPaper[1] || perPaper[2];
    overall = only
      ? { rawTotal: null, mostLikely: only.scaled, low: only.low, high: only.high, singlePaperOnly: true }
      : null;
  }

  // trajectory: least-squares fit of scaled score against time, projected forward
  let trajectory = null;
  const pts = papers.filter(p => p.refScaled !== null);
  if (pts.length >= 3) {
    const t0 = pts[0].at;
    const xs = pts.map(p => (p.at - t0) / 86400000);   // days
    const ys = pts.map(p => p.refScaled);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const denom = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
    const slope = denom ? xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / denom : 0;
    const intercept = my - slope * mx;
    const examMs = new Date(`${s.examDate}T09:00:00`).getTime();
    const daysToExam = (examMs - t0) / 86400000;
    const projected = Math.max(1, Math.min(9, intercept + slope * daysToExam));
    trajectory = {
      perWeek: Math.round(slope * 7 * 100) / 100,
      projected: Math.round(projected * 10) / 10,
      reachesTarget: projected >= s.targetScore,
      shortfall: Math.round(Math.max(0, s.targetScore - projected) * 10) / 10,
    };
  }

  // gap to target, in raw marks per paper, attributed to weak topics
  const gap = {};
  const diag = topicDiagnostics(attempts);
  for (const p of [1, 2]) {
    if (!perPaper[p]) { gap[p] = null; continue; }
    const need = rawNeededFor(p, s.targetScore);
    const marks = need === null ? null
      : Math.max(0, Math.round((need - perPaper[p].predictedRaw) * 10) / 10);
    gap[p] = { rawNeeded: need, marksShort: marks };
  }
  const totalShort = [1, 2].reduce((sum, p) => sum + (gap[p]?.marksShort ?? 0), 0);
  const recoverable = diag
    .filter(t => t.enoughData && t.expectedMarksLost > 0)
    .slice(0, 4)
    .map(t => ({
      topic: t.topic, label: t.label,
      // realistic recovery: lift accuracy to 80% on that topic
      marks: Math.round(Math.max(0, (0.8 - t.accuracy)) * t.questionsPerPaper * 100) / 100,
    }))
    .filter(t => t.marks > 0.05);

  return {
    ...base, ready: true,
    perPaper, overall, trajectory,
    gap: {
      byPaper: gap,
      totalMarksShort: Math.round(totalShort * 10) / 10,
      recoverable,
      recoverableTotal: Math.round(recoverable.reduce((s2, r) => s2 + r.marks, 0) * 10) / 10,
    },
    history: papers,
    confidence: papers.length >= 6 ? 'reasonable' : 'low',
  };
}

module.exports = {
  DEFAULTS, MIN_TOPIC_SAMPLE, MIN_PAPERS_TO_PREDICT, RESERVE_PAPERS, ERROR_TYPES,
  CHANGE_SAMPLE_MIN, MIN_RANGE_HALFWIDTH, BEST_EVER_MARGIN,
  countdown, daysBetween, scaledFor, rawNeededFor, fittedTable,
  topicDiagnostics, paperSplit, errorMix, pacing, guessing, answerChangeStats,
  suggestErrorType, predict, fullPapers, completed,
};
