// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// The tessera/slides document model. This JSON is what lives inside the
// <script type="application/tessera+json" id="tessera-doc"> block of a deck file.

import { LEGACY_SLIDES_FORMAT } from '../../kernel/src/legacy.ts'

export const FORMAT = 'tessera/slides'
export const FORMAT_VERSION = 1

export type TransitionKind = 'none' | 'fade' | 'slide' | 'zoom' | 'morph'

export interface ElementBase {
  /** Stable per-slide identity: `data-el-id`, selection, connector/comment
   *  anchors, and the CRDT node key. Also the DEFAULT morph key — elements
   *  sharing an id across adjacent slides morph into each other (the
   *  duplicate-a-slide idiom). Never mutate it to re-pair a morph; set
   *  `morphId` instead so identity stays stable. */
  id: string
  /** Optional morph-key override. When set, this element morphs with elements
   *  whose effective morph key (`morphId ?? id`) matches — letting two
   *  independently-created elements on different slides be paired without
   *  touching either's `id`. Omitted = fall back to `id` (the common case).
   *  Must not collide with another element's effective key on the SAME slide. */
  morphId?: string
  x: number
  y: number
  w: number
  h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
  /**
   * Drop shadow(s), rendered with CSS drop-shadow so they follow the
   * element's alpha shape (rounded corners, ellipses, glyphs, image
   * cutouts). An array stacks: e.g. a dark elevation shadow plus a soft
   * white glow.
   */
  shadow?: ShadowSpec | ShadowSpec[]
  /** Gaussian blur ON this element, in px. Composed into the SAME CSS `filter`
   *  as `shadow` (both apply). Survives PDF/print, unlike backdrop blur. */
  blur?: number
  /** CSS mix-blend-mode for this element ('screen' for neon light glows,
   *  'multiply'/'overlay' for editorial duotones). Omitted/'' = normal. */
  blend?: string
  /** Frosted-glass backdrop blur behind this element, in px (0/undefined = off).
   *  Screen-only: browser print/PDF drops backdrop-filter (pair with a
   *  translucent `fill` so PDFs show a graceful flat panel). */
  backdropFilter?: number
  /** presentation effects, run in present mode only */
  fx?: {
    /** entrance animation when the slide is shown. fade-* nudge ~16px; slide-*
     *  sweep ~120px in from an edge (slide-left starts to the right, etc.) */
    enter?: 'fade-up' | 'fade' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    /** entrance duration in seconds; omitted = the per-kind default
     *  (slide-* 0.75s, fade-* 0.55s). Lower = snappier, higher = more languid. */
    enterDur?: number
    /** stagger step within the entrance sequence; equal values enter together */
    order?: number
    /** animate numeric parts of the text from 0 to their final value */
    countUp?: boolean
    /** continuous ambient motion (slow zoom, for full-bleed photos) */
    ambient?: 'kenburns'
    /**
     * Ken-burns tuning. dir 'drift' (default) is the endless slow yoyo zoom;
     * 'out' and 'in' play ONCE per slide entry — 'out' starts zoomed by
     * `scale` and settles to rest (the classic title-photo effect).
     * `scale` is the far end of the zoom (e.g. 1.06), `duration` in seconds.
     */
    ken?: { dir?: 'drift' | 'out' | 'in'; scale?: number; duration?: number }
    /** continuous looping animation */
    loop?:
      | { type: 'dash-march'; distance?: number; duration?: number }
      | {
          type: 'motion-path'
          path: string
          duration: number
          delay?: number
          /** easing over each lap (default 'none' = constant tempo) */
          ease?: string
          /** per-anchor speed multipliers (1 = normal, <1 dwells, >1 rushes);
           *  length matches the path's anchor count. Warps the arc-length map
           *  so the element can linger at some points and rush between others. */
          speeds?: number[]
        }
  }
  /** while presenting, clicking this element jumps to the slide with this id */
  link?: string
  /** semantic group tag — hover focus and multi-element behaviours target it */
  group?: string
  /**
   * Editor grouping: elements sharing a groupId select and move as one
   * (click any member → whole group; Alt-click digs to the individual).
   * Distinct from `group`, which carries presentation semantics.
   */
  groupId?: string
  /**
   * In-slide hover reveal: this element is only visible while an element
   * whose `group` equals this value is hovered (slide.hover type 'reveal').
   * The slide's hover.default set is shown when nothing is hovered.
   */
  showOnHover?: string
  /**
   * Layout role — what this element IS on the slide ('title', 'subtitle',
   * 'body', 'kicker'). Applying a different layout moves content between
   * same-role elements, PowerPoint-placeholder style. Free-form string;
   * those four are the conventions the built-in layouts use.
   */
  role?: string
}

export interface ShadowSpec {
  x?: number
  y?: number
  blur: number
  color: string
}

export interface TextElement extends ElementBase {
  type: 'text'
  /** Rich text as sanitized inline HTML (b/i/u/br/span only). */
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  /** When set (and stops non-empty), painted into the glyphs; wins over `color`. */
  colorGradient?: GradientFill
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  /** px; optional tracking for letter-spaced caps labels */
  letterSpacing?: number
  /** Outline / hollow glyphs via -webkit-text-stroke. `fill:'none'` makes the
   *  interior transparent (the classic hollow section-break word); default keeps
   *  the solid `color` fill and just adds an outline. */
  textStroke?: { width: number; color: string; fill?: string }
  /**
   * Layout placeholder prompt ("Click to add title"). While the element's
   * html is empty: the editor shows this dimmed; present and print hide the
   * element entirely. Cleared content brings the prompt back.
   */
  placeholder?: string
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'

/** Linear gradient fill. Colors are any CSS color, including rgba(). */
export interface GradientFill {
  /** degrees, CSS convention: 0 = bottom→top, 90 = left→right */
  angle: number
  /** ordered stops; `at` is 0..1 along the gradient line */
  stops: Array<{ at: number; color: string }>
}

/** Decoration at a line's tip. Sized relative to the stroke width. */
export type LineEnding = 'none' | 'arrow' | 'dot' | 'bar'

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: ShapeKind
  fill: string
  /** when set, wins over `fill` (which is kept as the solid fallback) */
  fillGradient?: GradientFill
  stroke: string
  strokeWidth: number
  /** corner radius, rect only */
  radius: number
  /** dash length in px; 0/undefined = solid stroke (legacy — see strokeStyle) */
  strokeDash?: number
  /** stroke pattern; wins over strokeDash when set */
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  /** line shape only: tip decorations */
  lineStart?: LineEnding
  lineEnd?: LineEnding
  /** path only: SVG path data in the coordinate space given by pathBox */
  d?: string
  /** path only: [x, y, w, h] viewBox the path was authored in */
  pathBox?: [number, number, number, number]
  /**
   * Connector anchoring (line/path only): the start (`from`) and/or end (`to`)
   * of the shape follow another element. The geometry is DERIVED — the editor's
   * syncConnectors() recomputes the endpoint on that element's border toward the
   * other end whenever anything moves. A dangling ref (element deleted) is
   * dropped and the endpoint becomes free.
   */
  from?: ConnectorEnd
  to?: ConnectorEnd
}

/** One anchored end of a connector. `side:'auto'` picks the nearest border. */
export interface ConnectorEnd {
  el: string
  side?: 'auto' | 'top' | 'right' | 'bottom' | 'left'
}

export interface ImageElement extends ElementBase {
  type: 'image'
  /** data: URI, or "asset:<key>" referencing doc.assets */
  src: string
  fit: 'contain' | 'cover' | 'fill'
  radius: number
}

export interface SvgElement extends ElementBase {
  type: 'svg'
  /** key into doc.assets holding raw SVG markup (preferred: dedupes) */
  asset?: string
  /** raw inline SVG markup, used when asset is unset */
  markup?: string
  /**
   * CSS injected inside the svg — hover states, focus dims, and animations
   * live here and stay self-contained (svg <style> scopes to its svg).
   */
  css?: string
}

/**
 * Data chart rendered by ECharts. `option` is a PURE-JSON ECharts option
 * (template-string formatters only — never functions): static SVG snapshots
 * on the editor canvas/thumbnails/print, a live interactive instance
 * (tooltips, dataZoom) while presenting.
 */
export interface ChartElement extends ElementBase {
  type: 'chart'
  /** preset key the panel offers to re-seed from (bar/line/pie/scatter) */
  preset?: string
  option: Record<string, unknown>
  /** live data binding: xAxis labels + series values track this table element */
  source?: { tableId: string }
}

/** One cell of a table. `html` is the same sanitized inline subset as text. */
export interface TableCell {
  html: string
  align?: 'left' | 'center' | 'right'
  /** per-cell overrides (default from the table's style) */
  color?: string
  bg?: string
  bold?: boolean
}

export interface TableRow {
  cells: TableCell[]
}

/** Table-wide look. Cohesion lives here; cells carry only overrides. */
export interface TableStyle {
  headerBg: string
  headerColor: string
  /** stripe colour for alternate body rows; absent = no zebra */
  zebra?: string
  borderColor: string
  borderWidth: number
  cellPadX: number
  cellPadY: number
  fontSize: number
  fontFamily?: string
  /** default body-cell text colour */
  color: string
  /** outer corner radius (px) */
  radius: number
  /**
   * Which lines `borderWidth`/`borderColor` draw. `grid` (absent) boxes every
   * cell; `rows` draws only a hairline between rows — no verticals, no outer
   * box, nothing under the last row — the quiet editorial table.
   */
  rules?: 'grid' | 'rows'
  /** colour of a 2px rule under the header row; absent = the ordinary line */
  headerRule?: string
  /** header text as small letter-spaced capitals (0.78em, 600) */
  headerCaps?: boolean
}

/**
 * A data table rendered as a real HTML <table> (table-layout: fixed) by the
 * shared renderer — identical on the editor canvas, thumbnails, present and
 * print. Column widths are fractional weights, normalised at render. Morphs
 * as a box (position/size + style colours); cell CONTENT does not morph.
 */
export interface TableElement extends ElementBase {
  type: 'table'
  /** fractional column weights; length = column count */
  columns: Array<{ w: number }>
  rows: TableRow[]
  /** treat row 0 as a styled header row */
  header: boolean
  style: TableStyle
}

/**
 * Audio or video. Hybrid storage: `src` is a data: URI (embedded — travels
 * inside the deck file), an external URL / relative path (referenced — keeps
 * the file small but needs the network / a sibling file), or "asset:<key>".
 * Autoplay only fires in PRESENT mode (never on the canvas or in thumbnails).
 */
export interface MediaElement extends ElementBase {
  type: 'media'
  kind: 'video' | 'audio'
  src: string
  /** video only: a still shown before playback (data:/asset:/URL) */
  poster?: string
  /** video only: fit within the element box */
  fit?: 'contain' | 'cover' | 'fill'
  radius?: number
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  controls?: boolean
}

/**
 * An audience question. The presenter shows the slide, the room answers from
 * their phones, and one button turns the answers into a summary on the slide.
 *
 * The element renders DETERMINISTICALLY everywhere — question, join info, and
 * whatever summary was last saved. The live parts (response count, Summarize,
 * the raw-response toggle) are mounted only by present.ts, the same split that
 * keeps `media` from autoplaying on the canvas and in thumbnails. A poll slide
 * therefore still opens, prints, and reads correctly with no network at all.
 *
 * The join code is the ONLY capability: whoever can read it can answer. It is
 * printed on a projector by design, so treat both question and answers as
 * public, and see server/poll-app/README.md for what that does and doesn't imply.
 *
 * Two codes, two jobs: `doc.poll.session` is what the audience JOINS (one QR
 * for the whole talk, following whatever question is on screen) and `code` is
 * where THIS question's answers are stored. A deck with no session falls back
 * to showing `code` itself, which is exactly how polls worked before v1.0.12.
 *
 * Answers live in the service, never in the file. Only `summary` is written
 * back — a deck you reshare records what the room said without carrying every
 * individual response along with it.
 */
/** One multiple-choice question inside a `quiz` poll. */
export interface QuizQuestion {
  /** the question text, as the phone shows it */
  q: string
  /** what to pick between, in order */
  options: string[]
  /** index into `options` of the right answer — deck-only, never published */
  correct: number
}

export interface PollElement extends ElementBase {
  type: 'poll'
  /** the question, shown on the slide and on the audience's join page */
  question: string
  /**
   * What the room is asked to do. Absent = 'open' (free text), which is what
   * every poll written before v1.0.12 is.
   *
   * - `open`     — a sentence or two; the AI summarizer turns them into themes.
   * - `choice`   — pick one of `options`; reported as a bar chart of counts.
   * - `rating`   — a number on the `min`..`max` scale; reported as the average
   *   plus the distribution.
   * - `quiz`     — several multiple-choice `questions`, each with a right
   *   answer, all answered in one go on the phone; reported as the
   *   distribution of SCORES. The correct answers never leave the deck: the
   *   phone submits the picks it made and `quizStats` grades them here, so a
   *   student reading the network traffic learns nothing.
   * - `activity` — a self-contained page (`activityAsset`/`activityHtml`) the
   *   deck ships to the phone instead of a built-in form: a multi-question
   *   quiz, a small game, anything the three fixed kinds don't cover. The page
   *   asks its own questions, grades or scores itself, and answers through the
   *   same wire format as the other three — one string, free-form JSON by
   *   convention (`{"score":4,"total":5}`) since the server never interprets
   *   it. See docs/DECISIONS.md and server/poll-app/README.md.
   *
   * The ANSWER WIRE FORMAT stays one string for all of them (`choice` sends
   * the option's own text, `rating` sends the number as digits, `quiz` sends
   * `{"picks":[…]}`, `activity` sends whatever JSON its page chooses). That is
   * what keeps the service, the export and every already-collected answer
   * working unchanged — tallying is a client-side read of that string.
   */
  kind?: 'open' | 'choice' | 'rating' | 'quiz' | 'activity'
  /** `choice`: what the room picks from, in order. */
  options?: string[]
  /**
   * `quiz`: the questions, in order. `correct` indexes into that question's
   * own `options` and is the ONE field never published to the session — see
   * poll.ts activeQuestionOf.
   */
  questions?: QuizQuestion[]
  /** `rating`: the ends of the scale (defaults 1..5) and their optional labels */
  min?: number
  max?: number
  minLabel?: string
  maxLabel?: string
  /**
   * `activity`: the page's HTML, pushed to the poll service once when the
   * slide first presents (`publishActivityHtml`) and from then on served to
   * every phone that joins. Same asset/inline split as `EmbedElement`:
   * `activityAsset` (a `doc.assets` key — preferred, dedupes) takes priority
   * over inline `activityHtml`. Self-contained only — no CDN, no fetch to
   * anything but this deck's own poll service — since it runs on a phone with
   * whatever connectivity a lecture hall has.
   */
  activityAsset?: string
  activityHtml?: string
  /**
   * Ask for a name before this question can be answered. Off = anonymous,
   * which stays the default: a name changes what people are willing to say,
   * so it must be a deliberate choice per question.
   *
   * The audience page asks ONCE per session and remembers the name on the
   * phone, so a run of named questions is one prompt, not one per slide.
   */
  requireName?: boolean
  /**
   * `choice` only: let a respondent pick more than one option. Off = the
   * classic single pick.
   *
   * Wire format stays one string: a single pick still sends the option's own
   * text unchanged; a multi pick sends `text` as a JSON array of the picked
   * option strings (`["ChatGPT","Claude"]`), read back by `tallyChoices`.
   */
  multi?: boolean
  /** short answer-bucket code; also the join code on decks with no session */
  code: string
  /**
   * Draw the join column (QR, address, code)? Absent = yes.
   *
   * Set false for a slide that REPORTS a bucket the room already answered —
   * a reveal later in the talk, or a state slide showing one question another
   * way. Such a slide otherwise looks exactly like a new question, QR and all,
   * and a room will dutifully try to answer it again. The live count, the
   * results and Summarize are unaffected; only the invitation goes away.
   */
  showJoin?: boolean
  /** poll service base URL; absent = pollHost()'s default */
  service?: string
  /** the last AI summary, and when it was made */
  summary?: string
  summaryAt?: string
  /**
   * The question is over and its results are IN THE FILE: a copy handed to
   * students (the skills' `publish.py students`). A frozen poll never talks to
   * the service — no QR, no count tick, no Summarize, nothing published to
   * phones — and draws `answers` through the same arithmetic as a live one.
   * `answers` are the wire strings of a choice, rating or quiz (an option's
   * text, digits, picks) with names and times dropped; an `open` question
   * carries only its `summary`, never the room's words.
   */
  frozen?: { at?: string; count: number; answers?: string[] }
  /** extra steer handed to the summarizer ("group by team", "in French"…) */
  prompt?: string
  /** model slug override; absent = whatever the service is configured with */
  model?: string
  fontSize?: number
  fontFamily?: string
  color?: string
  /** accent for the join chip and theme markers; absent = theme accent */
  accent?: string
}

/**
 * A live web page embedded in the slide: simulations, interactive
 * infographics, small apps — anything that needs real JavaScript, which no
 * other element type can run (text/table `html` is sanitized to an inline
 * subset, and svg `markup` goes in via innerHTML, which never executes script).
 *
 * Rendered as a sandboxed <iframe>. Two sources, in priority order:
 *
 *   html / asset  → srcdoc. The page travels INSIDE the deck file and works
 *                   offline, which is what keeps a deck portable. Preferred.
 *   src           → a URL. Keeps the file small, but the deck now depends on
 *                   that host being up; a deck you email breaks when it is not.
 *
 * The sandbox omits `allow-same-origin` by default, so the frame runs with an
 * opaque origin and cannot reach the parent document. That matters here
 * specifically: a deck file carries its own E2EE collaboration room keys, and
 * a same-origin frame could read them straight out of the document.
 *
 * The one exception is a `src` pointing at a CROSS-ORIGIN http(s) URL. There
 * `allow-same-origin` grants the frame that third party's origin, not this
 * document's, so the parent stays out of reach — and hosted players (YouTube,
 * Vimeo) will not boot without it. List it in `sandbox` to get it; an inline
 * (`asset`/`html`) page, a relative URL or a same-origin URL is still refused,
 * because there the frame's own origin IS the parent's.
 *
 * `poster` is not optional in practice. The editor canvas, sidebar thumbnails
 * and PDF export all rasterize slides, and a live iframe cannot be
 * rasterized — without a poster those surfaces show an empty box.
 */
export interface EmbedElement extends ElementBase {
  type: 'embed'
  /** key into doc.assets holding the page's HTML (preferred: dedupes) */
  asset?: string
  /** raw inline HTML, used when asset is unset */
  html?: string
  /** URL to load instead of inline HTML; only used when asset/html are unset */
  src?: string
  /**
   * A figure still being built: the loopback URL of its source page (the
   * skills' live server). The EDITOR canvas loads it instead of the bundled
   * page so every save shows at once; `dev-figures.ts` copies each save into
   * `asset`, which stays the page of record. Present mode, player files and
   * every copy of the slide ignore or drop it — the address means something
   * only on this machine, in this deck's folder.
   */
  devSrc?: string
  /** still shown on the editor canvas, thumbnails and in print (data:/asset:) */
  poster?: string
  /** corner radius in px */
  radius?: number
  /**
   * Scale the frame's contents. The iframe is given a LOGICAL viewport of
   * `w/zoom × h/zoom` CSS px and then scaled to fit the element box, so a page
   * laid out for a taller window (most are) fits a slide without being cropped
   * or scrolled. 1 = no scaling; 0.85 buys ~18% more room in each axis.
   */
  zoom?: number
  /** extra sandbox tokens, appended to the `allow-scripts` baseline.
   *  `allow-same-origin` is honoured ONLY for a cross-origin http(s) `src`;
   *  on an inline or same-origin page it is refused — see above. */
  sandbox?: string[]
  /** run the frame on the editor canvas too, not just in present mode. Off by
   *  default: a live frame per slide makes editing heavy, and an embed that
   *  autoplays sound while you arrange slides is worse. */
  liveInEditor?: boolean
  /**
   * Keep the nearest poll at or before this slide open on the audience's
   * phones while this slide shows. For a figure that reports a question live
   * (the clustered hive) — without it the room's page says "look up" the
   * moment the deck leaves the poll slide, and no more answers arrive.
   */
  keepPollOpen?: boolean
  /**
   * The person's wording for the figure's labels, by the page's own keys
   * (`data-edit="KEY"` / `TESSERA_EMBED.text(KEY, …)`). Overrides the page's
   * defaults; edited by double-click on the edit canvas. See EMBED_TEXT_BRIDGE
   * in render.ts for the page side of the contract.
   */
  texts?: Record<string, string>
}

/** True for an http URL on this machine (the live figure server). */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

/** A copied slide is no longer the figure someone is building: take its
 *  embeds off the live server so the copy shows the page it carries. Call
 *  from every path that copies elements (duplicate, paste). */
export function dropDevSrc(elements: SlideElement[]): void {
  for (const el of elements) if (el.type === 'embed') delete el.devSrc
}

/** The nearest poll on slide `index` or any slide before it. Codes are
 *  reminted when a deck is made from a template, so a figure that reads a
 *  poll finds it by position, not by a pinned code. */
export function precedingPoll(doc: Pick<TesseraDoc, 'slides'>, index: number): PollElement | undefined {
  for (let i = Math.min(index, doc.slides.length - 1); i >= 0; i--) {
    const p = doc.slides[i].elements.find((e) => e.type === 'poll') as PollElement | undefined
    if (p?.code) return p
  }
  return undefined
}

export type SlideElement =
  | TextElement | ShapeElement | ImageElement | SvgElement | ChartElement | TableElement | MediaElement
  | PollElement | EmbedElement

/**
 * A review comment thread. Editor-only metadata: never rendered while
 * presenting or printing, but saved in the file so it travels with the
 * document when people pass it around.
 */
export interface Comment {
  id: string
  /** element the thread is anchored to; absent (or dangling) = the slide */
  elementId?: string
  /** point anchor in slide coordinates — used when no elementId is set */
  x?: number
  y?: number
  author: string
  text: string
  /** ISO datetime */
  at: string
  resolved?: boolean
  replies?: Array<{ id: string; author: string; text: string; at: string }>
  /**
   * A change request for an agent (the "Ask the agent" field under the slide),
   * not a review note. Any agent processing the deck treats unresolved request
   * threads as its to-do list: it sets `status: 'working'` while it acts,
   * answers in `replies` (author = its own name), then `status: 'done'` and
   * `resolved: true`. `elementId` names the selection the request was typed
   * against, `elementIds` the full selection when there were several.
   */
  request?: boolean
  status?: 'open' | 'working' | 'done'
  elementIds?: string[]
}

export interface Slide {
  id: string
  background: string
  transition: TransitionKind
  elements: SlideElement[]
  notes: string
  /** optional friendly name (link pickers, state badges) */
  name?: string
  /**
   * Interactive state: this slide is a variant of the slide with the given
   * id. It is hidden from linear navigation — reachable only via element
   * links (and morphs smoothly when element ids are shared with its parent).
   * While on a state: ArrowLeft returns to the parent, ArrowRight continues
   * after the parent.
   */
  stateOf?: string
  /**
   * present-mode hover behaviour:
   * - focus-group: dim every element outside the hovered element's group
   * - reveal: show the showOnHover set matching the hovered group
   *   (`default` names the set visible when nothing is hovered)
   */
  hover?: { type: 'focus-group' | 'reveal'; dim?: number; default?: string }
  /** review comment threads (editor-only; see Comment) */
  comments?: Comment[]
}

export interface TesseraDoc {
  /** FORMAT for every new document; a document from before the rename keeps
   *  the value it was written with (LEGACY_SLIDES_FORMAT, see parseDoc). */
  format: typeof FORMAT | typeof LEGACY_SLIDES_FORMAT
  version: number
  /**
   * Stable per-document identity (uuid), minted at creation and preserved
   * for the document's whole life — the rendezvous key for future
   * sync / share / merge features. Never derived from content.
   */
  docId: string
  title: string
  /**
   * Optional document properties for template fields ({{author}}, {{company}},
   * {{subject}}, {{event}}) and general provenance. All optional → old files
   * simply lack it and every token resolves to empty. `title` stays top-level
   * (load-bearing) and remains the source of {{title}}.
   */
  meta?: {
    author?: string
    company?: string
    subject?: string
    event?: string
    keywords?: string
  }
  /** slide coordinate space, px */
  size: { width: number; height: number }
  theme: {
    background: string
    color: string
    accent: string
    fontFamily: string
    /** ordered series colours for new charts; derived from accent when absent */
    chartPalette?: string[]
    /** defaults for newly inserted tables; omitted decks keep the standard look */
    table?: Partial<TableStyle>
  }
  /** present-mode chrome; decks with built-in chrome can turn Reveal's off */
  present?: {
    slideNumber?: boolean
    controls?: boolean
    progress?: boolean
  }
  /**
   * Audience-poll session: ONE join code for the whole deck.
   *
   * The room scans a QR once and stays on that page; present mode publishes
   * whichever question is on screen to `sessions/{session}`, and the phones
   * follow along. Without this a listener would have to re-scan at every
   * question, which is the single worst part of running a poll from a stage.
   *
   * Optional and additive: a deck without it prints each poll's own `code` on
   * its slide and behaves exactly as it did before v1.0.12. Session codes are
   * minted with an `s` prefix (the poll alphabet has no `s`), so the audience
   * page can tell "follow the speaker" from "answer this one question" from the
   * code alone — before the speaker has published anything.
   */
  poll?: {
    session?: string
    /**
     * This deck's poll service, base URL.
     *
     * The deployment travels IN THE FILE rather than being compiled into the
     * app: a template sets it once and every deck made from it inherits a
     * working poll service, including decks opened on a shell someone else
     * built. Per-element `service` still overrides it for a single question.
     * Absent = fall back to the build's DEFAULT_POLL_HOST (usually nothing).
     */
    service?: string
  }
  /**
   * Change requests about the whole deck ("improve the flow"), typed in the
   * slide list's "Whole deck" field. The same threads as a slide's request
   * comments (`request: true`, status, replies), with no slide. Absent on
   * decks that never had one; older shells preserve the field unread.
   */
  requests?: Comment[]
  /** shared assets (raw SVG markup or data URIs), referenced by key */
  assets?: Record<string, string>
  /**
   * Live-collab blob references for LARGE assets (docs/blob-offload.md).
   *
   * An asset over BLOB_INLINE_MAX cannot travel as a CRDT op — a Durable
   * Object storage value caps near 2MB — so its bytes go to the relay's blob
   * store and only this tiny reference is synced. Receiving peers fetch,
   * decrypt and materialise the asset into `assets` themselves.
   *
   * NOT part of the document at rest in any meaningful sense: a saved file
   * carries the real bytes in `assets`, and opening it standalone ignores this
   * map entirely. It is additive and optional — older builds simply preserve
   * it as an unknown field.
   */
  blobs?: Record<string, { key: string; mime: string; size: number }>
  /**
   * embedded fonts: each entry becomes an @font-face at boot, with the font
   * data living in assets (data: URI). Elements then use `family` normally.
   *
   * `weight` is written into the rule verbatim, so it takes a RANGE as well as
   * a number — `"200 800"` on a variable-font file covers every weight in the
   * deck from one asset. `unicodeRange` (additive, v1.0.11) splits a family
   * across subset files the way a webfont service does: a latin + latin-ext
   * pair is tens of KB where the full charset is hundreds, and a glyph outside
   * every declared range simply falls back to the next font in the stack.
   */
  fonts?: Array<{
    family: string
    asset: string
    weight?: string
    style?: string
    unicodeRange?: string
  }>
  /**
   * Slide layouts: slide-shaped templates that live outside slides[].
   * Instantiating one deep-copies its elements KEEPING their ids — slides
   * born from the same layout share ids, so their common chrome morphs
   * across transitions and stays traceable for a future re-apply merge.
   * When absent, the editor offers its built-in starter layouts.
   */
  layouts?: Slide[]
  /**
   * Live-collaboration credentials (tab sync), minted AT CREATION so any
   * copy of the file can join once sharing is turned on ("send the file
   * first, share later" just works). `room` is the relay WebSocket URL
   * (random id — never derived from docId), `key` the base64url AES-GCM
   * room key. `on` gates auto-join: absent = true (v0.8.0 files only carried
   * collab while actively shared). Possession of a copy IS the capability;
   * "Rotate keys" re-mints both to cut old copies off. `sync` is the saved
   * CRDT state (registers/liveness/text) stamped at save-time on shared
   * documents — it is what lets an offline-edited copy rejoin as a true
   * fork and merge both ways. Never transmitted as sync ops.
   */
  collab?: {
    room: string
    key: string
    on?: boolean
    sync?: import('./sync/crdt').SyncStateJSON
    /**
     * Signed writes (v0.9.18+): the WRITE capability is an ECDSA P-256 keypair,
     * distinct from the symmetric `key` (the READ capability). `writerPub`
     * (raw, base64url) travels in EVERY copy so the relay can verify authorship;
     * `writerPriv` (PKCS#8, base64url) travels ONLY in writer copies. A
     * read-only copy is a writer copy with `writerPriv` stripped — the relay
     * (for `w`-scheme rooms) then drops any op it tries to send. Absent on
     * legacy `r`-scheme rooms, which stay permissive. See docs/collab-design.md.
     */
    writerPub?: string
    writerPriv?: string
    /** 'reader' = this copy is a live viewer: receives updates, never sends. */
    role?: 'writer' | 'reader'
    /**
     * Fine-grained access (v1.0.3+, `v: 2`): per-person keys. The room id
     * commits to the OWNER's pubkey. A member copy carries an INVITE — an
     * owner-signed delegation keypair — and each device mints its own identity
     * key (kept in localStorage, never in the file); the chain
     * owner → invite → member is what the blind relay verifies. `ownerPriv`
     * travels ONLY in the owner's own copy. See docs/collab-design.md roadmap.
     */
    v?: number
    owner?: string
    ownerPriv?: string
    invite?: {
      pub: string
      priv: string
      role: 'writer' | 'commenter'
      /** unix ms expiry; 0/absent = no expiry */
      exp?: number
      /** owner's signature over `inv.${pub}.${role}.${exp||0}` */
      sig: string
    }
  }
  /**
   * Template file (.dotx-style): every OPEN instantiates a fresh document —
   * parseDoc strips this flag, mints a new docId and drops collab, so each
   * person who opens the template gets an independent deck with its own
   * identity and credentials. The template file itself never changes (there
   * is no file handle until the user's first save-as).
   */
  template?: boolean
  /**
   * A read-only PLAYER file: boots straight into the presentation and never
   * shows the editor. Honor-system (the JSON is right there), but it makes a
   * hand-out copy present-only for everyone who doesn't go digging.
   */
  readonly?: boolean
  slides: Slide[]
  modified: string
}

let counter = 0
export const uid = (prefix = 'el') =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/**
 * An element's effective morph key: the `morphId` override when set, else its
 * own `id`. THE single definition — render.ts stamps it into `data-flip-id`,
 * present.ts pairs and looks up model frames by it, and the panel uses it for
 * collision checks. Computing it inline in more than one place is exactly how
 * issue #54 happened: present.ts's model map keyed by `id` while every lookup
 * passed a flip id, so any element carrying a `morphId` silently missed and
 * never morphed. Route every morph-key read through here.
 */
export function morphKey(el: Pick<ElementBase, 'id' | 'morphId'>): string {
  return el.morphId || el.id
}

/** True when a background reads as light (so it wants dark text on top). Accepts
 *  a #rrggbb hex; for a gradient/CSS string it samples the first hex it finds and
 *  falls back to "light" (the safe assumption for the model's dark default ink). */
export function isLightBg(bg: string): boolean {
  const hex = /#([0-9a-fA-F]{6})/.exec(bg || '')
  if (!hex) return true
  const n = parseInt(hex[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 // sRGB relative luminance
}

/** A text colour that stays legible on the given background — new text/tables use
 *  this so a fresh element is never invisible on a dark deck. */
export function readableInk(bg: string): string {
  return isLightBg(bg) ? '#1E2A3A' : '#F5F7FA'
}

export function defaultText(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: uid('t'),
    type: 'text',
    x: 340, y: 300, w: 600, h: 120,
    rotation: 0, opacity: 1,
    html: 'Double-click to edit',
    fontSize: 32,
    fontFamily: FONT_STACK,
    fontWeight: 400,
    color: '#1E2A3A',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.25,
    ...partial,
  }
}

// --- table → chart data extraction (shared by creation + live binding) -------

const stripCell = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').replace(/,/g, '').trim()

/** First column = x labels; each mostly-numeric column after = a data series. */
export function tableChartColumns(table: TableElement): { labels: string[]; cols: Array<{ name: string; data: number[]; isPct: boolean }> } {
  const bodyRows = table.header ? table.rows.slice(1) : table.rows
  const headerRow = table.header ? table.rows[0] : null
  const labels = bodyRows.map((r) => stripCell(r.cells[0]?.html ?? ''))
  const cols: Array<{ name: string; data: number[]; isPct: boolean }> = []
  for (let c = 1; c < table.columns.length; c++) {
    const raw = bodyRows.map((r) => r.cells[c]?.html ?? '')
    const parsed = raw.map((h) => parseFloat(stripCell(h)))
    if (parsed.filter((n) => !Number.isNaN(n)).length < Math.ceil(bodyRows.length / 2)) continue
    cols.push({
      name: headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '',
      data: parsed.map((n) => (Number.isNaN(n) ? 0 : n)),
      isPct: /%/.test(headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '') ||
        raw.filter((h) => /%/.test(h)).length >= Math.ceil(bodyRows.length / 2),
    })
  }
  return { labels, cols }
}

/**
 * Push a linked table's current values into a chart's option IN PLACE,
 * preserving the chart's styling/axis config (only xAxis labels + each series'
 * data change). Returns true if anything changed. Series map to numeric columns
 * by position; extra series/columns are left untouched.
 */
export function syncLinkedChart(chart: ChartElement, table: TableElement): boolean {
  const before = JSON.stringify(chart.option)
  const { labels, cols } = tableChartColumns(table)
  const opt = chart.option as { xAxis?: any; series?: any }
  if (opt.xAxis && !Array.isArray(opt.xAxis) && typeof opt.xAxis === 'object') opt.xAxis.data = labels
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
  series.forEach((s, i) => {
    if (!s || !cols[i]) return
    if (s.type === 'pie') s.data = labels.map((name, j) => ({ name, value: cols[i].data[j] ?? 0 }))
    else s.data = cols[i].data
  })
  return JSON.stringify(chart.option) !== before
}

export function defaultImage(src: string, partial: Partial<ImageElement> = {}): ImageElement {
  return {
    id: uid('i'),
    type: 'image',
    x: 440, y: 210, w: 400, h: 300,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: 0,
    ...partial,
  }
}

/** Park an embedded data URI in `doc.assets` and return an `asset:` ref.
 *
 *  Every embed goes through here so there is exactly ONE place binary content
 *  lives. Identical bytes reuse the same key, so duplicating an image (or
 *  pasting the same photo twice) costs one copy in the file.
 *  A URL or an existing `asset:` ref passes straight through — only `data:`
 *  is interned. Callers MUST run this inside a `store.commit` so the assets
 *  write is part of the same undo step and the same sync batch. */
export function internAsset(doc: TesseraDoc, src: string): string {
  if (!src.startsWith('data:')) return src
  const assets = (doc.assets ??= {})
  for (const k in assets) if (assets[k] === src) return `asset:${k}`
  const key = uid('a')
  assets[key] = src
  return `asset:${key}`
}

/**
 * Give copied `elements` their own copy of every FIGURE asset they show — an
 * embed's or svg's page, and an embed's poster — in place.
 *
 * Call this from every path that copies a slide inside one deck (duplicate,
 * paste). A figure is revised by rewriting `assets[key]`, so two slides left
 * on one key are still one figure: revising the copy silently rewrote the
 * original too. Plain images stay shared on purpose — the logo is one asset
 * on every slide, and replacing a picture in the editor interns a new key
 * anyway. `only` limits the fork to those keys (paste: the ones the deck
 * already had). Callers MUST run this inside a `store.commit`, like
 * internAsset.
 */
export function forkFigureAssets(doc: TesseraDoc, elements: SlideElement[], only?: Set<string>): void {
  const assets = doc.assets
  if (!assets) return
  const forked = new Map<string, string>()
  const fork = (key: string): string => {
    if (assets[key] == null || (only && !only.has(key))) return key
    let next = forked.get(key)
    if (!next) {
      let n = 2
      while (assets[`${key}-${n}`] !== undefined) n++
      next = `${key}-${n}`
      assets[next] = assets[key]
      forked.set(key, next)
    }
    return next
  }
  for (const el of elements) {
    if (el.type !== 'embed' && el.type !== 'svg') continue
    if (el.asset) el.asset = fork(el.asset)
    if (el.type === 'embed' && el.poster?.startsWith('asset:')) el.poster = 'asset:' + fork(el.poster.slice(6))
  }
}

export function defaultMedia(
  kind: 'video' | 'audio',
  src: string,
  partial: Partial<MediaElement> = {},
): MediaElement {
  const audio = kind === 'audio'
  return {
    id: uid('m'),
    type: 'media',
    kind,
    x: 440, y: 210,
    w: audio ? 460 : 560, h: audio ? 56 : 315,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: audio ? 12 : 8,
    controls: true,
    // video defaults muted so present-mode autoplay is permitted by browsers
    muted: !audio,
    loop: false,
    autoplay: false,
    ...partial,
  }
}

// --- audience polls -----------------------------------------------------------

declare const __POLL_HOST__: string

/**
 * The poll service this BUILD falls back to — the last resort, under every
 * other source below.
 *
 * Empty in the source on purpose. A poll host is somebody's deployment, not a
 * property of the app: hard-coding one here points every deck built from this
 * repo at a stranger's server, and a deck that outlives that deployment breaks
 * with no way to tell why. Set it per build instead (`POLL_HOST=… npm run
 * build:single`, see vite.config.ts) — or better, let the deck carry its own
 * (`doc.poll.service`), which travels with the file and survives a rebuild.
 */
export const DEFAULT_POLL_HOST: string =
  typeof __POLL_HOST__ !== 'undefined' ? __POLL_HOST__ : ''

/**
 * The open document's own poll service, set at boot from `doc.poll.service`.
 *
 * Module state rather than a parameter threaded through twenty call sites:
 * one deck file is one document per page, and this value is a property of the
 * file we booted from. setDeckPollHost is called at boot and again on
 * replaceDoc (JSON round-trip, version restore) so it never goes stale.
 */
let deckPollHost = ''
export function setDeckPollHost(url: string | undefined | null): void {
  deckPollHost = (url ?? '').replace(/\/+$/, '')
}

/**
 * Where this poll talks to the service. First match wins:
 *
 *   1. the element's own `service` — one question pointed somewhere else
 *   2. localStorage `tessera-poll-url` — the VIEWER's dev override: that's how
 *      you aim a deck at `vercel dev` without editing the document
 *   3. the document's `poll.service` — the deck's own deployment, saved in the
 *      file, so a template hands it to every deck made from it
 *   4. whatever this build was compiled with (usually nothing)
 *
 * '' means no service is configured; callers must not turn that into a
 * relative URL, which would silently hit whatever host the file was opened
 * from. Use pollConfigured() to check.
 */
export function pollHost(el?: Pick<PollElement, 'service'>): string {
  if (el?.service) return el.service.replace(/\/+$/, '')
  try {
    const o = localStorage.getItem('tessera-poll-url')
    if (o) return o.replace(/\/+$/, '')
  } catch { /* storage blocked (file:// in some browsers) — fall through */ }
  return deckPollHost || DEFAULT_POLL_HOST
}

/** Is there a poll service to talk to at all? */
export const pollConfigured = (el?: Pick<PollElement, 'service'>): boolean => pollHost(el) !== ''

// --- the lecturer key ---------------------------------------------------------
//
// A deployment may set LECTURER_PASSWORD, which gates the four PRESENTER routes
// on the poll service: publishing an activity page, clearing responses, pointing
// the room's phones at a question, and summarizing (the one that spends money).
// The audience routes stay open — see server/poll-app/README.md.
//
// It lives in localStorage, NEVER in the document. A deck file is made to be
// shared, and a shared deck carrying its author's key would hand every recipient
// the presenter controls. This way it is per person, per machine, entered once.

const LECTURER_STORE = 'tessera-lecturer-key'

export function lecturerKey(): string {
  try {
    return localStorage.getItem(LECTURER_STORE) ?? ''
  } catch {
    return '' // storage blocked (file:// in some browsers)
  }
}

export function setLecturerKey(key: string): void {
  try {
    const v = key.trim()
    if (v) localStorage.setItem(LECTURER_STORE, v)
    else localStorage.removeItem(LECTURER_STORE)
  } catch { /* nothing we can do, and nothing worth interrupting a talk for */ }
}

/** A join code someone can read off a projector and type without a typo.
 *  Lowercase alphanumeric minus the characters that get misread at the back of
 *  a room: 0/o, 1/l/i, 5/s, 2/z. Six of these is ~1.5 billion combinations,
 *  which is ample — codes are short-lived and scoped to one talk. */
const CODE_ALPHABET = 'abcdefghjkmnpqrtuvwxy346789'
export function pollCode(len = 6): string {
  let out = ''
  const rand = new Uint8Array(len)
  crypto.getRandomValues(rand)
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[rand[i] % CODE_ALPHABET.length]
  return out
}

/**
 * A deck-wide session code. The `s` prefix is load-bearing: CODE_ALPHABET has
 * no `s`, so no question code can ever look like a session code, and the
 * audience page can branch on the code it was handed with no round trip —
 * which matters because the interesting case (someone scans the QR before the
 * speaker has opened a question) is exactly the one where the server knows
 * nothing yet.
 */
export function pollSessionCode(): string {
  return `s${pollCode(6)}`
}

/** True for a MINTED session code. A lecturer may name the join code instead
 *  ({@link isJoinCode}); the service then tells the join page it is a session. */
export function isPollSessionCode(code: string): boolean {
  return /^s[a-z0-9]{4,11}$/.test(code)
}

/** What a join code may be: 3–24 of a–z, 0–9 and inner hyphens. Mirrors
 *  SESSION_RE in server/poll-app/api/_lib.js — the server is the authority. */
export function isJoinCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/.test(code)
}

/** Turn what someone typed ("My Class 2026") into the nearest join code. */
export function toJoinCode(typed: string): string {
  return typed.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '')
}

/** The deck's session code, minting one if this deck has never had it. */
export function ensurePollSession(doc: TesseraDoc): string {
  if (!doc.poll) doc.poll = {}
  if (!doc.poll.session) doc.poll.session = pollSessionCode()
  return doc.poll.session
}

/** What goes on the slide and in the QR: the deck's one session code when it
 *  has one, else this question's own code (pre-v1.0.12 decks). */
export function pollJoinCode(doc: Pick<TesseraDoc, 'poll'>, el: Pick<PollElement, 'code'>): string {
  return doc.poll?.session || el.code
}

// --- reading answers back -----------------------------------------------------
//
// Answers arrive as plain strings for every question kind (see PollElement).
// These two turn them into the numbers a `choice` or `rating` slide reports.
// They live in the model, not in present.ts, because the live slide, the panel
// and the spreadsheet export must all count identically.

export const RATING_MIN = 1
export const RATING_MAX = 5

export function ratingScale(el: Pick<PollElement, 'min' | 'max'>): { min: number; max: number } {
  const min = Number.isFinite(el.min) ? Math.round(el.min as number) : RATING_MIN
  const max = Number.isFinite(el.max) ? Math.round(el.max as number) : RATING_MAX
  // A scale that runs backwards (or has no room in it) is a typo, not an
  // intention: fall back rather than render an empty row of buttons.
  return max > min ? { min, max } : { min: RATING_MIN, max: RATING_MAX }
}

/**
 * An answer whose text parses as a JSON array of strings is a `multi` pick —
 * each element is one option picked. Anything else (including a plain option
 * string, which is never valid JSON array syntax) is a single pick of the
 * whole text, unchanged from every answer collected before `multi` existed.
 */
function choicePicks(text: string): string[] {
  const raw = text.trim()
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) return parsed
    } catch { /* not a picks array — fall through to a single pick */ }
  }
  return [raw]
}

/**
 * Counts per option, in the author's order. Anything that doesn't match an
 * option is bucketed under `other` — an answer collected before the options
 * were edited is still a real answer and must not silently vanish from a chart
 * whose total is read aloud.
 *
 * `total` counts ANSWERS (respondents), not picks, so percentages read "x% of
 * the room picked this" even when `multi` lets one respondent land in several
 * rows. A single-pick answer still contributes exactly one count to one
 * bucket, so this is byte-for-byte the old behaviour when `multi` is unused.
 */
export function tallyChoices(
  el: Pick<PollElement, 'options'>,
  answers: Array<{ text: string }>,
): { rows: Array<{ label: string; count: number }>; other: number; total: number } {
  const options = el.options ?? []
  const counts = new Map(options.map((o) => [o.trim().toLowerCase(), 0]))
  let other = 0
  let total = 0
  for (const a of answers) {
    const text = String(a.text ?? '').trim()
    if (!text) continue
    total++
    for (const pick of choicePicks(text)) {
      const key = pick.trim().toLowerCase()
      if (!key) continue
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
      else other++
    }
  }
  const rows = options.map((o) => ({ label: o, count: counts.get(o.trim().toLowerCase()) ?? 0 }))
  return { rows, other, total }
}

/** Average and per-value distribution for a rating question. `count` is how
 *  many answers parsed as a number — the average's real denominator. */
export function ratingStats(
  el: Pick<PollElement, 'min' | 'max'>,
  answers: Array<{ text: string }>,
): { average: number; count: number; rows: Array<{ value: number; count: number }> } {
  const { min, max } = ratingScale(el)
  const rows = Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, count: 0 }))
  let sum = 0
  let count = 0
  for (const a of answers) {
    const raw = String(a.text ?? '').trim().replace(',', '.')
    // Number('') is 0, which would drag every average toward the floor for
    // free. An empty answer is not a rating of zero.
    if (!raw) continue
    const v = Number(raw)
    if (!Number.isFinite(v)) continue
    sum += v
    count++
    const row = rows[Math.round(v) - min]
    if (row) row.count++
  }
  return { average: count ? sum / count : 0, count, rows }
}

/**
 * Grade a quiz and report the distribution of SCORES (how many people got 0
 * right, 1 right, …), which is what the slide draws.
 *
 * Grading happens HERE, from `questions[].correct`, because that is the only
 * copy of the right answers: the phone is sent the questions without them and
 * submits `{"picks":[…]}`, one 0-based option index per question (`null`/-1
 * for one it skipped). So a student inspecting the traffic sees what they were
 * asked and nothing more.
 *
 * An answer whose picks don't parse is ignored rather than counted as zero —
 * the same reasoning as ratingStats: a broken payload is not a bad score, and
 * it must not drag down an average someone reads out to the room.
 */
export function quizStats(
  el: Pick<PollElement, 'questions'>,
  answers: Array<{ text: string }>,
): { average: number; count: number; total: number; rows: Array<{ score: number; count: number }> } {
  const questions = el.questions ?? []
  const total = questions.length
  const rows = Array.from({ length: total + 1 }, (_, i) => ({ score: i, count: 0 }))
  let sum = 0
  let count = 0
  for (const a of answers) {
    let picks: unknown
    try { picks = JSON.parse(String(a.text ?? '')) } catch { continue }
    const list = (picks as { picks?: unknown })?.picks
    if (!Array.isArray(list)) continue
    let score = 0
    questions.forEach((q, i) => { if (Number(list[i]) === q.correct) score++ })
    sum += score
    count++
    const row = rows[score]
    if (row) row.count++
  }
  return { average: count ? sum / count : 0, count, total, rows }
}

/** One person's score, for the spreadsheet export. Null when unparseable. */
export function quizScoreOf(
  el: Pick<PollElement, 'questions'>,
  text: string,
): number | null {
  const { count, average } = quizStats(el, [{ text }])
  return count ? Math.round(average) : null
}

/**
 * Give every poll among `elements` a fresh join code, in place.
 *
 * Call this from every path that COPIES a poll into a new slide or element:
 * instantiating a layout, pasting, duplicating. Two slides sharing one code
 * silently pool their answers into a single poll, and that is a miserable bug
 * to notice from the stage — whereas an unwanted second code is visible in the
 * panel and trivially fixed by pasting the old one back.
 *
 * The deliberate exception is a state slide (`createLinkedState`), which is
 * another view of the SAME question and must keep the same code.
 */
export function remintPollCodes(elements: SlideElement[]): void {
  for (const el of elements) if (el.type === 'poll') el.code = pollCode()
}

export function defaultPoll(partial: Partial<PollElement> = {}, slide?: Slide): PollElement {
  return {
    id: uid('poll'),
    type: 'poll',
    // full content width on the default 1280×720 page, inside 96px margins
    x: 96, y: 168, w: 1088, h: 456,
    rotation: 0, opacity: 1,
    question: 'What is your question for the audience?',
    code: pollCode(),
    fontSize: 40,
    color: readableInk(slide?.background ?? '#FFFFFF'),
    ...partial,
  }
}

export function emptySlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: uid('slide'),
    background: '#FFFFFF',
    transition: 'morph',
    elements: [],
    notes: '',
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Layouts. A layout is a Slide that lives in doc.layouts (or the built-in
// set below). Element ids are deterministic per layout and are KEPT when a
// layout is instantiated: slides born from the same layout share ids, so
// their common chrome morphs across transitions.

const ph = (
  id: string,
  placeholder: string,
  frame: { x: number; y: number; w: number; h: number },
  type: Partial<TextElement> = {},
): TextElement => ({
  id,
  type: 'text',
  ...frame,
  rotation: 0, opacity: 1,
  html: '',
  placeholder,
  fontSize: 32,
  fontFamily: FONT_STACK,
  fontWeight: 400,
  color: '#1E2A3A',
  align: 'left',
  valign: 'top',
  lineHeight: 1.25,
  ...type,
})

const bar = (id: string, frame: { x: number; y: number; w: number; h: number }): ShapeElement => ({
  id, type: 'shape', shape: 'rect', ...frame,
  rotation: 0, opacity: 1, fill: '#F7A600', stroke: 'transparent', strokeWidth: 0, radius: 2,
})

/** The layouts every document offers out of the box (not persisted until edited). */
export function builtinLayouts(): Slide[] {
  return [
    {
      id: 'layout-title', name: 'Title', background: '#FFFFFF', transition: 'morph', notes: '', elements: [
        bar('lt-bar', { x: 160, y: 380, w: 72, h: 8 }),
        ph('lt-title', 'Click to add title', { x: 160, y: 404, w: 1280, h: 140 },
          { fontSize: 76, fontWeight: 700, valign: 'middle', role: 'title' }),
        ph('lt-sub', 'Click to add subtitle', { x: 160, y: 556, w: 1100, h: 60 },
          { fontSize: 28, color: '#45566B', valign: 'middle', role: 'subtitle' }),
      ],
    },
    {
      id: 'layout-title-content', name: 'Title + content', background: '#FFFFFF', transition: 'morph', notes: '', elements: [
        ph('ltc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('ltc-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('ltc-body', 'Click to add content', { x: 120, y: 208, w: 1360, h: 600 },
          { fontSize: 26, color: '#586A80', valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-two-col', name: 'Two columns', background: '#FFFFFF', transition: 'morph', notes: '', elements: [
        ph('l2c-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('l2c-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('l2c-left', 'Left column', { x: 120, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ph('l2c-right', 'Right column', { x: 820, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-section', name: 'Section divider', background: '#1E2A3A', transition: 'morph', notes: '', elements: [
        bar('lsec-bar', { x: 160, y: 396, w: 72, h: 8 }),
        ph('lsec-title', 'Section title', { x: 160, y: 420, w: 1280, h: 120 },
          { fontSize: 64, fontWeight: 700, color: '#FFFFFF', valign: 'middle', role: 'title' }),
        ph('lsec-kicker', 'PART 1', { x: 160, y: 350, w: 800, h: 40 },
          { fontSize: 18, fontWeight: 600, color: '#F7A600', letterSpacing: 3, valign: 'middle', role: 'kicker' }),
      ],
    },
    {
      // The poll element draws its own question, so this layout deliberately
      // has no title placeholder — one question, one place to edit it.
      id: 'layout-poll', name: 'Audience question', background: '#FFFFFF', transition: 'morph',
      notes: 'Ask the room, then press Summarize while presenting to turn the answers into themes on this slide.',
      elements: [
        bar('lpoll-bar', { x: 96, y: 116, w: 72, h: 8 }),
        defaultPoll({ id: 'lpoll-poll', question: 'Click the slide, then type your question in the panel.' }),
      ],
    },
    { id: 'layout-blank', name: 'Blank', background: '#FFFFFF', transition: 'morph', notes: '', elements: [] },
  ]
}

/** A fresh slide from a layout — new slide id, element ids KEPT (lineage).
 *  Poll codes are the one thing re-minted: ids are shared on purpose so layout
 *  chrome morphs between slides, but a shared join CODE would pool two slides'
 *  answers into one poll. See remintPollCodes. */
export function instantiateLayout(layout: Slide): Slide {
  const copy: Slide = JSON.parse(JSON.stringify(layout))
  remintPollCodes(copy.elements)
  return { ...copy, id: uid('slide'), name: undefined, stateOf: undefined, notes: '' }
}

export const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : uid('doc')

export function newDoc(): TesseraDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: newDocId(),
    title: 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent: '#F7A600',
      fontFamily: FONT_STACK,
    },
    slides: [emptySlide()],
    modified: new Date().toISOString(),
  }
}

/**
 * The form a template is WRITTEN to disk in: flagged, and stripped of the
 * identity a template must not hand out.
 *
 * parseDoc drops `template` on open — that IS the instantiation — so the doc in
 * memory while you edit a template is an ordinary deck with its own docId, its
 * own collab credentials and its own poll session. Saving that doc as-is is
 * what silently turns a template back into a normal file, and then every person
 * who opens it inherits one docId (autosave recovery collides), one live room
 * and one poll session (two speakers steer each other's audience). Templates go
 * through here on the way out instead, so those fields simply are not in the
 * bytes and the next open mints fresh ones.
 *
 * Poll codes are deliberately NOT re-minted: the ones in the file are already
 * placeholders that parseDoc replaces on every open.
 */
export function asTemplateFile(doc: TesseraDoc): TesseraDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as TesseraDoc
  clone.template = true
  delete (clone as { docId?: string }).docId
  delete clone.collab
  return clone
}

export function parseDoc(json: string): TesseraDoc | null {
  try {
    const doc = JSON.parse(json)
    // Either format value; it is kept as found, because an older shell refuses
    // a document carrying the new one and the JSON travels between files.
    if (doc && (doc.format === FORMAT || doc.format === LEGACY_SLIDES_FORMAT) && Array.isArray(doc.slides) && doc.slides.length > 0) {
      // Documents from before docId existed get one minted here; it persists
      // on the next save and stays stable from then on.
      if (typeof doc.docId !== 'string' || !doc.docId) doc.docId = newDocId()
      if (doc.template) {
        // template instantiation: this open IS a new document
        delete doc.template
        doc.docId = newDocId()
        delete doc.collab
        // …and a new document runs its own polls. Without this, every talk given
        // from the same template would collect into one shared poll, and the
        // second speaker would see the first one's answers. Same reasoning as
        // dropping `collab` above: a fresh deck must not inherit live identity.
        // A SAVED deck keeps its codes across opens — otherwise the poll you
        // rehearsed with would not be the poll you present.
        for (const slide of doc.slides as Slide[]) remintPollCodes(slide.elements)
        // …and its own session, or two speakers running the same template would
        // steer each other's audiences from question to question.
        if (doc.poll?.session) doc.poll.session = pollSessionCode()
      }
      return doc as TesseraDoc
    }
  } catch {
    /* fall through */
  }
  return null
}
