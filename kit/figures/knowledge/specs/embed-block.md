---
type: Spec
title: '`## embed`: a live web page in the slide'
description: 'The spec block for an embed: page vs src, live, poster at the frame size, zoom, titled vs full-bleed frame, arrow keys.'
tags:
- embed
- texts
- data-edit
- spec
- page
- src
- poster
- live
- zoom
- full-bleed
- md_to_deck
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

Compiled by `md_to_deck.py`; the file shape and the other slide types are in the authoring guide's `reference/SLIDE_SPEC.md`.

The only element that runs JavaScript. A simulation, an interactive
infographic, or a build animation recreated as one self-paced figure.

```md
## embed
title: Evolutionary View
page: build/evolution-app.html
poster: build/media/evolution-app-poster.jpg
live: yes
notes: What it shows, one line per state (the first spoken on load), and that clicking in the frame
  advances it. The figure itself carries no captions -- the presenter narrates.
```

- `page:` is a local HTML file, embedded **verbatim** — the deck stays portable
  and works with no network. `src:` takes a URL instead and gives that up.
- `live: yes` shows the interactive figure on the main edit canvas too. Use it
  for figure embeds by default; the slide thumbnails still need a poster.
- `poster:` is required in practice. Shoot it at the frame's own size —
  `--size 1280x500` for a titled embed, `1280x720` for a full-bleed one — or
  the poster is letterboxed against the live frame's aspect.
  It is required because the editor canvas and the thumbnails rasterize
  slides, and a live iframe cannot be rasterized. `live: yes`
  replaces the poster on the main editor canvas only. Make one
  with `shoot.py --page --clicks last`; `--clicks all` instead writes every
  state plus a contact sheet, which with `figcheck.py` is how to check the build.
- **A `src:` embed still needs a poster**, and `shoot.py --page` only takes a
  file. Write a one-line wrapper page under `$DECK_DIR/build/check/` that
  iframes the URL (`<iframe src="https://…" style="border:0;width:100%;height:100%">`),
  shoot that with `--settle 8`, and point `poster:` at the result. Check the
  site allows framing first: `curl -sI URL | grep -i x-frame` should print
  nothing.
- `zoom:` gives the frame a logical viewport of `w/zoom × h/zoom` and scales it
  to fit — for a page laid out for a bigger window. Omit it for a page written
  to fit the slide.
- Omit `title:` for a full-bleed frame; set it for the standard title band with
  the figure below. The frame is then ~1224×469, so draw in a `1280x480`
  viewBox — a mismatched aspect letterboxes the figure and wastes width.
- The frame takes the arrow keys while focused, so the figure advances rather
  than the deck. Say so in `notes:`.
- `texts:` pins the wording of the page's editable labels, one-line JSON:
  `texts: {"n1": "Lower prices", "axis-x": "Years"}` (keys are the page's
  `data-edit` keys). People also retype labels in the editor; those edits are
  stored on the embed element as `texts` and a recompile carries them over by
  slide and element id. Never strip `texts` from an element when re-embedding,
  re-pointing or rebuilding a figure, and keep every `data-edit` key the page
  had.
