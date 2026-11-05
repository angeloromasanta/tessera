#!/usr/bin/env python3
"""Deterministic surgery on an already-compiled deck.

md_to_deck.py compiles a deck from scratch, one spec -> one HTML file. This
script is for the far more common edit: a deck already exists (often with no
surviving .md spec — it was hand-built, or the spec was thrown away) and one
`embed` slide needs to be added, replaced, or removed. It reuses md_to_deck's
own Template/Assets/build_embed machinery, so a slide produced here is
byte-for-byte the same shape a fresh compile would produce — same asset key
scheme, same logo/footer/pageno chrome, same "<" -> "\\u003c" JSON escaping.

    python tools/deck_build.py info deck.html          (large; prefer slide.py ls / info --section)
    python tools/deck_build.py add-slide deck.html --page fig.html \\
        --title "The perceptron" --notes "..."
    python tools/deck_build.py update-slide deck.html --id s05-embed \\
        --page fig.html
    python tools/deck_build.py remove-slide deck.html --id s05-embed
    python tools/deck_build.py add-poll deck.html --kind choice \\
        --question "Which matters most?" --options "Cost|Speed|Quality"

`add-poll` builds the other kind of slide worth splicing in on its own: an
audience question. It mints an answer bucket that cannot collide with the
deck's existing polls, and a deck-wide join session if the deck has none.

Every mutating command copies the deck to build/backups/ before touching it,
and re-parses its own output before declaring success.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
import deckio  # noqa: E402
from md_to_deck import (  # noqa: E402
    CANVAS_H,
    CANVAS_W,
    CODE_ALPHABET,
    DOC_RE,
    Assets,
    Block,
    Template,
    build_embed,
    build_poll,
    hive_slide,
    matrix_slide,
    MATRIX_ASSETS,
)

# the template ($TESSERA_TEMPLATE): source of the hive slide for decks that have none
TEMPLATE = config.template()
HIVE_ASSETS = ("page-hive-cluster", "img-hive-cluster-poster")

import shoot  # noqa: E402

# Windows consoles default to cp1252, and deck titles/notes carry em dashes,
# arrows and accents — `info` crashed printing them. Force UTF-8 output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


# ──────────────────────────────────────────────────────────────── plumbing

def load(deck_path: Path) -> Template:
    return Template(deck_path)


def next_slide_id(doc: dict, kind: str = "embed") -> str:
    n = len(doc.get("slides", [])) + 1
    used = {s["id"] for s in doc.get("slides", [])}
    sid = f"s{n:02d}-{kind}"
    while sid in used:
        n += 1
        sid = f"s{n:02d}-{kind}"
    return sid


def find_slide(doc: dict, sid: str) -> dict:
    for s in doc["slides"]:
        if s["id"] == sid:
            return s
    raise SystemExit(f"no slide with id '{sid}' — have: "
                     + ", ".join(s["id"] for s in doc["slides"]))


def insert_at(slides: list, slide: dict, after: str | None,
             index: int | None) -> None:
    if after is not None:
        for i, s in enumerate(slides):
            if s["id"] == after:
                slides.insert(i + 1, slide)
                return
        raise SystemExit(f"--after '{after}': no such slide id")
    if index is not None:
        slides.insert(max(0, min(index, len(slides))), slide)
        return
    slides.append(slide)


def write_deck(tpl: Template, doc: dict, out_path: Path) -> None:
    if (out_path.parent / "build" / f"{out_path.name}.live-source.json").exists():
        raise SystemExit("Live editor is authoritative. Use agent_live.py patch; do not rewrite this deck on disk.")
    """Same encode as md_to_deck.compile_deck: compact JSON, '<' escaped so
    an embedded page's own </script> can never close the outer script tag."""
    payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("<", "\\u003c")
    out = DOC_RE.sub(lambda m: m.group(1) + payload + m.group(3), tpl.html,
                     count=1)
    deckio.backup(out_path)
    out_path.write_text(out, encoding="utf-8")

    # round-trip check: re-extract and re-parse before calling it done
    check = DOC_RE.search(out)
    if not check:
        raise SystemExit("wrote the file but the doc script block is gone "
                         "— aborting, restore it from build/backups/")
    json.loads(check.group(2))  # raises if the escaping broke anything


def auto_poster(page: Path, title: str, clicks: list[int] | str,
                settle: float) -> Path:
    """Screenshot `page` at the exact frame size build_embed will give it.

    The poster lands in the DECK'S build/media/ — `shoot.default_out` decides
    which folder that is, so a figure page kept in figures/ or build/ does not
    grow a media/ folder of its own beside it.
    """
    w, h = CANVAS_W, (CANVAS_H if not title else 500)
    out = shoot.default_out(page, page=True).parent.parent / "media"         / f"{page.stem}-poster.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    shoot.shoot_page(page.resolve(), out, w, h, clicks, settle)
    return out.resolve()


def make_embed_slide(tpl: Template, doc: dict, *, page: Path | None,
                     src: str | None, poster: Path | None, title: str,
                     notes: str, name: str | None, footer: str | None,
                     sid: str | None, zoom: float | None, live: bool,
                     transition: str) -> dict:
    assets = Assets(doc, page.parent if page else Path.cwd())
    if footer is None:
        footer = _guess_footer(doc)
    ctx = {"assets": assets, "theme": doc.get("theme", {}), "footer": footer}

    s = Block("embed")
    s.fields = {
        "title": title or "",
        "page": str(page) if page else "",
        "src": src or "",
        "poster": str(poster) if poster else "",
        "notes": notes or "",
    }
    if zoom is not None:
        s.fields["zoom"] = str(zoom)
    if live:
        s.fields["live"] = "yes"

    layout, els = build_embed(tpl, s, ctx)
    resolved_sid = sid or next_slide_id(doc)
    return {
        "id": resolved_sid,
        "name": name or title or "Embed",
        "background": doc.get("theme", {}).get("background")
                     or tpl.layouts[layout]["background"],
        "transition": transition,
        "notes": notes or "",
        "elements": els,
    }


def existing_poll_codes(doc: dict) -> set[str]:
    """Every answer bucket already used in this deck.

    Seeded into the build context so a poll added today cannot be handed a
    code some slide is already collecting into — two questions sharing one
    bucket means the second shows the first one's answers, and a phone that
    answered either is told it answered both.
    """
    return {el["code"] for s in doc.get("slides", [])
            for el in s.get("elements", [])
            if el.get("type") == "poll" and el.get("code")}


def ensure_session(doc: dict) -> tuple[str, bool]:
    """The deck-wide join code: the room scans ONE QR for the whole talk and
    their page follows whichever question is on screen. `s` + 6 from the app's
    own alphabet, which has no `s` — so the join page can tell a session code
    from a question code without asking the server."""
    import random
    poll = doc.setdefault("poll", {})
    if poll.get("session"):
        return poll["session"], False
    rng = random.SystemRandom()
    poll["session"] = "s" + "".join(rng.choice(CODE_ALPHABET) for _ in range(6))
    return poll["session"], True


def parse_quiz(path: Path) -> list[Block]:
    """Read quiz questions into the sub-blocks build_poll expects.

    Two input shapes, because both are natural to write:
      .json  [{"q": "...", "options": ["a","b"], "correct": 1}, ...]
      .md    ### the question
             - option
             - *the right one          (first option if none is starred)
    """
    out: list[Block] = []
    if path.suffix.lower() == ".json":
        for q in json.loads(path.read_text(encoding="utf-8")):
            blk = Block("q")
            blk.fields["heading"] = q["q"]
            opts = list(q["options"])
            correct = int(q.get("correct", 0))
            blk.bullets = [{"text": ("*" if i == correct else "") + o, "subs": []}
                           for i, o in enumerate(opts)]
            out.append(blk)
        return out
    blk = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("###"):
            blk = Block("q")
            blk.fields["heading"] = line.lstrip("#").strip()
            out.append(blk)
        elif line.startswith("- ") and blk is not None:
            blk.bullets.append({"text": line[2:].strip(), "subs": []})
    return [b for b in out if b.fields.get("heading") and b.bullets]


def make_poll_slide(tpl: Template, doc: dict, *, fields: dict,
                    blocks: list[Block], base: Path, notes: str,
                    name: str | None, footer: str | None, sid: str | None,
                    transition: str) -> dict:
    if not tpl.has("poll"):
        raise SystemExit("this deck has no `poll` layout — add the poll "
                         "element by hand (see docs/guide/engagement.md) or "
                         "compile against a template that has one")
    if footer is None:
        footer = _guess_footer(doc)
    ctx = {"assets": Assets(doc, base), "theme": doc.get("theme", {}),
           "footer": footer, "poll_codes": existing_poll_codes(doc)}
    s = Block("poll")
    s.fields = {k: v for k, v in fields.items() if v not in (None, "")}
    s.blocks = blocks
    layout, els = build_poll(tpl, s, ctx)
    return {
        "id": sid or next_slide_id(doc, "poll"),
        "name": name or "Audience question",
        "background": tpl.layouts[layout]["background"],
        "transition": transition,
        "notes": notes or "",
        "elements": els,
    }


def _guess_footer(doc: dict) -> str:
    """Existing decks carry the footer text on every slide's own footer
    element rather than in one shared place — copy it from the last slide
    that has one, so a new slide matches instead of going blank."""
    for s in reversed(doc.get("slides", [])):
        for el in s.get("elements", []):
            if el.get("id") == "footer" and el.get("html"):
                return re.sub(r"<[^>]+>", "", el["html"])
    return ""


# ──────────────────────────────────────────────────────────────── commands

def cmd_info(args: argparse.Namespace) -> None:
    tpl = load(Path(args.deck))
    doc = tpl.doc
    out = {
        "size": doc.get("size"),
        "theme": doc.get("theme"),
        "slideCount": len(doc.get("slides", [])),
        "slides": [
            {
                "id": s["id"],
                "name": s.get("name"),
                "transition": s.get("transition"),
                "notes": (s.get("notes") or "")[:140],
            }
            for s in doc.get("slides", [])
        ],
        "assetKeys": sorted(doc.get("assets", {}).keys()),
        # The layout catalogue, read off the file: this is the source of truth
        # for ids and frames, so nothing in the docs has to repeat it.
        "layouts": [
            {
                "id": l["id"],
                "name": l.get("name"),
                "background": l.get("background"),
                "notes": l.get("notes"),
                "elements": [
                    {k: e[k] for k in ("id", "type", "x", "y", "w", "h",
                                        "fontSize", "color", "fill", "fit", "role")
                     if k in e}
                    for e in l.get("elements", [])
                ],
            }
            for l in doc.get("layouts", [])
        ],
        "agentNotes": doc.get("agentNotes"),
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_add_slide(args: argparse.Namespace) -> None:
    deck_path = Path(args.deck)
    tpl = load(deck_path)
    doc = tpl.doc

    page = Path(args.page).resolve() if args.page else None
    if page and not page.exists():
        raise SystemExit(f"--page {page}: not found")

    poster = Path(args.poster).resolve() if args.poster else None
    if page and not poster and not args.no_poster:
        clicks = args.clicks or "0"        # "3", "0,3", "last" or "all"
        print(f"no --poster given — screenshotting {page.name} ...")
        poster = auto_poster(page, args.title, clicks, args.settle)
        print(f"  wrote {poster}")

    notes = args.notes
    if args.notes_file:
        notes = Path(args.notes_file).read_text(encoding="utf-8").strip()

    slide = make_embed_slide(
        tpl, doc, page=page, src=args.src, poster=poster,
        title=args.title or "", notes=notes or "", name=args.name,
        footer=args.footer, sid=args.id, zoom=args.zoom, live=bool(args.live),
        transition=args.transition or "morph")

    insert_at(doc["slides"], slide, args.after, args.index)

    if args.dry_run:
        print(json.dumps(slide, indent=2)[:2000])
        print("(--dry-run: deck not written)")
        return

    out_path = Path(args.out) if args.out else deck_path
    write_deck(tpl, doc, out_path)
    print(f"wrote {out_path} — {len(doc['slides'])} slides "
          f"({out_path.stat().st_size/1e6:.1f} MB), inserted "
          f"{slide['id']!r} at position "
          f"{[s['id'] for s in doc['slides']].index(slide['id']) + 1}")


def cmd_add_poll(args: argparse.Namespace) -> None:
    deck_path = Path(args.deck)
    tpl = load(deck_path)
    doc = tpl.doc

    kind = args.kind
    blocks: list[Block] = []
    base = deck_path.resolve().parent
    if kind == "quiz":
        if not args.quiz_file:
            raise SystemExit("--kind quiz needs --quiz-file (.md or .json)")
        qp = Path(args.quiz_file).resolve()
        if not qp.exists():
            raise SystemExit(f"--quiz-file {qp}: not found")
        blocks = parse_quiz(qp)
        if not blocks:
            raise SystemExit(f"--quiz-file {qp}: no questions found")
    if kind == "choice" and not args.options:
        raise SystemExit("--kind choice needs --options 'A|B|C'")
    if kind == "activity":
        if not args.activity:
            raise SystemExit("--kind activity needs --activity page.html")
        ap = Path(args.activity).resolve()
        if not ap.exists():
            raise SystemExit(f"--activity {ap}: not found")
        base = ap.parent

    session, minted = ensure_session(doc)
    service = (doc.get("poll") or {}).get("service")

    # An open question is one slide: the live clustered hive with its poll
    # hidden beneath it. Its page and poster come from the template,
    # refreshed on every add so the deck picks up hive fixes.
    # `--axes`: the same one-slide question, but the answers are placed on the
    # presenter's axes (the hive matrix) instead of clustered.
    matrix = kind == "open" and bool(args.axes)
    if args.axes and kind != "open":
        raise SystemExit("--axes is for --kind open")
    if matrix:
        if not TEMPLATE.exists():
            raise SystemExit(f"--axes needs the template ({TEMPLATE}; set TESSERA_TEMPLATE)")
        src = Template(TEMPLATE)
        tpl.matrix_override = matrix_slide(src)
        if not tpl.matrix_override:
            raise SystemExit(f"the template {TEMPLATE.name} has no poll-matrix slide — run template/splice_template.py")
        for k in MATRIX_ASSETS:
            doc.setdefault("assets", {})[k] = src.doc["assets"][k]
    hive = kind == "open" and not args.no_hive and not matrix and TEMPLATE.exists()
    if hive:
        src = Template(TEMPLATE)
        tpl.hive_override = hive_slide(src)
        hive = bool(tpl.hive_override)
        if hive:
            for k in HIVE_ASSETS:
                doc.setdefault("assets", {})[k] = src.doc["assets"][k]

    slide = make_poll_slide(
        tpl, doc,
        fields={
            "kicker": args.kicker,
            "question": args.question,
            "kind": kind,
            "code": args.code,
            "options": args.options,
            "min": args.min,
            "max": args.max,
            "minlabel": args.min_label,
            "maxlabel": args.max_label,
            "requirename": "yes" if args.require_name else "",
            "hive": "no" if args.no_hive else "",
            "axes": ";".join(args.axes or []),
            "quads": args.quads or "",
            "activity": str(Path(args.activity).resolve()) if args.activity else "",
        },
        blocks=blocks, base=base, notes=args.notes or "",
        name=args.name or ("Open question on axes" if matrix else "Open question, live" if hive else None),
        footer=args.footer, sid=args.id or (next_slide_id(doc, "matrix") if matrix
                                            else next_slide_id(doc, "hive") if hive else None),
        transition=args.transition)

    insert_at(doc["slides"], slide, args.after, args.index)

    if args.dry_run:
        print(json.dumps(slide, indent=2)[:2000])
        print("(--dry-run: deck not written)")
        return

    out_path = Path(args.out) if args.out else deck_path
    write_deck(tpl, doc, out_path)
    code = next(el["code"] for el in slide["elements"] if el.get("type") == "poll")
    print(f"wrote {out_path} — inserted {slide['id']!r} at position "
          f"{[s['id'] for s in doc['slides']].index(slide['id']) + 1}, "
          f"kind {kind}, answer bucket {code!r}")
    print(f"  join session: {session}{' (minted now)' if minted else ''}")
    if not service:
        print("  ! this deck has no doc.poll.service — nothing will reach a "
              "poll service. Set it to your deployment's base URL.")


def cmd_update_slide(args: argparse.Namespace) -> None:
    deck_path = Path(args.deck)
    tpl = load(deck_path)
    doc = tpl.doc
    old = find_slide(doc, args.id)

    page = Path(args.page).resolve() if args.page else None
    if page and not page.exists():
        raise SystemExit(f"--page {page}: not found")
    title = args.title if args.title is not None else _current_title(old)

    poster = Path(args.poster).resolve() if args.poster else None
    if page and not poster and not args.no_poster:
        clicks = args.clicks or "0"        # "3", "0,3", "last" or "all"
        print(f"no --poster given — screenshotting {page.name} ...")
        poster = auto_poster(page, title, clicks, args.settle)
        print(f"  wrote {poster}")

    notes = args.notes if args.notes is not None else old.get("notes", "")
    if args.notes_file:
        notes = Path(args.notes_file).read_text(encoding="utf-8").strip()

    rebuilt = make_embed_slide(
        tpl, doc, page=page, src=args.src, poster=poster, title=title,
        notes=notes, name=args.name or old.get("name"),
        footer=args.footer, sid=old["id"], zoom=args.zoom,
        live=(args.live if args.live is not None else any(
            el.get("type") == "embed" and el.get("liveInEditor")
            for el in old.get("elements", []))),
        transition=args.transition or old.get("transition", "morph"))

    idx = doc["slides"].index(old)
    doc["slides"][idx] = rebuilt

    if args.dry_run:
        print(json.dumps(rebuilt, indent=2)[:2000])
        print("(--dry-run: deck not written)")
        return

    out_path = Path(args.out) if args.out else deck_path
    write_deck(tpl, doc, out_path)
    print(f"wrote {out_path} — updated {rebuilt['id']!r}")


def _current_title(slide: dict) -> str:
    for el in slide.get("elements", []):
        if el.get("id") == "co-title":
            return re.sub(r"<[^>]+>", "", el.get("html", ""))
    return ""


def cmd_remove_slide(args: argparse.Namespace) -> None:
    deck_path = Path(args.deck)
    tpl = load(deck_path)
    doc = tpl.doc
    old = find_slide(doc, args.id)
    doc["slides"].remove(old)
    if args.dry_run:
        print(f"(--dry-run: would remove {args.id!r}, deck not written)")
        return
    out_path = Path(args.out) if args.out else deck_path
    write_deck(tpl, doc, out_path)
    print(f"wrote {out_path} — removed {args.id!r}, "
          f"{len(doc['slides'])} slides left")


# ──────────────────────────────────────────────────────────────────── CLI

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info", help="print size/theme/slides/assets as JSON")
    p.add_argument("deck")
    p.set_defaults(func=cmd_info)

    def embed_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--page", help="local HTML file, embedded verbatim")
        p.add_argument("--src", help="a URL instead of --page (not portable)")
        p.add_argument("--poster",
                      help="poster image; auto-screenshotted from --page "
                           "at the right frame size if omitted")
        p.add_argument("--no-poster", action="store_true",
                      help="skip auto-screenshot even with no --poster")
        p.add_argument("--clicks", default="last",
                      help="advance a step-engine figure N times before the "
                           "poster shot; 'last' (default) = its final state, "
                           "which is 0 for a page with no steps")
        p.add_argument("--settle", type=float, default=1.3)
        p.add_argument("--notes")
        p.add_argument("--notes-file", help="read --notes from a file "
                       "instead (avoids shell quoting for long narration)")
        p.add_argument("--name", help="deck-outline label (default: title)")
        p.add_argument("--footer", help="default: copied from the last "
                       "slide that has one")
        p.add_argument("--zoom", type=float)
        p.add_argument("--live", action=argparse.BooleanOptionalAction,
                      default=None, help="run the embed on the edit canvas too")
        p.add_argument("--transition", default=None,
                      help="default: morph (update-slide: keep the slide's own)")
        p.add_argument("-o", "--out", help="default: overwrite the deck "
                       "in place (a backup goes to build/backups/ first)")
        p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("add-slide",
                       help="append (or insert) a new embed slide")
    p.add_argument("deck")
    p.add_argument("--title", default="", help="slide heading; omit for "
                   "full-bleed (no title band)")
    p.add_argument("--id", help="default: next sNN-embed")
    p.add_argument("--after", help="insert after this slide id")
    p.add_argument("--index", type=int, help="0-based insert position")
    embed_args(p)
    p.set_defaults(func=cmd_add_slide)

    p = sub.add_parser("add-poll",
                       help="append (or insert) an audience-question slide")
    p.add_argument("deck")
    p.add_argument("--question", required=True, help="what the room is asked")
    p.add_argument("--kind", default="open",
                   choices=["open", "choice", "rating", "quiz", "activity"])
    p.add_argument("--kicker", default="Over to you",
                   help="the small line above the question")
    p.add_argument("--options", help="choice: 'A|B|C'")
    p.add_argument("--min", help="rating: scale start (default 1)")
    p.add_argument("--max", help="rating: scale end (default 5)")
    p.add_argument("--min-label", help="rating: label under the low end")
    p.add_argument("--max-label", help="rating: label under the high end")
    p.add_argument("--quiz-file", help="quiz: .md (### question / - option, "
                   "* marks the right one) or .json ([{q,options,correct}])")
    p.add_argument("--activity", help="activity: a self-contained HTML page, "
                   "shipped to every phone")
    p.add_argument("--no-hive", action="store_true",
                   help="open: the classic question slide instead of the live "
                   "clustered hive")
    p.add_argument("--axes", nargs="+", metavar="'LOW|HIGH'",
                   help="open: place the answers on your own axes (the hive "
                   "matrix) — one or two 'Low pole|High pole', each pole "
                   "optionally 'Label = definition'")
    p.add_argument("--quads", help="--axes with two axes: quadrant names "
                   "'top-left|top-right|bottom-left|bottom-right'")
    p.add_argument("--require-name", action="store_true",
                   help="ask for a name once per session before answering")
    p.add_argument("--code", help="answer bucket; default: a fresh one that "
                   "cannot collide with this deck's existing polls")
    p.add_argument("--notes", help="speaker notes")
    p.add_argument("--name", help="deck-outline label")
    p.add_argument("--footer", help="default: copied from the last slide "
                   "that has one")
    p.add_argument("--id", help="default: next sNN-poll")
    p.add_argument("--after", help="insert after this slide id")
    p.add_argument("--index", type=int, help="0-based insert position")
    p.add_argument("--transition", default="morph")
    p.add_argument("-o", "--out", help="default: overwrite the deck in place "
                   "(a backup goes to build/backups/ first)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_add_poll)

    p = sub.add_parser("update-slide",
                       help="replace an existing embed slide's figure/poster/"
                            "title/notes in place")
    p.add_argument("deck")
    p.add_argument("--id", required=True)
    p.add_argument("--title", default=None)
    embed_args(p)
    p.set_defaults(func=cmd_update_slide)

    p = sub.add_parser("remove-slide", help="delete a slide by id")
    p.add_argument("deck")
    p.add_argument("--id", required=True)
    p.add_argument("-o", "--out")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_remove_slide)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    sys.exit(main())
