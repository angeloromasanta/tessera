"""Write the SIL OFL licence records into the Manrope subsets' name table.

    python scripts/brand-fonts/add_licence_names.py

The Manrope woff2 files here came from a web-font subset that dropped the
licence description (name ID 13) and licence URL (name ID 14); only the
copyright line survived. The OFL asks that the licence travel with the font,
and a deck carries its fonts inside it, so this puts both records back.
Idempotent; changes nothing else in the font.
"""
import pathlib

from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).resolve().parent
DESC = ("This Font Software is licensed under the SIL Open Font License, Version 1.1. "
        "This license is available with a FAQ at: https://openfontlicense.org")
URL = "https://openfontlicense.org"

for name in ("Manrope-latin.woff2", "Manrope-latin-ext.woff2"):
    path = HERE / name
    f = TTFont(path)
    table = f["name"]
    if table.getDebugName(13) == DESC and table.getDebugName(14) == URL:
        print(f"{name}: licence already there")
        continue
    table.setName(DESC, 13, 3, 1, 0x409)
    table.setName(URL, 14, 3, 1, 0x409)
    f.flavor = "woff2"
    f.save(path)
    print(f"{name}: licence added ({path.stat().st_size:,} bytes)")
