---
type: Recipe
title: A ring of nodes with arcs that touch the boxes
description: Ellipse layout of nodes with arcs clipped to each box edge, sweep direction and a shared arrowhead marker (flywheel, cycle).
tags:
- ring
- ellipse
- arc
- arrowhead
- marker
- flywheel
- cycle
- loop
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

The expensive bit is where an arc should start and stop: a fixed angular padding
either leaves a floating stub or hides the arrowhead under a box. Walk the
ellipse away from the node's own angle until it clears the node's box.

```js
const CX = 640, CY = 235, RX = 336, RY = 168, W = 216, H = 62, M = 9;
const at = d => [CX + RX * Math.cos(d * Math.PI / 180),
                 CY + RY * Math.sin(d * Math.PI / 180)];

function edge(node, dir, extra) {          // dir +1 leaving, -1 arriving
  let t = node.a;
  for (let k = 0; k < 400; k++) {
    t += dir * 0.4;
    const [x, y] = at(t);
    if (Math.abs(x - node.x) > W / 2 + M || Math.abs(y - node.y) > H / 2 + M)
      return t + dir * (extra || 0);       // extra ~3 deg leaves room for the head
  }
  return t;
}
function arc(id, from, to) {
  const p1 = at(edge(from, +1, 0)), p2 = at(edge(to, -1, 3));
  mk('path', { class: 'el draw', id,
    d: `M${p1[0].toFixed(1)},${p1[1].toFixed(1)} A ${RX} ${RY} 0 0 1 `
       + `${p2[0].toFixed(1)},${p2[1].toFixed(1)}`,
    fill: 'none', stroke: '#0F6B73', 'stroke-width': 3.6,
    'stroke-linecap': 'round', 'marker-end': 'url(#ar)' }, layer.links);
}
```

Sweep flag `1` runs clockwise (y grows downward), which is the direction a
flywheel should turn. Six nodes 60° apart on `RX 336 / RY 168` clear each other
at box `216x62`; a *circular* ring of the same height does not — adjacent boxes
collide, so stretch the ellipse rather than shrinking the type.

Arrowhead, once, in `<defs>` (`orient="auto"` follows the path):

```svg
<marker id="ar" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6"
        markerHeight="6" orient="auto"><path d="M0,1.2 L9,5 L0,8.8 z" fill="#0F6B73"/></marker>
```
