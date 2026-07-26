// Static question content: bundled inside the app package, read-only.
// In dev the files live in the repo; when packaged they are copied to
// process.resourcesPath/content by electron-builder.
const path = require('path');
const fs = require('fs');

let contentDir = null;
let questions = [];
let byId = new Map();
let conversions = {};
let taxonomy = {};

function resolveContentDir(appPath, resourcesPath, isPackaged) {
  if (isPackaged) return path.join(resourcesPath, 'content');
  return path.join(appPath, 'data');   // dev: data/questions.json + ../assets
}

function init({ appPath, resourcesPath, isPackaged }) {
  contentDir = resolveContentDir(appPath, resourcesPath, isPackaged);
  const qFile = path.join(contentDir, 'questions.json');
  const cFile = path.join(contentDir, 'conversions.json');
  const parsed = JSON.parse(fs.readFileSync(qFile, 'utf8'));
  questions = parsed.questions;
  taxonomy = parsed.taxonomy;
  conversions = JSON.parse(fs.readFileSync(cFile, 'utf8'));
  byId = new Map(questions.map(q => [q.id, q]));

  // image roots differ between dev and packaged layouts
  const imageRoot = isPackaged ? contentDir : path.join(appPath, 'assets');
  for (const q of questions) {
    q.imagePath = path.join(imageRoot, q.image);
    q.solutionPath = path.join(imageRoot, q.solutionImage);
  }
  return { count: questions.length, contentDir };
}

// The renderer never sees answers for questions in a live attempt.
function publicQuestion(q) {
  return {
    id: q.id, year: q.year, paper: q.paper, number: q.number,
    options: q.options, topics: q.topics,
    image: `tmua-img://question/${q.id}`,
  };
}

function fullQuestion(q) {
  return {
    ...publicQuestion(q),
    answer: q.answer,
    solution: `tmua-img://solution/${q.id}`,
  };
}

function get(id) { return byId.get(id); }
function all() { return questions; }
function getTaxonomy() { return taxonomy; }

function papers() {
  const seen = new Map();
  for (const q of questions) {
    const key = `${q.year}-P${q.paper}`;
    if (!seen.has(key)) seen.set(key, { key, year: q.year, paper: q.paper, count: 0 });
    seen.get(key).count++;
  }
  return [...seen.values()].sort((a, b) =>
    a.year === b.year ? a.paper - b.paper : a.year.localeCompare(b.year));
}

function paperQuestions(year, paper) {
  return questions
    .filter(q => q.year === year && q.paper === paper)
    .sort((a, b) => a.number - b.number);
}

// raw -> 1.0-9.0 scaled score, where a table exists for that year
function scaledScore(year, paper, raw) {
  const table = conversions[year];
  if (!table) return null;
  const key = paper === 1 ? 'paper1' : paper === 2 ? 'paper2' : 'overall';
  const t = table[key];
  if (!t) return null;
  const v = t[String(raw)];
  return v === undefined ? null : v;
}

function overallScaled(year, rawTotal) {
  const table = conversions[year];
  if (!table || !table.overall) return null;
  const v = table.overall[String(rawTotal)];
  return v === undefined ? null : v;
}

function hasConversion(year) { return Boolean(conversions[year]); }

// Years that have an official published conversion table, oldest first.
function conversionYears() {
  return Object.keys(conversions).sort();
}

// Raw table for a year/key, or null when that year has none published.
function rawTable(year, key) {
  const t = conversions[year];
  return t && t[key] ? t[key] : null;
}

// Average number of questions per paper carrying each topic, across the bank.
// This is what turns a topic accuracy into expected marks lost per paper.
let perPaperCache = null;
function topicsPerPaper() {
  if (perPaperCache) return perPaperCache;
  const paperKeys = new Set(questions.map(q => `${q.year}-${q.paper}`));
  const counts = {};
  for (const q of questions) {
    for (const t of q.topics) counts[t] = (counts[t] || 0) + 1;
  }
  const n = paperKeys.size || 1;
  perPaperCache = {};
  for (const [t, c] of Object.entries(counts)) perPaperCache[t] = c / n;
  return perPaperCache;
}

// Probability of a blind guess landing, averaged over the bank's option counts.
let randomRateCache = null;
function averageRandomRate() {
  if (randomRateCache !== null) return randomRateCache;
  const sum = questions.reduce((s, q) => s + 1 / (q.options || 8), 0);
  randomRateCache = questions.length ? sum / questions.length : 0.2;
  return randomRateCache;
}

function imageFileFor(kind, id) {
  const q = byId.get(id);
  if (!q) return null;
  return kind === 'solution' ? q.solutionPath : q.imagePath;
}

module.exports = {
  init, get, all, publicQuestion, fullQuestion, papers, paperQuestions,
  scaledScore, overallScaled, hasConversion, getTaxonomy, imageFileFor,
  conversionYears, rawTable, topicsPerPaper, averageRandomRate,
};
