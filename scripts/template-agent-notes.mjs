// SPDX-License-Identifier: MIT
//
// The agent briefing that travels INSIDE the document, for template.html and
// every deck made from it.
//
//   node scripts/stamp-agent-notes.mjs template.html            (this module is the default)
//   node scripts/stamp-agent-notes.mjs --notes OTHER.mjs deck.html
//
// Why it lives in the document and not in the HTML head: the head's comments
// belong to the SHELL, which is replaced wholesale whenever the deck is
// re-hosted (scripts/upgrade-deck.mjs keeps the document block and throws the
// rest of the file away). The document survives, so template-specific
// instructions have to be a document field.
//
// `agentNotes` is an unknown key to the app, which ignores it (format
// additivity) and re-serializes it verbatim on every save; inserted right
// after `title`, it stays in the first kilobyte of the file where an agent
// reading the head will see it.
//
// TWO KINDS OF NOTE. The hand-written ones below are the house rules that do
// not depend on what the file contains. Everything that DESCRIBES THE FILE --
// which layouts exist, their element ids and frames, which worked slides
// exist -- is GENERATED from doc.layouts and doc.slides by agentNotes(doc) at
// stamp time, so it cannot drift from the document it sits in. If you find
// yourself typing a layout id, a frame or a slide name into a hand-written
// note, stop: derive it instead. The colours and families quoted below are
// read from doc.theme and doc.fonts where they can be; FIGURE_TOKENS mirrors
// template/palette.py (keep the two in step).
//
// A brand kit keeps its own copy of this module (same exports) and passes it
// to the stamper with --notes.
//
// Keep every line free of "<" -- the block is `<`-escaped on write, and an
// escaped < in prose is unreadable for the agent this is written for. And
// never write the six-character sequence backslash-u-0-0-3-c literally in
// these strings: readers unescape the block with a global replace of that
// escape, which would eat the tail of the doubled backslash JSON.stringify
// emits and leave an invalid escape behind. Spell the escape out in words.

/** Page furniture every body layout carries; listed once, not per layout. */
const CHROME = new Set(['logo', 'footer', 'pageno'])

const frame = (e) => `${r(e.x)},${r(e.y)},${r(e.w)},${r(e.h)}`
const r = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : '?')

/** One line per element: id (type frame [key style facts]). */
function describeElement(e) {
  const bits = [e.type]
  bits.push(frame(e))
  if (e.type === 'text') {
    const fam = (e.fontFamily || '').split(',')[0].trim()
    if (fam) bits.push(fam)
    if (e.fontSize) bits.push(`${e.fontSize}px`)
    if (e.color) bits.push(e.color)
  } else if (e.type === 'image' && e.fit) bits.push(`fit:${e.fit}`)
  else if (e.type === 'shape' && e.fill) bits.push(`fill:${e.fill}`)
  else if (e.type === 'embed' && e.asset) bits.push(`asset:${e.asset}`)
  else if (e.type === 'poll' && e.kind) bits.push(`kind:${e.kind}`)
  return `${e.id} (${bits.join(' ')})`
}

const contentIds = (els) => new Set((els || []).map((e) => e.id).filter((id) => !CHROME.has(id)))

/** The layout a slide was built from, by element-id overlap (slides carry no
 *  layout reference of their own). Returns {layout, extra, missing} for the
 *  best match with at least half its ids in common, else null. */
function layoutOf(slide, layouts) {
  const ids = contentIds(slide.elements)
  let best = null
  for (const l of layouts) {
    const lids = contentIds(l.elements)
    const common = [...ids].filter((x) => lids.has(x)).length
    const score = common / Math.max(1, ids.size + lids.size - common) // Jaccard
    if (score >= 0.5 && (!best || score > best.score)) {
      best = { layout: l, score,
        extra: [...ids].filter((x) => !lids.has(x)),
        missing: [...lids].filter((x) => !ids.has(x)) }
    }
  }
  return best
}

/** Element lists are capped so a swatch card or a bar chart of shapes does
 *  not swamp the note; the JSON has the rest. */
const MAX_ELS = 16
function describeElements(els) {
  const list = (els || []).filter((e) => !CHROME.has(e.id))
  const shown = list.slice(0, MAX_ELS).map(describeElement)
  if (list.length > MAX_ELS) shown.push(`… ${list.length - MAX_ELS} more, read the JSON`)
  return shown.join('; ')
}

// Collapse whitespace and keep "<" out of the note (see the header comment).
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').replace(/</g, '‹').trim()

/** Notes that describe THIS document, derived from it. */
export function generatedNotes(doc) {
  const layouts = doc.layouts || []
  const slides = doc.slides || []
  const out = []

  // --- layouts --------------------------------------------------------------
  const layoutLines = layouts.map((l) => {
    let line = `${l.id} "${l.name || ''}" bg ${l.background || '?'}: ` + describeElements(l.elements)
    if (l.notes) line += `. RECIPE: ${oneLine(l.notes)}`
    return line
  })
  out.push(
    `LAYOUTS IN THIS FILE (generated from doc.layouts when these notes were stamped — ` +
    `if the JSON disagrees, the JSON is right; frames are x,y,w,h on a ` +
    `${doc.size?.width || 1280}x${doc.size?.height || 720} canvas; logo/footer/pageno omitted, ` +
    `see PAGE FURNITURE). ${layouts.length} layouts. ` +
    `To add a slide: pick the layout whose shape fits, deep-copy its elements into a new slide, ` +
    `KEEP THE ELEMENT IDS, replace the text; or "Apply layout" in the app. ` +
    `Placeholder prompts (the "placeholder" field) render dimmed in the editor and are hidden ` +
    `in the show — replace them with "html" content or delete the element. ` +
    `Where a layout carries a RECIPE, that is its speaker note and it is the rule for that layout. ` +
    layoutLines.join(' || '),
  )

  // --- slides ---------------------------------------------------------------
  const slideLines = slides.map((s, i) => {
    const m = layoutOf(s, layouts)
    const kinds = new Set((s.elements || []).map((e) => e.type))
    let line = `#${i + 1} "${s.name || ''}" id ${s.id}`
    if (s.stateOf) line += ` (state of ${s.stateOf})`
    if (m && !m.extra.length && !m.missing.length) line += ` = layout ${m.layout.id}`
    else if (m) {
      line += ` ≈ layout ${m.layout.id}`
      if (m.extra.length) line += ` plus ${m.extra.join(', ')}`
      if (m.missing.length) line += ` without ${m.missing.join(', ')}`
    } else line += ` = NO LAYOUT, copy the slide: ` + describeElements(s.elements)
    if (kinds.has('poll')) line += ' [working poll]'
    if (kinds.has('embed')) line += ' [working embed]'
    if (kinds.has('table')) line += ' [real table element]'
    if (kinds.has('chart')) line += ' [chart element]'
    if (s.notes) line += ` — notes: ${oneLine(s.notes).slice(0, 160)}${s.notes.length > 160 ? '…' : ''}`
    return line
  })
  out.push(
    `SLIDES IN THIS FILE (generated from doc.slides at stamp time). ${slides.length} slides. ` +
    `READ doc.slides AS WELL AS doc.layouts: a pattern only becomes a layout when an agent adds it to ` +
    `doc.layouts (the app has no layout tools), so a slide marked NO LAYOUT below is a pattern that exists only as a ` +
    `slide — invisible to anything that lists layouts — and the way to reuse it is to copy the slide. ` +
    `Every slide's speaker notes ("notes") say what it is for. ` +
    slideLines.join(' || '),
  )

  return out
}

/** The figure family's tokens (template/palette.py TOKENS). */
const FIGURE_TOKENS = {
  ink: '#1A2326', navy: '#0D2A2F', accent: '#0F6B73', sky: '#2B6CB0', muted: '#5A6467', faint: '#A7AFB1',
  line: '#C7CFD1', rule: '#D7DEDF', tint: '#F1F5F5', 'blue-tint': '#E2F0F1',
  amber: '#BF831A', 'amber-text': '#8E5F00', 'amber-tint': '#FCF0DA',
  green: '#3B9457', 'green-text': '#2B7041', 'green-tint': '#E3F2E6',
  coral: '#D2553A', 'coral-text': '#A83A20', 'coral-tint': '#FBE8E2',
}
const tokenLine = Object.entries(FIGURE_TOKENS).map(([k, v]) => `--${k}:${v}`).join('; ')

/** House rules that hold for any deck built from this template. Nothing in
 *  here may name a layout id, a frame, or a slide number -- that is what
 *  generatedNotes() is for. */
export function staticNotes(doc) {
  const t = doc.theme || {}
  const palette = Array.isArray(t.chartPalette) ? t.chartPalette.join(' ') : ''
  const fams = [...new Set((doc.fonts || []).map((f) => f.family || f.name).filter(Boolean))]
  const fontLine = fams.length
    ? `Fonts embedded in doc.assets and declared in doc.fonts: ${fams.map((f) => `"${f}"`).join(', ')} -- use those family names and add no others.`
    : 'Use only the font families declared in doc.fonts.'
  const title = fams.find((f) => f !== 'Manrope') || 'the title face'
  const W = doc.size?.width || 1280
  const H = doc.size?.height || 720

  return [
    'AI AGENTS -- READ THIS BEFORE EDITING. These notes live in the DOCUMENT, so they survive re-hosting; the HTML comments in the head belong to the app shell and are replaced every time this deck is re-hosted on a newer shell. If the head and these notes disagree, THESE WIN. The two notes headed LAYOUTS IN THIS FILE and SLIDES IN THIS FILE are generated from this document itself each time the notes are stamped, so they describe what is actually here.',

    sourceNote(),

    'WHAT THIS FILE IS. A tessera deck: one self-contained HTML file that is both the document and the app that edits it. This file is the tessera slide template (or a deck made from it). Tessera adds a poll element (live audience questions and games) and an embed element (a live web page inside a slide) that the guides of the editor it was forked from have never heard of; follow these notes and the tessera guides, not those.',

    'NO IN-APP UPDATES. Re-host this file only with tessera\'s own node scripts/upgrade-deck.mjs; a shell from another build may have no poll and no embed element and would break this deck.',

    'CHANGE REQUESTS ARE YOUR TO-DO LIST. People type change requests in the slide list: beside a slide (an entry of slides[i].comments with request:true; on a new empty slide it says what the slide should be -- build it) or in the Whole deck field (an entry of the top-level requests array, about the whole deck, e.g. the flow). Both have the shape {id, text, author, at, status: open|working|done|stopped, elementId?, elementIds?, replies?, resolved?, rev?}; elementId(s) are what was selected; rev counts the edits the person made to the text (one edited while you work on it: adjust to the new text); stopped = the person stopped it: stop at once and do not resume it. For every request not yet done or stopped: set status working, make the change (only what was asked), then append a reply (author = your own agent name, one line on what you did) and set status done and resolved true. Never delete a request. In a running file the app\'s requests API lists and answers them (list({open:true}) / reply(id, text, "done", name)); through the local agent bridge the open count arrives as pending on each session.',

    'EDITABLE FIGURE TEXT. Every visible label in an embed page carries data-edit="KEY" on the node that holds the text (an HTML element, an SVG text or tspan); text a script writes reads the embed API\'s text(KEY, default). The person edits those labels by double-click in the editor, and their wording is saved on the embed element as texts: {KEY: value}, which overrides the page. When you rebuild a figure keep its KEYs and leave texts alone.',

    'LIVE AGENT EDITING. While this deck is open in its editor, use the local agent_live.py read/patch connection described in docs/agent-live.md of the tessera repository. It applies ID-addressed changes with previous-value checks and updates the open editor without reloading. The editor owns saving. Never rewrite the HTML or load a stale whole-document snapshot during concurrent work. The file-edit instructions below apply only while the deck is not open, or after a coordinated save/pause handoff.',

    'HOW TO EDIT. The whole document is the ONE JSON script block near the top of this file (id "tessera-doc"; files written before the rename carry the older id, and every tool reads both): plain readable JSON. Edit that block IN PLACE and change nothing else. Escape every "less-than" character in the JSON as its JSON unicode escape (backslash, then u003c) so the block can never contain a closing script tag. The base64 blocks lower down are the DEFLATE-compressed app runtime -- never touch them, never regenerate the file.',

    'PICTURES AND LISTS OF POINTS -- the house convention, before anything else. ONE IMAGE, the default: the "tinted stage" image layout -- photo CONTAINED on the right, the panel behind it filled with the colour of the picture\'s own border (tools/panel_tint.py computes it); EXCEPT when the image already has a white or transparent background (a logo, a cut-out, a screenshot on white) -- then leave the panel white, because tinting behind one draws a visible box around nothing. ONE BIG, HIGH-RESOLUTION IMAGE: the "full bleed + band" image layout -- the only one that asks a photo to cover most of the slide, so a small or soft file will show. SEVERAL IMAGES: the "three across" grid -- one IDENTICAL box per picture, cover-cropped, captions on a shared baseline; never contain a picture in a row and never mix aspect ratios. SEVERAL POINTS WITH NO PICTURE: the points layout -- per column a square colour chip holding a stroke icon, a 4px rule in the same colour, a serif heading and the body; no card and no panel, so the chip and the rule are the only colour. The exact ids and frames of all four, and their recipes, are in LAYOUTS IN THIS FILE. Do not invent picture geometry.',

    'PAGE FURNITURE. Every body layout carries: logo (top-left; in this template a text WORDMARK that is empty until someone types a name into it -- hidden in the show while empty; an image element under the same id works too), footer (text, bottom-left), pageno (text, bottom-right, whose html is the literal token {{page:2}} -- a dynamic field the renderer resolves to the zero-padded slide number, so never hard-code a number there). Keep those element ids identical across slides: matching ids are what make the chrome morph in place instead of blinking. Dark layouts set the wordmark and the footer in a light colour.',

    `PALETTE AND TYPE. Canvas ${W}x${H}. From doc.theme: background ${t.background || '?'}, ink ${t.color || '?'}, accent ${t.accent || '?'}${palette ? `, chart palette ${palette}` : ''}. Deep ${FIGURE_TOKENS.navy} is the title and section background, muted ${FIGURE_TOKENS.muted} the footer and caption grey, ${FIGURE_TOKENS.line} / #E1E6E7 rules and card edges. Titles use the "${title}" serif face, body uses "Manrope"; both are SIL OFL fonts embedded in the file. ${fontLine} Keep the side margins: content starts at x=56 and right-most content x + w must stay under 1184. The colour-scheme layout is the palette reference card.`,

    'MAKE IT MOVE. A wall of text wastes this format. Numbers that compare go in a chart element, never bullets of figures. A spec or pricing grid goes in a table element. Two consecutive slides about the same thing changing get the SAME element ids plus transition:"morph" on the second one -- the shared elements glide; this is the signature move and it is almost always missed. A drill-down becomes a state slide (stateOf: parent-slide-id, plus link: state-slide-id on the element that opens it). A headline number gets fx:{countUp:true}. A hero photo gets fx:{ambient:"kenburns",ken:{dir:"drift",scale:1.08,duration:20}}. Write speaker notes on every slide -- they travel in the file. HOUSE DEFAULTS: every slide transitions with "morph" (shared ids glide, the rest rises in; use "fade" only for a deliberate change of scene). A LIST IS ONE TEXT ELEMENT: write each bullet as a line starting "• " (or "- "), lines separated by br tags, and two leading non-breaking spaces for a sub-point -- the renderer draws the accent marker and the hanging indent. Never lay out one text box per bullet; the title-and-bullets layout has a single body box for exactly this.',

    'AUDIENCE ENGAGEMENT (the poll element). The room answers on their phones and the slide reports back live. kind is one of: "open" (free text, AI-summarized into themes on stage), "choice" (options[], one live bar each), "rating" (min/max scale, live average and spread), "quiz" (questions[] of {q, options[], correct}; the correct answers NEVER leave the deck -- phones get the questions without them and the slide shows the distribution of scores), "activity" (a self-contained HTML page this deck ships to every phone -- a game, a custom form, anything the four fixed kinds do not cover; put the page in doc.assets and name the key in activityAsset, and have the page POST its result to /api/answer as one string, by convention JSON like {"score":4,"total":5}, which the slide reads as a leaderboard). Every poll needs question + code; code is that question\'s answer bucket, /^[a-z0-9]{4,12}$/, and MUST be unique per question -- mint a fresh one from the alphabet abcdefghjkmnpqrtuvwxy346789 (no 0/o/1/l/i/5/s/2/z, they get misread across a room) whenever you copy a poll, or the copy collects into the original\'s answers. doc.poll.session is the ONE join code the room scans for the whole talk (prefix "s"); doc.poll.service is the poll service that serves the join page -- your own deployment (docs/server-setup.md). This template ships with it EMPTY: set it (slide.py service DECK) before presenting a poll. Answers stay server-side: only the summary is ever written back into this file, and the join code is printed on a projector, so treat question and answers as public. The slide marked [working poll] in SLIDES IN THIS FILE is the example to copy.',

    'INFOGRAPHICS AND SIMULATIONS (the embed element). This is the only element that runs JavaScript, so anything animated, stepped or interactive is an embed: put the page HTML in doc.assets and name the key in the element\'s "asset" field. The page must be SELF-CONTAINED -- inline CSS and JS, no CDN, no linked web fonts, no fetch -- because the deck has to work offline; the deck\'s own Manrope arrives inlined as a data URI (see FIGURE STYLE). A poster is effectively required (poster: "asset:key" of a JPEG/PNG): the editor canvas and the thumbnails rasterize slides and cannot rasterize a live frame, so an embed without a poster shows an empty box everywhere but the show. Draw to the frame\'s real aspect: full-bleed is 1280x720, and under a title band it is about 1224x469, so use a 1280x480 viewBox -- a mismatched aspect letterboxes the figure and throws away width. Keys: the deck hands the arrow keys back from any frame that does not use them, and a click-stepped figure that declares itself stepped (window.TESSERA_STEPPED = true; the older name is still read) is offered each arrow first -- it builds, and the arrow after its last step moves to the next slide. A stepped figure must therefore stop (not wrap) at either end of its build. The slides marked [working embed] in SLIDES IN THIS FILE are the examples. For static artwork, prefer ordinary shapes, paths and text elements over an embed: they stay editable and can morph.',

    `FIGURE STYLE -- every embed in a deck must look like one family; figures drift apart fast when each one picks its own shades. FONT: Manrope only, inlined -- declare @font-face{font-family:Manrope;font-weight:200 800;src:url(MANROPE) format('woff2')} and build the page with tools/embed_font.py, which swaps in this file's own Manrope asset; a figure without it silently renders in the system font. No slide title inside a figure: the slide's title element carries it. FIGURE TOKENS (declare them as CSS custom properties on :root and use only these): ${tokenLine}. TYPE ROLES, in viewBox units of a 1280-wide figure (1 unit is about 1 slide px): group header 26/700 ink; eyebrow, axis end and legend 16/600 uppercase letter-spacing .08em muted; card title or mark label 20/700 ink; card body 17/500 muted; takeaway line 20/700 accent; headline number 52/700; nothing under 16. Cards: tint fill, corner radius 8, no stroke, a 5px left bar in the category colour marks a card's family. A colour outside the tokens on purpose (a computed ramp) is listed in a meta tag named figcheck-palette (content = the hexes).`,

    'TEMPLATE HYGIENE. A template file carries template:true, which makes every open mint a FRESH document (new docId, fresh poll codes and session) so two speakers working from it never collide. The flag is set in the JSON only: opening a template in the app CONSUMES it, so if the master template has lost template:true, put it back in the JSON before saving over it (slide.py template FILE). A NEW deck made by copying this file needs its own docId and fresh poll codes: run slide.py fork --polls on the copy. This is not a tidiness rule: two files with the same docId MERGE THEIR EDITS whenever both are open in the same browser -- including a headless browser used only to take screenshots -- and the merge is a CRDT, so closing the tab does not undo it.',

    'GOTCHAS THAT COST REAL TIME. Unknown property names are ignored rather than rejected, so a typo means your styling silently does not apply -- do not invent field names. Bar and line chart series data must be plain numbers ({value,...} objects coerce to 0; only pie takes {name,value}), and chart options are pure JSON with template formatters {b} {c} {d}, never functions. A line shape takes its colour from "fill" (not "stroke") and draws horizontally across its box, so a vertical rule is a rotation. Morph pairs elements by id, so ids must be stable and deterministic and must not collide within one slide. Never regenerate docId on an existing deck: it is the document\'s identity. doc.layouts is owned by this file -- no generator rebuilds it, so a layout added to the JSON (copy a slide with slide.py copy and add it to doc.layouts) is permanent; keep element ids stable when you add one, because the deck tools (tools/md_to_deck.py) resolve geometry by those ids and find a layout by its role (an id equal to the role, or ending in -role).',

    'SELF-AUDIT BEFORE YOU FINISH: numbers rendered as text that should be a chart; consecutive slides on one subject that should share ids plus transition:"morph"; at least one motion moment, especially on the cover; a drill-down that would work better as a state slide; the side margins and the palette; speaker notes on every slide.',

    `FULLER GUIDES. The tessera repository (${REPO}) has the authoring guide in docs/guide/ (docs/guide/reference/agents.md is the full format guide, docs/guide/reference/TEMPLATE.md this template's conventions) and python tools in tools/ that compile, screenshot and splice slides deterministically. With none of that available, everything above can still be done by editing this JSON block by hand.`,
  ]
}

/** Where the docs, the tools and newer versions live. Exported so a brand
 *  kit's notes module carries the same note (one owner). */
export const REPO = 'https://github.com/angeloromasanta/tessera'
export function sourceNote() {
  return `SOURCE, DOCS AND UPDATES -- CHECK FIRST. Tessera is open source (MIT): ${REPO} . Before non-trivial work, if you can reach the network, read there: README.md (quick start), docs/guide/README.md (the authoring guide: anatomy, slide.py, parallel agents, figures, polls and games, converting a pptx, publishing), docs/guide/reference/agents.md (the full format) and CHANGELOG.md (what changed after this file was made). Raw files: ${REPO}/raw/main/PATH . Where the repo's guide and these notes disagree on METHOD, the guide is newer; these notes stay right about THIS file (its layouts, slides and house rules). Clone it (git clone ${REPO}.git) for the tools: tools/slide.py reads and writes one slide at a time, on disk or in the open editor, and tools/shoot.py takes screenshots. Run python tools/slide.py doctor on this file before building into it: it reports an app shell too old for pages built today, and the fix is node scripts/upgrade-deck.mjs FILE (keeps the document, replaces the shell). Without network access, these notes are enough to edit this file by hand.`
}

/** The complete briefing for one document: house rules, then the generated
 *  inventory of that document. Deterministic for a given doc. */
export function agentNotes(doc) {
  const s = staticNotes(doc)
  const g = generatedNotes(doc)
  // Inventory goes right after the opening notes, before the conventions that refer to it.
  return [...s.slice(0, 5), ...g, ...s.slice(5)]
}

export default agentNotes
