"""Parse the standalone answer-key PDFs into data/answers.json.

Coordinate-based: find words that are numbers 1-20, pair each with the nearest
A-H word to its right on the same row, cluster pairs into columns, then map
columns/sequences to Paper 1 / Paper 2 (paper 1 always appears first, i.e.
leftmost column pair or first sequential block — verified visually).
"""
import json
import pathlib
import re
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"
DATA = ROOT / "data"

YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "specimen"]

def parse_key(pdf_path):
    doc = fitz.open(pdf_path)
    pairs = []  # (page, y, x, num, letter)
    for pno in range(doc.page_count):
        words = doc[pno].get_text("words")  # x0,y0,x1,y1,word,block,line,word_no
        nums = [w for w in words if re.fullmatch(r"\d{1,2}", w[4]) and 1 <= int(w[4]) <= 20]
        letters = [w for w in words if re.fullmatch(r"[A-H]", w[4])]
        for n in nums:
            same_row = [l for l in letters
                        if abs((l[1] + l[3]) / 2 - (n[1] + n[3]) / 2) < 5 and l[0] > n[2]]
            if not same_row:
                continue
            l = min(same_row, key=lambda l: l[0] - n[2])
            if l[0] - n[2] > 160:
                continue
            pairs.append((pno, round(n[1], 1), round(n[0], 1), int(n[4]), l[4]))
    doc.close()

    # cluster pair-columns by (page, x of the number)
    pairs.sort(key=lambda p: (p[0], p[2]))
    clusters = []
    for p in pairs:
        for c in clusters:
            if c["page"] == p[0] and abs(c["x"] - p[2]) < 30:
                c["items"].append(p)
                break
        else:
            clusters.append({"page": p[0], "x": p[2], "items": [p]})
    # order clusters left-to-right (then page), items top-to-bottom
    clusters.sort(key=lambda c: (c["page"], c["x"]))
    seqs = []
    for c in clusters:
        c["items"].sort(key=lambda p: p[1])
        # split a cluster that stacks both papers (1..20 then 1..20)
        cur = []
        for p in c["items"]:
            if cur and p[3] <= cur[-1][3]:
                seqs.append(cur)
                cur = []
            cur.append(p)
        if cur:
            seqs.append(cur)

    full = [s for s in seqs if [p[3] for p in s] == list(range(1, 21))]
    if len(full) == 2:
        return {1: {p[3]: p[4] for p in full[0]}, 2: {p[3]: p[4] for p in full[1]}}

    # interleaved rows (2016/specimen): two pair-columns share rows
    if len(full) == 0 and len(seqs) >= 2:
        merged = {}
        for s in seqs:
            for p in s:
                merged.setdefault((p[0], p[1]), []).append(p)
        col1, col2 = {}, {}
        for row in merged.values():
            row.sort(key=lambda p: p[2])
            if len(row) == 2:
                col1[row[0][3]] = row[0][4]
                col2[row[1][3]] = row[1][4]
        if set(col1) == set(range(1, 21)) and set(col2) == set(range(1, 21)):
            return {1: col1, 2: col2}
    raise ValueError(f"{pdf_path.name}: could not resolve key tables "
                     f"({[len(s) for s in seqs]} seq lengths)")

def main():
    answers = {}
    for y in YEARS:
        parsed = parse_key(PAPERS / f"{y}-answer-key.pdf")
        for paper in (1, 2):
            for q, letter in parsed[paper].items():
                answers[f"{y}-P{paper}-Q{q:02d}"] = letter
        print(f"{y}: P1 {''.join(parsed[1][q] for q in range(1, 21))}")
        print(f"{'':>{len(y)}}  P2 {''.join(parsed[2][q] for q in range(1, 21))}")
    DATA.mkdir(exist_ok=True)
    (DATA / "answers.json").write_text(json.dumps(answers, indent=1))
    print(f"total answers: {len(answers)}")

if __name__ == "__main__":
    main()
