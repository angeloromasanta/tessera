"""Splice the template's figures into its HTML: the swarm title, the live hive, the hive
matrix and the worked embed slides.

    python template/splice_template.py                         # template.html, template/splice.json
    python template/splice_template.py --config FILE.json      # another template (e.g. a private brand kit)
    python template/splice_template.py --template COPY.html    # a dry run on a copy

Idempotent: re-running replaces what an earlier run put in. Run it after
changing a figure source. Not while the template is open in the editor (push
the pages with `slide.py asset` then). Writes TEMPLATE.bak beside the file.

Everything brand- or file-specific comes from the config (default
template/splice.json, paths relative to the repository root, or to the config
file itself when it says "paths": "config"):

  template      the HTML to splice into
  prefix        layout ids are `<prefix>title`, slide ids `sl-<prefix>title`,
                `sl-<prefix>poll`, `sl-<prefix>poll-hive`, `sl-<prefix>poll-matrix`
  title_font    the title element's font-family (the text font is the deck's
                own Manrope); navy: the cover text colour
  logo          an image asset key for the cover's logo, or null for a text
                wordmark (an empty text box with the placeholder "Wordmark")
  retoken       true: every spliced page is re-coloured to template/palette.py
  examples      folders searched in order for `@examples/<file>` sources
  swarm         {page, poster}; hive / matrix: {page, sample, poster} -- `sample`
                (a JSON of answers) is baked into the page's `const SAMPLE=null;`
                line; with no sample the page is used as it is (already built)
  figures       {asset key: source}: the worked embed slides; `url(MANROPE)` in a
                source becomes the template's own Manrope (as embed_font.py does)
  scrub         [[regex, replacement], ...] applied to every spliced page
  title_notes, hive_notes, matrix_notes   speaker notes of those slides (optional)

The hive's page has CONFIG.code emptied, so it reads the nearest poll at or
before its slide through the embed API's `poll.previous` -- the poll element
hidden beneath it (`aq-poll`). Template instantiation remints poll codes, so a
pinned code would read an empty bucket. The sample answers show only while the
poll question is still PLACEHOLDER; a deck that writes its own question gets
the live page. Every figure slide's notes end with EDIT_HINT.
"""
import argparse
import base64
import json
import random
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from palette import TEXT_FONT, retoken  # noqa: E402

PLACEHOLDER = "Your open question"          # shared with the hive pages' sample mode
MATRIX_AXES = [["Automation", "Augmentation"], ["Use", "Build"]]   # what the sample scores were rated on
EDIT_HINT = ("Double-click any label in the figure to reword it; "
             "your wording is kept when the figure is rebuilt.")
sys.path.insert(0, str(ROOT / "tools"))
import legacy  # noqa: E402  (old names: decks written before the rename)
BLOCK = re.compile(r'(<script type="(?:application/tessera\+json|%s)" id="(?:tessera-doc|%s)">)(.*?)(</script>)'
                   % (re.escape(legacy.DOC_TYPE), re.escape(legacy.DOC_ID)), re.S)
CODE_ALPHABET = "abcdefghjkmnpqrtuvwxy346789"   # slides/src/model.ts


def valid_code(code) -> bool:
    return isinstance(code, str) and len(code) >= 4 and all(c in CODE_ALPHABET for c in code)


def new_code() -> str:
    return "".join(random.SystemRandom().choice(CODE_ALPHABET) for _ in range(6))


def data_uri(path: Path) -> str:
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}[path.suffix.lower()]
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def compact(o) -> str:
    return json.dumps(o, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def text_font(doc: dict) -> str:
    """The template's Manrope woff2 (Latin subset first), as a data URI -- embed_font.py's choice."""
    fonts = sorted((f for f in doc.get("fonts", []) if f.get("family") == "Manrope"),
                   key=lambda f: "latin-ext" in f["asset"])
    if not fonts:
        raise SystemExit("template: no Manrope font in doc.fonts")
    return doc["assets"][fonts[0]["asset"]]


class Splice:
    def __init__(self, cfg: dict, cfg_dir: Path):
        self.cfg = cfg
        self.dir = cfg_dir

    def path(self, p: str) -> Path:
        if p.startswith("@examples/"):
            name = p.split("/", 1)[1]
            for d in self.cfg.get("examples", []):
                cand = self.path(d) / name
                if cand.exists():
                    return cand
            raise SystemExit(f"{name}: not in any of the example folders {self.cfg.get('examples')}")
        q = Path(p)
        base = self.dir if self.cfg.get("paths") == "config" else ROOT
        return q if q.is_absolute() else (base / q)

    def finish(self, page: str, font: str) -> str:
        page = page.replace("url(MANROPE)", f"url({font})")
        if self.cfg.get("retoken"):
            page = retoken(page)
        for pat, rep in self.cfg.get("scrub", []):
            page = re.sub(pat, rep, page)
        return page

    def baked(self, spec: dict, font: str, kind: str) -> str:
        page = self.path(spec["page"]).read_text(encoding="utf-8")
        if spec.get("sample"):
            sample = json.loads(self.path(spec["sample"]).read_text(encoding="utf-8"))
            sample["placeholder"] = PLACEHOLDER
            if kind == "matrix":
                sample["axes"] = MATRIX_AXES
            page, n = re.subn(r"^const SAMPLE=null;.*$", lambda m: f"const SAMPLE={compact(sample)};",
                              page, count=1, flags=re.M)
            if n != 1:
                raise SystemExit(f"{spec['page']}: `const SAMPLE=null;` line missing")
        if kind == "hive":
            page, n1 = re.subn(r"code:'[^']*',", "code:'',", page, count=1)
            page, n2 = re.subn(r"eyebrow:'[^']*',", "eyebrow:'OPEN QUESTION',", page, count=1)
            if (n1, n2) != (1, 1):
                raise SystemExit("hive page: CONFIG.code / CONFIG.eyebrow not found")
        if kind == "matrix" and (not re.search(r"^  axes:\[.*\],$", page, re.M) or "code:''," not in page):
            raise SystemExit("hive-matrix page: CONFIG.axes line / empty CONFIG.code not found")
        return self.finish(page, font)

    def logo(self, x, y, w, h, color, fx=None) -> dict:
        if self.cfg.get("logo"):
            el = {"id": "logo", "type": "image", "x": x, "y": y, "w": w, "h": h, "rotation": 0, "opacity": 1,
                  "src": f"asset:{self.cfg['logo']}", "fit": "contain", "radius": 0}
        else:
            el = wordmark(x, y, max(w, 240), h, color, 15)
        if fx:
            el["fx"] = fx
        return el

    def title_elements(self, title: str, sub: str) -> list:
        navy, tf = self.cfg["navy"], self.cfg["title_font"]
        return [
            {"id": "cover-swarm", "type": "embed", "x": 0, "y": 0, "w": 1280, "h": 720,
             "rotation": 0, "opacity": 1, "radius": 0, "zoom": 1, "liveInEditor": True,
             "asset": "page-swarm-cover", "poster": "asset:img-swarm-cover-poster"},
            self.logo(64, 48, 111, 34, navy, {"enter": "fade", "order": 0, "enterDur": 0.8}),
            {"id": "ti-title", "type": "text", "x": 64, "y": 180, "w": 530, "h": 260,
             "rotation": 0, "opacity": 1, "html": title, "fontSize": 58, "fontFamily": tf,
             "fontWeight": 400, "color": navy, "align": "left", "valign": "top", "lineHeight": 1.12,
             "placeholder": "Presentation title", "role": "title",
             "fx": {"enter": "fade-up", "order": 4, "enterDur": 1.1}},
            {"id": "ti-sub", "type": "text", "x": 66, "y": 556, "w": 520, "h": 96,
             "rotation": 0, "opacity": 1, "html": sub, "fontSize": 23, "fontFamily": TEXT_FONT,
             "fontWeight": 600, "color": navy, "align": "left", "valign": "top", "lineHeight": 1.4,
             "placeholder": "Subtitle or presenter name, Date", "role": "subtitle",
             "fx": {"enter": "fade-up", "order": 18, "enterDur": 0.9}},
        ]

    def run(self, doc: dict) -> str:
        cfg, pre = self.cfg, self.cfg.get("prefix", "")
        assets = doc["assets"]
        font = text_font(doc)
        assets["page-swarm-cover"] = self.finish(self.path(cfg["swarm"]["page"]).read_text(encoding="utf-8"), font)
        assets["img-swarm-cover-poster"] = data_uri(self.path(cfg["swarm"]["poster"]))
        assets["page-hive-cluster"] = self.baked(cfg["hive"], font, "hive")
        assets["img-hive-cluster-poster"] = data_uri(self.path(cfg["hive"]["poster"]))
        assets["page-hive-matrix"] = self.baked(cfg["matrix"], font, "matrix")
        assets["img-hive-matrix-poster"] = data_uri(self.path(cfg["matrix"]["poster"]))
        for key, src in cfg.get("figures", {}).items():
            page = self.path(src).read_text(encoding="utf-8")
            if "url(MANROPE)" not in page:
                raise SystemExit(f"{src}: no url(MANROPE) placeholder")
            assets[key] = self.finish(page, font)

        layout = next(l for l in doc["layouts"] if l["id"] == f"{pre}title")
        layout["background"] = "#FFFFFF"
        layout["elements"] = self.title_elements("", "")

        slides = doc["slides"]
        title = next(s for s in slides if s["id"] == f"sl-{pre}title")
        title["background"] = "#FFFFFF"
        title["elements"] = self.title_elements("Presentation Title", "Subtitle or presenter name, Date")
        title["notes"] = cfg.get("title_notes") or TITLE_NOTES

        poll = next(s for s in slides if s["id"] == f"sl-{pre}poll")
        furniture = {e["id"]: e for e in poll["elements"] if e["id"] in ("logo", "footer", "pageno")}
        hive_id, matrix_id = f"sl-{pre}poll-hive", f"sl-{pre}poll-matrix"
        old = next((s for s in slides if s["id"] == hive_id), None)
        old_poll = next((e for e in (old or {}).get("elements", []) if e["type"] == "poll"), None)
        ask = json.loads(json.dumps(next(e for e in poll["elements"] if e["type"] == "poll")))
        ask.update({"x": 72, "y": 150, "w": 400, "h": 400, "opacity": 0, "kind": "open",
                    "question": PLACEHOLDER,
                    # keep the code across re-splices; never share the classic slide's bucket
                    "code": old_poll["code"] if old_poll and valid_code(old_poll["code"]) else new_code()})
        for k in ("options", "multi", "min", "max", "minLabel", "maxLabel"):
            ask.pop(k, None)
        hive = {
            "id": hive_id, "name": "12b · Open question, clustered live",
            "background": "#FFFFFF", "transition": "morph", "notes": cfg.get("hive_notes") or HIVE_NOTES,
            "elements": [
                ask,
                {"id": "em-frame", "type": "embed", "x": 0, "y": 0, "w": 1280, "h": 720,
                 "rotation": 0, "opacity": 1, "radius": 0, "asset": "page-hive-cluster",
                 "poster": "asset:img-hive-cluster-poster", "liveInEditor": True,
                 "keepPollOpen": True},
                *[json.loads(json.dumps(furniture[k])) for k in ("logo", "footer", "pageno") if k in furniture],
            ],
        }
        slides[:] = [s for s in slides if s["id"] != hive["id"]]
        slides.insert(slides.index(poll) + 1, hive)

        old = next((s for s in slides if s["id"] == matrix_id), None)
        old_poll = next((e for e in (old or {}).get("elements", []) if e["type"] == "poll"), None)
        ask2 = json.loads(json.dumps(ask))
        ask2["code"] = old_poll["code"] if old_poll and valid_code(old_poll["code"]) else new_code()
        if ask2["code"] == ask["code"]:
            ask2["code"] = new_code()
        matrix = json.loads(json.dumps(hive))
        matrix.update({"id": matrix_id, "name": "12c · Open question on your axes",
                       "notes": cfg.get("matrix_notes") or MATRIX_NOTES})
        matrix["elements"][0] = ask2
        matrix["elements"][1].update({"asset": "page-hive-matrix", "poster": "asset:img-hive-matrix-poster"})
        slides[:] = [s for s in slides if s["id"] != matrix["id"]]
        slides.insert(slides.index(hive) + 1, matrix)

        # teach the editable labels on every slide whose figure has them
        for s in slides:
            if any(e.get("type") == "embed" and "data-edit" in str(assets.get(e.get("asset"), ""))
                   for e in s["elements"]):
                s["notes"] = with_hint(s.get("notes", ""))
        return f"title + {hive_id} + {matrix_id} + {len(cfg.get('figures', {}))} figures spliced; {len(slides)} slides"


def wordmark(x, y, w, h, color, size=13) -> dict:
    """The neutral stand-in for a logo: an empty text box (hidden in the show) the
    person types a name into, or replaces with an image under the same id."""
    return {"id": "logo", "type": "text", "x": x, "y": y, "w": w, "h": h, "rotation": 0, "opacity": 1,
            "html": "", "placeholder": "Wordmark", "fontSize": size, "fontFamily": TEXT_FONT,
            "fontWeight": 700, "color": color, "align": "left", "valign": "middle", "lineHeight": 1.2,
            "letterSpacing": 1.2}


def with_hint(notes: str) -> str:
    notes = (notes or "").rstrip()
    if EDIT_HINT in notes:
        return notes
    return f"{notes} {EDIT_HINT}" if notes else EDIT_HINT


TITLE_NOTES = (
    "Title slide. A swarm of agents (black dots) builds, inspects and corrects a hex field "
    "across the right side; the title and presenter sit on the quiet white left. Behind it a hexagon lattice is "
    "invisible until a gold ring crosses it, every 9 s from a new origin. The figure follows the cursor (tiles and "
    "agents lean away, the lattice lights gold) and a click sends a ring from that point. It is an embed "
    "(cover-swarm) that runs on its own, no clicks, and starts half-built so the first frame is never empty. "
    "On arrival the wordmark fades in, then the title and subtitle rise (fx.enter) while a gold rule draws above the "
    "subtitle. The title is set in the template's serif title face; the subtitle line carries the presenter and date. "
    "Keep the title under ~4 lines at 58px."
)

HIVE_NOTES = (
    "An open question in one slide. The poll element (aq-poll) sits hidden beneath the hive: "
    "it opens the question on the phones, and the hive shows the question, the join QR and a "
    "count of answers as they come in. Edit the question with an agent, or send the embed "
    "backward to reach the poll. Click or press right to start: the answers so far "
    "replay in as if arriving, each readable first, then settling into one comb. "
    "Press the Cluster button (or click) at ANY moment -- the poll service clusters exactly "
    "the answers on screen: embeddings, k-means, a map rounded onto the honeycomb, and an "
    "LLM label per theme. Later answers are placed as they arrive -- nearest theme, or grey "
    "\"not yet sorted\". Nothing regroups until Re-cluster. Display (top-right, or S) sets "
    "how long each answer shows, how many open at once, and the replay speed. Home empties "
    "the slide. Needs present mode and the lecturer key. While the question is still the "
    "placeholder \"Your open question\" the page shows invented sample answers, already clustered, and "
    "never calls the service (eyebrow SAMPLE ANSWERS); writing a real question turns it live."
)

MATRIX_NOTES = (
    "An open question placed on axes you choose (one axis: a beeswarm; two: a 2x2). The poll "
    "element (aq-poll) sits hidden beneath the page, as on the hive. Answers collect in one comb "
    "as they arrive, the newest quoted under the count. Click or press right: the poll service "
    "rates every answer on each axis (LLM, -3..+3, or no stance) and orders answers sharing a "
    "rating by embedding projection; the x axis grows and the answers fly onto it. Next click "
    "(two axes): the second axis grows and the answers split into quadrants. Next: one voice per "
    "quadrant. Later answers wait in ARRIVING and are placed within seconds. Left steps back, "
    "Home returns to the comb. Change the axes with slide.py axes (never by hand). Needs present "
    "mode and the lecturer key. While the question is still the placeholder \"Your open "
    "question\" and the axes are the template's own, the page shows invented sample answers already "
    "placed (eyebrow SAMPLE ANSWERS); a real question or new axes turn it live."
)


def read_doc(path: Path):
    raw = path.read_text(encoding="utf-8")
    m = BLOCK.search(raw)
    if not m:
        raise SystemExit(f"{path}: no document block")
    return raw, m, json.loads(m.group(2))


def write_doc(path: Path, raw: str, m, doc: dict, backup: bool = True) -> None:
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    json.loads(body)  # the block must still parse
    if backup and path.exists():
        shutil.copyfile(path, path.with_name(path.name + ".bak"))
    path.write_text(raw[: m.start(2)] + body + raw[m.end(2):], encoding="utf-8", newline="")


def load_config(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(HERE / "splice.json"))
    ap.add_argument("--template", help="splice into this file instead of the config's template")
    a = ap.parse_args()
    cfg_path = Path(a.config).resolve()
    cfg = load_config(cfg_path)
    base = cfg_path.parent if cfg.get("paths") == "config" else ROOT
    target = Path(a.template) if a.template else (base / cfg["template"])
    raw, m, doc = read_doc(target)
    msg = Splice(cfg, cfg_path.parent).run(doc)
    write_doc(target, raw, m, doc)
    print(f"{target.name}: {msg}")


if __name__ == "__main__":
    main()
