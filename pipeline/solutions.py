"""Crop per-question worked solutions from the -ms PDFs.

Every solutions doc is LaTeX-set with bold 'Question N' headings at page top
(one or two pages per question). Section = heading page through the page
before the next heading (or before back matter). Multi-page sections are
stacked into one PNG.

Outputs assets/solutions/{qid}.png, data/solution-manifest.json, and a
cross-check of 'the answer is X' statements against data/answers.json.
"""
import json
import pathlib
import re
import fitz
from quartz_render import crop_points

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"
OUT = ROOT / "assets" / "solutions"
DATA = ROOT / "data"
DPI = 200
BACK_MATTER = re.compile(r"We are Cambridge Assessment|accessibility standard|WCAG|"
                         r"Our research-based", re.I)
ANSWER_RE = re.compile(r"answer is(?: therefore)?(?: option)?[:\s]+\(?([A-H])\)?[\s.,:]", )

YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "specimen"]

def find_headings(doc):
    heads = []
    for pno in range(doc.page_count):
        for block in doc[pno].get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                spans = line["spans"]
                text = "".join(s["text"] for s in spans).strip()
                m = re.fullmatch(r"Question\s+(\d{1,2})", text)
                s0 = spans[0]
                if (m and s0["bbox"][0] < 100 and s0["size"] >= 11.5
                        and ("Bold" in s0["font"] or "CMBX" in s0["font"])):
                    heads.append({"q": int(m.group(1)), "page": pno,
                                  "y": s0["bbox"][1]})
    ordered = []
    for h in heads:
        want = ordered[-1]["q"] + 1 if ordered else 1
        if h["q"] == want:
            ordered.append(h)
    return ordered

def page_content_bottom(page):
    H = page.rect.height
    cut = H - 68  # page number ~780, version footer ~785, © ~805
    lo = 60
    for block in page.get_text("dict")["blocks"]:
        if block["bbox"][3] < cut:
            lo = max(lo, block["bbox"][3])
    for d in page.get_drawings():
        if d["rect"].y1 < cut and d["rect"].width + d["rect"].height > 6:
            lo = max(lo, d["rect"].y1)
    return lo

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    answers = json.loads((DATA / "answers.json").read_text())
    manifest, mismatches, missing_stmt = {}, [], 0

    for year in YEARS:
        for pnum in (1, 2):
            doc = fitz.open(PAPERS / f"{year}-paper{pnum}-ms.pdf")
            heads = find_headings(doc)
            if [h["q"] for h in heads] != list(range(1, 21)):
                raise ValueError(f"{year}-P{pnum}: headings incomplete: {[h['q'] for h in heads]}")
            W = doc[0].rect.width
            for i, h in enumerate(heads):
                qid = f"{year}-P{pnum}-Q{h['q']:02d}"
                if i + 1 < len(heads):
                    last = heads[i + 1]["page"] - 1
                else:
                    last = h["page"]
                    for pno in range(h["page"] + 1, doc.page_count):
                        if BACK_MATTER.search(doc[pno].get_text("text")):
                            break
                        if len(doc[pno].get_text("text").strip()) < 30:
                            break
                        last = pno
                pages = list(range(h["page"], last + 1))
                pixmaps, section_text = [], []
                for pno in pages:
                    top = h["y"] - 12 if pno == h["page"] else 50
                    bottom = page_content_bottom(doc[pno]) + 8
                    clip = (58, top, W - 50, max(bottom, top + 30))
                    pm = crop_points(PAPERS / f"{year}-paper{pnum}-ms.pdf", pno, clip, DPI)
                    pixmaps.append(pm)
                    section_text.append(doc[pno].get_text("text"))
                if len(pixmaps) == 1:
                    final = pixmaps[0]
                else:
                    gap = 20
                    width = max(pm.width for pm in pixmaps)
                    height = sum(pm.height for pm in pixmaps) + gap * (len(pixmaps) - 1)
                    final = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, width, height))
                    final.set_rect(final.irect, (255,))
                    yoff = 0
                    for pm in pixmaps:
                        pm.set_origin(0, yoff)
                        final.copy(pm, fitz.IRect(0, yoff, pm.width, yoff + pm.height))
                        yoff += pm.height + gap
                final.save(OUT / f"{qid}.png")
                manifest[qid] = {"file": f"{year}-paper{pnum}-ms.pdf", "pages": pages}

                stmt = ANSWER_RE.search(" ".join(section_text))
                if stmt:
                    if stmt.group(1) != answers[qid]:
                        mismatches.append((qid, stmt.group(1), answers[qid]))
                else:
                    missing_stmt += 1
            doc.close()
        print(f"{year}: P1+P2 solutions cropped")

    (DATA / "solution-manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"total solution crops: {len(manifest)}")
    print(f"answer statements found: {len(manifest) - missing_stmt}/{len(manifest)}")
    if mismatches:
        print("MISMATCHES vs answer key:")
        for m in mismatches:
            print("  ", m)
    else:
        print("all found statements agree with the answer key")

if __name__ == "__main__":
    main()
