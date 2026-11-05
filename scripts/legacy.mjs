// SPDX-License-Identifier: MIT
// Old names: decks written before the rename use these names.
//
// For the node scripts (upgrade-deck.mjs, shell-gate.mjs); the app's are in
// slides/src/legacy.ts and kernel/src/legacy.ts. Readers take the new name
// first and one of these second; writers write the new name.

/** The document block of a deck saved before the rename. */
export const LEGACY_DOC_ID = 'bento-doc'
export const LEGACY_DOC_TYPE = 'application/bento+json'
/** Its opening tag, and a regex for the whole block (content in group 1). */
export const LEGACY_DOC_OPEN = `<script type="${LEGACY_DOC_TYPE}" id="${LEGACY_DOC_ID}">`
export const LEGACY_DOC_BLOCK_RE = /<script type="application\/bento\+json" id="bento-doc">([\s\S]*?)<\/script>/
/** The document format value such a deck carries (kept as is). */
export const LEGACY_FORMAT = 'bento/slides'
/** The prefix of the other plaintext data blocks (language packs). */
export const LEGACY_BLOCK_TYPE_RE = /^application\/bento\+/
/** The shell the build wrote before the rename. */
export const LEGACY_SHELL = 'slides/dist-single/Bento_Slides.bento.html'
