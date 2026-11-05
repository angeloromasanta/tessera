# Changelog

## 0.1.0 — 2026-11-05 First public release

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
