# Parallel agents on one deck

Several subagents each edit their own slides of one deck at the same time.
When the deck is open, the person watching sees each change land in the
editor, and each agent's name shows in the editor's tooltip.

## Why it is safe

`slide.py` turns every edit into compare-and-set patches addressed by id, down
to the element field (`slides/#s04/elements/#co-title/html`). In live mode the
editor's bridge applies requests one at a time, each all-or-nothing. Several
processes write the file: the editor's save (through the bridge), `slide.py`
(its write-through after a live edit, or a closed file), the compiler and
`land.py`. They all take one lock file, `build/.<deck>.html.lock`, so they
queue instead of clobbering each other. The consequences:

- Two agents on different slides, or on different elements of the same slide,
  never conflict.
- Two agents changing the same field: the second gets `conflict` and must
  re-read. Nothing is overwritten silently.
- Reordering, adding or deleting slides changes the shared slide list. Only
  the coordinator does that, and it does it before the agents start.

Measured with two headless agents pushing at once on a 26-slide, 4.9 MB deck:
both pushes landed in the open editor in about 1.1 s in total.

## Coordinator recipe (the main session)

1. **Connect.** Live (preferred, because the change is seen as it happens):
   the deck is open (it connects by itself) and `slide.py ls DECK.html`
   reports a live session ([editing.md](editing.md), "Live by default").
   Without a live editor, use the deck path as TARGET; everything below works
   the same.
2. **Plan the slides.** `slide.py ls TARGET`. Decide the final slide list.
3. **Do all structural work yourself, now:** `new --layout`, `copy`, `dup`,
   `move`, `rm`. Give new slides meaningful ids (`--id s07-market`) so the
   briefs can name them.
4. **Claim.** Run `slide.py claim TARGET s07-market s08-costs --agent market`
   for each agent. A push to another agent's slide is refused.
5. **Size the work (tokens).** A subagent re-reads the deck and shoots its
   slides, so it costs far more than the edit itself:
   - an edit of one to three commands (a title, notes, a `set`): the
     coordinator does it, no agent;
   - simple text slides: 2–3 per agent;
   - a figure, a rebuilt or a complex slide: one agent each.
6. **Brief and launch.** Launch all agents at once, in the background: one
   message holding every agent call, so they run concurrently. For each, fill
   in [reference/SLIDE_AGENT_BRIEF.md](reference/SLIDE_AGENT_BRIEF.md) with:
   the TARGET, the real path of `$T` (`{T}`), the agent name, its slide ids,
   the deck's accent colour and picture style, what each slide must say
   (content, sources, the material → element choice), and the deck README's
   standing rules. Each agent passes `--agent NAME` on every command (an
   `export` dies with its shell call, and the claim and the editor's tooltip
   go by that name). A smaller, cheaper model does text and layout slides well; keep the
   larger one for figures. Use at
   most 6 agents; above that the editor queue and review cost outgrow the
   gain. Every agent drafts first ([authoring.md](authoring.md), "Draft
   first").
7. **Watch, and land each result as it arrives.**
   - `slide.py who TARGET` shows the claims and the last pushes.
   - The editor or the live link is being watched, so **every agent's result
     goes into the deck the moment that agent reports**, never held for a
     batch at the end. A figure agent that wrote only `build/` files: save
     its spec block to a file and run `$T/land.py DECK.md --replace ID
     BLOCK.md` (or `--after`, `--delete`, `--ops`) right then ([editing.md](editing.md),
     "land.py"). With the deck open, `land.py` lands only the slides of that
     block, as patches (the block needs an `id:`); the rest of the deck, its
     docId and join code stay. An optional Stop hook,
     `$T/hooks/unlanded_figures.py` (wired in the checkout's
     `.claude/settings.json` for Claude Code; any harness with a stop hook can
     run it), refuses to end a turn while a built `fig-*.html` under
     `$TESSERA_DECKS` is not in its deck.
   - Don't poll in a loop: each background agent notifies you when it
     finishes.
8. **Close.**
   - Read each agent's report.
   - Run `shoot.py TARGET --id <all touched>` once and review the contact
     images yourself.
   - Fix cross-slide consistency (morph ids, repeated titles) with `slide.py`.
   - Release the claims: `slide.py claim TARGET … --release`.
9. **Spec-built deck:** the live deck is now ahead of its `.md`.
   - Port the changes back into the spec.
   - Recompile after the editor is closed.
   - Run `agent_live.py reconcile DECK --acknowledge`.
   - Or record in the deck README that the HTML is now the source.

## Figures and polls inside a parallel run

- **A figure agent** ([figures.md](figures.md),
  [reference/AGENT_BRIEF.md](reference/AGENT_BRIEF.md)) owns a page, not a
  slide: `build/figures/<name>.html`, served live by `live.py`.
  - The coordinator creates the embed slide first.
  - In live mode it does this by `copy`-ing a template embed slide, then
    `set … em-frame devSrc=http://127.0.0.1:5173/build/figures/NAME.html liveInEditor=true` (keep `asset`: the editor writes every save of the page into it).
  - The figure agent only writes its page. The open editor reloads the frame
    on every save.
- **A poll:** the coordinator adds it, with `deck_build.py add-poll` offline
  or by `copy`-ing `sl-poll` live (copy mints a fresh answer bucket for
  every copied poll). Never change an existing code.

## When an agent reports a conflict

It pulls again, redoes only the overlapping field, and pushes. If two agents
keep colliding, the claims were wrong. Stop one of them and re-split the work.
