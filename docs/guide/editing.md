# Editing a deck: `slide.py`, specs, checks

## The tool: `slide.py`

`TARGET` is a deck file, `live` (the one connected editor) or a session id.
The commands work the same on both. Every write is compare-and-set: if someone
changed the same value first, you get a `conflict` rather than overwriting
them. On disk, writes queue behind a lock, and the file is first copied to the
deck's `build/backups/` (3 rotating copies, `TESSERA_BACKUPS`). The editor's
version history covers edits made in the editor; these copies cover a tool
that rewrote the closed file.

```bash
$PY $T/slide.py ls TARGET                       # one line per slide (~3 KB, not 90 KB)
$PY $T/slide.py get TARGET ID                   # one slide, one element per line
$PY $T/slide.py info TARGET --section theme|layouts|layout:ID|assets|notes|poll
$PY $T/slide.py text TARGET ID ELEM "New title\nsecond line"   # or --html '<b>…</b>'
$PY $T/slide.py notes TARGET ID "…"             # or --file notes.txt
$PY $T/slide.py set TARGET ID ELEM x=56 fontSize=40 'color="#1A4C9C"'
$PY $T/slide.py set TARGET ID - transition=fade name="…"       # '-' = the slide itself
$PY $T/slide.py new TARGET --layout points --after ID
$PY $T/slide.py copy TARGET sl-title --after ID          # from the template, with its assets
$PY $T/slide.py dup|move|rm …   ·   asset TARGET KEY file.jpg
$PY $T/slide.py pull TARGET ID  →  edit build/work/ID.json  →  slide.py push TARGET ID
$PY $T/slide.py requests|reply|ask …            # requests typed in the editor (below)
$PY $T/slide.py fork COPY.html [--polls]        # a copied file gets its own identity (authoring.md, "Identity")
$PY $T/slide.py poll clear|export|code|publish …   # the poll service (engagement.md)
$PY $T/shoot.py TARGET --id ID,ID               # just those slides → build/shots/ID.png
```

- **Bigger edits** (moving several elements, rebuilding a slide): `pull`,
  change `build/work/<id>.json` with an exact-string edit (each element is one
  line), then `push`. `push` sends only what you changed. `--dry-run` shows
  the patches.
- **Embed and poll slides** have builders: `deck_build.py add-slide`,
  `update-slide` and `add-poll` (see `--help`, [figures.md](figures.md),
  [engagement.md](engagement.md)). They write the file, so they can't run
  while the deck is open live.
- **Icons:** `icon.py NAME --x --y --size --color` prints a `path` element.
  Use the `lucide` or `tabler` stroke sets; filled sets blob.
  **Panel tint:** `panel_tint.py deck.html --all`.

## Which edit path

| the deck is… | edit through | never |
|---|---|---|
| open in an editor (it connects by itself), or a `build/<deck>.html.live-source.json` exists | `slide.py DECK.html …`: it routes to the open editor; patches land with no reload | write the file, recompile, `deck_build.py`, delete the guard |
| built from a `.md` spec and not open live | the spec, then `md_to_deck.py --check` and compile (or `land.py`, below) | hand-edit the HTML; the next compile loses it |
| no spec (or spec abandoned, see the deck README) | `slide.py DECK.html …`; `deck_build.py` for embed and poll slides | ad-hoc `python -c` over the JSON |

After a live session, reconcile the saved deck back into the spec before the
next compile: `agent_live.py reconcile DECK --acknowledge`. That command is
only for after the reconciliation is done.

## Live by default: the open deck is watched

An open deck connects to the local bridge **by itself** (no pairing, no
button). `slide.py DECK.html …` and `shoot.py` edit the open editor when the
deck is open and the file when it is not; stderr says `(live: …)` when it went
live. Each patch shows in the editor at once, and `slide.py` writes the
editor's document through to the file, so a reload of an unsaved tab loses
nothing. Never write a live deck any other way. **Land each finished slide at
once**; never batch finished slides in `build/` for one compile at the end.

- **The guard.** The first live patch writes
  `build/<deck>.html.live-source.json`. While it exists the compiler and
  `deck_build.py` refuse to run (`land.py` still lands into the open deck);
  never delete it.
- **`busy`** (someone is mid-gesture) retries by itself. On **`conflict`**,
  `get` again and redo only the overlapping part.
- **Figure and poll builders** write the file, so with the deck open use
  `slide.py copy` of a template slide ([parallel.md](parallel.md), "Figures
  and polls").
- **Several tabs of one deck** sync with each other by docId: send each
  command **once**, to `DECK.html`. Repeating it per tab makes duplicate `-2`
  slides and push conflicts. Never stop a tab or ask for one to be closed.
- **A deck on an older shell** (no comment field beside each slide):
  re-host the saved file with `node $TESSERA/scripts/upgrade-deck.mjs DECK.html`.
  This works **while the deck is open**: wait for `dirty=False` in `slide.py ls`,
  re-host, then ask for a reload of the tab. The editor's save replaces only the
  `#tessera-doc` block, so it never puts the old shell back. A protected field
  (`doc.poll.service`, the join code, `docId`) cannot go through the live channel;
  `slide.py poll code` writes it to the file. An open tab folds file changes into
  its document on its next save (`save-merge.ts` skips only `docId`), so the file
  write plus a reload should work too, but that path is untested: close the deck
  if in doubt.

**Figures on the live server.** `live.py start $DECK_DIR` (port 5173, once per
task, outside any sandbox) serves figure pages that reload in place on save.
An embed runs from it when its `devSrc` is `http://127.0.0.1:5173/...` with
`liveInEditor` (spec: `src:` that address plus `live: yes`). The page is always
in the file too: the open editor copies each save into the embed's `asset`;
`slide.py bake DECK` does it for a closed file, `--final` (or
`live_figures.py close`) when the figures are finished.

## Requests typed in the editor

The person comments in the editor's review list (a field beside every slide;
Enter sends and moves on to the next), and what is typed is saved in the
deck, so it waits for whichever agent opens the deck next:

- **beside a slide**: a request thread on that slide, with the selection it
  was typed against when that slide was open;
- **on a new empty slide** (＋ between rows or New slide insert one and its
  field asks "What should this slide be?"): a request on that empty
  slide. **Build the slide there**, in place (`slide.py set`/`push` on that
  id, or replace it with `new`/`copy --after` and `rm`, then reply on the
  request before removing the slide);
- **in the "Whole deck" row** (first in the list): a request about the whole deck (flow,
  tone, a new section), stored in the top-level `requests` array.
  `slide.py requests` prints it as `[deck] whole deck`; `ask DECK - "text"`
  records one.

- **Start of any deck session:** `slide.py requests DECK.html`. Open requests
  are work already asked for; do them before anything nobody asked for.
- **While the deck is open live:** run a listener in the background,
  `slide.py requests DECK.html --wait` (timeout 2 h; in an agent harness, a
  background shell that notifies you when it exits, such as Claude Code's
  `run_in_background`, never a foreground call that blocks the session). The editor shows "An
  agent is listening" while it runs. When it exits it has printed the new
  requests: **mark each one working**
  (`slide.py reply DECK.html REQ_ID "" --status working`), **then re-arm**,
  then serve them. It gives up by itself after 115 quiet minutes; do not
  re-arm then unless asked.
- **Serving one:** (already marked working) make the change live (yourself if
  it is one to three commands; a subagent for a figure or a rebuilt slide), then
  `slide.py reply DECK.html REQ_ID "One line on what changed"`. The slide's orb
  turns green and the reply shows under the comment: it is all the person
  reads about what happened, so make it the one line that says it. Change only what was asked; never delete a request.
- Requests survive a recompile (`md_to_deck.py` carries them over by slide id)
  and are left out of the frozen Export. A request typed on the live mirror's
  phone view arrives the same way ([publishing.md](publishing.md)). The
  contract is in the file's head comment and in [../agent-live.md](../agent-live.md),
  "Change requests"; the JSON shape is in [reference/agents.md](reference/agents.md).

**Text a person retyped in a figure** lives on the embed as `texts`; never drop
it when you rebuild or re-embed ([figures.md](figures.md), "Editable labels").

## A deck built from a spec: `md_to_deck.py` and `land.py`

- **Whole deck:**
  `md_to_deck.py --check deck.md && md_to_deck.py deck.md -o deck.html`,
  then `node $TESSERA/scripts/stamp-agent-notes.mjs deck.html`. The spec
  format, and the three ways it loses text silently (a wrapped bullet, a slide
  field after a `###`, a wrapped value whose next line starts with `word:`),
  are in [reference/SLIDE_SPEC.md](reference/SLIDE_SPEC.md). **Run `--check`
  before every compile**: it catches all three.
- **Every edit: `land.py deck.md [--replace ID BLOCK.md | --after ID BLOCK.md |
  --delete ID… | --ops OPS.json]`**: spec edit, compile, notes, the deck's
  `postcompile.json` steps (slides the spec cannot hold), checks, and
  confirmation that the live link moved. Run it after each finished slide.
  It asks the bridge whether the deck is open: if so, only the changed slides
  land, as patches (each block needs an `id:`; nothing else, the docId or the
  join code changes). A closed-deck recompile mints new codes for unpinned
  polls; spec and deck writes are locked.
- **A layout bug is fixed in `$T/md_to_deck.py`, not in one deck.** Text
  that clips on every slide of a type, or a box in the wrong place, comes back
  on the next compile if you only patch the HTML.

## Hand-editing the JSON: the last resort

For a deck with no spec, **`slide.py` covers everything**: `text`, `notes`,
`set` for single values, `new`/`copy`/`dup`/`move`/`rm` for structure, `asset`
for pictures, and `pull` → edit `build/work/<id>.json` → `push` for anything
bigger (several elements, a rebuilt slide, odd fields). Embed and poll slides
have builders: `deck_build.py add-slide|update-slide|remove-slide|add-poll`
(offline only; `--help`).

Raw surgery on the `#tessera-doc` JSON is only for what `pull`/`push` cannot
express, such as a top-level document field. If you must: back the file up,
load the block with `json`, change it, escape every `<` as backslash-`u003c`,
splice it back with a replacer function (never a replacement string), and
re-parse the result. Never while the deck is open in the editor. Then run
`slide.py ls` on it: it refuses a block with a raw `<`, and
`slide.py repair DECK.html` re-escapes one.

Working examples in `$TESSERA/template.html`: poll `sl-poll`, embed
`sl-embed` and the other embed slides `slide.py ls` lists
(`slide.py get $TESSERA/template.html sl-embed`).

## Checking

- **Look** at what you touched: `shoot.py TARGET --id a,b` (works on hidden
  slides and `live`). Whole deck once, at the end: `shoot.py deck.html`
  (one PNG per slide, a contact sheet per 12).
- **Before a deck is copied or published:** `slide.py doctor DECK`: figures
  that are not in the file, slides sharing one figure page, missing assets and
  posters. It also names a figure page that scales itself to a frame with no
  size (blank when the show starts on that slide): `fitguard.py --deck DECK --fix`.
- A browser driven by an agent is not needed for checking: `shoot.py` covers it.

## Dead ends to skip

- `deck_build.py info` dumps 80–100 KB. Use `slide.py ls` / `info --section`.
- `shoot.py --only N` steps through every earlier slide and stalls on embeds.
  Use `--id`.
- `agent_live.py read` writes the whole document with base64 (4 MB). Use
  `slide.py get live ID`.
- A throwaway single-slide deck copy for screenshots is not needed any more:
  `shoot.py --id` does that.
- Inline `python -c` over the deck JSON is replaced by `slide.py`. If
  `slide.py` can't express an edit, `pull`/`push` can.
