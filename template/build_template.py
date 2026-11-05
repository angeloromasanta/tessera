"""Build template.html: the neutral template every tool defaults to.

    python template/build_template.py                      # refresh template.html in place
    python template/build_template.py --source BRAND.html [--strip STRIP.json]  # first build, from a branded template
    python template/build_template.py --no-posters         # skip re-shooting the embed posters

`template.html` (one level up) is the SOURCE of the template, the way any
deck is its own source: edit it with slide.py or by splicing its JSON, and
re-run this script only to re-apply the pieces it owns. A run:

 1. reads --source (default ../template.html) and, if it still carries a
    brand (layout ids with a brand prefix, a non-free title face, logo
    images), strips it ONCE: neutral layout ids (`title`, `points`, ...) and
    slide ids (`sl-<role>`), Fraunces titles and Manrope body (both SIL OFL,
    from scripts/brand-fonts/), a text wordmark where a logo image was, the
    palette of template/palette.py, generic copy, no course-specific slides,
    an empty poll service, fresh poll codes, a fresh docId and template:true.
    On an already-neutral file every step of this is a no-op;
 2. splices the figures (splice_template.py with template/splice.json): the
    swarm title, the live hive and hive matrix with their INVENTED sample
    answers (template/data/), the worked figure slides from kit/figures/examples;
 3. with --engage, rebuilds the lab and game pages from kit/engage (the
    engine's make_lab.py / make_game.py) in the template's colours;
 4. re-shoots every embed poster (posters.py);
 5. stamps the in-document agent briefing (scripts/stamp-agent-notes.mjs with
    scripts/template-agent-notes.mjs).

The document block is rewritten in place inside the source file's own app
shell (the bytes outside the block are kept); re-host on a newer shell with
`node scripts/upgrade-deck.mjs template.html`. Writes template.html.bak first.
"""
import argparse
import base64
import datetime as dt
import json
import random
import re
import subprocess
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import palette as P  # noqa: E402
from splice_template import (CODE_ALPHABET, Splice, load_config, read_doc, wordmark,  # noqa: E402
                             write_doc)

FONTS = ROOT / "scripts" / "brand-fonts"
TITLE_FONTS = [
    {"family": P.TITLE_FAMILY, "asset": "title-font-latin", "file": "Fraunces-latin.woff2", "weight": "300 700",
     "unicodeRange": "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
                     "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"},
    {"family": P.TITLE_FAMILY, "asset": "title-font-latin-ext", "file": "Fraunces-latin-ext.woff2", "weight": "300 700",
     "unicodeRange": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,"
                     "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"},
]
FREE_FAMILIES = {P.TITLE_FAMILY, P.TEXT_FAMILY}

# What a strip may need from its source, beyond the generic steps: slides to drop,
# ids that do not follow <prefix>-<role>, copy to rewrite (applied to every string of
# slides and layouts) and regex rewrites inside embedded pages. A source's own
# values come from --strip FILE.json (keys: drop_slides, slide_ids, role_fix, copy,
# page_scrub); a source without such a file gets only the generic steps.
STRIP = {"drop_slides": [], "slide_ids": {}, "role_fix": {}, "copy": [], "page_scrub": []}
PALETTE_CARDS = [   # pa-n / pa-x / pa-u per card, after the swatches are re-coloured
    ("Deep", P.HEX["navy"], "Title &amp; section backgrounds, dark fills."),
    ("Accent", P.HEX["accent"], "Slide titles, headings, statement slides."),
    ("Band", P.HEX["band"], "Diagonal band on section and hero slides."),
] + [(f"Chart {i + 1} — {n}", P.CHART[i], u) for i, (n, u) in enumerate(zip(P.CHART_NAMES, [
    "Categorical chart series 1.", "Series 2; also negative / warning values.", "Categorical chart series 3.",
    "Series 4; also positive values.", "Categorical chart series 5.", "Series 6; also highlights / callouts."]))]
PALETTE_NOTES = {
    "pa-note1": "<b>Wordmark</b><br>Top-left on every slide: an empty text box (id logo). Type a name there, "
                "or put an image under the same id.",
    "pa-note2": "<b>Body &amp; titles</b><br>Titles in Fraunces, body copy in Manrope — both embedded in this file "
                "(SIL OFL). Titles in the accent, body in ink.",
    "pa-note3": f"<b>Footers</b><br>Small grey ({P.HEX['muted']}) for footer text and page numbers, bottom corners.",
}
HOWTO_NOTES = (
    "How this template works and what it can do. Point 1: this whole file is one HTML document that IS the editor "
    "— open the folder in an AI coding agent and ask for changes in plain words (\"add a slide about X\", \"turn "
    "this into a chart\", \"make the title bigger\"); it edits the deck's own JSON directly, no build step, no "
    "export. Point 2: audience engagement — ask for a poll, quiz, rating or word cloud and the room answers on "
    "their phones live while you present, right there on the slide. Point 3: animated infographics — ask for an "
    "animated or interactive figure (a hype cycle, an adoption curve, a simulation) and it builds a self-contained "
    "figure that steps forward on click, like the ones later in this deck."
)

def new_code(n=6) -> str:
    return "".join(random.SystemRandom().choice(CODE_ALPHABET) for _ in range(n))


def b64(path: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def walk_strings(o, fn):
    if isinstance(o, dict):
        return {k: walk_strings(v, fn) for k, v in o.items()}
    if isinstance(o, list):
        return [walk_strings(v, fn) for v in o]
    return fn(o) if isinstance(o, str) else o


def is_branded(doc: dict) -> bool:
    """A brand prefix on the layout ids, or a title face that is not one of the free ones."""
    fams = {f.get("family") for f in doc.get("fonts", [])}
    return bool(fams - FREE_FAMILIES) or any(l["id"].endswith("-title") for l in doc.get("layouts", []))


def prune_assets(doc: dict) -> list[str]:
    """Delete every asset nothing points at (old fonts, logos, unused pages and posters)."""
    used = {f["asset"] for f in doc.get("fonts", [])}
    blob = json.dumps([doc["slides"], doc["layouts"]], ensure_ascii=False)
    used |= set(re.findall(r'asset:([\w.-]+)', blob))
    used |= set(re.findall(r'"(?:asset|activityAsset)":\s*"([^"]+)"', blob))
    gone = [k for k in doc["assets"] if k not in used]
    for k in gone:
        del doc["assets"][k]
    return gone


def strip_brand(doc: dict) -> list[str]:
    log = []
    # brand prefix: the title layout is "<prefix>title"
    tl = next((l["id"] for l in doc["layouts"] if l["id"].endswith("title")), "title")
    prefix = tl[: -len("title")]
    old_fams = {f.get("family") for f in doc.get("fonts", [])} - FREE_FAMILIES

    doc["slides"] = [s for s in doc["slides"] if s["id"] not in set(STRIP["drop_slides"])]
    log.append(f"dropped slides {sorted(STRIP['drop_slides'])}")

    # ids
    def slide_id(i):
        if i in STRIP["slide_ids"]:
            return STRIP["slide_ids"][i]
        if prefix and i.startswith(f"sl-{prefix}"):
            i = "sl-" + i[len(f"sl-{prefix}"):]
        return STRIP["role_fix"].get(i, i)
    ids = {s["id"]: slide_id(s["id"]) for s in doc["slides"]}
    for s in doc["slides"]:
        s["id"] = ids[s["id"]]
        if s.get("stateOf") in ids:
            s["stateOf"] = ids[s["stateOf"]]
        for e in s["elements"]:
            if e.get("link") in ids:
                e["link"] = ids[e["link"]]
    for l in doc["layouts"]:
        if prefix and l["id"].startswith(prefix):
            l["id"] = l["id"][len(prefix):]
    log.append(f"layout prefix {prefix!r} removed, {len(ids)} slide ids neutral")

    def text(s: str) -> str:
        for old, new in sorted(ids.items(), key=lambda kv: -len(kv[0])):
            if old != new:
                s = s.replace(old, new)
        for old, new in STRIP["copy"]:
            s = s.replace(old, new)
        return s

    # elements
    logos = {f"asset:{k}" for k in doc["assets"] if "logo" in k}
    for s in doc["slides"] + doc["layouts"]:
        out = []
        for e in s["elements"]:
            fam = (e.get("fontFamily") or "").split(",")[0].strip().strip("'\"")
            if fam in old_fams:
                e["fontFamily"] = P.TITLE_FONT
            elif e.get("fontFamily") and fam != P.TITLE_FAMILY and fam not in ("Georgia", "ui-monospace"):
                e["fontFamily"] = P.TEXT_FONT
            if e.get("type") == "image" and e.get("src") in logos:
                dark = "white" in e["src"]
                w = wordmark(e["x"], e["y"], max(e["w"], 240), e["h"], "#FFFFFF" if dark else P.HEX["ink"])
                if e.get("fx"):
                    w["fx"] = e["fx"]
                e = w
            if e["id"] == "se-tagline":
                e["html"], e["placeholder"] = "", "Tagline"
            out.append(e)
        s["elements"] = out
    for coll in ("slides", "layouts"):
        doc[coll] = walk_strings(doc[coll], text)
        doc[coll] = json.loads(P.retoken(json.dumps(doc[coll], ensure_ascii=False)))
    log.append("fonts, logos, copy and colours of every element neutral")

    # worked slides whose text is about the palette or the template itself
    for s in doc["slides"] + doc["layouts"]:
        by = {e["id"]: e for e in s["elements"]}
        if "pa-n1" in by:
            for i, (n, x, u) in enumerate(PALETTE_CARDS, 1):
                by[f"pa-n{i}"]["html"], by[f"pa-x{i}"]["html"], by[f"pa-u{i}"]["html"] = n, x, u
                by[f"pa-sw{i}"]["fill"] = x
            for k, v in PALETTE_NOTES.items():
                if k in by:
                    by[k]["html"] = v
        if "ch-bar1" in by:   # bars listed Category 6 .. Category 1
            for i in range(1, 7):
                by[f"ch-bar{i}"]["fill"] = P.CHART[6 - i]
        if s.get("id") == "sl-howto":
            s["notes"] = HOWTO_NOTES

    # pages: drop the unused, neutralise the rest (colours, wording)
    for k, v in list(doc["assets"].items()):
        if v.startswith("data:"):
            continue
        v = P.retoken(v)
        for pat, rep in STRIP["page_scrub"]:
            v = re.sub(pat, rep, v)
        doc["assets"][k] = v

    # fonts: the free title face replaces the brand's
    for f in TITLE_FONTS:
        doc["assets"][f["asset"]] = b64(FONTS / f["file"], "font/woff2")
    doc["fonts"] = [{k: v for k, v in f.items() if k != "file"} for f in TITLE_FONTS] + \
                   [f for f in doc["fonts"] if f.get("family") == P.TEXT_FAMILY]
    for f in doc["fonts"]:
        if f["family"] == P.TEXT_FAMILY:
            f["weight"] = "200 800"

    # identity: neutral, empty service, fresh codes, a template
    doc["title"] = "Slide Template"
    doc["meta"] = {"author": "", "company": "", "subject": "Presentation template",
                   "keywords": "template, slides"}
    doc["theme"] = json.loads(json.dumps(P.THEME))
    doc["poll"] = {"session": "s" + new_code(), "service": ""}
    doc.pop("blobs", None)
    doc["docId"] = str(uuid.uuid4())
    doc["template"] = True
    remint(doc)
    log.append(f"pruned unused assets {prune_assets(doc)}")
    log.append("meta, theme, poll service, codes, docId, template:true")
    return log


def remint(doc: dict) -> None:
    """A fresh code for every poll; a page that pins its poll's code follows it."""
    for s in doc["slides"]:
        for e in s["elements"]:
            if e.get("type") != "poll":
                continue
            old, e["code"] = e.get("code"), new_code()
            for el in s["elements"]:
                key = el.get("asset")
                if old and key and old in doc["assets"].get(key, ""):
                    doc["assets"][key] = doc["assets"][key].replace(f'"code":"{old}"', f'"code":"{e["code"]}"')


TEXT_FONTS = {"text-font-latin": "Manrope-latin.woff2", "text-font-latin-ext": "Manrope-latin-ext.woff2"}


def sync_fonts(doc: dict) -> list[str]:
    """Make every embedded copy of the template's fonts the bytes in scripts/brand-fonts/
    (the asset itself and each figure page that inlined it as a data URI)."""
    files = {f["asset"]: f["file"] for f in TITLE_FONTS} | TEXT_FONTS
    changed = []
    for key, name in files.items():
        new = b64(FONTS / name, "font/woff2")
        old = doc["assets"].get(key)
        if old == new or old is None:
            continue
        for k, v in doc["assets"].items():
            if k != key and not v.startswith("data:") and old in v:
                doc["assets"][k] = v.replace(old, new)
        doc["assets"][key] = new
        changed.append(key)
    return changed


def rebuild_engage(doc: dict, out: Path) -> list[str]:
    """Rebuild the lab and game pages from kit/engage with their own tools (--build-only),
    re-coloured to the palette, and put them in place of the ones in the file. Their
    posters are re-shot by posters.py afterwards."""
    build = HERE / "build" / "engage"
    tools = ROOT / "tools"
    done = []
    text_font = doc["assets"]["text-font-latin"]

    def own(page: str) -> str:
        # a tool may inline a Manrope of its own: use the template's (it carries the licence)
        page = re.sub(r"(@font-face\{font-family:\s*'?Manrope'?[^}]*?url\()data:font/woff2;base64,[A-Za-z0-9+/=]+",
                      lambda m: m.group(1) + text_font, page)
        return P.retoken(page)

    run = lambda *a: subprocess.run([sys.executable, *map(str, a)], check=True, capture_output=True, text=True)
    run(tools / "make_lab.py", HERE / "lab.json", "--deck", out, "--build-only", "--out", build / "lab")
    for lab in json.loads((HERE / "lab.json").read_text(encoding="utf-8")):
        lid = lab["id"]
        pages = {f"page-lab-{lid}": build / "lab" / "figures" / f"lab-{lid}.html",
                 f"activity-lab-{lid}": build / "lab" / "engage" / f"lab-{lid}-phone.html"}
        for key, src in pages.items():
            doc["assets"][key] = own(src.read_text(encoding="utf-8"))
            done.append(key)
    for cfg_file in sorted((HERE / "games").glob("*.json")):
        name = json.loads(cfg_file.read_text(encoding="utf-8"))["slide"]["assets"]
        run(tools / "make_game.py", cfg_file, "--deck", out, "--build-only", "--out", build / "games")
        pages = {f"page-{name}": build / "games" / f"fig-{name}.html",
                 f"activity-{name}": build / "games" / "engage" / f"{name}-phone.html"}
        for key, src in pages.items():
            doc["assets"][key] = own(src.read_text(encoding="utf-8"))
            done.append(key)
    return done


def ensure_posters(cfg: dict) -> None:
    """splice_template reads its three posters from template/media/posters; on a first
    build they do not exist yet, so a blank stands in until posters.py shoots them."""
    blank = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X8nVYAAAAASUVORK5CYII=")
    for k in ("swarm", "hive", "matrix"):
        p = ROOT / cfg[k]["poster"]
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(blank)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=str(ROOT / "template.html"))
    ap.add_argument("--out", default=str(ROOT / "template.html"))
    ap.add_argument("--config", default=str(HERE / "splice.json"))
    ap.add_argument("--strip", help="JSON with the source's own strip inputs (see STRIP)")
    ap.add_argument("--no-posters", action="store_true")
    ap.add_argument("--no-stamp", action="store_true")
    ap.add_argument("--engage", action="store_true",
                    help="also rebuild the lab and game pages from kit/engage (tools/make_lab.py, make_game.py)")
    a = ap.parse_args()
    src, out = Path(a.source), Path(a.out)
    raw, m, doc = read_doc(src)
    if "tessera-doc" in m.group(1):
        doc["format"] = "tessera/slides"   # a file on the renamed shell: the new format name
    if a.strip:
        STRIP.update(json.loads(Path(a.strip).read_text(encoding="utf-8")))
    if is_branded(doc):
        for line in strip_brand(doc):
            print("strip:", line)
    print("fonts synced:", sync_fonts(doc) or "none changed")
    cfg = load_config(Path(a.config))
    ensure_posters(cfg)
    print("splice:", Splice(cfg, Path(a.config).parent).run(doc))
    doc["modified"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    write_doc(out, raw, m, doc, backup=out.exists())
    print(f"wrote {out}")
    if a.engage:
        raw, m, doc = read_doc(out)
        print("engage pages rebuilt:", rebuild_engage(doc, out))
        write_doc(out, raw, m, doc, backup=False)
    if not a.no_posters:
        subprocess.run([sys.executable, str(HERE / "posters.py"), "--template", str(out)], check=True)
        # the splice embeds the three posters it reads from disk: re-splice with the fresh ones
        raw, m, doc = read_doc(out)
        Splice(cfg, Path(a.config).parent).run(doc)
        write_doc(out, raw, m, doc, backup=False)
    if not a.no_stamp:
        subprocess.run(["node", str(ROOT / "scripts" / "stamp-agent-notes.mjs"), str(out)], check=True)


if __name__ == "__main__":
    main()
