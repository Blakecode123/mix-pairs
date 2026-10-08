"""Draws the app icon (two overlapping records) into www/ at the sizes the web manifest needs.

The artwork stays inside the middle 80% so Android can crop it to a circle or squircle.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "www"
BG, PURPLE, YELLOW = "#0d0b09", "#f3ead9", "#ffa31a"
SCALE = 4  # draw oversized, then shrink, for smooth edges


def disc(draw, cx, cy, r, fill):
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)


def make(size):
    s = size * SCALE
    img = Image.new("RGB", (s, s), BG)
    draw = ImageDraw.Draw(img)
    r = s * 0.20
    for cx, colour in ((s * 0.39, PURPLE), (s * 0.61, YELLOW)):
        disc(draw, cx, s / 2, r, colour)
        disc(draw, cx, s / 2, r * 0.23, BG)
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png")


for size in (192, 512):
    make(size)
print("icons written to", OUT)
