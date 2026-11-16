---
name: tessera
description: 'Make and edit tessera slide decks: a deck is one self-contained .html file (document, editor and presenter in one) whose whole content is JSON in a "#tessera-doc" script block. Use for any request to create, edit, restyle, extend, fix or inspect such a deck (slides, layouts, charts, tables, speaker notes, morph transitions, reordering), to answer the comments a person typed beside the slides, or to set up tessera on a new computer. The hub: it routes figures and infographics to tessera-figures, polls, quizzes and games to tessera-engage, pictures to tessera-pictures, PowerPoint conversion to tessera-pptx, and links or copies for an audience to tessera-publish.'
---

# Tessera decks

A **tessera deck** is one `.html` file that is the document, the editor and
the presenter at once: double-clicking it opens the editor in Chrome or Edge.
The whole document is plain JSON in the `#tessera-doc` script block near the
top, so an agent can build and edit it as easily as a person.

**The method is the tessera authoring guide** (`$GUIDE`, below), which is
newer than this skill and owns every detail. This skill says how to start,
which page to read for which job, and the rules agents keep getting wrong.

## Where you are

Tessera is open source: **https://github.com/angeloromasanta/tessera**.

| name | inside the tessera repo | in a workspace that nests it (`tessera/` beside `decks/`) |
|---|---|---|
| `$TESSERA` | `.` | `tessera` |
| `$T` (the tools) | `tools` | `tessera/tools` |
| `$KIT` (ready-made pages) | `kit` | `tessera/kit` |
| `$GUIDE` (the guide) | `docs/guide` | `tessera/docs/guide` |
| `$PY` | `python` (`python3` on a Mac) | same |
| `$DECK_DIR` | `decks/<deck>/` (or `TESSERA_DECKS`) | same |

**Who outranks whom**: the deck's own `README.md`, then a workspace skill that
adds a brand or a person's preferences on top of this one (for example a
brand template's layouts and colours), then this skill, then the guide's
defaults. A brand skill never repeats the method; this skill never carries a
brand.

**No git or Node, or a chat assistant with only a Python sandbox?** Use
[without-tools.md](without-tools.md) (next to this file): a tested toolkit to
read and write the deck's JSON, build slides from layouts, answer the
comments typed in the editor and build animated figures with Python alone.

## 1. Every session

1. **Update.** `git -C $TESSERA pull`, then read the top of
   `$TESSERA/CHANGELOG.md`: newer entries can change how a tool is used. In a
   workspace, refresh these skills from the update:
   `$PY $T/skills.py install .` (it rewrites only the `tessera*` skill folders).
2. **Before building into a deck**: `$PY $T/slide.py doctor DECK.html`. If it
   reports an old shell, re-host it with
   `node $TESSERA/scripts/upgrade-deck.mjs DECK.html` (the document is kept,
   only the app shell is replaced), with the deck closed or saved.
3. **The person's comments come first**: `$PY $T/slide.py requests DECK.html`
   lists what they typed beside the slides; do those before anything else
   (section 5).

## 2. First-time setup (once per computer)

Needs **Python 3** (the tools), **Node 22.12+** (re-hosting, the app shell),
**git**, and Chrome or Edge. Ask before installing any of them; install them
yourself if the person agrees.

```bash
git clone https://github.com/angeloromasanta/tessera.git   # skip inside the repo itself
cd tessera/slides && npm install && npm run build:single && cd ../..
pip install playwright && python -m playwright install chromium   # screenshots (shoot.py)
```

A `.env` at the workspace root (the tools find it by walking up from the
current folder; every key: `$GUIDE/README.md`, "Configuration"):

```
TESSERA_TEMPLATE=<absolute path to the template>   # default: tessera/template.html
TESSERA_DECKS=decks
TESSERA_POLL_SERVICE=<your poll service URL>        # docs/server-setup.md; without one, polls show but collect nothing
TESSERA_LECTURER_KEY=<its lecturer key>
TESSERA_AUTHOR=<the person's name>
```

**Never print, copy, paste or commit a value from `.env`**, and never put the
lecturer key in a deck, a page or a test: it opens every poll's raw answers.
When a key must go in, tell the person which line to fill and let them type it.

## 3. Which skill, which page

| the job | skill | read |
|---|---|---|
| ordinary slides: text, layout, theme, charts, tables, notes, reordering | **here** | `$GUIDE/authoring.md`, `$GUIDE/editing.md` (start here) |
| several slides at once by parallel agents | **here** | `$GUIDE/parallel.md` |
| an animated, stepped or interactive figure, an infographic, a timer | `tessera-figures` | `$GUIDE/figures.md` |
| polls, quizzes, word clouds, phone activities, games, answers | `tessera-engage` | `$GUIDE/engagement.md` |
| a picture for a slide | `tessera-pictures` | `$GUIDE/pictures.md` |
| convert a PowerPoint | `tessera-pptx` | `$GUIDE/conversion.md` |
| a link or a copy for an audience | `tessera-publish` | `$GUIDE/publishing.md` |
| the format, field by field | here | `$GUIDE/reference/agents.md` (the section you need) |
| the template's layouts and conventions | here | `$GUIDE/reference/TEMPLATE.md`, or the brand skill's page for a brand template |

## 4. A new deck

Copy the template into its own folder, then give the copy its own identity.
Without `fork`, two decks share an id and poll codes: their edits merge in the
browser and their polls collect into each other's answers.

```bash
mkdir -p decks/my-talk && cp "$TESSERA_TEMPLATE" decks/my-talk/my-talk.html
$PY $T/slide.py fork decks/my-talk/my-talk.html --polls
```

Write `decks/my-talk/README.md` (what the deck is, its sources, standing
rules) and read it before every later session on that deck. **Land a rough
skeleton within a couple of minutes** and tell the person the path so they can
open it and watch the rest arrive (`$GUIDE/authoring.md`, "Draft first").

## 5. Listening to the comments typed beside the slides

The person reviews in the editor: they type a comment beside a slide (or in
"Whole deck") and press Enter. That comment is a request saved in the deck.
**They should not have to ask you each time.**

- **If your harness can run a command in the background and wake you when it
  exits** (Claude Code's `run_in_background`, for example): once the deck is
  open, arm the listener and keep it armed for the session:
  `$PY $T/slide.py requests DECK.html --wait`. The editor then shows "An agent
  is listening". When it exits it has printed the new requests: mark each one
  working, re-arm the listener, then do them and reply
  (`$GUIDE/editing.md`, "Requests typed in the editor"). It stops by itself
  after about two quiet hours; re-arm then only if asked.
- **If it cannot** (a foreground-only shell, a chat), never block the session
  on `--wait`. Say once, plainly: "Type your comments beside the slides, then
  tell me *do my comments*." Then serve all open requests each time.
- Either way: change only what was asked, reply one line under each request
  (it is all the person reads about what happened), never delete one, and stop
  at once on a request the person stopped.

## 6. Working for someone who is not a programmer

Many people using this are lecturers or speakers, not developers. Speak in
plain words, do the technical steps yourself, ask before installing anything,
and never paste code or terminal output at them unless they ask. Tell them
what to look at ("slide 4 now has the timeline; click it to step through"),
not what you ran.

## 7. Rules learned the hard way

1. **Land each slide the moment it is ready**, in the open editor
   (`slide.py ... live` / push, `$GUIDE/editing.md`) or the file, and confirm it
   arrived; never batch finished slides for one compile at the end.
2. **Diagrams are running figures, never images**, including a diagram that
   arrives as a picture in a pptx: `tessera-figures`.
3. **Figures must move, not fade**, and every figure of a deck looks like one
   family (the template's figure tokens).
4. **Never read or grep a deck's HTML**: it is megabytes of base64. Use
   `slide.py ls / get / set / info`.
5. **Never regenerate a deck's `docId`**, and never edit outside the
   `#tessera-doc` block.
6. **Everything a tool generates goes in `decks/<deck>/build/`.**
7. **Ask before anything that publishes or costs**: a public link, a deploy,
   generated pictures on someone's paid key.
8. **Write speaker notes on every slide**, and look at every slide you touched
   (`$PY $T/shoot.py DECK.html --id a,b`) before saying it is done.
