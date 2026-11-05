#!/usr/bin/env python3
"""The ground colour behind a CONTAINED picture — and a tool to apply it.

A contained picture sits inset on a panel (template slide 09, points cards
with `fit: contain`). The panel should continue the picture's own backdrop,
so the picture's edge disappears and the subject reads as standing on the
panel. What meets the panel is the picture's BORDER, not its middle, so the
colour comes from the border ring:

1. Take the outer ring of the picture (4% of the short side, on a 256 px
   thumbnail).
2. Find the dominant colour in that ring: bin every ring pixel into a coarse
   8x8x8 grid, take the fullest bin, and gather every ring pixel within 28
   (RGB distance) of that bin's mean. Their per-channel median is the
   backdrop. Median, not mean, so a subject that runs off one edge (chairs
   along the bottom, a sleeve on the left) does not pull the colour.
3. If that cluster covers >= 35% of the ring, the picture has a backdrop
   (an illustration on cream, a studio shot, a sky) -> the panel IS that
   colour, exactly. Method "backdrop".
4. Otherwise the border is busy (a street, a crowd) and no single colour
   continues it -> the ring's mean mixed 30/70 with white, a quiet ground in
   the picture's own hue. Method "photo".
5. A picture with transparency, or a near-white backdrop, keeps a white panel
   (a tint behind a cut-out draws a box around nothing). Method "white".
   White is also the answer when Pillow is missing or the file will not open.

Usage (from the repository root):

    python panel_tint.py picture.jpg [more.jpg ...]         # print colour + method
    python panel_tint.py deck.html --all                    # retint every contained picture's panel
    python panel_tint.py deck.html --all --dry-run          # show what would change

`--all` looks at every slide and layout for an image with `fit: contain`
whose rect shape underneath fully contains it, and sets that rect's fill.
md_to_deck.py uses the same function when it compiles, so re-run this only
after swapping a picture into a compiled deck (image_swap.py).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import statistics
import sys
from pathlib import Path

WHITE = "#FFFFFF"
RING = 0.04          # ring width, share of the short side
NEAR = 28            # RGB distance that still counts as the backdrop colour
BACKDROP_SHARE = 0.35


def _hex(rgb) -> str:
    return "#%02X%02X%02X" % tuple(max(0, min(255, round(c))) for c in rgb)


def analyse(im) -> tuple[str, str, float]:
    """(colour, method, backdrop share) for a PIL image."""
    from PIL import Image
    if im.mode in ("RGBA", "LA", "P", "PA"):
        if im.convert("RGBA").getchannel("A").getextrema()[0] < 250:
            return WHITE, "white", 0.0
    im = im.convert("RGB")
    im.thumbnail((256, 256), Image.LANCZOS)
    w, h = im.size
    b = max(2, round(min(w, h) * RING))
    px = im.load()
    ring = [px[x, y] for y in range(h) for x in range(w)
            if x < b or y < b or x >= w - b or y >= h - b]

    bins: dict[tuple, list] = {}
    for p in ring:
        bins.setdefault((p[0] >> 5, p[1] >> 5, p[2] >> 5), []).append(p)
    top = max(bins.values(), key=len)
    seed = [sum(p[c] for p in top) / len(top) for c in range(3)]
    near = [p for p in ring
            if sum((p[c] - seed[c]) ** 2 for c in range(3)) <= NEAR ** 2]
    share = len(near) / len(ring)

    if share >= BACKDROP_SHARE:
        colour = [statistics.median(p[c] for p in near) for c in range(3)]
        if min(colour) > 236:
            return WHITE, "white", share
        return _hex(colour), "backdrop", share
    mean = [sum(p[c] for p in ring) / len(ring) for c in range(3)]
    return _hex(0.3 * c + 0.7 * 255 for c in mean), "photo", share


def panel_tint(source) -> str:
    """Ground colour for a picture given as a path, bytes or data: URI."""
    try:
        from PIL import Image
    except ImportError:
        return WHITE
    try:
        if isinstance(source, (bytes, bytearray)):
            im = Image.open(io.BytesIO(source))
        elif isinstance(source, str) and source.startswith("data:"):
            im = Image.open(io.BytesIO(base64.b64decode(source.split(",", 1)[1])))
        else:
            im = Image.open(source)
        im.load()
    except Exception:
        return WHITE
    return analyse(im)[0]


# ── deck mode ────────────────────────────────────────────────────────────

def _contains(outer: dict, inner: dict) -> bool:
    return (outer["x"] <= inner["x"] and outer["y"] <= inner["y"]
            and outer["x"] + outer["w"] >= inner["x"] + inner["w"]
            and outer["y"] + outer["h"] >= inner["y"] + inner["h"])


def retint(doc: dict) -> list[str]:
    """Set the fill of every rect under a contained image. Returns a log."""
    from PIL import Image
    assets = doc.get("assets", {})
    log = []
    groups = [("slide", s) for s in doc.get("slides", [])] + \
             [("layout", l) for l in doc.get("layouts", [])]
    for kind, g in groups:
        els = g.get("elements", [])
        for i, img in enumerate(els):
            if img.get("type") != "image" or img.get("fit") != "contain":
                continue
            src = img.get("src") or ""
            data = assets.get(src[6:]) if src.startswith("asset:") else src
            if not isinstance(data, str) or not data.startswith("data:image"):
                continue
            under = [e for e in els[:i] if e.get("type") == "shape"
                     and e.get("shape") == "rect" and _contains(e, img)]
            if not under:
                continue
            panel = under[-1]              # the one drawn directly beneath
            im = Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1])))
            colour, method, share = analyse(im)
            old = panel.get("fill")
            if old != colour or panel.get("fillGradient"):
                panel["fill"] = colour
                panel.pop("fillGradient", None)
                log.append(f"{kind} {g.get('id')}: {panel['id']} {old} -> {colour} "
                           f"({method}, backdrop {share:.0%}, image {src[:40]})")
            else:
                log.append(f"{kind} {g.get('id')}: {panel['id']} already {colour}")
    return log


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="pictures, or one deck .html with --all")
    ap.add_argument("--all", action="store_true", help="retint every contained picture's panel in the deck")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not a.all:
        from PIL import Image
        for p in a.paths:
            colour, method, share = analyse(Image.open(p))
            print(f"{colour}  {method:8s}  backdrop {share:.0%}  {p}")
        return

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from deck_build import load, write_deck
    deck = Path(a.paths[0])
    tpl = load(deck)
    doc = tpl.doc
    log = retint(doc)
    print("\n".join(log) or "no contained pictures on a panel")
    if a.dry_run or not any("->" in l for l in log):
        return
    write_deck(tpl, doc, deck)
    print(f"wrote {deck} (backup in build/backups/)")


if __name__ == "__main__":
    main()
