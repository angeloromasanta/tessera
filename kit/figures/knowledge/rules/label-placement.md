---
type: Rule
title: Where labels collide
description: 'A label''s width hits the curve: park labels in the empty region, stack from getBBox, sub-labels 22-24 units under.'
tags:
- label
- collision
- getBBox
- sub
- placement
- overlap
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

A label's **width** is what hits a curve, not its anchor point. Two habits save
a screenshot round-trip each:

- Park a label in the empty region the curve leaves behind — under a rising
  segment, above a falling one — not beside the point it names.
- Text is in viewBox units, so it rescales with everything else; what breaks
  after an edit is a hand-typed width. Stack and pad from `getBBox()`, then let
  `figcheck.py` measure the frames with the most marks on screen.

Sub-labels (`.sub`) sit 22–24 units under their `.lbl`, never closer.
