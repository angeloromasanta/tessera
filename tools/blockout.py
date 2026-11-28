#!/usr/bin/env python3
"""Blockout: a figure's first draft as boxes and shapes, every state, in seconds.

Writes a valid click-stepped figure page (the starter's engine, verbatim) from a
short layout spec: each region of the figure as a plain dashed box, circle, chip
or line with a one-word label, at its real position in the real frame, entering
on the click it will enter on. The person watching the editor clicks through
the whole build as wireframes before any mark is styled, and a wrong layout is
caught while it is still cheap. A strip under the figure says, per state, what
that state will show (the `note` lines), and goes away when the figure is done.

The next pass refines THIS file, region by region: each region is one
`<!-- region: ID -->` group, so one Edit swaps its boxes for the real marks
(same ids, same data-edit keys) and the save lands live. The last pass runs
`blockout.py --strip FILE`, which removes the draft strip and the marker;
figcheck reports `draft` (an error) while either is still there.

Spec (one item per line, `#` comments; coordinates in viewBox units, 1280 wide,
480 high titled or 720 full-bleed; x y = top-left, w h = size):

  frame titled | full                      the frame (default titled, 1280x480)
  note N  what state N shows               one line per state, also --notes
  box    ID x y w h   [Label]   [@steps]   a card / region
  circle ID cx cy r   [Label]   [@steps]   a node
  chip   ID cx cy     [Label]   [@steps]   a rounded label chip
  text   ID x y       [Label]   [@steps]   a free label, centred on x
  row    ID x y w h   A|B|C     [@steps]   n equal boxes spread evenly (ids ID1..IDn)
  col    ID x y w h   A|B|C     [@steps]   n equal boxes stacked evenly
  grid   ID x y w h C A|B|C|D…  [@steps]   n boxes in C even columns
  arrow  ID FROM TO   [label]   [@steps]   edge-to-edge between two regions (draws on)
  line   ID x,y x,y … [label]   [@steps]   a polyline that draws itself
  curve  ID x,y x,y … [label]   [@steps]   the same, smoothed (a growth curve, a hype cycle)
  axis   ID x,y x,y   [label]              a frame line, always on (never fades)

  @steps:  @2  from state 2 on (default @1; state 0 stays empty)
           @2-4  states 2 to 4      @1,3  only those states
           @2+   a row/col/grid's items one per state: item k enters at 2+k
  A label in "quotes" may hold spaces; \\n splits it into lines (keys ID-1, ID-2).

  blockout.py SPEC -o build/figures/NAME.html [--root-from FIGURE.html] [--notes N.txt]
  blockout.py - -o …            the spec on stdin
  blockout.py --example         a spec to copy
  blockout.py --strip FILE      the figure is refined: drop the draft strip and marker
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shlex
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
STARTER = TOOLS.parent / "kit" / "figures" / "figure.html"
MARK = '<meta name="figure-draft" content="blockout">'
DRAFT_RE = re.compile(r"\n?/\* DRAFT-BEGIN.*?/\* DRAFT-END \*/\n?", re.S)
PLACEHOLDER_HINT = "an agent is building this figure"

EXAMPLE = """\
# a request travels to the model and back: 6 states
frame titled
note 0 Empty frame.
note 1 The person types a request.
note 2 The app wraps it with context and sends it.
note 3 The model answers.
note 4 The answer comes back through the app.
note 5 The app hands it to the person.
box    you    60 150 220 180  You             @1
box    app    470 110 340 260 "The app"       @2
row    ctx    500 260 280 80  Files|Mail|Web  @2     # @2+ would bring them one per click
circle model  1080 240 90     Model           @3
arrow  a1     you app         request         @2
arrow  a2     app model       prompt          @3
arrow  a3     model app       answer          @4
arrow  a4     app you         reply           @5
axis   base   60,440 1220,440
"""

BOX = "fill:var(--tint);stroke:var(--faint);stroke-width:2;stroke-dasharray:7 6"
LINE = "fill:none;stroke:var(--accent);stroke-width:3"


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def parse_steps(tok: str | None, family: int = 1) -> list[list[int] | tuple]:
    """Per item: a list of explicit states, or ('from', n) / ('range', a, b)."""
    tok = (tok or "@1")[1:]
    if tok.endswith("+"):
        a = int(tok[:-1])
        return [("from", a + k) for k in range(family)]
    if "-" in tok:
        a, b = (int(v) for v in tok.split("-"))
        one: list | tuple = ("range", a, b)
    elif "," in tok:
        one = [int(v) for v in tok.split(",")]
    else:
        one = ("from", int(tok))
    return [one] * family


def visible(spec, k: int, last: int) -> bool:
    if isinstance(spec, list):
        return k in spec
    if spec[0] == "from":
        return spec[1] <= k <= last
    return spec[1] <= k <= spec[2]


def top_state(spec) -> int:
    if isinstance(spec, list):
        return max(spec)
    return spec[1] if spec[0] == "from" else spec[2]


def text_lines(key: str, label: str, x: float, y: float, cls: str = "lbl") -> str:
    lines = label.replace("\\n", "\n").split("\n")
    if len(lines) == 1:
        return (f'<text class="{cls}" data-edit="{key}" x="{x:.0f}" y="{y + 7:.0f}" '
                f'text-anchor="middle">{esc(lines[0])}</text>')
    y0 = y - (len(lines) - 1) * 12 + 7
    spans = "".join(f'<tspan data-edit="{key}-{i + 1}" x="{x:.0f}" y="{y0 + i * 24:.0f}">'
                    f"{esc(t)}</tspan>" for i, t in enumerate(lines))
    return f'<text class="{cls}" text-anchor="middle">{spans}</text>'


def pts(tokens: list[str]) -> tuple[list[tuple[float, float]], list[str]]:
    p, rest = [], []
    for t in tokens:
        m = re.fullmatch(r"(-?[\d.]+),(-?[\d.]+)", t)
        (p.append((float(m[1]), float(m[2]))) if m else rest.append(t))
    return p, rest


def smooth(p: list[tuple[float, float]]) -> str:
    """Catmull-Rom through the points, as cubic Beziers."""
    if len(p) < 3:
        return "M" + " L".join(f"{x:.0f},{y:.0f}" for x, y in p)
    d = f"M{p[0][0]:.0f},{p[0][1]:.0f}"
    for i in range(len(p) - 1):
        p0, p1, p2 = p[max(i - 1, 0)], p[i], p[i + 1]
        p3 = p[min(i + 2, len(p) - 1)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.0f},{c1[1]:.0f} {c2[0]:.0f},{c2[1]:.0f} {p2[0]:.0f},{p2[1]:.0f}"
    return d


def edge(shape: dict, tx: float, ty: float, gap: float = 10) -> tuple[float, float]:
    """Where the line from the shape's centre towards (tx, ty) leaves the shape."""
    cx, cy = shape["c"]
    dx, dy = tx - cx, ty - cy
    n = math.hypot(dx, dy) or 1
    if shape["kind"] == "circle":
        r = shape["r"] + gap
        return cx + dx / n * r, cy + dy / n * r
    hw, hh = shape["w"] / 2 + gap, shape["h"] / 2 + gap
    t = min(hw / abs(dx) if dx else math.inf, hh / abs(dy) if dy else math.inf)
    return cx + dx * t, cy + dy * t


class Blockout:
    def __init__(self) -> None:
        self.full = False
        self.notes: dict[int, str] = {}
        self.links: list[str] = []
        self.shapes: list[str] = []
        self.labels: list[str] = []
        self.geom: dict[str, dict] = {}
        self.marks: list[tuple[str, object]] = []    # (element id, visibility)
        self.arrows: list[tuple] = []

    def add_mark(self, mid: str, vis, delay: int = 0) -> str:
        self.marks.append((mid, vis))
        return f' style="transition-delay:{delay}ms"' if delay else ""

    def region(self, rid: str, inner: str, vis, cls: str = "rise", delay: int = 0) -> None:
        st = self.add_mark(rid, vis, delay)
        self.shapes.append(f'<!-- region: {rid} -->\n      <g class="el {cls}" id="{rid}"{st}>'
                           f"{inner}</g>")

    def boxes(self, rid: str, x, y, w, h, labels, steps, layout: str, cols: int = 0) -> None:
        n = len(labels)
        gap = 20
        vis = parse_steps(steps, n)
        stagger = not (steps or "").endswith("+")
        if layout == "row":
            cols, rows = n, 1
        elif layout == "col":
            cols, rows = 1, n
        else:
            rows = math.ceil(n / cols)
        bw = (w - gap * (cols - 1)) / cols
        bh = (h - gap * (rows - 1)) / rows
        for k, lab in enumerate(labels):
            r, c = divmod(k, cols)
            bx, by = x + c * (bw + gap), y + r * (bh + gap)
            self.box(f"{rid}{k + 1}", bx, by, bw, bh, lab, vis[k], delay=60 * k if stagger else 0)

    def box(self, rid, x, y, w, h, label, vis, delay=0) -> None:
        inner = (f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" rx="8" '
                 f'style="{BOX}"/>')
        if label:
            inner += text_lines(rid, label, x + w / 2, y + h / 2)
        self.geom[rid] = {"kind": "rect", "c": (x + w / 2, y + h / 2), "w": w, "h": h}
        self.region(rid, inner, vis, delay=delay)

    def line(self, tokens: list[str]) -> None:
        kind, rid, rest = tokens[0], tokens[1], tokens[2:]
        steps = next((t for t in rest if t.startswith("@")), None)
        rest = [t for t in rest if not t.startswith("@")]
        num = lambda i: float(rest[i])
        if kind == "frame":
            self.full = rid == "full"
        elif kind == "note":
            self.notes[int(rid)] = " ".join(rest)
        elif kind == "box":
            self.box(rid, num(0), num(1), num(2), num(3), " ".join(rest[4:]),
                     parse_steps(steps)[0])
        elif kind == "circle":
            cx, cy, r = num(0), num(1), num(2)
            inner = (f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" style="{BOX}"/>'
                     + (text_lines(rid, " ".join(rest[3:]), cx, cy) if rest[3:] else ""))
            self.geom[rid] = {"kind": "circle", "c": (cx, cy), "r": r}
            self.region(rid, inner, parse_steps(steps)[0], cls="pop")
        elif kind == "chip":
            cx, cy, lab = num(0), num(1), " ".join(rest[2:]) or rid
            w, h = max(60, 11.5 * len(lab) + 28), 38
            inner = (f'<rect x="{cx - w / 2:.0f}" y="{cy - h / 2:.0f}" width="{w:.0f}" '
                     f'height="{h}" rx="19" style="fill:#fff;stroke:var(--accent);stroke-width:2"/>'
                     + text_lines(rid, lab, cx, cy))
            self.geom[rid] = {"kind": "rect", "c": (cx, cy), "w": w, "h": h}
            self.region(rid, inner, parse_steps(steps)[0], cls="pop")
        elif kind == "text":
            x, y, lab = num(0), num(1), " ".join(rest[2:]) or rid
            st = self.add_mark(rid, parse_steps(steps)[0])
            t = text_lines(rid, lab, x, y).replace("<text ", f'<text id="{rid}"{st} ', 1)
            self.labels.append(t.replace('class="lbl"', 'class="el rise lbl"', 1))
            self.geom[rid] = {"kind": "rect", "c": (x, y), "w": 11 * len(lab), "h": 30}
        elif kind in ("row", "col", "grid"):
            if kind == "grid":
                cols, labels = int(rest[4]), rest[5]
            else:
                cols, labels = 0, rest[4]
            self.boxes(rid, num(0), num(1), num(2), num(3),
                       labels.split("|"), steps, kind, cols)
        elif kind == "arrow":
            self.arrows.append((rid, rest[0], rest[1], " ".join(rest[2:]),
                                parse_steps(steps)[0]))
        elif kind in ("line", "curve", "axis"):
            p, words = pts(rest)
            if len(p) < 2:
                raise ValueError(f"{kind} {rid}: needs two x,y points or more")
            d = smooth(p) if kind == "curve" else "M" + " L".join(f"{x:.0f},{y:.0f}" for x, y in p)
            if kind == "axis":
                self.links.append(f'<path id="{rid}" d="{d}" style="fill:none;stroke:var(--line)" '
                                  f'stroke-width="2"/>')
                if words:
                    x, y = p[-1]
                    self.labels.append(f'<text class="axis" data-edit="{rid}" x="{x:.0f}" '
                                       f'y="{y + 30:.0f}" text-anchor="end">{esc(" ".join(words))}</text>')
                return
            vis = parse_steps(steps)[0]
            self.add_mark(rid, vis)
            self.links.append(f'<path class="el draw" id="{rid}" d="{d}" style="{LINE}" '
                              f'stroke-width="4" stroke-linecap="round"/>')
            if words:
                x, y = p[-1]
                self.label_mark(f"{rid}-l", rid, " ".join(words), x, y - 22, vis)
        else:
            raise ValueError(f"unknown item '{kind}'")

    def label_mark(self, mid, key, text, x, y, vis) -> None:
        st = self.add_mark(mid, vis)
        self.labels.append(f'<text class="el rise sub" id="{mid}" data-edit="{key}"{st} '
                           f'x="{x:.0f}" y="{y:.0f}" text-anchor="middle" '
                           f'style="paint-order:stroke;stroke:#fff;stroke-width:6">{esc(text)}</text>')

    def finish_arrows(self) -> None:
        pairs: dict[frozenset, list] = {}
        for ar in self.arrows:
            pairs.setdefault(frozenset(ar[1:3]), []).append(ar[0])
        for rid, a, b, lab, vis in self.arrows:
            for end in (a, b):
                if end not in self.geom:
                    raise ValueError(f"arrow {rid}: no region '{end}' (arrows name boxes, "
                                     "circles, chips or row items such as ctx2)")
            ga, gb = self.geom[a], self.geom[b]
            x1, y1 = edge(ga, *gb["c"])
            x2, y2 = edge(gb, *ga["c"])
            # two arrows between the same regions run side by side, labels outside
            same = pairs[frozenset((a, b))]
            off = (same.index(rid) - (len(same) - 1) / 2) * 30
            (ax, ay), (bx, by) = sorted([ga["c"], gb["c"]])
            n = math.hypot(bx - ax, by - ay) or 1
            nx, ny = -(by - ay) / n, (bx - ax) / n          # one normal for the pair
            if ny > 0:
                nx, ny = -nx, -ny                            # pointing up the screen
            x1, y1, x2, y2 = x1 + nx * off, y1 + ny * off, x2 + nx * off, y2 + ny * off
            self.add_mark(rid, vis)
            self.links.append(f'<path class="el draw" id="{rid}" d="M{x1:.0f},{y1:.0f} '
                              f'L{x2:.0f},{y2:.0f}" style="{LINE}" marker-end="url(#ar)"/>')
            if lab:
                side = 1 if off >= 0 else -1
                lx = (x1 + x2) / 2 + nx * 16 * side
                ly = (y1 + y2) / 2 + ny * 16 * side + (5 if side > 0 else 12)
                self.label_mark(f"{rid}-l", rid, lab, lx, ly, vis)

    def states(self) -> int:
        top = max([top_state(v) for _, v in self.marks] + list(self.notes) + [1])
        return top + 1

    def steps_js(self) -> str:
        n = self.states()
        out = []
        for k in range(n):
            ids = [m for m, v in self.marks if visible(v, k, n - 1)]
            out.append("  { on: [" + ", ".join(f'"{i}"' for i in ids) + "], cam: FULL },")
        return "const steps = [\n" + "\n".join(out) + "\n];"

    def draft_js(self) -> str:
        n = self.states()
        notes = [self.notes.get(k, "") for k in range(n)]
        arr = ",\n  ".join(json.dumps(t, ensure_ascii=False).replace("</", "<\\/") for t in notes)
        return (
            "/* DRAFT-BEGIN: the blockout's state notes, shown under the figure while it is\n"
            "   a draft. Delete this block (blockout.py --strip) once the figure is refined. */\n"
            f"const DRAFT_NOTES = [\n  {arr}\n];\n"
            "(() => {\n"
            "  const n = document.createElement('div');\n"
            "  n.style.cssText = 'flex:1;text-align:center;font-size:14px;font-weight:600;color:var(--accent)';\n"
            "  document.getElementById('bar').insertBefore(n, document.getElementById('hint'));\n"
            "  steps.forEach((s, k) => { const d = s.do; s.do = x => { if (d) d(x);\n"
            "    n.textContent = `draft \\u00b7 state ${k} of ${steps.length - 1} \\u00b7 ${DRAFT_NOTES[k] || ''}`; }; });\n"
            "})();\n"
            "/* DRAFT-END */\n")


def build(spec: str, name: str, root_from: Path | None) -> tuple[str, Blockout]:
    bo = Blockout()
    for no, raw in enumerate(spec.splitlines(), 1):
        line = raw.split(" #", 1)[0].strip() if not raw.lstrip().startswith("#") else ""
        if not line:
            continue
        try:
            toks = shlex.split(line, posix=True)
            if len(toks) < 2:
                raise ValueError("too short")
            bo.line(toks)
        except (ValueError, IndexError) as e:
            raise SystemExit(f"spec line {no}: {raw.strip()}\n  {e}")
    try:
        bo.finish_arrows()
    except ValueError as e:
        raise SystemExit(f"spec: {e}")
    if not bo.marks:
        raise SystemExit("spec: no marks")

    h = 720 if bo.full else 480
    page = STARTER.read_text(encoding="utf-8")
    if root_from:
        m = re.search(r":root\s*\{.*?\}", root_from.read_text(encoding="utf-8"), re.S)
        if not m:
            raise SystemExit(f"{root_from}: no :root{{…}} block")
        page = re.sub(r":root\s*\{.*?\}", lambda _: m[0], page, count=1, flags=re.S)
    page = page.replace("<title>FIGURE TITLE</title>", f"<title>{esc(name)}</title>\n{MARK}", 1)
    page = page.replace('viewBox="0 0 1280 480"', f'viewBox="0 0 1280 {h}"', 1)
    page = page.replace("const VBW = 1280, VBH = 480;", f"const VBW = 1280, VBH = {h};", 1)
    for layer, items in (("links", bo.links), ("shapes", bo.shapes), ("labels", bo.labels)):
        body = "".join(f"\n      {i}" for i in items) + "\n    "
        page, k = re.subn(rf'(<g id="{layer}">).*?(</g>)', lambda m: m[1] + body + m[2],
                          page, count=1, flags=re.S)
        if not k:
            raise SystemExit(f"starter changed: no <g id=\"{layer}\"> in {STARTER}")
    page = re.sub(r"\npill\('t1'.*\n", "\n", page, count=1)
    page, k = re.subn(r"const steps = \[.*?\n\];", lambda _: bo.steps_js(), page, count=1, flags=re.S)
    if not k:
        raise SystemExit(f"starter changed: no steps array in {STARTER}")
    page = page.replace("/* ---- engine", bo.draft_js() + "\n/* ---- engine", 1)
    return page, bo


def may_overwrite(out: Path) -> bool:
    if not out.exists():
        return True
    s = out.read_text(encoding="utf-8", errors="replace")
    return (MARK in s or PLACEHOLDER_HINT in s or len(s) < 2000
            or s.replace("\r", "") == STARTER.read_text(encoding="utf-8").replace("\r", ""))


def strip(path: Path) -> int:
    s = path.read_text(encoding="utf-8")
    t = DRAFT_RE.sub("\n", s.replace(MARK + "\n", "").replace(MARK, ""))
    if t == s:
        print(f"{path.name}: no draft marker or strip, nothing to do")
        return 0
    path.write_text(t, encoding="utf-8", newline="")
    print(f"{path.name}: draft strip and marker removed; run figcheck")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", nargs="?", help="the layout spec file, or - for stdin")
    ap.add_argument("-o", "--out", help="the figure source to write (build/figures/NAME.html)")
    ap.add_argument("--root-from", type=Path,
                    help="copy the :root palette block from this file (a figure of the same deck)")
    ap.add_argument("--notes", type=Path, help="also write the note lines, one per state")
    ap.add_argument("--force", action="store_true",
                    help="overwrite a figure that is already past its blockout (loses that work)")
    ap.add_argument("--example", action="store_true", help="print an example spec")
    ap.add_argument("--strip", type=Path, metavar="FILE", help="remove the draft strip and marker")
    a = ap.parse_args()
    if a.example:
        print(EXAMPLE, end="")
        return 0
    if a.strip:
        return strip(a.strip)
    if not a.spec or not a.out:
        ap.error("give SPEC and -o OUT (or --example / --strip FILE)")
    out = Path(a.out)
    if not a.force and not may_overwrite(out):
        raise SystemExit(f"{out}: already refined past its blockout; refine it with Edits "
                         "(or --force to start over, which throws that work away)")
    spec = sys.stdin.read() if a.spec == "-" else Path(a.spec).read_text(encoding="utf-8")
    page, bo = build(spec, out.stem, a.root_from)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8", newline="\n")
    n = bo.states()
    if a.notes:
        a.notes.write_text("\n".join(bo.notes.get(k, "") for k in range(n)) + "\n", encoding="utf-8")
    regions = len(bo.shapes)
    print(f"{out}: blockout, {n} states ({n - 1} clicks), {regions} regions, "
          f"{len(bo.marks)} marks, {'1280x720 full-bleed' if bo.full else '1280x480 titled'}")
    missing = [k for k in range(n) if k not in bo.notes]
    if missing:
        print(f"  no note for state(s) {', '.join(map(str, missing))}")
    print("  next: refine region by region (one Edit per <!-- region --> group, save each); "
          "finally blockout.py --strip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
