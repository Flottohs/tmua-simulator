"""Crop every question of every paper into its own PNG.

Reads detection from detect.find_questions, computes per-question segments
(a question may continue onto the next page), renders at high DPI in grayscale,
whites out page furniture (page numbers, footers), and writes:

  assets/questions/{YEAR}-P{n}-Q{nn}.png
  data/crop-manifest.json    (exact segments used, so fixes are data edits)
  data/qtext.json            (best-effort decoded text per question, for tagging)
  data/options.json          (detected option count per question)

Manual fixes: data/crop-overrides.json  {"2019-P1-Q07": {"segments": [{"page":8,"y0":90,"y1":520}]}}
"""
import json
import pathlib
import re
import fitz
from detect import find_questions, CAMBRIA_DIGITS
from quartz_render import crop_points

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"
OUT = ROOT / "assets" / "questions"
DATA = ROOT / "data"
DPI = 200
SCALE = DPI / 72.0

PAPER_FILES = [(y, p, f"{y}-paper{p}.pdf") for y in
               ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "specimen"]
               for p in (1, 2)]

# ---------- text decoding for the legacy encodings ----------

def decode_char(c, font):
    o = ord(c)
    if "CambriaMath" in font:
        if o == 0x03:
            return " "
        if 0x04 <= o <= 0x1D:
            return chr(o + 0x3D)          # A-Z
        if 0x83 <= o <= 0x9C:
            return chr(o - 0x22)          # a-z
        if 0x372 <= o <= 0x37B:
            return chr(o - 0x342)         # 0-9
        return c
    # shifted Arial (covers/footers of 2017/2021 files): printable ASCII moved down 0x1D
    if 0x03 <= o <= 0x60 and o != 0x20:
        cand = o + 0x1D
        if 0x20 <= cand <= 0x7D:
            return chr(cand)
    return c

def decode_text(t, font):
    if "CambriaMath" in font:
        return "".join(decode_char(c, font) for c in t)
    # only apply the arial shift when the raw text is clearly garbled
    if any(0x03 <= ord(c) < 0x20 for c in t):
        return "".join(decode_char(c, font) for c in t)
    return t

# ---------- page geometry ----------

def furniture_rects(page):
    """Rects of page numbers / footers / turn-over marks to white out."""
    W, H = page.rect.width, page.rect.height
    rects = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                x0, y0, x1, y1 = span["bbox"]
                dec = decode_text(span["text"], span["font"]).strip()
                if not dec:
                    continue
                centered = x0 > 0.35 * W and x1 < 0.65 * W
                # page numbers sit above y=50 (observed 27-48 across eras);
                # centered equation digits start at y~82, so keep the band tight
                edge = y0 < 50 or y1 > H - 95
                if centered and edge and re.fullmatch(r"\d{1,3}", dec):
                    rects.append((x0, y0, x1, y1))
                elif re.search(r"UCLES|Turn over|BLANK PAGE|END OF TEST|PV\d", dec, re.I):
                    rects.append((x0, y0, x1, y1))
    return rects

def content_top(page, footer_cut):
    """Highest y of real content on the page, span-level, ignoring furniture/blanks."""
    furn = [fitz.Rect(r) for r in furniture_rects(page)]
    hi = footer_cut
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            bx = fitz.Rect(block["bbox"])
            if bx.y0 < footer_cut and not any(bx.intersects(f) for f in furn):
                hi = min(hi, bx.y0)
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                sx = fitz.Rect(span["bbox"])
                if sx.y0 >= footer_cut:
                    continue
                if not decode_text(span["text"], span["font"]).strip():
                    continue
                if any(sx.intersects(f) for f in furn):
                    continue
                hi = min(hi, sx.y0)
    for d in page.get_drawings():
        r = d["rect"]
        if r.y0 < footer_cut and r.height + r.width > 6:
            hi = min(hi, r.y0)
    return hi

def content_bottom(page, y_from, footer_cut):
    """Lowest y of real content (text+images+drawings) below y_from, above footer."""
    lo = y_from
    for block in page.get_text("dict")["blocks"]:
        x0, y0, x1, y1 = block["bbox"]
        if y1 > footer_cut or y1 <= y_from:
            continue
        if block["type"] == 0:
            txt = "".join(decode_text(s["text"], s["font"])
                          for l in block["lines"] for s in l["spans"]).strip()
            if not txt:
                continue
            if re.search(r"UCLES|Turn over|BLANK PAGE|END OF TEST", txt, re.I):
                continue
        lo = max(lo, y1)
    for d in page.get_drawings():
        r = d["rect"]
        if r.y1 <= footer_cut and r.y1 > y_from and r.height + r.width > 6:
            lo = max(lo, r.y1)
    return lo

def option_count(page_texts):
    """Detect number of answer options from decoded per-span text+positions."""
    letters = set()
    for x0, y0, dec, font in page_texts:
        m = re.match(r"^([A-H])\b", dec.strip())
        if m and x0 < 115:
            letters.add(m.group(1))
    # options are consecutive from A; take the longest run
    n = 0
    for i, L in enumerate("ABCDEFGH"):
        if L in letters:
            n = i + 1
        else:
            break
    return n

# ---------- main ----------

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    overrides = {}
    ov_path = DATA / "crop-overrides.json"
    if ov_path.exists():
        overrides = json.loads(ov_path.read_text())

    manifest, qtext, options = {}, {}, {}
    problems = []

    for year, pnum, fname in PAPER_FILES:
        pdf = PAPERS / fname
        doc = fitz.open(pdf)
        qs = find_questions(pdf)
        if [q["q"] for q in qs] != list(range(1, 21)):
            problems.append(f"{fname}: detection incomplete ({len(qs)})")
            continue
        H = doc[0].rect.height
        W = doc[0].rect.width
        a4 = W < 600
        footer_cut = H - (72 if a4 else 42)
        x0, x1 = (40, W - 34) if a4 else (58, W - 52)
        one_per_page = len({q["page"] for q in qs}) == len(qs)

        for i, q in enumerate(qs):
            qid = f"{year}-P{pnum}-Q{q['q']:02d}"
            nxt = qs[i + 1] if i + 1 < len(qs) else None
            segments = []
            top = max(q["y"] - 10, 18)
            if one_per_page:
                # the whole page belongs to this question; figures may float
                # above the question number, so start at the page's content top
                top = max(min(top, content_top(doc[q["page"]], footer_cut) - 8), 14)
                bottom = content_bottom(doc[q["page"]], top, footer_cut)
                segments.append({"page": q["page"], "y0": top, "y1": min(bottom + 10, footer_cut)})
            elif nxt and nxt["page"] == q["page"]:
                segments.append({"page": q["page"], "y0": top, "y1": nxt["y"] - 14})
            else:
                bottom = content_bottom(doc[q["page"]], q["y"], footer_cut)
                segments.append({"page": q["page"], "y0": top, "y1": min(bottom + 10, footer_cut)})
                # full continuation pages between this question and the next
                if nxt and nxt["page"] > q["page"] + 1:
                    for mid in range(q["page"] + 1, nxt["page"]):
                        b = content_bottom(doc[mid], 0, footer_cut)
                        if b > 40:
                            segments.append({"page": mid, "y0": 18, "y1": min(b + 10, footer_cut)})
                # carryover: real content above the next question number on the
                # next question's page belongs to this question
                if nxt and nxt["page"] > q["page"]:
                    ctop = content_top(doc[nxt["page"]], footer_cut)
                    if ctop < nxt["y"] - 30:
                        b = min(nxt["y"] - 14, footer_cut)
                        segments.append({"page": nxt["page"], "y0": max(ctop - 8, 14), "y1": b})

            if qid in overrides:
                segments = overrides[qid]["segments"]

            # render segments and stack vertically
            pixmaps = []
            for seg in segments:
                clip = fitz.Rect(x0, seg["y0"], x1, seg["y1"])
                pm = crop_points(pdf, seg["page"], (clip.x0, clip.y0, clip.x1, clip.y1), DPI)
                # white out furniture within this clip
                for fr in furniture_rects(doc[seg["page"]]):
                    r = fitz.Rect(fr) & clip
                    if not r.is_empty:
                        px0 = int((r.x0 - clip.x0) * SCALE); px1 = int((r.x1 - clip.x0) * SCALE) + 1
                        py0 = int((r.y0 - clip.y0) * SCALE); py1 = int((r.y1 - clip.y0) * SCALE) + 1
                        pm.set_rect(fitz.IRect(px0, py0, px1, py1) & pm.irect, (255,))
                pixmaps.append(pm)

            if len(pixmaps) == 1:
                final = pixmaps[0]
            else:
                gap = 24
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

            # decoded text + options for the region
            texts = []
            for seg in segments:
                for block in doc[seg["page"]].get_text("dict")["blocks"]:
                    if block["type"] != 0:
                        continue
                    for lline in block["lines"]:
                        for span in lline["spans"]:
                            sx, sy = span["bbox"][0], span["bbox"][1]
                            if seg["y0"] - 2 <= sy <= seg["y1"] + 2:
                                dec = decode_text(span["text"], span["font"])
                                if dec.strip():
                                    texts.append((sx, sy, dec, span["font"]))
            qtext[qid] = " ".join(t[2] for t in sorted(texts, key=lambda t: (t[1], t[0])))
            options[qid] = option_count(texts)
            manifest[qid] = {"file": fname, "segments": segments,
                             "x": [round(x0, 1), round(x1, 1)], "dpi": DPI}
        doc.close()
        print(f"{fname}: 20 questions cropped")

    ov = DATA / "option-overrides.json"
    if ov.exists():
        for k, v in json.loads(ov.read_text()).items():
            if not k.startswith("_"):
                options[k] = v
    (DATA / "crop-manifest.json").write_text(json.dumps(manifest, indent=1))
    (DATA / "qtext.json").write_text(json.dumps(qtext, indent=1, ensure_ascii=False))
    (DATA / "options.json").write_text(json.dumps(options, indent=1))
    for p in problems:
        print("PROBLEM:", p)
    print(f"total crops: {len(manifest)}")

if __name__ == "__main__":
    main()
