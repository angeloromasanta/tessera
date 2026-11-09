"""Read and write the document block of a deck file, and find layouts by role.

A deck is one HTML file whose whole document is JSON in
`<script type="application/tessera+json" id="tessera-doc">`. Older decks carry
the block under its previous name (legacy.py); both are read. A write replaces
only the JSON between the tags, so the block keeps whichever name the file has
(a re-host onto a new shell is what renames it).

The JSON is compact and every '<' is written as \\u003c, so no '</script>' can
appear inside it and the block stays extractable with one regex.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import legacy

DOC_ID = "tessera-doc"
DOC_TYPE = "application/tessera+json"
FORMAT = "tessera/slides"                  # doc["format"] of a new deck
FORMATS = (FORMAT, legacy.FORMAT)          # what a reader accepts

_TYPES = "|".join(re.escape(t) for t in (DOC_TYPE, legacy.DOC_TYPE))
_IDS = "|".join(re.escape(i) for i in (DOC_ID, legacy.DOC_ID))

# group 1 = the opening tag, group 2 = the JSON, group 3 = the closing tag
DOC_RE = re.compile(rf'(<script\s+type="(?:{_TYPES})"\s+id="(?:{_IDS})">)(.*?)(</script>)', re.S)
# the opening tag alone (for a block whose JSON holds a raw '<')
OPEN_RE = re.compile(rf'<script\s+type="(?:{_TYPES})"\s+id="(?:{_IDS})">\s*')

LT = chr(92) + "u003c"


def backup(path, keep: int | None = None) -> Path | None:
    """Copy a deck file aside before a tool rewrites it: <deck folder>/build/backups/
    <name>.bak, rotating to .bak1, .bak2 (TESSERA_BACKUPS copies, default 3; 0
    turns them off). Out of the deck folder, so the deck sits alone beside its
    README. Returns the copy, or None when there was nothing to keep."""
    import os
    import shutil
    path = Path(path)
    if keep is None:
        import config
        try:
            keep = int(config.get("TESSERA_BACKUPS") or 3)
        except ValueError:
            keep = 3
    if keep <= 0 or not path.exists():
        return None
    folder = path.parent / "build" / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    baks = [folder / (path.name + (".bak" if i == 0 else f".bak{i}")) for i in range(keep)]
    for i in range(keep - 1, 0, -1):
        if baks[i - 1].exists():
            os.replace(baks[i - 1], baks[i])
    shutil.copy2(path, baks[0])
    return baks[0]


def encode(doc) -> str:
    """The block's JSON: compact, non-ASCII kept, every '<' escaped."""
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("<", LT)


def find(text: str):
    """The block's match (groups as DOC_RE) or None."""
    return DOC_RE.search(text)


def read(text: str) -> dict:
    """The document of a deck's HTML text. SystemExit when there is no block."""
    m = DOC_RE.search(text)
    if not m:
        raise SystemExit(f"no #{DOC_ID} block")
    return json.loads(m.group(2))


def load(path) -> dict:
    return read(Path(path).read_text(encoding="utf-8"))


# what a page built for the current shell reads; a shell from before the
# rename never sets these (it sets the legacy names), see old_shell_pages()
NEW_PAGE_GLOBAL = re.compile(r"\bTESSERA_(?:EMBED|STEPPED|STEPS|REFIT|GAME\w*)\b")


def is_old_shell_tag(open_tag: str) -> bool:
    """The block's opening tag (DOC_RE group 1) names the shell that wrote it:
    each shell saves under its own id, and upgrade-deck.mjs rewrites it."""
    return f'id="{legacy.DOC_ID}"' in open_tag


def embed_assets(doc) -> set:
    """The asset keys the embeds of `doc` show."""
    return {e.get("asset") for s in doc.get("slides", []) for e in s.get("elements", [])
            if e.get("type") == "embed" and e.get("asset")}


def old_shell_pages(doc, only=None) -> list[str]:
    """Embed-page assets of `doc` written for the current shell (they read the
    new globals and not the legacy one). In a shell from before the rename such
    a page gets no poll, texts or step keys and shows its sample state.
    `only`: limit to these asset keys."""
    assets = doc.get("assets", {})
    keys = embed_assets(doc)
    return sorted(k for k in keys if (only is None or k in only)
                  and isinstance(assets.get(k), str) and not assets[k].startswith("data:")
                  and NEW_PAGE_GLOBAL.search(assets[k]) and legacy.EMBED_GLOBAL not in assets[k])


def old_shell_message(name: str, keys) -> str:
    return (f"refused: {name} runs a shell from before the rename, which never hands a page "
            f"window.TESSERA_EMBED, so {', '.join(keys)} would show its sample state (no live "
            "poll, texts or step keys).\nRe-host the deck once, then re-run:\n"
            f"  node <tessera>/scripts/upgrade-deck.mjs \"{name if name.endswith('.html') else 'DECK.html'}\"\n"
            "An open deck is fine: wait for dirty=False in `slide.py ls`, re-host, then reload "
            "every tab of it (docs/guide/editing.md, \"A deck on an older shell\"). "
            "A template on the old shell makes every new deck old: re-host it too.")


def splice(text: str, doc) -> str:
    """`text` with its block's JSON replaced by `doc` (tags kept as they are).
    Refuses to put pages built for the current shell into an older shell."""
    m = DOC_RE.search(text)
    if not m:
        raise SystemExit(f"no #{DOC_ID} block")
    if is_old_shell_tag(m.group(1)):
        bad = old_shell_pages(doc)
        if bad:
            raise SystemExit(old_shell_message("this deck (or its template)", bad))
    return text[:m.start(2)] + encode(doc) + text[m.end(2):]


def unescaped(text: str):
    """(doc, start, end) when the block's JSON is whole but carries a raw '<'
    (DOC_RE stops at the first '</script>' inside a string), else None."""
    m = OPEN_RE.search(text)
    if not m:
        return None
    try:
        doc, end = json.JSONDecoder().raw_decode(text, m.end())
    except json.JSONDecodeError:
        return None
    if "<" not in text[m.end():end] or not text[end:].lstrip().startswith("</script>"):
        return None
    return doc, m.end(), end


# ─────────────────────────────────────────────────────────── layouts by role
#
# A template names its layouts after their role, either plainly (`points`) or
# with a prefix (`<brand>-points`). Tools ask for the role, so any template
# that follows that rule works without its name in the code.

def matches(ident: str, role: str) -> bool:
    return ident == role or ident.endswith("-" + role)


def layouts_of(doc_or_layouts) -> list:
    if isinstance(doc_or_layouts, dict):
        if "layouts" in doc_or_layouts and isinstance(doc_or_layouts["layouts"], list):
            return doc_or_layouts["layouts"]
        return list(doc_or_layouts.values())          # {id: layout}
    return list(doc_or_layouts or [])


def layout_for(doc_or_layouts, role: str):
    """The layout for a role (`points`, `title`, ...): id == role or ends with
    '-<role>'. An exact id wins; None when the template has none."""
    lays = layouts_of(doc_or_layouts)
    exact = next((l for l in lays if l.get("id") == role), None)
    return exact or next((l for l in lays if matches(str(l.get("id", "")), role)), None)


def layout_id(doc_or_layouts, role: str, default: str | None = None) -> str | None:
    lay = layout_for(doc_or_layouts, role)
    return lay["id"] if lay else default


def role_of(ident: str, roles) -> str | None:
    """The role an id plays, from a list of roles (longest match first)."""
    for r in sorted(roles, key=len, reverse=True):
        if matches(ident, r):
            return r
    return None


def slide_for(doc, role: str):
    """A template slide by role: id `sl-<role>` or ending '-<role>'."""
    slides = doc.get("slides", [])
    exact = next((s for s in slides if s.get("id") == "sl-" + role), None)
    return exact or next((s for s in slides if str(s.get("id", "")).endswith("-" + role)), None)


# ─────────────────────────────────────────────────────────── theme colours
#
# The ready-made pages (kit/engage, kit/figures) ship in the colours of
# template.html (template/palette.py). When a tool builds one into a deck it
# calls `recolor(html, deck)`, which swaps those shipped colours for the target
# deck's own, so the page follows the theme of the deck it lands in. It is a
# value-for-value swap (hex, rgb(), rgba()): the page keeps its size and its
# `:root` custom properties, only their values change.
#
# Where the deck's colours come from, in order:
#   1. doc["theme"]["tokens"]: a {token-name: hex} map the template declares
#      (names as in palette.TOKENS: ink, accent, navy, muted, ...); any token
#      it leaves out stays as shipped;
#   2. the theme is the shipped palette: nothing changes;
#   3. the theme's accent is one of the older family's (palette.RETOKEN keys):
#      that whole family comes back;
#   4. any other theme: ink and accent from theme.color / theme.accent, the
#      greys and tints mixed from them, the six hues from theme.chartPalette.

_PALETTE = None


def palette():
    """template/palette.py (the shipped colours), loaded by path."""
    global _PALETTE
    if _PALETTE is None:
        import importlib.util
        p = Path(__file__).resolve().parent.parent / "template" / "palette.py"
        spec = importlib.util.spec_from_file_location("tessera_palette", p)
        _PALETTE = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_PALETTE)
    return _PALETTE


def _norm(h):
    h = str(h or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", h):
        h = "#" + "".join(c * 2 for c in h[1:])
    return h.upper() if re.fullmatch(r"#[0-9a-fA-F]{6}", h) else ""


def _mix(a, b, t):
    """Hex colour t of the way from a to b."""
    ca, cb = (tuple(int(x[i:i + 2], 16) for i in (1, 3, 5)) for x in (a, b))
    return "#%02X%02X%02X" % tuple(round(p + (q - p) * t) for p, q in zip(ca, cb))


def theme_map(doc) -> dict:
    """{shipped hex (upper case): the deck's hex}, empty when the deck uses the shipped palette."""
    P = palette()
    theme = (doc or {}).get("theme") or {}
    ship = {k: v.upper() for k, v in P.HEX.items()}
    accent, ink = _norm(theme.get("accent")), _norm(theme.get("color"))
    tokens = {}
    if isinstance(theme.get("tokens"), dict):
        tokens = {k: _norm(v) for k, v in theme["tokens"].items() if k in ship and _norm(v)}
    if not tokens and accent and ink and not (accent == ship["accent"] and ink == ship["ink"]):
        if accent in P.RETOKEN:                                   # the older family, whole
            m = {}
            for old, new in P.RETOKEN.items():
                m.setdefault(new.upper(), old.upper())
            return {k: v for k, v in m.items() if k != v}
        chart = [_norm(c) for c in theme.get("chartPalette") or []]
        white = "#FFFFFF"
        tokens = {"ink": ink, "accent": accent, "navy": _mix(ink, "#000000", .3), "band": _mix(accent, "#000000", .15),
                  "muted": _mix(ink, white, .35), "faint": _mix(ink, white, .65), "line": _mix(ink, white, .78),
                  "rule": _mix(ink, white, .85), "edge": _mix(ink, white, .9), "tint": _mix(ink, white, .95),
                  "blue-tint": _mix(accent, white, .88)}
        if len(chart) >= 6 and all(chart[:6]):
            for name, c in zip(("sky", "coral", "violet", "green", "magenta", "amber"), chart):
                tokens[name] = c
                if name in ("coral", "green", "amber"):
                    tokens[name + "-text"] = _mix(c, "#000000", .3)
                    tokens[name + "-tint"] = _mix(c, white, .88)
    m = {}
    extra = {"violet": P.CHART[2], "magenta": P.CHART[4]}
    for name, target in tokens.items():
        src = (ship.get(name) if name not in extra else extra[name]).upper()
        if target != src:
            m[src] = target
    return m


def theme_tokens(doc) -> dict:
    """{token name: hex} for the deck: the shipped palette with the deck's colours put over it."""
    P = palette()
    m = theme_map(doc)
    return {k: m.get(v.upper(), v.upper()) for k, v in P.HEX.items()}


def recolor(html: str, doc_or_path=None) -> str:
    """`html` (a shipped page) in the colours of a deck: DOC_OR_PATH is the deck's
    doc, a deck/template file, or None for the configured template."""
    if doc_or_path is None:
        import config
        doc_or_path = config.template()
    doc = doc_or_path if isinstance(doc_or_path, dict) else load(doc_or_path)
    m = theme_map(doc)
    if not m:
        return html
    rx = re.compile("|".join(re.escape(k) for k in m) + r"(?![0-9A-Fa-f])", re.I)
    html = rx.sub(lambda g: m[g.group(0).upper()], html)
    rgb = {tuple(int(k[i:i + 2], 16) for i in (1, 3, 5)): tuple(int(v[i:i + 2], 16) for i in (1, 3, 5)) for k, v in m.items()}

    def swap(g):
        t = (int(g.group(1)), int(g.group(2)), int(g.group(3)))
        return g.group(0)[: g.group(0).index("(") + 1] + ",".join(map(str, rgb[t])) if t in rgb else g.group(0)
    return re.sub(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})", swap, html)


def ink(doc_or_path=None) -> str:
    """The deck's text colour (poll elements and the like)."""
    if doc_or_path is None:
        import config
        doc_or_path = config.template()
    doc = doc_or_path if isinstance(doc_or_path, dict) else load(doc_or_path)
    return theme_tokens(doc)["ink"]
