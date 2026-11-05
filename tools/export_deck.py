#!/usr/bin/env python3
"""Create a single-file, presentation-only copy of a deck (with a slide-list pane)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deckio  # noqa: E402

DOC_RE = deckio.DOC_RE
FORMAT, FORMATS = deckio.FORMAT, deckio.FORMATS
# the browser-side old names an older shell uses (its API object, its overlay class)
LEGACY = json.loads((Path(__file__).resolve().parent / "legacy.json").read_text(encoding="utf-8"))

NAV_ID = "tessera-export-nav"


def inject_nav(html: str) -> str:
    """Add the slide-list pane (nav.js) as its own script before </body>."""
    if f'id="{NAV_ID}"' in html or f'id="{LEGACY["navId"]}"' in html:
        return html
    js = (Path(__file__).resolve().parent / "nav.js").read_text(encoding="utf-8")
    old = {k: v for k, v in LEGACY.items() if k in ("api", "overlayClass")}
    js = js.replace("__LEGACY__", json.dumps(old))
    close = "</" + "script"
    if close in js.lower():
        raise ValueError("nav.js holds a script-close tag")
    at = html.rfind("</body>")
    if at < 0:
        raise ValueError("No </body> in the deck shell")
    tag = f'<script id="{NAV_ID}">' + chr(10) + js + close + ">" + chr(10)
    return html[:at] + tag + html[at:]


def export(source: Path, output: Path, nav: bool = True) -> None:
    source = source.resolve()
    output = output.resolve()
    if source == output:
        raise ValueError("Output must differ from the editable source deck")
    if not source.is_file():
        raise ValueError(f"Source deck not found: {source}")
    guard = source.parent / "build" / f"{source.name}.live-source.json"
    if guard.exists():
        raise ValueError(
            f"Live editor is authoritative ({guard}); save or reconcile it before export"
        )

    html = source.read_text(encoding="utf-8")
    match = DOC_RE.search(html)
    if not match:
        raise ValueError(f"No #{deckio.DOC_ID} block found; expected a deck HTML file")
    try:
        doc = json.loads(match.group(2))
    except json.JSONDecodeError:
        # The JSON may be whole but carry a raw '</script>' that cut the block short.
        raise ValueError(
            "the document block does not parse; if a writer left a raw '<' in it, run "
            f"`python tools/slide.py repair {source}` first"
        ) from None
    if doc.get("format") not in FORMATS:
        raise ValueError(f"Document format is not {FORMAT}")
    if doc.get("template"):
        raise ValueError("Source is a template; export a saved deck instance instead")

    doc["readonly"] = True
    doc.pop("collab", None)
    exported = html[:match.start(2)] + deckio.encode(doc) + html[match.end(2):]

    check = DOC_RE.search(exported)
    if not check or json.loads(check.group(2)) != doc:
        raise ValueError("Export failed document round-trip validation")
    if (exported[:check.start(2)] != html[:match.start(2)]
            or exported[check.end(2):] != html[match.end(2):]):
        raise ValueError("Export failed shell validation")

    if nav:
        exported = inject_nav(exported)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(exported, encoding="utf-8")
    print(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Saved editable deck (.html)")
    parser.add_argument("-o", "--output", type=Path, help="Player HTML output path")
    parser.add_argument("--no-nav", action="store_true",
                        help="Leave out the slide-list pane")
    args = parser.parse_args()
    source = args.source
    stem = source.stem.removesuffix("." + LEGACY["api"])     # an old name.<suffix>.html
    output = args.output or source.parent / "build" / f"{stem}-presentonly.html"
    try:
        export(source, output, nav=not args.no_nav)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"export_deck: {exc}\n")


if __name__ == "__main__":
    main()
