"""Watch figure agents build on the deck's edit canvas, then bundle the result.

Three steps, all run from the workspace root. The deck must be compiled from a spec.

    python tools/live_figures.py open  decks/X/deck.md roadmap="The year in four steps" cycle="How a session works"
    python tools/live_figures.py agent decks/X/deck.md roadmap --brief decks/X/build/agents/roadmap.md
    python tools/live_figures.py close decks/X/deck.md

open   For each NAME="slide title" (an `## embed` block with that title;
       `--after "Other title"` creates missing ones after that slide, and
       `--convert` turns a non-embed slide with that title into an embed,
       keeping its title and notes):
       creates build/figures/NAME.html (a placeholder if missing) and a poster,
       points the block at http://127.0.0.1:PORT/build/figures/NAME.html with
       `live: yes` and `sandbox: allow-same-origin`, recompiles the deck and
       stamps its agent notes. It also drops the deck's text font next to the
       figures as build/figures/MANROPE, so the starter's url(MANROPE) resolves
       while live and in agent screenshots: labels measure as they will ship.
       Then starts the live server (live.py start, idempotent). Refresh the
       deck file once in Chrome (edit mode); after that every save of a
       figure reloads only its frame.

agent  Runs one Codex agent (default gpt-6-sol, workspace-write sandbox) on
       NAME, with the shared brief (docs/guide/reference/AGENT_BRIEF.md,
       placeholders filled) followed by --brief. Blocks until it finishes, so
       launch each in the background. Log and final message go to
       build/agents/NAME.log and NAME.result.md.

revise Sends feedback (--feedback FILE.md) to a finished agent: resumes its
       Codex session (id read from NAME.log), same model and sandbox, with the
       figure's poster attached so it sees what you saw. Blocking; background it.
       Log: NAME.revN.log.

status Per figure: running agent, seconds since its last save, the first
       line of its last handback, and whether the deck still depends on the
       live server (not portable). Answers "are they building?".

stop   Kills one figure's running agent (agent or revise) with its whole
       process tree. Use before relaunching with a changed brief.

close  For every embed still pointing at the live server: inlines the font
       (build/figures/NAME.html -> build/fig-NAME.html), switches the block to
       `page: build/fig-NAME.html`, keeps `live: yes` and the poster, drops the
       sandbox token, and recompiles. The deck is portable again.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import config  # noqa: E402
import deckio  # noqa: E402

REPO = config.REPO
# the agents work in the workspace that holds the .env (else the current directory)
WORKSPACE = config.env_file().parent if config.env_file() else Path.cwd()
BRIEF = REPO / "docs" / "guide" / "reference" / "AGENT_BRIEF.md"
TEMPLATE = config.template()
# A resumed agent plans a big layout change silently before its first save;
# the presenter, watching the canvas, sees nothing for minutes. Say it every round.
REVISE_PREFIX = ("The presenter is watching your figure live. Save a rough, valid version of "
                 "any layout change within ~2 minutes, then refine it with small Edits.\n\n")
PLACEHOLDER = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>{name}</title>
<style>html,body{{margin:0;height:100%;background:#fff;font-family:Manrope,Segoe UI,sans-serif;color:#1A2326}}
body{{display:grid;place-items:center}}p{{font-size:22px;opacity:.55}}</style></head>
<body><p>{name} · an agent is building this figure…</p></body></html>
"""


def blocks(text: str) -> list[tuple[int, int]]:
    """(start, end) character spans of every `## ` block in a spec."""
    starts = [m.start() for m in re.finditer(r"(?m)^## ", text)] + [len(text)]
    return list(zip(starts, starts[1:]))


def field(block: str, key: str) -> str | None:
    m = re.search(rf"(?m)^{key}:[ \t]*(.*)$", block)
    return m.group(1).strip() if m else None


def set_fields(block: str, values: dict[str, str | None]) -> str:
    """Replace, add (right after the title line) or drop (None) top-level fields."""
    for key, val in values.items():
        pat = re.compile(rf"(?m)^{key}:.*\n?")
        if val is None:
            block = pat.sub("", block)
        elif pat.search(block):
            block = pat.sub(f"{key}: {val}\n", block, count=1)
        else:
            m = re.search(r"(?m)^title:.*\n", block) or re.search(r"^.*\n", block)
            block = block[:m.end()] + f"{key}: {val}\n" + block[m.end():]
    return block


def deck_for(spec: Path) -> Path:
    return spec.with_suffix(".html")


def compile_deck(spec: Path, template: Path) -> None:
    deck = deck_for(spec)
    run([sys.executable, str(TOOLS / "md_to_deck.py"), str(spec),
         "-t", str(template), "-o", str(deck)])
    stamp = REPO / "scripts" / "stamp-agent-notes.mjs"
    if stamp.exists():
        run(["node", str(stamp), str(deck)])


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout + r.stderr).strip().splitlines()
    print("\n".join("  " + l for l in out[-3:]))
    if r.returncode:
        raise SystemExit(f"failed: {' '.join(cmd[:3])} ...")


def text_font(deck: Path) -> bytes | None:
    """The deck's Latin text-font woff2 (as embed_font.py picks it)."""
    import base64
    if not deck.exists():
        return None
    doc = deckio.load(deck)
    fonts = sorted((f for f in doc.get("fonts", []) if f.get("family") == "Manrope"),
                   key=lambda f: "latin-ext" in f["asset"])
    if not fonts:
        return None
    uri = doc["assets"][fonts[0]["asset"]]
    return base64.b64decode(uri.split(",", 1)[1])


def placeholder_poster(page: Path, poster: Path, size: str) -> None:
    from playwright.sync_api import sync_playwright
    w, h = (int(n) for n in size.split("x"))
    poster.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": w, "height": h})
        pg.goto(page.resolve().as_uri())
        pg.screenshot(path=str(poster))
        b.close()


def prepare_blocks(text: str, wanted: dict, after: str | None, convert: bool) -> str:
    """Create missing embed blocks (after `after`) and convert other types."""
    spans = blocks(text)
    titles = {field(text[s:e], "title"): (s, e) for s, e in spans}
    for title in wanted:
        if title in titles:
            s, e = titles[title]
            block = text[s:e]
            if block.startswith("## embed"):
                continue
            if not convert:
                raise SystemExit(f"'{title}' is a `{block.splitlines()[0]}` slide; "
                                 "pass --convert to turn it into an embed")
            notes = field(block, "notes")
            new = f"## embed\ntitle: {title}\n" + (f"notes: {notes}\n" if notes else "") + "\n"
            text = text[:s] + new + text[e:]
            print(f"converted '{title}' to an embed slide (old body is in git)")
        else:
            if not after or after not in titles:
                raise SystemExit(f"no slide titled '{title}'; pass --after \"<existing "
                                 "title>\" to create it")
            s, e = titles[after]
            new = f"## embed\ntitle: {title}\nnotes: TODO\n\n"
            text = text[:e] + new + text[e:]
            print(f"created '{title}' after '{after}' (write its notes:)")
            after = title
        spans = blocks(text)
        titles = {field(text[s:e], "title"): (s, e) for s, e in spans}
    return text


def cmd_open(a: argparse.Namespace) -> None:
    spec = Path(a.spec)
    deck_dir = spec.parent
    wanted = {}
    for pair in a.figures:
        name, _, title = pair.partition("=")
        wanted[title.strip()] = name.strip()
    text = spec.read_text(encoding="utf-8")
    text = prepare_blocks(text, wanted, a.after, a.convert)
    out, last, found = [], 0, set()
    for s, e in blocks(text):
        block = text[s:e]
        title = field(block, "title")
        if block.startswith("## embed") and title in wanted:
            name = wanted[title]
            found.add(title)
            page = deck_dir / "build" / "figures" / f"{name}.html"
            page.parent.mkdir(parents=True, exist_ok=True)
            if not page.exists():
                page.write_text(PLACEHOLDER.format(name=name), encoding="utf-8")
            poster = field(block, "poster") or f"build/posters/{name}.png"
            if not (deck_dir / poster).exists():
                placeholder_poster(page, deck_dir / poster, "1280x500" if title else "1280x720")
            block = set_fields(block, {
                "page": None,
                "src": f"http://127.0.0.1:{a.port}/build/figures/{name}.html",
                "sandbox": "allow-same-origin", "poster": poster, "live": "yes"})
            print(f"live: {name}  <- '{title}'")
        out.append(text[last:s] + block)
        last = e
    missing = set(wanted) - found
    if missing:
        raise SystemExit(f"no `## embed` block titled: {sorted(missing)} "
                         "(add the slide to the spec first)")
    spec.write_text("".join(out) + text[last:], encoding="utf-8")
    font = text_font(deck_for(spec))
    if font:  # live.py serves this extension-less file raw, as a font
        (deck_dir / "build" / "figures" / "MANROPE").write_bytes(font)
    compile_deck(spec, Path(a.template))
    subprocess.run([sys.executable, str(TOOLS / "live.py"), "start", str(deck_dir),
                    "--port", str(a.port)], check=True)


def shared_brief(spec: Path, name: str) -> str:
    text = BRIEF.read_text(encoding="utf-8")
    for k, v in {"{NAME}": name, "{DECK_DIR}": spec.parent.as_posix(),
                 "{DECK}": deck_for(spec).as_posix(), "{T}": TOOLS.as_posix(),
                 "{KIT}": (REPO / "kit").as_posix()}.items():
        text = text.replace(k, v)
    return text


def latest_session(agents: Path, name: str) -> str | None:
    """Session id of the newest run of NAME (a --fresh round starts a new one)."""
    logs = list(agents.glob(f"{name}.log")) + list(agents.glob(f"{name}.rev*.log"))
    for log in sorted(logs, key=lambda f: f.stat().st_mtime, reverse=True):
        m = re.search(r"session id: (\S+)", log.read_text(encoding="utf-8", errors="replace"))
        if m:
            return m.group(1)
    return None


def cmd_agent(a: argparse.Namespace) -> None:
    spec = Path(a.spec)
    deck_dir = spec.parent
    agents = deck_dir / "build" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    prompt = shared_brief(spec, a.name) + "\n\n" + Path(a.brief).read_text(encoding="utf-8")
    codex = shutil.which("codex") or shutil.which("codex.cmd")
    if not codex:
        raise SystemExit("codex CLI not on PATH")
    cmd = [codex, "exec", "-m", a.model, "-c", f"model_reasoning_effort={a.effort}",
           "-s", "workspace-write", "-C", str(WORKSPACE),
           "-o", str(agents / f"{a.name}.result.md"), "-"]
    print(f"agent {a.name}: {a.model} ({a.effort}) -> {agents / (a.name + '.log')}")
    with open(agents / f"{a.name}.log", "w", encoding="utf-8") as log:
        r = subprocess.run(cmd, input=prompt, text=True, encoding="utf-8",
                           stdout=log, stderr=subprocess.STDOUT)
    result = agents / f"{a.name}.result.md"
    print(result.read_text(encoding="utf-8") if result.exists() else "(no result)")
    poster = Path(a.spec).parent / "build" / "posters" / f"{a.name}.png"
    print(f"\nreview the final frame before accepting: {poster}")
    sys.exit(r.returncode)


def cmd_revise(a: argparse.Namespace) -> None:
    spec = Path(a.spec)
    agents = spec.parent / "build" / "agents"
    codex = shutil.which("codex") or shutil.which("codex.cmd")
    n = 1 + len(list(agents.glob(f"{a.name}.rev*.log")))
    poster = spec.parent / "build" / "posters" / f"{a.name}.png"
    feedback = REVISE_PREFIX + Path(a.feedback).read_text(encoding="utf-8")
    if a.fresh:
        # A new session: a resumed one re-sends its whole history every round
        # (+60-100k tokens each) and keeps its old habits. The fresh agent gets
        # the briefs, every earlier feedback round, and the draft on disk.
        brief = agents / f"{a.name}.md"
        earlier = sorted(f for f in agents.glob(f"{a.name}.fb*.md")
                         if f.resolve() != Path(a.feedback).resolve())
        feedback = (shared_brief(spec, a.name) + "\n\n"
                    + (brief.read_text(encoding="utf-8") if brief.exists() else "")
                    + "\n\n# This is a revision, not a new build\n"
                    "Your file already holds a working draft that earlier rounds "
                    "produced and the presenter has seen. Keep everything the notes below "
                    "don't change: read the draft, then patch it.\n"
                    + "".join(f"\n## Earlier feedback ({f.name}), already applied\n"
                              + f.read_text(encoding="utf-8") for f in earlier)
                    + "\n## NEW feedback for this round\n" + feedback)
        cmd = [codex, "exec", "-m", a.model, "-c", f"model_reasoning_effort={a.effort}",
               "-s", "workspace-write", "-C", str(WORKSPACE),
               "-o", str(agents / f"{a.name}.result.md")]
    else:
        sid = latest_session(agents, a.name)
        if not sid:
            raise SystemExit(f"no session id in {a.name}'s logs; use --fresh")
        if n > 2:
            print(f"  note: resumed round {n}; each resume re-sends the whole history. "
                  "Consider --fresh.")
        # `resume` takes no -s: the sandbox goes in as config
        cmd = [codex, "exec", "resume", sid, "-m", a.model,
               "-c", f"model_reasoning_effort={a.effort}",
               "-c", 'sandbox_mode="workspace-write"',
               "-o", str(agents / f"{a.name}.result.md")]
    if poster.exists():
        cmd += ["-i", str(poster)]
    for img in a.image or []:  # e.g. a reference slide the feedback points to
        cmd += ["-i", img]
    cmd.append("-")
    log_path = agents / f"{a.name}.rev{n}.log"
    print(f"revise {a.name} (round {n}{', fresh session' if a.fresh else ''}) -> {log_path}")
    with open(log_path, "w", encoding="utf-8") as log:
        r = subprocess.run(cmd, input=feedback,
                           text=True, encoding="utf-8", stdout=log, stderr=subprocess.STDOUT)
    result = agents / f"{a.name}.result.md"
    print(result.read_text(encoding="utf-8") if result.exists() else "(no result)")
    poster = Path(a.spec).parent / "build" / "posters" / f"{a.name}.png"
    print(f"\nreview the final frame before accepting: {poster}")
    sys.exit(r.returncode)


def agent_procs(name: str | None = None):
    """(name, psutil.Process) for live_figures agent/revise runs."""
    import psutil
    found = []
    for p in psutil.process_iter(["cmdline"]):
        cl = p.info["cmdline"] or []
        if any(c.endswith("live_figures.py") for c in cl):
            i = next(i for i, c in enumerate(cl) if c.endswith("live_figures.py"))
            if len(cl) > i + 3 and cl[i + 1] in ("agent", "revise"):
                if name in (None, cl[i + 3]):
                    found.append((cl[i + 3], p))
    return found


def cmd_status(a: argparse.Namespace) -> None:
    import time
    spec = Path(a.spec)
    deck_dir = spec.parent
    running = {n for n, _ in agent_procs()}
    live = re.findall(r"(?m)^src:\s*http://127\.0\.0\.1:\d+/build/figures/([\w.-]+)\.html",
                      spec.read_text(encoding="utf-8"))
    names = sorted({p.stem for p in (deck_dir / "build" / "agents").glob("*.log")
                    if "." not in p.stem} | set(live))
    for n in names:
        page = deck_dir / "build" / "figures" / f"{n}.html"
        age = f"{time.time() - page.stat().st_mtime:6.0f}s ago" if page.exists() else "  missing"
        res = deck_dir / "build" / "agents" / f"{n}.result.md"
        first = res.read_text(encoding="utf-8").strip().splitlines()[0][:70] if res.exists() else ""
        print(f"{n:22} {'RUNNING' if n in running else 'idle   '} saved {age}"
              f"{'  LIVE' if n in live else ''}  {first}")
    if live:
        print("\n(these run from the live server on the edit canvas; the deck file carries "
              "each page too. `close` when the figures are finished)")


def cmd_stop(a: argparse.Namespace) -> None:
    procs = agent_procs(a.name)
    if not procs:
        print(f"no running agent for {a.name}")
    for n, p in procs:
        kids = p.children(recursive=True)
        for k in kids + [p]:
            try:
                k.kill()
            except Exception:
                pass
        print(f"stopped {n}: pid {p.pid} and {len(kids)} children")


def cmd_stats(a: argparse.Namespace) -> None:
    """Where each agent run spent its budget: for the next bottleneck review."""
    from collections import Counter
    agents = Path(a.spec).parent / "build" / "agents"
    rows, cmds_all = [], Counter()
    for log in sorted(agents.glob("*.log")):
        text = log.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        tok = next((lines[i + 1].strip() for i in range(len(lines) - 2, -1, -1)
                    if lines[i].strip() == "tokens used"), "?")
        cmds = [re.sub(r"\s+in [A-Z]:\\.*$", "",
                       re.sub(r"^.*?-Command ", "", lines[i + 1]))
                for i, l in enumerate(lines[:-1]) if l.strip() == "exec"]
        cmds = [re.sub(r"""["'@$]""", "", c).strip() for c in cmds]
        cmds = [c or "(multi-line inline script)" for c in cmds]
        fails = len(re.findall(r"(?m)^ exited [1-9]\d* in ", text))
        kinds = Counter((c.split() or ["?"])[0] for c in cmds)
        cmds_all.update(c[:50] for c in cmds)
        rows.append((log.name, tok, len(cmds), fails,
                     ", ".join(f"{k} x{v}" for k, v in kinds.most_common(4))))
    print("tokens are cumulative per Codex session: a revN row includes every earlier round")
    print(f"{'run':<32}{'tokens':>10}{'cmds':>6}{'fail':>6}  top commands")
    for r in rows:
        print(f"{r[0]:<32}{r[1]:>10}{r[2]:>6}{r[3]:>6}  {r[4]}")
    print("\nmost repeated commands across runs (a pattern here is a harness gap):")
    for c, k in cmds_all.most_common(8):
        print(f"  {k:>3}x  {c}")


def cmd_close(a: argparse.Namespace) -> None:
    spec = Path(a.spec)
    deck_dir = spec.parent
    deck = deck_for(spec)
    text = spec.read_text(encoding="utf-8")
    out, last, n = [], 0, 0
    for s, e in blocks(text):
        block = text[s:e]
        m = re.search(r"(?m)^src:\s*http://127\.0\.0\.1:\d+/build/figures/([\w.-]+)\.html\s*$", block)
        if block.startswith("## embed") and m and (not a.names or m.group(1) in a.names):
            name = m.group(1)
            src = deck_dir / "build" / "figures" / f"{name}.html"
            dst = deck_dir / "build" / f"fig-{name}.html"
            if "url(MANROPE)" in src.read_text(encoding="utf-8"):
                run([sys.executable, str(TOOLS / "embed_font.py"), str(src),
                     "--deck", str(deck), "-o", str(dst)])
            else:
                shutil.copyfile(src, dst)
            sandbox = [t for t in (field(block, "sandbox") or "").split()
                       if t != "allow-same-origin"]
            block = set_fields(block, {"src": None, "page": f"build/fig-{name}.html",
                                       "sandbox": " ".join(sandbox) or None,
                                       "live": "yes"})
            print(f"bundled: {name} -> build/fig-{name}.html")
            n += 1
        out.append(text[last:s] + block)
        last = e
    if not n:
        print("no live embeds in the spec")
        return
    spec.write_text("".join(out) + text[last:], encoding="utf-8")
    compile_deck(spec, Path(a.template))
    print("the live server is still running; `live.py stop` when the session ends")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(required=True)
    p = sub.add_parser("open", help="switch embed slides to live localhost figures")
    p.add_argument("spec")
    p.add_argument("figures", nargs="+", help='NAME="exact slide title"')
    p.add_argument("--port", type=int, default=5173)
    p.add_argument("--after", help="create missing embed slides after this slide title")
    p.add_argument("--convert", action="store_true",
                   help="turn a non-embed slide with a matching title into an embed")
    p.add_argument("-t", "--template", default=str(TEMPLATE))
    p.set_defaults(func=cmd_open)
    p = sub.add_parser("agent", help="run one Codex figure agent (blocking)")
    p.add_argument("spec")
    p.add_argument("name")
    p.add_argument("--brief", required=True, help="the figure's own brief (.md)")
    p.add_argument("--model", default="gpt-6-sol")
    p.add_argument("--effort", default="high")
    p.set_defaults(func=cmd_agent)
    p = sub.add_parser("revise", help="send feedback to a finished agent (blocking)")
    p.add_argument("spec")
    p.add_argument("name")
    p.add_argument("--feedback", required=True, help="feedback .md")
    p.add_argument("--image", action="append", help="extra image to attach (repeatable)")
    p.add_argument("--fresh", action="store_true",
                   help="new session with the briefs + all feedback, instead of resuming "
                        "(cheaper after ~2 rounds, or when the direction changes)")
    p.add_argument("--model", default="gpt-6-sol")
    p.add_argument("--effort", default="high")
    p.set_defaults(func=cmd_revise)
    p = sub.add_parser("status", help="agents running, last saves, live slides")
    p.add_argument("spec")
    p.set_defaults(func=cmd_status)
    p = sub.add_parser("stop", help="kill one figure's running agent")
    p.add_argument("spec")
    p.add_argument("name")
    p.set_defaults(func=cmd_stop)
    p = sub.add_parser("stats", help="tokens, commands and failures per agent run")
    p.add_argument("spec")
    p.set_defaults(func=cmd_stats)
    p = sub.add_parser("close", help="bundle live figures back into the deck")
    p.add_argument("spec")
    p.add_argument("names", nargs="*", help="only these figures (default: all)")
    p.add_argument("-t", "--template", default=str(TEMPLATE))
    p.set_defaults(func=cmd_close)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
