// Printable PDF export, built with Electron's own printToPDF in an offscreen
// window. No dependency and no network: the page is assembled from the same
// bundled crops the app already uses.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const url = require('url');
const content = require('./content');

function esc(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fileUrl(p) { return url.pathToFileURL(p).toString(); }

const CSS = `
  @page { size: A4; margin: 14mm 12mm 16mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.45 Georgia, "Times New Roman", serif; color: #111; margin: 0; }
  .cover { text-align: center; padding-top: 60mm; page-break-after: always; }
  .cover h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: .01em; }
  .cover .sub { font-size: 14px; color: #444; margin-bottom: 30px; }
  .cover .rules { text-align: left; max-width: 120mm; margin: 0 auto; font-size: 12px; }
  .cover .rules li { margin-bottom: 6px; }
  .q { page-break-inside: avoid; margin-bottom: 10mm; }
  .q + .q { border-top: 1px solid #e2e2e2; padding-top: 7mm; }
  .q img { width: 100%; height: auto; display: block; }
  .working { border: 1px dashed #bbb; height: var(--work, 34mm); margin-top: 4mm;
             border-radius: 3px; position: relative; }
  .working::after { content: 'working'; position: absolute; top: 2mm; left: 2mm;
                    font-size: 9px; color: #aaa; letter-spacing: .08em; text-transform: uppercase; }
  .pagebreak { page-break-after: always; }
  h2 { font-size: 15px; margin: 0 0 5mm; }
  table.answers { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.answers td, table.answers th { border: 1px solid #999; padding: 5px 7px; text-align: center; }
  table.answers th { background: #f0f0f0; }
  .foot { position: running(foot); }
  .meta { font-size: 10px; color: #777; margin-bottom: 6mm; }
`;

function questionBlock(q, { working }) {
  const img = content.imageFileFor('question', q.id);
  if (!img || !fs.existsSync(img)) return '';
  return `<div class="q">
    <img src="${esc(fileUrl(img))}" alt="Question ${q.number}">
    ${working ? `<div class="working"></div>` : ''}
  </div>`;
}

function answerSheet(questions) {
  const rows = questions.map(q => {
    const letters = 'ABCDEFGH'.slice(0, q.options).split('')
      .map(L => `<td>${L}</td>`).join('');
    const pad = Array.from({ length: 8 - q.options }, () => '<td style="border:0"></td>').join('');
    return `<tr><th>${q.number}</th>${letters}${pad}</tr>`;
  }).join('');
  return `<div class="pagebreak"></div>
    <h2>Answer sheet</h2>
    <p class="meta">Circle one option per question.</p>
    <table class="answers"><tbody>${rows}</tbody></table>`;
}

function markScheme(questions, title) {
  const rows = questions.map(q => `<tr><th>${q.number}</th><td>${q.answer}</td></tr>`).join('');
  return `<div class="pagebreak"></div>
    <h2>Mark scheme — ${esc(title)}</h2>
    <table class="answers"><tbody>${rows}</tbody></table>`;
}

function buildHtml({ title, subtitle, questions, working, includeAnswerSheet, includeMarkScheme, minutes }) {
  const cover = `<div class="cover">
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle)}</div>
    <ul class="rules">
      <li>${questions.length} multiple-choice questions.</li>
      <li>Time allowed: ${minutes} minutes.</li>
      <li>Calculators are <b>not</b> permitted.</li>
      <li>There is no negative marking — answer every question.</li>
    </ul>
  </div>`;
  const body = questions.map(q => questionBlock(q, { working })).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>${esc(title)}</title><style>${CSS}</style></head>
    <body>${cover}${body}
    ${includeAnswerSheet ? answerSheet(questions) : ''}
    ${includeMarkScheme ? markScheme(questions, title) : ''}
    </body></html>`;
}

// Render HTML to a PDF file in a hidden window that can only load local files.
async function renderToFile(html, outPath) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, images: true, sandbox: false },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // give the bundled images a moment to decode before printing
    await new Promise(r => setTimeout(r, 400));
    const buf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'default' },
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return { path: outPath, bytes: buf.length };
  } finally {
    win.destroy();
  }
}

async function exportPaper({ year, paper, outPath, working = true,
                             includeAnswerSheet = false, includeMarkScheme = false, minutes = 93 }) {
  const questions = content.paperQuestions(year, paper);
  if (!questions.length) throw new Error(`No such paper: ${year} Paper ${paper}`);
  const label = year === 'specimen' ? 'Specimen' : year;
  const html = buildHtml({
    title: `TMUA ${label} — Paper ${paper}`,
    subtitle: 'Test of Mathematics for University Admission',
    questions, working, includeAnswerSheet, includeMarkScheme, minutes,
  });
  return renderToFile(html, outPath);
}

async function exportDrill({ questionIds, outPath, title = 'TMUA custom drill',
                             working = true, includeMarkScheme = false, minutes = 60 }) {
  const questions = questionIds.map(id => content.get(id)).filter(Boolean);
  if (!questions.length) throw new Error('No questions in this drill');
  const html = buildHtml({
    title,
    subtitle: `${questions.length} questions selected from your practice history`,
    questions, working, includeAnswerSheet: false, includeMarkScheme, minutes,
  });
  return renderToFile(html, outPath);
}

module.exports = { exportPaper, exportDrill, buildHtml };
