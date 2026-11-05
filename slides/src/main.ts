// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Boot sequence. Order matters: capture the pristine document BEFORE any DOM
// mutation — the captured copy is what gets re-serialized on save.

// FIRST: carries what older shells kept in this browser over to the new names
// before any module reads it, and maps the old global names (legacy.ts).
import { exposeApi } from './legacy'
import './styles.css'
// The poll service's read guard and live link (see the file): the presenter's
// poll widget reads through it, so a slide left open costs nothing between answers.
import './live-shim.js'
import { anim } from './anim'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile,
  parseEnvelope, decryptEnvelope, setEncryptionPassword,
} from './save'
import { i18nApi, t, applyDirection } from './i18n'
import { parseDoc, setDeckPollHost, uid, type TesseraDoc } from './model'
import { findRequest, listRequests, pendingRequests, type RequestStatus } from './requests'
import { starterDoc } from './starterdeck'
import { injectFonts } from './fonts'
import { Store } from './store'
import { Editor } from './editor/editor'
import { frozenDoc } from './editor/export-frozen'
import { startPresentation } from './present'
import { SyncSession } from './sync/session'
import { connectAgentBridge } from './agent-bridge'
import { watchDevFigures } from './dev-figures'
import { watchIdentity } from './identity-watch'

// Tell the kernel who this app is — must precede any kernel module use
// (window title suffix, save-picker label).
configureApp({ appName: 'Tessera' })

capturePristine()

// Chrome direction follows the VIEWER's language (Arabic/Hebrew/… get an RTL
// interface). Deliberately AFTER capturePristine: saves re-serialize the
// pristine clone, so the dir/lang attributes never reach a saved file — the
// same viewer-scoped rule as 'tessera-lang' and reduced motion. The DOCUMENT
// never mirrors; styles.css pins every slide surface back to direction: ltr.
applyDirection()

// --- boot gates: password-encrypted files, read-only player files -----------

const embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null
if (envelope) {
  void passwordGate()
} else {
  bootWith((embedded && parseDoc(embedded)) || starterDoc())
}

/** Encrypted file: ask for the password (looping on failure), then boot. */
async function passwordGate() {
  const gate = document.createElement('div')
  gate.className = 'ed-pwgate'
  gate.innerHTML =
    `<div class="ed-pwcard"><div class="ed-pwmark">🔒</div>` +
    `<h1>${t('This file is encrypted.')}</h1>` +
    `<p>${t('Enter password to open this deck')}</p>` +
    `<input type="password" autocomplete="current-password">` +
    `<button>${t('Unlock')}</button><div class="ed-pwerr"></div></div>`
  document.body.appendChild(gate)
  document.getElementById('tessera-splash')?.remove()
  const input = gate.querySelector('input')!
  const button = gate.querySelector('button')!
  const err = gate.querySelector<HTMLElement>('.ed-pwerr')!
  const tryUnlock = async () => {
    const pass = input.value
    if (!pass) return
    button.setAttribute('disabled', '')
    const json = await decryptEnvelope(envelope!, pass)
    button.removeAttribute('disabled')
    if (json === null) {
      err.textContent = t('Wrong password — try again')
      input.select()
      return
    }
    const doc = parseDoc(json)
    if (!doc) {
      err.textContent = t('Wrong password — try again')
      return
    }
    setEncryptionPassword(pass) // saves + updates keep writing encrypted
    gate.remove()
    bootWith(doc)
  }
  button.addEventListener('click', () => void tryUnlock())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void tryUnlock()
  })
  input.focus()
}

function bootWith(doc: TesseraDoc) {
  // The deck's own poll deployment, before anything can render a poll (the
  // join URL and QR on a static slide read it too).
  setDeckPollHost(doc.poll?.service)
  if (doc.readonly) playerMode(doc)
  else editorMode(doc)
}

/**
 * Read-only files are PLAYER files: they open straight into the show and
 * never expose the editor. Leaving the presentation (Esc, leaving fullscreen)
 * does not end it: the show comes back on the slide it was on, filling the
 * tab, and F takes it fullscreen again. There is no landing card and no
 * "Save a copy" button, so a hosted deck never restarts or offers a download.
 */
function playerMode(doc: TesseraDoc) {
  document.title = `${doc.title} — ${appConfig().appName}`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('tessera-splash')?.remove()
  const start = (at: number, fullscreen: boolean) => {
    startPresentation(doc, at, (last) => {
      setTimeout(() => start(last, false), 0)
    }, { fullscreen })
  }
  exposeApi({ format: doc.format, doc, readonly: true })
  start(0, true)
}

function editorMode(doc: TesseraDoc) {

document.title = `${doc.title} — ${appConfig().appName}`

// Embedded fonts: register @font-face rules from the asset table so text
// elements can use bundled families in the editor, presenter and thumbnails.
if (doc.fonts?.length) injectFonts(doc)

const store = new Store(doc)
const editor = new Editor(document.getElementById('app')!, store)

// Tab-to-tab sync: every open tab of this deck on this machine
// syncs over BroadcastChannel. There is no online relay.
const session = new SyncSession(store)
editor.connectSync(session)
// `embedded` is the file version this tab loaded: the base its saves name, so
// the bridge can refuse one that would overwrite a newer file.
const agentApi = connectAgentBridge(store, () => { injectFonts(store.doc); session.flush() }, () => editor.isPresenting, embedded)
// with no file handle, every change is written to the deck file through the bridge
editor.fileSaver = (parts, json) => agentApi.saveToFile(parts, json)
watchDevFigures(store, () => session.flush())
watchIdentity(store, (other) => editor.showIdentityClash(other))

// Opening a link ending in #present starts the show immediately (player mode).
if (location.hash === '#present') {
  editor.present(true)
}

// Dismiss the boot splash (inline in index.html so it paints before this
// bundle parses). Hold it briefly so the assemble animation reads as a
// brand moment instead of a flicker; the pristine capture ran before this,
// so saved files keep the splash for their own next boot.
{
  const splash = document.getElementById('tessera-splash')
  if (splash) {
    const wait = 0 // fork: no brand moment — the splash is only a loading bar
    setTimeout(() => {
      splash.classList.add('done')
      setTimeout(() => splash.remove(), 550)
    }, wait)
  }
}

// Small scripting surface for tooling and automation: read/replace the
// document model and serialize the full deck file. window.tessera.
exposeApi({
  agent: agentApi,
  format: doc.format,
  get doc() {
    return store.doc
  },
  serialize: () => {
    session.stampInto(store.doc)
    return serializeFile(store.doc)
  },
  undo: () => store.undo(),
  redo: () => store.redo(),
  get selection() {
    return store.selection.slice()
  },
  /** animation engine, exposed for scripting/diagnostics */
  anim,
  /** i18n: t/locale/setLocale/choices — setLocale('x-pseudo') audits the sweep */
  i18n: i18nApi,
  /** live-collaboration session: actor id, connected peers, force a diff-flush */
  sync: {
    get actor() {
      return session.actor
    },
    peers: () => session.peers(),
    flush: () => session.flush(),
    transports: () => session.transportKinds,
  },
  /**
   * AI/tooling round-trip: replace the whole document from a JSON string
   * (the contents of #tessera-doc). Validates via parseDoc; returns false and
   * changes nothing on invalid input. Undoable in the editor.
   */
  loadDoc(json: string): boolean {
    const next = parseDoc(json)
    if (!next) return false
    store.replaceDoc(next)
    return true
  },
  /** The frozen audience copy Export writes (polls read once and baked in,
   *  hidden/state slides and service-reading figures dropped), as a document. */
  frozenDoc: () => frozenDoc(store.doc),
  /**
   * Change requests typed in the slide list (a slide's, or the whole deck's:
   * slideIndex -1, stored in doc.requests). Any agent that
   * drives this page — or reads the saved file — treats the open ones as its
   * to-do list: list({ open: true }), act, then reply(id, text, 'done').
   * Same data as Slide.comments entries with `request: true`.
   */
  requests: {
    list: (opts: { open?: boolean } = {}) => listRequests(store.doc, opts),
    pending: () => pendingRequests(store.doc),
    reply(id: string, text: string, status: RequestStatus = 'done', agent = 'Agent'): boolean {
      if (!findRequest(store.doc, id)) return false
      store.commit(() => {
        const c = findRequest(store.doc, id)!.thread
        if (text) c.replies = [...(c.replies ?? []), { id: uid('rep'), author: agent, text, at: new Date().toISOString() }]
        c.status = status
        c.resolved = status === 'done' || undefined
      })
      return true
    },
    /** called after every document change; returns an unsubscribe */
    onChange: (fn: () => void) => store.on('doc', fn),
  },
  /**
   * Flat list of every review comment thread — the entry point for tooling
   * and AI agents processing the deck ("fix everything people flagged"):
   * each item carries the slide, a typed anchor (element / point / slide),
   * author, text, replies and resolved state.
   */
  comments() {
    return store.doc.slides.flatMap((s, slideIndex) =>
      (s.comments ?? []).map((c) => ({
        slideId: s.id,
        slideIndex,
        id: c.id,
        anchor: c.elementId
          ? { type: 'element' as const, elementId: c.elementId }
          : typeof c.x === 'number'
            ? { type: 'point' as const, x: c.x, y: c.y }
            : { type: 'slide' as const },
        author: c.author,
        at: c.at,
        text: c.text,
        replies: c.replies ?? [],
        resolved: !!c.resolved,
      })),
    )
  },
})

} // editorMode
