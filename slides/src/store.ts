// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
import { setDeckPollHost } from './model'
import type { TesseraDoc, Slide, SlideElement } from './model'
import { applyPatches, diff } from './agent-patch'
import type { Patch } from './agent-patch'

export type StoreEvent =
  | 'doc'        // any document mutation
  | 'slides'     // slide list changed (add/remove/reorder) — sidebar rebuild
  | 'current'    // current slide switched
  | 'selection'  // selected element ids changed
  | 'dirty'      // dirty flag changed
  | 'historyConflict'

type Listener = () => void

const MAX_UNDO = 100
/** Safety net under MAX_UNDO: the undo and redo stacks together hold at most
 *  this many (estimated) bytes of patches; the oldest steps go first. */
const MAX_HISTORY_BYTES = 64 * 1024 * 1024
/** One undo or redo step: the conditional, ID-addressed patches that take the
 *  document back across it (`diff(after, before)`), so unrelated later edits
 *  survive. Patches, never whole-document copies: a 14 MB deck used to cost
 *  ~55 MB of heap per edit and crashed the tab after ~70 edits. */
type HistoryEntry = { patches: Patch[]; bytes: number }
/** The open gesture (checkpoint() until the next seal): its step on the undo
 *  stack and the document as it was before it, which later touch() calls of
 *  the same gesture diff against. `touched`: mutated since its patches. */
type Pending = { entry: HistoryEntry; before: unknown; touched: boolean }

/** A JSON-equivalent copy (what JSON.parse(JSON.stringify(v)) gives) that
 *  SHARES the strings instead of copying them — they are immutable — so the
 *  gesture's baseline costs the object skeleton, not the deck's megabytes of
 *  figure pages and images. */
function snapshot(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v === null || typeof v !== 'object') return v
  if (typeof (v as any).toJSON === 'function') return snapshot((v as any).toJSON())
  const skip = (x: unknown) => x === undefined || typeof x === 'function' || typeof x === 'symbol'
  if (Array.isArray(v)) return v.map(x => skip(x) ? null : snapshot(x))
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) {
    const x = (v as any)[k]
    if (skip(x)) continue
    if (k === '__proto__') Object.defineProperty(out, k, { value: snapshot(x), enumerable: true, writable: true, configurable: true })
    else out[k] = snapshot(x)
  }
  return out
}

/** Rough heap bytes of a patch list (UTF-16 strings plus per-node overhead). */
function sizeOf(v: unknown): number {
  if (typeof v === 'string') return 16 + 2 * v.length
  if (!v || typeof v !== 'object') return 8
  let n = 16
  if (Array.isArray(v)) for (const x of v) n += sizeOf(x)
  else for (const k of Object.keys(v)) n += 2 * k.length + sizeOf((v as any)[k])
  return n
}
const entry = (patches: Patch[]): HistoryEntry => ({ patches, bytes: sizeOf(patches) })

/** Central state: document, current slide, selection, undo/redo, dirty flag. */
export class Store {
  doc: TesseraDoc
  currentIndex = 0
  selection: string[] = []
  dirty = false
  /** editor-only: which showOnHover set the canvas previews (never saved) */
  hoverPreview: string | null = null
  /** While an agent edit is being notified: the only slides it can have
   *  changed the look of, so listeners leave the rest alone. null = anything. */
  scope: Set<string> | null = null

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private pending: Pending | null = null
  private listeners = new Map<StoreEvent, Set<Listener>>()

  /** read-only viewer: block user edits (commit) while remote ops — which
   *  apply via the session's direct state.apply + emit, NOT commit — still
   *  flow, so a live viewer sees updates but can never author them. */
  readOnly = false

  constructor(doc: TesseraDoc) {
    this.doc = doc
  }

  on(event: StoreEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return () => this.listeners.get(event)!.delete(fn)
  }

  emit(event: StoreEvent) {
    this.listeners.get(event)?.forEach((fn) => fn())
  }

  get slide(): Slide {
    return this.doc.slides[this.currentIndex]
  }

  element(id: string): SlideElement | undefined {
    return this.slide.elements.find((e) => e.id === id)
  }

  get selectedElements(): SlideElement[] {
    return this.selection
      .map((id) => this.element(id))
      .filter((e): e is SlideElement => !!e)
  }

  /**
   * Replace the whole document (AI/JSON round-trip import). Undoable —
   * Undo conditionally reverses its changes; subsequent unrelated edits survive.
   */
  replaceDoc(next: TesseraDoc) {
    this.checkpoint()
    this.doc = next
    this.finishHistory()
    // A wholesale replacement can bring a different deployment with it
    // (imported JSON, a restored version) — boot's value would be stale.
    setDeckPollHost(next.poll?.service)
    this.currentIndex = 0
    this.selection = []
    this.setDirty(true)
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
    this.emit('doc')
  }

  // --- history ------------------------------------------------------------

  /** Open a new undo step at the current doc state. Call BEFORE a mutation;
   *  every touch() until the next seal extends the same step. */
  checkpoint() {
    this.sealHistory()
    const step: HistoryEntry = { patches: [], bytes: 0 }
    this.pending = { entry: step, before: snapshot(this.doc), touched: false }
    this.undoStack.push(step)
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack.length = 0
  }

  /** End the local gesture before applying externally authored changes. */
  sealHistory() {
    if (this.pending?.touched) this.finishHistory()
    this.pending = null
  }
  /** Bring the open step's patches up to the current doc. */
  private finishHistory() {
    const p = this.pending
    if (!p) return
    p.touched = false
    p.entry.patches = diff(this.doc, p.before)
    p.entry.bytes = sizeOf(p.entry.patches)
    this.trimHistory()
  }
  /** Drop the oldest undo steps, then the farthest redo steps, while the
   *  stacks exceed the byte budget. The newest undo step always stays. */
  private trimHistory() {
    let total = 0
    for (const e of this.undoStack) total += e.bytes
    for (const e of this.redoStack) total += e.bytes
    while (total > MAX_HISTORY_BYTES && this.undoStack.length > 1) total -= this.undoStack.shift()!.bytes
    while (total > MAX_HISTORY_BYTES && this.redoStack.length) total -= this.redoStack.shift()!.bytes
  }

  /** checkpoint() + mutate + notify, in one call. */
  commit(mutate: () => void, event: StoreEvent = 'doc') {
    if (this.readOnly) return // live viewer — user edits are inert
    this.checkpoint()
    mutate()
    this.touch(event)
  }

  /** Mark dirty and notify after an in-place mutation (no checkpoint). The
   *  open step is diffed once, after the listeners (which may mutate too);
   *  a listener that seals mid-notification gets it diffed then. */
  touch(event: StoreEvent = 'doc') {
    this.doc.modified = new Date().toISOString()
    if (this.pending) this.pending.touched = true
    this.setDirty(true)
    this.emit('doc')
    if (event !== 'doc') this.emit(event)
    if (this.pending?.touched) this.finishHistory()
  }

  /** Forget every undo/redo step — the document became a different deck
   *  ("Duplicate as new deck…"), and its history belongs to the old one. */
  clearHistory() {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.pending = null
  }

  undo() { this.restore(this.undoStack, this.redoStack) }
  redo() { this.restore(this.redoStack, this.undoStack) }

  private restore(from: HistoryEntry[], to: HistoryEntry[]) {
    if (this.readOnly) return
    this.sealHistory()
    const step = from[from.length - 1]
    if (!step) return
    // applyPatches works on a copy, so `current` stays the pre-restore doc
    const current = this.doc, slideId = this.slide?.id
    let next: TesseraDoc
    try {
      next = applyPatches(current, step.patches)
    } catch {
      this.emit('historyConflict')
      return
    }
    from.pop()
    this.doc = next
    to.push(entry(diff(next, current)))
    this.trimHistory()
    this.doc.modified = new Date().toISOString()
    setDeckPollHost(this.doc.poll?.service)
    const index = this.doc.slides.findIndex(s => s.id === slideId)
    this.currentIndex = index < 0 ? Math.min(this.currentIndex, this.doc.slides.length - 1) : index
    this.selection = this.selection.filter((id) => this.element(id))
    this.setDirty(true)
    this.emit('doc')
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
  }

  setDirty(dirty: boolean) {
    if (this.dirty === dirty) return
    this.dirty = dirty
    this.emit('dirty')
  }

  // --- navigation & selection ----------------------------------------------

  goTo(index: number) {
    const clamped = Math.max(0, Math.min(index, this.doc.slides.length - 1))
    if (clamped === this.currentIndex) return
    this.currentIndex = clamped
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  /** Step forward/back one slide, skipping interactive states (stateOf) the way
   *  linear presentation does. dir = +1 next, -1 prev. */
  goToLinear(dir: 1 | -1) {
    const slides = this.doc.slides
    for (let i = this.currentIndex + dir; i >= 0 && i < slides.length; i += dir) {
      if (!slides[i].stateOf) { this.goTo(i); return }
    }
  }

  select(ids: string[]) {
    this.selection = ids
    this.emit('selection')
  }
}
