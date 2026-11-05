// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Language packs carried in the file.
//
// A PACK LIVES IN THE FILE. Nowhere else. Upstream could download a pack from
// its release channel and splice it into the deck on the next save; the fork
// has no channel, so this module only keeps the packs a file already carries:
// it registers them at boot and writes them back out on every save, so a deck
// that arrived with a language block never loses it (a file saved before the
// rename carries it under the old block type: read, and written back new).

import { addPack, type LanguagePack } from '../../kernel/src/i18n.ts'
import { readShellBlocks, type ShellBlock } from '../../kernel/src/save.ts'
import { LEGACY_PACK_TYPE } from './legacy'

/** The block type carrying a pack inside a saved shell. */
export const PACK_BLOCK_TYPE = 'application/tessera+lang'
/** Every type a pack block may arrive under; a save clears them all. */
export const PACK_BLOCK_TYPES = [PACK_BLOCK_TYPE, LEGACY_PACK_TYPE]
const blockId = (lang: string) => `tessera-lang-${lang}`

/** The packs this file carries. */
const inFile = new Map<string, LanguagePack>()

/**
 * Read packs already embedded in this file and register them. Runs at boot
 * from the i18n facade, before the first t(): a deck that arrives carrying
 * Japanese must show Japanese immediately, offline, with nothing fetched.
 * Not re-verified: once spliced, a pack carries exactly the trust the
 * document itself does.
 */
export function readPacksFromShell(): number {
  let n = 0
  for (const { body } of PACK_BLOCK_TYPES.flatMap((t) => readShellBlocks(t))) {
    try {
      const pack = JSON.parse(body) as LanguagePack
      if (pack?.lang && pack.strings && addPack(pack, 'slides')) {
        inFile.set(pack.lang, pack)
        n++
      }
    } catch {
      // a corrupt block must not stop the app booting — skip it
    }
  }
  return n
}

/** The blocks the kernel writes into every saved shell. */
export function shellBlocksForPacks(): ShellBlock[] {
  return [...inFile.values()].map((p) => ({
    id: blockId(p.lang),
    type: PACK_BLOCK_TYPE,
    body: JSON.stringify(p),
    attrs: { 'data-lang': p.lang },
  }))
}
