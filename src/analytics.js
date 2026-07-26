// Derived statistics for the progress dashboard: score trends, per-topic
// accuracy with concrete revision advice, pacing, and the wrong-answer log.
const content = require('./content');

const ADVICE = {
  'algebra-functions': {
    revise: 'Polynomial manipulation, factor/remainder theorem, partial fractions, composite and inverse functions.',
    drill: 'Questions asking for "the complete set of values" and ones that hide a substitution — practise spotting the substitution before expanding.',
  },
  'equations-inequalities': {
    revise: 'Quadratic discriminants, simultaneous equations, inequalities with sign changes, modulus equations.',
    drill: 'Inequality questions where multiplying by a variable flips the sign, and "for all real x" discriminant conditions.',
  },
  'sequences-series': {
    revise: 'Arithmetic/geometric formulae, sum to infinity conditions, sigma notation, recurrence relations.',
    drill: 'Sum-to-infinity questions with a hidden convergence condition, and recurrences that need the first few terms written out.',
  },
  'coordinate-geometry': {
    revise: 'Circle equations, tangents and normals, distance between centres, line intersections.',
    drill: 'Circle-and-line questions where the condition is tangency, and problems needing completion of the square.',
  },
  trigonometry: {
    revise: 'Identities, double-angle formulae, solving in a given interval, radians vs degrees.',
    drill: 'Interval-counting questions ("how many solutions in 0 ≤ x ≤ 2π") — sketch the graph rather than solving algebraically.',
  },
  'exponentials-logarithms': {
    revise: 'Log laws, changing base, exponential equations, log graph transformations.',
    drill: 'Equations mixing different bases, and questions where taking logs of both sides is the unlock.',
  },
  differentiation: {
    revise: 'Chain/product/quotient rules, stationary points and their nature, tangents and normals.',
    drill: 'Questions asking for the greatest/least value of a parameter — set the derivative condition first, then solve.',
  },
  integration: {
    revise: 'Definite integrals, area between curves, the trapezium rule and whether it over- or under-estimates.',
    drill: 'Area questions where the curve crosses the axis, and trapezium-rule over/under-estimate reasoning (link to concavity).',
  },
  graphs: {
    revise: 'Transformations, asymptotes, sketching from a factorised form, matching graphs to equations.',
    drill: 'Multiple-diagram "which sketch is this" questions — eliminate options using intercepts and end behaviour, not point-plotting.',
  },
  geometry: {
    revise: 'Circle theorems, similar triangles, areas and volumes, 3D distances on solids.',
    drill: '3D questions that need an unfolded net, and "not to scale" diagrams where you must not trust the picture.',
  },
  number: {
    revise: 'Divisibility, primes, modular reasoning, rational/irrational arguments, standard form.',
    drill: 'Divisibility proofs and counterexample-hunting on integer statements.',
  },
  'counting-probability': {
    revise: 'Counting principles, permutations/combinations, probability without replacement.',
    drill: 'Selection-without-replacement problems and "how many arrangements satisfy X" counting.',
  },
  'logic-truth': {
    revise: 'Which of I/II/III must be true, quantifiers (for all / there exists), negation of compound statements.',
    drill: 'Paper 2 "which statements must be true" — test each statement against an extreme or degenerate case.',
  },
  'necessary-sufficient': {
    revise: 'The difference between necessary, sufficient, and necessary-and-sufficient; converse and contrapositive.',
    drill: 'Necessary/sufficient questions: check both directions separately and look for a one-way counterexample.',
  },
  'proof-counterexample': {
    revise: 'Proof by contradiction, disproof by counterexample, structure of a valid proof.',
    drill: 'Counterexample questions — try small, boundary, negative, and zero values before anything clever.',
  },
  'argument-analysis': {
    revise: 'Finding the first invalid step in a numbered argument; spotting division by zero, lost roots, and invalid squaring.',
    drill: '"Which line contains the first error" — check each step for reversibility, especially squaring and dividing.',
  },
};

function scored(attempts) {
  return attempts.filter(a => a.status === 'completed');
}

function summarize(attempts) {
  const done = scored(attempts);
  const trend = done
    .slice()
    .sort((a, b) => a.completed_at - b.completed_at)
    .map(a => ({
      id: a.id, at: a.completed_at, mode: a.mode, year: a.year, paper: a.paper,
      raw: a.score_raw, scaled: a.score_scaled, total: a.questions.length,
    }));

  const byPaperType = { 1: { n: 0, raw: 0, total: 0 }, 2: { n: 0, raw: 0, total: 0 } };
  for (const a of done) {
    if (a.paper === 1 || a.paper === 2) {
      const b = byPaperType[a.paper];
      b.n++; b.raw += a.score_raw; b.total += a.questions.length;
    }
  }

  const attempted = new Set(done.filter(a => a.year && a.paper).map(a => `${a.year}-P${a.paper}`));
  const notDone = content.papers().filter(p => !attempted.has(p.key));

  return { trend, byPaperType, notDone, completedCount: done.length };
}

function topicStats(attempts) {
  const stats = new Map();
  for (const a of scored(attempts)) {
    for (const q of a.questions) {
      const meta = content.get(q.question_id);
      if (!meta || q.correct === null) continue;
      for (const t of meta.topics) {
        if (!stats.has(t)) stats.set(t, { topic: t, seen: 0, correct: 0, unanswered: 0 });
        const s = stats.get(t);
        s.seen++;
        if (q.correct) s.correct++;
        if (!q.selected) s.unanswered++;
      }
    }
  }
  const rows = [...stats.values()].map(s => ({
    ...s,
    accuracy: s.seen ? s.correct / s.seen : 0,
    label: content.getTaxonomy()[s.topic] || s.topic,
  }));
  rows.sort((a, b) => a.accuracy - b.accuracy || b.seen - a.seen);
  return rows;
}

function weaknesses(attempts) {
  const rows = topicStats(attempts).filter(r => r.seen >= 3);
  return rows.filter(r => r.accuracy < 0.7).slice(0, 6).map(r => ({
    ...r,
    advice: ADVICE[r.topic] || { revise: 'Review this topic in the TMUA specification.', drill: 'Drill mixed questions on this topic.' },
  }));
}

function pacing(attempts) {
  const done = scored(attempts).filter(a => a.allowed_sec);
  let totalTime = 0, totalQ = 0, unansweredAtTimeout = 0, timeouts = 0;
  const overruns = [];
  const positionBuckets = [];   // accuracy by position bucket (pacing signal)
  for (let i = 0; i < 4; i++) positionBuckets.push({ from: i * 5 + 1, to: i * 5 + 5, seen: 0, correct: 0 });

  for (const a of done) {
    if (a.finish_reason === 'timeout') timeouts++;
    for (const q of a.questions) {
      totalTime += q.time_spent; totalQ++;
      if (!q.selected) unansweredAtTimeout += a.finish_reason === 'timeout' ? 1 : 0;
      const meta = content.get(q.question_id);
      const bucket = positionBuckets[Math.min(3, Math.floor(q.position / 5))];
      if (q.correct !== null) { bucket.seen++; if (q.correct) bucket.correct++; }
      if (q.time_spent > 0) {
        overruns.push({
          attemptId: a.id, questionId: q.question_id, number: meta ? meta.number : q.position + 1,
          year: a.year, paper: a.paper, time: q.time_spent, correct: q.correct,
        });
      }
    }
  }
  overruns.sort((x, y) => y.time - x.time);
  const avg = totalQ ? totalTime / totalQ : 0;
  const buckets = positionBuckets.map(b => ({ ...b, accuracy: b.seen ? b.correct / b.seen : null }));

  // pacing verdict: does accuracy fall off in the last five questions?
  let note = null;
  const first = buckets[0].accuracy, last = buckets[3].accuracy;
  if (first !== null && last !== null && buckets[3].seen >= 5 && first - last >= 0.2) {
    note = `Accuracy drops from ${Math.round(first * 100)}% on Q1-5 to ${Math.round(last * 100)}% on Q16-20 — that is a pacing problem, not a knowledge gap. Practise banking time early.`;
  }
  return {
    avgSecPerQuestion: avg, overruns: overruns.slice(0, 15), buckets,
    unansweredAtTimeout, timeouts, note,
  };
}

function wrongLog(attempts) {
  const rows = [];
  for (const a of scored(attempts)) {
    for (const q of a.questions) {
      if (q.correct === 1 || q.correct === null) continue;
      const meta = content.get(q.question_id);
      if (!meta) continue;
      rows.push({
        attemptId: a.id, at: a.completed_at, questionId: q.question_id,
        year: meta.year, paper: meta.paper, number: meta.number, topics: meta.topics,
        selected: q.selected, answer: meta.answer, confidence: q.confidence,
        time: q.time_spent, unanswered: !q.selected,
      });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}

function confidenceBreakdown(attempts) {
  const out = { sureRight: 0, sureWrong: 0, unsureRight: 0, unsureWrong: 0, unmarked: 0 };
  for (const a of scored(attempts)) {
    for (const q of a.questions) {
      if (q.correct === null) continue;
      if (!q.confidence) { out.unmarked++; continue; }
      const key = (q.confidence === 'sure' ? 'sure' : 'unsure') + (q.correct ? 'Right' : 'Wrong');
      out[key]++;
    }
  }
  return out;
}

function studyLog(attempts) {
  const weeks = new Map();
  for (const a of scored(attempts)) {
    const d = new Date(a.completed_at);
    const monday = new Date(d);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, { week: key, papers: 0, questions: 0, correct: 0 });
    const w = weeks.get(key);
    w.papers++; w.questions += a.questions.length; w.correct += a.score_raw || 0;
  }
  const rows = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));

  // current streak: consecutive weeks (ending this week or last) with activity
  let streak = 0;
  const thisMonday = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  })();
  const have = new Set(rows.map(r => r.week));
  for (let i = 0; i < 520; i++) {
    const d = new Date(thisMonday); d.setDate(d.getDate() - i * 7);
    const key = d.toISOString().slice(0, 10);
    if (have.has(key)) streak++;
    else if (i > 0) break;          // allow the current week to be empty
  }
  return { weeks: rows, streak };
}

function dashboard(attempts) {
  return {
    summary: summarize(attempts),
    topics: topicStats(attempts),
    weaknesses: weaknesses(attempts),
    pacing: pacing(attempts),
    wrong: wrongLog(attempts),
    confidence: confidenceBreakdown(attempts),
    study: studyLog(attempts),
  };
}

module.exports = { dashboard, topicStats, weaknesses, pacing, wrongLog, ADVICE };
