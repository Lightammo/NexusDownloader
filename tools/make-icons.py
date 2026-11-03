#!/usr/bin/env python
"""Generates the extension icons (16/48/128) with Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded dark tile
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=118, fill=(23, 26, 33, 255))

# orange badge
pad = 46
d.ellipse([pad, pad, S - pad, S - pad], fill=(232, 135, 30, 255))

# white download arrow
cx = S // 2
d.rounded_rectangle([cx - 27, 176, cx + 27, 316], radius=18, fill=(255, 255, 255, 255))
d.polygon([(cx - 92, 300), (cx + 92, 300), (cx, 404)], fill=(255, 255, 255, 255))
d.rounded_rectangle([cx - 105, 428, cx + 105, 460], radius=16, fill=(255, 255, 255, 255))

for size in (128, 48, 16):
    icon = img.resize((size, size), Image.LANCZOS)
    path = OUT / f"icon{size}.png"
    icon.save(path, "PNG")
    print(path)
