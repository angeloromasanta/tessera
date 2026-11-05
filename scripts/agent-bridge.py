"""Local agent bridge and CLI for Tessera decks. Standard library only.

start | stop | pair FILE | sessions | select SESSION | read SESSION --out JSON
patch SESSION JSON | result SESSION REQUEST_ID | reconcile FILE --acknowledge
wait [FILE] [--timeout SECONDS] [--listener NAME]

Change requests: an editor reports `pending` (open "Ask the agent" requests in
its document) and, from shells built 2026-10-22 on, `pendingIds` on every
/tick. A client that POSTs /wait is a listener: while one is waiting, editors
are told `listening: true`, and /wait returns once a live session has a pending
request this listener has not been told about yet.

Saving: the open editor writes its deck through POST /save (only the
#tessera-doc block on disk is replaced; a deck saved before the rename keeps
its old-named block, legacy.py). A save names the file version it was
based on (`base`, the token the bridge handed back last time, or the editor's
own hash of the block it loaded); when the file changed since, the bridge
refuses with 409 and the current block, and the editor folds the difference in
and saves again. The protocol is in docs/agent-live.md.
"""
from __future__ import annotations

import argparse
import importlib.util
import contextlib
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def _load_legacy():
    """scripts/legacy.py, by path: a plain `import legacy` could find
    tools/legacy.py first when both folders are on sys.path."""
    spec = importlib.util.spec_from_file_location("bridge_legacy", Path(__file__).with_name("legacy.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


legacy = _load_legacy()


def _env(name):
    return os.environ.get(name) or os.environ.get(legacy.ENV.get(name, ""), "")


# Tests run a bridge of their own on another port with their own state; the
# editor only ever knows 18765.
PORT = int(_env("TESSERA_AGENT_PORT") or 18765)
_DATA = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
STATE_DIR = Path(_env("TESSERA_AGENT_STATE") or (_DATA / "TesseraAgent"))
STATE_FILE = STATE_DIR / "connection.json"
# The pairings a bridge from before the rename kept: carried over once (the old
# folder is left as it is), so editors paired then stay paired.
LEGACY_STATE_FILE = None if _env("TESSERA_AGENT_STATE") else _DATA / legacy.STATE_DIR_NAME / "connection.json"
MAX_BODY = 64 * 1024 * 1024
SESSION_TTL = 3600  # seconds a silent page is remembered
COMMAND_TTL = 1800  # seconds a command outlives its wait, for /result and same-ID retries
LISTEN_GRACE = 30  # seconds a listener counts as present after its last /wait
# 2: raw-body /save with a base version (409 on a changed file), pendingIds,
# one tab per docId. `start` replaces a running bridge older than this.
VERSION = 2


def base_url():
    return f"http://127.0.0.1:{PORT}"


BASE = base_url()  # kept for importers; call() reads PORT at call time


def config():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not STATE_FILE.exists() and LEGACY_STATE_FILE and LEGACY_STATE_FILE.is_file():
        try:
            with STATE_FILE.open("x", encoding="utf-8") as f:
                f.write(LEGACY_STATE_FILE.read_text(encoding="utf-8"))
            if os.name != "nt":
                STATE_FILE.chmod(0o600)
        except FileExistsError:
            pass
    if not STATE_FILE.exists():
        try:
            with STATE_FILE.open("x", encoding="utf-8") as f:
                json.dump({"cliToken": secrets.token_hex(32), "files": {}}, f)
            if os.name != "nt":
                STATE_FILE.chmod(0o600)
        except FileExistsError:
            pass
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def marker(file):
    path = Path(file)
    return path.parent / "build" / f"{path.name}.live-source.json"


def stale(file):
    target = marker(file)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"deck": str(Path(file).resolve()), "requiresReconciliation": True,
                                  "reason": "Live editor is authoritative; reconcile source before compiling."}), encoding="utf-8")


DOC_OPEN = '<script type="application/tessera+json" id="tessera-doc">'
DOC_OPENS = (DOC_OPEN, legacy.DOC_OPEN)
DOC_CLOSE = "</script>"


def find_block(text):
    """(start, end) of the document block's content (either name), or None.
    A plain find: a lazy regex crawls a 14 MB file."""
    for opener in DOC_OPENS:
        start = text.find(opener)
        if start >= 0:
            break
    else:
        return None
    start += len(opener)
    end = text.find(DOC_CLOSE, start)
    return (start, end) if end >= 0 else None


def version_token(body):
    """The file version an editor saves against: SHA-256 of the block content
    with line endings normalised (as the HTML parser does) and trimmed (as
    readEmbeddedDoc does), so the editor can compute it from the block it
    loaded."""
    norm = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


class Conflict(Exception):
    """The file changed since the version the editor based its save on."""

    def __init__(self, token, body):
        super().__init__("the deck file changed on disk since this editor loaded or saved it")
        self.token = token
        self.body = body


@contextlib.contextmanager
def deck_lock(path):
    """The same lock file slide.py takes, so an editor save and a file edit
    queue instead of clobbering each other."""
    build = Path(path).parent / "build"
    build.mkdir(parents=True, exist_ok=True)
    lock = build / f".{Path(path).name}.lock"
    for _ in range(300):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 120:
                    lock.unlink(missing_ok=True)  # a crashed writer's lock
            except OSError:
                pass
            time.sleep(0.1)
    else:
        raise ValueError("the deck file is locked by another writer; retrying")
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def _disk_doc_id(body):
    try:
        return json.loads(body).get("docId")
    except ValueError:
        return None  # encrypted or unreadable: trust the editor's capability


def save_deck(path, html, doc_id, base=None):
    """Write the editor's document into the deck file on disk. Only the
    document block is replaced: the shell on disk stays (it may be newer than
    the open tab's, after upgrade-deck). Refuses a document of another deck.

    `base` is the version token the editor's document was built on. When given
    and the file holds anything else, raises Conflict (with the file's block)
    instead of writing — the editor folds the difference in and saves again.
    Without it (shells shipped before 2026-10-22) the save is accepted as
    before. Returns {"written", "token"}; identical content is not rewritten."""
    span = find_block(html or "")
    if not span:
        raise ValueError("no document block in the save")
    new = html[span[0]:span[1]]
    new_token = version_token(new)
    with deck_lock(path):
        with open(path, encoding="utf-8", newline="") as f:
            text = f.read()
        old = find_block(text)
        if not old:
            raise ValueError("the file on disk is not a deck")
        disk = text[old[0]:old[1]]
        disk_token = version_token(disk)
        if disk_token == new_token:
            return {"written": False, "token": disk_token}
        if base and base != disk_token:
            disk_id = _disk_doc_id(disk)
            if disk_id and doc_id and disk_id != doc_id:
                raise ValueError("the file on disk is another deck (different docId); not overwritten")
            raise Conflict(disk_token, disk.strip())
        if not base:
            disk_id = _disk_doc_id(disk)
            if disk_id and doc_id and disk_id != doc_id:
                raise ValueError("the file on disk is another deck (different docId); not overwritten")
        out = text[:old[0]] + new + text[old[1]:]
        tmp = Path(path).with_suffix(".autosave.tmp")
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(out)
        os.replace(tmp, path)
        return {"written": True, "token": new_token}


def call(route, data=None, timeout=25):
    req = urllib.request.Request(base_url() + route, data=json.dumps(data or {}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + config()["cliToken"]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from None


def start():
    config()
    try:
        running = call("/sessions", timeout=1)
        if running.get("version", 0) >= VERSION:
            return
        # An older bridge is still serving (the bridge runs for days): replace
        # it, or editors on new shells keep saving through the old protocol and
        # listeners keep the old /wait. Open tabs reconnect within a second.
        try:
            call("/stop", timeout=2)
        except (OSError, RuntimeError):
            pass
        for _ in range(40):
            try:
                call("/sessions", timeout=.5)
                time.sleep(.1)
            except (OSError, RuntimeError):
                break
    except (OSError, RuntimeError):
        pass
    kwargs = {"creationflags": 0x00000008 | 0x00000200} if os.name == "nt" else {"start_new_session": True}
    with (STATE_DIR / "bridge.log").open("a", encoding="utf-8") as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "serve"], stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log, **kwargs)
    for _ in range(40):
        try:
            call("/sessions", timeout=1)
            return
        except (OSError, RuntimeError):
            time.sleep(.1)
    raise RuntimeError(f"Bridge did not start; check {STATE_DIR / 'bridge.log'} (port {PORT} may be occupied)")


class Bridge:
    def __init__(self):
        self.config = config()
        self.sessions = {}
        self.selected = {}
        self.primary = {}  # (file, docId) -> the tab commands go to
        self.commands = {}
        self.listeners = {}  # file URL (or "*") -> time the listener lapses
        self.reported = {}  # listener key -> {request id: time first reported}
        self.lock = threading.Condition(threading.RLock())

    def listening(self, file):
        now = time.time()
        return any(t > now and (f == "*" or f == file) for f, t in self.listeners.items())

    def prune(self):
        # The bridge runs for days: forget closed tabs and settled commands, or
        # every page reload and every read snapshot stays in memory forever.
        now = time.time()
        for sid in [k for k, s in self.sessions.items() if now - s["seen"] > SESSION_TTL]:
            del self.sessions[sid]
        for file in [f for f, sid in self.selected.items() if sid not in self.sessions]:
            del self.selected[file]
        for key in [k for k, sid in self.primary.items() if sid not in self.sessions]:
            del self.primary[key]
        for key in [k for k, c in self.commands.items() if now - c["expires"] > COMMAND_TTL]:
            del self.commands[key]
        for key, ids in list(self.reported.items()):
            for rid in [r for r, t in ids.items() if now - t > SESSION_TTL]:
                del ids[rid]
            if not ids:
                del self.reported[key]

    def live(self):
        return [s for s in self.sessions.values() if time.time() - s["seen"] < 6]

    def session(self, sid):
        """The tab that receives a command addressed to `sid`. Tabs of one file
        that share a docId are one deck (they sync over BroadcastChannel), so a
        command goes to ONE of them — the selected one, else a sticky primary —
        instead of being refused as ambiguous. Copies with different docIds
        still need an explicit `select`."""
        s = self.sessions.get(sid)
        if not s or time.time() - s["seen"] >= 6:
            raise ValueError("disconnected: open and connect the deck first")
        copies = [x for x in self.live() if x["file"] == s["file"]]
        if len(copies) == 1:
            return s
        chosen = self.selected.get(s["file"])
        if chosen:
            if chosen != sid:
                raise ValueError("ambiguous copies: explicitly select the receiving session")
            return s
        same = [x for x in copies if x["docId"] == s["docId"]]
        if len(same) != len(copies):
            raise ValueError("ambiguous copies: tabs of this file hold different documents; explicitly select the receiving session")
        key = (s["file"], s["docId"])
        current = self.sessions.get(self.primary.get(key))
        if not current or current not in same:
            current = max(same, key=lambda x: x["seen"])
            self.primary[key] = current["sessionId"]
        return current

    def register(self, path):
        path = Path(path).resolve(strict=True)
        if path.suffix.lower() != ".html" or not any(f'id="{i}"' in path.read_text(encoding="utf-8") for i in ("tessera-doc", legacy.DOC_ID)):
            raise ValueError("expected a deck HTML file")
        url = path.as_uri()
        entry = self.config["files"].get(url)
        if not entry:
            entry = self.config["files"][url] = {"token": secrets.token_hex(32), "path": str(path)}
            temp = STATE_FILE.with_suffix(".tmp")
            temp.write_text(json.dumps(self.config), encoding="utf-8")
            if os.name != "nt":
                temp.chmod(0o600)
            os.replace(temp, STATE_FILE)
        return url, entry

    def save(self, body, token, origin):
        """POST /save. The capability check takes the bridge lock; the file work
        (reading, hashing and writing megabytes) does not, so a big save never
        stalls other tabs' ticks or an agent's commands. Saves to one file still
        queue on the per-file lock that slide.py shares."""
        if origin != "null":
            raise PermissionError("editor must be a local file")
        with self.lock:
            entry = self.config["files"].get(body.get("file"))
            if not entry or not hmac.compare_digest(token, entry["token"]):
                raise PermissionError("invalid editor capability")
            path = entry["path"]
        result = save_deck(path, body.get("html"), body.get("docId"), body.get("base") or None)
        # A deck compiled from a Markdown spec now holds edits the spec lacks:
        # the compiler must not run over them until reconciled.
        if result["written"] and Path(path).with_suffix(".md").exists():
            stale(path)
        return {"saved": True, **result}

    def unreported(self, key, sessions):
        seen = self.reported.get(key, {})
        return [(s, [r for r in s["pendingIds"] if r not in seen]) for s in sessions]

    def handle(self, route, body, token, origin):
        if route == "/save":
            return self.save(body, token, origin)
        with self.lock:
            self.prune()
            if route == "/claim":
                # Auto-connect: an open file:// deck asks for its own token. The
                # token only lets a page act as that deck's editor, and only the
                # editor ever writes the file, so no paste step is needed.
                if origin != "null":
                    raise PermissionError("editor must be a local file")
                url = body.get("file")
                if not isinstance(url, str) or not url.startswith("file:///"):
                    raise ValueError("file URL required")
                path = urllib.request.url2pathname(urllib.parse.urlparse(url).path)
                registered, entry = self.register(path)
                if registered != url:
                    raise ValueError("file URL does not match its path")
                return {"file": url, "token": entry["token"]}
            if route == "/tick":
                if origin != "null":
                    raise PermissionError("editor must be a local file")
                entry = self.config["files"].get(body.get("file"))
                if not entry or not hmac.compare_digest(token, entry["token"]):
                    raise PermissionError("invalid editor capability")
                sid = body.get("sessionId")
                if not isinstance(sid, str) or not sid or not isinstance(body.get("docId"), str):
                    raise ValueError("session and document identity required")
                previous = self.sessions.get(sid)
                if previous and (previous["file"] != body["file"] or previous["docId"] != body["docId"]):
                    raise ValueError("session identity changed; reconnect the page")
                s = {k: body.get(k) for k in ("sessionId", "file", "docId", "title", "dirty", "canSave", "busy")}
                s["pending"] = body.get("pending") if isinstance(body.get("pending"), int) else 0
                ids = body.get("pendingIds")
                if isinstance(ids, list) and all(isinstance(x, str) for x in ids):
                    s["pendingIds"] = ids[:500]
                else:
                    # A shell from before pendingIds: one synthetic id per rise
                    # in the count, so a listener fires once per new request.
                    gen = (previous or {}).get("gen", 0)
                    if s["pending"] > (previous or {}).get("pending", 0):
                        gen += 1
                    s["gen"] = gen
                    s["pendingIds"] = [f"{sid}#{gen}"] if s["pending"] else []
                s["seen"] = time.time()
                if s["pendingIds"] and (not previous or previous.get("pendingIds") != s["pendingIds"]):
                    self.lock.notify_all()  # wake /wait
                self.sessions[sid] = s
                flags = {"listening": self.listening(s["file"]), "saveVersion": VERSION}
                reply = body.get("reply")
                if isinstance(reply, dict):
                    command = self.commands.get((sid, reply.get("commandId")))
                    if command and command.get("delivered") and "result" not in command:
                        command["result"] = reply.get("result")
                        self.lock.notify_all()
                for (target, _), command in self.commands.items():
                    if target == sid and "result" not in command and command["expires"] > time.time():
                        command["delivered"] = True
                        return {"command": command["wire"], **flags}
                return flags
            if origin is not None or not hmac.compare_digest(token, self.config["cliToken"]):
                raise PermissionError("CLI capability required")
            if route == "/sessions":
                return {"sessions": [{k: v for k, v in s.items() if k != "gen"} for s in self.live()], "version": VERSION}
            if route == "/stop":
                return {"stopping": True}
            if route == "/register":
                url, entry = self.register(body["file"])
                return {"file": url, "token": entry["token"],
                        "instruction": "Nothing to paste: an open deck connects by itself while the bridge runs. The token is only a fallback."}
            if route == "/select":
                s = self.sessions.get(body["sessionId"])
                if not s or s not in self.live():
                    raise ValueError("session disconnected")
                self.selected[s["file"]] = s["sessionId"]
                return {"selected": s["sessionId"]}
            if route == "/result":
                command = self.commands.get((body["sessionId"], body["id"]))
                if not command:
                    for (target, cid), c in self.commands.items():
                        if cid == body["id"] and c.get("asked") == body["sessionId"]:
                            command = c
                            break
                return {"result": command.get("result"), "delivered": command.get("delivered", False)} if command else {"status": "unknown"}
            if route == "/wait":
                # A listener: block until a live session (of FILE, if given) has
                # an open request THIS listener has not been told about, or until
                # the timeout. Each request is reported once per listener (key:
                # `listener`, else the file), so a listener re-armed while the
                # agent is still on the last request does not fire again at once.
                # Clients call it in a loop; each call keeps editors showing
                # "Agent ready" (the agent pill).
                want = body.get("file") or "*"
                key = str(body.get("listener") or want)
                limit = time.time() + max(1, min(float(body.get("timeout", 20)), 25))
                while True:
                    self.listeners[want] = max(self.listeners.get(want, 0), time.time() + LISTEN_GRACE)
                    mine = [x for x in self.live() if x.get("pendingIds") and (want == "*" or x["file"] == want)]
                    fresh = [(s, new) for s, new in self.unreported(key, mine) if new]
                    if fresh:
                        seen = self.reported.setdefault(key, {})
                        now = time.time()
                        for _, new in fresh:
                            for rid in new:
                                seen[rid] = now
                        return {"sessions": [{k: v for k, v in s.items() if k != "gen"} for s, _ in fresh],
                                "new": list(dict.fromkeys(rid for _, new in fresh for rid in new if "#" not in rid))}
                    if time.time() >= limit:
                        return {"sessions": [], "timeout": True}
                    self.lock.wait(timeout=.5)
            if route == "/reconcile":
                path = Path(body["file"]).resolve(strict=True)
                if any(s["file"] == path.as_uri() for s in self.live()):
                    raise ValueError("disconnect the live editor before acknowledging reconciliation")
                marker(path).unlink(missing_ok=True)
                return {"sourceReconciled": str(path)}
            if route != "/request":
                raise ValueError("unknown route")
            asked, kind = body["sessionId"], body["kind"]
            s = self.session(asked)
            sid = s["sessionId"]
            if kind not in ("read", "patch"):
                raise ValueError("unknown command")
            request = body.get("request")
            command_id = request["id"] if kind == "patch" else secrets.token_hex(16)
            if kind == "patch":
                if request.get("docId") != s["docId"]:
                    raise ValueError("wrong document identity")
                stale(self.config["files"][s["file"]]["path"])
            wire = {"id": command_id, "kind": kind, "request": request}
            command = self.commands.get((sid, command_id))
            if not command and kind == "patch":
                # A retry routed to another tab of the deck than the first try:
                # the first command still stands (same ID = same edit).
                for (target, cid), c in self.commands.items():
                    if cid == command_id and c["wire"] == wire and target in self.sessions:
                        command, sid = c, target
                        break
            if command:
                if command["wire"] != wire:
                    raise ValueError("request ID reused with different content")
                # Busy is transient: retry the SAME request after the gesture.
                if isinstance(command.get("result"), dict) and command["result"].get("status") == "busy":
                    command.pop("result")
            else:
                command = {"wire": wire, "asked": asked}
                self.commands[(sid, command_id)] = command
            command["expires"] = time.time() + 15
            while "result" not in command and command["expires"] > time.time():
                self.lock.wait(timeout=.5)
            if "result" in command:
                if kind == "read":
                    # A snapshot is the whole deck; its random ID is never retried.
                    self.commands.pop((sid, command_id), None)
                return command["result"]
            return {"status": "disconnected", "id": command_id, "delivered": command.get("delivered", False),
                    "message": "Outcome may be pending. Retry the same request ID in the same session; do not generate another insertion."}


EDITOR_ROUTES = ("/tick", "/claim", "/save")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def route(self):
        return urllib.parse.urlsplit(self.path).path

    def reply(self, status, data):
        encoded = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        if self.headers.get("Origin") == "null" and self.route() in EDITOR_ROUTES:
            self.send_header("Access-Control-Allow-Origin", "null")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.reply(200 if self.route() in EDITOR_ROUTES and self.headers.get("Origin") == "null" else 403, {})

    def do_POST(self):
        try:
            if self.headers.get("Host") != f"127.0.0.1:{PORT}":
                raise PermissionError("invalid host")
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= MAX_BODY:
                raise ValueError("request body limit exceeded")
            raw = self.rfile.read(size)
            route = self.route()
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if route == "/save" and not (self.headers.get("Content-Type") or "").startswith("application/json"):
                # The current shell posts the file itself (text/html, no JSON
                # wrapping of 15 MB on either side); identity rides in the query.
                q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
                body = {"file": q.get("file"), "docId": q.get("docId"), "base": q.get("base"), "html": raw.decode("utf-8")}
            else:
                body = json.loads(raw)
            result = self.server.bridge.handle(route, body, token, self.headers.get("Origin"))
            self.reply(200, result)
            if route == "/stop":
                threading.Thread(target=self.server.shutdown, daemon=True).start()
        except Conflict as conflict:
            self.reply(409, {"conflict": True, "error": str(conflict), "token": conflict.token, "doc": conflict.body})
        except PermissionError as error:
            self.reply(403, {"error": str(error)})
        except (ValueError, KeyError, TypeError, OSError) as error:
            self.reply(400, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("serve", "start", "stop", "sessions"):
        sub.add_parser(name)
    sub.add_parser("pair").add_argument("file")
    sub.add_parser("select").add_argument("session")
    p = sub.add_parser("read")
    p.add_argument("session")
    p.add_argument("--out", required=True, help="write the snapshot under the deck's build/ directory")
    p = sub.add_parser("patch")
    p.add_argument("session")
    p.add_argument("json")
    p = sub.add_parser("result")
    p.add_argument("session")
    p.add_argument("id")
    p = sub.add_parser("wait", help="block until an open deck has a change request this listener has not seen")
    p.add_argument("file", nargs="?")
    p.add_argument("--timeout", type=float, default=20)
    p.add_argument("--listener", help="report requests per this name instead of per file")
    p = sub.add_parser("reconcile")
    p.add_argument("file")
    p.add_argument("--acknowledge", action="store_true", required=True, help="confirm the Markdown has been reconciled with the saved live deck")
    args = parser.parse_args()
    if args.cmd == "serve":
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        server.bridge = Bridge()
        server.serve_forever()
        server.server_close()
        return
    if args.cmd == "stop":
        try:
            print(json.dumps(call("/stop", timeout=2)))
        except OSError:
            print(json.dumps({"stopping": False, "message": "bridge is not running"}))
        return
    start()
    if args.cmd == "start":
        result = {"listening": base_url()}
    elif args.cmd == "pair":
        result = call("/register", {"file": str(Path(args.file).resolve())})
    elif args.cmd == "sessions":
        result = call("/sessions")
    elif args.cmd == "select":
        result = call("/select", {"sessionId": args.session})
    elif args.cmd == "read":
        result = call("/request", {"sessionId": args.session, "kind": "read"})
        if "doc" in result:
            target = Path(args.out)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            result = {"snapshot": str(target.resolve())}
    elif args.cmd == "patch":
        request = json.loads(Path(args.json).read_text(encoding="utf-8-sig"))
        result = call("/request", {"sessionId": args.session, "kind": "patch", "request": request})
    elif args.cmd == "wait":
        file = Path(args.file).resolve().as_uri() if args.file else None
        result = call("/wait", {"file": file, "timeout": args.timeout, "listener": args.listener}, timeout=args.timeout + 10)
    elif args.cmd == "result":
        result = call("/result", {"sessionId": args.session, "id": args.id})
    else:
        result = call("/reconcile", {"file": str(Path(args.file).resolve())})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if isinstance(result, dict) and result.get("status") in ("conflict", "invalid", "busy", "readonly", "disconnected"):
        raise SystemExit(2)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
