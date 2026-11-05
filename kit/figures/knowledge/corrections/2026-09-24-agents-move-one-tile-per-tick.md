---
type: Correction
title: agents move 1 tile per tick is important
description: Smoothing a grid simulation changed its semantics; keep discrete cardinal tile steps and the source tick.
tags:
- simulation
- grid
- tick
- tile
- agents
- interpolation
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** adapting a grid simulation with smooth interpolated routes changed its movement semantics.
**Fix:** preserve discrete cardinal tile steps and the source tick interval; change styling independently. Verify integer positions and a Manhattan distance of at most one per tick.
