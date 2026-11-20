"""Final acceptance checks for icons/ (run: python icons/_verify.py)."""

import hashlib
import pathlib
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

HERE = pathlib.Path("icons")
SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'
failures = []


def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


print("[1] PNG structure / alpha")
for s in (16, 32, 48, 128):
    p = HERE / f"icon{s}.png"
    b = p.read_bytes()
    w, h, depth, ctype = struct.unpack(">IIBB", b[16:26])
    im = Image.open(p)
    a = np.asarray(im)[..., 3]
    check(b[:8] == b"\x89PNG\r\n\x1a\n", f"icon{s}.png has a valid PNG signature")
    check((w, h) == (s, s), f"icon{s}.png is {w}x{h} (expected {s}x{s})")
    check(ctype == 6 and depth == 8, f"icon{s}.png colour type {ctype} / {depth}-bit (RGBA = 6)")
    check(im.mode == "RGBA", f"icon{s}.png Pillow mode {im.mode}")
    check(a.min() == 0 and a.max() == 255, f"icon{s}.png alpha spans [{a.min()},{a.max()}]")
    cov = float((a > 127).mean()) * 100
    print(f"       icon{s}.png opaque={cov:.1f}%  fully-transparent={(a == 0).mean() * 100:.1f}%")

check((np.asarray(Image.open(HERE / "icon16.png"))[..., 3] > 127).mean() * 100 >= 88.0,
      "icon16.png opaque ratio >= 88%")
check((np.asarray(Image.open(HERE / "icon16.png"))[..., 3] == 0).mean() * 100 >= 3.0,
      "icon16.png has transparent corners (>=3% fully transparent)")

print("\n[2] SVG source files")
for name in ("logo.svg", "icon-mono.svg"):
    p = HERE / name
    text = p.read_text(encoding="utf-8")
    size = len(text.encode("utf-8"))
    root = ET.fromstring(text)
    check(size <= 4096, f"{name} is {size} B (limit 4096)")
    check(root.tag.endswith("svg"), f"{name} root element is <svg>")
    check(root.get("viewBox") == "0 0 128 128", f"{name} viewBox={root.get('viewBox')}")
    stripped = text.replace(SVG_NS, "")
    check("http" not in stripped, f"{name} references nothing external")
    check("currentColor" in text, f"{name} uses currentColor") if name == "icon-mono.svg" else None

mono = (HERE / "icon-mono.svg").read_text(encoding="utf-8")
check("currentColor" in mono, "icon-mono.svg is a currentColor monochrome mark")
logo = (HERE / "logo.svg").read_text(encoding="utf-8")
check("linearGradient" in logo and "#6366f1" in logo and "#22d3ee" in logo,
      "logo.svg carries the brand gradient #6366f1 -> #22d3ee")

print("\n[3] Determinism")
before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
          for p in HERE.glob("*") if p.suffix in (".png", ".svg")}
subprocess.run([sys.executable, str(HERE / "build_icons.py")],
               check=True, capture_output=True)
after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
         for p in HERE.glob("*") if p.suffix in (".png", ".svg")}
changed = [k for k in before if before[k] != after.get(k)]
check(not changed, f"rebuild is deterministic (changed: {changed})")

print("\n" + ("ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILURE(S): {failures}"))
sys.exit(1 if failures else 0)
