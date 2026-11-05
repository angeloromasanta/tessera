#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
//
// Move an existing deck onto the freshly built shell, keeping its document
// exactly as it is.
//
//   node scripts/upgrade-deck.mjs <deck.html> [more.html …]
//
// This is the splice contract from the outside (docs/PLATFORM.md): the document
// is one plaintext <script id="tessera-doc"> block, so a deck can be re-hosted
// on a newer app without regenerating it from source. There is no in-app
// self-update, so this is how every deck moves onto a new build.
//
// The document is copied VERBATIM. Nothing is migrated or "fixed": the app
// reads old documents, that is the whole point of format additivity. A deck
// saved before the rename carries the block under its old name (legacy.mjs);
// it is read the same way and lands in the new shell's #tessera-doc.
// A backup goes to the deck's build/backups/ before it is touched (backup.mjs).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backup } from './backup.mjs'
import { LEGACY_DOC_BLOCK_RE, LEGACY_FORMAT } from './legacy.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SHELL = join(root, 'slides/dist-single/tessera.html')
const BLOCK_RE = /<script type="application\/tessera\+json" id="tessera-doc">([\s\S]*?)<\/script>/
const FORMATS = ['tessera/slides', LEGACY_FORMAT]

const decks = process.argv.slice(2)
if (!decks.length) {
  console.error('usage: node scripts/upgrade-deck.mjs <deck.html> [more.html …]')
  process.exit(1)
}
if (!existsSync(SHELL)) {
  console.error(`no shell at ${SHELL}\nbuild it first: cd slides && npm run build:single`)
  process.exit(1)
}

const shell = readFileSync(SHELL, 'utf8')
if (!BLOCK_RE.test(shell)) {
  console.error(`${SHELL} has no #tessera-doc block — rebuild it`)
  process.exit(1)
}
// The shell's JS is deflated, so its version isn't greppable here — report
// the version of the source it was built from.
const shellVersion = JSON.parse(
  readFileSync(join(root, 'slides/package.json'), 'utf8'),
).version ?? 'unknown'

let failed = 0
for (const file of decks) {
  try {
    if (!existsSync(file)) throw new Error('no such file')
    const src = readFileSync(file, 'utf8')
    const m = BLOCK_RE.exec(src) ?? LEGACY_DOC_BLOCK_RE.exec(src)
    if (!m) throw new Error('no document block — is this a deck file?')

    // The block is `<`-escaped in the file (JSON reads that escape itself;
    // un-escaping it first broke on a literal backslash before "u003c").
    // Parsed only to report on it and to prove it is intact: the bytes
    // spliced across are the ORIGINAL ones.
    const raw = m[1].trim()
    let doc
    try {
      doc = JSON.parse(raw)
    } catch {
      throw new Error('the document block is not valid JSON')
    }
    if (!FORMATS.includes(doc.format)) throw new Error(`unexpected format "${doc.format}"`)

    const out = shell.replace(BLOCK_RE, () =>
      `<script type="application/tessera+json" id="tessera-doc">\n${raw}\n</scr` + 'ipt>')
    if (!out.includes(raw)) throw new Error('splice failed — shell has no #tessera-doc block')

    const bak = backup(file)
    writeFileSync(file, out)

    const polls = (doc.slides ?? []).flatMap((s) =>
      (s.elements ?? []).filter((e) => e.type === 'poll')).length
    console.log(
      `${file} → shell ${shellVersion} · ${doc.slides?.length ?? 0} slides` +
      `${doc.template ? ' · template' : ''}${polls ? ` · ${polls} poll${polls > 1 ? 's' : ''}` : ''}` +
      ` · ${Math.round(out.length / 1024)} KB${bak ? ` (backup: ${bak})` : ''}`,
    )
  } catch (e) {
    failed++
    console.error(`${file}: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
