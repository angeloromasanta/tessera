---
type: Spec
title: '`steps: morph`: one picture, N slides'
description: Two or three states of one picture as slides that morph into each other, and morphing between any two slides.
tags:
- morph
- steps
- gallery
- transition
- before after
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

The deck has no reveal-on-click *inside* a slide, so a build can become **N slides
that morph into each other** — the deck's arrow key drives the build as the
clicker did. Good for two or three states of one picture; for a real animation
prefer `embed`, which keeps it to one slide and actually tweens.

```md

## Morphing between two slides

Any two slides with the same `id` and `transition: morph` on the second tween
into each other. That is the cheap way to show a before/after of the same
figure without building a page.
