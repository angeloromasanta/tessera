#!/usr/bin/env python3
"""Extract a .pptx into a draft slide spec (+ media files), or a raw transcript.

Pass 1 of the pptx -> deck pipeline. No LLM tokens are spent here: the script
pulls every text frame, table, chart and picture out of the deck, guesses a
slide type for each slide, and writes a **draft spec** in the format
`../reference/SLIDE_SPEC.md` describes. Pass 2 then edits that draft in place
instead of retyping it, which is where the token saving lives.

    python <skill>/tools/pptx_extract.py deck.pptx -o deck.md --media build/media

`--raw FILE` additionally writes the old flat transcript (every shape, with
geometry) — worth having when a draft looks wrong and you want to see what the
guesser was working from.
"""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu

from pptx_draft import render_draft
from pptx_timing import summarize

EMU_PER_PX = 9525  # 96 dpi


def px(v) -> int:
    if v is None:
        return 0
    return int(round(Emu(int(v)).emu / EMU_PER_PX))


def clean(text: str) -> str:
    text = text.replace("\x0b", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def shape_text(shape) -> list[tuple[int, str]]:
    """Return [(indent_level, line)] for a shape's text frame."""
    out = []
    if not shape.has_text_frame:
        return out
    for para in shape.text_frame.paragraphs:
        line = clean("".join(run.text for run in para.runs))
        if line:
            out.append((para.level or 0, line))
    return out


def table_rows(shape) -> list[list[str]]:
    return [[clean(c.text) for c in r.cells] for r in shape.table.rows]


def save_picture(shape, media_dir: Path, seen: dict) -> str | None:
    try:
        img = shape.image
    except Exception:
        return None
    digest = hashlib.sha1(img.blob).hexdigest()[:10]
    if digest in seen:
        return seen[digest]
    name = f"{digest}.{img.ext}"
    path = media_dir / name
    if not path.exists():
        media_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(img.blob)
    rel = f"{media_dir.name}/{name}"
    seen[digest] = rel
    return rel


def walk(shapes, media_dir, seen, items, ids=False):
    """Collect a slide's shapes, in reading order, as plain dicts.

    One structured pass feeds both renderers: the draft guesser needs geometry
    and placeholder roles to tell a hero figure from a logo, and the raw
    transcript is just a flatter printing of the same items.
    """
    ordered = sorted(shapes, key=lambda s: (px(s.top), px(s.left)))
    for shape in ordered:
        base = {
            "id": shape.shape_id if ids else None,
            "x": px(shape.left), "y": px(shape.top),
            "w": px(shape.width), "h": px(shape.height),
        }
        if str(shape.shape_type).startswith("GROUP") or shape.shape_type == 6:
            walk(shape.shapes, media_dir, seen, items, ids)
            continue

        if shape.shape_type == 13 or getattr(shape, "image", None) is not None:
            try:
                rel = save_picture(shape, media_dir, seen)
            except Exception:
                rel = None
            if rel:
                items.append({**base, "kind": "img", "rel": rel})
                continue

        if shape.has_table:
            items.append({**base, "kind": "table", "rows": table_rows(shape)})
            continue

        if shape.has_chart:
            ch = shape.chart
            cats, series = [], []
            try:
                cats = [str(c) for c in ch.plots[0].categories]
                for s in ch.series:
                    series.append((str(s.name), list(s.values)))
            except Exception:
                pass
            items.append({**base, "kind": "chart", "chart_type": str(ch.chart_type),
                          "cats": cats, "series": series})
            continue

        lines = shape_text(shape)
        if not lines:
            continue
        ph = ""
        if shape.is_placeholder:
            ph = str(shape.placeholder_format.type).lower()
        items.append({**base, "kind": "text", "ph": ph, "lines": lines})


A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def drawn_marks(shapes, tally=None):
    """Count drawn shapes that carry no text and are not pictures.

    These are the marks the transcript CANNOT show you: an oval with a fill and
    no caption leaves no trace in the text or image items, so a slide built
    entirely from them reads as almost empty. A big count is the signal that the
    slide is a vector infographic and needs looking at, not guessing at.
    """
    tally = {} if tally is None else tally
    for shape in shapes:
        if str(shape.shape_type).startswith("GROUP") or shape.shape_type == 6:
            drawn_marks(shape.shapes, tally)
            continue
        if shape.shape_type == 13:                      # picture
            continue
        if shape.has_text_frame and shape.text_frame.text.strip():
            continue                                    # a label, already shown
        geom = shape._element.find(f".//{{{A_NS}}}prstGeom")
        kind = geom.get("prst") if geom is not None else None
        if kind is None and str(shape.shape_type).startswith("LINE"):
            kind = "line"
        if kind:
            tally[kind] = tally.get(kind, 0) + 1
    return tally


def read_slides(path: Path, media_dir: Path,
                first: int | None, last: int | None) -> tuple[dict, list[dict]]:
    """Pull the whole deck into dicts. The renderers do the rest."""
    prs = Presentation(str(path))
    seen: dict[str, str] = {}
    deck = {
        "stem": path.stem,
        "name": path.name,
        "w": px(prs.slide_width),
        "h": px(prs.slide_height),
        "total": len(prs.slides),
    }
    try:
        core = prs.core_properties
        deck["author"] = (core.author or "").strip()
        deck["subject"] = (core.subject or "").strip()
        deck["doc_title"] = (core.title or "").strip()
    except Exception:
        pass

    slides = []
    for i, slide in enumerate(prs.slides, 1):
        if first and i < first:
            continue
        if last and i > last:
            break
        build = summarize(str(path), i)
        marks = drawn_marks(slide.shapes)
        items: list[dict] = []
        walk(slide.shapes, media_dir, seen, items, ids=bool(build))
        note = ""
        if slide.has_notes_slide:
            note = clean(slide.notes_slide.notes_text_frame.text)
        slides.append({
            "n": i,
            "layout": slide.slide_layout.name,
            "build": build,
            "marks": marks,
            "items": items,
            "notes": note,
        })
    return deck, slides


def render_raw(deck: dict, slides: list[dict]) -> str:
    """The flat transcript — every shape, with geometry. Debug view."""
    doc = [f"# {deck['stem']}",
           f"<!-- source: {deck['name']} | {deck['total']} slides | "
           f"{deck['w']}x{deck['h']}px -->", ""]
    for s in slides:
        doc.append(f"## slide {s['n']}")
        doc.append(f"LAYOUT {s['layout']}")
        if s["build"]:
            doc.append(s["build"])
        total = sum(s["marks"].values())
        if total >= 4:      # below that it is border furniture, not a figure
            top = sorted(s["marks"].items(), key=lambda kv: -kv[1])[:4]
            doc.append(f"SHAPES {total} drawn ("
                       + ", ".join(f"{v} {k}" for k, v in top) + ")")
        for it in s["items"]:
            tag = f" #{it['id']}" if it.get("id") else ""
            at = f"@{it['x']},{it['y']} {it['w']}x{it['h']}"
            if it["kind"] == "img":
                doc.append(f"IMG{tag} {it['rel']} {at}")
            elif it["kind"] == "table":
                doc.append(f"TABLE{tag} @{it['x']},{it['y']}")
                for r, row in enumerate(it["rows"]):
                    doc.append("| " + " | ".join(row) + " |")
                    if r == 0:
                        doc.append("|" + "---|" * len(row))
            elif it["kind"] == "chart":
                doc.append(f"CHART{tag} {it['chart_type']} @{it['x']},{it['y']}")
                if it["cats"]:
                    doc.append("cats: " + " | ".join(it["cats"]))
                for name, vals in it["series"]:
                    doc.append(f"series {name}: "
                               + " | ".join("" if v is None else str(v)
                                            for v in vals))
            else:
                ph = f" [{it['ph']}]" if it["ph"] else ""
                doc.append(f"TEXT{tag}{ph} {at}")
                for level, line in it["lines"]:
                    doc.append(("  " * level) + "- " + line)
        if s["notes"]:
            doc.append("NOTES " + s["notes"].replace("\n", " / "))
        doc.append("")
    return "\n".join(doc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("-o", "--out", default=None,
                    help="draft slide spec (default <deck>.md)")
    ap.add_argument("--raw", default=None,
                    help="also write the flat transcript here")
    ap.add_argument("--media", default=None)
    ap.add_argument("--first", type=int, default=None)
    ap.add_argument("--last", type=int, default=None)
    args = ap.parse_args()

    src = Path(args.pptx)
    out = Path(args.out) if args.out else src.with_suffix(".md")
    media = Path(args.media) if args.media else out.parent / "media"
    deck, slides = read_slides(src, media, args.first, args.last)

    out.parent.mkdir(parents=True, exist_ok=True)
    draft, stats = render_draft(deck, slides, out, media)
    out.write_text(draft, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes) — {len(slides)} slides, "
          f"{stats['images']} images -> {media}")
    if stats["look"]:
        print("  slides to LOOK at (vector figures): "
              + ", ".join(str(n) for n in stats["look"]))
    print("  types: " + ", ".join(f"{k} {v}" for k, v in
                                  sorted(stats["types"].items(),
                                         key=lambda kv: -kv[1])))
    if args.raw:
        raw = Path(args.raw)
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_text(render_raw(deck, slides), encoding="utf-8")
        print(f"wrote {raw} ({raw.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
