"""Build a one-slide game from a screen page, a phone page and a JSON config.

    python tools/make_game.py GAME.json --deck DECK.html [--after ID]
    python tools/make_game.py GAME.json --build-only [--deck DECK.html] [--out DIR]

GAME.json (paths relative to the file itself):

    {
      "slide": {
        "id": "q-buzz",                     slide id (default q-game)
        "name": "Buzz and vote",            the slide's name; the hidden poll's question by default
        "question": "Buzz and vote",        optional
        "screen": "../figures/buzz.html",   the screen source (the figure, with the lecturer's controls)
        "phone": "buzz-phone.html",         the phone source (the activity page)
        "code": "k7m3pq",                   the pinned bucket; minted and written back here when missing
        "requirename": true,                default true
        "after": "s-rules",                 where a new slide goes (first build only)
        "notes": "...",                     speaker notes (replaced on every run when given)
        "assets": "buzz"                    asset names page-/img-/activity-<assets> (default: id minus q-)
      },
      "phone": ["title", "points"],         the keys of this file the PHONE gets
      "title": "Buzz and vote",             everything else is the screen's CONFIG
      "rounds": [...]
    }

Each page carries `/*CONFIG*/null/*CONFIG*/`; the screen's is filled with every
key but "slide" and "phone" (plus "code"), the phone's with only the keys
"phone" lists, so the answers stay on the screen. Then: the deck's font into
the screen (embed_font.py), fitguard, the phone checked against the service's
60 000 characters, the poster shot from the screen in sample mode (the game SDK
injected when the page has <meta name="tessera-game">), and, without
--build-only, the three assets uploaded and the slide created or updated
through slide.py (works on an open deck): a hidden `activity` poll under a
full-bleed embed with keepPollOpen and liveInEditor, logo only. A rerun keeps
the slide, its bucket and the person's wording (`texts`).

Writes (under the config's build/ folder, or --out):
    engage/<assets>-screen.html   the filled screen      fig-<assets>.html   with the font (asset page-<assets>)
    engage/<assets>-phone.html    the filled phone (asset activity-<assets>)
    posters/<assets>.png          the poster (asset img-<assets>)
--build-only never calls slide.py and prints the `## game` spec block for these files.
"""
from __future__ import annotations

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
import legacy  # noqa: E402

REPO = config.REPO
ALPHABET = "abcdefghjkmnpqrtuvwxy346789"      # no look-alikes; no leading s (sessions)
MAX_PHONE = 60_000
CONFIG_RE = re.compile(r"/\*CONFIG\*/.*?/\*CONFIG\*/", re.S)
GAME_META = re.compile(r"<meta[^>]+name=[\"']?(?:tessera-game|" + re.escape(legacy.GAME_META) + r")\b", re.I)
SDK = pathlib.Path(config.get("TESSERA_GAME_SDK") or REPO / "slides" / "src" / "game-sdk.js")


def run(*args):
    r = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(f"FAILED {' '.join(map(str, args))}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def js(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def fill(src: str, cfg: dict | None, what: str) -> str:
    n = len(CONFIG_RE.findall(src))
    if n == 0:
        if cfg:
            sys.exit(f"{what}: no /*CONFIG*/null/*CONFIG*/ placeholder to fill with {sorted(cfg)}")
        return src
    if n > 1:
        sys.exit(f"{what}: {n} /*CONFIG*/ placeholders; one only")
    return CONFIG_RE.sub(lambda m: "/*CONFIG*/" + (js(cfg) if cfg else "null") + "/*CONFIG*/", src)


def mint() -> str:
    return random.choice(ALPHABET) + "".join(random.choice(ALPHABET) for _ in range(5))


def build_dir(cfg_file: pathlib.Path) -> pathlib.Path:
    for p in [cfg_file.parent, *cfg_file.parents]:
        if p.name == "build":
            return p
    return cfg_file.parent


def poster(screen: pathlib.Path, out: pathlib.Path):
    """Shoot the screen in sample mode. The deck injects the SDK into the page; a file
    on its own has none, so a copy with it inlined is shot (none: the page as it is)."""
    html = screen.read_text(encoding="utf-8")
    shot = screen
    if GAME_META.search(html):
        if SDK.exists():
            shot = screen.with_name(screen.stem + ".poster-src.html")
            shot.write_text("<script>" + SDK.read_text(encoding="utf-8") + "</script>" + html,
                            encoding="utf-8", newline="\n")
        else:
            print(f"  ! no game SDK at {SDK}: the poster shows the page without it")
    try:
        run(TOOLS / "shoot.py", shot, "--page", "--size", "1280x720", "--settle", "2.5", "--out", out)
    finally:
        if shot != screen:
            shot.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config")
    ap.add_argument("--deck", help="the deck (its font; without --build-only, the slide goes in)")
    ap.add_argument("--after", help="slide id a NEW slide goes after (else slide.after in the config)")
    ap.add_argument("--build-only", action="store_true", help="pages and poster only, never call slide.py")
    ap.add_argument("--out", help="write under this folder instead of the config's build/")
    a = ap.parse_args()
    cfg_file = pathlib.Path(a.config).resolve()
    raw = json.loads(cfg_file.read_text(encoding="utf-8"))
    S = dict(raw.get("slide") or {})
    sid = S.get("id") or "q-game"
    name = S.get("assets") or re.sub(r"^q-", "", sid)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name):
        sys.exit(f"asset name {name!r}: lower case letters, digits and hyphens")
    for k in ("screen", "phone"):
        if not S.get(k):
            sys.exit(f'{cfg_file.name}: "slide.{k}" is required')
    screen_src = (cfg_file.parent / S["screen"]).resolve()
    phone_src = (cfg_file.parent / S["phone"]).resolve()
    deck = pathlib.Path(a.deck).resolve() if a.deck else None
    if not a.build_only and not deck:
        sys.exit("--deck DECK.html (or --build-only)")
    if deck and not deck.exists():
        sys.exit(f"no deck {deck}")

    # the bucket: the slide's own when it exists (a poll code never changes), else the pinned one
    have = run(TOOLS / "slide.py", "ls", deck) if deck and not a.build_only else ""
    exists = bool(re.search(rf"\s{re.escape(sid)}\s", have))
    code = S.get("code")
    if exists:
        run(TOOLS / "slide.py", "pull", deck, sid)
        cur = json.loads((deck.parent / "build" / "work" / f"{sid}.json").read_text(encoding="utf-8"))
        poll = next((e for e in cur["elements"] if e.get("type") == "poll"), None)
        if poll and poll.get("code") and poll["code"] != code:
            print(f"  note: {sid}'s poll code is {poll['code']}, the config says {code}: keeping {poll['code']}")
            code = poll["code"]
    if not code:
        code = mint()
        raw.setdefault("slide", {})["code"] = code
        cfg_file.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"  minted bucket {code}, pinned in {cfg_file.name}")
    if not re.fullmatch(r"[a-z0-9]{4,12}", code):
        sys.exit(f"bad code {code!r}")

    # the two CONFIGs: the phone gets only the keys "phone" lists
    game = {k: v for k, v in raw.items() if k not in ("slide", "phone")}
    keys = raw.get("phone") or []
    missing = [k for k in keys if k not in game]
    if missing:
        sys.exit(f'"phone" lists keys the config does not have: {missing}')
    screen_cfg = {**game, "code": code}
    phone_cfg = {k: game[k] for k in keys}

    build = pathlib.Path(a.out).resolve() if a.out else build_dir(cfg_file)
    for sub in ("engage", "posters"):
        (build / sub).mkdir(parents=True, exist_ok=True)
    screen = build / "engage" / f"{name}-screen.html"
    phone = build / "engage" / f"{name}-phone.html"
    baked = build / f"fig-{name}.html"
    shot = build / "posters" / f"{name}.png"
    screen.write_text(deckio.recolor(fill(screen_src.read_text(encoding="utf-8"), screen_cfg, screen_src.name), deck), encoding="utf-8", newline="\n")
    body = deckio.recolor(fill(phone_src.read_text(encoding="utf-8"), phone_cfg, phone_src.name), deck)
    if len(body) > MAX_PHONE:
        sys.exit(f"{phone_src.name} filled is {len(body)} characters: the service takes {MAX_PHONE} at most")
    if "url(MANROPE)" in body:
        print("  ! the phone page asks for url(MANROPE): fonts are not inlined into phones (size); use a system stack")
    phone.write_text(body, encoding="utf-8", newline="\n")
    font_src = deck or config.template()
    baked.unlink(missing_ok=True)
    run(TOOLS / "embed_font.py", screen, "--deck", font_src, "-o", baked)
    if not baked.exists():                 # no url(MANROPE) in the page: nothing to inline
        baked.write_text(screen.read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
    run(TOOLS / "fitguard.py", baked)
    poster(baked, shot)
    print(f"built {baked.name} ({len(baked.read_text(encoding='utf-8'))} chars), {phone.name} ({len(body)} chars, "
          f"keys {keys or 'none'}), {shot.name}; bucket {code}")

    question = S.get("question") or S.get("name") or game.get("title") or "Game"
    if a.build_only:
        rel = lambda p: pathlib.Path(p).relative_to(build.parent).as_posix() if build.parent in pathlib.Path(p).parents else str(p)
        print("\nThe spec block (SLIDE_SPEC.md, `## game`):\n")
        print("\n".join(x for x in [
            "## game", f"id: {sid}", f"title: {S.get('name') or question}",
            f"question: {question}" if S.get("question") else "",
            f"screen: {rel(baked)}", f"phone: {rel(phone)}", f"poster: {rel(shot)}", f"code: {code}",
            "requirename: no" if S.get("requirename") is False else "",
            f"notes: {S['notes']}" if S.get("notes") else ""] if x))
        return

    for key, f in ((f"activity-{name}", phone), (f"page-{name}", baked), (f"img-{name}", shot)):
        run(TOOLS / "slide.py", "asset", deck, key, f)
    work = deck.parent / "build" / "work" / f"{sid}.json"
    poll = {"id": "aq-poll", "type": "poll", "x": 72, "y": 150, "w": 400, "h": 400, "rotation": 0, "opacity": 0,
            "question": question, "code": code, "fontSize": 38, "color": deckio.ink(deck),
            "kind": "activity", "activityAsset": f"activity-{name}"}
    if S.get("requirename", True):
        poll["requireName"] = True
    frame = {"id": "em-frame", "type": "embed", "x": 0, "y": 0, "w": 1280, "h": 720, "rotation": 0, "opacity": 1,
             "radius": 0, "asset": f"page-{name}", "poster": f"asset:img-{name}", "liveInEditor": True,
             "keepPollOpen": True}
    if exists:
        slide = json.loads(work.read_text(encoding="utf-8"))
        for e in slide["elements"]:
            if e.get("id") == "aq-poll":
                for k in ("question", "activityAsset"):
                    e[k] = poll[k]
                if poll.get("requireName"):
                    e["requireName"] = True
                else:
                    e.pop("requireName", None)
            elif e.get("id") == "em-frame":
                for k in ("asset", "poster", "liveInEditor", "keepPollOpen"):
                    e[k] = frame[k]            # `texts` (the person's wording) stays
        if S.get("notes"):
            slide["notes"] = S["notes"]
        work.write_text(json.dumps(slide, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
        run(TOOLS / "slide.py", "push", deck, sid)
        print("updated", sid, "bucket", code)
        return
    after = a.after or S.get("after")
    layout = deckio.layout_id(deckio.load(deck), "content")
    if not layout:
        sys.exit(f"{deck.name} has no content layout")
    args = [TOOLS / "slide.py", "new", deck, "--layout", layout, "--id", sid,
            "--name", S.get("name") or question]
    if after:
        args += ["--after", after]
    run(*args)
    run(TOOLS / "slide.py", "pull", deck, sid)
    slide = json.loads(work.read_text(encoding="utf-8"))
    logo = [e for e in slide["elements"] if e.get("id") == "logo"]   # no footer or page number: the controls sit there
    slide["elements"] = [poll, frame] + logo
    slide["notes"] = S.get("notes") or slide.get("notes") or ""
    slide["transition"] = "fade"
    slide["background"] = "#FFFFFF"
    work.write_text(json.dumps(slide, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    run(TOOLS / "slide.py", "push", deck, sid)
    print("created", sid, "bucket", code)


if __name__ == "__main__":
    main()
