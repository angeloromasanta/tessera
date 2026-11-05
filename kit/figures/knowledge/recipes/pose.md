---
type: Recipe
title: 'Pose: where a mark IS in this step'
description: 'The step field pose {id: {x, y, s, r}} moves, scales and turns marks already on screen; values may be functions measured at step time.'
tags:
- pose
- move
- offset
- scale
- rotate
- onto
- step
- FIT
status: stable
sources:
- resource: /corrections/2026-10-01-measured-pose-stacked-in-deck.md
generated:
  by: claude-code/opus-5.5
  at: '2026-10-04T10:57:17Z'
---

[Born out of](/recipes/born-out-of.md) moves a mark by writing its own CSS. Three figures each wrote
their own version of it (an invisible marker element and a sibling combinator,
a bespoke `n:` field, per-id `:not(.on)` rules), which is why none of them was
reusable. The starter now takes it as a step field, so a mark's place, size and
turn are data:

```js
{ on: [...], pose: { seat3: { s: 2.5 }, chip: { x: 180, y: -40 }, arm: { r: 18 } } }
```

`x`/`y` are **offsets in viewBox units** from where the mark was authored (`px`
in an SVG element's CSS transform is one user unit, so it is plain viewBox
arithmetic), `s` scales about the mark's own centre, `r` turns it. Marks not
named in a step's `pose` return to their authored place, and stepping backwards
reverses everything for free.

Three habits, each of which is a screenshot round-trip saved:

- **A value may be a function**, evaluated at step time: `pose: { chip: () =>
  onto('chip','slot') }`. Anything measured from `getBBox` must be, or it is
  measured while the frame is still hidden and every text is 0 wide. A
  function alone is not enough: it runs inside `draw()`, and the deck loads
  the frame hidden and never calls `draw()` again, so after `draw();` push a
  function onto `FIT` that re-applies the current step's poses
  (`POSED.forEach(... setPose ...)`). `shoot.py --page` loads the page visible
  and cannot show this; check a measured pose with `shoot.py DECK --id ID`.
- **Pose marks that are already on screen.** An *entering* mark takes its
  direction from `rise`/`fromL`/`fly`/`draw` instead. A pose on the step a mark
  enters does travel — from its authored place to the pose — but that is rarely
  the motion you meant.
- **Check the gap before you scale.** A card swelling 6% in a grid with a 16-unit
  gutter overlaps its neighbour. The dimmed neighbours are below figcheck's
  visibility threshold so it will not tell you; the neighbours that stay lit
  will.

Only elements some step poses are touched by any of this — a figure that uses
no `pose` behaves exactly as before, and so does a mark carrying its own
`transform` attribute.
