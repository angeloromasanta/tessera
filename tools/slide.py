#!/usr/bin/env python3
"""Read and edit ONE slide of a deck, on disk or in the open editor.

TARGET is a deck file (deck.html), `live` (the one connected editor), or a live
session id from `agent_live.py sessions`. Every command works the same on
both: an edit is turned into compare-and-set patches (the bridge's own format,
slides/src/agent-patch.ts). A stale value fails with `conflict`
instead of overwriting someone else's change. On disk, writes also go through
a lock file, so parallel agents queue instead of clobbering each other.

Look (small output, no base64, no agentNotes):
    slide.py ls TARGET                      one line per slide
    slide.py get TARGET ID [--out F]        one slide's JSON
    slide.py info TARGET --section theme|layouts|layout:ID|assets|notes|poll

Edit:
    slide.py text TARGET ID ELEM "new text"    plain text; \\n = line break
    slide.py text TARGET ID ELEM --html "<b>x</b>"
    slide.py notes TARGET ID "speaker notes"   (or --file notes.txt)
    slide.py set TARGET ID ELEM key=value ...  x=56 fontSize=40 color="#1A4C9C"
    slide.py set TARGET ID - name="..." transition=fade   (slide fields)

Change requests (typed in the editor's slide list: beside a slide, or "Whole deck"):
    slide.py requests TARGET [--all]        the open ones: slide (or [deck]), id, status, text
    slide.py requests TARGET --wait         block until the open editor has new ones
                                            (run in the background; it exits to wake you)
    slide.py reply TARGET REQ_ID "what I did" [--status working|done]
    slide.py ask TARGET ID "text" [--id REQ] [--author A]   record a request as if
                                            typed beside slide ID (the phone mirror's route);
                                            ID "-" = about the whole deck

Structure (coordinator only when agents run in parallel):
    slide.py new TARGET --layout points [--id ID] [--after ID]   (a layout id, or its role)
    slide.py copy TARGET SRC_ID [--from TEMPLATE.html] [--id ID] [--after ID]   (default: $TESSERA_TEMPLATE)
    slide.py dup TARGET ID [--id NEW] | move TARGET ID --after ID|--first | rm TARGET ID
    slide.py asset TARGET KEY FILE               add or replace one asset
    slide.py axes TARGET ID --axes 'Lo|Hi' ['Lo|Hi'] [--quads 'TL|TR|BL|BR']
                                                 a hive-matrix slide's axes (copy takes the same flags)

Parallel agents (see docs/guide/parallel.md):
    slide.py claim TARGET ID... --agent NAME     one owner per slide
    slide.py pull TARGET ID [--agent NAME]       -> build/work/ID.json (+ .base.json)
    slide.py push TARGET ID [--agent NAME]       diff work vs base -> patches
    slide.py who TARGET                          claims + last pushes

Health (run before copying, exporting or publishing a deck):
    slide.py prune TARGET [--go]  assets nothing uses (left by removed slides); publish.py teach drops them
    slide.py doctor TARGET        figures that are not in the file, slides sharing one
                                  figure page, missing assets and posters; exits 1 on any
    slide.py bake TARGET          put every figure still on the live server into the file
                                  (keeps devSrc; --final drops it: the figure is finished)
    slide.py fork DECK.html       a new identity for a COPIED file: new docId
                                  (--polls: fresh answer buckets and join code too)
    slide.py template DECK.html   flag a master template (every open mints a fresh deck); --off

Poll service (what the editor's join-code button and Export menu do; the
lecturer key comes from TESSERA_LECTURER_KEY in the .env, never printed):
    slide.py poll clear TARGET SLIDE_ID|--all --yes   delete the answers (and images) in
                                  those buckets; codes kept. Irreversible
    slide.py poll export TARGET [--out F.xlsx|F.csv]  every poll's answers in one file
                                  (default build/<deck>-answers.xlsx)
    slide.py poll code DECK.html NAME [--fresh]       claim the join code on the service and
                                  set doc.poll.session (--fresh: every question a new empty
                                  bucket). File only; a spec recompile mints a new one
    slide.py poll publish TARGET SLIDE_ID|--all       push an activity's phone page now, so
                                  phones are ready before the slide is first presented
    slide.py service DECK.html [URL]   set doc.poll.service, the service the deck's polls
                                  use (default: TESSERA_POLL_SERVICE from the .env). File only

Repair:
    slide.py repair DECK.html     a doc block some writer left with a raw '<'
                                  (the deck errors in the browser; tools say so)

Options: --agent NAME (or $TESSERA_AGENT) shows up in the editor's tooltip. Agents:
pass --agent on every command; an `export` dies with its Bash call.
--dry-run prints the patches instead of sending them.
"""
from __future__ import annotations

import argparse
import calendar
import contextlib
import copy
import html as htmllib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import config  # noqa: E402
import deckio  # noqa: E402
import legacy  # noqa: E402
from deckio import DOC_RE  # noqa: E402

REPO = config.REPO
BRIDGE = REPO / "scripts" / "agent-bridge.py"
STAMP = REPO / "scripts" / "stamp-agent-notes.mjs"
LIVE_ROOTS = {"slides", "assets", "title", "theme", "layouts", "fonts", "requests"}

for _s in (sys.stdout, sys.stderr):
    with contextlib.suppress(AttributeError, ValueError):
        _s.reconfigure(encoding="utf-8")


# ─────────────────────────────────────────────── patches (agent-patch.ts port)

def _ids(v) -> bool:
    return isinstance(v, list) and all(isinstance(x, dict) and isinstance(x.get("id"), str) for x in v)


MISSING = object()


def diff(before, value, path=None) -> list[dict]:
    """ID-aware difference -> compare-and-set patches (same as the editor)."""
    path = path or []
    if before == value and type(before) is type(value):
        return []
    if _ids(before) and _ids(value) and before is not MISSING:
        out: list[dict] = []
        a = {x["id"]: x for x in before}
        b = {x["id"]: x for x in value}
        for i in list(a) + [k for k in b if k not in a]:
            out += diff(a.get(i, MISSING), b.get(i, MISSING), path + [{"id": i}])
        inter = [x["id"] for x in before if x["id"] in b] + [x["id"] for x in value if x["id"] not in a]
        target = [x["id"] for x in value]
        if inter != target:
            out.append({"path": path, "order": True, "before": inter, "value": target})
        return out
    if isinstance(before, dict) and isinstance(value, dict):
        out = []
        for k in list(before) + [k for k in value if k not in before]:
            if not path and k == "modified":
                continue
            out += diff(before.get(k, MISSING), value.get(k, MISSING), path + [k])
        return out
    p = {"path": path}
    if before is not MISSING:
        p["before"] = copy.deepcopy(before)
    if value is not MISSING:
        p["value"] = copy.deepcopy(value)
    return [p]


class Conflict(Exception):
    pass


def _key(parent, seg):
    if isinstance(seg, str):
        if isinstance(parent, list):
            raise Conflict("invalid path")
        return seg
    if not isinstance(parent, list):
        raise Conflict("invalid ID path")
    return next((i for i, x in enumerate(parent) if isinstance(x, dict) and x.get("id") == seg["id"]), -1)


def apply_patches(doc, patches):
    """Apply to a copy; raise Conflict if any `before` no longer matches."""
    doc = copy.deepcopy(doc)
    for p in patches:
        parent = doc
        for seg in p["path"][:-1]:
            k = _key(parent, seg)
            if k == -1 or (isinstance(parent, dict) and k not in parent):
                raise Conflict(f"missing parent at {_fmt(p['path'])}")
            parent = parent[k]
        last = p["path"][-1]
        k = _key(parent, last)
        has = (k != -1) if isinstance(parent, list) else (k in parent)
        actual = parent[k] if has else MISSING
        if p.get("order"):
            if not _ids(actual) or [x["id"] for x in actual] != p["before"]:
                raise Conflict(f"order conflict at {_fmt(p['path'])}")
            m = {x["id"]: x for x in actual}
            parent[k] = [m[i] for i in p["value"]]
            continue
        want = p.get("before", MISSING)
        if not (actual is MISSING and want is MISSING) and actual != want:
            raise Conflict(f"value conflict at {_fmt(p['path'])}")
        if "value" not in p:
            if has:
                del parent[k]
        elif isinstance(parent, list) and k == -1:
            parent.append(copy.deepcopy(p["value"]))
        else:
            parent[k] = copy.deepcopy(p["value"])
    return doc


def _fmt(path) -> str:
    return "/".join(s if isinstance(s, str) else f"#{s['id']}" for s in path)


# ─────────────────────────────────────────────────────────────────── backends

def _bridge():
    spec = importlib.util.spec_from_file_location("agent_bridge", BRIDGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@contextlib.contextmanager
def deck_lock(path, wait=60.0, stale=120.0):
    """The write lock of one file, build/.<name>.lock. For a deck it is the
    same file the bridge's /save and md_to_deck take, so every writer queues;
    land.py also takes one on the .md spec (with a longer wait)."""
    path = Path(path).resolve()
    build = path.parent / "build"
    lock = build / f".{path.name}.lock"
    build.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + wait
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            with contextlib.suppress(OSError):
                if time.time() - lock.stat().st_mtime > stale:
                    lock.unlink(missing_ok=True)  # a crashed writer's lock
            if time.time() > deadline:
                raise SystemExit(f"{lock} held for {wait:.0f} s — another writer is stuck") from None
            time.sleep(0.1)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


class FileDeck:
    live = False

    def __init__(self, path: Path):
        self.path = path.resolve()
        self.build = self.path.parent / "build"
        self.doc = self._read()[1]

    def _read(self):
        text = self.path.read_text(encoding="utf-8")
        m = DOC_RE.search(text)
        if not m:
            raise SystemExit(f"{self.path}: no #{deckio.DOC_ID} block")
        try:
            return text, json.loads(m.group(2))
        except json.JSONDecodeError:
            if unescaped_doc(text):
                raise SystemExit(
                    f"{self.path}: #{deckio.DOC_ID} holds a raw '<' (some writer skipped the \\u003c escape), "
                    f"so a '</script>' inside it cuts the block short and the deck is broken in the "
                    f"browser too. Fix: slide.py repair {self.path}") from None
            raise

    def _lock(self):
        return deck_lock(self.path)

    def apply(self, patches, agent, structure=False):
        # open_target already routed an open deck to its editor. A leftover
        # live-source guard only holds the spec compiler back, not slide.py.
        with self._lock():
            text, doc = self._read()
            new = apply_patches(doc, patches)  # Conflict propagates
            payload = json.dumps(new, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
            m = DOC_RE.search(text)
            out = text[:m.start(2)] + payload + text[m.end(2):]
            _rotate_bak(self.path)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(out, encoding="utf-8")
            json.loads(DOC_RE.search(tmp.read_text(encoding="utf-8")).group(2))
            os.replace(tmp, self.path)
            if structure and STAMP.exists() and shutil.which("node"):
                subprocess.run(["node", str(STAMP), str(self.path)], capture_output=True)
            self.doc = self._read()[1]
        return {"status": "applied"}


def unescaped_doc(text: str):
    """(doc, start, end) when the doc block's JSON is whole but carries a raw '<'
    (DOC_RE stops at the first '</script>' inside a string), else None."""
    return deckio.unescaped(text)


def _rotate_bak(path: Path):
    deckio.backup(path)


class LiveDeck:
    live = True

    def __init__(self, target: str):
        self.b = _bridge()
        sessions = _sessions(self.b)
        if not sessions:
            raise SystemExit("no live editor connected: open the deck in the browser "
                             "(it connects by itself within a few seconds), then retry")
        if target == "live":
            if len({s["file"] for s in sessions}) > 1 or len(sessions) > 1:
                raise SystemExit("several live sessions — pass the session id:\n" +
                                 "\n".join(f"  {s['sessionId']}  {s['file']}" for s in sessions))
            self.session = sessions[0]
        else:
            match = [s for s in sessions if s["sessionId"].startswith(target)]
            if len(match) != 1:
                raise SystemExit(f"no unique live session '{target}'")
            self.session = match[0]
        from urllib.parse import urlparse, unquote
        u = urlparse(self.session["file"])
        p = unquote(u.path)
        if re.match(r"^/[A-Za-z]:", p):
            p = p[1:]
        self.path = Path(p)
        self.build = self.path.parent / "build"
        self.sid = self.session["sessionId"]
        self.refresh()

    def refresh(self):
        r = self.b.call("/request", {"sessionId": self.sid, "kind": "read"})
        if "doc" not in r:
            raise SystemExit(f"read failed: {r}")
        self.doc = r["doc"]
        self.current = r.get("currentSlideId")
        self.dirty = r.get("dirty")

    def apply(self, patches, agent, structure=False):
        bad = [p for p in patches if p["path"][0] not in LIVE_ROOTS]
        if bad:
            raise SystemExit("the live editor only accepts slides/assets/title/theme/layouts/fonts/requests; "
                             f"refused: {', '.join(_fmt(p['path']) for p in bad)}")
        req = {"id": uuid.uuid4().hex, "docId": self.doc.get("docId"), "agent": agent, "patches": patches}
        for attempt in range(40):
            r = self.b.call("/request", {"sessionId": self.sid, "kind": "patch", "request": req}, timeout=30)
            st = r.get("status")
            if st in ("busy", "disconnected"):
                time.sleep(1.5 if st == "busy" else 0.5)  # same id: the bridge makes this idempotent
                continue
            break
        if r.get("status") == "conflict":
            raise Conflict(r.get("message", "conflict"))
        if r.get("status") != "applied":
            raise SystemExit(f"editor refused: {json.dumps(r)}")
        self.mirror()
        return r

    def mirror(self):
        """Write-through: when the editor holds no file handle (never saved with
        Ctrl+S since it was opened), its edits live only in the tab and a reload
        loses them. So after every live edit, copy the editor's whole document
        into the file on disk. The editor's own later save writes the same."""
        live = [s for s in self.b.call("/sessions")["sessions"] if s["sessionId"] == self.sid]
        if live and live[0].get("canSave"):
            return
        self.refresh()
        if not self.path.exists():
            return
        with FileDeck._lock(self):
            text = self.path.read_text(encoding="utf-8")
            m = DOC_RE.search(text)
            old = json.loads(m.group(2))
            doc = dict(self.doc)
            if "collab" in old:  # the editor's read leaves out `collab` (an inert upstream field): keep the file's
                doc["collab"] = old["collab"]
            payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
            out = text[:m.start(2)] + payload + text[m.end(2):]
            _rotate_bak(self.path)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(out, encoding="utf-8")
            json.loads(DOC_RE.search(tmp.read_text(encoding="utf-8")).group(2))
            os.replace(tmp, self.path)


def _sessions(b, uri=None, wait=6.0):
    """Live editor sessions (for one deck URI if given). An open deck connects
    by itself (it claims its token from the bridge, probing every <=5 s), so
    when the bridge has only just started, give the editor a moment to arrive."""
    try:
        b.call("/sessions", timeout=1)
        fresh = False
    except (OSError, RuntimeError):
        fresh = True
    b.start()
    deadline = time.time() + (wait if fresh else 0)
    while True:
        ss = [s for s in b.call("/sessions")["sessions"] if uri is None or s["file"] == uri]
        if ss or time.time() >= deadline:
            return ss
        time.sleep(0.5)


def live_for_file(path: Path):
    """The connected editor session that has this deck file open, or None."""
    ss = _sessions(_bridge(), Path(path).resolve().as_uri())
    return LiveDeck(ss[0]["sessionId"]) if ss else None


def open_target(target: str):
    """A deck path goes to its open editor when there is one (live by default,
    so the presenter sees each edit land without reloading), else to the file."""
    p = Path(target)
    if p.suffix.lower() == ".html" or p.exists():
        if not p.exists():
            raise SystemExit(f"{p}: not found")
        if not config.flag("TESSERA_NO_LIVE"):
            live = live_for_file(p)
            if live:
                print(f"(live: {p.name} is open in the editor; editing it there)", file=sys.stderr)
                return live
        return FileDeck(p)
    return LiveDeck(target)


# ──────────────────────────────────────────────────────────────── helpers

def find(doc, sid):
    for s in doc["slides"]:
        if s["id"] == sid:
            return s
    raise SystemExit(f"no slide '{sid}'. Run: slide.py ls TARGET")


def find_el(slide, eid):
    for e in slide["elements"]:
        if e["id"] == eid:
            return e
    raise SystemExit(f"slide {slide['id']} has no element '{eid}' — has: "
                     + ", ".join(e["id"] for e in slide["elements"]))


def plain(html: str) -> str:
    t = re.sub(r"<br\s*/?>|</p>|</li>", " / ", html or "")
    return htmllib.unescape(re.sub(r"<[^>]+>", "", t)).strip(" /")


def to_html(text: str) -> str:
    return htmllib.escape(text, quote=False).replace("\\n", "<br>").replace("\n", "<br>")


def asset_refs(obj) -> set[str]:
    out: set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("asset", "activityAsset") and isinstance(v, str):
                out.add(v)
            out |= asset_refs(v)
    elif isinstance(obj, list):
        for v in obj:
            out |= asset_refs(v)
    elif isinstance(obj, str) and obj.startswith("asset:"):
        out.add(obj[6:])
    return out


def unused_assets(doc) -> list[str]:
    """Asset keys nothing in the deck names: not the slides, layouts, theme,
    polls or requests, and not another used asset (a page that names a key).
    These pile up when slides are removed or copied in; publishing drops them."""
    assets = doc.get("assets") or {}
    rest = json.dumps({k: v for k, v in doc.items() if k not in ("assets", "blobs")})
    used = {k for k in assets if k in rest}
    grew = True
    while grew:
        blob = "".join(str(assets[k]) for k in used)
        more = {k for k in assets if k not in used and k in blob}
        used |= more
        grew = bool(more)
    return [k for k in assets if k not in used]


def _role_name(layout_id: str) -> str:
    """A layout id without its template prefix: `<brand>-points` -> `points`."""
    roles = ("image-hero", "image-grid", "title", "section", "content", "quote", "statement", "chart",
             "compare", "points", "image", "matrix", "palette", "poll", "embed")
    return deckio.role_of(layout_id, roles) or layout_id


def fresh_id(doc, base):
    used = {s["id"] for s in doc["slides"]}
    sid, n = base, 2
    while sid in used:
        sid, n = f"{base}-{n}", n + 1
    return sid


def parse_value(v: str):
    try:
        return json.loads(v)
    except ValueError:
        return v


def _lines(patches) -> str:
    return "\n".join(json.dumps(slim(x), ensure_ascii=False) for x in patches)[:4000]


def agent_name(args):
    return args.agent or config.get("TESSERA_AGENT") or "claude"


def commit(deck, new_doc, args, structure=False):
    patches = diff(deck.doc, new_doc)
    if not patches:
        print("no change")
        return
    if getattr(args, "dry_run", False):
        print(_lines(patches))
        return
    _check_claims(deck, patches, agent_name(args))
    try:
        deck.apply(patches, agent_name(args), structure)
    except Conflict as e:
        raise SystemExit(f"conflict: {e} — someone changed it first; re-run the command "
                         "(or pull again) to build on their edit")
    _log(deck, agent_name(args), patches)
    where = "live editor" if deck.live else deck.path.name
    print(f"applied {len(patches)} change(s) to {where}: "
          + ", ".join(sorted({_fmt(p['path'][:2]) for p in patches}))[:300])


def _claims_file(deck):
    return deck.build / "work" / "claims.json"


def _claims(deck) -> dict:
    f = _claims_file(deck)
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def _check_claims(deck, patches, agent):
    claims = _claims(deck)
    for p in patches:
        if p["path"][:1] == ["slides"] and len(p["path"]) > 1 and isinstance(p["path"][1], dict):
            owner = claims.get(p["path"][1]["id"])
            if owner and owner != agent:
                raise SystemExit(f"slide {p['path'][1]['id']} is claimed by {owner}; "
                                 "you are " + agent + " (--agent)")


def _log(deck, agent, patches):
    f = deck.build / "work" / "log.jsonl"
    f.parent.mkdir(parents=True, exist_ok=True)
    slides = sorted({p["path"][1]["id"] for p in patches
                     if len(p["path"]) > 1 and isinstance(p["path"][1], dict)})
    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"t": time.strftime("%H:%M:%S"), "agent": agent,
                             "slides": slides, "n": len(patches)}) + "\n")


# ──────────────────────────────────────────────────────────────── commands

def cmd_ls(args):
    deck = open_target(args.target)
    d = deck.doc
    print(f"{d.get('title', '')} — {len(d['slides'])} slides"
          + (f", live session {deck.sid}, current {deck.current}, dirty={deck.dirty}" if deck.live else ""))
    claims = _claims(deck)
    n = 0
    for s in d["slides"]:
        state = s.get("stateOf")
        if not state and not s.get("hidden"):
            n += 1
        tag = f"{n:>3}" if not state and not s.get("hidden") else ("  ↳" if state else "  h")
        first = next((plain(e.get("html", "")) for e in s["elements"]
                      if e["type"] == "text" and plain(e.get("html", ""))
                      and e["id"] not in ("footer", "pageno")), "")
        kinds = sorted({e["type"] for e in s["elements"]} - {"text", "image", "shape"})
        own = f" [{claims[s['id']]}]" if s["id"] in claims else ""
        print(f"{tag} {s['id']:<24} {(s.get('name') or '')[:28]:<28} "
              f"{len(s['elements']):>2}el {'+'.join(kinds):<10} {first[:60]}{own}")


def slim(obj):
    """Slide JSON for reading: data URIs shortened, everything else intact."""
    if isinstance(obj, dict):
        return {k: slim(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [slim(v) for v in obj]
    if isinstance(obj, str) and obj.startswith("data:") and len(obj) > 200:
        return obj[:40] + f"…[{len(obj)} chars]"
    return obj


def fmt_slide(s) -> str:
    """Slide fields first, then one element per line: compact to read and
    easy to Edit (every element is a single unique line)."""
    head = {k: v for k, v in s.items() if k != "elements"}
    lines = ["{"] + [f" {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}," for k, v in head.items()]
    els = [" " + json.dumps(e, ensure_ascii=False) for e in s.get("elements", [])]
    lines.append(' "elements": [\n' + ",\n".join(" " + e for e in els) + "\n ]")
    return "\n".join(lines) + "\n}"


def cmd_get(args):
    deck = open_target(args.target)
    s = find(deck.doc, args.id)
    out = fmt_slide(slim(s))
    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
        print(args.out)
    else:
        print(out)


def cmd_info(args):
    deck = open_target(args.target)
    d = deck.doc
    sec = args.section
    if sec == "theme":
        out = {"size": d.get("size"), "theme": d.get("theme"), "fonts": [f.get("family") for f in d.get("fonts", [])]}
    elif sec == "layouts":
        out = [{"id": l["id"], "name": l.get("name"),
                "elements": [f"{e['id']}:{e['type']}@{e['x']},{e['y']} {e['w']}x{e['h']}" for e in l["elements"]]}
               for l in d.get("layouts", [])]
    elif sec.startswith("layout:"):
        out = next((slim(l) for l in d.get("layouts", []) if l["id"] == sec[7:]), None)
    elif sec == "assets":
        used = asset_refs(d["slides"]) | asset_refs(d.get("layouts", [])) | asset_refs(d.get("fonts", []))
        out = {k: {"kb": len(v) // 1024, "used": k in used} for k, v in sorted(d.get("assets", {}).items())}
    elif sec == "notes":
        out = d.get("agentNotes")
    elif sec == "poll":
        out = d.get("poll")
        out = {**(out or {}), "codes": {s["id"]: e["code"] for s in d["slides"] for e in s["elements"]
                                        if e["type"] == "poll"}}
    else:
        raise SystemExit("--section theme|layouts|layout:ID|assets|notes|poll")
    print(json.dumps(out, ensure_ascii=False, indent=1))


def cmd_text(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    el = find_el(find(new, args.id), args.elem)
    if el["type"] != "text":
        raise SystemExit(f"{args.elem} is a {el['type']}, not text")
    el["html"] = args.html if args.html is not None else to_html(args.text)
    commit(deck, new, args)


def cmd_notes(args):
    text = Path(args.file).read_text(encoding="utf-8").strip() if args.file else args.text
    if text is None:
        # No text and no --file used to blank the notes; read them with `get` instead.
        raise SystemExit('notes: give the new text or --file (to clear on purpose, pass "")')
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    find(new, args.id)["notes"] = text
    commit(deck, new, args)


def _requests(doc, everything=False):
    # Whole-deck requests (doc["requests"], typed in the slide list's "Whole
    # deck" field) come first with i = -1 and s = None; then each slide's.
    out = []
    for i, s, threads in [(-1, None, doc.get("requests") or [])] + [
            (i, s, s.get("comments") or []) for i, s in enumerate(doc["slides"])]:
        for c in threads:
            if not c.get("request"):
                continue
            status = _req_status(c)
            if everything or status not in ("done", "stopped") or _recent_stop(c):
                out.append((i, s, c, status))
    return out


def _req_status(c):
    # same order as slides/src/requests.ts requestStatus
    if c.get("status") == "stopped":
        return "stopped"
    return "done" if c.get("resolved") else c.get("status") or "open"


def _recent_stop(c, minutes=10):
    # a stop is listed (and wakes listeners) for 10 minutes, so the agent on it hears
    try:
        t = calendar.timegm(time.strptime(c.get("stoppedAt", "")[:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return False
    return c.get("status") == "stopped" and time.time() - t < minutes * 60


def _print_requests(doc, everything=False):
    rows = _requests(doc, everything)
    if not rows:
        print("no open requests" if not everything else "no requests")
    for i, s, c, status in rows:
        els = c.get("elementIds") or ([c["elementId"]] if c.get("elementId") else [])
        where = "[deck] whole deck" if s is None else f"[{i + 1}] {s['id']}"
        note = ""
        if status == "stopped":
            note = "  STOPPED by the person: stop now, keep the deck consistent, do not resume"
        elif c.get("rev") and status == "working":
            note = f"  EDITED while you work on it (rev {c['rev']}): re-read the text and adjust"
        elif c.get("rev"):
            note = f"  (edited, rev {c['rev']})"
        print(f"{where}  {c['id']}  {status}" + (f"  on {', '.join(els)}" if els else "") + note
              + f"\n    {c.get('author', '?')}: {c['text']}")
        for r in c.get("replies") or []:
            print(f"    > {r.get('author', '?')}: {r.get('text', '')}")
    return rows


def cmd_requests(args):
    if not args.wait:
        _print_requests(open_target(args.target).doc, args.all)
        return
    # Listener: the bridge marks the editor "Agent ready" while this
    # waits, and returns once an open editor reports pending requests.
    b = _bridge()
    b.start()
    p = Path(args.target)
    uri = p.resolve().as_uri() if p.suffix.lower() == ".html" else None
    deadline = time.time() + args.minutes * 60
    while time.time() < deadline:
        r = b.call("/wait", {"file": uri, "timeout": 20}, timeout=35)
        ready = r.get("sessions") or []
        if ready:
            time.sleep(1.5)  # let a burst of requests land together
            deck = LiveDeck(ready[0]["sessionId"]) if uri is None else open_target(args.target)
            print(f"new request(s) in {deck.path.name}:")
            _print_requests(deck.doc)
            return
    print(f"no requests in {args.minutes} min; stopped listening (do not re-arm unless asked)")


def cmd_reply(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    for threads in [new.get("requests") or []] + [s.get("comments") or [] for s in new["slides"]]:
        for c in threads:
            if c.get("id") == args.req and c.get("request"):
                if args.text:
                    c.setdefault("replies", []).append({
                        "id": "rep-" + uuid.uuid4().hex[:10], "author": agent_name(args),
                        "text": args.text, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                if c.get("status") == "stopped" and args.status != "stopped":
                    # the person stopped it: a late reply is kept, the stop stands
                    print(f"{args.req} was stopped by the person; status left as stopped", file=sys.stderr)
                else:
                    c["status"] = args.status
                    if args.status in ("done", "stopped"):
                        c["resolved"] = True
                    else:
                        c.pop("resolved", None)
                commit(deck, new, args)
                return
    raise SystemExit(f"no request {args.req}")


def cmd_ask(args):
    # Same shape as the editor's ask box (slides/src/editor/ask.ts).
    # An id already on the slide is a retry of the same request: nothing to do.
    # ID "-" records a request about the whole deck (doc["requests"]).
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    s = None if args.id == "-" else find(new, args.id)
    held = (new.get("requests") or []) if s is None else (s.get("comments") or [])
    rid = args.req_id or "req-" + uuid.uuid4().hex[:10]
    old = next((c for c in held if c.get("id") == rid), None)
    if old is not None:
        # a retry of the same request, or (--rev above the stored one) the
        # person's later edit or stop of it, relayed by a page with no bridge
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if args.state == "stopped":
            if old.get("status") == "stopped":
                print("no change")
                return
            old.update(status="stopped", resolved=True, stoppedAt=now)
        elif (args.rev or 0) > (old.get("rev") or 0):
            old.update(text=args.text, rev=args.rev, editedAt=now)
            if _req_status(old) in ("done", "stopped"):
                old["status"] = "open"
                old.pop("resolved", None)
                old.pop("stoppedAt", None)
        else:
            print("no change")
            return
        commit(deck, new, args)
        return
    c = {"id": rid, "request": True, "status": "open", "author": args.author, "text": args.text,
         "at": args.at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if args.element:
        c["elementId"] = args.element[0]
        if len(args.element) > 1:
            c["elementIds"] = args.element
    if s is None:
        new["requests"] = held + [c]
    else:
        s["comments"] = held + [c]
    commit(deck, new, args)


def cmd_set(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    s = find(new, args.id)
    obj = s if args.elem == "-" else find_el(s, args.elem)
    for kv in args.pairs:
        k, _, v = kv.partition("=")
        if not _:
            raise SystemExit(f"'{kv}': expected key=value")
        if k == "id":
            raise SystemExit("ids are immutable; use dup + rm")
        if v == "":
            obj.pop(k, None)
        else:
            obj[k] = parse_value(v)
    commit(deck, new, args)


def _insert(slides, slide, after, first=False):
    if first:
        slides.insert(0, slide)
    elif after:
        idx = next((i for i, s in enumerate(slides) if s["id"] == after), None)
        if idx is None:
            raise SystemExit(f"--after {after}: no such slide")
        slides.insert(idx + 1, slide)
    else:
        slides.append(slide)


def cmd_new(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    lay = next((l for l in new.get("layouts", []) if l["id"] == args.layout), None)         or deckio.layout_for(new, args.layout)
    if not lay:
        raise SystemExit(f"no layout '{args.layout}' — have: " + ", ".join(l["id"] for l in new.get("layouts", [])))
    els = copy.deepcopy(lay["elements"])
    for e in els:
        if e.get("placeholder") and e["type"] == "text":
            e["html"] = e["placeholder"]
    slide = {"id": args.id or fresh_id(new, "s-" + _role_name(lay["id"])),
             "name": args.name or lay.get("name", args.layout), "background": lay.get("background", "#FFFFFF"),
             "transition": lay.get("transition", "morph"), "notes": "", "elements": els}
    _insert(new["slides"], slide, args.after)
    commit(deck, new, args, structure=True)
    print(f"new slide {slide['id']}")


def cmd_copy(args):
    deck = open_target(args.target)
    if args.src_deck is None:
        args.src_deck = str(config.template())
    src = FileDeck(Path(args.src_deck)) if args.src_deck else deck
    s = copy.deepcopy(find(src.doc, args.src_id))
    new = copy.deepcopy(deck.doc)
    s["id"] = args.id or fresh_id(new, s["id"])
    s.pop("stateOf", None)
    # A copied poll must not share its source's answer bucket.
    from md_to_deck import mint_poll_code
    used = {e.get("code") for x in new["slides"] + src.doc["slides"] for e in x["elements"] if e["type"] == "poll"}
    for e in s["elements"]:
        if e["type"] == "poll":
            e["code"] = mint_poll_code(used)
            used.add(e["code"])
            print(f"  poll {e['id']}: fresh answer bucket {e['code']}")
    # A figure still on the live server is copied as the page itself: the
    # address only means something in the source deck's folder.
    staged = {"assets": dict(src.doc.get("assets", {})), "fonts": src.doc.get("fonts", [])}
    for line in bake_elements(staged, s["elements"], src.path.parent, final=True):
        print(line if line.startswith("!") else "  figure " + line.strip())
    src_assets = staged["assets"]
    for k in asset_refs(s):
        if k in src_assets:
            if new.setdefault("assets", {}).get(k) not in (None, src_assets[k]) and not args.overwrite_assets:
                print(f"  ! asset {k} differs in the target; kept the target's (--overwrite-assets to replace)")
                continue
            new["assets"][k] = src_assets[k]
    from md_to_deck import MATRIX_PAGE, apply_axes, parse_axes, parse_quads
    is_matrix = any(e["type"] == "embed" and str(e.get("asset", "")).startswith(MATRIX_PAGE) for e in s["elements"])
    if getattr(args, "axes", None) and not is_matrix:
        raise SystemExit(f"--axes: {args.src_id} is not a hive-matrix slide")
    if is_matrix:
        # every matrix slide carries its own page, with its axes in CONFIG
        axes = parse_axes(args.axes) if args.axes else None
        if axes is None:
            print("  ! no --axes: this slide keeps the template's example axes — set them with slide.py axes")
        cur = src.doc["assets"].get(next(e["asset"] for e in s["elements"] if e["type"] == "embed"
                                         and str(e.get("asset", "")).startswith(MATRIX_PAGE)))
        if axes is None:
            import re as _re
            axes = json.loads(_re.search(r"^  axes:(\[.*\]),$", cur, _re.M).group(1))
        key = apply_axes(new, s, axes, parse_quads(args.quads) if args.quads else None, base_page=cur)
        print(f"  axes: {' ; '.join(a['neg'] + ' | ' + a['pos'] for a in axes)} -> asset {key}")
    if src is deck:
        # A copy inside one deck gets its own figure page and poster: a figure is
        # revised by rewriting assets[key], so a shared key keeps the two slides
        # one figure. Plain images stay shared (the logo is on every slide).
        forked = {}

        def fork(k):
            if k not in new.get("assets", {}):
                return k
            if k not in forked:
                n = 2
                while f"{k}-{n}" in new["assets"]:
                    n += 1
                forked[k] = f"{k}-{n}"
                new["assets"][forked[k]] = new["assets"][k]
                print(f"  figure asset {k} -> own copy {forked[k]}")
            return forked[k]

        for e in s["elements"]:
            if e["type"] not in ("embed", "svg") or str(e.get("asset", "")).startswith(MATRIX_PAGE):
                continue
            if e.get("asset"):
                e["asset"] = fork(e["asset"])
            if e["type"] == "embed" and str(e.get("poster", "")).startswith("asset:"):
                e["poster"] = "asset:" + fork(e["poster"][6:])
    _insert(new["slides"], s, args.after, args.first)
    commit(deck, new, args, structure=True)
    print(f"copied as {s['id']}")


def cmd_axes(args):
    from md_to_deck import apply_axes, parse_axes, parse_quads
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    s = find(new, args.id)
    key = apply_axes(new, s, parse_axes(args.axes), parse_quads(args.quads) if args.quads else None)
    commit(deck, new, args)
    print(f"{args.id}: axes set -> asset {key}")


def cmd_dup(args):
    args.src_deck, args.src_id, args.overwrite_assets = "", args.id, False  # "" = this deck
    args.axes = args.quads = None
    args.id, args.first = args.new_id, False
    args.after = args.after or args.src_id
    cmd_copy(args)


def cmd_move(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    s = find(new, args.id)
    new["slides"].remove(s)
    _insert(new["slides"], s, args.after, args.first)
    commit(deck, new, args, structure=True)


def cmd_prune(args):
    deck = open_target(args.target)
    if deck.doc.get("template"):
        raise SystemExit("a master template keeps every asset: not pruned")
    drop = unused_assets(deck.doc)
    mb = sum(len(json.dumps(deck.doc["assets"][k])) for k in drop) / 1e6
    print(f"{len(drop)} unused asset(s), {mb:.1f} MB" + ("" if drop else ": nothing to drop"))
    if not drop or not args.go:
        if drop:
            print("  " + ", ".join(drop[:30]) + (" …" if len(drop) > 30 else ""))
            print("  (--go to delete them)")
        return
    new = copy.deepcopy(deck.doc)
    for k in drop:
        del new["assets"][k]
    commit(deck, new, args, structure=True)


def cmd_rm(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    for sid in args.ids:
        new["slides"].remove(find(new, sid))
    commit(deck, new, args, structure=True)


def cmd_asset(args):
    import base64
    import mimetypes
    deck = open_target(args.target)
    f = Path(args.file)
    mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if f.suffix.lower() in (".html", ".htm"):
        # An embed page asset is the page's HTML itself (rendered via srcdoc),
        # never a data URI: a data URI shows up as literal text in the frame.
        uri = f.read_text(encoding="utf-8")
    else:
        uri = f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode()
    new = copy.deepcopy(deck.doc)
    new.setdefault("assets", {})[args.key] = uri
    commit(deck, new, args)


def _work(deck, sid):
    d = deck.build / "work"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{sid}.json", d / f"{sid}.base.json"


def cmd_pull(args):
    deck = open_target(args.target)
    s = find(deck.doc, args.id)
    work, base = _work(deck, args.id)
    body = fmt_slide(s)
    base.write_text(body, encoding="utf-8")
    work.write_text(body, encoding="utf-8")
    big = [e["id"] for e in s["elements"] if len(json.dumps(e)) > 20000]
    print(f"{work}  ({len(s['elements'])} elements"
          + (f"; large: {', '.join(big)} — edit around them" if big else "") + ")")


def cmd_push(args):
    deck = open_target(args.target)
    work, base = _work(deck, args.id)
    if not base.exists():
        raise SystemExit(f"pull {args.id} first")
    b = json.loads(base.read_text(encoding="utf-8"))
    w = json.loads(work.read_text(encoding="utf-8"))
    if w.get("id") != args.id:
        raise SystemExit("the slide id in the work file changed; ids are immutable")
    patches = [dict(p, path=["slides", {"id": args.id}] + p["path"]) for p in diff(b, w)]
    if not patches:
        print("no change")
        return
    if args.dry_run:
        print(_lines(patches))
        return
    agent = agent_name(args)
    _check_claims(deck, patches, agent)
    try:
        deck.apply(patches, agent)
    except Conflict as e:
        deck = open_target(args.target)
        now = find(deck.doc, args.id)
        theirs = {_fmt(p["path"]) for p in diff(b, now)}
        mine = {_fmt(p["path"]) for p in diff(b, w)}
        raise SystemExit(f"conflict: {e}\n  changed by someone else since pull: {sorted(theirs) or '-'}\n"
                         f"  overlapping your edits: {sorted(theirs & mine) or '-'}\n"
                         f"  -> `slide.py pull` again and redo only the overlapping part")
    base.write_text(work.read_text(encoding="utf-8"), encoding="utf-8")
    _log(deck, agent, patches)
    print(f"pushed {len(patches)} change(s) to {args.id} as {agent}")


def cmd_claim(args):
    deck = open_target(args.target)
    f = _claims_file(deck)
    f.parent.mkdir(parents=True, exist_ok=True)
    c = _claims(deck)
    for sid in args.ids:
        find(deck.doc, sid)
        if args.release:
            c.pop(sid, None)
        elif c.get(sid) not in (None, args.agent) and not args.force:
            raise SystemExit(f"{sid} already claimed by {c[sid]} (--force to take it)")
        else:
            c[sid] = args.agent
    f.write_text(json.dumps(c, indent=1), encoding="utf-8")
    print(json.dumps(c))


def cmd_who(args):
    deck = open_target(args.target)
    print("claims:", json.dumps(_claims(deck)))
    log = deck.build / "work" / "log.jsonl"
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines()[-args.n:]:
            print(line)


def cmd_repair(args):
    """Re-escape a doc block that some writer left with raw '<'. Same document, file only."""
    path = Path(args.target)
    if not path.is_file():
        raise SystemExit(f"{path}: repair takes a deck file")
    if live_for_file(path):
        raise SystemExit(f"{path.name} is open in the editor; its next save writes an escaped block")
    deck = FileDeck.__new__(FileDeck)
    deck.path, deck.build = path.resolve(), path.resolve().parent / "build"
    with deck._lock():
        text = path.read_text(encoding="utf-8")
        found = unescaped_doc(text)
        if not found:
            json.loads(DOC_RE.search(text).group(2))  # healthy, or broken some other way
            print(f"{path.name}: doc block is fine")
            return
        doc, start, end = found
        payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        out = text[:start] + payload + text[end:]
        if json.loads(DOC_RE.search(out).group(2)) != doc:
            raise SystemExit("repair failed validation; file untouched")
        _rotate_bak(path)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(out, encoding="utf-8")
        os.replace(tmp, path)
    print(f"{path.name}: doc block re-escaped ({len(doc.get('slides', []))} slides, content unchanged)")


# ─────────────────────────────────────────────────────── figures in the file
#
# A figure being built runs on the edit canvas from its source page on the live
# server (`devSrc`, http://127.0.0.1:5173/build/figures/NAME.html). The page of
# record is always assets[el.asset]: that is what the show, a copy of the slide
# and a published deck load. The open editor keeps the asset current by itself
# (slides/src/dev-figures.ts); `bake` does the same for a file, and
# adopts slides from before devSrc, which carry only a loopback `src`.

LOOPBACK = re.compile(r"^http://(?:127[.]0[.]0[.]1|localhost)(?::[0-9]+)?/([^?#]*)")


def dev_url(e):
    """The loopback address a figure element still depends on, or None."""
    if e.get("type") != "embed":
        return None
    if LOOPBACK.match(str(e.get("devSrc") or "")):
        return e["devSrc"]
    if not e.get("asset") and not e.get("html") and LOOPBACK.match(str(e.get("src") or "")):
        return e["src"]
    return None


def figure_page(root: Path, url: str, doc) -> str:
    """The page behind a loopback address, read from the deck folder, with the
    deck's text font inlined exactly as embed_font.py does."""
    from urllib.parse import unquote
    f = root / unquote(LOOPBACK.match(url).group(1))
    if not f.is_file():
        raise FileNotFoundError(str(f))
    text = f.read_text(encoding="utf-8")
    if "url(MANROPE)" in text:
        fonts = sorted((x for x in doc.get("fonts", []) if x.get("family") == "Manrope"),
                       key=lambda x: "latin-ext" in x["asset"])
        uri = doc.get("assets", {}).get(fonts[0]["asset"]) if fonts else None
        if uri:
            text = text.replace("url(MANROPE)", f"url({uri})")
    return text


def bake_elements(doc, elements, root: Path, final=False) -> list[str]:
    """Write each live figure's page into doc['assets']. Returns report lines;
    a line starting '!' is a figure that could not be baked."""
    out = []
    assets = doc.setdefault("assets", {})
    for e in elements:
        url = dev_url(e)
        if not url:
            continue
        try:
            page = figure_page(root, url, doc)
        except FileNotFoundError as err:
            out.append(f"! {e['id']}: {url} has no file at {err}")
            continue
        if not e.get("asset"):
            base = "page-" + re.sub(r"[^A-Za-z0-9_-]+", "-", Path(LOOPBACK.match(url).group(1)).stem)
            key, n = base, 2
            while key in assets:
                key, n = f"{base}-{n}", n + 1
            e["asset"] = key
        state = "unchanged" if assets.get(e["asset"]) == page else "baked"
        assets[e["asset"]] = page
        if e.get("src") == url:
            del e["src"]
        if final:
            e.pop("devSrc", None)
        else:
            e["devSrc"] = url
        out.append(f"  {e['id']}: {state} -> asset {e['asset']}" + (" (devSrc dropped)" if final else ""))
    return out


def doctor(doc) -> list[str]:
    """Everything that makes a slide depend on something outside the file."""
    out, assets, owners = [], doc.get("assets", {}), {}
    state_of = {s["id"]: s.get("stateOf") for s in doc["slides"]}
    for s in doc["slides"]:
        for e in s["elements"]:
            where = f"{s['id']}/{e['id']}"
            if e["type"] == "embed":
                url = dev_url(e)
                if url and not e.get("asset"):
                    out.append(f"{where}: figure is NOT in the file, only {url} (slide.py bake)")
                elif url:
                    out.append(f"{where}: still on the live server ({url}); the file has a copy "
                               "(slide.py bake --final when the figure is done)")
                elif not e.get("asset") and not e.get("html") and e.get("src"):
                    out.append(f"{where}: loads a remote page ({e['src']}); needs the network")
                if not e.get("poster"):
                    out.append(f"{where}: no poster; blank on the canvas and in the thumbnails")
                if e.get("asset") and not str(e["asset"]).startswith("page-hive-matrix"):
                    # a state slide shows its parent's figure on purpose
                    owners.setdefault(e["asset"], set()).add(state_of[s["id"]] or s["id"])
            for k in asset_refs(e):
                if k not in assets:
                    out.append(f"{where}: asset {k} is missing from the file")
    for key, slides in owners.items():
        if len(slides) > 1:
            out.append(f"figure page {key} is shared by {', '.join(sorted(slides))}: "
                       "revising one rewrites the others")
    try:                                    # a page that scales itself to a frame with no size
        import fitguard
        for key, html in fitguard.doc_pages(doc):
            if fitguard.scales(html) and not fitguard.guarded(html):
                out.append(f"figure page {key} scales itself to its frame without a zero-size guard: "
                           "blank when the slideshow starts on its slide (fitguard.py --deck DECK --fix)")
    except ImportError:
        pass
    return out


def cmd_doctor(args):
    deck = open_target(args.target)
    found = doctor(deck.doc)
    for line in found:
        print(line)
    if found:
        raise SystemExit(1)
    print(f"{deck.path.name}: every figure and asset is in the file")


def cmd_bake(args):
    deck = open_target(args.target)
    new = copy.deepcopy(deck.doc)
    root = Path(args.root) if args.root else deck.path.parent
    lines = [line for s in new["slides"] for line in bake_elements(new, s["elements"], root, args.final)]
    print("\n".join(lines) if lines else "no figure on the live server")
    commit(deck, new, args)
    if any(line.startswith("!") for line in lines):
        raise SystemExit(1)


def _closed_file(path: Path, instead: str) -> FileDeck:
    """For the file-only commands: an open editor would save over the change
    (and refuses document-level patches anyway)."""
    if not config.flag("TESSERA_NO_LIVE") and live_for_file(path):
        raise SystemExit(f"{path.name} is open in the editor: {instead}, or close the tab first")
    return FileDeck(path)


def _rewrite(deck: FileDeck, mutate):
    """Change a closed file's whole document: lock, mutate(doc), validate,
    back it up (deckio.backup). Returns what mutate returns."""
    with deck._lock():
        text, doc = deck._read()
        result = mutate(doc)
        payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("<", chr(92) + "u003c")
        m = DOC_RE.search(text)
        out = text[:m.start(2)] + payload + text[m.end(2):]
        if json.loads(DOC_RE.search(out).group(2)) != doc:
            raise SystemExit("rewrite failed validation; file untouched")
        _rotate_bak(deck.path)
        tmp = deck.path.with_suffix(".tmp")
        tmp.write_text(out, encoding="utf-8")
        os.replace(tmp, deck.path)
    deck.doc = doc
    return result


def remint_codes(doc) -> dict[str, str]:
    """A fresh, empty answer bucket for every poll; returns {old: new}. One old
    code maps to one new code, so a state or reporting slide keeps sharing the
    bucket of the question it shows. A page asset that names an old code
    literally (a figure's fallback, a report reading another slide's bucket) is
    repointed to the new one."""
    from md_to_deck import mint_poll_code
    used = {e.get("code", "") for s in doc["slides"] for e in s["elements"] if e["type"] == "poll"}
    mapping: dict[str, str] = {}
    for s in doc["slides"]:
        for e in s["elements"]:
            if e["type"] == "poll":
                old = e.get("code", "")
                if old not in mapping:
                    mapping[old] = mint_poll_code(used)
                e["code"] = mapping[old]
    swap = {o: n for o, n in mapping.items() if o}
    if swap:
        rx = re.compile(r"\b(" + "|".join(map(re.escape, swap)) + r")\b")
        for k, v in (doc.get("assets") or {}).items():
            if isinstance(v, str) and not v.startswith("data:") and rx.search(v):
                doc["assets"][k] = rx.sub(lambda m: swap[m.group(1)], v)
    return mapping


def _hardcoded(doc, codes) -> list[str]:
    """Pages in the deck that name one of these bucket codes literally (a figure
    reading a bucket that is not the nearest poll before it)."""
    hits = []
    for k, v in sorted((doc.get("assets") or {}).items()):
        if isinstance(v, str) and not v.startswith("data:"):
            found = sorted(c for c in codes if c and re.search(rf"\b{re.escape(c)}\b", v))
            if found:
                hits.append(f"{k} ({', '.join(found)})")
    return hits


def cmd_fork(args):
    """A file copied in Explorer (or saved by an older shell's Save a copy) is still the SAME
    deck: one docId means one tab-to-tab channel and recovery slot, so two
    versions merge into each other. This makes the copy its own deck."""
    path = Path(args.target)
    deck = _closed_file(path, "use the editor's 'Make this file independent' banner (shown while both copies are open) there")
    mapping: dict[str, str] = {}

    def go(doc):
        old = doc.get("docId")
        doc["docId"] = str(uuid.uuid4())
        doc.pop("collab", None)  # upstream's relay key: the fork has no relay
        if args.polls:
            mapping.update(remint_codes(doc))
            if (doc.get("poll") or {}).get("session"):
                from md_to_deck import mint_poll_code
                doc["poll"]["session"] = "s" + mint_poll_code(set(mapping.values()))
        return old

    old = _rewrite(deck, go)
    print(f"{path.name}: docId {str(old)[:8]}... -> {deck.doc['docId'][:8]}..."
          + (", poll codes and join code reminted" if args.polls else ", poll codes kept"))
    for hit in _hardcoded(deck.doc, mapping):
        print(f"  ! {hit} still names the old code: point it at the new one")


def cmd_template(args):
    """Flag a master template: every open of a file carrying `template: true`
    mints a fresh deck (docId, poll codes, join code). Opening the master in the
    editor consumes the flag, and the editor has no toggle for it any more."""
    path = Path(args.target)
    deck = _closed_file(path, "the editor would save over the flag")

    def go(doc):
        if args.off:
            doc.pop("template", None)
        else:
            doc["template"] = True
            doc.pop("docId", None)  # as model.ts asTemplateFile: each open mints its own
            doc.pop("collab", None)

    _rewrite(deck, go)
    print(f"{path.name}: " + ("template flag removed" if args.off else "template: true (every open starts a fresh deck)"))


# ────────────────────────────────────── poll service (the presenter routes)
#
# The same calls the editor makes (slides/src/poll.ts): clear a
# bucket, read its answers, claim a join code, publish an activity's phone
# page. The routes are in server/poll-worker/src/api/. All need the
# lecturer key, read like publish.py does (TESSERA_LECTURER_KEY in the
# .env) and never printed.

UA = config.USER_AGENT  # Cloudflare refuses Python's default user agent (error 1010)
JOIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$")  # model.ts isJoinCode, _lib.js SESSION_RE
MAX_ACTIVITY_HTML_CHARS = 60_000  # _lib.js


class ServiceError(Exception):
    pass


def _lecturer_key() -> str:
    return config.get("TESSERA_LECTURER_KEY")


def _service(doc, el=None) -> str:
    s = ((el or {}).get("service") or (doc.get("poll") or {}).get("service") or "").rstrip("/")
    if not s:
        raise SystemExit("this deck names no poll service (doc.poll.service)")
    return s


def _short(v):
    if isinstance(v, str) and len(v) > 80:
        return f"<{len(v)} chars>"
    return v


def _call(method, url, key, body=None, dry=False):
    """One presenter request. --dry-run prints it (never the key)."""
    if dry:
        shown = [json.dumps({k: _short(v) for k, v in body.items()})] if body else []
        print(" ".join([method, url, *shown, f"[lecturer key: {'set' if key else 'MISSING'}]"]))
        return None
    import urllib.error
    import urllib.request
    headers = {"user-agent": UA, **config.lecturer_headers(key)}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    where = url.split("?")[0]
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error") or ""
        except ValueError:
            msg = ""
        if e.code == 401:
            raise ServiceError(f"{method} {where}: 401, the service wants the lecturer key "
                               "(TESSERA_LECTURER_KEY=<key> in the .env)") from None
        raise ServiceError(f"{method} {where}: HTTP {e.code} {msg}".rstrip()) from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise ServiceError(f"cannot reach {where}: {e}") from None


def _polls(doc, slide_id=None):
    """[(slide number, slide, poll)] in slide order, one per distinct bucket."""
    out, seen = [], set()
    for n, s in enumerate(doc["slides"], 1):
        if slide_id and s["id"] != slide_id:
            continue
        for e in s["elements"]:
            if e["type"] == "poll" and e.get("code") and e["code"] not in seen:
                seen.add(e["code"])
                out.append((n, s, e))
    if slide_id and not out:
        find(doc, slide_id)
        raise SystemExit(f"slide {slide_id} has no poll")
    return out


def _one_or_all(args):
    if bool(args.slide) == bool(args.all):
        raise SystemExit("name one SLIDE_ID, or --all for every poll in the deck")


def poll_clear(args):
    _one_or_all(args)
    deck = open_target(args.target)
    polls = _polls(deck.doc, args.slide)
    codes = [e["code"] for _, _, e in polls]
    if not args.yes and not args.dry_run:
        raise SystemExit(f"this deletes every answer and uploaded image in {len(codes)} bucket(s) "
                         f"({', '.join(codes)}), for good. Re-run with --yes")
    key, total, failed = _lecturer_key(), 0, []
    for _, s, e in polls:
        try:
            r = _call("DELETE", f"{_service(deck.doc, e)}/api/poll?c={e['code']}", key, dry=args.dry_run)
        except ServiceError as err:
            failed.append(f"{s['id']} ({e['code']}): {err}")
            continue
        if r is not None:
            total += int(r.get("cleared") or 0)
            print(f"  cleared {s['id']} ({e['code']}): {r.get('cleared', 0)} answer(s), {r.get('images', 0)} image(s)")
    for f in failed:
        print(f"  ! {f}")
    if not args.dry_run:
        print(f"{len(codes) - len(failed)} of {len(codes)} bucket(s) cleared, {total} answer(s) deleted; codes kept")
    if failed:
        raise SystemExit(1)


def _result(e, answers) -> tuple[float | None, str]:
    kind = e.get("kind", "open")
    texts = [str(a.get("text", "")) for a in answers]
    if kind == "choice":
        counts = {o: 0 for o in e.get("options") or []}
        other = 0
        for t in texts:
            picks = [t]
            if e.get("multi"):
                with contextlib.suppress(ValueError, TypeError, AttributeError):
                    picks = json.loads(t).get("picks") or [t]
            for p in picks:
                if p in counts:
                    counts[p] += 1
                else:
                    other += 1
        return None, "; ".join([f"{o}: {c}" for o, c in counts.items()] + ([f"Other: {other}"] if other else []))
    if kind == "rating":
        vals = [float(t) for t in texts if re.fullmatch(r"-?\d+(\.\d+)?", t.strip())]
        return (round(sum(vals) / len(vals), 2) if vals else None), ""
    return None, e.get("summary", "") if kind == "open" else ""


def poll_export(args):
    deck = open_target(args.target)
    doc = deck.doc
    polls = _polls(doc)
    if not polls:
        raise SystemExit("this deck has no polls")
    out = Path(args.out) if args.out else deck.build / f"{deck.path.stem}-answers.xlsx"
    key = _lecturer_key()
    loaded, failed, withheld = [], [], []
    for n, s, e in polls:
        try:
            d = _call("GET", f"{_service(doc, e)}/api/poll?c={e['code']}", key, dry=args.dry_run)
        except ServiceError as err:
            failed.append(f"{s['id']} ({e['code']}): {err}")
            continue
        if d is None:
            continue
        if d.get("answersWithheld"):
            withheld.append(e["code"])
        loaded.append((n, s, e, d.get("answers") or []))
    if args.dry_run:
        print(f"would write {out}")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    names = any(a.get("name") for *_, ans in loaded for a in ans)
    try:
        if out.suffix.lower() == ".csv":
            raise ImportError
        import openpyxl
    except ImportError:
        import csv
        out = out.with_suffix(".csv")
        with out.open("w", newline="", encoding="utf-8-sig") as fh:
            w = csv.writer(fh)
            w.writerow(["slide", "slide_id", "code", "kind", "question", "#", "time"] + (["name"] if names else []) + ["answer"])
            for n, s, e, ans in loaded:
                for i, a in enumerate(ans, 1):
                    w.writerow([n, s["id"], e["code"], e.get("kind", "open"), e.get("question", ""), i, a.get("at", "")]
                               + ([a.get("name", "")] if names else []) + [a.get("text", "")])
    else:
        wb = openpyxl.Workbook()
        ov = wb.active
        ov.title = "Overview"
        ov.append(["Slide", "Slide id", "Question", "Type", "Code", "Responses", "Average", "Result"])
        for q, (n, s, e, ans) in enumerate(loaded, 1):
            avg, res = _result(e, ans)
            ov.append([n, s["id"], e.get("question", ""), e.get("kind", "open"), e["code"], len(ans), avg,
                       "withheld (no lecturer key)" if e["code"] in withheld else res])
            sh = wb.create_sheet(re.sub(r"[\[\]:*?/\\]", "", f"Q{q} {s['id']}")[:31])
            sh.append([f"Q{q} · {e.get('question', '')}"])
            sh.append(["Join code", e["code"], "Responses", len(ans)])
            sh.append([])
            sh.append(["#", "Time"] + (["Name"] if names else []) + ["Answer"])
            for i, a in enumerate(ans, 1):
                sh.append([i, a.get("at", "")] + ([a.get("name", "")] if names else []) + [a.get("text", "")])
        wb.save(out)
    print(f"{out}: {len(loaded)} question(s), {sum(len(a) for *_, a in loaded)} answer(s)")
    for f in failed:
        print(f"  ! not loaded: {f}")
    if withheld:
        print(f"  ! answers withheld (no or wrong lecturer key) for {', '.join(withheld)}: "
              "the counts are right, the answers are missing")
    if failed or withheld:
        raise SystemExit(1)


def to_join_code(typed: str) -> str:
    """model.ts toJoinCode: "My Class 2026" -> "my-class-2026"."""
    c = re.sub(r"[\s_]+", "-", typed.strip().lower())
    c = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9-]", "", c)).strip("-")
    return c[:24].rstrip("-")


def poll_code(args):
    path = Path(args.target)
    deck = _closed_file(path, "set it with the join-code button in the top bar")
    code = to_join_code(args.code)
    if not JOIN_RE.match(code):
        raise SystemExit(f"'{args.code}': a join code is 3 to 24 of a-z, 0-9 and inner hyphens")
    same = code == (deck.doc.get("poll") or {}).get("session")
    if same and not args.fresh:
        print(f"{path.name}: the join code is already {code}")
        return
    if not same:
        try:
            r = _call("POST", f"{_service(deck.doc)}/api/session", _lecturer_key(),
                      {"s": code, "claim": True}, dry=args.dry_run)
        except ServiceError as err:
            raise SystemExit(str(err)) from None
        if r and r.get("existed"):
            print(f"  note: {code} was already registered (this deck earlier, or another one); "
                  "a room still on it follows this deck now")
    if args.dry_run:
        print(f"would set doc.poll.session = {code}" + (", and remint every poll code" if args.fresh else ""))
        return

    def go(doc):
        if not isinstance(doc.get("poll"), dict):
            doc["poll"] = {}
        doc["poll"]["session"] = code
        return remint_codes(doc) if args.fresh else {}

    mapping = _rewrite(deck, go)
    print(f"{path.name}: join code {code}" + (f", {len(mapping)} question(s) start empty" if mapping else ""))
    for hit in _hardcoded(deck.doc, mapping):
        print(f"  ! {hit} still names the old code: point it at the new one")


def cmd_service(args):
    """Point a closed deck's polls at a poll service (doc.poll.service)."""
    path = Path(args.target)
    url = (args.url or config.get("TESSERA_POLL_SERVICE")).rstrip("/")
    if not url:
        raise SystemExit("no URL given and TESSERA_POLL_SERVICE is not set (.env): "
                         "pass the service, e.g. https://join.<subdomain>.workers.dev")
    if not re.match(r"^https?://[^/\s]+", url):
        raise SystemExit(f"'{url}' is not an http(s) address")
    deck = _closed_file(path, "close the tab first (the editor would save over it)")
    old = (deck.doc.get("poll") or {}).get("service", "")
    if old == url:
        print(f"{path.name}: poll service is already {url}")
        return
    if args.dry_run:
        print(f"would set doc.poll.service = {url} (was: {old or 'none'})")
        return

    def go(doc):
        if not isinstance(doc.get("poll"), dict):
            doc["poll"] = {}
        doc["poll"]["service"] = url

    _rewrite(deck, go)
    print(f"{path.name}: poll service {old or 'none'} -> {url}")
    overrides = sorted({s["id"] for s in deck.doc["slides"] for e in s["elements"]
                        if e["type"] == "poll" and e.get("service") and e["service"].rstrip("/") != url})
    if overrides:
        print(f"  note: these polls name their own service and keep it: {', '.join(overrides)}")


def activity_page(doc, slide, el) -> str:
    """What the deck publishes for an activity poll (poll.ts
    activityPageWithTexts): its page, with the slide's reworded labels in front."""
    html = (doc.get("assets") or {}).get(el["activityAsset"], "") if el.get("activityAsset") else el.get("activityHtml", "")
    if html.startswith("data:"):
        import base64
        import urllib.parse
        head, _, data = html.partition(",")
        html = (base64.b64decode(data).decode("utf-8") if head.endswith(";base64")
                else urllib.parse.unquote(data))
    texts = {}
    for e in slide["elements"]:
        if e["type"] == "embed" and isinstance(e.get("texts"), dict):
            texts.update({k: v for k, v in e["texts"].items() if isinstance(v, str)})
    if not texts:
        return html
    js = json.dumps(texts, ensure_ascii=False).replace("<", chr(92) + "u003c")
    # both names: a page written before the rename reads the old one
    new, old = "window.TESSERA_EMBED", "window." + legacy.EMBED_GLOBAL
    init = ("<script>(function(){var E=" + new + "=" + old + "=Object.assign(" + new + "||" + old + "||{},{texts:" + js + "});"
            "if(typeof E.text!=='function')E.text=function(k,d){return Object.prototype.hasOwnProperty.call(E.texts,k)?E.texts[k]:d};})()"
            "</" + "script>")
    out = init + html
    return html if len(out) > MAX_ACTIVITY_HTML_CHARS else out


def poll_publish(args):
    _one_or_all(args)
    deck = open_target(args.target)
    doc = deck.doc
    targets = [(s, e) for _, s, e in _polls(doc, args.slide) if e.get("kind") == "activity" and not e.get("frozen")]
    if not targets:
        raise SystemExit("no live activity poll there (only `kind: activity` has a phone page)")
    key, failed = _lecturer_key(), []
    for s, e in targets:
        html = activity_page(doc, s, e)
        if not html.strip():
            failed.append(f"{s['id']}: the poll has no page (activityAsset / activityHtml)")
            continue
        if len(html) > MAX_ACTIVITY_HTML_CHARS:
            failed.append(f"{s['id']}: page is {len(html)} chars, over the service's {MAX_ACTIVITY_HTML_CHARS}")
            continue
        try:
            r = _call("POST", f"{_service(doc, e)}/api/poll", key, {"code": e["code"], "html": html}, dry=args.dry_run)
        except ServiceError as err:
            failed.append(f"{s['id']} ({e['code']}): {err}")
            continue
        if r is not None:
            print(f"  published {s['id']} ({e['code']}): {len(html)} chars")
    for f in failed:
        print(f"  ! {f}")
    if failed:
        raise SystemExit(1)


# ──────────────────────────────────────────────────────────────────── CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def p(name, fn, *pos, write=False, **kw):
        q = sub.add_parser(name, **kw)
        q.add_argument("target", help="deck.html | live | SESSION_ID")
        for a in pos:
            q.add_argument(a)
        q.add_argument("--agent", default=None, help="your name, shown in the editor ($TESSERA_AGENT)")
        if write:
            q.add_argument("--dry-run", action="store_true", help="print the patches only")
        q.set_defaults(func=fn)
        return q

    p("ls", cmd_ls, help="one line per slide")
    q = p("get", cmd_get, "id", help="one slide's JSON (data URIs shortened)")
    q.add_argument("--out")
    q = p("info", cmd_info, help="one section of the document")
    q.add_argument("--section", required=True)
    q = p("text", cmd_text, "id", "elem", write=True, help="replace a text element's content")
    q.add_argument("text", nargs="?", default="")
    q.add_argument("--html", default=None, help="raw html instead of plain text")
    q = p("notes", cmd_notes, "id", write=True, help="set speaker notes")
    q.add_argument("text", nargs="?", default=None)
    q.add_argument("--file")
    q = p("requests", cmd_requests, help="change requests typed in the slide list (slides and whole deck)")
    q.add_argument("--all", action="store_true", help="include finished ones")
    q.add_argument("--wait", action="store_true", help="block until the open editor has open requests")
    q.add_argument("--minutes", type=float, default=115, help="--wait gives up after this long")
    q = p("reply", cmd_reply, "req", write=True, help="answer a request and set its status")
    q.add_argument("text", nargs="?", default="")
    q.add_argument("--status", choices=["working", "done", "stopped"], default="done")
    q = p("ask", cmd_ask, "id", write=True, help="record a change request on slide ID (- = whole deck)")
    q.add_argument("text")
    q.add_argument("--id", dest="req_id", default=None)
    q.add_argument("--author", default=config.get("TESSERA_AUTHOR") or "",
                   help="who asked (default $TESSERA_AUTHOR)")
    q.add_argument("--at", default=None)
    q.add_argument("--element", nargs="+", default=None)
    q.add_argument("--rev", type=int, default=0, help="an edit of request --id (above its stored rev)")
    q.add_argument("--state", choices=["stopped"], default=None, help="the person stopped request --id")
    q = p("set", cmd_set, "id", "elem", write=True, help="set fields: ELEM or - for the slide")
    q.add_argument("pairs", nargs="+", help="key=value (JSON-parsed if valid); key= deletes")
    q = p("new", cmd_new, write=True, help="new slide from a layout")
    q.add_argument("--layout", required=True, help="a layout id, or its role (points, title, ...)")
    q.add_argument("--id")
    q.add_argument("--name")
    q.add_argument("--after")
    q = p("copy", cmd_copy, "src_id", write=True, help="copy a slide (+ its assets) from another deck")
    q.add_argument("--from", dest="src_deck", default=None,
                   help="the deck to copy from (default: $TESSERA_TEMPLATE)")
    q.add_argument("--id")
    q.add_argument("--after")
    q.add_argument("--first", action="store_true")
    q.add_argument("--overwrite-assets", action="store_true")
    q.add_argument("--axes", nargs="+", help="hive-matrix slide: 'Low|High' (one or two)")
    q.add_argument("--quads", help="hive-matrix slide, two axes: 'TL|TR|BL|BR'")
    q = p("axes", cmd_axes, "id", write=True, help="set a hive-matrix slide's axes")
    q.add_argument("--axes", nargs="+", required=True, help="'Low|High' (one or two); a pole may be 'Label = definition'")
    q.add_argument("--quads", help="two axes: 'TL|TR|BL|BR'")
    q = p("dup", cmd_dup, "id", write=True, help="duplicate a slide right after itself")
    q.add_argument("--id", dest="new_id")
    q.add_argument("--after")
    q = p("move", cmd_move, "id", write=True, help="reorder")
    q.add_argument("--after")
    q.add_argument("--first", action="store_true")
    q = p("rm", cmd_rm, write=True, help="delete slides")
    q.add_argument("ids", nargs="+")
    p("asset", cmd_asset, "key", "file", write=True, help="add/replace one asset from a file")
    p("pull", cmd_pull, "id", help="slide -> build/work/ID.json for editing")
    p("push", cmd_push, "id", write=True, help="send your edits of build/work/ID.json")
    q = p("claim", cmd_claim, help="assign slides to an agent")
    q.add_argument("ids", nargs="+")
    q.add_argument("--release", action="store_true")
    q.add_argument("--force", action="store_true")
    q = p("who", cmd_who, help="claims and recent pushes")
    q.add_argument("-n", type=int, default=15)
    p("repair", cmd_repair, help="re-escape a doc block left with a raw '<' (file only)")
    p("doctor", cmd_doctor, help="what in this deck depends on something outside the file")
    q = p("prune", cmd_prune, write=True, help="delete assets nothing in the deck uses (publish.py teach runs it)")
    q.add_argument("--go", action="store_true", help="delete them (default: list only)")
    q = p("bake", cmd_bake, write=True, help="put every live-server figure into the file")
    q.add_argument("--final", action="store_true", help="also drop devSrc: the figure is finished")
    q.add_argument("--root", help="folder the live server serves (default: the deck's folder)")
    q = p("fork", cmd_fork, help="new docId for a copied file (file only)")
    q.add_argument("--polls", action="store_true", help="also remint every poll code and the join code")
    q = p("template", cmd_template, help="flag a master template: every open starts a fresh deck (file only)")
    q.add_argument("--off", action="store_true", help="remove the flag")

    q = sub.add_parser("service", help="set the deck's poll service (doc.poll.service; file only)")
    q.add_argument("target", help="deck.html (closed)")
    q.add_argument("url", nargs="?", default=None, help="default: TESSERA_POLL_SERVICE")
    q.add_argument("--dry-run", action="store_true", help="say what would change")
    q.set_defaults(func=cmd_service)

    pq = sub.add_parser("poll", help="the deck's polls on the poll service: clear, export, code, publish")
    psub = pq.add_subparsers(dest="action", required=True)

    def pp(name, fn, help, slide=False):
        q = psub.add_parser(name, help=help)
        q.add_argument("target", help="deck.html | live | SESSION_ID" if name != "code" else "deck.html (closed)")
        if slide:
            q.add_argument("slide", nargs="?", help="a slide id")
            q.add_argument("--all", action="store_true", help="every poll in the deck")
        q.add_argument("--dry-run", action="store_true", help="print the requests only (never the key)")
        q.set_defaults(func=fn)
        return q

    q = pp("clear", poll_clear, "delete the answers in that slide's bucket (or --all); codes kept", slide=True)
    q.add_argument("--yes", action="store_true", help="required: the answers are gone for good")
    q = pp("export", poll_export, "every poll's answers in one .xlsx (or .csv)")
    q.add_argument("--out", help="default: build/<deck>-answers.xlsx")
    q = pp("code", poll_code, "claim a join code on the service and set doc.poll.session")
    q.add_argument("code", help="e.g. my-class-2026 (3-24 of a-z, 0-9, inner hyphens)")
    q.add_argument("--fresh", action="store_true", help="also give every question a new, empty bucket")
    pp("publish", poll_publish, "push an activity's phone page to the service now", slide=True)

    args = ap.parse_args()
    if args.cmd == "claim" and not args.agent and not args.release:
        raise SystemExit("claim needs --agent NAME")
    args.func(args)


if __name__ == "__main__":
    main()
