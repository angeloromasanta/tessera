#!/usr/bin/env python3
"""Publish a file or folder to Cloudflare (Workers static assets), and take it down again.

    python tools/cf_upload.py up FILE|FOLDER [--name SLUG] [--force] [--dry-run]
    python tools/cf_upload.py ls                       what this tool published
    python tools/cf_upload.py rm NAME|PATH ... | --all [--force]
    python tools/cf_upload.py prune --days N           remove everything not updated in N days
    python tools/cf_upload.py whoami                   check the Cloudflare login

One Worker per upload, served at https://<name>.<subdomain>.workers.dev, so a
removal is one `wrangler delete` and leaves nothing behind. Uploading the same
name again redeploys in place: same URL. Needs only Node (wrangler runs through
`npx`) and a one-time `npx wrangler login`; for unattended use put
CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the `.env` instead.

A single HTML file is uploaded as index.html (the URL is the bare host); a
folder as it is, minus .git, node_modules and .env*, with its only .html copied
to index.html when it has no index. A `_headers` with `X-Robots-Tag: noindex`
keeps uploads out of search engines. 25 MiB per file at most.

What was published is recorded in a registry (TESSERA_CF_REGISTRY, default
tools/.cf-registry.json, gitignored). `up` will not overwrite, and `rm` will not
delete, a Worker the registry does not know (unless --force), so real apps on
the account are never touched. The link's host comes from TESSERA_CF_SUBDOMAIN
(the <subdomain> of <subdomain>.workers.dev), else from wrangler's output.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import legacy  # noqa: E402

WRANGLER = "wrangler@4"
COMPAT_DATE = "2026-09-01"
MAX_ASSET = 25 * 1024 * 1024  # Workers static assets: 25 MiB per file
# the old shell's double suffix (name.<old>.html): stripped like .html
_OLD_SUFFIX = "." + legacy.SHELL_NAME.lower().split(".")[-2]
URL_RE = re.compile(r"https://\S+?\.workers\.dev")


class UploadError(Exception):
    pass


def registry_path() -> Path:
    p = config.get("TESSERA_CF_REGISTRY")
    return Path(p).expanduser() if p else config.TOOLS / ".cf-registry.json"


def load_registry() -> dict:
    f = registry_path()
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}


def save_registry(reg: dict) -> None:
    f = registry_path()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(reg, indent=2) + "\n", encoding="utf-8")


def slugify(s: str) -> str:
    s = re.sub(rf"(?:{re.escape(_OLD_SUFFIX)})?\.html?$", "", s.lower())  # an old deck's double suffix too
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:54].rstrip("-") or "upload"


def _npx() -> list[str]:
    exe = shutil.which("npx") or shutil.which("npx.cmd")
    if not exe:
        raise UploadError("npx not found: install Node.js 20+")
    return [exe, "--yes", WRANGLER]


def wrangler(args: list[str], echo: bool = False) -> tuple[bool, str]:
    r = subprocess.run(_npx() + args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env={**os.environ, "WRANGLER_SEND_METRICS": "false"})
    out = (r.stdout or "") + (r.stderr or "")
    if echo:
        sys.stdout.write(r.stdout or "")
        sys.stderr.write(r.stderr or "")
    return r.returncode == 0, out


def relative_refs(html: str) -> list[str]:
    """Relative src/href/poster references: they 404 once a file is uploaded alone."""
    refs = []
    for m in re.finditer(r"""\b(?:src|href|poster)\s*=\s*["']([^"']+)["']""", html, re.I):
        u = m.group(1).strip()
        if not re.match(r"^(?:[a-z][a-z0-9+.-]*:|//|#|\{|\$)", u, re.I) and u not in refs:
            refs.append(u)
    return refs


def stage(src: Path) -> Path:
    """Copy what is uploaded into <tmp>/public. Returns <tmp>."""
    root = Path(tempfile.mkdtemp(prefix="cfup-"))
    pub = root / "public"
    if src.is_dir():
        skip = re.compile(r"^(\.git|node_modules|\.env.*)$")
        shutil.copytree(src, pub, ignore=lambda d, names: [n for n in names if skip.match(n)])
        if not (pub / "index.html").exists():
            htmls = [f for f in os.listdir(pub) if re.search(r"\.html?$", f, re.I)]
            if len(htmls) == 1:
                shutil.copyfile(pub / htmls[0], pub / "index.html")
            else:
                print(f"cf_upload: folder has no index.html ({len(htmls)} html files): link to them by name.",
                      file=sys.stderr)
    else:
        pub.mkdir()
        is_html = re.search(r"\.html?$", src.name, re.I) is not None
        shutil.copyfile(src, pub / ("index.html" if is_html else src.name))
        if is_html:
            refs = relative_refs(src.read_text(encoding="utf-8", errors="replace"))
            if refs:
                print(f"cf_upload: WARNING: {len(refs)} relative reference(s) will 404 when uploaded alone:",
                      file=sys.stderr)
                for r in refs[:10]:
                    print(f"   {r}", file=sys.stderr)
                print("       Upload the containing folder instead if they matter.", file=sys.stderr)
    headers = pub / "_headers"
    if not headers.exists():
        headers.write_text("/*\n  X-Robots-Tag: noindex, nofollow\n", encoding="utf-8")
    for f in pub.rglob("*"):
        if f.is_file() and f.stat().st_size > MAX_ASSET:
            shutil.rmtree(root, ignore_errors=True)
            raise UploadError(f"{f.relative_to(pub)} is {f.stat().st_size / 2**20:.1f} MiB: "
                              "Workers assets allow 25 MiB per file")
    return root


def deploy_args(name: str, root: Path) -> list[str]:
    return ["deploy", "--name", name, "--assets", "./public", "--compatibility-date", COMPAT_DATE,
            "--cwd", str(root)]


def link(name: str, output: str = "") -> str:
    """The Worker's address: from TESSERA_CF_SUBDOMAIN, else from wrangler's output."""
    want = config.workers_host(name)
    seen = next((u for u in URL_RE.findall(output) if u.startswith(f"https://{name}.")), None)
    if want and seen and seen != want:
        print(f"cf_upload: note: wrangler reports {seen}, TESSERA_CF_SUBDOMAIN gives {want}", file=sys.stderr)
    if want or seen:
        return want or seen
    raise UploadError(f"deployed {name}, but its address is unknown: set TESSERA_CF_SUBDOMAIN in the .env")


def up(src: Path, name: str | None = None, force: bool = False, dry_run: bool = False,
       owned: bool = False) -> str:
    """Publish `src` as Worker `name`; returns its URL. `owned`: the caller knows
    this name is its own (e.g. a deck's publish.json recorded it), so the
    registry guard does not apply."""
    src = src.resolve()
    if not src.exists():
        raise UploadError(f"not found: {src}")
    name = slugify(name if name is not None else src.name)
    reg = load_registry()
    if not dry_run and not (reg.get(name) or owned or force):
        ok, _ = wrangler(["deployments", "list", "--name", name])
        if ok:
            raise UploadError(f'a Worker named "{name}" already exists and this tool did not create it: '
                              "pick another --name (or --force if it really is yours)")
    root = stage(src)
    try:
        if dry_run:
            ok, out = wrangler(deploy_args(name, root) + ["--dry-run"], echo=True)
            if not ok:
                raise UploadError("wrangler deploy --dry-run failed")
            url = config.workers_host(name) or f"https://{name}.<subdomain>.workers.dev"
            print(f"\nDRY RUN  would publish {url}")
            return url
        ok, out = wrangler(deploy_args(name, root), echo=True)
        if not ok:
            raise UploadError("deploy failed")
    finally:
        shutil.rmtree(root, ignore_errors=True)
    url = link(name, out)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    reg[name] = {"url": url, "source": str(src), "created": (reg.get(name) or {}).get("created", now), "updated": now}
    save_registry(reg)
    print(f"\nLIVE  {url}\n      (remove with: python tools/cf_upload.py rm {name})")
    return url


def resolve_name(reg: dict, key: str) -> str | None:
    if key in reg:
        return key
    absolute = str(Path(key).resolve())
    by_source = next((n for n, e in reg.items() if e.get("source") == absolute), None)
    if by_source:
        return by_source
    s = slugify(Path(key).name)
    return s if s in reg else None


def remove(reg: dict, names: list[str]) -> int:
    failed = 0
    for n in names:
        ok, out = wrangler(["delete", "--name", n, "--force"])
        if ok or re.search(r"does not exist|not found|10007", out, re.I):
            reg.pop(n, None)
            print(f"REMOVED  {n}")
        else:
            failed += 1
            print(f"FAILED   {n} (still listed; retry, or delete it in the Cloudflare dashboard)\n{out}",
                  file=sys.stderr)
    save_registry(reg)
    return failed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("up", help="publish a file or folder (same name again = redeploy, same URL)")
    p.add_argument("src")
    p.add_argument("--name")
    p.add_argument("--force", action="store_true", help="overwrite a Worker the registry does not know")
    p.add_argument("--dry-run", action="store_true", help="stage and run wrangler deploy --dry-run; nothing uploaded")
    sub.add_parser("ls", help="what this tool published")
    p = sub.add_parser("rm", help="delete Workers (their URLs stop working)")
    p.add_argument("keys", nargs="*", help="names or source paths")
    p.add_argument("--all", action="store_true")
    p.add_argument("--force", action="store_true", help="delete a Worker by exact name even if not in the registry")
    p = sub.add_parser("prune", help="delete everything not updated in N days")
    p.add_argument("--days", type=float, required=True)
    sub.add_parser("whoami", help="check the Cloudflare login")
    a = ap.parse_args()
    try:
        if a.cmd == "up":
            up(Path(a.src), a.name, a.force, a.dry_run)
        elif a.cmd == "ls":
            reg = load_registry()
            if not reg:
                print("Nothing published.")
            for n in sorted(reg):
                e = reg[n]
                print(f"{n:<28} {e['url']:<52} {e.get('updated', '')[:10]}  {e.get('source', '')}")
        elif a.cmd == "rm":
            reg = load_registry()
            if a.all:
                targets = list(reg)
            else:
                targets = []
                for k in a.keys:
                    n = resolve_name(reg, k) or (k if a.force else None)
                    if not n:
                        raise UploadError(f'"{k}" is not something this tool published (see: ls). '
                                          "Pass --force to delete a Worker by exact name.")
                    targets.append(n)
            if not targets:
                print("Nothing to remove.")
            elif remove(reg, targets):
                raise SystemExit(1)
        elif a.cmd == "prune":
            reg = load_registry()
            cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=a.days)
            old = [n for n, e in reg.items()
                   if datetime.datetime.fromisoformat(e["updated"].replace("Z", "+00:00")) < cutoff]
            if not old:
                print(f"Nothing older than {a.days:g} day(s).")
            elif remove(reg, old):
                raise SystemExit(1)
        elif a.cmd == "whoami":
            ok, _ = wrangler(["whoami"], echo=True)
            raise SystemExit(0 if ok else 1)
    except UploadError as e:
        raise SystemExit(f"cf_upload: {e}") from None


if __name__ == "__main__":
    main()
