#!/usr/bin/env python3
"""Screenshot every slide of a deck, headless, via the DevTools protocol.

Pass 4 of the pipeline — the visual check. It boots the deck in headless
Chrome, enters slideshow mode, walks the deck with the arrow key and saves one
1280x720 PNG per slide, plus a contact sheet an agent can read in one look.

    python tools/shoot.py deck.html --out build/shots
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import websocket  # websocket-client

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import deckio  # noqa: E402
import legacy  # noqa: E402

# The app's own object on the page (doc, validate): its name, then the old one.
APP = "(window.tessera || window[%s])" % json.dumps(getattr(legacy, "APP_GLOBAL", "tessera"))

CHROME_CANDIDATES = [
    # macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    # Windows — both Program Files roots, plus the per-user install path
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(
        r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Chromium\Application\chrome.exe",
    # Linux / PATH, all platforms
    shutil.which("google-chrome") or "",
    shutil.which("google-chrome-stable") or "",
    shutil.which("chromium") or "",
    shutil.which("chromium-browser") or "",
    shutil.which("msedge") or "",
]


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    raise SystemExit(
        "Chrome not found in any known location — set the CHROME env var "
        "to a browser executable path")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Chrome's own sandbox cannot start inside another sandbox (a Codex agent's
# workspace-write, a container): the debug port never opens. Every figure
# agent used to lose ~3 min per call to that and then hack a --no-sandbox
# shim. launch_chrome() now waits briefly, retries once with --no-sandbox,
# and remembers the answer for the rest of the process. TESSERA_CHROME_NO_SANDBOX=1
# skips the first attempt.
_NO_SANDBOX = config.flag("TESSERA_CHROME_NO_SANDBOX")


def _attach(dport: int, want, wait: float) -> str | None:
    end = time.time() + wait
    while time.time() < end:
        try:
            targets = json.loads(urlopen(f"http://127.0.0.1:{dport}/json",
                                         timeout=1).read())
            pages = [t for t in targets if want(t)]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.25)
    return None


def launch_chrome(flags: list[str], url: str, profile: str, want):
    """Start headless Chrome on `url`; return (proc, ws_url) or exit."""
    global _NO_SANDBOX
    for no_sandbox in ([True] if _NO_SANDBOX else [False, True]):
        dport = free_port()
        proc = subprocess.Popen(
            [os.environ.get("CHROME") or find_chrome(), "--headless=new",
             *(["--no-sandbox"] if no_sandbox else []), *flags,
             f"--user-data-dir={profile}", f"--remote-debugging-port={dport}",
             url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws_url = _attach(dport, want, 20 if no_sandbox else 12)
        if ws_url:
            _NO_SANDBOX = no_sandbox
            return proc, ws_url
        proc.kill()
    raise SystemExit("could not attach to Chrome (also tried --no-sandbox)")


def serve(root: Path) -> tuple[ThreadingHTTPServer, int]:
    port = free_port()

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(root), **kw)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


class CDP:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=60,
                                              suppress_origin=True)
        self.n = 0
        # uncaught page exceptions and console.error calls, collected from the
        # event stream as call() reads past them (figcheck reports them)
        self.errors: list[str] = []

    def call(self, method: str, **params):
        self.n += 1
        want = self.n
        self.ws.send(json.dumps({"id": want, "method": method,
                                 "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            # A native prompt()/alert() blocks the renderer, so every later CDP
            # call — including captureScreenshot — hangs until it is dismissed.
            # A deck with poll slides raises one on entering the show (the
            # lecturer key), which is exactly when we start shooting.
            if msg.get("method") == "Page.javascriptDialogOpening":
                self.n += 1
                self.ws.send(json.dumps({
                    "id": self.n,
                    "method": "Page.handleJavaScriptDialog",
                    "params": {"accept": False}}))
                continue
            if msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                ex = d.get("exception", {}).get("description") or d.get("text", "")
                self.errors.append(f"{ex.splitlines()[0] if ex else 'exception'}"
                                   f" (line {d.get('lineNumber', 0) + 1})")
                continue
            if (msg.get("method") == "Runtime.consoleAPICalled"
                    and msg["params"].get("type") == "error"):
                args = msg["params"].get("args", [])
                self.errors.append("console.error: " + " ".join(
                    str(a.get("value", a.get("description", ""))) for a in args)[:200])
                continue
            if msg.get("id") == want:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr: str):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True)
        return r.get("result", {}).get("value")

    def key(self, key: str, code: str, vk: int):
        for t in ("rawKeyDown", "keyUp"):
            self.call("Input.dispatchKeyEvent", type=t, key=key, code=code,
                      windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk)

    def shot(self, path: Path):
        r = self.call("Page.captureScreenshot", format="png",
                      captureBeyondViewport=False)
        path.write_bytes(base64.b64decode(r["data"]))


ENTER_SHOW = """
(() => {
  const hit = [...document.querySelectorAll('button,[role=button],a,div')]
    .filter(e => /slideshow|present/i.test(e.textContent || '')
                 && e.offsetParent !== null);
  const el = hit.sort((a, b) => (a.textContent.length - b.textContent.length))[0];
  if (el) { el.click(); return 'clicked:' + el.textContent.trim().slice(0, 20); }
  return 'not-found';
})()
"""


def contact_sheet(shots: list[Path], out: Path, cols: int = 3,
                  cell: tuple[int, int] = (420, 236)) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    if not shots:
        return
    cw, ch = cell
    rows = (len(shots) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * (ch + 18)), "white")
    d = ImageDraw.Draw(sheet)
    for i, p in enumerate(shots):
        im = Image.open(p).convert("RGB")
        im.thumbnail((cw - 8, ch - 8))
        r, c = divmod(i, cols)
        sheet.paste(im, (c * cw + 4, r * (ch + 18) + 4))
        d.text((c * cw + 6, r * (ch + 18) + ch), p.stem, fill="black")
    sheet.save(out)


def contact_sheets(shots: list[Path], out_dir: Path, per_sheet: int = 12,
                   cols: int = 3) -> list[Path]:
    """Chunk the contact sheet so each one survives being looked at.

    A reader downsamples a tall image to a fixed budget, so one sheet holding
    77 slides arrives at ~90 px per slide — unreadable, and the whole point of
    the sheet is to be read. Twelve per sheet keeps a slide legible.
    """
    if not shots:
        return []
    chunks = [shots[i:i + per_sheet] for i in range(0, len(shots), per_sheet)]
    if len(chunks) == 1:
        contact_sheet(chunks[0], out_dir / "contact.png", cols)
        return [out_dir / "contact.png"]
    out = []
    for i, chunk in enumerate(chunks, 1):
        p = out_dir / f"contact-{i:02d}.png"
        contact_sheet(chunk, p, cols)
        out.append(p)
    return out


def parse_only(spec: str) -> list[int]:
    """`3,7,12-15` -> [3, 7, 12, 13, 14, 15]."""
    want: set[int] = set()
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part[1:]:
            a, b = part.split("-", 1)
            want.update(range(int(a), int(b) + 1))
        else:
            want.add(int(part))
    return sorted(want)


def run(deck: Path, out_dir: Path, count: int | None, settle: float,
        only: list[int] | None = None, per_sheet: int = 12) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    srv, port = serve(deck.parent.resolve())
    url = f"http://127.0.0.1:{port}/{deck.name}"
    profile = tempfile.mkdtemp(prefix="tessera-shoot-")
    proc, ws_url = launch_chrome(
        ["--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
         "--window-size=1280,720"], url, profile,
        lambda t: t["type"] == "page" and t["url"].startswith("http"))

    cdp = CDP(ws_url)
    cdp.call("Page.enable")
    cdp.call("Runtime.enable")

    for _ in range(60):
        if cdp.eval(f"!!{APP} && !!{APP}.doc"):
            break
        time.sleep(0.25)
    total = cdp.eval(f"{APP}.doc.slides.filter(s => !s.stateOf "
                     "&& !s.hidden).length") or 0
    n = count or total
    wanted = [i for i in (only or range(1, n + 1)) if 1 <= i <= (total or n)]
    if only:
        n = max(wanted) if wanted else 0    # walk far enough to reach the last
        print(f"deck has {total} slides; capturing "
              + ", ".join(str(i) for i in wanted))
    else:
        print(f"deck has {total} slides; capturing {n}")

    val = cdp.eval(f"{APP}.validate ? "
                   f"JSON.stringify({APP}.validate()).slice(0,4000) : ''")
    if val:
        (out_dir / "validate.json").write_text(val)
        print("validate() ->", val[:600])

    # Entering the show on a deck with polls asks for the lecturer key via a
    # native prompt(); stub the three dialogs so it never blocks the renderer.
    cdp.eval("window.prompt = () => null; window.alert = () => {}; "
             "window.confirm = () => false;")
    print(cdp.eval(ENTER_SHOW))
    time.sleep(settle + 0.8)

    want = set(wanted)
    shots = []
    for i in range(1, n + 1):
        if i in want:
            time.sleep(settle)
            p = out_dir / f"slide-{i:02d}.png"
            cdp.shot(p)
            shots.append(p)
        else:
            time.sleep(0.12)        # stepping past, nothing to capture
        cdp.key("ArrowRight", "ArrowRight", 39)

    sheets = contact_sheets(shots, out_dir, per_sheet)
    print(f"wrote {len(shots)} shots to {out_dir} (+ "
          + ", ".join(p.name for p in sheets) + ")")

    proc.kill()
    srv.shutdown()
    shutil.rmtree(profile, ignore_errors=True)


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}

# A step-engine figure declares `const steps = [...]` at the top level of a
# classic script: a global binding Runtime.evaluate can see, though it is not a
# property of window. TESSERA_STEPS (or its old name) is the fallback for a
# page that keeps its steps elsewhere. null = no step engine (a live-control figure).
STATES_JS = """(() => {
  try { if (Array.isArray(steps)) return steps.length; } catch (e) {}
  for (const k of ['TESSERA_STEPS', %s]) if (Number.isInteger(window[k])) return window[k];
  return null;
})()""" % json.dumps(legacy.STEPS_GLOBAL)


def open_page(page: Path, w: int, h: int, scale: float = 2,
              settle: float = 1.3):
    """Boot headless Chrome on a standalone page at exactly w x h CSS px.

    Returns (cdp, close). Shared by shoot_page and figcheck.py, so there is
    one Chrome driver, not two.
    """
    srv, port = serve(page.parent.resolve())
    profile = tempfile.mkdtemp(prefix="tessera-page-")
    try:
        proc, ws_url = launch_chrome(
            ["--disable-gpu", "--hide-scrollbars", "--no-first-run"],
            "about:blank", profile, lambda t: t["type"] == "page")
    except SystemExit:
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
        raise

    def close() -> None:
        proc.kill()
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    cdp = CDP(ws_url)
    cdp.call("Page.enable")
    cdp.call("Runtime.enable")  # before navigating, so load-time errors are caught
    # exact metrics beat --window-size, which loses pixels to browser chrome
    cdp.call("Emulation.setDeviceMetricsOverride", width=w, height=h,
             deviceScaleFactor=scale, mobile=False)
    cdp.call("Page.navigate", url=f"http://127.0.0.1:{port}/{page.name}")
    time.sleep(settle + 1.5)
    return cdp, close


def page_states(cdp: CDP) -> int | None:
    """How many states the figure's step engine has (None = no engine)."""
    try:
        n = cdp.eval(STATES_JS)
    except RuntimeError:
        return None
    return n if isinstance(n, int) and n > 0 else None


def click_frame(cdp: CDP, w: int, h: int) -> None:
    for kind in ("mousePressed", "mouseReleased"):
        cdp.call("Input.dispatchMouseEvent", type=kind, x=w // 2,
                 y=h // 3, button="left", clickCount=1,
                 buttons=1 if kind == "mousePressed" else 0)


def resolve_clicks(clicks: list[int] | str, n: int | None) -> list[int]:
    """`0,3,7` / `last` / `all` (or a list of ints) -> sorted click counts.

    N states means clicks 0..N-1; click N wraps back to state 0, so anything
    past the end is clamped to the final state, with a warning.
    """
    if isinstance(clicks, str):
        key = clicks.strip().lower()
        if key in ("last", "all"):
            if n is None:
                print(f"note: no steps array on the page; --clicks {key} "
                      "shoots state 0")
                return [0]
            return [n - 1] if key == "last" else list(range(n))
        marks = parse_only(key)
    else:
        marks = list(clicks)
    marks = sorted(set(marks)) or [0]
    if n is not None:
        over = [m for m in marks if m >= n]
        if over:
            print(f"WARNING: clicks {','.join(map(str, over))} go past the "
                  f"last state ({n - 1}) and would wrap back to state 0; "
                  f"clamped to {n - 1}. Use --clicks last")
            marks = sorted({min(m, n - 1) for m in marks})
    return marks


def shoot_page(page: Path, out: Path, w: int, h: int,
               clicks: list[int] | str, settle: float, scale: int = 1) -> None:
    """Screenshot a standalone HTML page — the poster for an `embed` slide.

    Every surface that rasterizes a slide (editor canvas, thumbnails) has to
    fall back to this image, because a live iframe cannot be captured.
    `--clicks last` steps a self-paced figure to its END state first, which is
    what someone looking at the still should be left with.

    `--clicks 0,3,7` (or `all`) captures several states of one build in ONE
    browser run: full-size `step-NN.png` files plus a `contact.png` of the
    sequence. `--out` is a single file only when it ends in an image suffix
    and one state is wanted; otherwise it is a folder of step-NN.png.
    """
    cdp, close = open_page(page, w, h, max(2, scale), settle)
    try:
        n = page_states(cdp)
        if n is not None:
            print(f"{n} states -> clicks 0..{n - 1}")
        marks = resolve_clicks(clicks, n)
        multi = len(marks) > 1 or out.suffix.lower() not in IMAGE_SUFFIXES
        (out if multi else out.parent).mkdir(parents=True, exist_ok=True)

        def grab(dest: Path) -> None:
            r = cdp.call("Page.captureScreenshot", format="png",
                         clip={"x": 0, "y": 0, "width": w, "height": h,
                               "scale": max(2, scale)})
            raw = base64.b64decode(r["data"])
            try:
                from io import BytesIO
                from PIL import Image
                Image.open(BytesIO(raw)).convert("RGB").resize(
                    (w * scale, h * scale), Image.LANCZOS).save(
                        dest, **({"quality": 88} if dest.suffix != ".png"
                                 else {}))
            except ImportError:
                dest.write_bytes(raw)

        done, shots = 0, []
        for m in marks:
            while done < m:                 # walk the build, capturing en route
                click_frame(cdp, w, h)
                done += 1
                time.sleep(0.4)
            time.sleep(settle)
            dest = out / f"step-{m:02d}.png" if multi else out
            grab(dest)
            shots.append(dest)
            print(f"wrote {dest} ({w * scale}x{h * scale}, after {m} clicks)")
        if len(shots) > 1:
            cell = (900, round(900 * h / w) + 4)
            contact_sheet(shots, out / "contact.png", cols=1, cell=cell)
            print(f"wrote {out / 'contact.png'}: the SEQUENCE only; judge "
                  f"layout on the full-size {shots[-1].name}")
    finally:
        close()


def default_out(target: Path, page: bool, marks: int = 1) -> Path:
    """Where screenshots go when --out was not given.

    Beside the deck, in ITS build/ folder — not under the cwd. A relative
    "build/shots" default writes wherever the command was run from, which is
    how a repo root collects screenshot folders belonging to decks three
    directories away. `build/` next to the deck is gitignored and is where
    every other generated artefact for that deck already lives.
    """
    base = target.resolve().parent
    # A figure page usually sits in a subfolder of the deck's own folder
    # (build/, figures/, media/). Climb out of those so the shots land in ONE
    # build/ per deck rather than one per subfolder.
    while base.name in ("build", "figures", "figs", "media") and base.parent != base:
        base = base.parent
    if not page:
        return base / "build" / "shots"
    # --page with several clicks writes a DIRECTORY of steps + a contact sheet;
    # with one click it defaults to a single image (an --out given without an
    # image suffix is taken as a folder instead).
    out = base / "build" / "check" / target.stem
    return out if marks > 1 else out.with_suffix(".png")


def shoot_ids(target: str, ids: list[str], out: str | None,
              settle: float) -> None:
    """Shoot slides by id through a throwaway deck that holds only them."""
    import slide as slidetool
    deck = slidetool.open_target(target)
    keep = []
    for sid in ids:
        s = json.loads(json.dumps(slidetool.find(deck.doc, sid)))
        s.pop("stateOf", None)
        s.pop("hidden", None)
        keep.append(s)
    doc = dict(deck.doc, slides=keep)
    shell = deck.path.read_text(encoding="utf-8")
    payload = deckio.encode(doc)
    m = deckio.DOC_RE.search(shell)
    check = deck.build / "check"
    check.mkdir(parents=True, exist_ok=True)
    tmp = check / f"ids-{os.getpid()}.html"
    tmp.write_text(shell[:m.start(2)] + payload + shell[m.end(2):],
                   encoding="utf-8")
    out_dir = Path(out) if out else deck.build / "shots"
    stage = check / f"ids-{os.getpid()}"
    try:
        run(tmp, stage, None, settle, None, 10 ** 6)
        for i, sid in enumerate(ids, 1):
            src = stage / f"slide-{i:02d}.png"
            if src.exists():
                out_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), out_dir / f"{sid}.png")
                print(out_dir / f"{sid}.png")
    finally:
        tmp.unlink(missing_ok=True)
        shutil.rmtree(stage, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("deck", help="a deck .html file, or --page's HTML file")
    ap.add_argument("--out", default=None,
                    help="default: the DECK'S OWN build/ folder — "
                         "<deck dir>/build/shots for a deck, "
                         "<page dir>/build/check/<page> for --page. Output "
                         "belongs beside the deck it came from, never in "
                         "whatever directory the command happened to run in")
    ap.add_argument("-n", "--count", type=int, default=None)
    ap.add_argument("--settle", type=float, default=1.3,
                    help="seconds to wait for entrance animations")
    ap.add_argument("--page", action="store_true",
                    help="shoot a standalone HTML page (an embed poster), "
                         "not a deck")
    ap.add_argument("--size", default="1280x720", help="--page: WxH")
    ap.add_argument("--scale", type=int, default=1,
                    help="--page: pixel multiple of the saved image — 2 for a "
                         "print/Moodle-grade copy (2560x1000 from 1280x500)")
    ap.add_argument("--clicks", default="0",
                    help="--page: advance a self-paced figure N times first. "
                         "N states = clicks 0..N-1. A list (0,3,7), 'all' or "
                         "'last'. Several states write full-size step-NN.png "
                         "+ contact.png into --out as a folder; an --out with "
                         "no image suffix is always a folder")
    ap.add_argument("--only", default=None,
                    help="shoot just these slides: 3,7,12-15 — for a re-check "
                         "after a fix, instead of the whole deck again")
    ap.add_argument("--per-sheet", type=int, default=12,
                    help="slides per contact sheet (0 = one tall sheet)")
    ap.add_argument("--id", default=None,
                    help="shoot these slide ids (a,b,c) from a one-off deck "
                         "holding only them: no stepping past earlier "
                         "slides, works for hidden/state slides. DECK may be "
                         "`live` (or a session id) to shoot what the open "
                         "editor shows, unsaved edits included. Writes "
                         "build/shots/<id>.png")
    args = ap.parse_args()
    if args.id:
        return shoot_ids(args.deck, [s for s in args.id.split(",") if s],
                         args.out, args.settle)
    if args.out is None:
        key = (args.clicks or "0").strip().lower()
        marks = (2 if key in ("last", "all") else
                 len(set(parse_only(key) or [0]))) if args.page else 1
        args.out = str(default_out(Path(args.deck), args.page, marks))
    if args.page:
        w, h = (int(v) for v in args.size.lower().split("x"))
        shoot_page(Path(args.deck), Path(args.out), w, h,
                   args.clicks or "0",
                   args.settle, args.scale)
    else:
        run(Path(args.deck), Path(args.out), args.count, args.settle,
            parse_only(args.only) if args.only else None,
            args.per_sheet or 10 ** 6)


if __name__ == "__main__":
    sys.exit(main())
