// SPDX-License-Identifier: MIT
// Old names: decks written before the rename use these names.
//
// The app's half of the compatibility layer; the kernel's is
// kernel/src/legacy.ts, the browser scripts' is legacy-names.js (imported here
// so it also runs in the deck window). Nothing outside these files spells an
// old name. Readers take the new name first and one of these second; writers
// write the new name; nothing old is deleted.
//
// Imported FIRST by main.ts: copying the old localStorage keys has to happen
// before any module reads one.

import './legacy-names.js'
import LEGACY_NAMES_JS from './legacy-names.js?raw'
import { migrateLocalStorage } from '../../kernel/src/legacy.ts'

export { LEGACY_DOC_ID, LEGACY_DOC_TYPE, LEGACY_BLOCK_TYPE_PREFIX } from '../../kernel/src/legacy.ts'

migrateLocalStorage()

/** The browser-script layer, as text: first in every embed's preamble and in
 *  every activity page the deck publishes. */
export { LEGACY_NAMES_JS }

/** The document format value older files carry. Opened as is and KEPT as is:
 *  the value travels with the JSON (tools, the agent bridge, clipboard), and
 *  an older shell refuses any other one. New documents get the new value. */
export { LEGACY_SLIDES_FORMAT as LEGACY_FORMAT } from '../../kernel/src/legacy.ts'

/** Language-pack blocks older files carry (packs.ts). */
export const LEGACY_PACK_TYPE = 'application/bento+lang'

// --- messages between the deck and its frames ---------------------------------

const MSG = 'bento'

/** The kind of a frame message under either key ({tessera:'goto'} or the old
 *  {bento:'goto'}); '' when it is not one of ours. */
export function msgKind(d: unknown): string {
  if (!d || typeof d !== 'object') return ''
  const o = d as Record<string, unknown>
  const k = typeof o.tessera === 'string' ? o.tessera : o[MSG]
  return typeof k === 'string' ? k : ''
}

/** A message for a frame: the new key, and the old one for pages written
 *  before the rename (they test `d.bento === 'slide'`). */
export function frameMsg(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, tessera: kind, [MSG]: kind }
}

/** The same two keys, as JavaScript source for scripts injected into frames. */
export const FRAME_MSG_KEYS_JS = `tessera:K,${MSG}:K`

// --- page opt-ins ---------------------------------------------------------------

/** `<meta name="tessera-game">`, or the old name: the page gets the game SDK. */
export const GAME_META = /<meta\s[^>]*name=["']?(?:tessera|bento)-game\b/i
/** `<meta name="tessera-offline-ok">`, or the old name. */
export const OFFLINE_OK_META = /<meta name="(?:tessera|bento)-offline-ok"/

// --- clipboard and drag between windows ------------------------------------------

/** The tag older shells put on clipboard JSON (`{__bento: 'clip'}`). */
export const LEGACY_CLIP_TAG = '__bento'
/** The drag type older shells put on dragged slides. */
export const LEGACY_DRAG_TYPE = 'text/bento-slides'

// --- the running file's API -------------------------------------------------------

/** window.tessera, also reachable as the name scripts used before the rename. */
export function exposeApi(api: unknown): void {
  const w = window as unknown as Record<string, unknown>
  w.tessera = api
  w.bento = api
}

// --- the poll service -------------------------------------------------------------

/** The lecturer-key header the poll service read before the rename. The
 *  frozen Vercel service still reads only this one (and only lets this one
 *  through its CORS check), so a service that refuses the new name is asked
 *  again with this one, and remembered. */
export const LEGACY_LECTURER_HEADER = 'x-bento-lecturer'
const oldWire = new Set<string>()
const originOf = (url: string) => { try { return new URL(url, location.href).origin } catch { return url } }
export const lecturerHeaderFor = (url: string) =>
  oldWire.has(originOf(url)) ? LEGACY_LECTURER_HEADER : 'x-tessera-lecturer'
export const markOldWire = (url: string) => { oldWire.add(originOf(url)) }
export const isOldWire = (url: string) => oldWire.has(originOf(url))

// --- globals a figure page sets ----------------------------------------------------

const OLD_GLOBAL = { TESSERA_REFIT: 'BENTO_REFIT', TESSERA_STEPPED: 'BENTO_STEPPED' } as const

/** JavaScript reading a global a page sets, under either name. The accessor
 *  legacy-names.js installs covers `window.OLD = …`, but a top-level
 *  `function OLD(){}` replaces the accessor with a plain property. */
export const eitherGlobalJs = (now: keyof typeof OLD_GLOBAL) => `(window.${now}||window.${OLD_GLOBAL[now]})`
