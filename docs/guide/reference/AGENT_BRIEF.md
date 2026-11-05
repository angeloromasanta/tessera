# Shared rules for every figure agent (read fully before starting)

<!-- Filled in by live_figures.py agent (Codex), or by the coordinator when it
     briefs a subagent: {NAME}, {DECK} (the deck .html path), {DECK_DIR},
     {T} (the tools folder) and {KIT} (the kit folder), all as real paths.
     Keep it generic; anything about one deck or one figure goes in the
     figure's brief. -->

You are building ONE animated figure for the deck `{DECK}`.
Your brief (below this shared part) says what the deck and audience are.
Other agents may be building other figures of the same deck *at the same
time*. Your figure's name is `{NAME}`. Every shell call is a fresh shell:
write each command in full, with the paths as given here.

## What you may touch
- ONLY your own figure file (named in your brief) under `{DECK_DIR}/build/figures/`,
  plus screenshots under `{DECK_DIR}/build/check/{NAME}/` and your poster
  `{DECK_DIR}/build/posters/{NAME}.png`.
- Do NOT edit the deck HTML, its `.md` spec, its `README.md`, any other figure,
  anything in the tools, the kit or the engine. Do not run git. Do not start
  or stop any server (the live server `live.py` is already running on port
  5173 - leave it alone).

## The person is watching you work, live
The deck is open in the editor, and your slide's canvas is an iframe on
`http://127.0.0.1:5173/build/figures/{NAME}.html`. The live server reloads it
every time you save, and the editor copies each save into the deck file. So
you **draft first** (this section is all of the rule you need):
1. Your file currently holds a placeholder. Within your first ~2 minutes,
   replace it: copy the starter `{KIT}/figures/figure.html` over your file
   and save a valid page showing the main regions / first state.
   Do not spend a long silent think computing coordinates first.
2. Then improve by small incremental edits (patch the content table, a
   constant, one group of marks). Save after every visible improvement.
   The same applies to every FEEDBACK ROUND: when feedback changes the layout,
   save a rough version of the new layout within ~2 minutes, then refine it.
   Nobody sees anything while you plan, and a silent 9-minute think looks
   like a stall.
3. The file must be a valid, rendering page after EVERY save. Never delete it,
   never leave it half-written, never write it to a temp name and swap.

## Read first (and nothing else)
This brief plus the starter are all you need. Past agents lost 10-15k tokens
each re-reading the documentation and the tools' source code.
- The starter `{KIT}/figures/figure.html`, in full. Its comments ARE the
  manual: palette tokens, type roles, motion classes (`rise`, `fromL`, `fly`,
  `draw`, `march`), `pose` / `cam` / `dim` / `do`, `spotlight`, `onto`,
  `stagger`, `pill`, the `FIT` re-measure rule. The step engine, dots and keys
  are written; reuse them and never rewrite them.
- At most ONE example from `{KIT}/figures/examples/`, the one your brief
  suggests.
- The knowledge base, only for a mark or step you need:
  `python {T}/kb.py search "<what you need>"`, then `kb.py get KEY` for the
  one or two entries that fit (mark code, routing rules, past corrections,
  harness pitfalls). Read-only for you: never `add`.
- Do NOT read the guide's pages, any skill or any tool's source. Run
  `TOOL --help` for a flag this brief doesn't show. If a tool fails, report the
  error in your handback instead of reverse-engineering it.
- In a feedback round, don't re-read the whole figure. `rg -n` for the ids or
  constants the feedback names, then read ~40 lines around them.

## Frame and house style (no need to inspect the deck)
- Titled embed: the slide already shows the title in a band above the frame,
  so do NOT repeat the slide title inside the figure. Frame is 1280x500; draw
  in `viewBox 0 0 1280 480`. Full-bleed (brief says so): 1280x720, same
  viewBox width, and pass `--size 1280x720` to both checks. White background
  unless the brief says otherwise.
- Colours: the starter's palette tokens only (`:root` custom properties, in JS
  `C.accent`, `C['amber-tint']`), never a typed hex. They carry the deck's
  template; if your brief gives another theme, it says which `:root` block to
  use. One accent for structure; supporting colours only separate categories.
  All figures of one deck must look like one family.
- Type: the starter's font stack and type roles (`.head`, `.lbl`, `.sub`,
  `.eyebrow`, `.callout`, `.big`). Label floor 18px (16 absolute minimum).
  Sentence case, no ALL-CAPS paragraphs.
- Flat, clean, editorial vector diagram in the palette (think a good
  newspaper explainer): not a web dashboard of pastel cards, no emoji, no
  drop-shadow soup, no illustration artwork (pictures are made separately,
  not as figures). Generous white space, one clear focal point per state,
  strong hierarchy.
- Motion: every click must MOVE something (grow, travel, fly, draw, zoom) -
  never fade-only. figcheck warns `fade-only`; treat it as a defect. Use the
  starter's step fields `on` / `pose` / `cam` / `dim` / `do` with `spotlight`,
  `onto`, `stagger`. Each mark is carried in by whatever causes it; a zoom
  grows the marks already there (dim the rest), never draws a new copy. Keep
  one loop running, and make the last click an outro back to state 0.
- Editable labels (mandatory): the deck editor lets people double-click a
  label in the figure and retype it. Every visible label carries
  `data-edit="KEY"` on the node holding the words (`<text>`, `<tspan>`, HTML
  element; plain text, no children), with a stable KEY (the mark's id or a
  readable name; a rebuild keeps every key). Labels built in JS read
  `T(KEY, 'default')` (the starter's `txt()` and `pill()` do it). A live value
  (counter, clock) gets `data-no-edit`. No label drawn on a canvas. See the
  starter's "EDITABLE TEXT" comment.
- The final state must also read as a standalone, self-explanatory image
  (it becomes the poster), so it must be complete and legible
  without a speaker.

## Checks (required before you finish)
```
python {T}/figcheck.py {DECK_DIR}/build/figures/{NAME}.html --deck {DECK}
python {T}/shoot.py {DECK_DIR}/build/figures/{NAME}.html --page --size 1280x500 --clicks all --out {DECK_DIR}/build/check/{NAME}
```
If your page is not a plain `viewBox` SVG and scales a stage to the frame itself
(`innerWidth / 1280`), it must skip a frame with no size and fit again later, or
the slide is blank when the slideshow starts on it. Run
`python {T}/fitguard.py {DECK_DIR}/build/figures/{NAME}.html`
(exit 0; `--fix` adds the guard).

figcheck must exit 0 and show no `no-edit` / `edit-leaf` warning (no
overlaps, no lines through labels, no fade-only, no page script errors: it
reports uncaught exceptions itself, so don't hand-roll a `node -e`/vm syntax
check). A warning your figure accepts ON PURPOSE (e.g. a timeline already
visible on load = `state0`, a deliberately compact figure = `coverage`) is
declared once in the page's head,
`<meta name="figcheck-allow" content="state0 coverage">`, and not re-argued in
every handback. Never use it for errors or for `fade-only`.
Then open ONLY the final `step-NN.png` at full size and look at it critically:
collisions, clipped text, labels too small, empty dead zones, anything a
designer would wince at. Fix and repeat. No contact sheets.
When clean, copy that final step PNG to `{DECK_DIR}/build/posters/{NAME}.png`.

## Hand back (your final message)
- "N clicks (N+1 states)", then one line per state for the speaker notes, the
  first spoken on load.
- The figcheck summary line.
- Anything you were unsure about (a label, a fact) so the coordinator can check.
- Lessons: anything you had to work out that a `kb.py search` did not answer,
  one line each (symptom, cause, fix). The coordinator records them.

## Environment notes
- If you run inside a sandbox (Codex's workspace-write, for one): shoot.py and
  figcheck.py start headless Chrome themselves, and retry with `--no-sandbox`
  when Chrome's own sandbox can't start inside yours (the first call can take
  ~15 s). Run them exactly as written. Do NOT wrap them in a
  Popen/--no-sandbox shim, and do not switch to another browser driver.
- Ambient motion that never stops (agents flying, a flow marching): figcheck and
  shoot measure after `--settle` seconds, so keep labels out of the moving marks'
  paths, and pass `--settle 3` to both if a state's build takes longer than
  ~1 s. Don't write your own timed screenshot script.
- Need a higher-resolution copy (print, a course page)? `shoot.py … --page
  --clicks last --scale 2 --out file.png` writes it at 2x.
- `{DECK_DIR}/build/figures/MANROPE` is the deck's text font, so the starter's
  `url(MANROPE)` resolves while you work: keep that @font-face line as it is.
