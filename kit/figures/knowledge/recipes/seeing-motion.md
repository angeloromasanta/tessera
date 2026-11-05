---
type: Recipe
title: Seeing motion in screenshots
description: Screenshots show resting states; re-shoot moving states with --settle 0.28 to prove a flow runs or a camera arrives.
tags:
- shoot
- settle
- screenshot
- motion
- verify
- contact sheet
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

`shoot.py` waits `--settle 1.3`, so every frame is the resting state: a flow
that never starts or a camera stuck halfway both look correct. Re-shoot moving
states short:

```bash
$PY $T/shoot.py $DECK_DIR/build/figures/fig.html --page --size 1280x500 \
    --clicks 5,6,7 --settle 0.28 --out $DECK_DIR/build/check/mid
```

Marks caught in flight, a stream at a different offset, a camera mid-push are
the proof. Two shots at `--settle 0.28` also show whether a loop runs (a
stopped one is identical in both). `contact.png` checks the sequence only (it
is downscaled); read the final `step-NN.png` at full size for layout.
