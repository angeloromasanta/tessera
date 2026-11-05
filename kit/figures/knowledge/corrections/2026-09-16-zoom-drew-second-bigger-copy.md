---
type: Correction
title: the zoom drew a second, bigger copy somewhere else
description: The camera was used to mean 'these few matter' and threw away the crowd; spotlight in place and dim the rest.
tags:
- zoom
- camera
- spotlight
- copy
- crowd
status: deprecated
superseded_by: /recipes/zoom-as-spotlight.md
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** reaching for the camera to mean "these few of the many matter". A
camera pushes the crowd off-frame, and the crowd was the argument.
**Fix:** `pose: spotlight(ids, 2.5)` with `dim:` on the crowd — the chosen
marks swell in place and nothing new is drawn. The camera is for a turn of the
head, when the layout does not change. Table in [camera or relayout](/recipes/camera-or-relayout.md).
