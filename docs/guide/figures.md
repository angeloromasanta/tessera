# Building figures

One slide, one figure: an **`embed`** slide (a self-contained HTML page that
steps on click or takes controls) or a **`diagram`** slide (native shapes).
Input is usually a sentence, sometimes a reference image or a PowerPoint slide.
The starter, the examples and the knowledge base are in `$KIT/figures/`; the
agent briefs in [reference/](reference/). The `embed` element's fields:
[reference/agents.md](reference/agents.md), "embed".

**Not done until it runs in the deck, live.** The deliverable is the embed in
the deck — never the picture, the poster or a screenshot standing in for it —
running in the editor as well (`liveInEditor`; the compiler sets it for any
`page:` embed). Put it in the deck as soon as it is built, so it shows up in
the open editor or live link at once. A figure left in `build/` is not done.
A diagram that arrives as a picture (a pptx, a screenshot) is rebuilt as a
figure, never left as an image.

## Files

```
$KIT/figures/figure.html          starter for a click-stepped figure: step engine, dots, keys,
                                  palette tokens, type roles, motion classes, pose/cam helpers
$KIT/figures/examples/            finished figures by genre
$KIT/figures/knowledge/, $T/kb.py what earlier figures taught (recipes, rules, corrections, pitfalls)
reference/AGENT_BRIEF.md          shared brief for every figure agent (any harness)
reference/FIGURE_BRIEF.md         template for the per-figure brief
$T/figcheck.py  shoot.py  embed_font.py  live.py  live_figures.py  slide.py  deck_build.py  fitguard.py
```

Rings, self-drawing curves, bands, flows, glyph streams, boxes that grow,
label collisions, routing: **search the knowledge base for the mark and copy
the entry's code** (`$PY $T/kb.py search "<what you need>"`, then
`kb.py get KEY`), don't re-derive.

Where the files go (what the tools actually do):

| file | path | written by |
|---|---|---|
| figure source (edit this) | `$DECK_DIR/build/figures/NAME.html` | you / the agent; `live_figures.py open` makes a placeholder |
| bundled page (font inlined) | `$DECK_DIR/build/fig-NAME.html` | `embed_font.py build/figures/NAME.html --deck DECK.html`; `live_figures.py close` |
| checks | `$DECK_DIR/build/check/NAME/` | `shoot.py --clicks all` |
| poster, live/agent route | `$DECK_DIR/build/posters/NAME.png` | the agent (final `step-NN.png`), `live_figures.py` |
| poster, `deck_build.py` route | `$DECK_DIR/build/media/<page-stem>-poster.jpg` | `deck_build.py add-slide` auto-shot |

## Choose the form

| the figure | form |
|---|---|
| **changes over clicks**: a build, a process, a simulation, a curve drawing itself | `embed`, click-stepped (the starter) |
| something the audience should **drive**: a parameter, a simulation | `embed` with real controls (`examples/perceptron.html`: sliders + drag feed one `update()`, no `steps`) |
| a **stage tool**: a countdown for an exercise or a break | `embed` copied from `examples/timer.html` (dark, full-bleed), `timer-half.html` (right half of a content slide) or `timer-small.html` (a strip under bullets); set `DEFAULT_MIN` |
| **static** artwork: a framework, a 2×2, a schematic | `diagram` (native, editable) |
| two or three states of one picture, nothing between | `steps: morph` (N morphing slides) |
| numbers | not a figure: a `chart` slide |
| photos one by one / bullets one by one | a `gallery` / a `content` slide |

When in doubt: animated → `embed`; static → `diagram`. Spec blocks:
`kb.py get embed-block diagram-block morph-steps`.

## The flow

1. **Say what the picture claims.** One line per region (what it *is*, what
   containing its contents asserts) plus one for the whole. The claim is about
   **what contains what** and **what crosses what**. Show it, then build.
   `api-call` was built twice because the request was drawn as a floating
   panel wired to the model (saying the model assembles it); no motion saved
   it. figcheck measures layout, never meaning.
2. **Plan the states.** 4–8 states; one line you would *say* per state, or the
   state should not exist. State 0 shows on load; N clicks = N+1 states
   (`steps.length`); a click past the last wraps to state 0, the → key past
   the last leaves the slide. `notes:` has one line per state, the first
   spoken on load. Every arrow is `from-id → to-id: meaning`. **No captions in
   the figure** — the presenter narrates.
3. **Draft on the canvas within ~2 minutes** ([authoring.md](authoring.md),
   "Draft first"): the regions as plain boxes with one-word labels (each with
   its `data-edit` key from the first draft) at real positions in the real
   frame, no motion or styling. `cp $KIT/figures/figure.html
   $DECK_DIR/build/figures/NAME.html`, start `live.py`, put it on its slide
   (below), say which slide in one line, keep going.
4. **Iterate in passes**: layout → real marks and text → steps and motion →
   polish. Save a valid page after each visible change; patch the content
   table or one constant, never rewrite the file.
5. **Check** (below) until figcheck exits 0, then read the final state once
   at full size.
6. **Finish**: bundle the page and poster into the deck, notes one line per
   state, compare all the deck's figures side by side.

Checking the real theme: when the brief doesn't give it,
`slide.py info DECK --section theme` (small). Not `deck_build.py info`
(80–100 KB). A deck whose theme differs from the starter's gets its `:root`
block edited once.

## Motion rules

**Figures must move, not fade.** A figure whose every step is "another thing
fades in" is bullets with extra work. figcheck warns `fade-only` (marks enter
from nowhere, nothing on screen moved, camera still) — **a defect, not
advice**.

1. **Every step moves something with intent**: an annotation about the left
   comes in from the left; a total rises from its parts; a replacement grows
   out of what it replaces.
2. **Causation: each mark is carried in by an agent.** A cell that pops in
   with no carrier reads as decoration — the thing that causes the change
   brings its piece in (from off-screen, along a path). Later clicks add
   **behaviours** (removals, talking, meeting), not more of the same.
3. **Stagger a family, don't blink it**: `stagger(ids, ms)` sets
   `transitionDelay`, so it works forwards and backwards.
4. **A transform beats a swap**: the outgoing shape transforms and the
   incoming marks `fly` out of it.
5. **A zoom introduces no new marks; the camera pushes in and the subject
   grows from where it was.** "These few of many matter" = the marks already
   on screen swell in place and the rest dim: `pose: spotlight(ids, 2.5)` +
   `dim: [crowd]`. Never a fresh bigger copy elsewhere. The label arrives at
   the end of the move. The camera (`cam`) is for "the same picture nearer"
   when nothing rearranges — it throws away the crowd. Worked:
   `kb.py get zoom-as-spotlight camera-or-relayout`. Pick highlighted marks by
   hand, scattered.
6. **Loop.** Keep one continuous motion running so the slide is never dead
   (`march`, `breathe`, agents moving). The last click plays an **outro that
   returns seamlessly to state 0** — figures get restarted live, and a jump
   cut looks broken. Keep the `prefers-reduced-motion` block.

**A step is an object**, not a list of ids:

| field | expresses |
|---|---|
| `on` | which marks are visible (enter / exit) |
| `pose` | `{id: {x, y, s, r}}` — offsets in viewBox units from the authored place, scale, degrees; a value may be a function (measured at step time) |
| `cam` | `() => camFit(['id', …])` — the rect to frame; never a typed rect |
| `dim` `dead` `sel` | the same marks re-read (receded, failed, chosen) |
| `do` | `(s) => {…}` anything else: a box height, a counter, which flows run |

Helpers: `spotlight(ids, s)`, `onto(id, toId)` (offset landing one centre on
another), `stagger(ids, ms)`. **Pose marks already on screen; an entering mark
gets its direction from a class** beside `.el`: `rise`/`fall`, `fromL`/`fromR`,
`pop`, `draw` (path draws itself), `fly` (out of a point: `--dx`/`--dy` back to
its origin), `march` (endless dashes), `breathe` (endless pulse).

| figcheck says | fix |
|---|---|
| `fade-only` | give the entering mark a class, or `pose` something on screen, or move `cam` |
| `still` | a `dim`/`dead`/`sel` re-read (fine; `kb.py get three-state-engine`) or delete the step |
| `off-camera` | `cam: () => camFit([ids of the beat])` |
| `coverage` | drawing doesn't fill the frame: rescale from the constants |
| `state0` | state 0 should be empty or frame-only unless `notes:` narrates it |
| `no-edit` | `data-edit="KEY"` on the label's own node (JS: `txt()` / `T()`); a live value gets `data-no-edit` ("Editable labels") |
| `edit-leaf` | move the key down to each `<tspan>` / child that holds words |

## One family

All figures of a deck are **one family**. `figcheck.py --deck DECK.html`
lints drift; before calling the deck done, look at every figure's poster side
by side (same header size, card fill, legend style).

The shipped starter, examples and engagement pages carry the default template's palette. The tools that build
one into a deck (`make_lab.py`, `make_game.py`, `make_guess.py`, `make_remix.py`) swap those colours for the
target deck's theme (`deckio.recolor`: a value-for-value swap, driven by `theme.tokens` if the template declares
one, else by `theme.accent`, `theme.color` and `theme.chartPalette`). A figure you write by hand copies the
starter's tokens and, if the deck's theme differs, changes them once in its `:root`.

- **Palette tokens, never a typed hex**: the starter's `:root` custom
  properties, in JS as `C.accent`, `C['amber-tint']`. A deliberate off-token
  colour (a computed ramp) goes in
  `<meta name="figcheck-palette" content="#…">`. One accent for structure;
  supporting colours only separate categories.
- **The font is inlined at bundle time**: sources declare
  `@font-face{font-family:Manrope;font-weight:200 800;src:url(MANROPE) format('woff2')}`;
  `embed_font.py` writes the bundled `build/fig-NAME.html` with the deck's
  font. You edit the source; figcheck errors when the font never loaded.
- **Type roles, not sizes**: the starter's classes (`.head`, `.eyebrow`,
  `.axis`, `.lbl`, `.sub`, `.callout`, `.big`, `on-dark`) set size, weight and
  colour, so two figures that use the same role match. Label floor 18 px
  (16 absolute); monospace only for code and file names.
- **One typeface** for every figure of the deck, the deck's body face,
  inlined (above).
- The concrete look (which tokens, which sizes per role, card fill, strokes)
  belongs to the template or the brand: the starter's `:root` block carries
  the bundled template's, and a brand overrides that block once for every
  figure. `figcheck.py` falls back to the deck's own theme for the palette
  when a page declares none.
- **A figure copied from another deck is re-tokened** before it ships: its
  `:root` block replaced by this deck's, every typed hex mapped to a token,
  its type mapped onto the roles. `figcheck --deck` flags what was missed.

## Building rules

- **Every label is editable — mandatory.** The deck editor lets anyone
  double-click a label inside the figure and retype it, without touching the
  page. That works only for text the page declares (**Editable labels**):
  - `data-edit="KEY"` on the node that **holds the words itself** — the SVG
    `<text>`, `<tspan>` or `<textPath>`, or the HTML element — plain text, no
    child elements. A two-line label is two `<tspan>`s with a key each.
  - **KEY is stable**: a rebuild, a restyle or a re-layout keeps every key, or
    the person's wording silently falls off. Use the mark's id or a readable
    name (`n1`, `axis-x`, `n2-1`/`n2-2`). A key on two nodes is one label
    shown twice — so the same words in several steps get ONE key, and an
    edit shows in every step.
  - **Clicks stay plain.** On the edit canvas a **double-click** edits a
    label and a **single click** steps the figure after 260 ms (other clicks
    step at once); the deck tells them apart by itself, so a figure needs no
    click guard of its own.
  - **Text a script writes reads `T(KEY, 'default')`**, the starter's guarded
    wrapper of `TESSERA_EMBED.text` (absent when the page runs on its own, so it
    falls back to the default). The starter's `txt()` and `pill()` do both.
  - Re-measuring layout goes on `FIT`; the starter sets
    `window.TESSERA_REFIT = refit`, which the editor calls after each edit.
  - Not a label (a live counter, a clock, a value a slider computes):
    `data-no-edit`. **Never draw a label on a canvas** — canvas text cannot be
    edited.
  - The edits live on the embed element as `texts: {KEY: value}`, never in the
    page. **Re-embedding or recompiling keeps them; never strip `texts`** from
    an element. A spec `## embed` block may pin them as one-line JSON,
    `texts: {"n1": "Lower prices"}`; a recompile also carries over the
    editor's edits by slide and element id. The same contract covers the
    engagement pages ([engagement.md](engagement.md), "Wording").
  - figcheck warns `no-edit` (visible text without a key) and `edit-leaf` (a
    key on a node that also holds elements, so an edit would wipe them).
- **Every mark exists from the start** with `class="el"` and a stable id;
  steps toggle `.on`, the browser tweens. An id present in consecutive steps
  stays on screen. Axes and frames omit `.el`.
- **No slide title inside the figure.** The slide's own title element
  carries it, in the band above the frame; a heading repeated inside the page
  wastes the frame and drifts from the title when either is edited. A
  full-bleed figure with no title element may draw a header (`.head`).
- **Frame = viewBox aspect.** Titled embed: frame 1280×500 under the title
  band → draw in `viewBox 0 0 1280 480`. Full-bleed (no `title:`): frame and
  viewBox **1280×720**. A mismatch letterboxes. 1 unit ≈ 1 slide px.
- **Never scale the page to the frame by hand without a zero-size guard.** An SVG
  with a `viewBox` needs no scaling and is always safe. A page that instead does
  `scale(innerWidth / 1280)` (a canvas or HTML stage: timers, games, walls) is
  **blank when the slideshow starts on its slide**: the frame runs the script
  before it has a size, the scale becomes 0, and no resize event follows. It
  works in the editor and when the show starts on an earlier slide, so no shot
  catches it. Skip a zero size and fit again on `load`, a `ResizeObserver` and a
  1 s timer (copy `fit()` from `examples/timer.html`). Check with
  `$PY $T/fitguard.py FILE.html` (`--deck DECK.html --fix` repairs a deck's
  pages); `slide.py doctor` reports it too.
- **Measure, never type widths**: `pill(id, text, x, y, {anchor, color})`
  sizes a label from `getBBox()`; layers paint links → shapes → labels.
  **Never measure once**: the frame loads hidden (text 0 wide) and fonts land
  late, so wrap every `getBBox` layout in a function on the starter's `FIT`
  list. Skipping it shows only when someone clicks quickly — no shot catches it.
- **Geometry in constants / a content table**, marks generated from it; every
  figure gets rescaled once. Words go in cards; arrows short, in empty lanes.
- **Self-contained**: inline CSS/JS, no CDN, no fetch. Works offline.
- The starter's engine block (`/* engine */`, the clamped key handler,
  `window.TESSERA_STEPPED`) is copied verbatim, never retyped.
- A mark that crosses something on purpose: `data-figcheck="ignore"`.

## Check

```bash
$PY $T/figcheck.py $DECK_DIR/build/figures/NAME.html --size 1280x500 --deck DECK.html   # must exit 0
$PY $T/shoot.py $DECK_DIR/build/figures/NAME.html --page --size 1280x500 \
    --clicks all --out $DECK_DIR/build/check/NAME                                 # "N states -> clicks 0..N-1"
```

figcheck (text) after every fix; **one image** when clean — the final
`step-NN.png` at full size (the frame with most marks). No contact sheets per
fix. Deliberate warnings: `<meta name="figcheck-allow" content="state0 coverage">`
(never for errors or `fade-only`). Screenshots show resting states only —
`kb.py get seeing-motion` for `--settle 0.28` shots. A controls
figure: `--clicks 0`. Full-bleed: `--size 1280x720`. Poster:
`shoot.py … --page --clicks last --out …` (`--scale 2` for print). Never
shoot an embed slide with `shoot.py --only N` (it stalls); use
`shoot.py DECK --id ID`.

## Getting it onto a slide

First check the edit path ([editing.md](editing.md)): **is the deck open
live** — does `slide.py ls DECK.html` report a live session, or does
`$DECK_DIR/build/<deck>.html.live-source.json` exist? Start the page server once
per task, outside the sandbox: `$PY $T/live.py start $DECK_DIR` (port
5173; a save reloads just that frame in the open editor). Whoever watches
should **stay in edit mode** (no F5: the slide arrives live). The deck file
carries each figure's page all along (`devSrc` is only the edit-canvas view);
`slide.py doctor DECK` lists any figure that is not in the file.

### A. Deck open live (or the guard exists)

`live_figures.py open/close` and `deck_build.py add-slide/update-slide` are
**refused** (they recompile or write the file). Never delete the guard. The
coordinator uses `slide.py … live`:

```bash
# 1. the slide: a copy of the template's embed slide, pointed at the live page
$PY $T/slide.py copy live sl-embed --id NAME --after PREV_ID
$PY $T/slide.py text live NAME co-title "Slide title"
$PY $T/slide.py set live NAME em-frame devSrc=http://127.0.0.1:5173/build/figures/NAME.html liveInEditor=true
#    `devSrc` runs the source on the edit canvas only. Keep `asset`: the open
#    editor copies every save of the page into it (font inlined), so the slide
#    is always in the file, and a copy, the show or a published deck never
#    depends on this machine. Never `asset=` and never a loopback `src=`.
# 2. when accepted: drop the live address and set the poster
$PY $T/slide.py bake live --final          # page into the file one last time, devSrc removed
$PY $T/slide.py asset live img-NAME-poster $DECK_DIR/build/posters/NAME.png
$PY $T/slide.py set live NAME em-frame poster=asset:img-NAME-poster
$PY $T/slide.py notes live NAME "…one line per state…"
```

The embed element is `em-frame` with fields `asset` (page key), `src`,
`poster` (`asset:KEY`), `liveInEditor`, `zoom`, `sandbox`, and `texts` (the
label edits people made; keep it whenever you replace or re-point the page)
(`slide.py get $TESSERA/template.html sl-embed`). Set `liveInEditor: true`
on every figure embed: without it the editor shows the poster image, not the page. The copied slide still
carries the template's adoption-curve poster until step 2 replaces it. For a
full-bleed figure: `set … em-frame x=0 y=0 w=1280 h=720`, and drop
`co-title` via `slide.py pull`, delete its line, `push`.
After the session, reconcile into the spec ([editing.md](editing.md)).

### B. Deck compiled from a spec, not open live

The spec is the source: an `## embed` block (`kb.py get embed-block`), recompiled.
`live_figures.py` automates the live-draft loop (run from the repo root,
`S=$DECK_DIR/deck.md`):

| step | command |
|---|---|
| open | `live_figures.py open $S NAME="Slide title" …` — creates `build/figures/NAME.html` + a placeholder poster in `build/posters/`, points the block at the live server, recompiles, runs `live.py start`. `--after "<title>"` creates missing slides; `--convert` turns a points/table slide into an embed |
| agent | `live_figures.py agent $S NAME --brief $DECK_DIR/build/agents/NAME.md` — one Codex agent per figure, backgrounded |
| status | `live_figures.py status $S` — running?, seconds since last save, handback, LIVE slides |
| stop | `live_figures.py stop $S NAME`, edit the brief, `agent` again (Codex takes no mid-run messages) |
| revise | `live_figures.py revise $S NAME --feedback …/NAME.fbN.md [--image ref.png]` — resumes the session with the poster attached; from round 3 or on a change of direction add **`--fresh`** (a resume re-sends all history: 330k tokens by round 5) |
| close | `live_figures.py close $S` — `embed_font` → `build/fig-NAME.html`, block → `page:`, recompiles. **Run before the session ends**, even with a revision pending; `open` again is cheap |
| stats | `live_figures.py stats $S` — tokens, commands, failures; a command repeated across agents is a harness gap: fix the tool, not the brief |

The spec's poster for an embed must be shot at the frame size (1280×500
titled, 1280×720 full-bleed) or it letterboxes.

### C. Deck file with no spec, not open live

`deck_build.py add-slide DECK.html --page $DECK_DIR/build/fig-NAME.html
--live --title "…" --notes-file n.txt` (auto-poster to `build/media/`);
`update-slide --id …` to iterate, never a second `add-slide`. For a live
draft: add the slide with `--page`, then
`slide.py set DECK.html ID em-frame devSrc=http://127.0.0.1:5173/build/figures/NAME.html`
and `slide.py bake DECK.html` after each round (`--final` when done). Flags and pitfalls:
`kb.py get deck-embed-slide`. Or use route A's `slide.py` commands on the
file path instead of `live`.

## Parallel figures: agents

Each agent owns **one page** (`build/figures/NAME.html`), never the deck;
only the coordinator creates slides, bundles and edits notes, so saves never
collide. Brief = [reference/AGENT_BRIEF.md](reference/AGENT_BRIEF.md) (generic: own file only,
visible save within 2 min, never a broken page, house style, checks, handback)
+ a per-figure brief from [reference/FIGURE_BRIEF.md](reference/FIGURE_BRIEF.md) (claim, visual, data, every state,
who carries each mark in). What goes in it: `kb.py get briefing-figure-agents`.

- **Subagents** of the coordinating session: all launched at once, in the
  background; the prompt is AGENT_BRIEF.md with `{NAME}`, `{DECK}`,
  `{DECK_DIR}`, `{T}` and `{KIT}` filled in (real paths: a fresh shell has no
  variables), followed by the figure brief. Launch them in one message so they
  run concurrently. Works in any route
  (A–C); the coordinator makes the slides first.
- **Codex**: `live_figures.py agent` (route B), which sends both briefs itself.

**Review every handback yourself**: agents hand back figcheck-clean figures
whose meaning is off (an arrow from the wrong place, labels drifting, a peak
on the back rim). Read the final poster at full size; budget one fix round per
figure.

**Cost.** Six agents cost ~100–160k tokens each; for two or three figures,
building them yourself is often cheaper. Most waste is one long silent think
over coordinates — draft in 2 minutes, `cp` + Edit, figcheck before any image,
one example only. Audit table and harness pitfalls:
`kb.py search -t pitfall <symptom>`.

## Working from a source

- **A description**: invent nothing factual; ask for *their* data.
- **A reference image**: match the argument and composition, not pixels.
- **A PowerPoint slide**: `$PY $T/pptx_render.py
  deck.pptx 52 -o $DECK_DIR/build/slide52.png`, then reconstruct the idea
  (approximate colours, positions, fewer steps). Dense slides: render the PDF
  export with PyMuPDF instead.
- **Last year's deck**: brief from last year's slide (the deck README lists
  it).

## The knowledge base: find first, learn after

What earlier figures taught lives in `$KIT/figures/knowledge/`: plain
Markdown, one concept per file
([OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format) v0.2:
YAML front matter with a `type`, reviewed in git). `$T/kb.py` searches it with
SQLite FTS5, built in memory on every call, so there is no index to go stale.
Finished figures by genre are in `$KIT/figures/examples/`
(`kb.py search -t example <genre>`). `kb.py --help` has every command.

The shipped knowledge base is public: an entry you add there is written for
anyone (no people's names, courses, brands or private paths). To keep a
private one, point `TESSERA_KB` at your own folder of the same shape.

| type | folder | holds |
|---|---|---|
| `Recipe` | `recipes/` | mark or step code worth copying (a ring of nodes, a glyph stream, a pose) |
| `Rule` | `rules/` | a lesson several corrections shared (routing, label placement, briefing agents) |
| `Correction` | `corrections/` | one mistake the author had to point out: the symptom in their words, the cause, the fix |
| `Pitfall` | `pitfalls/` | a harness or tool trap (a flag that stalls, a sandbox that will not start) |
| `Spec` | `specs/` | the spec blocks for figure slides (`## embed`, `## diagram`, `steps: morph`) |
| `Example` | `examples/` | one card per file in `$KIT/figures/examples/` and what is worth stealing from it |

- **Find first.** Before building a mark or a step you have not built this
  session: `$PY $T/kb.py search "<what you need, in plain words>"`, then
  `kb.py get KEY` for the one or two entries that fit. A Correction that turns
  up is a mistake already made once: read it.
- **Learn after a second round.** When a figure needed one (the author asked
  for a change, or a check made you reason instead of look up):
  `kb.py add Correction "<symptom, in the author's words>" --cause "…" --fix "…" --tags a,b`.
  It lands as `draft`. `add` lists similar entries first: if one already
  covers it, **edit that file** instead of adding a near-copy.
- **Draft → verified.** A draft is a proposal. Agents propose; **the author
  approves**: show the entry, and when they confirm, `kb.py verify KEY` (a
  human review marks it `stable` and human-reviewed). `kb.py lint` lists the
  drafts still waiting.
- **Consolidate.** `kb.py lint` also reports near-duplicates and broken
  links. Write the lesson into the entry it belongs to (edit the file), then
  `kb.py retire CORRECTION --into KEY`; or, when several corrections share a
  cause, write one rule over them: `kb.py add Rule "Title" --description "…"
  --body-file rule.md --supersedes corrections/a,corrections/b`. Superseded
  entries stay on disk (`status: deprecated`) and drop out of search.
- **Recipe or Pitfall.** New mark code worth copying is a `Recipe`; a trap in
  the harness or a tool is a `Pitfall`.
- **What goes where.** A rule that must hold for **every** figure goes in this
  page, not the knowledge base: search only helps an agent that thinks to
  look. A one-off content correction (this deck's labels, a fact) goes in the
  deck's `README.md`. Figure agents never write to the knowledge base: they
  report lessons in their handback, and the coordinator records them.
