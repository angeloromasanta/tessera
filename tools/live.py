"""Live figures: every save of a figure page reloads its frame inside the deck
file the presenter already has open (file://, edit mode). Nobody opens a URL.

    python tools/live.py start decks/X       # idempotent; call before any figure work
    python tools/live.py status              # what is being served, and where
    python tools/live.py stop                # stop the server on the port

`start` launches a detached server on 127.0.0.1:5173 (`--port`) whose root is
the deck folder, and returns at once; a second `start` for the same folder is a
no-op. An embed whose `src` is http://127.0.0.1:5173/build/... and which runs
on the edit canvas (`live: yes`) then reloads in place on every save: the
server injects a tiny watcher into each .html it serves that polls the file's
mtime and reloads the frame once a write has settled. Everything else is served
raw (the extension-less build/figures/MANROPE font as a font), caching off.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WATCHER = r"""<script>(function(){
var me=document.currentScript;me&&me.remove();
var P=location.pathname,base=%(sig)s,last=null,gone=false;
setInterval(function(){if(gone)return;fetch('/__live?p='+encodeURIComponent(P),{cache:'no-store'})
 .then(function(r){return r.ok?r.text():null}).then(function(s){if(s==null||gone)return;
  if(s===base){last=null;return}
  if(s!==last){last=s;return}   /* changed: wait one more poll so the write has settled */
  gone=true;location.reload()}).catch(function(){})},350)})();</script>"""


VERSION = 2  # 2: /__live?src= serves a page raw, for the editor's dev-figures sync


def signature(path: Path) -> str:
    st = path.stat()
    return f"{st.st_mtime_ns}-{st.st_size}"


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:  # quiet: the page polls several times a second
        pass

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        # an embed sandboxed without allow-same-origin has an opaque origin: its
        # watcher's poll (and its font) are cross-origin requests
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):  # extension-less files (the MANROPE font) are fonts here
        return "font/woff2" if not Path(str(path)).suffix else super().guess_type(path)

    def local(self, url_path: str) -> Path:
        return Path(self.translate_path(url_path))

    def do_GET(self) -> None:
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/__live":
            q = urllib.parse.parse_qs(url.query)
            if "root" in q:
                return self.reply(json.dumps({"root": self.directory, "pid": os.getpid(), "v": VERSION}),
                                  "application/json")
            if "src" in q:  # the page as it is on disk, no watcher: what the editor bakes into the deck
                f = self.local(q["src"][0])
                return (self.reply(f.read_bytes(), "text/html; charset=utf-8")
                        if f.is_file() else self.send_error(404))
            f = self.local(q.get("p", ["/"])[0])
            return self.reply(signature(f), "text/plain") if f.is_file() else self.send_error(404)
        f = self.local(url.path)
        if f.is_file() and f.suffix.lower() in (".html", ".htm"):
            body = f.read_bytes()
            tag = (WATCHER % {"sig": json.dumps(signature(f))}).encode("utf-8")
            low = body[:4096].lower()
            i = low.find(b"<head")
            i = body.index(b">", i) + 1 if i >= 0 else 0
            return self.reply(body[:i] + tag + body[i:], "text/html; charset=utf-8")
        super().do_GET()

    def reply(self, body, ctype: str) -> None:
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def running(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__live?root=1", timeout=1) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _ensure_manrope(root: Path) -> None:
    """Figure sources load `url(MANROPE)`; while served live that must be a real
    font file at build/figures/MANROPE, or every live figure falls back to the
    system font (and figcheck fails). Extract it from the deck's own fonts."""
    target = root / "build" / "figures" / "MANROPE"
    if target.exists():
        return
    import base64
    import json as _json
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import deckio
    for deck in sorted(root.glob("*.html")):
        m = deckio.DOC_RE.search(deck.read_text(encoding="utf-8"))
        if not m:
            continue
        doc = _json.loads(m.group(2))
        fonts = sorted((f for f in doc.get("fonts", []) if f.get("family") == "Manrope"),
                       key=lambda f: "latin-ext" in f["asset"])
        uri = doc.get("assets", {}).get(fonts[0]["asset"], "") if fonts else ""
        if "," in uri:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(uri.split(",", 1)[1]))
            return


def cmd_start(a) -> None:
    root = Path(a.dir).resolve()
    if root.is_file():
        root = root.parent
    _ensure_manrope(root)
    info = running(a.port)
    if info and info.get("v", 1) < VERSION and Path(info["root"]).resolve() == root:
        cmd_stop(a)  # a server from before this version cannot serve the editor's bake
        time.sleep(0.5)
        info = running(a.port)
    if info and Path(info["root"]).resolve() != root:
        raise SystemExit(f"port {a.port} already serves {info['root']}; "
                         f"`live.py stop --port {a.port}` first, or pass another --port")
    if not info:
        log = root / "build" / "live.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        kw = ({"creationflags": 0x00000008 | 0x00000200}  # DETACHED_PROCESS | NEW_PROCESS_GROUP
              if os.name == "nt" else {"start_new_session": True})
        subprocess.Popen([sys.executable, __file__, "serve", str(root), "--port", str(a.port)],
                         stdout=open(log, "w"), stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, **kw)
        for _ in range(50):
            if running(a.port):
                break
            time.sleep(0.1)
        else:
            raise SystemExit(f"server did not come up; see {log}")
    state = "already live" if info else "started"
    print(f"{state}: {root} on http://127.0.0.1:{a.port}/")
    print(f"live embeds: src http://127.0.0.1:{a.port}/build/<fig>.html with live: yes")


def cmd_serve(a) -> None:
    root = Path(a.dir).resolve()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), partial(Handler, directory=str(root)))
    print(f"serving {root} on http://127.0.0.1:{a.port}/", flush=True)
    srv.serve_forever()


def cmd_status(a) -> None:
    info = running(a.port)
    if not info:
        print(f"nothing live on port {a.port}")
        return
    print(f"live: {info['root']} on http://127.0.0.1:{a.port}/ (pid {info['pid']})")


def cmd_stop(a) -> None:
    info = running(a.port)
    if not info:
        print(f"nothing live on port {a.port}")
        return
    import signal
    os.kill(info["pid"], signal.SIGTERM)
    print(f"stopped the server for {info['root']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(required=True)
    for name, fn, needs_dir in (("start", cmd_start, True), ("serve", cmd_serve, True),
                                ("status", cmd_status, False), ("stop", cmd_stop, False)):
        p = sub.add_parser(name)
        if needs_dir:
            p.add_argument("dir", help="the deck folder (or any file in it)")
        p.add_argument("--port", type=int, default=5173)
        p.set_defaults(func=fn)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
