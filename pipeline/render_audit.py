"""Detect text spans that exist in the PDF text layer but render blank
(broken embedded font subsets). For each non-space span on question pages,
render its bbox and check ink coverage; report spans that are pure white.
"""
import pathlib
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"

def audit(pdf_path, max_report=6):
    doc = fitz.open(pdf_path)
    bad = []
    for pno in range(doc.page_count):
        page = doc[pno]
        pm = page.get_pixmap(dpi=100, colorspace=fitz.csGRAY)
        pm.set_origin(0, 0)
        S = 100 / 72.0
        for b in page.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            for l in b["lines"]:
                for s in l["spans"]:
                    txt = s["text"].replace("\x03", " ").strip()
                    if not txt:
                        continue
                    x0, y0, x1, y1 = s["bbox"]
                    ir = fitz.IRect(int(x0 * S), int(y0 * S), int(x1 * S) + 1, int(y1 * S) + 1) & pm.irect
                    if ir.is_empty:
                        continue
                    sub = fitz.Pixmap(pm, ir.x0, ir.y0, None) if False else None
                    # sample min pixel in the rect
                    mn = 255
                    for yy in range(ir.y0, ir.y1):
                        row = pm.samples[yy * pm.stride + ir.x0: yy * pm.stride + ir.x1]
                        if row:
                            mn = min(mn, min(row))
                        if mn < 200:
                            break
                    if mn >= 200:
                        bad.append((pno, round(x0), round(y0), s["font"][:24], txt[:24]))
    doc.close()
    return bad

if __name__ == "__main__":
    total_bad = 0
    for pdf in sorted(PAPERS.glob("*paper[12].pdf")) + sorted(PAPERS.glob("*-ms.pdf")):
        bad = audit(pdf)
        total_bad += len(bad)
        if bad:
            print(f"{pdf.name}: {len(bad)} blank-rendered spans")
            for b in bad[:6]:
                print("   ", b)
    print("total blank spans:", total_bad)
