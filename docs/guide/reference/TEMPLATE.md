# The template — conventions, not a catalogue

`$TESSERA/template.html` is the source of truth for everything that describes
itself: which layouts exist, their element ids and frames, the theme, the
fonts, the worked slides. **This page does not repeat any of that**, because a
copy here drifts the moment someone adds a layout. Read the file instead — two
ways, both derived from the JSON at the moment you ask:

```bash
python $T/slide.py info $TESSERA/template.html --section layouts        # every layout: element ids + frames
python $T/slide.py info $TESSERA/template.html --section layout:image   # one layout + its recipe
python $T/slide.py ls $TESSERA/template.html                            # the worked slides
```

or open the deck's `doc.agentNotes` (right after `title`): the notes headed
**LAYOUTS IN THIS FILE** and **SLIDES IN THIS FILE** are generated from
`doc.layouts` and `doc.slides` by `scripts/stamp-agent-notes.mjs`, so they
list the real layouts, frames, each layout's recipe (its `notes`), and which
slides are patterns that exist *only* as slides.

What this page keeps is what is not in the file: **how to choose** between what
the file offers, and the rules the compiler encodes. How the file itself is
built and maintained is in `$TESSERA/template/README.md`.

## Layouts by role

Layout ids are the role itself; slide ids are `sl-<role>`. Tools find a
layout by role — an id equal to the role, or ending in `-<role>` — so a
branded template whose ids carry a prefix (`acme-points`) works with the same
tools.

| role | for | worked slide |
|---|---|---|
| `title` | the cover: the living swarm figure, title and subtitle on the left | `sl-title` |
| `section` | a divider between parts, on the deep colour under the diagonal band | `sl-section` |
| `content` | title + one bullet box, the workhorse | `sl-content` |
| `quote` | one sentence on the accent colour, with its source | `sl-quote` |
| `statement` | one centred statement on white | — |
| `chart` | the six chart colours as bars; real charts take the palette from the theme | `sl-chart` |
| `compare` | two options: white left, accent panel right | `sl-compare` |
| `points` | several points, no picture: icon chip, rule, heading, body per column | `sl-points` |
| `image` | one picture, contained, on a panel tinted from its border | `sl-image` |
| `image-hero` | one big, sharp picture under the diagonal band | `sl-image-hero` |
| `image-grid` | several pictures in identical cover-cropped boxes | `sl-image-grid` |
| `matrix` | a 2×2 | — |
| `palette` | the palette reference card | `sl-palette` |
| `poll` | a live audience question | `sl-poll` |
| `embed` | an interactive figure under a title | `sl-embed` |

Slides that are patterns without a layout of their own: `sl-howto` (three
numbered pictures with captions), `sl-table` (the table look, below),
`sl-poll-hive` and `sl-poll-matrix` (an open question shown as a live clustered
hive, or on the presenter's axes), `sl-lab` (task, prompts, countdown, the
room's status and the screenshots it shared, an AI helper on every phone), `sl-game-pot` and
`sl-game-prompt` (two classroom games), `sl-embed-evolution`,
`sl-embed-perceptron` (worked figures). Reuse them with `slide.py copy`.

## Which slide for a picture, and which for a list of points

**The house convention — use it before anything else.**

| what you have | layout |
|---|---|
| **one image** — the default | `image` (tinted stage: picture contained, panel tinted from the picture) |
| one image, **white or transparent background** | `image`, but leave the panel `#FFFFFF` |
| one image, **big and high-resolution** | `image-hero` (full bleed under the diagonal band) |
| **several images** with a caption each | `image-grid` (identical cover-cropped boxes) |
| **several points**, no picture | `points` (per column: icon in a colour chip, a rule in that colour, heading, body; no card) |
| several points, each **with** a picture | `image-grid`, widening the sub-caption for the paragraph |

The three rules the table encodes, because they are the ones that go wrong:

1. **The tint rule: a contained picture needs a ground, not a gap — and the
   ground is the picture's own border.** The panel takes the dominant colour of
   the picture's border ring (outer 4%): the fullest colour cluster there, as a
   median, so a subject running off one edge does not pull it. When that
   backdrop covers ≥35% of the ring (an illustration on cream, a studio shot, a
   sky) the panel is exactly that colour and the picture's edge disappears. A
   busy border (a street, a crowd) has no colour to continue, so it gets the
   ring's mean mixed 30/70 with white. `tools/panel_tint.py` is the rule; after
   swapping a picture into a deck, `python $T/panel_tint.py deck.html --all`.
2. **…unless the picture is already on white or on transparency.** A logo, a
   cut-out or a screenshot on white keeps a white panel; tinting behind one
   draws a visible box around nothing.
3. **Several pictures only read as a set if the boxes are identical and
   cover-cropped.** Never `fit:"contain"` in a row, never mixed aspect ratios.

`md_to_deck.py` follows all three and reads its geometry out of the layouts.

## Palette

The values live in `doc.theme` and in `template/palette.py` (one place; the
builder re-applies it). Roles, not names, are what matter:

| token | value | role |
|---|---|---|
| ink | `#1A2326` | all body text (`theme.color`) |
| deep (`--navy` in figures) | `#0D2A2F` | title and section backgrounds, dark fills |
| accent | `#0F6B73` | slide titles, headings, structure, emphasis fills, the quote and compare panels (`theme.accent`) |
| band | `#13565D` | the diagonal band on section and hero slides |
| muted | `#5A6467` | footer, page number, captions, eyebrows, table header |
| line / rule / edge | `#C7CFD1` / `#D7DEDF` / `#E1E6E7` | axes and dead marks / hairlines / card edges and table rules |
| tint / accent tint | `#F1F5F5` / `#E2F0F1` | neutral card fill, a shaded table row / soft accent fill |
| chart palette | `#2B6CB0` `#D2553A` `#7A5BBF` `#3B9457` `#C2477F` `#BF831A` | blue, coral, violet, green, magenta, gold (`theme.chartPalette`); each ≥ 3:1 on white |

Coral doubles as *negative/warning*, green as *positive*, gold as *highlight*;
each has a `-text` (for type) and a `-tint` (for fills) in the figure tokens.
Text on white is ink or accent (accent is 6.2:1); text on the accent and the
deep colour is white. Keep a category's colour across a deck: reuse the chart
order.

## Type

- **Titles: Fraunces** (serif, weight 400; 300–700 available), in the
  accent on white and white on dark. Slide titles 36–40px, the cover 58px,
  section titles 56px, column headings 20–30px.
- **Body: Manrope** (200–800): 16–24px body, 600 for kickers and labels,
  700 for emphasis; 14px footer and page number in muted.
- Both are SIL OFL fonts embedded in the file (`scripts/brand-fonts/`); add no
  others. Code spans use the system monospace stack.
- **Figures** use Manrope only, inlined by `embed_font.py`, with the figure
  tokens above (`--ink`, `--navy`, `--accent`, `--sky` …, listed in the
  deck's FIGURE STYLE note) and the type roles there.

## Margins and furniture

- Content starts at **x=56**; nothing crosses **x=1184** (a 1168 stage on the
  1280×720 canvas). Titles sit at y≈88–104.
- Every body layout carries **`logo`**, **`footer`**, **`pageno`** with
  identical ids, so the chrome morphs in place. `logo` is a **text wordmark**,
  empty by default (hidden in the show while empty): type a name into it, or
  replace it with an image under the same id. Dark layouts set it white.
- `pageno`'s html is the literal token `{{page:2}}`.

## The table look

Copy `sl-table`. Table `style` comes from `doc.theme.table` (read it from the
theme, do not hard-code): the **Rows** preset — hairlines between rows only
(`rules: "rows"`), no header fill, the header in small capitals (`headerCaps`)
over a 2px accent rule (`headerRule`), the table flush with the title at x=56,
w=1128. Cell habits: the key column in the accent colour per cell, a break or
section row shaded with each cell's `bg` (the tint) in muted text, tags in
their own right-aligned last column. Cell chips: `<code>cmd</code>` (a
command), `<mark>Demo</mark>` (a soft tag), `<mark><b>Lab</b></mark>` (a filled
tag). `md_to_deck.py`'s `table` builder mirrors its ids and inset.

## Where layouts come from, and what not to break

`doc.layouts` is owned by the file. A layout is added by deep-copying a slide
into `doc.layouts` with a role id, a `name` and `notes` carrying its recipe,
then re-stamping the notes: `node scripts/stamp-agent-notes.mjs`.

**Keep the element ids stable.** `md_to_deck.py` resolves typography and
geometry by id — `pt-title`/`pt-h1`/`pt-p1` (points, gallery, grid),
`im-panel`/`im-cap`/`im-title`/`im-body` (image), `ga-cap1`/`ga-sub1`
(gallery), `tb-*` (table), plus `logo`/`footer`/`pageno` everywhere. Renaming
one breaks a builder with a `KeyError`, not a wrong-looking slide.

## Template hygiene

The file carries `template: true`, so every open mints a fresh document (new
`docId`, fresh poll codes and session). Opening it in the editor consumes the
flag, so edit the master on disk (`slide.py`, or splice the JSON) and restore
the flag with `slide.py template FILE` if it is lost. A deck made by copying
the file needs its own identity: `slide.py fork --polls`. Its
`poll.service` is empty: set yours (`slide.py service DECK`, or
`TESSERA_POLL_SERVICE` in `.env` for new decks) before presenting a poll.

The hive slides show **invented** sample answers while their question is the
placeholder `Your open question`; writing a real question turns them live.
