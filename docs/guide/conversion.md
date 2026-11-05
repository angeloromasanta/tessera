# Converting a PowerPoint deck

**Every diagram becomes an embedded
figure — including the ones pasted into the pptx as pictures.** Open every
exported picture; anything with boxes, arrows, axes or labels goes to
[figures.md](figures.md), never into an `image`/`gallery` block. And each
rebuilt slide lands in the open editor or live link as soon as it is ready,
not in one batch at the end ([editing.md](editing.md)). Anything past
conversion (editing the finished deck, figures, polls, pictures, publishing)
is the ordinary authoring in these pages.

Four passes. Only pass 2 (and the fix-ups in pass 4) spend tokens; the heavy
lifting — unzipping the deck, exporting images, replaying build animations,
guessing slide types, laying out elements, embedding assets — is python.

```
deck.pptx ──1──► deck.md (draft) ──2──► deck.md ──2.5──► ──3──► deck.html ──4──► shots/
            pptx_extract.py       (the agent edits text_audit.py  md_to_deck.py   shoot.py
            + media/ + .raw.md     it in place)    every word?
```

Pass 1 writes a **draft spec**, not a transcript: types already guessed, tables
and charts already complete, logos already dropped. Pass 2 edits that file in
place. Rewriting it from scratch is the expensive mistake — the draft is
usually 60–80% right, and the whole design is to make you pay only for the rest.

## Paths

```
$T/  pptx_extract.py   pass 1 — pptx -> draft spec + images
     pptx_draft.py     the type guesser (used by ^)
     pptx_timing.py    reads click-build animations (used by ^)
     pptx_render.py    draw a slide to PNG, to LOOK at it
     text_audit.py     pass 2.5 - every source word still there?
     md_to_deck.py     pass 3 — spec -> deck
     shoot.py          pass 4 — screenshots; embed posters
     slide.py          inspect or edit one slide of a compiled deck
     deck_build.py     add/update/remove an embed slide, add a poll
reference/SLIDE_SPEC.md   the spec format, and choosing a type
```

The spec, `build/media/` and the compiled deck live in `$DECK_DIR`. Call the
tools by path; never copy them into the deck folder.

## Before you start

**1. Python.** Besides the common check ([README.md](README.md)), this needs
`python-pptx`: `$PY -c "import pptx" || $PY -m pip install -q python-pptx`.

**2. A template.** A deck whose theme, fonts, logos and layouts every
generated slide is built from. `md_to_deck.py` defaults to `TESSERA_TEMPLATE`
(`$TESSERA/template.html` unless `.env` says otherwise) and **finds layouts by
role**: a layout whose id is the role or ends in `-<role>` (`points`,
`acme-points`) serves it. List a template's layouts with
`slide.py info TEMPLATE.html --section layouts`. A template missing a role a
spec slide needs compiles that slide broken: if the user's template lacks
one, say so (or add the layout) rather than producing garbage. Ask which
template to use if there is more than one candidate, or none.

The compiled deck gets a **new identity** (no `docId`, a fresh
`poll.session`, fresh poll codes), so it never syncs with the template or
steers its audience session. A note that the template is *not flagged
`template: true`* does not affect the compile
([reference/TEMPLATE.md](reference/TEMPLATE.md), "Template hygiene").

## Pass 1 — extract (no tokens)

```bash
$PY $T/pptx_extract.py deck.pptx \
    -o deck.md --media $DECK_DIR/build/media --raw $DECK_DIR/build/deck.raw.md [--first 1 --last 10]
```

Writes the draft spec (~230 bytes/slide) plus deduplicated image files, and
prints a summary: how many slides got each type, and which slides hold a vector
figure you will have to look at.

**Always** use `--first/--last` when the user asked for a subset.

**Always pass `--raw` too.** It writes the flat transcript - every shape, its
text and its `@x,y` - and it is the only complete record of what the deck says.
The draft is a guess layered on top of it that silently drops text the guesser
could not place, so pass 2 reconciles against the raw, not against the draft.
It costs about as much to read as the draft and saves re-reading it later.

## Pass 2 — edit the draft (the only pass that needs judgement)

Read [reference/SLIDE_SPEC.md](reference/SLIDE_SPEC.md), then read the draft and **edit it in
place**. Work slide by slide; leave alone what is already right.

The draft carries one comment line per slide — `<!-- 12 · build 3 clicks · 41
drawn (ellipse,rect) · 2 chrome dropped · 5 images unused -->`. The number is
the source slide. The rest is what the extractor knows and the draft could not
express:

| flag | what it means |
|---|---|
| `N drawn (kinds)` | shapes with no text and no exported picture. High, with no image on the slide, means a **vector infographic** — the transcript cannot show it to you |
| `? vector figure` | the above, flagged: render it and look |
| `build N clicks` | the slide reveals itself over clicks. Changes what you do **only** on infographics |
| `N chrome dropped` | repeated logos and page furniture, removed. The template supplies its own |
| `N images unused` | pictures the guess had no place for. Promote one if it carries meaning |

### The rule that outranks the rest: the words are not yours

**A conversion preserves the author's text. You are moving it, not editing it.**
This is the failure mode of this pass, it is invisible in the output, and it is
the one thing the user will notice. A tightened bullet, seven goals condensed
to six, a caption invented for a picture that never had one, a typo quietly
corrected -- each reads better and each replaces the author's deck with yours.

- **Copy every string verbatim**, including typos, inconsistent capitalisation,
  a stray `3.` at the start of a bullet, and notes-to-self the author left on a
  slide. They are the author's to fix, not yours. Say what you noticed in the
  handover instead.
- **One spec slide per source slide.** Do not merge near-duplicate slides, drop
  a blank one, or split one -- a build that reveals a list is still one slide.
  If a source slide genuinely cannot be expressed as one, say so explicitly.
- **Do not invent a title, heading or caption** for a slide that has none. A
  full-bleed picture with no words is a finished slide; it does not need a
  label you made up. `###` with no label stays unlabelled.
- **Keep every URL and citation.** They are set in tiny type at the foot of a
  source slide and they are easy to drop. `note:` renders one on any slide.
- **Speaker notes are the one place your own words belong** -- and even there,
  only what you can support from the source. Never assert an outside fact.

Rewriting is a *separate, explicit* request. When the user asks for a better
deck, rewrite freely. When they ask for a conversion, convert.

### The draft is lossy -- reconcile against the raw transcript

`pptx_draft.py` guesses a shape's role from its geometry and **drops the text
it cannot place**: a body sentence on a slide it typed as `points`, one of two
labels under a pair of images, a price sitting off-canvas. Those look like
nothing is wrong, because the draft is well-formed.

So never treat the draft as the record of what the deck says: edit with the
`--raw` transcript from pass 1 open. Then **prove it** before you compile. The audit reports every text run in the
pptx that is not in your spec, and exits non-zero until none are left:

```bash
$PY $T/text_audit.py deck.pptx deck.md
# deck.pptx -> deck.md: 290/290 text runs present (100.0%), 0 missing
```

It folds the differences a spec is allowed to have (curly quotes, `--` for an
em dash, case, whitespace) and recognises the one edit you must make -- PowerPoint
concatenates two placeholders with no separator ("Assistant ProfessorExample
Business School"), and splitting that back into two fields reports as `split`,
not as a loss. Anything else it calls MISSING is text you dropped.

### The rest of the pass

- **Fix the type where the guess is wrong.** It is one word on the `##` line.
  A wall of bullets is often a `compare`, `grid` or `chart`; a one-idea slide is
  a `statement`, not a one-bullet `content`. The table in SLIDE_SPEC.md decides.
  Changing the type is free -- it does not touch the words.
- **Check the ordering the draft could not see.** It emits images and labels in
  document order, which is not reading order. The raw transcript carries `@x,y`
  for every shape: use it to pair each label with the picture it sits under,
  and to put a left-to-right sequence in the order the audience reads it.
- **Check the front matter** -- `title`, `author`, `footer` come from the pptx's
  core properties and are often stale or empty.
- Image paths are bare filenames resolved against `media:`. Keep them that way.

Never invent facts that are not in the source. A caption you cannot support
from the deck is better left out.

### Look at a slide you cannot read from the draft

`pptx_extract.py` exports embedded pictures. A figure drawn from PowerPoint
*shapes* (ovals, connectors, arcs) exports nothing — the `? vector figure` flag.
Don't reconstruct it from coordinates. Render it and look:

```bash
$PY $T/pptx_render.py deck.pptx 52 -o $DECK_DIR/build/slide52.png
```

Approximate on purpose — curves become chords, effects are dropped — but enough
to see what the slide argues. On a slide with a build it draws the **end state**
(PowerPoint's dimming scrims exit on the last click, so drawing every shape at
once buries the artwork under them). `--all-shapes` overrides.

It is a reference to read, never a deliverable to embed.

### Slides that need a figure

**What the slide is made of decides this, not whether it animates.**

| slide is | signal | do this |
|---|---|---|
| **photos** | pictures **of things** (people, places, products, screenshots that are the point), whatever the build does | `image` / `gallery` / `points`, exactly as if it were static. **Ignore the build** |
| **bullets** | text, nothing drawn | `content`. Ignore the build |
| **an infographic** | `? vector figure`, or a high `drawn` count | render it, look, then build it as a figure ([figures.md](figures.md)) |
| **a pictured infographic** | a picture **of a diagram or chart**: a flowchart, decision tree, org chart, funnel, framework, matrix, process, table with sketches, a data chart | rebuild it as an embedded figure (data charts: digitize the values, keep the source line). **Never ship it as an `image`** |

**Open every exported picture before choosing its row.** The extractor cannot
tell a photo from a pasted diagram — both arrive as a PNG/JPG — so the draft
puts every picture in an `image`/`gallery` block. Make a contact sheet of
`build/media/` and look: anything with arrows, boxes, axes or labels is a
pictured infographic.

Photographs appearing one at a time are a transition, not an argument: the deck
gains nothing from reproducing it and a gallery reads better. In a typical deck
most builds are this. Do not reach for an embed just because a build is present.

For the infographics that do deserve it, [figures.md](figures.md) covers the
whole job — choosing between a live `embed`, a native `diagram` and `steps:
morph`, writing the figure, shooting its poster and slotting the block into
this spec.

## Pass 3 — compile (no tokens)

```bash
$PY $T/md_to_deck.py --check deck.md && $PY $T/md_to_deck.py deck.md -o deck.html
```

Deterministic: clones the template's JSON document, keeps its theme/fonts/
layouts/logos, instantiates one slide per `##` block, embeds every referenced
image as a data URI (downscaled to 1600 px and JPEG-ified when opaque — use
`--max-px 0` to keep originals). Text blocks are measured and shrunk to fit, so
you do not hand-place anything.

Warnings it prints (`! missing image`, `! unknown type`) are real — fix the spec.
Then `node $TESSERA/scripts/stamp-agent-notes.mjs deck.html`. The compiler
refuses while a live-source guard exists ([editing.md](editing.md), "Which
edit path").

## Pass 4 — look at it

```bash
$PY $T/shoot.py deck.html
```

Boots the deck in headless Chrome, enters slideshow mode, saves one PNG per
slide and a contact sheet per 12 slides (`contact-01.png`, …). **Read the
contact sheets** — a few images for the whole deck — and zoom into individual
`slide-NN.png` only where something looks wrong.

Check for: clipped or overflowing text, images cropped through their subject
(switch `fit: cover` → `contain`; on an `image` slide the panel then takes
the dominant colour of the picture's border ring, per [reference/TEMPLATE.md](reference/TEMPLATE.md)), a
table that ran past its box, a slide that is still a wall of bullets.

One judgement the screenshots cannot make for you: a photograph that is big
and sharp enough to carry the whole slide is wasted in a 640-wide half. Copy
the template's full-bleed image slide over it after compiling
(`slide.py copy deck.html sl-image-hero --after ID`, then `rm` the old
one); [reference/TEMPLATE.md](reference/TEMPLATE.md) has the conventions.

Fix by editing the spec and recompiling, then re-shoot **only what you
changed** — a second full pass over the deck buys nothing:

```bash
$PY $T/slide.py ls deck.html                  # slide ids
$PY $T/shoot.py deck.html --id ID,ID           # just those, no stepping
```

If the layout itself is at fault, fix the builder in `md_to_deck.py`, never the
generated HTML. To fix one slide in a deck whose spec is gone (or not worth a
recompile), use `slide.py` or `deck_build.py` ([editing.md](editing.md)).
