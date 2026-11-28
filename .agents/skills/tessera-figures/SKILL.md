---
name: tessera-figures
description: 'Build one tessera slide carrying an infographic: an animated or interactive HTML figure that steps on click (a process that builds up, a cycle, a hype curve, a network, a simulation), a stage tool such as a countdown timer, or a static vector diagram. Works from a description, a reference image, or a PowerPoint slide whose diagram arrived as a picture. Use when asked for an infographic, to animate a slide, visualize a concept, add a simulation, interactive figure or timer, or rebuild a pictured diagram.'
---

# Infographics and figures

**The method is `$GUIDE/figures.md`**: choosing the form, the flow (claim,
states, draft, passes, check), the motion rules, one family per deck,
editable labels, the checks (`figcheck.py`, `shoot.py`), getting the figure
onto its slide, and figure agents. Paths, setup and the general rules: the
`tessera` skill. Without the tools (no git or Node, or a chat), the
`tessera` skill's `without-tools.md`, section 7, has a builder that wraps your
marks and steps into the working figure page.

## Before you build

1. **Pick the form** (`$GUIDE/figures.md`, "Choose the form"): changes over
   clicks or driven by the audience → an `embed` figure; static artwork (a
   framework, a 2x2, a schematic) → native shapes on the slide; numbers → a
   `chart`, not a figure.
2. **Say the claim** in one line per region, plus one for the whole: what
   contains what, what crosses what. Show it to the person when the meaning
   is in doubt; a figure drawn on the wrong claim is rebuilt from scratch.
3. **Search the knowledge base before inventing a mark**:
   `$PY $T/kb.py search "<what you need>"`, then `kb.py get KEY`. Rings,
   self-drawing curves, flows, routing and label collisions are solved there.
   Finished examples by genre are in `$KIT/figures/examples/`.

## While you build

- **Block it out on the slide within a couple of minutes**: a ~15-line spec
  to `$T/blockout.py` draws every state as dashed boxes, circles and arrows
  with one-word labels at real positions (`$GUIDE/figures.md`, "Blockout").
  Say which slide it is on, then refine that file region by region (one
  Edit per region, saving each), never in one rewrite; `--strip` last.
  The person watching should stay in edit mode.
- **The look comes from the deck**: copy the starter's `:root` tokens, then
  replace them with the deck's figure family when the template defines one
  (its agent notes, "FIGURE STYLE", or a brand skill). Never a typed hex.
- **Every step moves something** (travel, draw-on, swell, a mark carried in
  by the thing that causes it); a step where things only fade in is a defect
  (`figcheck` says `fade-only`).
- **Every label is editable** (`data-edit="KEY"`, stable keys), and there is
  no slide title inside the figure.

## Done means

`figcheck.py` exits 0 (no `draft`), the final state is read once at full size, the figure
runs in the deck (in the editor too, `liveInEditor`), it has a poster, and the
slide's speaker notes carry one sentence per state. Compare all of a deck's
figures side by side before calling the deck done.
