// SPDX-License-Identifier: MIT
// Old names: decks written before the rename use these names.
//
// The kernel's half of the compatibility layer (the app's is
// slides/src/legacy.ts). Nothing outside these files spells an old name:
// every reader takes the new name first and one of these second, every writer
// writes the new name, and nothing old is ever deleted — a browser profile
// that still opens decks on an older shell keeps its data.

/** The document block of a file saved before the rename. */
export const LEGACY_DOC_ID = 'bento-doc'
export const LEGACY_DOC_TYPE = 'application/bento+json'
/** Prefix of the other plaintext data blocks older files carry. */
export const LEGACY_BLOCK_TYPE_PREFIX = 'application/bento+'
/** The password-protected document envelope's format before the rename. */
export const LEGACY_ENC_FORMAT = 'bento/enc'
/** The file name suffix older saves suggested. */
export const LEGACY_FILE_SUFFIX = /\.bento\.html$/i

/** The document block of THIS page, under either name. */
export function findDocBlock(root: Document): Element | null {
  return root.getElementById(DOC_ID) ?? root.getElementById(LEGACY_DOC_ID)
}
// (the new names, repeated here so this file needs no import from save.ts)
const DOC_ID = 'tessera-doc'
const DOC_TYPE = 'application/tessera+json'

/** Rename an old-named document block in place (a shell copy about to be
 *  written): what is saved always carries the new name. */
export function renameDocBlock(block: Element): void {
  if (block.id !== LEGACY_DOC_ID) return
  block.id = DOC_ID
  block.setAttribute('type', DOC_TYPE)
}

// --- browser storage ---------------------------------------------------------

const OLD_PREFIX = 'bento-'
const NEW_PREFIX = 'tessera-'

/**
 * Copy every `bento-*` localStorage key to its `tessera-*` name, once per key:
 * a key the new name already holds is left alone, and the old key stays (an
 * older shell in the same profile still reads it). Run before anything reads
 * localStorage.
 */
export function migrateLocalStorage(): void {
  try {
    const ls = window.localStorage
    const keys: string[] = []
    for (let i = 0; i < ls.length; i++) keys.push(ls.key(i) ?? '')
    for (const k of keys) {
      if (!k.startsWith(OLD_PREFIX)) continue
      const nk = NEW_PREFIX + k.slice(OLD_PREFIX.length)
      if (ls.getItem(nk) === null) ls.setItem(nk, ls.getItem(k) ?? '')
    }
  } catch { /* storage off: nothing to carry */ }
}

/** The IndexedDB databases older shells wrote, by their new name. */
export const LEGACY_DB: Record<string, string> = {
  'tessera-autosave': 'bento-autosave',
  'tessera-file-handles': 'bento-file-handles',
}

const legacyDbs = new Map<string, Promise<IDBDatabase | null>>()

/** Open an old database WITHOUT creating it: null when it never existed. */
export function openLegacyDb(newName: string): Promise<IDBDatabase | null> {
  const name = LEGACY_DB[newName]
  if (!name) return Promise.resolve(null)
  let p = legacyDbs.get(name)
  if (p) return p
  p = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(name) } catch { resolve(null); return }
    // An upgrade on a no-version open means the database did not exist:
    // abort it, which discards the empty database it would have created.
    req.onupgradeneeded = () => { try { req.transaction?.abort() } catch { /* */ } }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  legacyDbs.set(name, p)
  return p
}

/** Every record of `store` in an old database whose `index` (or key) is
 *  `key`; [] when there is no such database or store. */
export function readLegacy<T>(db: IDBDatabase | null, store: string, key: IDBValidKey, index?: string): Promise<T[]> {
  if (!db || !db.objectStoreNames.contains(store)) return Promise.resolve([])
  return new Promise((resolve) => {
    try {
      const s = db.transaction(store, 'readonly').objectStore(store)
      const src: IDBObjectStore | IDBIndex = index ? s.index(index) : s
      const req = src.getAll(IDBKeyRange.only(key))
      req.onsuccess = () => resolve((req.result ?? []) as T[])
      req.onerror = () => resolve([])
    } catch { resolve([]) }
  })
}

/** Remember (in localStorage) that one key was carried over from an old
 *  database, so a record later cleared in the new one is not brought back. */
export function legacyCopied(dbName: string, key: string): boolean {
  try { return localStorage.getItem(`${NEW_PREFIX}copied:${dbName}:${key}`) === '1' } catch { return false }
}
export function markLegacyCopied(dbName: string, key: string): void {
  try { localStorage.setItem(`${NEW_PREFIX}copied:${dbName}:${key}`, '1') } catch { /* repeated next time, harmlessly */ }
}

/** The slides document format value older files carry. Opened as is and
 *  KEPT as is: the value travels with the JSON (tools, the agent bridge, the
 *  clipboard), and an older shell refuses any other one. New documents get
 *  the new value. (Here rather than in the app's legacy.ts because the model
 *  is also loaded by node tests, which cannot run that file.) */
export const LEGACY_SLIDES_FORMAT = 'bento/slides'
