---
type: Correction
title: slides are crashing, like slide 6
description: Replacing a page asset with slide.py stored a base64 data URI; an embed asset must be raw HTML starting <!DOCTYPE.
tags:
- asset
- base64
- data uri
- slide.py
- crash
- page
status: stable
not_duplicate_of:
- recipes/deck-embed-slide
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** `slide.py asset DECK page-fig-roadmap fig-roadmap.html` replacing an existing page asset stored it as a `data:text/html;base64,…` URI; an embed `asset` must be raw HTML, so the frame showed the base64 text. New keys were stored raw.
**Fix:** after bundling, check `assets[page-*]` starts with `<!DOCTYPE`; if not, re-add it with `slide.py asset DECK KEY page.html` (which now stores page HTML raw) or `slide.py pull`/`push`. Walk the deck in the editor (playwright, ArrowDown per slide) rather than trusting `shoot.py --id`, which stalls on stepped embeds.
