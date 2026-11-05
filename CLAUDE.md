# tessera — working agreement for agents

Tessera is a slide app where the whole deck is one HTML file: the document
(plaintext JSON in `#tessera-doc`), the viewer, the presenter and the editor.
It adds live audience polls and games, interactive figures and an editor where
an agent builds and a person fixes. `AGENTS.md` points here.

| folder | what | read |
|---|---|---|
| `docs/guide/` | **authoring decks**: anatomy, `slide.py`, figures, polls and games, conversion, publishing | `docs/guide/README.md` |
| `tools/`, `kit/` | the authoring tools (Python) and the ready-made pages (engagement, figures, knowledge base) | `TOOL --help`, the guide |
| `template.html`, `template/` | the default template (it IS the source) and the figures spliced into it | `template/README.md`, `docs/guide/reference/TEMPLATE.md` |
| `slides/` | the app (TypeScript, Vite) → one-file shell | `docs/architecture.md`, `docs/format.md` |
| `slides/src/live-shim.js`, `game-sdk.js` | browser scripts every live page runs: the live link, the game SDK | `docs/game.md` |
| `server/poll-worker/` | the poll + game + AI service (Cloudflare Workers Free) | `docs/server-setup.md`, its `README.md` |
| `scripts/` | build, re-host (`upgrade-deck.mjs`), agent bridge, tests | `docs/agent-live.md` |

## Routines

```bash
cd slides && npm run build:single && cd .. && node scripts/upgrade-deck.mjs template.html   # engine change → shell → template
cd server/poll-worker && npm test        # then `npm run deploy` (syncs live.js/game.js, e2e, wrangler deploy)
```

Re-host a deck with the same `upgrade-deck.mjs`. Skipping the build is the
classic failure: the typecheck passes and the shipped shell has never heard of
the new field.

## Hard rules

- **Nothing may bill.** Services go on Workers Free, where a limit fails
  instead of charging; no paid plan, no polling that reaches the network
  (live-shim caches it). Model calls are capped per code and open only while
  the slide is shown.
- **Never print, copy or commit the lecturer key** or any `.env` value, never
  put one in a test page. Never seed or clear a poll bucket a real deck uses.
- **Old names stay readable.** Decks written before the rename carry older
  block, format, global and header names (`docs/guide/reference/legacy.md`).
  Those names live only in the `legacy.*` files; new code writes the new names
  and never removes a legacy reader.
- `#tessera-doc` stays plaintext and regex-extractable; no literal script-close
  tag in a bundle or the document (the JSON escapes every `<`). Never
  regenerate a `docId`.
- `node scripts/test-sync.ts` after any change to `slides/src/sync/crdt.ts`.
- New UI strings go into every catalog under `slides/src/i18n/`.
- Re-stamp agent notes (`node scripts/stamp-agent-notes.mjs`) after a
  convention, layout or slide change in `template.html`.
- Edit `slides/src/live-shim.js` / `game-sdk.js` / `legacy-names.js`, never
  their generated copies in `server/poll-worker/public/`.
- No personal or brand material in this repo: a brand template, accounts and
  preferences belong to the workspace that uses it (see the guide's
  "Workspace layout"). `node scripts/release-check.mjs` lints for it.
- Verify before claiming done: typecheck, build, tests, and the change seen in a browser.

## Before non-trivial work

`docs/OVERVIEW.md` (what Tessera adds, the gotchas, open issues — start here),
`docs/DECISIONS.md` (append-only; read before reopening a settled question),
`docs/PLATFORM.md` (invariants that keep shipped files working).

Keep `README.md` current with every change.
