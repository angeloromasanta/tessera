#!/usr/bin/env python3
"""Turn an open-licence icon into a deck `path` element.

A deck has to stay self-contained, so there is nothing to "import" at
run time: no icon font, no CDN link, no <i class="..."> . What you can do is
paste an icon's vector data straight into a `path` element, which is better
anyway -- it takes the brand colour, it scales, and it stays editable in the
app like any other shape.

This script does the pasting. It fetches one icon, flattens whatever
primitives it is drawn with into a single `d`, and prints the element JSON.

    python icon.py lightbulb                       # -> one element, ready to splice
    python icon.py building-2 --x 56 --y 196 --size 40 --color "#FFFFFF"
    python icon.py globe --set lucide --stroke-width 1.8
    python icon.py layers building-2 globe --size 40    # several at once

Sets:
  lucide     (ISC)  ~1500 icons, stroke-drawn.  DEFAULT -- see note below.
  bootstrap  (MIT)  ~2000 icons, fill-drawn.
  tabler     (MIT)  ~5800 icons, stroke-drawn.

**Prefer a stroke set (lucide, tabler).** Every element of a stroke icon is an
open subpath, so concatenating them into one `d` renders exactly right. Filled
sets (bootstrap, heroicons) often rely on `fill-rule="evenodd"` per <path>, and
merging those subpaths into one nonzero path fills the holes -- a filled icon
with more than one <path> may come out solid. The script warns when it sees
this. If it does, use the stroke equivalent or keep only the subpath you want.

Names are the set's own file names, kebab-case: `building-2`, `chevron-right`,
`users-round`. Browse at lucide.dev/icons or tabler.io/icons.

Icons are cached under tools/.icon-cache/ so a deck can be rebuilt offline
once its icons have been fetched.
"""
import argparse, json, math, os, re, sys, urllib.request

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".icon-cache")

SETS = {
    "lucide":    ("https://cdn.jsdelivr.net/npm/lucide-static@0.469.0/icons/{}.svg", "stroke"),
    "tabler":    ("https://cdn.jsdelivr.net/npm/@tabler/icons@3.26.0/icons/outline/{}.svg", "stroke"),
    "bootstrap": ("https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons/{}.svg", "fill"),
}


def fetch(name, setname):
    url, _ = SETS[setname]
    path = os.path.join(CACHE, setname, name + ".svg")
    if os.path.exists(path):
        return open(path, encoding="utf-8").read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with urllib.request.urlopen(url.format(name), timeout=20) as r:
            svg = r.read().decode("utf-8")
    except Exception as e:
        sys.exit("could not fetch %s/%s: %s\n(check the name at lucide.dev/icons)" % (setname, name, e))
    open(path, "w", encoding="utf-8").write(svg)
    return svg


def _f(s):
    return float(s)


def flatten(svg):
    """Every drawable primitive -> one path `d` string. Returns (d, viewBox, n_paths)."""
    vb = re.search(r'viewBox="([\d.\-\s]+)"', svg)
    box = [float(v) for v in vb.group(1).split()] if vb else [0, 0, 24, 24]
    parts, npath = [], 0

    for d in re.findall(r"<path[^>]*\sd=\"([^\"]+)\"", svg):
        d = d.strip()
        # A subpath starting with a RELATIVE moveto is relative to (0,0) while it
        # is its own <path>, but to the previous subpath's end point once they are
        # concatenated -- which flings it off the canvas. Reset the current point
        # first. (Uppercasing the "m" is not equivalent: the implicit coordinate
        # pairs that follow a moveto inherit its case.)
        if d[:1] == "m":
            d = "M0 0 " + d
        parts.append(d)
        npath += 1

    for tag in re.findall(r"<circle[^>]*>", svg):
        a = dict(re.findall(r'(\w+)="([^"]+)"', tag))
        cx, cy, r = _f(a.get("cx", 0)), _f(a.get("cy", 0)), _f(a["r"])
        parts.append("M %g %g a %g %g 0 1 0 %g 0 a %g %g 0 1 0 %g 0"
                     % (cx - r, cy, r, r, 2 * r, r, r, -2 * r))

    for tag in re.findall(r"<ellipse[^>]*>", svg):
        a = dict(re.findall(r'(\w+)="([^"]+)"', tag))
        cx, cy = _f(a.get("cx", 0)), _f(a.get("cy", 0))
        rx, ry = _f(a["rx"]), _f(a["ry"])
        parts.append("M %g %g a %g %g 0 1 0 %g 0 a %g %g 0 1 0 %g 0"
                     % (cx - rx, cy, rx, ry, 2 * rx, rx, ry, -2 * rx))

    for tag in re.findall(r"<rect[^>]*>", svg):
        a = dict(re.findall(r'(\w+)="([^"]+)"', tag))
        x, y = _f(a.get("x", 0)), _f(a.get("y", 0))
        w, h = _f(a["width"]), _f(a["height"])
        rr = _f(a.get("rx", a.get("ry", 0)))
        if rr:
            parts.append("M %g %g h %g a %g %g 0 0 1 %g %g v %g a %g %g 0 0 1 %g %g h %g "
                         "a %g %g 0 0 1 %g %g v %g a %g %g 0 0 1 %g %g Z"
                         % (x + rr, y, w - 2 * rr, rr, rr, rr, rr, h - 2 * rr, rr, rr, -rr, rr,
                            -(w - 2 * rr), rr, rr, -rr, -rr, -(h - 2 * rr), rr, rr, rr, -rr))
        else:
            parts.append("M %g %g h %g v %g h %g Z" % (x, y, w, h, -w))

    for tag in re.findall(r"<line[^>]*>", svg):
        a = dict(re.findall(r'(\w+)="([^"]+)"', tag))
        parts.append("M %s %s L %s %s" % (a["x1"], a["y1"], a["x2"], a["y2"]))

    for tag, closed in [(t, False) for t in re.findall(r"<polyline[^>]*>", svg)] + \
                       [(t, True) for t in re.findall(r"<polygon[^>]*>", svg)]:
        a = dict(re.findall(r'(\w+)="([^"]+)"', tag))
        pts = re.findall(r"-?[\d.]+", a["points"])
        if len(pts) >= 4:
            d = "M %s %s" % (pts[0], pts[1])
            for i in range(2, len(pts) - 1, 2):
                d += " L %s %s" % (pts[i], pts[i + 1])
            parts.append(d + (" Z" if closed else ""))

    return " ".join(parts), box, npath


def element(name, setname, eid, x, y, size, color, sw):
    svg = fetch(name, setname)
    d, box, npath = flatten(svg)
    if not d:
        sys.exit("no drawable geometry in %s/%s" % (setname, name))
    kind = SETS[setname][1]
    if kind == "fill" and npath > 1:
        sys.stderr.write(
            "warning: %s/%s is a fill icon made of %d <path>s. Merged into one nonzero\n"
            "         path its holes may fill solid. Check the render, or use a stroke set.\n"
            % (setname, name, npath))
    el = {
        "id": eid or ("ic-" + re.sub(r"[^a-z0-9]+", "-", name.lower())),
        "type": "shape", "shape": "path",
        "x": x, "y": y, "w": size, "h": size,
        "rotation": 0, "opacity": 1,
        "fill": color if kind == "fill" else "transparent",
        "stroke": "transparent" if kind == "fill" else color,
        "strokeWidth": 0 if kind == "fill" else sw,
        "radius": 0,
        "d": d,
        "pathBox": box,
    }
    return el


def default_color():
    """The accent of the configured template (TESSERA_TEMPLATE), else of template.html."""
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    try:
        import config, deckio
        return deckio.load(config.template())["theme"]["accent"]
    except (Exception, SystemExit):
        try:
            import deckio
            return deckio.load(os.path.join(here, "..", "template.html"))["theme"]["accent"]
        except (Exception, SystemExit):
            return "#0F6B73"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="+", help="icon file name(s), kebab-case")
    ap.add_argument("--set", dest="setname", default="lucide", choices=sorted(SETS))
    ap.add_argument("--id", default=None, help="element id (single icon only)")
    ap.add_argument("--x", type=float, default=56)
    ap.add_argument("--y", type=float, default=196)
    ap.add_argument("--size", type=float, default=40, help="box side in slide px")
    ap.add_argument("--gap", type=float, default=64, help="x step when several names are given")
    ap.add_argument("--color", default=None, help="hex colour (default: the template accent)")
    ap.add_argument("--stroke-width", dest="sw", type=float, default=2.0,
                    help="in the icon's own 24-unit space, not slide px")
    a = ap.parse_args()
    a.color = a.color or default_color()

    out = [element(n, a.setname, a.id if len(a.name) == 1 else None,
                   a.x + i * a.gap, a.y, a.size, a.color, a.sw)
           for i, n in enumerate(a.name)]
    print(json.dumps(out[0] if len(out) == 1 else out, indent=1))


if __name__ == "__main__":
    main()
