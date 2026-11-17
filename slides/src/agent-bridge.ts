import { AgentEditor } from './agent-editor'
import type { Store } from './store'
import { pendingRequests, signalIds } from './requests'
import { hasFileHandle, currentFileName } from './save'
import { foldDiskChanges, OtherDeckError } from './save-merge'

const BRIDGE = 'http://127.0.0.1:18765'

/** What a save through the bridge came to. `merged`: the file had changed on
 *  disk; its changes are now in the editor and the caller saves again. */
export type BridgeSave =
  | { status: 'saved' }
  | { status: 'merged'; applied: number; kept: string[] }
  | { status: 'busy' }
  | { status: 'refused'; message: string }
  | { status: 'failed' }

/** SHA-256 hex of the trimmed block text — the bridge's `version_token`. */
async function versionToken(text: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(text.replace(/\r\n?/g, '\n').trim())
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch { return null }
}

/** Optional localhost transport; no credentials or server dependency in the deck.
 *  `loaded` is the #tessera-doc text this tab booted from: the file version its
 *  first save is based on. */
export function connectAgentBridge(store: Store, flush: () => void, presenting: () => boolean, loaded: string | null = null) {
  const file = location.href.split('#')[0]
  const storageKey = `tessera-agent:${file}`
  let sessionId = crypto.randomUUID(), docId = store.doc.docId
  let pointer = false, composing = false, token = '', stopped = false, bridgeSaves = false
  // The bridge's save protocol (from its /tick replies): 2 = raw body + base
  // version; anything older takes the JSON form it has always taken.
  let saveVersion = 0
  // The file version this editor's document is built on: the block it loaded,
  // then whatever it last saved or folded in. `json` is that version's
  // document, the base a fold diffs against.
  let base: { token: Promise<string | null> | string | null; json: string | null } =
    { token: loaded ? versionToken(loaded) : null, json: loaded }
  // The "Ask the agent" field is not an edit of the document: typing the next
  // request must never hold up the agent working on the last one.
  // A show running in this tab does not hold edits back: it repaints the
  // slides they change (present.ts, live). Only goTo waits for the show.
  const busy = () => pointer || composing || (!!document.activeElement?.closest('input, textarea, select, [contenteditable="true"]') && !document.activeElement?.closest('.ed-agent-input')) || !!document.querySelector('dialog[open]')
  const agent = new AgentEditor(store, busy, flush)
  window.addEventListener('pointerdown', () => { pointer = true }, true)
  window.addEventListener('pointerup', () => { pointer = false }, true)
  window.addEventListener('pointercancel', () => { pointer = false }, true)
  window.addEventListener('blur', () => { pointer = false; composing = false })
  window.addEventListener('compositionstart', () => { composing = true }, true)
  window.addEventListener('compositionend', () => { composing = false }, true)
  /** Show a slide by id: a mirror on a phone follows the slide being edited
   *  elsewhere (the assistant's deck_preview). Never while presenting. */
  const goTo = (slideId: string): boolean => {
    const i = store.doc.slides.findIndex((x) => x.id === slideId)
    if (i < 0 || presenting()) return false
    store.goTo(i)
    return true
  }
  /** Write the editor's document into the deck file through the bridge (it
   *  replaces only the #tessera-doc block on disk). `parts` are the file's
   *  pieces, `json` the document they carry. */
  let saveToFile: (parts: string[], json: string) => Promise<BridgeSave> = async () => ({ status: 'failed' })
  const api = {
    version: 1, read: () => agent.read(), apply: agent.apply.bind(agent), goTo,
    get sessionId() { return sessionId },
    saveToFile: (parts: string[], json: string) => saveToFile(parts, json),
  }
  // Hosted/shared documents never discover or connect to the local service.
  if (location.protocol !== 'file:') return api
  // Auto-connect: the local bridge hands an open file:// deck its token on
  // request (/claim), so nothing is pasted. Clicking the button turns it off
  // for this file (remembered) and on again.
  const offKey = `tessera-agent-off:${file}`
  let off = false
  try { token = localStorage.getItem(storageKey) || ''; off = localStorage.getItem(offKey) === '1' } catch { /* optional */ }
  // The top bar's agent pill (editor.ts) paints this state; its menu sends
  // tessera-agent-toggle to turn the connection off for this file and on again.
  const status = (connected: boolean) => {
    window.dispatchEvent(new CustomEvent('tessera-agent-status', {
      detail: { off, connected, lastActivity: agent.lastActivity || '' },
    }))
  }
  window.addEventListener('tessera-agent-toggle', () => {
    off = !off
    try { off ? localStorage.setItem(offKey, '1') : localStorage.removeItem(offKey) } catch { /* session only */ }
    if (off) { disconnect(); setListening(false) }
    status(false)
  })
  let pending: { commandId: string; result: unknown } | null = null
  // whether an agent is listening for requests: told by the bridge on each tick
  let heard: boolean | null = null
  const setListening = (on: boolean) => {
    if (on === heard) return
    heard = on
    window.dispatchEvent(new CustomEvent('tessera-agent-listening', { detail: on }))
  }
  let misses = 0
  const disconnect = () => {
    token = ''; pending = null; sessionId = crypto.randomUUID()
    try { localStorage.removeItem(storageKey) } catch { /* optional */ }
    status(false)
  }
  saveToFile = async (parts: string[], json: string): Promise<BridgeSave> => {
    if (!token || off) return { status: 'failed' }
    const auth = { Authorization: `Bearer ${token}` }
    try {
      let r: Response
      if (saveVersion >= 2) {
        // The file itself as the body: no JSON wrapping of 15 MB on either
        // side, and the Blob takes the pieces without joining them first.
        const baseToken = (await base.token) ?? ''
        const q = new URLSearchParams({ file, docId: store.doc.docId, base: baseToken })
        r = await fetch(`${BRIDGE}/save?${q}`, {
          method: 'POST', headers: { 'Content-Type': 'text/html', ...auth },
          body: new Blob(parts, { type: 'text/html' }), signal: AbortSignal.timeout(30000),
        })
      } else {
        r = await fetch(`${BRIDGE}/save`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({ file, docId: store.doc.docId, html: parts.join('') }), signal: AbortSignal.timeout(30000),
        })
      }
      if (r.status === 409) {
        // The file changed since this editor's base: fold its changes in.
        const body = await r.json()
        if (typeof body.doc !== 'string' || typeof body.token !== 'string') return { status: 'failed' }
        if (!base.json) {
          // Nothing to diff against (a starter deck): the file's version is
          // the base from now on, and this tab's document wins as a whole.
          base = { token: body.token, json: body.doc }
          return { status: 'merged', applied: 0, kept: ['(whole document)'] }
        }
        if (agent.isBusy()) return { status: 'busy' }
        let fold
        try { fold = foldDiskChanges(store.doc, base.json, body.doc) } catch (error) {
          if (error instanceof OtherDeckError) return { status: 'refused', message: error.message }
          throw error
        }
        if (fold.applied) agent.commitDoc(fold.doc)
        base = { token: body.token, json: body.doc }
        return { status: 'merged', applied: fold.applied, kept: fold.kept }
      }
      if (r.status === 400) {
        const body = await r.json().catch(() => ({}))
        if (/another deck/.test(String(body.error))) return { status: 'refused', message: String(body.error) }
        return { status: 'failed' }
      }
      if (!r.ok) return { status: 'failed' }
      const body = await r.json().catch(() => ({}))
      if (typeof body.token === 'string') base = { token: body.token, json }
      bridgeSaves = true
      return { status: 'saved' }
    } catch { return { status: 'failed' } }
  }
  async function claim() {
    const response = await fetch(`${BRIDGE}/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }), signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) throw Error('claim refused')
    const body = await response.json()
    if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw Error('no token')
    token = body.token
    try { localStorage.setItem(storageKey, token) } catch { /* session only */ }
  }
  window.addEventListener('tessera-file-target-changed', disconnect)
  store.on('doc', () => {
    if (store.doc.docId !== docId) { docId = store.doc.docId; disconnect() }
  })
  async function tick() {
    if (stopped) return
    const name = currentFileName()
    // Saved under another name ("Save a copy…", "Duplicate as new deck…"): this
    // tab no longer IS the file its URL names. Stay disconnected — re-claiming
    // would hand an agent editing that file this other document instead.
    const moved = !!name && name !== decodeURIComponent(new URL(file).pathname.split('/').pop()!)
    if (moved && token) disconnect()
    if (!token && !off && !moved) {
      try { await claim(); misses = 0 } catch { misses++ }
    }
    if (token && !off) {
      const usedToken = token
      const usedSession = sessionId
      try {
        const pendingIds = signalIds(store.doc)
        const response = await fetch(`${BRIDGE}/tick`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${usedToken}` },
          body: JSON.stringify({ sessionId, file, docId: store.doc.docId, title: store.doc.title, dirty: store.dirty, canSave: hasFileHandle() || bridgeSaves, busy: busy(), pending: pendingRequests(store.doc), pendingIds, reply: pending }),
          signal: AbortSignal.timeout(8000),
        })
        // A stale token (bridge state reset): drop it and claim a fresh one.
        if (response.status === 403) { if (usedToken === token) disconnect(); throw Error('capability refused') }
        if (!response.ok) throw Error('connection refused')
        const body = await response.json()
        if (usedToken !== token || usedSession !== sessionId) throw Error('connection changed')
        saveVersion = typeof body.saveVersion === 'number' ? body.saveVersion : 0
        pending = null
        status(true)
        setListening(!!body.listening)
        if (body.command) {
          const c = body.command
          let result: unknown
          try {
            result = c.kind === 'read' ? agent.read() : c.kind === 'patch' ? agent.apply(c.request) : { status: 'invalid' }
          } catch (error) { result = { status: 'invalid', message: String(error) } }
          pending = { commandId: c.id, result }
          status(true)
        }
      } catch { status(false); setListening(false) }
    }
    // Without a bridge, probe quietly: 2 s at first, backing off to 5 s.
    window.setTimeout(() => void tick(), pending ? 50 : token ? 750 : Math.min(5000, 2000 + misses * 500))
  }
  window.addEventListener('pagehide', () => { stopped = true })
  window.addEventListener('pageshow', () => { if (stopped) { stopped = false; void tick() } })
  status(false)
  void tick()
  return api
}
