# Authoring a deck

## What a deck is

One HTML file that is both the document and the editor. The whole document is
a single JSON block near the top of the file:
`<script type="application/tessera+json" id="tessera-doc">…</script>`. Everything
after it is the compressed app runtime. **Change only the JSON. Never
regenerate the file.**

- **The block is one line, 2–7 MB long**, about 90% of it base64 assets. Never
  `Read`, `cat` or `grep` a deck. Use `slide.py ls/get/info`, which prints
  kilobytes, not megabytes ([editing.md](editing.md)).
- The format guide is [reference/agents.md](reference/agents.md), one copy.
  Where a deck's own `doc.agentNotes` disagrees about that deck, the notes win.
- **Never re-host a deck on an upstream shell**: only
  `$TESSERA/scripts/upgrade-deck.mjs` with this repo's own build (an upstream
  shell has no `poll` and no `embed`, so it would silently break every one).

## Where files go

**Everything generated goes under `$DECK_DIR/build/`**:

- `shots/`, `check/`
- `media/` for pictures and embed posters (`*-poster.jpg`)
- `figures/` for figure pages
- `work/` for slide.py work copies, claims and the push log
- `agents/` for figure-agent logs

The tools work these paths out from the deck themselves. Pass `--out` only to
override, and never write to the repo root or a skill folder. The template is
`TESSERA_TEMPLATE` from `.env`, by default `$TESSERA/template.html`; tools
default to it, so `-t` is needed only for a one-off different template
([README.md](README.md), "Configuration").

Layouts are found **by role**: a layout whose id is the role (`points`) or
ends in `-<role>` (`acme-points`) serves that role, so a brand template only
has to keep the role names in its layout ids. The bundled template's slides
are `sl-<role>` (`sl-title`, `sl-poll`, `sl-embed`); `slide.py ls` on the
template lists them all.

## Draft first, then refine

For any new or substantially reworked **slide, figure, poll, game or
activity**:

1. **Land a rough but working version in the open deck within ~2 minutes.**
   Regions as plain boxes with one-word labels at their real positions;
   placeholder text; a poll with its question already set; a game or activity
   as a playable skeleton (one round, one screen, the phone page posting one
   answer). No styling and no motion yet.
2. **Say where it is in one line** (the slide id or title), so the person
   watching the editor looks at it.
3. **Get it seen before polishing.** Wait only when the claim or the mechanic
   itself is in doubt.
4. **Refine in passes**, saving a valid, working version after each: layout →
   real content → steps, motion or game logic → polish. Patch what changed;
   never rewrite the whole thing.

Nobody sees anything while an agent plans: a silent ten-minute think looks
like a stall, and a polished slide on a wrong layout is thrown away. The same
holds for **a feedback round** (when feedback changes the layout, land a rough
version of the new layout within ~2 minutes) and for **a new deck**: a
skeleton first (title, sections, a one-line placeholder per slide), then one
section at a time, figures and activities last. Ship that skeleton early
and give the person the deck's path at once, so they can open it and watch
the rest land.

## The loop

1. **Look.** `slide.py ls`, then `get` for the slides you'll touch. Never
   author against an assumed theme.
2. **Decide what each piece of material should be** (table below). A wall of
   bullets is the #1 failure.
3. **Write it.** Start from a layout (`new --layout`) or a worked template
   slide (`copy`). Keep their ids, replace the text, delete what you don't
   need.
4. **Look again.** `shoot.py TARGET --id …` shoots only what you touched, with
   no stepping through the deck. Open the PNG, fix, repeat. Shoot the whole
   deck (`shoot.py deck.html`, contact sheets) once, at the end.

## What each piece of material should become

| the material | reach for |
|---|---|
| numbers that compare | `chart`, never bullets of figures |
| a spec, pricing or feature grid | `table`: copy the template's table slide |
| the same thing changing across slides | same element ids + `transition:"morph"` |
| a point to drill into | a state slide (`stateOf` + an element `link`) |
| one image | layout `image` (tinted stage); `image-hero` if it is big and high-res |
| several images | `image-grid` (identical cover-cropped boxes) |
| several points, no picture | `points` (icon chip, colour rule, heading, body per column; icons from `icon.py`) |
| a headline number | big text + `fx:{countUp:true}` |
| a sequence or flow | a `path` with a `dash-march` loop |
| something to poke at, or that builds over clicks | `embed`: [figures.md](figures.md) |
| something the room answers | `poll`: [engagement.md](engagement.md) |
| a picture that doesn't exist yet | [pictures.md](pictures.md) |

**Copying a layout beats inventing geometry:**
`slide.py new DECK --layout points`. The layout's `notes` carry its
recipe (`slide.py info DECK --section layout:points`). Placeholders
render dimmed in the editor and are hidden in the show; replace them or delete
the element.

## JSON rules that keep a deck working

- **Escape every `<` in the JSON** as backslash-`u003c`. `slide.py` and the
  compilers do this for you. If you ever splice with `String.replace`, pass a
  replacer function. In an inline `bash` heredoc the escape loses its backslash:
  write the script to a file, or build it with `chr(92)`. A deck that slipped
  (`slide.py` stops with "holds a raw '<'"; the browser shows script errors) is
  fixed with `slide.py repair DECK.html`, content unchanged.
- **Unknown property names are silently ignored.** Don't invent fields; check
  [reference/agents.md](reference/agents.md).
- **Identity: never change `docId`, element ids or poll codes** on an existing
  deck; a figure hard-codes its poll codes. A *copied file* is still the same
  deck (copies sync into each other by `docId`) until `slide.py fork COPY.html`
  gives it its own (`--polls`: fresh answer buckets and join code too; in the
  editor, Save ▾ → "Save a copy…" makes copies that are their own deck from the
  start, and the banner shown while both files are open offers "Make this
  file independent"). A copied poll
  *element* needs a fresh `code`: `slide.py copy`, `add-poll` and the app
  remint; a hand copy must do it itself.
- **Morph pairs elements by id.** Share ids across consecutive slides on one
  subject. `morph` is the default transition; use `fade` only for a change of
  scene.
- **A list is ONE text box**: one `• ` line per bullet, two leading spaces for
  level 2. Inline `<code>` is a chip. A line that is only a `<code>` span is a
  code block.
- **Chart data is plain numbers** (pie alone takes `{name,value}`). Options
  are pure JSON: `{b}` / `{c}` / `{d}`, never functions.
- **A `line` shape takes its colour from `fill`** and runs horizontally; a
  vertical rule is a rotation.
- **Assets are data URIs** in `doc.assets`, referenced as `"asset:<key>"`
  (an embed's page is `"asset": "<key>"`). The file stays self-contained.
- **Type is absolute.** When you change a frame, adjust `fontSize` too.
- **Page furniture** is `logo`, `footer`, and `pageno` (`{{page:2}}`, never a
  number), with the same ids on every body slide.
- **Margins and fonts come from the template** (the bundled one:
  [reference/TEMPLATE.md](reference/TEMPLATE.md)); add no others.
- **Write speaker notes on every slide.**
- A `shape` used as a card needs `stroke:'transparent', strokeWidth:0`, or it
  can render invisible.
- A text element's `html` keeps tags but drops `style` attributes: a second
  colour needs a second text box.

## Handing over an editable copy

Copy the **whole** file ("this slide" still means the file), then
`slide.py fork COPY.html --polls`, so it neither syncs with the original nor
answers into its polls. In the editor: Save ▾ → "Save a copy…" →
"Another room". Links and frozen copies: [publishing.md](publishing.md).

## Self-audit before you say done

- [ ] Numbers shown as text that should be a chart?
- [ ] Consecutive slides on one subject share ids + morph?
- [ ] At least one motion moment (ken-burns, a loop, a count-up), especially on the cover?
- [ ] Every figure step **moves** something rather than fading one more thing in?
- [ ] Margins inside the template's, one accent colour, two typefaces?
- [ ] Speaker notes on every slide?
- [ ] Did you **look** at every slide you touched: `shoot.py DECK --id a,b`?
