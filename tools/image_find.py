#!/usr/bin/env python3
"""Find an open-licence photograph for a slide.

Two subcommands:

  search  query a keyless photo source (Openverse and Wikimedia Commons),
          download thumbnails, and lay them out on ONE numbered contact
          sheet so the candidates can be judged by looking at them.
  pick    download the full-size file behind one number, write it into the
          deck's build/media/, and append its credit line to CREDITS.md.

    python image_find.py search "students laughing around a table" --deck slides/X/deck.md
    python image_find.py pick slides/X/build/media/find-students-laughing.json 3 --name network

Everything lands in <deck dir>/build/media/ — the sheet, its .json, the
picked photo and CREDITS.md. No API key is needed for either source; add
PEXELS_API_KEY to the environment (or the .env) and Pexels joins the
search, which is where the polished editorial photos usually are.
"""
import argparse
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("pip install Pillow")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

UA = {"User-Agent": "tessera image tool/1.0 (slide decks; https://github.com/angeloromasanta/tessera)"}
TIMEOUT = 40


# --------------------------------------------------------------------------- paths
def media_dir(deck: str | None) -> Path:
    """<deck dir>/build/media — the deck may be a file (.html/.md) or a folder."""
    if deck:
        p = Path(deck)
        base = p if p.is_dir() else p.parent
    else:
        base = Path.cwd()
    d = base / "build" / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_env_key(name: str) -> str | None:
    return config.get(name) or None


def slug(s: str, n: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n] or "query"


def fetch(url: str, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def fetch_json(url: str, headers: dict | None = None) -> dict:
    return json.loads(fetch(url, headers).decode("utf-8"))


# --------------------------------------------------------------------------- sources
def search_openverse(q: str, n: int, wide: bool) -> list[dict]:
    params = {"q": q, "page_size": n, "mature": "false"}
    if wide:
        params["aspect_ratio"] = "wide"
    d = fetch_json("https://api.openverse.org/v1/images/?" + urllib.parse.urlencode(params))
    out = []
    for r in d.get("results", []):
        out.append({
            "source": f"openverse/{r.get('source', '')}",
            "title": (r.get("title") or "")[:90],
            "creator": r.get("creator") or "",
            "license": f"CC {r.get('license', '').upper()} {r.get('license_version', '')}".strip(),
            "license_url": r.get("license_url") or "",
            "page": r.get("foreign_landing_url") or r.get("url"),
            "thumb": r.get("thumbnail") or r.get("url"),
            "full": r.get("url"),
            "width": r.get("width") or 0, "height": r.get("height") or 0,
        })
    return out


def search_commons(q: str, n: int) -> list[dict]:
    params = {"action": "query", "generator": "search", "gsrnamespace": 6,
              "gsrsearch": f"filetype:bitmap {q}", "gsrlimit": n,
              "prop": "imageinfo", "iiprop": "url|size|extmetadata",
              "iiurlwidth": 640, "format": "json"}
    d = fetch_json("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params))
    out = []
    for p in d.get("query", {}).get("pages", {}).values():
        ii = p["imageinfo"][0]
        meta = ii.get("extmetadata", {})
        get = lambda k: re.sub(r"<[^>]+>", "", meta.get(k, {}).get("value", "")).strip()
        out.append({
            "source": "wikimedia commons",
            "title": p["title"].replace("File:", "")[:90],
            "creator": get("Artist")[:60],
            "license": get("LicenseShortName"),
            "license_url": get("LicenseUrl"),
            "page": ii.get("descriptionurl"),
            "thumb": ii.get("thumburl") or ii.get("url"),
            "full": ii.get("url"),
            "width": ii.get("width", 0), "height": ii.get("height", 0),
        })
    return out


def search_pexels(q: str, n: int, wide: bool, key: str) -> list[dict]:
    params = {"query": q, "per_page": n}
    if wide:
        params["orientation"] = "landscape"
    d = fetch_json("https://api.pexels.com/v1/search?" + urllib.parse.urlencode(params),
                   {"Authorization": key})
    out = []
    for r in d.get("photos", []):
        out.append({
            "source": "pexels",
            "title": (r.get("alt") or "")[:90],
            "creator": r.get("photographer") or "",
            "license": "Pexels licence",
            "license_url": "https://www.pexels.com/license/",
            "page": r.get("url"),
            "thumb": r["src"].get("medium"),
            "full": r["src"].get("original"),
            "width": r.get("width", 0), "height": r.get("height", 0),
        })
    return out


# --------------------------------------------------------------------------- sheet
def contact_sheet(cands: list[dict], out: Path, cols: int = 4, cell=(320, 220)) -> None:
    rows = (len(cands) + cols - 1) // cols
    w, h = cell
    sheet = Image.new("RGB", (cols * w, rows * (h + 34)), "white")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    for i, c in enumerate(cands):
        x, y = (i % cols) * w, (i // cols) * (h + 34)
        try:
            im = Image.open(io.BytesIO(fetch(c["thumb"]))).convert("RGB")
            im.thumbnail((w - 8, h - 8))
            sheet.paste(im, (x + 4 + (w - 8 - im.width) // 2, y + 4 + (h - 8 - im.height) // 2))
        except Exception as e:  # a dead thumbnail should not kill the sheet
            draw.text((x + 8, y + 8), f"(thumb failed: {e})"[:40], fill="red", font=font)
        draw.rectangle([x + 4, y + 4, x + 34, y + 26], fill="#0F6B73")
        draw.text((x + 10, y + 8), str(i + 1), fill="white", font=font)
        cap = f"{c['width']}x{c['height']} · {c['license']} · {c['source']}"
        draw.text((x + 6, y + h + 4), cap[:52], fill="#1A2326", font=font)
        draw.text((x + 6, y + h + 18), c["title"][:52], fill="#666", font=font)
    sheet.save(out)


# --------------------------------------------------------------------------- commands
def cmd_search(a):
    md = media_dir(a.deck)
    cands: list[dict] = []
    per = a.n
    errors = []
    if "pexels" in a.sources:
        key = load_env_key("PEXELS_API_KEY")
        if key:
            try:
                cands += search_pexels(a.query, per, a.wide, key)
            except Exception as e:
                errors.append(f"pexels: {e}")
    if "openverse" in a.sources:
        try:
            cands += search_openverse(a.query, per, a.wide)
        except Exception as e:
            errors.append(f"openverse: {e}")
    if "commons" in a.sources:
        try:
            cands += search_commons(a.query, per)
        except Exception as e:
            errors.append(f"commons: {e}")
    cands = [c for c in cands if c["width"] >= a.min_width]
    if a.wide:
        cands = [c for c in cands if c["height"] and c["width"] / c["height"] >= 1.15]
    cands = cands[: a.max]
    for e in errors:
        print("warning:", e, file=sys.stderr)
    if not cands:
        sys.exit("no candidates — loosen --min-width, drop --wide, or generate one with image_gen.py")
    stem = "find-" + slug(a.query)
    js = md / f"{stem}.json"
    png = md / f"{stem}.png"
    js.write_text(json.dumps({"query": a.query, "candidates": cands}, indent=1), encoding="utf-8")
    contact_sheet(cands, png)
    print(f"{len(cands)} candidates → {png}")
    for i, c in enumerate(cands, 1):
        print(f"{i:2d}. {c['width']}x{c['height']}  {c['license']:<16} {c['source']:<22} {c['title']}")
    print(f"\nNext: Read {png}, then\n  python {Path(__file__).name} pick {js} <N> --name <slug>")


def cmd_pick(a):
    js = Path(a.results)
    data = json.loads(js.read_text(encoding="utf-8"))
    c = data["candidates"][a.n - 1]
    md = js.parent
    raw = fetch(c["full"])
    im = Image.open(io.BytesIO(raw))
    ext = "png" if im.mode in ("RGBA", "P") and (im.format or "").upper() == "PNG" else "jpg"
    if im.width > a.max_width:
        im = im.convert("RGB") if ext == "jpg" else im
        im.thumbnail((a.max_width, a.max_width * 10))
    out = md / f"{a.name}.{ext}"
    if ext == "jpg":
        im.convert("RGB").save(out, quality=88)
    else:
        im.save(out)
    credit = (f"- `{out.name}` — {c['title']}" + (f", {c['creator']}" if c['creator'] else "")
              + f" · {c['license']} · {c['page']}")
    with open(md / "CREDITS.md", "a", encoding="utf-8") as f:
        f.write(credit + "\n")
    print(f"saved {out} ({im.width}x{im.height})\ncredit appended to {md / 'CREDITS.md'}:\n{credit}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search", help="query the sources and build a contact sheet")
    s.add_argument("query")
    s.add_argument("--deck", help="the deck file or folder; results go to its build/media/")
    s.add_argument("--n", type=int, default=8, help="results per source (default 8)")
    s.add_argument("--max", type=int, default=12, help="candidates on the sheet (default 12)")
    s.add_argument("--min-width", type=int, default=1000, help="drop files narrower than this (default 1000)")
    s.add_argument("--wide", action="store_true", help="landscape only — what a cover-cropped slide half wants")
    s.add_argument("--sources", default="pexels,openverse,commons",
                   help="comma list of pexels,openverse,commons (pexels needs PEXELS_API_KEY)")
    s.set_defaults(fn=cmd_search)
    p = sub.add_parser("pick", help="download one candidate at full size")
    p.add_argument("results", help="the find-*.json written by search")
    p.add_argument("n", type=int, help="candidate number on the sheet")
    p.add_argument("--name", required=True, help="file stem to save as (build/media/<name>.jpg)")
    p.add_argument("--max-width", type=int, default=2000, help="downscale wider files (default 2000)")
    p.set_defaults(fn=cmd_pick)
    a = ap.parse_args()
    if a.cmd == "search":
        a.sources = [x.strip() for x in a.sources.split(",")]
    a.fn(a)


if __name__ == "__main__":
    main()
