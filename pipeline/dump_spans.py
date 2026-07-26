"""Dump all spans on given pages of a PDF, with repr() so encoding issues are visible."""
import sys
import pathlib
import fitz

PAPERS = pathlib.Path(__file__).resolve().parent.parent / "assets" / "papers"
name, pages = sys.argv[1], [int(p) for p in sys.argv[2].split(",")]
doc = fitz.open(PAPERS / name)
for pno in pages:
    page = doc[pno]
    print(f"----- {name} page {pno} (rect {page.rect}) -----")
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            print(f"  [image block] bbox={[round(v,1) for v in block['bbox']]}")
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                b = [round(v, 1) for v in span["bbox"]]
                print(f"  x={b[0]:6} y={b[1]:6} sz={span['size']:4.1f} {span['font'][:20]:20} {repr(span['text'][:60])}")
doc.close()
