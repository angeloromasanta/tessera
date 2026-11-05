"""Build the template's title face, Fraunces, as two small woff2 subsets.

    python scripts/brand-fonts/build_title_font.py Fraunces[SOFT,WONK,opsz,wght].ttf

The source is the variable TTF from the google/fonts repository
(https://github.com/google/fonts/tree/main/ofl/fraunces, SIL OFL 1.1, no
Reserved Font Name). This pins the decorative axes (SOFT 0, WONK 0) and the
optical size (opsz 72, a display cut that suits 20-60 px slide titles), keeps
weight variable over 300-700, and splits the result into the same two
unicode ranges as the Manrope files beside it:

    Fraunces-latin.woff2      -> doc.assets['title-font-latin']
    Fraunces-latin-ext.woff2  -> doc.assets['title-font-latin-ext']

Needs fontTools and brotli (pip install fonttools brotli).
"""
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = pathlib.Path(__file__).resolve().parent

# The same split as Manrope's two subsets (doc.fonts in template.html).
RANGES = {
    "latin": "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,"
             "U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,"
                 "U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,"
                 "U+2113,U+2C60-2C7F,U+A720-A7FF",
}
AXES = {"SOFT": 0, "WONK": 0, "opsz": 72, "wght": (300, 700)}


def unicodes(spec: str) -> list[int]:
    out = []
    for part in spec.split(","):
        part = part.strip().removeprefix("U+")
        lo, _, hi = part.partition("-")
        out.extend(range(int(lo, 16), int(hi or lo, 16) + 1))
    return out


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    font = TTFont(sys.argv[1])
    font = instancer.instantiateVariableFont(font, AXES, updateFontNames=False)
    tmp = HERE / "_fraunces-instance.ttf"
    font.save(tmp)
    try:
        for name, spec in RANGES.items():
            opts = subset.Options()
            opts.flavor = "woff2"
            opts.layout_features = ["*"]
            opts.name_IDs = ["*"]          # keep the copyright and licence records
            opts.name_languages = ["*"]
            f = TTFont(tmp)
            sub = subset.Subsetter(opts)
            sub.populate(unicodes=unicodes(spec))
            sub.subset(f)
            out = HERE / f"Fraunces-{name}.woff2"
            f.flavor = "woff2"
            f.save(out)
            print(f"wrote {out.name}  {out.stat().st_size:,} bytes")
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
