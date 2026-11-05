---
type: Recipe
title: Something born out of something else
description: 'A child mark grows out of its parent: author it at its final place, offset it back with a CSS transform that .on removes.'
tags:
- child
- spawn
- grow
- transform
- origin
- parent
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

A child mark that grows out of its parent, using only a class toggle: put the
element at its **final** position and offset it back with a transform that
`.on` removes.

```js
mk('circle', { class: 'el sp', id, cx: b.x, cy: b.y, r: b.r, fill: b.c,
  style: `--dx:${a.x - b.x}px;--dy:${a.y - b.y}px` });   // a = parent
```

```css
.sp{transform:translate(var(--dx),var(--dy)) scale(.3);
  transform-box:fill-box;transform-origin:center;
  transition:transform .75s cubic-bezier(.34,1.16,.5,1),opacity .45s,fill .55s}
.sp.on{transform:translate(0,0) scale(1)}
```

`px` in an SVG element's CSS transform is one user unit, so the offsets are
plain viewBox arithmetic. Stepping backwards reverses it for free.
