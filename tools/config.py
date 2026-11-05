"""Settings for every tool: one `.env`, real environment variables first.

The `.env` is found by walking up from the current directory, then from this
folder (so a workspace that nests the checkout can keep its own `.env` above
it). A variable already set in the environment is never overridden. Values are
read with `get(KEY)`; the defaults below apply when a key is set nowhere.

Keys:
    TESSERA_TEMPLATE      the template new decks start from (default: template.html in the checkout)
    TESSERA_DECKS         the folder that holds the decks (default: decks)
    TESSERA_POLL_SERVICE  the poll service a new deck uses (https://join.<sub>.workers.dev)
    TESSERA_LECTURER_KEY  the poll service's lecturer key (also read from LECTURER_KEY); never printed
    OPENROUTER_API_KEY    image generation (image_gen.py)
    TESSERA_CF_SUBDOMAIN  the <sub> of <sub>.workers.dev, for published links
    TESSERA_LIVE_URL      the public address of the live mirror (optional)
    TESSERA_LIVE_LOCAL    the address the mirror server listens on (default http://127.0.0.1:8000)
    TESSERA_AUTHOR        the name written as the author of requests and decks (default: none)
"""
from __future__ import annotations

import os
from pathlib import Path

import legacy

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent                       # the engine checkout

DEFAULTS = {
    "TESSERA_TEMPLATE": str(REPO / "template.html"),
    "TESSERA_DECKS": "decks",
    "TESSERA_LIVE_LOCAL": "http://127.0.0.1:8000",
}

_loaded: list[Path] = []


def _parse(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:]
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def find_env(start: Path) -> Path | None:
    for d in [start, *start.parents]:
        f = d / ".env"
        if f.is_file():
            return f
    return None


def load() -> list[Path]:
    """Read the `.env` files once (idempotent). Returns the files read."""
    if _loaded:
        return _loaded
    for start in (Path.cwd().resolve(), TOOLS):
        f = find_env(start)
        if f and f not in _loaded:
            _loaded.append(f)
            for k, v in _parse(f).items():
                os.environ.setdefault(k, v)
    if not _loaded:
        _loaded.append(Path())  # nothing found: remember that we looked
    return _loaded


def env_file() -> Path | None:
    """The `.env` the settings came from first (None when there is none)."""
    load()
    return next((f for f in _loaded if f.name == ".env"), None)


def get(key: str, default: str | None = None) -> str:
    """A setting: the environment (after `.env`), then its old name, then the default."""
    load()
    v = os.environ.get(key)
    if not v and key in legacy.ENV:
        v = os.environ.get(legacy.ENV[key])
    if not v and key == "TESSERA_LECTURER_KEY":
        v = os.environ.get("LECTURER_KEY")
    if not v:
        v = default if default is not None else DEFAULTS.get(key, "")
    return v or ""


def flag(key: str) -> bool:
    """A yes/no setting (TESSERA_NO_LIVE=1 and the like)."""
    return get(key) not in ("", "0", "false", "no")


def template() -> Path:
    return Path(get("TESSERA_TEMPLATE")).expanduser()


def decks_dir() -> Path:
    """The deck folder; a relative TESSERA_DECKS is taken from the `.env`'s folder
    (or the current directory when there is no `.env`)."""
    p = Path(get("TESSERA_DECKS")).expanduser()
    if p.is_absolute():
        return p
    f = env_file()
    return ((f.parent if f else Path.cwd()) / p).resolve()


def shell() -> Path:
    """The player shell the engine build writes (slides/dist-single/)."""
    d = REPO / "slides" / "dist-single"
    new = d / "tessera.html"
    old = d / legacy.SHELL_NAME
    return new if new.is_file() or not old.is_file() else old


def live_local() -> str:
    return get("TESSERA_LIVE_LOCAL").rstrip("/")


def live_url() -> str:
    """The public base of the live mirror, else the local one."""
    return (get("TESSERA_LIVE_URL") or live_local()).rstrip("/")


def workers_host(name: str) -> str | None:
    sub = get("TESSERA_CF_SUBDOMAIN")
    return f"https://{name}.{sub}.workers.dev" if sub else None


USER_AGENT = "tessera-tools/1.0"  # Cloudflare refuses Python's default user agent (error 1010)


def lecturer_headers(key: str) -> dict[str, str]:
    """The lecturer key as the poll service reads it (both header names)."""
    return {"x-tessera-lecturer": key, legacy.LECTURER_HEADER: key} if key else {}
