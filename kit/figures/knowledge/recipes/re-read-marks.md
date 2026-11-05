---
type: Recipe
title: The same marks, a different meaning
description: dim, dead and sel re-read the picture instead of adding to it; a re-read-only step warns `still` and may be right.
tags:
- dim
- dead
- sel
- still
- highlight
- recolour
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

`dim`, `dead` and `sel` are lists beside `on`, applied by the engine, so a step
can re-read the picture instead of adding to it. Override the colours per figure:

```css
.el.on.dim{opacity:.22}       /* the crowd a highlight was picked out of */
.el.on.dead{opacity:.34}      /* it failed, and leaving it grey is the point */
circle.dead{fill:#C7CFD1}     /* CSS beats the fill attribute */
.sel{stroke:#1A2326;stroke-width:3}
```

A step that only re-reads marks — no enter, no exit, no motion — reads as a
dead click to `figcheck` (`still`), because a colour change moves no bounding
box. That is a warning, not an error: `evolution.html`'s selection beats are
exactly this and are right. Pair it with a small `pose` when the beat feels
flat.
