---
type: Correction
title: folder names stacked in one place on the slide, fine in the page shot
description: A getBBox-measured pose ran only in draw() while the frame was hidden; re-apply poses from FIT.
tags:
- pose
- getBBox
- FIT
- hidden
- font
- measure
status: deprecated
superseded_by: /recipes/pose.md
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** a `pose` given as a function that measures with `getBBox` runs only inside `draw()`. The deck loads the frame hidden (every text 0 wide) and never calls `draw()` again, so the pose kept the hidden measurement. `shoot.py --page` loads the page visible and cannot show it.
**Fix:** after `draw();`, push a function onto `FIT` that re-applies the current step's poses (`POSED.forEach(... setPose ...)`), so font load and the first real size redo them. Check a measured pose with `shoot.py DECK --id ID`, not only `--page`.
