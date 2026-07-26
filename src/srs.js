// Question-level spaced repetition.
//
// Schedule: +3, +7, +21, +45 days. A wrong answer resets to the start.
// A question retires only after two consecutive correct reviews at spaced
// intervals — one lucky retry is not evidence of anything.
const content = require('./content');

const INTERVALS = [3, 7, 21, 45];          // days
const RETIRE_AFTER = 2;                    // consecutive correct reviews
const SESSION_CAP = 20;
const DAY = 86400000;

// Priority order when building a session. A confident wrong answer is the most
// dangerous thing in the data: it is a misconception, not a gap.
const PRIORITY = { sure_wrong: 0, wrong: 1, revisit: 2, flag: 3 };

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms, days) {
  // date arithmetic, not ms arithmetic, so DST and month boundaries behave
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function blank(questionId, source, now) {
  return {
    question_id: questionId,
    source,
    due_at: addDays(now, INTERVALS[0]),
    interval_index: 0,
    consecutive_correct: 0,
    lapses: 0,
    attempts: 0,
    hits: 0,
    retired: 0,
    last_result: null,
    last_seen_at: null,
    created_at: now,
    history: '[]',
  };
}

// Record the outcome of seeing a question. `correct` null means the question
// merely entered the queue (flagged / marked revisit) rather than being answered.
function applyResult(existing, { questionId, source, correct, now }) {
  const row = existing ? { ...existing } : blank(questionId, source, now);

  // a wrong answer always outranks a flag as the reason it is in the queue
  if (PRIORITY[source] < PRIORITY[row.source]) row.source = source;

  if (correct === null || correct === undefined) {
    if (!existing) return row;                 // newly queued, schedule untouched
    return row;
  }

  const history = JSON.parse(row.history || '[]');
  history.push({ at: now, correct: correct ? 1 : 0 });
  row.history = JSON.stringify(history.slice(-40));
  row.attempts += 1;
  row.last_result = correct ? 'correct' : 'wrong';
  row.last_seen_at = now;

  if (correct) {
    row.hits += 1;
    row.consecutive_correct += 1;
    row.interval_index = Math.min(row.interval_index + 1, INTERVALS.length - 1);
    row.due_at = addDays(now, INTERVALS[row.interval_index]);
    if (row.consecutive_correct >= RETIRE_AFTER) row.retired = 1;
  } else {
    if (row.attempts > 1 || existing) row.lapses += 1;
    row.consecutive_correct = 0;
    row.interval_index = 0;
    row.retired = 0;
    row.due_at = addDays(now, INTERVALS[0]);
  }
  return row;
}

function decorate(row, now) {
  const meta = content.get(row.question_id);
  const overdueDays = Math.round((startOfDay(now) - startOfDay(row.due_at)) / DAY);
  return {
    questionId: row.question_id,
    source: row.source,
    dueAt: row.due_at,
    due: row.due_at <= startOfDay(now) + DAY - 1,
    overdueDays: Math.max(0, overdueDays),
    intervalIndex: row.interval_index,
    nextIntervalDays: INTERVALS[Math.min(row.interval_index, INTERVALS.length - 1)],
    consecutiveCorrect: row.consecutive_correct,
    lapses: row.lapses,
    attempts: row.attempts,
    hits: row.hits,
    misses: row.attempts - row.hits,
    retired: Boolean(row.retired),
    stubborn: row.lapses >= 2,
    lastResult: row.last_result,
    history: JSON.parse(row.history || '[]'),
    year: meta ? meta.year : null,
    paper: meta ? meta.paper : null,
    number: meta ? meta.number : null,
    topics: meta ? meta.topics : [],
    trend: row.consecutive_correct >= 1 ? 'toward retirement'
      : row.lapses >= 2 ? 'keeps resetting' : 'in progress',
  };
}

function dueList(rows, now = Date.now()) {
  const cutoff = startOfDay(now) + DAY - 1;
  return rows
    .filter(r => !r.retired && r.due_at <= cutoff)
    .map(r => decorate(r, now))
    .sort((a, b) => {
      // most overdue first, then most stubborn, then the riskiest source
      if (b.overdueDays !== a.overdueDays) return b.overdueDays - a.overdueDays;
      if (b.lapses !== a.lapses) return b.lapses - a.lapses;
      return PRIORITY[a.source] - PRIORITY[b.source];
    });
}

function session(rows, now = Date.now(), cap = SESSION_CAP) {
  return dueList(rows, now).slice(0, cap);
}

function stubborn(rows, now = Date.now()) {
  return rows
    .filter(r => !r.retired && r.lapses >= 2)
    .map(r => decorate(r, now))
    .sort((a, b) => b.lapses - a.lapses || b.misses - a.misses);
}

function summary(rows, now = Date.now()) {
  const active = rows.filter(r => !r.retired);
  const due = dueList(rows, now);
  return {
    total: rows.length,
    active: active.length,
    retired: rows.length - active.length,
    due: due.length,
    overdue: due.filter(d => d.overdueDays > 0).length,
    stubborn: stubborn(rows, now).length,
    cap: SESSION_CAP,
    intervals: INTERVALS,
  };
}

module.exports = {
  INTERVALS, RETIRE_AFTER, SESSION_CAP, PRIORITY,
  applyResult, dueList, session, stubborn, summary, decorate, addDays, blank,
};
