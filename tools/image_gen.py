#!/usr/bin/env python3
"""Generate a picture for a slide with Seedream 4.5 through OpenRouter.

    python image_gen.py "three students laughing over laptops in a bright library" \
        --deck slides/X/deck.md --name network

Writes <deck dir>/build/media/<name>.png (or .jpg, whatever the model
returns) and appends a line to CREDITS.md saying it was generated, with the
prompt. Needs OPENROUTER_API_KEY in the environment or in the .env.

--style TEXT (or --style-file FILE) is prepended to every prompt so a deck's
pictures share one look; by default the prompt is sent as it is. --dry-run
prints the final prompt and calls nothing.
"""
import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_MODEL ="bytedance-seed/seedream-4.5"
DEFAULT_STYLE = ""  # no prefix: the prompt is sent as written


def media_dir(deck):
    if deck:
        p = Path(deck)
        base = p if p.is_dir() else p.parent
    else:
        base = Path.cwd()
    d = base / "build" / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


def generate(prompt, model, aspect, resolution, key):
    body = {"model": model, "prompt": prompt, "aspect_ratio": aspect, "resolution": resolution}
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/images", data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "User-Agent": config.USER_AGENT,
                 "HTTP-Referer": "https://github.com/angeloromasanta/tessera",
                 "X-Title": "tessera image_gen"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"openrouter {e.code}: {e.read().decode('utf-8', 'replace')[:600]}")
    items = d.get("data") or []
    if not items:
        sys.exit("no image in response: " + json.dumps(d)[:600])
    it = items[0]
    if it.get("b64_json"):
        raw = base64.b64decode(it["b64_json"])
    elif it.get("url", "").startswith("data:"):
        raw = base64.b64decode(it["url"].split(",", 1)[1])
    elif it.get("url"):
        raw = urllib.request.urlopen(it["url"], timeout=120).read()
    else:
        sys.exit("unrecognised image payload: " + json.dumps(it)[:300])
    mt = it.get("media_type") or it.get("mime_type") or "image/png"
    return raw, "jpg" if "jpeg" in mt or "jpg" in mt else "png"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompt")
    ap.add_argument("--deck", help="the deck file or folder; the image goes to its build/media/")
    ap.add_argument("--name", required=True, help="file stem (build/media/<name>.png)")
    ap.add_argument("--aspect", default="16:9", help="aspect ratio (default 16:9; 4:3 for a slide half, 1:1 for a card)")
    ap.add_argument("--resolution", default="2K", help="1K, 2K or 4K (default 2K)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--style", default=DEFAULT_STYLE, help="prefix prepended to the prompt (default: none)")
    ap.add_argument("--style-file", help="read the prefix from this file (wins over --style)")
    ap.add_argument("--dry-run", action="store_true", help="print the final prompt; no API call, nothing written")
    ap.add_argument("--variants", type=int, default=1, help="generate N files: <name>-1, -2, …")
    a = ap.parse_args()

    style = Path(a.style_file).read_text(encoding="utf-8") if a.style_file else a.style
    full = (style.strip() + " " + a.prompt.strip()).strip()
    if a.dry_run:
        print(f"model {a.model}, aspect {a.aspect}, resolution {a.resolution}, {a.variants} variant(s)")
        print(f"prompt: {full}")
        return
    key = config.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY not set and not found in any .env up the tree")
    md = media_dir(a.deck)
    for i in range(1, a.variants + 1):
        raw, ext = generate(full, a.model, a.aspect, a.resolution, key)
        stem = a.name if a.variants == 1 else f"{a.name}-{i}"
        out = md / f"{stem}.{ext}"
        out.write_bytes(raw)
        with open(md / "CREDITS.md", "a", encoding="utf-8") as f:
            f.write(f"- `{out.name}` — generated with {a.model} via OpenRouter. Prompt: {a.prompt.strip()}\n")
        print(f"saved {out} ({len(raw)//1024} KB)")


if __name__ == "__main__":
    main()
