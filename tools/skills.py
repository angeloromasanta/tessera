"""The agent skills that ship with tessera: keep the copies agree, install them, test them.

    python tools/skills.py sync             copy .agents/skills/tessera* to .claude/skills/ (after editing)
    python tools/skills.py check            the two copies agree, and scripts/deck.py with without-tools.md's examples runs on template.html
    python tools/skills.py install DEST     put the skills in a workspace (DEST/.agents/skills and
                                            DEST/.claude/skills); run again after `git pull` to update

`.agents/skills/` is the source (Codex and other agents read it); `.claude/skills/`
is a plain copy for Claude Code, because a symlink does not survive a clone on
Windows. Only folders named `tessera` or `tessera-*` are ever written or removed,
so a workspace's own skills beside them are left alone.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import filecmp
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / ".agents" / "skills"
MIRROR = REPO / ".claude" / "skills"


def ours(folder: Path) -> list[Path]:
    return sorted(p for p in folder.glob("tessera*") if p.is_dir() and re.fullmatch(r"tessera(-[a-z0-9-]+)?", p.name))


def copy_into(dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    names = [p.name for p in ours(SRC)]
    for old in ours(dest):                       # a skill renamed or removed upstream goes too
        if old.name not in names:
            shutil.rmtree(old)
    for p in ours(SRC):
        target = dest / p.name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(p, target, ignore=shutil.ignore_patterns("__pycache__"))
    return names


def same(a: Path, b: Path) -> bool:
    cmp = filecmp.dircmp(a, b, ignore=["__pycache__"])
    if cmp.left_only or cmp.right_only or cmp.diff_files or cmp.funny_files:
        return False
    return all(same(a / d, b / d) for d in cmp.common_dirs)


def check_toolkit() -> None:
    """Run the hub's scripts/deck.py, and without-tools.md's own examples, on
    template.html: a deck from layouts, a copied poll, the worked figure."""
    import importlib.util
    skill = SRC / "tessera"
    spec = importlib.util.spec_from_file_location("deck", skill / "scripts" / "deck.py")
    deck = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deck)
    text = (skill / "without-tools.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```python\n(.*?)```", text, re.S)
    basic = next(b for b in blocks if "from deck import *" in b)
    example = next(b for b in blocks if "figure_page(doc, marks, script)" in b)
    with tempfile.TemporaryDirectory() as tmp:
        ns = dict(vars(deck))
        with contextlib.redirect_stdout(io.StringIO()):   # the example prints a slide list
            exec(basic.replace("from deck import *", "").replace('"template.html"', repr(str(REPO / "template.html")))
                 .replace('"agents-classroom.html"', repr(str(Path(tmp) / "basic.html"))), ns)
        html, span, doc = deck.load(str(REPO / "template.html"))
        ns["doc"] = doc
        poll_slide = next(s["id"] for s in doc["slides"]
                          if any(e["type"] == "poll" for e in s["elements"]) and not s.get("hidden"))
        doc["slides"] = [deck.from_layout(doc, deck.layout_id(doc, "title")), deck.copy_slide(doc, poll_slide)]
        exec(example, ns)
        out = Path(tmp) / "check.html"
        deck.save(html, span, doc, str(out))
        deck.check(str(out))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sync")
    sub.add_parser("check")
    inst = sub.add_parser("install")
    inst.add_argument("dest", help="the workspace folder (it gets .agents/skills and .claude/skills)")
    args = ap.parse_args()

    if args.cmd == "sync":
        print("synced:", ", ".join(copy_into(MIRROR)))
    elif args.cmd == "install":
        dest = Path(args.dest).resolve()
        if dest == REPO:
            sys.exit("that is the tessera checkout itself: use `sync`")
        for where in (".agents/skills", ".claude/skills"):
            names = copy_into(dest / where)
        print(f"installed in {dest}: {', '.join(names)}")
    else:
        bad = [p.name for p in ours(SRC) if not (MIRROR / p.name).is_dir() or not same(p, MIRROR / p.name)]
        bad += [p.name for p in ours(MIRROR) if not (SRC / p.name).is_dir()]
        if bad:
            sys.exit(f".claude/skills differs from .agents/skills ({', '.join(sorted(set(bad)))}): run `python tools/skills.py sync`")
        check_toolkit()
        print("skills: copies agree, deck.py and without-tools.md run on template.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
