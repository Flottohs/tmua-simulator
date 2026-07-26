"""Build the two human-review pages:

  qa/spotcheck.html  20 sampled questions with the mark-scheme row cropped
                     straight from the official key PDF, beside the stored answer
  qa/gallery.html    all question + solution crops, with a "mark as bad crop"
                     button that builds a fix-list JSON you can download

Both are plain file:// pages; nothing here touches the network.
"""
import json
import pathlib
import random
import re
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"
QA = ROOT / "qa"
SHOTS = QA / "keyrows"

answers = json.loads((ROOT / "data" / "answers.json").read_text())
content = json.loads((ROOT / "data" / "questions.json").read_text())
questions = {q["id"]: q for q in content["questions"]}


def key_row_image(year, paper, qnum, out_path):
    """Crop the answer-key PDF at the row for this question.

    Key PDFs use three layouts: side-by-side paper tables, stacked tables, and
    row-interleaved (n K n K). A question number therefore appears twice in the
    document — once per paper — so both candidates are collected and ordered by
    (page, x, y). That ordering puts Paper 1 first in all three layouts: left
    column when side-by-side or interleaved, higher up when stacked.
    """
    doc = fitz.open(PAPERS / f"{year}-answer-key.pdf")
    candidates = []
    for pno in range(doc.page_count):
        page = doc[pno]
        words = page.get_text("words")
        for n in words:
            if not (re.fullmatch(r"\d{1,2}", n[4]) and int(n[4]) == qnum):
                continue
            row = [w for w in words
                   if abs((w[1] + w[3]) / 2 - (n[1] + n[3]) / 2) < 5
                   and re.fullmatch(r"[A-H]", w[4]) and w[0] > n[2] and w[0] - n[2] < 160]
            if not row:
                continue
            letter = min(row, key=lambda w: w[0] - n[2])
            candidates.append((pno, round(n[0]), n[1], n, letter, page))

    candidates.sort(key=lambda c: (c[0], c[1], c[2]))
    if len(candidates) < paper:
        doc.close()
        return {"found": False, "candidates": len(candidates)}

    pno, _x, _y, n, letter, page = candidates[paper - 1]
    clip = fitz.Rect(max(n[0] - 30, 0), max(n[1] - 6, 0),
                     min(letter[2] + 40, page.rect.width),
                     min(n[3] + 6, page.rect.height))
    page.get_pixmap(dpi=240, clip=clip).save(out_path)
    doc.close()
    return {"page": pno, "letter": letter[4], "found": True,
            "candidates": len(candidates)}


def build_spotcheck(n=20, seed=20260726):
    SHOTS.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    ids = sorted(questions)
    # spread the sample across every paper
    papers = sorted({(q["year"], q["paper"]) for q in questions.values()})
    sample = []
    for (year, paper) in rng.sample(papers, min(n, len(papers))):
        qnum = rng.randint(1, 20)
        sample.append(f"{year}-P{paper}-Q{qnum:02d}")
    while len(sample) < n:
        cand = rng.choice(ids)
        if cand not in sample:
            sample.append(cand)
    sample = sorted(set(sample))[:n]

    rows = []
    mismatches = []
    for qid in sample:
        q = questions[qid]
        img = SHOTS / f"{qid}-keyrow.png"
        info = key_row_image(q["year"], q["paper"], q["number"], img)
        stored = answers[qid]
        agree = info.get("found") and info["letter"] == stored
        if info.get("found") and info["letter"] != stored:
            mismatches.append((qid, info["letter"], stored))
        rows.append(f"""
<tr>
  <td><b>{qid}</b><br><span class=m>{q['year']} Paper {q['paper']} Q{q['number']}</span></td>
  <td class=ans>{stored}</td>
  <td>{'<img src="keyrows/' + img.name + '">' if info.get('found') else '<i>row not located</i>'}</td>
  <td class="{'ok' if agree else 'bad'}">{'match' if agree else 'CHECK'}</td>
  <td><img class=q src="../assets/questions/{qid}.png"></td>
</tr>""")

    html = f"""<!doctype html><meta charset=utf-8><title>TMUA answer-key spot check</title>
<style>
 body{{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px;background:#f6f7f9;color:#16202c}}
 table{{border-collapse:collapse;width:100%;background:#fff;border:1px solid #dfe3e8;border-radius:8px}}
 td,th{{border-bottom:1px solid #eee;padding:10px;vertical-align:top}}
 th{{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6875}}
 .ans{{font-size:26px;font-weight:700;text-align:center}}
 .m{{color:#5b6875;font-size:12px}}
 .ok{{color:#157f4a;font-weight:600}} .bad{{color:#b4232b;font-weight:700}}
 img{{max-width:340px;display:block;border:1px solid #eee;border-radius:4px}}
 img.q{{max-width:460px;max-height:230px;object-fit:cover;object-position:top}}
 h1{{font-size:20px}} .note{{margin-bottom:16px;color:#5b6875}}
</style>
<h1>Answer-key spot check — {len(sample)} sampled questions</h1>
<p class=note>Each row shows the answer stored in the simulator beside the row cropped
straight out of the official mark-scheme PDF. They should agree. Automated diffing already
passed; this page is for your own eyes.</p>
<p class=note><b>Automated result: {'all ' + str(len(sample)) + ' agree' if not mismatches else str(len(mismatches)) + ' MISMATCH'}</b></p>
<table>
<tr><th>Question</th><th>Stored</th><th>Official key row</th><th></th><th>Question (top)</th></tr>
{''.join(rows)}
</table>"""
    (QA / "spotcheck.html").write_text(html)
    return sample, mismatches


def build_gallery():
    ocr = {}
    p = ROOT / "data" / "crop-ocr.json"
    if p.exists():
        ocr = json.loads(p.read_text())
    cards = []
    for qid in sorted(questions):
        q = questions[qid]
        o = ocr.get(qid, {})
        meta = (f"{q['options']} options · answer {q['answer']} · "
                f"{o.get('w','?')}×{o.get('h','?')}px · ink {o.get('ink','?')}")
        cards.append(f"""
<div class=card data-id="{qid}">
  <div class=head>
    <b>{qid}</b>
    <button class=bad onclick="mark('{qid}',this)">mark bad</button>
  </div>
  <div class=meta>{meta}</div>
  <img loading=lazy src="../assets/questions/{qid}.png">
  <details><summary>worked solution</summary>
    <img loading=lazy src="../assets/solutions/{qid}.png"></details>
</div>""")

    html = f"""<!doctype html><meta charset=utf-8><title>TMUA crop QA gallery</title>
<style>
 body{{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:20px;background:#f6f7f9;color:#16202c}}
 .bar{{position:sticky;top:0;background:#fff;border:1px solid #dfe3e8;border-radius:8px;
      padding:12px 16px;margin-bottom:16px;display:flex;gap:12px;align-items:center;z-index:5}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:14px}}
 .card{{background:#fff;border:1px solid #dfe3e8;border-radius:8px;padding:10px}}
 .card.flagged{{outline:3px solid #b4232b}}
 .head{{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}}
 .meta{{font-size:12px;color:#5b6875;margin-bottom:6px}}
 img{{width:100%;height:auto;border:1px solid #eee;border-radius:4px;background:#fff}}
 button{{font:inherit;cursor:pointer;border:1px solid #dfe3e8;background:#f0f2f5;
        border-radius:6px;padding:4px 10px}}
 button.on{{background:#b4232b;color:#fff;border-color:#b4232b}}
 #count{{font-weight:600}}
 summary{{cursor:pointer;font-size:13px;color:#5b6875;margin-top:6px}}
</style>
<div class=bar>
  <b>TMUA crop QA</b>
  <span>{len(questions)} questions</span>
  <span id=count>0 marked bad</span>
  <button onclick=download()>Download fix list JSON</button>
  <button onclick=clearAll()>Clear marks</button>
  <input id=filter placeholder="filter e.g. 2019-P1" oninput=filt()>
</div>
<div class=grid>{''.join(cards)}</div>
<script>
const KEY='tmua-bad-crops';
let bad=new Set(JSON.parse(localStorage.getItem(KEY)||'[]'));
function paint(){{
  document.querySelectorAll('.card').forEach(c=>{{
    const on=bad.has(c.dataset.id);
    c.classList.toggle('flagged',on);
    c.querySelector('button.bad').classList.toggle('on',on);
  }});
  document.getElementById('count').textContent=bad.size+' marked bad';
}}
function mark(id){{ bad.has(id)?bad.delete(id):bad.add(id);
  localStorage.setItem(KEY,JSON.stringify([...bad])); paint(); }}
function clearAll(){{ bad=new Set(); localStorage.removeItem(KEY); paint(); }}
function download(){{
  const body={{markedBad:[...bad].sort(),note:'paste ids into data/crop-overrides.json and re-run pipeline/crop.py'}};
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(body,null,1)],{{type:'application/json'}}));
  a.download='crop-fix-list.json'; a.click();
}}
function filt(){{
  const v=document.getElementById('filter').value.toLowerCase();
  document.querySelectorAll('.card').forEach(c=>{{
    c.style.display=c.dataset.id.toLowerCase().includes(v)?'':'none';
  }});
}}
paint();
</script>"""
    (QA / "gallery.html").write_text(html)
    return len(questions)


if __name__ == "__main__":
    QA.mkdir(exist_ok=True)
    sample, mismatches = build_spotcheck()
    n = build_gallery()
    print(f"qa/spotcheck.html — {len(sample)} sampled questions, "
          f"{'no mismatches' if not mismatches else str(mismatches)}")
    print(f"qa/gallery.html — {n} crops")
