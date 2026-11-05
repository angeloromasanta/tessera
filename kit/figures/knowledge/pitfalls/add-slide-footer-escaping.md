---
type: Pitfall
title: add-slide double-escaped the footer
description: deck_build.py add-slide produced &amp;amp; in the copied footer; copy the footer html from a neighbour afterwards.
tags:
- deck_build
- add-slide
- footer
- escape
- amp
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

`deck_build.py add-slide` double-escaped the copied footer (`&amp;amp;`):
copy the footer `html` from a neighbour verbatim afterwards.
