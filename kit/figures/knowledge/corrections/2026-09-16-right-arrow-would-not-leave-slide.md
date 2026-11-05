---
type: Correction
title: a figure's right arrow would not leave the slide
description: A wrapping keydown handler kept the arrow key from reaching the deck; copy the starter's clamped handler and TESSERA_STEPPED verbatim.
tags:
- keys
- arrow
- keydown
- wrap
- TESSERA_STEPPED
- engine
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** the old keydown wrapped (`go(i + 1)` with a modulo `go`), so the
last step returned to state 0 instead of leaving the key unhandled for the
deck. It also lacked `window.TESSERA_STEPPED`.
**Fix:** copy the starter's clamped handler verbatim — `if (fwd && i <
steps.length - 1)`. It bit a figure after it had
already been reviewed and shipped, because no screenshot can show it.
