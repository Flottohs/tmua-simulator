"""Generate the macOS app icon (build/icon.icns) offline with Pillow.

Design: a Big Sur style rounded square with an indigo-to-blue gradient, a white
parabola with axes as the mark (recognisable at Dock size without depending on
any font), and 'TMUA' beneath for the larger renditions.

Run:  pipeline/.venv/bin/python pipeline/make_icon.py
Then: iconutil -c icns build/icon.iconset -o build/icon.icns
"""
import math
import pathlib
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"

TOP = (67, 88, 214)        # indigo
BOTTOM = (26, 132, 224)    # blue
SS = 4                     # supersample factor for clean edges


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size):
    g = Image.new("RGB", (1, size))
    px = g.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
    return g.resize((size, size), Image.BILINEAR)


def find_font(size):
    for path in [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ]:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def draw_icon(px):
    """Render one square icon at px pixels."""
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    base = gradient(S).convert("RGBA")
    img.paste(base, (0, 0), rounded_mask(S, int(S * 0.2237)))

    d = ImageDraw.Draw(img)
    # soft highlight across the top third
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse([-S * 0.35, -S * 0.75, S * 1.35, S * 0.42],
                               fill=(255, 255, 255, 26))
    img.alpha_composite(Image.composite(hl, Image.new("RGBA", (S, S), (0, 0, 0, 0)),
                                        rounded_mask(S, int(S * 0.2237))))

    # ---- the mark: an upward parabola over subtle axes ----
    # PIL's thick polylines serrate at tight curvature, so the stroke is laid
    # down as overlapping discs along a densely sampled path instead.
    # Axes are L-shaped (left and bottom). A centred vertical axis would run
    # straight through the vertex and make the whole mark read as a psi.
    cx = S * 0.545
    axis_y = S * 0.655                    # x-axis height
    axis_x = S * 0.215                    # y-axis position, left of the curve
    half = S * 0.215                      # half-width of the plot
    amp = S * 0.275                       # curve height above the vertex
    vertex_y = axis_y - S * 0.055
    axis_w = max(2, int(S * 0.016))
    curve_r = max(2, S * 0.032)
    axis = (255, 255, 255, 130)
    white = (255, 255, 255, 255)

    d.line([(axis_x, axis_y), (S * 0.845, axis_y)], fill=axis, width=axis_w)
    d.line([(axis_x, axis_y), (axis_x, S * 0.215)], fill=axis, width=axis_w)

    def stroke(points, radius, colour):
        for (x, y) in points:
            d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=colour)

    pts = []
    N = 400
    for i in range(N + 1):
        t = -1.0 + 2.0 * i / N
        pts.append((cx + t * half, vertex_y - amp * t * t))
    stroke(pts, curve_r, white)

    # ---- wordmark (skipped at sizes where it would be mud) ----
    if px >= 64:
        font = find_font(int(S * 0.135))
        if font:
            text = "TMUA"
            box = d.textbbox((0, 0), text, font=font)
            tw = box[2] - box[0]
            d.text((cx - tw / 2 - box[0], S * 0.735), text, font=font,
                   fill=(255, 255, 255, 235))

    return img.resize((px, px), Image.LANCZOS)


def main():
    ICONSET.mkdir(parents=True, exist_ok=True)
    # macOS iconset requires these exact names
    specs = [
        (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
    ]
    cache = {}
    for px, name in specs:
        if px not in cache:
            cache[px] = draw_icon(px)
        cache[px].save(ICONSET / name)
    # electron-builder also accepts a plain 1024 png
    cache[1024].save(BUILD / "icon.png")

    out = BUILD / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(ICONSET), "-o", str(out)], check=True)
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB) "
          f"from {len(specs)} renditions")


if __name__ == "__main__":
    main()
