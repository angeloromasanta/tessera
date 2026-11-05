---
type: Recipe
title: deck_build.py embed slides (offline decks only)
description: add-slide / update-slide / remove-slide an embed in a deck file with no spec and no live editor, with an auto-shot poster.
tags:
- deck_build
- add-slide
- update-slide
- poster
- offline
- src
- iframe
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

```bash
$PY $T/deck_build.py add-slide deck.html --page $DECK_DIR/build/fig-NAME.html \
    --live --title "The perceptron" --notes-file notes.txt
$PY $T/deck_build.py update-slide deck.html --id s05-embed --page $DECK_DIR/build/fig-NAME.html
$PY $T/deck_build.py remove-slide deck.html --id s05-embed
```

Reads the target deck's own theme/layouts (no template), builds the `embed`,
auto-shoots the poster to `build/media/<page-stem>-poster.jpg` at the frame
size in the final state unless `--poster`/`--no-poster`, splices with the
`<`-escaping a compile uses, writes `.bak`, re-parses. Flags: `--id`,
`--after ID` / `--index N`, `--footer`, `--clicks N`, `--src URL` (not
portable), `--dry-run`. Re-running `add-slide` inserts a second slide — iterate
with `update-slide`. Anything else: `docs/editing.md`, "Hand-editing the JSON".
Refused while the deck is open live or has a live-source guard.

A `src:` embed (a hosted URL) still needs a poster: a one-line wrapper page in
`build/check/` that iframes it, shot with `--settle 8`. Check framing first:
`curl -sI URL | grep -i x-frame` should print nothing.
