"""INDEPENDENT re-parse of every answer key, for QA.

Deliberately shares no code with pipeline/keys.py and uses a different
technique: keys.py pairs words by coordinates and clusters columns; this reads
the page's raw reading-order text stream and consumes 'number then letter'
pairs, splitting papers on the sequence restarting at 1.

Two different methods agreeing on all 360 answers is real evidence. Writes
data/answers-reparsed.json for the audit to diff.
"""
import json
import pathlib
import re
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"
YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "specimen"]


def token_stream(pdf):
    """Flat list of tokens in page reading order across the whole document."""
    doc = fitz.open(pdf)
    toks = []
    for pno in range(doc.page_count):
        text = doc[pno].get_text("text")
        # normalise non-breaking spaces used by some of the older key PDFs
        text = text.replace("\xa0", " ")
        for raw in re.split(r"[\s]+", text):
            t = raw.strip()
            if t:
                toks.append(t)
    doc.close()
    return toks


def sequences(pdf):
    """Extract every maximal run of (n, LETTER) pairs with n ascending from 1."""
    toks = token_stream(pdf)
    runs, cur, expect = [], {}, 1
    i = 0
    while i < len(toks) - 1:
        a, b = toks[i], toks[i + 1]
        if re.fullmatch(r"\d{1,2}", a) and re.fullmatch(r"[A-H]", b):
            n = int(a)
            if n == expect:
                cur[n] = b
                expect += 1
                i += 2
                continue
            if n == 1 and cur:
                runs.append(cur)
                cur, expect = {1: b}, 2
                i += 2
                continue
        i += 1
    if cur:
        runs.append(cur)
    return [r for r in runs if set(r) == set(range(1, 21))]


def interleaved(pdf):
    """2016/specimen keys lay both papers out as rows: n K n K across the page.
    Consume quadruples instead of pairs."""
    toks = token_stream(pdf)
    p1, p2, expect = {}, {}, 1
    i = 0
    while i < len(toks) - 3:
        a, b, c, d = toks[i:i + 4]
        if (re.fullmatch(r"\d{1,2}", a) and re.fullmatch(r"[A-H]", b)
                and re.fullmatch(r"\d{1,2}", c) and re.fullmatch(r"[A-H]", d)
                and int(a) == expect and int(c) == expect):
            p1[expect] = b
            p2[expect] = d
            expect += 1
            i += 4
            continue
        i += 1
    if set(p1) == set(range(1, 21)) and set(p2) == set(range(1, 21)):
        return [p1, p2]
    return []


def parse(year):
    pdf = PAPERS / f"{year}-answer-key.pdf"
    runs = sequences(pdf)
    if len(runs) >= 2:
        return runs[0], runs[1]
    inter = interleaved(pdf)
    if len(inter) == 2:
        return inter[0], inter[1]
    raise ValueError(f"{year}: independent parser found {len(runs)} full runs")


def main():
    out = {}
    for year in YEARS:
        p1, p2 = parse(year)
        for paper, table in ((1, p1), (2, p2)):
            for q, letter in table.items():
                out[f"{year}-P{paper}-Q{q:02d}"] = letter
        print(f"{year}: P1 {''.join(p1[i] for i in range(1, 21))}  "
              f"P2 {''.join(p2[i] for i in range(1, 21))}")
    (ROOT / "data" / "answers-reparsed.json").write_text(json.dumps(out, indent=1))
    print(f"independent parse produced {len(out)} answers")


if __name__ == "__main__":
    main()
