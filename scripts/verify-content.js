#!/usr/bin/env node
// Content integrity check: every paper has 20 questions, and every question
// has a crop, an answer, topic tags, and a worked solution.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/questions.json'), 'utf8'));
const conversions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/conversions.json'), 'utf8'));
const answers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/answers.json'), 'utf8'));

const problems = [];
const note = (m) => problems.push(m);

const byPaper = new Map();
for (const q of data.questions) {
  const key = `${q.year}-P${q.paper}`;
  if (!byPaper.has(key)) byPaper.set(key, []);
  byPaper.get(key).push(q);
}

console.log('Paper                Qs  crops  answers  topics  solutions  conversion');
console.log('─'.repeat(74));

let totalQ = 0, totalCrops = 0, totalSol = 0;
for (const [key, qs] of [...byPaper.entries()].sort()) {
  qs.sort((a, b) => a.number - b.number);
  const numbers = qs.map(q => q.number);
  if (numbers.length !== 20) note(`${key}: ${numbers.length} questions (expected 20)`);
  for (let i = 1; i <= 20; i++) if (!numbers.includes(i)) note(`${key}: missing question ${i}`);

  let crops = 0, sols = 0, withAns = 0, withTopics = 0;
  for (const q of qs) {
    const img = path.join(ROOT, 'assets', q.image);
    const sol = path.join(ROOT, 'assets', q.solutionImage);
    if (fs.existsSync(img) && fs.statSync(img).size > 2000) crops++;
    else note(`${q.id}: missing or tiny question crop`);
    if (fs.existsSync(sol) && fs.statSync(sol).size > 2000) sols++;
    else note(`${q.id}: missing or tiny solution crop`);
    if (q.answer && /^[A-H]$/.test(q.answer)) withAns++;
    else note(`${q.id}: bad answer '${q.answer}'`);
    if (answers[q.id] !== q.answer) note(`${q.id}: answers.json disagrees with questions.json`);
    if (Array.isArray(q.topics) && q.topics.length >= 1) withTopics++;
    else note(`${q.id}: no topic tags`);
    for (const t of q.topics || []) {
      if (!data.taxonomy[t]) note(`${q.id}: unknown topic '${t}'`);
    }
    if (!q.options || q.options < 2) note(`${q.id}: implausible option count ${q.options}`);
    const need = q.answer.charCodeAt(0) - 64;
    if (q.options < need) note(`${q.id}: answer ${q.answer} exceeds ${q.options} options`);
  }
  totalQ += qs.length; totalCrops += crops; totalSol += sols;
  const year = key.split('-')[0];
  const conv = conversions[year] ? 'yes' : (year === 'specimen' ? 'n/a' : 'MISSING');
  console.log(
    `${key.padEnd(20)} ${String(qs.length).padStart(2)}  ${String(crops).padStart(5)}  ` +
    `${String(withAns).padStart(7)}  ${String(withTopics).padStart(6)}  ` +
    `${String(sols).padStart(9)}  ${conv.padStart(10)}`);
}

// conversion table sanity
for (const [year, t] of Object.entries(conversions)) {
  for (const key of ['paper1', 'paper2']) {
    const tbl = t[key];
    if (!tbl) { note(`${year}.${key}: missing`); continue; }
    for (let r = 0; r <= 20; r++) {
      const v = tbl[String(r)];
      if (typeof v !== 'number' || v < 1 || v > 9) note(`${year}.${key}[${r}]: bad value ${v}`);
    }
    for (let r = 1; r <= 20; r++) {
      if (tbl[String(r)] < tbl[String(r - 1)]) note(`${year}.${key}: not monotonic at raw ${r}`);
    }
  }
  if (t.overall) {
    for (let r = 0; r <= 40; r++) {
      const v = t.overall[String(r)];
      if (typeof v !== 'number' || v < 1 || v > 9) note(`${year}.overall[${r}]: bad value ${v}`);
    }
  }
}

console.log('─'.repeat(74));
console.log(`Totals: ${totalQ} questions · ${totalCrops} crops · ${totalSol} solutions · ` +
  `${Object.keys(conversions).length} conversion years`);

const topicCounts = {};
for (const q of data.questions) for (const t of q.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
const untagged = Object.keys(data.taxonomy).filter(t => !topicCounts[t]);
if (untagged.length) note(`taxonomy entries never used: ${untagged.join(', ')}`);

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems.slice(0, 40)) console.log('  -', p);
  process.exit(1);
}
console.log('\nAll content checks passed.');
