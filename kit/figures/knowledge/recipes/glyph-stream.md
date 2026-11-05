---
type: Recipe
title: A stream of glyphs riding a wire
description: Data moving over a link as a textPath of digits on its own inset rail, drawn left-to-right, offset kept in [-pitch, 0].
tags:
- textPath
- bits
- data
- wire
- stream
- network
- packet
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

For "data is moving over this link", the digits **are** the wire — no packet
shape, nothing to collide with a label.

```js
const PAT = '0110100111010010';              // 16 chars, so one cycle = seamless
const t = mk('text', { class: 'bits', fill: ACC, 'data-figcheck': 'ignore' }, L.labels);
const tp = document.createElementNS(SVG, 'textPath');
tp.setAttribute('href', '#' + rail.id);
tp.textContent = PAT.repeat(Math.ceil(rail.getTotalLength() / 60) + 3);  // overfill
t.appendChild(tp);
// in the rAF ticker: pitch = one PAT width, measured (never typed)
tp.setAttribute('startOffset', pitch * (dir > 0 ? u - 1 : -u));
```

```css
.bits{font-family:Consolas,monospace;font-weight:700;font-size:16px;
  dominant-baseline:middle;letter-spacing:.08em}
```

Three traps, all of which cost a screenshot each:

- **A `textPath` runs along its path's own direction**, so a wire drawn
  right-to-left renders every glyph upside down. Draw *every* wire
  left-to-right; a returning one takes `marker-start` with a marker declared
  `orient="auto-start-reverse"`, and runs its stream backwards (`dir = -1`).
- **Give the stream its own rail**, a second invisible path inset ~13 units at
  each end, or the digits run under the arrowhead and into the box edge.
- Keep the offset inside `[-pitch, 0]` in both directions — that is the range
  where an overfilled string still covers the whole wire, so the stream never
  shows a gap. Measure `pitch` from `getComputedTextLength()` and re-measure it
  in `FIT`; a hand-typed character width is wrong the moment the font loads.
