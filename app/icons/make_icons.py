#!/usr/bin/env python3
"""Generate the PWA icons: a rounded pink square with a white 字.

No CJK font is required: the glyph is drawn as vector strokes so the icon
renders identically everywhere. Uses Pillow when available, otherwise falls
back to a minimal pure-stdlib PNG writer (rounded square + simplified glyph).

    python3 app/icons/make_icons.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PINK = (236, 72, 153)      # #ec4899, the kanji colour
WHITE = (255, 255, 255)
SIZES = (192, 512)

# Strokes of 字 on a 1000 x 1000 design grid, as polylines (x, y).
# Top: 宀 (dot, roof with two short legs). Bottom: 子 (bent top stroke,
# vertical with hook, long horizontal).
STROKES = [
    [(500, 150), (500, 245)],                       # dot
    [(215, 300), (785, 300)],                       # roof
    [(215, 300), (215, 410)],                       # roof, left leg
    [(785, 300), (785, 410)],                       # roof, right leg
    [(330, 470), (655, 470), (560, 580)],           # 子 top stroke with diagonal
    [(500, 555), (500, 845), (440, 815)],           # vertical with hook
    [(190, 665), (810, 665)],                       # long horizontal
]
STROKE_WIDTH = 64


def render_pillow(size):
    from PIL import Image, ImageDraw
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(big * 0.22)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=PINK + (255,))
    k = big / 1000.0
    w = int(STROKE_WIDTH * k)
    for pts in STROKES:
        scaled = [(x * k, y * k) for x, y in pts]
        draw.line(scaled, fill=WHITE + (255,), width=w, joint="curve")
        for (x, y) in scaled:  # round caps
            draw.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE + (255,))
    return img.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------------------
# Fallback: pure standard library PNG encoder
# ---------------------------------------------------------------------------

def _chunk(tag, payload):
    body = tag + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, size, pixel):
    """pixel(x, y) -> (r, g, b, a)."""
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            row.extend(pixel(x, y))
        rows.append(bytes(row))
    raw = b"".join(rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += _chunk(b"IDAT", zlib.compress(raw, 9))
    png += _chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def _dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / float(dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def render_stdlib(path, size):
    radius = size * 0.22
    k = size / 1000.0
    half = STROKE_WIDTH * k / 2.0
    segments = []
    for pts in STROKES:
        for i in range(len(pts) - 1):
            segments.append((pts[i][0] * k, pts[i][1] * k, pts[i + 1][0] * k, pts[i + 1][1] * k))

    def inside_rounded(x, y):
        cx = min(max(x, radius), size - radius)
        cy = min(max(y, radius), size - radius)
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius

    def pixel(x, y):
        px, py = x + 0.5, y + 0.5
        if not inside_rounded(px, py):
            return (0, 0, 0, 0)
        for (ax, ay, bx, by) in segments:
            if _dist_to_segment(px, py, ax, ay, bx, by) <= half:
                return WHITE + (255,)
        return PINK + (255,)

    write_png(path, size, pixel)


def main():
    for size in SIZES:
        out = os.path.join(HERE, "icon-%d.png" % size)
        try:
            img = render_pillow(size)
            img.save(out, "PNG")
            how = "pillow"
        except Exception:  # Pillow missing or too old
            render_stdlib(out, size)
            how = "stdlib"
        print("wrote %s (%s)" % (out, how))


if __name__ == "__main__":
    main()
