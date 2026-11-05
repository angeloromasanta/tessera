---
type: Correction
title: figures must move, not fade
description: Step vocabulary could only enter and exit; pose/dim/dead/sel/do became step fields and figcheck warns fade-only.
tags:
- fade-only
- motion
- pose
- step fields
status: deprecated
superseded_by: /recipes/pose.md
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** the step vocabulary could only say enter and exit, so the only motion
a figure could express was an entry direction. Seven steps across the showcase
were marks fading in, and the three figures that did move had each invented a
private mechanism — an invisible marker element with a CSS sibling combinator,
a bespoke `n:` field, per-id `:not(.on)` rules.
**Fix:** `pose` / `dim` / `dead` / `sel` / `do` are step fields the starter's
engine applies. See [pose](/recipes/pose.md); `figcheck` warns `fade-only` on the rest.
