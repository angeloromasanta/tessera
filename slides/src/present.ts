// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Present mode: a fullscreen Reveal.js overlay generated from the model.
// Slides marked transition:'morph' use GSAP Flip to animate elements whose
// ids match across the two slides (PowerPoint "Morph" behaviour).

import Reveal from 'reveal.js'
import 'reveal.js/dist/reveal.css'
import { anim, resetXform } from './anim'
import { chartSnapshotSvg, mountChart } from './charts'
import type { TesseraDoc, GradientFill, PollElement, ShapeElement, Slide, SlideElement } from './model'
import { morphKey, precedingPoll, quizStats, ratingScale, ratingStats, tallyChoices } from './model'
import { applyElementFrame, gradientLineCoords, renderPollAsk, renderPollBars, renderPollBody, renderSlide, summaryHtml } from './render'
import { activityPageWithTexts, claimSession, ensureLecturerKey, fetchPoll, publishActive, publishActivityHtml, summarizePoll, type PollAnswer } from './poll'
import { paintSpeaker, setSpeakerWindow, speakerIdleBody, speakerWindow } from './screens'
import { t } from './i18n'
import { frameMsg, msgKind } from './legacy'

const MORPH_DURATION = 0.65
const MORPH_EASE = 'power2.inOut'

export interface PresentSession {
  exit(): void
}

export function startPresentation(
  doc: TesseraDoc,
  startIndex: number,
  onExit: (lastIndex: number) => void,
  opts: {
    fullscreen?: boolean
    /** Called when a poll is summarized on a slide. present.ts holds `doc` but
     *  not the store, so the editor supplies the commit — that keeps the summary
     *  in the undo history and on the normal save paths. */
    onPollSummary?: (elId: string, summary: string) => void
  } = {},
): PresentSession {
  const overlay = document.createElement('div')
  overlay.className = 'tessera-present-overlay'
  overlay.style.setProperty('--tessera-accent', doc.theme.accent)
  // Reveal ignores key events originating from form fields. If focus is still
  // on an editor input (title, notes…) when the show starts, arrows go dead.
  ;(document.activeElement as HTMLElement | null)?.blur?.()

  const revealEl = document.createElement('div')
  revealEl.className = 'reveal'
  const slidesEl = document.createElement('div')
  slidesEl.className = 'slides'
  revealEl.appendChild(slidesEl)
  overlay.appendChild(revealEl)

  doc.slides.forEach((slide) => {
    const section = document.createElement('section')
    // Morph slides swap instantly; the Flip animation supplies the motion.
    section.dataset.transition = slide.transition === 'morph' ? 'none' : slide.transition
    if (slide.stateOf) section.dataset.tesseraState = '1' // dimmed in overview
    const surface = renderSlide(slide, doc, { hidePlaceholders: true, liveMedia: true })
    // reveal slides start with only the default hover set visible
    if (slide.hover?.type === 'reveal') applyRevealSet(surface, slide.hover.default ?? null, slide.hover.default)
    section.appendChild(surface)
    if (slide.notes) {
      const aside = document.createElement('aside')
      aside.className = 'notes'
      aside.textContent = slide.notes
      section.appendChild(aside)
    }
    slidesEl.appendChild(section)
  })

  document.body.appendChild(overlay)

  // ——— state-aware linear navigation ———
  // Slides with stateOf are interactive states: linked-to, never walked-to.
  const isState = (i: number) => !!doc.slides[i]?.stateOf
  const anchorOf = (i: number) => {
    const pid = doc.slides[i]?.stateOf
    const p = doc.slides.findIndex((s) => s.id === pid)
    return p >= 0 ? p : i
  }
  const goNext = () => {
    const cur = deck.getIndices().h
    for (let i = (isState(cur) ? anchorOf(cur) : cur) + 1; i < doc.slides.length; i++) {
      if (!isState(i)) return deck.slide(i, 0)
    }
  }
  const goPrev = () => {
    const cur = deck.getIndices().h
    if (isState(cur)) return deck.slide(anchorOf(cur), 0)
    for (let i = cur - 1; i >= 0; i--) {
      if (!isState(i)) return deck.slide(i, 0)
    }
  }
  const hasNext = () => {
    const cur = deck.getIndices().h
    for (let i = (isState(cur) ? anchorOf(cur) : cur) + 1; i < doc.slides.length; i++) {
      if (!isState(i)) return true
    }
    return false
  }
  const hasPrev = () => {
    const cur = deck.getIndices().h
    if (isState(cur)) return true // right-swipe returns to the parent slide
    for (let i = cur - 1; i >= 0; i--) {
      if (!isState(i)) return true
    }
    return false
  }
  const visibleIndex = (i: number) => doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
  const visibleTotal = doc.slides.filter((s) => !s.stateOf).length
  // real slide indices that appear in linear navigation (states are excluded) —
  // the presenter-view thumbnail rail and grid iterate this.
  const railIndices = doc.slides.map((_, i) => i).filter((i) => !isState(i))
  const goFirst = () => deck.slide(railIndices[0] ?? 0, 0)
  const goLast = () => deck.slide(railIndices[railIndices.length - 1] ?? 0, 0)

  // ——— black-screen (audience blackout; presenter keeps notes) ———
  let blacked = false
  const blackout = document.createElement('div')
  blackout.className = 'tessera-blackout'
  blackout.hidden = true
  overlay.appendChild(blackout)
  const setBlack = (on: boolean) => {
    blacked = on
    blackout.hidden = !on
    updateSpeakerControls()
  }
  const toggleBlack = () => setBlack(!blacked)

  // ——— reduced motion (a VIEWER/PRESENTER preference, never in the doc) ———
  // Defaults to the OS 'prefers-reduced-motion'; an explicit toggle (M, or the
  // speaker view) overrides it and persists per browser. When on, slide
  // transitions cut instantly and every fx animation (morph, entrances,
  // count-ups, loops, ken-burns) is skipped — elements just show their final
  // state. The '.reduce-motion' class also neutralises CSS motion (svg
  // animations, Reveal's section transitions). Mirrors how locale/auto-check
  // are viewer prefs that never enter the document format.
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const readMotionPref = (): boolean | null => {
    try {
      const v = localStorage.getItem('tessera-reduce-motion')
      return v === 'on' ? true : v === 'off' ? false : null
    } catch { return null }
  }
  let reduceMotion = readMotionPref() ?? reduceQuery.matches
  overlay.classList.toggle('reduce-motion', reduceMotion)

  let exited = false
  const deck = new Reveal(revealEl, {
    embedded: true,
    width: doc.size.width,
    height: doc.size.height,
    margin: 0,
    // Reveal's default maxScale is 2.0 — on a 1280-wide deck that caps the show
    // at 2560px and letterboxes it in the middle of large displays (a 4K/5K/8K
    // screen shows a small centred slide). Deck content is vector/text, so it
    // upscales crisply: allow it to fill any display. minScale stays generous
    // for tiny embeds.
    minScale: 0.1,
    maxScale: 100,
    center: false,
    hash: false,
    history: false,
    transition: 'fade',
    transitionSpeed: 'default',
    backgroundTransition: 'fade',
    controls: doc.present?.controls ?? false, // links/keys navigate; corner arrows are clutter
    progress: doc.present?.progress ?? true,
    slideNumber: (doc.present?.slideNumber ?? true)
      ? (((slideEl: HTMLElement) => {
          const i = [...slidesEl.children].indexOf(slideEl)
          return [`${visibleIndex(i)} / ${visibleTotal}`]
        }) as any)
      : false,
    // touch is handled by our own swipe logic below (state-aware + ends exit)
    touch: false,
    // heavy decks: paint only the neighbourhood of the current slide
    viewDistance: 1,
    keyboardCondition: null,
    plugins: [],
  })

  const onResize = () => deck.layout()

  // ——— speaker view (S) ———
  // Reveal's stock speaker window reloads the presentation URL in iframes —
  // which in a deck file boots the EDITOR. Instead: our own popup, rendered
  // with the same renderer from this one app instance and synced directly.
  let speaker: Window | null = null
  let speakerTimer = 0
  let speakerStart = 0
  // opening the speaker popup drops the main window out of OS fullscreen on most
  // browsers; this guards the fullscreenchange handler so that bounce doesn't
  // end the show (see onFsChange).
  let openingSpeaker = false
  // Reveal reports valid indices only after initialize(). The speaker view can
  // be opened (from the editor) before that, so gate any deck.getIndices() read
  // and re-populate once the deck is ready.
  let deckReady = false
  // true when we adopted a speaker window the EDITOR opened — we drive it but
  // must not close it on exit (it lives beyond this present session).
  let speakerAdopted = false
  // Second-screen placement is set up in the EDITOR (properties panel) before
  // presenting — that's where the Window Management permission is granted via a
  // dedicated gesture, and the layout is cached in ../screens. Here we just read
  // the chosen display synchronously when the notes open.
  const nextVisibleIndex = (from: number) => {
    for (let i = (isState(from) ? anchorOf(from) : from) + 1; i < doc.slides.length; i++) {
      if (!isState(i)) return i
    }
    return -1
  }
  const svSlide = (idx: number, w: number): HTMLElement => {
    const frame = document.createElement('div')
    frame.className = 'sv-frame'
    const scale = w / doc.size.width
    frame.style.width = `${w}px`
    frame.style.height = `${doc.size.height * scale}px`
    if (idx >= 0) {
      const inner = document.createElement('div')
      inner.style.cssText = `transform:scale(${scale});transform-origin:0 0`
      inner.appendChild(renderSlide(doc.slides[idx], doc, { hidePlaceholders: true }))
      frame.appendChild(inner)
    } else {
      frame.classList.add('end')
      frame.textContent = t('End of deck')
    }
    return frame
  }
  // Cheap, one-shot update of just the controls (highlight, counter, button
  // states) — called on every slidechange AND on black toggle without re-rendering
  // the (expensive) current/next slides or the thumbnail rail.
  const updateSpeakerControls = () => {
    if (!speaker || speaker.closed || !deckReady) return
    const d = speaker.document
    const cur = deck.getIndices().h
    const anchor = isState(cur) ? anchorOf(cur) : cur
    const count = d.querySelector('.sv-count')
    if (count) count.textContent = `${visibleIndex(cur)} / ${visibleTotal}`
    d.querySelectorAll<HTMLElement>('.sv-thumb').forEach((th) => {
      const on = Number(th.dataset.idx) === anchor
      th.classList.toggle('current', on)
      if (on && th.closest('.sv-rail')) th.scrollIntoView({ block: 'nearest', inline: 'center' })
    })
    const nav = (k: string) => d.querySelector<HTMLButtonElement>(`.sv-btn[data-nav="${k}"]`)
    nav('prev')?.toggleAttribute('disabled', !hasPrev())
    nav('first')?.toggleAttribute('disabled', !hasPrev())
    nav('next')?.toggleAttribute('disabled', !hasNext())
    nav('last')?.toggleAttribute('disabled', !hasNext())
    nav('black')?.classList.toggle('active', blacked)
    nav('reduce')?.classList.toggle('active', reduceMotion)
  }

  // A brief centred pill so a keypress (M) gives visible confirmation — the
  // audience overlay otherwise changes silently.
  let toastTimer = 0
  const flashPresentMsg = (text: string) => {
    let el = overlay.querySelector<HTMLElement>('.tessera-present-toast')
    if (!el) { el = document.createElement('div'); el.className = 'tessera-present-toast'; overlay.appendChild(el) }
    el.textContent = text
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show') // restart the fade
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => el!.classList.remove('show'), 1400)
  }

  const setReduceMotion = (on: boolean, persist = true) => {
    reduceMotion = on
    if (persist) { try { localStorage.setItem('tessera-reduce-motion', on ? 'on' : 'off') } catch { /* storage off */ } }
    overlay.classList.toggle('reduce-motion', on)
    // Toast only on an explicit toggle (M / speaker button), not the silent
    // OS-preference follow or the initial state.
    if (persist) flashPresentMsg(on ? t('Reduced motion: on') : t('Reduced motion: off'))
    // Re-settle the CURRENT slide: kill any running tweens and restore final
    // frames (a killed entrance would otherwise strand an element at opacity 0);
    // if motion is back on, replay this slide's entrance + ambient fx.
    if (deckReady) {
      const cur = deck.getIndices().h
      const section = slidesEl.children[cur] as HTMLElement | undefined
      const slide = doc.slides[cur]
      if (section && slide) {
        anim.killTweensOf(section.querySelectorAll('.tessera-el'))
        for (const el of slide.elements) {
          const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
          if (node) { applyElementFrame(node, el); resetXform(node) }
        }
        if (!on) { runEnterFx(slide, section); runAmbientFx(slide, section); restartSvgAnimations(section) }
      }
    }
    updateSpeakerControls()
  }
  const toggleReduceMotion = () => setReduceMotion(!reduceMotion)
  // Follow later OS changes ONLY while the user hasn't set an explicit choice.
  const onMotionQuery = (e: MediaQueryListEvent) => { if (readMotionPref() === null) setReduceMotion(e.matches, false) }
  reduceQuery.addEventListener?.('change', onMotionQuery)

  const updateSpeaker = () => {
    if (!speaker || speaker.closed) return
    if (!deckReady) return // opened pre-init — populated on ready
    const d = speaker.document
    const cur = deck.getIndices().h
    const nxt = nextVisibleIndex(cur)
    const curBox = d.querySelector('.sv-current')
    const nxtBox = d.querySelector('.sv-nextbox')
    if (!curBox || !nxtBox) return
    curBox.innerHTML = ''
    curBox.appendChild(d.importNode(svSlide(cur, 660), true))
    nxtBox.innerHTML = ''
    nxtBox.appendChild(d.importNode(svSlide(nxt, 300), true))
    const notes = d.querySelector('.sv-notes')
    if (notes) notes.textContent = doc.slides[cur]?.notes || t('— no notes for this slide —')
    updateSpeakerControls()
  }
  const openSpeaker = () => {
    if (speaker && !speaker.closed) {
      speaker.focus()
      return
    }
    // guard the whole open + fullscreen-restore dance: the popup makes the
    // browser leave fullscreen, and without this that would end the show
    const wasFullscreen = document.fullscreenElement === overlay
    openingSpeaker = true
    // ADOPT a window the editor already opened (the clean two-gesture path:
    // opened in its own gesture, never fought fullscreen for this click's
    // activation, never trapped in the fullscreen Space). Only open a fresh one —
    // on THIS display — when none was pre-opened (e.g. S pressed mid-show).
    const pre = speakerWindow()
    if (pre) {
      speaker = pre
      speakerAdopted = true
    } else {
      speaker = window.open('', 'tessera-speaker', 'width=1200,height=800')
      speakerAdopted = false
    }
    if (!speaker) { openingSpeaker = false; console.warn('[tessera-speaker] popup blocked — allow pop-ups for this site'); return }
    setSpeakerWindow(speaker)
    ;(window as unknown as Record<string, unknown>).__tesseraSpeaker = speaker // diagnostics
    const d = speaker.document
    d.title = `${doc.title} — ${t('Speaker view')}`
    if (!d.head.querySelector('style')) { // already styled when adopting an editor window
      for (const st of document.querySelectorAll('style')) d.head.appendChild(d.importNode(st, true))
    }
    d.body.className = 'tessera-speaker'
    const navBtn = (k: string, glyph: string, label: string) =>
      `<button class="sv-btn" data-nav="${k}" title="${label}" aria-label="${label}">${glyph}</button>`
    d.body.innerHTML =
      `<div class="sv-top">` +
        `<div class="sv-timer" title="${t('Click to reset')}">00:00</div>` +
        `<div class="sv-clock"></div>` +
        `<div class="sv-count"></div>` +
        `<div class="sv-ctrls">` +
          navBtn('first', '⇤', t('First slide')) +
          navBtn('prev', '‹', t('Previous')) +
          navBtn('next', '›', t('Next')) +
          navBtn('last', '⇥', t('Last slide')) +
          navBtn('black', '■', t('Black screen (B)')) +
          navBtn('grid', '▦', t('All slides (G)')) +
          navBtn('reduce', '⏸', t('Reduce motion (M)')) +
        `</div>` +
      `</div>` +
      `<div class="sv-main">` +
        `<div class="sv-current"></div>` +
        `<div class="sv-side">` +
          `<div class="sv-next-wrap"><div class="sv-label">${t('Next')}</div><div class="sv-nextbox"></div></div>` +
          `<div class="sv-notes-wrap"><div class="sv-label">${t('Notes')}</div><div class="sv-notes"></div></div>` +
        `</div>` +
      `</div>` +
      `<div class="sv-rail"></div>` +
      `<div class="sv-grid" hidden><div class="sv-grid-inner"></div></div>`

    speakerStart = performance.now()
    d.querySelector('.sv-timer')?.addEventListener('click', () => { speakerStart = performance.now() })
    clearInterval(speakerTimer)
    speakerTimer = window.setInterval(() => {
      if (!speaker || speaker.closed) { clearInterval(speakerTimer); return }
      const el = speaker.document.querySelector('.sv-timer')
      if (el) {
        const s = Math.floor((performance.now() - speakerStart) / 1000)
        el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      }
      const clock = speaker.document.querySelector('.sv-clock')
      if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }, 1000)

    // a clickable thumbnail: an imported slide render inside a button, badged
    // with its slide number; clicking jumps the live show there.
    const thumb = (idx: number, w: number): HTMLElement => {
      const b = d.createElement('button')
      b.className = 'sv-thumb'
      b.dataset.idx = String(idx)
      b.appendChild(d.importNode(svSlide(idx, w), true))
      const num = d.createElement('span')
      num.className = 'sv-thumb-n'
      num.textContent = String(visibleIndex(idx))
      b.appendChild(num)
      b.addEventListener('click', () => { deck.slide(idx, 0); toggleGrid(false) })
      return b
    }

    const rail = d.querySelector('.sv-rail')!
    for (const idx of railIndices) rail.appendChild(thumb(idx, 150))

    // all-slides grid overlay — built lazily on first open (cheap for small decks,
    // but a big deck shouldn't pay for it unless the presenter asks).
    const grid = d.querySelector('.sv-grid') as HTMLElement
    const gridInner = d.querySelector('.sv-grid-inner')!
    let gridBuilt = false
    const toggleGrid = (on?: boolean) => {
      const show = on ?? grid.hasAttribute('hidden')
      if (show && !gridBuilt) { for (const idx of railIndices) gridInner.appendChild(thumb(idx, 240)); gridBuilt = true }
      grid.toggleAttribute('hidden', !show)
      if (show) updateSpeakerControls()
    }
    grid.addEventListener('click', (ev) => { if (ev.target === grid) toggleGrid(false) })

    const doNav = (k: string) => {
      if (k === 'first') goFirst()
      else if (k === 'prev') goPrev()
      else if (k === 'next') goNext()
      else if (k === 'last') goLast()
      else if (k === 'black') toggleBlack()
      else if (k === 'grid') toggleGrid()
      else if (k === 'reduce') toggleReduceMotion()
    }
    d.querySelectorAll<HTMLButtonElement>('.sv-btn[data-nav]').forEach((b) => {
      b.addEventListener('click', () => doNav(b.dataset.nav!))
    })

    // drive the show FROM the speaker window (its keys fire in its own document)
    d.addEventListener('keydown', (ev: KeyboardEvent) => {
      const k = ev.key
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { ev.preventDefault(); stepOrNavigate(1, k) }
      else if (k === 'ArrowLeft' || k === 'PageUp') { ev.preventDefault(); stepOrNavigate(-1, k) }
      else if (k === 'n') { ev.preventDefault(); goNext() }
      else if (k === 'p') { ev.preventDefault(); goPrev() }
      else if (k === 'Home') { ev.preventDefault(); goFirst() }
      else if (k === 'End') { ev.preventDefault(); goLast() }
      else if (k === 'b' || k === 'B') { ev.preventDefault(); toggleBlack() }
      else if (k === 'g' || k === 'G') { ev.preventDefault(); toggleGrid() }
      else if (k === 'm' || k === 'M') { ev.preventDefault(); toggleReduceMotion() }
      else if (k === 'Escape' && !grid.hasAttribute('hidden')) { ev.preventDefault(); toggleGrid(false) }
    })

    updateSpeaker()
    if (!speakerAdopted && wasFullscreen) {
      // A fresh window on THIS display sits behind the fullscreen slides — drop
      // fullscreen so the notes are visible. (Open notes from the Slide panel and
      // drag them to a second screen to keep the slides fullscreen.)
      document.exitFullscreen?.().catch(() => {})
    }
    window.setTimeout(() => { openingSpeaker = false }, 500)
  }

  // Real fullscreen (F toggles; Present enters it by default). The overlay
  // element is what goes fullscreen, so the speaker popup stays independent.
  // Requests can be denied (iframes, no user activation) — tab-fill mode is
  // the graceful floor, and stays the mode for testing/sharing via F.
  /**
   * Keep the screen awake for the length of the show.
   *
   * This matters most on a PHONE, which is where a shared deck usually gets
   * presented from: iOS dims and locks on its own idle timer, and a presenter
   * advancing a slide every couple of minutes trips it mid-talk. Desktop
   * benefits too — fullscreen alone does not defeat a screensaver.
   *
   * Best-effort by construction: the API is absent on older iOS (<16.4) and
   * Firefox, and the request is REJECTED unless the page is visible, so this
   * must never throw into the caller. The lock is also dropped by the browser
   * whenever the tab is hidden — switching apps mid-show and coming back would
   * otherwise leave the screen sleeping again — so re-acquire on visibility.
   */
  let wakeLock: { release(): Promise<void> } | null = null
  const acquireWakeLock = async () => {
    const wl = (navigator as any).wakeLock
    if (!wl || wakeLock || document.visibilityState !== 'visible') return
    try { wakeLock = await wl.request('screen') } catch { /* denied or unsupported */ }
  }
  const releaseWakeLock = () => {
    const held = wakeLock
    wakeLock = null
    void held?.release?.().catch(() => {})
  }
  const onVisibility = () => { if (document.visibilityState === 'visible') void acquireWakeLock() }
  document.addEventListener('visibilitychange', onVisibility)
  void acquireWakeLock()

  const enterFullscreen = () => {
    overlay.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else enterFullscreen()
  }
  // leaving fullscreen — Esc, F, the browser's own UI, an OS gesture —
  // ends the show outright; it never drops into tab-fill mode. (Tab mode
  // is only ever entered deliberately, via the small present button.)
  let wentFullscreen = false
  const onFsChange = () => {
    if (document.fullscreenElement === overlay) wentFullscreen = true
    else if (wentFullscreen && !exited && !openingSpeaker) exit()
  }
  document.addEventListener('fullscreenchange', onFsChange)
  if (opts.fullscreen !== false) enterFullscreen()
  // If the editor already opened notes on the second screen, go live on that
  // existing window now — no new window.open, so fullscreen above kept this
  // click's activation and the notes were never trapped in the fullscreen Space.
  if (speakerWindow()) openSpeaker()

  const exit = () => {
    if (exited) return
    exited = true
    // measurements are keyed by slide INDEX, so they'd be wrong for the next
    // show if the deck was edited in between — never carry them across
    symCache.clear()
    pauseMediaIn(slidesEl) // stop any playing clip before teardown
    // Every section, not just the current one: Reveal's viewDistance cache may
    // hold a mounted poll on a neighbour, and a leaked interval would keep
    // hitting the poll service for the rest of the session.
    for (const section of slidesEl.children) disposeLivePolls(section as HTMLElement)
    slideEntered(null) // the figures on screen hear `on: false` before they go
    // The talk is over: close the audience's question so nobody keeps typing
    // into a room that has stopped listening.
    void publishActive(doc, null, { service: deckPollService(doc) })
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    const last = deck.getIndices().h
    try {
      deck.destroy()
    } catch {
      /* Reveal teardown is best-effort */
    }
    overlay.remove()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('message', onEmbedMessage)
    for (const p of pendingKeys.values()) clearTimeout(p.timer)
    pendingKeys.clear()
    document.removeEventListener('fullscreenchange', onFsChange)
    document.removeEventListener('visibilitychange', onVisibility)
    releaseWakeLock()
    reduceQuery.removeEventListener?.('change', onMotionQuery)
    clearInterval(speakerTimer)
    if (speaker && !speaker.closed) {
      if (speakerAdopted) {
        // editor-owned window — leave it open, reset to the idle placeholder so
        // it's ready for the next run instead of freezing on the last slide
        paintSpeaker(speaker, `${doc.title} — ${t('Speaker view')}`,
          speakerIdleBody(doc.title, t('Presentation ended. Start it again to bring these notes back to life.')))
      } else {
        speaker.close()
        setSpeakerWindow(null)
      }
    }
    onExit(last)
  }

  // ——— embeds: an arrow key steps a figure first, then moves the show ———
  // The deck half of the bridge in render.ts (EMBED_KEY_BRIDGE). A stepped
  // figure on the current slide is offered each navigation key; only when it
  // declines (it is at the end of its build) does the deck change slide. Keys
  // pressed INSIDE a frame come back as `embed-key` when the page did not use
  // them. Either way the show behaves like PowerPoint animations: → builds the
  // figure, and the → after the last build is the next slide.
  const NEXT_KEYS = new Set(['ArrowRight', 'PageDown', ' '])
  const steppedFrames = new WeakSet<Window>()
  const pendingKeys = new Map<number, { dir: 1 | -1; timer: number }>()
  let keySeq = 0
  const currentSection = () => slidesEl.children[deck.getIndices().h] as HTMLElement | undefined
  const frameOf = (w: Window | null) =>
    w ? [...slidesEl.querySelectorAll('iframe')].find((f) => f.contentWindow === w) : undefined
  // Focus left in a frame would keep eating keys after its slide is gone.
  const releaseEmbedFocus = () => {
    const a = document.activeElement
    if (a instanceof HTMLIFrameElement) a.blur()
  }
  const navigate = (dir: 1 | -1) => {
    releaseEmbedFocus()
    if (dir > 0) goNext()
    else goPrev()
  }
  const stepOrNavigate = (dir: 1 | -1, key: string) => {
    const frame = [...(currentSection()?.querySelectorAll('iframe') ?? [])]
      .find((f) => f.contentWindow && steppedFrames.has(f.contentWindow))
    if (!frame) return navigate(dir)
    const id = ++keySeq
    // a frame that never answers must not freeze the show
    const timer = window.setTimeout(() => { if (pendingKeys.delete(id)) navigate(dir) }, 400)
    pendingKeys.set(id, { dir, timer })
    frame.contentWindow!.postMessage(frameMsg('deck-key', { key, id }), '*')
  }
  const onEmbedMessage = (ev: MessageEvent) => {
    const d = ev.data
    // either key: a figure written before the rename posts the old one
    const kind = msgKind(d)
    if (!kind) return
    const frame = frameOf(ev.source as Window | null)
    if (!frame) return // only frames inside this show
    if (kind === 'embed-ready') {
      if (d.stepped) steppedFrames.add(frame.contentWindow!)
    } else if (kind === 'deck-key-result') {
      const p = pendingKeys.get(d.id)
      if (!p) return
      pendingKeys.delete(d.id)
      clearTimeout(p.timer)
      if (!d.handled) navigate(p.dir)
    } else if (kind === 'embed-key' && currentSection()?.contains(frame)) {
      navigate(NEXT_KEYS.has(d.key) ? 1 : -1)
    } else if (kind === 'goto' && currentSection()?.contains(frame)) {
      gotoFromFrame(d.to)
    }
    // A frame on the current slide that (re)loaded late — `loading="lazy"`, a
    // reload — missed the enter message: tell it now. Repeats are harmless.
    if (kind === 'embed-ready' && slideOn && slideOn.contains(frame)) postSlide(slideOn, true, [frame])
  }
  window.addEventListener('message', onEmbedMessage)

  // ——— embeds: slide enter/leave and goto (docs/game.md, "Deck ↔ figure") ———
  // A game screen needs to know when its slide is up (open the round, start the
  // clock) and when the show left it (close the round), and may move the show
  // itself ('next' when a round is over). The frame is sandboxed, so this is
  // the only way either side can know.
  let slideOn: HTMLElement | null = null
  const postSlide = (section: HTMLElement, on: boolean, frames?: HTMLIFrameElement[]) => {
    const index = [...slidesEl.children].indexOf(section)
    const msg = frameMsg('slide', { on, id: doc.slides[index]?.id ?? '', index })
    for (const f of frames ?? section.querySelectorAll('iframe')) f.contentWindow?.postMessage(msg, '*')
  }
  const slideEntered = (to: HTMLElement | null) => {
    if (slideOn === to) return
    if (slideOn) postSlide(slideOn, false)
    slideOn = to
    if (to) postSlide(to, true)
  }
  const gotoFromFrame = (to: unknown) => {
    if (to === 'next') return navigate(1)
    if (to === 'prev') return navigate(-1)
    const idx = typeof to === 'number' ? to : typeof to === 'string' ? doc.slides.findIndex((s) => s.id === to) : -1
    if (!Number.isInteger(idx) || idx < 0 || idx >= doc.slides.length) return
    releaseEmbedFocus()
    deck.slide(idx, 0)
  }

  // Capture-phase keys: Esc exits; arrows navigate unconditionally. Reveal
  // drops key events when focus sits in odd places (a leftover form field, a
  // host-embedded frame) — present mode has no fields, so arrows are always
  // navigation. Handled here exclusively (stopPropagation avoids double-steps).
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      if (deck.isOverview()) return // let Reveal close its overview first
      ev.preventDefault()
      ev.stopPropagation()
      exit()
      return
    }
    if (ev.key === 's' || ev.key === 'S') {
      ev.preventDefault()
      ev.stopPropagation()
      openSpeaker()
      return
    }
    if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault()
      ev.stopPropagation()
      toggleFullscreen()
      return
    }
    if (ev.key === 'm' || ev.key === 'M') {
      ev.preventDefault()
      ev.stopPropagation()
      toggleReduceMotion()
      return
    }
    const key = ev.key || ({ 32: ' ', 37: 'ArrowLeft', 39: 'ArrowRight', 33: 'PageUp', 34: 'PageDown' } as Record<number, string>)[ev.keyCode]
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      ev.preventDefault()
      ev.stopPropagation()
      stepOrNavigate(1, key)
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      ev.preventDefault()
      ev.stopPropagation()
      stepOrNavigate(-1, key)
    }
  }
  document.addEventListener('keydown', onKeydown, true)

  // ——— touch: swipe left/right to navigate; swiping past either end of
  // the deck drops back into the editor (phones have no Esc) ———
  let touchX = 0
  let touchY = 0
  overlay.addEventListener('touchstart', (ev) => {
    touchX = ev.touches[0].clientX
    touchY = ev.touches[0].clientY
  }, { passive: true })
  overlay.addEventListener('touchend', (ev) => {
    const t0 = ev.changedTouches[0]
    if (!t0) return
    const dx = t0.clientX - touchX
    const dy = t0.clientY - touchY
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return // a tap or a scroll
    if (dx < 0) {
      if (hasNext()) goNext()
      else exit()
    } else {
      if (hasPrev()) goPrev()
      else exit()
    }
  }, { passive: true })

  deck.on('slidechanged', ((event: any) => {
    const from = event.previousSlide as HTMLElement | undefined
    const to = event.currentSlide as HTMLElement
    if (!to) return
    const fromIdx = from ? [...slidesEl.children].indexOf(from) : -1
    const toIdx = [...slidesEl.children].indexOf(to)
    releaseEmbedFocus() // however we got here — a click, a swipe, the speaker view
    if (from) {
      // Kill the outgoing slide's tweens, then restore model frames —
      // a tween killed during its delay would otherwise leave the element
      // stuck at its "from" state (invisible) for every future visit.
      anim.killTweensOf(from.querySelectorAll('.tessera-el'))
      const fromSlide = doc.slides[fromIdx]
      for (const el of fromSlide?.elements ?? []) {
        const node = from.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
        if (node) {
          applyElementFrame(node, el) // resets style.transform…
          resetXform(node) // …so the engine must forget its composed state
        }
      }
      if (fromSlide?.hover?.type === 'reveal') {
        applyRevealSet(from, null, fromSlide.hover.default)
      }
    }
    const forward = toIdx > fromIdx
    // Morph forward into a morph slide, and un-morph when backing out of one.
    const morphing =
      from &&
      ((forward && doc.slides[toIdx]?.transition === 'morph') ||
        (!forward && doc.slides[fromIdx]?.transition === 'morph'))
    if (morphing) { if (!reduceMotion) runMorph(doc, from!, to, fromIdx, toIdx) }
    else if (!reduceMotion) runEnterFx(doc.slides[toIdx], to)
    if (!reduceMotion) {
      runAmbientFx(doc.slides[toIdx], to)
      restartSvgAnimations(to)
    }
    wireHoverFocus(doc.slides[toIdx], to)
    if (from) disposeLiveCharts(doc.slides[fromIdx], from)
    mountLiveCharts(doc.slides[toIdx], to, morphing ? doc.slides[fromIdx] : undefined)
    if (from) disposeLivePolls(from)
    mountLivePolls(doc, doc.slides[toIdx], to, opts.onPollSummary)
    slideEntered(to)
    if (from) pauseMediaIn(from)
    startMediaIn(to)
    // Capture where this slide's formula symbols sit WHILE it is on screen —
    // once it becomes the outgoing slide there is no layout left to measure.
    // Synchronously, not in rAF: a backgrounded tab never runs animation
    // frames, and a slide whose symbols were never captured simply doesn't
    // symbol-morph on the way out. symbolOffsets normalises by the element's
    // own box, so measuring mid-morph is safe.
    cacheSlideSymbols(doc, to, toIdx)
    updateSpeaker()
  }) as any)

  // Clicking an element with a link jumps to its target slide.
  slidesEl.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('a[href]')) return
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-link]')
    if (!target) return
    const idx = doc.slides.findIndex((s) => s.id === target.dataset.link)
    if (idx >= 0) {
      ev.preventDefault()
      ev.stopPropagation()
      deck.slide(idx, 0)
    }
  })

  deck.initialize().then(() => {
    deckReady = true
    if (startIndex > 0) deck.slide(startIndex, 0)
    // if the speaker view was opened before init (macOS reorder), fill it now
    updateSpeaker()
    // late layout: fonts/images that finish loading after init can change
    // the measured size, and the boot viewport may still be settling
    window.addEventListener('resize', onResize)
    setTimeout(onResize, 120)
    setTimeout(onResize, 600)
    const first = slidesEl.children[startIndex] as HTMLElement | undefined
    if (first) {
      if (!reduceMotion) {
        runEnterFx(doc.slides[startIndex], first)
        runAmbientFx(doc.slides[startIndex], first)
        restartSvgAnimations(first)
      }
      wireHoverFocus(doc.slides[startIndex], first)
      // the opening slide never gets a slidechanged, so capture its symbols
      // here or the very first morph would have no from-side to travel from
      cacheSlideSymbols(doc, first, startIndex)
      mountLiveCharts(doc.slides[startIndex], first)
      // the opening slide never fires slidechanged, so it mounts here too
      mountLivePolls(doc, doc.slides[startIndex], first, opts.onPollSummary)
      // ...and its figures are told the show is on their slide
      slideEntered(first)
      startMediaIn(first)
    }
    // The lecturer-key preflight. A gated deployment refuses the presenter
    // routes, and the most important of them (steering the room's phones)
    // deliberately never prompts — it runs on EVERY slide change, and a dialog
    // per slide would be unusable. The result used to be the worst possible
    // failure: a talk where the audience's phones silently never followed
    // along, with nothing on screen to say why.
    //
    // So ask once, here, at the top of the show. Not awaited and never fatal:
    // the presentation is already running, an unreachable service answers
    // "don't know" (ensureLecturerKey returns true), and a presenter who
    // dismisses the dialog gets the old behaviour rather than a blocked deck.
    if (deckUsesPolls(doc)) void ensureLecturerKey(deckPollService(doc))
    // A named join code is a session only once the service knows it: make
    // sure it does before the first phone arrives. Silent, like the publish.
    if (deckUsesPolls(doc) && doc.poll?.session) void claimSession(doc.poll.session, { el: { service: deckPollService(doc) } })
  })

  return { exit }
}

// --- media playback -----------------------------------------------------------

// Autoplay is intentionally NOT set at render time (it would fire on the editor
// canvas and in every thumbnail). Present mode starts flagged media on entry
// and pauses everything on exit so a paused clip doesn't keep playing off-slide.
function startMediaIn(section: HTMLElement) {
  section.querySelectorAll<HTMLMediaElement>('video[data-autoplay="1"], audio[data-autoplay="1"]').forEach((m) => {
    try { m.currentTime = 0 } catch { /* not seekable yet */ }
    void m.play().catch(() => { /* blocked (e.g. un-muted video) — leave paused */ })
  })
}

function pauseMediaIn(section: HTMLElement) {
  section.querySelectorAll<HTMLMediaElement>('video, audio').forEach((m) => { m.pause() })
}

// --- live charts --------------------------------------------------------------

// Present mode swaps chart snapshots for live ECharts instances (tooltips,
// dataZoom). Leaving the slide disposes the instance and restores the
// snapshot so the section stays presentable in Reveal's viewDistance cache.
const chartHandles = new WeakMap<HTMLElement, Array<() => void>>()

function mountLiveCharts(slide: Slide, section: HTMLElement, fromSlide?: Slide) {
  const handles: Array<() => void> = []
  for (const el of slide?.elements ?? []) {
    if (el.type !== 'chart') continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) continue
    // a matching chart on the other side of a morph: animate its data over
    const fromEl = fromSlide?.elements.find((e) => e.id === el.id && e.type === 'chart')
    const dispose = mountChart(el, node, fromEl && fromEl.type === 'chart' ? fromEl.option : undefined)
    handles.push(() => {
      dispose()
      node.innerHTML = chartSnapshotSvg(el)
      const csvg = node.querySelector('svg')
      if (csvg) {
        csvg.setAttribute('preserveAspectRatio', 'none')
        ;(csvg as SVGElement).style.cssText = 'width:100%;height:100%;display:block'
      }
    })
  }
  if (handles.length) chartHandles.set(section, handles)
}

function disposeLiveCharts(_slide: Slide, section: HTMLElement) {
  for (const h of chartHandles.get(section) ?? []) h()
  chartHandles.delete(section)
}

// --- live audience polls ------------------------------------------------------

// A poll renders statically everywhere (question, join code, saved summary).
// Present mode adds the parts that only make sense with an audience in the room:
// a response count that ticks up, the Summarize button, and a hide/show toggle
// for the raw responses. Same mount/dispose contract as live charts — Reveal
// keeps neighbouring sections in its viewDistance cache, so leaving a slide MUST
// stop the polling and put the static body back.
const pollHandles = new WeakMap<HTMLElement, Array<() => void>>()

/** Does this deck ask the room anything at all? Gates the lecturer-key
 *  preflight: a deck with no poll element never touches the service, and must
 *  not be interrupted by a dialog about one. */
function deckUsesPolls(doc: TesseraDoc): boolean {
  return doc.slides.some((s) => s.elements.some((el) => el.type === 'poll' && !el.frozen))
}

/** Which service this deck's polls live on, for the publishes that happen on a
 *  slide with no poll element to read a `service` override off. */
function deckPollService(doc: TesseraDoc): string | undefined {
  for (const slide of doc.slides) {
    for (const el of slide.elements) {
      if (el.type === 'poll' && el.service) return el.service
    }
  }
  return undefined
}

/** How often the count refreshes. Fast enough that the room sees their answers
 *  land, slow enough to be unremarkable traffic for a 40-minute talk. */
const POLL_INTERVAL_MS = 3000

function mountLivePolls(
  doc: TesseraDoc,
  slide: Slide,
  section: HTMLElement,
  onSummary?: (elId: string, summary: string) => void,
) {
  const handles: Array<() => void> = []
  for (const el of slide?.elements ?? []) {
    if (el.type !== 'poll') continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    const live = node?.querySelector<HTMLElement>('.tessera-poll-live')
    if (!node || !live) continue
    handles.push(mountOnePoll(doc, el, node, live, onSummary))
  }
  if (handles.length) pollHandles.set(section, handles)

  // Steer the room's phones. EVERY slide change publishes, including onto a
  // slide with no question at all (which tells the audience page to say "look
  // up") — a page still showing the last question is worse than an empty one,
  // because people answer it.
  // A reporting figure that asks for it (`keepPollOpen`) keeps the question
  // before it on the phones, so answers keep arriving while it draws them.
  let first = (slide?.elements ?? []).find((e) => e.type === 'poll' && !e.frozen) as PollElement | undefined
  if (!first && slide?.elements.some((e) => e.type === 'embed' && e.keepPollOpen)) {
    first = precedingPoll(doc, doc.slides.findIndex((s) => s.id === slide.id))
  }
  void publishActive(doc, first ?? null, { service: deckPollService(doc) })
}

function disposeLivePolls(section: HTMLElement) {
  for (const h of pollHandles.get(section) ?? []) h()
  pollHandles.delete(section)
}

function mountOnePoll(
  doc: TesseraDoc,
  el: PollElement,
  node: HTMLElement,
  live: HTMLElement,
  onSummary?: (elId: string, summary: string) => void,
): () => void {
  const accent = el.accent || doc.theme.accent
  const kind = el.kind ?? 'open'
  const abort = new AbortController()
  let timer = 0
  let answers: PollAnswer[] = []
  // The service is holding responses back for want of a lecturer key: `count`
  // is real, `answers` is empty. Tracked separately from "nobody answered yet"
  // because the two look identical on screen and only one of them means the
  // presenter should stop and fix something. Without this a gated deck draws a
  // bar chart of zeros over a count of 42.
  let withheld = false
  // Open text stays hidden until the presenter asks for it — the room's own
  // words on a projector is a decision, not a default. Aggregates are the
  // opposite: a bar chart nobody can see is the point of the question missing.
  // A leaderboard is names, same call as open text.
  let showing = kind !== 'open' && kind !== 'activity'

  // Push the activity's page once, on mount — it does not change while the
  // talk runs, so there is nothing to keep re-sending on the 3s tick. Best
  // effort: a failed push doesn't stop the show, it just means a phone that
  // joins before it lands sees "not ready yet" until the presenter returns
  // to this slide (present.ts re-mounts, and re-tries, on every slide-enter).
  if (kind === 'activity') {
    const html = el.activityAsset ? (doc.assets?.[el.activityAsset] ?? '') : (el.activityHtml ?? '')
    // with the slide's reworded labels in front, so the phones match the screen
    if (html.trim() && !el.frozen) void publishActivityHtml(el, activityPageWithTexts(doc, el, html)).catch(() => {})
  }
  let busy = false
  // A failed Summarize must stay readable: the count refreshes every 3s, and a
  // message that vanishes before the presenter has finished reading it is worse
  // than no message. Poll errors are transient and may be cleared; this one is
  // held until the next Summarize attempt.
  let stickyErr = false
  // The last count the service reported. Read by repaint(), which runs from the
  // toggle handler too — where no fetch has just happened to read it from.
  let lastCount = 0

  live.textContent = ''

  // Row 1: the count, the toggle, and Summarize.
  const bar = document.createElement('div')
  bar.className = 'tessera-poll-bar'

  const count = document.createElement('span')
  count.className = 'tessera-poll-count'
  count.textContent = t('Waiting for responses…')

  const toggle = document.createElement('button')
  toggle.className = 'tessera-poll-btn'
  toggle.hidden = true

  const summarize = document.createElement('button')
  summarize.className = 'tessera-poll-btn tessera-poll-btn-primary'
  summarize.style.background = accent
  summarize.textContent = t('Summarize')
  summarize.disabled = true
  // Only open text has anything to summarize: a choice tally and a rating
  // average ARE the summary, computed here and never sent to a model.
  summarize.hidden = kind !== 'open'
  // Summarize is the button that pushes itself to the right end of the bar;
  // without it the toggle takes that job, so the row doesn't bunch up.
  if (summarize.hidden) toggle.style.marginLeft = 'auto'

  bar.append(count, toggle, summarize)
  live.appendChild(bar)

  // Row 2: whatever we have to show — the summary, the responses, or an error.
  const out = document.createElement('div')
  out.className = 'tessera-poll-out'
  live.appendChild(out)

  const summaryBox = document.createElement('div')
  summaryBox.className = 'tessera-poll-summary'
  if (el.summary) summaryBox.innerHTML = summaryHtml(el.summary)
  else summaryBox.hidden = true
  out.appendChild(summaryBox)

  const list = document.createElement('ul')
  list.className = 'tessera-poll-answers'
  list.hidden = true
  out.appendChild(list)

  // choice/rating draw into their own box; when the results are hidden it holds
  // the question's options instead, so the room can still read what to pick.
  const results = document.createElement('div')
  results.className = 'tessera-poll-results'
  results.hidden = kind === 'open'
  out.appendChild(results)

  const err = document.createElement('p')
  err.className = 'tessera-poll-err'
  err.hidden = true
  out.appendChild(err)

  // Shown instead of the results when the service is withholding them. Its own
  // node rather than `err`, which is for transient failures that clear on the
  // next tick — this condition persists until somebody enters a key.
  const locked = document.createElement('p')
  locked.className = 'tessera-poll-err'
  locked.hidden = true
  locked.textContent = t('Responses are locked — press Summarize, or enter the lecturer key, to read them.')
  out.appendChild(locked)

  const setToggleLabel = () => {
    // Nothing to toggle when we are not allowed to see it. Hiding the button
    // is kinder than a button that does nothing.
    if (withheld) {
      toggle.hidden = true
      return
    }
    if (kind === 'open' || kind === 'activity') {
      toggle.hidden = answers.length === 0
      toggle.textContent = showing
        ? t('Hide responses')
        : t('Show {n} responses', { n: answers.length })
      return
    }
    // Aggregates are always offerable, even at zero: "hide results" before the
    // first answer lands is how a presenter sets up a reveal.
    toggle.hidden = false
    toggle.textContent = showing ? t('Hide results') : t('Show results')
  }

  /** `activity` answers are free-form JSON by convention (`{"score":…}` is the
   *  one field this reads); a malformed or scoreless payload still shows, just
   *  unranked, at the bottom, rather than vanishing from a count someone on
   *  stage is reading aloud. */
  const paintLeaderboard = () => {
    const parsed = answers.map((a) => {
      let score: number | undefined
      try {
        const d = JSON.parse(a.text)
        if (d && typeof d.score === 'number') score = d.score
      } catch { /* not JSON — show as-is, unranked */ }
      return { a, score }
    })
    parsed.sort((x, y) => (y.score ?? -Infinity) - (x.score ?? -Infinity))
    for (const { a, score } of parsed) {
      const li = document.createElement('li')
      li.dir = 'auto'
      const who = document.createElement('b')
      who.textContent = `${a.name || t('Anonymous')}: `
      li.append(who, document.createTextNode(score != null ? String(score) : a.text))
      list.appendChild(li)
    }
  }

  const paintList = () => {
    list.hidden = !showing || withheld || (kind !== 'open' && kind !== 'activity')
    if (list.hidden) return
    list.textContent = ''
    if (kind === 'activity') {
      paintLeaderboard()
      return
    }
    for (const a of answers) {
      const li = document.createElement('li')
      li.dir = 'auto'
      // A named question shows who said it — that is what the presenter turned
      // it on for. Anonymous answers are unchanged.
      if (a.name) {
        const who = document.createElement('b')
        who.textContent = `${a.name}: `
        li.append(who, document.createTextNode(a.text))
      } else {
        li.textContent = a.text
      }
      list.appendChild(li)
    }
    // Newest answers matter most once the list is long.
    list.scrollTop = list.scrollHeight
  }

  /** The bars (or the options, when hidden). Rebuilt on every tick — a few
   *  dozen divs every three seconds is nothing, and diffing counts would be
   *  more code than the whole widget. */
  const paintResults = () => {
    if (kind === 'open' || kind === 'activity') return
    results.textContent = ''
    // `withheld` falls through to the same branch as "hidden": draw the
    // question's options, which the room still needs to read, instead of a
    // tally of an empty array that would report zero for every option.
    if (!showing || withheld) {
      const ask = renderPollAsk(el, accent, { hidePlaceholders: true })
      if (ask) results.appendChild(ask)
      return
    }
    if (kind === 'choice') {
      const { rows, other, total } = tallyChoices(el, answers)
      const withOther = other ? [...rows, { label: t('Other'), count: other }] : rows
      results.appendChild(renderPollBars(withOther, accent, { total }))
      return
    }
    if (kind === 'quiz') {
      // Scores, not answers: how many people got 0 right, 1 right, and so on.
      // Marking happens in model.quizStats from the deck's own `correct`
      // fields — the phones were never told them.
      const stats = quizStats(el, answers)
      const head = document.createElement('div')
      head.className = 'tessera-poll-average'
      const value = document.createElement('span')
      value.className = 'tessera-poll-average-value'
      value.style.color = accent
      value.textContent = stats.count ? stats.average.toFixed(1) : '—'
      const label = document.createElement('span')
      label.className = 'tessera-poll-average-label'
      label.textContent = t('average of {n} · out of {max}', { n: stats.count, max: stats.total })
      head.append(value, label)
      results.appendChild(head)
      results.appendChild(renderPollBars(
        stats.rows.map((r) => ({ label: t('{n} / {max}', { n: r.score, max: stats.total }), count: r.count })),
        accent,
        { total: stats.count },
      ))
      return
    }
    const stats = ratingStats(el, answers)
    const head = document.createElement('div')
    head.className = 'tessera-poll-average'
    const value = document.createElement('span')
    value.className = 'tessera-poll-average-value'
    value.style.color = accent
    value.textContent = stats.count ? stats.average.toFixed(1) : '—'
    const label = document.createElement('span')
    label.className = 'tessera-poll-average-label'
    const { max } = ratingScale(el)
    label.textContent = t('average of {n} · out of {max}', { n: stats.count, max })
    head.append(value, label)
    results.appendChild(head)
    results.appendChild(renderPollBars(
      stats.rows.map((r) => ({ label: String(r.value), count: r.count })),
      accent,
      { total: stats.count },
    ))
  }

  const repaint = () => {
    setToggleLabel()
    paintList()
    paintResults()
    results.hidden = kind === 'open' || kind === 'activity'
    // Only worth saying once anyone has actually answered: "locked" over an
    // empty bucket is noise, and the presenter can still fix it from the panel.
    locked.hidden = !withheld || lastCount === 0
    // The summary and the raw list compete for the same space; showing one
    // hides the other rather than squeezing both into a projector's worth of room.
    summaryBox.hidden = (showing && kind === 'open') || !summaryBox.innerHTML
  }

  toggle.addEventListener('click', () => {
    showing = !showing
    repaint()
  })

  const tick = async () => {
    try {
      const state = await fetchPoll(el, abort.signal)
      answers = state.answers
      withheld = !!state.answersWithheld
      lastCount = state.count
      // The count is public even on a gated deployment, so participation still
      // shows: "42 responses" is true whether or not this machine may read them.
      count.textContent = state.count === 1
        ? t('1 response')
        : t('{n} responses', { n: state.count })
      summarize.disabled = state.count === 0 || busy
      if (!stickyErr) err.hidden = true
      repaint()
    } catch (e) {
      if (abort.signal.aborted) return
      // Degrade, never break: the question and join code are still on screen,
      // which is the part the audience needs.
      count.textContent = t('Offline')
      err.textContent = String((e as Error)?.message ?? e)
      err.hidden = false
      summarize.disabled = true
    }
  }

  summarize.addEventListener('click', async () => {
    busy = true
    summarize.disabled = true
    const label = summarize.textContent
    summarize.textContent = t('Summarizing…')
    stickyErr = false
    err.hidden = true
    try {
      const summary = await summarizePoll(el, abort.signal)
      summaryBox.innerHTML = summaryHtml(summary)
      summaryBox.hidden = false
      // Collapse the raw list so the summary owns the slide.
      showing = false
      repaint()
      // Persist through the editor's store so it lands in an undo step and the
      // usual save paths pick it up. present.ts holds `doc`, not the store, so
      // it must not write the model itself.
      onSummary?.(el.id, summary)
    } catch (e) {
      if (!abort.signal.aborted) {
        err.textContent = String((e as Error)?.message ?? e)
        err.hidden = false
        stickyErr = true
      }
    } finally {
      busy = false
      summarize.textContent = label
      // Stays enabled: more answers arrive mid-discussion and re-summarizing
      // is the normal thing to want.
      summarize.disabled = false
    }
  })

  // Draw before the first response arrives: a choice question must show its
  // options the instant the slide lands, not three seconds later.
  repaint()

  const start = () => {
    if (timer) return
    void tick()
    timer = window.setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  }
  const stop = () => {
    if (!timer) return
    window.clearInterval(timer)
    timer = 0
  }
  // A backgrounded tab (presenter switched apps) has no audience watching the
  // count, so stop paying for the requests until it comes back.
  const onVis = () => (document.hidden ? stop() : start())
  // A frozen poll (PollElement.frozen) reports what is in the file and never
  // reaches for the service: same widget, same arithmetic, no network.
  if (el.frozen) {
    answers = (el.frozen.answers ?? []).map((text) => ({ text, at: el.frozen?.at ?? '' }))
    lastCount = el.frozen.count
    count.textContent = lastCount === 1 ? t('1 response') : t('{n} responses', { n: lastCount })
    summarize.hidden = true
    if (kind === 'open' || kind === 'activity') toggle.hidden = true
    repaint()
    if (kind === 'open' || kind === 'activity') toggle.hidden = true
    return () => {
      node.textContent = ''
      node.appendChild(renderPollBody(el, doc, { hidePlaceholders: true }))
    }
  }
  document.addEventListener('visibilitychange', onVis)
  start()

  return () => {
    stop()
    document.removeEventListener('visibilitychange', onVis)
    abort.abort()
    // Restore the static body so this cached section still reads correctly.
    node.textContent = ''
    node.appendChild(renderPollBody(el, doc, { hidePlaceholders: true }))
  }
}

// --- element fx -------------------------------------------------------------

function fxNodes(slide: Slide, section: HTMLElement): Array<[SlideElement, HTMLElement]> {
  const pairs: Array<[SlideElement, HTMLElement]> = []
  for (const el of slide?.elements ?? []) {
    if (!el.fx) continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (node) pairs.push([el, node])
  }
  return pairs
}

/** Staggered entrance animations + count-ups for the incoming slide. */
function runEnterFx(slide: Slide, section: HTMLElement) {
  const entering = fxNodes(slide, section)
    // reveal-set members are shown/hidden by hover, never by entrance tweens
    .filter(([el]) => (el.fx!.enter || el.fx!.countUp) && !el.showOnHover)
    .sort((a, b) => (a[0].fx!.order ?? 0) - (b[0].fx!.order ?? 0))
  // Delay derives from fx.order when set (equal order ⇒ elements enter
  // together — how a diagram reveals band-by-band), else from list position.
  entering.forEach(([el, node], i) => {
    const fx = el.fx!
    const step = fx.order ?? i
    // motion-path loops own the transform — an entrance tween on the same
    // node would fight it and freeze the dot off its path
    if (fx.loop?.type === 'motion-path') return
    if (fx.enter) {
      // directional entrances: fade-* nudge 16px, slide-* sweep 120px from an
      // edge. x needs the x transform channel (added to anim.ts).
      const D = 120
      const from = { opacity: 0, x: 0, y: 0 }
      if (fx.enter === 'fade-up') from.y = 16
      else if (fx.enter === 'fade-down') from.y = -16
      else if (fx.enter === 'slide-left') from.x = D // starts to the right, slides in leftward
      else if (fx.enter === 'slide-right') from.x = -D
      else if (fx.enter === 'slide-up') from.y = D
      else if (fx.enter === 'slide-down') from.y = -D
      const slide = fx.enter.startsWith('slide-')
      anim.fromTo(
        node,
        from,
        {
          opacity: el.opacity,
          x: 0,
          y: 0,
          duration: fx.enterDur ?? (slide ? 0.75 : 0.55),
          delay: 0.12 + Math.min(step, 24) * 0.05,
          ease: slide ? 'power3.out' : 'power2.out',
        },
      )
    }
    if (fx.countUp) runCountUp(node)
  })
  settleGuarantee(entering.map(([el, node]) => [node, el]))
}

/**
 * Wall-clock safety net: on starved render loops (throttled tabs, weak
 * machines) tween progress crawls — guarantee every animated element lands
 * on its final model state instead of lingering half-invisible.
 */
function settleGuarantee(pairs: Array<[HTMLElement, SlideElement]>) {
  // Ambient/looping elements run infinite tweens by design — their progress
  // never reaches 1, and "settling" them would kill the loop and freeze the
  // element (a real bug once: orbit dots died 2.8s after every morph entry).
  pairs = pairs.filter(([, el]) => !el.fx?.loop && el.fx?.ambient !== 'kenburns')
  if (!pairs.length) return
  setTimeout(() => {
    for (const [node, el] of pairs) {
      if (!node.isConnected) continue
      const tweens = anim.getTweensOf(node)
      if (tweens.some((t) => t.progress() < 1)) {
        anim.killTweensOf(node)
        applyElementFrame(node, el)
        resetXform(node)
      }
    }
  }, 2800)
}

/** Animate every number in the element's text from 0 to its final value. */
function runCountUp(node: HTMLElement) {
  const inner = node.querySelector<HTMLElement>('.tessera-text-inner') ?? node
  const final = inner.textContent ?? ''
  const tokens = [...final.matchAll(/\d+(?:[.,]\d+)?/g)]
  if (!tokens.length) return
  const state = { p: 0 }
  anim.to(state, {
    p: 1,
    duration: 1.15,
    delay: 0.15,
    ease: 'power2.out',
    onUpdate() {
      let out = ''
      let last = 0
      for (const m of tokens) {
        out += final.slice(last, m.index)
        const raw = m[0].replace(',', '.')
        const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
        out += (parseFloat(raw) * state.p).toFixed(decimals)
        last = m.index! + m[0].length
      }
      inner.textContent = out + final.slice(last)
    },
  })
}

/** Re-parse inline svg elements so their CSS animations replay on entry. */
function restartSvgAnimations(section: HTMLElement) {
  for (const host of section.querySelectorAll<HTMLElement>('.tessera-el-svg')) {
    if (host.querySelector('animate, [style*="animation"], style')) {
      // eslint-disable-next-line no-self-assign
      host.innerHTML = host.innerHTML
    }
  }
}

/** Continuous motion: ken-burns zoom, marching dashes, dots along paths. */
function runAmbientFx(slide: Slide, section: HTMLElement) {
  for (const [el, node] of fxNodes(slide, section)) {
    const fx = el.fx!
    if (fx.ambient === 'kenburns') {
      const ken = fx.ken ?? {}
      const dir = ken.dir ?? 'drift'
      if (dir === 'drift') {
        anim.fromTo(
          node,
          { scale: 1.02 },
          { scale: ken.scale ?? 1.1, duration: ken.duration ?? 26, ease: 'none', repeat: -1, yoyo: true, transformOrigin: '50% 40%' },
        )
      } else {
        // one-shot settle, replayed on every slide entry
        const far = ken.scale ?? 1.06
        const dur = ken.duration ?? 2.5
        anim.fromTo(
          node,
          { scale: dir === 'out' ? far : 1 },
          { scale: dir === 'out' ? 1 : far, duration: dur, ease: 'power2.out', transformOrigin: '50% 50%' },
        )
      }
    }
    if (fx.loop?.type === 'dash-march') {
      const target = node.querySelector('path, line, rect, ellipse, polygon') as SVGElement | null
      if (target) {
        // Seamless marching ants: the offset must travel a WHOLE number of
        // dash+gap periods, or the pattern snaps back mid-cycle each loop and
        // reads as an incomplete/janky loop. Snap the requested distance to
        // the nearest whole multiple of the element's dasharray period.
        const da = target.getAttribute('stroke-dasharray') || getComputedStyle(target).strokeDasharray || ''
        const parts = da.split(/[\s,]+/).map(parseFloat).filter((n) => n > 0)
        const period = parts.reduce((a, b) => a + b, 0)
        let travel = fx.loop.distance ?? 18
        if (period > 0) {
          // SVG doubles an odd-count dasharray, so one visual period is 2× then.
          const unit = parts.length % 2 ? period * 2 : period
          travel = Math.max(1, Math.round(travel / unit)) * unit
        }
        anim.fromTo(
          target,
          { strokeDashoffset: travel },
          { strokeDashoffset: 0, duration: fx.loop.duration ?? 1.4, ease: 'none', repeat: -1 },
        )
      }
    }
    if (fx.loop?.type === 'motion-path') {
      anim.to(node, {
        motionPath: { path: fx.loop.path, speeds: fx.loop.speeds },
        duration: fx.loop.duration,
        delay: fx.loop.delay ?? 0,
        ease: fx.loop.ease ?? 'none',
        repeat: -1,
      })
    }
  }
}

/** Show only the showOnHover set for `group` (falling back to the default). */
function applyRevealSet(root: HTMLElement, group: string | null, def?: string | null) {
  const active = group ?? def ?? null
  for (const node of root.querySelectorAll<HTMLElement>('[data-show-on-hover]')) {
    const show = node.dataset.showOnHover === active
    node.style.transition = 'opacity .18s ease'
    node.style.opacity = show ? '' : '0'
    node.style.pointerEvents = show ? '' : 'none'
  }
}

/**
 * Hover behaviours. focus-group: pointing at a grouped element dims every
 * element outside its group. reveal: pointing at a grouped element shows the
 * matching showOnHover set (in-slide content swap — no state slides needed).
 */
function wireHoverFocus(slide: Slide, section: HTMLElement) {
  if (!slide?.hover || section.dataset.hoverWired) return
  section.dataset.hoverWired = '1'
  const mode = slide.hover.type
  const dim = slide.hover.dim ?? 0.13
  const def = slide.hover.default ?? null
  let current: string | null = null
  const apply = (group: string | null) => {
    if (group === current) return
    current = group
    if (mode === 'reveal') {
      applyRevealSet(section, group, def)
      return
    }
    for (const node of section.querySelectorAll<HTMLElement>('[data-group]')) {
      const other = group !== null && node.dataset.group !== group
      node.style.transition = 'opacity .25s ease'
      node.style.opacity = other ? String(dim) : ''
    }
  }
  section.addEventListener('mouseover', (ev) => {
    const hit = (ev.target as HTMLElement).closest<HTMLElement>('[data-group]')
    apply(hit ? hit.dataset.group! : null)
  })
  section.addEventListener('mouseleave', () => apply(null))
}

// --- morph ------------------------------------------------------------------

function elementsById(root: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((n) => {
    map.set(n.dataset.flipId!, n)
  })
  return map
}

/**
 * Model frames keyed by MORPH KEY, not by `id` — every caller looks these up
 * with a `data-flip-id`, which is `morphId || id`. Keying by `id` meant any
 * element carrying a `morphId` missed its own model entry, so `runMorph` hit
 * `if (!a || !b) continue` and skipped the tween: the DOM paired correctly and
 * then nothing animated (issue #54). Same-slide keys are unique — the panel
 * rejects a `morphId` that collides on the slide — so this stays 1:1.
 */
function modelByMorphKey(doc: TesseraDoc, index: number): Map<string, SlideElement> {
  const map = new Map<string, SlideElement>()
  for (const el of doc.slides[index]?.elements ?? []) map.set(morphKey(el), el)
  return map
}

/**
 * Where a symbol sits INSIDE its element, in model units.
 *
 * The engine's rule is "geometry from the model, never the DOM" — because the
 * outgoing section carries Reveal's own transforms, so absolute measurement
 * lies. A symbol inside a formula has no model entry to read: it is produced
 * at render time from a raw `$…$` string, so there is nothing to look up.
 *
 * The way through is to measure only what is INVARIANT under those transforms:
 * the symbol's offset from its own element's box, divided by that element's
 * measured width over its MODEL width. Any uniform scale an ancestor applies
 * hits numerator and denominator alike and cancels. Box geometry stays fully
 * model-driven; only the rearrangement WITHIN a box is measured.
 */
/**
 * Symbol offsets measured while a slide was ON SCREEN, keyed `slideIdx ␟ flipId`.
 *
 * Necessary because the outgoing section has NO LAYOUT by the time runMorph
 * runs — its elements measure zero width, which is the same fact that made
 * "geometry from the model, never the DOM" the rule in the first place. A
 * formula's symbols have no model entry to fall back on, so the only honest
 * source for where a symbol WAS is a measurement taken while it was visible.
 * Captured on slide entry; read on slide exit.
 */
const symCache = new Map<string, Map<string, { x: number; y: number }>>()
const symKey = (idx: number, flipId: string) => `${idx}${flipId}`

/** Measure and cache every formula on a slide that is currently displayed. */
function cacheSlideSymbols(doc: TesseraDoc, section: HTMLElement, idx: number) {
  const slide = doc.slides[idx]
  if (!slide) return
  const byKey = modelByMorphKey(doc, idx)
  for (const host of Array.from(section.querySelectorAll<HTMLElement>('[data-flip-id]'))) {
    if (!host.querySelector('[data-sym]')) continue
    const model = byKey.get(host.dataset.flipId!)
    if (!model) continue
    const offsets = symbolOffsets(host, model.w, model.h)
    if (offsets.size) symCache.set(symKey(idx, host.dataset.flipId!), offsets)
  }
}

function symbolOffsets(host: HTMLElement, modelW: number, modelH: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const box = host.getBoundingClientRect()
  if (!box.width || !box.height) return out // no layout (hidden slide) — nothing to measure
  // Normalise per axis: the box morph can scale x and y differently, and one
  // shared factor would skew every vertical offset when it does.
  const sx = box.width / Math.max(modelW, 0.01)
  const sy = box.height / Math.max(modelH, 0.01)
  for (const sym of Array.from(host.querySelectorAll<HTMLElement>('[data-sym]'))) {
    const r = sym.getBoundingClientRect()
    out.set(sym.dataset.sym!, { x: (r.left - box.left) / sx, y: (r.top - box.top) / sy })
  }
  return out
}

/**
 * Morph a formula symbol by symbol: each token travels from where it sat on
 * the previous slide to where it sits on this one, so a term moving across the
 * equals sign is SEEN to move rather than crossfading.
 *
 * Composes with the element box morph rather than replacing it: that tween
 * already carries the element's gross position and scale, so what is animated
 * here is only each symbol's offset RELATIVE to its box. The delta is divided
 * by the box's current scale because a transform on a child inside a scaled
 * parent is scaled too — without it, symbols overshoot whenever the formula
 * changes size between slides.
 *
 * Symbols on only one side are left alone: they simply appear with their
 * element, which is what the box morph already does for them.
 */
function morphMathSymbols(
  fromAt: Map<string, { x: number; y: number }> | undefined,
  to: HTMLElement,
  a: SlideElement,
  b: SlideElement,
): boolean {
  if (!fromAt?.size || !to.querySelector('[data-sym]')) return false
  const toAt = symbolOffsets(to, b.w, b.h)
  if (!toAt.size) return false

  const pairs: Array<{ node: HTMLElement; dx: number; dy: number }> = []
  for (const sym of Array.from(to.querySelectorAll<HTMLElement>('[data-sym]'))) {
    const src = fromAt.get(sym.dataset.sym!)
    const dst = toAt.get(sym.dataset.sym!)
    if (!src || !dst) continue
    const dx = src.x - dst.x
    const dy = src.y - dst.y
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue // sits still — don't tween it
    pairs.push({ node: sym, dx, dy })
  }
  if (!pairs.length) return false

  const state = { p: 0 }
  for (const { node } of pairs) node.style.willChange = 'transform'
  anim.to(state, {
    p: 1,
    duration: MORPH_DURATION,
    ease: MORPH_EASE,
    onUpdate() {
      const p = state.p
      // undo the box tween's scale so the symbol delta stays in model units
      const sx = (a.w + (b.w - a.w) * p) / Math.max(b.w, 0.01)
      const sy = (a.h + (b.h - a.h) * p) / Math.max(b.h, 0.01)
      for (const { node, dx, dy } of pairs) {
        node.style.transform = `translate(${(dx * (1 - p)) / sx}px, ${(dy * (1 - p)) / sy}px)`
      }
    },
    onComplete() {
      for (const { node } of pairs) {
        node.style.transform = ''
        node.style.willChange = ''
      }
    },
  })
  return true
}

function runMorph(
  doc: TesseraDoc,
  fromSection: HTMLElement,
  toSection: HTMLElement,
  fromIdx: number,
  toIdx: number,
) {
  const fromEls = elementsById(fromSection)
  const toEls = elementsById(toSection)
  const fromModel = modelByMorphKey(doc, fromIdx)
  const toModel = modelByMorphKey(doc, toIdx)

  const matchedFrom: HTMLElement[] = []
  const matchedTo: HTMLElement[] = []
  for (const [id, el] of fromEls) {
    const target = toEls.get(id)
    if (target) {
      matchedFrom.push(el)
      matchedTo.push(target)
    }
  }

  // Unmatched incoming elements fade/rise in — to their MODEL opacity
  // (clearProps would wipe reveal-set hiding and dimmed-state opacities).
  const toSlide = doc.slides[toIdx]
  const activeSet = toSlide?.hover?.type === 'reveal' ? (toSlide.hover.default ?? null) : null
  const entering: Array<[HTMLElement, number]> = []
  for (const n of toEls.values()) {
    const id = n.dataset.flipId!
    if (fromEls.has(id)) continue
    const m = toModel.get(id)
    if (m?.showOnHover && m.showOnHover !== activeSet) continue // hover-revealed, stays hidden
    entering.push([n, m?.opacity ?? 1])
  }
  if (entering.length) {
    const spread = Math.min(0.45, entering.length * 0.03)
    entering.forEach(([n, opacity], i) => {
      // motion-path loops own the transform — entrance limited to opacity
      const m = toModel.get(n.dataset.flipId!)
      const owns = m?.fx?.loop?.type === 'motion-path'
      anim.fromTo(n,
        owns ? { opacity: 0 } : { opacity: 0, y: 14 },
        {
          opacity, ...(owns ? {} : { y: 0 }), duration: 0.45,
          delay: MORPH_DURATION * 0.4 + (spread * i) / entering.length,
          ease: 'power2.out',
        })
    })
    settleGuarantee(entering.map(([n]) => {
      const m = toModel.get(n.dataset.flipId!)
      return [n, m!] as [HTMLElement, SlideElement]
    }).filter(([, m]) => !!m))
  }
  if (!matchedFrom.length) return

  // Geometry straight from the model — no DOM measuring needed (both sides'
  // frames are in the doc), so the outgoing section's Reveal styling is
  // irrelevant. Each matched node animates from the from-slide's frame to its
  // own via translate+scale about the top-left corner (scale mode like
  // PowerPoint: text scales instead of reflowing mid-morph). Rotating morphs
  // pivot slightly differently than center-origin — rare and acceptable.
  for (const node of matchedTo) {
    const id = node.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (a.rotation ?? 0) === (b.rotation ?? 0)) continue
    const state = { p: 0 }
    node.style.transformOrigin = '0 0'
    anim.to(state, {
      p: 1,
      duration: MORPH_DURATION,
      ease: MORPH_EASE,
      onUpdate() {
        const p = state.p
        const x = a.x + (b.x - a.x) * p
        const y = a.y + (b.y - a.y) * p
        const w = a.w + (b.w - a.w) * p
        const h = a.h + (b.h - a.h) * p
        const r = (a.rotation ?? 0) + ((b.rotation ?? 0) - (a.rotation ?? 0)) * p
        node.style.transform =
          `translate(${x - b.x}px, ${y - b.y}px)` +
          (r ? ` rotate(${r}deg)` : '') +
          ` scale(${w / Math.max(b.w, 0.01)}, ${h / Math.max(b.h, 0.01)})`
      },
      onComplete() {
        node.style.transformOrigin = ''
        node.style.transform = b.rotation ? `rotate(${b.rotation}deg)` : ''
        resetXform(node)
      },
    })
  }

  // Symbol-level math morph, layered on top of the box morph above. The
  // from-side offsets come from the cache captured while that slide was
  // visible — measuring it now would read zeros (it has no layout).
  for (const to of matchedTo) {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    morphMathSymbols(symCache.get(symKey(fromIdx, id)), to, a, b)
  }

  // Styles morph straight from the model — exact values, no DOM sniffing.
  for (const to of matchedTo) {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    if (a.opacity !== b.opacity) {
      anim.fromTo(to, { opacity: a.opacity }, { opacity: b.opacity, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    if (a.type === 'shape' && b.type === 'shape') {
      const target = to.querySelector<SVGElement>('rect,ellipse,polygon,line,path')
      if (target) morphShapeFill(target, a, b)
    }
    if (a.type === 'text' && b.type === 'text' && a.color !== b.color) {
      const inner = to.querySelector<HTMLElement>('.tessera-text-inner')
      if (inner) {
        anim.fromTo(inner, { color: a.color }, { color: b.color, duration: MORPH_DURATION, ease: MORPH_EASE })
      }
    }
  }
}

// --- fill morphing (solid ⇄ solid, solid ⇄ gradient, gradient ⇄ gradient) ----

const SVG_NS = 'http://www.w3.org/2000/svg'
let morphGradSeq = 0

/** Any solid CSS color we author (#hex / rgb / rgba) → [r, g, b, a]. */
function colorParts(v: string): [number, number, number, number] {
  const m = v?.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[\s,/]+/).map(Number)
    return [p[0] || 0, p[1] || 0, p[2] || 0, Number.isFinite(p[3]) ? p[3] : 1]
  }
  let hex = (v ?? '').trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{6,8}$/.test(hex)) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1,
    ]
  }
  return [0, 0, 0, v === 'transparent' || v === 'none' ? 0 : 1]
}

const rgbaStr = (c: [number, number, number, number]) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Math.round(c[3] * 1000) / 1000})`

/** Color of a gradient evaluated at position t (piecewise-linear between stops). */
function sampleGradient(stops: GradientFill['stops'], t: number): string {
  const s = [...stops].sort((x, y) => x.at - y.at)
  if (t <= s[0].at) return rgbaStr(colorParts(s[0].color))
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (t <= b.at) {
      const f = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at)
      const ca = colorParts(a.color)
      const cb = colorParts(b.color)
      return rgbaStr([0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * f) as [number, number, number, number])
    }
  }
  return rgbaStr(colorParts(s[s.length - 1].color))
}

/**
 * Tween a shape's fill from element a's to element b's. Solids tween the fill
 * attribute; when a gradient is involved the tween runs on the <stop> nodes
 * (colors sampled from the other side at matching positions) and on the
 * gradient line, so angle changes sweep too. A solid destination gets a
 * temporary gradient that collapses to the flat color and is then removed.
 */
function morphShapeFill(target: SVGElement, a: ShapeElement, b: ShapeElement) {
  if (a.fill === b.fill && JSON.stringify(a.fillGradient) === JSON.stringify(b.fillGradient)) return
  // line shapes paint with stroke (fill is the line color in the model)
  if (b.shape === 'line' && target.tagName === 'line') {
    anim.fromTo(target, { attr: { stroke: a.fill } }, { attr: { stroke: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE })
    return
  }
  const ag = a.fillGradient?.stops.length ? a.fillGradient : undefined
  const bg = b.fillGradient?.stops.length ? b.fillGradient : undefined
  if (!ag && !bg) {
    if (a.fill !== b.fill) {
      anim.fromTo(target, { attr: { fill: a.fill } }, { attr: { fill: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    return
  }
  const svg = target.ownerSVGElement
  if (!svg) return

  let lin = svg.querySelector('linearGradient')
  if (!lin) {
    // destination is solid — fabricate a gradient shaped like the source so
    // there is something to tween through, then collapse it to b.fill
    lin = document.createElementNS(SVG_NS, 'linearGradient')
    lin.id = `tessera-morph-grad-${morphGradSeq++}`
    for (const s of ag!.stops) {
      const stop = document.createElementNS(SVG_NS, 'stop')
      stop.setAttribute('offset', String(s.at))
      lin.appendChild(stop)
    }
    const defs = document.createElementNS(SVG_NS, 'defs')
    defs.appendChild(lin)
    svg.appendChild(defs)
    target.setAttribute('fill', `url(#${lin.id})`)
  }

  const stops = [...lin.querySelectorAll('stop')]
  // per rendered stop: where it sits, what it starts as, what it ends as
  const finals = bg ? bg.stops : ag!.stops.map((s) => ({ at: s.at, color: b.fill }))
  stops.forEach((node, i) => {
    const at = finals[i]?.at ?? 1
    const fromColor = ag ? sampleGradient(ag.stops, at) : rgbaStr(colorParts(a.fill))
    const toColor = finals[i]?.color ?? b.fill
    anim.fromTo(
      node,
      { attr: { 'stop-color': fromColor } },
      {
        attr: { 'stop-color': toColor },
        duration: MORPH_DURATION,
        ease: MORPH_EASE,
        ...(i === 0 && !bg
          ? {
              // solid destination: swap the temp gradient back to a flat fill
              onComplete: () => {
                target.setAttribute('fill', b.fill)
                lin!.parentElement?.remove()
              },
            }
          : {}),
      },
    )
  })

  const fromLine = gradientLineCoords((ag ?? bg)!.angle)
  const toLine = gradientLineCoords((bg ?? ag)!.angle)
  anim.fromTo(lin, { attr: fromLine }, { attr: toLine, duration: MORPH_DURATION, ease: MORPH_EASE })
}
