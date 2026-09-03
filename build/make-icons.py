from PIL import Image, ImageDraw
import math

SIZES = [128, 48, 16]
BG = (91, 91, 214, 255)   # matches popup --accent
FG = (255, 255, 255, 255)

def draw_icon(size):
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = s * 0.22
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # Simple shield glyph.
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

    # Checkmark cut out of the shield.
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
