"""Parse score conversion tables into data/conversions.json.

Each year yields paper1/paper2 tables (raw 0-20 -> grade) and an overall
table (raw 0-40 -> grade). Layouts vary (ascending, descending, stacked,
side-by-side, row-interleaved), so we pair numbers coordinate-wise, cluster
into columns, split clusters into consecutive-raw runs, and classify runs by
length: 21 rows = paper table (first=P1, second=P2), 41 rows = overall.

Cross-checked against the same tables embedded in the answer-key PDFs.
"""
import json
import pathlib
import re
import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPERS = ROOT / "assets" / "papers"
DATA = ROOT / "data"
YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023"]

def extract_tables(pdf_path):
    doc = fitz.open(pdf_path)
    pairs = []
    for pno in range(doc.page_count):
        words = doc[pno].get_text("words")
        raws = [w for w in words if re.fullmatch(r"\d{1,2}", w[4]) and 0 <= int(w[4]) <= 40]
        grades = [w for w in words if re.fullmatch(r"[1-9](\.\d)?", w[4])]
        for r in raws:
            same = [g for g in grades
                    if abs((g[1] + g[3]) / 2 - (r[1] + r[3]) / 2) < 4 and g[0] > r[2]
                    and g[0] - r[2] < 110]
            if not same:
                continue
            g = min(same, key=lambda g: g[0] - r[2])
            pairs.append((pno, round(r[1], 1), round(r[0], 1), int(r[4]), float(g[4])))
    doc.close()

    pairs.sort(key=lambda p: (p[0], p[2], p[1]))
    clusters = []
    for p in pairs:
        for c in clusters:
            if c[-1][0] == p[0] and abs(c[-1][2] - p[2]) < 25:
                c.append(p)
                break
        else:
            clusters.append([p])

    runs = []
    for c in clusters:
        c.sort(key=lambda p: p[1])
        cur = [c[0]]
        for p in c[1:]:
            step = p[3] - cur[-1][3]
            if len(cur) == 1 and step in (1, -1):
                cur.append(p)
            elif len(cur) > 1 and step == cur[1][3] - cur[0][3]:
                cur.append(p)
            else:
                runs.append(cur)
                cur = [p]
        runs.append(cur)

    paper_tables, overall = [], None
    for run in runs:
        m = {p[3]: p[4] for p in run}
        if len(run) == 21 and set(m) == set(range(21)):
            paper_tables.append(m)
        elif len(run) == 41 and set(m) == set(range(41)):
            overall = m
    return paper_tables, overall

def main():
    out = {}
    for y in YEARS:
        papers, overall = extract_tables(PAPERS / f"{y}-conversion.pdf")
        if len(papers) != 2 or overall is None:
            raise ValueError(f"{y}: expected 2 paper tables + overall, got "
                             f"{len(papers)} papers, overall={'yes' if overall else 'no'}")
        out[y] = {
            "paper1": {str(k): papers[0][k] for k in range(21)},
            "paper2": {str(k): papers[1][k] for k in range(21)},
            "overall": {str(k): overall[k] for k in range(41)},
        }
        # cross-check against tables embedded in the answer-key PDF, if any
        kp, ko = extract_tables(PAPERS / f"{y}-answer-key.pdf")
        if len(kp) == 2:
            assert kp[0] == papers[0] and kp[1] == papers[1], f"{y}: paper table mismatch vs key PDF"
            note = "cross-checked vs key PDF"
            if ko is not None:
                assert ko == overall, f"{y}: overall mismatch vs key PDF"
                note += " (incl. overall)"
        else:
            note = "single source"
        print(f"{y}: P1[20]={papers[0][20]} P1[10]={papers[0][10]} "
              f"P2[10]={papers[1][10]} OV[30]={overall[30]}  [{note}]")
    (DATA / "conversions.json").write_text(json.dumps(out, indent=1))
    print(f"years: {len(out)}")

if __name__ == "__main__":
    main()
