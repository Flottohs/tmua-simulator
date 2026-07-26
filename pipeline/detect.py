"""Question-boundary detection for all TMUA paper eras.

Eras observed:
  - Modern LaTeX (2018-2020, 2022-2023 style): bold digit span (CMBX12 / Arial,Bold),
    x in [45,65], near top of page, one question per page.
  - Legacy Cambria (2016, 2017, 2021, specimen): CambriaMath span at x in [45,65]
    where digits are encoded as chr(0x372 + d)  ('1' -> U+0373).

A candidate is accepted only if it extends the ascending sequence 1,2,...,20.
"""
import pathlib
import re
import fitz

PAPERS = pathlib.Path(__file__).resolve().parent.parent / "assets" / "papers"

CAMBRIA_DIGITS = {chr(0x372 + d): str(d) for d in range(10)}

def decode_qnum(text):
    """Return (num, pure) if the span starts with a question-number token.

    pure=True when the span is ONLY the number (optionally with a trailing dot),
    which is a stronger signal than a number leading into inline text.
    """
    t = text.replace("\x03", " ").strip()
    if not t:
        return None
    token = t.split()[0].rstrip(".")
    dec = "".join(CAMBRIA_DIGITS.get(c, c) for c in token)
    if not re.fullmatch(r"\d{1,2}", dec):
        return None
    pure = len(t.split()) == 1
    return int(dec), pure

def find_questions(pdf_path):
    """Return list of dicts {q, page, y, x, font} for questions 1..20 in order."""
    doc = fitz.open(pdf_path)
    found = []          # accepted, ascending
    for pno in range(doc.page_count):
        page = doc[pno]
        # question numbers sit in the left margin, inside the body indent:
        # A4 papers (~595pt): x in [40,66]; US-Letter specimen (612pt): [66,80]
        xlo, xhi = (66, 80) if page.rect.width > 600 else (40, 66)
        cands = []
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    x0, y0 = span["bbox"][0], span["bbox"][1]
                    if not (xlo <= x0 <= xhi):
                        continue
                    if span["size"] < 10:
                        continue
                    got = decode_qnum(span["text"])
                    if got is None or not (1 <= got[0] <= 20):
                        continue
                    q, pure = got
                    marker = ("Bold" in span["font"] or "CMBX" in span["font"]
                              or span["font"].startswith(("Cambria",)))
                    if not marker:
                        continue
                    cands.append({"q": q, "pure": pure, "page": pno,
                                  "y": round(y0, 1), "x": round(x0, 1),
                                  "font": span["font"]})
        # physical order is authoritative: on a page, question k+1 is always
        # below question k, so a single top-to-bottom pass is correct
        cands.sort(key=lambda c: c["y"])
        for c in cands:
            want = found[-1]["q"] + 1 if found else 1
            if c["q"] == want:
                found.append(c)
    doc.close()
    return found

if __name__ == "__main__":
    for pdf in sorted(PAPERS.glob("*paper[12].pdf")):
        qs = find_questions(pdf)
        nums = [q["q"] for q in qs]
        pages = [q["page"] for q in qs]
        ok = nums == list(range(1, 21))
        status = "OK " if ok else "FAIL"
        per_page = "1/page" if len(set(pages)) == len(pages) else "multi/page"
        print(f"{status} {pdf.name:24} found={len(qs):2}  {per_page:10} pages {pages[0] if pages else '-'}..{pages[-1] if pages else '-'}")
        if not ok:
            print(f"     got: {nums}")
