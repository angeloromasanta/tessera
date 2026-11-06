# Tessera

**Slides that are one HTML file — and that your audience can answer, vote and play in.**

A Tessera deck is a single `.html` file that is at once the document, the viewer,
the presenter and the editor. Double-click it and it opens in its own editor; no
account, no install, no server. The whole document is plain JSON inside the
file, so an AI agent can build and edit a deck as easily as a person can.

On top of that, Tessera adds what classroom and workshop decks need:

| | |
|---|---|
| **Live polls** | the room scans one QR code and answers on their phones: open text (summarized by AI on stage, or clustered into a live "hive"), multiple choice, rating, quiz, a 2×2 matrix |
| **Activities and games** | a whole self-contained HTML page the deck ships to every phone: a group pot, a prompt game, a drawing round, a lab with a timer whose room shares screenshots of what they made |
| **Running figures** | `embed` elements: animated, stepped, interactive diagrams (a hype cycle that builds on click, a simulation, a countdown timer) inside a slide |
| **An editor built for agents** | the agent builds the deck; you read it, fix text in place and type change requests beside each slide. A local bridge lets an agent patch the open deck live, with conflict checks |
| **A poll service you own** | a small Cloudflare Worker on the free plan. One command deploys it to your own account; a limit fails instead of billing |

## Quick start

Node 20+ and npm; Python 3 for the authoring tools.

```bash
git clone https://github.com/angeloromasanta/tessera.git && cd tessera
cd slides && npm install && npm run build:single && cd ..   # -> slides/dist-single/tessera.html
mkdir -p decks/my-talk && cp template.html decks/my-talk/my-talk.html
python tools/slide.py fork decks/my-talk/my-talk.html --polls  # its own deck: new id, fresh poll codes
```

Open `decks/my-talk/my-talk.html` in Chrome or Edge and edit. `template.html`
is the default template: 22 example slides across 15 layouts, the palette, two
open-licence typefaces (Fraunces, Manrope), polls, the live hive, a lab and two
games. Its conventions are in [docs/guide/reference/TEMPLATE.md](docs/guide/reference/TEMPLATE.md).

**With an agent** (Claude Code, Codex, or any agent that reads files and runs
commands): point it at [docs/guide/](docs/guide/README.md). The tools in
`tools/` read and write one slide at a time, on disk or in the open editor:

```bash
python tools/slide.py ls decks/my-talk/my-talk.html          # one line per slide
python tools/slide.py copy decks/my-talk/my-talk.html sl-points   # add a slide from the template
python tools/shoot.py --help                                  # screenshots to check the result
```

**Polls and games** need the poll service. With a free Cloudflare account:

```bash
cd server/poll-worker && npm install && npm run setup
```

`setup` logs you in to Cloudflare, sets a lecturer key, deploys the Worker and
writes the service URL into your `.env`, so new decks pick it up. Details,
limits and troubleshooting: [docs/server-setup.md](docs/server-setup.md).

## Configuration

Tools read one `.env` (copy [.env.example](.env.example)), found by walking up
from the current folder, so a workspace that nests this repo can keep its own
`.env`, decks and template beside it. The keys are listed in
[docs/guide/README.md](docs/guide/README.md#configuration).

## Layout

```
slides/              the app (TypeScript, Vite) → one-file shell
kernel/              shared machinery: save/splice, autosave, i18n, anim, charts
server/poll-worker/  the poll, game and AI service (Cloudflare Workers Free)
tools/               authoring tools: slide.py, shoot.py, figcheck.py, md_to_deck.py, publish.py …
kit/                 ready-made pages: engagement (kit/engage), figures and their knowledge base (kit/figures)
template.html        the default template — the SOURCE, not a build artifact
template/            figure sources spliced into template.html, and its builder
docs/guide/          the authoring guide (start at its README)
docs/                engine docs: OVERVIEW.md first, then format, platform, architecture
decks/               your decks (gitignored)
```

## Documentation

- **[docs/guide/](docs/guide/README.md)** — authoring decks: anatomy, editing
  with `slide.py`, parallel agents, figures, polls and games, converting a
  `.pptx`, publishing.
- **[docs/server-setup.md](docs/server-setup.md)** — your own poll service.
- **[docs/OVERVIEW.md](docs/OVERVIEW.md)** — how the engine is wired, the
  gotchas, open issues. Then [format.md](docs/format.md),
  [PLATFORM.md](docs/PLATFORM.md), [DECISIONS.md](docs/DECISIONS.md).
- **[CLAUDE.md](CLAUDE.md)** — the working agreement for agents changing the engine.

## Development

```bash
cd slides && npm run dev                   # dev server
npm run build:single && cd .. && node scripts/upgrade-deck.mjs template.html   # re-host the template
node scripts/test-sync.ts                  # CRDT convergence rig
cd server/poll-worker && npm test          # poll service unit + e2e tests
node scripts/release-check.mjs             # no personal data, brand or commercial fonts in the tree
```

## Credits and license

Tessera is forked from [bento](https://bento.page) by nyblnet
([nyblnet/bento](https://github.com/nyblnet/bento)), "the office suite that fits
in a file", whose single-file document model it builds on. MIT, inherited from
upstream — see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Bundled runtime components
(reveal.js, Moveable, Selecto) are MIT; the embedded typefaces are under the SIL
Open Font License.
