---
type: Recipe
title: Motion beyond a fade
description: Self-drawing curves in segments, marching ants around a loop, a hatched region, and what tweens in SVG.
tags:
- draw
- march
- ants
- flow
- loop
- hatch
- pattern
- tween
- fade-only
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

- **A curve drawing itself** — `class="el draw"`, handled by the starter's
  engine. Split a long curve into segments with shared endpoints (`s1` ends
  where `s2` starts) so each click extends the line.
- **Flow around a closed loop** (the last click of a flywheel): dashes that
  march. Append the ellipse *after* the arcs so the ants ride on top.
  ```css
  #flow{animation:ants 1.7s linear infinite}
  @keyframes ants{to{stroke-dashoffset:-36}}   /* = dash + gap, so it loops seamlessly */
  ```
  ```js
  mk('ellipse', { class: 'el', id: 'flow', cx: CX, cy: CY, rx: RX, ry: RY,
    fill: 'none', stroke: '#BF831A', 'stroke-width': 3, 'stroke-dasharray': '8 30' }, layer.links);
  ```
  Do **not** rotate an ellipse to suggest spin — it reads as tumbling.
- **A region under discussion** — a hatched band beats a tinted rect on white:
  ```svg
  <pattern id="hatch" width="9" height="9" patternTransform="rotate(45)"
           patternUnits="userSpaceOnUse">
    <line x1="0" y1="0" x2="0" y2="9" stroke="#D2553A" stroke-width="3" opacity=".26"/>
  </pattern>
  ```
- Anything tweenable tweens: `cx`, `r`, `transform`, `stroke-dashoffset`.
