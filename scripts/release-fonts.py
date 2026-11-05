"""Licence check for every font the release ships, loose or embedded in an HTML file.

    python scripts/release-fonts.py FILE...     (called by release-check.mjs)

A font passes when its name table carries an open licence (SIL OFL, Apache,
MIT, Ubuntu Font Licence) in the licence description (name ID 13) or URL (14).
Embedded fonts are found as base64 runs whose decoded bytes start with a font
signature. Prints one line per failing font; prints nothing when all pass.
"""
import base64
import io
import re
import sys

try:
    from fontTools.ttLib import TTFont
except ImportError:
    print("fontTools missing: python -m pip install fonttools brotli")
    sys.exit(1)

OPEN = re.compile(r"open font licen[cs]e|scripts\.sil\.org/OFL|openfontlicense|apache licen[cs]e|"
                  r"\bMIT\b|ubuntu font licen[cs]e", re.I)
SIGS = (b"wOF2", b"wOFF", b"\x00\x01\x00\x00", b"OTTO", b"true")
B64 = re.compile(rb"[A-Za-z0-9+/]{2000,}={0,2}")


def verdict(data, where):
    try:
        font = TTFont(io.BytesIO(data), lazy=True)
        names = font["name"]
    except Exception as e:  # not a font after all, or unreadable
        return None
    def get(i):
        r = names.getName(i, 3, 1, 0x409) or names.getName(i, 1, 0, 0)
        return str(r) if r else ""
    fam = get(1) or "?"
    lic = get(13) + " " + get(14)
    if OPEN.search(lic):
        return None
    return f"{where}: font '{fam}' has no open licence in its name table ({get(0)[:90]!r})"


def main(paths):
    bad = []
    for p in paths:
        try:
            raw = open(p, "rb").read()
        except OSError:
            continue
        if raw[:4] in SIGS:
            v = verdict(raw, p)
            if v:
                bad.append(v)
            continue
        for m in B64.finditer(raw):
            blob = m.group(0)
            try:
                head = base64.b64decode(blob[:8], validate=False)
            except Exception:
                continue
            if head[:4] not in SIGS:
                continue
            try:
                data = base64.b64decode(blob + b"=" * (-len(blob) % 4))
            except Exception:
                continue
            v = verdict(data, f"{p} @{m.start()}")
            if v:
                bad.append(v)
    print("\n".join(bad))


if __name__ == "__main__":
    main(sys.argv[1:])
