#!/usr/bin/env python3
"""Build icon assets for Edge Resource Downloader (writes icons/ only).

ONE parameterised geometry table in 128x128 user units drives every artefact,
so style / colour / composition are shared across all sizes.  That table is
then rendered with *optical sizing* -- the small raster sizes get deliberate,
documented simplifications instead of a blind downscale:

    size    optical corrections
    ----    ---------------------------------------------------------------
    16      no corner play-triangle (it turns to dirt), fatter arrow, wider
            head, smaller corner radius, larger arrow<->bar gap, stronger
            dark contour so it reads on Edge's light toolbar
    32      small low-contrast play-triangle, enlarged arrow body
    48      full composition at reduced contrast weight for the triangle
    128     complete detail: triangle + refined rim highlights

Artefacts:
    logo.svg / icon-mono.svg   exact coordinates, no external references
    icon{16,32,48,128}.png     same table, 8x supersampling, Pillow only
    preview.png                dark / light / mid-grey contact sheet

Run:  python icons/build_icons.py
"""

from __future__ import annotations

import pathlib
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent
SIZES = (16, 32, 48, 128)
SS = 8                      # supersampling factor (128 * 8 = 1024px master)
VIEW = 128.0                # user units

BRAND1 = (99, 102, 241)     # --brand-1 #6366f1  indigo
BRAND2 = (34, 211, 238)     # --brand-2 #22d3ee  cyan
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)


# ---------------------------------------------------------------- geometry ---
@dataclass(frozen=True)
class Variant:
    """Per-size geometry. Everything is expressed in 128x128 user units."""

    inset: float                     # container margin inside the 128 canvas
    body_r: float                    # container corner radius
    shaft: tuple[float, float, float, float]      # x, y, w, h
    shaft_r: float
    head: tuple[tuple[float, float], ...]         # rounded triangle
    head_r: float
    bar: tuple[float, float, float, float]        # x, y, w, h
    bar_r: float
    ghost: tuple[tuple[float, float], ...] | None
    ghost_r: float
    ghost_a: float
    rim_light: float                 # white inner highlight alpha
    rim_dark: float                  # black contour alpha (light-bg legibility)
    rim_w: float


VARIANTS: dict[int, Variant] = {
    # -- 16px: maximum simplicity. Bold arrow, no triangle, wide gap.
    #    Optical sizing for the smallest raster:
    #      * container inset 4u (~0.5px) + corner radius 26u (3.25px, ~20% of
    #        the edge) -> four visible transparent corners, ~4% fully
    #        transparent pixels, 91% opaque (the 32px icon is ~94% covered);
    #      * the play triangle is dropped: at 16px it degrades into a dirty
    #        blob, the arrow alone carries the meaning;
    #      * arrow simplified to shaft + flat head, bold strokes, generous gap
    #        between the head and the "saved file" bar.
    16: Variant(
        inset=4.0, body_r=26.0,
        shaft=(56.0, 25.0, 18.0, 32.0), shaft_r=9.0,
        head=((38.0, 53.0), (90.0, 53.0), (64.0, 79.0)), head_r=5.0,
        bar=(39.0, 99.0, 50.0, 12.0), bar_r=6.0,
        ghost=None, ghost_r=0.0, ghost_a=0.0,
        rim_light=0.20, rim_dark=0.32, rim_w=3.0,
    ),
    # -- 32px: triangle returns, small + low contrast ------------------------
    32: Variant(
        inset=3.6, body_r=26.0,
        shaft=(55.0, 23.0, 18.0, 32.0), shaft_r=9.0,
        head=((33.0, 50.0), (95.0, 50.0), (64.0, 79.0)), head_r=5.5,
        bar=(35.0, 96.0, 58.0, 12.0), bar_r=6.0,
        ghost=((93.0, 29.0), (93.0, 55.0), (114.0, 42.0)), ghost_r=3.5, ghost_a=0.10,
        rim_light=0.18, rim_dark=0.24, rim_w=2.6,
    ),
    # -- 48px: full composition ---------------------------------------------
    48: Variant(
        inset=4.5, body_r=28.0,
        shaft=(55.5, 22.0, 17.0, 32.0), shaft_r=8.5,
        head=((34.0, 47.0), (94.0, 47.0), (64.0, 77.0)), head_r=5.5,
        bar=(34.5, 96.0, 59.0, 12.0), bar_r=6.0,
        ghost=((91.0, 27.0), (91.0, 55.0), (114.5, 41.0)), ghost_r=3.5, ghost_a=0.12,
        rim_light=0.20, rim_dark=0.22, rim_w=2.0,
    ),
    # -- 128px: full detail --------------------------------------------------
    128: Variant(
        inset=5.0, body_r=29.0,
        shaft=(56.0, 20.0, 16.0, 32.0), shaft_r=8.0,
        head=((34.0, 46.0), (94.0, 46.0), (64.0, 76.0)), head_r=6.0,
        bar=(34.0, 96.0, 60.0, 12.0), bar_r=6.0,
        ghost=((90.0, 26.0), (90.0, 56.0), (115.0, 41.0)), ghost_r=4.0, ghost_a=0.15,
        rim_light=0.22, rim_dark=0.18, rim_w=1.5,
    ),
}


def body_box(v: Variant) -> tuple[float, float, float, float]:
    return (v.inset, v.inset, VIEW - 2 * v.inset, VIEW - 2 * v.inset)


# --------------------------------------------------------------- primitives --
def _dir(dx: float, dy: float) -> tuple[float, float]:
    length = (dx * dx + dy * dy) ** 0.5
    return dx / length, dy / length


def _corners(pts, radius: float):
    """Rounded convex polygon as (start, control, end) arcs, one per vertex."""
    n = len(pts)
    out = []
    for i in range(n):
        vx, vy = pts[i]
        px, py = pts[(i - 1) % n]
        nx, ny = pts[(i + 1) % n]
        ux, uy = _dir(vx - px, vy - py)          # direction entering the vertex
        wx, wy = _dir(nx - vx, ny - vy)          # direction leaving the vertex
        cosang = max(-1.0, min(1.0, (-ux) * wx + (-uy) * wy))
        tan_len = radius / np.tan(np.arccos(cosang) / 2.0)
        out.append(((vx - ux * tan_len, vy - uy * tan_len),
                    (vx, vy),
                    (vx + wx * tan_len, vy + wy * tan_len)))
    return out


def outline(pts, radius: float, steps: int = 20) -> list[tuple[float, float]]:
    """Dense sample of the rounded polygon (convex quadratic Beziers)."""
    arcs = _corners(pts, radius)
    pts_out: list[tuple[float, float]] = []
    for i, (start, ctrl, end) in enumerate(arcs):
        for s in range(steps + 1):
            t = s / steps
            mt = 1.0 - t
            pts_out.append((
                mt * mt * start[0] + 2.0 * mt * t * ctrl[0] + t * t * end[0],
                mt * mt * start[1] + 2.0 * mt * t * ctrl[1] + t * t * end[1],
            ))
    return pts_out


def svg_path(pts, radius: float) -> str:
    """The very same rounded polygon as an SVG `M / Q / L` path."""
    arcs = _corners(pts, radius)
    n = len(arcs)
    f = lambda p: f"{round(p[0], 3):g} {round(p[1], 3):g}"
    parts = [f"M{f(arcs[0][0])}"]
    for i in range(n):
        _, ctrl, end = arcs[i]
        parts.append(f"Q{f(ctrl)} {f(end)}")
        if i < n - 1:
            parts.append(f"L{f(arcs[i + 1][0])}")
    parts.append("Z")
    return "".join(parts)


def shaft_path(v: Variant) -> str:
    """Arrow shaft: rounded top corners, square bottom (hidden by the head)."""
    x, y, w, h, r = (*v.shaft, v.shaft_r)
    f = lambda a: f"{round(a, 3):g}"
    return (f"M{f(x)} {f(y + r)}a{f(r)} {f(r)} 0 0 1 {f(r)} {f(-r)}"
            f"h{f(w - 2 * r)}a{f(r)} {f(r)} 0 0 1 {f(r)} {f(r)}"
            f"v{f(h - r)}h{f(-w)}Z")


# -------------------------------------------------------------------- raster --
def _gradient(n: int) -> np.ndarray:
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    t = np.clip((xs + ys) / (2.0 * (n - 1)), 0.0, 1.0)[..., None]
    return (1.0 - t) * np.array(BRAND1, np.float32) + t * np.array(BRAND2, np.float32)


def _layer(n: int, color=(0, 0, 0, 0)) -> Image.Image:
    return Image.new("RGBA", (n, n), color)


def render(size: int, mono: tuple[int, int, int] | None = None,
           variant: int | None = None) -> Image.Image:
    """Rasterise one size. `mono` overrides the brand gradient (used in preview).

    `variant` lets a non-standard render size reuse the closest optical variant
    (e.g. the 15px popup mono mark borrows the simplified 16px geometry).
    """
    v = VARIANTS[variant if variant is not None else size]
    n = size * SS
    k = n / VIEW

    if mono is None:
        base = Image.fromarray(
            np.clip(_gradient(n), 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    else:
        base = _layer(n, mono + (255,))

    # faint play triangle (media cue) -- omitted at 16px
    if v.ghost is not None:
        g = _layer(n)
        ImageDraw.Draw(g).polygon(
            [(x * k, y * k) for x, y in outline(v.ghost, v.ghost_r)],
            fill=WHITE + (int(round(v.ghost_a * 255)),))
        base = Image.alpha_composite(base, g)

    # white glyph: bar, then shaft, then head on top (head hides the shaft butt)
    gl = _layer(n)
    d = ImageDraw.Draw(gl)
    bx, by, bw, bh = v.bar
    d.rounded_rectangle((bx * k, by * k, (bx + bw) * k, (by + bh) * k),
                        radius=v.bar_r * k, fill=WHITE + (255,))
    sx, sy, sw, sh = v.shaft
    d.rounded_rectangle((sx * k, sy * k, (sx + sw) * k, (sy + sh) * k),
                        radius=v.shaft_r * k, corners=(True, True, False, False),
                        fill=WHITE + (255,))
    d.polygon([(x * k, y * k) for x, y in outline(v.head, v.head_r)],
              fill=WHITE + (255,))
    base = Image.alpha_composite(base, gl)

    # container rim: dark contour (light-toolbar legibility) + inner highlight
    rim = _layer(n)
    dr = ImageDraw.Draw(rim)
    cx, cy, cw, ch = body_box(v)
    dark_w = v.rim_w * k
    dr.rounded_rectangle(
        (cx * k + dark_w / 2, cy * k + dark_w / 2,
         (cx + cw) * k - dark_w / 2, (cy + ch) * k - dark_w / 2),
        radius=(v.body_r - v.rim_w / 2) * k,
        outline=BLACK + (int(round(v.rim_dark * 255)),),
        width=max(1, int(round(dark_w))))
    hi_w = dark_w * 0.55
    dr.rounded_rectangle(
        (cx * k + dark_w + hi_w / 2, cy * k + dark_w + hi_w / 2,
         (cx + cw) * k - dark_w - hi_w / 2, (cy + ch) * k - dark_w - hi_w / 2),
        radius=(v.body_r - v.rim_w - hi_w / 2) * k,
        outline=WHITE + (int(round(v.rim_light * 255)),),
        width=max(1, int(round(hi_w))))
    base = Image.alpha_composite(base, rim)

    # clip everything to the rounded-square container
    mask = _layer(n, (0, 0, 0, 0)).convert("L")
    ImageDraw.Draw(mask).rounded_rectangle(
        (cx * k, cy * k, (cx + cw) * k, (cy + ch) * k),
        radius=v.body_r * k, fill=255)
    cov = np.asarray(mask, np.float32) / 255.0
    if mono is None:
        a = np.asarray(base.getchannel("A"), np.float32) * cov
        base.putalpha(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L"))

    # downsample: colour and coverage are resampled separately so edge pixels
    # are not darkened by RGB that lives outside the visible container.
    # Colour uses LANCZOS (crisp gradient), coverage uses BOX: the alpha channel
    # is an area-coverage mask, and a box filter is exactly area averaging.
    # LANCZOS overshoots on hard mask edges and would inflate the opaque ratio.
    arr = np.asarray(base, np.float32)
    rgb = np.stack([
        np.asarray(Image.fromarray(arr[..., c].astype(np.uint8), "L")
                   .resize((size, size), Image.LANCZOS), np.float32)
        for c in range(3)], axis=-1)
    alpha = np.asarray(Image.fromarray(arr[..., 3].astype(np.uint8), "L")
                       .resize((size, size), Image.BOX), np.float32)
    if mono is None:
        alpha[alpha < 1.0] = 0.0
    return Image.fromarray(
        np.dstack([np.clip(rgb, 0, 255), np.clip(alpha, 0, 255)]).astype(np.uint8),
        "RGBA")


# ----------------------------------------------------------------------- svg --
def _hex(c) -> str:
    return "#%02x%02x%02x" % tuple(c)


def logo_svg() -> str:
    """Full-detail vector source (matches the 128px raster exactly)."""
    v = VARIANTS[128]
    bx, by, bw, bh = body_box(v)
    ox, oy, ow, oh = v.bar
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" '
        'height="128" role="img" aria-label="Edge Resource Downloader">\n'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="128" y2="128" '
        'gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="{_hex(BRAND1)}"/>'
        f'<stop offset="1" stop-color="{_hex(BRAND2)}"/>'
        '</linearGradient></defs>\n'
        f'<rect x="{bx:g}" y="{by:g}" width="{bw:g}" height="{bh:g}" '
        f'rx="{v.body_r:g}" fill="url(#g)"/>\n'
        f'<path d="{svg_path(v.ghost, v.ghost_r)}" fill="#fff" '
        f'fill-opacity="{v.ghost_a:g}"/>\n'
        f'<rect x="{ox:g}" y="{oy:g}" width="{ow:g}" height="{oh:g}" '
        f'rx="{v.bar_r:g}" fill="#fff"/>\n'
        f'<path d="{shaft_path(v)}" fill="#fff"/>\n'
        f'<path d="{svg_path(v.head, v.head_r)}" fill="#fff"/>\n'
        f'<rect x="{bx + v.rim_w / 2:g}" y="{by + v.rim_w / 2:g}" '
        f'width="{bw - v.rim_w:g}" height="{bh - v.rim_w:g}" '
        f'rx="{v.body_r - v.rim_w / 2:g}" fill="none" stroke="#fff" '
        f'stroke-opacity="{v.rim_light:g}" stroke-width="{v.rim_w:g}"/>\n'
        '</svg>\n'
    )


def mono_svg() -> str:
    """currentColor version for the popup brand row (rendered at 15px).

    Inherits the 16px optical variant: no play triangle, bold arrow, so the
    mark stays legible at a 15px render size.
    """
    v = VARIANTS[16]
    ox, oy, ow, oh = v.bar
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" '
        'height="128" fill="currentColor" role="img" '
        'aria-label="Edge Resource Downloader">\n'
        f'<rect x="{ox:g}" y="{oy:g}" width="{ow:g}" height="{oh:g}" '
        f'rx="{v.bar_r:g}"/>\n'
        f'<path d="{shaft_path(v)}"/>\n'
        f'<path d="{svg_path(v.head, v.head_r)}"/>\n'
        '</svg>\n'
    )


# ------------------------------------------------------------------- preview --
def build_preview(images: dict[int, Image.Image]) -> Image.Image:
    pad, gap = 26, 30
    rows = [
        ("dark  #0b0f19", (11, 15, 25, 255)),
        ("light #f5f7fc", (245, 247, 252, 255)),
        ("edge toolbar grey", (201, 208, 220, 255)),
        ("dark elev #111827", (17, 24, 39, 255)),
    ]
    panel_h = 150
    icons_w = sum(SIZES) + gap * (len(SIZES) - 1)
    w = max(pad * 2 + icons_w, 560)
    zoom_h = 130
    h = pad + panel_h * len(rows) + zoom_h + pad
    sheet = Image.new("RGBA", (w, h), (8, 11, 18, 255))

    y = pad
    for _label, bg in rows:
        sheet.alpha_composite(
            Image.new("RGBA", (w - 2 * pad, panel_h - 12), bg), (pad, y))
        x = pad + 14
        for s in SIZES:
            sheet.alpha_composite(images[s], (x, y + (panel_h - 12 - s) // 2))
            x += s + gap
        y += panel_h

    # pixel-level legibility row: 16px @5x, 32px @2x, mono mark @15px / @30px
    y += 6
    x = pad + 14
    for size, zoom in ((16, 5), (32, 2)):
        sheet.alpha_composite(
            images[size].resize((size * zoom, size * zoom), Image.NEAREST), (x, y))
        x += size * zoom + gap + 4
    for color, back in (((99, 102, 241, 255), (245, 247, 252, 255)),
                         ((233, 237, 247, 255), (17, 24, 39, 255))):
        chip = Image.new("RGBA", (130, 84), back)
        sheet.alpha_composite(chip, (x, y - 4))
        mark15 = render(15, mono=color[:3], variant=16)
        mark30 = render(30, mono=color[:3], variant=32)
        sheet.alpha_composite(mark15, (x + 10, y + 28))
        sheet.alpha_composite(mark30, (x + 40, y + 20))
        mark60 = render(60, mono=color[:3], variant=48)
        sheet.alpha_composite(mark60, (x + 76, y + 8))
        x += 140
    return sheet


# ---------------------------------------------------------------------- main --
def report(img: Image.Image, size: int) -> None:
    a = np.asarray(img.getchannel("A"))
    cover = float((a > 127).sum()) / (size * size)
    bbox = Image.fromarray(a, "L").getbbox()
    print(f"icon{size}.png\t{size}x{size} RGBA\topaque={cover * 100:5.1f}%"
          f"\tbbox={bbox}")


def main() -> None:
    images = {}
    for size in SIZES:
        img = render(size)
        assert img.size == (size, size), img.size
        assert img.mode == "RGBA", img.mode
        img.save(HERE / f"icon{size}.png", optimize=True)
        images[size] = img
        report(img, size)

    # logo.svg must stay <= 4KB and reference nothing external
    (HERE / "logo.svg").write_text(logo_svg(), encoding="utf-8")
    (HERE / "icon-mono.svg").write_text(mono_svg(), encoding="utf-8")
    for name in ("logo.svg", "icon-mono.svg"):
        data = (HERE / name).read_text(encoding="utf-8")
        assert "http://" not in data.replace('xmlns="http://www.w3.org/2000/svg"', "")
        print(f"{name}\t{len(data.encode('utf-8'))} bytes")

    preview = build_preview(images)
    preview.save(HERE / "preview.png", optimize=True)
    print(f"preview.png\t{preview.size[0]}x{preview.size[1]}")


if __name__ == "__main__":
    main()
