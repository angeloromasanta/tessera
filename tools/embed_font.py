"""Build a figure page from its source, with the deck's text font inlined.

A figure source declares `@font-face{font-family:Manrope;...src:url(MANROPE)...}`
and never carries the font itself, so it stays small enough to read and edit.
This writes the page the deck embeds, with the deck's own text-font asset (the
woff2 in doc.assets whose doc.fonts family is not the heading font) swapped in
as a data URI, so the figure matches the slides and stays self-contained.

    python embed_font.py SRC.html --deck deck.html [-o OUT.html]

OUT defaults to <src dir>/../fig-<src name>.html, i.e. build/figures/x.html ->
build/fig-x.html. Re-run after every edit to the source; edit the source only.
"""
import argparse, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deckio  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("src", nargs="+")
ap.add_argument("--deck", required=True, help="compiled deck whose text font to inline")
ap.add_argument("--family", default="Manrope", help="font family to take from the deck")
ap.add_argument("-o", "--out", help="output file (single source only)")
a = ap.parse_args()

deck = pathlib.Path(a.deck).read_text(encoding="utf-8")
doc = deckio.read(deck)
fonts = [f for f in doc.get("fonts", []) if f.get("family") == a.family]
if not fonts:
    sys.exit(f"no {a.family} font in {a.deck}; families: {sorted({f.get('family') for f in doc.get('fonts', [])})}")
# the Latin subset first: that is the one figure text needs
fonts.sort(key=lambda f: "latin-ext" in f["asset"])
uri = doc["assets"][fonts[0]["asset"]]

for s in a.src:
    src = pathlib.Path(s)
    text = src.read_text(encoding="utf-8")
    if "url(MANROPE)" not in text:
        print(f"skip {src.name}: no url(MANROPE) placeholder", file=sys.stderr)
        continue
    out = pathlib.Path(a.out) if a.out else src.parent.parent / f"fig-{src.stem}.html"
    out.write_text(text.replace("url(MANROPE)", f"url({uri})"), encoding="utf-8")
    print("wrote", out)
