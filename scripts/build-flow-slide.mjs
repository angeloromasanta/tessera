#!/usr/bin/env node
/**
 * Session-flow slide generator — a proportional timeline of a session's phases.
 *
 *   node scripts/build-flow-slide.mjs template.html
 *   node scripts/build-flow-slide.mjs deck.html --phases "10 Icebreaker, 50 Lecture, 10 Break"
 *   node scripts/build-flow-slide.mjs brand.html --config path/to/flow-slide.json
 *
 * Writes ONE slide (id `sl-<prefix>agenda`) + a matching layout (`<prefix>agenda`)
 * into an existing deck, leaving every other slide untouched. Re-running it
 * REPLACES that slide — which is the point: change the minutes here and the
 * block widths recompute proportionally. Everyday text edits (labels, title,
 * footer) are better done in the app; only come back here to re-balance time.
 *
 * Look and ids come from the deck itself unless a --config JSON overrides them:
 *   prefix      ''            ids `sl-<prefix>agenda` / `<prefix>agenda`
 *   titleFont   the deck's serif title face (the first doc.fonts family that is not the text face)
 *   textFont    Manrope stack
 *   logo        null -> an empty text wordmark (id logo); "asset-key" -> that image
 *   title, subtitle, colors {title, muted, pill, axis, shadow}
 *   skins       [{from, to, ink, mute}, …] cycled over the phases
 *   phases      [{min, label}, …] the default running order (--phases wins)
 *
 * The splice follows the same contract as the other generators: only the
 * document block (#tessera-doc, or the older id) is rewritten, every "<"
 * escaped as the JSON unicode form.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { backup } from './backup.mjs'
import { LEGACY_DOC_ID, LEGACY_DOC_TYPE } from './legacy.mjs'

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const args = process.argv.slice(2)
const flag = (name) => {
  const a = args.find((x) => x === name || x.startsWith(name + '='))
  if (!a) return undefined
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[args.indexOf(a) + 1]
}
const valued = new Set(['--phases', '--config'])
const file = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
if (!file) {
  console.error('usage: node scripts/build-flow-slide.mjs <deck.html> [--phases "10 Icebreaker, 50 Lecture, …"] [--config flow.json]')
  process.exit(1)
}

// ——— the deck ——————————————————————————————————————————————————————————
// the block under its new name or the old one (scripts/legacy.mjs); group 1 type, 2 id, 3 JSON
const blockRe = new RegExp(String.raw`<script type="(application/tessera\+json|${esc(LEGACY_DOC_TYPE)})" ` +
  String.raw`id="(tessera-doc|${esc(LEGACY_DOC_ID)})">([\s\S]*?)<\/script>`)
const html = readFileSync(file, 'utf8')
const m = blockRe.exec(html)
if (!m) throw new Error(`${file}: no document block — is this a tessera deck?`)
// No un-escaping pass on the way in: the escaped form of "<" is ordinary JSON
// and JSON.parse already yields the character. A blanket text replace would
// also eat a DOUBLED backslash inside an embedded asset's own source and
// break the string it sits in.
const doc = JSON.parse(m[3].trim())
const cfgPath = flag('--config')
const cfg = cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}

const theme = doc.theme || {}
const SANS = cfg.textFont || "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const textFamily = SANS.split(',')[0].trim()
const titleFamily = (doc.fonts || []).map((f) => f.family).find((f) => f && f !== textFamily)
const SERIF = cfg.titleFont || (titleFamily ? `${titleFamily}, Georgia, 'Times New Roman', serif` : SANS)
const ACCENT = theme.accent || '#0F6B73'
const INK = theme.color || '#1A2326'
const C = {
  title: ACCENT, muted: '#5A6467', pill: '#F1F5F5', axis: '#C1CBCD', tick: '#899395',
  shadow: 'rgba(26,35,38,0.14)', ...(cfg.colors || {}),
}
const PREFIX = cfg.prefix ?? ''
const TITLE = cfg.title || 'Session flow'
const SUBTITLE = cfg.subtitle || 'How the time is spent — each block is drawn to scale.'

// ——— content ————————————————————————————————————————————————————————————
// colours per block, cycled; default: the deck's own chart pairs and accent
const SKINS = cfg.skins || [
  { from: '#FCF0DA', to: '#BF831A', ink: INK, mute: 'rgba(26,35,38,0.58)' },
  { from: ACCENT, to: '#0D2A2F', ink: '#FFFFFF', mute: 'rgba(255,255,255,0.66)' },
  { from: '#F1F5F5', to: '#DCE7E8', ink: ACCENT, mute: 'rgba(15,107,115,0.62)' },
  { from: '#3B9457', to: '#2B7041', ink: '#FFFFFF', mute: 'rgba(255,255,255,0.66)' },
  { from: '#FBE8E2', to: '#D2553A', ink: INK, mute: 'rgba(26,35,38,0.58)' },
]
let PHASES = cfg.phases || [
  { min: 10, label: 'Icebreaker' },
  { min: 50, label: 'Lecture' },
  { min: 10, label: 'Break' },
  { min: 40, label: 'Group activity' },
  { min: 10, label: 'Synthesis' },
]
const phasesArg = flag('--phases')
if (phasesArg !== undefined) {
  PHASES = String(phasesArg ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const mm = /^(\d+)\s+(.+)$/.exec(s)
      if (!mm) throw new Error(`--phases: expected "<minutes> <label>", got "${s}"`)
      return { min: Number(mm[1]), label: mm[2] }
    })
  if (!PHASES.length) throw new Error('--phases: nothing to lay out')
}
PHASES = PHASES.map((p, i) => ({ ...SKINS[i % SKINS.length], ...p }))

// ——— geometry ———————————————————————————————————————————————————————————
const TRACK_X = 56
const TRACK_W = 1168 // 1280 − 2 × 56 margin
const GAP = 8
const BAR_Y = 288
const BAR_H = 200
const MIN_W = 92 // a block narrower than this can't hold its own label

const total = PHASES.reduce((a, p) => a + p.min, 0)
const avail = TRACK_W - GAP * (PHASES.length - 1)
if (avail / PHASES.length < MIN_W) throw new Error(`${PHASES.length} phases don't fit on one track — split the slide`)

/**
 * Proportional widths, with a floor: a 5-minute break next to a 90-minute
 * workshop would otherwise render as an unreadable sliver. Anything under
 * MIN_W is pinned there and the remaining width is re-shared by the rest,
 * repeated until nothing else falls through the floor.
 */
function widths() {
  let w = PHASES.map((p) => (p.min / total) * avail)
  for (let pass = 0; pass < 8; pass++) {
    const pinned = w.map((x) => x < MIN_W)
    if (!pinned.some(Boolean)) break
    const rest = avail - pinned.filter(Boolean).length * MIN_W
    const restMin = PHASES.reduce((a, p, i) => a + (pinned[i] ? 0 : p.min), 0)
    w = PHASES.map((p, i) => (pinned[i] ? MIN_W : (p.min / restMin) * rest))
  }
  return w
}

// place from the cumulative exact edges, then round — the track always ends
// on TRACK_X + TRACK_W however the fractions fall.
const raw = widths()
let run = 0
const segs = PHASES.map((p, i) => {
  const start = TRACK_X + run + i * GAP
  run += raw[i]
  const end = TRACK_X + run + i * GAP
  return { ...p, x: Math.round(start), w: Math.round(end) - Math.round(start) }
})

// ——— elements ———————————————————————————————————————————————————————————
const base = { rotation: 0, opacity: 1 }
const text = (o) => ({
  ...base,
  type: 'text',
  fontFamily: SANS,
  fontWeight: 400,
  align: 'left',
  valign: 'top',
  lineHeight: 1.4,
  ...o,
})

const clock = (mins) => `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`

const logo = cfg.logo
  ? { ...base, id: 'logo', type: 'image', x: 56, y: 36, w: 82, h: 26, src: `asset:${cfg.logo}`, fit: 'contain', radius: 0 }
  : text({ id: 'logo', x: 56, y: 36, w: 240, h: 26, html: '', placeholder: 'Wordmark', fontSize: 13,
      fontWeight: 700, color: INK, valign: 'middle', lineHeight: 1.2, letterSpacing: 1.2 })

const chrome = [
  logo,
  text({
    id: 'fl-title', x: 56, y: 88, w: 900, h: 52, html: TITLE, fontSize: 40, fontFamily: SERIF,
    color: C.title, lineHeight: 1.2, placeholder: 'Slide title', role: 'title', fx: { enter: 'fade-up', order: 0 },
  }),
  text({
    id: 'fl-sub', x: 56, y: 148, w: 900, h: 30, html: SUBTITLE, fontSize: 17, color: C.muted, lineHeight: 1.5,
    placeholder: 'One line of context', role: 'subtitle', fx: { enter: 'fade-up', order: 0 },
  }),
  {
    ...base, id: 'fl-total-pill', type: 'shape', shape: 'rect', x: 1064, y: 92, w: 160, h: 34,
    fill: C.pill, stroke: 'transparent', strokeWidth: 0, radius: 17, fx: { enter: 'fade-up', order: 0 },
  },
  text({
    id: 'fl-total', x: 1064, y: 92, w: 160, h: 34, html: `${total} min total`, fontSize: 13, fontWeight: 700,
    color: C.title, align: 'center', valign: 'middle', letterSpacing: 0.2, fx: { enter: 'fade-up', order: 0, countUp: true },
  }),
]

const columns = segs.flatMap((s, i) => {
  const n = i + 1
  const group = `phase-${n}`
  const fx = { enter: 'slide-up', order: n }
  return [
    {
      ...base, id: `fl-bar${n}`, type: 'shape', shape: 'rect', x: s.x, y: BAR_Y, w: s.w, h: BAR_H,
      fill: s.to, stroke: 'transparent', strokeWidth: 0, radius: 10,
      fillGradient: { angle: 135, stops: [{ at: 0, color: s.from }, { at: 1, color: s.to }] },
      shadow: { x: 0, y: 8, blur: 22, color: C.shadow }, group, fx,
    },
    text({
      id: `fl-num${n}`, x: s.x, y: BAR_Y + 31, w: s.w, h: 56, html: String(s.min), fontSize: 44, fontFamily: SERIF,
      color: s.ink, align: 'center', valign: 'middle', lineHeight: 1.1, group, fx: { ...fx, countUp: true },
    }),
    text({
      id: `fl-unit${n}`, x: s.x, y: BAR_Y + 89, w: s.w, h: 20, html: 'MIN', fontSize: 11, fontWeight: 700,
      color: s.mute, align: 'center', valign: 'middle', letterSpacing: 1.8, group, fx,
    }),
    text({
      id: `fl-lab${n}`, x: s.x, y: BAR_Y + 117, w: s.w, h: 52, html: s.label, fontSize: 15, fontWeight: 700,
      color: s.ink, align: 'center', valign: 'top', lineHeight: 1.3, placeholder: 'Phase', role: 'body', group, fx,
    }),
  ]
})

const axis = [
  {
    ...base, id: 'fl-axis', type: 'shape', shape: 'line', x: TRACK_X, y: BAR_Y + BAR_H + 34, w: TRACK_W, h: 14,
    fill: C.axis, stroke: 'transparent', strokeWidth: 2, radius: 0, strokeStyle: 'dashed', lineEnd: 'arrow',
    fx: { enter: 'fade', order: PHASES.length + 1, loop: { type: 'dash-march', distance: 18, duration: 1.6 } },
  },
  text({
    id: 'fl-t0', x: TRACK_X, y: BAR_Y + BAR_H + 56, w: 160, h: 24, html: '0:00', fontSize: 12, fontWeight: 700,
    color: C.tick, letterSpacing: 0.6, fx: { enter: 'fade', order: PHASES.length + 1 },
  }),
  text({
    id: 'fl-t1', x: TRACK_X + TRACK_W - 160, y: BAR_Y + BAR_H + 56, w: 160, h: 24, html: clock(total), fontSize: 12,
    fontWeight: 700, color: C.tick, align: 'right', letterSpacing: 0.6, fx: { enter: 'fade', order: PHASES.length + 1 },
  }),
  text({
    id: 'footer', x: 56, y: 658, w: 560, h: 30, html: 'Footer text', fontSize: 14, color: C.muted, valign: 'bottom',
    placeholder: 'Footer text',
  }),
  text({
    id: 'pageno', x: 1032, y: 658, w: 200, h: 30, html: '{{page:2}}', fontSize: 14, color: C.muted, align: 'right',
    valign: 'bottom',
  }),
]

const slide = {
  id: `sl-${PREFIX}agenda`,
  background: '#FFFFFF',
  transition: 'fade',
  hover: { type: 'focus-group', dim: 0.25 },
  elements: [...chrome, ...columns, ...axis],
  notes:
    'The running order, drawn to scale — each block is as wide as its share of the session, ' +
    'so the shape of the hour is visible before a word is read.\n\n' +
    'To change it in the app: click a number or a label and type. Everything else follows — ' +
    'the numbers count up on entry, and hovering a block dims the others (point at where you are).\n\n' +
    'To re-balance the TIME, run scripts/build-flow-slide.mjs with new minutes ' +
    '(--phases "10 Icebreaker, 50 Lecture, 10 Break, 40 Group activity, 10 Synthesis") — ' +
    'the widths recompute proportionally. Dragging a block by hand works too; the widths are just numbers.',
  name: '14 · Session flow',
}

// ——— splice ————————————————————————————————————————————————————————————
const at = doc.slides.findIndex((s) => s.id === slide.id)
if (at >= 0) doc.slides[at] = slide
else doc.slides.push(slide)

doc.layouts ??= []
const layout = { id: `${PREFIX}agenda`, name: slide.name, background: slide.background, transition: slide.transition, hover: slide.hover, notes: slide.notes, elements: slide.elements }
const lat = doc.layouts.findIndex((l) => l.id === layout.id)
if (lat >= 0) doc.layouts[lat] = layout
else doc.layouts.push(layout)

doc.modified = new Date().toISOString()

const json = JSON.stringify(doc).replace(/</g, '\\u003c')
const [, mime, id] = m
// replacer FUNCTION, never a string: `$&` and friends are substitution
// patterns and the embedded assets are full of them.
const out = html.replace(blockRe, () => `<script type="${mime}" id="${id}">\n${json}\n</scr` + 'ipt>')
if (!out.includes(json)) throw new Error('splice failed — document block not found')
backup(file)
writeFileSync(file, out)

console.log(
  `${file} — ${at >= 0 ? 'replaced' : 'added'} "${slide.name}" ` +
  `(${PHASES.length} phases, ${total} min): ${segs.map((s) => `${s.label} ${s.w}px`).join(', ')}`,
)
