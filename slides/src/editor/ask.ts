// SPDX-License-Identifier: MIT
// The places a person writes in the AI-native editor, besides the slide:
//   AskBar      — one line that grows, aimed at a slide (and at the selected
//                 element, shown as a chip) or at the whole deck. A request is
//                 a Slide.comments thread flagged `request` — doc.requests for
//                 the whole deck — (see ../requests.ts): it is saved in the
//                 file, so whichever agent opens the deck next finds it, and an
//                 agent connected through the local bridge is told at once.
//   RowAsk      — the comment side of one row of the review list (a slide, or
//                 the whole deck): the latest request, earlier ones folded, and
//                 a field that is always there. A dot before each request is
//                 its status (green, with the text, when done); hovering the
//                 dot shows the agent's reply. Up/Down at the field's first or
//                 last line move to the row above or below.
//   NewSlidePrompt — the box on an empty slide when the list shows no fields
//                 (narrow or grid): "What should this slide be?"
//   RequestList — a slide's requests as cards (the phone dock, phone.ts).
//   NotesView   — this slide's speaker notes, under the slide.

import type { Store } from '../store'
import { uid, type Comment, type Slide, type SlideElement } from '../model'
import { listRequests, requestStatus } from '../requests'
import { ICONS } from '../icons'
import { t } from '../i18n'

const div = (cls: string) => Object.assign(document.createElement('div'), { className: cls })
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** A request or a note changes nothing on the slide itself: commit without
 *  repainting the canvas, which would reload any running figure. */
function quiet(store: Store, fn: () => void) {
  store.scope = new Set()
  try { fn() } finally { store.scope = null }
}

/** What a person would call an element: the start of its text, else its kind. */
export function elementLabel(e: SlideElement | undefined): string {
  if (!e) return t('Element')
  if (e.type === 'text') {
    const text = (new DOMParser().parseFromString(e.html, 'text/html').body.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (text) return `“${text.length > 26 ? text.slice(0, 25) + '…' : text}”`
  }
  return ({
    text: t('Text'), shape: t('Shape'), image: t('Picture'), svg: t('Drawing'), chart: t('Chart'),
    table: t('Table'), media: t('Video'), poll: t('Question'), embed: t('Figure'),
  } as Record<string, string>)[e.type] ?? t('Element')
}

/** "2 min ago", in the reader's language, with no catalog strings. */
function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!isFinite(s)) return ''
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto', style: 'short' })
  if (s < 45) return rtf.format(0, 'second')
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return new Date(iso).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'short' })
}

// --- the ask field ------------------------------------------------------------

export interface AskOptions {
  /** 'deck': the request is about the whole deck (doc.requests) */
  scope?: 'slide' | 'deck'
  /** no "Slide n" chip: the field sits beside the slide it is about */
  compact?: boolean
  placeholder?: () => string
}

export class AskBar {
  readonly root = div('ed-ask')
  private input = document.createElement('textarea')
  private target = div('ed-ask-target')
  /** the selection the person took off the request with the chip's × */
  private dropped = ''

  constructor(parent: HTMLElement, private store: Store, private opts: AskOptions = {}) {
    this.input.className = 'ed-agent-input ed-ask-input'
    this.input.rows = 1
    this.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation() // the editor's shortcuts must not fire while typing
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); this.send() }
      if (ev.key === 'Escape') this.input.blur()
    })
    this.input.addEventListener('input', () => this.grow())
    const send = el('button', 'ed-ask-send')
    send.innerHTML = ICONS.send
    send.title = t('Send (Enter) · new line: Shift+Enter')
    send.setAttribute('aria-label', t('Send'))
    send.addEventListener('click', () => this.send())
    const bar = div('ed-ask-bar')
    bar.append(this.target, this.input, send)
    bar.addEventListener('click', (ev) => { if (ev.target === bar) this.input.focus() })
    this.root.append(bar)
    parent.appendChild(this.root)

    store.on('current', () => { this.dropped = ''; this.paint() })
    store.on('selection', () => this.paint())
    store.on('doc', () => this.paint())
    this.paint()
    // a narrow column wraps the placeholder: the field grows to show it all
    let width = 0
    new ResizeObserver(([e]) => {
      if (Math.round(e.contentRect.width) !== width) { width = Math.round(e.contentRect.width); this.grow() }
    }).observe(this.input)
  }

  focus() { this.input.focus() }

  private selected(): string[] {
    if (this.opts.scope === 'deck') return []
    const sel = this.store.selection.filter((id) => this.store.slide?.elements.some((e) => e.id === id))
    return sel.join(',') === this.dropped ? [] : sel
  }

  private paint() {
    const slide = this.store.slide
    if (!slide) return
    const n = this.store.currentIndex + 1
    const sel = this.selected()
    this.target.textContent = ''
    if (!this.opts.compact && this.opts.scope !== 'deck') this.target.append(el('span', 'ed-ask-slide', `${t('Slide')} ${n}`))
    if (sel.length) {
      const first = slide.elements.find((e) => e.id === sel[0])
      const what = sel.length > 1 ? t('{n} elements', { n: sel.length }) : elementLabel(first)
      const x = el('button', 'ed-ask-drop', '×')
      x.title = t('Ask about the whole slide instead')
      x.addEventListener('click', (ev) => { ev.stopPropagation(); this.dropped = this.store.selection.join(','); this.paint() })
      this.target.append(el('span', 'ed-ask-el', what), x)
    }
    this.target.classList.toggle('has-el', sel.length > 0)
    this.target.hidden = !this.target.childNodes.length
    const ph = this.opts.placeholder?.()
      ?? (this.opts.scope === 'deck' ? t('Ask for a change to the whole deck…') : t('Ask for a change to this slide…'))
    if (this.input.placeholder !== ph) { this.input.placeholder = ph; if (!this.input.value) this.grow() }
  }

  private grow() {
    if (!this.input.isConnected || !this.input.offsetWidth) return // not laid out: keep the CSS height
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 6 * 21 + 14)}px`
  }

  private author(): string {
    try { return localStorage.getItem('tessera-author') || t('You') } catch { return t('You') }
  }

  private send() {
    const text = this.input.value.trim()
    if (!text) return
    const sel = this.selected()
    const c: Comment = {
      id: uid('req'), request: true, status: 'open', author: this.author(), text, at: new Date().toISOString(),
      ...(sel.length ? { elementId: sel[0] } : {}),
      ...(sel.length > 1 ? { elementIds: sel } : {}),
    }
    const deck = this.opts.scope === 'deck'
    const slideId = deck ? '' : this.store.slide.id
    quiet(this.store, () => this.store.commit(() => {
      if (deck) { this.store.doc.requests = [...(this.store.doc.requests ?? []), c]; return }
      const s = this.store.slide
      s.comments = [...(s.comments ?? []), c]
    }))
    this.input.value = ''
    this.grow()
    // for a page that carries requests somewhere else (a hosted mirror has no
    // bridge); slideId '' = the whole deck
    window.dispatchEvent(new CustomEvent('tessera-request', { detail: { slideId, request: c } }))
  }
}

/** Whether an agent is waiting for requests (agent-bridge.ts, on each tick). */
let listening = false
window.addEventListener('tessera-agent-listening', ((ev: CustomEvent) => {
  listening = !!ev.detail
  window.dispatchEvent(new Event('tessera-ask-state'))
}) as EventListener)

// --- the review list: a comment field beside every slide --------------------------

/** The status word for a request. */
const statusWord = (s: string) => ({ open: t('Waiting'), working: t('Working…'), done: t('Done') } as Record<string, string>)[s] ?? s

/** Whether an agent is waiting for requests right now. */
export const agentListening = () => listening

/** The orbs on a thumbnail: one per request (hollow = waiting, pulsing = the
 *  agent works on it, green = done), the newest `max`; older ones counted.
 *  The only status display: no words under the comments. Null when none. */
export function requestOrbs(threads: Comment[] | undefined, max = 6): HTMLElement | null {
  const reqs = (threads ?? []).filter((c) => c.request)
  if (!reqs.length) return null
  const box = div('ed-orbs')
  const shown = reqs.slice(-max)
  if (reqs.length > shown.length) box.append(el('span', 'ed-orbs-more', `+${reqs.length - shown.length}`))
  for (const c of shown) {
    const st = requestStatus(c)
    const b = el('span', 'ed-orb')
    b.dataset.s = st
    const reply = c.replies?.[c.replies.length - 1]
    b.title = `${statusWord(st)}${st === 'open' && !listening ? ' · ' + t('no agent listening') : ''}: ${c.text}${reply ? `
→ ${reply.text}` : ''}`
    box.appendChild(b)
  }
  return box
}

/** The name an agent signs its replies with, newest first; '' when none has. */
export function agentNameOf(threads: Comment[]): string {
  for (let i = threads.length - 1; i >= 0; i--) {
    const r = threads[i].replies
    if (r?.length) return r[r.length - 1].author
  }
  return ''
}

function removeRequest(store: Store, slideId: string | null, id: string) {
  quiet(store, () => store.commit(() => {
    if (slideId === null) {
      store.doc.requests = (store.doc.requests ?? []).filter((x) => x.id !== id)
      if (!store.doc.requests.length) delete store.doc.requests
      return
    }
    const s = store.doc.slides.find((x) => x.id === slideId)
    if (!s) return
    s.comments = (s.comments ?? []).filter((x) => x.id !== id)
    if (!s.comments.length) delete s.comments
  }))
}

export interface RowAskHooks {
  /** Enter sent a request: the editor moves on to the next row */
  sent(): void
  /** Up/Down past the field's first or last line: false when there is no row there */
  move(dir: 1 | -1): boolean
}

/** The top of the caret's line at `pos` in a textarea, measured on a hidden
 *  copy laid out the same way (a wrapped line counts as a line). */
function caretTop(ta: HTMLTextAreaElement, pos: number): number {
  const cs = getComputedStyle(ta)
  const m = document.createElement('div')
  for (const p of ['box-sizing', 'width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style',
    'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height',
    'text-transform', 'word-spacing', 'tab-size', 'direction', 'word-break']) m.style.setProperty(p, cs.getPropertyValue(p))
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' })
  m.textContent = ta.value.slice(0, pos)
  const mark = document.createElement('span')
  mark.textContent = '\u200b'
  m.appendChild(mark)
  document.body.appendChild(m)
  const top = mark.offsetTop
  m.remove()
  return top
}

/** The agent's reply to a request, shown while its dot is hovered: one box
 *  for the page, fixed so the scrolling list does not clip it. */
let replyPop: HTMLElement | null = null
function showReply(dot: HTMLElement, c: Comment) {
  const pop = replyPop ??= document.body.appendChild(div('ed-reply-pop'))
  const st = requestStatus(c)
  pop.textContent = ''
  pop.append(el('div', `ed-reply-pop-head ${st}`, `${statusWord(st)} · ${ago(c.at)}${st === 'open' && !listening ? ' · ' + t('no agent listening') : ''}`))
  for (const r of c.replies ?? []) {
    const p = div('ed-reply-pop-text')
    p.append(el('b', '', r.author), document.createTextNode(' ' + r.text))
    pop.appendChild(p)
  }
  pop.hidden = false
  const r = dot.getBoundingClientRect()
  const w = pop.offsetWidth, h = pop.offsetHeight
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 6))
  const top = r.bottom + 6 + h > window.innerHeight - 8 ? r.top - 6 - h : r.bottom + 6
  pop.style.left = `${left}px`
  pop.style.top = `${Math.max(8, top)}px`
}
function hideReply() { if (replyPop) replyPop.hidden = true }

/**
 * The comment side of one row of the review list: the latest request (its
 * text, and the agent's one-line reply under it in small type), the earlier
 * ones folded behind "n earlier", and a field that is always there. Status is
 * not written out: the thumbnail's orbs show it. `slideId` null = the whole deck (doc.requests). The editor keeps one
 * per slide across list rebuilds, so a half-typed comment survives a move.
 */
export class RowAsk {
  readonly root = div('ed-row-ask')
  readonly input = document.createElement('textarea')
  private reqs = div('ed-row-reqs')
  private target = div('ed-row-target')
  private open = false
  private sig = ''

  constructor(private store: Store, readonly slideId: string | null, hooks: RowAskHooks) {
    // ed-agent-input: typing a comment must not hold up an agent's edits (agent-bridge busy())
    this.input.className = 'ed-row-input ed-agent-input'
    this.input.rows = 1
    this.input.setAttribute('aria-label', slideId === null ? t('Comment on the whole deck') : t('Comment on this slide'))
    this.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation() // the editor's shortcuts must not fire while typing
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault()
        if (this.send()) hooks.sent()
      }
      if (ev.key === 'Escape') this.input.blur()
      // Up on the first line, Down on the last: the row above or below
      if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.isComposing) {
        const down = ev.key === 'ArrowDown'
        if (this.atEdge(down) && hooks.move(down ? 1 : -1)) ev.preventDefault()
      }
    })
    this.input.addEventListener('input', () => this.grow())
    this.input.addEventListener('focus', () => this.paint())
    // a click in the comment side is not a click on the slide (selection, drag)
    this.root.addEventListener('click', (ev) => ev.stopPropagation())
    this.root.addEventListener('mousedown', (ev) => ev.stopPropagation())
    this.root.append(this.reqs, this.target, this.input)
    this.paint()
  }

  private threads(): Comment[] {
    const list = this.slideId === null ? this.store.doc.requests : this.store.doc.slides.find((s) => s.id === this.slideId)?.comments
    return (list ?? []).filter((c) => c.request)
  }

  private slide(): Slide | undefined {
    return this.slideId === null ? undefined : this.store.doc.slides.find((s) => s.id === this.slideId)
  }

  /** The selection on this row's slide when it is the open one: the request
   *  is aimed at it (a chip says so). */
  private selected(): string[] {
    if (this.slideId === null || this.store.slide?.id !== this.slideId) return []
    return this.store.selection.filter((id) => this.store.slide.elements.some((e) => e.id === id))
  }

  grow() {
    if (!this.input.isConnected || !this.input.offsetWidth) return
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 8 * 19 + 10)}px`
  }

  /** Redraw from the document; cheap when nothing it shows has changed. */
  paint() {
    const reqs = this.threads()
    const s = this.slide()
    const sel = this.selected()
    const sig = JSON.stringify([reqs, this.open, sel, s?.elements.length === 0])
    if (sig === this.sig) return
    this.sig = sig
    hideReply() // its dot may be about to go
    this.reqs.textContent = ''
    const shown = this.open ? reqs : reqs.slice(-1)
    if (reqs.length > 1) {
      const more = el('button', 'ed-row-more', this.open ? t('Show only the latest') : t('{n} earlier', { n: reqs.length - 1 }))
      more.addEventListener('click', () => { this.open = !this.open; this.paint() })
      this.reqs.appendChild(more)
    }
    for (const c of shown) this.reqs.appendChild(this.line(c))
    this.target.textContent = ''
    if (sel.length) {
      const first = this.store.slide.elements.find((e) => e.id === sel[0])
      this.target.append(el('span', '', `${t('About')} ${sel.length > 1 ? t('{n} elements', { n: sel.length }) : elementLabel(first)}`))
    }
    this.target.hidden = !sel.length
    this.input.placeholder = this.slideId === null
      ? (reqs.length ? t('Add another comment on the whole deck…') : t('Comment on the whole deck, e.g. improve the flow…'))
      : s && !s.elements.length && !reqs.length ? t('What should this slide be?')
        : reqs.length ? t('Add another comment…') : t('Add a comment…')
    this.grow()
  }

  private line(c: Comment): HTMLElement {
    const st = requestStatus(c)
    const row = div(`ed-row-req ${st}`)
    // the dot is the status; hovering it shows the agent's reply
    const dot = el('span', 'ed-row-dot')
    dot.dataset.s = st
    dot.tabIndex = 0
    dot.setAttribute('aria-label', [statusWord(st), ...(c.replies ?? []).map((r) => `${r.author}: ${r.text}`)].join(' · '))
    dot.addEventListener('mouseenter', () => showReply(dot, c))
    dot.addEventListener('focus', () => showReply(dot, c))
    dot.addEventListener('mouseleave', hideReply)
    dot.addEventListener('blur', hideReply)
    const text = el('div', 'ed-row-text', c.text)
    const x = el('button', 'ed-row-x', '×')
    x.title = t('Delete')
    x.addEventListener('click', () => removeRequest(this.store, this.slideId, c.id))
    const head = div('ed-row-head')
    head.append(dot, text, x)
    row.append(head)
    return row
  }

  focus() { this.input.focus() }

  /** Focus with the caret at the start (arrived from above) or the end (from below). */
  focusAt(where: 'start' | 'end') {
    this.input.focus({ preventScroll: true })
    const p = where === 'start' ? 0 : this.input.value.length
    this.input.setSelectionRange(p, p)
    this.root.closest('.ed-row')?.scrollIntoView({ block: 'nearest' })
  }

  /** Whether the caret sits on the field's first (Up) or last (Down) line. */
  private atEdge(down: boolean): boolean {
    const ta = this.input
    if (ta.selectionStart !== ta.selectionEnd) return false
    const pos = ta.selectionStart, v = ta.value
    if (down ? v.slice(pos).includes('\n') : v.slice(0, pos).includes('\n')) return false
    if (!v.length || pos === (down ? v.length : 0)) return true
    return caretTop(ta, pos) === caretTop(ta, down ? v.length : 0)
  }

  /** Record what is typed as a request; false when there is nothing. */
  private send(): boolean {
    const text = this.input.value.trim()
    if (!text) return false
    const sel = this.selected()
    const c: Comment = {
      id: uid('req'), request: true, status: 'open', author: authorName(), text, at: new Date().toISOString(),
      ...(sel.length ? { elementId: sel[0] } : {}),
      ...(sel.length > 1 ? { elementIds: sel } : {}),
    }
    const slideId = this.slideId
    quiet(this.store, () => this.store.commit(() => {
      if (slideId === null) { this.store.doc.requests = [...(this.store.doc.requests ?? []), c]; return }
      const s = this.store.doc.slides.find((x) => x.id === slideId)
      if (s) s.comments = [...(s.comments ?? []), c]
    }))
    this.input.value = ''
    this.grow()
    // for a page that carries requests somewhere else (a hosted mirror has no
    // bridge); slideId '' = the whole deck
    window.dispatchEvent(new CustomEvent('tessera-request', { detail: { slideId: slideId ?? '', request: c } }))
    return true
  }
}

function authorName(): string {
  try { return localStorage.getItem('tessera-author') || t('You') } catch { return t('You') }
}

/** On an empty slide (a new one, typically): "What should this slide be?" —
 *  what is typed becomes a request on that slide, for the agent to build. */
export class NewSlidePrompt {
  readonly root = div('ed-newslide')
  private ask: AskBar
  /** off while the review list shows the slide's own comment field */
  private on = true
  constructor(parent: HTMLElement, private store: Store) {
    const card = div('ed-newslide-card')
    card.append(
      el('div', 'ed-newslide-h', t('What should this slide be?')),
      el('div', 'ed-newslide-sub', t('Describe it; the agent builds it here.')),
    )
    this.ask = new AskBar(card, store, { compact: true, placeholder: () => t('e.g. a timeline of the three phases, with a picture') })
    // the canvas under it must not take these clicks (deselect, marquee)
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) card.addEventListener(type, (ev) => ev.stopPropagation())
    this.root.appendChild(card)
    parent.appendChild(this.root)
    store.on('current', () => this.paint())
    store.on('doc', () => this.paint())
    this.paint()
  }

  focus() { this.ask.focus() }

  setActive(on: boolean) { this.on = on; this.paint() }

  private paint() {
    const s = this.store.slide
    this.root.hidden = !this.on || !s || s.elements.length > 0 || !!s.stateOf || !!s.comments?.some((c) => c.request)
  }
}

// --- a slide's requests as cards (the phone dock) ---------------------------------

export class RequestList {
  readonly root = div('ed-reqs')
  private list = div('ed-reqs-list')
  private elsewhere = el('button', 'ed-reqs-elsewhere')
  /** done cards the person opened, and whether older done ones are shown */
  private opened = new Set<string>()
  private showOld = false

  constructor(private store: Store) {
    this.elsewhere.addEventListener('click', () => {
      const next = listRequests(this.store.doc, { open: true }).find((r) => r.slideIndex >= 0 && r.slideIndex !== this.store.currentIndex)
      if (next) this.store.goTo(next.slideIndex)
    })
    this.root.append(this.list, this.elsewhere)
    store.on('current', () => { this.showOld = false; this.refresh() })
    store.on('doc', () => this.refresh())
    window.setInterval(() => this.refresh(), 60_000) // keeps "2 min ago" true
    window.addEventListener('tessera-ask-state', () => this.refresh())
    this.refresh()
  }

  private card(c: Comment, slide: Slide, full: boolean): HTMLElement {
    const status = requestStatus(c)
    const item = div(`ed-req ${status}${full ? '' : ' folded'}`)
    const head = div('ed-req-head')
    head.append(
      el('span', 'ed-req-dot'),
      el('span', 'ed-req-status', statusWord(status)),
      el('span', 'ed-req-time', ago(c.at)),
    )
    if (status === 'open' && !listening) {
      const idle = el('span', 'ed-req-idle', t('no agent listening'))
      idle.title = t('Requests are saved in the deck; the next agent that opens it picks them up')
      head.append(idle)
    }
    const x = el('button', 'ed-req-x', '×')
    x.title = t('Delete')
    x.addEventListener('click', (ev) => { ev.stopPropagation(); removeRequest(this.store, this.store.slide.id, c.id) })
    head.append(x)
    item.append(head, el('div', 'ed-req-text', c.text))
    const ids = c.elementIds ?? (c.elementId ? [c.elementId] : [])
    if (ids.length) {
      const target = slide.elements.find((e) => e.id === ids[0])
      item.append(el('div', 'ed-req-el', ids.length > 1 ? t('{n} elements', { n: ids.length }) : elementLabel(target)))
    }
    for (const r of c.replies ?? []) {
      const a = div('ed-req-reply')
      a.append(el('b', '', r.author), document.createTextNode(' ' + r.text))
      item.appendChild(a)
    }
    if (status === 'done') {
      item.addEventListener('click', () => {
        if (this.opened.has(c.id)) this.opened.delete(c.id)
        else this.opened.add(c.id)
        this.refresh()
      })
    }
    return item
  }

  refresh() {
    const slide = this.store.slide
    if (!slide) return
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24
    this.list.textContent = ''
    const reqs = (slide.comments ?? []).filter((c) => c.request)
    // newest done request stays open (its reply is the news); older ones fold
    // to a line, and past two they hide behind "n earlier"
    const done = reqs.filter((c) => requestStatus(c) === 'done')
    const latestDone = done[done.length - 1]
    const older = done.slice(0, -1)
    const hidden = !this.showOld && older.length > 2 ? new Set(older.slice(0, older.length - 1).map((c) => c.id)) : new Set<string>()
    if (hidden.size) {
      const more = el('button', 'ed-reqs-more', t('{n} earlier requests done · show', { n: hidden.size }))
      more.addEventListener('click', () => { this.showOld = true; this.refresh() })
      this.list.appendChild(more)
    }
    for (const c of reqs) {
      if (hidden.has(c.id)) continue
      const full = requestStatus(c) !== 'done' || c === latestDone || this.opened.has(c.id)
      this.list.appendChild(this.card(c, slide, full))
    }
    if (atBottom) this.list.scrollTop = this.list.scrollHeight
    const others = listRequests(this.store.doc, { open: true }).filter((r) => r.slideIndex >= 0 && r.slideIndex !== this.store.currentIndex)
    const slides = new Set(others.map((r) => r.slideIndex)).size
    this.elsewhere.hidden = !others.length
    this.elsewhere.textContent = t('{n} open on other slides — go to slide {s} →', { n: others.length, s: (others[0]?.slideIndex ?? 0) + 1 })
    this.elsewhere.title = t('{n} open requests on {k} other slides', { n: others.length, k: slides })
  }
}

// --- speaker notes ------------------------------------------------------------

export class NotesView {
  readonly root = div('ed-notes')
  private notes = document.createElement('textarea')
  private foot = div('ed-notes-foot')

  constructor(private store: Store) {
    this.notes.className = 'ed-notes-input'
    this.notes.placeholder = t('Notes for presenter view (press S while presenting)…')
    this.notes.spellcheck = true
    this.notes.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Escape') this.notes.blur()
    })
    // one undo step per typing burst
    let burst = false
    this.notes.addEventListener('input', () => {
      if (!burst) { this.store.checkpoint(); burst = true }
      this.store.slide.notes = this.notes.value
      quiet(this.store, () => this.store.touch())
      this.count()
    })
    this.notes.addEventListener('change', () => { burst = false })
    this.root.append(this.notes, this.foot)
    const sync = () => {
      const v = this.store.slide?.notes ?? ''
      if (document.activeElement !== this.notes && this.notes.value !== v) { this.notes.value = v; this.notes.scrollTop = 0 }
      this.count()
    }
    store.on('current', sync)
    store.on('doc', sync)
    sync()
  }

  private count() {
    const words = (this.notes.value.match(/\S+/g) ?? []).length
    this.foot.textContent = words
      ? t('{words} words · ~{min} min · speaker view (S)', { words, min: Math.max(1, Math.round(words / 130)) })
      : t('Shown in speaker view (S)')
  }
}
