"""Phase 1 inventory checklist: verify every expected source file exists and is a valid PDF."""
import pathlib
import fitz

PAPERS = pathlib.Path(__file__).resolve().parent.parent / "assets" / "papers"
YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023"]

def check(name):
    p = PAPERS / name
    if not p.exists():
        return "MISSING"
    try:
        doc = fitz.open(p)
        n = doc.page_count
        doc.close()
        return f"OK {n:>2}p"
    except Exception as e:
        return f"CORRUPT ({e})"

missing = 0
print(f"{'':14}{'Paper 1':>9} {'Paper 2':>9} {'Sol P1':>9} {'Sol P2':>9} {'AnsKey':>9} {'Conv':>9}")
for y in YEARS + ["specimen"]:
    cols = [
        check(f"{y}-paper1.pdf"),
        check(f"{y}-paper2.pdf"),
        check(f"{y}-paper1-ms.pdf"),
        check(f"{y}-paper2-ms.pdf"),
        check(f"{y}-answer-key.pdf"),
        check(f"{y}-conversion.pdf") if y != "specimen" else "n/a",
    ]
    missing += sum("MISSING" in c or "CORRUPT" in c for c in cols)
    print(f"{y:14}" + " ".join(f"{c:>9}" for c in cols))

print()
print(f"Expected questions: {len(YEARS)} years x 2 papers x 20 = {len(YEARS)*40} (+40 specimen bonus)")
print("ALL SOURCES PRESENT" if missing == 0 else f"PROBLEMS: {missing} file(s) missing/corrupt")
