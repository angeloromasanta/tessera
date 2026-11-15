"""Re-shoot the posters of the template's embed slides from their own pages.

    python template/posters.py [--template template.html] [--only KEY,KEY] [--no-write]

An embed's poster is what the editor canvas, the thumbnails and every frozen
copy show, so after a figure is re-coloured or rebuilt its poster must be
re-shot, or the slide shows the old picture until it is presented. For each
embed slide this writes the page to template/build/posters/, shoots it at its
frame size, saves template/media/posters/<poster key>.(png|jpg) and puts the
image back into the template (unless --no-write).

How each page is shot:
  page-swarm-cover        250 ms after load (the field starts warm)
  page-hive-*             with a stand-in host whose previous poll is the slide's own
                          (question still the placeholder), so the page opens on its
                          finished sample view
  pages with a game meta  the game SDK (slides/src/game-sdk.js) inlined, sample mode
  stepped figures         their last state (tools/shoot.py --page --clicks last)
  the lab                 its first state
Needs python playwright (Chromium) and, for stepped figures, Chrome for tools/shoot.py.
"""
import argparse
import base64
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from splice_template import read_doc, write_doc  # noqa: E402

BUILD = HERE / "build" / "posters"
MEDIA = HERE / "media" / "posters"
SDK = ROOT / "slides" / "src" / "game-sdk.js"
SHOOT = ROOT / "tools" / "shoot.py"
sys.path.insert(0, str(ROOT / "tools"))
import legacy  # noqa: E402  (old names: pages built before the rename)
GAME_META = re.compile(r'<meta name="(?:tessera-game|%s)"' % re.escape(legacy.GAME_META))

HOST_JS = """
(() => {
  const prev = %s;
  const api = {poll: {previous: prev, service: '', session: '', lecturer: ''},
               text: (k, d) => d, texts: {}};
  window.TESSERA_EMBED = api;
})();
"""


def shoot_live(html: Path, out: Path, w: int, h: int, wait_ms: int, host: dict | None) -> list:
    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": w, "height": h})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        if host is not None:
            pg.add_init_script(HOST_JS % json.dumps(host))
        pg.goto(html.as_uri())
        pg.wait_for_timeout(wait_ms)
        kw = {"type": "jpeg", "quality": 88} if out.suffix == ".jpg" else {}
        pg.screenshot(path=str(out), **kw)
        b.close()
    return errors


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--template", default=str(ROOT / "template.html"))
    ap.add_argument("--only", help="comma-separated page asset keys")
    ap.add_argument("--no-write", action="store_true", help="shoot only; leave the template as it is")
    a = ap.parse_args()
    target = Path(a.template)
    raw, m, doc = read_doc(target)
    BUILD.mkdir(parents=True, exist_ok=True)
    MEDIA.mkdir(parents=True, exist_ok=True)
    only = set(a.only.split(",")) if a.only else None
    done = {}
    for s in doc["slides"]:
        poll = next((e for e in s["elements"] if e.get("type") == "poll"), None)
        for e in s["elements"]:
            key, poster = e.get("asset"), (e.get("poster") or "").removeprefix("asset:")
            if e.get("type") != "embed" or not key or not poster or key in done:
                continue
            if only and key not in only:
                continue
            page = doc["assets"][key]
            w, h = int(e["w"]), int(e["h"])
            ext = ".png" if doc["assets"].get(poster, "").startswith("data:image/png") else ".jpg"
            out = MEDIA / f"{poster}{ext}"
            src = BUILD / f"{key}.html"
            errors = []
            if GAME_META.search(page) and SDK.exists():
                # the SDK file defines window.TesseraGame; a page built earlier may call it by an
                # older global name, which the deck aliases -- alias it here too
                names = sorted(set(re.findall(r"\bwindow\.(\w+Game)\b", page)) - {"TesseraGame"})
                alias = "".join(f"window.{n}=window.{n}||window.TesseraGame;" for n in names)
                page = ("<script>" + SDK.read_text(encoding="utf-8") + "</script><script>" + alias +
                        "</script>" + page)
            src.write_text(page, encoding="utf-8", newline="\n")
            if key == "page-swarm-cover":
                errors = shoot_live(src, out, w, h, 250, None)
            elif key.startswith("page-hive"):
                prev = {"question": poll["question"], "code": poll["code"], "kind": "open"} if poll else None
                errors = shoot_live(src, out, w, h, 6000, prev)
            elif GAME_META.search(page):
                errors = shoot_live(src, out, w, h, 2500, None)
            else:
                clicks = "0" if key.startswith("page-lab") else "last"
                # a page whose last state lands in a slow sequence says how long to wait
                settle = re.search(r'<meta name="poster-settle" content="([\d.]+)"', page)
                r = subprocess.run([sys.executable, str(SHOOT), str(src), "--page", "--size", f"{w}x{h}",
                                    "--clicks", clicks, "--settle", settle[1] if settle else "1.5",
                                    "--out", str(out)],
                                   capture_output=True, text=True)
                if r.returncode:
                    raise SystemExit(f"{key}: shoot.py failed\n{r.stdout}\n{r.stderr}")
            mime = "image/png" if ext == ".png" else "image/jpeg"
            done[key] = (poster, out)
            doc["assets"][poster] = f"data:{mime};base64," + base64.b64encode(out.read_bytes()).decode()
            print(f"{key} -> {out.relative_to(ROOT)} ({w}x{h})" + (f"  page errors: {errors}" if errors else ""))
    if not a.no_write:
        write_doc(target, raw, m, doc, backup=False)
        print(f"{target.name}: {len(done)} posters written")


if __name__ == "__main__":
    main()
