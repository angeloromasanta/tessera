---
type: Pitfall
title: Chrome cannot start its sandbox inside Codex's
description: shoot.py and figcheck.py retry with --no-sandbox after ~12 s by themselves; write no shims.
tags:
- chrome
- sandbox
- codex
- shoot
- figcheck
- no-sandbox
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

Chrome cannot start its sandbox inside Codex's: `shoot.py`/`figcheck.py`
retry with `--no-sandbox` after ~12 s. Don't write shims.
