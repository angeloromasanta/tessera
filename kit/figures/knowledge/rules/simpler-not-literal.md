---
type: Rule
title: 'The corrections so far: all toward simpler'
description: Even spacing over true scale, abstract over literal, last year's slide as the brief, last click for a static image, galleries for photos.
tags:
- simple
- even spacing
- abstract
- last year
- static image
- gallery
- pptx
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

- A calendar of sessions → **evenly spaced**, not a true-scale time axis (the
  dated version cost three rounds of label collisions).
- A concept picture (a research swarm) → **abstract** (one structure, many
  agents), not a literal labelled diagram of sub-problems.
- A deck that existed last year → brief from **last year's slide** (the deck
  README lists it). `pptx_render.py` mangles dense slides; the PDF export
  renders cleanly: `fitz.open(pdf)[i].get_pixmap(dpi=110).save(png)`.
- A static image (a course page, a handout) → the figure's **last click** (legible
  without a speaker), `shoot.py --page --clicks last --scale 2`.
- Photographs appearing one by one are a `gallery`; bullets one by one are a
  `content` slide. A figure is for drawn marks that carry meaning.
