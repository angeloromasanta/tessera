#!/usr/bin/env python3
"""Compile a slide-spec markdown file into an HTML deck.

Pass 3 of the pptx -> deck pipeline. Deterministic, no LLM tokens: it reads
the template ($TESSERA_TEMPLATE, default template.html), lifts its theme, fonts,
assets and layouts, then instantiates one slide per `## <type>` block in the spec.
Layouts are found by role (`points`, or `<prefix>-points`), so any template that
names its layouts that way works.

    python tools/md_to_deck.py deck.md -o deck.html [-t TEMPLATE.html]

Spec format: see docs/guide/reference/SLIDE_SPEC.md
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import mimetypes
import random
import re
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import deckio  # noqa: E402
from deckio import DOC_RE  # noqa: E402

# Colours the compiler adds itself are written in the default template's
# palette and mapped onto the target template's own (deckio.theme_map), so a
# deck compiled against another template keeps that template's colours.
_TMAP: dict = {}


def tok(c: str) -> str:
    return _TMAP.get(c.upper(), _TMAP.get(c, c))


KEYS = {
    "id", "title", "subtitle", "tagline", "body", "heading", "image", "caption",
    "attribution", "quote", "note", "footer", "notes", "transition", "preset",
    "categories", "question", "code", "kind", "options", "columns", "axis-x",
    "axis-y", "fit", "side", "kicker", "accent", "background", "steps",
    "page", "src", "poster", "zoom", "icon",
    # rating scales. Without these here the parser treats `min: 1` as prose and
    # glues it onto the previous field, which silently turned `kind: rating`
    # into `kind: rating min: 1 max: 7 …` and produced a poll of no known kind.
    "min", "max", "minlabel", "maxlabel",
    # `activity` polls: the page the deck ships to the phones, and whether the
    # join page asks for a name. Same trap as the rating keys above — a field
    # the parser doesn't know is prose, and prose glues onto `kind:`.
    "activity", "requirename",
    # Drop the QR/address/code column, for a slide that REPORTS a bucket the
    # room already answered rather than asking anything new.
    "showjoin",
    # `multi: yes` lets a choice poll take several picks per phone (engine
    # field `multi`; the phone posts a JSON array of the picked options).
    "multi",
    # `embed`: extra iframe sandbox tokens, whether the frame runs on the
    # editor canvas as well as in present mode, and which chrome set the page
    # furniture comes from (`chrome: dark` for a dark frame, e.g. a video).
    "sandbox", "live", "chrome", "frame",
    # `keeppoll: yes` keeps the poll before this embed open on the phones while
    # it shows (engine field `keepPollOpen`) — for a figure reporting it live.
    "keeppoll",
    # `hive: no` on an open `poll` keeps the classic question slide instead of
    # the live clustered hive (the default for open questions).
    "hive",
    # `axes:` on an open `poll` places the answers on the presenter's own axes
    # (the hive matrix) instead of clustering them: `Automation | Augmentation`
    # or two axes `A | B ; C | D`, each pole optionally `Label = definition`.
    # `quads:` names the four quadrants, `TL | TR | BL | BR`.
    "axes", "quads",
    # `texts:` an embed's (or a game's) editable labels as one-line JSON. It
    # was missing here, so the line was read as prose and the wording never
    # reached the element.
    "texts",
    # `## game`: the screen page (the figure, with the lecturer's controls)
    # and the phone page (the activity) of a one-slide game.
    "screen", "phone",
}

# Fields that hold ONE token, never a sentence. A prose line after one of
# these is the block's body, not a continuation -- `fit: contain` followed by
# a card's text used to compile to `fit: contain The card text…`, which is
# neither a valid fit nor a body, and the card came out with no text at all.
NOWRAP_KEYS = {
    "id", "image", "fit", "side", "page", "src", "poster", "zoom", "code",
    "kind", "columns", "preset", "transition", "steps", "background",
    "requirename", "showjoin", "min", "max", "activity", "accent", "multi",
    "live", "chrome", "frame", "keeppoll", "hive", "axes", "quads",
    "texts", "screen", "phone",
}

TRUTHY = ("yes", "true", "1", "on")
FALSEY = ("no", "false", "0", "off")

# keys a `steps:` sub-block may override on the slide it is a frame of
STEP_KEYS = ("image", "fit", "caption", "notes", "background")

MARGIN = 56
CANVAS_W, CANVAS_H = 1280, 720


# ────────────────────────────────────────────────────────────── markdown spec

class Block:
    """A slide, or a `###` sub-block inside one."""

    def __init__(self, kind: str = ""):
        self.kind = kind
        self.fields: dict[str, str] = {}
        self.bullets: list[dict] = []        # {text, subs:[str]}
        self.rows: list[list[str]] = []      # markdown table rows
        self.series: list[tuple[str, list]] = []
        # ('shape'|'label', id, [pipe-separated args]) for `diagram` slides
        self.shapes: list[tuple[str, str, list[str]]] = []
        self.blocks: list[Block] = []

    def get(self, *names, default=""):
        for n in names:
            if self.fields.get(n):
                return self.fields[n]
        return default

    def bullet_texts(self) -> list[str]:
        return [b["text"] for b in self.bullets]


def parse_spec(text: str) -> tuple[dict, list[Block]]:
    lines = text.replace("\r\n", "\n").split("\n")
    meta: dict[str, str] = {}
    i = 0
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            if ":" in lines[i]:
                k, v = lines[i].split(":", 1)
                meta[k.strip()] = v.strip()
            i += 1
        i += 1

    slides: list[Block] = []
    slide: Block | None = None
    sub: Block | None = None
    last_field: tuple[Block, str] | None = None
    # The bullet a bare continuation line belongs to. Without this a wrapped
    # bullet's second line is "prose", which lands in `body` — a field most
    # builders never read — so the tail of the sentence silently vanishes.
    # See SLIDE_SPEC.md, "Three ways to lose text silently".
    last_bullet: Callable[[str], None] | None = None

    def target() -> Block | None:
        return sub or slide

    for raw in lines[i:]:
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            last_field = None
            last_bullet = None
            continue
        if stripped.startswith("<!--"):
            continue

        m = re.match(r"^##\s+([a-z][a-z0-9-]*)\s*$", stripped)
        if m:
            slide = Block(m.group(1))
            slides.append(slide)
            sub = None
            last_field = None
            last_bullet = None
            continue
        if slide is None:
            continue

        # `###` on its own opens an unlabelled sub-block — a gallery frame with
        # no caption still needs to be its own block.
        if stripped == "###" or stripped.startswith("### "):
            sub = Block("item")
            sub.fields["heading"] = stripped[3:].strip()
            slide.blocks.append(sub)
            last_field = None
            last_bullet = None
            continue

        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                continue
            target().rows.append(cells)
            last_field = None
            last_bullet = None
            continue

        # shape <id>: <kind> | x | y | w | h | fill [| stroke | strokeWidth]
        # or  label <id>: x | y | w | h | text [| size | color | align]
        m = re.match(r"^(shape|label)\s+(\S+?):\s*(.*)$", stripped)
        if m:
            parts = [p.strip() for p in m.group(3).split("|")]
            target().shapes.append((m.group(1), m.group(2), parts))
            last_field = None
            last_bullet = None
            continue

        m = re.match(r"^series\s+(.+?):\s*(.*)$", stripped)
        if m:
            vals = [v.strip() for v in m.group(2).split("|")]
            nums = []
            for v in vals:
                v = v.replace(",", "").replace("%", "")
                try:
                    nums.append(float(v) if "." in v else int(v))
                except ValueError:
                    nums.append(None)
            target().series.append((m.group(1).strip(), nums))
            last_field = None
            last_bullet = None
            continue

        m = re.match(r"^(\s*)[-*]\s+(.*)$", raw)
        if m:
            indent, txt = len(m.group(1)), m.group(2).strip()
            blk = target()
            if indent >= 2 and blk.bullets:
                subs = blk.bullets[-1]["subs"]
                subs.append(txt)

                def last_bullet(extra: str, _s=subs) -> None:
                    _s[-1] = (_s[-1] + " " + extra).strip()
            else:
                blk.bullets.append({"text": txt, "subs": []})
                bullet = blk.bullets[-1]

                def last_bullet(extra: str, _b=bullet) -> None:
                    _b["text"] = (_b["text"] + " " + extra).strip()
            last_field = None
            continue

        m = re.match(r"^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$", stripped)
        if m and m.group(1).lower() in KEYS:
            blk = target()
            key = m.group(1).lower()
            blk.fields[key] = m.group(2).strip()
            last_field = (blk, key)
            last_bullet = None
            continue

        if last_field and last_field[1] not in NOWRAP_KEYS:
            blk, key = last_field
            blk.fields[key] = (blk.fields[key] + " " + stripped).strip()
        elif last_bullet:
            # A wrapped bullet. Continues the bullet it follows; a blank line
            # ends it, which is how prose after a list still reaches `body`.
            last_bullet(stripped)
        else:
            blk = target()
            blk.fields["body"] = (blk.fields.get("body", "") + " " + stripped).strip()
            last_field = (blk, "body")

    return meta, slides


# ────────────────────────────────────────────────────────────────── text util

def esc(text: str) -> str:
    """Markdown-ish inline formatting -> the inline html the app accepts.
    `code` becomes a code span, left exactly as typed (no bold, no dashes)."""
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for part in parts:
        part_h = part.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if len(part) > 2 and part.startswith("`") and part.endswith("`"):
            out.append("<code>" + part_h[1:-1] + "</code>")
            continue
        part_h = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", part_h)
        part_h = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<i>\1</i>", part_h)
        out.append(part_h.replace("--", "—"))
    return "".join(out)


CODE_ONLY = re.compile(r"^\s*`[^`]+`\s*$")


def list_line(text: str, level: int) -> str:
    """One line of a list box. A bullet that is nothing but `code` is drawn
    as a code block at that level (render.ts codeLine), so it takes no marker."""
    lead = "&nbsp;&nbsp;" if level == 2 else ""
    if CODE_ONLY.match(text or ""):
        return lead + esc(text.strip())
    return lead + "• " + esc(text)


def plain_len(text: str) -> int:
    return len(re.sub(r"<[^>]+>", "", text))


def wrapped_lines(html: str, width_px: int, font_size: int, glyph: float = 0.52) -> int:
    """Rough line count: average glyph ≈ 0.52 em (Manrope measures nearer
    0.47; the default errs wide so a box is never too small for its text)."""
    per_line = max(1, int(width_px / (font_size * glyph)))
    total = 0
    for part in html.split("<br>"):
        total += max(1, math.ceil(plain_len(part) / per_line))
    return total


def bullet_html(b: dict) -> str:
    """One bullet's text plus its sub-points as indented "• " lines, markers
    included (a code-only line takes none — list_line). The renderer draws every line that starts with
    "• " as a list item (hanging indent, accent marker); two leading &nbsp;s make
    it second level. So a whole list is ONE text element."""
    html = list_line(b["text"], 1)
    for sub in b["subs"]:
        html += "<br>" + list_line(sub, 2)
    return html


def body_html(block: Block, key: str = "body") -> str:
    parts = []
    if block.get(key):
        parts.append(esc(block.get(key)))
    if block.bullets:
        parts.extend(bullet_html(b) for b in block.bullets)
    return "<br>".join(parts)


# ───────────────────────────────────────────────────────────── template model

class Template:
    def __init__(self, path: Path):
        self.path = path
        self.html = path.read_text(encoding="utf-8")
        m = DOC_RE.search(self.html)
        if not m:
            raise SystemExit(f"{path}: no #{deckio.DOC_ID} script block found")
        self.doc = json.loads(m.group(2))
        self.layouts = {l["id"]: l for l in self.doc.get("layouts", [])}

    def lay(self, role: str, fallback: str | None = None) -> str:
        """The id of the layout that plays `role` (id == role or ends '-role')."""
        for r in (role, fallback):
            if r:
                lid = deckio.layout_id(self.layouts, r)
                if lid:
                    return lid
        raise SystemExit(f"{self.path.name}: no layout for the role '{role}' "
                         f"(a layout id '{role}' or '<prefix>-{role}')")

    def has(self, role: str) -> bool:
        return deckio.layout_id(self.layouts, role) is not None

    def optional(self, layout_id: str, element_id: str) -> list:
        """[the element] when the layout has it (a logo, say), else []."""
        try:
            return [self.element(layout_id, element_id)]
        except KeyError:
            return []

    def style(self, layout_id: str, element_id: str, *drop: str) -> dict:
        for el in self.layouts[layout_id]["elements"]:
            if el["id"] == element_id:
                out = {k: v for k, v in el.items()
                       if k not in ("id", "x", "y", "w", "h", "html",
                                    "placeholder", *drop)}
                return json.loads(json.dumps(out))
        raise KeyError(f"{layout_id}/{element_id}")

    def element(self, layout_id: str, element_id: str) -> dict:
        for el in self.layouts[layout_id]["elements"]:
            if el["id"] == element_id:
                return json.loads(json.dumps(el))
        raise KeyError(f"{layout_id}/{element_id}")


def text_el(tpl: Template, layout: str, style_from: str, eid: str,
            x, y, w, h, html: str, **over) -> dict:
    el = {"id": eid, "type": "text", "x": x, "y": y, "w": w, "h": h,
          "rotation": 0, "opacity": 1, "html": html}
    el.update(tpl.style(layout, style_from, "role"))
    el.update(over)
    return el


# ───────────────────────────────────────────────────────────────────── assets

def optimize(path: Path, max_px: int) -> tuple[bytes, str]:
    """Downscale to max_px on the long edge; flatten opaque PNGs to JPEG."""
    raw = path.read_bytes()
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    if mime == "image/svg+xml" or max_px <= 0:
        return raw, mime
    try:
        from io import BytesIO

        from PIL import Image
    except ImportError:
        return raw, mime
    try:
        im = Image.open(BytesIO(raw))
        im.load()
    except Exception:
        return raw, mime
    if max(im.size) > max_px:
        im.thumbnail((max_px, max_px), Image.LANCZOS)
    has_alpha = im.mode in ("RGBA", "LA", "P") and (
        im.mode != "P" or "transparency" in im.info)
    if has_alpha:  # a fully opaque alpha channel is just wasted bytes
        alpha = im.convert("RGBA").getchannel("A")
        has_alpha = alpha.getextrema()[0] < 250
    buf = BytesIO()
    if has_alpha:
        im.convert("RGBA").save(buf, "PNG", optimize=True)
        out_mime = "image/png"
    else:
        im.convert("RGB").save(buf, "JPEG", quality=82, optimize=True,
                               progressive=True)
        out_mime = "image/jpeg"
    return (buf.getvalue(), out_mime) if len(buf.getvalue()) < len(raw) else (raw, mime)


class Assets:
    def __init__(self, doc: dict, base: Path, max_px: int = 1600,
                 roots: list[Path] | None = None):
        self.doc = doc
        self.base = base
        self.max_px = max_px
        # where a relative path may live: next to the spec, inside the `media:`
        # directory, or under the cwd. A bare `d4c1d43194.png` resolves against
        # `media:`, which is why the extractor can stop repeating the directory
        # on every image line.
        self.roots = [base, *(roots or []), Path.cwd()]
        self.cache: dict[str, str] = {}

    def resolve(self, rel: str) -> Path | None:
        if Path(rel).is_absolute():
            p = Path(rel)
            return p if p.exists() else None
        for root in self.roots:
            p = root / rel
            if p.exists():
                return p
        return None

    def add(self, rel: str) -> str | None:
        rel = rel.strip()
        if not rel:
            return None
        if rel in self.cache:
            return self.cache[rel]
        path = self.resolve(rel)
        if path is None:
            print(f"  ! missing image {rel}")
            return None
        blob, mime = optimize(path, self.max_px)
        data = base64.b64encode(blob).decode()
        key = "img-" + re.sub(r"[^a-zA-Z0-9]+", "-", path.stem).strip("-").lower()
        self.doc.setdefault("assets", {})[key] = f"data:{mime};base64,{data}"
        self.cache[rel] = key
        return key

    def add_page(self, rel: str) -> str | None:
        """Store an HTML page verbatim in doc.assets, for an `embed` element.

        Not base64: the embed renderer feeds the asset straight to iframe
        srcdoc, so it wants the markup as-is.
        """
        rel = rel.strip()
        if not rel:
            return None
        ck = "page:" + rel
        if ck in self.cache:
            return self.cache[ck]
        path = self.resolve(rel)
        if path is None:
            print(f"  ! missing page {rel}")
            return None
        key = "page-" + re.sub(r"[^a-zA-Z0-9]+", "-", path.stem).strip("-").lower()
        self.doc.setdefault("assets", {})[key] = path.read_text(encoding="utf-8")
        self.cache[ck] = key
        return key

    def image_el(self, rel: str, eid: str, x, y, w, h,
                 fit="cover", radius=4) -> dict | None:
        key = self.add(rel)
        if not key:
            return None
        return {"id": eid, "type": "image", "x": x, "y": y, "w": w, "h": h,
                "rotation": 0, "opacity": 1, "src": f"asset:{key}",
                "fit": fit, "radius": radius}

    def tint(self, rel: str) -> str:
        """The ground colour for a CONTAINED picture — see build_image.

        The dominant colour of the picture's border ring, so the panel
        continues the picture's own backdrop; a busy border falls back to its
        mean mixed 30/70 with white, and a cut-out or white backdrop keeps a
        white panel. The rule lives in panel_tint.py, which also retints an
        already-compiled deck after an image swap.
        """
        path = self.resolve((rel or "").strip()) if rel else None
        if path is None:
            return "#FFFFFF"
        from panel_tint import panel_tint
        return panel_tint(path)


# ─────────────────────────────────────────────────────────── slide builders

def chrome(tpl: Template, layout: str, els: list, footer: str,
           want_footer=True, want_page=True) -> None:
    """Logo + footer + page number, straight from the layout. A builder that
    placed one itself keeps its own: a second element with the same id makes
    the editor refuse every live patch to the deck."""
    have = {e.get("id") for e in els}
    want_footer = want_footer and "footer" not in have
    want_page = want_page and "pageno" not in have
    for eid in ("logo",):
        if eid in have:
            continue
        try:
            els.append(tpl.element(layout, eid))
        except KeyError:
            pass
    if want_footer and footer:
        try:
            el = tpl.element(layout, "footer")
            el["html"] = esc(footer)
            els.append(el)
        except KeyError:
            pass
    if want_page:
        try:
            els.append(tpl.element(layout, "pageno"))
        except KeyError:
            pass


def build_title(tpl, s, ctx):
    """Every element of the template's title layout, in its own geometry —
    the cover figure, logo and any slogan as they are, the two texts filled."""
    L = tpl.lay("title")
    els = []
    for el in tpl.layouts[L]["elements"]:
        el = json.loads(json.dumps(el))
        if el["id"] == "ti-title":
            el.pop("placeholder", None); el.pop("role", None)
            el["html"] = esc(s.get("title"))
            el.setdefault("fx", {"enter": "fade-up", "order": 0})
        elif el["id"] == "ti-sub":
            sub = s.get("subtitle")
            if not sub:
                continue
            el.pop("placeholder", None); el.pop("role", None)
            el["html"] = esc(sub).replace(" · ", "<br>") if sub.count(" · ") > 1 else esc(sub)
            el.setdefault("fx", {"enter": "fade-up", "order": 1})
        els.append(el)
    return L, els


def build_section(tpl, s, ctx):
    L = tpl.lay("section")
    els = [tpl.element(L, "se-band"), *tpl.optional(L, "logo")]
    tagline = s.get("tagline", default=config.get("TESSERA_SECTION_TAGLINE") or "")
    els.append(text_el(tpl, L, "se-tagline", "se-tagline", 56, 22, 300, 48, tagline))
    els.append(text_el(tpl, L, "se-title", "se-title", 56, 330, 1104, 150,
                       esc(s.get("title")), fx={"enter": "fade-up", "order": 0}))
    if s.get("subtitle"):
        els.append(text_el(tpl, L, "se-tagline", "se-sub", 56, 480, 900, 60,
                           esc(s.get("subtitle")), fontSize=20,
                           color="#CDD6EE", fx={"enter": "fade-up", "order": 1}))
    return L, els


def list_height(rows: list[str], width: int, fs: int, line_h: float) -> float:
    """Height of "• " list lines as the renderer lays them out: each line hangs
    ~1.1em in (2.2em at level 2) and items are 0.4em apart. The 0.5-em glyph
    sits between Manrope's real ~0.47 and the old box-sizing 0.52."""
    total = 0.0
    for r in rows:
        indent = fs * (2.2 if r.startswith("&nbsp;&nbsp;") else 1.1)
        if "• " not in r and "<code>" in r:
            # a code block: 0.7em mono (~0.6em glyphs), 1.55 leading, 0.6em pad
            cfs = fs * 0.7
            total += wrapped_lines(r, int(width - indent - 2 * cfs), cfs, 0.6) \
                * cfs * 1.55 + 1.2 * cfs
            continue
        total += wrapped_lines(r, int(width - indent), fs, 0.5) * fs * line_h
    return total + max(0, len(rows) - 1) * 0.4 * fs


def build_content(tpl, s, ctx):
    """Title + ONE text box holding every bullet as a "• " line.

    The renderer draws the markers and the hanging indent, so the list stays a
    single editable element (it used to be a box per bullet plus a box per dot,
    whose spacing broke whenever a line wrapped differently from the estimate).
    The type shrinks until the whole list fits the template's co-body box."""
    L = tpl.lay("content")
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "co-title", "co-title", 56, 96, 1168, 56,
                       esc(s.get("title"))))
    bullets = s.bullets or ([{"text": s.get("body"), "subs": []}] if s.get("body") else [])
    if not bullets:
        return L, els
    box = tpl.element(L, "co-body")
    rows = "<br>".join(bullet_html(b) for b in bullets).split("<br>")
    size, line_h = box["fontSize"], box.get("lineHeight", 1.45)
    while size > 14 and list_height(rows, box["w"], size, line_h) > box["h"]:
        size -= 1
    els.append(text_el(tpl, L, "co-body", "co-body", box["x"], box["y"], box["w"],
                       box["h"], "<br>".join(rows), fontSize=size,
                       fx={"enter": "fade-up", "order": 1}))
    return L, els


def build_statement(tpl, s, ctx):
    L = tpl.lay("statement")
    els = []
    chrome(tpl, L, els, ctx["footer"])
    title = esc(s.get("title"))
    if title:
        els.append(text_el(tpl, L, "st-title", "st-title", 0, 200, 1280, 120,
                           title, fx={"enter": "fade-up", "order": 0}))
    body = body_html(s)
    if body:
        # With no title above it the body gets the whole stage. A converted deck
        # puts long quoted passages on a bare slide, and the old fixed 340..560
        # box let them run out through the footer.
        y, h = (340, 220) if title else (150, 460)
        # Size it to the box: the layout's small body type left a case prompt
        # or a one-line point at 14px in the middle of an empty slide.
        size = 26 if title else 34
        while size > 16 and list_height([body], 840, size, 1.4) > h:
            size -= 1
        els.append(text_el(tpl, L, "st-body", "st-body", 220, y, 840, h, body,
                           fontSize=size, fx={"enter": "fade-up", "order": 1}))
    return L, els


def build_quote(tpl, s, ctx):
    L = tpl.lay("quote")
    els = [*tpl.optional(L, "logo"), tpl.element(L, "qu-mark")]
    quote = esc(s.get("quote", "title", "body"))
    q = tpl.element(L, "qu-text")
    size, line_h = q.get("fontSize", 32), q.get("lineHeight", 1.4)
    # A long passage grows the box upward and shrinks until it fits above the
    # attribution, instead of running out over the logo.
    while size > 16 and list_height([quote], 1080, size, line_h) > 440:
        size -= 1
    h = max(220, min(440, int(list_height([quote], 1080, size, line_h)) + 10))
    els.append(text_el(tpl, L, "qu-text", "qu-text", 100, 555 - h, 1080, h,
                       quote, fontSize=size))
    if s.get("attribution"):
        els.append(text_el(tpl, L, "qu-attr", "qu-attr", 0, 570, 1280, 30,
                           esc(s.get("attribution"))))
    els.append(tpl.element(L, "pageno"))
    return L, els


def build_compare(tpl, s, ctx):
    L = tpl.lay("compare")
    # The second option sits on a blue panel filling the right half (cm-panel),
    # its text and the page number in white: all of it read from the layout.
    els = [tpl.element(L, "cm-panel")]
    chrome(tpl, L, els, ctx["footer"])
    t = tpl.element(L, "cm-title")
    title = esc(s.get("title"))
    t_size = t["fontSize"]
    while t_size > 26 and list_height([title], t["w"], t_size, t.get("lineHeight", 1.2)) > t["h"]:
        t_size -= 2
    els.append(text_el(tpl, L, "cm-title", "cm-title", t["x"], t["y"], t["w"], t["h"],
                       title, fontSize=t_size))
    # Geometry and type come from the template's own cm-h/cm-p frames; the body
    # shrinks from the template size only as far as it must to fit its box.
    for i, blk in enumerate(s.blocks[:2], 1):
        h, p = tpl.element(L, f"cm-h{i}"), tpl.element(L, f"cm-p{i}")
        els.append(text_el(tpl, L, f"cm-h{i}", f"cm-h{i}", h["x"], h["y"], h["w"],
                           h["h"], esc(blk.get("heading")),
                           fx={"enter": "fade-up", "order": i}))
        body = body_html(blk)
        size, line_h = p["fontSize"], p.get("lineHeight", 1.5)
        while size > 14 and list_height(body.split("<br>"), p["w"], size, line_h) > p["h"]:
            size -= 1
        els.append(text_el(tpl, L, f"cm-p{i}", f"cm-p{i}", p["x"], p["y"], p["w"],
                           p["h"], body, fontSize=size,
                           fx={"enter": "fade-up", "order": i}))
    return L, els


def plate(el, hairline: bool = True):
    """Strip a backing rect down to a plain plate.

    `im-panel` may still carry the old brand gradient. A `fit: contain`
    picture cannot cover it, so the gradient would show around the artwork --
    a coloured box behind a logo rather than a design. Callers overwrite
    `fill` with `Assets.tint` right after; this is what clears the gradient
    underneath and supplies the white fallback.
    """
    el["fill"] = "#FFFFFF"
    el.pop("fillGradient", None)
    if hairline:
        el["stroke"] = "#E3E7F0"
        el["strokeWidth"] = 1
    return el


def build_points_cards(tpl, s, ctx, items):
    """Points with NO picture — the template's 08 pattern.

    Each column is a 64px square chip in the column's colour, a 4px rule in
    the same colour, the heading in the title face and the body under it. No
    card and no panel: the chip and the rule are the only colour on the slide.

    The chip holds the block's `icon:` (a lucide name, fetched and cached by
    `tools/icon.py`; `tabler:name` for the other stroke set) — white on the
    accent, navy on the lighter colours. A block with no icon, or one that
    cannot be fetched, gets its number there instead.

    Columns are `build_gallery`'s: same x and width, so a points slide and a
    photo row morph into each other.
    """
    L = tpl.lay("points")
    # Accent first, then the saturated chart colours — the order the
    # template's 08 slide uses.
    accent = ctx["theme"].get("accent", tok("#0F6B73"))
    palette = [accent, tok("#3B9457"), tok("#BF831A"), tok("#D2553A")]
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "pt-title", "pt-title", 56, 88, 1000, 52,
                       esc(s.get("title"))))
    n = len(items)
    gutter = 32
    w = int((1168 - gutter * (n - 1)) / n)
    for i, blk in enumerate(items, 1):
        x = 56 + (w + gutter) * (i - 1)
        colour = palette[(i - 1) % len(palette)]
        on_chip = "#FFFFFF" if colour == accent else tok("#0D2A2F")
        els.append({"id": f"pt-chip{i}", "type": "shape", "shape": "rect",
                    "x": x, "y": 184, "w": 64, "h": 64, "rotation": 0,
                    "opacity": 1, "fill": colour, "stroke": "transparent",
                    "strokeWidth": 0, "radius": 0})
        mark = points_icon(blk.get("icon"), f"pt-icon{i}", x + 14, 198, on_chip)
        els.append(mark or text_el(tpl, L, "pt-h1", f"pt-num{i}", x, 184, 64, 64,
                                   f"{i:02d}", fontSize=24, color=on_chip,
                                   align="center", valign="middle"))
        els.append({"id": f"pt-bar{i}", "type": "shape", "shape": "rect",
                    "x": x, "y": 276, "w": w, "h": 4, "rotation": 0,
                    "opacity": 1, "fill": colour, "stroke": "transparent",
                    "strokeWidth": 0, "radius": 0})
        head = esc(blk.get("heading")) or esc(blk.get("caption"))
        h_fs = int(tpl.style(L, "pt-h1", "role").get("fontSize") or 24)
        head_h = max(34, wrapped_lines(head, w, h_fs)
                     * int(h_fs * 1.35)) if head else 0
        y = 300
        if head:
            els.append(text_el(tpl, L, "pt-h1", f"pt-h{i}", x, y, w, head_h,
                               head, align="left",
                               fx={"enter": "fade-up", "order": i}))
        body_y = y + head_h + (10 if head else 0)
        els.append(text_el(tpl, L, "pt-p1", f"pt-p{i}", x, body_y, w,
                           max(40, 624 - body_y), body_html(blk),
                           align="left", fx={"enter": "fade-up", "order": i}))
    return L, els


def points_icon(name, eid, x, y, colour):
    """A 36px stroke icon as a `path` element, or None (no name, no network
    and not cached, unknown name) — the caller then shows the number."""
    name = str(name or "").strip()
    if not name:
        return None
    setname, _, icon_name = name.rpartition(":")
    try:
        import icon
        return icon.element(icon_name, setname or "lucide", eid, x, y, 36, colour, 2)
    except (Exception, SystemExit) as e:
        print(f"  icon '{name}' not placed ({e}); the chip shows the number")
        return None


def build_points(tpl, s, ctx):
    """Up to 4 columns: a picture, a heading and a paragraph under each.

    With no picture on any column this hands off to `build_points_cards` —
    the template's 08 pattern — because the picture-less version of this
    shape is an empty coloured rectangle above a caption.

    Distinct from `gallery`, which is the same row of pictures with a caption
    and one line under each. Use this when each column has something to say;
    use `gallery` when the pictures are the point. A column with no `image:`
    on a slide where others have one simply gets no picture — the placeholder
    card that used to fill the hole was the failure mode, not the fix.
    """
    L = tpl.lay("points")
    items = s.blocks[:4] or [s]
    if not any(b.get("image") for b in items):
        return build_points_cards(tpl, s, ctx, items)
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "pt-title", "pt-title", 56, 88, 1000, 52,
                       esc(s.get("title"))))
    n = len(items)
    gutter = 32
    total = 1224 - 56
    w = int((total - gutter * (n - 1)) / n)
    img_h = 250 if n <= 3 else 200
    for i, blk in enumerate(items, 1):
        x = 56 + (w + gutter) * (i - 1)
        contained = blk.get("image") and blk.get("fit", default="cover") == "contain"
        if contained:
            # Same rule as build_image: a contained picture gets a ground in
            # its own colour, not a gap. A cover-cropped one needs no card —
            # the old layout put a brand-gradient rect behind every column,
            # which a photo covered completely and a logo turned into a box.
            els.append({"id": f"pt-img{i}", "type": "shape", "shape": "rect",
                        "x": x, "y": 230, "w": w, "h": img_h, "rotation": 0,
                        "opacity": 1, "fill": ctx["assets"].tint(blk.get("image")),
                        "stroke": "transparent", "strokeWidth": 0, "radius": 4})
        img = ctx["assets"].image_el(blk.get("image"), f"pt-pic{i}", x, 230,
                                     w, img_h,
                                     fit=blk.get("fit", default="cover"),
                                     radius=4) \
            if blk.get("image") else None
        if img:
            els.append(img)
        # A heading long enough to wrap used to overrun its fixed 30px box and
        # sit on top of the body -- which is the normal case for a converted
        # deck, where the heading is a whole line lifted out of the source.
        # Measure it, and push the body down by however much it actually needs.
        y = 230 + img_h + 22
        head = esc(blk.get("heading"))
        h_fs = int(tpl.style(L, "pt-h1", "role").get("fontSize") or 20)
        head_h = max(30, wrapped_lines(head, w, h_fs) * int(h_fs * 1.35)) if head else 0
        if head:
            els.append(text_el(tpl, L, "pt-h1", f"pt-h{i}", x, y, w, head_h,
                               head, fx={"enter": "fade-up", "order": i}))
        body_y = y + head_h + (6 if head else 0)
        els.append(text_el(tpl, L, "pt-p1", f"pt-p{i}", x, body_y, w,
                           max(40, 664 - body_y), body_html(blk),
                           fx={"enter": "fade-up", "order": i}))
    return L, els


def build_image(tpl, s, ctx):
    """One picture beside title + body — the workhorse single-image slide.

    Two shapes, chosen by `fit`. `contain` is the template's 09 pattern;
    `cover` is the half-bleed shape, which the template no longer keeps a
    worked slide for:

    · `cover` (the default) — the photo fills the whole 640-wide half, bleeding
      off three edges, with a slow ken-burns drift.
    · `contain` — the whole frame survives, inset inside the half, and the
      panel behind it takes the colour of the image's own border (its
      backdrop), so the picture's edge disappears into it. A picture that
      already sits on white or transparency keeps a white panel instead
      (`Assets.tint`), because a tint behind a cut-out is just a box.

    For a big, high-resolution photograph that deserves the whole slide, the
    template's 09a (full bleed under the diagonal band) beats both; it is a
    slide to copy, not a type this compiler emits.
    """
    L = tpl.lay("image")
    els = []
    left = s.get("side").lower() == "left"
    panel_x = 0 if left else 640
    text_x = 696 if left else 56
    panel = tpl.element(L, "im-panel")
    panel.update({"x": panel_x, "y": 0, "w": 640, "h": 720})
    plated = bool(s.get("image")) and s.get("fit", default="cover") == "contain"
    if plated:
        plate(panel, hairline=False)
        panel["fill"] = ctx["assets"].tint(s.get("image"))
    els.append(panel)
    box = (panel_x + 64, 76, 512, 568) if plated else (panel_x, 0, 640, 720)
    img = ctx["assets"].image_el(s.get("image"), "im-pic", *box,
                                 fit=s.get("fit", default="cover"), radius=0)
    if img:
        if not plated:
            img["fx"] = {"ambient": "kenburns",
                         "ken": {"dir": "drift", "scale": 1.06, "duration": 20}}
        els.append(img)
    else:
        cap = tpl.element(L, "im-cap")
        cap.update({"x": panel_x, "y": 0, "w": 640, "h": 720,
                    "html": esc(s.get("caption", default="Image placeholder"))})
        els.append(cap)
    if img and s.get("caption"):
        # Clear of the inset picture when it is contained (it ends at y=644),
        # over the bleed when it is not.
        els.append(text_el(tpl, L, "im-cap", "im-cap", panel_x,
                           652 if plated else 640, 640, 40,
                           esc(s.get("caption")), fontSize=13, valign="middle",
                           color=tok("#5A6467") if plated else "#FFFFFF"))
    # The layout parks the logo top-left, over the picture whenever `side: left`
    # flips the panel there. It belongs on the text side, like the footer below.
    for logo in tpl.optional(L, "logo"):
        logo["x"] = text_x
        els.append(logo)
    els.append(text_el(tpl, L, "im-title", "im-title", text_x, 110, 528, 56,
                       esc(s.get("title"))))
    body = body_html(s)
    if body:
        els.append(text_el(tpl, L, "im-body", "im-body", text_x, 220, 528, 380,
                           body, fx={"enter": "fade-up", "order": 1}))
    fel = tpl.element(L, "footer")
    fel["x"] = text_x
    fel["html"] = esc(ctx["footer"])
    els.append(fel)
    try:  # the pageno sits bottom-RIGHT, so `side` never moves it
        els.append(tpl.element(L, "pageno"))
    except KeyError:
        pass
    return L, els


def build_embed(tpl, s, ctx):
    """A live web page filling the slide — simulation, interactive figure, app.

    The only element that runs JavaScript, so this is what a slide becomes when
    the point is something the audience (or the presenter) drives, rather than
    a sequence the arrow key steps through.

    `page:` is a local HTML file, embedded verbatim so the deck stays portable
    and works offline; `src:` is a URL, which does not. `poster:` is an image
    shown wherever a slide gets rasterized — the slide thumbnails cannot
    screenshot a live frame. The editor canvas uses it unless `live: yes`.

    Full-bleed by default: most embedded pages carry their own heading, and a
    title band would just compete with it. Set `title:` to add one.
    """
    L = tpl.lay("embed", "content")
    els = []
    full = not s.get("title")
    x, y = 0, (0 if full else 150)
    w, h = 1280, (720 if full else 500)
    # `frame: x,y,w,h` overrides the box. The reason it exists: a page that
    # draws its own chrome — a video player prints the clip's title top-left
    # and a control bar along the bottom — collides with the deck's logo and
    # footer when it bleeds to the edges. Inset it and the two stop fighting.
    if s.get("frame"):
        try:
            x, y, w, h = (int(float(n)) for n in
                          re.split(r"[\s,]+", s.get("frame").strip()))
        except ValueError:
            print("  ! embed frame: needs four numbers x,y,w,h")
    el = {"id": "em-frame", "type": "embed", "x": x, "y": y, "w": w, "h": h,
          "rotation": 0, "opacity": 1, "radius": 0}
    key = ctx["assets"].add_page(s.get("page")) if s.get("page") else None
    # A figure on the live server (`src: http://127.0.0.1:5173/build/figures/x.html`)
    # is compiled as the page itself plus `devSrc`: the edit canvas runs the
    # source, the show and every copy of the slide run what is in the file.
    dev = re.match(r"^http://(?:127[.]0[.]0[.]1|localhost)(?::[0-9]+)?/([^?#]+)$", (s.get("src") or "").strip())
    if not key and dev:
        key = ctx["assets"].add_page(dev.group(1))
        if key:
            store = ctx["assets"].doc["assets"]
            fonts = sorted((f for f in ctx["assets"].doc.get("fonts", []) if f.get("family") == "Manrope"),
                           key=lambda f: "latin-ext" in f["asset"])
            if fonts and store.get(fonts[0]["asset"]):
                store[key] = store[key].replace("url(MANROPE)", f"url({store[fonts[0]['asset']]})")
            el["devSrc"] = s.get("src").strip()
    if key:
        el["asset"] = key
    elif s.get("src"):
        el["src"] = s.get("src")
    else:
        print(f"  ! embed slide has neither page: nor src:")
    if s.get("poster"):
        pk = ctx["assets"].add(s.get("poster"))
        if pk:
            el["poster"] = f"asset:{pk}"
    if s.get("zoom"):
        try:
            el["zoom"] = float(s.get("zoom"))
        except ValueError:
            pass
    # Extra sandbox tokens on top of the always-applied `allow-scripts`. A
    # third-party player wants `allow-same-origin` (without its own origin
    # YouTube's player boots to a black rectangle) plus `allow-popups
    # allow-popups-to-escape-sandbox allow-presentation` for its "watch on"
    # link and its fullscreen button. The renderer honours `allow-same-origin`
    # only on a cross-origin `src:`; on an inline `page:` it strips it, because
    # a srcdoc frame's own origin is the deck's.
    sandbox = [t for t in re.split(r"[\s,]+", s.get("sandbox", default="") or "") if t]
    if el.get("devSrc"):  # inline page: the token would be refused anyway
        sandbox = [t for t in sandbox if t != "allow-same-origin"]
    if sandbox:
        el["sandbox"] = sandbox
    # `liveInEditor` runs the frame on the editor canvas too, not only in
    # present mode. An inline figure (`page:`) runs by default: without it the
    # editor — and the live link, which is the editor — shows only the frozen
    # poster, which reads as "the infographic is still an image". `live: no` opts a heavy page out. A `src:` frame (a
    # video, a remote site) stays opt-in with `live: yes`.
    live = str(s.get("live", default="")).strip().lower()
    if live in ("yes", "true", "1") or (key and live not in ("no", "false", "0")):
        el["liveInEditor"] = True
    if str(s.get("keeppoll", default="")).strip().lower() in TRUTHY:
        el["keepPollOpen"] = True
    # `texts: {"title": "…", "n1": "…"}` — the person's wording for the page's
    # data-edit labels. Edits made in the editor are carried over from the
    # previous build anyway (see _carry_over); this pins them in the spec.
    texts = parse_texts(s)
    if texts:
        el["texts"] = texts
    els.append(el)
    # A full-bleed frame that is dark (a video player) swallows the navy logo
    # and the muted footer whole. `chrome: dark` takes the same three pieces
    # from 09a instead — white wordmark, pale footer, white page number — and
    # puts them back on this deck's 56px margin.
    C = L
    if s.get("chrome").lower() == "dark" and tpl.has("image-hero"):
        C = tpl.lay("image-hero")
    for logo in tpl.optional(C, "logo"):
        logo["x"] = 56
        els.append(logo)
    fel = tpl.element(C, "footer")
    fel.update({"x": 56, "w": 560, "html": esc(ctx["footer"])})
    els.append(fel)
    els.append(tpl.element(C, "pageno"))
    if s.get("title"):
        # the embed layout carries no title placeholder of its own -- borrow
        # the content layout's, so the heading matches every other slide
        els.append(text_el(tpl, tpl.lay("content"), "co-title", "co-title",
                           56, 88, 1168, 56, esc(s.get("title"))))
    return L, els


def build_diagram(tpl, s, ctx):
    """Title + a figure drawn from native shape/text elements.

    For vector artwork the extractor cannot export (a diagram built from
    PowerPoint shapes rather than a picture). Native elements beat a rendered
    PNG on every axis that matters here: they stay crisp at any size, weigh
    almost nothing, remain editable in the app, and — the reason this exists —
    they MORPH. Give a shape the same id on consecutive `steps: morph` frames
    and it tweens instead of cross-fading, so a build animation reads as
    motion rather than a slideshow of stills.

    Coordinates are slide coordinates (1280x720); the source deck's own
    geometry drops straight in.
    """
    L = tpl.lay("content")
    els = []
    chrome(tpl, L, els, ctx["footer"])
    if s.get("title"):
        els.append(text_el(tpl, L, "co-title", "co-title", 56, 88, 1000, 52,
                           esc(s.get("title"))))

    def num(v, default=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    for kind, eid, a in s.shapes:
        if kind == "shape":
            # kind|x|y|w|h|fill|stroke|strokeWidth|strokeStyle|rotation
            g = (a + [""] * 10)[:10]
            el = {"id": eid, "type": "shape", "shape": g[0] or "rect",
                  "x": num(g[1]), "y": num(g[2]), "w": num(g[3]), "h": num(g[4]),
                  "rotation": num(g[9]), "opacity": 1,
                  "fill": g[5] or "transparent",
                  "stroke": g[6] or "transparent",
                  "strokeWidth": num(g[7]), "radius": 0}
            if g[8]:
                el["strokeStyle"] = g[8]
            els.append(el)
        else:
            # x|y|w|h|text|fontSize|color|align|fontWeight
            # `text` is plain text -- escaped, so markup in it is shown, not
            # interpreted. Use the weight field rather than wrapping in <b>.
            g = (a + [""] * 9)[:9]
            over = {"fontSize": int(num(g[5], 20)),
                    "align": g[7] or "center", "valign": "middle"}
            if g[6]:  # empty = keep the layout's own colour
                over["color"] = g[6]
            if g[8]:
                over["fontWeight"] = int(num(g[8], 400))
            els.append(text_el(tpl, L, "co-body", eid, num(g[0]), num(g[1]),
                               num(g[2]), num(g[3]), esc(g[4]), **over))
    return L, els


def build_gallery(tpl, s, ctx):
    """Several pictures on one slide — the template's 09b pattern.

    What makes a row of photographs read as a set is that every picture gets
    an IDENTICAL box and is cover-cropped into it. Contained images at their
    own aspect ratios line up on nothing and look like an accident, so `fit`
    here defaults to `cover`; `fit: contain` is still honoured for the case
    where cropping would destroy the content (a chart, a screenshot).

    Every picture bottoms out at y=500 whatever the count, so the caption
    block — a short accent rule, the caption, then its one-line gloss — sits
    on the same baseline on every gallery slide in the deck, and on the same
    baseline as the `points` cards. That is what lets a photo row and a points
    row morph into each other instead of jumping.
    """
    grid = tpl.has("image-grid")
    L = tpl.lay("image-grid") if grid else tpl.lay("points")
    HEAD, SUB = ("ga-cap1", "ga-sub1") if grid else ("pt-h1", "pt-p1")
    accent = ctx["theme"].get("accent", tok("#0F6B73"))
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "pt-title", "pt-title", 56, 104, 1000, 60,
                       esc(s.get("title"))))
    items = [b for b in s.blocks if b.get("image")]
    if not items and s.get("image"):
        items = [s]
    items = items[:4]
    n = max(1, len(items))
    gutter = 32
    w = int((1168 - gutter * (n - 1)) / n)
    h = {1: 310, 2: 310, 3: 270, 4: 200}[n]
    top = 500 - h
    x0 = 56
    if n == 1:  # one figure: a wide centred stage
        w = 960
        x0 = (CANVAS_W - w) // 2
        if items and not (items[0].get("heading") or items[0].get("caption")):
            # No caption block to line up with: a chart or screenshot gets
            # the whole stage down to the note line, instead of a 310px strip.
            w, x0 = 1168, 56
            top = 170 if s.get("title") else 90
            h = 610 - top
    for i, blk in enumerate(items, 1):
        x = x0 + (w + gutter) * (i - 1)
        img = ctx["assets"].image_el(blk.get("image"), f"ga-pic{i}", x, top, w, h,
                                     fit=blk.get("fit", default="cover"),
                                     radius=8)
        if img:
            img["fx"] = {"enter": "fade-up", "order": i}
            els.append(img)
        cap = esc(blk.get("heading")) or esc(blk.get("caption"))
        sub = esc(blk.get("caption")) if blk.get("heading") else ""
        if cap:
            els.append({"id": f"ga-rule{i}", "type": "shape", "shape": "rect",
                        "x": x + (w - 128) // 2, "y": 536, "w": 128, "h": 2,
                        "rotation": 0, "opacity": 1, "fill": accent,
                        "stroke": "transparent", "strokeWidth": 0, "radius": 0})
            els.append(text_el(tpl, L, HEAD, f"ga-cap{i}", x, 556, w, 28,
                               cap, fontSize=20, align="center",
                               fx={"enter": "fade-up", "order": i}))
        if sub:
            els.append(text_el(tpl, L, SUB, f"ga-sub{i}", x,
                               588 if cap else 536, w, 48, sub, fontSize=15,
                               align="center",
                               fx={"enter": "fade-up", "order": i}))
    return L, els


def build_grid(tpl, s, ctx):
    """Card grid: icon + label, for taxonomies / tech lists."""
    L = tpl.lay("points")
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "pt-title", "pt-title", 56, 88, 1000, 52,
                       esc(s.get("title"))))
    items = s.blocks or [{"heading": b["text"]} for b in s.bullets]
    items = [b if isinstance(b, Block) else _as_block(b) for b in items]
    n = len(items)
    if not n:
        return L, els
    cols = int(s.get("columns", default=0) or 0) or min(4, max(1, math.ceil(math.sqrt(n))))
    rows = math.ceil(n / cols)
    gx, gy = 24, 20
    total_w = 1224 - 56
    w = int((total_w - gx * (cols - 1)) / cols)
    top = 190
    avail = 630 - top
    h = int((avail - gy * (rows - 1)) / rows)
    accent = ctx["theme"].get("accent", tok("#0F6B73"))
    for i, blk in enumerate(items):
        r, c = divmod(i, cols)
        x = 56 + (w + gx) * c
        y = top + (h + gy) * r
        els.append({"id": f"gd-card{i+1}", "type": "shape", "shape": "rect",
                    "x": x, "y": y, "w": w, "h": h, "rotation": 0, "opacity": 1,
                    "fill": tok("#F1F5F5"), "stroke": "transparent",
                    "strokeWidth": 0, "radius": 8,
                    "fx": {"enter": "fade-up", "order": i}})
        pad = 14
        icon = ctx["assets"].image_el(blk.get("image"), f"gd-ic{i+1}",
                                      x + pad, y + pad, 42, 42,
                                      fit="contain", radius=0) \
            if blk.get("image") else None
        ty = y + pad
        if icon:
            icon["fx"] = {"enter": "fade-up", "order": i}
            els.append(icon)
            ty = y + pad + 52
        els.append(text_el(tpl, L, "pt-h1", f"gd-h{i+1}", x + pad, ty,
                           w - pad * 2, 46, esc(blk.get("heading")),
                           fontSize=17, align="left", color=accent,
                           fx={"enter": "fade-up", "order": i}))
        body = body_html(blk)
        if body:
            els.append(text_el(tpl, L, "pt-p1", f"gd-p{i+1}", x + pad, ty + 44,
                               w - pad * 2, h - (ty - y) - 50, body,
                               fontSize=14, align="left",
                               fx={"enter": "fade-up", "order": i}))
    return L, els


def _as_block(d: dict) -> Block:
    b = Block("item")
    b.fields.update({k: v for k, v in d.items() if isinstance(v, str)})
    return b


def build_matrix(tpl, s, ctx):
    L = tpl.lay("matrix")
    els = [tpl.element(L, "mx-panel"), tpl.element(L, "mx-axis-h"),
           tpl.element(L, "mx-axis-v")]
    for i, blk in enumerate(s.blocks[:4], 1):
        el = tpl.element(L, f"mx-c{i}")
        head = esc(blk.get("heading"))
        body = body_html(blk)
        el["html"] = f"<b>{head}</b><br>{body}" if body else f"<b>{head}</b>"
        els.append(el)
    els.extend(tpl.optional(L, "logo"))
    els.append(text_el(tpl, L, "mx-title", "mx-title", 56, 110, 467, 56,
                       esc(s.get("title"))))
    body = s.get("body")
    if body:
        els.append(text_el(tpl, L, "mx-body", "mx-body", 56, 220, 467, 380,
                           esc(body)))
    chrome(tpl, L, els, ctx["footer"])
    return L, els


def build_chart(tpl, s, ctx):
    L = tpl.lay("chart")
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "ch-title", "ch-title", 56, 88, 1000, 52,
                       esc(s.get("title"))))
    preset = s.get("preset", default="bar").lower()
    cats = [c.strip() for c in s.get("categories").split("|") if c.strip()]
    palette = ctx["theme"].get("chartPalette") or [ctx["theme"].get("accent")]
    note = s.get("note")
    w = 800 if note else 1168
    option: dict = {"color": palette,
                    "legend": {"show": len(s.series) > 1, "bottom": 0},
                    "grid": {"left": 60, "right": 24, "top": 30, "bottom": 60},
                    "textStyle": {"fontSize": 14}}
    if preset == "pie":
        name, vals = (s.series[0] if s.series else ("", []))
        option["series"] = [{"type": "pie", "name": name, "radius": ["38%", "68%"],
                             "data": [{"name": c, "value": v}
                                      for c, v in zip(cats, vals)],
                             "label": {"formatter": "{b} {d}%"}}]
        option.pop("grid")
    else:
        option["xAxis"] = {"type": "category", "data": cats}
        option["yAxis"] = {"type": "value"}
        option["series"] = [
            {"type": preset if preset in ("bar", "line") else "bar",
             "name": name, "data": vals,
             **({"smooth": True, "symbolSize": 6} if preset == "line" else
                {"itemStyle": {"borderRadius": 4}})}
            for name, vals in s.series]
    els.append({"id": "ch-main", "type": "chart", "x": 56, "y": 170,
                "w": w, "h": 420, "rotation": 0, "opacity": 1,
                "preset": preset if preset in ("bar", "line", "pie", "scatter") else "bar",
                "option": option})
    if note:
        els.append(text_el(tpl, L, "ch-side", "ch-side", 888, 190, 336, 400,
                           esc(note)))
    return L, els


TAG_ONLY = re.compile(r"^\s*(\[\[!?[^\]]+\]\]\s*)+$")


def cell_html(text: str) -> str:
    """A table cell: the usual inline markdown plus the table's chips —
    `cmd` is a command chip, [[Tag]] a soft tag, [[!Tag]] a filled one
    (render.ts cellChips styles them)."""
    out = esc(text)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\[\[!([^\]]+)\]\]", r"<mark><b>\1</b></mark>", out)
    out = re.sub(r"\[\[([^\]]+)\]\]", r"<mark>\1</mark>", out)
    return out


def table_cell(text: str, c: int, rows: list, r: int) -> dict:
    """A column holding nothing but tags is a tag column: right-aligned, like
    the template's."""
    cell = {"html": cell_html(text)}
    body = [row[c] for row in rows[1:] if row[c].strip()]
    if body and all(TAG_ONLY.match(v) for v in body):
        cell["align"] = "right"
    return cell


def build_table(tpl, s, ctx):
    """Title (+ optional supporting line) over a real `table` element.

    Geometry copies the template's own hand-built table slide ("14 · Table",
    ids tb-title / tb-sub / tb-table, the table flush with the title at x=56
    w=1128) rather
    than inventing its own, so a compiled table slide sits where the brand
    puts one — and shares ids with it, which is what lets the two morph.

    There is deliberately no `table` LAYOUT to instantiate: the template
    carries that pattern as a slide, not a layout, so the chrome is borrowed
    from the content layout and the rest is built here.
    """
    L = tpl.lay("content")
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "co-title", "tb-title", 56, 96, 1168, 56,
                       esc(s.get("title"))))
    rows = s.rows
    if not rows:
        return L, els
    # The framing line above the table, when the spec gives one. `subtitle` and
    # nothing else — an alias the parser doesn't have in KEYS would be read as
    # prose and glued onto the previous field.
    sub = s.get("subtitle")
    if sub:
        els.append(text_el(tpl, L, "co-body", "tb-sub", 56, 160, 1168, 32,
                           esc(sub), fontSize=16, color=tok("#5A6467"), lineHeight=1.5))
    ncol = max(len(r) for r in rows)
    rows = [r + [""] * (ncol - len(r)) for r in rows]

    weights = [float(x) for x in re.findall(r"[\d.]+", s.get("columns"))] \
        if s.get("columns") else []
    if len(weights) != ncol:
        # widest column of text gets proportionally more room
        avg = [max(1, sum(len(r[c]) for r in rows) / len(rows)) for c in range(ncol)]
        weights = [max(0.6, min(4.0, a / (sum(avg) / ncol))) for a in avg]

    # Template geometry: the table sits under the title (x=56, w=1128) and bottoms out at
    # 616, clear of the footer at 658. It starts under the supporting line when
    # there is one, and takes that space back when there isn't.
    top = 216 if sub else 190
    avail = 616 - top
    x, width = 56, 1128
    pad_x, table_w = 12, width - 24
    fs = 15

    def table_height(fs: int) -> float:
        pad_y = 10 if fs >= 14 else 7
        total = 0.0
        for r in rows:
            lines = 1
            for c, cell in enumerate(r):
                col_w = table_w * weights[c] / sum(weights) - 2 * pad_x
                per = max(1, int(col_w / (fs * 0.52)))
                lines = max(lines, math.ceil(max(1, len(cell)) / per))
            total += lines * fs * 1.35 + 2 * pad_y + 1
        return total

    while fs > 9 and table_height(fs) > avail:
        fs -= 1
    height = min(avail, math.ceil(table_height(fs)) + 4)

    style = dict(ctx["theme"].get("table", {}))
    style.setdefault("headerBg", ctx["theme"].get("accent", tok("#0F6B73")))
    style.setdefault("headerColor", "#FFFFFF")
    style["fontSize"] = fs
    style["cellPadX"] = pad_x
    style["cellPadY"] = 10 if fs >= 14 else 7
    els.append({
        "id": "tb-table", "type": "table", "x": x, "y": top,
        "w": width, "h": height, "rotation": 0, "opacity": 1, "header": True,
        "columns": [{"w": w} for w in weights],
        "rows": [{"cells": [table_cell(c, c_i, rows, r_i) for c_i, c in enumerate(r)]}
                 for r_i, r in enumerate(rows)],
        "style": style,
    })
    if s.get("note"):
        els.append(text_el(tpl, L, "co-body", "tb-note", x, top + height + 16,
                           width, 40, esc(s.get("note")), fontSize=14,
                           color=tok("#5A6467")))
    return L, els


# The app's own alphabet (slides/src/model.ts CODE_ALPHABET): no `s`, so a
# question code can never be mistaken for a session code, and no characters
# that get misread off a projector from the back of a room.
CODE_ALPHABET = "abcdefghjkmnpqrtuvwxy346789"

# The poll service's own ceiling for an `activity` page
# (server/poll-app/api/_lib.js MAX_ACTIVITY_HTML_CHARS). Generous for a compact
# single-file mini-app; a page over it is rejected at publish time, on stage.
MAX_ACTIVITY_HTML_CHARS = 60_000


def mint_poll_code(used: set[str]) -> str:
    """A fresh answer bucket, unique within this deck.

    This used to be a slug of the question text, which quietly broke any deck
    that asked two similar questions: "What is your biggest challenge?" and
    "What is your favourite tool?" both slugged to `whatisyo`, so the two
    slides shared one bucket — the second question showed the first one's
    answers, and a phone that had answered either was told it had answered
    both. Random and checked is the only version of this that cannot collide.
    """
    rng = random.SystemRandom()
    while True:
        code = "".join(rng.choice(CODE_ALPHABET) for _ in range(6))
        if code not in used:
            used.add(code)
            return code


HIVE_SLIDE = "poll-hive"     # template slide role: id sl-poll-hive or <...>-poll-hive


def _plays(slide_id: str, role: str) -> bool:
    """A template slide plays a role: id `sl-<role>` or ending `-<role>`."""
    return slide_id == "sl-" + role or slide_id.endswith("-" + role)


def hive_slide(tpl):
    """The template's one-slide open question: the live clustered hive, with
    its own poll underneath. None when the template has no such slide.
    `tpl.hive_override` supplies one from elsewhere (deck_build.py add-poll
    takes it from the template for a deck that has none)."""
    if getattr(tpl, "hive_override", None):
        return tpl.hive_override
    return next((sl for sl in tpl.doc.get("slides", []) if _plays(sl["id"], HIVE_SLIDE)
                 and any(e["type"] == "poll" for e in sl["elements"])), None)


def build_hive(tpl, s, ctx, hive):
    """An open question is ONE slide: the hive embed full-bleed, with the poll
    element hidden beneath it. The poll opens the question on the phones; the
    hive reads that bucket (the nearest poll at or before its own slide), shows
    the question, the join QR and every answer as it lands, and clusters them."""
    els = json.loads(json.dumps(hive["elements"]))
    for el in els:
        if el["type"] == "poll":
            el["question"] = s.get("question", "body", default="Your question")
            explicit = s.get("code")
            if explicit:
                el["code"] = explicit[:12].ljust(4, "0")
                ctx["poll_codes"].add(el["code"])
            else:
                el["code"] = mint_poll_code(ctx["poll_codes"])
            el["kind"] = "open"
            if s.get("requirename").strip().lower() in TRUTHY:
                el["requireName"] = True
        elif el["id"] == "footer":
            el["html"] = esc(ctx["footer"])
    return tpl.lay("poll"), els


MATRIX_SLIDE = "poll-matrix"  # template slide role: id sl-poll-matrix or <...>-poll-matrix
MATRIX_PAGE = "page-hive-matrix"
MATRIX_ASSETS = (MATRIX_PAGE, "img-hive-matrix-poster")


def parse_axes(spec) -> list[dict]:
    """`A | B ; C | D` (or a list of `A | B` strings) -> [{neg, pos, negDef, posDef}].
    A pole may carry a definition for the rater: `Automation = AI does it for me`."""
    parts = spec if isinstance(spec, (list, tuple)) else str(spec).split(";")
    axes = []
    for part in parts:
        if not str(part).strip():
            continue
        poles = [x.strip() for x in str(part).split("|")]
        if len(poles) != 2 or not all(poles):
            raise SystemExit(f"axes: '{part}' — expected 'Left | Right' (low pole | high pole)")
        (neg, nd), (pos, pd) = [(x.split("=", 1) + [""])[:2] for x in poles]
        axes.append({"neg": neg.strip()[:40], "pos": pos.strip()[:40],
                     "negDef": nd.strip()[:200], "posDef": pd.strip()[:200]})
    if not 1 <= len(axes) <= 2:
        raise SystemExit("axes: one or two axes (`A | B` or `A | B ; C | D`)")
    return axes


def parse_quads(spec) -> list[str]:
    q = [x.strip() for x in (spec if isinstance(spec, (list, tuple)) else str(spec).split("|")) if str(x).strip()]
    if q and len(q) != 4:
        raise SystemExit("quads: four names, top-left | top-right | bottom-left | bottom-right")
    return q


def matrix_page(page: str, axes: list[dict], quads: list[str] | None = None) -> str:
    """The hive-matrix page with this slide's axes (and quadrant names) written
    into its CONFIG. The page's `axes:` / `quads:` lines are the contract."""
    enc = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    page, n1 = re.subn(r"^  axes:\[.*\],$", lambda m: f"  axes:{enc(axes)},", page, count=1, flags=re.M)
    page, n2 = re.subn(r"^  quads:\[.*\],$", lambda m: f"  quads:{enc(quads or [])},", page, count=1, flags=re.M)
    if (n1, n2) != (1, 1):
        raise SystemExit("hive-matrix page: CONFIG `axes:` / `quads:` lines not found")
    return page


def matrix_slide(tpl):
    """The template's hive-matrix slide (poll hidden beneath the page), or None."""
    if getattr(tpl, "matrix_override", None):
        return tpl.matrix_override
    return next((sl for sl in tpl.doc.get("slides", []) if _plays(sl["id"], MATRIX_SLIDE)
                 and any(e["type"] == "poll" for e in sl["elements"])), None)


def apply_axes(doc: dict, slide: dict, axes: list[dict], quads: list[str] | None = None,
               base_page: str | None = None) -> str:
    """Give a hive-matrix slide its own page, `page-hive-matrix-<poll code>`, with
    these axes. The base is the page its embed shows now (or `base_page`).
    Returns the asset key."""
    em = next((e for e in slide["elements"] if e["type"] == "embed"
               and str(e.get("asset", "")).startswith(MATRIX_PAGE)), None)
    poll = next((e for e in slide["elements"] if e["type"] == "poll"), None)
    if not em or not poll:
        raise SystemExit(f"{slide['id']}: not a hive-matrix slide (no {MATRIX_PAGE}* embed + poll)")
    assets = doc.setdefault("assets", {})
    base = base_page or assets.get(em["asset"]) or assets.get(MATRIX_PAGE)
    if not base:
        raise SystemExit(f"{slide['id']}: the deck has no {MATRIX_PAGE} page to start from")
    key = f"{MATRIX_PAGE}-{poll['code']}"
    assets[key] = matrix_page(base, axes, quads)
    em["asset"] = key
    return key


def build_hive_matrix(tpl, s, ctx, matrix):
    """An open question on the presenter's axes: the hive slide's shape, with the
    hive-matrix page and this slide's axes written into its own copy of it."""
    layout, els = build_hive(tpl, s, ctx, matrix)
    doc = ctx["assets"].doc
    for k in MATRIX_ASSETS:
        if k not in doc.setdefault("assets", {}) and k in tpl.doc.get("assets", {}):
            doc["assets"][k] = tpl.doc["assets"][k]
    apply_axes(doc, {"id": "poll", "elements": els}, parse_axes(s.get("axes")),
               parse_quads(s.get("quads")) or None)
    return layout, els


def build_poll(tpl, s, ctx):
    L = tpl.lay("poll")
    kind = s.get("kind", default="open").strip().lower()
    if kind == "open" and s.get("axes").strip():
        matrix = matrix_slide(tpl)
        if not matrix:
            raise SystemExit(f"`axes:` needs a template with the sl-{MATRIX_SLIDE} slide ($TESSERA_TEMPLATE)")
        return build_hive_matrix(tpl, s, ctx, matrix)
    hive = hive_slide(tpl)
    if (kind == "open" and hive and s.get("hive").strip().lower() not in FALSEY
            and s.get("showjoin").strip().lower() not in FALSEY):
        return build_hive(tpl, s, ctx, hive)
    els = []
    chrome(tpl, L, els, ctx["footer"])
    els.append(text_el(tpl, L, "aq-kicker", "aq-kicker", 56, 88, 800, 34,
                       esc(s.get("kicker", "title", default="Audience question"))))
    poll = tpl.element(L, "aq-poll")
    poll["question"] = s.get("question", "body", default="Your question")
    # An explicit `code:` is honoured (it names an EXISTING bucket someone
    # wants to keep collecting into); everything else gets a fresh one.
    explicit = s.get("code")
    if explicit:
        poll["code"] = explicit[:12].ljust(4, "0")
        ctx["poll_codes"].add(poll["code"])
    else:
        poll["code"] = mint_poll_code(ctx["poll_codes"])
    poll["kind"] = kind
    if kind == "choice":
        poll["options"] = [o.strip() for o in s.get("options").split("|") if o.strip()]
    if kind == "rating":
        for key, field in (("min", "min"), ("max", "max")):
            raw = s.get(key)
            if raw.strip().lstrip("-").isdigit():
                poll[field] = int(raw.strip())
        for key, field in (("minlabel", "minLabel"), ("maxlabel", "maxLabel")):
            if s.get(key):
                poll[field] = s.get(key)
    # Ask for a name before answering. Off by default and deliberately so: a
    # name changes what people are willing to say, so it is per question.
    if s.get("requirename").strip().lower() in TRUTHY:
        poll["requireName"] = True
    # `showjoin: no` drops the QR, the address and the code. For a reveal slide
    # reading back a bucket the room filled earlier: it still counts and
    # summarizes, it just stops inviting an answer nobody should give twice.
    if s.get("showjoin").strip().lower() in FALSEY:
        poll["showJoin"] = False
    # `multi: yes` -- a choice question that takes several picks per phone.
    if kind == "choice" and s.get("multi").strip().lower() in TRUTHY:
        poll["multi"] = True
    if kind == "activity":
        # The deck ships a whole self-contained page to the phones. Stored the
        # same way an `embed` page is (verbatim in doc.assets, not base64) —
        # the service serves it to each phone into a sandboxed iframe.
        key = ctx["assets"].add_page(s.get("activity")) if s.get("activity") else None
        if key:
            poll["activityAsset"] = key
            size = len(ctx["assets"].doc["assets"][key])
            if size > MAX_ACTIVITY_HTML_CHARS:
                print(f"  ! activity page is {size} chars — the poll service "
                      f"refuses anything over {MAX_ACTIVITY_HTML_CHARS}")
        else:
            print("  ! activity poll has no `activity:` page — the phones will "
                  "show 'not ready yet'")
    if kind == "quiz":
        # One `###` sub-block per question: the heading is the question, the
        # bullets are the options, and a `*` in front of one marks the right
        # answer (first option if nobody marked any).
        questions = []
        for blk in s.blocks:
            opts, correct = [], 0
            for raw in blk.bullet_texts():
                text = raw.strip()
                if text.startswith("*"):
                    correct = len(opts)
                    text = text[1:].strip()
                opts.append(text)
            if blk.get("heading") and opts:
                questions.append({"q": blk.get("heading"), "options": opts,
                                  "correct": correct})
        poll["questions"] = questions
    els.append(poll)
    return L, els


def inline_font(doc: dict, html: str, family: str = "Manrope") -> str:
    """embed_font.py's rule at compile time: a page source declares
    `src:url(MANROPE)` and gets the deck's own text font (its Latin subset) as
    a data URI. A page that is already bundled has no placeholder left."""
    if "url(MANROPE)" not in html:
        return html
    store = doc.get("assets", {})
    fonts = sorted((f for f in doc.get("fonts", []) if f.get("family") == family
                    and store.get(f.get("asset"))), key=lambda f: "latin-ext" in f["asset"])
    if not fonts:
        print(f"  ! no {family} font in the template: url(MANROPE) left as it is")
        return html
    return html.replace("url(MANROPE)", f"url({store[fonts[0]['asset']]})")


def parse_texts(s) -> dict | None:
    """`texts: {"title": "…"}`: an embed's editable labels, one-line JSON."""
    if not s.get("texts"):
        return None
    try:
        texts = json.loads(s.get("texts"))
        if isinstance(texts, dict):
            return {str(k): str(v) for k, v in texts.items()}
    except json.JSONDecodeError:
        pass
    print('  ! texts: needs one-line JSON, e.g. {"title": "New title"}')
    return None


def build_game(tpl, s, ctx):
    """A whole game on ONE slide: a hidden `activity` poll (the phones get
    `phone:`) under a full-bleed embed of `screen:` (the room's view, with the
    lecturer's controls) that keeps the poll open while it shows and runs in
    the editor too. Logo only: a game's control bar sits where the footer and
    page number would. The same slide the per-game make_*.py scripts and
    engage/tools/make_game.py create, so a spec can carry it.

    The pages go in as they are (fill a CONFIG with make_game.py --build-only
    first); the screen gets the deck's font for its `url(MANROPE)`."""
    L = tpl.lay("content")
    assets = ctx["assets"]
    store = assets.doc.setdefault("assets", {})
    base = s.get("id") or Path(s.get("screen") or "game").stem
    slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")
    slug = re.sub(r"^q-", "", slug) or "game"

    def put(prefix: str, value: str) -> str:
        key, n = f"{prefix}-{slug}", 2
        while key in store and store[key] != value:   # another game, same name
            key, n = f"{prefix}-{slug}-{n}", n + 1
        store[key] = value
        return key

    def page(field: str) -> str | None:
        rel = s.get(field).strip()
        path = assets.resolve(rel) if rel else None
        if path is None:
            print(f"  ! game: {'missing' if rel else 'no'} `{field}:` page {rel}")
            return None
        return path.read_text(encoding="utf-8")

    screen, phone = page("screen"), page("phone")
    question = s.get("question", "title", default="Game")
    explicit = s.get("code").strip()
    if explicit:
        if not re.fullmatch(r"[a-z0-9]{4,12}", explicit):
            print(f"  ! game code {explicit!r} must match /^[a-z0-9]{{4,12}}$/")
        code = explicit
        ctx["poll_codes"].add(code)
    else:
        # Fresh on every compile: a recompile would orphan the room's answers.
        code = mint_poll_code(ctx["poll_codes"])
        print(f"  note: game {question!r} has no `code:`; minted {code} (pin it)")
    poll = {"id": "aq-poll", "type": "poll", "x": 72, "y": 150, "w": 400, "h": 400,
            "rotation": 0, "opacity": 0, "question": question, "code": code,
            "fontSize": 38, "color": tok("#1A2326"), "kind": "activity"}
    if phone is not None:
        if len(phone) > MAX_ACTIVITY_HTML_CHARS:
            print(f"  ! game phone page is {len(phone)} chars — the poll service "
                  f"refuses anything over {MAX_ACTIVITY_HTML_CHARS}")
        poll["activityAsset"] = put("activity", phone)
    if s.get("requirename", default="yes").strip().lower() not in FALSEY:
        poll["requireName"] = True
    el = {"id": "em-frame", "type": "embed", "x": 0, "y": 0, "w": 1280, "h": 720,
          "rotation": 0, "opacity": 1, "radius": 0}
    if screen is not None:
        el["asset"] = put("page", inline_font(assets.doc, screen))
    if s.get("poster"):
        pk = assets.add(s.get("poster"))
        if pk:
            el["poster"] = f"asset:{pk}"
    el["liveInEditor"] = True
    el["keepPollOpen"] = True
    texts = parse_texts(s)
    if texts:
        el["texts"] = texts
    els = [poll, el]
    chrome(tpl, L, els, ctx["footer"], want_footer=False, want_page=False)
    s.fields.setdefault("transition", "fade")
    s.fields.setdefault("background", "#FFFFFF")
    return L, els


BUILDERS = {
    "title": build_title, "cover": build_title,
    "section": build_section, "divider": build_section,
    "content": build_content, "bullets": build_content,
    "statement": build_statement, "quote": build_quote,
    "compare": build_compare, "comparison": build_compare,
    "points": build_points, "columns": build_points,
    "image": build_image, "gallery": build_gallery, "grid": build_grid,
    "matrix": build_matrix, "chart": build_chart, "table": build_table,
    "poll": build_poll, "game": build_game,
    "diagram": build_diagram, "figure": build_diagram,
    "embed": build_embed, "app": build_embed,
}


# ────────────────────────────────────────────────────────────────── compile

def expand_steps(s: Block) -> list[Block]:
    """A slide carrying `steps:` becomes one slide per `###` sub-block.

    This is how a PowerPoint click-build survives the conversion. The app has no
    reveal-on-click primitive inside a slide, so a build of N clicks becomes N
    consecutive slides that morph into each other: the arrow key drives the
    build exactly as the clicker did. Element ids are stable across the
    builders, so shared elements pair up and glide instead of blinking.

    One spec slide fans out to N -- the multiplication is deterministic and
    stays out of the editing pass.
    """
    if not s.get("steps") or not s.blocks:
        return [s]
    base_id = s.get("id") or "step"
    frames = []
    for i, blk in enumerate(s.blocks, 1):
        f = Block(s.kind)
        f.fields = dict(s.fields)
        f.fields.pop("steps", None)
        f.bullets, f.rows, f.series = s.bullets, s.rows, s.series
        f.blocks = []  # a frame is one figure, not a row of them
        # A `diagram` frame draws the sub-block's OWN shapes; a shape carried
        # over from the slide would be on every frame and never build.
        f.shapes = blk.shapes or s.shapes
        for k in STEP_KEYS:
            if blk.fields.get(k):
                f.fields[k] = blk.fields[k]
        f.fields["id"] = f"{base_id}-{i}"
        # first frame keeps the slide's own transition; the rest morph in
        f.fields["transition"] = "morph" if i > 1 else s.get(
            "transition", default="morph")
        frames.append(f)
    return frames


def _carry_over(doc: dict, out_path: Path) -> None:
    """What the editor holds that the spec does not: the deck's identity
    (`docId`), change requests typed in the editor (comments with
    request: true) and figure label edits (an embed's `texts`). A recompile
    keeps all three, matched by slide and element id, so rebuilding never loses
    someone's request or wording and the rebuilt file is still the same deck:
    tabs sync, and the bridge checks a save, by docId. (A previous build with
    no docId leaves none; the editor mints one on the next open.)"""
    if not out_path.exists():
        return
    m = DOC_RE.search(out_path.read_text(encoding="utf-8"))
    if not m:
        return
    try:
        old = json.loads(m.group(2))
    except json.JSONDecodeError:
        return
    if old.get("docId"):
        doc["docId"] = old["docId"]
    before ={s["id"]: s for s in old.get("slides", [])}
    kept = 0
    for s in doc["slides"]:
        prev = before.get(s["id"])
        if not prev:
            continue
        reqs = [c for c in prev.get("comments") or [] if c.get("request")]
        if reqs:
            have = {c.get("id") for c in s.get("comments") or []}
            s["comments"] = (s.get("comments") or []) + [c for c in reqs if c.get("id") not in have]
            kept += len(reqs)
        old_els = {e["id"]: e for e in prev.get("elements", [])}
        for e in s["elements"]:
            o = old_els.get(e["id"])
            if e.get("type") == "embed" and o and o.get("texts"):
                e["texts"] = {**o["texts"], **(e.get("texts") or {})}
                kept += 1
    # requests on slides the spec no longer has would vanish: say so
    ids = {s["id"] for s in doc["slides"]}
    gone = [c for sid, sl in before.items() if sid not in ids
            for c in sl.get("comments") or [] if c.get("request") and not c.get("resolved")]
    if gone:
        print(f"  ! {len(gone)} open request(s) were on slides this spec no longer has: "
              + "; ".join(c.get("text", "")[:60] for c in gone))
    if kept:
        print(f"  kept {kept} request thread(s)/figure text edit(s) from the previous build")


def compile_deck(spec_path: Path, tpl_path: Path, out_path: Path,
                 max_px: int = 1600, carry_from: Path | None = None) -> None:
    """`carry_from`: the previous build whose docId, requests and figure texts
    the new one keeps (default out_path; land.py compiles into a scratch file
    and carries from the real deck)."""
    carry_from = carry_from or out_path
    if any((p.parent / "build" / f"{p.name}.live-source.json").exists() for p in (out_path, carry_from)):
        raise SystemExit("Live editor is authoritative. Save it, reconcile the Markdown, disconnect agents, "
                         "then run agent_live.py reconcile <deck.html> --acknowledge before compiling.")
    meta, slides = parse_spec(spec_path.read_text(encoding="utf-8"))
    tpl = Template(tpl_path)

    doc = json.loads(json.dumps(tpl.doc))
    if not doc.pop("template", None):
        # Opening a template in the app CONSUMES `template: true` — that open
        # IS the instantiation. So a master template that has lost the flag was
        # opened and saved over at some point, and the next person to open it
        # gets a deck, not a fresh document. Harmless for this compile (the
        # identity strip below covers us) but worth saying once: the fix is
        # `slide.py template FILE` (the editor has no toggle any more).
        print(f"  note: {tpl_path.name} is not flagged `template: true` "
              f"(harmless here; `slide.py template {tpl_path}` restores it)")
    # A compiled deck is a NEW document, not a copy of the template's identity.
    #
    # The app does this itself when it opens a file carrying `template: true`
    # (parseDoc mints a fresh docId, remints every poll code and the session).
    # But a template that has been opened and saved in the app once has had
    # that flag CONSUMED — it is then an ordinary deck with a real docId and a
    # live session code, and cloning it verbatim is how two decks end up syncing
    # into each other (same-machine tabs sync by docId) and steering one
    # audience between them. Strip identity here so it cannot depend on the
    # state of the template. (`collab` is upstream's relay key: inert, dropped.)
    # A REbuild gets its own previous docId back in _carry_over.
    doc.pop("docId", None)
    doc.pop("collab", None)
    if isinstance(doc.get("poll"), dict) and doc["poll"].get("session"):
        # `s` + 6, matching slides/src/model.ts pollSessionCode: the prefix is
        # load-bearing (CODE_ALPHABET has no `s`, so the join page can tell a
        # session code from a question code with no round trip).
        doc["poll"]["session"] = "s" + "".join(
            random.SystemRandom().choice(CODE_ALPHABET) for _ in range(6))
    # A template that names no poll service takes the one in the .env
    # (TESSERA_POLL_SERVICE); one that names a service keeps it.
    if config.get("TESSERA_POLL_SERVICE") and not (doc.get("poll") or {}).get("service"):
        if not isinstance(doc.get("poll"), dict):
            doc["poll"] = {}
        doc["poll"]["service"] = config.get("TESSERA_POLL_SERVICE").rstrip("/")
    # The template's agentNotes carry an inventory of ITS slides, generated by
    # scripts/stamp-agent-notes.mjs. Drop those two generated notes
    # so a compiled deck never describes slides it does not have; the static
    # house rules stay. Re-stamp the compiled deck to get its own inventory.
    if isinstance(doc.get("agentNotes"), list):
        doc["agentNotes"] = [n for n in doc["agentNotes"]
                             if not str(n).startswith(("LAYOUTS IN THIS FILE",
                                                       "SLIDES IN THIS FILE"))]
    doc["title"] = meta.get("title", spec_path.stem)
    doc["meta"] = {k: meta.get(k, "") for k in
                   ("author", "company", "subject", "event", "keywords")
                   if meta.get(k)} or doc.get("meta", {})
    doc["slides"] = []

    # `media:` is a search root, not a prefix: `build/media/x.png` and a bare
    # `x.png` both resolve, so the spec can carry whichever is shorter.
    roots: list[Path] = []
    if meta.get("media"):
        cand = Path(meta["media"])
        if not cand.is_absolute():
            cand = spec_path.parent / cand
        if cand.is_dir():
            roots += [cand, cand.parent]
    _TMAP.clear(); _TMAP.update(deckio.theme_map(doc))
    ctx = {"assets": Assets(doc, spec_path.parent, max_px, roots),
           "theme": doc.get("theme", {}),
           "footer": meta.get("footer", ""),
           # Every answer bucket used so far, so two polls in one deck can
           # never end up sharing one (see mint_poll_code).
           "poll_codes": set()}

    used_ids: set[str] = set()
    slides = [step for s in slides for step in expand_steps(s)]
    for i, s in enumerate(slides, 1):
        builder = BUILDERS.get(s.kind)
        if not builder:
            print(f"  ! slide {i}: unknown type '{s.kind}', skipped")
            continue
        layout, els = builder(tpl, s, ctx)
        # A converted deck is full of source URLs and citations set in tiny type
        # at the foot of the slide. `chart` and `table` render `note:` themselves;
        # everywhere else it used to be parsed, accepted and then dropped, which
        # silently lost every attribution in the source deck.
        if s.get("note") and s.kind not in ("chart", "table"):
            # A layout without its own footer (quote) borrows the content one.
            try:
                tpl.style(layout, "footer", "role")
                note_layout = layout
            except KeyError:
                note_layout = tpl.lay("content")
            els.append(text_el(tpl, note_layout, "footer", f"note{i}",
                               56, 622, 1168, 30, esc(s.get("note")),
                               fontSize=11, align="left", valign="bottom",
                               color="#8A90A0"))
        sid = s.get("id") or f"s{i:02d}-{s.kind}"
        while sid in used_ids:
            sid += "x"
        used_ids.add(sid)
        slide = {
            "id": sid,
            "name": s.get("title", "heading", default=s.kind.title()),
            "background": s.get("background") or tpl.layouts[layout]["background"],
            # morph is the house default: shared chrome (logo, footer, page
            # number, same-id titles) glides and new content rises in
            "transition": s.get("transition", default="morph"),
            "notes": s.get("notes"),
            "elements": els,
        }
        doc["slides"].append(slide)

    # Read the previous build and write the new one under the deck's lock (the
    # file slide.py and the bridge's save take), so a file edit cannot land
    # between the carry-over read and the write and be lost.
    from slide import deck_lock
    with deck_lock(out_path):
        _carry_over(doc, carry_from)
        payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        payload = payload.replace("<", "\\u003c")
        out = DOC_RE.sub(lambda m: m.group(1) + payload + m.group(3), tpl.html, count=1)
        tmp = out_path.with_suffix(".compile.tmp")
        tmp.write_text(out, encoding="utf-8")
        tmp.replace(out_path)
    imgs = len(ctx["assets"].cache)
    print(f"wrote {out_path} — {len(doc['slides'])} slides, {imgs} images, "
          f"{out_path.stat().st_size/1e6:.1f} MB")


# ──────────────────────────────────────────────────────────────────── linting
#
# The spec format loses text SILENTLY in a couple of places — the compile
# succeeds, the deck opens, and a sentence is simply not on the slide. Those
# cost a full screenshot pass to find by eye, so find them here instead.

# Fields that only ever mean something on a SLIDE. Seeing one on a `###`
# sub-block means it was written below the line it belonged above.
SUB_KEYS = {"heading", "image", "fit", "caption", "body", "icon"}

# Roughly how much text each builder can show before it clips. The compiler
# shrinks type to fit but estimates glyph width slightly narrow, so a block at
# the boundary can still overflow. Numbers are plain characters.
BUDGET = {
    "content": ("each bullet", 150),
    "bullets": ("each bullet", 150),
    "compare": ("each column", 300),
    "comparison": ("each column", 300),
    "image": ("the body", 360),
    "gallery": ("the caption", 150),
    "points": ("the caption", 150),
    "columns": ("the caption", 150),
}


def check_spec(spec_path: Path) -> int:
    """Report everything suspicious about a spec. Returns the problem count."""
    raw = spec_path.read_text(encoding="utf-8")
    meta, slides = parse_spec(raw)
    lines = raw.replace("\r\n", "\n").split("\n")

    problems: list[str] = []
    notes: list[str] = []

    def where(i: int) -> str:
        return f"{spec_path.name}:{i + 1}"

    # --- line-level: the two traps the parser cannot recover from -------------
    in_sub = False
    prev_was_value = False        # previous line opened or continued a field
    seen_slide = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r"^##\s+[a-z]", stripped):
            in_sub, prev_was_value, seen_slide = False, False, True
            continue
        if not seen_slide or stripped.startswith("<!--"):
            continue
        if stripped.startswith("###"):
            in_sub, prev_was_value = True, False
            continue
        if not stripped:
            prev_was_value = False
            continue

        m = re.match(r"^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$", stripped)
        is_field = bool(m) and m.group(1).lower() in KEYS
        if is_field:
            key = m.group(1).lower()
            # A known key at the start of a wrapped value silently ends the
            # value it was continuing.
            if prev_was_value and line.startswith((" ", "\t")):
                problems.append(
                    f"{where(i)}: indented line starts with the known key "
                    f"`{key}:` — it ends the value above instead of continuing "
                    f"it. Reword so the line does not begin `{key}:`.")
            elif in_sub and key not in SUB_KEYS:
                problems.append(
                    f"{where(i)}: `{key}:` after a `###` attaches to the "
                    f"sub-block, not the slide. Move it above the first `###`.")
            prev_was_value = True
            continue
        if re.match(r"^\s*[-*]\s+", line):
            prev_was_value = False
            # A wrapped bullet is now joined rather than dropped, but say so —
            # a spec written against the old behaviour reads differently.
            if i + 1 < len(lines):
                nxt = lines[i + 1]
                ns = nxt.strip()
                if (ns and not ns.startswith(("#", "-", "*", "|", "<!--"))
                        and not (re.match(r"^([a-zA-Z][a-zA-Z0-9_-]*):", ns)
                                 and ns.split(":")[0].lower() in KEYS)):
                    notes.append(f"{where(i + 1)}: joined onto the bullet above.")
            continue
        prev_was_value = prev_was_value or bool(m)

    # --- slide-level ----------------------------------------------------------
    codes: dict[str, int] = {}
    for n, s in enumerate(slides, 1):
        tag = f"slide {n} (## {s.kind})"
        if s.kind not in BUILDERS:
            problems.append(f"{tag}: unknown type '{s.kind}' — it will be skipped.")
            continue
        if not s.get("notes"):
            notes.append(f"{tag}: no `notes:`.")

        # `body` set on a builder that never reads it is the classic symptom of
        # text having fallen out of a bullet or a field.
        if s.get("body") and s.kind not in (
                "statement", "matrix", "image", "compare", "comparison",
                "points", "columns", "grid", "poll", "quote"):
            problems.append(
                f"{tag}: has loose prose in `body`, which a `{s.kind}` slide "
                f"never renders: {s.get('body')[:60]!r}…")

        if s.kind in ("poll", "game"):
            code = s.get("code")
            if code:
                if not re.fullmatch(r"[a-z0-9]{4,12}", code):
                    problems.append(
                        f"{tag}: code {code!r} must match /^[a-z0-9]{{4,12}}$/.")
                if code in codes:
                    problems.append(
                        f"{tag}: code {code!r} is already used on slide "
                        f"{codes[code]} — they would share one answer bucket.")
                codes[code] = n
            if s.kind == "poll" and s.get("kind", default="open") == "activity" and not s.get("activity"):
                problems.append(f"{tag}: `kind: activity` with no `activity:` page.")
        if s.kind == "game":
            for key in ("screen", "phone"):
                if not s.get(key):
                    problems.append(f"{tag}: no `{key}:` page.")
            if not s.get("code"):
                notes.append(f"{tag}: no `code:` — every compile mints a new bucket; pin one.")

        # text budgets
        budget = BUDGET.get(s.kind)
        if budget:
            what, cap = budget
            over = []
            if s.kind in ("content", "bullets"):
                over = [b["text"] for b in s.bullets if plain_len(esc(b["text"])) > cap]
            elif s.kind in ("compare", "comparison"):
                over = [blk.get("heading") for blk in s.blocks
                        if plain_len(body_html(blk)) > cap]
            elif s.kind == "image":
                if plain_len(body_html(s)) > cap:
                    over = ["the body"]
            else:
                over = [blk.get("caption") for blk in s.blocks
                        if plain_len(esc(blk.get("caption"))) > cap]
            for item in over:
                problems.append(
                    f"{tag}: {what} is over ~{cap} characters and may clip: "
                    f"{str(item)[:50]!r}…")

    # --- referenced files -----------------------------------------------------
    roots = [spec_path.parent, Path.cwd()]
    if meta.get("media"):
        cand = Path(meta["media"])
        if not cand.is_absolute():
            cand = spec_path.parent / cand
        if cand.is_dir():
            roots += [cand, cand.parent]
    for n, s in enumerate(slides, 1):
        for blk in [s, *s.blocks]:
            for key in ("image", "page", "poster", "activity", "screen", "phone"):
                rel = blk.get(key)
                if not rel:
                    continue
                found = next((r / rel for r in roots if (r / rel).exists()), None)                     or (Path(rel) if Path(rel).exists() else None)
                if not found:
                    problems.append(f"slide {n}: `{key}: {rel}` not found.")
                elif key in ("activity", "phone"):
                    size = len(found.read_text(encoding="utf-8"))
                    if size > MAX_ACTIVITY_HTML_CHARS:
                        problems.append(f"slide {n}: `{key}: {rel}` is {size} characters; "
                                        f"the poll service refuses over {MAX_ACTIVITY_HTML_CHARS}.")

    for p in problems:
        print(f"  ! {p}")
    for note in notes:
        print(f"  · {note}")
    print(f"{spec_path.name}: {len(slides)} slides, "
          f"{len(problems)} problem{'' if len(problems) == 1 else 's'}, "
          f"{len(notes)} note{'' if len(notes) == 1 else 's'}")
    return len(problems)


def main() -> None:
    ap = argparse.ArgumentParser(description="Compile a slide-spec markdown file into an HTML deck.")
    ap.add_argument("spec")
    ap.add_argument("-t", "--template", default=None,
                    help="the template (default: $TESSERA_TEMPLATE, else template.html in the checkout)")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--max-px", type=int, default=1600,
                    help="long-edge cap for embedded images (0 = keep original)")
    ap.add_argument("--check", action="store_true",
                    help="lint the spec and exit — no compile, no template needed")
    ap.add_argument("--carry-from", default=None,
                    help="keep the docId, requests and figure texts of this previous build (default: the -o file)")
    args = ap.parse_args()
    spec = Path(args.spec)
    if args.check:
        raise SystemExit(1 if check_spec(spec) else 0)
    out = Path(args.out) if args.out else spec.with_suffix(".html")
    compile_deck(spec, Path(args.template) if args.template else config.template(), out, args.max_px,
                 Path(args.carry_from) if args.carry_from else None)


if __name__ == "__main__":
    main()
