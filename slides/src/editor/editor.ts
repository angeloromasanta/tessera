// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Editor shell: topbar, slide sidebar, canvas, ask-the-agent strip, keyboard
// shortcuts, save & present wiring.

import type { Store } from '../store'
import {
  asTemplateFile, defaultImage, defaultText, dropDevSrc, emptySlide, forkFigureAssets, newDocId, pollConfigured, pollSessionCode, readableInk, remintPollCodes, syncLinkedChart, uid,
  type ChartElement, type Slide, type SlideElement, type TableElement,
} from '../model'
import { renderThumbnail } from '../render'
import { SlideCanvas } from './canvas'
import { AskBar, NewSlidePrompt, NotesView, RequestList, RowAsk, agentNameOf, requestOrbs } from './ask'
import { requestStatus } from '../requests'
import { PhoneView, watchPhone } from './phone'
import { exportFrozenCopy } from './export-frozen'
import { openJoinCodePop } from './joincode'
import { startPresentation } from '../present'
import { clearAllResponses, ensureLecturerKey, exportPollsXlsx, pollsOf } from '../poll'
import { adoptStoredHandle, canWriteInPlace, hasFileHandle, isEncryptionActive, saveFile, serializeJsonParts, writeUpdatedFile } from '../save'
import { addVersion, clearRecovery, docContentKey, getRecovery, listVersions, pruneOld, putRecovery } from '../autosave'
import type { BridgeSave } from '../agent-bridge'
import { insertElements, insertSlides, parseClip, serializeElements, serializeSlides } from './clipboard'
import { openSpeakerWindow, speakerIdleBody } from '../screens'
import { borderPoint, boxCenter, lineEndpoints, setLineEndpoints, sideMidpoint } from './lineedit'
import { ICONS } from '../icons'
import { t, isRtl } from '../i18n'
import { appConfig } from '../../../kernel/src/app.ts'

/** Per-BROWSER, not per-deck: whether the "this browser can't rewrite files"
 *  notice has been acknowledged. It is a property of the browser. */
const SAVE_NOTICE_KEY = 'tessera-save-notice'

export class Editor {
  private canvas!: SlideCanvas
  /** the slide list column: the whole-deck ask on top, then `list` */
  private sidebar!: HTMLElement
  /** the scrolling list of thumbnails (a grid when the column is wide) */
  private list!: HTMLElement
  /** each slide's comment side in the review list (key: slide id, '' = the
   *  whole deck), kept across rebuilds */
  private rows = new Map<string, RowAsk>()
  private newSlide!: NewSlidePrompt
  /** "Slide 3 of 5" above the slide; the notes under it; the agent's status */
  private navLabel!: HTMLElement
  private notesPanel!: HTMLElement
  private agentStatus!: HTMLElement
  private maxBtn: HTMLElement | null = null
  /** slides picked in the list (ids) for moving together; the anchor of a
   *  Shift-click range */
  private picked = new Set<string>()
  private anchor = -1
  private saveState!: HTMLElement
  private thumbTimer = 0
  private thumbScope: Set<string> | null = new Set()
  private presenting = false
  get isPresenting() { return this.presenting }
  private session: import('../sync/session').SyncSession | null = null
  /** slide-list width (px) — user-resizable, persisted per browser */
  private panelW = Editor.PANEL_DEFAULT
  /** the thumbnail column's width in the review list once the person dragged
   *  it (null: it follows the list's width) */
  private thumbW: number | null = null

  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {
    this.build()
    this.wireKeyboard()
    store.on('slides', () => this.rebuildSidebar())
    store.on('current', () => {
      // moving to a slide outside the selection (keys, a link) selects it alone
      const id = this.store.slide?.id
      if (id && !this.picked.has(id)) { this.picked = new Set([id]); this.anchor = this.store.currentIndex }
      this.highlightSidebar()
    })
    store.on('doc', () => this.scheduleThumbs())
    store.on('dirty', () => this.paintSaveState())
    // Leaving writes at once. The browser's leave-page prompt only when the
    // file is known to be behind AND no browser copy holds the edits (a failed
    // save with no IndexedDB): then leaving really loses work (DECISIONS,
    // 2026-10-28).
    window.addEventListener('beforeunload', (ev) => {
      if (!store.dirty) return
      if (this.fileStale && !this.lastBackupAt) ev.preventDefault()
      else void this.runAutosave()
    })
    // leaving the tab: write now rather than after the debounce
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && store.dirty) void this.runAutosave()
    })
    this.wireAutosave()
    this.wirePaste()
    store.on('doc', () => this.syncLinkedCharts())
    store.on('doc', () => this.syncConnectors())
    this.rebuildSidebar()
  }

  /** wire tab-to-tab sync: remote selections and in-text presence of the
   *  other tabs of this deck on this machine */
  connectSync(session: import('../sync/session').SyncSession) {
    this.store.on('historyConflict', () => this.toast(t('Cannot undo: the affected content has changed.')))
    this.session = session
    session.onPeers(() => this.canvas.setRemotePeers(session.peers()))
    this.canvas.onTextEditChange = (elId) => session.setEditing(elId)
    this.store.on('current', () => this.canvas.setRemotePeers(session.peers()))
  }

  // --- DOM ----------------------------------------------------------------

  private build() {
    this.root.innerHTML = ''
    this.root.className = 'ed-root'

    // topbar. AI-native fork: the agent builds the deck, so the bar keeps the
    // title and its save state, the agent's status, Present, and one menu for
    // the file operations a person rarely needs.
    const bar = div('ed-topbar')
    const title = document.createElement('input')
    title.className = 'ed-title'
    title.title = t('Deck title — shown in the tab, on {{title}} fields, and as the suggested file name')
    title.value = this.store.doc.title
    title.spellcheck = false
    title.addEventListener('change', () => {
      this.store.commit(() => { this.store.doc.title = title.value || 'Untitled' })
      document.title = `${this.store.doc.title} — ${appConfig().appName}`
    })
    title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') title.blur() })
    // remote/programmatic title changes reflect live (unless being typed in)
    this.store.on('doc', () => {
      if (document.activeElement !== title && title.value !== this.store.doc.title) {
        title.value = this.store.doc.title
        document.title = `${this.store.doc.title} — ${appConfig().appName}`
      }
    })
    // the save state in words; a click saves now (⌘S). Capability-aware: on
    // Safari/Firefox (and every iOS browser) there is no File System Access
    // API, so ⌘S CANNOT rewrite this file — it hands back a copy.
    this.saveState = btn('<i class="ed-save-icon"></i>', ' ', () => void this.save(false))
    this.saveState.classList.add('ed-savestate')

    // right: [◌ working on 2 requests] [☁ Saved ▾] [▶ Present ▾] — the save
    // state IS the save button, and its ▾ holds copies, history, export and
    // the agent switch
    const actions = div('ed-group ed-group-right')
    this.agentStatus = div('ed-agent-status')
    this.agentStatus.hidden = true
    actions.append(this.agentStatus, this.saveButton(), this.presentButton())
    bar.append(title, actions)

    // main area: [the review list: a comment field beside every slide, the
    // whole deck first | "Slide n of N", the slide, its speaker notes]
    const main = div('ed-main')
    this.sidebar = div('ed-sidebar')
    const head = div('ed-review-head')
    head.append(
      Object.assign(document.createElement('span'), { className: 'ed-review-h1', textContent: t('Slide') }),
      Object.assign(document.createElement('span'), { className: 'ed-review-h2', textContent: t('What should change?') }),
      Object.assign(document.createElement('span'), { className: 'ed-review-hint', textContent: t('Enter sends · Shift+Enter new line') }),
    )
    this.maxBtn = btn(ICONS.maximize, '', () => this.setMaximized(!this.maximized), t('Maximize the list to reorder slides in a grid'))
    this.maxBtn.classList.add('ed-max-btn')
    head.append(
      Object.assign(document.createElement('span'), { className: 'ed-max-hint', textContent: t('Click, Shift-click or Ctrl-click to pick slides, drag to move them · double-click opens one · Esc returns') }),
      this.maxBtn,
    )
    this.list = div('ed-slidelist')
    this.sidebar.append(head, this.list, this.makeColumnHandle())
    this.wireListSelection()
    const nav = div('ed-slidenav')
    this.navLabel = div('ed-slidenav-label')
    const prev = btn('‹', '', () => this.store.goToLinear(-1), t('Previous slide'))
    const next = btn('›', '', () => this.store.goToLinear(1), t('Next slide'))
    prev.classList.add('ed-slidenav-btn')
    next.classList.add('ed-slidenav-btn')
    const navBtns = div('ed-slidenav-btns')
    navBtns.append(prev, next)
    nav.append(this.navLabel, navBtns)
    const canvasWrap = div('ed-canvas-wrap')
    const center = div('ed-center')
    this.notesPanel = div('ed-notes-panel')
    const notesHead = document.createElement('button')
    notesHead.className = 'ed-notes-head'
    notesHead.textContent = t('Speaker notes')
    notesHead.title = t('Show or hide the speaker notes (])')
    notesHead.addEventListener('click', () => this.toggleNotes())
    this.notesPanel.append(notesHead, new NotesView(this.store).root)
    try { if (localStorage.getItem('tessera-ed-notes') === 'hidden') this.notesPanel.classList.add('collapsed') } catch { /* defaults */ }
    center.append(nav, canvasWrap, this.notesPanel)
    main.append(this.sidebar, this.makeResizer(), center)

    this.root.append(bar, main)

    // phones/small windows: start with the slide list collapsed so the CANVAS
    // is what you see — its chevron (and [) brings it back
    if (window.innerWidth < 700) this.sidebar.classList.add('ed-collapsed')

    this.restorePanelWidth()
    this.canvas = new SlideCanvas(canvasWrap, this.store)
    this.canvas.onSlideNav = (dir) => this.store.goToLinear(dir)
    this.newSlide = new NewSlidePrompt(canvasWrap, this.store)
    this.wireAgentEditing(canvasWrap)

    // Phones: the slides stacked in one scroll and the ask box, no editing
    // (phone.ts). The desktop DOM stays built and hidden; its canvas holds its
    // slide (and any running figure) until the view comes back. The phone's
    // own request cards and box wait in a hidden holder until it docks them.
    const holder = div('ed-phone-holder')
    holder.hidden = true
    this.root.appendChild(holder)
    const phoneReqs = new RequestList(this.store)
    holder.appendChild(phoneReqs.root)
    const ask = new AskBar(holder, this.store)
    const phone = new PhoneView(this.root, this.store, phoneReqs, ask, () => this.present(false, false))
    watchPhone((on) => {
      this.root.classList.toggle('ed-phone', on)
      document.body.classList.toggle('ed-phone-on', on)
      this.canvas.hold(on)
      if (on) phone.activate()
      else phone.deactivate()
    })
  }

  /** Speaker notes under the slide fold to their header (]). */
  private toggleNotes() {
    const on = this.notesPanel.classList.toggle('collapsed')
    try { localStorage.setItem('tessera-ed-notes', on ? 'hidden' : 'shown') } catch { /* session only */ }
  }

  // --- the agent at work, Present, the Save menu ----------------------------------

  /** What the agent is doing, shown three ways: a thumbnail ring and a chip on
   *  the canvas for 5 s after each edit it makes to a slide (agent-editor.ts
   *  reports tessera-agent-edited), the same chip while a request on the open
   *  slide is being worked on, and the top bar's "… working on N requests".
   *  The name is the one the agent signs its edits or replies with; with none,
   *  the words are neutral (the editor serves any agent). */
  private wireAgentEditing(canvasWrap: HTMLElement) {
    const chip = div('ed-editing-chip')
    chip.hidden = true
    canvasWrap.appendChild(chip)
    const until = new Map<string, number>()
    let who = ''
    let timer = 0
    const allThreads = () => [...(this.store.doc.requests ?? []), ...this.store.doc.slides.flatMap((s) => s.comments ?? [])].filter((c) => c.request)
    const paint = () => {
      const now = Date.now()
      for (const [id, at] of until) if (at <= now) until.delete(id)
      this.list.querySelectorAll<HTMLElement>('.ed-thumb[data-index]').forEach((item) => {
        const id = this.store.doc.slides[Number(item.dataset.index)]?.id
        item.classList.toggle('ed-thumb-editing', !!id && until.has(id))
      })
      const slide = this.store.slide
      const working = (slide?.comments ?? []).some((c) => c.request && requestStatus(c) === 'working')
      const name = who || agentNameOf(slide?.comments ?? []) || agentNameOf(allThreads())
      const here = until.has(slide?.id ?? '') || working
      chip.hidden = !here
      chip.textContent = here ? (name ? t('{name} is updating this slide', { name }) : t('Updating this slide…')) : ''
      // the top bar: requests being worked on across the deck
      const n = allThreads().filter((c) => requestStatus(c) === 'working').length
      this.agentStatus.hidden = !n
      this.agentStatus.textContent = !n ? ''
        : name ? (n === 1 ? t('{name} is working on 1 request', { name }) : t('{name} is working on {n} requests', { name, n }))
          : (n === 1 ? t('Working on 1 request') : t('Working on {n} requests', { n }))
      clearTimeout(timer)
      if (until.size) timer = window.setTimeout(paint, Math.max(200, Math.min(...until.values()) - now))
    }
    window.addEventListener('tessera-agent-edited', ((ev: CustomEvent) => {
      who = ev.detail.agent || ''
      for (const id of ev.detail.slideIds as string[]) until.set(id, Date.now() + 5000)
      paint()
    }) as EventListener)
    this.store.on('current', paint)
    this.store.on('doc', paint)
    this.store.on('slides', () => queueMicrotask(paint))
    paint()
  }

  /** Present: the main action. Its menu holds the other ways to present and,
   *  for a deck with questions, the code the audience joins with. */
  private presentButton(): HTMLElement {
    const group = div('ed-split ed-present')
    const main = btn(ICONS.play, t('Present'), () => this.present(false, true),
      t('Start the slideshow fullscreen — F toggles fullscreen, S opens speaker view, Esc ends'))
    main.classList.add('ed-btn-primary')
    const wrap = dropdown(t('More ways to present'), group, (item, sep) => {
      item(ICONS.window, t('Present in this tab'), t('Fills this tab instead of going fullscreen — handy for testing or sharing a window'), () => this.present(false, false))
      item(ICONS.presenter, t('Open speaker view'), t('Notes, controls and slide thumbnails in a separate window — drag it to a second screen. On macOS, open it before going fullscreen.'), () => this.openSpeakerView())
      sep('ed-join-only')
      item(ICONS.key, t('Join code'), t('Join code — the code the audience types to answer this deck’s polls'),
        () => openJoinCodePop(this.store, group, (m) => this.toast(m)), 'ed-join-only ed-join-item')
    })
    const paintJoin = () => {
      const code = this.store.doc.poll?.session
      const hasPolls = this.store.doc.slides.some((s) => s.elements.some((e) => e.type === 'poll'))
      group.classList.toggle('has-join', hasPolls || !!code)
      const label = wrap.querySelector('.ed-join-item span')
      if (label) label.textContent = code ? t('Join code: {code}', { code }) : t('Join code')
    }
    paintJoin()
    this.store.on('doc', paintJoin)
    group.append(main, wrap)
    return group
  }

  /** [☁ Saved ▾]: the save state is the button (a click or ⌘S saves); the ▾
   *  holds copies, version history, export, the deck's poll answers and the
   *  agent switch. */
  private saveButton(): HTMLElement {
    const host = div('ed-split ed-save')
    host.appendChild(this.saveState)
    this.paintSaveState()
    const wrap = dropdown(t('Save options — a copy, version history, export'), host, (item, sep) => {
      item(ICONS.copy, t('Save a copy…'),
        t('A new file that is its own deck — it never syncs with this one; you then work on the copy'),
        () => void this.saveCopy())
      item(ICONS.history, t('Version history…'),
        t('Restore an earlier auto-saved version of this deck (kept locally in this browser).'),
        () => void this.openVersionHistory())
      sep()
      item(ICONS.download, t('Export a frozen copy…'),
        t('Export a frozen copy — every poll shows its results and can no longer be answered; no editor'),
        () => void exportFrozenCopy(this.store, (m) => this.toast(m)))
      item(ICONS.download, t('Export answers (Excel)'), t('Download every question’s answers as one Excel workbook'),
        () => void this.exportAnswers(), 'ed-poll-only')
      item(ICONS.trash, t('Clear answers…'),
        t('Delete the answers every question in this deck has collected — after a rehearsal, before the real talk'),
        () => void this.clearAnswers(), 'ed-poll-only')
      sep('ed-agent-only')
      item('', t('Pause agent edits'), t('Stop local agents from changing this file until you turn them back on'),
        () => window.dispatchEvent(new Event('tessera-agent-toggle')), 'ed-agent-only ed-agent-toggle')
    })
    const paint = () => host.classList.toggle('has-polls', pollsOf(this.store.doc).length > 0)
    paint()
    this.store.on('doc', paint)
    // the agent switch exists where an agent can connect (agent-bridge.ts)
    window.addEventListener('tessera-agent-status', ((ev: CustomEvent) => {
      host.classList.add('has-agent')
      const label = wrap.querySelector('.ed-agent-toggle span')
      if (label) label.textContent = ev.detail.off ? t('Turn agent edits back on') : t('Pause agent edits')
    }) as EventListener)
    host.appendChild(wrap)
    return host
  }

  // --- resizable slide list ---------------------------------------------------

  private static get PANEL_DEFAULT() { return Math.max(Editor.REVIEW_AT, Math.min(540, Math.round(window.innerWidth * 0.4))) }

  /** [min, max] of the slide list's width: anything that leaves the slide room;
   *  the grid is the maximize button's, not a width */
  private static get PANEL_BOUNDS(): [number, number] {
    return [150, Math.max(Editor.REVIEW_AT + 60, window.innerWidth - 360)] // the slide keeps 360 px
  }

  private restorePanelWidth() {
    try {
      const saved = JSON.parse(localStorage.getItem('tessera-ed-review') ?? '{}')
      const [min, max] = Editor.PANEL_BOUNDS
      if (typeof saved.left === 'number') this.panelW = Math.min(max, Math.max(min, saved.left))
      if (typeof saved.thumb === 'number') this.thumbW = saved.thumb
    } catch { /* corrupt storage — keep the default */ }
    this.applyPanelWidth()
  }

  private applyPanelWidth() {
    this.sidebar.style.setProperty('--panew', `${this.panelW}px`)
  }

  private panelToggle: HTMLElement | null = null

  private updatePanelChevron() {
    const b = this.panelToggle
    if (!b) return
    const collapsed = this.sidebar.classList.contains('ed-collapsed')
    // the chevron points where clicking will move the boundary; under an RTL
    // chrome the slide list sits on the right, so the arrow turns around too
    const g = collapsed ? '›' : '‹'
    b.textContent = isRtl() ? (g === '›' ? '‹' : '›') : g
    b.title = collapsed ? t('Show slide list ([)') : t('Hide slide list ([)')
  }

  private makeResizer(): HTMLElement {
    const handle = div('ed-resizer')
    handle.title = t('Drag to resize · double-click to reset')
    const toggle = document.createElement('button')
    toggle.className = 'ed-panel-toggle'
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.togglePanel()
    })
    this.panelToggle = toggle
    handle.appendChild(toggle)
    queueMicrotask(() => this.updatePanelChevron())
    const commit = () => {
      // its own key since the review list (2026-10-28): older saved widths
      // were the narrow thumbnail column
      this.savePanel()
      // thumbnails render at a width derived from the sidebar — refit them
      this.rebuildSidebar()
    }
    handle.addEventListener('mousedown', (down) => {
      if (down.target === toggle) return // the chevron is a click, not a drag
      if (this.sidebar.classList.contains('ed-collapsed')) return
      down.preventDefault()
      const startX = down.clientX
      const startW = this.panelW
      const [min, max] = Editor.PANEL_BOUNDS
      this.sidebar.classList.add('ed-noanim')
      document.body.classList.add('ed-col-resizing')
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        // clientX is physical; RTL docks the slide list to the right edge
        this.panelW = Math.min(max, Math.max(min, startW + (isRtl() ? -dx : dx)))
        this.applyPanelWidth()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        this.sidebar.classList.remove('ed-noanim')
        document.body.classList.remove('ed-col-resizing')
        commit()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    handle.addEventListener('dblclick', () => {
      this.panelW = Editor.PANEL_DEFAULT
      this.applyPanelWidth()
      commit()
    })
    return handle
  }

  private savePanel() {
    try {
      localStorage.setItem('tessera-ed-review', JSON.stringify({ left: this.panelW, ...(this.thumbW === null ? {} : { thumb: this.thumbW }) }))
    } catch { /* session only */ }
  }

  /** The line between the thumbnails and the comments in the review list:
   *  dragging it trades width between them; double-click hands the thumbnail
   *  width back to the list's width. */
  private makeColumnHandle(): HTMLElement {
    const handle = div('ed-col-handle')
    handle.title = t('Drag to resize · double-click to reset')
    handle.addEventListener('mousedown', (down) => {
      if (this.mode !== 'review') return
      down.preventDefault()
      down.stopPropagation()
      const startX = down.clientX
      const startW = this.thumbWidth(false)
      document.body.classList.add('ed-thumbcol-resizing')
      handle.classList.add('dragging')
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        this.thumbW = Math.round(startW + (isRtl() ? -dx : dx))
        this.rescaleThumbs()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.classList.remove('ed-thumbcol-resizing')
        handle.classList.remove('dragging')
        this.thumbW = this.thumbWidth(false) // what the bounds let it be
        this.savePanel()
        this.rebuildSidebar()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    handle.addEventListener('dblclick', () => {
      this.thumbW = null
      this.savePanel()
      this.rebuildSidebar()
    })
    return handle
  }

  /** Resize the thumbnails in place while the column line is dragged (a
   *  rebuild per mouse move would re-render every slide). */
  private rescaleThumbs() {
    this.sidebar.style.setProperty('--thumbw', `${this.thumbWidth(false)}px`)
    const { width, height } = this.store.doc.size
    this.list.querySelectorAll<HTMLElement>('.ed-thumb[data-index]').forEach((item) => {
      const slide = this.store.doc.slides[Number(item.dataset.index)]
      const surface = item.querySelector<HTMLElement>('.tessera-thumb-surface')
      if (!slide || !surface) return
      const w = this.thumbWidth(!!slide.stateOf)
      surface.style.width = `${w}px`
      surface.style.height = `${(height * w) / width}px`
      const inner = surface.firstElementChild as HTMLElement | null
      if (inner) inner.style.transform = `scale(${w / width})`
    })
    this.rows.forEach((r) => r.grow())
  }

  /** Collapse/expand the slide list. */
  togglePanel() {
    this.sidebar.classList.toggle('ed-collapsed')
    this.updatePanelChevron()
    // the canvas wrap resizes; its ResizeObserver re-fits the stage
  }

  /** Deck-wide, like the export: resetting after a rehearsal means every
   *  question, not a hunt through the slides (a hive's poll sits hidden under
   *  its embed). clearResponses asks for the lecturer key on a 401, once. */
  private async clearAnswers() {
    const polls = pollsOf(this.store.doc)
    if (!polls.length) return
    const n = new Set(polls.map((p) => p.el.code)).size
    if (!confirm(t('Delete every response to all {n} questions in this deck? Export them first to keep them. This cannot be undone.', { n }))) return
    try {
      if (!pollConfigured(polls[0].el)) throw new Error(t('This deck has no poll service yet.'))
      const r = await clearAllResponses(this.store.doc)
      if (r.failed.length) {
        alert(t('Could not clear {failed} of {total} questions: {err}', {
          failed: r.failed.length, total: r.questions, err: r.failed[0].err,
        }))
      }
      this.toast(t('Cleared {n} responses from {q} questions.', { n: r.cleared, q: r.questions - r.failed.length }))
    } catch (err) {
      alert(t('Could not clear responses: {err}', { err: String((err as Error)?.message ?? err) }))
    }
  }

  /** One workbook of the whole session: an overview sheet with the tallies,
   *  then a tab per question. Reading answers needs the lecturer key on a
   *  gated service, so it is asked for first (only when the service wants one
   *  and the key held here is wrong). */
  private async exportAnswers() {
    const first = pollsOf(this.store.doc)[0]?.el
    if (!first) return
    try {
      if (!pollConfigured(first)) throw new Error(t('This deck has no poll service yet.'))
      if (!(await ensureLecturerKey(first.service))) return
      const { questions, answers, failed, withheld } = await exportPollsXlsx(this.store.doc)
      // Loud, not a toast: a spreadsheet that is empty for want of a key is
      // indistinguishable from one that is empty because nobody answered.
      if (withheld.length) {
        alert(t('{n} of {total} questions exported with NO answers: the poll service withholds them without a valid lecturer key.', {
          n: withheld.length, total: questions,
        }))
      }
      this.toast(failed.length
        ? t('Exported {n} of {total} questions — {failed} could not be loaded.', {
          n: questions - failed.length, total: questions, failed: failed.length,
        })
        : t('Exported {n} responses from {q} questions.', { n: answers, q: questions }))
    } catch (err) {
      alert(String((err as Error)?.message ?? err))
    }
  }


  /** Save a copy…: a new file that is its own deck (new docId, so it never
   *  syncs with this one), and this editor becomes it. A copy that shared the
   *  docId kept two files editing each other (four versions of one deck), so
   *  there is no such copy any more. The one real choice is the questions:
   *  shared with this deck (a new version for the same room) or fresh. */
  private async saveCopy() {
    this.canvas.commitTextEdit()
    let fresh = false
    if (pollsOf(this.store.doc).length) {
      const pick = await this.choose(t('Save a copy'), t('The copy is a separate deck. What about its questions?'), [
        { value: 'same', label: t('Same room — keep the answers and the join code'), primary: true },
        { value: 'fresh', label: t('Another room — empty questions, new join code') },
      ])
      if (!pick) return
      fresh = pick === 'fresh'
    }
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').TesseraDoc
    clone.docId = newDocId()
    delete clone.collab // a new deck carries no live-session credentials
    // Another room: fresh answer buckets and a fresh session, or this copy
    // would steer (and pool answers with) the deck it came from.
    if (fresh) {
      for (const slide of clone.slides) remintPollCodes(slide.elements)
      if (clone.poll?.session) clone.poll.session = pollSessionCode()
    }
    // The copy gets its OWN FILE before this editor becomes it. The other way
    // round (swap the document, then ask where to save) left the new deck in
    // memory with the ORIGINAL file still the ⌘S/autosave target: a cancelled
    // picker and the autosave timer wrote the copy over the original, and the
    // two files then shared whatever identity was saved last.
    let result: Awaited<ReturnType<typeof saveFile>>
    try {
      result = await saveFile(JSON.parse(JSON.stringify(clone)), true)
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
      return
    }
    if (result === 'cancelled') return
    if (result === 'downloaded') {
      // No handle to the copy, and the old one (if any) still points at the
      // original — so this editor stays the original and the copy is the file
      // in Downloads.
      this.toast(canWriteInPlace()
        ? t('Couldn’t write that file — a copy went to Downloads instead')
        : t('This browser can’t rewrite files in place — a fresh copy went to Downloads'))
      return
    }
    this.store.replaceDoc(clone)
    // Undo must not reach back across the fork: it would restore the original's
    // docId, live-session keys and poll codes into the copy's file.
    this.store.clearHistory()
    window.dispatchEvent(new Event('tessera-file-target-changed'))
    // rewrite through the new handle: file form (template), baseline
    void this.save(false)
    this.toast(t('Saved a copy — you are now working on it'))
  }

  /** A small modal with a choice; resolves to its value, or null on cancel. */
  private choose(title: string, text: string, options: Array<{ value: string; label: string; primary?: boolean }>): Promise<string | null> {
    return new Promise((resolve) => {
      document.querySelector('.ed-about-overlay')?.remove()
      const overlay = div('ed-about-overlay')
      const box = div('ed-about ed-choose')
      const h = document.createElement('h2')
      h.textContent = title
      const p = document.createElement('p')
      p.textContent = text
      box.append(h, p)
      const done = (v: string | null) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v) }
      for (const o of options) {
        const b = document.createElement('button')
        b.className = 'ed-btn' + (o.primary ? ' ed-btn-primary' : '')
        b.textContent = o.label
        b.addEventListener('click', () => done(o.value))
        box.appendChild(b)
      }
      const cancel = document.createElement('button')
      cancel.className = 'ed-btn ed-choose-cancel'
      cancel.textContent = t('Cancel')
      cancel.addEventListener('click', () => done(null))
      box.appendChild(cancel)
      const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); done(null) } }
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(null) })
      document.addEventListener('keydown', onKey, true)
      overlay.appendChild(box)
      document.body.appendChild(overlay)
      box.querySelector<HTMLElement>('.ed-btn-primary')?.focus()
    })
  }

  /**
   * Give THIS file its own identity, in place. The counterpart of "Save a
   * copy…" for a copy that already exists: a file copied in Explorer (or saved
   * by an older shell's "Save a copy…") still carries the original's docId, so the
   * two are one deck to every tab, room and recovery slot. Poll codes stay
   * unless asked — a new version of a deck usually keeps teaching the same
   * room. The other file's recovery slot and versions are left alone: they
   * are its. Reached from the banner that appears when both files are open.
   */
  private makeIndependent(newPolls: boolean) {
    this.canvas.commitTextEdit()
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').TesseraDoc
    clone.docId = newDocId()
    delete clone.collab // the old live-session credentials belong to the original
    if (newPolls) {
      for (const slide of clone.slides) remintPollCodes(slide.elements)
      if (clone.poll?.session) clone.poll.session = pollSessionCode()
    }
    const at = this.store.currentIndex
    this.store.replaceDoc(clone)
    // undo must not restore the shared identity
    this.store.clearHistory()
    this.store.goTo(at)
    this.canvas.render()
    document.querySelector('.ed-ident')?.remove()
    this.toast(t('This file is now its own deck — it no longer syncs with its copies'))
    void this.save(false)
  }

  /** Another FILE with this deck's id is open (identity-watch.ts). */
  showIdentityClash(otherName: string) {
    document.querySelector('.ed-ident')?.remove()
    const bar = div('ed-recover ed-ident')
    const msg = document.createElement('span')
    msg.textContent = t('“{name}” is open too and has the same deck ID — edits in one will appear in the other.', { name: otherName })
    const fork = document.createElement('button')
    fork.className = 'ed-btn ed-btn-primary'
    fork.textContent = t('Make this file independent')
    fork.addEventListener('click', () => this.makeIndependent(false))
    const keep = document.createElement('button')
    keep.className = 'ed-btn'
    keep.textContent = t('Keep them linked')
    keep.addEventListener('click', () => bar.remove())
    bar.append(msg, fork, keep)
    document.body.appendChild(bar)
  }

  // --- sidebar: the review list ------------------------------------------------

  /** How the slide list lays out: thumbnails only when dragged narrow, the
   *  review list (a comment field beside every slide; widening it only grows
   *  the thumbnails), or — maximized, hiding the slide — the grid: the sorter
   *  view, orbs only, no fields. */
  private static REVIEW_AT = 330
  private maximized = false
  private get mode(): 'thumbs' | 'review' | 'grid' {
    return this.maximized ? 'grid' : this.panelW >= Editor.REVIEW_AT ? 'review' : 'thumbs'
  }
  private get grid() { return this.mode === 'grid' }

  /** Thumbnail width: beside the comments it grows with the column (150 to
   *  360 px) until the person drags the line between them (then theirs, as
   *  long as the comments keep 160 px), alone it fills the column, in the grid
   *  it is a cell's. */
  private thumbWidth(isState: boolean): number {
    const mode = this.mode
    const base = mode === 'review'
      ? this.thumbW !== null
        ? Math.round(Math.max(100, Math.min(this.thumbW, this.panelW - 70 - 160))) // 70: row chrome
        : Math.round(Math.min(360, Math.max(150, (this.panelW - 60) * 0.42)))
      : mode === 'thumbs' ? Math.max(96, this.panelW - 52)
        : (() => {
          const inner = (this.sidebar.clientWidth || window.innerWidth) - 40 - 22 // padding, scrollbar gutter, borders
          const cols = Math.max(2, Math.floor((inner + 14) / (220 + 14)))
          return Math.floor((inner - 14 * (cols - 1)) / cols) - 4 // 2px border each side
        })()
    return isState ? Math.round(base * 0.84) : base
  }

  /** Maximize: the list takes the whole area (slide and notes hidden) as a
   *  grid for reordering; the same button or Esc restores. */
  private setMaximized(on: boolean) {
    if (on === this.maximized) return
    this.maximized = on
    this.sidebar.classList.toggle('ed-max', on)
    this.sidebar.classList.remove('ed-collapsed')
    if (this.maxBtn) {
      this.maxBtn.innerHTML = on ? ICONS.minimize : ICONS.maximize
      this.maxBtn.title = on ? t('Back to the slide (Esc)') : t('Maximize the list to reorder slides in a grid')
    }
    this.rebuildSidebar()
    if (!on) requestAnimationFrame(() => this.list.querySelector<HTMLElement>('.ed-row.active')?.scrollIntoView({ block: 'nearest' }))
  }

  /** The comment side of a slide's row, kept across rebuilds so a half-typed
   *  comment survives a move or an insert. */
  private rowAsk(slideId: string | null): RowAsk {
    const key = slideId ?? ''
    let r = this.rows.get(key)
    if (!r) {
      r = new RowAsk(this.store, slideId, { sent: () => this.afterSent(slideId), move: (dir) => this.moveRow(slideId, dir) })
      this.rows.set(key, r)
    }
    return r
  }

  /** Enter in a row sends and moves on to the next slide's field, so a whole
   *  deck can be reviewed without a click. */
  private afterSent(slideId: string | null) {
    const slides = this.store.doc.slides
    const i = slideId === null ? -1 : slides.findIndex((s) => s.id === slideId)
    let j = i + 1
    while (j < slides.length && slides[j].stateOf) j++
    if (j >= slides.length) return
    this.store.goTo(j)
    this.rows.get(slides[j].id)?.focus()
  }

  /** Up/Down out of a row's field: the field of the row above or below (the
   *  whole deck sits above slide 1), whose slide opens. */
  private moveRow(slideId: string | null, dir: 1 | -1): boolean {
    const order = [null, ...this.store.doc.slides.map((s) => s.id)]
    const k = order.indexOf(slideId) + dir
    if (k < 0 || k >= order.length) return false
    const id = order[k]
    const r = this.rows.get(id ?? '')
    if (!r) return false
    if (id !== null) this.store.goTo(k - 1)
    r.focusAt(dir > 0 ? 'start' : 'end')
    return true
  }

  private makeRow(slide: Slide, i: number, isState: boolean): HTMLElement {
    const row = div('ed-row')
    row.dataset.index = String(i)
    if (isState) row.classList.add('ed-row-state')
    const item = div('ed-thumb')
    item.dataset.index = String(i)
    item.draggable = !isState
    const num = div('ed-thumb-num')
    let label: string
    if (isState) {
      const parentIdx = this.store.doc.slides.findIndex((s) => s.id === slide.stateOf)
      label = slide.name ?? `⤷ ${parentIdx + 1}`
      num.title = `Interactive state of slide ${parentIdx + 1} — reached via links while presenting`
    } else {
      label = String(this.linearNumber(i))
    }
    num.textContent = label
    const surface = renderThumbnail(slide, this.store.doc, this.thumbWidth(isState))
    paintOrbs(item, slide.comments, this.mode !== 'review')
    const tools = div('ed-thumb-tools')
    tools.append(
      btn(ICONS.copy, '', (ev) => { ev.stopPropagation(); this.duplicateSlide(i) }, t('Duplicate slide')),
      btn(ICONS.trash, '', (ev) => { ev.stopPropagation(); this.deleteSlide(i) }, t('Delete slide')),
    )
    item.append(num, surface, tools)
    if (this.mode === 'review') {
      const rn = div('ed-row-num')
      rn.textContent = isState ? '' : label
      row.append(rn, item, this.rowAsk(slide.id).root)
    } else row.append(item)
    return row
  }

  /** The first row of the review list: requests about the whole deck. No
   *  thumbnail: a small label, and the comments take the whole width. */
  private deckRow(): HTMLElement {
    const row = div('ed-row ed-row-deck')
    const label = div('ed-row-deck-label')
    label.innerHTML = ICONS.layers
    label.appendChild(Object.assign(document.createElement('span'), { textContent: t('Whole deck') }))
    row.append(label, this.rowAsk(null).root)
    return row
  }

  /** 1-based position among non-state slides (what the audience counts). */
  private linearNumber(i: number): number {
    return this.store.doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
  }

  private rebuildSidebar() {
    // States sit in doc order right after their parent and render nested —
    // smaller, indented, dimmed — so the structure reads at a glance.
    const scroll = this.list.scrollTop
    const focused = document.activeElement
    const mode = this.mode
    this.list.innerHTML = ''
    this.sidebar.classList.toggle('ed-grid', mode === 'grid')
    this.sidebar.classList.toggle('ed-review', mode === 'review')
    this.sidebar.style.setProperty('--thumbw', `${this.thumbWidth(false)}px`)
    this.newSlide.setActive(mode !== 'review')
    const slides = this.store.doc.slides
    const ids = new Set(slides.map((s) => s.id))
    for (const id of this.picked) if (!ids.has(id)) this.picked.delete(id)
    for (const key of this.rows.keys()) if (key && !ids.has(key)) this.rows.delete(key)
    if (mode === 'review') this.list.appendChild(this.deckRow())
    slides.forEach((slide, i) => {
      // hover gap = insert here; never between a parent and its states
      if (!slide.stateOf && mode !== 'grid') this.list.appendChild(this.insertGap(i))
      this.list.appendChild(this.makeRow(slide, i, !!slide.stateOf))
    })
    if (mode !== 'grid') this.list.appendChild(this.insertGap(slides.length))
    const add = btn(ICONS.plus, t('New slide'), () => this.insertEmptySlide(this.afterBlock(this.store.currentIndex)))
    add.classList.add('ed-add-slide')
    add.title = t('Add a slide after this one and say what it should be')
    this.list.appendChild(add)
    this.list.scrollTop = scroll
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus()
    this.rows.forEach((r) => r.grow())
    this.highlightSidebar()
  }

  /** The index just past slide `i` and its interactive states. */
  private afterBlock(i: number): number {
    const slides = this.store.doc.slides
    const parent = slides[i]?.stateOf ? slides.findIndex((s) => s.id === slides[i].stateOf) : i
    let j = parent + 1
    while (j < slides.length && slides[j].stateOf) j++
    return j
  }

  /** A new slide at `at` is an empty one; what it should be is a comment in
   *  its row ("What should this slide be?"), or in the box on the canvas when
   *  the list shows no fields. No layout picker. */
  private insertEmptySlide(at: number) {
    const slide = emptySlide({ background: this.store.doc.theme.background || '#FFFFFF' })
    this.store.commit(() => { this.store.doc.slides.splice(at, 0, slide) }, 'slides')
    this.store.goTo(at)
    requestAnimationFrame(() => {
      this.list.querySelector<HTMLElement>('.ed-row.active')?.scrollIntoView({ block: 'nearest' })
      if (this.mode === 'review') this.rows.get(slide.id)?.focus()
      else this.newSlide.focus()
    })
  }

  /** Slim hover strip between rows — click inserts an empty slide there. */
  private insertGap(at: number): HTMLElement {
    const gap = div('ed-insertgap')
    gap.title = t('Insert a slide here')
    const plus = document.createElement('button')
    plus.className = 'ed-insertgap-btn'
    plus.textContent = '＋'
    plus.tabIndex = -1
    gap.appendChild(plus)
    gap.addEventListener('click', () => this.insertEmptySlide(at))
    return gap
  }

  /** Click picks one slide, Shift-click a range, Ctrl/⌘-click toggles one;
   *  dragging any picked thumbnail moves them all (with their states), before
   *  or after the row it is dropped on. One listener set on the list; the
   *  comment fields stop their own clicks. */
  private wireListSelection() {
    const rowOf = (ev: Event) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('.ed-row')
      return row && row.dataset.index !== undefined ? row : null
    }
    this.list.addEventListener('click', (ev) => {
      const row = rowOf(ev)
      if (!row) return
      const i = Number(row.dataset.index)
      const id = this.store.doc.slides[i]?.id
      if (!id) return
      if (ev.shiftKey) {
        const from = this.anchor >= 0 && this.anchor < this.store.doc.slides.length ? this.anchor : this.store.currentIndex
        const [a, b] = from < i ? [from, i] : [i, from]
        this.picked = new Set(this.store.doc.slides.slice(a, b + 1).map((s) => s.id))
      } else if (ev.ctrlKey || ev.metaKey) {
        if (this.picked.has(id) && this.picked.size > 1) {
          this.picked.delete(id)
          this.anchor = i
          this.highlightSidebar()
          return // stays on the open slide
        }
        this.picked.add(id)
        this.anchor = i
      } else {
        this.picked = new Set([id])
        this.anchor = i
      }
      if (i === this.store.currentIndex) this.highlightSidebar()
      else this.store.goTo(i) // the 'current' handler keeps the picked set: it holds i
    })

    this.list.addEventListener('dblclick', (ev) => {
      const row = rowOf(ev)
      if (!row || !this.maximized) return
      const i = Number(row.dataset.index)
      this.setMaximized(false)
      this.store.goTo(i)
    })

    let dragging: string[] = []
    const clearMarks = () => this.list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'))
    const side = (row: HTMLElement, ev: DragEvent): 'before' | 'after' => {
      const r = row.getBoundingClientRect()
      if (this.grid) return (ev.clientX < r.left + r.width / 2) !== isRtl() ? 'before' : 'after'
      return ev.clientY < r.top + r.height / 2 ? 'before' : 'after'
    }
    this.list.addEventListener('dragstart', (ev) => {
      const thumb = (ev.target as HTMLElement).closest?.('.ed-thumb')
      const row = rowOf(ev)
      const id = row && this.store.doc.slides[Number(row.dataset.index)]?.id
      if (!thumb || !row || !id) return
      if (!this.picked.has(id)) { this.picked = new Set([id]); this.highlightSidebar() }
      dragging = this.store.doc.slides.filter((s) => this.picked.has(s.id) && !s.stateOf).map((s) => s.id)
      ev.dataTransfer!.setData('text/tessera-slides', JSON.stringify(dragging))
      ev.dataTransfer!.effectAllowed = 'move'
      this.list.classList.add('ed-dragging')
    })
    // A drop rebuilds the list, which detaches the dragged row, so its dragend never
    // bubbles here: end the drag on the document too, or ed-dragging sticks and the
    // insert gaps stay dead (pointer-events: none) until a reload.
    const endDrag = () => { dragging = []; clearMarks(); this.list.classList.remove('ed-dragging') }
    this.list.addEventListener('dragend', endDrag)
    document.addEventListener('dragend', endDrag, true)
    this.list.addEventListener('dragover', (ev) => {
      const row = rowOf(ev)
      if (!row || !dragging.length) return
      ev.preventDefault()
      ev.dataTransfer!.dropEffect = 'move'
      const where = side(row, ev)
      if (!row.classList.contains(`drop-${where}`)) { clearMarks(); row.classList.add(`drop-${where}`) }
    })
    this.list.addEventListener('drop', (ev) => {
      const row = rowOf(ev)
      clearMarks()
      if (!row || !dragging.length) return
      ev.preventDefault()
      const target = this.store.doc.slides[Number(row.dataset.index)]
      const ids = dragging
      endDrag()
      if (target) this.moveSlides(ids, target.id, side(row, ev))
    })
  }

  /** Move slides (each with its interactive states, in deck order) before or
   *  after `targetId`'s block. One undo step. */
  moveSlides(ids: string[], targetId: string, where: 'before' | 'after') {
    const slides = this.store.doc.slides
    const parents = new Set(ids.filter((id) => !slides.find((s) => s.id === id)?.stateOf))
    const moving = slides.filter((s) => parents.has(s.id) || (!!s.stateOf && parents.has(s.stateOf)))
    let target = slides.find((s) => s.id === targetId)
    if (!target || !moving.length) return
    // a state is never split from its parent: dropping on one means its parent's block
    if (target.stateOf) { target = slides.find((s) => s.id === target!.stateOf) ?? target; where = 'after' }
    if (moving.includes(target)) return
    const rest = slides.filter((s) => !moving.includes(s))
    let at = rest.indexOf(target)
    if (where === 'after') { at++; while (at < rest.length && rest[at].stateOf === target.id) at++ }
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    if (order.every((s, k) => s === slides[k])) return
    const current = this.store.slide?.id
    this.store.commit(() => { this.store.doc.slides = order }, 'slides')
    const k = order.findIndex((s) => s.id === current)
    if (k >= 0 && k !== this.store.currentIndex) { this.store.currentIndex = k; this.store.emit('current') }
    this.highlightSidebar()
  }

  private highlightSidebar() {
    const slides = this.store.doc.slides
    this.list.querySelectorAll<HTMLElement>('.ed-row[data-index]').forEach((row) => {
      const i = Number(row.dataset.index)
      const on = i === this.store.currentIndex
      const picked = this.picked.size > 1 && this.picked.has(slides[i]?.id)
      row.classList.toggle('active', on)
      row.classList.toggle('picked', picked)
      const thumb = row.querySelector('.ed-thumb')
      thumb?.classList.toggle('active', on)
      thumb?.classList.toggle('picked', picked)
    })
    this.list.classList.toggle('ed-multi', this.picked.size > 1)
    this.paintNav()
  }

  private scheduleThumbs() {
    // Agent edits name the slides they touched; collect those across the
    // debounce and redraw only them. Anything else redraws every thumbnail.
    const scope = this.store.scope
    if (!scope) this.thumbScope = null
    else if (this.thumbScope) scope.forEach((id) => this.thumbScope!.add(id))
    // the comment sides follow requests at once (they commit quietly)
    this.rows.forEach((r) => r.paint())
    clearTimeout(this.thumbTimer)
    this.thumbTimer = window.setTimeout(() => {
      const only = this.thumbScope
      this.thumbScope = new Set()
      const thumbs = this.list.querySelectorAll<HTMLElement>('.ed-thumb[data-index]')
      if (thumbs.length !== this.store.doc.slides.length) return this.rebuildSidebar()
      thumbs.forEach((item) => {
        const slide = this.store.doc.slides[Number(item.dataset.index)]
        if (!slide) return
        paintOrbs(item, slide.comments, this.mode !== 'review')
        if (only && !only.has(slide.id)) return
        item.querySelector('.tessera-thumb-surface')?.replaceWith(renderThumbnail(slide, this.store.doc, this.thumbWidth(!!slide.stateOf)))
      })
      this.paintNav()
    }, 150)
  }

  /** "Slide 3 of 5" above the slide. */
  private paintNav() {
    if (!this.navLabel) return
    const slides = this.store.doc.slides
    const total = slides.filter((s) => !s.stateOf).length
    const i = this.store.currentIndex
    const s = slides[i]
    const n = s?.stateOf ? this.linearNumber(slides.findIndex((x) => x.id === s.stateOf)) : this.linearNumber(i)
    this.navLabel.textContent = s?.stateOf
      ? t('Slide {n} of {total} · interactive state', { n, total })
      : t('Slide {n} of {total}', { n, total })
  }

  // --- slide ops ------------------------------------------------------------------

  private duplicateSlide(i: number) {
    // Duplicated slides keep element ids → set transition to morph and you
    // get PowerPoint-Morph behaviour for free.
    const clone = JSON.parse(JSON.stringify(this.store.doc.slides[i]))
    clone.id = uid('slide')
    // element ids are kept on purpose (morph), but a duplicated poll gets its
    // own join code so the two slides don't pool answers into one poll
    remintPollCodes(clone.elements)
    dropDevSrc(clone.elements)
    this.store.commit(() => {
      // …and a duplicated figure its own page, so revising one leaves the other
      forkFigureAssets(this.store.doc, clone.elements)
      this.store.doc.slides.splice(i + 1, 0, clone)
    }, 'slides')
    this.store.goTo(i + 1)
  }

  private deleteSlide(i: number) {
    const target = this.store.doc.slides[i]
    if (!target) return
    // dependents: states of this slide, and element links pointing at it
    const states = this.store.doc.slides.filter((s) => s.stateOf === target.id)
    const doomedIds = new Set([target.id, ...states.map((s) => s.id)])
    // "A deck needs at least one slide" has to be checked against what will
    // SURVIVE, not against the current count: deleting a parent takes its
    // interactive states with it, so one slide + one state (length 2) sailed
    // past a `length <= 1` test and then deleted BOTH — leaving a deck with
    // zero slides and an editor with nothing to render (issue #30). States
    // don't count as survivors: they're unreachable except through a parent.
    const survivesLinear = this.store.doc.slides.some((s) => !s.stateOf && !doomedIds.has(s.id))
    if (!survivesLinear) return this.toast(t('A deck needs at least one slide'))
    let linkCount = 0
    for (const s of this.store.doc.slides) {
      if (doomedIds.has(s.id)) continue
      for (const el of s.elements) if (el.link && doomedIds.has(el.link)) linkCount++
    }
    if (states.length || linkCount) {
      const parts = [
        states.length ? `${states.length} interactive state${states.length > 1 ? 's' : ''} will be deleted with it` : '',
        linkCount ? `${linkCount} element link${linkCount > 1 ? 's' : ''} will be cleared` : '',
      ].filter(Boolean).join('; ')
      if (!window.confirm(t('Delete this slide? {parts}.', { parts }))) return
    }
    this.store.commit(() => {
      this.store.doc.slides = this.store.doc.slides.filter((s) => !doomedIds.has(s.id))
      for (const s of this.store.doc.slides) {
        for (const el of s.elements) {
          if (el.link && doomedIds.has(el.link)) delete el.link
        }
      }
    }, 'slides')
    this.store.goTo(Math.min(i, this.store.doc.slides.length - 1))
    this.store.emit('current')
  }

  // --- present & save ------------------------------------------------------------------

  /** Open the speaker view now (a launcher twin of the Slide-panel button) so it
   *  can be placed on a second screen before presenting — present mode adopts it. */
  openSpeakerView() {
    const w = openSpeakerWindow(
      `${this.store.doc.title} — ${t('Speaker view')}`,
      speakerIdleBody(this.store.doc.title, t('Notes, controls and slide thumbnails appear here when you start presenting. Drag this window to your second display.')),
    )
    if (!w) this.toast(t('Couldn’t open the speaker view — allow pop-ups for this site.'))
  }

  present(fromStart = false, fullscreen = true) {
    if (this.presenting) return
    // They've started a slideshow — retire the first-run nudge for good.
    try { localStorage.setItem('tessera-slideshow-started', '1') } catch { /* storage off */ }
    this.canvas.commitTextEdit()
    this.presenting = true
    startPresentation(this.store.doc, fromStart ? 0 : this.store.currentIndex, (last) => {
      this.presenting = false
      this.store.goTo(last)
      this.canvas.render()
    }, {
      fullscreen,
      // A summary produced on stage is a result worth keeping: commit it so it
      // joins the undo history and rides the normal save/autosave paths.
      onPollSummary: (elId, summary) => {
        const el = this.store.element(elId)
        if (!el || el.type !== 'poll') return
        this.store.commit(() => {
          el.summary = summary
          el.summaryAt = new Date().toISOString()
        })
      },
    })
  }

  // --- paste: external objects + cross-deck elements/slides ---------------------

  private wirePaste() {
    document.addEventListener('paste', (ev: ClipboardEvent) => {
      if (this.presenting) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return // text edit owns it
      const dt = ev.clipboardData
      if (!dt) return
      // 1) an image from the OS clipboard (screenshot, copied picture…)
      const imgItem = [...dt.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))
      if (imgItem) {
        const file = imgItem.getAsFile()
        if (file) { ev.preventDefault(); this.pasteImageFile(file); return }
      }
      const text = dt.getData('text/plain')
      // 2) elements / slides copied from this or another deck
      const clip = parseClip(text)
      if (clip?.kind === 'elements') {
        ev.preventDefault()
        let added: SlideElement[] = []
        this.store.commit(() => { added = insertElements(clip, this.store.doc, this.store.slide) })
        this.store.select(added.map((e) => e.id))
        this.toast(added.length === 1 ? t('Pasted 1 item') : t('Pasted {n} items', { n: added.length }))
        return
      }
      if (clip?.kind === 'slides') {
        ev.preventDefault()
        const at = this.store.currentIndex + 1
        let made: Slide[] = []
        this.store.commit(() => { made = insertSlides(clip, this.store.doc, at) }, 'slides')
        this.rebuildSidebar()
        this.store.goTo(at)
        this.toast(made.length === 1 ? t('Pasted 1 slide') : t('Pasted {n} slides', { n: made.length }))
        return
      }
      // 3) plain text → a text element
      if (text && text.trim()) {
        ev.preventDefault()
        const esc = text.trim().slice(0, 4000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
        const { width } = this.store.doc.size
        const el = defaultText({ html: esc, color: readableInk(this.store.slide.background), x: Math.round(width / 2 - 300), y: 260, w: 600 })
        this.store.commit(() => this.store.slide.elements.push(el))
        this.store.select([el.id])
        this.toast(t('Text pasted'))
      }
    })
  }

  private pasteImageFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      const place = (w: number, h: number) => {
        const { width, height } = this.store.doc.size
        const el = defaultImage(src, { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h, fit: 'contain' })
        // via canvas.insert, so a pasted photo is interned into doc.assets on
        // the same path as every other embed
        this.canvas.insert(el)
        this.toast(t('Image pasted'))
      }
      const img = new Image()
      img.onload = () => {
        let w = img.naturalWidth || 400, h = img.naturalHeight || 300
        const sc = Math.min(1, 640 / w, 480 / h); place(Math.round(w * sc), Math.round(h * sc))
      }
      img.onerror = () => place(400, 300)
      img.src = src
    }
    reader.readAsDataURL(file)
  }

  // --- live table→chart binding -------------------------------------------------

  private tableSig = ''
  /** Re-derive any chart linked to a table on the current slide when that
   *  table's content changes. Guarded by a content signature so it can't loop,
   *  and skipped when nothing is linked. */
  private syncLinkedCharts() {
    const slide = this.store.slide
    const linked = slide.elements.filter((e): e is ChartElement => e.type === 'chart' && !!(e as ChartElement).source)
    if (!linked.length) { this.tableSig = ''; return }
    const tables = slide.elements.filter((e): e is TableElement => e.type === 'table')
    const sig = slide.id + '|' + tables.map((tb) => `${tb.id}:${tb.columns.length}:${JSON.stringify(tb.rows)}`).join('|')
    if (sig === this.tableSig) return
    this.tableSig = sig
    let changed = false
    for (const chart of linked) {
      const table = tables.find((tb) => tb.id === chart.source!.tableId)
      if (table && syncLinkedChart(chart, table)) changed = true
    }
    // the triggering table edit already dirtied the doc + drives sync/autosave;
    // each replica derives identically from the synced table, so just re-render.
    if (changed) this.canvas.render()
  }

  /** Re-route connectors (line shapes anchored to elements via from/to) when
   *  anything on the slide moves. Derived, not committed — every replica computes
   *  the same endpoints from the element boxes (mirrors syncLinkedCharts). */
  private syncConnectors() {
    const slide = this.store.slide
    const byId = new Map(slide.elements.map((e) => [e.id, e]))
    let changed = false
    for (const el of slide.elements) {
      if (el.type !== 'shape' || el.shape !== 'line') continue
      const c = el as import('../model').ShapeElement
      if (!c.from && !c.to) continue
      if (c.from && !byId.has(c.from.el)) { delete c.from; changed = true }
      if (c.to && !byId.has(c.to.el)) { delete c.to; changed = true }
      if (!c.from && !c.to) continue
      const [a, b] = lineEndpoints(c)
      const fromBox = c.from ? byId.get(c.from.el) : null
      const toBox = c.to ? byId.get(c.to.el) : null
      // explicit side → pin to that side's midpoint; 'auto' → nearest border
      const end = (box: SlideElement, side: 'auto' | 'top' | 'right' | 'bottom' | 'left' | undefined, toward: { x: number; y: number }) =>
        side && side !== 'auto' ? sideMidpoint(box, side) : borderPoint(box, toward)
      const na = fromBox ? end(fromBox, c.from?.side, toBox ? boxCenter(toBox) : b) : a
      const nb = toBox ? end(toBox, c.to?.side, fromBox ? boxCenter(fromBox) : a) : b
      if (Math.hypot(na.x - a.x, na.y - a.y) > 0.5 || Math.hypot(nb.x - b.x, nb.y - b.y) > 0.5) {
        setLineEndpoints(c, na, nb)
        changed = true
      }
    }
    if (changed) this.canvas.render()
  }

  // --- auto-save + crash recovery -----------------------------------------------

  private autosaveTimer = 0
  private lastVersionAt = 0
  private lastBackupAt = 0
  /** the last autosave reached no file: the save state says so */
  private fileStale = false

  private wireAutosave() {
    if (this.store.doc.readonly) return // player file — nothing to autosave
    void pruneOld()
    void this.checkRecovery()
    this.noticeIfCannotWriteInPlace()
    // The handle picked for this file last time, when Chrome kept the grant:
    // then the write-back below works from the first edit, no ⌘S needed.
    void adoptStoredHandle(this.store.doc)
    this.store.on('doc', () => { this.revision++; this.scheduleAutosave() })
  }

  /** Bumped on every document change. A save remembers the revision it
   *  serialized; the deck is clean after it only if nothing moved since —
   *  the same answer as comparing two full-document JSON keys, for free. */
  private revision = 0

  /** After a write of revision `rev` landed: clean, or save again. */
  private afterSave(rev: number) {
    const unchanged = rev === this.revision
    this.store.setDirty(!unchanged)
    if (!unchanged) this.scheduleAutosave()
    else { this.fileStale = false; this.flashSaved(); void clearRecovery(this.store.doc.docId) } // the file has it; no stale "found" banner
  }

  private scheduleAutosave() {
    if (this.store.doc.readonly) return
    clearTimeout(this.autosaveTimer)
    this.autosaveTimer = window.setTimeout(() => { void this.runAutosave() }, 800)
  }

  /** Writes the deck file when the editor holds no file handle: the local
   *  agent bridge (main.ts wires it). Every change reaches the file this way,
   *  with no picker and no "unsaved" state; version history undoes. */
  fileSaver: ((parts: string[], json: string) => Promise<BridgeSave>) | null = null
  private saving = false
  private refusedSave = ''

  private async runAutosave() {
    const doc = this.store.doc
    if (doc.readonly) return
    if (this.saving) { this.scheduleAutosave(); return }
    this.saving = true
    try { await this.autosaveOnce() } finally { this.saving = false }
  }

  private async autosaveOnce() {
    const doc = this.store.doc
    // A ⌘S that landed inside the 2.5s window already wrote these bytes; a
    // second write through the same handle is a second modification of the
    // file for nothing (and a second "Saved").
    if (!this.store.dirty) return
    // ONE serialization per save, taken synchronously so it is the snapshot:
    // the same string is the recovery copy, the file's document and the
    // bridge's base. (A save used to make a dozen full-document JSON passes
    // and rebuild the file through outerHTML: 0.5-0.9 s per edit on a 14 MB
    // deck, 2026-10-22.)
    const rev = this.revision
    this.session?.stampInto(doc)
    const fileDoc = this.fileDoc()
    const json = JSON.stringify(fileDoc)
    // Never write an encrypted deck's plaintext to IndexedDB; its file
    // write-back below stays encrypted via serializeJsonParts.
    let snapshotted = false
    if (!isEncryptionActive()) {
      // only true if it REALLY stored — see putRecovery; no IndexedDB (Safari
      // private browsing, some file:// contexts) must not read as "backed up"
      const same = fileDoc === doc ? json : undefined
      snapshotted = await putRecovery(doc, same)
      if (Date.now() - this.lastVersionAt > 120_000) { this.lastVersionAt = Date.now(); await addVersion(doc, same) }
    }
    // Silent file write-back once we hold a writable handle (Chrome/Edge).
    if (hasFileHandle()) {
      try {
        await writeUpdatedFile(await serializeJsonParts(json, fileDoc.title))
        this.afterSave(rev)
        return
      } catch { /* try the bridge; the IndexedDB snapshot is the backstop */ }
    }
    // No handle: the local agent bridge writes the document into the file.
    if (this.fileSaver && !isEncryptionActive()) {
      const r = await this.fileSaver(await serializeJsonParts(json, fileDoc.title), json)
      if (r.status === 'saved') { this.afterSave(rev); return }
      if (r.status === 'merged') {
        // The file had changed on disk since this tab loaded or saved it
        // (slide.py while this tab was not counted live, a recompile, another
        // tab). Its changes are now in the editor; save the union.
        if (r.applied || r.kept.length) {
          this.toast(r.kept.length
            ? t('The file changed on disk: {n} change(s) merged; your version kept for {k}: {paths}', { n: String(r.applied), k: String(r.kept.length), paths: r.kept.slice(0, 3).join(', ') })
            : t('The file changed on disk: {n} change(s) merged', { n: String(r.applied) }))
        }
        if (r.kept.length) console.warn('tessera: file changed on disk; kept this tab\'s version of', r.kept)
        this.scheduleAutosave()
        return
      }
      if (r.status === 'busy') { this.scheduleAutosave(); return }
      if (r.status === 'refused') {
        // Never written: the file is another deck now. Say so once per cause.
        if (this.refusedSave !== r.message) { this.refusedSave = r.message; this.toast(t('Not saved to the file: {why}', { why: r.message })) }
      }
    }
    // No handle (Safari/Firefox/iOS) or the write failed: the file on disk is
    // STALE and the deck stays dirty — saying "Saved" here would be a lie. But
    // the snapshot means the work is not lost, and that was previously
    // invisible: nothing was shown at all, so the only signal was an amber dot
    // that never cleared. Say what is actually true.
    //
    // Deliberately silent for an ENCRYPTED deck: those are never snapshotted to
    // IndexedDB (plaintext-to-disk), so on a browser that cannot write back
    // there is no backstop, and claiming one would be the worst kind of wrong.
    if (snapshotted) this.lastBackupAt = Date.now()
    this.fileStale = true
    this.paintSaveState()
  }

  private async checkRecovery() {
    const doc = this.store.doc
    const snap = await getRecovery(doc.docId)
    if (!snap) return
    let recovered: import('../model').TesseraDoc
    try { recovered = JSON.parse(snap.json) } catch { return }
    // No banner (DECISIONS, 2026-10-28): edits the file does not hold go into
    // Version history, where a restore is one click and undoable; agents
    // write the file behind the tab's back, so such a snapshot is usually
    // OLDER than the file and must never be offered as "your changes".
    if (docContentKey(recovered) !== docContentKey(doc) && !isEncryptionActive()) await addVersion(recovered, snap.json, snap.at)
    await clearRecovery(doc.docId)
  }

  /**
   * Say ONCE, before any work is at risk, that this browser cannot rewrite the
   * open file. Shown on Safari/Firefox and every iOS browser (all WebKit, none
   * of which ship the File System Access API).
   *
   * Timing is the point. The editor used to state the opposite in its tooltips
   * and only correct itself in a toast AFTER the first save — by which time the
   * author had already trusted "⌘S rewrites this file" and, on a deck opened
   * from disk, had no idea their edits were going to Downloads instead.
   *
   * Once per browser, not per deck: it is a property of the browser, and
   * repeating it every time a file opens would be nagging.
   */
  private noticeIfCannotWriteInPlace() {
    if (canWriteInPlace()) return
    if (localStorage.getItem(SAVE_NOTICE_KEY) === 'seen') return
    const bar = div('ed-recover')
    const msg = document.createElement('span')
    msg.textContent = t('This browser can’t rewrite files in place. ⌘S will download an updated copy instead — your work is also kept in this browser and offered back if you reopen.')
    const ok = document.createElement('button')
    ok.className = 'ed-btn ed-btn-primary'
    ok.textContent = t('Got it')
    ok.addEventListener('click', () => { localStorage.setItem(SAVE_NOTICE_KEY, 'seen'); bar.remove() })
    bar.append(msg, ok)
    document.body.appendChild(bar)
  }

  /** Browse and restore the locally-kept auto-save timeline for this deck. */
  private async openVersionHistory() {
    const versions = await listVersions(this.store.doc.docId)
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-version-box')
    const h = document.createElement('h2')
    h.textContent = t('Version history')
    box.appendChild(h)
    if (!versions.length) {
      const empty = document.createElement('p')
      empty.className = 'ed-about-fine'
      empty.textContent = t('No saved versions yet — they accumulate as you edit and save.')
      box.appendChild(empty)
    } else {
      const list = div('ed-version-list')
      versions.forEach((v, i) => {
        const rowEl = document.createElement('button')
        rowEl.className = 'ed-version-row'
        const when = new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        rowEl.innerHTML = `<span class="vh-when">${when}</span>` +
          `<span class="vh-tag">${i === 0 ? t('most recent') : ''}</span>` +
          `<span class="vh-do">${t('Restore')}</span>`
        rowEl.addEventListener('click', () => {
          try {
            this.store.replaceDoc(JSON.parse(v.json))
            this.canvas.render()
            overlay.remove()
            this.toast(t('Restored the version from {when} — ⌘Z undoes', { when }))
          } catch { this.toast(t('That version could not be read')) }
        })
        list.appendChild(rowEl)
      })
      box.appendChild(list)
    }
    const fine = div('ed-about-fine')
    fine.textContent = t('Versions are stored only in this browser, never in the file or online. Restoring is undoable.')
    box.appendChild(fine)
    overlay.appendChild(box)
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

  private flashSaved() {
    this.paintSaveState()
  }

  /** The save state beside the title, in words: saved, saving, or — when no
   *  write reaches the file — not saved there, with ⌘S one click away. */
  private paintSaveState() {
    const b = this.saveState
    if (!b) return
    const stuck = this.store.dirty && this.fileStale
    const state = !this.store.dirty ? 'saved' : stuck ? 'stuck' : 'saving'
    if (b.dataset.state !== state) {
      b.querySelector('.ed-save-icon')!.innerHTML = { saved: ICONS.cloudCheck, saving: ICONS.cloudSync, stuck: ICONS.cloudOff }[state]
    }
    b.dataset.state = state
    b.querySelector('span')!.textContent = {
      saved: t('Saved'), saving: t('Saving…'), stuck: t('Not saved to the file'),
    }[state]
    b.title = state === 'stuck'
      ? (canWriteInPlace()
        ? t('Kept in this browser, but the file on disk is older. Click to save (⌘S).')
        : t('Kept in this browser, but the file on disk is older. Click to download an updated copy (⌘S).'))
      : t('Every change is saved to the file as you work · click to save now (⌘S)')
    b.setAttribute('aria-label', b.title)
  }

  /**
   * The document as it should be WRITTEN.
   *
   * Identical to the live doc except for a template, which must not hand out
   * the identity it picked up when it was opened — see model.asTemplateFile.
   * Both write paths (⌘S and the autosave write-back) go through here so a
   * master template stays a template no matter which one saved it.
   */
  private fileDoc(): import('../model').TesseraDoc {
    return this.store.doc.template ? asTemplateFile(this.store.doc) : this.store.doc
  }

  async save(forcePicker: boolean) {
    this.canvas.commitTextEdit()
    // No handle, but the bridge writes this file (the usual case for a deck
    // opened from disk): saving now is the autosave, run at once. Without
    // this, ⌘S opened a Save As picker and moved the tab to whatever was picked.
    if (!forcePicker && !hasFileHandle() && this.fileSaver && !isEncryptionActive() && !this.fileStale) {
      clearTimeout(this.autosaveTimer)
      if (!this.store.dirty) { this.toast(t('Saved')); return }
      await this.runAutosave()
      this.toast(this.store.dirty ? t('Not saved to the file') : t('Saved'))
      return
    }
    // a file shared live upstream keeps its CRDT state current, so its
    // saved copies still merge as forks
    this.session?.stampInto(this.store.doc)
    try {
      const rev = this.revision
      const snapshot = JSON.parse(JSON.stringify(this.fileDoc()))
      const result = await saveFile(snapshot, forcePicker)
      if (result === 'cancelled') return
      if (forcePicker && result !== 'downloaded') window.dispatchEvent(new Event('tessera-file-target-changed'))
      const unchanged = rev === this.revision
      this.store.setDirty(!unchanged)
      if (!unchanged) this.scheduleAutosave()
      // record a recovery baseline + a version checkpoint at each manual save
      if (!isEncryptionActive()) { void putRecovery(this.store.doc); void addVersion(this.store.doc); this.lastVersionAt = Date.now() }
      // 'downloaded' has two causes and they need different words: a browser
      // without the File System Access API (expected, permanent) and a write
      // this browser COULD have done but refused — a lapsed permission, a
      // dismissed picker. Saying "this browser can't" for the second one sends
      // people looking for a browser problem that isn't there.
      this.toast(result !== 'downloaded'
        ? t(unchanged ? 'Saved' : 'Changes pending save')
        : canWriteInPlace()
          ? t('Couldn’t write that file — a copy went to Downloads instead')
          : t('This browser can’t rewrite files in place — a fresh copy went to Downloads'))
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
    }
  }

  // --- keyboard ------------------------------------------------------------------

  private wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
      if (this.presenting) return
      const mod = ev.metaKey || ev.ctrlKey
      const inField =
        ev.target instanceof Element &&
        ev.target.closest('input, textarea, select, [contenteditable="true"]') != null

      if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        if (!ev.repeat) this.save(false) // a held key must not queue saves
        return
      }
      if (mod && (ev.key === '=' || ev.key === '+')) {
        ev.preventDefault()
        this.canvas.zoomIn()
        return
      }
      if (mod && ev.key === '-') {
        ev.preventDefault()
        this.canvas.zoomOut()
        return
      }
      if (mod && ev.key === '0') {
        ev.preventDefault()
        this.canvas.zoomReset()
        return
      }
      if (ev.key === 'F5') {
        ev.preventDefault()
        this.present(!ev.shiftKey)
        return
      }
      if (inField) return

      if (mod && ev.key.toLowerCase() === 'g') {
        ev.preventDefault()
        const els = this.store.selectedElements
        if (ev.shiftKey) this.ungroup(els)
        else this.group(els)
        return
      }
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault()
        ev.shiftKey ? this.store.redo() : this.store.undo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault()
        this.store.redo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'd') {
        ev.preventDefault()
        this.duplicateSelection()
        return
      }
      if (mod && ev.key.toLowerCase() === 'c') {
        // Copy to BOTH the in-app clipboard (fast, same session) and the system
        // clipboard as a deck payload (works across decks/tabs). Elements when
        // any are selected; otherwise the current slide.
        if (this.store.selection.length) {
          void navigator.clipboard?.writeText?.(serializeElements(this.store.selectedElements, this.store.doc)).catch(() => {})
        } else {
          void navigator.clipboard?.writeText?.(serializeSlides([this.store.slide], this.store.doc)).catch(() => {})
          this.toast(t('Slide copied — ⌘V in any deck to paste it'))
        }
        return
      }
      // ⌘V is handled by the document 'paste' listener (wirePaste) so it can
      // also receive images and cross-deck payloads.
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this.store.selection.length) {
          ev.preventDefault()
          const ids = new Set(this.store.selection)
          this.store.commit(() => {
            this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
          })
          this.store.select([])
        }
        return
      }
      // nothing selected → arrows walk slides (Left/Up = prev, Right/Down = next);
      // when an element IS selected they nudge it (branch below). inField already
      // returned above, so this never fires mid text/cell edit.
      if (ev.key.startsWith('Arrow') && !this.store.selection.length) {
        ev.preventDefault()
        this.store.goToLinear(ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (ev.key.startsWith('Arrow') && this.store.selection.length) {
        ev.preventDefault()
        const step = ev.shiftKey ? 10 : 1
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0
        this.store.commit(() => {
          for (const el of this.store.selectedElements) {
            el.x += dx
            el.y += dy
          }
        })
        return
      }
      if (ev.key === '[') {
        this.togglePanel()
        return
      }
      if (ev.key === ']') {
        this.toggleNotes()
        return
      }
      if (ev.key === 'Escape') {
        if (this.maximized) { this.setMaximized(false); return }
        this.store.select([])
        if (this.picked.size > 1) { this.picked = new Set([this.store.slide.id]); this.highlightSidebar() }
        return
      }
      if (ev.key === 'PageDown') {
        ev.preventDefault()
        this.store.goToLinear(1)
        return
      }
      if (ev.key === 'PageUp') {
        ev.preventDefault()
        this.store.goToLinear(-1)
      }
    })
  }

  /** ⌘G: one group id across the selection — a click on any member then
   *  selects them all (canvas expandGroups). */
  private group(els: SlideElement[]) {
    if (els.length < 2) return
    const gid = `grp-${uid()}`
    this.store.commit(() => { for (const el of els) el.groupId = gid })
  }

  /** ⇧⌘G: dissolve every group the selection touches. */
  private ungroup(els: SlideElement[]) {
    const gids = new Set(els.map((e) => e.groupId).filter(Boolean))
    if (!gids.size) return
    this.store.commit(() => {
      for (const el of this.store.slide.elements) {
        if (el.groupId && gids.has(el.groupId)) delete el.groupId
      }
    })
  }

  private duplicateSelection() {
    const els = this.store.selectedElements
    if (!els.length) return
    const clones = els.map((el) => cloneElement(el))
    this.store.commit(() => this.store.slide.elements.push(...clones))
    this.store.select(clones.map((c) => c.id))
  }

  // --- toast ------------------------------------------------------------------

  toast(message: string) {
    document.querySelector('.ed-toast')?.remove()
    const t = div('ed-toast')
    t.textContent = message
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'))
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, 2200)
  }
}

/** Deep-clone an element with a fresh id (same-slide duplicates must not share
 *  ids) — and, for a poll, a fresh join code (they must not share answers). */
function cloneElement(el: SlideElement): SlideElement {
  const copy: SlideElement = { ...JSON.parse(JSON.stringify(el)), id: uid(el.type[0]), x: el.x + 24, y: el.y + 24 }
  remintPollCodes([copy])
  dropDevSrc([copy])
  return copy
}

/** A menu button: a caret (or `icon`) whose menu `fill` adds items and rules
 *  to; an item or rule given a class can be hidden by CSS. */
function dropdown(
  tip: string,
  host: HTMLElement,
  fill: (
    item: (icon: string, label: string, title: string, onClick: () => void, cls?: string) => void,
    sep: (cls?: string) => void,
  ) => void,
  icon = '<span class="ed-caret">▾</span>',
): HTMLElement {
  const wrap = div('ed-dropdown')
  const menu = div('ed-menu ed-menu-end')
  const trigger = btn(icon, '', () => wrap.classList.toggle('open'), tip)
  trigger.classList.add('ed-split-caret')
  trigger.setAttribute('aria-label', tip)
  fill((ic, label, title, onClick, cls) => {
    const b = document.createElement('button')
    b.className = 'ed-btn' + (cls ? ' ' + cls : '')
    if (ic) b.innerHTML = ic
    b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
    b.title = title
    b.addEventListener('click', () => {
      wrap.classList.remove('open')
      onClick()
    })
    menu.appendChild(b)
  }, (cls) => { menu.appendChild(div('ed-menu-sep' + (cls ? ' ' + cls : ''))) })
  wrap.append(trigger, menu)
  closeOnOutside(wrap, host)
  return wrap
}

function closeOnOutside(wrap: HTMLElement, host: HTMLElement = wrap) {
  document.addEventListener('pointerdown', (ev) => {
    if (!host.contains(ev.target as Node)) wrap.classList.remove('open')
  })
}

/** A thumbnail's orbs: one per request (hollow waiting, pulsing working,
 *  green done) — where the list shows no comments; in the review list the dot
 *  before each comment says it — and a mark for open review comments. */
function paintOrbs(item: HTMLElement, threads: import('../model').Comment[] | undefined, withOrbs = true) {
  const all = threads ?? []
  const comments = all.filter((c) => !c.request && !c.resolved).length
  const sig = JSON.stringify([withOrbs, all.map((c) => [c.id, c.request, c.status, c.resolved, c.replies?.length, c.text])])
  let badge = item.querySelector<HTMLElement>('.ed-thumb-badge')
  if (badge?.dataset.sig === sig) return
  badge?.remove()
  const orbs = withOrbs ? requestOrbs(all) : null
  if (!orbs && !comments) return
  badge = div('ed-thumb-badge')
  badge.dataset.sig = sig
  if (orbs) badge.appendChild(orbs)
  if (comments) {
    const c = div('ed-thumb-cmt')
    c.title = t('Open comment(s)')
    badge.appendChild(c)
  }
  item.appendChild(badge)
}

// tiny DOM helpers
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function btn(
  icon: string,
  label: string,
  onClick: (ev: MouseEvent) => void,
  title?: string,
): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
