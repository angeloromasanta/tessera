---
type: Recipe
title: Filled bands under a computed curve
description: Sample f(x) once, close each band back to the baseline, draw the outline on top; a cumulative overlay is the running sum.
tags:
- curve
- distribution
- bell
- s-curve
- area
- cumulative
- adoption
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

For a distribution, an S-curve, any `f(x)`: sample it once, build each band as a
closed path back to the baseline, and put the outline on top as a `.draw` path.

```js
const X0 = 150, X1 = 1200, BASE = 396, AMP = 306, Z = 3.2;   // one place to rescale
const px = z => X0 + (z + Z) / (2 * Z) * (X1 - X0);
const g  = z => Math.exp(-z * z / 2);
const py = z => BASE - AMP * g(z);
const samples = (a, b, n) =>
  Array.from({ length: n + 1 }, (_, k) => a + (b - a) * k / n);

for (const s of segs) {                 // segs: [{id, z:[a,b], c, name, pct}]
  const zs = samples(s.z[0], s.z[1], 60);
  let d = `M${px(zs[0]).toFixed(1)},${BASE}`;
  for (const z of zs) d += ` L${px(z).toFixed(1)},${py(z).toFixed(1)}`;
  mk('path', { class: 'el', id: s.id, d: d + ` L${px(zs.at(-1)).toFixed(1)},${BASE} Z`,
    fill: s.c, 'fill-opacity': .82 });
}
```

A cumulative overlay is the running sum of the same samples, scaled to its own
height — no error function needed:

```js
const w = zs.map(g), tot = w.reduce((a, b) => a + b, 0);
let run = 0, d = '';
zs.forEach((z, k) => { run += w[k] / tot;
  d += (k ? ' L' : 'M') + px(z).toFixed(1) + ',' + (BASE - 331 * run).toFixed(1); });
```
