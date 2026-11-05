#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Stamp (or refresh) the in-document agent briefing on a deck.
//
//   node scripts/stamp-agent-notes.mjs                          # template.html, template-agent-notes.mjs
//   node scripts/stamp-agent-notes.mjs deck.html [more.html …]
//   node scripts/stamp-agent-notes.mjs --notes path/to/brand-notes.mjs brand.html
//   node scripts/stamp-agent-notes.mjs --check deck.html        # report only
//
// The briefing lives in `doc.agentNotes` (see scripts/template-agent-notes.mjs
// for why it is a document field and not an HTML comment). Part of it is
// generated from the deck's own layouts and slides, so re-run this after
// adding or changing a layout in the template, and on any deck made from it
// whose notes `--check` reports as STALE or MISSING.
//
// --notes takes any module exporting agentNotes(doc) (a brand kit keeps its
// own). Relative paths resolve against the current directory.
//
// Everything else in the document is left byte-identical apart from the
// re-serialization JSON.stringify performs. The field is inserted directly
// after `title` so it lands in the first kilobyte of the file. The block keeps
// the name it was found under (#tessera-doc, or the older id).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { backup } from './backup.mjs'
import { LEGACY_DOC_ID, LEGACY_DOC_TYPE, LEGACY_FORMAT } from './legacy.mjs'

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
// The document block under its new name or the old one (scripts/legacy.mjs); group 1 is
// the type, group 2 the id, group 3 the JSON. A rewrite keeps the name it found.
const BLOCK_RE = new RegExp(String.raw`<script type="(application/tessera\+json|${esc(LEGACY_DOC_TYPE)})" ` +
  String.raw`id="(tessera-doc|${esc(LEGACY_DOC_ID)})">([\s\S]*?)<\/script>`)
const FORMATS = new Set(['tessera/slides', LEGACY_FORMAT])

const args = process.argv.slice(2)
const check = args.includes('--check')
const ni = args.indexOf('--notes')
const notesPath = ni >= 0 ? resolve(args[ni + 1] || '') : join(HERE, 'template-agent-notes.mjs')
const decks = args.filter((a, i) => !a.startsWith('--') && !(ni >= 0 && i === ni + 1))
if (!decks.length) decks.push(join(ROOT, 'template.html'))
if (!existsSync(notesPath)) {
  console.error(`no notes module at ${notesPath}`)
  process.exit(1)
}
const { agentNotes } = await import(pathToFileURL(notesPath).href)

/** Rebuild the document with `agentNotes` right after `title`, preserving the
 *  order of every other key (JSON.stringify emits insertion order, and that
 *  order is what puts the notes near the top of the file). */
function withNotes(doc, notes) {
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'agentNotes') continue // re-inserted at its canonical position
    out[k] = v
    if (k === 'title') out.agentNotes = notes
  }
  if (!out.agentNotes) out.agentNotes = notes // a doc with no title
  return out
}

let failed = 0
for (const file of decks) {
  try {
    if (!existsSync(file)) throw new Error('no such file')
    const src = readFileSync(file, 'utf8')
    const m = BLOCK_RE.exec(src)
    if (!m) throw new Error('no document block — is this a tessera deck?')
    const [, mime, id] = m
    const doc = JSON.parse(m[3].trim().replace(/\\u003c/g, '<'))
    if (!FORMATS.has(doc.format)) throw new Error(`unexpected format "${doc.format}"`)

    // The briefing is derived from THIS document (its layouts and slides), so
    // it is recomputed per file and goes stale whenever the file's own
    // inventory changes — which is exactly when it should.
    const AGENT_NOTES = agentNotes(doc)
    if (JSON.stringify(AGENT_NOTES).includes('\\u003c')) throw new Error('a note contains the forbidden u003c sequence')
    const had = Array.isArray(doc.agentNotes) ? doc.agentNotes : null
    const same = had && JSON.stringify(had) === JSON.stringify(AGENT_NOTES)
    if (check) {
      console.log(`${file}: ${same ? 'current' : had ? 'STALE' : 'MISSING'}` +
        ` (${AGENT_NOTES.length} notes, ${Math.round(JSON.stringify(AGENT_NOTES).length / 1024)} KB)`)
      continue
    }
    if (same) { console.log(`${file}: already current`); continue }

    const json = JSON.stringify(withNotes(doc, AGENT_NOTES)).replace(/</g, '\\u003c')
    // Replacer FUNCTION, never a string: `$&`, `$1` and friends are
    // substitution patterns, and an embedded page's minified JS is full of them.
    const out = src.replace(BLOCK_RE, () =>
      `<script type="${mime}" id="${id}">\n${json}\n</scr` + 'ipt>')
    if (!out.includes(json)) throw new Error('splice failed')
    // Prove the write is readable before it lands.
    const back = JSON.parse(BLOCK_RE.exec(out)[3].trim().replace(/\\u003c/g, '<'))
    if (back.slides?.length !== doc.slides?.length) throw new Error('round-trip lost slides')

    const bak = backup(file)
    writeFileSync(file, out)
    console.log(`${file}: ${had ? 'refreshed' : 'stamped'} agentNotes ` +
      `(${AGENT_NOTES.length} notes · ${doc.slides.length} slides · ` +
      `${Math.round(out.length / 1024)} KB${bak ? ` · backup: ${bak}` : ''})`)
  } catch (e) {
    failed++
    console.error(`${file}: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
