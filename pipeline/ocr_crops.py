"""Independent image + OCR analysis of every question crop.

Deliberately does NOT reuse the build-time PDF text layer. It measures the
rendered PNGs only, using macOS Vision (on-device, offline) so the results are
an independent check on the pipeline's own claims.

Writes data/crop-ocr.json:
  { qid: { w, h, ink, qnum, letters, last_option, stem_ok } }

  ink         fraction of non-white pixels (blank detection)
  qnum        question number OCR'd from the top-left corner region
  letters     option letters found as standalone glyphs in the left margin
  last_option highest consecutive letter from A (so 'F' means A-F present)
"""
import json
import pathlib
import re
import sys

import fitz
import Vision
import Quartz
from Foundation import NSURL

ROOT = pathlib.Path(__file__).resolve().parent.parent
QDIR = ROOT / "assets" / "questions"
OUT = ROOT / "data" / "crop-ocr.json"


def ocr(path, region=None):
    """OCR a PNG. region = (x0,y0,x1,y1) in fractions of the image, top-left origin.
    Returns list of (text, x_frac, y_frac_from_top, h_frac)."""
    url = NSURL.fileURLWithPath_(str(path))
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, {})
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)          # 0 = accurate
    req.setUsesLanguageCorrection_(False)
    if region:
        x0, y0, x1, y1 = region
        # Vision ROI origin is bottom-left
        req.setRegionOfInterest_(Quartz.CGRectMake(x0, 1 - y1, x1 - x0, y1 - y0))
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        return []
    out = []
    for obs in (req.results() or []):
        cand = obs.topCandidates_(1)
        if not cand:
            continue
        box = obs.boundingBox()
        out.append((
            cand[0].string(),
            float(box.origin.x),
            1.0 - float(box.origin.y + box.size.height),   # y from top
            float(box.size.height),
        ))
    return out


def analyse(qid, path):
    pm = fitz.Pixmap(str(path))          # raises if the file is not a valid image
    w, h = pm.width, pm.height
    samples = pm.samples
    # ink ratio on a subsampled grid (every 4th pixel) for speed
    dark = 0
    total = 0
    stride = pm.stride
    for y in range(0, h, 4):
        row = samples[y * stride: y * stride + w]
        for i in range(0, len(row), 4):
            total += 1
            if row[i] < 200:
                dark += 1
    ink = dark / total if total else 0.0

    full = ocr(path)

    # Question number: read from the FULL-image pass. Cropping down to just the
    # digit makes Vision flip 6 and 9 (no surrounding text to fix orientation),
    # so the number is taken as the leftmost bare number in the top strip.
    qnum = None
    cands = [(x, t.strip()) for t, x, y, _h in full
             if y < 0.18 and x < 0.09 and re.fullmatch(r"\d{1,2}\.?", t.strip())]
    if cands:
        cands.sort()
        qnum = int(cands[0][1].rstrip("."))

    # Option letters. OCR readily merges the letter into the maths beside it,
    # so it UNDER-detects; two passes are unioned and the result is only ever
    # used as a lower bound (a letter seen definitely exists).
    letters = set()
    for obs in (full, ocr(path, region=(0.045, 0.0, 0.30, 1.0))):
        for text, x, y, _hh in obs:
            t = text.strip()
            if x < 0.30:
                m = re.match(r"^([A-H])(?:[\s.)]|$)", t)
                if m:
                    letters.add(m.group(1))
    highest = max(letters) if letters else None

    return {
        "w": w, "h": h, "ink": round(ink, 5),
        "qnum": qnum,
        "letters": "".join(sorted(letters)),
        "highest": highest,
    }


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    files = sorted(QDIR.glob("*.png"))
    if only:
        files = [f for f in files if only in f.name]
    out = {}
    for i, f in enumerate(files, 1):
        qid = f.stem
        try:
            out[qid] = analyse(qid, f)
        except Exception as e:
            out[qid] = {"error": str(e)}
        if i % 40 == 0:
            print(f"  {i}/{len(files)}", flush=True)
    if only:
        print(json.dumps(out, indent=1))
        return
    OUT.write_text(json.dumps(out, indent=1))
    print(f"wrote {OUT.relative_to(ROOT)} for {len(out)} crops")


if __name__ == "__main__":
    main()
