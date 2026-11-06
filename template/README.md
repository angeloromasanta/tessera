# template/ — how `template.html` is built and maintained

`template.html` (one level up) is the neutral template every tool starts a
deck from (`TESSERA_TEMPLATE` in `.env` points elsewhere for a brand of your
own). **It is its own source**, like any deck: edit it with `slide.py` or by
splicing its JSON, never by regenerating it. This folder holds what the
builder re-applies on top of it — the palette, the figures spliced into it and
their inputs — and the scripts that do it.

```
template/
├── build_template.py   the builder: brand strip (one-time), splice, posters, agent notes
├── splice_template.py  puts the swarm title, the hive, the hive matrix and the worked
│                       figures into the template (config: splice.json)
├── splice.json         what is spliced, from where (paths from the repository root)
├── palette.py          the palette, fonts and theme; RETOKEN maps the older figure
│                       family's colours onto it
├── posters.py          re-shoots every embed's poster from its page
├── figures/            swarm-cover.html (title), hive-cluster.html, hive-matrix.html
├── data/               make_samples.py -> sample-cluster.json, sample-matrix.json:
│                       INVENTED answers the hive slides show as a sample
├── media/              img-coding/audience/dashboard (+ CREDITS.md); posters/ (shot by posters.py)
├── lab.json            the lab slide (sl-lab), for tools/make_lab.py
└── games/              pot.json, prompt.json: the two game slides, for tools/make_game.py
```

The fonts come from `../scripts/brand-fonts/` (Fraunces titles, Manrope body,
both SIL OFL); the agent briefing from `../scripts/template-agent-notes.mjs`.

## Rebuild

From the repository root, after changing a figure source, the palette or the
sample answers:

```bash
python template/data/make_samples.py        # only if the sample answers changed
python template/build_template.py           # splice + posters + agent notes; writes template.html.bak
python template/build_template.py --no-posters   # faster, when no figure changed visually
python template/build_template.py --engage  # also rebuild the lab and game pages from kit/engage
python tools/shoot.py template.html         # look at every slide
```

Not while `template.html` is open in the editor (push pages with
`slide.py asset` then). The steps can also run alone:
`python template/splice_template.py`, `python template/posters.py [--only KEY]`,
`node scripts/stamp-agent-notes.mjs` (re-stamp after any layout or slide
change). The lab and game slides are rebuilt by their own tools:
`python tools/make_lab.py template/lab.json --deck template.html` and
`python tools/make_game.py template/games/pot.json --deck template.html`.

### What a build does

1. **Brand strip, one time.** Given a branded template (`--source BRAND.html`,
   with `--strip STRIP.json` for what only that source needs: slides to drop,
   irregular slide ids, copy to rewrite, rewrites inside its pages —
   recognised by layout ids with a prefix, a title face that is not one of the
   free ones, logo images), it renames layouts to their role (`title`, `points`, …) and
   slides to `sl-<role>`, swaps the title face for Fraunces, puts a text
   wordmark where a logo image was, re-colours every element and embedded page
   with `palette.py`, rewrites product- and course-specific copy, drops
   course-specific slides and every asset nothing points at, empties
   `poll.service`, mints fresh poll codes and a fresh `docId`, and sets
   `template: true`. On `template.html` itself every one of these is a no-op,
   which is what makes it the maintained source afterwards.
2. **Fonts synced** from `scripts/brand-fonts/` into the font assets and into
   every page that inlined them.
3. **Splice** (`splice.json`): the swarm cover, the hive and hive matrix with
   their sample answers baked in, the worked figures from `kit/figures/examples/`
   (re-coloured to the palette, `url(MANROPE)` replaced by the template's own
   Manrope).
4. **Posters** re-shot from the pages (`posters.py`), then spliced again.
5. **Agent notes** stamped.

The document block is rewritten in place inside the file's own app shell;
re-host the template on a newer shell with `node scripts/upgrade-deck.mjs template.html`.

A brand kit reuses the same scripts with its own files: a `splice.json` with
`"paths": "config"`, `"prefix"`, its title font and logo asset
(`python template/splice_template.py --config KIT/splice.json`), its own notes
module (`node scripts/stamp-agent-notes.mjs --notes KIT/notes.mjs KIT/brand.html`)
and a `--config` for `scripts/build-flow-slide.mjs`.

## The spliced slides

| slide | figure | source |
|---|---|---|
| `sl-title` (layout `title`) | the living swarm: agents (flat black dots) building, inspecting and correcting a hex field on the right; a hexagon lattice a gold ring lights every 9 s; title and subtitle on the quiet left, entering with `fx.enter` | `figures/swarm-cover.html` |
| `sl-poll-hive`, after `sl-poll` | a whole open question on one slide: its poll hidden beneath the live clustered hive | `figures/hive-cluster.html` + `data/sample-cluster.json` |
| `sl-poll-matrix` | the same, answers placed on the presenter's own axes (one axis: beeswarm; two: 2×2) | `figures/hive-matrix.html` + `data/sample-matrix.json` |
| `sl-embed`, `sl-embed-evolution`, `sl-embed-perceptron` | the worked figures: adoption curve, evolution, perceptron | `kit/figures/examples/{adoption-curve,evolution,perceptron}.html` |

Not spliced, built by their tools and kept in the file: `sl-lab` (a hands-on
lab: task, prompts, countdown, the room's Lost / Working on it / Finished bar,
a wall of the screenshots the room shared, an AI helper on every phone;
`tools/make_lab.py` from `lab.json`),
`sl-game-pot` and `sl-game-prompt` (the group-pot and prompt games on the game
layer, `docs/game.md`; `tools/make_game.py` from `games/*.json`, pages in
`kit/engage/`).

**Every label in these figures is editable on the edit canvas** (`data-edit`
keys), and the splice ends the notes of every slide whose figure has them with
a hint saying so.

### The hive slides

The hive's page has `CONFIG.code` emptied, so it reads the nearest poll at or
before its slide through the embed API's `poll.previous` — the poll element on
its own slide (`aq-poll`, `opacity: 0`, under the embed). Template
instantiation remints poll codes, so a pinned code would read an empty bucket;
`splice_template.py` keeps the slide's code across re-splices. The hive shows
the question, the join QR and a live count before its first click; the embed
has `keepPollOpen: true`. Clustering and scoring are `POST /api/cluster` on the
poll service (`docs/server-setup.md`).

The matrix follows the same contract, plus one: its `CONFIG.axes:` and
`CONFIG.quads:` are one line each, and that line is what the deck tools
rewrite (`slide.py axes`, `add-poll --axes`, spec `axes:`). Keep those lines
single-line JSON, and keep `const SAMPLE=null;` and `const SAMPLE_ALWAYS=false;`
each on its own line in the sources (the splice replaces them).

**Sample mode — why the template hives are not empty.** The splice bakes the
INVENTED answers of `data/` into both pages (`const SAMPLE=…`). A page uses
them only while its poll's question is still the placeholder
`Your open question` — and, for the matrix, while its axes are the template's
own (`Automation ↔ Augmentation`, `Use ↔ Build`; the sample scores only hold
for those). Then it opens on the finished view, shows the eyebrow
`SAMPLE ANSWERS` and never calls the service. A deck that writes its own
question gets the ordinary live page, so no tool has to strip anything. The
placeholder string is `PLACEHOLDER` in `splice_template.py`. Never put real
audience answers in `data/`.

### Standing rules

- **The swarm starts warm.** It simulates up to 60 s, until half the field is
  built, before its first frame, and paints synchronously; posters are shot
  250 ms after load.
- **Pointer and entrance are paint-only.** `warp()` shrinks tiles and agents
  near the cursor; a click sends a ring; on arrival one ring spreads from the
  title side and a gold rule draws at x 66, y 516. No text inside the canvas.
- **One palette.** Pages use the CSS custom properties of `palette.py`'s
  tokens; a figure written against the older family is re-coloured by
  `RETOKEN` when spliced. Change a colour in `palette.py`, never in a page.
- **Canvas figures render at screen size**: size the backing store by
  `devicePixelRatio × hostScale()`.
- **No fixed answer count.** A hive must work for 5 answers or 500.
