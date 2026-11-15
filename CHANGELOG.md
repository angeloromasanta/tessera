# Changelog

## Unreleased

- **The template's "Start here" page is an animated how-to** for a reader
  who is not technical (`template/figures/start-here.html`). It opens on the
  four steps side by side; each click zooms into one step, drawn as the screen
  the person will see, and plays it: the file moved into one folder, that
  folder chosen in the Claude or ChatGPT desktop app (the picker under the
  message box) and the agent asked to connect, a request building slides in
  the open deck, and one comment ("Make it more interactive") turning a static
  slide into a moving field of hexagons, before and after. The last click returns to the overview. `template/posters.py` waits
  for a page's `<meta name="poster-settle">` before shooting its poster.

## 0.2.0 — 2026-11-15 First public release

- **Every deck points back to the repo.** The shell's head comment and the
  template's in-document agent notes (`SOURCE, DOCS AND UPDATES`, the
  second note) give the repository URL, which docs to read first, the
  CHANGELOG to compare against, and the `doctor` / `upgrade-deck` pair for an
  old shell; the head comment also states the shell version and build date.
  A brand kit's notes module imports `sourceNote()` from
  `scripts/template-agent-notes.mjs` so its decks say the same.

- **No more new pages in an old shell.** A page built with the current globals
  (`TESSERA_EMBED` and the rest) shows its sample state in a deck whose shell
  predates the rename, which only sets the old names. `slide.py` (every write:
  set, push, copy, asset; so `make_lab.py` and the figure tools too) and
  `deckio.splice` now refuse to land such a page and print the re-host command;
  `slide.py doctor` reports an old shell. The guide (`editing.md`,
  `reference/legacy.md`, `reference/agents.md`) now says compatibility runs one
  way, and that a template on the old shell makes every new deck old.

- **Lab slides: share a screenshot, view the outputs.** The lab phone page
  gets *Share your result* (from Working on; Finished scrolls to it): the
  picture goes to `/api/upload`, then a check-in that carries it and the
  current status. The lab card gets *View outputs (N)*: a wall of the shared
  screenshots over the card, one large on a click, arrows to move on, the
  countdown still running. It reads nothing extra (the room's own poll read)
  and fetches pictures only when opened. `make_lab.py` rebuilds older labs
  and updates their speaker note; `mock_service.py` now keeps uploaded
  pictures and serves them at `/api/blob`.

- **Requests can be edited and stopped.** A sent request shows its whole
  text; clicking it edits it (Enter saves, Escape cancels). An edit while the
  agent works on it reaches that agent; an edit of a finished one sends it
  again. While the agent works, the request's × is a Stop button
  (`status: "stopped"`). Both wake `slide.py requests --wait`.
- **Hide a slide.** An eye button beside Duplicate and Delete on each
  thumbnail sets `hidden: true`: the slide stays in the deck, faded in the
  list, and the show, its counter and published copies skip it.

## 0.1.0 — 2026-11-05 First release (private preview)

Tessera is a single-file slide engine: a deck is one `.html` file that edits,
saves and presents itself, built to be authored by an agent and corrected by a
person.

- **Editor.** AI-native: the agent builds, the person reads, fixes text and
  leaves comments per slide in a review list; a phone view for reading and
  asking; version history, frozen copies, tab-to-tab sync.
- **Audience polls.** The `poll` element in five kinds (open with AI summary,
  choice, rating, quiz, activity), one join code per deck, results back on the
  slide, Excel export, frozen student copies that never touch the service.
- **Interactive figures.** The `embed` element: self-contained live pages with
  step engine, editable text, results bound to an earlier poll.
- **Games and activities.** `TesseraGame` SDK with an offline mock; activity
  pages shipped to every phone.
- **Poll service.** Cloudflare Workers Free (nothing can bill), deployable with
  `npm run setup`; join page, sessions, buckets, uploads, clustering, model
  summaries, lecturer key gate. See `docs/server-setup.md`.
- **Agent bridge.** Atomic, ID-addressed patches to an open deck, change
  requests typed in the editor, conflict-safe saves.
- **Authoring tools and guide.** `tools/`, `kit/` and `docs/guide/`; a neutral
  `template.html` whose layouts resolve by role.
- **Formats.** `#tessera-doc`, `TesseraGame`, `tessera-*` keys; decks written
  before the rename still open (`legacy.*` modules).

Earlier history: forked from bento (nyblnet/bento).
