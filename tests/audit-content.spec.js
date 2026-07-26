const { test, expect } = require('@playwright/test');
const { buildAudit } = require('./lib/audit');

let A;
test.beforeAll(() => { A = buildAudit(); });

test.describe('content completeness audit', () => {
  test('prints the audit table', () => {
    const lines = [];
    lines.push('');
    lines.push('Paper          Qs  crops  keys  tags  sols  ocr  distinct-answers');
    lines.push('─'.repeat(70));
    for (const r of A.rows) {
      lines.push(
        `${r.paper.padEnd(14)}${String(r.count).padStart(3)}  ${String(r.crops).padStart(5)}  ` +
        `${String(r.answers).padStart(4)}  ${String(r.tags).padStart(4)}  ` +
        `${String(r.solutions).padStart(4)}  ${String(r.ocrChecked).padStart(3)}  ` +
        `${String(r.distinct).padStart(6)}${r.isCore ? '' : '   (bonus)'}`);
    }
    lines.push('─'.repeat(70));
    lines.push(`core papers: ${A.totals.corePapers}/16   core questions: ${A.totals.coreQuestions}/320`);
    lines.push(`total shipped: ${A.totals.papers} papers, ${A.totals.questions} questions`);
    lines.push(`missing papers: ${A.missingPapers.length ? A.missingPapers.join(', ') : 'none'}`);
    lines.push(`extra papers:   ${A.extraPapers.length ? A.extraPapers.join(', ') + ' (intentional bonus)' : 'none'}`);
    lines.push('');
    lines.push('Year   P1 rows  P2 rows  overall rows');
    for (const c of A.convRows) {
      lines.push(`${c.year}   ${String(c.paper1).padStart(7)}  ${String(c.paper2).padStart(7)}  ${String(c.overall).padStart(12)}`);
    }
    lines.push('');
    lines.push(`median crop height: ${A.medianH}px`);
    lines.push(`warnings: ${A.warnings.length}`);
    for (const w of A.warnings.slice(0, 15)) lines.push(`  - ${w}`);
    console.log(lines.join('\n'));
  });

  test('exactly 16 core papers, 2016-2023 x P1/P2, no gaps or extras', () => {
    expect(A.missingPapers).toEqual([]);
    expect(A.unexpectedExtras).toEqual([]);
    expect(A.totals.corePapers).toBe(16);
    expect(A.totals.coreQuestions).toBe(320);
  });

  test('every paper has exactly 20 questions, numbered 1-20 with no duplicates', () => {
    for (const r of A.rows) expect(r.count, `${r.paper} question count`).toBe(20);
    const numbering = A.problems.filter(p => /gap —|duplicate question/.test(p));
    expect(numbering).toEqual([]);
  });

  test('every question has a valid, readable crop image', () => {
    const cropProblems = A.problems.filter(p => /crop (missing|is zero|does not decode|only )/.test(p));
    expect(cropProblems).toEqual([]);
    for (const r of A.rows) expect(r.crops, `${r.paper} crops`).toBe(20);
  });

  test('no crop is blank, mis-numbered, or an outlier in height', () => {
    const imgProblems = A.problems.filter(p =>
      /blank or near-blank|shows question number|height .* outlier|image analysis failed/.test(p));
    expect(imgProblems).toEqual([]);
  });

  test('every question has an answer key entry within the options actually present', () => {
    const keyProblems = A.problems.filter(p =>
      /no answer-key|implausible answer|beyond the .* options|shows option .* but only/.test(p));
    expect(keyProblems).toEqual([]);
    for (const r of A.rows) expect(r.answers, `${r.paper} answers`).toBe(20);
  });

  test('every question has valid topic tags from the fixed taxonomy', () => {
    const tagProblems = A.problems.filter(p =>
      /no topic tags|outside the taxonomy|surrounding whitespace|not lower-case|duplicate tags|non-string tag/.test(p));
    expect(tagProblems).toEqual([]);
    for (const r of A.rows) expect(r.tags, `${r.paper} tagged`).toBe(20);
  });

  test('every question links a worked solution (gaps listed explicitly)', () => {
    const solProblems = A.problems.filter(p => /solution does not decode/.test(p));
    expect(solProblems).toEqual([]);
    const gaps = A.warnings.filter(w => /no official worked solution/.test(w));
    // any gap is acceptable but must be surfaced, not silent
    console.log(`worked-solution gaps: ${gaps.length === 0 ? 'none' : gaps.join(', ')}`);
    for (const r of A.rows) expect(r.solutions, `${r.paper} solutions`).toBe(20);
  });

  test('answer letters are not suspiciously uniform within a paper', () => {
    const uniform = A.problems.filter(p => /distinct answer letters/.test(p));
    expect(uniform).toEqual([]);
    for (const r of A.rows) expect(r.distinct, `${r.paper} distinct letters`).toBeGreaterThanOrEqual(4);
  });

  test('an independent re-parse of every key PDF agrees with the stored answers', () => {
    const mismatches = A.problems.filter(p => /INDEPENDENT RE-PARSE DISAGREES/.test(p));
    expect(mismatches).toEqual([]);
  });

  test('conversion tables cover raw 0-20 for both papers with values in 1.0-9.0', () => {
    const convProblems = A.problems.filter(p =>
      /conversion table|outside 1\.0-9\.0|not monotonic|\.(paper1|paper2|overall)/.test(p));
    expect(convProblems).toEqual([]);
    expect(A.convRows.length).toBe(8);
    for (const c of A.convRows) {
      expect(c.paper1, `${c.year} P1 rows`).toBe(21);
      expect(c.paper2, `${c.year} P2 rows`).toBe(21);
    }
  });

  test('no orphaned images, answers, options or tags', () => {
    const orphans = A.problems.filter(p => /orphan/.test(p));
    expect(orphans).toEqual([]);
  });

  test('the audit finds no problems at all', () => {
    if (A.problems.length) {
      console.log('\nPROBLEMS:\n' + A.problems.map(p => '  - ' + p).join('\n'));
    }
    expect(A.problems).toEqual([]);
  });
});
