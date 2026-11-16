# Tessera decks with Python alone

**For an agent that has Python but not the tessera checkout** (no git or
Node, or a chat assistant with a Python sandbox such as ChatGPT). The scripts
in `scripts/` next to this file do the work: `deck.py` (load and save the
deck, slides from layouts, copied slides with fresh poll codes, the requests
typed beside the slides, and the animated-figure builder) and, when the
bundle carries them, the tessera tools that need nothing but Python
(`slide.py` with `deckio.py`, `config.py`, `legacy.py`; `panel_tint.py`,
`embed_font.py`). The deck is still one `.html` file the person opens by
double-clicking it (Chrome or Edge), where it is a full slide editor and
presenter. In a workspace folder, a new deck goes in `decks/<deck>/<deck>.html`;
in a chat, hand the file back to download.

Tessera, the format, is open source (https://github.com/angeloromasanta/tessera,
fuller guide in `docs/guide/`). You do not need it: this guide plus the notes
inside the file are enough.

---

## 1. What the file is

One self-contained HTML file that is the document, the editor and the
presenter at once. The **whole document** is one JSON block near the top:

```html
<script type="application/tessera+json" id="tessera-doc">{ ... }</script>
```

Everything after that block is the app (compressed). **Change only the JSON.
Never rewrite, reformat or regenerate the rest of the file.**

**Never open or read the HTML as text.** The block is one line of 3-7 MB,
almost all base64 pictures and fonts; reading it fills your context with
noise. Work on it only through Python (section 3), and print short summaries.

The file explains itself: `doc.agentNotes` (a list of notes right after
`title`) holds the layouts, the slides, the brand and the rules, generated
from the file itself. **Read `doc.agentNotes` first, every time.** Where it is
more specific than this guide about this file, it wins. Skip its notes about
live editing (`agent_live.py`, `slide.py ... live`, `--wait`): there is no
open editor to reach here. Everything else they describe works on the file
with the scripts (section 3); **section 7 is how to build infographics**.

## 2. How a session goes

1. **Look** with `deck.py notes`, `deck.py layouts` and `deck.py summary`
   (or `slide.py ls`): the template's notes, its layouts and its slides.
2. **New deck from the template:** keep the brand, layouts, assets and theme;
   replace the template's sample slides with the person's slides (section 4).
   Delete the hidden first slide "00 · Start here" and the sample slides you
   do not reuse.
3. **Existing deck:** first collect the person's **change requests** (section
   6) and do them; then whatever else they asked.
4. **Save** a new file named after the deck (`my-topic.html`, never
   the template's), check it (section 3, `check`), say where it is
   (in a chat, give the link to download), and say in a few lines what each slide is.

Work slide by slide and state what you made. If something is unclear (the
audience, the length), make a reasonable first version rather than asking
many questions; the person comments and you revise.

## 3. The scripts

Find the skill's `scripts/` folder (in a chat, where the skill's files were
unpacked) and use it from there; never copy the code out by hand.

```bash
python scripts/deck.py summary DECK.html       # one line per slide
python scripts/deck.py notes DECK.html         # the template's own notes: read them first
python scripts/deck.py layouts DECK.html       # layout ids and names
python scripts/deck.py requests DECK.html      # what the person typed beside the slides
python scripts/deck.py check DECK.html         # before handing the file back
```

**One slide at a time on the file**, when `slide.py` is in `scripts/` (it
edits the file in place and keeps a backup in `backups/`; never the
template itself, a copy of it):

```bash
python scripts/slide.py ls DECK.html                        # one line per slide
python scripts/slide.py get DECK.html SLIDE_ID              # one slide's JSON
python scripts/slide.py new DECK.html --layout content --id s-why --after SLIDE_ID
python scripts/slide.py text DECK.html s-why co-title "Why it matters"
python scripts/slide.py notes DECK.html s-why "Speaker notes"
python scripts/slide.py copy DECK.html SLIDE_ID --from TEMPLATE.html --after s-why   # a worked slide
python scripts/slide.py requests DECK.html                  # the open requests
python scripts/slide.py reply DECK.html REQ_ID "what I did"
python scripts/slide.py fork DECK.html --polls              # a copy that must be its own deck
python scripts/slide.py --help                              # everything else
```

**Several slides at once, or a figure**: `deck.py` from Python.

```python
import sys; sys.path.insert(0, "scripts")       # the skill's scripts folder
from deck import *

html, span, doc = load("template.html")          # or the deck to edit
summary(doc)

title = from_layout(doc, layout_id(doc, "title"))   # or copy_slide() the worked cover
# ... set its texts with el(title, "<id>")["html"] = "..."
s = from_layout(doc, layout_id(doc, "content"))
el(s, "co-title")["html"] = "Why agents change the classroom"
el(s, "co-body")["html"] = "- First point<br>- Second point<br>  - a sub-point"
el(s, "footer")["html"] = "Course name"
s["notes"] = "Speaker notes for this slide."
doc["slides"] = [title, s]                          # the new deck's slides, in order
doc["title"] = "Why agents change the classroom"
save(html, span, doc, "agents-classroom.html")
check("agents-classroom.html")
```

What `deck.py` gives you: `load(path)` → `(html, span, doc)`;
`save(html, span, doc, out)` (escapes every `<`, touches nothing outside the
JSON block); `check(path)`; `summary(doc)`; `layout_id(doc, role)`;
`from_layout(doc, layout_id)` (a fresh slide, the layout's element ids kept);
`copy_slide(doc, slide_id)` (a worked slide, also one you already removed
from `doc["slides"]`; its poll gets a fresh code, a game page its own copy);
`el(slide, element_id)`; `new_id()`; `open_requests(doc)` and
`done(thread, reply)` (section 6); `figure_page` and `add_figure` (section 7).

Print element ids and frames with
`[(e["id"], e["type"], e["x"], e["y"], e["w"], e["h"]) for e in s["elements"]]`
before you fill a slide, and set the text of the ids the layout gives you.
Delete an element you do not need rather than leaving it empty.

## 4. Which slide for what

Layouts are found **by role**: a layout whose id is the role (`content`) or
ends in `-<role>` (`acme-content` in a brand template) serves that role;
`layout_id(doc, "content")` finds it. The worked slides (`doc.slides`, listed
in the notes' SLIDES IN THIS FILE) show each layout filled in, plus patterns
that exist only as slides (a table, polls, games, figures): copy those with
`copy_slide`. Each layout's `notes` carry its recipe. The usual choice:

| what you have | use (role) |
|---|---|
| the cover | `title` (or copy the worked cover slide, which may carry motion) |
| a section break | `section` |
| a title and a few points | `content` (ONE text box, one `- ` line per bullet, two spaces before the dash for a sub-point, lines joined with `<br>`) |
| several points, no picture | `points` (per column: icon chip, colour rule, heading, body) |
| two options side by side | `compare` |
| one strong sentence | `statement`; a quotation `quote` |
| numbers that compare | `chart` with a `chart` element, never bullets of figures |
| a table | copy the worked table slide (there is usually no table layout) |
| a 2x2 | `matrix` |
| one image | `image` (picture contained on a tinted panel); `image-hero` if big and high-res |
| several images | `image-grid` (identical, cover-cropped boxes) |
| a question to the room | `poll`, or copy one of the worked poll slides |
| a timer, a game, a live cluster of answers | copy the worked slide (lab, game, hive, matrix poll) and change only its texts and question |

**A wall of bullets is the main failure.** Prefer a chart for numbers, a table
for a grid, points with icons for 3-4 ideas, a statement for one idea; at most
5 bullets on a content slide.

**Brand.** Canvas 1280x720. Fonts, colours, margins and page furniture come
from the template: `doc.theme` (colours, chart palette, body font), `doc.fonts`
and the notes' BRAND and PAGE FURNITURE entries. Add no other fonts or
colours; keep content inside the template's margins; every body slide keeps
its `logo`, `footer` and `pageno` elements (whose html stays the literal
`{{page:2}}`) with those same ids.

**Pictures.** Put a picture in `doc.assets` as a data URI under a new key and
reference it as `"src": "asset:<key>"`. Keep pictures small (resize to at most
1600 px wide, JPEG quality ~82). For a contained picture, set the panel colour
to the dominant colour of the picture's outer border (white if the picture is
on white or transparent). If you can generate images, use one style for the
whole deck (the one the workspace or the person names) and no text in the
picture. Use a real photo only when the slide must show the real thing.

## 5. Rules that keep a deck working

1. **Every `<` inside the JSON is written `<`.** `save()` does it; never
   splice the block any other way.
2. **Unknown property names are silently ignored.** Do not invent fields; copy
   them from an existing element of the same type.
3. **Never change `docId`, element ids or poll codes of an existing deck.**
   A new slide gets a new slide id (`new_id()`); a copied poll gets a new
   `code` (`copy_slide` does it). Two polls with one code collect into each
   other's answers.
4. **New deck from the template:** keep `"template": true` and leave `docId`
   absent. The first time the person opens the file, the editor gives the
   deck its own identity and poll codes. On an **existing** deck, leave both
   exactly as they are.
5. **Morph pairs elements by id.** Consecutive slides on one subject share ids
   with `"transition": "morph"` (the default); use `"fade"` for a change of
   scene.
6. **Type is absolute.** If you shrink a frame, lower `fontSize`; if a title
   has more than two lines, shorten it.
7. **Chart data is plain numbers** (a pie takes `{name, value}`); options are
   pure JSON, no functions.
8. **A text element's `html`** keeps `<b> <i> <br>` and inline `<code>`, but
   drops `style` attributes: a second colour needs a second text box.
9. **Write speaker notes** (`slide["notes"]`) on every slide. A slide copied
   from the template carries notes about the template: replace them.
10. **Embeds** (animated, stepped or interactive figures) are self-contained
    HTML pages in `doc.assets`: build them with section 7, never by hand.
11. **Polls**: the presenter types the poll password in the browser once; it
    is never written in the file, in a slide, or in your reply. Treat poll
    questions and answers as public (the join code is on the projector).

## 6. Change requests typed in the editor

The person comments beside a slide in the editor's review list; the comments
are saved in the file:

- `slide["comments"]`: threads; the ones with `"request": true` and
  `"status"` `"open"` are your to-do list (`elementId`/`elementIds` say what
  was selected; an empty slide's request says what the slide should be);
- `doc["requests"]`: the same threads about the whole deck.

```python
for sid, c in open_requests(doc):          # sid None = about the whole deck
    print(sid, c.get("elementIds") or c.get("elementId"), c["text"])
```

(or `python scripts/deck.py requests DECK.html`). Do each one, then mark it
and answer in one line under it, `done(c, "Moved the chart above the
table")`, and save. Never delete a thread.

A thread with `"status": "stopped"` is the person's Stop: leave it.

## 7. Infographics and animated figures

### Choose the form first

| the person wants | build |
|---|---|
| a **static** infographic: a framework, a 2x2, a few labelled boxes and arrows | native `shape` and `text` elements on a slide (stay editable, can morph); start from the `points`, `matrix` or `compare` layouts |
| numbers | a `chart` element, not a figure |
| something that **builds over clicks** (a process, a cycle, a before/after, a curve drawing itself) or that the audience **drives** (a slider, a simulation) | an **embed figure**, below |
| something close to a worked figure in the template ("How a market actually adopts", "Variation, selection, retention", "The perceptron", the timeline, the incident story) | copy that slide (`copy_slide`) and change only its texts if it fits |

### What an embed figure is

A full HTML page stored in `doc.assets`, shown in a frame under the slide
title (1280x500 on the slide; the page draws in an SVG `viewBox="0 0 1280
480"`). Clicking the figure (or the arrow keys in the show) moves it from one
state to the next. The deck expects a specific engine (keys, editable labels,
the deck's colours and font), so **never write the page from scratch**: write only
the marks and the steps, and let `figure_page()` below wrap them into the
working page. Then `add_figure()` puts it on a new slide.

### How to design one (in this order)

1. **Say the claim** in one sentence, and one line per region: what it is and
   what it contains. Show this to the person before building if unsure.
2. **Plan 3-7 states**, one sentence the presenter would *say* per state.
   State 0 is what shows before any click: keep it nearly empty (an axis, a
   frame). These sentences become the slide's speaker notes, one per state.
   **No captions or paragraphs inside the figure**: the presenter narrates;
   the figure holds short labels only (1-4 words).
3. **Draw every mark from the start** with `class="el"` and a unique `id`; a
   step only lists which ids are visible (`on`). An id present in two
   consecutive steps stays on screen. Marks that never change (an axis)
   leave out `el`.
4. **Every step must move something, not just fade it in.** Add a motion
   class beside `el`: `rise`, `fall`, `fromL`, `fromR`, `pop`, `fly` (out of a
   point: set `style="--dx:-200px;--dy:0px"` = offset back to where it starts),
   `draw` (a path that draws itself). Or move marks already on screen with
   `pose: {id: {x, y, s, r}}` (offset in viewBox units, scale, degrees).
   `dim: [ids]` pushes marks back, `sel: [ids]` outlines the chosen one,
   `dead: [ids]` greys out a failure. Keep one loop running so the slide is
   never dead: `class="march"` on a dashed flow line, `breathe` on a pulse.
5. **Labels are editable**: every visible text needs `data-edit="KEY"` (a
   stable, readable key such as `n1`, `axis-x`) on the `<text>` that holds the
   words, with no child elements; a two-line label is two `<text>`s with a key
   each. In JS use `txt(KEY, 'words', attrs)` or `pill(id, 'words', x, y)`.
6. **Look**: the deck's figure colours only, as CSS variables (`var(--accent)`,
   `var(--tint)`, ...; in JS `C.accent`), never a typed hex. Text roles by
   class, never a font size: `head` (group name, 26), `lbl` (card title, 20),
   `sub` (card body, 17), `eyebrow` / `axis` (16, uppercase grey), `callout`
   (takeaway, accent), `big` (a headline number), `on-dark` (white text on a
   navy card). Cards: `class="card"` rect with `rx="8"`, no stroke; a 5 px left
   bar in a category colour marks its family. Content stays inside x 40..1240,
   y 20..460; nothing smaller than 16. Arrows: `marker-end="url(#ar)"`.
7. **Self-contained**: no external script, font, image URL or fetch.

### The builder

`deck.py` carries it: `figure_page(doc, marks, script, full_bleed=False)`
wraps your marks and steps into the working page (the click and key engine,
editable labels, the deck's own figure colours from its notes and its body
font), and `add_figure(doc, title, page, notes, footer="")` puts that page
on a new slide: the template's figure slide (title above, frame below),
copied. `marks` is SVG for three layers, `{"links": ..., "shapes": ...,
"labels": ...}` (any may be empty), painted in that order. `script` is
JavaScript that may build more marks with `mk(tag, attrs, layer)`,
`txt(key, words, attrs)` and `pill(id, words, x, y)`, and **must** define
`const steps = [...]`: one object per state, `{on: [ids], pose?, dim?, sel?,
dead?, cam?, do?}`. Helpers inside the page: `spotlight(ids, s)`,
`onto(id, toId)`, `stagger(ids, ms)`, `camFit(ids)`, the colours as `C.accent`
and so on.

A worked example (a three-stage flow that builds over four clicks, with a
token travelling through it):

```python
marks = {
  "links": """
    <path class="el draw" id="a1" d="M330,240 H500" fill="none" style="stroke:var(--accent)" stroke-width="3" marker-end="url(#ar)"/>
    <path class="el draw" id="a2" d="M780,240 H950" fill="none" style="stroke:var(--accent)" stroke-width="3" marker-end="url(#ar)"/>
    <path class="el march" id="loop" d="M1090,330 C1090,430 190,430 190,330" fill="none" style="stroke:var(--sky)" stroke-width="2"/>""",
  "shapes": """
    <rect class="el rise card" id="b1" x="50" y="170" width="280" height="140" rx="8"/>
    <rect class="el rise card" id="b2" x="500" y="170" width="280" height="140" rx="8"/>
    <rect class="el rise card" id="b3" x="950" y="170" width="280" height="140" rx="8"/>
    <circle class="el fly" id="tok" cx="190" cy="140" r="12" style="fill:var(--amber);--dx:-150px;--dy:0px"/>""",
  "labels": """
    <text class="el rise lbl" id="l1" data-edit="b1" x="190" y="248" text-anchor="middle">Ask</text>
    <text class="el rise lbl" id="l2" data-edit="b2" x="640" y="248" text-anchor="middle">Draft</text>
    <text class="el rise lbl" id="l3" data-edit="b3" x="1090" y="248" text-anchor="middle">Check</text>
    <text class="el fromR callout" id="take" data-edit="take" x="640" y="460" text-anchor="middle">Repeat until it holds</text>""",
}
script = """
const steps = [
  { on: [] },
  { on: ['b1','l1','tok'] },
  { on: ['b1','l1','tok','a1','b2','l2'], pose: { tok: { x: 450 } } },
  { on: ['b1','l1','tok','a1','b2','l2','a2','b3','l3'], pose: { tok: { x: 900 } }, dim: ['b1','l1'] },
  { on: ['b1','l1','tok','a1','b2','l2','a2','b3','l3','loop','take'], pose: { tok: { x: 900 } }, sel: ['b3'] },
];
"""
page = figure_page(doc, marks, script)
fig = add_figure(doc, "How the work moves", page,
    "On load: empty. 1: it starts with a question. 2: the agent drafts. "
    "3: we check the draft. 4: and the loop repeats until it holds.")
doc["slides"].append(fig)
```

Rules the builder relies on:

- `steps` lists **every** visible id in each state (copy the previous step's
  list and add or remove). An id that is in no step never shows.
- A mark with `pose` must already be visible in that step; a mark that
  *enters* gets its direction from its class (`rise`, `fromL`, `fly`, ...).
- A pose holds for one step only: repeat it in every later step where the
  mark should stay moved, or it slides back to where it was drawn.
- Ids are unique within the page and never reused for two marks.
- Text built in JS uses `txt()` / `pill()` so it stays editable; a label that
  must be measured (a pill around text) goes in `FIT`.
- Change only `marks` and `script`; never edit `deck.py`'s page parts. For a full-slide figure without a title, call
  `figure_page(..., full_bleed=True)` and, on the slide, set the frame to
  `x=0, y=0, w=1280, h=720` and remove `co-title`.
- **Check the page before saving the deck** if your sandbox can render HTML
  (for example with Playwright): open it at 1280x500, click through every
  state, and make sure nothing overlaps or falls outside the frame. If it
  cannot render, re-read your coordinates: every mark inside x 40..1240 and
  y 20..460, labels centred on their cards, no two cards overlapping.
- The figure slide has no thumbnail picture (a poster) in the slide list;
  that is expected. The figure itself runs in the editor and in the show.

## 8. Before you hand the file back

- [ ] `check(out_path)` prints OK.
- [ ] The file name is the deck's, not the template's.
- [ ] No sample slide of the template left by accident; the hidden "Start here" slide removed.
- [ ] Numbers shown as text that should be a chart?
- [ ] Margins inside 56..1184, two typefaces, one accent colour?
- [ ] Speaker notes on every slide?
- [ ] Tell the person where the deck is (in a chat: download it), that
      double-clicking it opens it in Chrome or Edge, that they edit by
      clicking and save with Ctrl+S, and that a comment typed beside a slide
      is a request for you: "Do my comments" when they are ready (in a chat,
      upload the saved file with it). A deck that was open while you wrote it
      needs a reload, after they save their own edits.
