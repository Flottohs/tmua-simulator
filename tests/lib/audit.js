// Shared content-audit logic: pure data checks over the built content.
// Used by tests/audit-content.spec.js.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

const CORE_YEARS = ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023'];
const BONUS_YEARS = ['specimen'];   // shipped as an extra, not part of the 16

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

// Structural PNG validation without a decoding dependency: verify the
// signature, walk every chunk verifying its CRC32, and read IHDR.
function inspectPng(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) {
    return { ok: false, reason: 'not a PNG' };
  }
  let off = 8, width = 0, height = 0, sawIHDR = false, sawIEND = false, idat = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return { ok: false, reason: `truncated ${type} chunk` };
    const stored = buf.readUInt32BE(dataEnd);
    const actual = zlib.crc32
      ? zlib.crc32(buf.subarray(off + 4, dataEnd))
      : crc32(buf.subarray(off + 4, dataEnd));
    if ((actual >>> 0) !== stored) return { ok: false, reason: `bad CRC on ${type}` };
    if (type === 'IHDR') {
      sawIHDR = true;
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
    }
    if (type === 'IDAT') idat += len;
    if (type === 'IEND') { sawIEND = true; break; }
    off = dataEnd + 4;
  }
  if (!sawIHDR) return { ok: false, reason: 'no IHDR' };
  if (!sawIEND) return { ok: false, reason: 'no IEND' };
  if (idat === 0) return { ok: false, reason: 'no image data' };
  return { ok: true, width, height, bytes: buf.length, idat };
}

// fallback CRC32 for runtimes without zlib.crc32
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function buildAudit() {
  const content = load('questions.json');
  const answers = load('answers.json');
  const reparsed = load('answers-reparsed.json');
  const conversions = load('conversions.json');
  const options = load('options.json');
  const ocrPath = path.join(DATA, 'crop-ocr.json');
  const ocr = fs.existsSync(ocrPath) ? JSON.parse(fs.readFileSync(ocrPath, 'utf8')) : {};

  const problems = [];
  const warnings = [];
  const fail = (m) => problems.push(m);
  const warn = (m) => warnings.push(m);

  // ---- paper inventory ----
  const expected = new Set();
  for (const y of CORE_YEARS) for (const p of [1, 2]) expected.add(`${y}-P${p}`);
  const present = new Map();
  for (const q of content.questions) {
    const key = `${q.year}-P${q.paper}`;
    if (!present.has(key)) present.set(key, []);
    present.get(key).push(q);
  }
  const missingPapers = [...expected].filter(k => !present.has(k));
  const extraPapers = [...present.keys()].filter(k => !expected.has(k));
  for (const m of missingPapers) fail(`missing paper: ${m}`);
  const unexpectedExtras = extraPapers.filter(
    k => !BONUS_YEARS.some(b => k.startsWith(b + '-')));
  for (const e of unexpectedExtras) fail(`unexpected extra paper: ${e}`);

  // ---- per-paper checks ----
  const rows = [];
  const heights = [];
  for (const q of content.questions) {
    const o = ocr[q.id];
    if (o && !o.error) heights.push(o.h);
  }
  heights.sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  for (const key of [...expected, ...extraPapers.filter(k => !unexpectedExtras.includes(k))]) {
    const qs = (present.get(key) || []).slice().sort((a, b) => a.number - b.number);
    const row = {
      paper: key, count: qs.length, crops: 0, answers: 0, tags: 0, solutions: 0,
      ocrChecked: 0, isCore: expected.has(key),
    };

    const numbers = qs.map(q => q.number);
    const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    if (dupes.length) fail(`${key}: duplicate question numbers ${[...new Set(dupes)].join(',')}`);
    for (let n = 1; n <= 20; n++) {
      if (!numbers.includes(n)) fail(`${key}: gap — no question ${n}`);
    }
    if (qs.length !== 20) fail(`${key}: ${qs.length} questions (expected 20)`);

    for (const q of qs) {
      // crop image
      const img = path.join(ROOT, 'assets', q.image);
      if (!fs.existsSync(img)) { fail(`${q.id}: crop missing`); }
      else if (fs.statSync(img).size === 0) { fail(`${q.id}: crop is zero bytes`); }
      else {
        const info = inspectPng(img);
        if (!info.ok) fail(`${q.id}: crop does not decode (${info.reason})`);
        else {
          row.crops++;
          if (info.height < 300) fail(`${q.id}: crop only ${info.height}px tall — unreadable`);
          if (info.width < 900) fail(`${q.id}: crop only ${info.width}px wide — below 200dpi A4 body`);
        }
      }

      // solution image
      const sol = path.join(ROOT, 'assets', q.solutionImage);
      if (fs.existsSync(sol) && fs.statSync(sol).size > 0) {
        const si = inspectPng(sol);
        if (!si.ok) fail(`${q.id}: solution does not decode (${si.reason})`);
        else row.solutions++;
      } else {
        warn(`${q.id}: no official worked solution`);
      }

      // answer key
      const a = answers[q.id];
      if (!a) fail(`${q.id}: no answer-key entry`);
      else if (!/^[A-H]$/.test(a)) fail(`${q.id}: implausible answer '${a}'`);
      else row.answers++;
      if (q.answer !== a) fail(`${q.id}: questions.json answer '${q.answer}' != answers.json '${a}'`);

      // independent re-parse must agree
      if (reparsed[q.id] !== a) {
        fail(`${q.id}: INDEPENDENT RE-PARSE DISAGREES — key says '${reparsed[q.id]}', stored '${a}'`);
      }

      // topic tags
      if (!Array.isArray(q.topics) || q.topics.length === 0) fail(`${q.id}: no topic tags`);
      else {
        row.tags++;
        for (const t of q.topics) {
          if (typeof t !== 'string') { fail(`${q.id}: non-string tag`); continue; }
          if (t !== t.trim()) fail(`${q.id}: tag '${t}' has surrounding whitespace`);
          if (t !== t.toLowerCase()) fail(`${q.id}: tag '${t}' is not lower-case`);
          if (!content.taxonomy[t]) fail(`${q.id}: tag '${t}' is outside the taxonomy`);
        }
        if (new Set(q.topics).size !== q.topics.length) fail(`${q.id}: duplicate tags`);
      }

      // option count and answer-in-range
      const opts = options[q.id];
      if (typeof opts !== 'number' || opts < 2 || opts > 8) {
        fail(`${q.id}: implausible option count ${opts}`);
      } else if (a && /^[A-H]$/.test(a)) {
        const idx = a.charCodeAt(0) - 64;
        if (idx > opts) fail(`${q.id}: answer ${a} is beyond the ${opts} options present`);
      }
      if (q.options !== opts) fail(`${q.id}: questions.json options ${q.options} != options.json ${opts}`);

      // OCR cross-checks on the rendered crop (independent of the PDF text layer)
      const o = ocr[q.id];
      if (!o) { warn(`${q.id}: no OCR record`); }
      else if (o.error) { fail(`${q.id}: image analysis failed (${o.error})`); }
      else {
        row.ocrChecked++;
        if (o.ink < 0.002) fail(`${q.id}: crop is blank or near-blank (ink ${o.ink})`);
        if (o.qnum !== null && o.qnum !== q.number) {
          fail(`${q.id}: crop shows question number ${o.qnum}, labelled ${q.number}`);
        }
        if (o.qnum === null) warn(`${q.id}: could not OCR the question number`);
        // OCR under-detects letters, so only the upper direction is a failure:
        // seeing a letter beyond the claimed option count is a real contradiction
        if (o.highest) {
          const seen = o.highest.charCodeAt(0) - 64;
          if (seen > opts) {
            fail(`${q.id}: crop shows option ${o.highest} but only ${opts} options recorded`);
          }
        }
        if (medianH && (o.h > medianH * 3 || o.h < medianH * 0.28)) {
          fail(`${q.id}: crop height ${o.h}px is an outlier vs median ${medianH}px ` +
            `— may span two questions or be truncated`);
        }
      }
    }

    // uniformity: a parse failure often yields all-identical letters
    const letters = qs.map(q => answers[q.id]).filter(Boolean);
    const distinct = new Set(letters).size;
    if (letters.length === 20 && distinct <= 2) {
      fail(`${key}: only ${distinct} distinct answer letters across 20 questions — suspect parse failure`);
    }
    row.distinct = distinct;
    rows.push(row);
  }

  // ---- conversion tables ----
  const convRows = [];
  for (const y of CORE_YEARS) {
    const t = conversions[y];
    if (!t) { fail(`${y}: no conversion table`); continue; }
    const r = { year: y, paper1: 0, paper2: 0, overall: 0 };
    for (const k of ['paper1', 'paper2']) {
      const tbl = t[k];
      if (!tbl) { fail(`${y}.${k}: missing`); continue; }
      for (let raw = 0; raw <= 20; raw++) {
        const v = tbl[String(raw)];
        if (typeof v !== 'number') { fail(`${y}.${k}[${raw}]: missing`); continue; }
        if (v < 1.0 || v > 9.0) fail(`${y}.${k}[${raw}]: ${v} outside 1.0-9.0`);
        r[k]++;
      }
      for (let raw = 1; raw <= 20; raw++) {
        if (tbl[String(raw)] < tbl[String(raw - 1)]) {
          fail(`${y}.${k}: not monotonic at raw ${raw}`);
        }
      }
    }
    if (t.overall) {
      for (let raw = 0; raw <= 40; raw++) {
        const v = t.overall[String(raw)];
        if (typeof v !== 'number' || v < 1 || v > 9) fail(`${y}.overall[${raw}]: bad value ${v}`);
        else r.overall++;
      }
    }
    convRows.push(r);
  }

  // ---- orphans ----
  const validIds = new Set(content.questions.map(q => q.id));
  for (const id of Object.keys(answers)) {
    if (!validIds.has(id)) fail(`orphan answer for nonexistent question ${id}`);
  }
  for (const id of Object.keys(options)) {
    if (!validIds.has(id)) fail(`orphan option count for nonexistent question ${id}`);
  }
  for (const id of Object.keys(ocr)) {
    if (!validIds.has(id)) fail(`orphan crop image ${id}.png with no question record`);
  }
  const cropFiles = fs.readdirSync(path.join(ROOT, 'assets', 'questions'))
    .filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, ''));
  for (const f of cropFiles) {
    if (!validIds.has(f)) fail(`orphan crop file ${f}.png`);
  }
  const usedTags = new Set(content.questions.flatMap(q => q.topics));
  for (const t of Object.keys(content.taxonomy)) {
    if (!usedTags.has(t)) warn(`taxonomy entry '${t}' is never used`);
  }

  return {
    rows, convRows, problems, warnings,
    missingPapers, extraPapers, unexpectedExtras,
    totals: {
      papers: present.size,
      corePapers: [...present.keys()].filter(k => expected.has(k)).length,
      questions: content.questions.length,
      coreQuestions: content.questions.filter(q => CORE_YEARS.includes(q.year)).length,
    },
    medianH,
  };
}

module.exports = { buildAudit, inspectPng, CORE_YEARS, BONUS_YEARS, ROOT };
