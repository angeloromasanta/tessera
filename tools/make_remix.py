"""Interactive title: the room checks in on their phones, then rewrites the slide with an AI.

    python tools/make_remix.py DECK_DIR/build/remix.json --deck DECK.html [--build-only]
        [--course NAME] [--lecturer NAME] [--email-label TEXT] [--email-placeholder TEXT]
        [--logo-asset NAME=ASSET ...] [--logo-text TEXT] [--font-asset FAMILY=ASSET]

The title and subtitle are locked: the screen draws them as one compact left column (logo,
title, rule, name, and the QR card right under them), on white plates above the slide
the model edits, so no idea can remove or restyle them. Right of x 330 is the room's.
Under the slide runs a base page (`base`: a deck's own cover figure, e.g. the swarm), and
the seed slide is transparent with one invitation line, so the first version looks like
the deck's title slide.

One slide: a hidden `activity` poll (question "Interactive title ...") under a full-bleed
1280x720 embed. The screen (template remix.html) shows the slide itself, drawn from HTML
that a model rewrites, plus a QR card with the check-in count. The phone (template
remix-phone.html) checks the student in (full name and email: the attendance) and then
takes ideas for the slide. The presenting screen batches the ideas and sends them to
POST /api/remix (lecturer key), where a model rewrites the slide; HTML and CSS only, never
blank. See the comments at the top of the two templates (kit/engage/) and
server/poll-worker/src/api/remix.js (its REMIX_STYLE tells the model which fonts and
logos the slide may use: name them the same here).

remix.json (one object):

    {"slide": "title",                               # the slide to arm or create
     "title": "My course",                           # the locked title (HTML: <br> only; one short line fits)
     "subtitle": "The presenter",                    # the name; {{date}} = the day the slide is shown
     "eyebrow": "My course · Session 1",             # the phone's top line
     "base": {"deck": "../1_Lecture.html",           # optional: the live cover under the slide,
              "asset": "page-cover",                 #   a page asset of that deck (path from this json)
              "poster": "img-cover-poster"}}         #   and its still, for the phone's preview

Defaults for what remix.json leaves out: --course (the title and the phone's top line;
otherwise "Welcome" and "Check in"), --lecturer (the subtitle; otherwise {{date}}). The
look: --logo-asset NAME=ASSET (repeatable) puts a template asset in the page as the logo
NAME (the model writes <img src="logo:NAME">; the first one is drawn on the locked
column), --logo-text the wordmark of the phone's preview, --font-asset FAMILY=ASSET the
title face (a font asset of the template, declared as FAMILY), --email-label and
--email-placeholder the check-in field. With none of them: no logo, the title in Manrope.

Attendance: ⋯ > Export answers (Excel), or `slide.py poll export`. Each check-in is a row
with the name, and the text {"t":"in","name","email"}. Clear the responses before the
next group: that also puts the slide back to the original.

Writes build/figures/remix-ID.html, build/engage/remix-ID-phone.html and the poster;
with --deck it uploads page-remix-ID, img-remix-ID, activity-remix-ID and arms the slide
(keeps its bucket on a re-run). Works on an open deck (it only uses slide.py).
"""
import argparse
import base64
import html
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

HERE = config.REPO / "kit" / "engage"     # the page templates
ALPHABET = "abcdefghjkmnpqrtuvwxy346789"
POLL_ID = "remix-poll"
QUESTION = "Interactive title"            # remix.html reads the poll only when its question starts with this
NOTES = ("Interactive title. Scan the QR: phones check in (full name and email: this is the attendance), then "
         "send ideas to improve this slide. The screen sends them in batches to Claude Haiku, which rewrites the "
         "slide live (HTML and CSS only; a version that would leave it blank is refused). Needs present mode and "
         "the lecturer key. Click into the slide, then P pauses, U undoes, R twice resets to the original; the "
         "same buttons appear top right on hover. The bars along the bottom are the versions: click one (or [ and ]) "
         "to show an earlier version, view only, applying waits; the last bar or L goes back to live. Attendance: Export, Export answers (Excel). Clear the "
         "answers (Export, Clear answers) before the next group: that also resets the slide.")

SEED = """<!doctype html>
<html><head><style>
body{margin:0;width:1280px;height:720px;color:#0D2A2F;font-family:Manrope,sans-serif;position:relative;overflow:hidden}
.ask{position:absolute;left:40px;top:652px;width:270px;margin:0;text-align:center;font-weight:800;font-size:22px;line-height:1.3;color:#0F6B73}
</style></head><body>
<p class="ask">Improve this slide.</p>
</body></html>"""


def js_json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=1).replace("<", "\\u003c")


def run(*args):
    r = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(f"FAILED {' '.join(map(str, args))}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def deck_assets(deck):
    a = deckio.load(deck)["assets"]

    def val(k):
        if k not in a:
            sys.exit(f"{pathlib.Path(deck).name} has no asset {k}")
        return a[k] if isinstance(a[k], str) else (a[k].get("src") or a[k].get("data") or a[k].get("url"))
    return val


def pairs(values, flag):
    out = []
    for v in values or []:
        name, eq, key = v.partition("=")
        if not eq or not name.strip() or not key.strip():
            sys.exit(f"{flag} {v!r}: expected NAME=ASSET")
        out.append((name.strip(), key.strip()))
    return out


def template_assets(a):
    """The title face and the logos the flags name, as data URIs, from the template."""
    logos, font = {}, None
    wanted = pairs(a.logo_asset, "--logo-asset")
    face = pairs([a.font_asset] if a.font_asset else [], "--font-asset")
    if wanted or face:
        get = deck_assets(config.template())
        logos = {name: get(key) for name, key in wanted}
        if face:
            font = (face[0][0], get(face[0][1]))
    return font, logos


def content_layout(deck):
    """The deck's `content` layout (any template: id `content` or `<prefix>-content`)."""
    lid = deckio.layout_id(deckio.load(deck), "content")
    if not lid:
        sys.exit(f"{pathlib.Path(deck).name} has no content layout")
    return lid


def small_jpeg(data_uri, width=480):
    """A data URI still, shrunk to a small JPEG data URI (the phone page has a 60 000 character cap)."""
    import io
    from PIL import Image
    raw = base64.b64decode(data_uri.split(",", 1)[1])
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=62, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def fonts_css(font):
    lab = (HERE / "lab.html").read_text(encoding="utf-8")
    manrope = re.search(r"@font-face\{font-family:Manrope;[^}]*\}", lab).group(0)
    if not font:
        return manrope
    family, uri = font
    return f"@font-face{{font-family:{family};font-weight:400;src:url({uri})}}\n{manrope}"


def safe_title(t):
    """Text with <br> only: everything else escaped."""
    parts = re.split(r"<br\s*/?>", str(t), flags=re.I)
    return "<br>".join(html.escape(p, quote=False) for p in parts)


def fill(template, cfg, fonts=None, title_font=None):
    src = (HERE / template).read_text(encoding="utf-8")
    out, n = re.subn(r"/\*CONFIG\*/.*?/\*END\*/", lambda m: "/*CONFIG*/" + js_json(cfg) + "/*END*/", src, flags=re.S)
    assert n == 1, f"{template}: no single /*CONFIG*/ block"
    if fonts is not None:
        out = out.replace("/*FONTS*/", fonts, 1)
    out = out.replace("/*TITLEFONT*/", f"{title_font}," if title_font else "", 1)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config")
    ap.add_argument("--deck")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--course", default="", help="default title and phone top line (remix.json title / eyebrow win)")
    ap.add_argument("--lecturer", default="", help="default subtitle (remix.json subtitle wins; else {{date}})")
    ap.add_argument("--email-label", default="", help='label of the check-in email field (default "Email")')
    ap.add_argument("--email-placeholder", default="", help='its placeholder (default "name@example.com")')
    ap.add_argument("--logo-asset", action="append", metavar="NAME=ASSET",
                    help="a template asset offered as logo NAME (repeatable; the first is drawn)")
    ap.add_argument("--logo-text", default="", help="wordmark in the phone preview's logo plate (default: no plate)")
    ap.add_argument("--font-asset", metavar="FAMILY=ASSET", help="title face: a template font asset, declared as FAMILY")
    a = ap.parse_args()
    cfile = pathlib.Path(a.config).resolve()
    cfg = json.loads(cfile.read_text(encoding="utf-8"))
    build = cfile.parent
    for sub in ("figures", "engage", "posters"):
        (build / sub).mkdir(parents=True, exist_ok=True)
    sid = cfg.get("slide") or "title"
    rid = re.sub(r"[^a-z0-9-]", "", sid.lower()) or "title"

    font, logos = template_assets(a)
    seed = SEED
    # the title and the name are locked: the screen draws them over the slide, the model never sees them
    lock = {"title": safe_title(cfg.get("title", a.course or "Welcome")),
            "subtitle": safe_title(cfg.get("subtitle", a.lecturer or "{{date}}"))}
    base, still = "", ""
    if cfg.get("base"):
        get = deck_assets(cfile.parent / cfg["base"]["deck"])
        base = get(cfg["base"]["asset"])
        if cfg["base"].get("poster"):
            still = small_jpeg(get(cfg["base"]["poster"]))
    fig = build / "figures" / f"remix-{rid}.html"
    phone = build / "engage" / f"remix-{rid}-phone.html"
    fig.write_text(deckio.recolor(fill("remix.html", {"seed": seed, "base": base, "lock": lock, "logos": logos,
                                       "sample": {"in": 47, "ideas": 23, "versions": 7}},
                        fonts_css(font), font[0] if font else None), a.deck),
                   encoding="utf-8", newline="\n")
    ptext = (HERE / "remix-phone.html").read_text(encoding="utf-8")
    eyebrow = cfg.get("eyebrow") or a.course
    if eyebrow:
        ptext = re.sub(r'<div id="eyebrow">[^<]*</div>', lambda m: f'<div id="eyebrow">{html.escape(eyebrow)}</div>',
                       ptext, count=1)
    if a.email_label:
        ptext = ptext.replace('<label for="em">Email</label>', f'<label for="em">{html.escape(a.email_label)}</label>', 1)
    if a.email_placeholder:
        ptext = ptext.replace('placeholder="name@example.com"', f'placeholder="{html.escape(a.email_placeholder)}"', 1)
    ptext, n = re.subn(r"/\*MARK\*/.*?/\*ENDMARK\*/", lambda m: "/*MARK*/" + js_json(a.logo_text) + "/*ENDMARK*/",
                       ptext, flags=re.S)
    assert n == 1, "remix-phone.html: no single /*MARK*/ block"
    ptext, n = re.subn(r"/\*LOCK\*/.*?/\*ENDLOCK\*/", lambda m: "/*LOCK*/" + js_json(lock) + "/*ENDLOCK*/", ptext, flags=re.S)
    assert n == 1, "remix-phone.html: no single /*LOCK*/ block"
    if still:
        ptext = re.sub(r"(#preview\{[^}]*?)background:#fff\}", lambda m: f"{m.group(1)}background:#fff url({still}) center/cover}}", ptext, count=1)
    ptext = deckio.recolor(ptext, a.deck)
    phone.write_text(ptext, encoding="utf-8", newline="\n")
    if len(ptext) > 60000:
        sys.exit(f"{phone.name} is over the 60 000 character limit of an activity page")
    poster = build / "posters" / f"remix-{rid}.png"
    run(TOOLS / "shoot.py", fig, "--page", "--size", "1280x720", "--settle", "2", "--out", poster)
    if a.build_only or not a.deck:
        print("built", fig.name, phone.name, poster.name)
        return

    deck = pathlib.Path(a.deck).resolve()
    run(TOOLS / "slide.py", "asset", deck, f"page-remix-{rid}", fig)
    run(TOOLS / "slide.py", "asset", deck, f"img-remix-{rid}", poster)
    run(TOOLS / "slide.py", "asset", deck, f"activity-remix-{rid}", phone)
    have = run(TOOLS / "slide.py", "ls", deck)
    if not re.search(rf"(?<![\w-]){re.escape(sid)}(?![\w-])", have):
        run(TOOLS / "slide.py", "new", deck, "--layout", content_layout(deck), "--id", sid, "--name", "Interactive title")
    run(TOOLS / "slide.py", "pull", deck, sid)
    work = deck.parent / "build" / "work" / f"{sid}.json"
    slide = json.loads(work.read_text(encoding="utf-8"))
    old = next((e for e in slide["elements"] if e.get("type") == "poll"), None)
    if old and not str(old.get("question", "")).startswith(QUESTION):
        sys.exit(f"{sid} already has a poll that is not an interactive title ({old.get('id')}); not touching it")
    code = old["code"] if old else "".join(random.choice(ALPHABET) for _ in range(6))
    poll = {"id": old["id"] if old else POLL_ID, "type": "poll", "x": 72, "y": 160, "w": 400, "h": 400, "rotation": 0,
            "opacity": 0, "question": f"{QUESTION}: check in and improve this slide", "code": code, "fontSize": 38,
            "color": deckio.ink(deck), "kind": "activity", "activityAsset": f"activity-remix-{rid}"}
    emb = next((e for e in slide["elements"] if e.get("type") == "embed"), None)
    embed = {**(emb or {}), "id": emb["id"] if emb else "em-remix", "type": "embed", "x": 0, "y": 0, "w": 1280, "h": 720,
             "rotation": 0, "opacity": 1, "radius": 0, "asset": f"page-remix-{rid}", "poster": f"asset:img-remix-{rid}",
             "liveInEditor": False, "keepPollOpen": True}
    embed.pop("devSrc", None)      # live only in present mode: one screen runs the queue, never the editor too
    slide["elements"] = [poll, embed]          # the embed draws everything, logo included
    slide["notes"] = NOTES
    slide["name"] = "Interactive title"
    slide["background"] = "#FFFFFF"
    work.write_text(json.dumps(slide, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    run(TOOLS / "slide.py", "push", deck, sid)
    print("armed", sid, "bucket", code, "(kept)" if old else "(new)")


if __name__ == "__main__":
    main()
