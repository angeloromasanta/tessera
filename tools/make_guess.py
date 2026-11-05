"""Guess the number: build the slides from a questions file.

    python tools/make_guess.py DECK_DIR/build/guess.json [--deck DECK.html] [--build-only] [--out DIR] [ID ...]

The room guesses a study's result on their phones, the slide shows the spread
of the guesses, then the study's number (templates in kit/engage: guess.html, the screen;
guess-phone.html, the phone). One entry per question:

    {"id": "time-saved",              # slide id becomes g-time-saved
     "after": "d08",                  # slide to insert after (first build only)
     "question": "...", "setup": "...",       # setup: the study, WITHOUT its result
     "unit": "%", "min": 0, "max": 100, "step": 1, "ticks": [0, 25, 50, 75, 100],
     "signed": false, "low": "", "high": "",  # signed: show +; low/high: pole labels
     "truth": 40,                     # or [40, 52] for a range
     "tol": 5,                        # "close" = within this of the truth
     "answer": "...", "source": "...",        # shown with the reveal
     "sample": 25,                    # centre of the sample guesses (poster, rehearsal)
     "notes": "..."}                  # speaker notes (optional)

Several numbers in one question: replace "truth" by "items", 2 to 4 of them,
which share the axis (min/max/step/ticks/unit/signed/low/high). The phone gets
one slider per item, the screen one row per item: the room's median and, at
the reveal, the study's number beside it.

     "items": [{"key": "right", "label": "When the AI was right", "truth": 71},
               {"key": "wrong", "label": "When the AI was wrong", "truth": 31.5, "color": "#0F6B73"}],
     "sample": [60, 45],              # one centre per item (or one number for all)
     "given": [{"label": "Without any AI", "value": 46}]   # known from the start: on the axis
                                      # from state 0 and on the phone (any entry may have it)

Without --deck it only writes the pages: build/figures/guess-ID.html and
build/engage/guess-ID-phone.html. With --deck it also inlines the deck's font
(build/fig-guess-ID.html), shoots the poster (state 0, never the answer),
uploads the three assets and, if slide g-ID does not exist yet, creates it
with a fresh answer bucket. Run it again after editing a question: the slide
and its bucket are kept, the pages are replaced. The phone page never
contains truth, answer, source or sample.

--build-only stops before the deck: pages, baked page and poster are written,
slide.py is never called. With --deck the font is read from that file on disk
(read only); without it the poster is shot from the unbaked page. --out DIR
writes everything under DIR instead of the questions file's folder.
"""
import argparse
import json
import pathlib
import random
import re
import subprocess
import sys

TOOLS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import config  # noqa: E402
import deckio  # noqa: E402

HERE = config.REPO / "kit" / "engage"         # the page templates
PHONE_KEYS = ("id", "question", "setup", "unit", "min", "max", "step", "signed", "low", "high", "given")
ITEM_PHONE_KEYS = ("key", "label")            # never truth
ALPHABET = "abcdefghjkmnpqrtuvwxy346789"      # no look-alikes, no leading s (sessions)
MANROPE = "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
DEFAULTS = {"unit": "%", "min": 0, "max": 100, "step": 1, "signed": False, "low": "", "high": "", "setup": ""}
NOTES = ("Guess the number. State 0: the question, the join code and a count; nobody sees a guess yet, so nobody "
         "anchors on the room. Give it 45 seconds. Click 1: guesses close and every guess lands on the axis, with the "
         "room's median and the middle half (one row per number when the question asks for several). Ask one low and one high guesser why. Click 2: the study's number, how far "
         "the room's median was and how many were close. Needs present mode and the lecturer key (without it the slide "
         "says so). No wifi: ask for numbers, type each and press Enter.")


def fill(template, cfg):
    src = (HERE / template).read_text(encoding="utf-8")
    block = json.dumps(cfg, ensure_ascii=False, indent=2)
    out, n = re.subn(r"/\*CONFIG\*/.*?/\*END\*/", lambda m: "/*CONFIG*/" + block + "/*END*/", src, flags=re.S)
    assert n == 1, template
    return out


def check(q):
    """A question has one truth, or 2 to 4 items with a truth each."""
    qid = q.get("id", "?")
    items = q.get("items")
    if items is None:
        if "truth" not in q:
            sys.exit(f'{qid}: needs "truth" (or "items")')
    else:
        if not isinstance(items, list) or not 2 <= len(items) <= 4:
            sys.exit(f'{qid}: "items" takes 2 to 4 entries')
        keys = [str(it.get("key", "")) for it in items]
        if "" in keys or len(set(keys)) != len(keys):
            sys.exit(f'{qid}: every item needs its own "key"')
        for it in items:
            if not it.get("label") or "truth" not in it:
                sys.exit(f'{qid}: item {it.get("key")} needs "label" and "truth"')
        if isinstance(q.get("sample"), list) and len(q["sample"]) != len(items):
            sys.exit(f'{qid}: "sample" as a list needs one centre per item')
    for g in q.get("given") or []:
        if "label" not in g or "value" not in g:
            sys.exit(f'{qid}: a "given" needs "label" and "value"')


def phone_cfg(cfg):
    out = {k: cfg[k] for k in PHONE_KEYS if k in cfg}
    if cfg.get("items"):
        out["items"] = [{k: it[k] for k in ITEM_PHONE_KEYS if k in it} for it in cfg["items"]]
    return out


def run(*args, quiet=True):
    r = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(f"FAILED {' '.join(map(str, args))}\n{r.stdout}\n{r.stderr}")
    if not quiet:
        print(r.stdout.strip())
    return r.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("questions")
    ap.add_argument("ids", nargs="*", help="only these question ids")
    ap.add_argument("--deck")
    ap.add_argument("--build-only", action="store_true",
                    help="write the pages and the poster, never call slide.py (the deck is only read, for its font)")
    ap.add_argument("--out", help="write under this folder instead of the questions file's folder")
    a = ap.parse_args()
    qfile = pathlib.Path(a.questions).resolve()
    build = pathlib.Path(a.out).resolve() if a.out else qfile.parent
    for sub in ("figures", "engage", "posters"):
        (build / sub).mkdir(parents=True, exist_ok=True)
    questions = json.loads(qfile.read_text(encoding="utf-8"))
    deck = pathlib.Path(a.deck).resolve() if a.deck else None
    have = run(TOOLS / "slide.py", "ls", deck) if deck and not a.build_only else ""
    for q in questions:
        if a.ids and q["id"] not in a.ids:
            continue
        check(q)
        cfg = {**DEFAULTS, **q}
        qid, sid = cfg["id"], "g-" + cfg["id"]
        meta = {k: cfg.pop(k, None) for k in ("after", "notes")}
        fig = build / "figures" / f"guess-{qid}.html"
        phone = build / "engage" / f"guess-{qid}-phone.html"
        fig.write_text(deckio.recolor(fill("guess.html", cfg), deck), encoding="utf-8", newline="\n")
        phone.write_text(deckio.recolor(fill("guess-phone.html", phone_cfg(cfg)), deck), encoding="utf-8", newline="\n")
        if len(phone.read_text(encoding="utf-8")) > 60000:
            sys.exit(f"{phone.name} is over the 60 000 character limit of an activity page")
        if not deck and not a.build_only:
            print("wrote", fig.name, phone.name)
            continue
        baked = build / f"fig-guess-{qid}.html"
        poster = build / "posters" / f"guess-{qid}.png"
        if deck:
            run(TOOLS / "embed_font.py", fig, "--deck", deck, "-o", baked)
        run(TOOLS / "shoot.py", baked if deck else fig, "--page", "--size", "1280x720", "--settle", "2", "--out", poster)
        if a.build_only:
            print("built", (baked if deck else fig).name, phone.name, poster.name)
            continue
        run(TOOLS / "slide.py", "asset", deck, f"page-guess-{qid}", baked)
        run(TOOLS / "slide.py", "asset", deck, f"img-guess-{qid}", poster)
        run(TOOLS / "slide.py", "asset", deck, f"activity-guess-{qid}", phone)
        if re.search(rf"\b{re.escape(sid)}\b", have):
            print("updated", sid)
            continue
        layout = deckio.layout_id(deckio.load(deck), "content")
        if not layout:
            sys.exit(f"{deck.name} has no content layout")
        args = [TOOLS / "slide.py", "new", deck, "--layout", layout, "--id", sid, "--name", "Guess: " + cfg["question"][:60]]
        if meta["after"]:
            args += ["--after", meta["after"]]
        run(*args)
        run(TOOLS / "slide.py", "pull", deck, sid)
        work = deck.parent / "build" / "work" / f"{sid}.json"
        slide = json.loads(work.read_text(encoding="utf-8"))
        keep = [e for e in slide["elements"] if e["id"] in ("logo", "footer", "pageno")]
        # A new layout slide carries the template's "Footer text": take the
        # deck's own footer from the slide it follows.
        if meta["after"]:
            run(TOOLS / "slide.py", "pull", deck, meta["after"])
            prev = json.loads((work.parent / f"{meta['after']}.json").read_text(encoding="utf-8"))
            foot = next((e for e in prev["elements"] if e["id"] == "footer"), None)
            for e in keep:
                if e["id"] == "footer" and foot:
                    e["html"] = foot["html"]
        code = "".join(random.choice(ALPHABET) for _ in range(6))
        slide["elements"] = [
            {"id": "aq-poll", "type": "poll", "x": 72, "y": 150, "w": 400, "h": 400, "rotation": 0, "opacity": 0,
             "question": "Guess: " + cfg["question"], "code": code, "fontSize": 38, "color": deckio.ink(deck),
             "kind": "activity", "activityAsset": f"activity-guess-{qid}"},
            {"id": "em-frame", "type": "embed", "x": 0, "y": 0, "w": 1280, "h": 720, "rotation": 0, "opacity": 1,
             "radius": 0, "asset": f"page-guess-{qid}", "poster": f"asset:img-guess-{qid}", "liveInEditor": True,
             "keepPollOpen": True},
        ] + keep
        slide["notes"] = meta["notes"] or NOTES
        slide["transition"] = "fade"
        work.write_text(json.dumps(slide, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
        run(TOOLS / "slide.py", "push", deck, sid)
        print("created", sid, "bucket", code)


if __name__ == "__main__":
    main()
