#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Self-extracting shell: compress the built runtime so the file on disk is
// ~half the size, with zero feature loss.
//
//   node scripts/postbuild-compress.mjs slides/dist-single/tessera.html
//
// Takes the vite single-file build, extracts the big inline module script and
// stylesheet, deflates them (raw) into base64 payload blocks, and restructures
// the document into the canonical byte order:
//
//   head chrome → NOTICE → tooling comment → #tessera-doc (PLAINTEXT, always)
//   → splash (paints while the payload parses) → payloads + 1KB loader last
//
// The loader inflates via the native DecompressionStream and boots the module
// from a blob URL. Browsers without DecompressionStream (pre-2023 Safari) get
// a plain-HTML message instead of a blank page.
//
// COMPATIBILITY CONTRACT (docs/PLATFORM.md §2):
//   - #tessera-doc stays plaintext with the same id.
//   - The whole file survives DOMParser → splice → outerHTML round-trips.
//   - No literal "</script>" anywhere (base64 alphabet can't produce one;
//     the loader is checked below).
// scripts/shell-gate.mjs runs a frozen v0.1.0-style splice against the output.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const path = process.argv[2]
if (!path || path.startsWith('--')) {
  console.error('usage: node scripts/postbuild-compress.mjs <shell.html>')
  process.exit(1)
}

const generator = 'tessera'
const titleFallback = 'Tessera'

const html = readFileSync(path, 'utf8')
if (html.includes('id="tessera-rt"')) {
  console.log('already compressed — skipping')
  process.exit(0)
}

// --- extract the runtime pieces --------------------------------------------
const modRe = /<script type="module"[^>]*>([\s\S]*?)<\/script>/
const mod = html.match(modRe)
if (!mod) throw new Error('module script not found')

// the FIRST big <style> is the app css; the splash <style> lives in body.
// Strip the module script first — its bundled JS text can contain literal
// "<style...>...</style>"-shaped substrings (e.g. xlsx.ts's OOXML
// `<styleSheet>` template) that would otherwise false-match this regex.
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/
const headPart = html.slice(0, html.indexOf('</head>')).replace(modRe, '')
const styleM = headPart.match(styleRe)
if (!styleM) throw new Error('app stylesheet not found in head')

const js = mod[1]
const css = styleM[1]

const b64 = (s) => deflateRawSync(Buffer.from(s, 'utf8'), { level: 9 }).toString('base64')
const jsB64 = b64(js)
const cssB64 = b64(css)

// --- other parts ------------------------------------------------------------
// The NOTICE names its copyright holders by a placeholder: they are the
// "Copyright" lines of the repo's LICENSE, which MIT says every copy carries.
const licensePath = new URL('../LICENSE', import.meta.url)
const holders = existsSync(licensePath)
  ? readFileSync(licensePath, 'utf8').split(/\r?\n/).filter((l) => /^Copyright\b/.test(l.trim())).map((l) => l.trim())
  : []
if (!holders.length) throw new Error('LICENSE has no Copyright line to put in the NOTICE')
const notice = (html.match(/<!--\s*NOTICE[\s\S]*?-->/)?.[0] ?? '')
  .replace('@COPYRIGHT@', holders.join('\n      '))
const docBlock = html.match(/<script type="application\/tessera\+json" id="tessera-doc">[\s\S]*?<\/script>/)?.[0]
if (!docBlock) throw new Error('#tessera-doc not found')
const favicon = html.match(/<link rel="icon"[^>]*\/?>/)?.[0] ?? ''
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? `<title>${titleFallback}</title>`
const splashDiv = html.match(/<div id="tessera-splash"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
const splashCss = (() => {
  const bodyPart = html.slice(html.indexOf('<body'))
  const m = bodyPart.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  return m ? m[1] : ''
})()

const SLIDES_TOOLING = `<!--
  ════════════════════════════════════════════════════════════════════════
  AI AGENTS / TOOLING — READ THIS BEFORE EDITING THIS DECK
  ════════════════════════════════════════════════════════════════════════
  This file is a Tessera deck: one HTML file that is both the document and
  the app (editor, presenter, live polls and games, interactive figures).

  CHANGE REQUESTS — YOUR TO-DO LIST
  · People ask for changes in the slide list (beside the slide, or in its
    "Whole deck" field). A slide's request is an entry of
    slides[i].comments with "request": true; a whole-deck one (e.g.
    "improve the flow") is an entry of the top-level "requests" array.
    A new empty slide whose request says what it should be is yours to
    build. Both have the shape:
    { id, text, author, at, status: "open"|"working"|"done"|"stopped",
      elementId?, elementIds?, replies?: [{ id, author, text, at }],
      resolved?, rev?, editedAt?, stoppedAt? }.
    elementId(s) name what was selected when it was typed. "rev" counts the
    person's edits of the text after sending: one edited while you work on it
    means adjust to the new text. "stopped" means the person stopped it:
    stop at once, land nothing more for it, do not resume it.
  · Treat every request whose status is not "done" or "stopped" as work to do: set
    status "working", make the change, then add a reply (author = your own
    name, saying what you did) and set status "done" and resolved: true.
    Change only what the request asks for. Never delete a request.
  · In a running file: window.tessera.requests.list({open:true}) and
    window.tessera.requests.reply(id, text, "done", "<agent name>").
  · The local agent bridge (docs/agent-live.md in the source) reports how many
    are open ("pending") and lets a listener wait for new ones.

  FIGURE TEXT — EDITABLE BY THE PERSON
  · Embed pages mark every visible label data-edit="KEY" (text a script
    writes reads TESSERA_EMBED.text(KEY, default)). The person's edits are saved
    on the embed element as "texts": { KEY: value } and override the page.
    When you rebuild a figure keep its KEYs, and keep "texts" — it is their
    wording, not stale data.

  THE MECHANICS
  · The document is the ONE script block of type "application/tessera+json",
    id "tessera-doc", below — plain readable JSON. Edit THAT block in place;
    never regenerate the whole file. Escape every "<" in the JSON as \\u003c.
  · The base64 blocks near the end are the DEFLATE-compressed app runtime
    (open source, MIT) — no user content, leave them alone.
  · In a running file, window.tessera exposes { doc, serialize(), loadDoc(json),
    comments(), requests, agent, i18n }.
  · THIS COMMENT BELONGS TO THE APP SHELL, and re-hosting with upgrade-deck
    replaces the shell wholesale (only #tessera-doc is carried across). So if
    the document carries an "agentNotes" field, READ THAT FIRST and prefer it:
    it is the deck's own briefing — brand rules, house layouts, which fork
    built it — and unlike this comment it survives re-hosting.

  MAKE A GREAT DECK, NOT JUST A CORRECT ONE
  The format's whole point is motion + interactivity. A wall of text slides wastes
  it. When the source material contains ↓, reach for the feature:
  · numbers to compare visually (trend, magnitude, share)  →  a CHART
      element (preset bar|line|pie|scatter). Never list data as bullet text.
  · a comparison / spec / pricing / feature grid  →  a TABLE element
      (columns[] + rows[] of cells + a style object). Not a pile of textboxes.
  · consecutive slides about the SAME thing changing (before/after, process
    steps, a metric across stages)  →  give the shared elements the SAME id
    on both slides and set the later slide's transition to "morph". This is
    the format's signature move — use it liberally; it is almost always missed.
  · a point to drill into (a definition, "click to see how")  →  a STATE
    slide (stateOf: "<parent-id>" + an element link: "<state-id>").
  · a hero / full-slide image  →  full-bleed image (0,0,1280,720) + a scrim
    rect + text on top, with a slow ken-burns drift
      (fx:{ambient:"kenburns",ken:{dir:"drift",scale:1.08,duration:20}}).
  · a sequence / flow / timeline / connection  →  a line or path with a
    loop (fx:{loop:{type:"dash-march",...}}), or morph a highlight through it.
  · a headline number  →  big, with fx:{countUp:true}.
  · every cover / section divider  →  at least ONE ambient motion so it is
    not dead static.
  · repeated chrome or a logo  →  keep its id stable across slides so it
    morphs in place instead of popping.
  · an infographic that BUILDS, a simulation, anything the audience should
    poke at  →  an EMBED element, the only element that runs JavaScript:
    "asset" names a doc.assets key holding a SELF-CONTAINED page (inline CSS
    and JS, no CDN, no fetch, works offline), plus a "poster" — the canvas
    and the thumbnails rasterize slides and cannot rasterize a live frame, so
    an embed without one is an empty box everywhere but the show. Draw to the frame's real aspect (full-bleed 1280x720; under a title
    band ~1224x469, so a 1280x480 viewBox). STATIC artwork is better as
    ordinary shapes/paths/text — those stay editable and can morph.
  · the audience should answer/vote/react live  →  a POLL element, kind:
      "open" (free text → AI-summarized themes), "choice" (options[] → a live
      bar per option), "rating" (min/max scale → live average + spread),
      "quiz" (questions[] of {q,options[],correct} answered in one go; the
      correct answers NEVER leave the deck, the slide shows the score spread),
      or "activity" (activityAsset → a self-contained HTML page this deck
      ships to every phone: a game, a custom form, anything the fixed kinds
      don't cover; the page posts one string back, by convention JSON like
      {"score":4,"total":5}, and the slide reads it as a leaderboard).
      Requires question + code (answer bucket, /^[a-z0-9]{4,12}$/, unique per
      question — a COPIED poll must get a fresh one or it collects into the
      original's answers). doc.poll.session is the single join code the room
      scans for the whole talk; doc.poll.service is the deployment serving the
      join page. Answers are never stored in the file — only the summary is,
      and the join code is printed on a projector, so treat both the question
      and the answers as public.

  BEFORE YOU FINISH — self-audit:
  [ ] any numbers rendered as text that should be a chart?
  [ ] do consecutive slides on one subject share ids + transition:"morph"?
  [ ] at least one motion moment (ken-burns / loop / count-up), esp. the cover?
  [ ] a drill-down that would work better as a state slide?
  [ ] one accent colour, at most two typefaces, 96px side margins?
  [ ] speaker notes written (they travel in the file)?
  ════════════════════════════════════════════════════════════════════════
-->`

const TOOLING_COMMENT = SLIDES_TOOLING

// --- loader (plain script, runs at end of body; no "</script>" literal) -----
const loader = `
(async () => {
  var fail = function (msg) {
    var d = document.createElement('div')
    d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0D1B2E;color:#F2F0EA;font:16px/1.6 sans-serif;text-align:center;padding:40px;z-index:99999'
    d.innerHTML = msg
    document.body.appendChild(d)
    var s = document.getElementById('tessera-splash'); if (s) s.remove()
  }
  if (typeof DecompressionStream === 'undefined') {
    fail('This file needs a browser from 2023 or later (Chrome 80+, Edge, Firefox 113+, Safari 16.4+).<br>The document itself is intact \\u2014 open this file in a newer browser.')
    return
  }
  var inflate = async function (id) {
    var b64 = document.getElementById(id).textContent.trim()
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0) })
    var ds = new DecompressionStream('deflate-raw')
    var stream = new Blob([bytes]).stream().pipeThrough(ds)
    return await new Response(stream).text()
  }
  try {
    var css = await inflate('tessera-rt-css')
    var st = document.createElement('style')
    st.textContent = css
    document.head.appendChild(st)
    var js = await inflate('tessera-rt')
    var url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
    await import(url)
  } catch (e) {
    fail('This file could not start: ' + (e && e.message ? e.message : e))
  }
})()
`
if (loader.includes('</scr' + 'ipt>')) throw new Error('loader contains script-close')

// --- assemble ----------------------------------------------------------------
const out = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="only light" />
    <meta name="generator" content="${generator}" />
    ${favicon}
    ${title}
    ${notice}
    ${TOOLING_COMMENT}
    ${docBlock}
    <style>${splashCss}</style>
  </head>
  <body>
    ${splashDiv}
    <div id="app"></div>
    <script id="tessera-rt-css" type="tessera/deflate-b64">${cssB64}</script>
    <script id="tessera-rt" type="tessera/deflate-b64">${jsB64}</script>
    <script>${loader}</script>
  </body>
</html>
`

// sanity: script-close count must equal script tag count (splice invariant)
const closes = out.split('</scr' + 'ipt>').length - 1
const opens = (out.match(/<script[\s>]/g) ?? []).length
if (closes !== opens) throw new Error(`script tag imbalance: ${opens} opens, ${closes} closes`)

writeFileSync(path, out)
const kb = (n) => `${Math.round(n / 1024)}KB`
console.log(`compressed shell: ${kb(html.length)} → ${kb(out.length)} (js ${kb(js.length)}→${kb(jsB64.length)}, css ${kb(css.length)}→${kb(cssB64.length)})`)
