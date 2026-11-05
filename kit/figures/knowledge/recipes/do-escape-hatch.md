---
type: Recipe
title: '`do`: anything else that changes rather than enters'
description: 'The escape hatch for a box height, a counter or running flows: a named field of your own on the step, applied by do.'
tags:
- do
- counter
- height
- custom field
- state
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

The escape hatch, for a change no list can express: a box height, a counter,
which flows are running, a class on a group whose children are not stepped
marks of their own.

```js
const steps = [ { on: [...], n: 3 }, … ];
steps.forEach(s => { s.do = () => { ccBox.style.height = ccH(s.n || 0) + 'px'; }; });
```

Give the step a **named field of your own** (`n`, `band`, `axes`, `zoom`) and
let `do` apply it, rather than putting the logic in the step. The field is then
readable as the figure's state, and `draw()` stays the starter's.
