# Your own poll service

Polls, word clouds, quizzes, games and the AI features of a deck need a small
web service: the page the room opens on its phones, and the place their answers
are kept. You run your own, free, on Cloudflare. It takes one command and a
Cloudflare account; after that every new deck uses it.

The code is `server/poll-worker/`; its [README](../server/poll-worker/README.md)
is for working on it.

## What it does

- **The join page.** The room scans the QR on a poll slide (or types the
  address and code) and lands on `https://join.<subdomain>.workers.dev/<code>`.
  The page follows whichever question is on screen.
- **Answers, images and games.** Each poll and each join code is a Durable
  Object with its own small SQLite database: the answers, uploaded photos,
  the state of a game and its players.
- **Live updates.** A slide hears about new answers over a WebSocket, so a page
  that "polls" every second does not actually reach the network.
- **AI features** (optional): summaries of open answers, clusters of ideas,
  a lab helper for students, an interactive title the room rewrites, and model
  calls for games. They go through [OpenRouter](https://openrouter.ai) with
  your key, which stays on the service and never in a deck.

## What it costs

Nothing, on the **Workers Free** plan, and it cannot start billing you: past a
daily limit, requests fail instead of being charged.

| limit (Workers Free) | how much |
|---|---|
| Worker requests | 100 000 per day |
| Durable Object requests | 100 000 per day |
| storage | 5 GB per account, 1 GB per poll, 2 MB per answer or image |
| the join page and scripts (static assets) | free, not counted |

A class of 50–100 people answering a dozen questions costs **a few thousand
requests**: roughly answers + images + slide changes × open phones. The limits
reset at **00:00 UTC**.

To see your usage: Cloudflare dashboard → **Workers & Pages** → `join` →
**Metrics**.

The AI features are paid by your OpenRouter account, per call. The service caps
them (below), opens the audience routes only while the slide is shown, and
puts the costly ones behind the lecturer key. Leave `OPENROUTER_API_KEY` unset
and they fail (HTTP 502) while everything else works.

## Before you start

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up). The first
  time you deploy a Worker, Cloudflare asks you to pick a **workers.dev
  subdomain** (the `<subdomain>` in the address); do it in the dashboard under
  **Workers & Pages** if the setup says it is missing.
- Node.js 20 or later, and this repository checked out.
- Python 3 with Playwright only if you want to run the browser tests (`npm test`).
- Optional: an OpenRouter API key, for the AI features.

## Set it up

```sh
cd server/poll-worker
npm install
npm run setup
```

`npm run setup` (`scripts/setup.mjs`) walks you through it:

1. **Logs you in** to Cloudflare (`wrangler login` opens the browser) if you
   are not logged in yet.
2. **The lecturer key**: type one, or press Enter to have a strong one
   generated. It is never shown on screen.
3. Writes it to `server/poll-worker/.dev.vars` (gitignored) for the local tests.
4. **Deploys**: `npm run deploy` syncs the browser scripts, runs the local
   end-to-end tests, then `wrangler deploy`.
5. **Sets the secrets** on the deployed service: `LECTURER_PASSWORD`, and
   `OPENROUTER_API_KEY` if you give one (Enter skips). Values go through stdin.
6. **Writes `.env`**: `TESSERA_POLL_SERVICE` (the address), `TESSERA_LECTURER_KEY`
   and `TESSERA_CF_SUBDOMAIN`. It updates the first `.env` found walking up
   from where you run it, changing only those lines; if there is none, it
   creates one at the repository root. You never copy a value by hand.

Options (`npm run setup -- --help`):

| option | what |
|---|---|
| `--dry-run` | show every step and run `wrangler deploy --dry-run`; writes, sets and deploys nothing |
| `--existing --url <URL>` | the service is already deployed: only write the `.env` lines |
| `--generate-key` | make a new lecturer key without asking |
| `--skip-ai` | do not ask for an OpenRouter key |
| `--env-file <path>` | write this `.env` instead (also `TESSERA_ENV_FILE`) |

## Connect your decks

The address travels inside each deck, so a deck shared with someone else still
reaches your service:

- **New decks** take `doc.poll.service` from `TESSERA_POLL_SERVICE` in `.env`
  when they are created.
- **An existing deck**: `slide.py service DECK` sets it from `.env` (see the
  [authoring guide](guide/engagement.md)).
- **One question elsewhere**: a `poll` element's own `service` field overrides
  the deck's for that question.

`doc.poll.service` is `https://join.<subdomain>.workers.dev` with no trailing
slash and no path.

## The lecturer key

The key unlocks the presenter's side: seeing results, clearing a poll,
publishing an activity, and the AI routes that cost money. Without
`LECTURER_PASSWORD` set, the service refuses all of them (it fails closed).

- It lives in two places: the service (a Cloudflare secret) and your `.env`
  (`TESSERA_LECTURER_KEY`, gitignored), plus `.dev.vars` for local tests.
- When you present, the deck asks for it once (the poll panel) and keeps it in
  that browser.
- **Never put it in a deck**, a figure, a test page or a commit: a deck is a
  file people forward.
- To change it: `npx wrangler secret put LECTURER_PASSWORD` in
  `server/poll-worker`, then update `TESSERA_LECTURER_KEY` in `.env` (or run
  `npm run setup` again).

## AI features

With `OPENROUTER_API_KEY` set (`npx wrangler secret put OPENROUTER_API_KEY`):

| feature | route | model setting (default) | daily cap per code |
|---|---|---|---|
| summary of open answers | `/api/summarize` 🔒 | `SUMMARY_MODEL` (`anthropic/claude-opus-5`) | one per 10 s |
| clusters of ideas | `/api/cluster` 🔒 | `EMBED_MODEL`, `LABEL_MODEL`, `SCORE_MODEL` | per press |
| lab helper for students | `/api/help` | `HELP_MODEL` (`anthropic/claude-haiku-5.5`) | `HELP_MAX_PER_DAY` (3000) |
| prompt-to-drawing game | `/api/draw` | `DRAW_MODEL` (`anthropic/claude-haiku-5.5`) | `DRAW_MAX_PER_DAY` (2000) |
| interactive title | `/api/remix` 🔒 | `REMIX_MODEL` (`anthropic/claude-haiku-5.5`) | `REMIX_MAX_PER_DAY` (600) |
| model calls in games | `/api/ai` | the page's task (`anthropic/claude-haiku-5.5`) | `AI_MAX_PER_DAY` (2000) |

🔒 = needs the lecturer key. The audience routes answer only for
`*_OPEN_HOURS` (3) hours after the slide was shown.

Two settings describe your setting to the models:

- `HELP_CONTEXT`: who the lab helper is and who it talks to, e.g.
  `You are a patient lab TA for a hands-on AI class at <your school>. The students are <who>, not programmers.`
- `REMIX_STYLE`: the room and the interactive title slide's look, as lines
  starting with `- ` (the fonts and logos the slide may use, the background
  under it, the locked column with the title and QR). The default describes the
  kit's interactive title with no brand.

Every setting is optional. Set one as a secret
(`npx wrangler secret put HELP_MODEL`), or for many at once from a JSON file of
`{"NAME": "value"}`: `npx wrangler secret bulk settings.json`. Both apply right
away, without a redeploy.

## A custom domain

The service answers on `join.<subdomain>.workers.dev`. To use your own domain,
add it to the Worker in the dashboard (**Workers & Pages** → `join` →
**Settings** → **Domains & Routes**), then set `PUBLIC_ORIGIN` to it
(`https://polls.example.org`) so upload links and QR codes point there, and put
the same address in `TESSERA_POLL_SERVICE` (`npm run setup -- --existing --url https://polls.example.org`).

## After engine changes

When you update this repository, redeploy so phones get the current join page
and scripts:

```sh
cd server/poll-worker
npm run deploy
```

Your answers, secrets and settings stay. Keep the worker name (`join`) and the
Durable Object class (`Space`) in `wrangler.jsonc`: renaming either starts a
new, empty service.

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| a script gets **error 1010** (HTTP 403) | Cloudflare blocks requests without a browser-like `user-agent` (Python's default is refused) | send a `user-agent` header, e.g. `tessera-tools/1.0` |
| **HTTP 429**, or **error 1027** | the daily Workers Free limit is used up | wait for the reset at 00:00 UTC; check usage under Workers & Pages → `join` → Metrics |
| the deck says **"This deck has no poll service yet."** | the deck has no `doc.poll.service` | `slide.py service DECK`, or check `TESSERA_POLL_SERVICE` in `.env` and create the deck again |
| results stay empty, controls say they need the key | the deck has no key, or not the one on the service | type the key from `.env` into the poll panel; `GET <service>/api/lecturer` with the key in `x-tessera-lecturer` says `{"ok": true}` when it matches |
| an AI feature fails with HTTP 502 (`OPENROUTER_API_KEY is not set`, or a helper that "could not answer") | no OpenRouter key on the service, or OpenRouter refused it (credit, model name) | `npx wrangler secret put OPENROUTER_API_KEY`; check the key and credit on openrouter.ai |
| `npm run setup` says there is no workers.dev subdomain | a new account has none yet | pick one in the dashboard (Workers & Pages), then run setup again |
| a local test stops with "No .dev.vars" | the tests need a throwaway key | `npm run setup`, or write `LECTURER_PASSWORD=<anything>` to `server/poll-worker/.dev.vars` |

## Take it down

```sh
cd server/poll-worker
npx wrangler delete
```

This deletes the Worker and **all its answers and images**, and every deck
pointing at it stops reaching it. Remove `TESSERA_POLL_SERVICE` from `.env`
afterwards.
