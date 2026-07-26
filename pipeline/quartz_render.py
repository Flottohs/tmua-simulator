"""Render PDF pages via macOS Quartz (CoreGraphics) — the same engine as
Preview — to avoid PyMuPDF's glyph-dropping on broken embedded font subsets.

render_page(pdf_path, page_index_0based, dpi) -> grayscale PNG bytes in memory
(via a CGBitmapContext), returned as a fitz.Pixmap for downstream compositing.
"""
import Quartz
import CoreFoundation
import fitz

_doc_cache = {}

def _doc(pdf_path):
    key = str(pdf_path)
    if key not in _doc_cache:
        url = CoreFoundation.CFURLCreateFromFileSystemRepresentation(
            None, key.encode(), len(key.encode()), False)
        _doc_cache[key] = Quartz.CGPDFDocumentCreateWithURL(url)
    return _doc_cache[key]

_page_cache = {}

def render_page_cached(pdf_path, pno, dpi=200):
    key = (str(pdf_path), pno, dpi)
    if key not in _page_cache:
        if len(_page_cache) > 8:
            _page_cache.clear()
        _page_cache[key] = render_page(pdf_path, pno, dpi)
    return _page_cache[key]

def crop_points(pdf_path, pno, rect_pts, dpi=200):
    """Render page and crop a rect given in PDF points -> gray Pixmap at (0,0)."""
    full = render_page_cached(pdf_path, pno, dpi)
    s = dpi / 72.0
    ir = fitz.IRect(round(rect_pts[0] * s), round(rect_pts[1] * s),
                    round(rect_pts[2] * s), round(rect_pts[3] * s)) & full.irect
    pm = fitz.Pixmap(full, full.width, full.height, ir)
    pm.set_origin(0, 0)
    return pm

def render_page(pdf_path, pno, dpi=200):
    """Render full page -> fitz.Pixmap (gray, no alpha)."""
    doc = _doc(pdf_path)
    page = Quartz.CGPDFDocumentGetPage(doc, pno + 1)  # 1-based
    box = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFCropBox)
    scale = dpi / 72.0
    w = int(round(box.size.width * scale))
    h = int(round(box.size.height * scale))
    cs = Quartz.CGColorSpaceCreateDeviceGray()
    ctx = Quartz.CGBitmapContextCreate(None, w, h, 8, w, cs,
                                       Quartz.kCGImageAlphaNone)
    # white background
    Quartz.CGContextSetGrayFillColor(ctx, 1.0, 1.0)
    Quartz.CGContextFillRect(ctx, Quartz.CGRectMake(0, 0, w, h))
    Quartz.CGContextSaveGState(ctx)
    Quartz.CGContextScaleCTM(ctx, scale, scale)
    Quartz.CGContextTranslateCTM(ctx, -box.origin.x, -box.origin.y)
    Quartz.CGContextDrawPDFPage(ctx, page)
    Quartz.CGContextRestoreGState(ctx)
    data = Quartz.CGBitmapContextGetData(ctx)
    buf = bytes(data.as_buffer(w * h)) if data else b"\xff" * (w * h)
    # CGBitmapContext memory is already top-down for row 0
    return fitz.Pixmap(fitz.csGRAY, w, h, buf, 0)

if __name__ == "__main__":
    import sys
    pm = render_page(sys.argv[1], int(sys.argv[2]), 200)
    pm.save(sys.argv[3])
    print("saved", sys.argv[3], pm.width, pm.height)
