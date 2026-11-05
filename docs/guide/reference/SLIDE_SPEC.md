# Slide spec format

The intermediate format between a PowerPoint deck (or a written outline) and a
tessera/slides HTML file. `$T/md_to_deck.py` compiles it deterministically
against a template (`TESSERA_TEMPLATE`, by default `$TESSERA/template.html`;
no `-t` needed), so the spec only ever carries **content and slide type** — never
coordinates, fonts or colours. Those come from the template's layouts.

`pptx_extract.py` writes a first draft of this file; pass 2 edits it in place.

## File shape

```md
---
title: Exponential Organizations     # deck title ({{title}} token)
author: Jane Doe                     # {{author}}
company: Example Business School     # {{company}}
subject: Course overview
footer: Exponential Organizations    # printed bottom-left on every slide
media: build/media                   # search root for bare image filenames
                                     # (spec paths are relative to the SPEC file,
                                     #  which lives in $DECK_DIR — so this is
                                     #  $DECK_DIR/build/media)
---

## <type>
key: value
- bullet
  - sub-bullet
### Sub-block heading
key: value
- bullet
```

Rules the parser follows:

- `## <type>` opens a slide. One per source slide unless you deliberately split.
- `key: value` sets a field on the current slide (or sub-block). Only keys from
  the known list are treated as fields — any other line is prose and gets
  appended to the previous field, so a sentence containing a colon is safe.
- `- item` is a bullet; two-space indent makes it a sub-bullet of the one above.
- `### Heading` opens a sub-block (a column, quadrant, card or comparison side).
  Bare `###` opens one with no label — a gallery frame with no caption.
- `| a | b |` rows build a table; the `|---|` separator row is optional. In a
  cell, `` `cmd` `` is a command chip, `[[Demo]]` a soft tag and `[[!Lab]]` a
  filled one; a column holding only tags is right-aligned by itself.
- `series Name: 1 | 2 | 3` supplies chart data.
- `<!-- … -->` is a comment and is skipped. The draft's flags live in these.
- Inline `**bold**` and `*italic*` work; `--` becomes an em dash. `` `code` ``
  becomes a code span, left exactly as typed. A bullet or sub-bullet that is
  **only** a code span (`  - `` `pip install x` ``) compiles to a code block
  under the bullet above it; several in a row join into one block.

## Three ways to lose text silently — read this before writing a spec

Each of these compiles without a murmur and the text simply is not on the
slide. **`md_to_deck.py --check spec.md` catches all three**; run it before
every compile, and again after any hand-edit.

**1. A bullet is ONE line.** A wrapped continuation is not part of the bullet —
it is prose, so it lands in the slide's `body`, which most builders ignore.

```md
- Seven models via OpenRouter: ChatGPT, GPT-5, Gemini,     ← the bullet
  Claude, DeepSeek, Grok, Mistral.                         ← GONE
```

Write the whole bullet on one line however long it is, or split it into two
bullets. (`key: value` fields are different — `notes:`, `caption:`, `note:` and
friends *may* wrap, because the parser keeps appending to the field it is on.)

**2. Slide-level fields go BEFORE the first `###`.** After a `###`, every field
attaches to that sub-block. `notes:` written under the last column of a
`compare` slide becomes the column's notes and the slide gets none.

```md
## gallery
title: Every model leans the same way
notes: …                    ← here: the slide's notes
###
image: figs/baseline.png
caption: …                  ← here: the sub-block's caption. Correct.
notes: …                    ← here: silently the sub-block's. WRONG.
```

**3. Inside a wrapped value, no line may start with a KNOWN key.** The parser
sees a new field and abandons the one it was filling. Only names on the known
list do this — `tension: 44% on centralization` is safe prose, but `note:`,
`question:`, `title:`, `max:`, `side:`, `code:`, `phone:`, `screen:` and the rest of the list are
not, and they are ordinary ways to start an English sentence in `notes:`:

```md
notes: Two things to press on.
  Question: did the recommendation actually move?   ← starts a `question` field
```

Reword, or pull the colon off the line start (`Ask whether the recommendation
actually moved.`). `--check` flags it.

**Prose after a one-token field is the body, not a continuation.** `fit:`,
`image:`, `side:`, `code:`, `kind:`, `page:`, `screen:`, `phone:`, `poster:` and the other fields
that hold a single token never wrap, so a card's text written straight after
`fit: contain` becomes the block's `body`. (Before this rule the parser glued
it onto `fit`, the value was no longer `contain`, and the card compiled with
no text at all — silently.) Fields that hold sentences — `notes:`, `caption:`,
`body:`, `question:` — still wrap. When in doubt write `body:` explicitly.

**A `content` slide is one text box.** Every bullet becomes a `• ` line in a
single `co-body` element; the renderer draws the marker, the hanging indent and
the gap between items, and a sub-bullet (two-space indent in the spec) becomes a
second level. The compiler shrinks the whole list's type from 24px until it
fits, so a long list comes out smaller rather than clipped — if it drops much
below ~18px, split the slide. `compare` bodies and every other `- ` list render
the same way.

## Text that fits

The compiler measures text and shrinks it to fit, but it estimates glyph width
and errs slightly narrow, so a block right at the boundary can still clip.
Budgets that are always safe:

| where | keep under |
|---|---|
| `content` bullet | ~150 characters |
| `compare` column (all its bullets together) | ~300 characters |
| `image` slide body (all bullets together) | ~360 characters |
| `gallery` / `points` caption | ~150 characters |

`--check` warns when a block is within reach of overflowing. If a slide needs
more than this, it needs to be two slides.

An `image:` value resolves against the spec's own directory, then `media:`, then
the cwd — so `$DECK_DIR/build/media/8fab2bab37.png` and a bare `8fab2bab37.png` both work.

## What `fit` decides

`fit` is the only picture field with a real design consequence, and the
compiler builds a different slide for each value.

| type | `fit` | what you get |
|---|---|---|
| `image` | `cover` (default) | the photo fills its 640-wide half, bleeding off three edges, with a slow ken-burns drift |
| `image` | `contain` | the whole frame survives, inset in the half, on a panel filled with the **dominant colour of the picture's border ring** (`panel_tint.py`; see [TEMPLATE.md](TEMPLATE.md)) — or white when the file is already on white or transparency |
| `gallery` | `cover` (default) | every picture cover-cropped into one identical box, captions on a shared baseline |
| `gallery` | `contain` | letterboxed in that box — only for a chart or a screenshot that cropping would destroy |

So: `fit: contain` for anything with text in it or a subject that must not be
cut (a diagram, a logo, a product shot); leave it off for a photograph. Do
**not** set `fit: contain` on a `gallery` just to "show all of each picture" —
a row of differently-shaped images lines up on nothing.

A big, high-resolution photograph that deserves the whole slide has no spec
type: copy the template's full-bleed image slide (`sl-image-hero`) after
compiling (`slide.py copy deck.html sl-image-hero --after ID`).
[TEMPLATE.md](TEMPLATE.md) has the conventions.

Universal optional fields: `id` (stable slide id — set the same id on two
slides plus `transition: morph` to morph between them), `transition`
(`fade|slide|morph|none`, default `morph`), `notes` (speaker notes), `background`, and `note` —
one line of small grey type just above the footer, on any slide type. `note` is
where a converted deck's source URLs and citations live; `chart` and `table`
render it in their own layout instead.

## Slide types

| type | fields | sub-blocks |
|---|---|---|
| `title` | `title`, `subtitle` | — |
| `section` | `title`, `tagline`, `subtitle` | — |
| `content` | `title`, bullets (auto-sized, 1–8) | — |
| `statement` | `title`, `body` | — |
| `quote` | `quote`, `attribution` | — |
| `compare` | `title` | exactly 2 — heading + bullets/body |
| `points` | `title` | 2–4 — `heading`, `image`, `fit`, `caption`, `icon`, body |
| `image` | `title`, `image`, `caption`, `side` (`left`/`right`), `fit`, bullets | — |
| `gallery` | `title` | 1–4 — `image`, `caption`, `fit` |
| `grid` | `title`, `columns` | N cards — `heading`, `image` (icon), body |
| `matrix` | `title`, `body` | 4 quadrants — heading + body |
| `chart` | `title`, `preset` (`bar\|line\|pie`), `categories`, `series …`, `note` | — |
| `table` | `title`, `subtitle` (the framing line above the table), rows, `columns` (weights), `note` | — |
| `poll` | `kicker`, `question`, `kind` (`open\|choice\|rating\|quiz\|activity`), `options`, `multi` (a `choice` that takes several picks), `min`/`max`/`minlabel`/`maxlabel`, `activity` (a local HTML page), `requirename`, `code`, `showjoin`, `hive` (`no`: an open question as the classic slide instead of the live hive), `axes`/`quads` (open: the hive matrix) | `quiz`: one per question |
| `game` | `screen` (local HTML: the room's view and the lecturer's controls), `phone` (local HTML: the activity page), `code` (pin it), `requirename` (default `yes`), `question` (the hidden poll's; default `title`), `poster`, `texts`, `title` (the slide's name) | — |
| `embed` | `page` (local HTML) or `src` (URL), `poster`, `zoom`, `frame`, `sandbox`, `live`, `chrome`, `texts` (one-line JSON: the page's editable labels, `kb.py get embed-block`), optional `title` | — |
| `diagram` | `title`, `shape`/`label` lines | — |

Aliases: `cover`→title, `divider`→section, `bullets`→content,
`comparison`→compare, `columns`→points.

A **`game`** is a whole game on one slide: a hidden `activity` poll (the
phones get `phone:`) under a full-bleed embed of `screen:` that keeps the poll
open and runs in the editor too, logo only (the screen's control bar sits
where the footer would). It compiles to exactly the slide the per-game
`make_*.py` scripts and `$T/make_game.py` create. The pages go in as
they are, the screen with the deck's font for its `url(MANROPE)`; a page with
a `/*CONFIG*/` to fill is built first (`make_game.py CONFIG.json --build-only`)
and the spec points at the built files. **Pin `code:`**: without it every
compile mints a new bucket and the room's game is left behind.
[../engagement.md](../engagement.md), "Games", owns the subject.

```md
## game
id: q-buzz
title: Buzz and vote
screen: build/game/buzz-screen.html
phone: build/game/buzz-phone.html
poster: build/posters/buzz.png
code: k7m3pq
notes: The whole game runs on this slide (present mode, lecturer key entered).
```

`embed`'s four less obvious fields:

- `sandbox:` adds iframe tokens on top of the always-applied `allow-scripts`.
  `allow-same-origin` is honoured only on a **cross-origin `src:`** — on an
  inline `page:` the renderer strips it, because a `srcdoc` frame's own origin
  is the deck's. A YouTube clip wants all four:
  `sandbox: allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation`.
- `live: yes` runs the frame on the editor canvas as well as in present mode.
- `chrome: dark` takes the logo, footer and page number from the dark set, for
  a frame whose own page is dark.
- `frame: x,y,w,h` overrides the frame's box (default full-bleed, or
  `0,150,1280,500` under a `title:`). It exists for a page that draws its own
  chrome — a video player prints the clip's title along the top and controls
  along the bottom, which collide with the deck's logo and footer at full
  bleed. `frame: 126,72,1028,578` is a 16:9 player inset clear of both.

**`embed`, `diagram` and builds (`steps: morph`) are figure slides** —
[../figures.md](../figures.md) owns them; `$T/kb.py get embed-block diagram-block morph-steps`
prints their fields and the rules for
writing one.

## Choosing a type

- Numbers that compare → `chart`, never bullets of figures.
- A spec / pricing / schedule grid → `table`.
- Two options, before/after, us/them → `compare`.
- 2–4 things each with a picture → `points`; pictures alone → `gallery`.
- 2–4 things with **no** picture → `points` too. With no `image:` on any block
  it compiles to the template's icon columns: a colour chip holding the block's
  `icon:` (a lucide name such as `icon: list-checks`, or `tabler:name`; the
  block's number when there is none), a rule in that colour, heading, body.
  Write the text as `body:` on the line after `icon:`; a bare paragraph there
  is read as part of the icon's value.
- A taxonomy or icon list (technologies, capabilities) → `grid`.
- One idea that deserves the whole slide → `statement`, not a one-bullet `content`.
- A big figure or screenshot with commentary → `image`.
- Anything the audience should answer live → `poll`; a game the room plays
  round by round, with the lecturer's controls on the screen → `game`.
- Artwork that moves, or that the extractor could not export → a figure slide.

Keep `content` to ≤6 bullets; the compiler shrinks type to fit but a wall of
text is still a wall of text. Split instead.

## Examples

```md
## chart
title: Funding has compounded
preset: bar
categories: 2021 | 2022 | 2023 | 2024
series Seed: 12 | 19 | 24 | 31
series Series A: 4 | 7 | 11 | 18
note: Growth is entirely in the earliest stage.

## image
title: What the model sees
image: 8fab2bab37.png
fit: contain
side: right
caption: Protein sequence space, clustered by family
- Each dot is a protein family
- Colour marks functional class

## grid
title: Nine technologies
columns: 3
### Robotics
image: d1656c6a26.png
### Quantum computing
image: 399ef20e9a.png

## poll
kind: quiz
question: Quick check — 3 questions
### Which ocean is the largest?
- Atlantic
- *Pacific
- Indian
### What is 7 × 8?
- 54
- *56
```

In a `quiz`, each `###` is one multiple-choice question and `*` marks the right
answer (the first option if none is marked). The right answers stay in the deck
— phones are sent the questions without them and submit only their picks, and
the slide shows the distribution of scores. Every `poll` gets a fresh, unique
answer code unless you set `code:` yourself to keep collecting into an existing
one.

An **open** poll compiles to ONE slide, the live clustered hive (template slide
`sl-poll-hive`): the poll hidden beneath a full-bleed hive that shows the
question, the join QR and the answers, and clusters them. `kicker` is ignored
there. `hive: no` — or `showjoin: no` — gives the classic question slide.
`axes:` turns it into the **hive matrix** (`sl-poll-matrix`): answers placed
on the presenter's axes instead of clustered. One axis `Low | High`, two
`Low | High ; Low | High` (x first); a pole may be `Label = definition`.
`quads: TL | TR | BL | BR` names the quadrants (default: pole names).

`showjoin: no` drops the QR, the address and the code. For a slide that reports
a bucket the room already answered — it still counts and summarizes, it just
stops inviting an answer nobody should give twice:

```md
## poll
kicker: From what you already sent me
question: The markets you aimed at
kind: open
code: mrkt47
showjoin: no
```

`kind: activity` ships a whole self-contained page to the phones instead of a
built-in form — a game, or a form none of the four fixed kinds can express:

```md
## poll
kicker: Over to you
question: Beat the clock
kind: activity
activity: build/game.html
requirename: yes
```

The page is embedded verbatim in `doc.assets` (max 60 000 characters) and must
run in a sandbox with no storage and no CDN. [../engagement.md](../engagement.md) owns
the whole subject; `$KIT/engage/activity.html` is a working starter page.
