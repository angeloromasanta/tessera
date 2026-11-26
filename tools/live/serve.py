"""Live previews of decks: one function, serve(), plus a small server to run it.

For watching a deck from another computer (or a phone) while it is being
edited here. Two ways to run it:

    python tools/live/serve.py [--port 8000] [--decks tools/live/decks.json]
        serves http://127.0.0.1:<port>/deck/<slug> (TESSERA_LIVE_LOCAL sets the
        default address). Put it behind a tunnel to reach it from elsewhere, and
        set TESSERA_LIVE_URL to that public address.
    an app that mounts serve(method, path, key, body, prefix, query) under /deck
        (it re-loads this file when it changes; nothing to restart).

`decks.json` (beside this file unless --decks says otherwise; see
decks.example.json) maps a slug to a deck file, and is read on every request,
so `publish.py live` adding or removing a deck takes effect at once. A relative
path is taken from the checkout's folder:

    {"decks": {"my-talk": "decks/my-talk/my-talk.html"}}

    /<slug>            the deck, with sync.js appended
    /<slug>/version    mtime-size of the file: what the open page polls
    /<slug>/doc        the deck's JSON with every asset replaced by its hash
    /<slug>/asset?key=&h=   one asset, refused (409) if it moved on since /doc

The page does not reload when the file changes. `sync.js` polls /version, and on
a change fetches /doc, downloads only the assets it does not hold, and applies
the difference through the editor's own agent interface, so a changed slide is
redrawn in place.

    POST /<slug>/request   {"slideId", "request"}: a change request typed in the
                           ask box, recorded through `slide.py ask`

Read-only but for that one route: a change request is written through
`slide.py ask`, so it lands in the open editor here when there is one (waking
an agent's listener) and in the file otherwise, under slide.py's lock. Only
the files named in `decks.json` are ever opened. Anything else changed in the
hosted copy stays in that browser and is overwritten by the next sync. Stdlib only.
"""

import hashlib
import json
import re
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
import config  # noqa: E402
import deckio  # noqa: E402

DECKS = HERE / "decks.json"   # --decks replaces it
SYNC_JS = HERE / "sync.js"
# the browser-side old names (an older shell's API and request event)
LEGACY = json.loads((TOOLS / "legacy.json").read_text(encoding="utf-8"))

NO_CACHE = {"Cache-Control": "no-cache, no-store"}

DOC_RE = deckio.DOC_RE   # group 2 = the JSON

# What the editor's agent interface can patch. Anything else that changes
# (the app shell itself, the document's identity) makes the page reload.
LIVE_ROOTS = ("slides", "assets", "title", "theme", "layouts", "fonts")
# Never part of "did the rest change": a timestamp, the collaboration room, and
# the notes for agents (stamped again by every build, never shown on screen).
IGNORED = {"modified", "collab", "agentNotes"}
# The poll session (the room's join code) is protected from patches but changes
# on every recompile: tracked on its own, so the page patches the slides and
# offers a reload instead of reloading by itself.
POLL = "poll"

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")

# slug -> the parsed deck for one version of the file. One entry per deck; a
# deck is ~10 MB of JSON, parsed once per save rather than once per request.
_CACHE: dict[str, dict] = {}
_LOCK = threading.Lock()


class Refused(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _text(status: int, text: str, kind="text/plain; charset=utf-8") -> tuple:
    return status, kind, text.encode("utf-8"), NO_CACHE


def decks() -> dict[str, Path]:
    try:
        raw = json.loads(DECKS.read_text(encoding="utf-8")).get("decks", {})
    except (OSError, ValueError):
        return {}
    return {slug: _abs(path) for slug, path in raw.items() if SLUG_RE.match(slug)}


def _abs(path: str) -> Path:
    p = Path(path).expanduser()
    return p if p.is_absolute() else config.REPO / p


def _path(slug: str) -> Path:
    path = decks().get(slug)
    if path is None or not path.is_file():
        raise Refused(404, "deck not found")
    return path


def _version(path: Path) -> str:
    st = path.stat()
    return f"{st.st_mtime_ns}-{st.st_size}"


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _load(slug: str) -> dict:
    """The deck at its current version: html, doc, asset hashes, rest hash."""
    path = _path(slug)
    with _LOCK:
        version = _version(path)
        hit = _CACHE.get(slug)
        if hit and hit["version"] == version:
            return hit
        html = path.read_text(encoding="utf-8")
        m = DOC_RE.search(html)
        try:
            doc = json.loads(m.group(2)) if m else None
        except ValueError:
            doc = None
        if not isinstance(doc, dict):
            # caught mid-write, or not a deck: the page retries
            raise Refused(503, "deck is not readable right now")
        assets = doc.get("assets") or {}
        other = {k: v for k, v in doc.items()
                 if k not in LIVE_ROOTS and k not in IGNORED and k != POLL}
        entry = {
            "version": version,
            "html": html,
            "doc": {k: doc[k] for k in LIVE_ROOTS if k in doc and k != "assets"},
            "assets": assets,
            "hashes": {k: _sha1(v) if isinstance(v, str) else None for k, v in assets.items()},
            # the shell around the doc counts too: a rebuilt app needs a reload
            "rest": _sha1(json.dumps(other, sort_keys=True) + _sha1(html[m.end():])),
            "poll": _sha1(json.dumps(doc.get(POLL), sort_keys=True)),
        }
        _CACHE[slug] = entry
        return entry


def page(slug: str, base: str) -> tuple:
    deck = _load(slug)
    script = (SYNC_JS.read_text(encoding="utf-8")
              .replace("__BASE__", json.dumps(base))
              .replace("__VERSION__", json.dumps(deck["version"]))
              .replace("__REST__", json.dumps(deck["rest"]))
              .replace("__POLL__", json.dumps(deck["poll"]))
              .replace("__LEGACY__", json.dumps({k: LEGACY[k] for k in ("api", "requestEvent")})))
    # Appended after the document; the parser moves a trailing script into <body>.
    return _text(200, f"{deck['html']}\n<script>\n{script}</script>\n", "text/html; charset=utf-8")


def doc(slug: str) -> tuple:
    deck = _load(slug)
    # An asset that is not a string (none so far) travels inside the doc.
    inline = {k: v for k, v in deck["assets"].items() if deck["hashes"][k] is None}
    return _text(200, json.dumps({
        "version": deck["version"],
        "rest": deck["rest"],
        "poll": deck["poll"],
        "doc": deck["doc"],
        "assets": {k: h for k, h in deck["hashes"].items() if h is not None},
        "inline": inline,
    }), "application/json")


def asset(slug: str, key: str, h: str = "") -> tuple:
    deck = _load(slug)
    value = deck["assets"].get(key)
    if not isinstance(value, str):
        raise Refused(404, "no such asset")
    if h and deck["hashes"][key] != h:
        # the file moved on between /doc and this request: the page starts over
        raise Refused(409, "asset changed")
    return _text(200, value)


SLIDE_PY = TOOLS / "slide.py"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def request(slug: str, body: bytes) -> tuple:
    path = _path(slug)
    try:
        data = json.loads(body.decode("utf-8"))
        sid, req = data["slideId"], data["request"]
        text = str(req["text"]).strip()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise Refused(400, "expected {slideId, request: {id, text}}")
    rid = req.get("id") or ""
    els = req.get("elementIds") or ([req["elementId"]] if req.get("elementId") else [])
    if sid == "":
        sid = "-"  # a request about the whole deck: slide.py ask DECK - TEXT
    if (not isinstance(sid, str) or not (sid == "-" or ID_RE.match(sid)) or not text or len(text) > 4000
            or not ID_RE.match(rid) or not all(isinstance(e, str) and ID_RE.match(e) for e in els)):
        raise Refused(400, "bad request")
    cmd = [sys.executable, str(SLIDE_PY), "ask", "--id", rid,
           "--author", str(req.get("author") or config.get("TESSERA_AUTHOR") or "Phone")[:60], "--agent", "Phone"]
    if isinstance(req.get("at"), str):
        cmd += ["--at", req["at"][:40]]
    if els:
        cmd += ["--element", *els]
    # the person's later edit (rev) or stop of a request already relayed
    if isinstance(req.get("rev"), int) and 0 < req["rev"] < 10000:
        cmd += ["--rev", str(req["rev"])]
    if req.get("status") == "stopped":
        cmd += ["--state", "stopped"]
    # slide.py retries for about 90 s while the editor here is busy (someone typing)
    def ask(target, words):
        try:   # a text that starts with "-" is not an option
            return subprocess.run(cmd + ["--", str(path), target, words], capture_output=True, text=True,
                                  encoding="utf-8", timeout=120)
        except subprocess.TimeoutExpired:
            raise Refused(504, "the editor did not take the request in time")
    r = ask(sid, text)
    if r.returncode and sid != "-" and f"no slide '{sid}'" in (r.stderr or r.stdout):
        # typed on a slide added in the mirror ("What should this slide be?"),
        # which the deck does not have yet: add the same empty slide where the
        # page has it (`after` = the slide before it there, `first` = it leads
        # the deck; neither, or a slide that is gone = at the end), then record
        # the request on it. The page then matches the deck and keeps the slide.
        after = data.get("after")
        new = [sys.executable, str(SLIDE_PY), "new", "--empty", "--id", sid, "--agent", "Phone"]
        tries = [["--first"]] if data.get("first") is True else []
        if isinstance(after, str) and ID_RE.match(after):
            tries.append(["--after", after])
        made = None
        for place in tries + [[]]:
            try:
                made = subprocess.run(new + place + ["--", str(path)], capture_output=True, text=True,
                                      encoding="utf-8", timeout=120)
            except subprocess.TimeoutExpired:
                raise Refused(504, "the editor did not take the slide in time")
            if not made.returncode or "exists already" in (made.stderr or made.stdout):
                break
        r = ask(sid, text)
        if r.returncode:   # the slide could not be added: keep the request anyway, on the whole deck
            where = f" after {after}" if isinstance(after, str) and ID_RE.match(after) else ""
            r = ask("-", f"[typed on a slide added in the mirror{where}, not in the deck: {sid}] {text}"[:4000])
    if r.returncode:
        raise Refused(409, (r.stderr or r.stdout).strip()[-300:] or "not recorded")
    return _text(200, json.dumps({"recorded": rid}), "application/json")


def serve(method, path, key="", body=b"", prefix="", query="") -> tuple:
    parts = [p for p in path.split("/") if p]
    if method == "POST" and len(parts) == 2 and parts[1] == "request":
        # sync.js sends this header; a form on another site cannot (it would
        # need a CORS preflight), so the Access cookie alone writes nothing.
        if key != "deck-request":
            return _text(403, "missing X-Key")
        try:
            return request(parts[0], body)
        except Refused as e:
            return _text(e.status, e.message)
    if method not in ("GET", "HEAD"):
        return _text(405, "read-only")
    if not parts or len(parts) > 2:
        return _text(404, "deck not found")
    slug, what = parts[0], (parts[1] if len(parts) == 2 else "")
    try:
        if what == "":
            return page(slug, f"{prefix}/{slug}")
        if what == "version":
            return _text(200, _version(_path(slug)))
        if what == "doc":
            return doc(slug)
        if what == "asset":
            q = parse_qs(query)
            return asset(slug, (q.get("key") or [""])[0], (q.get("h") or [""])[0])
    except Refused as e:
        return _text(e.status, e.message)
    return _text(404, "deck not found")


# ─────────────────────────────────────────────────────────── standalone server

def main() -> None:
    import argparse
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlsplit

    local = urlsplit(config.live_local())
    ap = argparse.ArgumentParser(description="Serve the live previews named in decks.json at /deck/<slug>.")
    ap.add_argument("--host", default=local.hostname or "127.0.0.1")
    ap.add_argument("--port", type=int, default=local.port or 8000)
    ap.add_argument("--decks", help="the slug -> deck file map (default: decks.json beside this file)")
    a = ap.parse_args()
    global DECKS
    if a.decks:
        DECKS = Path(a.decks).resolve()
    mount = "/deck"

    class Handler(BaseHTTPRequestHandler):
        def _go(self, method):
            u = urlsplit(self.path)
            if u.path != mount and not u.path.startswith(mount + "/"):
                status, kind, body, headers = _text(404, "not found (decks are under /deck/<slug>)")
            else:
                n = int(self.headers.get("content-length") or 0)
                status, kind, body, headers = serve(method, u.path[len(mount):], self.headers.get("x-key") or "",
                                                    self.rfile.read(n) if n else b"", mount, u.query)
            self.send_response(status)
            self.send_header("content-type", kind)
            self.send_header("content-length", str(len(body)))
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            self._go("GET")

        def do_HEAD(self):
            self._go("HEAD")

        def do_POST(self):
            self._go("POST")

        def log_message(self, fmt, *args):
            pass

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"live previews: http://{a.host}:{a.port}{mount}/<slug>  (decks: {DECKS}; Ctrl+C stops)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
