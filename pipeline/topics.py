"""Topic tags for every question, assigned from the fixed TMUA-spec taxonomy
by reviewing each question. Emits data/questions.json (the app's master file)
combining id, paper metadata, image paths, option counts, and topics.

Run after crop.py + solutions.py + keys.py.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

TAXONOMY = {
    "algebra-functions": "Algebra & functions",
    "equations-inequalities": "Equations & inequalities",
    "sequences-series": "Sequences & series",
    "coordinate-geometry": "Coordinate geometry",
    "trigonometry": "Trigonometry",
    "exponentials-logarithms": "Exponentials & logarithms",
    "differentiation": "Differentiation",
    "integration": "Integration",
    "graphs": "Graphs of functions",
    "geometry": "Geometry & measure",
    "number": "Number",
    "counting-probability": "Counting & probability",
    "logic-truth": "Logic & truth",
    "necessary-sufficient": "Necessary & sufficient",
    "proof-counterexample": "Proof & counterexamples",
    "argument-analysis": "Argument analysis",
}

# fmt: off
TAGS = {
 "2016-P1": [
  ["algebra-functions"], ["algebra-functions"], ["differentiation","coordinate-geometry"],
  ["sequences-series"], ["integration"], ["number"], ["counting-probability"],
  ["trigonometry","equations-inequalities"], ["coordinate-geometry"], ["trigonometry","graphs"],
  ["exponentials-logarithms","equations-inequalities"], ["differentiation","geometry"],
  ["differentiation","graphs"], ["sequences-series"], ["differentiation","algebra-functions"],
  ["exponentials-logarithms","equations-inequalities"], ["trigonometry","equations-inequalities"],
  ["differentiation"], ["algebra-functions"], ["geometry"],
 ],
 "2016-P2": [
  ["integration"], ["differentiation"], ["trigonometry","equations-inequalities"],
  ["logic-truth"], ["proof-counterexample","number"], ["sequences-series","integration"],
  ["exponentials-logarithms","proof-counterexample"], ["equations-inequalities","logic-truth"],
  ["geometry","necessary-sufficient"], ["necessary-sufficient","equations-inequalities"],
  ["algebra-functions","logic-truth"], ["sequences-series","logic-truth"],
  ["argument-analysis","number"], ["graphs","logic-truth"],
  ["equations-inequalities","necessary-sufficient"], ["geometry"],
  ["trigonometry","graphs"], ["proof-counterexample","algebra-functions"],
  ["geometry"], ["geometry","number"],
 ],
 "2017-P1": [
  ["integration"], ["differentiation"], ["coordinate-geometry","geometry"],
  ["algebra-functions"], ["equations-inequalities"], ["coordinate-geometry","geometry"],
  ["sequences-series"], ["trigonometry","equations-inequalities"],
  ["coordinate-geometry","geometry"], ["differentiation","algebra-functions"],
  ["sequences-series"], ["integration","algebra-functions"], ["algebra-functions"],
  ["exponentials-logarithms","equations-inequalities"], ["integration","graphs"],
  ["differentiation","graphs"], ["integration","sequences-series"],
  ["exponentials-logarithms","graphs"], ["equations-inequalities","algebra-functions"],
  ["geometry","trigonometry"],
 ],
 "2017-P2": [
  ["differentiation"], ["coordinate-geometry","geometry"], ["sequences-series"],
  ["trigonometry","argument-analysis"], ["number","proof-counterexample"],
  ["integration","sequences-series"], ["exponentials-logarithms","graphs"],
  ["exponentials-logarithms","number"], ["argument-analysis","number"],
  ["necessary-sufficient","integration"], ["integration","algebra-functions"],
  ["trigonometry","graphs"], ["number","logic-truth"], ["graphs","algebra-functions"],
  ["sequences-series","number"], ["proof-counterexample","differentiation"],
  ["logic-truth"], ["argument-analysis","exponentials-logarithms"],
  ["necessary-sufficient","algebra-functions"], ["logic-truth","counting-probability"],
 ],
 "2018-P1": [
  ["integration"], ["sequences-series"], ["coordinate-geometry","geometry"],
  ["equations-inequalities","coordinate-geometry"], ["algebra-functions"],
  ["trigonometry","graphs"], ["algebra-functions"], ["sequences-series"],
  ["differentiation","algebra-functions"], ["equations-inequalities","number"],
  ["differentiation","coordinate-geometry"], ["integration","graphs"],
  ["differentiation","graphs"], ["coordinate-geometry","exponentials-logarithms"],
  ["exponentials-logarithms","equations-inequalities"], ["differentiation","coordinate-geometry"],
  ["number"], ["trigonometry","graphs"], ["trigonometry","geometry"],
  ["trigonometry","number"],
 ],
 "2018-P2": [
  ["differentiation"], ["algebra-functions"], ["argument-analysis","number"],
  ["trigonometry"], ["geometry","logic-truth"], ["proof-counterexample","differentiation"],
  ["sequences-series","number"], ["logic-truth"], ["argument-analysis","equations-inequalities"],
  ["necessary-sufficient","graphs"], ["exponentials-logarithms","graphs"],
  ["logic-truth","number"], ["argument-analysis","trigonometry"], ["trigonometry","geometry"],
  ["algebra-functions","logic-truth"], ["sequences-series","logic-truth"],
  ["number","logic-truth"], ["necessary-sufficient","graphs"],
  ["exponentials-logarithms","equations-inequalities"],
  ["equations-inequalities","algebra-functions"],
 ],
 "2019-P1": [
  ["algebra-functions","graphs"], ["equations-inequalities"], ["algebra-functions","sequences-series"],
  ["sequences-series","exponentials-logarithms"], ["sequences-series"],
  ["coordinate-geometry","geometry"], ["differentiation"], ["integration","graphs"],
  ["integration","coordinate-geometry"], ["integration","graphs"],
  ["exponentials-logarithms","equations-inequalities"], ["integration"],
  ["exponentials-logarithms","trigonometry"], ["trigonometry"],
  ["exponentials-logarithms"], ["integration","algebra-functions"],
  ["trigonometry","equations-inequalities"], ["differentiation","coordinate-geometry"],
  ["trigonometry","sequences-series"], ["graphs","equations-inequalities"],
 ],
 "2019-P2": [
  ["algebra-functions"], ["algebra-functions"], ["number","logic-truth"],
  ["number","proof-counterexample"], ["necessary-sufficient","number"],
  ["argument-analysis","trigonometry"], ["proof-counterexample","number"],
  ["equations-inequalities","number"], ["counting-probability"],
  ["necessary-sufficient","geometry"], ["sequences-series","number"],
  ["counting-probability"], ["integration","logic-truth"],
  ["differentiation","necessary-sufficient"], ["exponentials-logarithms","equations-inequalities"],
  ["graphs","equations-inequalities"], ["logic-truth"],
  ["equations-inequalities","graphs"], ["number","algebra-functions"],
  ["necessary-sufficient","graphs"],
 ],
 "2020-P1": [
  ["differentiation"], ["algebra-functions"], ["equations-inequalities"],
  ["sequences-series"], ["algebra-functions","graphs"],
  ["exponentials-logarithms","algebra-functions"], ["exponentials-logarithms","equations-inequalities"],
  ["algebra-functions","equations-inequalities"], ["algebra-functions"],
  ["graphs","algebra-functions"], ["integration","graphs"], ["trigonometry","graphs"],
  ["algebra-functions"], ["integration"], ["exponentials-logarithms","equations-inequalities"],
  ["coordinate-geometry","geometry"], ["equations-inequalities","coordinate-geometry"],
  ["trigonometry","equations-inequalities"], ["equations-inequalities","number"],
  ["algebra-functions","equations-inequalities"],
 ],
 "2020-P2": [
  ["equations-inequalities"], ["trigonometry"], ["argument-analysis","number"],
  ["proof-counterexample","number"], ["graphs","exponentials-logarithms"],
  ["necessary-sufficient","integration"], ["necessary-sufficient","geometry"],
  ["argument-analysis","equations-inequalities"], ["number","trigonometry"],
  ["equations-inequalities","logic-truth"], ["coordinate-geometry","sequences-series"],
  ["necessary-sufficient","integration"], ["integration","logic-truth"],
  ["sequences-series","necessary-sufficient"], ["trigonometry","necessary-sufficient"],
  ["argument-analysis","integration"], ["number"],
  ["algebra-functions","logic-truth"], ["logic-truth","counting-probability"], ["logic-truth"],
 ],
 "2021-P1": [
  ["coordinate-geometry"], ["integration","differentiation"], ["sequences-series"],
  ["exponentials-logarithms","algebra-functions"], ["number","logic-truth"],
  ["trigonometry","algebra-functions"], ["integration","graphs"],
  ["coordinate-geometry","equations-inequalities"], ["graphs","geometry"],
  ["integration","exponentials-logarithms"], ["differentiation"],
  ["algebra-functions","equations-inequalities"], ["integration","sequences-series"],
  ["graphs","trigonometry"], ["integration","graphs"], ["algebra-functions"],
  ["graphs","trigonometry"], ["coordinate-geometry","graphs"],
  ["trigonometry","exponentials-logarithms"], ["exponentials-logarithms","coordinate-geometry"],
 ],
 "2021-P2": [
  ["integration"], ["coordinate-geometry"], ["counting-probability","necessary-sufficient"],
  ["number","proof-counterexample"], ["argument-analysis","trigonometry"],
  ["necessary-sufficient","differentiation"], ["coordinate-geometry","geometry"],
  ["necessary-sufficient","differentiation"], ["logic-truth","algebra-functions"],
  ["sequences-series","proof-counterexample"], ["argument-analysis","algebra-functions"],
  ["integration","logic-truth"], ["equations-inequalities","logic-truth"],
  ["exponentials-logarithms","equations-inequalities"], ["coordinate-geometry","necessary-sufficient"],
  ["graphs","equations-inequalities"], ["exponentials-logarithms","equations-inequalities"],
  ["trigonometry","logic-truth"], ["trigonometry","equations-inequalities"],
  ["integration","sequences-series"],
 ],
 "2022-P1": [
  ["trigonometry","equations-inequalities"], ["coordinate-geometry","equations-inequalities"],
  ["integration","differentiation"], ["geometry","number"], ["sequences-series"],
  ["integration","exponentials-logarithms"], ["integration","graphs"],
  ["sequences-series"], ["trigonometry","algebra-functions"], ["graphs","algebra-functions"],
  ["exponentials-logarithms","sequences-series"], ["algebra-functions","graphs"],
  ["algebra-functions","equations-inequalities"], ["geometry","trigonometry"],
  ["differentiation","graphs"], ["algebra-functions","trigonometry"],
  ["trigonometry","geometry"], ["graphs","algebra-functions"],
  ["coordinate-geometry","counting-probability"], ["graphs","equations-inequalities"],
 ],
 "2022-P2": [
  ["differentiation"], ["algebra-functions","sequences-series"], ["number","proof-counterexample"],
  ["coordinate-geometry","necessary-sufficient"], ["coordinate-geometry","logic-truth"],
  ["number","necessary-sufficient"], ["argument-analysis","number"],
  ["sequences-series","counting-probability"], ["logic-truth","equations-inequalities"],
  ["logic-truth","number"], ["geometry","necessary-sufficient"],
  ["integration","exponentials-logarithms"], ["logic-truth","equations-inequalities"],
  ["equations-inequalities","graphs"], ["exponentials-logarithms","logic-truth"],
  ["sequences-series","logic-truth"], ["argument-analysis","algebra-functions"],
  ["graphs","trigonometry"], ["geometry","necessary-sufficient"], ["trigonometry","graphs"],
 ],
 "2023-P1": [
  ["integration"], ["equations-inequalities","coordinate-geometry"], ["integration"],
  ["trigonometry","sequences-series"], ["geometry","equations-inequalities"],
  ["algebra-functions","number"], ["exponentials-logarithms","equations-inequalities"],
  ["trigonometry","geometry"], ["trigonometry","equations-inequalities"],
  ["integration","geometry"], ["algebra-functions","graphs"],
  ["exponentials-logarithms","equations-inequalities"], ["coordinate-geometry","geometry"],
  ["differentiation","algebra-functions"], ["exponentials-logarithms","trigonometry"],
  ["coordinate-geometry"], ["coordinate-geometry","sequences-series"],
  ["sequences-series","counting-probability"], ["integration","graphs"],
  ["graphs","algebra-functions"],
 ],
 "2023-P2": [
  ["algebra-functions","equations-inequalities"], ["integration"],
  ["proof-counterexample","exponentials-logarithms"], ["argument-analysis","number"],
  ["necessary-sufficient","integration"], ["exponentials-logarithms","logic-truth"],
  ["coordinate-geometry","necessary-sufficient"], ["geometry","logic-truth"],
  ["logic-truth","geometry"], ["argument-analysis","equations-inequalities"],
  ["logic-truth","number"], ["trigonometry","logic-truth"],
  ["logic-truth","equations-inequalities"], ["coordinate-geometry","logic-truth"],
  ["number","sequences-series"], ["number","sequences-series"],
  ["integration","sequences-series"], ["equations-inequalities","necessary-sufficient"],
  ["differentiation","logic-truth"], ["integration","logic-truth"],
 ],
 "specimen-P1": [
  ["equations-inequalities"], ["trigonometry","equations-inequalities"], ["coordinate-geometry"],
  ["equations-inequalities"], ["exponentials-logarithms","algebra-functions"],
  ["algebra-functions"], ["counting-probability"], ["exponentials-logarithms"],
  ["algebra-functions","equations-inequalities"], ["graphs","trigonometry"],
  ["exponentials-logarithms","equations-inequalities"], ["geometry","algebra-functions"],
  ["algebra-functions","graphs"], ["exponentials-logarithms","graphs"],
  ["integration","differentiation"], ["exponentials-logarithms","number"],
  ["equations-inequalities","algebra-functions"], ["trigonometry","equations-inequalities"],
  ["sequences-series"], ["algebra-functions"],
 ],
 "specimen-P2": [
  ["coordinate-geometry"], ["differentiation"], ["argument-analysis","equations-inequalities"],
  ["logic-truth","proof-counterexample"], ["exponentials-logarithms","number"],
  ["number","geometry"], ["graphs","algebra-functions"], ["number","logic-truth"],
  ["logic-truth"], ["graphs","exponentials-logarithms"], ["number","trigonometry"],
  ["algebra-functions","logic-truth"], ["counting-probability"],
  ["graphs","differentiation"], ["equations-inequalities","logic-truth"],
  ["sequences-series"], ["logic-truth","number"], ["number","counting-probability"],
  ["algebra-functions","graphs"], ["logic-truth"],
 ],
}
# fmt: on

def main():
    answers = json.loads((DATA / "answers.json").read_text())
    options = json.loads((DATA / "options.json").read_text())
    manifest = json.loads((DATA / "crop-manifest.json").read_text())

    questions = []
    problems = []
    for paper_key, tag_rows in TAGS.items():
        year, pstr = paper_key.rsplit("-P", 1)
        assert len(tag_rows) == 20, f"{paper_key}: {len(tag_rows)} rows"
        for i, tags in enumerate(tag_rows, start=1):
            qid = f"{paper_key}-Q{i:02d}"
            if not (1 <= len(tags) <= 3):
                problems.append(f"{qid}: {len(tags)} tags")
            for t in tags:
                if t not in TAXONOMY:
                    problems.append(f"{qid}: unknown tag {t}")
            if qid not in answers:
                problems.append(f"{qid}: no answer")
            if qid not in manifest:
                problems.append(f"{qid}: no crop")
            questions.append({
                "id": qid,
                "year": year,
                "paper": int(pstr),
                "number": i,
                "image": f"questions/{qid}.png",
                "solutionImage": f"solutions/{qid}.png",
                "options": options.get(qid, 8),
                "answer": answers[qid],
                "topics": tags,
            })
    if problems:
        for p in problems:
            print("PROBLEM:", p)
        raise SystemExit(1)
    out = {"taxonomy": TAXONOMY, "questions": questions}
    (DATA / "questions.json").write_text(json.dumps(out, indent=1))
    from collections import Counter
    c = Counter(t for q in questions for t in q["topics"])
    print(f"{len(questions)} questions tagged; topic coverage:")
    for t, n in c.most_common():
        print(f"  {t:26} {n}")

if __name__ == "__main__":
    main()
