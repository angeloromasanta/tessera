---
type: Rule
title: Routing rules
description: Lines never behind cards, labels within ~12 units of their mark, spacing under big numbers, computed boundaries, arrowheads off text.
tags:
- line
- route
- lane
- arrow
- arrowhead
- label
- boundary
- big number
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

`figcheck.py` flags each of these; building to them avoids the round-trip.

- **Never route a line behind cards.** Send it down an empty lane between rows
  or columns; if no lane exists, drop the line and let position carry it.
- **A label sits within ~12 units of its mark**, on the side with free space.
  Farther than that and the room pairs it with the wrong mark.
- **Under a big number**, the next baseline is at least `0.3 x size + sub size`
  lower (52px number, 18px sub: 34 units) — or stack them with `getBBox()`.
- **A boundary line is computed from the dots it separates** (midway between
  the last dot on one side and the first on the other), never typed; its
  labels go on the side away from the line.
- **Arrowheads never land on text.** End an arrow at the box edge (see the
  [ring recipe](/recipes/ring-of-nodes.md)'s `edge()`), and put its label beside the shaft, not at the tip.
