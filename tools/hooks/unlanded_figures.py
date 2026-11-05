"""Stop hook: refuse to end a turn while a figure built for a deck is not in it.

The presenter watches the open editor / live link; a figure page sitting in
<decks>/<deck>/build/ is invisible there. Blocks once (stop_hook_active stops
a loop) when, for a deck touched in the last hours:
  - a bundled figure build/fig-*.html is not referenced by the deck's spec,
    postcompile.json or a script in the deck folder;
  - a compiled deck has an inline figure that shows only its poster in the
    editor (no liveInEditor).

The deck folder is TESSERA_DECKS (config.py: .env or environment, default
`decks`). Wire it as a Claude Code Stop hook:
    python "$CLAUDE_PROJECT_DIR/tools/hooks/unlanded_figures.py"
"""
import json, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config  # noqa: E402
import deckio  # noqa: E402

# Pages that run only in present mode on purpose: the interactive title
# (make_remix.py) would start a second AI queue in the editor
# (docs/guide/engagement-pages.md, "Interactive title").
PRESENT_ONLY = ("page-remix-",)

RECENT = 6 * 3600
SETTLING = 10 * 60   # a page changed this recently is still being built by its agent


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    if data.get("stop_hook_active"):
        return
    decks_dir = config.decks_dir()
    if not decks_dir.is_dir():
        return
    root = decks_dir.parent
    now, problems = time.time(), []
    for deck_dir in sorted(decks_dir.glob("*/")):
        build = deck_dir / "build"
        figs = [f for f in build.glob("fig-*.html") if now - f.stat().st_mtime < RECENT] if build.is_dir() else []
        decks = [d for d in deck_dir.rglob("*.html")
                 if "build" not in d.relative_to(deck_dir).parts and now - d.stat().st_mtime < RECENT]
        if not figs and not decks:
            continue
        refs = ""
        for f in [*deck_dir.rglob("*.md"), *deck_dir.glob("postcompile.json"), *deck_dir.rglob("*.py")]:
            try:
                refs += f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                pass
        for f in figs:
            if now - f.stat().st_mtime < SETTLING:
                continue
            if f.name not in refs:
                problems.append(f"{f.relative_to(root).as_posix()} is built but not in any deck of {deck_dir.name}")
        for d in decks:
            m = deckio.DOC_RE.search(d.read_text(encoding="utf-8", errors="ignore"))
            try:
                doc = json.loads(m.group(2)) if m else {}
            except ValueError:
                continue
            still = [s["id"] for s in doc.get("slides", []) for e in s.get("elements", [])
                     if e.get("type") == "embed" and e.get("asset") and not e.get("liveInEditor")
                     and not str(e["asset"]).startswith(PRESENT_ONLY)]
            if still:
                problems.append(f"{d.relative_to(root).as_posix()}: figures show only a poster in the editor/live link: {', '.join(still)}")
    if problems:
        print(json.dumps({"decision": "block", "reason":
            "Not landed yet: put each finished figure into its deck now "
            "(tools/land.py, or tools/slide.py ... live) and make figures run in the editor, "
            "or say why a file is intentionally unused.\n- " + "\n- ".join(problems)}))


if __name__ == "__main__":
    main()
