// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Self-saving: a deck file writes itself back to disk with updated data.
//
// At boot (before the app mutates the DOM) we deep-clone the document. On save
// we swap the clone's data block content for the current model JSON and
// serialize the clone back to an HTML string — byte-for-byte the same app
// shell, new document inside. TiddlyWiki pioneered this trick.

import type { KernelDoc } from './doc.ts'
import { appConfig } from './app.ts'
import { findDocBlock, renameDocBlock, LEGACY_ENC_FORMAT, LEGACY_FILE_SUFFIX, openLegacyDb, readLegacy } from './legacy.ts'

const DATA_BLOCK_ID = 'tessera-doc'
const DATA_BLOCK_TYPE = 'application/tessera+json'
// Split so the literal never appears in the bundle (it would terminate the
// inline <script> that carries this very code inside a built deck file).
const SCRIPT_CLOSE = '</scr' + 'ipt>'

let pristine: Document | null = null

/** Call first thing at boot, before any DOM mutation. */
export function capturePristine() {
  pristine = document.cloneNode(true) as Document
  // The copy is a SHELL: every save swaps the data block anyway, so it need
  // not hold a second copy of a multi-megabyte document for the whole session.
  // A file saved before the rename carries the block under its old name; the
  // shell copy takes the new one, so every save writes the new name.
  const block = findDocBlock(pristine)
  if (block) { renameDocBlock(block); block.textContent = '' }
  template = null
}

export function readEmbeddedDoc(): string | null {
  const block = findDocBlock(document)
  const text = block?.textContent?.trim()
  return text || null
}

/**
 * Extra plaintext blocks the app wants written into every saved shell —
 * language packs today (docs/i18n-packs.md), whatever else later. The kernel
 * stays ignorant of what they mean: it is told an id, a type and a JSON body,
 * and guarantees only that they survive a save the same way #tessera-doc does.
 *
 * The full set is re-declared on every serialize, so dropping one from the
 * list removes it from the next saved file — that is how "remove from this
 * file" works without a second API.
 */
export interface ShellBlock {
  id: string
  type: string
  /** JSON text; `<` is escaped on write exactly as the doc block's is */
  body: string
  attrs?: Record<string, string>
}
let shellBlocks: () => ShellBlock[] = () => []
let managedTypes: string[] = []

/**
 * Register the provider consulted on every serialize, and the block types it
 * OWNS. Call once, at boot.
 *
 * The types are declared rather than inferred from what the provider returns,
 * because the empty list is meaningful: "this file should carry no language
 * pack" has to clear the blocks the file arrived with, and a set derived from
 * the blocks about to be written would be empty exactly then — leaving the
 * last removed pack in the file (it would come back on the next open).
 */
export function registerShellBlocks(fn: () => ShellBlock[], types: string[]): void {
  shellBlocks = fn
  managedTypes = types
}

/** Every extra block currently in THIS document (as loaded from disk). */
export function readShellBlocks(type: string): Array<{ id: string; body: string; el: Element }> {
  return Array.from(document.querySelectorAll(`script[type="${type}"]`)).map((el) => ({
    id: el.id,
    body: (el.textContent ?? '').trim(),
    el,
  }))
}

/** Serialize a raw data-block body into an app shell. */
function serializeBody(shell: Document, body: string, title: string): string {
  const clone = shell.cloneNode(true) as Document

  // Re-declare the app's extra blocks: drop every one of a managed type, then
  // write the current set back. Removing a language from the file is therefore
  // just "stop listing it" — no deletion path to get wrong. The clear-set is
  // the DECLARED types, never the types about to be written: an empty write
  // set still has to clear (that is what removing the file's last pack looks
  // like).
  const wanted = shellBlocks()
  for (const type of new Set([...managedTypes, ...wanted.map((b) => b.type)])) {
    for (const stale of Array.from(clone.querySelectorAll(`script[type="${type}"]`))) stale.remove()
  }
  for (const b of wanted) {
    const el = clone.createElement('script')
    el.setAttribute('type', b.type)
    el.id = b.id
    for (const [k, v] of Object.entries(b.attrs ?? {})) el.setAttribute(k, v)
    // same <-escape as the doc block: these can never contain "</script>"
    el.textContent = '\n' + b.body.replace(/</g, '\\u003c') + '\n'
    clone.head.appendChild(el)
  }

  let block = findDocBlock(clone)
  if (block) renameDocBlock(block)
  else {
    block = clone.createElement('script')
    block.setAttribute('type', DATA_BLOCK_TYPE)
    block.id = DATA_BLOCK_ID
    clone.head.appendChild(block)
  }
  // <-escape so the JSON can never contain "</script>" and break the file.
  block.textContent = '\n' + body.replace(/</g, '\\u003c') + '\n'

  const titleEl = clone.querySelector('title')
  if (titleEl) titleEl.textContent = title + ' — ' + appConfig().appName

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  // Belt-and-braces: an unescaped close tag anywhere in generated output would
  // corrupt the file; this should never trigger given the escaping above.
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('tessera: unexpected script-close count in serialized file')
  }
  return html
}

// --- the fast path: the shell split once, the file built by concatenation ----
//
// serializeBody clones a Document and re-serializes it with outerHTML on every
// save. For a 14 MB deck that was a ~370 ms main-thread task per autosave (the
// clone still held the boot-time document text). The shell never changes
// during a session, so it is serialized ONCE, with sentinels where the title,
// the app's extra blocks and the document go; a save is then string pieces
// around one escaped JSON. The output is byte-identical to serializeBody's
// (checked against it in the save-path test, 2026-10-22).

interface ShellTemplate { parts: string[]; slots: Array<'title' | 'blocks' | 'doc'> }
let template: ShellTemplate | null = null

function buildTemplate(shell: Document): ShellTemplate {
  const clone = shell.cloneNode(true) as Document
  const tag = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const S = { title: `tessera-slot-title-${tag}`, blocks: `tessera-slot-blocks-${tag}`, doc: `tessera-slot-doc-${tag}` }
  // Same order of operations as serializeBody: managed blocks cleared, the
  // re-declared ones appended to <head>, then the document block (created at
  // the end of <head> if the shell has none), then the title.
  const declared = new Set([...managedTypes, ...shellBlocks().map((b) => b.type)])
  for (const type of declared) {
    for (const stale of Array.from(clone.querySelectorAll(`script[type="${type}"]`))) stale.remove()
  }
  clone.head.appendChild(clone.createTextNode(S.blocks))
  let block = findDocBlock(clone)
  if (block) renameDocBlock(block)
  else {
    block = clone.createElement('script')
    block.setAttribute('type', DATA_BLOCK_TYPE)
    block.id = DATA_BLOCK_ID
    clone.head.appendChild(block)
  }
  block.textContent = S.doc
  const titleEl = clone.querySelector('title')
  if (titleEl) titleEl.textContent = S.title
  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  const parts: string[] = []
  const slots: ShellTemplate['slots'] = []
  const re = new RegExp(`${S.title}|${S.blocks}|${S.doc}`, 'g')
  let at = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    parts.push(html.slice(at, m.index))
    slots.push(m[0] === S.title ? 'title' : m[0] === S.blocks ? 'blocks' : 'doc')
    at = m.index + m[0].length
  }
  parts.push(html.slice(at))
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('tessera: unexpected script-close count in the shell')
  }
  return { parts, slots }
}

/** Text as outerHTML writes it inside <title> (an escapable raw-text parent
 *  is not special: & < > and no-break space are escaped). */
const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Every `<` becomes the six characters backslash-u-0-0-3-c, so the JSON can
 *  never contain a script-close tag. */
export const escapeDocBody = (body: string) =>
  body.indexOf('<') < 0 ? body : body.split('<').join('\\u003c')

function blocksHtml(shell: Document): string {
  let out = ''
  for (const b of shellBlocks()) {
    const el = shell.createElement('script')
    el.setAttribute('type', b.type)
    el.id = b.id
    for (const [k, v] of Object.entries(b.attrs ?? {})) el.setAttribute(k, v)
    el.textContent = '\n' + b.body.replace(/</g, '\\u003c') + '\n'
    out += el.outerHTML
  }
  return out
}

/**
 * The file for an already-serialized data-block body, as PIECES (join them,
 * or hand them to a Blob, which never builds the 14 MB string at all). The
 * body is the doc JSON or an encryption envelope; it is escaped here.
 */
export function serializeBodyParts(body: string, title: string): string[] {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  if (!template) template = buildTemplate(pristine)
  const out: string[] = [template.parts[0]]
  template.slots.forEach((slot, i) => {
    out.push(slot === 'doc'
      ? '\n' + escapeDocBody(body) + '\n'
      : slot === 'title' ? escapeText(title + ' — ' + appConfig().appName) : blocksHtml(pristine!))
    out.push(template!.parts[i + 1])
  })
  return out
}

/**
 * Encryption-aware pieces of the file for a document already stringified
 * (`json` = JSON.stringify(doc)): the one stringify of a save is shared with
 * the recovery snapshot and whatever else needs it.
 */
export async function serializeJsonParts(json: string, title: string): Promise<string[]> {
  return serializeBodyParts(encPassword ? await encryptBody(json, encPassword) : json, title)
}

/** The pre-2026-10-22 path (clone the boot-time shell, outerHTML) for the
 *  same document: the reference the fast path is checked against. */
export function serializeFileSlow(doc: KernelDoc): string {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeBody(pristine, JSON.stringify(doc), doc.title)
}

/**
 * Serialize `doc` into an arbitrary app shell (a parsed deck HTML document).
 * Used with the boot-time pristine copy on every save, and by the self-update
 * flow with a freshly fetched NEWER shell — same document, new app around it.
 * PLAIN output — encryption-aware callers use serializeDocInto/serializeAuto.
 */
export function serializeWith(shell: Document, doc: KernelDoc): string {
  return serializeBody(shell, JSON.stringify(doc), doc.title)
}

/** The full deck file content with `doc` embedded (plain). */
export function serializeFile(doc: KernelDoc): string {
  return serializeBodyParts(JSON.stringify(doc), doc.title).join('')
}

// --- password encryption ----------------------------------------------------
//
// An encrypted file keeps the SAME plaintext #tessera-doc block (the splice
// contract) — but the block holds a tessera/enc envelope (files saved before
// the rename: the legacy format name, read the same way)
// instead of the document: AES-GCM-256 over the doc JSON, key derived from
// the password with PBKDF2-SHA-256. The password is held in memory for the
// session so ⌘S and self-update keep writing encrypted output.

export interface EncEnvelope {
  format: typeof ENC_FORMAT | typeof LEGACY_ENC_FORMAT
  v: 1
  it: number
  salt: string
  iv: string
  data: string
}

const ENC_ITERATIONS = 300_000
const ENC_FORMAT = 'tessera/enc'

const eb64 = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  dec(s: string): Uint8Array {
    const b = atob(s)
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

let encPassword: string | null = null

/** Set (or clear with null) the password used for every subsequent save. */
export function setEncryptionPassword(p: string | null) {
  encPassword = p
}

export const isEncryptionActive = () => encPassword !== null

/** Parse a data-block body as an encryption envelope; null if it is not one. */
export function parseEnvelope(text: string): EncEnvelope | null {
  try {
    const env = JSON.parse(text)
    if (env && (env.format === ENC_FORMAT || env.format === LEGACY_ENC_FORMAT) && env.v === 1 && env.data && env.salt && env.iv) {
      return env as EncEnvelope
    }
  } catch {
    /* not an envelope */
  }
  return null
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptBody(json: string, password: string): Promise<string> {
  const salt = new Uint8Array(16)
  const iv = new Uint8Array(12)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)
  const key = await deriveKey(password, salt, ENC_ITERATIONS)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(json))
  const env: EncEnvelope = {
    format: ENC_FORMAT, v: 1, it: ENC_ITERATIONS,
    salt: eb64.enc(salt), iv: eb64.enc(iv), data: eb64.enc(new Uint8Array(ct)),
  }
  return JSON.stringify(env)
}

/** Decrypt an envelope with a candidate password; null on wrong password. */
export async function decryptEnvelope(env: EncEnvelope, password: string): Promise<string | null> {
  try {
    const key = await deriveKey(password, eb64.dec(env.salt), env.it || ENC_ITERATIONS)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: eb64.dec(env.iv) as BufferSource }, key, eb64.dec(env.data) as BufferSource)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/**
 * Encryption-aware serialization into an arbitrary shell — THE path for
 * saves and self-updates. Plain when no password is active.
 */
export async function serializeDocInto(shell: Document, doc: KernelDoc): Promise<string> {
  const body = encPassword
    ? await encryptBody(JSON.stringify(doc), encPassword)
    : JSON.stringify(doc)
  return serializeBody(shell, body, doc.title)
}

/** Encryption-aware serializeFile. */
export async function serializeAuto(doc: KernelDoc): Promise<string> {
  return (await serializeJsonParts(JSON.stringify(doc), doc.title)).join('')
}

export function suggestedFileName(doc: KernelDoc, suffix = ''): string {
  const base = doc.title.replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '') || 'Untitled'
  return `${base}${suffix ? `-${suffix}` : ''}.html`
}

// --- writing to disk --------------------------------------------------------

type SaveResult = 'saved' | 'saved-as' | 'downloaded' | 'cancelled'

interface FsFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  name: string
  // Present in every shipping implementation, optional here because the spec
  // moved them around (they were `FileSystemHandle.queryPermission` before
  // landing in the permissions section) and a handle from an older engine may
  // not have them. Absent = assume granted and let the write speak for itself.
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  getFile?(): Promise<File>
}

let fileHandle: FsFileHandle | null = null

const hasFsAccess = () => typeof (window as any).showSaveFilePicker === 'function'

// --- remembering the handle across opens --------------------------------------
//
// A deck double-clicked from disk arrives with NO handle: the File System
// Access API gives a page no way to reach the file it was loaded from. So the
// first ⌘S of every session showed a Save As picker — and, worse, Chrome
// truncates the picked file to zero bytes the instant it is chosen, while the
// deck is still being serialized. That is the "one blank save, then the real
// one" everyone saw.
//
// A FileSystemFileHandle is structured-cloneable, so the handle picked once is
// kept in IndexedDB under the deck's docId. On the next open it is recalled
// and, IF it is provably the very file this page was loaded from, adopted:
// ⌘S then rewrites in place through createWritable() — which writes a swap
// file and renames it over the original on close, so the file on disk is
// never empty, not even for a millisecond.
//
// "Provably the same file" is the whole safety of this. docId is NOT enough:
// it is never regenerated, so `deck_v2.html` copied to `deck_v3.html` shares
// one, and writing v3's edits into v2 would be silent data loss. The recalled
// handle must match the open file on
//   · name  — the page's own URL says what it was opened as, and
//   · mtime — `document.lastModified` on a file:// page IS the file's
//             modification time; a copy elsewhere, or a file rewritten by a
//             build script since this tab loaded, disagrees by seconds.
// Anything less than both, or a page that is not file://, gets the picker.

const HANDLE_DB = 'tessera-file-handles'
const HANDLE_STORE = 'handles'

interface StoredHandle { docId: string; handle: FsFileHandle; name: string; at: number }

let handleDb: Promise<IDBDatabase | null> | null = null

function openHandleDb(): Promise<IDBDatabase | null> {
  if (handleDb) return handleDb
  handleDb = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(HANDLE_DB, 1) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE, { keyPath: 'docId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return handleDb
}

function handleTx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openHandleDb().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      let t: IDBTransaction
      try { t = db.transaction(HANDLE_STORE, mode) } catch { resolve(null); return }
      let req: IDBRequest<T>
      try { req = fn(t.objectStore(HANDLE_STORE)) } catch { resolve(null); return }
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(null)
    })
  })
}

/** Best effort — a handle that cannot be stored just means a picker next time. */
function rememberHandle(doc: KernelDoc, handle: FsFileHandle): Promise<unknown> {
  return handleTx('readwrite', (s) =>
    s.put({ docId: doc.docId, handle, name: handle.name, at: Date.now() } as StoredHandle))
    .then((k) => console.info(k == null
      ? `tessera: could not remember "${handle.name}" for next time (IndexedDB unavailable)`
      : `tessera: remembered "${handle.name}" — reopen this file and ⌘S saves to it directly`))
}

async function storedHandle(doc: KernelDoc): Promise<StoredHandle | null> {
  const r = await handleTx<StoredHandle>('readonly', (s) => s.get(doc.docId))
  if (r?.handle) return r
  // A handle an older shell remembered for this deck (its own database).
  const [old] = await readLegacy<StoredHandle>(await openLegacyDb(HANDLE_DB), HANDLE_STORE, doc.docId)
  if (!old?.handle) return null
  void handleTx('readwrite', (s) => s.put(old))
  return old
}


const isFileUrl = () => { try { return location.protocol === 'file:' } catch { return false } }

/** The open file's mtime in ms, or NaN when the page cannot know it. */
function openedFileMtime(): number {
  if (!isFileUrl()) return NaN
  const t = Date.parse(document.lastModified)
  // 01/01/1970 is what a browser reports when it has no idea
  return t > 0 ? t : NaN
}

/**
 * The handle remembered for this deck, if it is demonstrably the file this
 * page was opened from and we are allowed to write it. `prompt` may spend
 * user activation on a permission dialog (⌘S); the boot-time call passes
 * false and only succeeds when Chrome remembered the grant across visits.
 */
async function recallHandle(doc: KernelDoc, prompt: boolean): Promise<FsFileHandle | null> {
  // Every refusal says why on the console: this decides whether ⌘S shows a
  // dialog, and "it asked again" is undiagnosable without the reason.
  const no = (why: string) => {
    console.info(`tessera: not reusing the remembered file — ${why}`)
    return null
  }
  if (!isFileUrl()) return no('the page is not a file:// URL')
  const name = openedFileName()
  const mtime = openedFileMtime()
  if (!name) return no('cannot tell the open file\'s name from the URL')
  if (Number.isNaN(mtime)) return no(`document.lastModified is unusable (${document.lastModified})`)
  const stored = await storedHandle(doc)
  if (!stored) return no(`nothing remembered for docId ${doc.docId}`)
  if (stored.handle.name !== name) return no(`remembered "${stored.handle.name}", open file is "${name}"`)
  const h = stored.handle
  if (typeof h.getFile !== 'function') return no('the remembered handle cannot be read')
  if (!(await ensureWritable(h, prompt))) {
    return no(prompt ? 'write permission was not granted' : 'write permission needs a prompt (waits for ⌘S)')
  }
  try {
    const file = await h.getFile()
    // document.lastModified has one-second precision
    if (Math.abs(file.lastModified - mtime) > 1500) {
      return no(`the remembered "${name}" is not the one this tab loaded — a copy in another folder, or rewritten since (remembered ${new Date(file.lastModified).toISOString()}, this tab ${new Date(mtime).toISOString()}). Save into the open file's own folder once and it is remembered instead`)
    }
  } catch (err) {
    return no(`reading the remembered file failed (${(err as Error)?.name ?? err})`)
  }
  console.info(`tessera: reusing the remembered file "${name}"`)
  return h
}

/**
 * Adopt the remembered handle at boot when Chrome kept its write grant
 * ("allow on every visit"), so the silent autosave write-back works from the
 * first edit instead of from the first ⌘S. Silent: no prompt, no picker.
 */
export function adoptStoredHandle(doc: KernelDoc): Promise<boolean> {
  return serialized(async () => {
    if (fileHandle || !hasFsAccess()) return fileHandle !== null
    const h = await recallHandle(doc, false)
    if (h) fileHandle = h
    return h !== null
  })
}

/**
 * Can this browser rewrite the open file, or only hand back copies?
 *
 * The File System Access API is Chrome/Edge only: Safari and Firefox lack it,
 * and so does EVERY browser on iOS, because they are all WebKit underneath.
 * Without it there is no writable handle, which costs three things — in-place
 * save, silent autosave write-back, and in-place self-update.
 *
 * Exported because the UI must not promise what the browser cannot do. "⌘S
 * rewrites this file in place" is the product's central claim and it is simply
 * false here; saying it anyway and retracting it in a toast after the first
 * save is worse than saying the true thing up front.
 */
export const canWriteInPlace = () => hasFsAccess()

async function pickHandle(
  doc: KernelDoc, suffix = '', suggestedName?: string,
): Promise<FsFileHandle | null> {
  // A plain ⌘S offers the name the file is open AS, so the picker is one
  // Enter away from overwriting it; an export (suffix) is named off the title.
  const name = suggestedName ?? (suffix ? null : openedFileName()) ?? suggestedFileName(doc, suffix)
  // startIn takes a HANDLE, never a path — the API gives no way to point a
  // picker at an arbitrary directory, by design. The held handle lands us in
  // the open file's own folder. Without one, `id` is all there is: the browser
  // remembers the last directory used under it, SHARED by every deck, so a
  // deck saved for the first time starts where the previous deck went (the
  // decks all live under one slides/ tree) rather than in Documents. A
  // per-deck id was tried and put every first save in Documents — where a
  // confirmed Enter creates a stray copy that the same-file check then keeps
  // refusing. Nor is the remembered handle used here: when it failed that
  // check it may well BE the stray copy, and pointing the picker at it is
  // how the copy gets overwritten a second time.
  try {
    return await (window as any).showSaveFilePicker({
      suggestedName: name,
      ...(fileHandle ? { startIn: fileHandle } : {}),
      id: 'tessera-doc',
      types: [{ description: appConfig().appName, accept: { 'text/html': ['.html'] } }],
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    throw err
  }
}

async function writeHandle(handle: FsFileHandle, html: string | string[]) {
  const writable = await handle.createWritable()
  await writable.write(new Blob(typeof html === 'string' ? [html] : html, { type: 'text/html' }))
  await writable.close()
}

/**
 * "The browser refused the write" — as opposed to a bug, a full disk, or a
 * file that vanished. Every one of these means the same thing to us: we can
 * still hand the user their bytes, just not through this handle.
 */
const isDenied = (err: unknown): boolean => {
  const name = (err as { name?: string } | null)?.name
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/**
 * Confirm we may still write `h`, re-prompting if allowed to.
 *
 * A handle's readwrite grant is not permanent: it lapses when the tab is
 * reloaded or restored, and Chrome can drop it on its own. Without this check
 * every write after that point throws NotAllowedError — including the silent
 * autosave write-back, which then fails forever with nothing to click.
 *
 * `prompt` re-asks the user. It needs transient user activation, so it is only
 * ever true on a path reached straight from a gesture (⌘S). The autosave timer
 * passes false: an unprompted request would be rejected anyway, and a
 * permission dialog appearing 2.5 seconds after someone typed would be worse
 * than the write quietly not happening.
 */
async function ensureWritable(h: FsFileHandle, prompt: boolean): Promise<boolean> {
  if (typeof h.queryPermission !== 'function') return true
  try {
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true
    if (!prompt || typeof h.requestPermission !== 'function') return false
    return await h.requestPermission({ mode: 'readwrite' }) === 'granted'
  } catch {
    return false
  }
}

export function downloadFile(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// --- concurrency: at most one write in flight at a time -----------------------
//
// Nothing upstream debounces a save. A keyboard shortcut and a click can land
// together; a slow save can still be sitting at its native picker — which
// stays open for as long as a person takes to type a filename — when the same
// shortcut is pressed again out of impatience. Every function below either
// shows that picker or writes through `fileHandle`, and two of them running
// at once is exactly how a save silently loses data:
//
//   1. Two overlapping calls each read the not-yet-set `fileHandle` before
//      either had finished picking one, so BOTH opened their own native
//      "Save As" dialog — two competing writable streams to two different
//      files (confirmed by instrumenting the real save path: a second trigger
//      fired while the first dialog was still open produced a second,
//      independent showSaveFilePicker() call).
//   2. A writable stream's target is created/truncated the moment writing
//      starts and only filled in on close. Whichever of the two streams never
//      finished was left on disk as a genuinely empty file — not missing,
//      *empty* — which is what silently overwrites-with-nothing looks like.
//
// A simple queue removes the race instead of chasing its symptom: every write
// here waits its turn, so at most one picker or write is ever in flight. A
// call that lands mid-save no longer opens a second dialog — it runs after
// the first finishes, by which point `fileHandle` is already set, so it
// becomes a silent, harmless rewrite through the same handle rather than a
// second competing one.
let queue: Promise<unknown> = Promise.resolve()

/** Run `fn` after every write already queued, even if one of them failed —
 *  one rejected save must not wedge every save after it. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Save the document. Chrome/Edge: File System Access API (picker on first
 * save, silent rewrite after). Firefox/Safari: download a copy.
 *
 * ORDER IS LOAD-BEARING: everything that needs transient user activation — the
 * save picker, a permission re-prompt — happens FIRST, before the document is
 * serialized. Activation expires a few seconds after the keypress, and
 * serializing a large deck is not fast: cloning a multi-megabyte DOM,
 * stringifying a document with embedded fonts and images, escaping it and
 * re-serializing outerHTML can take longer than the window. Doing it the other
 * way round works on a small deck and throws NotAllowedError on a real one,
 * which is exactly the sort of bug that only shows up on the file that matters.
 *
 * And it never dead-ends: if the handle path is refused anyway, the bytes go
 * to Downloads rather than back to the caller as an exception.
 */
export function saveFile(doc: KernelDoc, forcePicker = false): Promise<SaveResult> {
  // A save that arrives while one is still at its dialog JOINS it rather than
  // queueing behind it. Queued, it would run the moment the first one ended —
  // and if that one was cancelled, failed, or fell back to a download, there is
  // no handle yet and a SECOND dialog pops up right after the first. The
  // document is live, so the in-flight save already writes the latest state.
  if (pendingSave && !forcePicker) {
    console.info('tessera: save requested while one is in progress — joining it')
    return pendingSave
  }
  const run = serialized(async () => {
    console.info(`tessera: save (${forcePicker ? 'save as' : fileHandle ? 'through the held handle' : 'no handle yet'})`)
    try {
      const r = await saveFileNow(doc, forcePicker)
      console.info(`tessera: save → ${r}${fileHandle ? ` ("${fileHandle.name}")` : ''}`)
      return r
    } catch (err) {
      console.info('tessera: save → failed', err)
      throw err
    }
  })
  if (!forcePicker) {
    pendingSave = run
    run.then(() => { pendingSave = null }, () => { pendingSave = null })
  }
  return run
}
let pendingSave: Promise<SaveResult> | null = null

async function saveFileNow(doc: KernelDoc, forcePicker: boolean): Promise<SaveResult> {
  if (!hasFsAccess()) {
    downloadFile(await serializeAuto(doc), suggestedFileName(doc))
    return 'downloaded'
  }

  // No handle yet (the deck was double-clicked open): the one remembered from
  // last time, if it is this very file. This is the path that turns "Save As
  // every session" into a plain in-place save.
  const held = fileHandle ?? (forcePicker ? null : await recallHandle(doc, true))

  // Kick off whatever needs user activation FIRST (see saveFile) — and then
  // serialize WHILE the native dialog is up rather than after it closes.
  // Chrome truncates a picked file the moment the user confirms, so every
  // millisecond of serialization after that point is a zero-byte file on disk;
  // done during the dialog, the bytes are ready before the file is touched.
  const picking: Promise<FsFileHandle | null> = forcePicker || !held
    ? pickHandle(doc)
    : ensureWritable(held, true).then((ok) =>
      // The grant lapsed and re-prompting was refused or unavailable. Ask
      // where to put the file instead of failing — the user asked to save.
      ok ? held : pickHandle(doc))
  const building = serializeAuto(doc)
  building.catch(() => undefined) // reported below, where it is awaited

  let handle: FsFileHandle | null
  try {
    handle = await picking
  } catch (err) {
    if (!isDenied(err)) throw err
    downloadFile(await building, suggestedFileName(doc))
    return 'downloaded'
  }
  if (!handle) return 'cancelled'

  const fresh = handle !== fileHandle
  const html = await building
  try {
    await writeHandle(handle, html)
  } catch (err) {
    if (!isDenied(err)) throw err
    downloadFile(html, suggestedFileName(doc))
    return 'downloaded'
  }
  fileHandle = handle
  void rememberHandle(doc, handle)
  return fresh ? 'saved-as' : 'saved'
}

export const currentFileName = () => fileHandle?.name ?? null

/**
 * The name of the file this document is actually open AS, when knowable.
 *
 * Two sources, best first: a held FS Access handle, else this document's own
 * URL. The URL case is the one that matters — a deck double-clicked
 * from disk grants no handle, which is exactly when a save picker appears with
 * nothing useful in it.
 *
 * Any `.html` opened from disk counts; on a served page only the double
 * suffix older saves suggested does.
 * That deliberately excludes the hosted demo (`/slides/`, `index.html`), so
 * the anonymous try-it deck still names itself after its title, not "index".
 */
export function openedFileName(): string | null {
  if (fileHandle?.name) return fileHandle.name
  try {
    const base = decodeURIComponent(new URL(location.href).pathname.split('/').pop() ?? '')
    if (LEGACY_FILE_SUFFIX.test(base)) return base
    return isFileUrl() && /\.html?$/i.test(base) ? base : null
  } catch {
    return null
  }
}

// --- self-update writing ----------------------------------------------------

/** Whether we hold a writable handle to the file (in-place update possible). */
export const hasFileHandle = () => fileHandle !== null

/**
 * Overwrite the held file with arbitrary html (the freshly updated shell).
 *
 * Throws — including when the write permission has lapsed, which is checked
 * WITHOUT prompting (this runs from the autosave timer, with no user
 * activation to spend). Callers treat a throw as "the file on disk is stale"
 * and fall back to whatever backstop they have.
 */
export function writeUpdatedFile(html: string | string[]): Promise<void> {
  // Same queue as saveFile/writeUpdatedFileAs: this also calls createWritable()
  // on `fileHandle`, and that call itself truncates the file again even when
  // no picker is involved — so it must not overlap a manual save writing
  // through the very same handle.
  return serialized(async () => {
    if (!fileHandle) throw new Error('no file handle')
    if (!(await ensureWritable(fileHandle, false))) throw new Error('write permission lapsed')
    await writeHandle(fileHandle, html)
  })
}

/**
 * Save updated html via a picker (user points it at the file they have open,
 * or anywhere else). Returns false if cancelled. Keeps the picked handle so
 * subsequent ⌘S saves go to the same place.
 *
 * `html` may be a THUNK, and callers with a large document should pass one:
 * the picker then opens before serialization instead of after it, which is the
 * difference between a save that works and a NotAllowedError on a deck with
 * embedded fonts (see saveFile). A plain string stays fine for callers that
 * already have the bytes — the self-updater has been through a network fetch
 * by then, so its activation is long gone either way, and it lands on the
 * download fallback below.
 */
export function writeUpdatedFileAs(
  html: string | (() => Promise<string>),
  doc: KernelDoc,
  opts: { suffix?: string; keepHandle?: boolean; suggestedName?: string } = {},
): Promise<boolean> {
  // Queued with saveFile: this is the export path (view-only, present-only,
  // invite, template, self-update) and it shows the same native picker — two
  // of these fired close together are the same "competing dialogs, one file
  // left empty" race as two overlapping manual saves.
  return serialized(() => writeUpdatedFileAsNow(html, doc, opts))
}

async function writeUpdatedFileAsNow(
  html: string | (() => Promise<string>),
  doc: KernelDoc,
  opts: { suffix?: string; keepHandle?: boolean; suggestedName?: string },
): Promise<boolean> {
  const build = () => (typeof html === 'function' ? html() : Promise.resolve(html))
  const name = opts.suggestedName ?? suggestedFileName(doc, opts.suffix)
  if (!hasFsAccess()) {
    downloadFile(await build(), name)
    return true
  }
  // Picker first, build while it is open — same reasoning as saveFileNow.
  const picking = pickHandle(doc, opts.suffix, opts.suggestedName)
  const building = build()
  building.catch(() => undefined)
  let handle: FsFileHandle | null
  try {
    handle = await picking
  } catch (err) {
    if (!isDenied(err)) throw err
    downloadFile(await building, name)
    return true
  }
  if (!handle) return false
  const out = await building
  try {
    await writeHandle(handle, out)
  } catch (err) {
    if (!isDenied(err)) throw err
    downloadFile(out, name)
    return true
  }
  // Share/export artifacts must NOT become the ⌘S target — otherwise the next
  // save would overwrite e.g. a view-only copy with the FULL document (owner
  // keys included). Only an explicit keepHandle retargets in-place saving.
  if (opts.keepHandle) {
    fileHandle = handle
    void rememberHandle(doc, handle)
  }
  return true
}
