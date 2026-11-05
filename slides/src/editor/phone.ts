// SPDX-License-Identifier: MIT
// The phone view of the editor: read the deck and ask for changes, nothing else.
//
// On a phone the person does not edit (the author, 2026-10-22: "I probably just
// need to see the slides … and also the box for suggestions"). So the desktop
// chrome is hidden and this view shows every slide stacked in one vertical
// scroll, each fitted to the screen width, with this slide's requests and the
// ask bar docked at the bottom. They are the SAME RequestList and AskBar the
// desktop shows (moved, not copied), bound to the slide most in view through the store's
// current slide, so a request is committed by exactly the same code.
//
// Lean on purpose: a card is painted only when it comes near the screen, and a
// card's figures (embed frames) run only while the card is on screen; off
// screen it shows the posters again. Nothing here edits a slide.

import type { Store } from '../store'
import type { EmbedElement, Slide } from '../model'
import { postChangedTexts, renderSlide, sameLook, slideLook, watchEmbedTexts } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'
import type { AskBar, RequestList } from './ask'

/** Narrow screens, and touch screens up to a small tablet. Decided by the
 *  browser, re-evaluated when it changes (rotation, a resized window). */
export const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px)'

/** `?view=phone` / `?view=desktop` in the address forces one or the other. */
function override(): boolean | null {
  try {
    const v = new URLSearchParams(location.search).get('view')
    return v === 'phone' ? true : v === 'desktop' ? false : null
  } catch { return null }
}

/** Calls `apply(on)` now and whenever the answer changes. */
export function watchPhone(apply: (on: boolean) => void) {
  const forced = override()
  if (forced !== null) { apply(forced); return }
  const mq = window.matchMedia(PHONE_QUERY)
  apply(mq.matches)
  mq.addEventListener('change', () => apply(mq.matches))
}

const div = (cls: string) => Object.assign(document.createElement('div'), { className: cls })

/** Elements whose live and still renderings differ. */
const LIVE_TYPES = new Set(['embed', 'video', 'audio', 'svg'])

interface Card {
  id: string
  root: HTMLElement
  num: HTMLElement
  frame: HTMLElement
  painted: '' | 'still' | 'live'
  near: boolean
  onScreen: boolean
  /** what the last paint showed: slide JSON without its comments and figure
   *  texts, the assets it names, and the texts its running figures hold */
  sig: string
  assets: string[]
  texts: Map<string, string>
}

export class PhoneView {
  readonly root = div('ed-phone-view')
  private list = div('ed-phone-list')
  private dock = div('ed-phone-dock')
  private title = div('ed-phone-title')
  private counter = div('ed-phone-count')
  private cards = new Map<string, Card>()
  private order: string[] = []
  private active = false
  private homes: Array<[HTMLElement, HTMLElement | null, Node | null]> = []
  private nearObs: IntersectionObserver | null = null
  private seenObs: IntersectionObserver | null = null
  private scrollRaf = 0
  /** the store moved because of our own scroll: do not scroll back */
  private fromScroll = false
  private docSig = ''
  private off: Array<() => void> = []

  constructor(host: HTMLElement, private store: Store, private requests: RequestList, private ask: AskBar, private present: () => void) {
    const head = div('ed-phone-head')
    const play = document.createElement('button')
    play.className = 'ed-btn ed-phone-play'
    play.innerHTML = ICONS.slideshow
    play.title = t('Slideshow')
    play.setAttribute('aria-label', t('Slideshow'))
    play.addEventListener('click', () => this.present())
    head.append(this.title, this.counter, play)
    this.root.append(head, this.list, this.dock)
    this.root.hidden = true
    host.appendChild(this.root)

    // a tap on a slide (outside a running figure) aims the box at it
    this.list.addEventListener('click', (ev) => {
      const card = (ev.target as HTMLElement).closest<HTMLElement>('.ed-phone-card')
      const i = card ? this.store.doc.slides.findIndex((s) => s.id === card.dataset.slideId) : -1
      if (i >= 0 && i !== this.store.currentIndex) { this.fromScroll = true; this.store.goTo(i); this.fromScroll = false }
    })
    this.list.addEventListener('scroll', () => {
      if (!this.scrollRaf) this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = 0; this.pickFromScroll() })
    }, { passive: true })
    new ResizeObserver(() => this.fit()).observe(this.list)
    // a frame reloaded by a card moving gets texts that moved on since its
    // srcdoc; a figure that drew a changed text from script is repainted
    watchEmbedTexts((source) => {
      if (!this.active) return undefined
      const frame = [...this.list.querySelectorAll('iframe')].find((f) => f.contentWindow === source)
      const card = frame && this.cards.get(frame.closest<HTMLElement>('.ed-phone-card')?.dataset.slideId ?? '')
      const id = frame?.closest<HTMLElement>('[data-el-id]')?.dataset.elId
      const el = card && id ? this.slideOf(card)?.elements.find((e) => e.id === id) : undefined
      return frame && el?.type === 'embed' ? { frame, el: el as EmbedElement } : undefined
    }, (frame) => {
      const c = this.cards.get(frame.closest<HTMLElement>('.ed-phone-card')?.dataset.slideId ?? '')
      if (c) this.paint(c)
    })
  }

  activate() {
    if (this.active) return
    this.active = true
    this.root.hidden = false
    // the desktop's request list and ask bar move into the dock (and back)
    this.homes = [this.requests.root, this.ask.root].map((n) => [n, n.parentElement, n.nextSibling])
    this.dock.append(this.requests.root, this.ask.root)
    this.nearObs = new IntersectionObserver((es) => this.onNear(es), { root: this.list, rootMargin: '150% 0px' })
    this.seenObs = new IntersectionObserver((es) => this.onSeen(es), { root: this.list, threshold: 0 })
    this.off.push(
      this.store.on('slides', () => this.syncCards()),
      this.store.on('doc', () => this.onDoc()),
      this.store.on('current', () => this.onCurrent()),
    )
    this.trackKeyboard()
    this.docSig = this.sigOfDoc()
    this.syncCards()
    this.fit()
    this.onCurrent(true)
  }

  deactivate() {
    if (!this.active) return
    this.active = false
    this.root.hidden = true
    this.off.forEach((f) => f()); this.off = []
    this.nearObs?.disconnect(); this.seenObs?.disconnect()
    this.nearObs = this.seenObs = null
    // drop every card: their frames must not keep running behind the desktop
    this.list.textContent = ''
    this.cards.clear(); this.order = []
    for (const [n, parent, next] of this.homes) parent?.insertBefore(n, next)
    this.homes = []
  }

  // --- cards ------------------------------------------------------------------

  /** One card per slide, in deck order; cards are reused by slide id. */
  private syncCards() {
    if (!this.active) return
    const ids = this.store.doc.slides.map((s) => s.id)
    const same = ids.length === this.order.length && ids.every((id, i) => id === this.order[i])
    if (!same) {
      for (const [id, c] of this.cards) {
        if (!ids.includes(id)) { this.nearObs?.unobserve(c.root); this.seenObs?.unobserve(c.root); c.root.remove(); this.cards.delete(id) }
      }
      ids.forEach((id) => {
        let c = this.cards.get(id)
        if (!c) {
          c = this.makeCard(id)
          this.cards.set(id, c)
          this.nearObs?.observe(c.root)
          this.seenObs?.observe(c.root)
        }
        this.list.appendChild(c.root) // appending an existing node moves it: deck order
      })
      this.order = ids
      // page numbers ({{page}}) shift with the order
      for (const c of this.cards.values()) if (c.painted) this.paint(c)
    }
    this.number()
    this.title.textContent = this.store.doc.title
    this.mark()
  }

  private makeCard(id: string): Card {
    const root = div('ed-phone-card')
    root.dataset.slideId = id
    const num = div('ed-phone-num')
    const frame = div('ed-phone-frame')
    root.append(num, frame)
    return { id, root, num, frame, painted: '', near: false, onScreen: false, sig: '', assets: [], texts: new Map() }
  }

  private number() {
    const slides = this.store.doc.slides
    slides.forEach((s, i) => {
      const c = this.cards.get(s.id)
      if (!c) return
      c.num.textContent = `${i + 1}`
      c.root.classList.toggle('state', !!s.stateOf)
    })
  }

  private slideOf(c: Card): Slide | undefined {
    return this.store.doc.slides.find((s) => s.id === c.id)
  }

  /** The slide as the card shows it: content without its request threads (a
   *  reply arriving must not reload a running figure) and without its figure
   *  texts (posted into the frames), plus the assets it names. */
  private sigOf(slide: Slide) {
    return slideLook(slide, this.store.doc)
  }

  private sigOfDoc(): string {
    const d = this.store.doc
    return JSON.stringify([d.title, d.size, d.theme, d.fonts?.length ?? 0])
  }

  private paint(c: Card) {
    const slide = this.slideOf(c)
    if (!slide) return
    const live = c.onScreen && slide.elements.some((e) => LIVE_TYPES.has(e.type))
    const surface = renderSlide(slide, this.store.doc, live
      ? { liveMedia: true, hidePlaceholders: true }
      : { svgAsImage: true, hidePlaceholders: true })
    // hover-reveal slides show one set at a time, as on the edit canvas
    const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
    if (sets.length) {
      const shown = slide.hover?.default ?? sets[0]
      for (const node of surface.querySelectorAll<HTMLElement>('[data-show-on-hover]')) {
        if (node.dataset.showOnHover !== shown) node.style.display = 'none'
      }
    }
    surface.classList.add('ed-phone-surface')
    c.frame.replaceChildren(surface)
    c.painted = live ? 'live' : 'still'
    const s = this.sigOf(slide)
    c.sig = s.sig
    c.assets = s.assets
    c.texts = s.texts
  }

  private onNear(es: IntersectionObserverEntry[]) {
    for (const e of es) {
      const c = this.cards.get((e.target as HTMLElement).dataset.slideId ?? '')
      if (!c) continue
      c.near = e.isIntersecting
      if (c.near && !c.painted) this.paint(c)
    }
  }

  private onSeen(es: IntersectionObserverEntry[]) {
    for (const e of es) {
      const c = this.cards.get((e.target as HTMLElement).dataset.slideId ?? '')
      if (!c) continue
      c.onScreen = e.isIntersecting
      const slide = this.slideOf(c)
      const wantLive = c.onScreen && !!slide?.elements.some((el) => LIVE_TYPES.has(el.type))
      // a figure runs only while its card is on screen
      if (c.painted ? (c.painted === 'live') !== wantLive : c.onScreen) this.paint(c)
    }
  }

  /** A document change: repaint only the cards whose slide (or an asset it
   *  names) changed. A request or a reply changes no card; a change to a
   *  figure's texts alone is posted into its running frame. */
  private onDoc() {
    if (!this.active) return
    this.syncCards()
    const scope = this.store.scope
    const docSig = this.sigOfDoc()
    const everything = docSig !== this.docSig
    this.docSig = docSig
    for (const c of this.cards.values()) {
      if (!c.painted || (scope && !scope.has(c.id) && !everything)) continue
      const slide = this.slideOf(c)
      if (!slide) continue
      const s = this.sigOf(slide)
      if (everything || !sameLook(s, c)) { this.paint(c); continue }
      // a still card shows posters, which never carried the texts
      if (c.painted === 'live') postChangedTexts(c.frame, slide, c.texts, s.texts)
      c.texts = s.texts
    }
    this.title.textContent = this.store.doc.title
  }

  // --- the slide the box is about ----------------------------------------------

  /** The slide covering most of the list follows the scroll, except while the
   *  person is typing: then the box stays on the slide it was opened for. */
  private pickFromScroll() {
    if (!this.active || this.typing()) return
    const box = this.list.getBoundingClientRect()
    let best = -1, bestPx = 0
    this.store.doc.slides.forEach((s, i) => {
      const c = this.cards.get(s.id)
      if (!c) return
      const r = c.root.getBoundingClientRect()
      const px = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)
      if (px > bestPx + 1) { best = i; bestPx = px }
    })
    if (best >= 0 && best !== this.store.currentIndex) {
      this.fromScroll = true
      this.store.goTo(best)
      this.fromScroll = false
    }
  }

  private typing(): boolean {
    return document.activeElement?.classList.contains('ed-agent-input') ?? false
  }

  private onCurrent(initial = false) {
    if (!this.active) return
    this.mark()
    // moved from elsewhere (keyboard, the live mirror following an edit): show it
    if (!this.fromScroll) this.reveal(initial ? 'auto' : 'smooth')
  }

  private mark() {
    const id = this.store.slide?.id
    for (const c of this.cards.values()) c.root.classList.toggle('on', c.id === id)
    const n = this.store.currentIndex + 1
    this.counter.textContent = `${n} / ${this.store.doc.slides.length}`
  }

  private reveal(behavior: ScrollBehavior) {
    const c = this.cards.get(this.store.slide?.id ?? '')
    if (!c) return
    const top = c.root.offsetTop - this.list.offsetTop - 8
    this.list.scrollTo({ top, behavior })
  }

  // --- size ---------------------------------------------------------------------

  /** Every slide is as wide as the screen allows. */
  private fit() {
    if (!this.active) return
    const { width, height } = this.store.doc.size
    const w = this.list.clientWidth - 24 // the 12px gutters
    if (w <= 0) return
    this.list.style.setProperty('--ed-phone-scale', `${w / width}`)
    this.list.style.setProperty('--ed-phone-ratio', `${width} / ${height}`)
    this.list.style.setProperty('--ed-phone-w', `${width}px`)
    this.list.style.setProperty('--ed-phone-h', `${height}px`)
  }

  /** The view is sized to the VISUAL viewport, so the on-screen keyboard
   *  shrinks it from below and the box stays above the keyboard. */
  private trackKeyboard() {
    const vv = window.visualViewport
    if (!vv) return
    const place = () => {
      if (!this.active) return
      this.root.style.top = `${vv.offsetTop}px`
      this.root.style.height = `${vv.height}px`
      this.root.style.setProperty('--ed-phone-vh', `${vv.height}px`)
      // the slide the box is about stays in sight above it
      // (scrolling the list only: scrollIntoView would also scroll the page)
      const c = this.typing() ? this.cards.get(this.store.slide?.id ?? '') : undefined
      if (c) {
        const box = this.list.getBoundingClientRect(), r = c.root.getBoundingClientRect()
        if (r.bottom > box.bottom) this.list.scrollTop += r.bottom - box.bottom + 8
        else if (r.top < box.top) this.list.scrollTop -= box.top - r.top + 8
      }
    }
    vv.addEventListener('resize', place)
    vv.addEventListener('scroll', place)
    this.off.push(() => {
      vv.removeEventListener('resize', place)
      vv.removeEventListener('scroll', place)
      this.root.style.top = this.root.style.height = ''
    })
    place()
  }
}
