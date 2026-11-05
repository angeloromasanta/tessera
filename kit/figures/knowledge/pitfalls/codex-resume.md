---
type: Pitfall
title: 'Codex resume: silent planning and sandbox flags'
description: A resumed agent plans silently, so revise asks for a rough version in ~2 minutes; resume takes no -s, so revise passes sandbox_mode.
tags:
- codex
- resume
- revise
- sandbox
- workspace-write
- oauth
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

A resumed agent plans silently (9 min once): `revise` prefixes a "rough
version within ~2 minutes" reminder.

Codex: `-s workspace-write` (auto-mode refuses `danger-full-access`);
`codex exec resume` takes no `-s`, so `revise` passes
`-c sandbox_mode="workspace-write"`. OAuth "refresh token" log errors come
from Codex's own MCP servers and are harmless.
