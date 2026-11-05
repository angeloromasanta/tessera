---
type: Recipe
title: A box sized from what it holds
description: Show growth by animating a box's height (SVG geometry is CSS-animatable), deriving the outer box from the inner one.
tags:
- height
- grow
- queue
- transcript
- transition
- container
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

When the point is that something *grows* — a transcript, a queue, a total —
do not fade in a bigger box. SVG geometry properties (`x`, `y`, `width`,
`height`, `r`, `cx`) are CSS-animatable, so a step just sets a height and the
box stretches, carrying its border and its label with it.

```css
#msgBox,#ccBox{transition:height .85s cubic-bezier(.4,0,.2,1)}
```
```js
const msgH = n => 56 + (n - 1) * PITCH;            // n = rows it holds
const ccH  = n => MSGY + msgH(n) + 16 - CC.y;      // the box around it
// in draw(): ccBox.style.height = ccH(s.n) + 'px'
```

Derive the outer box from the inner one rather than keeping two tables in
step. This is also the cheapest way to satisfy the fade-only check: a step that
grows a box has moved something already on screen.
