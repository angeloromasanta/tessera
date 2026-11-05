---
type: Recipe
title: 'A three-state engine: on / dead / sel'
description: Steps with on/dead/sel lists so marks can read as failed or chosen, not just shown; leave failures on screen, greyed.
tags:
- dead
- sel
- selection
- failure
- survival
- evolution
- shortlist
- phase
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

Opacity alone cannot say *this one failed* or *this one was chosen*. When the
figure is about survival, competition or a shortlist, give a step three lists
instead of one — the engine grows by two lines and every mark gains two more
states. `examples/evolution.html` is the worked version.

```js
const steps = [
  { on: g1 },
  { on: g1, dead: ['b0','b2'], sel: ['b1','b3'] },   // same marks, new meaning
];
els.forEach(e => {
  e.classList.toggle('on', s.on.includes(e.id));
  e.classList.toggle('dead', (s.dead || []).includes(e.id));
  e.classList.toggle('sel',  (s.sel  || []).includes(e.id));
});
```

```css
.el.on.dead{opacity:.34}          /* 3 classes beat .el.on, so it wins */
circle.dead{fill:#C7CFD1}         /* CSS beats the fill attribute */
circle.sel{stroke:#1A2326;stroke-width:3}
text.ph.sel{fill:#1A2326}         /* same list can light up a phase label */
```

**Leave the failures on screen, greyed.** A ball that vanishes was never there;
a ball that goes grey and shrinks is the cost of the process, which is usually
the point. And a persistent phase strip (`VARIATION → SELECTION → RETENTION`,
one word lit) tells the audience where they are in a cycle without a caption.
