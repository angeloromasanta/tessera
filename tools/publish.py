#!/usr/bin/env python3
"""Publish a deck: one entry point, three targets.

    publish.py students DECK.html   a frozen player copy for students, on Cloudflare
    publish.py teach    DECK.html   the full deck (editor, live polls) to present from, on Cloudflare
    publish.py live     DECK.html   a mirror that follows every edit (tools/live/serve.py)
    publish.py status   DECK.html   what is published for this deck, and where

students  Player-only (readonly), its own docId, no collab / agentNotes / poll
          config, hidden slides and drill-down states dropped, optional name
          scrub, every poll FROZEN: its results are read once from the poll
          service and baked into the slide (bars for choice / rating / quiz, the
          saved summary for open text; never the room's own words), so the
          copy asks nothing and reaches for no service. Built on the engine's
          current player shell, with the slide-list pane.
teach     The deck file as it is, after `slide.py doctor` and a size check.
live      Adds the deck to tools/live/decks.json; tools/live/serve.py (run it, or
          mount it in an app) serves it at <TESSERA_LIVE_URL>/deck/<slug> and
          patches changed slides in place; `--stop` removes it.

--dry-run (every target) builds and checks but uploads nothing and writes
neither publish.json nor decks.json; it prints the link it would publish.

Cloudflare uploads go through tools/cf_upload.py: one Worker per link, served at
https://<name>.<TESSERA_CF_SUBDOMAIN>.workers.dev; it needs `npx wrangler login` once.

Names and per-deck rules live in `publish.json` beside the deck, keyed by the
deck file's name; a name given with --name is saved there, so the next publish
is just `publish.py students DECK.html`:

    {"my-talk.html": {
       "students": {"name": "my-talk-1", "drop": ["speaker-profile"],
                    "scrub": [["Dr\\\\. Jane Doe<br>", ""]], "names": "jane|doe",
                    "swap": {"page-fig-x": "build/fig-x-online.html"}, "notes": {"s15": "…"},
                    "cover": "page-swarm-cover", "keep_states": false,
                    "out": "build/online/my-talk.html", "upload": "build/online"},
       "teach": {"name": "my-talk"},
       "live": {"slug": "my-talk"}}}

`scrub` is a list of [regex, replacement] applied to every text, note and page;
`names` is a regex the result is checked against (a warning names what is left).
`--scrub REGEX` and `--names REGEX` add to them for one run.

Freezing needs the lecturer key: TESSERA_LECTURER_KEY (or LECTURER_KEY) in the
gitignored .env (never printed). Without it pass --answers FILE.json ({"<poll code>":
["answer", …]}) or --drop-polls (remove the poll slides instead of freezing).
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cf_upload  # noqa: E402
import config  # noqa: E402
import deckio  # noqa: E402
import legacy  # noqa: E402
import slide as slide_tool  # noqa: E402
from export_deck import inject_nav  # noqa: E402

REPO = config.REPO
DOC_RE = deckio.DOC_RE
PREVIEW = HERE / "live" / "decks.json"
MAX_BYTES = 25 * 1024 * 1024  # Workers static assets: 25 MiB per file


def preview_base(public: bool = True) -> str:
    """Where the live mirror shows a deck: TESSERA_LIVE_URL (else the local address) + /deck."""
    return (config.live_url() if public else config.live_local()) + "/deck"

POLL_API = re.compile(r"/api/(poll|cluster)")


# ─────────────────────────────────────────────────────────────── plumbing

def die(msg: str):
    raise SystemExit(f"publish: {msg}")


def env(key: str) -> str:
    """A setting from the environment or the .env (config.get)."""
    return config.get(key)


def shown(f: Path) -> str:
    try:
        return str(f.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(f)


def deck_config(deck: Path) -> tuple[Path, dict]:
    f = deck.parent / "publish.json"
    return f, (json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {})


def remember(deck: Path, mode: str, **fields) -> None:
    f, all_ = deck_config(deck)
    entry = all_.setdefault(deck.name, {}).setdefault(mode, {})
    if all(entry.get(k) == v for k, v in fields.items()):
        return
    entry.update(fields)
    f.write_text(json.dumps(all_, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"  saved in {shown(f)}")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:54]


def read_deck(deck: Path) -> tuple[str, dict, bool]:
    """(file text, document, came_from_live). The open editor is authoritative
    when it has the deck: its document is used, the file only lends the shell."""
    html = deck.read_text(encoding="utf-8")
    m = DOC_RE.search(html)
    if not m:
        die(f"{deck.name}: no #{deckio.DOC_ID} block")
    live = None
    if not config.flag("TESSERA_NO_LIVE"):
        try:
            live = slide_tool.live_for_file(deck)
        except SystemExit:
            live = None
    if live:
        print(f"  {deck.name} is open in the editor: publishing the live document")
        return html, live.doc, True
    guard = deck.parent / "build" / f"{deck.name}.live-source.json"
    if guard.exists():
        die(f"{deck.name} has unreconciled live edits ({guard.name}) and its editor is not "
            "connected: open the deck, or reconcile it (agent_live.py reconcile) first")
    return html, json.loads(m.group(2)), False


def write_deck(shell_html: str, doc: dict, out: Path) -> int:
    payload = deckio.encode(doc)
    at = DOC_RE.search(shell_html)
    html = shell_html[:at.start(2)] + payload + shell_html[at.end(2):]
    if json.loads(DOC_RE.search(html).group(2)) != doc:
        die("document failed its round trip; nothing written")
    html = inject_nav(html) if doc.get("readonly") else html
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return len(html.encode("utf-8"))


def upload(path: Path, name: str, owned: bool = False) -> str:
    """Publish to Cloudflare (tools/cf_upload.py); returns the link. `owned`: the
    deck's publish.json already records this name, so it is ours to redeploy."""
    try:
        return cf_upload.up(path, name, owned=owned)
    except cf_upload.UploadError as e:
        die(f"upload failed for {name}: {e}")


def would_publish(name: str) -> str:
    n = cf_upload.slugify(name)
    return config.workers_host(n) or f"https://{n}.<TESSERA_CF_SUBDOMAIN>.workers.dev"


# ──────────────────────────────────────────────────────────────── students

def page_text(value) -> str:
    if not isinstance(value, str):
        return ""
    if not value.startswith("data:"):
        return value
    head, _, body = value.partition(",")
    if "base64" not in head:
        return body
    try:
        return base64.b64decode(body).decode("utf-8", "replace")
    except ValueError:
        return ""


OFFLINE_OK = re.compile(r'<meta name="(?:tessera-offline-ok|%s)"' % re.escape(legacy.OFFLINE_META))


def reads_service(s: dict, assets: dict) -> bool:
    """A figure that needs the poll service; one marked tessera-offline-ok (a lab card) runs without it."""
    return any(e["type"] == "embed" and POLL_API.search(t := page_text(assets.get(e.get("asset"), "")))
               and not OFFLINE_OK.search(t)
               for e in s["elements"])


def fetch_answers(service: str, code: str, key: str) -> tuple[int, list[str] | None]:
    """(count, answer texts) for one bucket; texts is None when withheld."""
    # A user agent: Cloudflare refuses Python's default one (error 1010).
    req = urllib.request.Request(f"{service.rstrip('/')}/api/poll?c={code}",
                                 headers={"user-agent": config.USER_AGENT, **config.lecturer_headers(key)})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read())
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        die(f"could not read poll {code} from {service}: {e}")
    if d.get("answersWithheld"):
        return int(d.get("count") or 0), None
    return int(d.get("count") or 0), [str(a.get("text", "")) for a in d.get("answers", [])]


def freeze_polls(doc: dict, supplied: dict | None, dry_run: bool = False) -> list[str]:
    """Bake each poll's results into its element. Returns report lines.
    `dry_run`: answers the service withholds (no key) are a warning, not fatal."""
    out, key = [], env("TESSERA_LECTURER_KEY")
    deck_service = (doc.get("poll") or {}).get("service", "")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    for s in doc["slides"]:
        for e in s["elements"]:
            if e["type"] != "poll" or e.get("frozen"):
                continue
            kind, code = e.get("kind", "open"), e.get("code", "")
            if supplied is not None:
                texts = [str(t) for t in supplied.get(code, [])]
                count = len(texts)
            else:
                service = e.get("service") or deck_service
                if not service:
                    die(f"{s['id']}: poll {code} has no service to read; --answers FILE or --drop-polls")
                count, texts = fetch_answers(service, code, key)
                if texts is None and kind in ("choice", "rating", "quiz") and count:
                    msg = (f"the poll service is withholding the answers of {s['id']} ({count} responses). "
                           "Put TESSERA_LECTURER_KEY=<the lecturer key> in the .env, "
                           "or pass --answers FILE.json, or --drop-polls")
                    if not dry_run:
                        die(msg)
                    out.append(f"  ! dry run: {msg}")
            frozen = {"at": now, "count": count}
            if kind in ("choice", "rating", "quiz"):
                frozen["answers"] = texts or []   # wire strings only: no names, no times
            e["frozen"] = frozen
            for k in ("service", "requireName"):
                e.pop(k, None)
            note = "" if kind != "open" or e.get("summary") else " (no saved summary: the slide shows the question only)"
            out.append(f"  frozen {s['id']}: {kind}, {count} response(s){note}")
    return out


def build_students(deck: Path, cfg: dict, args) -> tuple[Path, dict]:
    _, doc, _ = read_deck(deck)
    if doc.get("template"):
        die("this is a template master; publish a saved deck instance")
    root = deck.parent
    before = len(doc["slides"])
    assets = doc.setdefault("assets", {})

    # figures still on the live server go in as pages; a figure that cannot is fatal
    baked = [line for s in doc["slides"] for line in slide_tool.bake_elements(doc, s["elements"], root, final=True)]
    bad = [line for line in baked if line.startswith("!")]
    if bad:
        die("a figure is not in the file and its source is missing:\n" + "\n".join(bad))

    drop = {s["id"] for s in doc["slides"] if s.get("hidden") or s["id"] in set(cfg.get("drop", []))}
    if not cfg.get("keep_states"):
        drop |= {s["id"] for s in doc["slides"] if s.get("stateOf")}
    if args.drop_polls:
        drop |= {s["id"] for s in doc["slides"] if any(e["type"] == "poll" for e in s["elements"])}
    # a figure that reads the poll service cannot run in a copy with no service
    reporting = {s["id"] for s in doc["slides"] if s["id"] not in drop and reads_service(s, assets)}
    drop |= reporting
    drop |= {s["id"] for s in doc["slides"] if s.get("stateOf") in drop}
    removed = [s for s in doc["slides"] if s["id"] in drop]
    doc["slides"] = [s for s in doc["slides"] if s["id"] not in drop]
    for s in doc["slides"]:
        s["elements"] = [e for e in s["elements"]
                         if not ((e["id"].startswith("dd-chip") and not cfg.get("keep_states")) or e.get("link") in drop)]
        s.pop("comments", None)  # review notes and agent requests are not for students

    supplied = json.loads(Path(args.answers).read_text(encoding="utf-8")) if args.answers else None
    report = freeze_polls(doc, supplied, getattr(args, "dry_run", False))

    # per-deck replacements: the template's current cover, assets, notes
    cover = cfg.get("cover")
    if cover and cover in assets:
        tpl = deckio.load(config.template())
        assets[cover] = tpl["assets"][cover]
    for k, rel in (cfg.get("swap") or {}).items():
        if k not in assets:
            die(f"swap: the deck has no asset {k}")
        data = (root / rel).read_bytes()
        assets[k] = ("data:image/png;base64," + base64.b64encode(data).decode()
                     if rel.lower().endswith(".png") else data.decode("utf-8"))
    # pages that run without the service (lab cards) learn they are in a frozen copy
    for k in {e.get("asset") for s in doc["slides"] for e in s["elements"] if e["type"] == "embed"}:
        t = page_text(assets.get(k))
        if t and OFFLINE_OK.search(t) and not re.search(r"<html[^>]*data-offline", t):
            assets[k] = re.sub(r"<html\b", "<html data-offline", t, count=1)
    for s in doc["slides"]:
        if s["id"] in (cfg.get("notes") or {}):
            s["notes"] = cfg["notes"][s["id"]]

    # assets only the removed slides used
    rest = json.dumps({k: v for k, v in doc.items() if k not in ("assets", "blobs")})
    gone = json.dumps(removed)
    for k in [k for k in assets if json.dumps(k) in gone and json.dumps(k) not in rest
              and f'"asset:{k}"' not in rest]:
        del assets[k]

    scrub = [(re.compile(p), r) for p, r in
             cfg.get("scrub", []) + [[p, ""] for p in getattr(args, "scrub", None) or []]]
    names_re = "|".join(x for x in [cfg.get("names")] + (getattr(args, "names", None) or []) if x)
    if scrub or names_re:
        (doc.get("meta") or {}).pop("author", None)

        def clean(t: str) -> str:
            for p, r in scrub:
                t = p.sub(r, t)
            return t
        for s in doc["slides"]:
            s["notes"] = clean(s.get("notes", ""))
            for e in s["elements"]:
                for f in ("html", "question", "summary"):
                    if isinstance(e.get(f), str):
                        e[f] = clean(e[f])
        for k, v in assets.items():
            if isinstance(v, str) and not v.startswith("data:"):
                assets[k] = clean(v)
    if names_re:
        names = re.compile(names_re, re.I)
        rest = {k: v for k, v in doc.items() if k not in ("assets", "blobs")}
        rest["pages"] = {k: re.sub(r"[A-Za-z0-9+/=]{300,}", "", v) for k, v in assets.items()
                         if isinstance(v, str) and not v.startswith("data:")}
        left = sorted({m.group(0).lower() for m in names.finditer(json.dumps(rest, ensure_ascii=False))})
        if left:
            report.append(f"  WARNING: a name is still in the text: {left}")

    for k in ("poll", "collab", "agentNotes", "template"):
        doc.pop(k, None)
    doc["readonly"] = True
    doc["docId"] = str(uuid.uuid4())

    shell = config.shell()
    if not shell.is_file():
        die(f"no player shell at {shell}: cd {REPO / 'slides'} && npm run build:single")
    out = (root / cfg["out"]).resolve() if cfg.get("out") else root / "build" / "publish" / f"{deck.stem}-students.html"
    size = write_deck(shell.read_text(encoding="utf-8"), doc, out)
    print(f"{deck.name}: {before} -> {len(doc['slides'])} slides, {size / 1e6:.1f} MB -> {out}")
    if drop:
        print("  removed:", " ".join(sorted(drop)))
    if reporting:
        print("  ! removed because their figure reads the poll service (freeze the figure by hand to keep it):",
              " ".join(sorted(reporting)))
    for line in baked + report:
        print(line)
    if size > MAX_BYTES:
        die(f"{size / 1e6:.1f} MB is over Cloudflare's 25 MiB per file")
    return out, doc


def cmd_students(args) -> None:
    deck = Path(args.deck).resolve()
    _, all_ = deck_config(deck)
    cfg = dict(all_.get(deck.name, {}).get("students", {}))
    out, _ = build_students(deck, cfg, args)
    if args.no_upload:
        print("built only (--no-upload)")
        return
    name = args.name or cfg.get("name") or slug(deck.stem) + "-students"
    target = (deck.parent / cfg["upload"]).resolve() if cfg.get("upload") else out
    if args.dry_run:
        print(f"DRY RUN  would upload {shown(target)} as {name}: {would_publish(name)}")
        return
    url = upload(target, name, owned=name == cfg.get("name"))
    remember(deck, "students", name=name, url=url)
    print(f"STUDENTS  {url}")


# ─────────────────────────────────────────────────────────────────── teach

def cmd_teach(args) -> None:
    deck = Path(args.deck).resolve()
    _, all_ = deck_config(deck)
    cfg = all_.get(deck.name, {}).get("teach", {})
    html, doc, live = read_deck(deck)
    if live and getattr(slide_tool.live_for_file(deck), "dirty", False):
        die(f"{deck.name} has unsaved changes in the editor: let it save (Ctrl+S), then publish again. "
            "The teaching copy is the file itself")
    # Clean first: assets nothing in the deck uses (left by removed or copied
    # slides) go, in the deck itself (through the open editor when it is open),
    # so the published file and the source stay the same and under 25 MiB.
    drop = [] if args.keep_assets or doc.get("template") else slide_tool.unused_assets(doc)
    if drop and not (args.no_upload or args.dry_run):
        mb = sum(len(json.dumps(doc["assets"][k])) for k in drop) / 1e6
        print(f"  cleaning: {len(drop)} unused asset(s), {mb:.1f} MB")
        target = slide_tool.open_target(str(deck))
        new = copy.deepcopy(target.doc)
        for k in drop:
            new["assets"].pop(k, None)
        slide_tool.commit(target, new, argparse.Namespace(agent="publish", dry_run=False), structure=True)
        if live:
            time.sleep(2)                     # the editor writes the file through
        html, doc, live = read_deck(deck)
    elif drop:
        print(f"  note: {len(drop)} unused asset(s) would be cleaned on upload")
    problems = slide_tool.doctor(doc)
    fatal = [p for p in problems if "NOT in the file" in p or "missing from the file" in p]
    for p in problems:
        print(("! " if p in fatal else "  note: ") + p)
    if fatal:
        die("fix these first (slide.py bake DECK), or the published deck shows blank figures")
    if deck.stat().st_size > MAX_BYTES:
        die(f"{deck.stat().st_size / 1e6:.1f} MB is over Cloudflare's 25 MiB per file")
    session = (doc.get("poll") or {}).get("session")
    print(f"{deck.name}: {len(doc['slides'])} slides, {deck.stat().st_size / 1e6:.1f} MB"
          + (f", join code {session}" if session else ""))
    if args.no_upload:
        print("checked only (--no-upload)")
        return
    name = args.name or cfg.get("name") or slug(deck.stem)
    if args.dry_run:
        print(f"DRY RUN  would upload {deck.name} as {name}: {would_publish(name)}")
        return
    url = upload(deck, name, owned=name == cfg.get("name"))
    remember(deck, "teach", name=name, url=url)
    print(f"TEACH  {url}   (redeploy after every edit: publish.py teach {args.deck})")


# ──────────────────────────────────────────────────────────────────── live

def preview_settings() -> tuple[Path, dict]:
    if not PREVIEW.is_file():
        return PREVIEW, {"decks": {}}
    return PREVIEW, json.loads(PREVIEW.read_text(encoding="utf-8"))


def cmd_live(args) -> None:
    deck = Path(args.deck).resolve()
    _, all_ = deck_config(deck)
    cfg = all_.get(deck.name, {}).get("live", {})
    f, settings = preview_settings()
    decks = settings.setdefault("decks", {})
    path = deck.as_posix()
    mine = [s for s, p in decks.items() if Path(p).resolve() == deck]
    if args.stop:
        if not mine:
            print("not being previewed")
            return
        for s in mine:
            del decks[s]
    else:
        name = args.slug or cfg.get("slug") or (mine[0] if mine else slug(deck.stem))
        if not re.match(r"^[a-z0-9][a-z0-9-]{1,40}$", name):
            die(f"'{name}' is not a usable slug (a-z, 0-9, hyphens)")
        if name in decks and Path(decks[name]).resolve() != deck:
            die(f"slug '{name}' already previews {decks[name]}; pass --slug")
        for s in mine:
            if s != name:
                del decks[s]
        decks[name] = path
    if args.dry_run:
        print("DRY RUN  would " + (f"stop previewing {', '.join(mine) or deck.name}" if args.stop
                                   else f"preview {deck.name} at {preview_base()}/{name}"))
        return
    # Read on every request by live/serve.py: nothing to register anywhere else.
    f.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    if args.stop:
        print(f"stopped previewing {deck.name} (was: {', '.join(mine)})")
        return
    remember(deck, "live", slug=name)
    local = preview_base(public=False)
    for _ in range(45):
        try:
            with urllib.request.urlopen(f"{local}/{name}/version", timeout=2) as r:
                if r.status == 200:
                    break
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(2)
    else:
        die(f"{local}/{name}/version did not answer within 90 s. Start the mirror: "
            f"python {shown(HERE / 'live' / 'serve.py')}")
    print(f"LIVE  {preview_base()}/{name}   (follows every edit; "
          f"`publish.py live {args.deck} --stop` when done)")


# ────────────────────────────────────────────────────────────────── status

def cmd_status(args) -> None:
    deck = Path(args.deck).resolve()
    _, all_ = deck_config(deck)
    cfg = all_.get(deck.name, {})
    reg = cf_upload.load_registry()
    for mode in ("students", "teach"):
        name = cfg.get(mode, {}).get("name")
        hit = reg.get(name) if name else None
        print(f"{mode:9}", f"{hit['url']}   updated {hit.get('updated', '?')[:16]}" if hit
              else (f"{name}: configured, not in the upload registry ({cf_upload.registry_path()})"
                    if name else "not published"))
    try:
        decks = preview_settings()[1].get("decks", {})
    except SystemExit:
        decks = {}
    mine = [s for s, p in decks.items() if Path(p).resolve() == deck]
    print(f"{'live':9}", ", ".join(f"{preview_base()}/{s}" for s in mine) if mine else "not previewed")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("students", help="frozen player copy for students")
    p.add_argument("deck")
    p.add_argument("--name", help="Cloudflare worker name (saved in publish.json)")
    p.add_argument("--no-upload", action="store_true", help="build the copy only")
    p.add_argument("--answers", help="JSON {poll code: [answers]} instead of reading the service")
    p.add_argument("--drop-polls", action="store_true", help="remove poll slides instead of freezing them")
    p.add_argument("--scrub", action="append", metavar="REGEX",
                   help="remove what matches from every text, note and page (repeatable; adds to publish.json scrub)")
    p.add_argument("--names", action="append", metavar="REGEX",
                   help="warn if this still matches after the scrub (repeatable; adds to publish.json names)")
    p.add_argument("--dry-run", action="store_true", help="build and check; upload nothing, save nothing")
    p.set_defaults(func=cmd_students)
    p = sub.add_parser("teach", help="the full deck, to present from")
    p.add_argument("deck")
    p.add_argument("--name")
    p.add_argument("--no-upload", action="store_true", help="run the checks only")
    p.add_argument("--keep-assets", action="store_true",
                   help="skip the clean-up of assets nothing in the deck uses (done by default)")
    p.add_argument("--dry-run", action="store_true", help="run the checks; clean, upload and save nothing")
    p.set_defaults(func=cmd_teach)
    p = sub.add_parser("live", help="mirror that follows every edit")
    p.add_argument("deck")
    p.add_argument("--slug")
    p.add_argument("--stop", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="say what would change; write nothing")
    p.set_defaults(func=cmd_live)
    p = sub.add_parser("status", help="what is published for this deck")
    p.add_argument("deck")
    p.set_defaults(func=cmd_status)
    args = ap.parse_args()
    if not Path(args.deck).is_file():
        die(f"{args.deck}: not found")
    args.func(args)


if __name__ == "__main__":
    main()
