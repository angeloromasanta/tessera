"""Land slides in a spec-built deck, now: edit the spec, compile, and put the
result in front of the presenter: the open editor if the deck is open, else the file
(post-compile steps, checks, and confirmation that the live link moved).

    python tools/land.py decks/<deck>/<deck>.md --replace ID BLOCK.md   # swap one block
    python tools/land.py decks/<deck>/<deck>.md --after ID BLOCK.md      # insert a block
    python tools/land.py decks/<deck>/<deck>.md --delete ID [ID ...]
    python tools/land.py decks/<deck>/<deck>.md --ops OPS.json           # several at once
    python tools/land.py decks/<deck>/<deck>.md                          # just rebuild + check
    python tools/land.py decks/<deck>/<deck>.md --slides ID [ID ...]     # land blocks edited by hand

OPS.json: [{"op": "replace"|"after"|"delete"|"append", "id": ..., "block": "..."}].
A block is the spec text from its leading `<!-- -->` comment through its fields.

Deck OPEN in the editor (asked of the bridge, like slide.py): only the changed
slides land, as slide.py patches (compiled into build/land/, the changed
slides diffed against the editor's, pushed). Every other slide, the docId and
the join code stay as they are; requests, figure texts and poll codes already
on a replaced slide are kept. Each landed block needs an `id:`. Post-compile
steps are not re-run (their slides are already in the deck).

Deck CLOSED: the whole deck is compiled into build/land/, post-compile steps
and checks run there, and the result replaces the file under the deck lock
(keeping its docId and any request typed meanwhile). Refused while
build/<deck>.html.live-source.json exists: reconcile the live edits first.

The spec is locked (build/.<spec>.lock) for the whole run, so parallel lands
queue instead of losing each other's spec edits.

Post-compile steps (slides the spec cannot express: a guess slide, an activity
added by a script) are listed in `<deck folder>/postcompile.json`, or in
`<spec stem>.postcompile.json` beside the spec when one folder holds several decks:
    {"steps": ["python tools/make_guess.py decks/X/build/guess.json --deck {deck}"],
     "require": ["g-city"]}
`{deck}` is the compiled HTML. `require` lists slide ids that must exist after.
Steps run from the folder of the `.env` (else the current directory).

Run it after EACH finished slide: the presenter watches the editor or the live
link; a slide waiting in build/ is not done.
"""
import argparse, copy, json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

T = Path(__file__).resolve().parent
sys.path.insert(0, str(T))
import config  # noqa: E402
import slide as S  # noqa: E402
import md_to_deck as M  # noqa: E402

# where post-compile steps run: the workspace that holds the .env
ROOT = config.env_file().parent if config.env_file() else Path.cwd()
PREVIEW = T / "live" / "decks.json"


def blocks_of(text):
    lines = text.split("\n")
    starts = [i for i, l in enumerate(lines) if l.startswith("## ")]
    if not starts:
        sys.exit("land: no '## ' blocks in the spec")

    def lead(i):
        j = i
        while j > 0 and (lines[j-1].startswith("<!--") or not lines[j-1].strip()):
            j -= 1
        while not lines[j].strip():
            j += 1
        return j
    bounds = [lead(i) for i in starts]
    head = "\n".join(lines[:bounds[0]]).rstrip("\n")
    out = []
    for k, b in enumerate(bounds):
        e = bounds[k+1] if k+1 < len(bounds) else len(lines)
        txt = "\n".join(lines[b:e]).strip("\n")
        m = re.search(r"^id: (\S+)", txt, re.M)
        out.append([m.group(1) if m else None, txt])
    return head, out


def apply_ops(spec: Path, ops):
    """Edit the spec. Returns [(old block text | None, new block text | None)]."""
    head, blocks = blocks_of(spec.read_text(encoding="utf-8"))
    changes = []

    def find(i):
        for n, (bid, _) in enumerate(blocks):
            if bid == i:
                return n
        sys.exit(f"land: no block with id {i}")
    for o in ops:
        op, blk = o["op"], o.get("block", "").strip("\n")
        if op == "replace":
            n = find(o["id"])
            changes.append((blocks[n][1], blk))
            blocks[n][1] = blk
        elif op == "delete":
            n = find(o["id"])
            changes.append((blocks[n][1], None))
            del blocks[n]
        elif op == "after":
            blocks.insert(find(o["id"]) + 1, [None, blk])
            changes.append((None, blk))
        elif op == "append":
            blocks.append([None, blk])
            changes.append((None, blk))
        else:
            sys.exit(f"land: unknown op {op}")
    spec.write_text(head + "\n\n" + "\n\n".join(t for _, t in blocks) + "\n", encoding="utf-8", newline="\n")
    return changes


def ids_of(block):
    """The slide ids one spec block compiles to (a `steps:` block makes several)."""
    return [f.get("id") or None for s in M.parse_spec(block)[1] for f in M.expand_steps(s)]


def run(cmd, show=1, fatal=True):
    for attempt in range(3):
        r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
        # Windows: the live-link server or a screenshot can hold the deck for a moment
        if not (r.returncode and "PermissionError" in r.stdout + r.stderr):
            break
        time.sleep(3)
    out = (r.stdout + r.stderr).strip().splitlines()
    for l in (out[-show:] if show else []):
        print("  " + l)
    if r.returncode and fatal:
        sys.exit(f"land: failed: {cmd}")
    return "\n".join(out)


def read_doc(path: Path):
    return json.loads(M.DOC_RE.search(path.read_text(encoding="utf-8")).group(2))


def editor_for(deck: Path):
    """The open editor holding this deck (a slide.LiveDeck), or None. Asks the
    bridge, so a deck opened but not yet edited counts as open."""
    if config.flag("TESSERA_NO_LIVE"):
        return None
    return S.live_for_file(deck)


def mirror_slug(deck: Path):
    try:
        decks = json.loads(PREVIEW.read_text(encoding="utf-8")).get("decks", {})
    except (OSError, ValueError):
        return None
    for slug, p in decks.items():
        if Path(p).resolve() == deck.resolve():
            return slug


def version(slug):
    try:
        with urllib.request.urlopen(f"{config.live_local()}/deck/{slug}/version", timeout=5) as r:
            return r.read().decode()
    except OSError:
        return None


def keep_live(new, old):
    """What the open slide holds that the spec does not: its comments (requests),
    figure texts retyped in the editor, and poll codes (answers live there)."""
    if old.get("comments"):
        new["comments"] = copy.deepcopy(old["comments"])
    olds = {e["id"]: e for e in old.get("elements", [])}
    for e in new.get("elements", []):
        o = olds.get(e["id"])
        if not o or o.get("type") != e.get("type"):
            continue
        if e["type"] == "embed" and o.get("texts"):
            e["texts"] = {**o["texts"], **(e.get("texts") or {})}
        if e["type"] == "poll" and o.get("code"):
            e["code"] = o["code"]


def land_patches(live_doc, new_doc, land, gone):
    """slide.py patches that make the open deck's `land` slides match the
    compile and remove `gone`, touching nothing else."""
    new_by = {s["id"]: s for s in new_doc["slides"]}
    order = [s["id"] for s in new_doc["slides"]]
    lost = [i for i in land if i not in new_by]
    if lost:
        sys.exit(f"land: the compile has no slide {lost} (a duplicate id renamed?)")
    target = [s for s in live_doc["slides"] if s["id"] not in gone or s["id"] in land]
    for i in sorted(land, key=order.index):
        ns = copy.deepcopy(new_by[i])
        at = next((n for n, s in enumerate(target) if s["id"] == i), None)
        if at is not None:
            keep_live(ns, target[at])
            target[at] = ns
            continue
        prev = [p for p in reversed(order[:order.index(i)]) if any(s["id"] == p for s in target)]
        pos = next(n for n, s in enumerate(target) if s["id"] == prev[0]) + 1 if prev else 0
        target.insert(pos, ns)
    live_assets = live_doc.get("assets") or {}
    want = {k: v for k, v in (new_doc.get("assets") or {}).items()
            if k in S.asset_refs([s for s in target if s["id"] in land]) and live_assets.get(k) != v}
    before = {"slides": live_doc["slides"], "assets": {k: live_assets[k] for k in want if k in live_assets}}
    return S.diff(before, {"slides": target, "assets": want})


def land_open(ed, tmp, land, gone, agent):
    new_doc = read_doc(tmp)
    for attempt in range(3):
        patches = land_patches(ed.doc, new_doc, land, gone)
        if not patches:
            print("editor: already up to date")
            return
        try:
            ed.apply(patches, agent, structure=True)
            break
        except S.Conflict as e:  # someone changed the same slide meanwhile: re-read, redo
            print(f"  conflict ({e}); re-reading the editor")
            ed.refresh()
    else:
        sys.exit("land: kept conflicting with edits in the editor; land again")
    S._log(ed, agent, patches)
    ed.refresh()
    print(f"editor: landed {', '.join(sorted(land)) or '-'}"
          + (f"; removed {', '.join(sorted(gone - set(land)))}" if gone - set(land) else "")
          + f" ({len(patches)} patch(es), as {agent})")


def install(tmp: Path, deck: Path):
    """Replace the closed deck with the compile, under the deck lock, keeping
    its docId and any request typed into the file since the compile started."""
    with S.deck_lock(deck):
        doc = read_doc(tmp)
        M._carry_over(doc, deck)
        text = tmp.read_text(encoding="utf-8")
        m = M.DOC_RE.search(text)
        payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("<", chr(92) + "u003c")
        out = text[:m.start(2)] + payload + text[m.end(2):]
        if deck.exists():
            S._rotate_bak(deck)
        part = deck.with_suffix(".land.tmp")
        part.write_text(out, encoding="utf-8")
        read_doc(part)
        os.replace(part, deck)
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("--replace", nargs=2, metavar=("ID", "BLOCK"))
    ap.add_argument("--after", nargs=2, metavar=("ID", "BLOCK"))
    ap.add_argument("--delete", nargs="+", metavar="ID")
    ap.add_argument("--ops")
    ap.add_argument("--slides", nargs="+", metavar="ID", default=[],
                    help="open deck: also land these slides (spec blocks you edited by hand)")
    ap.add_argument("--agent", default=config.get("TESSERA_AGENT") or "land",
                    help="name shown in the editor (default: land)")
    ap.add_argument("-o", "--out", help="compiled deck (default: the spec's .html)")
    a = ap.parse_args()
    spec = Path(a.spec).resolve()
    deck = Path(a.out).resolve() if a.out else spec.with_suffix(".html")
    ops = []
    if a.ops:
        ops += json.loads(Path(a.ops).read_text(encoding="utf-8"))
    if a.replace:
        ops.append({"op": "replace", "id": a.replace[0], "block": Path(a.replace[1]).read_text(encoding="utf-8")})
    if a.after:
        ops.append({"op": "after", "id": a.after[0], "block": Path(a.after[1]).read_text(encoding="utf-8")})
    for i in a.delete or []:
        ops.append({"op": "delete", "id": i})

    ed = editor_for(deck)
    guard = deck.parent / "build" / (deck.name + ".live-source.json")
    if not ed and guard.exists():
        sys.exit("land: the deck holds live edits not yet in the spec (live-source guard) and is not open: "
                 "reconcile them into the spec, then `agent_live.py reconcile DECK --acknowledge`; "
                 "or open the deck and land again (only the changed slides go in).")
    if ed:
        if any(None in ids_of(o["block"]) for o in ops if o.get("block")):
            sys.exit("land: the deck is open, so each landed block needs an `id:` line")
        print(f"deck is open in the editor (session {ed.sid[:8]}): landing only the changed slides")
    slug = mirror_slug(deck)
    before = version(slug) if slug else None
    work = deck.parent / "build" / "land"
    tmp = work / deck.name

    with S.deck_lock(spec, wait=900, stale=900):  # one land at a time per spec
        land, gone = list(a.slides), set()
        if ops:
            for old, new in apply_ops(spec, ops):
                new_ids = ids_of(new) if new else []
                land += new_ids
                gone |= set(ids_of(old) if old else []) - set(new_ids)
            print(f"spec: {len(ops)} change(s)")
        if ed and not land and not gone:
            sys.exit("land: the deck is open and nothing names a slide: pass --slides ID … "
                     "(a whole recompile would overwrite the live deck)")
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        run(f'python "{T/"md_to_deck.py"}" --check "{spec}"', 3, fatal=False)  # warnings only
        carry = "" if ed else f' --carry-from "{deck}"'
        run(f'python "{T/"md_to_deck.py"}" "{spec}" -o "{tmp}"{carry}')
        # A folder holding several decks gives each its own <spec stem>.postcompile.json.
        cfg_path = spec.with_suffix(".postcompile.json")
        if not cfg_path.exists():
            cfg_path = spec.parent / "postcompile.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        if ed:
            land_open(ed, tmp, set(land), gone, a.agent)
            doc = ed.doc
        else:
            run(f'node "{config.REPO / "scripts" / "stamp-agent-notes.mjs"}" "{tmp}"')
            for step in cfg.get("steps", []):
                run(step.replace("{deck}", str(tmp)))
            missing = [i for i in cfg.get("require", []) if i not in {s["id"] for s in read_doc(tmp)["slides"]}]
            if missing:
                sys.exit(f"land: slides missing after post-compile: {missing} (the deck is unchanged)")
            doc = install(tmp, deck)
        shutil.rmtree(work, ignore_errors=True)

    ids = [s["id"] for s in doc["slides"]]
    missing = [i for i in cfg.get("require", []) if i not in ids]
    if missing:
        print(f"  ! slides missing: {missing}")
    run(f'python "{T/"slide.py"}" doctor "{deck}"', 2, fatal=False)  # prints its findings
    still = [s["id"] for s in doc["slides"] for e in s.get("elements", [])
             if e.get("type") == "embed" and e.get("asset") and not e.get("liveInEditor")]
    if still:
        print(f"  ! these figures show only their poster in the editor/live link: {still}")
    print(f"deck: {len(ids)} slides" + (" (open editor)" if ed else f", docId {str(doc.get('docId'))[:8]}"))
    if slug:
        for _ in range(10):
            after = version(slug)
            if after and after != before:
                print(f"live link updated: {config.live_url()}/deck/{slug}")
                break
            time.sleep(1)
        else:
            print(f"  ! live link /deck/{slug} did not move (is the mirror running? start it: python tools/live/serve.py)")


if __name__ == "__main__":
    main()
