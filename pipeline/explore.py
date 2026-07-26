"""Exploratory: find candidate question-number spans in question papers."""
import sys
import pathlib
import fitz

PAPERS = pathlib.Path(__file__).resolve().parent.parent / "assets" / "papers"

def unshift(t):
    """Undo the broken-font 0x1D offset seen in 2017-P1 / 2021 papers."""
    return "".join(chr(ord(c) + 0x1D) if 0x03 <= ord(c) <= 0x60 else c for c in t)

def scan(name):
    doc = fitz.open(PAPERS / name)
    print(f"===== {name} ({doc.page_count} pages) =====")
    for pno in range(doc.page_count):
        page = doc[pno]
        d = page.get_text("dict")
        for block in d["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    raw = span["text"].strip()
                    dec = unshift(raw)
                    for label, txt in (("raw", raw), ("dec", dec)):
                        if txt.isdigit() and 1 <= int(txt) <= 20 and span["bbox"][0] < 100:
                            print(f"p{pno:02} {label} q={txt:>2} x={span['bbox'][0]:6.1f} y={span['bbox'][1]:6.1f} "
                                  f"size={span['size']:.1f} font={span['font']}")
                            break
    doc.close()

for name in sys.argv[1:]:
    scan(name)
