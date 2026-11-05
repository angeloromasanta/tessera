# Games: the game layer of the poll service, and the SDK

_Contract, 22 October 2026. Owner of the wire shape for `/api/game`, `/api/ai`,
the live channels, `game-sdk.js` and the deck↔figure slide messages._

## Why

Before this, every classroom game (group pot, investment, prediction, prompt
game) rebuilt a game layer on top of a poll service made for polls: the screen
held the lecturer key, read whole answer buckets, deduped "last per player" or
"first per company" itself, and wrote its whole state as JSON into the `html`
field of a twin bucket (`CODE.slice(0,11)+"q"`) that every phone polled. That
meant: no identity (a typed name; a reload starts over; anyone can post as
anyone), every player's private result broadcast to every phone, buckets split
to dodge the 500-answer cap, last-writer-wins between two screens, no server
gate on late answers, and ~400 lines of plumbing copied into each game.

The game layer moves that into the service, once. Nothing old changes: answers,
polls, sessions, activity pages and the `html`-field trick keep working.

## Model

A game lives on an activity poll's own code (`c:CODE`, the same Durable Object
as its answers). It holds:

| part | who writes | who reads |
|---|---|---|
| `state`: one JSON value, versioned (`v`) | screen (lecturer key), compare-and-set optional | everyone |
| `accept`: what moves the server takes right now | screen | everyone |
| `players`: `{pid, name, at, kicked}` | each phone joins itself | screen (roster); phones get only `count` and themselves |
| `moves`: `{seq, pid, k, slot, data, at}`, unique per (owner, k) | phones | screen (incremental, `since`); a phone gets only its own |
| `private`: one JSON value per player | screen | that player only |
| `epoch`: changes on reset | screen | everyone (phones rejoin by themselves) |

### Players

The join page keeps a random **device token** in `localStorage`
(`tessera-device`, 24 url-safe chars, made once per phone) and hands it to the
activity page as `TESSERA_ACTIVITY.player`. A phone sends it as the header
**`x-tessera-player: TOKEN`** (allowed by CORS). The server derives the public
player id `pid` = first 12 chars of base32(sha256(`CODE:TOKEN`)), lower case:
stable per phone and per game, different across games, never revealing the
token. Nobody can act as another player without their token. A reload keeps
the pid, so a phone that reloads is the same player.

### Moves

A move is one value a player submits under a key `k` (`[A-Za-z0-9_.:-]{1,40}`,
e.g. `r3`, `q2`, `bid`). Uniqueness is per **(owner, k)**, where owner is the
player's `pid`, or `slot` when the phone sends one (`[A-Za-z0-9_.:-]{1,40}`, e.g.
`team:acme`: teammates share it). Modes:

- `last` (default): replaces the owner's earlier move under `k`; it gets a new
  `seq` and `at`, so `since` readers see it again.
- `first`: only the first move under (owner, k) counts; later ones get
  `409 {error:"taken", by: pid, at}`. Atomic (one Durable Object, single
  threaded): this is the buzzer and the "a teammate was faster".

`at` is server time in ms; `seq` is a per-game increasing integer. Order by
`seq` for "who was first".

### Accept (server-side rules)

`accept` is `null` (take every move) or
`{ join?: bool (default true), moves?: [keys] | null, until?: msEpoch }`.
A key pattern ending in `*` is a prefix (`r*`). `moves: []` takes none (the
round is closed). `until` closes after that server time (a countdown the server
enforces; phones get `now` on every read to sync their clock). A refused move:
`403 {error, closed:true}`.

## Routes

All on `/api/game`, routed by `?c=CODE` (or `code` in the body) like every
poll route. Limits in `_lib.js`: 500 players, 10 000 moves (rows) per game,
4 000 chars per move `data` (serialized JSON), 100 000 chars of `state`, 4 000
per player's `private`, 60 chars per name.

`GET /api/game?c=CODE[&since=SEQ]`

- everyone: `{code, v, epoch, state, accept, now, count}` (`count` = players
  not kicked).
- with `x-tessera-player`: adds `me: {pid, name, joined, kicked, private,
  moves: {k: {data, at, seq, slot?}}}` (the moves this pid made).
- with the lecturer key: adds `players: [{pid, name, at, kicked}]`,
  `seq` (the highest move seq), and `moves: [{seq, pid, k, slot?, data, at}]`
  with `seq > since` (all when `since` is absent), ordered by seq. **Paged at
  2 000 moves**: when the reply is cut it carries `more: true` and `seq` is
  then the last seq returned, so the reader reads again at once with
  `since=seq` while `more` is set (the SDK and `TesseraGame.mock` do).
- `seq` keeps counting across a reset (it never restarts); `epoch` is an
  8-character string; `v` starts at 0 and grows on every `state` op and every
  reset (not on kick, join or move).

`POST /api/game` with `{code, op, ...}`:

| op | who | body | returns |
|---|---|---|---|
| `join` | player | `name` | `{pid, epoch, name}`; clears `kicked`; refused (403) when `accept.join === false` for a pid not yet joined |
| `move` | player (joined, not kicked) | `k`, `data` (any JSON), `mode?`, `slot?` | `{ok, seq, at}`; `409 {error:"taken", by, at}`; 403 with `closed: true`, `kicked: true` or `joined: false`; 429 when the game is full; 400 bad token |
| `state` | lecturer | `state?`, `accept?` (`null` clears), `private?: {pid: value or null}`, `ifV?` | `{v}`; `409 {error:"stale", v, state}` when `ifV` ≠ `v` |
| `kick` | lecturer | `pid` | `{ok}`: `kicked = true` (moves kept, flagged in the roster) |
| `reset` | lecturer | — | `{v, epoch}`: players, moves and private gone, `state = {}`, `accept = null`, new `epoch` |

`DELETE /api/poll?c=CODE` (Clear responses) also resets the game.

`data`, `state` and `private` are stored as JSON text and returned parsed.

## Live channels

`/api/live?c=CODE` sockets hear `{"t":"changed"}` after every write, as
before. A socket opened with **`&ch=state`** hears only writes phones care
about: `state` (including private), `kick`, `reset`. Joins and moves do not
wake it, so 60 phones are not re-read on every one of 60 answers. Messages may
carry extra fields (`{"t":"changed","ch":"state"}`); readers match on
`changed`.

`live-shim.js`: `/api/game` is a READ (GET) and a WRITE (POST) route; a GET
without the lecturer key uses topic `c=CODE&ch=state`, with it `c=CODE`; any
write to a code invalidates every topic of that code (when it is sent and again
when it lands, so a timer read in between cannot cache the pre-write reply);
cache keys distinguish key (`#k`) / player (`#p:TOKEN`) requests.

## `/api/ai`: one model route for any game

`POST /api/ai` `{code, task, input, image?}` → `{text, json?}`

- **Audience** (no key): `task` must be declared in the activity page the deck
  published for this code, in
  `<script type="application/json" id="tessera-ai">{"tasks": {"judge": {"system": "...", "model": "anthropic/claude-haiku-5.5", "max": 600, "json": false}}}</script>`.
  Open only while that page was published in the last 3 h (`AI_OPEN_HOURS`),
  like `/api/help`.
- **Lecturer** (key): may send `system` (≤ 8 000 chars) and `model` instead of
  `task`; no publish window.
- Both: `input` ≤ 4 000 chars, `image` a data URL (jpeg/png/webp, ≤ 1.6 MB,
  never stored), `max` ≤ 1 500 tokens, 2 000 calls per code per day
  (`AI_MAX_PER_DAY`). `json: true` asks for JSON and returns it parsed as
  `json` (best effort; `text` always). Model via OpenRouter, default
  `anthropic/claude-haiku-5.5`.

## Libraries

The service serves vendored libraries at `SERVICE/lib/NAME.js` (static assets,
free): `confetti` (canvas-confetti), `matter` (matter-js), `d3`, `chart`
(chart.js UMD). A page loads them with `TesseraGame.lib(name)` or a script tag.
An activity page's 60 000-character limit no longer has to hold a library.

## The phone frame

The join page's activity iframe: `sandbox="allow-scripts allow-popups
allow-popups-to-escape-sandbox"` and `allow="camera *; microphone *;
geolocation *; accelerometer *; gyroscope *; magnetometer *; fullscreen *;
clipboard-write *"`. Still an opaque origin: no storage, no access to the join
page.

## Deck ↔ figure messages (present mode)

- Deck → frame: `{tessera:'slide', on: true|false, id, index}` to every embed
  frame on a slide when that slide becomes current (`on: true`) and when the
  show leaves it (`on: false`), and once when the show starts on it. A
  frame on the current slide that loads late (`loading="lazy"`, a reload) gets
  `on: true` again when it posts `embed-ready`; repeats carry no news. Every
  embed frame gets these, game page or not. Each message also carries the
  same kind under the key pages written before the rename read, and the deck
  accepts either key from a frame (`slides/src/legacy.ts`); such pages also
  find the embed info and the SDK under their old global names
  (`slides/src/legacy-names.js`, first in every embed).
- Frame → deck: `{tessera:'goto', to}` with `to` = `'next'`, `'prev'`, a slide id
  or a 0-based index. Honoured only in present mode and only from a frame on
  the current slide. `'next'`/`'prev'` move like the arrow keys (state slides
  skipped); an id or index goes exactly there, a state slide included.

## `game-sdk.js` (the SDK)

Canonical copy `tessera/slides/src/game-sdk.js`; the worker serves an
identical `public/game.js` (`npm run sync`). **Opt-in**: a page that contains
`<meta name="tessera-game">` gets it injected, after `TESSERA_EMBED` / the live
shim in a deck embed (render.ts) and after `TESSERA_ACTIVITY` / live.js in an
activity page (join page). Plain ES2017, no imports.

```js
const g = TesseraGame.connect(opts?)   // opts: {code, service, role, mock, tick}
// role: 'screen' inside a deck embed (TESSERA_EMBED), 'phone' inside an activity
// (TESSERA_ACTIVITY). code: TESSERA_ACTIVITY.code, or TESSERA_EMBED.poll.previous.code,
// or opts.code (the pinned fallback). No service at all (a poster, a page opened
// on its own) → g.sample === true and an in-memory service (TesseraGame.mock).

g.role, g.code, g.service, g.sample, g.hasKey
g.state, g.v, g.epoch, g.accept, g.now()        // server-synced clock (ms)
g.onState(fn)          // fn(state, g) whenever v changes (also once on connect)
g.ai(task, input, {image, json, system, model, max}) → Promise<{text, json?}>
g.lib(name) → Promise   // loads SERVICE/lib/NAME.js once

// phone
g.me                   // {pid, name, joined, kicked, private, moves}
g.join(name?)          // name defaults to TESSERA_ACTIVITY.name; done by itself on
                       // connect when a name is known, and again after a reset
g.move(k, data, {mode, slot}) → Promise<{ok, seq, at}>  // rejects Error with .status, .taken
                       // (+ .by, .at), .closed, .kicked, .joined (false when not joined), .body
g.onMe(fn)             // fn(me, g) when me changes (private, kicked, own moves)

// screen
g.players              // [{pid, name, at, kicked}]
g.moves                // every move, by seq
g.latest(k)            // Map pid→move: each owner's current move under k
g.onMoves(fn)          // fn(newMoves, g) after each read that brought some
g.publish(state, {accept, private, ifV}) → Promise<{v}>
g.reset(), g.kick(pid)
g.onPlayers(fn)        // fn(players, g) when the roster changes
g.slide.on('enter'|'leave', fn), g.slide.goto(to)   // deck messages above;
                       // g.slide.active / .id / .index hold the last one (null before any)
g.fake(name)           // sample/mock only: a phone handle (a full phone `g`) writing into the mock

// everyone, housekeeping
g.count                // players not kicked, from the last read
g.error                // the last read's Error, null once a read succeeds
g.refresh()            // read now;  g.close() stops reading

// helpers, no connection needed
TesseraGame.fit(stageEl, w = 1280, h = 720)  // scale a fixed stage into the frame; safe at size 0
TesseraGame.joinBox(el, {fg})                // QR + address + join code from TESSERA_EMBED
TesseraGame.mock()                           // the in-memory service the sample mode uses
```

Transport: reads every `tick` ms (default 2000; the live shim turns that into
"only when the server says changed"), paused while hidden; the screen reads
with `since`. Writes are plain `fetch` with the right headers, followed by a
read. A new `epoch` empties `g.moves` and `g.players` and re-reads from the
start.

Details a page can rely on:

- A phone's `g.service` is `''`: its page is a srcdoc of the join page, so
  relative URLs reach the service (`g.lib` loads `/lib/NAME.js`). A phone
  without `TESSERA_ACTIVITY.player` (an older join page) gets a random token per
  page load, so it is a new player on every reload.
- In sample mode the screen holds the key (`hasKey` true), the code is
  `opts.code` or `'sample'`, `g.ai` answers `{text: '(sample) …'}` (`json: {}`
  when asked), and `g.lib` rejects unless `opts.service` names a service.
- `TesseraGame.fit` positions the stage itself (absolute, centred, scaled) and
  sets `overflow: hidden` on the page; it returns the re-fit function.
- `joinBox` prints `previous.join`, else the session, else `previous.code`;
  `opts.code` / `opts.service` override. No service: the code alone.
- The deck's `on: false` on leaving the show (Esc) is posted while the frames
  are being torn down, so a page may never receive it; treat the page's
  `pagehide` as the last word.
