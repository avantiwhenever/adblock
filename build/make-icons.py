# Generates icons/icon{16,48,128}.png — a simple shield-with-checkmark
# glyph on a rounded-square background, matching the popup's --accent
# color. Run with `python3 build/make-icons.py` (requires Pillow: `pip
# install pillow`). Not run automatically as part of anything — the
# resulting PNGs are committed to the repo, so this only needs to be
# re-run if the icon design itself changes.
from PIL import Image, ImageDraw

SIZES = [128, 48, 16]
BG = (91, 91, 214, 255)  # matches popup.css's --accent (#5b5bd6)
FG = (255, 255, 255, 255)


def draw_icon(size):
    # Draw at 8x the target resolution, then downsample with a high-quality
    # filter at the end (Image.LANCZOS) — antialiasing shapes at a large
    # size and shrinking them looks noticeably cleaner than drawing
    # directly at 16px, where individual lines are only a couple of pixels
    # wide and PIL's own rasterization has no antialiasing of its own.
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = s * 0.22
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # Simple shield glyph: a hexagon-ish outline (flat top, pointed bottom)
    # built from six explicit points, sized relative to the canvas so it
    # scales correctly at every icon size.
    cx, cy = s / 2, s / 2
    w, h = s * 0.46, s * 0.52
    top = cy - h / 2
    shield = [
        (cx, top),
        (cx + w / 2, top + h * 0.18),
        (cx + w / 2, top + h * 0.55),
        (cx, top + h),
        (cx - w / 2, top + h * 0.55),
        (cx - w / 2, top + h * 0.18),
    ]
    d.polygon(shield, fill=FG)

    # Checkmark "cut out" of the shield: drawn in the background color on
    # top of the white shield, rather than actually punching a hole in it,
    # which is simpler than working with alpha masks for a two-segment line.
    ck_w = s * 0.05
    p1 = (cx - w * 0.20, cy + h * 0.02)
    p2 = (cx - w * 0.02, cy + h * 0.20)
    p3 = (cx + w * 0.24, cy - h * 0.18)
    d.line([p1, p2], fill=BG, width=int(ck_w))
    d.line([p2, p3], fill=BG, width=int(ck_w))

    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    icon = draw_icon(size)
    icon.save(f"icons/icon{size}.png")
    print(f"wrote icons/icon{size}.png")
