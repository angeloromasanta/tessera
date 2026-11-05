# Pictures for slides

A slide that needs a picture gets one in two ways: a generated one, or a real,
open-licence picture found online. Both tools write into the deck's
`build/media/` and append a line to `build/media/CREDITS.md`, so the deck
folder always knows where each picture came from. The slide itself is then
built with the ordinary spec types (`image`, `points` with an `image:` per
block, `gallery`), which embed the file as a data URI. The tools are
`$T/image_find.py`, `$T/image_gen.py` and `$T/image_swap.py`. `--deck` takes the deck's `.md`, `.html` or
folder and derives `build/media/` from it; omit it only when the cwd is the
deck folder. Which to try first, and the house style, are the
workspace's choice: a workspace skill or the deck README names them. A good
default: generate every illustrative picture (a scene, a mood, a concept) in
one style, and search only when the slide must show **the real thing** (a
figure from a named paper, a real product, place or event).

## Searching

The keyless sources are Flickr-via-Openverse and Wikimedia Commons, strong on
places, objects, science and history. With `PEXELS_API_KEY` in the
environment or the `.env`, Pexels joins.

```bash
$PY $T/image_find.py search "students laughing around a table" --deck $DECK_DIR/deck.md --wide
```

Prints the candidates and writes `build/media/find-<query>.png`, a numbered
contact sheet, next to a `.json` of the same list. **Read the sheet** — the
list alone cannot tell you the picture is a sepia bird's nest. Then:

```bash
$PY $T/image_find.py pick $DECK_DIR/build/media/find-<query>.json 3 --name network
```

saves `build/media/network.jpg` (downscaled to 2000px wide) and appends the
credit. `--wide` keeps landscape files only, which is what a slide half or a
gallery box wants; `--min-width` (default 1000) drops files that would go
soft at 640px wide. Openverse serves Flickr at 1024px, which is enough for
the 640-wide half of an `image` slide and for gallery boxes, but not for the
1030×720 hero layout — that one needs Commons, Pexels or generation.

Query in the language of a caption, not a concept: "runner on a mountain
trail at dawn" finds pictures, "perseverance" finds statues.

Two things disqualify a found picture on sight: a visible brand or another
institution's logo, and a licence with **ND** (no derivatives) when the slide
will crop it — a cover-cropped slide half is a derivative. `BY` and `BY-SA`
are fine with the credit line; `NC` is fine for teaching.

## Generating

```bash
$PY $T/image_gen.py "Four students laughing over laptops in a glass study room at night, city lights outside" \
    --deck $DECK_DIR/deck.md --name network
```

Seedream 4.5 through OpenRouter's image endpoint, `OPENROUTER_API_KEY` from
the environment or the `.env` ([README.md](README.md), "Configuration"). Writes `build/media/network.jpg` at 2K,
16:9 by default; `--aspect 4:3` or `1:1` when the target box is squarer, so
the cover crop keeps the subject. `--variants 2` writes `-1` and `-2`;
**read both** before choosing, one is usually clearly better (`--variants 3`
when the subject is hard). The tool adds no style of its own: a house style is
passed whole with `--style "…"` or `--style-file FILE`, prepended to every
prompt (a workspace's skill names its own and passes it every time). One
deck, one style.

What Seedream does, so the prompt can work with it:

- **It draws text badly**: signs, labels and lettering come out garbled.
  End every style with a tail such as "no text, no letters, no logos, no
  signage, no lettering of any kind", and never ask for a sign, a caption or
  a slogan in the picture; the slide's own text carries the words.
- **Screens render as glowing blank or abstract panels**, which reads well.
  Never ask for readable code, numbers or a real interface on a screen; for
  that, use a real screenshot.
- **Describe one small scene**: a few figures doing one thing, one or two
  props, where they stand, the viewpoint, and leave the look to the style.
  Humour works with objects, animals and simple figures.

Never generate a real person, a real logo, or a slide that claims to be a
photograph of a real event; an illustration that stands in for a real product
says so on its `note:` line. Build a joke with animals or objects, never a
reproduced known meme (somebody's copyright, often a real face).

## Swapping a picture into a compiled deck

When a recompile would lose edits made in the app, or the deck is open live,
`image_swap.py` replaces just the picture and touches nothing else:

```bash
$PY $T/slide.py info deck.html --section assets           # the asset keys (or image_swap.py deck.html)
$PY $T/image_swap.py deck.html img-network=build/media/network.jpg img-build=build/media/build.jpg
```

It re-encodes to JPEG at 1600px wide (`--png` keeps transparency). **On a
live deck** (a `build/<deck>.html.live-source.json` guard exists) it sends the new
assets to the open editor, which saves the file itself; otherwise it backs the
file up to `build/backups/` and re-parses its own output. Copy the new file over
the one the spec references too (`build/media/<name>.jpg`), so a later
recompile agrees with the hand-edited deck. Then retint the panel behind any
contained picture, which still carries the old picture's colour:

```bash
$PY $T/panel_tint.py deck.html --all      # offline only: it writes the file
$PY $T/panel_tint.py build/media/network.jpg   # live: print the colour, then
$PY $T/slide.py set live SLIDE im-panel 'fill="#…"'
```

## Putting it on the slide

| the slide is | spec | why |
|---|---|---|
| one point, one picture | `image` — `fit` left at `cover` | the photo fills its half with a ken-burns drift; body ≤ ~360 characters |
| a diagram, a screenshot, anything with text in it | `image` with `fit: contain` | the whole frame survives, on a panel tinted from the picture |
| 2–4 points, a picture each | `points` with `image:` on every block | picture-per-column with heading and paragraph |
| pictures alone | `gallery` | identical cover-cropped boxes |

A picture **of a diagram** is not a picture: rebuild it as a figure
([figures.md](figures.md)).

**Reuse the same picture across a summary and its drill-downs** — a `points`
row of three, then an `image` slide per point with the same file — so the
sequence reads as one idea unfolding rather than four unrelated stock photos.
Look at the shots afterwards: a cover crop takes the *middle* of the file, so
a 16:9 picture on a portrait half loses both ends; if the subject was at an
edge, regenerate at 4:3 or pick a differently framed candidate.

Credits: found pictures carry their credit line in `CREDITS.md`; put it on
the slide's `note:` (the small line above the footer) when the licence asks
for attribution, which every CC-BY variant does. Generated pictures need no
credit on the slide.

## Checklist

- [ ] Read the contact sheet, not just the list?
- [ ] No logos, no ND licence on a cropped picture?
- [ ] The file is in `build/media/` and `CREDITS.md` has its line?
- [ ] Attribution on the slide's `note:` where the licence requires it?
- [ ] Shot the slide and checked the crop kept the subject?
