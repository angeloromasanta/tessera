---
type: Correction
title: it is not loaded to the slide and I need to present to show it
description: A failed liveInEditor step left the template's poster in the editor; re-run all of route A and check liveInEditor true.
tags:
- liveInEditor
- poster
- editor
- route A
- present
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

**Cause:** route A's first `set … liveInEditor=true` failed (two tabs open) and only the later bundle step (`asset= poster=`) was re-run, so the copied slide kept the template's default: poster in the editor, figure only in the show.
**Fix:** when a step of route A fails, re-run all of it; after bundling, `slide.py get DECK ID` must show `"liveInEditor": true` on `em-frame`.
