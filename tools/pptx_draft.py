#!/usr/bin/env python3
"""Turn extracted slides into a DRAFT slide spec — the guessing half of pass 1.

Everything here is a heuristic, and the point is not to be right: it is to be
*close enough to edit*. Pass 2 used to read a transcript and type a whole spec
back out; now it reads a draft and changes the slides it disagrees with, which
costs a fraction of the output tokens.

The guesses that are cheap and safe are made here — tables, charts, title
slides, one-big-picture slides, icon grids, logos and page furniture. The
guesses that need judgement (is this wall of bullets really a `compare`? is
that figure worth an `embed`?) are left alone and flagged in a comment.

Annotations are written as `<!-- ... -->`, which `md_to_deck.py`'s parser
skips, so a draft compiles as-is — badly, but it compiles.
"""

from __future__ import annotations

import os
import re
from collections import Counter
from pathlib import Path

# an image at least this fraction of the canvas is content, not decoration
BIG_FRAC = 0.045
# below this, a picture is an icon: fine in a `grid` card, never a hero figure
ICON_PX = 200
# a picture repeated on this many slides is page furniture
CHROME_REPEATS = 3
# drawn marks with no exported picture: the tell for a vector infographic
FIGURE_MARKS = 10


def _txt(item) -> str:
    return " ".join(line for _, line in item["lines"]).strip()


def _sanitize(text: str) -> str:
    """Keep source prose from being read as spec markup."""
    text = re.sub(r"^[#>|]+\s*", "", text.strip())
    text = re.sub(r"^[-*]\s+", "", text)
    return text.replace("|", "/").strip()


def _first_line(item) -> str:
    return _sanitize(item["lines"][0][1]) if item["lines"] else ""


def _rest_lines(item) -> list[tuple[int, str]]:
    return item["lines"][1:]


class Slide:
    """One slide's items, sorted into the roles the builders care about."""

    def __init__(self, s: dict, deck: dict, chrome: set[str]):
        self.n = s["n"]
        self.build = s["build"]
        self.marks = sum(s["marks"].values())
        self.mark_kinds = s["marks"]
        self.notes = s["notes"]
        self.W, self.H = deck["w"] or 1280, deck["h"] or 720

        items = s["items"]
        self.tables = [i for i in items if i["kind"] == "table"]
        self.charts = [i for i in items if i["kind"] == "chart"]
        texts = [i for i in items if i["kind"] == "text"]

        imgs = [i for i in items if i["kind"] == "img"]
        self.dropped = [i for i in imgs if self._is_chrome(i, chrome)]
        kept = [i for i in imgs if i not in self.dropped]
        self.big = [i for i in kept if self._area(i) >= BIG_FRAC]
        self.icons = [i for i in kept if i not in self.big]

        self.title_item = self._pick_title(texts)
        self.subtitle_item = self._pick_subtitle(texts)
        used = {id(x) for x in (self.title_item, self.subtitle_item) if x}
        self.body = [t for t in texts if id(t) not in used]

    # ── geometry helpers

    def _area(self, it) -> float:
        return (it["w"] * it["h"]) / float(self.W * self.H)

    def _is_chrome(self, it, chrome: set[str]) -> bool:
        if it["rel"] in chrome and self._area(it) < BIG_FRAC:
            return True                       # same picture on many slides
        edge = it["y"] < 40 or it["y"] + it["h"] > self.H - 40
        return edge and max(it["w"], it["h"]) <= ICON_PX and self._area(it) < 0.02

    def _pick_title(self, texts):
        for t in texts:
            if "title" in t["ph"]:
                return t
        top = [t for t in texts
               if t["y"] < 0.22 * self.H and len(_txt(t)) < 90
               and len(t["lines"]) == 1]
        return min(top, key=lambda t: t["y"]) if top else None

    def _pick_subtitle(self, texts):
        for t in texts:
            if "subtitle" in t["ph"] or t["ph"] == "center_title":
                if t is not self.title_item:
                    return t
        return None

    def _nearest_text(self, img, pool, radius=200):
        """The label that belongs to a picture — the caption under an icon."""
        cx, cy = img["x"] + img["w"] / 2, img["y"] + img["h"] / 2
        best, bestd = None, radius
        for t in pool:
            tx, ty = t["x"] + t["w"] / 2, t["y"] + t["h"] / 2
            d = abs(tx - cx) + abs(ty - cy) * 0.6      # prefer directly below
            if d < bestd:
                best, bestd = t, d
        return best

    # ── the guess

    def guess(self) -> str:
        if self.tables:
            return "table"
        if self.charts:
            return "chart"

        body_chars = sum(len(_txt(t)) for t in self.body)
        has_pics = bool(self.big or self.icons)

        if self.subtitle_item is not None and not has_pics and not self.body:
            return "title"
        if self.title_item is not None and not has_pics and not self.body:
            return "section"
        # a bare phrase alone on the slide is a divider, wherever it sits
        if not has_pics and self.title_item is None and len(self.body) == 1 \
                and len(self.body[0]["lines"]) == 1 and body_chars <= 44:
            return "section"

        if len(self.big) == 1:
            return "image"
        if 2 <= len(self.big) <= 4:
            return "points" if len(self.body) >= len(self.big) else "gallery"
        if len(self.big) > 4:
            return "gallery"
        # a grid is icons *with labels*; unlabelled icons scattered over a text
        # slide are logos, and belong in the dropped list, not in cards
        if len(self.labelled_icons()) >= 3:
            return "grid"

        if self._two_columns():
            return "compare"
        if len(self.body) == 1 and body_chars <= 180 \
                and len(self.body[0]["lines"]) <= 2:
            return "statement"
        return "content"

    def _two_columns(self) -> bool:
        if len(self.body) != 2:
            return False
        a, b = sorted(self.body, key=lambda t: t["x"])
        if a["x"] + a["w"] > self.W * 0.55 or b["x"] < self.W * 0.42:
            return False
        return abs(a["y"] - b["y"]) < 0.15 * self.H

    def labelled_icons(self) -> list[dict]:
        pool = list(self.body)
        out = []
        for img in self.icons:
            cap = self._nearest_text(img, pool, radius=260)
            if cap is not None:
                pool.remove(cap)
                out.append(img)
        return out

    def needs_eyes(self) -> bool:
        """A figure drawn from PowerPoint shapes exports nothing. Go look."""
        return self.marks >= FIGURE_MARKS and not self.big


# ────────────────────────────────────────────────────────────────── rendering

class Draft:
    def __init__(self, out_path: Path, media_dir: Path):
        self.out_dir = out_path.parent.resolve()
        self.media_dir = media_dir.resolve()
        self.lines: list[str] = []
        self.used = 0            # images this slide actually placed

    def img_path(self, rel: str) -> str:
        """Just the filename — `media:` in the front matter is a search root.

        A hundred image lines that each repeat `build/media/` is a hundred
        lines of nothing; the compiler resolves bare names against `media:`.
        """
        self.used += 1
        return Path(rel).name

    def add(self, line: str = ""):
        self.lines.append(line)

    def sub(self, heading: str):
        """Open a `###` sub-block. Bare when the source gave it no label."""
        heading = _sanitize(heading)
        self.add(f"### {heading}" if heading else "###")

    def field(self, key: str, value: str):
        value = _sanitize(value)
        if value:
            self.add(f"{key}: {value}")

    def bullets(self, item):
        for level, line in item["lines"]:
            text = _sanitize(line)
            if text:
                self.add(("  " * min(level, 1)) + "- " + text)

    def body_bullets(self, items):
        for it in items:
            self.bullets(it)


def _shortest_path(target: Path, start: Path) -> str:
    """Relative when that is short, absolute when the spec lives elsewhere."""
    rel = os.path.relpath(target, start).replace(os.sep, "/")
    return rel if len(rel) <= len(str(target)) else str(target)


def _preset(chart_type: str) -> str:
    t = chart_type.upper()
    if "PIE" in t or "DOUGHNUT" in t:
        return "pie"
    if "LINE" in t or "SCATTER" in t or "AREA" in t:
        return "line"
    return "bar"


def _num(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def render_slide(d: Draft, s: Slide, kind: str) -> None:
    title = _txt(s.title_item) if s.title_item else ""

    if kind == "title":
        d.field("title", title)
        if s.subtitle_item:
            d.field("subtitle", " — ".join(
                _sanitize(l) for _, l in s.subtitle_item["lines"]))
        return

    if kind == "section":
        d.field("title", title or (_txt(s.body[0]) if s.body else ""))
        return

    if kind == "statement":
        rest = list(s.body)
        if not title and rest:
            title = _txt(rest.pop(0))
        d.field("title", title)
        if rest:
            d.field("body", _txt(rest[0]))
        return

    if kind == "chart":
        ch = s.charts[0]
        d.field("title", title)
        d.field("preset", _preset(ch["chart_type"]))
        if ch["cats"]:
            d.add("categories: " + " | ".join(_sanitize(c) for c in ch["cats"]))
        for name, vals in ch["series"]:
            d.add(f"series {_sanitize(name) or 'Series'}: "
                  + " | ".join(_num(v) for v in vals))
        d.body_bullets(s.body)
        return

    if kind == "table":
        d.field("title", title)
        for r, row in enumerate(s.tables[0]["rows"]):
            d.add("| " + " | ".join(_sanitize(c) for c in row) + " |")
            if r == 0:
                d.add("|" + "---|" * len(row))
        return

    if kind == "image":
        d.field("title", title)
        d.add("image: " + d.img_path(s.big[0]["rel"]))
        d.add("fit: contain")
        d.body_bullets(s.body)
        return

    if kind == "gallery":
        d.field("title", title)
        pool = list(s.body)
        for img in (s.big or s.icons)[:4]:
            cap = s._nearest_text(img, pool)
            if cap in pool:
                pool.remove(cap)
            d.sub(_first_line(cap) if cap else "")
            d.add("image: " + d.img_path(img["rel"]))
            d.add("fit: contain")
        return

    if kind == "points":
        d.field("title", title)
        pool = list(s.body)
        for img in s.big[:4]:
            cap = s._nearest_text(img, pool)
            if cap in pool:
                pool.remove(cap)
            d.sub(_first_line(cap) if cap else "")
            d.add("image: " + d.img_path(img["rel"]))
            d.add("fit: contain")
            if cap:
                for level, line in _rest_lines(cap):
                    text = _sanitize(line)
                    if text:
                        d.add("- " + text)
        return

    if kind == "grid":
        cards = s.labelled_icons()[:12]
        d.field("title", title)
        d.add(f"columns: {4 if len(cards) > 6 else 3}")
        pool = list(s.body)
        for img in cards:
            cap = s._nearest_text(img, pool, radius=260)
            if cap in pool:
                pool.remove(cap)
            d.sub(_first_line(cap) if cap else "")
            d.add("image: " + d.img_path(img["rel"]))
        return

    if kind == "compare":
        d.field("title", title)
        for col in sorted(s.body, key=lambda t: t["x"]):
            d.sub(_first_line(col))
            for level, line in _rest_lines(col):
                text = _sanitize(line)
                if text:
                    d.add(("  " * min(level, 1)) + "- " + text)
        return

    # content — and the fallback for anything unclassified
    d.field("title", title)
    d.body_bullets(s.body)
    for img in s.big[:1]:
        d.add("image: " + d.img_path(img["rel"]))


def _flags(s: Slide, used: int) -> str:
    """The one comment line per slide. Only what pass 2 can act on."""
    bits = [f"{s.n}"]
    if s.build:
        m = re.match(r"BUILD (\d+) clicks", s.build)
        bits.append(f"build {m.group(1)} clicks" if m else "build")
    if s.marks >= 4:
        top = sorted(s.mark_kinds.items(), key=lambda kv: -kv[1])[:2]
        bits.append(f"{s.marks} drawn ({','.join(k for k, _ in top)})")
    if s.dropped:
        bits.append(f"{len(s.dropped)} chrome dropped")
    spare = len(s.big) + len(s.icons) - used
    if spare > 0:
        bits.append(f"{spare} images unused")
    return " · ".join(bits)


def render_draft(deck: dict, slides: list[dict], out_path: Path,
                 media_dir: Path) -> tuple[str, dict]:
    """Return (draft markdown, stats)."""
    counts = Counter(i["rel"] for s in slides for i in s["items"]
                     if i["kind"] == "img")
    chrome = {rel for rel, c in counts.items() if c >= CHROME_REPEATS}

    d = Draft(out_path, media_dir)
    doc_title = deck.get("doc_title", "")
    if doc_title.lower() in ("powerpoint presentation", "presentation", ""):
        doc_title = ""                       # the default nobody ever changes
    title = doc_title or deck["stem"].replace("_", " ").strip()
    d.add("---")
    d.add(f"title: {title}")
    if deck.get("author"):
        d.add(f"author: {deck['author']}")
    if deck.get("subject"):
        d.add(f"subject: {deck['subject']}")
    d.add(f"footer: {title}")
    d.add(f"media: {_shortest_path(media_dir.resolve(), d.out_dir)}")
    d.add("---")
    d.add()
    d.add(f"<!-- DRAFT from {deck['name']} — guessed types, edit before "
          f"compiling. Numbers in comments are source slide numbers. -->")
    d.add()

    stats = {"images": len(counts), "look": [], "types": Counter()}
    for raw in slides:
        s = Slide(raw, deck, chrome)
        kind = s.guess()
        stats["types"][kind] += 1

        # render into a scratch buffer first: the flag line reports how many
        # pictures the guess left on the floor, which is only known afterwards
        body = Draft(out_path, media_dir)
        render_slide(body, s, kind)
        if s.notes:
            body.field("notes", s.notes.replace("\n", " / "))

        d.add(f"<!-- {_flags(s, body.used)} -->")
        if s.needs_eyes():
            stats["look"].append(s.n)
            d.add(f"<!-- ? vector figure, nothing exported — render and look: "
                  f"pptx_render.py <deck>.pptx {s.n} -->")
        d.add(f"## {kind}")
        d.lines.extend(body.lines)
        d.add()

    return "\n".join(d.lines), stats
