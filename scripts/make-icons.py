#!/usr/bin/env python3
"""Generate the extension's PNG icons without any third-party dependencies.

Draws a rounded indigo square with a white "download" glyph (a down arrow
landing on a tray) at 16/32/48/128 px. Pure stdlib: builds an RGBA raster
and encodes it as a PNG via zlib + manual chunk framing.
"""
import struct
import zlib
import os

BG = (91, 108, 240)      # indigo  #5B6CF0
BG2 = (124, 92, 246)     # violet   (subtle vertical gradient toward this)
FG = (255, 255, 255)     # white glyph

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def lerp(a, b, t):
    return a + (b - a) * t


def mix(under, over, alpha):
    """Alpha-composite `over` (rgb) onto `under` (rgb) with `alpha` in [0,1]."""
    return tuple(int(round(lerp(under[i], over[i], alpha))) for i in range(3))


def rounded_rect_coverage(x, y, w, h, radius):
    """Fractional coverage of pixel (x,y) by a rounded rect filling 0..w,0..h."""
    r = radius
    # nearest point inside the "core" rectangle (inset by r) to the pixel center
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    # 1px-wide smooth edge
    return max(0.0, min(1.0, r - dist + 0.5))


def glyph_alpha(px, py, n):
    """Return glyph coverage [0,1] for a point in an n x n icon (download icon)."""
    x = px / n
    y = py / n

    def bar(x0, x1, y0, y1, soft=0.012):
        # smooth rectangle membership
        ax = min(x - x0, x1 - x) / soft
        ay = min(y - y0, y1 - y) / soft
        return max(0.0, min(1.0, ax)) * max(0.0, min(1.0, ay))

    cover = 0.0
    # vertical shaft of the arrow
    cover = max(cover, bar(0.435, 0.565, 0.26, 0.56))
    # arrow head (triangle pointing down), spanning y 0.50..0.70
    if 0.50 <= y <= 0.705:
        t = (y - 0.50) / (0.705 - 0.50)        # 0 at top of head, 1 at tip
        half = lerp(0.20, 0.0, t)
        if abs(x - 0.5) <= half:
            edge = (half - abs(x - 0.5)) / 0.02
            cover = max(cover, max(0.0, min(1.0, edge)))
    # tray / base line the arrow drops into
    cover = max(cover, bar(0.26, 0.74, 0.76, 0.84))
    return cover


def render(n):
    radius = n * 0.235
    px = bytearray()
    SS = 3  # supersampling factor for anti-aliasing
    for y in range(n):
        px.append(0)  # PNG filter type 0 for this scanline
        for x in range(n):
            r_acc = g_acc = b_acc = a_acc = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) / SS
                    fy = y + (sy + 0.5) / SS
                    cov = rounded_rect_coverage(fx, fy, n, n, radius)
                    if cov <= 0:
                        continue  # fully transparent outside the rounded square
                    t = fy / n
                    base = tuple(int(round(lerp(BG[i], BG2[i], t))) for i in range(3))
                    g = glyph_alpha(fx, fy, n)
                    col = mix(base, FG, g)
                    r_acc += col[0] * cov
                    g_acc += col[1] * cov
                    b_acc += col[2] * cov
                    a_acc += 255 * cov
            inv = 1.0 / (SS * SS)
            a = a_acc * inv
            if a <= 0:
                px.extend((0, 0, 0, 0))
            else:
                # un-premultiply the color by coverage so edges stay crisp
                px.append(int(round(r_acc / (a_acc / 255.0))))
                px.append(int(round(g_acc / (a_acc / 255.0))))
                px.append(int(round(b_acc / (a_acc / 255.0))))
                px.append(int(round(a)))
    return bytes(px)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))


def write_png(path, n):
    raw = render(n)
    ihdr = struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({n}x{n}, {len(png)} bytes)")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for n in (16, 32, 48, 128):
        write_png(os.path.join(OUT_DIR, f"icon{n}.png"), n)


if __name__ == "__main__":
    main()
