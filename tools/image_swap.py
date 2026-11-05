#!/usr/bin/env python3
"""Replace a picture inside a compiled deck, in place.

    python image_swap.py deck.html img-network=build/media/network.jpg img-build=build/media/build.jpg

Each pair is <asset key>=<file>. The asset's data URI in the deck's
document JSON block is replaced and nothing else in the file is touched,
so a deck edited by hand in the app keeps every edit. The file is
re-encoded as JPEG (quality 85) and downscaled to --max-width (default 1600)
so the deck does not grow with every swap; pass --png to keep transparency.

Keys are listed by `slide.py info deck.html --section assets` (deck), or
by this tool with no pairs. A backup goes to the deck's build/backups/.
"""
import argparse
import base64
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deckio  # noqa: E402

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("pip install Pillow")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BLOCK = deckio.DOC_RE


def encode(path: Path, max_width: int, png: bool) -> str:
    im = Image.open(path)
    if im.width > max_width:
        im.thumbnail((max_width, max_width * 10))
    buf = io.BytesIO()
    if png:
        im.save(buf, "PNG", optimize=True)
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    im.convert("RGB").save(buf, "JPEG", quality=85, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deck")
    ap.add_argument("pairs", nargs="*", help="<asset key>=<image file>")
    ap.add_argument("--max-width", type=int, default=1600)
    ap.add_argument("--png", action="store_true", help="embed as PNG (keeps transparency)")
    a = ap.parse_args()

    deck = Path(a.deck)
    text = deck.read_text(encoding="utf-8")
    m = BLOCK.search(text)
    if not m:
        sys.exit(f"no #{deckio.DOC_ID} block found")
    doc = json.loads(m.group(2))
    assets = doc.setdefault("assets", {})
    images = {k: v[:22] for k, v in assets.items() if isinstance(v, str) and v.startswith("data:image")}

    if not a.pairs:
        for k, v in images.items():
            print(f"{k:<28} {v}")
        return

    for pair in a.pairs:
        key, _, file = pair.partition("=")
        if key not in assets:
            sys.exit(f"asset '{key}' is not in the deck; keys: {', '.join(images)}")
        assets[key] = encode(Path(file), a.max_width, a.png)
        print(f"{key} <- {file} ({len(assets[key]) // 1024} KB)")

    guard = deck.parent / "build" / f"{deck.name}.live-source.json"
    if guard.exists():
        # The open editor owns the file: send the new assets as patches.
        import slide
        live = slide.live_for_file(deck)
        patches = [{"path": ["assets", k], "before": live.doc["assets"].get(k), "value": assets[k]}
                   for k in (pair.partition("=")[0] for pair in a.pairs)]
        live.apply(patches, "image_swap")
        print(f"sent {len(patches)} asset(s) to the live editor; it saves the file itself")
        return

    # Escape '<' so the block can never contain a closing script tag.
    body = deckio.encode(doc)
    new = text[: m.start(2)] + body + text[m.end(2):]
    bak = deckio.backup(deck)
    deck.write_text(new, encoding="utf-8")
    # Re-parse our own output before calling it done.
    json.loads(BLOCK.search(new).group(2))
    print(f"wrote {deck} ({len(new) // 1024} KB)" + (f", backup {bak}" if bak else ""))


if __name__ == "__main__":
    main()
