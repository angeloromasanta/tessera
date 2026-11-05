# poll-worker — the poll service on Cloudflare Workers Free

The service behind every live slide: the join page (`/CODE`) the room opens on
its phones, and the `/api/*` routes a deck calls for answers, images, games and
AI features. Each deck names the service it talks to in `doc.poll.service`, so
anyone can run their own. **Deploying it: [docs/server-setup.md](../../docs/server-setup.md)**
(`npm run setup`). This file is for working on the code.

Nothing here can bill. It runs on Workers Free, where a limit makes requests
fail (HTTP 429 / error 1027) instead of charging, and it uses no R2 or other
paid storage. Keep it that way.

## How it is built

| file | job |
|---|---|
| `src/index.js` | the Worker: routes `/api/<route>` to the Durable Object its code names (`?c=` / `?s=`, else `code` / `s` in a JSON body); answers `/api/qr`, `/api/lecturer` itself. Assets (`public/`) are served without running it |
| `src/space.js` | `Space`, one Durable Object per poll (`c:CODE`) and per join code (`s:CODE`): SQLite tables `kv` (the poll document; also the game's `gameState`/`gameV`/`gameEpoch`/`gameAccept`/`gameSeq`), `answers`, `blobs`, and the game's `players`, `moves` (unique per owner, k), `privates`; runs the route handlers (30 s CPU, the Worker has 10 ms); live sockets (below) with hibernation and a `ping` auto-response |
| `src/api/*.js` | the route handlers, written as `handler(req, res)`; `_lib.js` holds CORS, validation, the lecturer key and the storage calls to the Durable Objects (local SQLite when the code is the object's own, RPC otherwise) |
| `src/adapter.js` | runs a `handler(req, res)` against a Workers `Request` |
| `src/legacy.js` | the old request header names and tag id that decks from before the rename still send; the only place they live |
| `public/index.html` | the join page; keeps the device token (`localStorage` `tessera-device`) and hands it to activity pages as `TESSERA_ACTIVITY.player`; inlines `/legacy-names.js`, `/live.js` and, for a page with `<meta name="tessera-game">`, `/game.js` into every activity page; the activity frame is `allow-scripts allow-popups allow-popups-to-escape-sandbox` (still an opaque origin) with camera, motion etc. allowed |
| `public/legacy.js` | the join page's old names (storage keys, meta names, the activity global), read once so phones and pages from before the rename keep working |
| `public/live.js`, `public/game.js`, `public/legacy-names.js` | **generated** from `slides/src/live-shim.js`, `game-sdk.js` and `legacy-names.js` by `npm run sync`. Never edit them here |
| `public/lib/` | vendored libraries for game pages (`/lib/confetti.js`, `matter.js`, `d3.js`, `chart.js`), pinned; versions and licences in its README |
| `scripts/setup.mjs` | `npm run setup`: login, lecturer key, deploy, secrets, `.env` (see the guide) |
| `scripts/sync.mjs` | `npm run sync`: copies the browser scripts into `public/` |

## Games (`/api/game`, `/api/ai`)

The contract is [docs/game.md](../../docs/game.md); this is where it runs. A game
lives on an activity poll's code: a versioned `state` and `accept` rules the
screen publishes (lecturer key), players who join with their device token
(`x-tessera-player`; the server derives `pid` from `CODE:TOKEN`, so a reload is
the same player and nobody can be another), moves under keys (`last` replaces,
`first` is atomic: the buzzer), and a `private` value only its player reads.
Each op is one synchronous method on the object, so check-and-write cannot
interleave. `GET` carries `now` (the server clock); the lecturer's read adds the
roster and the moves after `since` (paged at 2 000, `more: true`). Limits are
constants in `_lib.js` (500 players, 10 000 moves, 4 000 chars a move or a
private, 100 000 of state). `/api/ai` runs a model task the published page
declares in `<script type="application/json" id="tessera-ai">` (open 3 h after
publishing, 2 000 calls per code per day), or the lecturer's own `system`.

**Live channels.** `/api/live?c=CODE` sockets hear `{"t":"changed"}` after
every write, coalesced to one per 400 ms per channel. A socket opened with
`&ch=state` (a phone in a game) hears only state, private, kick and reset
(`{"t":"changed","ch":"state"}`), not joins, moves or answers. The channel is
the socket's hibernation tag.

**The live link** (`live.js`) wraps `fetch` in figures, the deck window, the
join page and activity pages: a GET to `/api/poll`, `/api/session` or
`/api/remix` opens one WebSocket to that code and is then answered from the last
reply until the code changes, and from cache whenever the page is out of sight.
Pages keep their `setInterval` polling; it just stops reaching the network.
Against a service without `/api/live` it gives up after two failed sockets and
the page polls as before.

## The lecturer key

`LECTURER_PASSWORD` (a secret) gates every presenter route: results, clearing,
publishing an activity, the money-spending AI routes. A deck sends it as the
`x-tessera-lecturer` header. **Without it the presenter routes are refused**
(the gate fails closed). It never belongs in a deck, a test page or a commit.

## Settings

Secrets (`npx wrangler secret put NAME`): `LECTURER_PASSWORD`, `OPENROUTER_API_KEY`.
Everything else is optional and read from `process.env` (`nodejs_compat`), so it
can be a secret or a `vars` entry:

| setting | default | what |
|---|---|---|
| `PUBLIC_ORIGIN` | the request's host | the address upload links and the QR point to (a custom domain) |
| `HELP_CONTEXT` | a neutral line | who the lab helper is and who it talks to (the school, the programme) |
| `REMIX_STYLE` | the kit's interactive title | the room, fonts, logos, background and locked column of the interactive title slide, as `- ` lines |
| `SUMMARY_MODEL` | `anthropic/claude-opus-5` | `/api/summarize` (a deck may override per poll) |
| `EMBED_MODEL`, `LABEL_MODEL`, `SCORE_MODEL` | `openai/text-embedding-3-small`, `anthropic/claude-sonnet-5`, = label | `/api/cluster` |
| `HELP_MODEL`, `REMIX_MODEL`, `DRAW_MODEL` | `anthropic/claude-haiku-5.5` | the lab helper, the interactive title, the prompt game (`/api/ai` takes its model from the page's task) |
| `HELP_MAX_PER_DAY`, `DRAW_MAX_PER_DAY`, `AI_MAX_PER_DAY`, `REMIX_MAX_PER_DAY` | 3000, 2000, 2000, 600 | model calls per code per day |
| `HELP_OPEN_HOURS`, `DRAW_OPEN_HOURS`, `AI_OPEN_HOURS` | 3 | how long after the slide is shown the audience routes answer |

## Limits (Workers Free)

100k Worker requests/day (UTC); Durable Objects 100k requests/day, 5 GB storage
per account, 1 GB per object, 2 MB per row; static assets free. A class costs
roughly answers + images + slide changes × open pages, a few thousand
requests, because polling no longer reaches the network.

## Commands

```sh
npm install
npm run setup     # first deploy on your account: see docs/server-setup.md
npm test          # unit tests, the old names (legacy.test.mjs), local end-to-end incl. the game layer (wrangler dev), live link and game pages in a browser (python playwright)
npm run deploy    # sync, the local end-to-end tests, wrangler deploy
python test/summarize_live.py   # one real summary on YOUR deployed service (TESSERA_POLL_SERVICE / TESSERA_LECTURER_KEY from .env)
```

The local tests read `.dev.vars` (gitignored) for a throwaway
`LECTURER_PASSWORD`; `npm run setup` writes it, or write
`LECTURER_PASSWORD=<anything>` there yourself.

Once deployed, keep the worker `name` (`join`) and the Durable Object class
(`Space`) in `wrangler.jsonc`: renaming either starts a new, empty service, and
there is no migration that would move the data.
