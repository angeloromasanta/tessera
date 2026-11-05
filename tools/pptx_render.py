#!/usr/bin/env python3
"""Draw a pptx slide's shape tree to a PNG so an agent can LOOK at it.

pptx_extract.py exports embedded pictures. A slide whose figure is drawn from
PowerPoint *shapes* — ovals, connectors, arcs, text boxes — exports nothing,
and its transcript is a title and a few stray labels. That is the case this
tool covers: one image, no tokens, enough to see what the slide argues.

Deliberately APPROXIMATE. Curves become their bounding chords, gradients
become their first stop, effects are ignored. The output is a reference to
read, not a deliverable to ship — do not embed it in a deck.

    python <skill>/tools/pptx_render.py deck.pptx 52 -o build/slide52.png
    python <skill>/tools/pptx_render.py deck.pptx 10-14 -o build/shots
"""

from __future__ import annotations

import argparse
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
SS = 2  # supersample, downscaled on save

FONTS = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
         "/System/Library/Fonts/Supplemental/Arial.ttf",
         "/System/Library/Fonts/Helvetica.ttc",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def theme_colors(pptx: Path) -> dict[str, str]:
    """slot name -> #RRGGBB, read from the deck's first theme part."""
    out = {}
    with zipfile.ZipFile(pptx) as z:
        names = [n for n in z.namelist() if re.match(r"ppt/theme/theme\d+\.xml", n)]
        if not names:
            return out
        root = ET.fromstring(z.read(sorted(names)[0]))
    scheme = root.find(f".//{{{A}}}clrScheme")
    if scheme is None:
        return out
    for child in scheme:
        slot = child.tag.split("}")[1]
        srgb = child.find(f"{{{A}}}srgbClr")
        sysc = child.find(f"{{{A}}}sysClr")
        if srgb is not None:
            out[slot] = "#" + srgb.get("val")
        elif sysc is not None:
            out[slot] = "#" + (sysc.get("lastClr") or "000000")
    # the aliases python-pptx reports, mapped onto the scheme's own names
    for alias, slot in (("TEXT_1", "dk1"), ("TEXT_2", "dk2"),
                        ("BACKGROUND_1", "lt1"), ("BACKGROUND_2", "lt2"),
                        ("DARK_1", "dk1"), ("DARK_2", "dk2"),
                        ("LIGHT_1", "lt1"), ("LIGHT_2", "lt2"),
                        ("ACCENT_1", "accent1"), ("ACCENT_2", "accent2"),
                        ("ACCENT_3", "accent3"), ("ACCENT_4", "accent4"),
                        ("ACCENT_5", "accent5"), ("ACCENT_6", "accent6"),
                        ("HYPERLINK", "hlink")):
        if slot in out:
            out[alias] = out[slot]
    return out


def _lum(hex_color: str, mod: float | None, off: float | None) -> str:
    """PowerPoint's lumMod/lumOff, close enough to read."""
    if mod is None and off is None:
        return hex_color
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    m, o = (mod or 1.0), (off or 0.0)
    return "#" + "".join(
        f"{max(0, min(255, round(c * m + 255 * o))):02x}" for c in (r, g, b))


def shape_fill(shape, theme: dict) -> tuple[str | None, float]:
    """(#RRGGBB, alpha 0..1) for a shape's solid fill; (None, _) if none."""
    sp = shape._element
    solid = sp.find(f".//{{{A}}}solidFill")
    if solid is None:
        return None, 1.0
    alpha = 1.0
    a_el = solid.find(f".//{{{A}}}alpha")
    if a_el is not None:
        alpha = int(a_el.get("val", "100000")) / 100000.0
    srgb = solid.find(f"{{{A}}}srgbClr")
    scheme = solid.find(f"{{{A}}}schemeClr")
    node = srgb if srgb is not None else scheme
    if node is None:
        return None, alpha
    if srgb is not None:
        base = "#" + srgb.get("val")
    else:
        name = scheme.get("val")
        # schemeClr uses tx1/bg1 where the theme part says dk1/lt1
        base = theme.get({"tx1": "dk1", "tx2": "dk2", "bg1": "lt1",
                          "bg2": "lt2"}.get(name, name), "#888888")
    mod = node.find(f"{{{A}}}lumMod")
    off = node.find(f"{{{A}}}lumOff")
    return _lum(base, int(mod.get("val")) / 100000 if mod is not None else None,
                int(off.get("val")) / 100000 if off is not None else None), alpha


def line_color(shape, theme: dict) -> tuple[str | None, float]:
    ln = shape._element.find(f".//{{{A}}}ln")
    if ln is None or ln.find(f"{{{A}}}noFill") is not None:
        return None, 1.0
    solid = ln.find(f".//{{{A}}}solidFill")
    if solid is None:
        return None, 1.0
    srgb = solid.find(f"{{{A}}}srgbClr")
    scheme = solid.find(f"{{{A}}}schemeClr")
    if srgb is not None:
        base = "#" + srgb.get("val")
    elif scheme is not None:
        name = scheme.get("val")
        base = theme.get({"tx1": "dk1", "tx2": "dk2", "bg1": "lt1",
                          "bg2": "lt2"}.get(name, name), "#666666")
        mod = scheme.find(f"{{{A}}}lumMod")
        off = scheme.find(f"{{{A}}}lumOff")
        base = _lum(base,
                    int(mod.get("val")) / 100000 if mod is not None else None,
                    int(off.get("val")) / 100000 if off is not None else None)
    else:
        return None, 1.0
    w = int(ln.get("w", "12700")) / 12700 * (96 / 72)   # EMU -> pt -> px
    return base, max(1.0, w)


def font(px: int):
    for p in FONTS:
        try:
            return ImageFont.truetype(p, px)
        except OSError:
            continue
    return ImageFont.load_default()


def _draw_geom(d, shape, box, rgba, stroke, sw):
    name = (getattr(shape, "name", "") or "").lower()
    geom = shape._element.find(f".//{{{A}}}prstGeom")
    kind = geom.get("prst") if geom is not None else (
        "line" if "connector" in name else "rect")
    w = max(1, int(sw * SS)) if stroke else 0
    if kind in ("line", "straightConnector1") or "connector" in name:
        if stroke:
            d.line([box[0], box[1], box[2], box[3]], fill=stroke, width=w)
    elif kind == "ellipse":
        d.ellipse(box, fill=rgba, outline=stroke, width=w)
    elif kind == "arc":
        # a real arc needs its sweep angles; half the ellipse reads well enough
        if stroke:
            d.arc(box, 0, 180, fill=stroke, width=w)
    elif kind == "triangle":
        d.polygon([((box[0] + box[2]) / 2, box[1]), (box[2], box[3]),
                   (box[0], box[3])], fill=rgba, outline=stroke)
    elif rgba or stroke:
        d.rectangle(box, fill=rgba, outline=stroke, width=w)


def draw_shape(img, shape, theme, sx, sy):
    # Drawing an RGBA ink onto an RGBA image REPLACES pixels, alpha and all —
    # it does not blend. Anything translucent goes on its own layer and is
    # composited, or PowerPoint's 79%-white scrims come out solid white and
    # erase the artwork underneath them.
    d = ImageDraw.Draw(img, "RGBA")
    try:
        x, y = shape.left * sx, shape.top * sy
        w, h = shape.width * sx, shape.height * sy
    except TypeError:
        return
    box = [x * SS, y * SS, (x + w) * SS, (y + h) * SS]
    if box[2] < box[0]:
        box[0], box[2] = box[2], box[0]
    if box[3] < box[1]:
        box[1], box[3] = box[3], box[1]

    if shape.shape_type == 13:                       # picture
        try:
            from io import BytesIO
            pic = Image.open(BytesIO(shape.image.blob)).convert("RGBA")
            pic = pic.resize((max(1, int(box[2] - box[0])),
                              max(1, int(box[3] - box[1]))), Image.LANCZOS)
            img.alpha_composite(pic, (int(box[0]), int(box[1])))
            return
        except Exception:
            pass

    fill, alpha = shape_fill(shape, theme)
    stroke, sw = line_color(shape, theme)
    rgba = None
    if fill:
        r, g, b = (int(fill[i:i + 2], 16) for i in (1, 3, 5))
        rgba = (r, g, b, int(alpha * 255))
    if rgba and alpha < 0.999:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer, "RGBA")
        _draw_geom(d, shape, box, rgba, stroke, sw)
        img.alpha_composite(layer)
        return
    _draw_geom(d, shape, box, rgba, stroke, sw)

    if shape.has_text_frame and shape.text_frame.text.strip():
        size = 18
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                if r.font.size:
                    size = r.font.size.pt
                    break
            break
        f = font(max(8, int(size * 96 / 72 * SS)))
        lines = [ln for ln in shape.text_frame.text.split("\n") if ln.strip()]
        total = len(lines) * f.size * 1.25
        ty = (box[1] + box[3]) / 2 - total / 2
        for ln in lines:
            bb = d.textbbox((0, 0), ln, font=f)
            d.text(((box[0] + box[2]) / 2 - (bb[2] - bb[0]) / 2, ty), ln,
                   font=f, fill="#111111")
            ty += f.size * 1.25


def walk(img, shapes, theme, sx, sy, keep=None):
    for shape in shapes:                    # document order == z-order
        if shape.shape_type == 6 or str(shape.shape_type).startswith("GROUP"):
            walk(img, shape.shapes, theme, sx, sy, keep)
        elif keep is None or keep(shape):
            draw_shape(img, shape, theme, sx, sy)


def final_state(pptx: Path, index: int):
    """Predicate keeping only what is on screen after the LAST click.

    A slide with a build ends somewhere quite different from where every shape
    piled on top of every other one would put it — PowerPoint's dimming scrims
    typically exit on the final click. Drawing all shapes at once buries the
    artwork under them; drawing the end state shows what the audience is left
    looking at. Returns None when the slide has no build.
    """
    try:
        from pptx_timing import click_groups, visibility_frames
    except ImportError:
        return None
    groups = click_groups(str(pptx), index)
    if not groups:
        return None
    animated = {sid for g in groups for sid, _ in g}
    visible = visibility_frames(str(pptx), index)[-1]
    return lambda sh: str(sh.shape_id) not in animated or \
        str(sh.shape_id) in visible


def render_slide(prs, theme, index: int, out: Path, W=1280, keep=None) -> Path:
    H = int(W * prs.slide_height / prs.slide_width)
    sx, sy = W / prs.slide_width, H / prs.slide_height
    img = Image.new("RGBA", (W * SS, H * SS), "white")
    walk(img, prs.slides[index - 1].shapes, theme, sx, sy, keep)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(out, quality=90)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("slides", help="slide number or range, e.g. 52 or 10-14")
    ap.add_argument("-o", "--out", default="build/slide.png")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--all-shapes", action="store_true",
                    help="draw every shape, ignoring the build's end state")
    args = ap.parse_args()

    src = Path(args.pptx)
    prs = Presentation(str(src))
    theme = theme_colors(src)
    m = re.fullmatch(r"(\d+)(?:-(\d+))?", args.slides)
    if not m:
        raise SystemExit(f"bad slide range: {args.slides}")
    first, last = int(m.group(1)), int(m.group(2) or m.group(1))
    out = Path(args.out)
    multi = last > first
    for n in range(first, last + 1):
        target = (out / f"slide-{n:02d}.png") if multi else out
        keep = None if args.all_shapes else final_state(src, n)
        print("wrote", render_slide(prs, theme, n, target, args.width, keep),
              "(build end state)" if keep else "")


if __name__ == "__main__":
    main()
