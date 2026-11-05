#!/usr/bin/env python3
"""kb.py - the infographics knowledge base.

The knowledge is an OKF v0.2 bundle (Google's Open Knowledge Format): one
concept per Markdown file under kit/figures/knowledge/ (or $TESSERA_KB), YAML
front matter with a `type`,
reviewed and versioned in git. Search is SQLite FTS5 (BM25, porter stemming),
built in memory on every call: the bundle is small, so there is no index file
to go stale, lock, or merge.

  kb.py search "zoom crowd highlight"       ranked entries: key, type, status, trust, snippet
  kb.py get pose camera-or-relayout          print entries (key = path without .md, or a unique stem)
  kb.py add Correction "the symptom, in the author's words" --cause "..." --fix "..."
  kb.py add Rule "Title" --description "..." --body-file rule.md --supersedes corrections/a,corrections/b
  kb.py retire corrections/2026-10-01-x --into recipes/pose     after writing its lesson into that entry
  kb.py verify corrections/2026-10-04-x      the author confirmed it: verified by human, status stable
                                             (--by human:<id> to name who)
  kb.py lint                                 conformance, broken links, near-duplicates, drafts to review
  kb.py index                                regenerate the index.md files (add/verify do it themselves)

Types and their folders: Recipe recipes/, Rule rules/, Correction corrections/,
Pitfall pitfalls/, Spec specs/, Example examples/.
"""
import argparse
import datetime as dt
import math
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

ROOT = Path(config.get("TESSERA_KB") or config.REPO / "kit" / "figures" / "knowledge").resolve()
FOLDERS = {"Recipe": "recipes", "Rule": "rules", "Correction": "corrections",
           "Pitfall": "pitfalls", "Spec": "specs", "Example": "examples"}
RESERVED = {"index.md", "log.md"}
ORDER = ["type", "title", "description", "tags", "status", "resource", "sources",
         "superseded_by", "not_duplicate_of", "stale_after", "generated", "verified"]
STOP = set("""a an and are as at be but by do does for from has have how i if in into is it
its not of on or so than that the then this to too was we what when where which who why
with without you your""".split())
FM = re.compile(r"\A---\r?\n(.*?)\r?\n---[ \t]*\r?\n?(.*)\Z", re.S)
LINK = re.compile(r"\]\((/?[^)\s#]+\.md)(?:#[^)]*)?\)")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------- the bundle

class Entry:
    def __init__(self, path):
        self.path = path
        self.key = path.relative_to(ROOT).with_suffix("").as_posix()
        text = path.read_text(encoding="utf-8")
        m = FM.match(text)
        self.ok = bool(m)
        self.meta = (yaml.safe_load(m.group(1)) or {}) if m else {}
        self.body = m.group(2) if m else text

    def __getattr__(self, name):          # meta fields as attributes, None if absent
        if name in ("meta", "path", "key", "body", "ok"):
            raise AttributeError(name)
        return self.meta.get(name)

    @property
    def tag_list(self):
        t = self.meta.get("tags") or []
        return [str(x) for x in (t if isinstance(t, list) else [t])]

    @property
    def state(self):
        return self.meta.get("status") or "stable"

    @property
    def trust(self):
        v = self.meta.get("verified") or []
        if any(str(x.get("by", "")).split(":")[0] == "human" for x in v if isinstance(x, dict)):
            return "human-reviewed"
        return "machine-confirmed" if v else "unverified"

    def save(self):
        meta = {k: self.meta[k] for k in ORDER if k in self.meta}
        meta.update({k: v for k, v in self.meta.items() if k not in meta})
        fm = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=1000)
        self.path.write_text(f"---\n{fm}---\n\n{self.body.lstrip()}", encoding="utf-8")


def entries():
    out = []
    for p in sorted(ROOT.rglob("*.md")):
        if p.name in RESERVED or any(part.startswith(".") for part in p.relative_to(ROOT).parts):
            continue
        out.append(Entry(p))
    return out


def resolve(es, key):
    key = key.strip().removesuffix(".md").lstrip("/")
    hits = [e for e in es if e.key == key] or \
           [e for e in es if e.key.endswith("/" + key)] or \
           [e for e in es if key in e.key]
    if len(hits) != 1:
        names = ", ".join(e.key for e in hits[:8]) or "nothing"
        sys.exit(f"kb: '{key}' matches {names}. Use `kb.py search` for the key.")
    return hits[0]


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today():
    return dt.date.today().isoformat()


def slug(text, n=6):
    words = [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP]
    return "-".join(words[:n]) or "entry"


# ---------------------------------------------------------------- search

def fts(es):
    db = sqlite3.connect(":memory:")
    db.execute("create virtual table kb using fts5(key UNINDEXED, type UNINDEXED, "
               "status UNINDEXED, title, tags, description, body, "
               "tokenize='porter unicode61')")
    db.executemany("insert into kb(rowid, key, type, status, title, tags, description, body) "
                   "values (?,?,?,?,?,?,?,?)",
                   [(i, e.key, str(e.type or ""), e.state, str(e.title or ""),
                     " ".join(e.tag_list), str(e.description or ""), e.body)
                    for i, e in enumerate(es)])
    return db


def terms(q):
    return [w for w in re.findall(r"\w+", q.lower()) if w not in STOP]


def query(es, q, n=6, types=None, include_all=False, exclude=None):
    """AND of the words first; topped up with OR so a long query still finds something."""
    ws = terms(q)
    if not ws:
        return []
    db = fts(es)
    sql = ("select rowid, bm25(kb, 0, 0, 0, 10, 5, 4, 1), "
           "snippet(kb, 6, '[', ']', ' ... ', 16) from kb where kb match ?")
    seen, out = set(), []
    for op in (" AND ", " OR "):
        match = op.join(f'"{w}"' for w in ws)
        for rid, score, snip in db.execute(sql + " order by 2", (match,)):
            e = es[rid]
            if rid in seen or e.key == exclude:
                continue
            if not include_all and e.state == "deprecated":
                continue
            if types and str(e.type).lower() not in types:
                continue
            seen.add(rid)
            out.append((e, score, snip))
        if len(out) >= n:
            break
    return out[:n]


def show_hits(hits):
    for e, _, snip in hits:
        flag = "" if e.state == "stable" else f" {e.state.upper()}"
        print(f"{e.key}  ({e.type}{flag}, {e.trust})")
        print(f"    {e.title}")
        if e.description:
            print(f"    {e.description}")
        snip = " ".join(snip.split())
        if snip:
            print(f"    > {snip}")
        if e.superseded_by:
            print(f"    superseded by {e.superseded_by}")


def cmd_search(a):
    es = entries()
    types = {t.lower() for t in a.type.split(",")} if a.type else None
    hits = query(es, " ".join(a.query), a.n, types, a.all)
    if not hits:
        print("no entry matches; nobody has written this down yet. "
              "If you work it out, record it with `kb.py add`.")
        return
    show_hits(hits)
    print("\n`kb.py get KEY` prints an entry in full.")


def cmd_get(a):
    es = entries()
    for i, k in enumerate(a.keys):
        e = resolve(es, k)
        if i:
            print("\n" + "=" * 72 + "\n")
        print(f"# {e.key}  ({e.type}, {e.state}, {e.trust})\n")
        print(e.path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- writing

def append_log(lines):
    log = ROOT / "log.md"
    text = log.read_text(encoding="utf-8") if log.exists() else "# Log\n\nNewest first.\n"
    head = f"## {today()}"
    add = "".join(f"- {l}\n" for l in lines)
    if head in text:
        text = text.replace(head + "\n", head + "\n" + add, 1)
    else:
        m = re.search(r"^## ", text, re.M)
        block = f"{head}\n{add}\n"
        text = text[:m.start()] + block + text[m.start():] if m else text.rstrip() + "\n\n" + block
    log.write_text(text, encoding="utf-8")


def cmd_add(a):
    es = entries()
    typ = next((t for t in FOLDERS if t.lower() == a.type.lower()), None)
    if not typ:
        sys.exit(f"kb: type must be one of {', '.join(FOLDERS)}")
    if a.body_file == "-":
        body = sys.stdin.read()
    elif a.body_file:
        body = Path(a.body_file).read_text(encoding="utf-8")
    elif a.cause or a.fix:
        body = f"**Cause:** {a.cause or '?'}\n\n**Fix:** {a.fix or '?'}\n"
    else:
        sys.exit("kb: give the body: --body-file FILE (- for stdin), or --cause/--fix")
    if typ == "Correction" and not (a.cause and a.fix) and "**Fix:**" not in body:
        sys.exit("kb: a Correction needs a cause and a fix")

    key = a.key or f"{FOLDERS[typ]}/" + (f"{today()}-{slug(a.title)}" if typ == "Correction" else slug(a.title))
    path = ROOT / f"{key}.md"
    if path.exists():
        sys.exit(f"kb: {key} exists. Edit that file instead (it is plain Markdown), "
                 f"or pass --key for a new one.")

    similar = query(es, f"{a.title} {a.description or ''} {' '.join(a.tags or [])}", 3)
    if similar:
        print("Similar entries already exist. If one says the same thing, edit it, or")
        print("supersede it with a Rule (`--supersedes`), instead of adding a near-copy:")
        for e, _, _ in similar:
            print(f"    {e.key}: {e.title}")
        print()

    meta = {"type": typ, "title": a.title}
    if a.description:
        meta["description"] = a.description
    if a.tags:
        meta["tags"] = a.tags
    meta["status"] = a.status or ("draft" if typ == "Correction" else "stable")
    if a.resource:
        meta["resource"] = a.resource
    sup = [resolve(es, k) for k in (a.supersedes or [])]
    srcs = [{"resource": s} for s in (a.sources or [])] + [{"resource": f"/{e.key}.md"} for e in sup]
    if srcs:
        meta["sources"] = srcs
    meta["generated"] = {"by": a.by, "at": now()}

    path.parent.mkdir(parents=True, exist_ok=True)
    new = Entry.__new__(Entry)
    new.path, new.key, new.meta, new.body, new.ok = path, key, meta, body, True
    new.save()
    log = [f"added [{a.title}](/{key}.md) ({typ}, {meta['status']}) by {a.by}"]
    for e in sup:
        e.meta["status"] = "deprecated"
        e.meta["superseded_by"] = f"/{key}.md"
        e.save()
        log.append(f"deprecated [{e.title}](/{e.key}.md): superseded by /{key}.md")
    append_log(log)
    build_index()
    print(f"wrote knowledge/{key}.md" + (f"; deprecated {len(sup)}" if sup else ""))


def cmd_retire(a):
    es = entries()
    e, into = resolve(es, a.key), resolve(es, a.into)
    e.meta["status"] = "deprecated"
    e.meta["superseded_by"] = f"/{into.key}.md"
    e.save()
    srcs = into.meta.get("sources") or []
    if not any(isinstance(s, dict) and s.get("resource") == f"/{e.key}.md" for s in srcs):
        into.meta["sources"] = srcs + [{"resource": f"/{e.key}.md"}]
    into.meta["generated"] = {"by": a.by, "at": now()}
    into.save()
    append_log([f"folded [{e.title}](/{e.key}.md) into [{into.title}](/{into.key}.md) by {a.by}"])
    build_index()
    print(f"{e.key} -> deprecated, superseded by {into.key}")


def cmd_verify(a):
    es = entries()
    e = resolve(es, a.key)
    v = e.meta.get("verified") or []
    v.append({"by": a.by, "at": now()})
    e.meta["verified"] = v
    if e.state == "draft":
        e.meta["status"] = "stable"
    e.save()
    append_log([f"verified [{e.title}](/{e.key}.md) by {a.by}"])
    build_index()
    print(f"{e.key}: {e.trust}, {e.state}")


# ---------------------------------------------------------------- index.md

INTRO = """# figure knowledge

What earlier figures taught: mark code worth copying, house rules, the
corrections the author asked for, harness pitfalls, the spec forms and the worked
examples. One concept per file ([OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format)).

Find before you derive: `python $T/kb.py search "<topic>"` (`$T` is the
checkout's `tools/`),
then `kb.py get KEY`. Learn after a second round: `kb.py add Correction ...`.
Two entries saying the same thing become one Rule (`--supersedes`). The
workflow (add, verify, lint, retire, supersede) is in the authoring guide,
`docs/guide/figures.md`, "The knowledge base".
This file and the folder indexes are generated by `kb.py index`; edit the entries.
"""


def build_index():
    es = entries()
    by = {}
    for e in es:
        by.setdefault(e.key.split("/")[0] if "/" in e.key else ".", []).append(e)
    rows = []
    for folder, group in sorted(by.items()):
        live = [e for e in group if e.state != "deprecated"]
        old = [e for e in group if e.state == "deprecated"]
        lines = [f"# {folder}\n"]
        lines += [f"- [{e.title}](/{e.key}.md){' (draft)' if e.state == 'draft' else ''}"
                  f"{' - ' + str(e.description) if e.description else ''}" for e in live]
        if old:
            lines += ["", "## Superseded", ""]
            lines += [f"- [{e.title}](/{e.key}.md) -> {e.superseded_by}" for e in old]
        if folder != ".":
            (ROOT / folder / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        types = sorted({str(e.type) for e in group})
        rows.append(f"| [{folder}/](/{folder}/index.md) | {', '.join(types)} | {len(live)} |"
                    + (f" {len(old)} superseded" if old else ""))
    table = "| folder | type | entries |\n|---|---|---|\n" + "\n".join(rows)
    (ROOT / "index.md").write_text(f'---\nokf_version: "0.2"\n---\n\n{INTRO}\n{table}\n',
                                   encoding="utf-8")


def cmd_index(a):
    build_index()
    print("index.md regenerated")


# ---------------------------------------------------------------- lint

def vec(e):
    text = f"{e.title} {e.title} {e.description or ''} {' '.join(e.tag_list)} {e.body}"
    ws = [w.rstrip("s") for w in re.findall(r"[a-z][a-z0-9]+", text.lower())
          if w not in STOP and len(w) > 2]
    return Counter(ws)


def cosine(a, b):
    dot = sum(a[k] * b[k] for k in a if k in b)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def cmd_lint(a):
    es = entries()
    errors, warns = [], []
    keys = {e.key for e in es}
    for e in es:
        if not e.ok:
            errors.append(f"{e.key}: no YAML front matter (OKF: every concept file needs one)")
            continue
        if not str(e.type or "").strip():
            errors.append(f"{e.key}: empty `type` (the one field OKF requires)")
        folder = FOLDERS.get(str(e.type))
        if folder and not e.key.startswith(folder + "/"):
            warns.append(f"{e.key}: a {e.type} belongs in {folder}/")
        if not e.title or not e.description:
            warns.append(f"{e.key}: missing title or description (search ranks on them)")
        if e.state not in ("draft", "stable", "deprecated"):
            warns.append(f"{e.key}: status '{e.state}' is not draft|stable|deprecated")
        if e.stale_after and str(e.stale_after) < today():
            warns.append(f"{e.key}: stale since {e.stale_after}: re-check it or deprecate it")
        for link in LINK.findall(e.body):
            target = link.lstrip("/").removesuffix(".md") if link.startswith("/") else \
                (e.path.parent / link).resolve().relative_to(ROOT.resolve()).with_suffix("").as_posix()
            if target not in keys and not (ROOT / f"{target}.md").exists():
                warns.append(f"{e.key}: broken link {link}")
        res = e.resource
        if isinstance(res, str) and not res.startswith(("http", "/")):
            if not (e.path.parent / res).exists():
                warns.append(f"{e.key}: resource {res} does not exist")

    live = [e for e in es if e.ok and e.state != "deprecated"]
    vs = {e.key: vec(e) for e in live}
    pairs = []
    for i, x in enumerate(live):
        for y in live[i + 1:]:
            if "Correction" not in (x.type, y.type):
                continue
            if y.key in (x.not_duplicate_of or []) or x.key in (y.not_duplicate_of or []):
                continue
            s = cosine(vs[x.key], vs[y.key])
            if s >= a.dup:
                pairs.append((s, x.key, y.key))
    for s, x, y in sorted(pairs, reverse=True):
        warns.append(f"near-duplicate ({s:.2f}): {x} ~ {y}. Same lesson: fold it in and "
                     f"`retire`, or one Rule with --supersedes. Different: list the other key "
                     f"under `not_duplicate_of:` in the correction")

    drafts = [e.key for e in live if e.state == "draft"]
    corr = [e for e in live if e.type == "Correction"]
    for e in errors:
        print("ERROR", e)
    for w in warns:
        print("warn ", w)
    if drafts:
        print(f"draft {len(drafts)} to review with the author (`kb.py verify KEY`): " + ", ".join(drafts))
    if len(corr) > 10:
        print(f"note  {len(corr)} live corrections: consolidate the ones that share a cause into Rules")
    print(f"{len(es)} entries, {len(errors)} errors, {len(warns)} warnings")
    sys.exit(1 if errors else 0)


# ---------------------------------------------------------------- cli

def csv(s):
    return [x.strip() for x in s.split(",") if x.strip()]


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog=__doc__.split("\n\n", 1)[1])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="ranked entries for a topic")
    s.add_argument("query", nargs="+")
    s.add_argument("-n", type=int, default=6)
    s.add_argument("-t", "--type", help="only these types, comma-separated")
    s.add_argument("--all", action="store_true", help="include deprecated entries")
    s.set_defaults(fn=cmd_search)

    g = sub.add_parser("get", help="print entries in full")
    g.add_argument("keys", nargs="+")
    g.set_defaults(fn=cmd_get)

    d = sub.add_parser("add", help="record a new entry")
    d.add_argument("type", help="|".join(FOLDERS))
    d.add_argument("title", help="for a Correction: the symptom, in the words it was reported")
    d.add_argument("--description", help="one sentence; search weighs it")
    d.add_argument("--tags", type=csv)
    d.add_argument("--cause")
    d.add_argument("--fix")
    d.add_argument("--body-file", help="Markdown body; - for stdin")
    d.add_argument("--key", help="path without .md (default: folder/slug)")
    d.add_argument("--resource", help="the artifact the entry is about")
    d.add_argument("--sources", type=csv, help="what it derives from (deck, file, URL)")
    d.add_argument("--supersedes", type=csv, help="keys this entry replaces; they become deprecated")
    d.add_argument("--status", choices=["draft", "stable"])
    d.add_argument("--by", default=os.environ.get("KB_ACTOR", "claude-code/agent"),
                   help="OKF actor: <producer>/<version>, human:<id> or process:<id>")
    d.set_defaults(fn=cmd_add)

    r = sub.add_parser("retire", help="after folding a lesson into another entry, deprecate it")
    r.add_argument("key")
    r.add_argument("--into", required=True, help="the entry that now carries the lesson")
    r.add_argument("--by", default=os.environ.get("KB_ACTOR", "claude-code/agent"))
    r.set_defaults(fn=cmd_retire)

    v = sub.add_parser("verify", help="record a review; a draft becomes stable")
    v.add_argument("key")
    v.add_argument("--by", default="human", help="who reviewed it: human or human:<id>")
    v.set_defaults(fn=cmd_verify)

    l = sub.add_parser("lint", help="conformance, links, near-duplicates, drafts")
    l.add_argument("--dup", type=float, default=0.35, help="cosine threshold for near-duplicates")
    l.set_defaults(fn=cmd_lint)

    i = sub.add_parser("index", help="regenerate index.md files")
    i.set_defaults(fn=cmd_index)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
