// The action checklist and the week-by-week study plan.
//
// Every item states what to do, why (tied to the user's own numbers), how long
// it takes, and carries an action the UI can fire directly. Capped so the list
// is never a wall of guilt.
const content = require('./content');
const coach = require('./coach');
const srs = require('./srs');

const MAX_ITEMS = 5;

// How the sub-skills behind a weak topic are actually described, so a study
// item names the thing to revise rather than waving at the topic.
const SUBSKILLS = {
  'logic-truth': 'quantifiers (for all / there exists), negating compound statements, and reading "which of I, II, III must be true" as three separate claims',
  'necessary-sufficient': 'necessary vs sufficient conditions, converse and contrapositive, and testing each direction separately for a one-way counterexample',
  'proof-counterexample': 'proof by contradiction, and hunting counterexamples at small, zero, negative and boundary values before anything clever',
  'argument-analysis': 'finding the first invalid step: squaring both sides, dividing by something that may be zero, and losing roots',
  integration: 'definite integrals with a sign change in the interval, area between curves, and when the trapezium rule over- or under-estimates (link it to concavity)',
  differentiation: 'chain, product and quotient rules, stationary points and their nature, and tangents/normals at a given point',
  trigonometry: 'identities and double-angle formulae, and counting solutions in a given interval by sketching rather than solving',
  'exponentials-logarithms': 'log laws and change of base, equations mixing different bases, and when taking logs of both sides is the unlock',
  'coordinate-geometry': 'circle equations by completing the square, tangency conditions, and distance between centres',
  'sequences-series': 'arithmetic and geometric formulae, the convergence condition for a sum to infinity, and writing out the first terms of a recurrence',
  'algebra-functions': 'polynomial manipulation, factor and remainder theorem, and composite/inverse functions',
  'equations-inequalities': 'discriminant conditions for "all real x", and sign flips when multiplying an inequality by a variable',
  graphs: 'transformations, asymptotes, and eliminating sketch options using intercepts and end behaviour',
  geometry: 'circle theorems, similar triangles, and 3D distances via an unfolded net',
  number: 'divisibility and modular arguments, primes, and rational vs irrational reasoning',
  'counting-probability': 'counting principles and probability without replacement',
};

function subskill(topic) {
  return SUBSKILLS[topic] || 'the core techniques for this topic in the TMUA specification';
}

// ---------------------------------------------------------------- phase

function phase(days) {
  if (days < 0) return { key: 'past', label: 'Exam has passed', blurb: 'Practice mode.' };
  if (days <= 14) {
    return {
      key: 'simulation', label: 'Exam simulation',
      blurb: 'Two weeks out: full timed mocks, review and light consolidation. Do not start new topics now.',
    };
  }
  if (days <= 42) {
    return {
      key: 'targeted', label: 'Targeted practice',
      blurb: 'Mix timed papers with focused work on your weakest topics.',
    };
  }
  return {
    key: 'fundamentals', label: 'Build fundamentals',
    blurb: 'Plenty of runway: go deep on weak topics now, papers will come.',
  };
}

// ---------------------------------------------------------------- checklist

function build({ attempts, reviewRows, changes, settings, now = Date.now(), doneKeys = new Set() }) {
  const cd = coach.countdown(settings, now);
  const ph = phase(cd.days);
  const done = coach.fullPapers(attempts);
  const diag = coach.topicDiagnostics(attempts);
  const split = coach.paperSplit(attempts);
  const mix = coach.errorMix(attempts);
  const pace = coach.pacing(attempts);
  const guess = coach.guessing(attempts);
  const changeStats = coach.answerChangeStats(changes, attempts);
  const review = srs.summary(reviewRows, now);
  const stubbornList = srs.stubborn(reviewRows, now);

  const attemptedKeys = new Set(done.map(a => `${a.year}-P${a.paper}`));
  const allPapers = content.papers();
  const unseen = allPapers.filter(p => !attemptedKeys.has(p.key));
  const items = [];

  const add = (item) => {
    if (doneKeys.has(item.key)) return;
    items.push(item);
  };

  // 1. questions missed more than once — the strongest signal available
  const repeated = stubbornList.slice(0, 12);
  if (repeated.length >= 3) {
    add({
      key: `repeat-misses-${repeated.length}`,
      kind: 'retry', priority: 100,
      title: `Redo ${repeated.length} questions you have missed more than once`,
      why: `These have reset in your review queue ${repeated[0].lapses}+ times. A repeated miss is a real gap, not bad luck.`,
      minutes: Math.max(15, repeated.length * 3),
      action: { type: 'drill', questionIds: repeated.map(r => r.questionId), untimed: true,
        label: 'Drill · stubborn questions' },
    });
  }

  // 2. spaced repetition backlog
  if (review.due > 0) {
    const overdueHeavy = review.overdue >= 10;
    add({
      key: `review-due-${review.due}`,
      kind: 'retry', priority: overdueHeavy ? 95 : 70,
      title: `${review.due} question${review.due === 1 ? '' : 's'} due for review`,
      why: overdueHeavy
        ? `${review.overdue} are overdue. Clearing the backlog matters more than a new paper right now.`
        : 'Spaced review is what turns a corrected mistake into a fixed one.',
      minutes: Math.min(40, Math.max(10, review.due * 2)),
      action: { type: 'review', cap: review.cap },
    });
  }

  // 3. habit fixes, when the error mix or pacing says the problem is not knowledge
  if (mix.dominant && mix.tagged >= 5) {
    const t = mix.dominant.type;
    const pctOf = Math.round((mix.counts[t] / mix.tagged) * 100);
    if (t === 'careless' && pctOf >= 30) {
      add({
        key: `habit-careless-${pctOf}`,
        kind: 'habit', priority: 88,
        title: 'Drill a checking routine — your errors are slips, not gaps',
        why: `${pctOf}% of your tagged wrong answers are careless slips. More topic revision will not fix these.`,
        minutes: 20,
        how: 'On your next paper, after answering each question spend five seconds re-reading the question stem and confirming the answer you picked matches what was actually asked. Measure it: the careless share should fall below 20% next attempt.',
        action: { type: 'paper-suggest' },
      });
    } else if (t === 'time' && pctOf >= 30) {
      add({
        key: `habit-time-${pctOf}`,
        kind: 'habit', priority: 88,
        title: 'Fix triage — time is costing you more than knowledge',
        why: `${pctOf}% of your tagged errors are time-related, and you have left ${pace.unanswered} question(s) blank at timeout.`,
        minutes: 20,
        how: 'Budget 4:30 per question. On sight, sort each question into do-now / come-back / guess-and-move. Never spend more than 7 minutes on one question before flagging it and moving on.',
        action: { type: 'paper-suggest' },
      });
    } else if (t === 'misread' && pctOf >= 25) {
      add({
        key: `habit-misread-${pctOf}`,
        kind: 'habit', priority: 85,
        title: 'Underline what the question actually asks',
        why: `${pctOf}% of your tagged errors are misreads — especially "not", "must", "sufficient" and "complete set of".`,
        minutes: 15,
        how: 'Before answering, say the question back to yourself in your own words. Watch for negations and for "which one is NOT".',
        action: { type: 'paper-suggest' },
      });
    }
  }

  // 4. blanks left on the paper — free marks with no negative marking
  if (guess.blanks >= 2) {
    add({
      key: `habit-blanks-${guess.blanks}`,
      kind: 'habit', priority: 84,
      title: `Stop leaving blanks — ${guess.blanks} across your papers`,
      why: `There is no negative marking. At random-guess rate those blanks are about ${guess.marksThrownAway} marks thrown away.`,
      minutes: 5,
      how: 'With two minutes left, fill every empty answer with your best guess, eliminating what you can first.',
      action: { type: 'paper-suggest' },
    });
  }

  // 5. answer-change habit, only once the sample supports it
  if (changeStats.enoughData && changeStats.net <= -3) {
    add({
      key: `habit-changes-${changeStats.total}`,
      kind: 'habit', priority: 80,
      title: 'Stop second-guessing correct answers',
      why: `You changed ${changeStats.total} answers: ${changeStats.helped} helped, ${changeStats.hurt} hurt — net ${changeStats.net} marks.`,
      minutes: 5,
      how: 'Only change an answer when you can point to a specific error in your working. A vague feeling is not a reason.',
      action: { type: 'paper-suggest' },
    });
  }

  // 6. topic study for genuine conceptual gaps
  const conceptualHeavy = !mix.dominant || mix.dominant.type === 'conceptual' || mix.tagged < 5;
  const weak = diag.filter(t => t.enoughData && t.expectedMarksLost >= 0.35);
  if (weak.length && ph.key !== 'simulation' && conceptualHeavy) {
    const t = weak[0];
    add({
      key: `study-${t.topic}`,
      kind: 'study', priority: 78,
      title: `Study ${t.label} — worth about ${t.expectedMarksLost} marks a paper`,
      why: `You are ${Math.round(t.accuracy * 100)}% on ${t.label} over ${t.seen} questions, and it appears ${t.questionsPerPaper} times per paper. That is your biggest single leak.`,
      minutes: 45,
      how: `Work offline on ${subskill(t.topic)}. Use your A-level textbook chapter on this and the TMUA specification points, then come back and drill.`,
      action: { type: 'drill', topics: [t.topic], untimed: true, label: `Drill · ${t.label}` },
    });
  }

  // 7. which paper to sit next, and why
  if (unseen.length) {
    const preferPaper = split.weaker || (split.paper2.attempts < split.paper1.attempts ? 2 : 1);
    const candidates = unseen.filter(p => p.paper === preferPaper);
    const pick = (candidates.length ? candidates : unseen)[0];
    const reserved = reservedPapers(unseen, cd.days);
    const isReserved = reserved.some(r => r.key === pick.key);
    const usable = unseen.filter(p => !reserved.some(r => r.key === p.key));
    const chosen = isReserved && usable.length ? usable.find(p => p.paper === preferPaper) || usable[0] : pick;

    if (chosen) {
      const asMock = ph.key === 'simulation' || (cd.days <= 21);
      const reason = split.weaker
        ? `Paper ${split.weaker} is your weaker paper (${split[`paper${split.weaker}`].avgScaled ?? '—'} vs ${split[`paper${split.weaker === 1 ? 2 : 1}`].avgScaled ?? '—'} scaled).`
        : `You have done ${split.paper1.attempts} Paper 1s and ${split.paper2.attempts} Paper 2s — keep them balanced.`;
      add({
        key: `sit-${chosen.key}`,
        kind: 'paper', priority: ph.key === 'simulation' ? 92 : 74,
        title: asMock
          ? `Sit a full timed mock — ${labelYear(chosen.year)}`
          : `Sit ${labelYear(chosen.year)} Paper ${chosen.paper} under timed conditions`,
        why: `${reason} ${unseen.length} papers still unseen, ${reserved.length} held back as clean mocks for the final fortnight.`,
        minutes: asMock ? 201 : 93,
        action: asMock
          ? { type: 'mock', year: chosen.year }
          : { type: 'paper', year: chosen.year, paper: chosen.paper },
      });
    }
  }

  // 8. current-format familiarity, in the final month
  if (cd.days <= 35 && cd.days >= 0) {
    add({
      key: 'format-current-provider',
      kind: 'study', priority: 76,
      title: 'Sit one current-provider practice paper',
      why: 'Every paper in this app is Cambridge-era (2016–2023). UAT-UK took over in 2024 and the format shifted slightly, so exam-day layout should not be a surprise.',
      minutes: 93,
      how: 'Download a recent specimen/practice paper from the current provider outside this app, print it, and sit it on paper. Then record the result here with "Enter answers from paper".',
      action: { type: 'offline-entry' },
    });
  }

  // 9. pace warning if papers are being burned too fast
  const burn = burnRate(done, unseen.length, cd.days, now);
  if (burn.tooFast) {
    add({
      key: `consolidate-burn-${unseen.length}`,
      kind: 'consolidate', priority: 72,
      title: 'Slow down — you are running out of unseen papers',
      why: `${unseen.length} unseen papers left with ${cd.days} days to go. At your recent rate of ${burn.perWeek}/week you would run dry around ${burn.dryInWeeks} week(s) before the exam.`,
      minutes: 0,
      how: 'Spend the next session reviewing and drilling what you already have wrong rather than opening a new paper.',
      action: { type: 'review', cap: srs.SESSION_CAP },
    });
  }

  // 10. nothing else to say
  if (!items.length) {
    add({
      key: 'all-clear',
      kind: 'consolidate', priority: 1,
      title: done.length ? 'Nothing urgent — sit a paper when you are ready' : 'Sit your first paper',
      why: done.length
        ? 'No overdue reviews and no topic is standing out as a leak yet.'
        : 'The coach needs data before it can tell you anything useful. Start with any paper.',
      minutes: 93,
      action: unseen.length
        ? { type: 'paper', year: unseen[0].year, paper: unseen[0].paper }
        : { type: 'review', cap: srs.SESSION_CAP },
    });
  }

  items.sort((a, b) => b.priority - a.priority);
  return {
    phase: ph,
    countdown: cd,
    items: items.slice(0, MAX_ITEMS),
    suppressed: Math.max(0, items.length - MAX_ITEMS),
    context: { split, review, mix, pacing: pace, guessing: guess, changes: changeStats,
      unseen: unseen.length, reserved: reservedPapers(unseen, cd.days).map(p => p.key) },
  };
}

function labelYear(y) { return y === 'specimen' ? 'the specimen paper' : y; }

// Hold back a few unseen papers so the final fortnight has clean mocks.
function reservedPapers(unseen, daysToExam) {
  if (daysToExam < 0) return [];
  const n = Math.min(coach.RESERVE_PAPERS, Math.max(0, unseen.length));
  if (daysToExam <= 14) return [];        // in the final fortnight they are for using
  return unseen.slice(-n);
}

function burnRate(donePapers, unseenCount, daysToExam, now) {
  const recent = donePapers.filter(a => now - a.completed_at <= 21 * 86400000);
  const perWeek = Math.round((recent.length / 3) * 10) / 10;
  const weeksLeft = Math.max(0, daysToExam / 7);
  if (perWeek <= 0 || daysToExam < 0) {
    return { perWeek, tooFast: false, dryInWeeks: null };
  }
  const weeksOfStock = unseenCount / perWeek;
  return {
    perWeek,
    dryInWeeks: Math.max(0, Math.round((weeksLeft - weeksOfStock) * 10) / 10),
    tooFast: weeksOfStock < weeksLeft - 2 && unseenCount <= 6 && daysToExam > 21,
  };
}

// ---------------------------------------------------------------- study plan

function plan({ attempts, settings, now = Date.now() }) {
  const cd = coach.countdown(settings, now);
  const done = coach.fullPapers(attempts);
  const attemptedKeys = new Set(done.map(a => `${a.year}-P${a.paper}`));
  const unseen = content.papers().filter(p => !attemptedKeys.has(p.key));
  const diag = coach.topicDiagnostics(attempts).filter(t => t.enoughData);
  const weakOrder = diag.length
    ? diag.map(t => t.topic)
    : Object.keys(content.getTaxonomy());

  if (cd.days <= 0) {
    return { weeks: [], countdown: cd, phase: phase(cd.days), unseen: unseen.length,
      note: 'Exam date has passed — the plan is empty. Change the exam date in Settings to plan another sitting.' };
  }

  const totalWeeks = Math.max(1, Math.ceil(cd.days / 7));
  const reserve = Math.min(coach.RESERVE_PAPERS, unseen.length);
  const forSchedule = unseen.slice(0, Math.max(0, unseen.length - reserve));
  const reserved = unseen.slice(unseen.length - reserve);

  // spread the schedulable papers over the weeks before the final fortnight
  const buildWeeks = Math.max(1, totalWeeks - 2);
  const perWeek = forSchedule.length / buildWeeks;

  const weeks = [];
  let cursor = 0;
  for (let w = 0; w < totalWeeks; w++) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + w * 7);
    const weeksLeft = totalWeeks - w;
    const ph = phase(cd.days - w * 7);

    let papers = [];
    let topics = [];
    let mock = false;

    if (weeksLeft <= 2) {
      // final fortnight: clean mocks from the reserve, then review
      const take = reserved.splice(0, Math.ceil(reserved.length / Math.max(1, weeksLeft)));
      papers = take;
      mock = true;
      topics = [];
    } else {
      const take = Math.round(perWeek * (w + 1)) - Math.round(perWeek * w);
      papers = forSchedule.slice(cursor, cursor + take);
      cursor += take;
      // weakest first, then revisit earlier topics for spaced repetition
      const primary = weakOrder[w % Math.max(1, weakOrder.length)];
      const revisit = w >= 3 ? weakOrder[(w - 3) % Math.max(1, weakOrder.length)] : null;
      topics = [primary, revisit].filter(Boolean)
        .map(t => ({ topic: t, label: content.getTaxonomy()[t] || t }));
    }

    weeks.push({
      index: w + 1,
      startsOn: start.toISOString().slice(0, 10),
      weeksToExam: weeksLeft,
      phase: ph.label,
      papers: papers.map(p => ({ key: p.key, year: p.year, paper: p.paper })),
      isMockWeek: mock,
      topics,
    });
  }

  return {
    countdown: cd, phase: phase(cd.days), weeks,
    unseen: unseen.length,
    reserved: unseen.slice(unseen.length - reserve).map(p => p.key),
    papersPerWeek: Math.round(perWeek * 10) / 10,
    note: forSchedule.length === 0
      ? 'No unseen papers left to schedule — the plan focuses on review and re-sits.'
      : null,
  };
}

module.exports = { build, plan, phase, subskill, MAX_ITEMS, SUBSKILLS, reservedPapers };
