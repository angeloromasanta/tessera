---
type: Rule
title: 'Briefing figure agents: checklist'
description: 'What a per-figure brief must carry: closest example, page path, frame, every state and edge, step fields, carriers, check loop, handback.'
tags:
- agent
- brief
- codex
- subagent
- handback
- parallel
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

`AGENT_BRIEF.md` already carries the generic rules; the per-figure brief
(from `FIGURE_BRIEF.md`, written with the Write tool — a multi-file bash
heredoc once failed on a stray quote) needs:

- **The closest example**, and "read that one file only".
- **Its own page path** (`build/figures/NAME.html`); a first valid save
  within ~2 minutes, then a save per visible revision.
- **Theme and frame**, so it skips `info`: titled = 1280×500 frame, viewBox
  `0 0 1280 480`; full-bleed = 1280×720.
- **Every state** numbered (state 0 = on load) and **every edge** as
  `from-id → to-id: meaning`. The agent cannot know the argument.
- **The step fields** by name (`on`/`pose`/`cam`/`dim`/`do`, `spotlight`,
  `onto`, `stagger`), and that `fade-only` is a defect. Otherwise every beat
  fades.
- **Who carries each mark in**, what behaviour later clicks add, and an outro
  that loops seamlessly to state 0.
- **The check loop**: figcheck exit 0, then the final `step-NN.png` at full
  size. A contact sheet alone let four of six agents hand back "clean" figures
  with lines through labels.
- **Handback**: "N clicks (N+1 states)", one notes line per state, the
  figcheck summary line, the edge list as built.
- A dense diagram (decision tree) usually needs one more pass: lanes — main
  path on one row, terminals on another, every edge label in a white pill.
- For a redo, what was wrong with the old one, in the author's words.
