# Publishing a deck

Everything goes through `$T/publish.py`. Pick the target from what was asked:

| asked for | command | where it lands |
|---|---|---|
| slides **for students**, a copy to share | `publish.py students DECK.html` | a Cloudflare Worker, `https://<name>.<subdomain>.workers.dev` |
| a link **to present from** (editor, live polls) | `publish.py teach DECK.html` | the same, full deck |
| **watch edits** from a phone or another computer | `publish.py live DECK.html` | the live mirror, `$TESSERA_LIVE_URL/deck/<slug>` |
| a frozen **file** to hand over (no upload) | `publish.py students DECK.html --no-upload` | `$DECK_DIR/build/publish/<deck>-students.html` |
| what is already out | `publish.py status DECK.html` | |

```bash
$PY $T/publish.py students $DECK_DIR/<deck>.html --name <worker-name>
$PY $T/publish.py teach    $DECK_DIR/<deck>.html --name <worker-name>
$PY $T/publish.py live     $DECK_DIR/<deck>.html            # --stop when done
```

**Uploads go to your own Cloudflare account**, on Workers Free, as static
assets through `wrangler deploy` (`npx wrangler login` once). The link is
`https://<name>.<subdomain>.workers.dev`, with `<subdomain>` from
`TESSERA_CF_SUBDOMAIN` in `.env` ([README.md](README.md), "Configuration";
the poll service's setup writes it). A name given once is saved in
`$DECK_DIR/publish.json`, so a redeploy is the same command without `--name`.
Uploading needs network access (a sandbox off). `--no-upload` builds
(students) or checks (teach) without publishing. These are public links:
never publish student data, grades or keys.

A deck that is open in the editor is published from the editor's document, so
unsaved live edits are included in `students`; `teach` uploads the file itself
and refuses while the editor has unsaved changes.

## students: the frozen copy

**In the editor**, Save ▾ → **Export a frozen copy…** makes the same frozen
copy as a local file, without uploading it
(`$TESSERA/slides/src/editor/export-frozen.ts`). It has none of this command's
per-deck options (cover, swap, notes, scrub, drop, nav pane), and it asks the
person for their own lecturer key. Use `publish.py students` (with
`--no-upload` for just the file) when the deck has a `publish.json` entry, a
link is wanted, or an agent makes the copy.

Written to `$DECK_DIR/build/publish/<deck>-students.html`, then uploaded.
The source is never changed. The copy:

- opens straight into the show (`readonly`), with the slide-list pane (☰,
  `$T/nav.js`), on this repo's current player shell
  (`$TESSERA/slides/dist-single`, so build the shell first if it is stale);
- has its own `docId`, and no `collab`, `agentNotes` or poll configuration;
- drops hidden slides, drill-down (`stateOf`) slides and their chips, and the
  slides listed under `drop`;
- carries every figure as a page in the file (`devSrc` baked, then removed);
- **freezes every poll**: the results are read once from the poll service and
  written into the slide (`frozen`). A choice, rating or quiz shows its bars,
  an open question its saved summary. No QR, no join code, no request to the
  service, and never the room's own words or names.

Freezing reads answers with the lecturer key, `TESSERA_LECTURER_KEY` in the
gitignored `.env` (never print or commit it). Without it the script stops and
says so. Alternatives: `--answers FILE.json`
(`{"<poll code>": ["answer", …]}`, also how to rehearse offline) or
`--drop-polls` (remove the poll slides).

**A slide whose figure reads the poll service** (the clustered hive, the hive
matrix) is removed and reported: a live reader cannot run without the service.
To keep one, freeze the figure itself first: run the service's own clustering
on the bucket's answers locally, bake the result into a copy of the page so
it no longer calls `/api/`, and `swap` that copy in (below). Never group the
answers by hand. A page that carries `<meta name="tessera-offline-ok">` (the
lab card) is kept: the copy adds `data-offline` to its `<html>` tag and the
page hides its live parts.

`publish.json`, per deck file (all keys optional):

```json
{"week-1.html": {
  "students": {"name": "intro-week-1",
               "drop": ["about-me", "s39-thanks"],
               "scrub": [["Dr\\. Jane Doe<br>", ""]],
               "names": "jane|doe",
               "swap": {"page-fig-x": "build/fig-x-online.html"},
               "notes": {"s15b-prompt": "Shorter note for students."},
               "cover": "page-cover",
               "keep_states": false,
               "out": "build/online/week-1.html", "upload": "build/online"},
  "teach": {"name": "intro-week-1-teach"},
  "live": {"slug": "week-1"}}}
```

`drop` lists slide ids to leave out; `scrub` is regex/replacement pairs
applied to slide text, notes and figure pages; `names` is a regex the script
warns about if it still matches (the presenter's name, a student's). `swap`
replaces a page asset with a local file. `cover` replaces that asset with the
template's current one. `out` + `upload` build several decks into one folder
with a landing page and publish the folder.

## teach: the deck to present from

**Cleans the deck first, every time:** assets nothing in the deck uses (left by
removed or copied-in slides; a merged deck can carry 15 MB of them) are deleted
from the deck itself, through the open editor when it is open (`slide.py prune
DECK --go` is the same step by hand; `--keep-assets` skips it). Then it uploads
the deck file after two checks: `slide.py doctor` (a figure that is not in the
file is fatal) and the file is under Cloudflare's 25 MiB.
Polls work as in the local file, with the same join code. Edits made in the
hosted copy stay in that browser: the file here is the source. A deck with
unreconciled live edits (not yet in its spec) is refused: reconcile first.
Redeploy after each edit the presenter should see in the link (the same
command, no `--name`).

## live: the mirror that follows edits

A small server on your machine, `$T/live/serve.py` (stdlib only), serves each
deck named in `$T/live/decks.json` (gitignored; `decks.example.json` shows the
shape) with `$T/live/sync.js` appended, and reads that file on every request.
`publish.py live` adds the slug (`--stop` removes it):

- **Run the server**: `$PY $T/live/serve.py`, listening on
  `TESSERA_LIVE_LOCAL` (default `http://127.0.0.1:8000`). `publish.py live`
  waits for `<local>/<slug>/version` to answer.
- **Make it reachable** from a phone with any tunnel or reverse proxy in front
  of that address (a Cloudflare Tunnel, a VPN, your LAN), and set
  `TESSERA_LIVE_URL` to the public base, so the command prints the right link.
  Put a login in front of it: the mirror shows the whole deck and accepts
  change requests.

Then edit with `slide.py` or recompile as usual: the page waits until the file
stops changing, patches changed slides in place and on a phone (or with
`?follow`) moves to the slide just edited. A recompile's new join code cannot
be patched, so the page shows "The join code changed — tap to reload" instead
of reloading. It is a mirror: edits made in it are overwritten. In
presentation mode patches wait. `--stop` when the deck is presented.

**On a phone it is the way to steer the deck.** A deck on the current shell
opens there as a vertical scroll of slides with the ask box docked below,
bound to the slide in view (no text editing). A request sent there is POSTed
to `/<slug>/request` (header `X-Key: deck-request`, so no cross-site form can
write) and recorded with `slide.py ask TARGET SLIDE "text"`: into the open
editor when there is one (an agent's `requests --wait` wakes as usual), else
into the file. Until the server confirms it the page holds its sync, so the
request is not overwritten; a red pill says when one is still unsent. A
request typed on a slide that exists only in the mirror (added there, so not
in the file) is kept as a whole-deck request that names that slide id and the
slide it was added after; the added slide itself is not saved, so the agent
creates it. `python scripts/test-live-request.py` checks the route.

**Have an agent answer while you type.** With the deck open in an editor on
the machine, `slide.py requests live --wait` blocks until a request arrives.
With no editor open, requests go into the file: the agent reads
`slide.py requests DECK.html` on a loop, answers with `slide.py reply`, and
the answer shows under the request on the phone at the next sync.

**A deck the editor refuses patches for reloads on every edit.** The usual
cause is two elements with one id on a slide (the editor checks the whole deck
on each patch); the page's console says `[deck-preview] {status: invalid …}`.

## Older paths

`$T/export_deck.py` (a `readonly` copy with live polls) stays only because
`publish.py` and older deck build scripts import its helpers; use
`students --no-upload` instead. A read-only copy is not access control: for
that, put `live` behind a login.

## Uploads and taking them down

`publish.py` uploads through `$T/cf_upload.py`, which also works on its own for
any static file or folder: `up FILE|FOLDER [--name SLUG]` (same name again =
same URL), `ls` (what it published), `rm NAME|--all`, `prune --days N`, and
`whoami` (checks the Cloudflare login). Each upload is one Worker at
`https://<name>.<subdomain>.workers.dev`, so a removal is one `wrangler delete`
and leaves nothing behind. It records uploads in `TESSERA_CF_REGISTRY`; run
`$PY $T/cf_upload.py --help` for the details.
