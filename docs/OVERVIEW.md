# Tessera overview: what it adds, how it is wired, what bites

Working notes for changing this repository. `CLAUDE.md` is the router; this is
the file to read before non-trivial engine work. Authoring a deck needs none of
it: that lives in `guide/` (see `README.md` here).

Forked from bento (nyblnet/bento, MIT). On top of it Tessera adds the `poll`
element and its service, the `embed` element (interactive figures and games),
activities, the AI-native editor, the agent bridge, and a neutral template
(`template.html`).

**AI-native editor (October 2026).** The agent builds the deck; the person reads,
fixes text and asks for changes. The top bar holds only: the title; on the
right **Save ▾**, the save state with a cloud icon that is also the Save
button (Saved / Saving… / Not saved to the file; a click or ⌘S saves) and its
▾ (Save a copy…, Version history…; Export a frozen copy…,
`editor/export-frozen.ts`; Export answers (Excel) and Clear answers… for a
deck with questions; Pause agent edits where an agent can connect), then
**Present ▾** (Present in this tab, Present in a new tab, Open speaker view, and for a deck with
questions the join code, `editor/joincode.ts`). A slide an agent changes gets a
green ring on its thumbnail for 5 s after each edit (`tessera-agent-edited`
from `agent-editor.ts`; request status and replies do not count).

**The review list (2026-10-28, `editor/ask.ts` `RowAsk`, `editor.ts`
sidebar).** The
left column is SLIDE | WHAT SHOULD CHANGE?: a "Whole deck" row first (a small
label, no thumbnail, its comments across the whole row; its threads are
`doc.requests`), then one row per slide with its number, thumbnail and a field
that is always there ("Add a comment…", "What should this slide be?" on an
empty slide). Enter sends and moves to the next slide's field (`afterSent`);
Up on the field's first line and Down on its last move to the row above or
below and open that slide (`moveRow`, `RowAsk.atEdge`, which measures wrapped
lines on a hidden copy). A row shows its latest request; earlier ones fold
behind "n earlier". Each request starts with a status dot (hollow waiting,
pulsing blue working, green done);
hovering the dot shows the agent's reply (`.ed-reply-pop`, one fixed box on
the body so the scrolling list does not clip it). A done request shrinks to its green orb (`.ed-row-orbs`, `RowAsk.orb`): hovering it shows the request and the reply, a click pins the box with Edit and send again and Delete. In the review list the
thumbnails carry no orbs; the narrow list and the grid, which have no fields,
keep them (`requestOrbs`, `paintOrbs(…, withOrbs)`). The top bar says "{agent} is working on N requests"
and the canvas chip "{agent} is updating this slide" while a request on the
open slide is worked on (and 5 s after each agent edit); the name is the one
on the latest agent edit or reply, else the words are neutral. The `RowAsk`
of each slide is kept across list rebuilds (`rows`), so a half-typed comment
survives a move. ＋ between rows and New slide insert an empty slide and focus
its row's field; `NewSlidePrompt` (the canvas box) shows only when the list
has no fields. Right of the list: "Slide n of N" with ‹ ›, the slide, and the
speaker notes under it (`NotesView` in `.ed-notes-panel`, folds with `]`).
See `agent-live.md`, "Change requests".

**List width, maximize, selection (2026-10-28).** Dragging the list wider
only grows the rows (thumbnail 150 to 360 px, `--thumbw`); below 330 px it is
thumbnails only; it may take all but 360 px of the window
(`tessera-ed-review`). The line between thumbnails and comments
(`.ed-col-handle`, review list only) is dragged to set the thumbnail width
(`thumbW`, saved as `thumb` in `tessera-ed-review`; the comments keep 160 px;
thumbnails are rescaled in place while dragging, rebuilt on release);
double-click hands it back to the list width. The icon at the end of the list's header maximizes it:
the slide and notes are hidden and the list is a grid with orbs and no fields;
the icon or Esc restores, a double-click on a thumbnail restores and opens it
(`setMaximized`). In the list and the grid: click picks one slide,
Shift-click a range, Ctrl/⌘-click toggles one (`picked`, UI state only);
dragging a picked thumbnail moves them all with their interactive states,
before or after the row it lands on (`moveSlides`, one undo step). There is
no keyboard move. Group/ungroup live in `editor.ts`.

**No unsaved-changes banner (2026-10-28).** A recovery snapshot that differs
from the opened file is filed into Version history at its own time
(`addVersion(…, at)`) and the slot cleared; nothing is offered on open. The
leave-page prompt fires only when the file is behind and no browser copy
exists; otherwise leaving flushes the save.

**Phone view (2026-10-22, `editor/phone.ts`).** On `(max-width: 760px), (pointer:
coarse) and (max-width: 1024px)` (re-evaluated live; `?view=phone|desktop`
forces one) the editor hides its desktop DOM and shows every slide in one
vertical scroll, fitted to the width, with its own request cards and ask box (`RequestList`, `AskBar`) in a
bottom dock. No editing: no canvas, handles or label double-click. The box is
bound to the slide covering most of the list (a tap on a slide picks it; the
binding freezes while the field has focus) through `store.goTo`, so a request
is committed by the desktop code path; `agent.goTo` scrolls the list. Cards
paint when within 1.5 screens; figures run (`liveMedia`) only while their card
is on screen and fall back to posters off screen; tapping a figure steps it.
The view is sized to `visualViewport`, so the keyboard shrinks it from below.
The desktop canvas is held (`SlideCanvas.hold`) while the phone view shows.
Every sent request also fires `window` event `tessera-request` (`{slideId,
request}`, `slideId` empty for a whole-deck one) for a page that must carry it elsewhere: a live mirror
(`tools/live/`) has no bridge and its next disk sync deletes a request
typed on the phone (verified 2026-10-22) until it forwards that event.

**Removed on 2026-10-22** (`DECISIONS.md`, "Upstream surface removed"): the
properties panel (`panels.ts`), insert tools, Share and the relay
(`sync/online.ts`, `sync/blobs.ts`, `server/sync-worker`), the About dialog,
self-update (`kernel/src/update.ts`, signing and release scripts), remote
language packs (bundled catalogs and already-embedded packs only), PDF export,
the help overlay, the password UI (encrypted files still open and save
encrypted), "Copy/Replace document JSON" (`window.tessera.loadDoc` stays),
`spaces/`, `site-src/`, `ios/` and the guestbook. Nothing calls the upstream site.
Tabs on one machine still sync over BroadcastChannel (`collab-design.md`). Do
not bring any of it back in an upstream merge. The editor is also used by other
people with their own agents, so UI copy says "agent", never a product name.

Text inside figures is editable: pages mark labels `data-edit="KEY"` (or read
`TESSERA_EMBED.text(KEY, default)`), the person's edits are stored on the element
as `EmbedElement.texts`, and `EMBED_TEXT_BRIDGE` in `render.ts` does the
in-frame editing on the edit canvas only. The key `poll.question` edits the
reported poll's question instead. Poll options, quiz questions and scale labels
edit in place too (`data-poll-field`).

**A texts change never reloads a running figure** (2026-10-22). Rebuilding the
srcdoc sends a figure back to step 0, so when all that changed on a slide is
`embed.texts` (undo/redo, another tab, an agent) the canvas (`update` in
`canvas.ts`) and the phone view post `{tessera:'set-texts', texts}` into the
frame instead; the bridge applies it, giving a removed key back the node's own
wording (or the default the page passed to `TESSERA_EMBED.text`). `slideLook` /
`postChangedTexts` / `watchEmbedTexts` in `render.ts` are the shared halves: a
look key that leaves out texts and comments, and a listener that resends texts
to a frame that reloaded with an older srcdoc (`embed-ready`) and rebuilds one
that answers `texts-applied` with `stale` (a changed key drawn by script with
no `[data-edit]` node). Any other change still rebuilds the slide.

---

## 1. Audience polls (`poll`)

A `poll` element turns a slide into a two-way moment: the room scans a QR,
answers on their phones, and the slide fills in live. Five kinds — `open`
(free text, AI-summarized on stage), `choice`, `rating`, `quiz`, `activity`.

**Where the code is.** `slides/src/poll.ts` is the only surface that touches
the network.
`render.ts renderPollBody` draws the element *statically* everywhere — question,
options or scale, join URL + QR, saved summary — and `present.ts
mountLivePolls`/`disposeLivePolls` ENRICHES that same DOM with the live count,
Summarize, result bars and the hide/show toggle. Wire per-slide-entry hooks in
BOTH places (`slidechanged` and the `deck.initialize().then()` block), and
dispose every section on exit or a leaked 3s interval keeps hitting the service.
`tallyChoices` / `ratingStats` / `quizStats` in `model.ts` do all the
arithmetic, so slide, figure and export cannot disagree.

**One join code per deck.** `doc.poll.session` (minted `s` + 6 chars —
`CODE_ALPHABET` has no `s`, so the join page tells a session code from a
question code with no round trip). `mountLivePolls` publishes the on-screen
question to `/api/session`; the audience page polls it every 2.5s, so the room
scans once and follows the speaker. Answers still go to each question's own
`code`, which is why summarize/clear/export are per-question.
`pollJoinCode(doc, el)` is what the slide prints; a deck with no session falls
back to per-question codes, so pre-session files are untouched.

**The lecturer can name the join code** (the join code button in the top bar,
`editor/joincode.ts`: `my-class-2026`; 3 to 24 of a-z, 0-9 and inner hyphens,
`isJoinCode` / `SESSION_RE`; the same popover can make every question start
empty). A name has no `s` to recognise it by, so it is a session only
once the service knows it: `claimSession` (`poll.ts`) registers it when the
name is set and at the top of every show, without touching what the room is on,
and `GET /api/session` returns `exists`. The join page still decides alone
where it can (a minted `s…` code; any name with a hyphen or over 12 characters
can never be a question code) and asks only for a short plain name. A name
that is already a question's bucket is refused (409). Sessions have no owner:
two decks given the same name steer one room.

**Kinds are one wire string.** `choice` sends the option's own text, `rating`
the number as digits, `quiz` its picks as JSON, `activity` whatever its page
chooses. An answer that no longer matches an option lands in `Other` instead of
vanishing. A quiz publishes its `questions` WITHOUT `correct`
(`activeQuestionOf` strips it) and grades in the deck, so reading the network
traffic teaches a student nothing.

**A copied poll must get a fresh code.** `remintPollCodes` is called from
`instantiateLayout`, paste (elements and slides), element duplicate and slide
duplicate. A state slide is the deliberate exception — same question, another
view. A forked document re-mints `poll.session` too.

**A copied figure must get its own page.** A figure is revised by rewriting
`assets[key]` (`slide.py asset … page-NAME`), so two slides on one key are one
figure. `forkFigureAssets` copies an embed's/svg's page and an embed's poster
to `<key>-2` on slide duplicate and same-deck slide paste; `slide.py dup` does
the same. Plain images stay shared (the logo is one asset on every slide).
Slides duplicated by an older shell are still linked — re-point one by hand.

**Two files with one `docId` are one deck** — same tab-to-tab channel,
recovery slot and remembered handle: open in one browser, they merge edits.
Save ▾ → "Save a copy…" (`saveCopy`) forks a NEW file with a new `docId`; it writes
the copy to its own file BEFORE the editor becomes it and clears undo at the
fork (see DECISIONS, 2026-10-05). A deck with questions asks once: "Same room"
keeps poll codes and join code, "Another room" remints both. A file copied in
Explorer (or by an older shell's same-id "Save a copy…") keeps the `docId`; the
identity banner's "Make this file independent" (`makeIndependent`) gives the
open file a new id in place, poll codes kept; `slide.py fork` is the same on
disk. Save (and ⌘S) with no file handle runs the bridge autosave at once
instead of opening a Save As picker.
`identity-watch.ts` raises a banner the moment a second FILE with this id is
open (its own BroadcastChannel; two tabs of one file stay silent).

**`showJoin: false`** drops the QR/address/code column, for a slide that
REPORTS a bucket the room already answered rather than asking something new.
Without it every poll element looks like an invitation to answer.

**Only the summary is written back into the file** (via the `onPollSummary`
callback the editor passes to `startPresentation` — `present.ts` holds `doc`,
not the store). Raw answers stay server-side, so a reshared deck carries no
audience text.

**Export answers (Excel)** is `exportPollsXlsx` (`poll.ts`) over `src/xlsx.ts`, a
dependency-free stored-ZIP `.xlsx` writer validated against python's `zipfile`
in `scripts/test-xlsx.ts`. A hand-rolled container fails by refusing to open on
someone else's machine — never change it without running that.

**Resetting vs. forking.** Save ▾ → *Clear answers…* (`clearAllResponses`,
each distinct code once, sequential so a 401 asks for the key once) deletes
buckets but keeps codes: the same room again. A new section is *Save a copy…*
→ "Another room" (`saveCopy`), which remints every code and the session and
leaves the old buckets intact; "Same room" keeps them. The hive figure has its own per-slide Clear. Figures that hard-code a bucket code do not follow a remint.

**A frozen poll never touches the service.** `PollElement.frozen`
(`{at, count, answers?}`) is written by the publish tool's `students` mode (`tools/`): the
static body drops the join column and draws choice/rating bars, `mountOnePoll`
paints once from the stored wire strings (no tick, no Summarize, no activity
push), `mountLivePolls` does not publish it to phones and `deckUsesPolls`
ignores it, so a student copy raises no key prompt. `answers` holds no names
or times; an open question keeps only its `summary`.

**Images from the room.** An answer is one string, so a picture cannot ride
inside it: `POST /api/upload` takes the bytes and the answer carries the URL.
Caps live in `api/_lib.js` (the same in both services) — `MAX_UPLOAD_BYTES`
600 KB decoded (the legacy service's 1 MB document cap, base64 costs a third) for
images; on the Worker also documents (`DOC_TYPES`: PDF, HTML, markdown, text,
`MAX_DOC_BYTES` 1.8 MB, under the 2 MB SQLite row), for peer-review hand-ins.
`/api/blob` serves HTML, markdown and text under a CSP `sandbox` (an opaque
origin, so a student's page never runs as the service), markdown and text as
`text/plain`; a PDF as is, since a sandbox blocks the browser's viewer.

**`MAX_ANSWER_CHARS` is 2000**, not the original 600. `GET /api/poll` returns
every answer in the bucket, so the ceiling bounds the worst case per poll tick
(`MAX_ANSWERS` × `MAX_ANSWER_CHARS`, ~1 MB when full) — it was never about one
answer's length. Going meaningfully higher needs `/api/poll` to paginate first.

### The lecturer key

`LECTURER_PASSWORD` (set in the service's environment) gates the four PRESENTER
routes — publish an activity page, clear a bucket, steer the room, summarize
(which spends money) — behind `x-tessera-lecturer`, constant-time-compared in
`denyLecturer`. Unset = no gate. The key lives in
`localStorage['tessera-lecturer-key']`, never in the document: a shared deck
carrying its author's key would hand every recipient the presenter controls.

**The header must be in `access-control-allow-headers`** (`api/_lib.js`
`CORS`). A custom header means a preflight, and a preflight that lists only
`content-type` makes the browser drop every read unsent — the deck then says
"Offline — cannot reach the poll service" while curl reaches it fine. It bit
the moment a key was first stored on a machine (3 September 2026).

**`answers[]` is gated too, by a SOFT check** (`hasLecturer`) that writes no 401
and instead varies the PAYLOAD by caller — the join page and the presenting deck
call the same route and only one may see the responses. Why it had to be gated:
`/api/session` hands every phone the open question's `code`, so an ungated
`answers[]` let any participant read every response verbatim, a roster of
who-said-what whenever `requireName` was on. `count` stays public —
participation is not a disclosure.

**Every surface must branch on `answersWithheld`** or it lies to a presenter:
`present.ts` shows the options and a locked note instead of a chart of zeros,
and `exportPollsXlsx` returns `withheld[]` so the Export menu can alert rather
than hand over an empty spreadsheet. A reporting embed must send the header itself
from `window.TESSERA_EMBED.poll.lecturer`.

**The key is asked by prompt before it is needed**: `present.ts` runs
`ensureLecturerKey` once at the top of a show (gated on `deckUsesPolls`, never
awaited, never fatal), and Export answers / Clear answers ask before they
call. `GET /api/lecturer` returning `{required, ok}` tells it whether a key is
needed and whether the stored one works. Asking up front matters because the
room-steering publish runs on every slide change and deliberately never
prompts, so a show without a key fails SILENTLY — the phones never follow.

Full reasoning and the rejected alternatives: `docs/DECISIONS.md`.

### The service

Join page, session pointer, answer buckets, QR, OpenRouter summarize, image
uploads, clustering.

- **`server/poll-worker/`**: deployed to your own `<name>.workers.dev` with `npm run setup`
  (`server-setup.md`), Cloudflare Workers Free (nothing can bill;
  a limit fails requests instead), one SQLite Durable Object per poll code and
  per join code, `/api/live` WebSockets that tell `live-shim.js` when to
  re-read, so pages stop polling the network. Deploy with `npm run deploy` in
  that folder. Its README has the limits and the differences (no
  `LECTURER_PASSWORD` = presenter routes refused).
An older billed service with the same JSON routes (the legacy service) is no
longer shipped; decks that still point at it work only while its owner runs it.

The OpenRouter key lives only in each service's env vars.

- **The deployment lives in the DOCUMENT**: `doc.poll.service` (a template sets
  it once for every deck forked from it). Lookup order in `pollHost`: element
  `service`, then localStorage `tessera-poll-url`, then `doc.poll.service`, then
  the vite `__POLL_HOST__` define, which is EMPTY unless built with
  `POLL_HOST=…`. No brand URL belongs in the kernel, and an empty host means
  don't fetch: a host-less `/api/poll` is a relative URL and would quietly ask
  whatever server the file was opened from.
- **Redeploying a service is separate from re-hosting a shell**; neither
  touches the other.
- **An activity can take the whole phone screen.** A page carrying
  `<meta name="tessera-activity" content="full">` is shown full-bleed by the join
  page (no card, kicker or question header, frame 100dvh); without it, the
  page sits in the card under the question as before. The lab card opts in.
- **Clustering lives on the service, not in the shell.** `POST /api/cluster`
  (lecturer-gated) embeds a bucket's answers, clusters them, maps them onto a
  honeycomb and names the themes with an LLM; `op:"assign"` places later
  answers without regrouping. Embeddings are cached on each answer doc as field
  `v` (`listAnswers` masks it out of the 3-second read), and the last
  clustering is saved on the poll doc as `clusterJson` (cleared with the
  answers). A reporting embed calls it with `TESSERA_EMBED.poll.lecturer`; see
  `template/engage/` for the hive slide that uses it. `op:"score"` serves the
  hive matrix: an LLM rates each answer −3…+3 per presenter axis (null = no
  stance) and each gets its projection onto the embedding direction between the
  poles, cached as `scoreJson` per axes signature (so a re-press is free and new
  axes re-rate). The slide bins by the rating and orders within a bin by the
  projection; embeddings alone confuse topic with stance.
- **An embed gets the lecturer key only if it existed when the slide was
  built.** `embedPreamble` stamps `lecturerKey()` into `TESSERA_EMBED` at render
  time, and present mode's key prompt runs after the first render, so on a
  device's first visit a reporting embed sees no key until the deck is
  reloaded. Embeds that need it should offer their own key field (the hive
  slide does).

---

## 2. Interactive figures (`embed`)

An `embed` is a live web page inside a slide — the only element that runs
JavaScript. The page HTML goes in `doc.assets`, named by the element's `asset`
field, and must be self-contained: inline CSS and JS, no CDN, no web fonts, no
fetch, because a deck has to work offline.

- **The page is always in the file.** A figure under construction carries
  `devSrc`, the loopback URL of its source on the authoring tools' live server (`tools/live/`); only the
  edit canvas loads it. `dev-figures.ts` copies every save of that source into
  `assets[el.asset]` (font inlined, kept out of undo), and adopts an older
  slide that has only a loopback `src`. Present mode, a player file and every
  copy path (`dropDevSrc`: duplicate, paste) use or keep the asset alone. A
  frame with nothing but a loopback `src` gets a red "Figure is not in this
  file" tag on the canvas. `tools/slide.py doctor` / `bake` are the same for a file.
- **A poster is effectively required.** The editor canvas and the thumbnails
  rasterize slides and cannot rasterize a live frame, so an embed without
  `poster` shows an empty box everywhere but the show.
- **`window.TESSERA_EMBED`** — `{poll: {service, session, lecturer}}` — is
  injected before the page in present mode (`embedPreamble` in `render.ts`), the
  same trick as `window.TESSERA_ACTIVITY` for activity pages. It exists so a LATER
  slide's embed can read an EARLIER slide's poll bucket and chart it. The
  service address is the one thing a sandboxed page cannot work out for itself:
  its origin is opaque and a relative URL resolves to nothing. `poll.previous`
  (`{code, kind, question}` of the nearest poll at or before the embed's slide,
  `precedingPoll` in `render.ts`) lets a results figure find its bucket without
  hard-coding a code — codes are reminted whenever a deck is made from a
  template, which silently broke every pinned reader. `previous.join` is the
  code the room types (the session code when the deck has one). An embed with
  `keepPollOpen: true` keeps that poll published to the phones while its slide
  shows (`present.ts`), so answers keep arriving under a live results figure.
- **Keys: a figure builds, then the show moves on.** A second script in the
  preamble (`EMBED_KEY_BRIDGE` in `render.ts`) pairs with `stepOrNavigate` /
  `onEmbedMessage` in `present.ts`. A navigation key the page did not `preventDefault()`
  is posted up and moves the slide, so clicking into a frame no longer traps
  the keyboard. A page that sets `window.TESSERA_STEPPED = true` is OFFERED each
  arrow the deck receives and the deck only changes slide when the page declines
  — the `/infographics` step engine stops at either end of its build to decline.
  Opt-in because older figures wrap from the last step to the first and would
  hold the show forever. A frame that does not answer in 400 ms is skipped.
  Focus in a frame is dropped on every slide change.
- **Games: the SDK and the slide messages** (contract: `docs/game.md`). A page
  containing `<meta name="tessera-game">` gets `game-sdk.js` (`TesseraGame`)
  injected right after the live shim (`embedPreamble`, `GAME_META`); every
  other page is untouched. `present.ts` posts `{tessera:'slide', on, id, index}`
  to every frame of the slide entered and the slide left (`slideEntered`,
  wired in `slidechanged` AND the opening-slide block, like `mountLivePolls`),
  re-sends `on: true` to a frame on the current slide when it posts
  `embed-ready` (frames are `loading="lazy"`), and honours `{tessera:'goto', to}`
  from a frame on the current slide in `onEmbedMessage`. The shim treats
  `/api/game` as a read (the phone channel is `c=CODE&ch=state`) and
  `/api/game` POST and `/api/ai` as writes. The SDK is canonical here; the
  worker serves a copy as `/game.js` — run `npm run sync` in
  `server/poll-worker` after changing it, as for the shim. Its sample mode
  (`TesseraGame.mock`, no service) is what makes a game buildable offline; keep
  the mock's rules in step with `server/poll-worker/src/api/game.js`.
- **The sandbox.** `allow-scripts` is always applied; extra tokens come from
  the element's `sandbox`. `allow-same-origin` is the exception: it is refused
  on an inline (`asset`/`html`) page, because a `srcdoc` frame's own origin IS
  this document's and the token would hand the frame the parent page: the whole
  document and the lecturer key in `localStorage`.
  It IS honoured on a frame loading a cross-origin `http(s)` `src`, where the
  origin granted is the third party's and the parent stays unreachable —
  without it a hosted player (YouTube, Vimeo) boots to a blank rectangle.
  `embedIsThirdParty` / `embedSandbox` in `render.ts`; the reasoning is in
  `DECISIONS.md`, 2026-09-07. A remote `src` is still the lesser option for a
  figure: it dies with the host and with the room's wifi.
- **Aspect matters.** Full-bleed is 1280×720; under a title band the frame is
  about 1224×469, so draw in a 1280×480 viewBox. A mismatched aspect letterboxes
  the figure and throws away width.
- For static artwork prefer ordinary shapes, paths and text: they stay editable
  and can morph. `svg` elements are the fallback for geography and artwork only,
  and their CSS must be scoped (`render.ts scopeCss`) or one diagram's rules
  leak into every other svg on the page.

---

## 3. The template (`template.html`)

**`template.html` IS the source, not a build artifact.** The generator that
bootstrapped it was deleted once every later change had been made in the app or
by splicing JSON; recover it from git history only for a genuine from-scratch
rebuild. `doc.layouts` is owned by the file: add a layout by splicing it into
the JSON (or a live patch on the `layouts` root); the app has no layout tools.
Layouts are resolved by ROLE (`title`, `points`, `content`, `section`, `quote`,
`statement`, `chart`, `compare`, `image`, `image-hero`, `image-grid`, `matrix`,
`palette`, `poll`, `embed`): id equals the role or ends with `-<role>`, so a
branded template can prefix its ids and the tools still find them. Brand
templates are built the same way and live outside the public tree
(`TESSERA_TEMPLATE` points at one).

Two scripts still write into an existing deck, and both leave everything else
alone:

```bash
node scripts/upgrade-deck.mjs template.html      # re-host on a newly built shell
node scripts/stamp-agent-notes.mjs template.html # refresh doc.agentNotes (--check reports)
```

Node 22.16 needs `--experimental-strip-types` for scripts that import
`slides/src/model.ts` directly.

**Opening a template consumes `template: true`** (parseDoc strips it; that IS
the instantiation), and the flag can only be set in the JSON, so ⌘S on an
opened master writes an ordinary deck over it. Edit `template.html` on disk
(splices, `tools/slide.py`) and check the flag is still there.

**Teaching an agent that has only the file.** Two surfaces, in the order an
agent meets them:

1. **`doc.agentNotes`**: plain-string notes inserted right after `title`, so
   they land in the first KB of the file. The stamp script holds the
   hand-written house rules and **generates** two more from the document
   itself: LAYOUTS IN THIS FILE (ids, element frames, each layout's `notes` as
   its recipe) and SLIDES IN THIS FILE. Hand-written notes must never name a
   layout id, a frame or a slide number; derive it. The briefing survives
   re-hosting; **the head comment does not**, since `upgrade-deck.mjs` keeps
   only `#tessera-doc`. So engine-specific instructions belong HERE, never in
   the shell comment. Never write the six characters backslash-u-0-0-3-c in a
   note: the unescape step mangles it. Re-stamp after adding a layout.
2. **The shell's `AI AGENTS / TOOLING` comment**
   (`scripts/postbuild-compress.mjs`): generic, rebuilt with the app, and it
   defers to `agentNotes` when a deck has one.

Tooled agents use the authoring guide in `guide/` (`guide/reference/agents.md`
is the authoritative format guide).

---

## 4. Gotchas that must not regress

1. **Moveable in a scaled canvas**: the control box mounts INSIDE
   `.ed-stage-scale` (the `transform: scale()` wrapper) with
   `rootContainer: document.body`, and `moveable.zoom = 1/scale` on relayout.
   Then all Moveable event coords are in slide-local px. Mounting it outside the
   scaled wrapper gives garbage coordinates.
2. **Don't reset `moveable.target` to an identical array** — gesture listeners
   re-attach a frame later and a drag started in that frame is swallowed
   (`syncTargets` checks).
3. **`querySelector('[data-el-id=…]')` is ambiguous** — sidebar thumbnails
   contain the same ids as the canvas. Always scope to the surface
   (`.ed-stage-scale …`).
4. **Never let a literal script-close tag into the bundle** — `save.ts` builds
   it by concatenation; the data block JSON escapes every `<`. An ad-hoc
   script that drops the escape breaks the file in the browser while it still
   looks fine on disk (one commit shipped a template that way, 719 raw `<` from
   embedded figure pages); `tools/slide.py repair template.html` re-escapes it.
5. Reveal's `.reveal-viewport` paints white; the present overlay CSS overrides
   it black.
6. **svg-element CSS must be scoped** (`render.ts scopeCss`) — svg `<style>`
   applies document-wide, and CSS animations with fill modes even beat later
   static rules.
7. Tiny text labels make unusable click targets when scaled down — interactive
   controls get padded transparent `link` overlay rects, not links on the text.
8. **`saveFile` / `writeUpdatedFileAs` / `writeUpdatedFile` (`kernel/src/save.ts`)
   are serialized through a shared `serialized()` queue.** Nothing upstream
   debounces a save — a keypress and a click can land together, and the native
   Save As picker sits open for as long as a human takes to type a filename. Two
   overlapping calls each read the not-yet-set `fileHandle`, so BOTH opened
   their own picker; `createWritable()` truncates its target the instant writing
   starts, so whichever stream lost the race left a genuinely empty file on
   disk. The queue makes a call that lands mid-save wait its turn, by which
   point `fileHandle` is set, so it becomes a silent redundant rewrite. Never
   call `pickHandle`/`writeHandle` outside `serialized()`.
9. **Activation order in `save.ts` is load-bearing** — the picker and any
   `requestPermission` run BEFORE serialization. Activation expires a few
   seconds after the keypress and serializing a font-laden deck can outlast it,
   which is what made ⌘S throw `NotAllowedError` on big decks and never on
   small ones.
10. **Synthetic `PointerEvent`s do not drive Moveable/Selecto** (Gesto listens
    for mouse events). Dispatch `MouseEvent`s, or use a real mouse. After
    changing selection, wait a frame before starting a synthetic drag.
11. **A double-clicked deck has no file handle, and a picker truncates.** The
    File System Access API gives a `file://` page no way to reach its own
    file, and `showSaveFilePicker` zeroes the chosen file on confirm, before a
    byte is written. `save.ts` therefore keeps the picked handle in IndexedDB
    (`tessera-file-handles`, keyed by docId) and re-adopts it on the next open —
    but ONLY when it is provably this file: `handle.name` equals the URL's
    basename and `getFile().lastModified` equals `document.lastModified`
    (which on `file://` in Chrome is the file's mtime, second precision —
    verified 2026-09-21 in headless Chromium). docId alone is never enough:
    it survives copying, so `v2.html` and `v3.html` share one, and matching on
    it would write v3's edits into v2. A recompiled deck fails the mtime test
    too, which is right — the tab is stale. Every picker also pre-fills the
    open file's name (`openedFileName` now accepts any `.html` on `file://`).
    Where it STARTS is the weak spot: without a handle the API cannot point a
    picker at the open file's folder, only at the last folder used under a
    shared `id` — so the very first save of a deck may start in Documents,
    and a confirmed Enter there creates a stray copy that the same-file check
    keeps refusing (2026-09-21: exactly this, `Documents\DATA_department_v3.html`).
    Navigate to the deck's own folder once; from then on it is remembered.
    A per-deck `id` and `startIn` on the remembered-but-refused handle were
    both tried and made this worse. Serialization is started right after the
    picker or permission prompt is opened, not after it closes, so the bytes
    are ready when the file is touched.
12. **Sync work scales with the document, so keep it off the hot path**
    (`sync/session.ts`, fixed 2026-09-29). Every flush and commit parses or
    re-serializes the whole doc, which is several MB for an image-heavy deck.
    `applyRemote()` used to flush before every replayed batch and pinned the
    editor at 100% CPU; it now flushes only when a local edit is pending.
    Measure with Playwright + CDP `Performance.getMetrics` (`TaskDuration`)
    over time with two tabs of one deck open. Since 2026-10-22 the session's
    shadow is a structural copy that shares strings (`cloneData`), so keeping
    it costs the deck's structure, not its megabytes of data URIs, and a
    received batch is notified with `store.scope` = the slides its ops touch
    (`opsScope`): the other tab repaints those thumbnails and leaves the canvas
    and its running figures alone unless the shown slide changed. An element
    added or removed no longer emits `slides`/`current`. 10 received figure-text
    edits on a 14 MB deck: 2.0 s of main thread and 10 figure reloads before,
    1.1 s and 0 after (what remains is that tab's autosave serializing the file).
13. **Thinking tokens eat `max_tokens`.** Even at effort "low" a model can
    think past a 1,200-token budget on a long brief and return no text
    (finish `length`, 47 answers to cluster). `/api/ai` adds
    `REASONING_HEADROOM` on top of the caller's `max` and asks once more with
    reasoning off when the reply is still empty (`src/api/ai.js`). The other
    model routes (`help`, `summarize`, `_cluster`) still use a bare budget.

---

## 5. Open issues

### Local agent editing

`window.tessera.agent.goTo(slideId)` shows a slide (the live preview in
`tools/live/`, uses it so a phone follows the slide being edited).
`slides/src/agent-editor.ts` validates atomic ID-addressed patches; `agent-bridge.ts`
auto-connects open `file://` decks (each claims a per-file token, no paste) to
`scripts/agent-bridge.py` on port 18765. SyncSession forwards the resulting
edits to other tabs. The bridge WRITES the deck file when the editor holds no
file handle (`POST /save`, splicing only `#tessera-doc`), and since 2026-10-22
refuses a save based on a file version that is no longer on disk: the editor
folds the file's changes in and saves again (`save-merge.ts`; agent-live.md,
"A save never overwrites a file it did not see").
`agent-patch.ts` also provides conditional history inverses for `store.ts`; call
`sealHistory()` before external mutations so remote edits do not enter a local
gesture's history. Tests and setup: [agent-live.md](agent-live.md).

A save stringifies the document once, synchronously, at its start; that string
is the snapshot. It clears dirty only if the editor's revision counter (bumped
on every store `doc` event) has not moved since, so agent edits arriving during
serialization remain pending and trigger another save.

**Already-shipped shells save without a base** (the JSON form of `/save`), so
they can still overwrite a file written behind their back until re-hosted on a
shell built 2026-10-22 or later. The FS Access handle path has no base check
either: a tab holding a handle overwrites the file outright (slide.py routes to
such a tab live, so this needs the tab to be uncounted AND hold a handle).

**The double save — one blank file, then the correct one.** Closed 2026-09-21;
the record stays because the first fix (the `serialized()` queue, gotcha 8)
addressed a different race and the symptom survived it. The actual cause was
never two saves: a deck double-clicked from disk has no file handle, so every
session's first ⌘S went through `showSaveFilePicker`, and **Chrome truncates
the picked file to zero bytes the instant it is confirmed** — while the app was
still serializing a multi-megabyte deck. Explorer showed a 0 KB file, then the
real one. Three changes in `kernel/src/save.ts`, see gotcha 11: the picked
handle is remembered in IndexedDB and re-adopted next time the same file is
opened, so ⌘S never shows a picker again for that file; serialization now runs
*while* the picker is open, so the blank window is gone even on a first save;
and the picker pre-fills the open file's own name and folder. Separately, an
autosave that fired inside 2.5s of a ⌘S rewrote the file a second time — it now
skips when the deck is clean. If it comes back, `document.lastModified` on the
page vs the file's mtime is the first thing to compare (gotcha 11).

---

## 6. Where the upstream detail went

The module-by-module narrative for the editor, animation, charts, sync and
i18n is in `docs/architecture.md`, `docs/format.md` and
`docs/collab-design.md`. Upstream's own contributor docs were deleted in the
2026-09-02 consolidation, and its code for the relay, self-update, signed
releases and packs, spaces and the site on 2026-10-22; recover any of it with
`git show <that commit>^:<path>`. The fork re-hosts decks with
`upgrade-deck.mjs`; `scripts/shell-gate.mjs` is kept as the splice-contract
check for a built shell.

## Text lists and the default transition

- **A list is one text element.** Lines starting `- `, `• ` or `– ` render as
  list items: accent marker, hanging indent, a second level for two leading
  spaces (`layoutListLines` in `render.ts`). The stored html stays plain; the
  editor restores it before editing (`startTextEdit`, `canvas.ts`). Left-aligned
  text only. The template's `content` layout is one `co-body` box.
- **`morph` is the default transition** — `emptySlide`, built-in layouts, the
  sync healer, `template.html` and `md_to_deck.py`. Unmatched incoming elements
  rise in, so it degrades gracefully between unrelated slides.

Design sketches for features not built yet: `docs/design/`.

**Present in a new tab, live edits in the show (2026-11-17).** Present ▾ →
Present in a new tab opens the same file at `#present=<slide id>`
(`Editor.presentInNewTab`, `main.ts`); that tab drops the hash, presents
tab-filled from that slide (F for fullscreen; leaving fullscreen comes back to
the tab-filled show; Esc closes the tab, or falls back to the editor when the
browser will not close it). The first tab stays the editor; tab-to-tab sync
carries every edit, and `startPresentation(…, { live })` repaints in place
only the slides whose signature changed (the slide minus `notes` and
`comments`; title, theme, size, fonts and layouts repaint all), adds, removes
and reorders sections, `deck.sync()`s and stays on the slide on screen.
Notes alone patch the aside and the speaker view. A poll summary the show
writes re-signs its slide so the poll on screen is not remounted. Agent edits
no longer wait for a show in their own tab (`agent-bridge.ts` `busy`); only
`goTo` does. Tabs pair by `docId`, so a template instantiation (a new docId
on every open) pairs only once saved.

