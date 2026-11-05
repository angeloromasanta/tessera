# tessera/slides — the document format

**The authoritative format guide for tessera decks.** Not the upstream
editor's own agent guide: it has no `poll` and no `embed`. Where they
disagree, this file wins. Shared working rules (material → element, JSON
rules, self-audit) are in [../authoring.md](../authoring.md), edit paths in
[../editing.md](../editing.md); read this one by section, not whole. The dry
field-by-field reference is [../../format.md](../../format.md).

**Guide version `__APP_VERSION__`** · format `tessera/slides` (v1). The deck's
`#tessera-doc` JSON is the source of truth; unknown keys are ignored, never fatal.

| section | open it for |
|---|---|
| [Copy-paste recipes](#copy-paste-recipes) | morph pair, chart, table, state slide, hero image, the five polls, video |
| [Minimal valid document](#minimal-valid-document) | required top-level fields |
| [Element types](#element-types-all-share-idxywhrotationopacity) | every element's fields; `poll` and `embed` in full |
| [Rules that make decks feel designed](#the-rules-that-make-decks-feel-designed) | lists, morph, `fx` entrances, ken-burns, loops, links, count-up |
| [Layout guardrails](#layout-guardrails) | canvas, margins, fonts |
| [Dynamic fields](#dynamic-fields-tokens-in-text-html) | `{{page}}`, `{{title}}`, `meta` |
| [Gotchas](#gotchas) | `agentNotes`, escaping, `docId`, `readonly`, `template` |

The bundled template is `$TESSERA/template.html` (or whatever
`TESSERA_TEMPLATE` names): its layouts
(`slide.py info $TESSERA/template.html --section layouts`) and a worked slide
per layout. Its conventions: [TEMPLATE.md](TEMPLATE.md). Rebuilding the shell
is engine work ([../../OVERVIEW.md](../../OVERVIEW.md)).

A deck (`*.html`) keeps its document in ONE block near the top:

```html
<script type="application/tessera+json" id="tessera-doc">
{ "format": "tessera/slides", ... }
</script>
```

**Legacy names.** Decks written before the rename use older names for the
block, the format and the page globals, and remain readable: every reader
takes the new name first and the old one second, every writer writes the new
one. The list is [legacy.md](legacy.md); write only the names on this page.

Edit it with `slide.py` (see [../editing.md](../editing.md), "Which edit path"), which escapes
every `<` as backslash-`u003c` so the block never contains `</script>`.
Everything after the block is runtime; leave it untouched.

*For a chatbot with no file access only:* the whole document can be swapped
from the browser console with `window.tessera.loadDoc(json)`. It replaces
everything, so **never use it during a live or concurrent session**: it
overwrites every other agent's and the person's edits.

## Copy-paste recipes

What each kind of material should become, and the self-audit, are in
[../authoring.md](../authoring.md). These recipes are schema examples. Coordinates
follow the house margins: content x=56..1184.

**Morph a title + accent bar between two slides** — identical ids, `transition:"morph"`:
```json
// slide 1
{ "id":"s1","transition":"none","elements":[
  { "id":"headline","type":"text","x":56,"y":140,"w":900,"h":200,"html":"Big claim.","fontSize":120,"fontWeight":900,"color":"#111","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":56,"y":380,"w":320,"h":16,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
// slide 2 — same ids, new frames → they animate
{ "id":"s2","transition":"morph","elements":[
  { "id":"headline","type":"text","x":56,"y":84,"w":500,"h":80,"html":"Big claim.","fontSize":40,"fontWeight":900,"color":"#888","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":56,"y":170,"w":16,"h":450,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
```

**A bar chart from a table** — bar/line data is PLAIN NUMBERS (see chart rules below):
```json
{ "id":"c1","type":"chart","x":56,"y":260,"w":1128,"h":380,"rotation":0,"opacity":1,"preset":"bar","option":{
  "xAxis":{"type":"category","data":["2022","2023","2024","2025"]},
  "yAxis":{"type":"value"},
  "series":[{"type":"bar","data":[420,780,1300,2450],"itemStyle":{"color":"#141310"},"barWidth":90}],
  "tooltip":{"trigger":"item","formatter":"{b}: {c}"} },
  "fx":{"enter":"fade-up"} }
```

**A comparison table** — a real HTML table; cells are the same inline-html subset as text:
```json
{ "id":"tbl1","type":"table","x":240,"y":220,"w":800,"h":260,"rotation":0,"opacity":1,
  "header":true,
  "columns":[{"w":1.4},{"w":1},{"w":1}],
  "rows":[
    { "cells":[{"html":"Plan"},{"html":"Price","align":"right"},{"html":"Seats","align":"right"}] },
    { "cells":[{"html":"Team"},{"html":"$29"},{"html":"5"}] },
    { "cells":[{"html":"Business"},{"html":"$79"},{"html":"25"}] } ],
  "style":{"headerBg":"#1E2A3A","headerColor":"#fff","zebra":"rgba(30,42,58,0.05)",
    "borderColor":"rgba(30,42,58,0.14)","borderWidth":1,"cellPadX":16,"cellPadY":11,
    "fontSize":18,"color":"#1E2A3A","radius":10} }
```

**A state slide reached by clicking a node** — parent slide has the clickable element, the state lives adjacent:
```json
// on the parent slide, an element the viewer clicks:
{ "id":"node-ingest","type":"shape","shape":"ellipse","x":330,"y":180,"w":74,"h":74,"fill":"#0B0E1E","stroke":"#7A5CFF","strokeWidth":2,"radius":0,"rotation":0,"opacity":1,"link":"state-ingest" }
// a hidden state slide (arrow keys skip it; ← returns to parent):
{ "id":"state-ingest","stateOf":"parent-slide-id","transition":"morph","name":"INGEST","elements":[ /* … */
  { "id":"dismiss","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(0,0,0,0)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1,"link":"parent-slide-id" } ] }
```

**Full-bleed hero image with ken-burns + scrim + text:**
```json
{ "id":"photo","type":"image","x":0,"y":0,"w":1280,"h":720,"src":"asset:hero","fit":"cover","radius":0,"rotation":0,"opacity":1,"fx":{"ambient":"kenburns","ken":{"dir":"drift","scale":1.09,"duration":22}} },
{ "id":"scrim","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(10,14,26,0.55)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 },
{ "id":"htitle","type":"text","x":56,"y":460,"w":1000,"h":180,"html":"On top of the photo.","fontSize":76,"fontWeight":800,"color":"#fff","align":"left","valign":"top","lineHeight":1.05,"rotation":0,"opacity":1,"fx":{"enter":"fade-up"} }
```
(Embed the image as a data URI in `doc.assets` under key `hero`, then reference `"asset:hero"` — the file must stay self-contained.)

**Audience poll — the five answer kinds** (`code` is the answer bucket, `/^[a-z0-9]{4,12}$/`, unique per question in the deck):
```json
// open text — free-form answers, summarized into themes on stage
{ "id":"q1","type":"poll","x":140,"y":160,"w":1000,"h":420,"rotation":0,"opacity":1,
  "kind":"open","question":"What's the biggest blocker to shipping this quarter?","code":"blk2026" }

// multiple choice — a live bar per option
{ "id":"q2","type":"poll","x":140,"y":160,"w":1000,"h":420,"rotation":0,"opacity":1,
  "kind":"choice","question":"Which feature should we build next?",
  "options":["Search","Offline mode","Dark theme"],"code":"vote01" }

// rating — a live average + distribution over a numeric scale
{ "id":"q3","type":"poll","x":140,"y":160,"w":1000,"h":420,"rotation":0,"opacity":1,
  "kind":"rating","question":"How confident are you in the roadmap?",
  "min":1,"max":5,"minLabel":"Not at all","maxLabel":"Very","code":"conf01" }

// quiz — several MCQs answered in one go; the slide shows the SCORE spread.
// `correct` indexes that question's own options and NEVER leaves the deck:
// phones get the questions without it and submit only their picks.
{ "id":"q4","type":"poll","x":140,"y":160,"w":1000,"h":420,"rotation":0,"opacity":1,
  "kind":"quiz","question":"Quick check — 3 questions","code":"chk01","questions":[
    {"q":"Which ocean is the largest?","options":["Atlantic","Pacific","Indian"],"correct":1},
    {"q":"What is 7 × 8?","options":["54","56"],"correct":1} ] }

// activity — the deck ships a whole self-contained page to the phones: a game,
// a custom form, anything the four fixed kinds don't cover. The page posts one
// string back; by convention JSON with a `score`, which the slide ranks.
{ "id":"q5","type":"poll","x":140,"y":160,"w":1000,"h":420,"rotation":0,"opacity":1,
  "kind":"activity","question":"Beat the clock","code":"game01",
  "activityAsset":"activity-game","requireName":true }
```
(`kind` absent defaults to `"open"`. The join QR/URL, response counts, and Summarize button only render in present mode — the slide is otherwise static and network-free.)

**Video — embed a short clip, or link a big one** (autoplay is present-only; `muted` required to autoplay):
```json
// embedded — self-contained, keep it small (a few MB at most):
{ "id":"clip","type":"media","kind":"video","src":"data:video/mp4;base64,AAAA…","x":220,"y":120,"w":840,"h":472,"rotation":0,"opacity":1,"controls":true,"muted":true,"autoplay":true,"loop":true,"fit":"cover","radius":8 }
// linked — deck stays tiny; needs the URL at play time (give it a poster):
{ "id":"clip","type":"media","kind":"video","src":"https://cdn.example.com/demo.mp4","poster":"asset:demo-poster","x":220,"y":120,"w":840,"h":472,"rotation":0,"opacity":1,"controls":true }
```

## Minimal valid document

Start from this skeleton when creating a deck from scratch. `size` and
`theme` (including `fontFamily`) are **required** — the app will not boot
without them — and elements should carry the full field set shown.

```json
{
  "format": "tessera/slides", "version": 1, "title": "My deck",
  "size": { "width": 1280, "height": 720 },
  "theme": { "background": "#101418", "color": "#F2F0EA",
             "accent": "#FF9E8A", "fontFamily": "system-ui, sans-serif" },
  "slides": [
    { "id": "s1", "background": "#101418", "transition": "none",
      "notes": "speaker notes here",
      "elements": [
        { "id": "t1", "type": "text", "x": 56, "y": 260, "w": 1128, "h": 160,
          "rotation": 0, "opacity": 1,
          "html": "Hello from an agent.",
          "fontSize": 88, "fontFamily": "system-ui, sans-serif",
          "fontWeight": 800, "color": "#F2F0EA",
          "align": "left", "valign": "top", "lineHeight": 1.1 }
      ] }
  ]
}
```

**Change requests live on the slide**: `slide.comments[]` threads with
`request: true`, typed in the editor's review list beside that slide (on an
empty slide: what the slide should be). Requests about the
whole deck are the same threads in the top-level `requests` array.
A thread is `{id, author, text, at, elementId?, elementIds?, request: true,
status: "open"|"working"|"done", resolved?, replies: [{id, author, text, at}]}`;
`elementId(s)` name the selection it was typed against. Never delete one; serve
them with `slide.py requests` / `reply` ([../editing.md](../editing.md), "Requests typed
in the editor"). Figure text a person retyped is the embed's `texts` (below).

## Element types (all share `id,x,y,w,h,rotation,opacity`)

- **text**: `html` (inline `<b> <i> <br>` ok), `fontSize`, `fontFamily`,
  `fontWeight`, `color`, `align` (`left|center|right`), `valign`,
  `lineHeight`, optional `letterSpacing`.
- **shape**: `shape` = `rect|ellipse|triangle|arrow|line|path`, `fill`, `stroke`,
  `strokeWidth`, `radius` (rect corner). Optional `fillGradient`
  `{angle, stops:[{at:0..1, color}]}` (CSS-convention angle). Lines take
  their color from `fill` and draw horizontally across the box (rotate for
  vertical); `strokeStyle: solid|dashed|dotted`; tips `lineStart`/`lineEnd`
  = `arrow|dot|bar`. A `path` is a free vector: `d` (SVG path data) +
  `pathBox` `[x,y,w,h]` authoring viewBox, stretched into the element box;
  for a **curved line** set `fill:"transparent"` + a `stroke` + `strokeWidth`.
  A **connector** is a `line` (or `path`) with `from`/`to: {el, side}` — its ends
  follow those elements and re-route when they move (side `"auto"` picks the
  nearest border). Make sure a shape's colour contrasts with its slide background.
- **image**: `src` = data URI or `"asset:<key>"` into `doc.assets`,
  `fit: cover|contain|fill`, `radius`. Embed images as data URIs in
  `doc.assets` and reference them — the file must stay self-contained.
- **chart**: `preset: bar|line|pie|scatter`, `option` = ECharts-SHAPED pure
  JSON. **Bar/line series data must be plain numbers** (`{value,itemStyle}`
  objects coerce to 0 — only pie takes `{name,value}`); per-item bar colors
  are unsupported, color by series; template formatters only (`{b}`, `{c}`,
  `{d}`), never functions. **Dual axis**: for two series on very different
  scales (e.g. volume + a %), make `yAxis` an ARRAY of two `{type:"value"}`
  axes (give the 2nd `axisLabel:{formatter:"{value}%"}`) and point the odd
  series at it with `"yAxisIndex":1` — render it as a `line` over the bars.
- **table**: `columns` (array of `{w}` fractional weights), `rows` (array of
  `{cells:[{html, align?, color?, bg?, bold?}]}`), `header` (bool — row 0 is
  the header), and a `style` object (`headerBg`, `headerColor`, `zebra?`,
  `borderColor`, `borderWidth`, `cellPadX`, `cellPadY`, `fontSize`,
  `fontFamily?`, `color`, `radius`, and the optional `rules?`
  (`"grid"` default | `"rows"`: hairlines between rows only), `headerRule?`
  (colour of a 2px rule under the header), `headerCaps?` (small letter-spaced
  capitals)). Renders as a real HTML table. In cell `html`, `<code>` is a
  command chip, `<mark>` a soft accent tag and `<mark><b>…</b></mark>` a filled
  one (older shells show `<mark>` as a plain highlight). Use for
  comparison/spec/pricing grids — NOT for numeric trends (use a chart).
  **`style.fontFamily` is optional and usually absent**: the renderer falls
  back to `doc.theme.fontFamily`, so a table already matches the deck's body
  face. Set it only to make one table deliberately differ.
- **svg**: `asset` or `markup` for static artwork. Prefer composing rects/
  texts/paths — those stay editable and can morph.
- **media**: `kind: video|audio`, `src` = data URI (embedded — travels in the
  file), an external URL / relative path (referenced — keeps the file small,
  needs the network at play time), or `"asset:<key>"`. Video also takes
  `poster`, `fit: cover|contain|fill`, `radius`. Playback flags: `controls`,
  `autoplay`, `loop`, `muted`. **Autoplay fires only in present mode**, and
  browsers require `muted:true` for a video to autoplay. **Embed only SHORT
  clips** — a big data URI bloats the file and makes it slow to open/save;
  host large media and reference its URL instead.
- **poll**: an audience question — the room answers on their phones, the slide
  reports back. Required `question` (plain text) + `code` (this question's
  answer bucket, `/^[a-z0-9]{4,12}$/`). `kind` picks what the room does —
  **five options**:
  - `"open"` (default) — free text, reported as AI-generated `summary` themes.
    Answers stay hidden until the presenter asks for them. In the bundled
    template an open question is the hive slide (`sl-poll-hive`): the
    poll hidden under a clustering embed; `sl-poll-matrix` places the
    answers on the presenter's axes instead (set them with `slide.py axes`).
  - `"choice"` — `options: string[]`; one live bar per option.
    `multi?: boolean` lets a phone pick several: the answer is then a JSON
    array of the picked option strings, and the tally counts each pick while
    `total` stays the number of respondents.
  - `"rating"` — `min?`/`max?` (default `1..5`), `minLabel?`/`maxLabel?`; live
    average + distribution.
  - `"quiz"` — `questions: [{q, options: string[], correct: number}]`, all
    answered in one go on the phone; the slide shows the distribution of
    SCORES. **`correct` never leaves the deck**: the phones are sent the
    questions without it and submit only their picks, so a student reading the
    network traffic learns nothing.
  - `"activity"` — a **self-contained HTML page the deck ships to the phones**
    instead of a built-in form: a game, a custom multi-step form, anything the
    other four don't cover. `activityAsset` (a `doc.assets` key — preferred)
    or inline `activityHtml`, max ~60 000 characters, no CDN and no fetch to
    anything but the poll service. The page runs in a sandboxed iframe with an
    opaque origin (so no `localStorage`), is handed
    `window.TESSERA_ACTIVITY = {code, name}`, and POSTs its own result to
    `/api/answer` as ONE string — by convention JSON like
    `{"score":4,"total":5}`, which the slide ranks as a leaderboard.

  Optional `requireName` (the join page asks once per session; names reach the
  presenter via the export and are never sent to the summarizer), `service`
  (poll-service base URL override), `prompt`/`model` (summarizer tuning), and
  **`showJoin: false`** — drop the QR, the address and the code from the side
  column. For a slide that REPORTS a bucket the room already answered (a reveal
  later in the talk, a state slide showing one question another way). Without
  it such a slide looks exactly like a new question and a room will try to
  answer it again. Count, results and Summarize are unaffected.
  Renders deterministically everywhere (question, join QR/URL, any saved
  `summary`); live counts, Summarize and the activity page run **only in
  present mode**. **Never write individual answers into the document** — only
  `summary` is saved back, so a reshared deck carries no audience text. Give
  each poll a fresh, deck-unique `code`; the app remints one automatically on
  duplicate/paste, but a hand-written deck must avoid collisions itself, or
  the copy collects into the original's answers.
  - **Deck-level**: `doc.poll.session` (`"s"` + 6) is ONE join code for the
    whole talk — the room scans once and their page follows whichever question
    is on screen; `doc.poll.service` is the deployment that serves the join
    page and the answer buckets. Both are inherited by any deck copied from a
    template, so **re-mint the session** when forking a deck by hand.
- **embed**: a live web page in the slide — a simulation, an interactive
  infographic, a small app. **This is the only element that executes
  JavaScript**, so it is the one to reach for when the audience should poke at
  something rather than read it. (`text`/`table` `html` is sanitized to
  `b/i/u/br/span/div/p/strong/em/s/code/a` (anchors retain only absolute HTTP(S) hrefs and open in a new tab); `svg` `markup` goes in via
  `innerHTML`, which never runs `<script>`.) Source, in priority order:
  `asset` (key into `doc.assets` holding the page's HTML) → `html` (raw
  inline) → `src` (a URL). **Prefer inline**: an `asset`/`html` embed travels
  inside the file and works offline, which is the whole point of a
  self-contained deck; a `src` embed breaks the moment the host is down or the
  room has no wifi. Also takes `poster`, `zoom`, `radius`, `sandbox`,
  `liveInEditor`.
  - **`poster` is effectively required.** The editor canvas and the sidebar
    thumbnails rasterize slides, and a live iframe cannot be rasterized — without a poster those surfaces show an empty chip. Render
    the page at its logical viewport and downscale to the element box.
  - **`zoom`** gives the frame a logical viewport of `w/zoom × h/zoom` CSS px
    and scales it to fit. Most pages are laid out for a desktop window and are
    cropped inside a 1280×720 box; `zoom: 0.8` buys a 1600×900 viewport. Size
    it from the page's real `document.body.scrollHeight`, do not guess.
  - **Sandbox.** `allow-scripts` is always applied; extra tokens go in
    `sandbox`. **`allow-same-origin` is stripped from an inline page** — an
    `asset`/`html` embed renders through `srcdoc`, so its own origin IS the
    deck's, and the token would hand the frame the parent document with the
    E2EE room keys it carries. It **is** honoured on a `src` pointing at a
    cross-origin http(s) URL, where the origin granted is that third party's
    and the parent stays unreachable. Ask for it there and nowhere else: a
    hosted player (YouTube, Vimeo) renders a black rectangle without it. For a
    YouTube clip the working set is
    `["allow-same-origin","allow-popups","allow-popups-to-escape-sandbox","allow-presentation"]`
    on `src: https://www.youtube.com/embed/<id>?rel=0&modestbranding=1`, and
    the player prints its own title bar and controls — inset the frame rather
    than bleeding it, or the deck's logo and footer collide with them.
  - **`texts`: editable labels.** A page that marks its labels with
    `data-edit="KEY"` (leaf text nodes; script-written text reads
    `TESSERA_EMBED.text(KEY, default)`) can be retyped on the edit canvas by
    double-click; the edits are stored on the element as `texts: {KEY: value}`
    and re-applied inside the frame, never written into the page. Keep `texts`
    whenever the element's page is replaced, re-pointed or rebuilt. The
    contract for authors: [../figures.md](../figures.md), "Building rules".
  - **Live in present mode only** by default; the editor shows the poster, so
    a deck full of embeds stays light to edit. Set `liveInEditor: true` to
    override for one element.
  - **`window.TESSERA_EMBED` is injected before an inline page** (`asset` or
    `html`; a `src` embed gets none) whenever the frame runs live. Exact shape
    (`slides/src/render.ts`, `embedPreamble`):
    `{texts, editable, poll: {service, session, lecturer, previous}}`
    (`texts`/`editable` and `TESSERA_EMBED.text(KEY, default)`: the editable
    labels below), where `lecturer` is the
    presenter's key from that browser's `localStorage` (`""` if not entered)
    and `previous` is the nearest poll at or before this slide,
    `{code, kind, question, join}` or `null`. It lets a figure READ what the
    room answered earlier: `GET {service}/api/poll?c={code}` answers any
    origin, and the service address is the one thing an opaque-origin page
    cannot work out. Prefer `previous.code` over a hard-coded code (codes are
    reminted from templates); always leave a manual fallback for no wifi.

    **Reading answers needs the lecturer key** (`answers[]` is withheld
    without it, `answersWithheld: true`), and every read counts against the
    service: the rule, the reading code, polling limits and offline rehearsal
    are in [../engagement.md](../engagement.md), "Answers from one slide, shown on another".
  - To inline a bundled app (Vite/React and friends), rewrite its chunk
    imports into `data:text/javascript;base64,…` module URLs so the whole
    import graph collapses into one inline `<script type="module">`. See
    `$TESSERA/scripts/embeds/why-people-disagree.html` and the embed slides of the template
    (`sl-embed` and the others `slide.py ls` lists).

## The rules that make decks feel designed

- **A list is one text element.** A line starting `- ` or `• ` renders
  as a bullet: accent marker, hanging indent, 0.4em between items; two leading
  spaces or `&nbsp;`s make a second level (`–`). Left/justified text only.
  Write `"• One<br>• Two<br>&nbsp;&nbsp;• Sub"` — never a text box per bullet.
- **Morph is the default transition** in the bundled template, the compiler and
  new slides. Unmatched incoming elements rise in, so it reads well
  even between unrelated slides.
- **Morph = shared ids.** Slides with `"transition": "morph"` tween any
  elements whose `id` matches the previous slide — position, size, color,
  gradients. This is THE signature move: carry 2–4 ids through the deck and
  rearrange them per slide. Generators must emit deterministic ids.
- **Entrances**: `fx: { enter: "fade-up", order: 0 }` — equal `order` =
  simultaneous. Entrance staggers only run on non-morph arrivals.
- **Ken-burns**: `fx: { ambient: "kenburns", ken: { dir: "drift|out|in",
  scale: 1.08, duration: 20 } }` — `drift` loops, `out`/`in` settle once on
  slide entry. For full-bleed photos: image at 0,0,1280,720 + a scrim rect
  + text on top. Never combine entrance tweens with motion-path loops.
- **Loops**: `fx: { loop: { type: "dash-march" | "motion-path", ... } }`.
- **Interactivity**: element `link: "<slide-id>"` jumps on click; a slide
  with `stateOf: "<parent-id>"` is a hidden variant reached only by links
  (arrow keys skip it, ← returns to parent). Give clickable things a padded
  transparent rect as the hit target, not the text itself.
- **Numbers count up** with `fx: { countUp: true }`.
- **Speaker notes** (`notes`) are part of the document — write them; they
  make a template teach itself.

## Layout guardrails

- Canonical canvas 1280×720 (`doc.size` can differ — read it first).
- Content spans x=56..1184 (the template's margins; nothing crosses 1184).
- One accent color; 2 typefaces max. `theme` sets deck defaults.
- Fonts: `doc.fonts` (`{family, asset, weight}`) + woff2 data URIs in
  `doc.assets` if you need embedded faces; otherwise stick to system stacks.

## Dynamic fields (tokens in text `html`)

Put these tokens in any text element's `html`; they resolve at render time (the
model keeps the raw token, so numbering/props update automatically):
`{{page}}`, `{{pages}}` (position among non-state slides; zero-pad with
`{{page:2}}`→"06"), `{{title}}`, `{{date}}`, `{{time}}`, and the document
properties `{{author}}`, `{{company}}`, `{{subject}}`, `{{event}}`. Set the
props in an optional top-level `"meta": {author, company, subject, event,
keywords}` object — great for title slides and footers that fill from one place.

## Gotchas

- **Read `doc.agentNotes` first if the deck has one.** It is an array of
  plain-string house rules the file carries about itself (brand, which build
  made it) plus two notes generated from the file's own `layouts` and
  `slides` — the catalogue of layout ids, element frames, recipes and worked
  slides — sitting right after `title` so it lands in the first kilobyte of
  the file. It survives app updates — the `AI AGENTS / TOOLING` comment in
  the HTML head does not, because an update replaces the whole shell and
  carries only `#tessera-doc` across. Where they disagree, the notes win.
  `$TESSERA/scripts/stamp-agent-notes.mjs` writes and refreshes the field;
  run it after adding a layout or compiling a deck.
- Escaping, unknown keys and `String.replace` splicing: [../authoring.md](../authoring.md), "JSON
  rules". One extra trap: the unescape step turns the six-character sequence
  backslash-u003c back into `<`, so never let it appear inside a string
  *value*; spell it out in words.
- `docId` is the document's identity — never regenerate it when editing.
- `readonly: true` makes a PLAYER file — it boots straight into the
  presentation with no editor. Set it only on hand-out copies.
- If `template: true` is set, every open mints a fresh document (that's for
  distributable templates; remove it for a personal deck).
- Charts degrade gracefully but exotic ECharts config is ignored — keep
  options minimal.
- **Media size**: embedding a large video as a data URI can push the file into
  the tens of MB and make it slow to open and save. Embed only short clips;
  otherwise host the file and put its URL in `media.src`.
- **Arrow keys and embeds.** The shell injects a key bridge: an arrow, Page
  or Space key the page does not `preventDefault()` is handed back to the deck,
  and a page that sets `window.TESSERA_STEPPED = true` is offered the deck's keys
  first (it lets them through at either end of its build). Keys typed into a
  field stay in the page. [../figures.md](../figures.md) covers stepped figures.
- **A field the shipped renderer has never heard of is silently ignored**,
  which looks exactly like a bug in your JSON. If a document field genuinely
  needs new engine support, that is engine work: [../../OVERVIEW.md](../../OVERVIEW.md).
- **`String.replace` with a string replacement is unsafe for splicing the doc
  block**: `$&`, `` $` ``, `$'` and `$1` are substitution patterns, and
  minified JS in an embedded page is full of them. Use a replacer *function*.

Working examples of everything above: `$TESSERA/template.html`. Inspect it
with `slide.py ls` / `slide.py get` / `slide.py info --section …`; it carries
a worked slide per layout, live embeds (`sl-embed` and its siblings), polls and a
real table, and its `agentNotes` name which slide is which.
