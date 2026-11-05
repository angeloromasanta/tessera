---
type: Pitfall
title: Where figure-agent tokens go
description: 'Six-agent audit: silent coordinate thinking, retyped engines, reading every doc, info dumps, contact sheets, whole-file rewrites; and the shortcut for each.'
tags:
- tokens
- cost
- agent
- codex
- audit
- resume
- fresh
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

Agents spent 10–15 commands and ~10k tokens each reading the old 44 KB
SKILL.md and tool source. AGENT_BRIEF forbids both; keep it self-sufficient
when a rule here changes.

| cost | shortcut |
|---|---|
| one silent 5–8 min think (100–150 KB) placing coordinates | write a rough draft within ~2 min; let figcheck find clearances |
| retyping the step engine | `cp` the starter, **Edit** content + `steps`; never `Write` the whole file |
| reading every doc and example | the skill's core + **one** example; `kb.py search` the topic, `get` one entry |
| `deck_build.py info` (80–100 KB) | the brief states theme + frame; else `slide.py info --section theme` |
| 7–8-frame contact sheets re-shot per fix, crop scripts | figcheck (text) per fix; one full-size final image when clean |
| whole-file rewrite per feedback round | patch the content table or a constant |
| hand-typed label widths | `getBBox()` inside a `FIT` function |
| camera rects typed as numbers | `cam: () => camFit([ids])` |
| re-reading your own file after Edit | don't; Edit fails loudly |

Six Sonnet agents cost ~100–160k tokens each plus a revision round. For two or
three figures, building them yourself is often cheaper (you hold the context).
A resumed Codex session re-sends its whole history (the roadmap's 5th round ran
at 330k tokens): use `revise --fresh` from round 3.
