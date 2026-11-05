// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// tessera-sync session — the bridge between the CRDT engine (crdt.ts) and the
// running editor. Owns: the differ hook on the store, the same-machine
// BroadcastChannel transport (every open tab of this deck), presence, and peer
// catch-up. The fork has no online relay. See docs/collab-design.md.
//
// Wire protocol (one JSON frame per message):
//   {t:'hello', a, vv, p}    join/announce — receivers reply hello + missing ops
//   {t:'ops',   a, ops}      op batch
//   {t:'need',  a, vv}       gap catch-up request (receivers send missing ops)
//   {t:'p',     a, p}        presence heartbeat   {t:'bye', a}  leave
//
// The differ is the whole integration: every local mutation already flows
// through store.commit/touch → 'doc' event → (debounced) diff against the
// session's shadow → ops out. Remote ops apply surgically by id and re-emit
// the same store events the editor already listens to. Zero editor rewrites.

import type { Store } from '../store'
import type { TesseraDoc, Slide } from '../model'
import { uid } from '../model'
import { keySlide, SyncState, SYNC_V, type Op } from './crdt'

export interface PresenceInfo {
  name: string
  color: string
  /** current slide id */
  slide: string
  /** selected element ids */
  sel: string[]
  /** element id currently being text-edited (in-text presence) */
  editing?: string
}

export interface Peer extends PresenceInfo {
  actor: string
  at: number
}

interface HelloFrame { t: 'hello'; a: string; vv: Record<string, number>; p: PresenceInfo }
interface OpsFrame { t: 'ops'; a: string; ops: Op[] }
interface NeedFrame { t: 'need'; a: string; vv: Record<string, number> }
interface PresFrame { t: 'p'; a: string; p: PresenceInfo }
interface ByeFrame { t: 'bye'; a: string }
/** state-based fork merge: a rejoining offline-edited copy announces itself */
interface SnapFrame {
  t: 'snap'
  a: string
  doc: TesseraDoc
  state: import('./crdt').SyncStateJSON
}
/** every frame is stamped with the sync protocol version (`pv: SYNC_V`) by
 * send(); frames without the current pv (old builds, the bare-id era) are
 * dropped in onFrame — their keys don't interoperate */
export type Frame = (HelloFrame | OpsFrame | NeedFrame | PresFrame | ByeFrame | SnapFrame) & {
  pv?: number
}

export interface Transport {
  readonly kind: string
  send(frame: Frame): void
  close(): void
}

/** Same-machine transport: every open tab/window of this document. */
class BroadcastTransport implements Transport {
  readonly kind = 'local'
  private ch: BroadcastChannel
  constructor(docId: string, onFrame: (f: Frame) => void) {
    this.ch = new BroadcastChannel(`tessera-sync-${docId}`)
    this.ch.onmessage = (ev) => onFrame(ev.data as Frame)
  }
  send(frame: Frame) {
    this.ch.postMessage(frame)
  }
  close() {
    this.ch.close()
  }
}

const PEER_COLORS = ['#FF9E8A', '#8FA3BF', '#7FC8A9', '#E8C468', '#C792EA', '#6AB7D6', '#E88AB0', '#A9C77F']

const actorColor = (actor: string): string => {
  let h = 0
  for (let i = 0; i < actor.length; i++) h = (h * 31 + actor.charCodeAt(i)) >>> 0
  return PEER_COLORS[h % PEER_COLORS.length]
}

/**
 * Actor id: fresh per SESSION INSTANCE, deliberately — a reloaded tab is a
 * new replica with empty CRDT state, and the engine skips "own" ops on
 * apply, so reusing an id would make a peer's replay of the previous
 * incarnation's ops a no-op. Random ids sidestep the whole class.
 */
function tabActor(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * A copy of plain JSON data that SHARES its strings, which are immutable. The
 * shadow then costs the document's structure, not its bytes: an image-heavy
 * deck is megabytes of data-URI strings in a few hundred objects, and the
 * shadow used to be re-serialized whole after every received batch.
 * Mirrors a JSON round trip: undefined properties are dropped, undefined
 * array slots become null.
 */
function cloneData<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : cloneData(x))) as T
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined && typeof x !== 'function') o[k] = cloneData(x)
    }
    return o as T
  }
  return v
}

/** Slide properties that change how the slide looks but not the slide list
 *  (its thumbnail's size, nesting or label), so a remote set of one repaints
 *  that slide alone. */
const SLIDE_LOOK_KEYS = new Set(['notes', 'comments', 'background', 'transition', 'hover'])

/**
 * Which slides a batch of remote ops can have changed, and whether it changed
 * the slide list itself. `slides: null` = beyond slides (doc-level props,
 * assets, slides added, removed or reordered): everything repaints.
 */
function opsScope(ops: Op[]): { slides: Set<string> | null; list: boolean } {
  const slides = new Set<string>()
  let list = false
  for (const op of ops) {
    if (op.op === 'set') {
      if (op.el) slides.add(keySlide(op.el))
      else if (op.sl) {
        slides.add(op.sl)
        if (!SLIDE_LOOK_KEYS.has(op.k)) list = true
      } else return { slides: null, list: true }
    } else if (op.op === 'txt') slides.add(keySlide(op.el))
    else if (op.kind === 'slide') return { slides: null, list: true }
    else slides.add(keySlide(op.id))
  }
  return { slides, list }
}

const DIFF_DEBOUNCE_MS = 90
const HEARTBEAT_MS = 5000
const PEER_TTL_MS = 13000

export class SyncSession {
  readonly actor: string
  state!: SyncState
  /** the document as last diffed or received (cloneData: strings shared) */
  private shadow: TesseraDoc = null as unknown as TesseraDoc
  private docId = ''
  private log: Op[] = []
  private transports: Transport[] = []
  private peersMap = new Map<string, Peer>()
  private applying = false
  private diffTimer: number | null = null
  private heartbeat: number | null = null
  private peerListeners = new Set<() => void>()
  private editingEl: string | undefined

  constructor(private store: Store) {
    this.actor = tabActor()
    this.attach()
    store.on('doc', () => this.onLocalChange())
    store.on('current', () => this.pushPresence())
    store.on('selection', () => this.pushPresence())
    window.addEventListener('beforeunload', () => this.broadcast({ t: 'bye', a: this.actor }))
  }

  // --- lifecycle -----------------------------------------------------------

  /** a restored offline fork still owes the room its snapshot */
  private forkPending = false

  private attach() {
    this.docId = this.store.doc.docId
    const doc = this.store.doc
    // Files saved by upstream during a shared session carry their CRDT state
    // in collab.sync; new decks carry no collab at all.
    const saved = doc.collab?.sync
    if (saved && saved.v === SYNC_V) {
      // this file was saved during/after a shared session: restore the CRDT
      // state so our offline edits carry real registers, remote replay
      // dedups by version vector, and a state-based snapshot exchange can
      // merge the fork BOTH ways (see docs/collab-design.md)
      this.state = SyncState.fromJSON(this.actor, JSON.parse(JSON.stringify(saved)))
      this.forkPending = true
    } else {
      // no saved state, or state from the pre-composite-key era (v1) — that
      // scheme collapsed same-id-on-many-slides, so it is discarded and the
      // file joins as a never-synced adopt (deterministic keys from the doc)
      this.state = new SyncState(this.actor)
    }
    this.state.adopt(doc)
    this.shadow = cloneData(doc)
    this.log = []
    this.peersMap.clear()
    this.emitPeers()
    for (const tr of this.transports) tr.close()
    this.transports = [new BroadcastTransport(this.docId, (f) => this.onFrame(f))]
    this.hello() // announces + (for restored forks) broadcasts the state snapshot
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = window.setInterval(() => {
      this.pushPresence()
      this.sweepPeers()
    }, HEARTBEAT_MS)
  }

  get transportKinds(): string[] {
    return this.transports.map((t) => t.kind)
  }

  // --- local mutations → ops ----------------------------------------------

  private onLocalChange() {
    if (this.applying) return
    if (this.store.doc.docId !== this.docId) {
      // replaceDoc / loadDoc swapped in a different document — re-key
      this.attach()
      return
    }
    if (this.diffTimer) return
    this.diffTimer = window.setTimeout(() => {
      this.diffTimer = null
      this.flush()
    }, DIFF_DEBOUNCE_MS)
  }

  /** diff now (also called before presence-relevant transitions) */
  flush() {
    if (this.applying) return
    const before = this.shadow
    let ops: Op[]
    try {
      ops = this.state.diff(before, this.store.doc, { text: true })
    } catch (err) {
      this.recoverFromDiffFailure(err)
      return
    }
    this.shadow = cloneData(this.store.doc)
    if (!ops.length) return
    this.log.push(...ops)
    this.broadcast({ t: 'ops', a: this.actor, ops })
  }

  /**
   * A differ bug must not WEDGE the session. The shadow is only advanced after
   * a successful diff, so an uncaught throw here poisons every later flush:
   * the same delta is re-diffed, throws again, and nothing syncs for the rest
   * of the session — on any slide, not just the element that broke. That
   * amplifier is what turned the ~200KB-text stack overflow (fixed in crdt.ts:
   * splice-without-spread) into total, silent collab failure. The trigger is
   * gone; the amplifier stays armed for the next differ bug, so disarm it.
   *
   * Recovery, best-effort in this order:
   *  - Advance the shadow past the poison delta. Re-diffing it would just
   *    re-throw, and a wedged differ is strictly worse than one lost delta.
   *  - Ship a state snapshot. diff() mints ops and advances its registers as
   *    it goes, so a mid-diff throw leaves some changes stamped but never
   *    broadcast — they now live only in our doc VALUES. That is exactly the
   *    offline-fork case, and a snapshot is how those travel (see hello()).
   *    forkPending marks the state as owing a snapshot.
   *
   * This path is a bug — console is the right surface.
   */
  private recoverFromDiffFailure(err: unknown) {
    console.error('[tessera-sync] diff failed; recovering via snapshot', err)
    this.shadow = cloneData(this.store.doc)
    this.forkPending = true
    try {
      // inlined rather than this.snapshot() — that calls flush(), and flush()
      // is our caller
      this.broadcast({
        t: 'snap',
        a: this.actor,
        doc: JSON.parse(JSON.stringify(this.store.doc)) as TesseraDoc,
        state: JSON.parse(JSON.stringify(this.state.toJSON())),
      })
    } catch (e2) {
      // snapshot itself failed (state unserializable) — the shadow is still
      // advanced, so editing continues and the next reconnect retries
      console.error('[tessera-sync] snapshot recovery failed', e2)
    }
  }

  // --- remote frames --------------------------------------------------------

  private onFrame(f: Frame) {
    if (f.pv !== SYNC_V) return // old-protocol frame (bare-id keys) — ignore
    if (f.a === this.actor) return
    switch (f.t) {
      case 'hello': {
        this.touchPeer(f.a, f.p)
        // answer so the newcomer learns us + catch them up from our log,
        // AND tell them our vv so ops they minted before connecting (which
        // nothing else would push) flow back to us — need→ops terminates
        this.send({ t: 'p', a: this.actor, p: this.presence() })
        this.send({ t: 'need', a: this.actor, vv: this.state.vv })
        const missing = this.state.missingFor(this.log, f.vv)
        if (missing.length) this.send({ t: 'ops', a: this.actor, ops: missing })
        break
      }
      case 'ops':
        this.applyRemote(f.ops)
        break
      case 'need': {
        const missing = this.state.missingFor(this.log, f.vv)
        if (missing.length) this.send({ t: 'ops', a: this.actor, ops: missing })
        break
      }
      case 'p':
        this.touchPeer(f.a, f.p)
        break
      case 'snap':
        this.applySnapshot(f.doc, f.state)
        break
      case 'bye':
        this.peersMap.delete(f.a)
        this.emitPeers()
        break
    }
  }

  applyRemote(ops: Op[]) {
    this.store.sealHistory()
    // make sure our own pending edits are diffed first (they pre-date the
    // remote batch locally; LWW settles the rest). Only when one IS pending:
    // a flush parses and re-serialises the whole document, and joining a room
    // replays it batch by batch, so an unconditional flush here cost an
    // image-heavy deck ~10 s of pinned CPU on every open.
    if (this.diffTimer) {
      clearTimeout(this.diffTimer)
      this.diffTimer = null
      this.flush()
    }
    for (const op of ops) if (!this.log.some((o) => o.a === op.a && o.s === op.s)) this.log.push(op)
    // Ops buffered behind a gap may be released by this batch, and they are
    // not in it: then the scope cannot be known, and everything repaints.
    const scope = this.state.gappedActors.length ? { slides: null, list: true } : opsScope(ops)
    this.applying = true
    try {
      const res = this.state.apply(this.store.doc, ops)
      if (res.changed) this.afterRemoteChange(res.structure, scope)
    } finally {
      this.applying = false
    }
    if (this.state.gappedActors.length) {
      this.send({ t: 'need', a: this.actor, vv: this.state.vv })
    }
  }

  /**
   * Tell the editor what a remote batch changed. `scope` names the slides it
   * touched, so the listeners repaint those alone (store.scope, as for an
   * agent edit): the canvas keeps a slide that did not change — and its
   * running figures — and the sidebar redraws only those thumbnails. An
   * element added or removed is a change to its slide, not to the slide list.
   */
  private afterRemoteChange(structure: boolean, scope: { slides: Set<string> | null; list: boolean } = { slides: null, list: true }) {
    const store = this.store
    // an all-slides-deleted race leaves an empty deck — heal with a blank
    if (store.doc.slides.length === 0) {
      const blank: Slide = {
        id: uid('s'),
        background: store.doc.theme.background,
        transition: 'morph',
        elements: [],
        notes: '',
      }
      store.doc.slides.push(blank)
      // mint it as a local op so every replica converges on ONE healer's
      // slide (LWW keeps all healers' slides; harmless extra blanks)
      this.applying = false
      this.flush()
      this.applying = true
      scope = { slides: null, list: true }
    }
    store.currentIndex = Math.min(store.currentIndex, store.doc.slides.length - 1)
    const sel = store.selection.filter((id) => store.element(id))
    const selChanged = sel.length !== store.selection.length
    store.selection = sel
    this.shadow = cloneData(store.doc)
    store.doc.modified = new Date().toISOString()
    store.setDirty(true)
    store.scope = scope.slides
    try {
      store.emit('doc')
      if (structure && (scope.list || !scope.slides)) {
        store.emit('slides')
        store.emit('current')
      }
    } finally { store.scope = null }
    if (selChanged) store.emit('selection')
  }

  // --- presence -------------------------------------------------------------

  private presence(): PresenceInfo {
    let name = 'Guest'
    try {
      name = localStorage.getItem('tessera-author') || 'Guest'
    } catch {
      /* storage unavailable */
    }
    return {
      name,
      color: actorColor(this.actor),
      slide: this.store.slide?.id ?? '',
      sel: this.store.selection.slice(),
      ...(this.editingEl ? { editing: this.editingEl } : {}),
    }
  }

  /** canvas hooks this while a text element is being edited (M3 presence) */
  setEditing(elId: string | undefined) {
    if (this.editingEl === elId) return
    this.editingEl = elId
    this.pushPresence()
  }

  private pushPresence() {
    this.send({ t: 'p', a: this.actor, p: this.presence() })
  }

  private touchPeer(actor: string, p: PresenceInfo) {
    this.peersMap.set(actor, { ...p, actor, at: Date.now() })
    this.emitPeers()
  }

  private sweepPeers() {
    const cut = Date.now() - PEER_TTL_MS
    let changed = false
    for (const [a, p] of this.peersMap) {
      if (p.at < cut) {
        this.peersMap.delete(a)
        changed = true
      }
    }
    if (changed) this.emitPeers()
  }

  peers(): Peer[] {
    return [...this.peersMap.values()].sort((a, b) => (a.actor < b.actor ? -1 : 1))
  }

  onPeers(fn: () => void): () => void {
    this.peerListeners.add(fn)
    return () => this.peerListeners.delete(fn)
  }

  private emitPeers() {
    this.peerListeners.forEach((fn) => fn())
  }

  // --- snapshots (file-fork merge) ------------------------------------------

  /** current (doc, sync-state) pair, broadcast by a restored offline fork */
  snapshot(): { doc: TesseraDoc; state: import('./crdt').SyncStateJSON } {
    this.flush()
    return {
      doc: JSON.parse(JSON.stringify(this.store.doc)) as TesseraDoc,
      state: JSON.parse(JSON.stringify(this.state.toJSON())),
    }
  }

  /** merge a remote snapshot (another tab's restored fork, or diff recovery) */
  applySnapshot(rdoc: TesseraDoc, rstate: import('./crdt').SyncStateJSON) {
    if (!rstate || rstate.v !== SYNC_V) return // pre-v2 room snapshot — unusable
    this.store.sealHistory()
    this.flush()
    this.applying = true
    try {
      const res = this.state.mergeSnapshot(this.store.doc, rdoc, rstate)
      if (res.changed) this.afterRemoteChange(true)
    } finally {
      this.applying = false
    }
  }

  /** announce this tab (and, for a restored fork, its state snapshot) */
  private hello() {
    this.broadcast({ t: 'hello', a: this.actor, vv: this.state.vv, p: this.presence() })
    if (this.forkPending) {
      // rejoining offline fork: our contributions live in doc values +
      // restored registers, not ops — a state snapshot is how they travel
      const s = this.snapshot()
      this.broadcast({ t: 'snap', a: this.actor, doc: s.doc, state: s.state })
    }
  }

  /**
   * Stamp the CRDT state into doc.collab.sync so the SAVED file can rejoin
   * as a true fork later. Called by the save/serialize paths; only files that
   * were shared live upstream carry it (every other file stays clean).
   */
  stampInto(doc: TesseraDoc) {
    if (!doc.collab || doc.collab.on === false) return
    this.flush()
    doc.collab.sync = JSON.parse(JSON.stringify(this.state.toJSON()))
  }

  // --- plumbing -------------------------------------------------------------

  private send(frame: Frame) {
    const stamped = { ...frame, pv: SYNC_V }
    for (const tr of this.transports) tr.send(stamped)
  }

  private broadcast(frame: Frame) {
    this.send(frame)
  }
}
