"""Lab slides: a lab card with a timer, the room's status, and an AI helper on every phone.

    python tools/make_lab.py DECK_DIR/build/labs.json [--deck DECK.html] [--build-only] [--out DIR] [ID ...]

One slide per lab: a hidden `activity` poll under a 1280x500 embed. The screen
(template kit/engage/lab.html) shows the instruction, the prompt(s) to type, a countdown,
and a live bar of where the room is: Lost / Working on it / Finished. The phone
(template kit/engage/lab-phone.html) lets each student set that status, ask the lab helper
a question with or without a photo of their screen (POST /api/help, a small model), and,
on Finished, get three ideas for what to do next. One entry per lab:

    {"id": "lab2",                    # asset keys page-lab-ID, img-lab-ID, activity-lab-ID
     "slide": "slide-mv1z70km-3znx4", # the slide to arm. An existing one keeps its title and notes;
                                      # a missing one is created (default id: lab-ID)
     "after": "d08",                  # new slide only: insert after this slide
     "heading": "Lab 2",              # short label
     "title": "Three scouts, three companies",   # the slide title of a new slide, the phone's heading
     "minutes": 12,
     "do": "Name three companies you care about.",
     "types": [["Type this", "Find the latest news about ... [A], [B] and [C] ..."]],   # 1 to 3; [..] = placeholder
     "steps": ["Find three roles you are interested in.", "Write a cover letter for each."],  # or instead of types:
                                      # 1 to 5 numbered lines of plain task, no prompt to type
     "tip": "Then test it: run your skill on a new input.",                            # optional
     "context": "For the AI helper only, never shown: the goal, what success looks like, the tools, "
                "common problems and their fixes. The speaker notes are a good source.",
     "notes": "..."}                  # speaker notes of a NEW slide (optional)

The helper only answers while the lab slide was opened in present mode in the
last 3 hours (that publishes the phone page), and it reads the lab's context
from the published page, never from the phone.

Without --deck it only writes the pages: build/figures/lab-ID.html and
build/engage/lab-ID-phone.html. With --deck it also shoots the poster, uploads
the three assets and arms or creates the slide. Run it again after an edit: the
slide and its bucket are kept, the pages replaced. Works on an open deck (it
only uses slide.py). --build-only writes the pages and poster and never calls
slide.py.
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
import deckio  # noqa: E402
import config  # noqa: E402

HERE = config.REPO / "kit" / "engage"         # the page templates
ALPHABET = "abcdefghjkmnpqrtuvwxy346789"      # no look-alikes, no leading s (sessions)
KEYS = ("id", "heading", "title", "minutes", "do", "steps", "types", "tip", "context")
POLL_ID = "lab-poll"
QUESTION = "Lab check-in"                     # lab.html reads the poll only when its question starts with this
NOTE = ("Room check and AI helper: phones show Lost / Working on it / Finished and an ask box (text or a photo of "
        "the screen, answered by an AI model); Finished gives three ideas for what to do next. The bar under the "
        "timer is the room. Needs present mode and the lecturer key; the helper opens when this slide is shown.")
NOTES = ("Lab, one screen: the task, the prompt to type and the timer (Space starts it). " + NOTE)


def js_json(obj):
    """JSON safe inside a <script>: every < escaped."""
    return json.dumps(obj, ensure_ascii=False, indent=1).replace("<", "\\u003c")


def fill(template, cfg, context_tag=False):
    src = (HERE / template).read_text(encoding="utf-8")
    out, n = re.subn(r"/\*CONFIG\*/.*?/\*END\*/", lambda m: "/*CONFIG*/" + js_json(cfg) + "/*END*/", src, flags=re.S)
    assert n == 1, f"{template}: no single /*CONFIG*/ block"
    if context_tag:
        tag = '<script type="application/json" id="lab-context">'
        out, n = re.subn(re.escape(tag) + r".*?</script>", lambda m: tag + js_json(cfg) + "</script>", out, flags=re.S)
        assert n == 1, f"{template}: no single lab-context tag"
    return out


def check(lab):
    lid = lab.get("id", "?")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", str(lab.get("id", ""))):
        sys.exit(f"{lid}: id must be lowercase letters, digits and hyphens")
    for k in ("heading", "title", "minutes"):
        if not lab.get(k):
            sys.exit(f'{lid}: needs "{k}"')
    t, st = lab.get("types") or [], lab.get("steps") or []
    if not t and not st:
        sys.exit(f'{lid}: needs "types" (prompts to type) or "steps" (the task in plain words)')
    if not isinstance(t, list) or len(t) > 3 or any(not isinstance(x, list) or len(x) != 2 for x in t):
        sys.exit(f'{lid}: "types" takes 1 to 3 [label, prompt] pairs')
    if not isinstance(st, list) or len(st) > 5 or any(not isinstance(x, str) for x in st):
        sys.exit(f'{lid}: "steps" takes 1 to 5 strings')
    if not lab.get("context"):
        print(f'{lid}: no "context": the helper will only know the task text', file=sys.stderr)


def run(*args):
    r = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(f"FAILED {' '.join(map(str, args))}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def poll_el(lab, code, ink="#1A2326"):
    return {"id": POLL_ID, "type": "poll", "x": 72, "y": 160, "w": 400, "h": 400, "rotation": 0, "opacity": 0,
            "question": f"{QUESTION}: {lab['heading']} · {lab['title']}", "code": code, "fontSize": 38,
            "color": ink, "kind": "activity", "activityAsset": f"activity-lab-{lab['id']}"}


def embed_el(lab):
    return {"id": "em-frame", "type": "embed", "x": 0, "y": 150, "w": 1280, "h": 500, "rotation": 0, "opacity": 1,
            "radius": 0, "asset": f"page-lab-{lab['id']}", "poster": f"asset:img-lab-{lab['id']}",
            "liveInEditor": True, "keepPollOpen": True}


def title_style(deck):
    """The title type of the deck's own content layout (its `...title` text element),
    else the theme's font and accent."""
    doc = deckio.load(deck)
    lay = deckio.layout_for(doc, "content") or {}
    el = next((e for e in lay.get("elements", []) if e.get("type") == "text" and str(e.get("id", "")).endswith("title")), {})
    theme = doc.get("theme") or {}
    return {"fontFamily": el.get("fontFamily") or theme.get("fontFamily") or "Manrope, sans-serif",
            "fontWeight": el.get("fontWeight", 400), "color": el.get("color") or theme.get("accent") or deckio.ink(doc)}


def arm(deck, sid, lab, fresh):
    """Put the hidden poll and the lab embed on slide sid; keep its other elements, title and bucket."""
    run(TOOLS / "slide.py", "pull", deck, sid)
    work = deck.parent / "build" / "work" / f"{sid}.json"
    slide = json.loads(work.read_text(encoding="utf-8"))
    els = slide["elements"]
    old = next((e for e in els if e.get("type") == "poll"), None)
    if old and not str(old.get("question", "")).startswith(QUESTION):
        sys.exit(f"{sid} already has a poll that is not a lab check-in ({old.get('id')}); not touching it")
    code = old["code"] if old else "".join(random.choice(ALPHABET) for _ in range(6))
    poll = {**poll_el(lab, code, deckio.ink(deck)), "id": old["id"] if old else POLL_ID}
    emb = next((e for e in els if e.get("type") == "embed"), None)
    new_emb = {**(emb or {}), **embed_el(lab)}
    if emb:
        new_emb["id"] = emb["id"]
        new_emb.pop("devSrc", None)
    rest = [e for e in els if e is not old and e is not emb]
    if fresh:
        ts = title_style(deck)
        rest.append({"id": "co-title", "type": "text", "x": 56, "y": 88, "w": 1168, "h": 56, "rotation": 0,
                     "opacity": 1, "html": f"{lab['heading']}: {lab['title']}", "fontSize": 40,
                     "fontFamily": ts["fontFamily"], "fontWeight": ts["fontWeight"], "color": ts["color"], "align": "left",
                     "valign": "top", "lineHeight": 1.2})
    slide["elements"] = [poll, new_emb] + rest
    notes = slide.get("notes") or ""
    if fresh:
        slide["notes"] = lab.get("notes") or NOTES
    elif "Room check and AI helper" not in notes:
        slide["notes"] = notes.rstrip() + "\n• " + NOTE if notes.strip() else NOTE
    work.write_text(json.dumps(slide, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    run(TOOLS / "slide.py", "push", deck, sid)
    return code, bool(old)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("labs")
    ap.add_argument("ids", nargs="*", help="only these lab ids")
    ap.add_argument("--deck")
    ap.add_argument("--build-only", action="store_true", help="write the pages and the poster, never call slide.py")
    ap.add_argument("--out", help="write under this folder instead of the labs file's folder")
    a = ap.parse_args()
    lfile = pathlib.Path(a.labs).resolve()
    build = pathlib.Path(a.out).resolve() if a.out else lfile.parent
    for sub in ("figures", "engage", "posters"):
        (build / sub).mkdir(parents=True, exist_ok=True)
    labs = json.loads(lfile.read_text(encoding="utf-8"))
    deck = pathlib.Path(a.deck).resolve() if a.deck else None
    have = run(TOOLS / "slide.py", "ls", deck) if deck and not a.build_only else ""
    for lab in labs:
        if a.ids and lab["id"] not in a.ids:
            continue
        check(lab)
        cfg = {k: lab[k] for k in KEYS if k in lab}
        lid = cfg["id"]
        fig = build / "figures" / f"lab-{lid}.html"
        phone = build / "engage" / f"lab-{lid}-phone.html"
        screen_cfg = {k: v for k, v in cfg.items() if k != "context"}   # the projected page never carries it
        fig.write_text(deckio.recolor(fill("lab.html", screen_cfg), deck), encoding="utf-8", newline="\n")
        phone.write_text(deckio.recolor(fill("lab-phone.html", cfg, context_tag=True), deck), encoding="utf-8", newline="\n")
        if len(phone.read_text(encoding="utf-8")) > 60000:
            sys.exit(f"{phone.name} is over the 60 000 character limit of an activity page")
        if not deck and not a.build_only:
            print("wrote", fig.name, phone.name)
            continue
        poster = build / "posters" / f"lab-{lid}.png"
        run(TOOLS / "shoot.py", fig, "--page", "--size", "1280x500", "--settle", "1.5", "--out", poster)
        if a.build_only:
            print("built", fig.name, phone.name, poster.name)
            continue
        run(TOOLS / "slide.py", "asset", deck, f"page-lab-{lid}", fig)
        run(TOOLS / "slide.py", "asset", deck, f"img-lab-{lid}", poster)
        run(TOOLS / "slide.py", "asset", deck, f"activity-lab-{lid}", phone)
        sid = lab.get("slide") or f"lab-{lid}"
        fresh = not re.search(rf"(?<![\w-]){re.escape(sid)}(?![\w-])", have)
        if fresh:
            lid_ = deckio.layout_id(deckio.load(deck), "content")
            if not lid_:
                sys.exit(f"{deck.name} has no content layout")
            args = [TOOLS / "slide.py", "new", deck, "--layout", lid_, "--id", sid,
                    "--name", f"{lab['heading']}: {lab['title']}"[:80]]
            if lab.get("after"):
                args += ["--after", lab["after"]]
            run(*args)
            # keep only the page furniture of the layout
            run(TOOLS / "slide.py", "pull", deck, sid)
            work = deck.parent / "build" / "work" / f"{sid}.json"
            s = json.loads(work.read_text(encoding="utf-8"))
            s["elements"] = [e for e in s["elements"] if e["id"] in ("logo", "footer", "pageno")]
            s["transition"] = "morph"
            work.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
            run(TOOLS / "slide.py", "push", deck, sid)
        code, kept = arm(deck, sid, lab, fresh)
        print(("created" if fresh else "armed"), sid, "bucket", code, "(kept)" if kept else "(new)")


if __name__ == "__main__":
    main()
