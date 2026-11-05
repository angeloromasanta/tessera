#!/usr/bin/env python3
"""Audit a spec against its source pptx: which of the deck's words went missing.

    python text_audit.py deck.pptx deck.md [--first N --last N] [-v]

Pass 2 is the only step a model does by hand, and the failure it makes is
always the same one: it paraphrases. A tightened bullet, a seven-item list
condensed to six, a caption invented for a picture that never had one -- each
reads fine, compiles clean, and quietly replaces the author's deck with the
model's. Nothing downstream notices, because the output is still a valid deck.

So check it mechanically. Every text run in the pptx must appear in the spec.
Exit status is the number of source runs that do not.

Matching is deliberately forgiving about things a spec has to change:
straight vs. curly quotes, `--` for an em dash, collapsed whitespace, case.
It is deliberately unforgiving about words. If a sentence lost a clause, that
is a paraphrase, and it is reported.
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

from pptx import Presentation

# Runs that are furniture rather than content: slide numbers, dates, the
# author's own name in a footer placeholder. Only skip what is genuinely noise.
NOISE = re.compile(r"^[\s\d/.,:%-]*$")


def norm(text: str) -> str:
    """Fold the differences a faithful spec is still allowed to have."""
    t = unicodedata.normalize("NFKD", text)
    t = (t.replace("’", "'").replace("‘", "'")
          .replace("“", '"').replace("”", '"')
          .replace("–", "-").replace("—", "-")
          .replace("…", "..."))
    t = re.sub(r"--", "-", t)
    t = re.sub(r"[^a-z0-9]+", " ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


def runs(pptx: Path, first: int, last: int) -> list[tuple[int, str]]:
    out = []
    for n, slide in enumerate(Presentation(str(pptx)).slides, 1):
        if n < first or n > last:
            continue
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for para in shape.text_frame.paragraphs:
                text = "".join(r.text for r in para.runs).strip()
                if text and not NOISE.match(text):
                    out.append((n, text))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx", type=Path)
    ap.add_argument("spec", type=Path)
    ap.add_argument("--first", type=int, default=1)
    ap.add_argument("--last", type=int, default=10**6)
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="also list the runs that were found")
    a = ap.parse_args()

    hay = norm(a.spec.read_text(encoding="utf-8"))
    found, split, missing = [], [], []
    for n, text in runs(a.pptx, a.first, a.last):
        if norm(text) in hay:
            found.append((n, text))
            continue
        # PowerPoint concatenates two placeholders with no separator
        # ("Assistant ProfessorBusiness School"). Splitting that back
        # into two fields is the one edit a faithful spec must make, so a run
        # whose halves are both present has not been lost.
        parts = re.split(r"(?<=[a-z)])(?=[A-Z])", text)
        if len(parts) > 1 and all(norm(p) in hay for p in parts if norm(p)):
            split.append((n, text))
        else:
            missing.append((n, text))

    if a.verbose:
        for n, t in found:
            print(f"  ok    {n:>3}  {t[:88]}")
    for n, t in split:
        print(f"  split slide {n:>3}  {t[:88]}")
    for n, t in missing:
        print(f"  MISSING  slide {n:>3}  {t[:100]}")

    found += split
    total = len(found) + len(missing)
    pct = 100.0 * len(found) / total if total else 100.0
    print(f"{a.pptx.name} -> {a.spec.name}: {len(found)}/{total} text runs "
          f"present ({pct:.1f}%), {len(missing)} missing")
    if missing:
        print("Restore them verbatim, or say in your handover why each one went.")
    return len(missing)


if __name__ == "__main__":
    sys.exit(main())
