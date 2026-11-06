# Engagement: polls, activities and games

A `poll` element makes a slide two-way: the room scans a QR, answers on their
phones, and the slide fills in live. **The live parts run only in present
mode**; in the editor a poll renders statically (question, options, join
address and code, any saved summary). The element's fields are in
[reference/agents.md](reference/agents.md), "poll"; the ready-made pages (guess the number, lab, interactive
title, groups) in [engagement-pages.md](engagement-pages.md).
The pages live in `$KIT/engage/`, their builders (`make_*.py`) in `$T/`.

**Polls need a poll service**: your own, free, on Cloudflare Workers, set up
once with [../server-setup.md](../server-setup.md). Its setup writes
`TESSERA_POLL_SERVICE` and `TESSERA_LECTURER_KEY` into `.env`
([README.md](README.md), "Configuration"); a new deck takes its
`doc.poll.service` from there when it is created, and `slide.py service DECK`
sets it on an existing deck. Without a service, polls render statically.

Every new poll, game or activity follows **draft first**
([authoring.md](authoring.md)): question set, or a playable one-round skeleton.

## How the room joins

One join code for the **whole deck**, `doc.poll.session`: minted as `s` + 6
chars, or a name such as `my-class` (3 to 24 of a-z, 0-9 and inner
hyphens). A name must be registered with the service, so never type it into
the JSON: `slide.py poll code DECK.html NAME` (deck closed; `--fresh` also
empties every question), or the top bar's join-code button in the editor. A
spec recompile mints a new one: re-run it after `land.py` (or as a
`postcompile.json` step) when the room already knows the name. The
audience scans once and their page follows whichever question is on screen.
Answers still go to each question's own `code`, so each keeps its own results.

```
doc.poll.session   "s9kcft3"                          ← printed on every poll slide
doc.poll.service   "https://join.<subdomain>.workers.dev"   ← the deployment ($TESSERA_POLL_SERVICE)
element.code       "erfrya"                           ← THIS question's answer bucket
```

The phone lands on `<service>/<session>`. A deck with no session prints each
question's own code instead (older behaviour, still supported).

## Pick the kind

| you want | `kind` | the slide shows |
|---|---|---|
| opinions in their own words | `open` (default) | the live **hive**: count, then a honeycomb of answers with one-click LLM-labelled clusters. `--no-hive` gives the classic slide with **Summarize** |
| opinions placed on **your** axes (automation ↔ augmentation, cost ↔ value) | `open` + axes | the **hive matrix**: the same comb, then one click places every answer on one axis (a beeswarm) or two (a 2×2 with quadrant counts). Pick it when the lecture already has the frame and the room should see where it sits in it; pick the hive when the themes should come from the room |
| a vote between named options | `choice` | one live bar per option |
| a temperature check | `rating` | live average and spread |
| a knowledge check | `quiz` | distribution of **scores**; `correct` never reaches a phone |
| a guess at a number, then the truth (a study's result) | `activity`, ready-made: "Guess the number" | the spread of the guesses, the room's median, then the study's number |
| a hands-on lab: the task, a timer, where the room is, help on every phone | `activity`, ready-made: "Lab slides" | the lab card, a countdown and a live Lost / Working on it / Finished bar, and a wall of the screenshots the room shared; phones get an AI helper (text or a photo of the screen), a way to share a screenshot of the result and, on Finished, three next steps |
| attendance, then the room rewrites the slide on screen with an AI | `activity`, ready-made: "Interactive title" | the slide itself, rewritten live by Haiku from the room's ideas, with a QR card and the check-in count |
| a game, or a form nothing above expresses | `activity` | a leaderboard ranked by each phone's `score` |

- **`multi: yes`** lets a `choice` take several picks (toggles + Send; bars
  read as share of respondents). Without it, one tap submits.
- **A `choice` fits about seven options**; the eighth runs off the frame. For
  more, ask an `open` question ("type the table's number") or split the vote.
- `activity` only when the other four genuinely cannot do it.

**An open question is ONE slide: the hive** (template slide
`sl-poll-hive`, "12b · Open question, clustered live"). Its `poll` sits
hidden (`opacity: 0`) under a full-bleed hive embed that shows the question,
the QR and a live count, replays answers into a honeycomb on click, and
clusters them. **Never put a separate question slide before it.** The **hive matrix**
(`sl-poll-matrix`, "12c") is the same one-slide shape with axes instead
of clusters. Its axes live in its own page copy (asset
`page-hive-matrix-<poll code>`), so **set them only through the tools below —
never by editing the asset**. An axis is `Low pole|High pole` (the low pole is
left / bottom); a pole may carry a definition for the rater,
`Automation = AI does the task instead of me`. Choice,
rating, quiz and activity use the classic `sl-poll`. Source:
`$TESSERA/template/README.md`.

**Sample mode.** While the poll's question is still the template placeholder
`Your open question`, both hive pages show baked sample answers, already
clustered / placed (eyebrow `SAMPLE ANSWERS`), and never call the service. So a
copied hive that still shows the template's sample answers has no question
yet: set it (and, for the matrix, its axes) and the slide is live and empty.

## Adding one

**Live deck (open in the editor):** copy the template slide; `slide.py copy`
mints a fresh, collision-free code by itself:

```bash
$PY $T/slide.py copy live sl-poll-hive --after ID     # open question
$PY $T/slide.py copy live sl-poll-matrix --after ID     --axes "Automation|Augmentation" "Use|Build"     --quads "Build to delegate|Build to think|Use to offload|Use to sharpen"   # open, on axes
$PY $T/slide.py axes live NEWID --axes "Cost|Value"          # change them later (quads reset)
$PY $T/slide.py copy live sl-poll --after ID          # then set kind/question/options
$PY $T/slide.py set live NEWID POLLID 'kind="choice"' 'question="Which first?"' 'options=["Cost","Speed","Quality"]'
```

**Deck on disk, no spec:** `deck_build.py add-poll` (offline only: it writes
the file). It mints a bucket that cannot collide, mints the session if
missing, backs the file up to `build/backups/` and re-parses its output.

```bash
$PY $T/deck_build.py add-poll deck.html --kind open \
    --question "What is the biggest barrier at your school?" \
    --notes "90 seconds, then click, Cluster, read the themes out."
$PY $T/deck_build.py add-poll deck.html --kind open --question "What do you want AI for?"     --axes "Automation = AI does it for me|Augmentation = AI makes me better" "Use|Build"
$PY $T/deck_build.py add-poll deck.html --kind choice --question "Which first?" --options "Cost|Speed|Quality"
$PY $T/deck_build.py add-poll deck.html --kind rating --question "How confident are you?" \
    --min 1 --max 7 --min-label "Not at all" --max-label "Totally"
$PY $T/deck_build.py add-poll deck.html --kind quiz --question "Quick check" --quiz-file quiz.md
$PY $T/deck_build.py add-poll deck.html --kind activity --question "Beat the clock" \
    --activity $DECK_DIR/build/game.html --require-name
```

Extras: `--after <slide-id>` / `--index N`, `--kicker`, `--require-name`,
`--no-hive` (open only), `--axes` / `--quads` (open: the hive matrix), `--code` (only to keep collecting into an existing
bucket), `--dry-run`. Slide ids: `slide.py ls deck.html`. A quiz file is `.md`
(one `###` per question, `-` per option, `*` on the right one) or `.json`
(`[{q, options, correct}]`).

**In a spec** ([reference/SLIDE_SPEC.md](reference/SLIDE_SPEC.md), `## poll`): `kind: activity` takes
`activity: build/game.html`; `requirename: yes` asks for a name; `showjoin: no`
makes a reporting slide. Codes are fresh unless you write `code:`. **Do write
it** when a later slide reads that bucket back.

**By hand**, the element (the `poll` layout puts it at `56,140,1168,456`):

```json
{ "id":"aq-poll","type":"poll","x":56,"y":140,"w":1168,"h":456,
  "rotation":0,"opacity":1,"fontSize":38,"color":"#1A2326",
  "kind":"choice","question":"Which should we do first?",
  "options":["Cost","Speed","Quality"],"code":"vote01" }
```

`code` matches `/^[a-z0-9]{4,12}$/`, unique in the deck, minted from
`abcdefghjkmnpqrtuvwxy346789` (no look-alikes off a projector, no leading `s`,
which is reserved for sessions). `showJoin: false` drops the QR, address and
code: for a slide that reports a bucket already answered.

**Then look at it:** `$PY $T/shoot.py deck.html --id NEWID`.

## Codes: the one thing that goes wrong

**A copied poll needs a fresh `code`**, or the copy shows the original's
answers and a phone that answered one is told it answered both (the identity
rules for elements and whole decks: [authoring.md](authoring.md), "Identity").
Two deliberate exceptions reuse a bucket: a **state slide** showing one
question another way, and a **reporting slide** (`showJoin: false`);
`slide.py fork --polls` and `poll code --fresh` keep them sharing.

**Never change a code to reset rehearsal data.** Figures hard-code bucket
codes; clear the bucket instead (`slide.py poll clear`).

## The wire contract

The service is `$TESSERA/server/poll-worker/` (Cloudflare Workers, Durable
Objects; deployed with [../server-setup.md](../server-setup.md)). Source of
truth for the routes: `server/poll-worker/src/api/`. Never move a deck to
another deployment silently: its answers stay behind in the old one. Every
route answers any origin (`Access-Control-Allow-Origin: *`), so a sandboxed
embed or activity can call them. `GET /api/live?c=CODE|s=CODE` is a WebSocket
that sends `{"t":"changed"}` after every write (the live link uses it; pages
never need to).

**A script that calls the service must send a `user-agent` header.**
Cloudflare refuses the default one of Python's `urllib` and some other
clients with error **1010** before the request reaches the worker. The tools
set one; a hand-written `curl` is fine, a bare `urllib.request` is not.

| route | caller | body / query | returns |
|---|---|---|---|
| `POST /api/answer` | phone | `{code, text, question?, name?}` | `{ok, count}` |
| `POST /api/upload` | phone | `{code, dataUrl}` (an image) | `{url, id, bytes, mime}` |
| `GET /api/poll?c=CODE` | anyone | — | `{code, question, count, answers[], answersWithheld?, summary, summaryAt, html}`; **`answers[]` is 🔒** |
| `GET /api/session?s=S` | phones | — | `{session, active, at}` |
| `GET /api/qr?c=CODE` | slide | `&fg=RRGGBB` | SVG |
| `POST /api/draw` | phone (prompt game) | `{code, prompt, prev?, state?, repair?}` | `{js, state, broken, fixed, turn}`: one `draw(ctx, t)` function. Open only while the activity page was published in the last 3 h; 2,000 calls a day per bucket. One reply (the 2nd or 3rd) carries a planted error that stays until the student says what the error is; failed calls and code that does not compile are retried by the service, and `repair` (the phone's report that the code throws or is too long) has the model fix its own error without counting a turn |
| `POST /api/help` | phone (lab helper) | `{code, mode:"ask"\|"next", question?, image?, history?}` | ask: `{answer}`; next: `{ideas:[{title, why, prompt} x3]}`. Only for a bucket whose published page has a `lab-context` tag, published in the last 3 h; 3,000 calls a day per bucket. The image (a data URL) is never stored |
| `GET /api/game?c=CODE` / `POST /api/game` | screen, phones (games) | `since`; `{code, op, ...}` | the game layer: [Games](#games), [../game.md](../game.md). A phone sends `x-tessera-player`; the roster, every move and `state`/`kick`/`reset` are 🔒 |
| `POST /api/ai` | phones, screen (games) | `{code, task, input, image?}` | `{text, json?}`; the task must be declared in the published activity page ([../game.md](../game.md)), open 3 h after the publish; 🔒 may send `system` instead |
| `GET /api/remix?c=CODE` | screen, phones (interactive title) | `&v=VER`, `&hist=1` | `{ver, html, same, log[], hist?}`: the slide as rewritten so far; `hist` the earlier versions `[{ver, html}]` |
| `POST /api/remix` 🔒 | screen (interactive title) | `{code, op:"seed"\|"apply"\|"reject"\|"undo", ...}` | `{ver, html, applied?, skipped?}`; Haiku rewrites the slide with a batch of ideas |
| `GET /api/lecturer` | deck | header | `{required, ok}` |
| `POST /api/poll` 🔒 | deck | `{code, html}`: publish an activity | `{ok}` |
| `DELETE /api/poll?c=CODE` 🔒 | deck | — | `{cleared}` (answers and images) |
| `POST /api/session` 🔒 | deck | `{s, active}` | `{ok}` |
| `POST /api/summarize` 🔒 | deck | `{code, question, prompt?, model?}` | `{summary}` |
| `POST /api/cluster` 🔒 | hive | `{code, op, ids?}` | themes + placements |
| `POST /api/cluster` 🔒 | hive matrix | `{code, op:"score", axes, ids?}` | per answer `s` (LLM, −3…+3 or null per axis) and `e` (embedding projection); cached per axes |

An answer is `{id, text, at, name?}`; `text` is always ONE string (a choice
sends the option text, a rating digits, a quiz its picks as JSON, an activity
whatever it posts). Limits (`_lib.js`): 2000 chars per answer, 500 per
bucket, 60 000 chars per activity page, **600 kB** per uploaded image.

## Every read counts

Every poll read counts against a daily request limit. On **Workers Free**
that is **100,000 requests a day** for the Worker and, separately, for its
Durable Objects. Past a limit, requests **fail** (`429`, Cloudflare error
1027) until the counter resets at **00:00 UTC**; nothing is billed, because
the free plan cannot bill. So a polling mistake does not cost money, it breaks
the next class. (On a paid plan or another backend the same mistake becomes a
bill: the rules below are what keeps it bounded either way.) Design inside
these layers, never around them:

- **The live link** (`$TESSERA/slides/src/live-shim.js`) wraps `fetch` in
  every embed, the deck window, the join page and every activity page (the
  join page inlines it). A GET to `/api/poll`, `/api/session` or `/api/remix`
  opens one socket to that code and is then answered from the last reply until
  the code changes, and from cache whenever the page is out of sight. So a
  page may poll on a timer and still reach the network only when there is
  news. It does not reach a figure on `live.py`/`devSrc` or a page opened on
  its own; after a shell rebuild, re-host decks so they carry it.
- **Server.** Answers are cached in each poll's Durable Object, so a read
  costs one request and no storage scan. A new route that pages call repeatedly must be cheap per call and
  send `changed()` on writes; a route that calls a model gets a per-bucket daily
  cap like `draw`, `help` and `remix`.
- **The page.** A timer that reads the service: 2.5 s at the fastest, stopped on
  `visibilitychange` when hidden, stopped for good once its job is done (a
  closed round, a revealed answer). Never poll a URL that changes every tick
  (a timestamp in the query defeats the cache). Phones never read `answers[]`
  (refused anyway). Large POST bodies (photos) put `?c=CODE` in the URL; the
  live link adds it for JSON bodies with a `code`.

**What a class costs, and how to check.** A class with a few polls and a game
for a room of 50 to 100 should use **a few thousand requests**. After a class
with a new live figure or game, look at the day's use: Cloudflare dashboard →
Workers & Pages → your worker (`join`) → Metrics (requests, and the Durable
Objects requests beside them). Tens of thousands means a page defeats the live
link: something is still polling (often a tab left open in the background).

## The lecturer key: one rule

🔒 routes, **and the `answers[]` of `GET /api/poll`**, need the lecturer key:
the service's `LECTURER_PASSWORD` secret, which its setup sets
([../server-setup.md](../server-setup.md)); while it is unset, every presenter
route is refused. Without the key, `GET /api/poll` still returns `count`,
`question` and `html`, but `answers` is `[]` with `answersWithheld: true`
(every phone holds the code, so open answers would let anyone read
everyone's).

- The presenter enters the key once per browser; it lives in `localStorage`,
  never in the `.html`. Agent tools (`slide.py poll ...`, `publish.py
  students`) read `TESSERA_LECTURER_KEY` (or `LECTURER_KEY`) from the
  gitignored `.env` ([README.md](README.md), "Configuration"); never print, copy or commit it.
- On the wire: header `x-tessera-lecturer: <key>` (`?pass=` also works for a
  terminal `DELETE`). Missing or wrong on a 🔒 route: `401 {error}`.
- **So a reading embed needs the key**, and gets it only from
  `window.TESSERA_EMBED.poll.lecturer` (below), which is empty until the
  presenter has entered it in that browser.
- The key protects the presenter's controls and the raw answers, not privacy
  in general: tell the room what you collect.

## Answers from one slide, shown on another

The pattern for "the room submitted something earlier; now analyse it". A
later `embed` fetches the earlier bucket and draws whatever it likes.

**`window.TESSERA_EMBED`** is injected before an **inline** embed page
(`asset`/`html`, not a URL: on the edit canvas a figure running from
`live.py` through `devSrc` gets none; in present mode it runs from the page in
the file and does) whenever the frame runs live, i.e. in present mode or with
`liveInEditor`. Its exact shape
(`$TESSERA/slides/src/render.ts`, `embedPreamble`):

```js
window.TESSERA_EMBED = { poll: {
  service,   // doc.poll.service (or the build default)
  session,   // doc.poll.session, "" if none
  lecturer,  // the presenter's key from localStorage, "" if not entered
  previous,  // nearest poll at or before this slide: {code, kind, question, join} | null
} }
```

Read `previous.code` rather than hard-coding: it survives code reminting. Pin
`code:` on the collecting slide only when the embed reads a poll that is not
the nearest one before it, and hard-code that as the fallback.

```js
const HOST = (window.TESSERA_EMBED && window.TESSERA_EMBED.poll) || {};
const SERVICE = HOST.service || "";   // no fallback: the deck always passes its own service
const CODE = (HOST.previous && HOST.previous.code) || "teeth4";   // pinned fallback

async function answers() {
  const r = await fetch(`${SERVICE}/api/poll?c=${encodeURIComponent(CODE)}`, {
    cache: "no-store",
    headers: HOST.lecturer ? { "x-tessera-lecturer": HOST.lecturer } : {},
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  if (d.answersWithheld) throw new Error("withheld: enter the lecturer key in the deck");
  return d.answers || [];   // [{id, text, at, name?}]
}
```

- **Say so on `answersWithheld`**; never draw a chart of zeros over a room
  that answered.
- Load once on open and offer a **Refresh** button, no timer. A figure that
  shows answers arriving live may poll, every 2.5 s at the fastest (see "Every
  read counts"). Always give a manual fallback (paste box, file drop):
  no-wifi rooms are common.
- A `poll` element always draws its QR, so a *reporting* poll slide looks like
  a new question: use `showJoin: false`, or report with an `embed`.
- **Themes, not exact matches:** use **Summarize** on an `open` poll. If an
  `activity` collected the data (JSON `text`), have it also post the one field
  you want themed to a second bucket an `open` poll owns, after the real
  submission and best-effort (`.catch(() => {})`). Give that slide
  `showJoin: false` and word its question as a statement.

## Images from the phones

An answer is text, so the phone uploads the image and sends the URL:

```js
const up = await fetch("/api/upload", { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: HOST.code, dataUrl: await shrink(file) }) });
const { url } = await up.json();      // public, unguessable, dies with the bucket
```

Images only, **600 kB** decoded, counting against the 500-per-bucket cap:
downscale on the phone first (canvas ~1000px, JPEG q0.7). Links from chat
tools are often behind a login: give the display embed a file-drop fallback.
The lab slide has this built in (*Share your result* on the phone, *View
outputs* on the card: [engagement-pages.md](engagement-pages.md#lab-slides-timer-room-check-ai-helper)).
A display that shows the pictures reads them from the poll it already reads,
and loads them only when they are shown.

## Activity pages and games

`kind: "activity"` ships a self-contained page to every phone. The deck
publishes it on the slide's first entry in present mode; phones load it into a
sandboxed iframe. Start from **`$KIT/engage/activity.html`** (a working timed
quiz; edit `CONFIG`, leave the engine). The contract:

1. **One self-contained file**: no CDN, web fonts or imports; under
   **60 000 characters** or publishing fails on stage.
2. **No storage**: opaque origin, `localStorage` throws. Keep state in variables.
3. **`window.TESSERA_ACTIVITY = { code, name }`** is injected (`name` only with
   `requireName`).
4. **Post one string** to `/api/answer` (relative URL) as
   `{code, text, question, name}`. By convention `text` is JSON with a numeric
   **`score`**, which the leaderboard ranks. Cap fields; max 2000 chars.

**A whole game is one slide**: a hidden `activity` poll (`requireName`) under
a full-bleed screen embed (`keepPollOpen`, `liveInEditor`), logo only. The
screen is the admin view, with the lecturer's controls on it; the phone is the
activity page. A spec writes it as `## game`, a deck without one gets it from
`make_game.py` ("Games", below). A new game runs on the **game layer**
(below); older games use the poll bucket as their
control channel (the screen posts its state into a twin bucket's `html`,
phones read it there) and keep working, with that design's limits: no
identity, every result broadcast, about 500 answers a bucket. Pin the codes
so a recompile mints only a new join code.

**The slide's own page** (the figure over a hidden `activity` poll: a wall, a
game board, a leaderboard) is usually a 1280x720 HTML stage that scales itself to
the frame. It must skip a frame with no size and fit again later, or the slide
is blank whenever the slideshow starts on it (it still works in the editor and
when the show starts earlier). Copy `fit()` from `$KIT/engage/groups.html` and run
`$PY $T/fitguard.py PAGE.html` (exit 0) before bundling.

Check the UI (the POST errors outside the join page, which is fine):
`$PY $T/shoot.py $DECK_DIR/build/game.html --page --size 390x780`.
**Publish the phone page before the room joins**, or early phones see "not
ready yet": `$PY $T/slide.py poll publish DECK.html SLIDE_ID` (or `--all`).
The slide also publishes itself when first shown in present mode; the lab
helper and the prompt game answer only for 3 h after the last publish, so
publish on the day. An activity is also the escape hatch for ordering tasks,
two-question forms, drawings, team tallies. (A countdown timer touches no
server, so it is a figure: [figures.md](figures.md).)

## Games

A game is round after round with the screen in charge: who is playing, what
each phone did, and what each phone should now see. The **game layer** of the
poll service holds that, so a page does not rebuild it on answers. Use
it for any game with rounds, scores, a buzzer, teams or a result per player;
keep plain answers (`/api/answer`, above) for a one-shot form whose results the
screen only counts.

What it gives, per activity code (wire contract, limits and the full API:
[../game.md](../game.md)):

- **Identity.** The join page keeps a device token; the service derives a
  player id (`pid`) from it. A reload is the same player, nobody can play as
  someone else, a typed name is only a label. The screen can remove a player
  (`kick`).
- **Moves under keys** (`r3`, `bid`): `last` replaces the player's earlier
  move, `first` takes only the first, and a shared `slot` (`team:acme`, `room`)
  makes it the first of a team or of the room: the buzzer.
- **Rules on the server**: `accept` says which keys count right now and until
  when, so a closed round is closed for every phone at once.
- **One versioned `state`** the screen publishes (compare-and-set with `ifV`,
  so two screens cannot overwrite each other) and **a `private` value per
  player** that only that phone reads: each phone's own score and rank, never
  everyone's.
- **No 500-answer cap**: 500 players and 10 000 moves a game, and a `last`
  move replaces instead of adding. Clear responses (`DELETE /api/poll`) also
  resets the game.

**The SDK** (`$TESSERA/slides/src/game-sdk.js`) is the only way a page talks
to it. A page opts in with `<meta name="tessera-game">`; the deck injects it into
the screen embed and the join page into the phone page.

```js
const g = TesseraGame.connect();             // role, code, service: detected
g.onState((s) => draw(s));                 // everyone: the screen's state
// screen
g.onMoves(() => draw(g.state)); g.latest('v2');   // Map owner -> current move
g.publish({phase: 'q', r: 2}, {accept: {moves: ['v2', 'b2']}, private: {[pid]: {score: 3}}, ifV: g.v});
// phone
g.move('v2', 1); g.move('b2', 1, {mode: 'first', slot: 'room'}).catch((e) => e.taken && tooLate());
g.onMe((me) => show(me.private));
```

Without a service (the poster, the page opened on its own) the same calls run
against an in-memory copy and `g.sample` is true; `g.fake(name)` makes
simulated phones, so a screen can play by itself for its poster.

**Building one.** Start from the starter pair
([engagement-pages.md](engagement-pages.md), "Game starter"): a screen and a
phone page, each with one `/*CONFIG*/null/*CONFIG*/`. Two whole games built
the same way sit beside it and are slides of the bundled template: the group pot
(`pot-screen.html` + `pot-phone.html`: teams, rounds, private scores) and the
prompt game (`prompt-screen.html` + `prompt-phone.html`: an AI task declared in
the phone page, `g.ai`); their GAME.json files are
`$TESSERA/template/games/`, their rehearsals `rehearse_pot.py` and
`rehearse_prompt.py`. A game declares its AI tasks in its own page; it never
needs a new server route. Then one command builds
the slide, for any game:

```bash
$PY $T/make_game.py $DECK_DIR/build/game/GAME.json --deck DECK.html [--after ID]
$PY $T/make_game.py $DECK_DIR/build/game/GAME.json --build-only     # pages + poster; prints the spec block
```

`GAME.json` names the two pages and the slide (`slide`), lists the keys the
phone may have (`phone`; the answers stay on the screen) and holds the rest of
the CONFIG (the fields: `--help`). It fills both pages, inlines the deck's
font, checks the phone against the 60 000 characters and the screen with
`fitguard.py`, shoots the poster in sample mode, then uploads the assets and
creates or updates the slide through `slide.py` (an open deck too); a rerun
keeps the slide, its bucket and its `texts`. A **spec deck** takes the built
files in a `## game` block ([reference/SLIDE_SPEC.md](reference/SLIDE_SPEC.md)), with `code:` pinned; rebuild
them with `--build-only` after a page edit.

**Rehearsing** a game: `$T/mock_service.py` is the service in memory
(answers, polls, sessions, the whole game layer, `/api/ai` with canned
replies, the lecturer key) as a Playwright route, with helpers that open the
screen and N phones with the injections the deck and the join page make, SDK
included. `$T/rehearse_starter.py` is the worked example (joins, a
kick, votes that change, a buzzer race, private results, reloads, Back, reset,
no key): copy it beside a game and change the plays. `mock_service.py
--self-test` checks the mock itself.

## Wording is editable in place

Every engagement page (guess, lab, remix, groups, activity starter, game starter, the hive and
the hive matrix) lets the person reword its labels by **double-clicking them on
the edit canvas** (contract: `EMBED_TEXT_BRIDGE` in `$TESSERA/slides/src/render.ts`).

- **CONFIG holds the defaults; the embed element's `texts` overrides win.** Keys
  are the CONFIG field names (`question`, `setup`, `answer`, `do`, `types.0.1`,
  `items.1.label`, `axes.0.neg`, `quads.2`, `eyebrow`, `kicker`…). The make_*.py
  scripts still write CONFIG only; a rebuilt page keeps the person's wording.
- **Never strip, reset or "clean up" `texts`** on an embed, and never bake its
  values into CONFIG unasked. To change a reworded label, edit `texts` itself.
- **The phone half follows the screen:** when the deck publishes an activity page
  it puts the `texts` of the embeds on the poll's slide in front of it
  (`TESSERA_EMBED.texts`, `activityPageWithTexts` in `poll.ts`), and the phone pages
  read the same keys. Present the slide again after a reword so phones get it.
- **The hives' question is the poll's own** (`poll.question`): rewording it on the
  canvas edits the hidden poll's `question`, not `texts`. The hives draw the deck's
  question in preference to the copy the service stored.
- **A new page** follows the figure contract ([figures.md](figures.md),
  "Building rules"); text built in JS reads `TESSERA_EMBED.text(KEY, CONFIG.field)`, and
  wrapped SVG text gets a transparent box holding the whole string (`editBox`
  in guess.html, `spot()` in the hives).

## Rehearsing without a room

**A reading embed can only be rehearsed offline.** The service is locked, and
the key reaches a page only through `TESSERA_EMBED` in the presenter's browser.
Never copy the key from `.env` into a test page. Instead copy the page to
`$DECK_DIR/build/check/`, replace its loader with test data
(`names = [...]; history = [...]; draw();`), shoot it, delete it. That checks
layout and algorithm, which is what goes wrong. A game is rehearsed the same
way, against a mocked service, never the real one (`$T/mock_service.py`,
"Games").

**Never seed or clear a bucket a real deck uses.** For a round trip on the
real service, fork a scratch copy (`slide.py fork COPY.html --polls`, in a
scratch folder), seed its fresh code over `curl` (`POST /api/answer`), then
`slide.py poll export` / `poll clear --yes` on the copy. A real Summarize:
`python $TESSERA/server/poll-worker/test/summarize_live.py` (five made-up
answers, then the scratch poll is cleared).

## Presenting and privacy

- **Reset after a rehearsal:** `slide.py poll clear DECK SLIDE_ID --yes`, or
  `--all --yes` for the deck (in the editor: Save ▾ → *Clear answers…*; on a
  hive, Display → **Clear responses**). It deletes the buckets (answers,
  images, saved clustering) and keeps the codes. **Another section** gets its
  own buckets, old responses kept: `slide.py poll code DECK NAME --fresh` in
  place, or a copy with `slide.py fork COPY.html --polls` (in the editor:
  Save ▾ → *Save a copy…* → "Another room"). One new empty question is a copy
  of the slide (`slide.py copy`).
- `open` answers stay hidden until **Show N responses**; aggregates show from
  the first answer; "Hide results" beforehand sets up a reveal.
- **Summarize** (open only) costs a model call. Only `summary` is written back
  into the file; raw answers stay on the server.
- **Export:** `slide.py poll export DECK` (an overview sheet, then one sheet
  per question; `--out F.csv` for CSV), or Save ▾ → *Export answers (Excel)*.
- A deck with no `service` renders questions and saved summaries only. Don't
  set `service` per element.
- **The projected code grants writing** to anyone; uploaded images are public
  until the bucket is cleared. Answers are anonymous unless `requireName`
  (names never reach the summarizer). Tell the room what you collect.

## Troubleshooting

| symptom | cause |
|---|---|
| no QR, no count | not in present mode, or no `service` |
| "not ready yet" on phones | activity not published: `slide.py poll publish DECK SLIDE_ID`, or enter the slide in present mode |
| answers on the wrong question | two polls share a `code` |
| the room's page never changes question | no `doc.poll.session` |
| phones can't answer | code typo (`o/0`, `l/1`, `s/5`), or the bucket hit 500 |
| activity blank on phones | it used `localStorage`, a CDN, or a blocked fetch |
| `401` on Summarize / Clear / present | the deck has not been given the lecturer key |
| reading embed empty, `answersWithheld` | no key sent: presenter must enter it; page must send `x-tessera-lecturer` |
| slide blank only when the slideshow STARTS on it | its page scales itself with `innerWidth` and ran before the frame had a size: `$PY $T/fitguard.py --deck DECK.html --fix` (or by hand: skip a zero size and re-fit on `load`, a `ResizeObserver` and a 1 s timer, as `fit()` in `$KIT/engage/groups.html`) |
| `error 1010` from a script | no `user-agent` header: Cloudflare refuses the client's default one ("The wire contract") |
| requests at tens of thousands a day (Cloudflare Metrics) | a page still polling past the live link: close the tab; check its timer against "Every read counts" |
| `429` / error 1027 from the service | the day's free requests are used up (resets 00:00 UTC): find the page that polls |
| reading embed shows nothing at all | wrong `code`, editor canvas (not live), or a `src` embed with no `TESSERA_EMBED` |
| reading embed network error | relative URL: use `TESSERA_EMBED.poll.service` |
| blank tiles on an image wall | links behind a login: fall back to dropped files |
