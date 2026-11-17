# Ready-made engagement pages

Each is one slide: a hidden `activity` poll under an embed, built by a script
in `$T/` (`make_guess.py`, `make_lab.py`, `make_remix.py`; the game starter by
`make_game.py`) that fills the screen and phone templates in `$KIT/engage/`, inlines the deck's font, shoots the poster and uploads the
assets through `slide.py`, so it works on an open deck too. The general rules
(codes, the lecturer key, editable wording, rehearsing) are in
[engagement.md](engagement.md).

## Guess the number

The room guesses a study's result (a percentage, a count), the slide shows the
**spread of the guesses**, then the study's number. One slide per question: a
hidden `activity` poll under a full-bleed embed, like the hive.

```bash
$PY $T/make_guess.py $DECK_DIR/build/guess.json --deck DECK.html   # all questions, or add ids
$PY $T/make_guess.py $DECK_DIR/build/guess.json --deck DECK.html --build-only [--out DIR]   # pages + poster only
```

`guess.json` is a list; the fields are in the script's docstring (`question`,
`setup`, `min`/`max`/`step`/`ticks`, `unit`, `signed`, pole labels `low`/`high`,
`truth` as a number or a `[from, to]` range, `tol`, `answer`, `source`, `sample`,
`after`). The script fills `$KIT/engage/guess.html` (screen) and
`$KIT/engage/guess-phone.html` (phone), inlines the deck's font, shoots the poster,
uploads `page-guess-ID`, `img-guess-ID`, `activity-guess-ID` and, the first time,
creates slide `g-ID` with a fresh bucket. Run it again after an edit: slide and
bucket are kept. Works on an open deck too (it only uses `slide.py`).
`--build-only` never calls `slide.py`: it reads the deck file for the font and
writes pages, baked page and poster, to check a question before it goes in.

- **Three states.** 0: question, QR, a count and an unsorted pile, so nobody
  anchors on the room. Click 1: guesses close (phones lock) and land on the
  axis as a dot plot with the room's median and middle half. Click 2: the
  study's number, how far the median was, who was within `tol`.
- **Several numbers in one question:** `items` instead of `truth`, 2 to 4 of
  `{"key", "label", "truth", "color"?}` on the entry's one axis; `sample` may
  be a list, one centre per item. Phone: one slider per item, one Send once
  all are touched, posting `{"v": {key: number}, "d", "score": 1}`. Screen: one
  row per item (label, dots, ROOM median), then STUDY beside it, a red bar for
  the gap and "12 points too high". Four rows fit, without that last line.
- **`given`**: `[{"label": "Without any AI", "value": 46}]`, a value everybody
  may know. On the axis from state 0, through all rows later, and on the phone.
- **Write `setup` without the result**, and keep the number out of the slide
  title before it. The phone page never receives `truth`, `answer` or `source`.
- The phone's sliders start at a random place and show "?" until touched.
- Text is measured and wrapped, left of the QR block: the question up to three
  lines (about 110 characters; longer shrinks, down to 26px), `setup` and
  `answer` two; the plot takes what is left. Row labels wrap at two lines.
- No wifi: type a number on the slide and press Enter to add a guess (items:
  `40,18`). Without `TESSERA_EMBED` (poster, `shoot.py --page --clicks all`) it
  plays sample guesses centred on `sample`.
- **Rehearse** one question in present mode with a phone before class.
- Change the look in the two templates, then re-run the script for every deck
  that uses them.

## Lab slides: timer, room check, AI helper

The standard slide for a hands-on lab. One slide per lab: a
hidden `activity` poll (`lab-poll`, question `Lab check-in: ...`) under a
1280x500 embed at y=150, under the slide's own title. Template slide in
`$TESSERA/template.html`: `sl-lab`. In a student copy (`publish.py students`) the card stays and its
room panel is hidden (`<html data-offline>`); rebuild an older card with `make_lab.py` to get this.

- **Screen** (`$KIT/engage/lab.html`): the instruction, 1 to 3 prompts to type
  (`[..]` placeholders in red), a tip, the countdown (Space starts it, −/+ set
  minutes) and, under it, the room: how many phones say **Finished** (each
  phone's latest status; no other state is shown). Without the lecturer key it
  says so.
- **Outputs**: **View outputs (N)**, bottom right of the card, opens a wall of
  the screenshots the room shared over the card (the countdown keeps running
  beside it): click a tile to show it large, ← / → move on (past the ends:
  back to all), Esc or a click on the picture goes back, Close (or Esc again)
  back to the card; Hide takes one off this screen only. The pictures come in
  the room's own `/api/poll` read, never a read of their own, and are fetched
  only once the wall opens. No key, no button (as the room). Offline (the
  poster, the editor without a service) it shows six sample screenshots, so it
  can be rehearsed.
- **Phone** (`$KIT/engage/lab-phone.html`): two buttons, **I need help** and
  **Finished**; the one pressed decides what shows under them. I need help
  opens the ask box (hidden until then): text and/or a photo of the laptop
  screen (**Camera** opens the phone's camera, **Upload** the gallery; shrunk
  on the phone, never stored), answered by `POST /api/help` (Haiku 5.5).
  Finished opens **Share what you did**: just Camera and Upload; once a
  picture is chosen they give way to the picture, a one-line description and
  Send. The screenshot, shrunk under 600 kB, goes to `POST /api/upload` (a
  public link, kept until the bucket is cleared; the footer says the class
  will see it), then a check-in that carries it, `{v:1, pid, st, u, c?, n?}`.
  It carries the current status, so the room still counts each phone's latest
  answer. The status is `st: "lost"` for I need help (the value the older
  Lost button stored) and `"finished"`; answers from the older three-button
  page (`"working"`) are still read, and only `"finished"` is counted.
  It carries `<meta name="tessera-activity" content="full">`, so the join page
  gives it the whole screen (no card, no question header).
  Any activity page can opt in the same way.
- **The helper reads the lab's `context`** from the published phone page, never
  from the phone, and answers only while the slide was opened in present mode
  in the last 3 hours, 3,000 calls per bucket per day (`api/help.js`).

Write the labs in `$DECK_DIR/build/labs.json` (fields in the script's
docstring: `heading`, `title`, `minutes`, `do`, `types` (prompts to type) or `steps` (1 to 5 numbered lines of plain task, no prompt), `tip`, `context`, and
`slide` to arm an existing slide), then:

```bash
$PY $T/make_lab.py $DECK_DIR/build/labs.json --deck DECK.html      # all labs, or add ids
$PY $T/make_lab.py $DECK_DIR/build/labs.json --build-only           # pages + posters only
```

It uploads `page-lab-ID`, `img-lab-ID`, `activity-lab-ID`, and arms the slide
(keeps its title, notes and bucket) or creates it. Works on an open deck. A new
lab from the template: `slide.py copy live sl-lab --after ID`, then a
labs.json entry with `"slide": NEWID`. **Write `context` from the speaker
notes**: the goal, what success looks like, the tools, the usual problems and
their fixes; it is what makes the helper useful. Rehearse the phone offline:
open `build/engage/lab-ID-phone.html?fake` (a shared screenshot stays on the
phone); the screen with phones and pictures end to end: `$T/mock_service.py`
(its `/api/upload` keeps the picture and `/api/blob` serves it).
A screenshot wall without a lab (a slide that only collects pictures) is the
same pattern: [engagement.md](engagement.md#images-from-the-phones).

## Interactive title: attendance, then the room rewrites the slide

A title slide the room changes. One slide: a hidden `activity`
poll (question `Interactive title: ...`) under a full-bleed 1280x720 embed.

- **Phone** (`$KIT/engage/remix-phone.html`): check in with full name and email (the
  attendance: a row per check-in in `slide.py poll export`), then send ideas to
  improve the slide (one every 12 s; four random suggestion chips), see what became
  of each (queued, on the screen, skipped and why) and a preview of the slide.
- **Screen** (`$KIT/engage/remix.html`): the slide, drawn from HTML; a QR card (in the
  left column under the title, always on top, QR 236 px) with the join address and the counts. Every 3 s it reads
  the bucket and sends the next batch (≤ 6 ideas, one per phone) to `POST /api/remix`
  with the lecturer key: Haiku rewrites the whole slide, about 10 s a batch. Pills
  bottom left of the room's space say whose idea landed and which were skipped, and why.
- **Locked title**: the title and the lecturer's name (`title`, `subtitle` in the
  json) are not in the HTML the model edits. The screen draws them, with the logo and
  a short accent rule, as one compact left column (x 40-310, the QR card right under it;
  right of x 330 is the room's), on three white plates above the slide
  (transparent while the original is showing, white once the room changed it), and the
  phone preview overlays the same plates, so no idea can remove, hide or restyle them.
  The model is told the plates are there and skips ideas that target them ("the title
  and name are locked"); everything around them is the room's.
- **Base** (`base` in the json, optional): a deck's own cover page (an animated
  cover's page asset, e.g. `page-cover`) runs live under the slide, which starts transparent, so the first
  version is that deck's title slide; an idea that paints a background covers it. A
  stored original that no idea has touched yet is replaced by the current build's on
  the next show, so a rebuild never leaves an old original on screen.
- **Never blank**: the model is told so and skips such ideas (and rude ones, and
  prompt injection); the server strips every script, handler, frame and link and
  refuses a page with no visible text; the screen renders each version in a back
  frame under a CSP that allows no script of the model's and no network, measures
  it (readable text on top, not covered, not the colour of its background, not
  under the QR card or a title plate) and sends `reject` instead of showing it.
- **Presenter**: click into the slide, then **P** pause, **U** undo, **R** twice
  reset (also buttons top right on hover). It runs only in present mode
  (`liveInEditor: false`), so the editor never runs a second queue.
  **Clear the answers** before the next group (`slide.py poll clear DECK
  SLIDE_ID --yes`): that also resets the slide.
- **Version bars**: a thin row along the bottom (right of the column), one bar per
  version the server keeps (the original plus the last 29, `GET /api/remix?hist=1`),
  the live one in the accent colour. Click a bar, or **[** / **]**, to show an earlier version: view
  only (the server state does not change), applying waits, the chip says "Version 3
  of 7"; the last bar, **L** or a click on the chip goes back to live and resumes.
  Undo shrinks the bars; old versions render through the same sandbox and CSP.

```bash
$PY $T/make_remix.py $DECK_DIR/build/remix.json --deck DECK.html   # {"slide","title","subtitle","eyebrow"}
$PY $T/make_remix.py $DECK_DIR/build/remix.json --build-only
```

The seed slide (transparent, one invitation line pointing at the QR card; `{{date}}`
works in `subtitle`) is in the script. Rehearse offline: the phone with `?fake`; the screen's queue and its blank
check against a mocked service (`$T/mock_service.py`, [engagement.md](engagement.md),
"Games").

## Game starter: buzz and vote

`$KIT/engage/game-screen.html` + `$KIT/engage/game-phone.html`: a small, complete game on
the game layer ([engagement.md](engagement.md), "Games"), to copy and change.
Lobby (names appear as phones join; click one to remove it) → a question:
phones vote (`mode: 'last'`, key `vR`, changeable until the round closes) and
race for the buzzer (`mode: 'first'` on the shared slot `room`, key `bR`) →
Close voting → Reveal (the bars, the right answer, the buzzer's +2 or −1;
every phone gets only its own result, a `private` value) → Leaderboard →
next round … → Final standings. Back undoes a step, Reset (two clicks) starts
over and the phones rejoin by themselves. The question reaches the phones in
`state` when its round opens; the answers stay in the screen's CONFIG.

- **CONFIG** (screen): `title`, `eyebrow`, `points` (`right`, `buzzRight`,
  `buzzWrong`), `rounds` (`[{q, options (2 to 4), answer}]`); the phone gets
  `title` and `points` (`"phone": ["title", "points"]` in the game's json).
  Labels are editable in place (keys `title`, `eyebrow`, `joinHead`,
  `lobbyHint`, `rounds.N.q`, `rounds.N.options.I`, `boardHead`, `finalHead`…).
- Logo-only slide; the header starts under the deck's logo, the controls sit
  along the bottom. Without the lecturer key the screen says so and its
  controls are disabled.
- Opened on its own it plays with seven simulated phones (the poster); the
  phone page alone previews a question.
- Rehearsed end to end with `$T/rehearse_starter.py`; run it after any
  change to the pair, and play one round with a phone before class.

## Groups

`$KIT/engage/groups.html` draws balanced random groups from an `open` sign-in
bucket and, on **Save round**, posts the grouping to a second bucket so later
draws avoid repeat pairs. Copy it to `$DECK_DIR/build/figures/`, set
`NAMES_CODE` and `HISTORY_CODE` to the spec's pinned `code:`s, embed with no
`title:`. It has a paste-a-list fallback.
