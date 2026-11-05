import type { Store } from './store'
import type { TesseraDoc } from './model'
import { applyPatches, clone, equal, type Patch } from './agent-patch'

export type AgentRequest = { id: string; docId: string; agent: string; patches: Patch[] }
export type AgentResult = { status: 'applied' | 'conflict' | 'busy' | 'invalid' | 'readonly'; id: string; message?: string }
const roots = new Set(['slides', 'assets', 'title', 'theme', 'layouts', 'fonts', 'requests'])
const types = new Set(['text', 'shape', 'image', 'svg', 'chart', 'table', 'media', 'poll', 'embed'])

function validate(doc: TesseraDoc, previous: TesseraDoc) {
  if (!Array.isArray(doc.slides) || !doc.slides.length) throw Error('a deck needs at least one slide')
  const unique = (items: { id: string }[]) => items.every(x => x && typeof x.id === 'string' && x.id.length > 0) && new Set(items.map(x => x.id)).size === items.length
  if (!unique(doc.slides)) throw Error('duplicate or missing slide ID')
  if (!doc.theme || !['background', 'color', 'accent', 'fontFamily'].every(k => typeof (doc.theme as any)[k] === 'string') || typeof doc.title !== 'string') throw Error('invalid document properties')
  if (doc.layouts && (!Array.isArray(doc.layouts) || !unique(doc.layouts))) throw Error('invalid layouts')
  if (doc.fonts && (!Array.isArray(doc.fonts) || doc.fonts.some(f => !f || typeof f.family !== 'string' || typeof f.asset !== 'string'))) throw Error('invalid fonts')
  const freshPolls = new Set<string>()
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) {
    const liveSlide = doc.slides.includes(s)
    if (!Array.isArray(s.elements) || !unique(s.elements)) throw Error('duplicate or missing element ID')
    if (typeof s.notes !== 'string' || typeof s.background !== 'string' || !['none', 'fade', 'slide', 'zoom', 'morph'].includes(s.transition)) throw Error('invalid slide properties')
    if (s.stateOf && !doc.slides.some(p => p.id === s.stateOf) && doc.slides.includes(s)) throw Error('missing state parent')
    for (const el of s.elements) {
      if (!types.has(el.type) || !['x', 'y', 'w', 'h'].every(k => Number.isFinite((el as any)[k]))) throw Error('invalid element type or frame')
      const old = (liveSlide ? previous.slides : previous.layouts ?? []).find(p => p.id === s.id)?.elements.find(e => e.id === el.id)
      if (old?.type === 'poll' && el.type === 'poll' && old.code !== el.code) throw Error('existing poll codes are immutable')
      if (el.type === 'poll' && liveSlide && !old && !s.stateOf && previous.slides.some(p => p.elements.some(e => e.type === 'poll' && e.code === el.code))) throw Error('new polls need fresh codes')
      if (el.type === 'poll' && !old && !s.stateOf && liveSlide) {
        if (!el.code || freshPolls.has(el.code)) throw Error('new polls need distinct codes')
        freshPolls.add(el.code)
      }
      if (el.type === 'text' && typeof el.html !== 'string') throw Error('invalid text')
    }
  }
  if (doc.requests !== undefined && (!Array.isArray(doc.requests) || !unique(doc.requests))) throw Error('invalid deck requests')
  if (doc.assets && (Array.isArray(doc.assets) || Object.values(doc.assets).some(x => typeof x !== 'string'))) throw Error('invalid assets')
}

/**
 * applyPatches hands back a deep copy, so every slide would look new to the
 * editor and it would redraw the whole deck for a one-word edit. Put the
 * previous objects back wherever nothing changed (open panels keep pointing at
 * live nodes) and report which slides can look different: a set of slide IDs,
 * or null when the change reaches further than the slides it names.
 */
function reconcile(previous: TesseraDoc, next: TesseraDoc): Set<string> | null {
  const changed = new Set<string>()
  let all = !equal(previous.slides.map(s => s.id), next.slides.map(s => s.id)) // page numbers shift
  const hasPoll = (s?: { elements: { type: string }[] }) => !!s?.elements.some(e => e.type === 'poll')
  const before = new Map(previous.slides.map(s => [s.id, s]))
  next.slides.forEach((s, i) => {
    const old = before.get(s.id)
    if (old && equal(old, s)) { next.slides[i] = old; return }
    changed.add(s.id)
    // Later figures read the nearest preceding poll.
    if (hasPoll(old) || hasPoll(s)) all = true
  })
  const layouts = new Map((previous.layouts ?? []).map(l => [l.id, l]))
  next.layouts?.forEach((l, i) => {
    const old = layouts.get(l.id)
    if (old && equal(old, l)) next.layouts![i] = old
  })
  const shared: (keyof TesseraDoc)[] = ['title', 'theme', 'layouts', 'fonts', 'size']
  for (const k of shared) {
    if (!equal(previous[k], next[k])) all = true
    else if (k !== 'layouts' && k in next) (next as any)[k] = previous[k]
  }
  // A replaced or removed asset redraws whatever names it; a new one, nothing.
  const replaced = Object.keys(previous.assets ?? {}).filter(k => previous.assets![k] !== next.assets?.[k])
  if (replaced.length && !all) {
    const names = (v: unknown) => { const json = JSON.stringify(v) ?? ''; return replaced.some(k => json.includes(k)) }
    if (names([next.theme, next.layouts, next.fonts])) all = true
    else for (const s of next.slides) if (!changed.has(s.id) && names(s)) changed.add(s.id)
  }
  return all ? null : changed
}

export class AgentEditor {
  private results = new Map<string, { request: string; result: AgentResult }>()
  lastActivity = ''
  constructor(private store: Store, private busy: () => boolean, private flush: () => void) {}

  read() {
    const doc = clone(this.store.doc)
    // An agent needs content, not the owner's relay credentials.
    delete doc.collab
    return { doc, dirty: this.store.dirty, currentSlideId: this.store.slide?.id }
  }

  apply(request: AgentRequest): AgentResult {
    const invalid = (message: string): AgentResult => ({ status: 'invalid', id: request?.id, message })
    if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 200 || typeof request.agent !== 'string') return invalid('request ID and agent name required')
    const fingerprint = JSON.stringify(request)
    const cached = this.results.get(request.id)
    if (cached) return cached.request === fingerprint ? cached.result : invalid('request ID reused with different content')
    if (request.docId !== this.store.doc.docId) return invalid('document identity changed; read again')
    if (this.store.readOnly || this.store.doc.readonly) return { status: 'readonly', id: request.id }
    if (this.busy()) return { status: 'busy', id: request.id, message: 'finish the active editor gesture before retrying' }
    if (this.results.size >= 10000) return invalid('session request limit reached; reconnect with a new session')
    if (!Array.isArray(request.patches) || !request.patches.length || request.patches.length > 10000) return invalid('patches required (maximum 10000)')
    for (const p of request.patches) {
      if (!p || !Array.isArray(p.path) || !roots.has(p.path[0] as string)) return invalid('protected document property')
      // Collections must be addressed by ID/key, never replaced wholesale.
      const initialize = p.before === undefined && ((p.path[0] === 'assets' && equal(p.value, {})) || (p.path[0] === 'layouts' && equal(p.value, [])))
      if (['slides', 'assets', 'layouts'].includes(p.path[0] as string) && p.path.length === 1 && !p.order && !initialize) return invalid('address individual slides, layouts or assets')
      if (p.path[p.path.length - 1] === 'id') return invalid('node IDs are immutable')
    }
    let next: TesseraDoc
    const before = new Map(this.store.doc.slides.map(s => [s.id, s]))
    try { next = applyPatches(this.store.doc, request.patches) }
    catch (error) { return { status: 'conflict', id: request.id, message: String(error) } }
    try { validate(next, this.store.doc) }
    catch (error) { return invalid(String(error)) }
    const result: AgentResult = { status: 'applied', id: request.id }
    // Commit receipt precedes notification: a renderer failure cannot make
    // retrying this request insert the same content a second time.
    const failed = this.commitDoc(next, () => this.results.set(request.id, { request: fingerprint, result }))
    if (failed) result.message = `Applied; editor notification failed: ${failed}`
    this.lastActivity = request.agent.slice(0, 80)
    // The slides whose CONTENT changed (a request's status or reply is not an
    // edit of the slide): the editor marks them as being edited for a moment.
    const bare = (s: unknown) => ({ ...(s as object), comments: undefined })
    const slideIds = this.store.doc.slides
      .filter(s => { const old = before.get(s.id); return old !== s && (!old || !equal(bare(old), bare(s))) })
      .map(s => s.id)
    if (slideIds.length && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('tessera-agent-edited', { detail: { slideIds, agent: this.lastActivity } }))
    return result
  }

  /**
   * Swap in a document that already holds the change (an agent patch, or the
   * file's own changes folded in by a save that found the file changed on
   * disk). Outside any local gesture's undo history, redrawing only what
   * changed. Returns the notification error, if any.
   */
  commitDoc(next: TesseraDoc, receipt: () => void = () => {}): string | null {
    const current = this.store.slide?.id, selection = this.store.selection.slice()
    const structure = !equal(this.store.doc.slides.map(s => s.id), next.slides.map(s => s.id))
    const scope = reconcile(this.store.doc, next)
    this.store.sealHistory()
    try {
      this.store.scope = scope
      this.store.commit(() => {
        this.store.doc = next
        const index = next.slides.findIndex(s => s.id === current)
        this.store.currentIndex = index < 0 ? Math.min(this.store.currentIndex, next.slides.length - 1) : index
        this.store.selection = selection.filter(id => this.store.element(id))
        receipt()
      }, structure ? 'slides' : 'doc')
      if (structure) this.store.emit('current')
      if (!equal(selection, this.store.selection)) this.store.emit('selection')
      this.flush()
      return null
    } catch (error) {
      return String(error)
    } finally { this.store.scope = null; this.store.sealHistory() }
  }

  /** Whether a gesture is under way (a commit now would cut into it). */
  isBusy() { return this.busy() }
}
