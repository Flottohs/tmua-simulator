"""Build the internal QA page (pipeline/qa.html) and per-paper contact sheets.

qa.html shows every question crop with its id, answer, detected option count,
and a link to its solution crop — open directly in a browser via file://.
Contact sheets (scratch dir) are 4x5 grids per paper for fast visual sweeps.
"""
import json
import pathlib
import sys
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
QDIR = ROOT / "assets" / "questions"
SHEETS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "pipeline" / "sheets"

answers = json.loads((DATA / "answers.json").read_text())
options = json.loads((DATA / "options.json").read_text())
manifest = json.loads((DATA / "crop-manifest.json").read_text())

# ---- qa.html ----
rows = []
for qid in sorted(manifest):
    rows.append(f"""
<div class="card">
  <div class="meta"><b>{qid}</b> &nbsp; answer: {answers.get(qid, '?')} &nbsp;
    options: {options.get(qid, '?')} &nbsp;
    <a href="../assets/solutions/{qid}.png">solution</a></div>
  <img loading="lazy" src="../assets/questions/{qid}.png">
</div>""")

html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>TMUA crop QA</title>
<style>
 body {{ font-family: system-ui; background:#f3f4f6; margin:20px; }}
 .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:14px; }}
 .card {{ background:#fff; border:1px solid #ddd; border-radius:8px; padding:10px; }}
 .card img {{ width:100%; height:auto; border:1px solid #eee; }}
 .meta {{ font-size:13px; margin-bottom:6px; color:#333; }}
</style></head><body>
<h2>TMUA question crops — {len(rows)} questions</h2>
<div class="grid">{''.join(rows)}</div>
</body></html>"""
(ROOT / "pipeline" / "qa.html").write_text(html)
print("wrote pipeline/qa.html")

# ---- contact sheets ----
SHEETS.mkdir(parents=True, exist_ok=True)
papers = sorted({qid.rsplit("-Q", 1)[0] for qid in manifest})
CELL_W, PAD, LABEL_H = 360, 8, 0
for paper in papers:
    qids = [f"{paper}-Q{n:02d}" for n in range(1, 21)]
    thumbs = []
    for qid in qids:
        pm = fitz.Pixmap(str(QDIR / f"{qid}.png"))
        scale = CELL_W / pm.width
        th = fitz.Pixmap(pm, int(pm.width * scale), int(pm.height * scale), None)
        thumbs.append(th)
    cols, rows_n = 4, 5
    col_h = [0] * cols
    cell_h = max(th.height for th in thumbs) + PAD
    W = cols * (CELL_W + PAD) + PAD
    H = rows_n * cell_h + PAD
    sheet = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, W, H))
    sheet.set_rect(sheet.irect, (235,))
    for i, th in enumerate(thumbs):
        r, c = divmod(i, cols)
        x = PAD + c * (CELL_W + PAD)
        y = PAD + r * cell_h
        g = fitz.Pixmap(fitz.csGRAY, th)  # ensure gray
        g.set_origin(x, y)
        sheet.copy(g, fitz.IRect(x, y, x + g.width, y + g.height))
    sheet.save(SHEETS / f"{paper}.png")
print(f"wrote {len(papers)} contact sheets to {SHEETS}")
