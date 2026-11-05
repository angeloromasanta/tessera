# Authoring guide

How decks are built, edited, figured, polled and published with tessera,
written for anyone: a person at a terminal, or any coding agent (Claude Code,
Codex, another harness). A workspace may add its own agent skills on top of
these pages (a brand, accounts, keys, the author's standing preferences);
those skills link here for the method. **One fact, one owner**: a rule written
here is not repeated in a skill, and a skill's rule is not repeated here.

| page | owns |
|---|---|
| [authoring.md](authoring.md) | what a deck is, where files go, **draft first**, the loop, material → element, JSON rules, self-audit |
| [editing.md](editing.md) | `slide.py`: which edit path, live vs file, `conflict`, requests typed in the editor (a slide, a new slide, the whole deck), specs and `land.py`, checking (`shoot.py`, `doctor`) |
| [parallel.md](parallel.md) | several agents on one deck: the coordinator, claims, sizing, landing each result live |
| [figures.md](figures.md) | embed figures: states, motion rules, editable labels (`data-edit`), figcheck, the figure family, getting a figure onto a slide, figure agents, the knowledge base |
| [engagement.md](engagement.md) | polls, activities and games: kinds, codes, the wire contract, limits and cost, reading answers back, rehearsing, presenting |
| [engagement-pages.md](engagement-pages.md) | the ready-made engagement pages: guess the number, lab slides, interactive title, the game starter, groups |
| [pictures.md](pictures.md) | finding, generating and swapping slide pictures |
| [conversion.md](conversion.md) | the pptx → deck pipeline |
| [publishing.md](publishing.md) | `publish.py`: the students, teach and live targets |

## Where to start

1. [authoring.md](authoring.md) and [editing.md](editing.md). The other pages
   when the job needs them.
2. **The deck's own `README.md`**: its sources, commands and standing rules.
   They outrank these pages for that deck.
3. **On demand only**, by section:
   - [reference/agents.md](reference/agents.md): **the format guide**, every
     element and field (`fx`, `poll`, `embed`, charts, tables, state slides).
     Not the upstream editor's own agent guide: it has no `poll` and no `embed`.
   - [reference/SLIDE_SPEC.md](reference/SLIDE_SPEC.md): the spec format
     `md_to_deck.py` compiles.
   - [reference/TEMPLATE.md](reference/TEMPLATE.md): the bundled template's
     conventions (which layout for a picture, the tint rule, the table look,
     margins and fonts). A workspace with its own template documents its own.
   - Subagent briefs: [reference/SLIDE_AGENT_BRIEF.md](reference/SLIDE_AGENT_BRIEF.md)
     (a slide), [reference/AGENT_BRIEF.md](reference/AGENT_BRIEF.md) and
     [reference/FIGURE_BRIEF.md](reference/FIGURE_BRIEF.md) (a figure).
   - The engine: [../format.md](../format.md) (the dry field reference),
     [../agent-live.md](../agent-live.md) (the live patch protocol and change
     requests, which `slide.py` already speaks), [../game.md](../game.md) (the
     game layer), [../server-setup.md](../server-setup.md) (your own poll
     service), [../OVERVIEW.md](../OVERVIEW.md) before changing the engine.

**Run `TOOL --help` rather than reading a tool's source.** Every flag is
documented there, and reading the source costs an agent thousands of tokens.

## Conventions in these pages

| name | means |
|---|---|
| `$TESSERA` | the tessera checkout: `.` when you work inside it, `tessera/` in a workspace that nests it |
| `$T` | `$TESSERA/tools`, every authoring tool (flat: `slide.py`, `shoot.py`, `md_to_deck.py`, `deck_build.py`, `publish.py`, …) |
| `$KIT` | `$TESSERA/kit`: `engage/` (engagement pages), `figures/` (`figure.html` starter, `examples/`, `knowledge/`) |
| `$DECK_DIR` | one deck's folder, `$TESSERA_DECKS/<deck>/` (default `decks/<deck>/`) |
| `$PY` | Python 3.10+ (`python` on Windows, often `python3` elsewhere) |

Check the dependencies once per session:
`$PY -c "import PIL, websocket" || $PY -m pip install -q Pillow websocket-client`.
Screenshots and figure checks need a Chrome or Chromium the tools can start
headless; the pptx pipeline adds `python-pptx` ([conversion.md](conversion.md)).

## Configuration

Every tool reads one `.env` file. It is found by walking up from the current
directory, then from the tools' own folder, so a workspace that nests the
checkout can keep its `.env` above it; a variable already set in the
environment wins over the file. Copy `$TESSERA/.env.example` to `.env` to
start; the poll service's setup (`npm run setup`,
[../server-setup.md](../server-setup.md)) writes the poll keys into it for
you, and creates the file at the checkout root if none exists.

| key | what it is | default |
|---|---|---|
| `TESSERA_TEMPLATE` | the template new decks and compiles start from | `$TESSERA/template.html` |
| `TESSERA_DECKS` | the folder that holds the decks | `decks` |
| `TESSERA_POLL_SERVICE` | the poll service a new deck uses, `https://join.<subdomain>.workers.dev` | none: polls render statically |
| `TESSERA_LECTURER_KEY` | the poll service's lecturer key (also read from `LECTURER_KEY`) | none |
| `OPENROUTER_API_KEY` | picture generation ([pictures.md](pictures.md)) | none |
| `TESSERA_CF_SUBDOMAIN` | the `<subdomain>` of `<subdomain>.workers.dev`, for published links | none |
| `TESSERA_LIVE_URL` | the public address of the live mirror ([publishing.md](publishing.md)), optional | none |
| `TESSERA_LIVE_LOCAL` | where the mirror server listens | `http://127.0.0.1:8000` |
| `TESSERA_AUTHOR` | the name a request or `slide.py ask` is signed with | none |
| `TESSERA_SECTION_TAGLINE` | the tagline `md_to_deck.py` puts on a section slide whose spec gives none | none |
| `PEXELS_API_KEY` | adds Pexels to the photo search ([pictures.md](pictures.md)), optional | none |
| `TESSERA_CF_REGISTRY` | where `cf_upload.py` records what it published ([publishing.md](publishing.md)) | `$T/.cf-registry.json` |
| `TESSERA_BACKUPS` | how many copies a tool keeps in the deck's `build/backups/` before rewriting it; `0` turns them off | `3` |
| `TESSERA_KB` | a figure knowledge base other than the shipped one ([figures.md](figures.md)) | `$KIT/figures/knowledge` |

**Keys are secrets.** `.env` is gitignored; never print, copy or commit a
value from it, and never paste one into a page or a test.

## Workspace layout

- **Decks live in `decks/<deck>/`** (or wherever `TESSERA_DECKS` points),
  one folder per deck, never loose at the root.
- **Everything a tool generates goes under the deck's `build/`**: shots,
  checks, media, figure pages, work copies, publish output
  ([authoring.md](authoring.md), "Where files go").
- **Each deck has a `README.md`**: what the deck is, its sources, the commands
  that rebuild it, and its standing rules (wording, which slides are frozen,
  who it is for). An agent reads it before touching the deck.
- **A workspace may nest tessera** (`tessera/` beside its own `decks/`, its
  own `.env` and template) and add its own agent skills on top: a brand
  template, accounts and links, the author's preferences. Those skills link to
  these pages instead of restating them, so each fact has one owner.
