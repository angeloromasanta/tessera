// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// The audience-poll client: the ONE place that knows how a deck talks to the
// poll service. The editor panel (rehearsal) and present mode (live) both go
// through here so there is a single wire contract to keep in step with
// server/poll-app/.
//
// Deliberately tiny and dependency-free: a poll is content, and a deck that
// cannot reach the service must still present its question, its join code, and
// whatever summary was last saved. Every function here throws a message fit to
// show a presenter mid-talk — never a raw stack.

import type { TesseraDoc, PollElement, SlideElement } from './model'
import { lecturerKey, pollConfigured, pollHost, quizScoreOf, quizStats, ratingScale, ratingStats, setLecturerKey, tallyChoices } from './model'
import { buildXlsx, downloadXlsx, type Sheet } from './xlsx'
import { t } from './i18n'
import { isOldWire, lecturerHeaderFor, markOldWire, LEGACY_NAMES_JS } from './legacy'

export interface PollAnswer {
  text: string
  at: string
  /** who said it, when the question asked for a name; absent = anonymous */
  name?: string
}

export interface PollState {
  code: string
  question: string
  count: number
  answers: PollAnswer[]
  summary: string
  summaryAt: string
  /**
   * The service holds answers it will not show us: `count` is real, `answers`
   * is empty, and the difference is a missing lecturer key rather than a quiet
   * room. Surfaces that draw results (live bars, the panel, export) MUST
   * branch on this — "0 answers" and "42 answers you may not read" look
   * identical otherwise, and the second one is a presenter about to tell a
   * room nobody responded.
   */
  answersWithheld?: boolean
}

/** A deck with no service configured has nowhere to send anything. Caught here
 *  rather than at fetch(), where an empty host would build a RELATIVE url and
 *  quietly ask whatever server the file was opened from. */
function assertConfigured(el: PollElement) {
  if (!pollConfigured(el)) throw new Error(t('This deck has no poll service yet.'))
}

async function readError(r: Response): Promise<string> {
  const d = await r.json().catch(() => null)
  return d?.error ? String(d.error) : `HTTP ${r.status}`
}

// --- presenter-only routes ----------------------------------------------------
//
// Four routes on the service can be gated behind a shared LECTURER_PASSWORD:
// publish an activity page, clear responses, point the room at a question, and
// summarize. They are the destructive and the expensive ones; the audience
// routes are open, because the join code is on a projector and that is the
// design. A deployment with no password set gates nothing.

/** A presenter call: `init` with the lecturer key added as a header. The key
 *  is omitted entirely when there isn't one, so an ungated service sees
 *  exactly the request it always saw. A service from before the rename lets
 *  only the old header name through its CORS check, which fails the request
 *  outright: it is asked again under that name, and the name is remembered
 *  for that service (legacy.ts). */
async function presenterFetch(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const key = lecturerKey()
  const go = () => fetch(url, key ? { ...init, headers: { ...init.headers, [lecturerHeaderFor(url)]: key } } : init)
  if (!key || isOldWire(url)) return go()
  try {
    return await go()
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    markOldWire(url)
    try { return await go() } catch { throw e }
  }
}

/**
 * Ask for the key and remember it, then let the caller retry.
 *
 * Runs at most once per failed action: the alternative is a talk that stops
 * dead on a 401 the presenter has no way to answer. Returns false when they
 * dismiss it, and the original error is then shown as normal.
 */
function askForLecturerKey(): boolean {
  const entered = globalThis.prompt?.(
    t('This deck’s poll service needs the lecturer key to run audience questions. Enter it once — it is remembered on this computer and never saved into the deck.'),
    lecturerKey(),
  )
  if (entered == null) return false
  setLecturerKey(entered)
  return !!entered.trim()
}

/** True when the service refused for want of a key. */
function isLocked(r: Response): boolean {
  return r.status === 401
}

/** What the service says about the key this machine is holding. `required`
 *  describes the deployment; `ok` describes us. */
export interface LecturerStatus {
  required: boolean
  ok: boolean
}

/**
 * Ask the service whether it wants a key, and whether ours is good.
 *
 * Returns null when the question cannot be answered — offline, no service
 * configured, an old deployment with no `/api/lecturer` route, or a dead
 * network. Callers MUST treat null as "don't know" and carry on: a deck whose
 * poll service is unreachable still has to present. Nothing here throws, for
 * the same reason.
 */
/**
 * Last verdict, keyed by the two things it depends on. The panel rebuilds on
 * every committed edit — typing a question, flipping a toggle — and without
 * this that would be one request per keystroke at the poll service.
 *
 * Not a TTL cache: the answer changes when the HOST or the KEY changes, and
 * both are in the key. The remaining case is the deployment's own config
 * changing under us, which is what `force` (the Check key button) is for.
 */
let lastCheck: { at: string; status: LecturerStatus } | null = null

export async function checkLecturerKey(service?: string, force = false): Promise<LecturerStatus | null> {
  const host = pollHost(service ? { service } : undefined)
  if (!host) return null
  const at = `${host}\u0000${lecturerKey()}`
  if (!force && lastCheck?.at === at) return lastCheck.status
  try {
    const r = await presenterFetch(`${host}/api/lecturer`, { cache: 'no-store' })
    if (!r.ok) return null
    const d = await r.json()
    const status = { required: !!d.required, ok: !!d.ok }
    lastCheck = { at, status }
    return status
  } catch {
    // Deliberately NOT cached: a failure here means "could not tell", and
    // caching that would keep answering "could not tell" after the network
    // came back.
    return null
  }
}

/**
 * Make sure a key is in hand before a talk that needs one — the preflight.
 *
 * This is the whole answer to "the presenter found out mid-show". The four
 * gated routes each prompt on their own 401, but the one that matters most
 * (steering the room, `POST /api/session`) runs on every slide change and
 * therefore must never prompt — so on a gated deployment a presenter with no
 * key used to get a room whose phones simply never followed along, with no
 * error anywhere. Asking once, before the first slide, costs one dialog and
 * removes that failure entirely.
 *
 * Prompts at most once, and only when the service actually says it needs a
 * key and the one we hold (if any) is wrong. Returns true when it is safe to
 * proceed — INCLUDING when we could not tell (see checkLecturerKey), because
 * refusing to start a presentation over an unreachable poll service would be a
 * far worse failure than the one this guards against.
 */
export async function ensureLecturerKey(service?: string): Promise<boolean> {
  // Forced: this runs once, at the top of a talk, and is the one moment worth
  // asking the service afresh rather than trusting a verdict from whenever the
  // panel last looked.
  const status = await checkLecturerKey(service, true)
  if (!status || !status.required || status.ok) return true
  if (!askForLecturerKey()) return false
  const after = await checkLecturerKey(service, true)
  return !after || after.ok
}

/** A fetch failure from a `file://` page is indistinguishable from a dead
 *  network at the API level, so say the useful thing rather than "Failed to
 *  fetch" — which reads, on stage, like a bug in the deck. */
function netError(e: unknown): Error {
  const msg = String((e as Error)?.message ?? e)
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return new Error(t('Cannot reach the poll service — check the network.'))
  }
  return e instanceof Error ? e : new Error(msg)
}

export async function fetchPoll(el: PollElement, signal?: AbortSignal): Promise<PollState> {
  assertConfigured(el)
  const url = `${pollHost(el)}/api/poll?c=${encodeURIComponent(el.code)}`
  let r: Response
  try {
    // The key rides along on a READ. `answers[]` is presenter-only on a gated
    // deployment (see server/poll-app/api/poll.js) — every phone in the room
    // learns the question code from /api/session, so an ungated answers[] hands
    // every participant the whole bucket, names included. `count` comes back
    // either way, so a deck with no key still shows participation and still
    // renders the question; it just cannot read what people wrote.
    //
    // This runs on the 3s tick, so it must NEVER prompt — askForLecturerKey is
    // for deliberate presses only. A presenter who has not entered a key finds
    // out from the slide (answersWithheld), not from a dialog mid-talk.
    r = await presenterFetch(url, { cache: 'no-store', signal })
  } catch (e) {
    throw netError(e)
  }
  if (!r.ok) throw new Error(await readError(r))
  const d = await r.json()
  return {
    code: String(d.code ?? el.code),
    question: String(d.question ?? ''),
    count: Number(d.count ?? 0),
    answers: Array.isArray(d.answers) ? d.answers : [],
    summary: String(d.summary ?? ''),
    summaryAt: String(d.summaryAt ?? ''),
    answersWithheld: !!d.answersWithheld,
  }
}

/** Ask the service to summarize. The model key lives there, never here — that
 *  is the whole reason the service exists (see server/poll-app/README.md). */
export async function summarizePoll(el: PollElement, signal?: AbortSignal): Promise<string> {
  assertConfigured(el)
  const send = () => presenterFetch(`${pollHost(el)}/api/summarize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: el.code,
      question: el.question,
      prompt: el.prompt,
      model: el.model,
    }),
    signal,
  })
  let r: Response
  try {
    r = await send()
    // A deliberate button press, so it is the right moment to ask for the key.
    if (isLocked(r) && askForLecturerKey()) r = await send()
  } catch (e) {
    throw netError(e)
  }
  if (!r.ok) throw new Error(await readError(r))
  const d = await r.json()
  const summary = String(d.summary ?? '').trim()
  if (!summary) throw new Error(t('The summarizer returned nothing.'))
  return summary
}

/**
 * Delete every answer collected under this question's code, and the images
 * they referenced. Presenter-only and irreversible; the caller confirms first.
 *
 * Lives here rather than in the panel that calls it because this file is meant
 * to be the one place that knows the wire contract — including which routes
 * need the lecturer key.
 */
export async function clearResponses(el: PollElement): Promise<Response> {
  assertConfigured(el)
  const url = `${pollHost(el)}/api/poll?c=${encodeURIComponent(el.code)}`
  const send = () => presenterFetch(url, { method: 'DELETE' })
  try {
    const r = await send()
    if (isLocked(r) && askForLecturerKey()) return await send()
    return r
  } catch (e) {
    throw netError(e)
  }
}

/**
 * Clear every question in the deck: each distinct bucket once (a state slide
 * shares its code with the question it shows), one after another so a 401 asks
 * for the key once rather than once per question. Keeps going past a failure
 * and reports it, so one unreachable bucket does not leave the rest behind.
 */
export async function clearAllResponses(
  doc: TesseraDoc,
): Promise<{ questions: number; cleared: number; failed: Array<{ code: string; err: string }> }> {
  const seen = new Set<string>()
  const out = { questions: 0, cleared: 0, failed: [] as Array<{ code: string; err: string }> }
  for (const { el } of pollsOf(doc)) {
    if (!el.code || seen.has(el.code)) continue
    seen.add(el.code)
    out.questions++
    try {
      const r = await clearResponses(el)
      if (!r.ok) throw new Error(await pollError(r))
      const d = await r.json().catch(() => ({}))
      out.cleared += Number(d.cleared ?? 0)
    } catch (e) {
      out.failed.push({ code: el.code, err: String((e as Error)?.message ?? e) })
    }
  }
  return out
}

/** The service's own error text when it sent one, so a 401 reads as the
 *  instruction it is rather than as "HTTP 401". */
export const pollError = readError

// --- the session: one join code that follows the speaker ----------------------
//
// The audience scans ONE QR for the whole talk and stays on that page. Present
// mode publishes whichever question is on screen; the phones read it back every
// couple of seconds and re-draw. The session holds only a POINTER to a question
// (plus what the phone needs to render it) — answers still go to the question's
// own `code`, which is what keeps summarize, export and clear untouched.

/** Everything a phone needs to draw the question it should be answering. */
export interface ActiveQuestion {
  code: string
  question: string
  kind: 'open' | 'choice' | 'rating' | 'quiz' | 'activity'
  options?: string[]
  /** `choice`: let the phone pick more than one option. See PollElement.multi. */
  multi?: boolean
  min?: number
  max?: number
  minLabel?: string
  maxLabel?: string
  requireName?: boolean
  /** `quiz`: the questions to draw — WITHOUT their right answers. */
  questions?: Array<{ q: string; options: string[] }>
}

export function activeQuestionOf(el: PollElement): ActiveQuestion {
  const kind = el.kind ?? 'open'
  const active: ActiveQuestion = {
    code: el.code,
    question: el.question ?? '',
    kind,
    requireName: !!el.requireName,
  }
  if (kind === 'choice') {
    active.options = (el.options ?? []).filter((o) => o.trim())
    if (el.multi) active.multi = true
  }
  if (kind === 'rating') {
    const { min, max } = ratingScale(el)
    active.min = min
    active.max = max
    if (el.minLabel) active.minLabel = el.minLabel
    if (el.maxLabel) active.maxLabel = el.maxLabel
  }
  // A quiz publishes its questions WITHOUT `correct`. That single omission is
  // what keeps the right answers in the deck — the phone renders the options,
  // sends back the indices it picked, and model.quizStats does the marking.
  if (kind === 'quiz') {
    active.questions = (el.questions ?? [])
      .filter((q) => q.q.trim() && (q.options ?? []).some((o) => o.trim()))
      .map((q) => ({ q: q.q, options: (q.options ?? []).filter((o) => o.trim()) }))
  }
  // `activity` needs nothing beyond code/question/requireName — the page
  // itself, not the session pointer, is what tells the phone what to draw.
  return active
}

/**
 * The phone half of an engagement slide shows the same strings as its screen
 * half (the embed on the poll's slide), and those strings can be reworded on
 * the edit canvas: the overrides live on the embed (`EmbedElement.texts`,
 * EMBED_TEXT_BRIDGE in render.ts), never in either page. So the activity page
 * is published with them in front of it, as `TESSERA_EMBED.texts` plus the same
 * `TESSERA_EMBED.text(KEY, default)` reader the screen gets — the phone host
 * gives a page no preamble of its own. No overrides: the page goes unchanged.
 * Over the service's size limit: unchanged too, since old wording on the
 * phones beats a room full of "not ready yet".
 */
const MAX_ACTIVITY_HTML_CHARS = 60_000 // server/poll-worker/src/api/_lib.js
export function activityPageWithTexts(doc: Pick<TesseraDoc, 'slides'>, el: PollElement, html: string): string {
  let slide = doc.slides.find((s) => s.elements.includes(el))
  if (!slide && el.code) slide = doc.slides.find((s) => s.elements.some((e) => e.type === 'poll' && e.id === el.id && (e as PollElement).code === el.code))
  if (!slide) return html
  const texts: Record<string, string> = {}
  for (const e of slide.elements) {
    if (e.type !== 'embed' || !e.texts) continue
    for (const [k, v] of Object.entries(e.texts)) if (typeof v === 'string') texts[k] = v
  }
  if (!Object.keys(texts).length) return html
  // Every `<` escaped: the values are free text and must never close the tag.
  const json = JSON.stringify(texts).replace(/</g, '\\u003c')
  // The old names first (legacy-names.js), for a page written before the rename.
  const init = `<script>${LEGACY_NAMES_JS}<\/script>` +
    `<script>(function(){var E=window.TESSERA_EMBED=Object.assign(window.TESSERA_EMBED||{},{texts:${json}});` +
    `if(typeof E.text!=='function')E.text=function(k,d){return Object.prototype.hasOwnProperty.call(E.texts,k)?E.texts[k]:d};})()<\/script>`
  const out = init + html
  return out.length > MAX_ACTIVITY_HTML_CHARS ? html : out
}

/**
 * Push an `activity` poll's self-contained page to the service, once, so a
 * phone joining after this point can fetch it. Called on first mount of the
 * slide (present.ts), never on the 3s poll timer — the page does not change
 * while a talk is running, so there is nothing to keep publishing.
 */
export async function publishActivityHtml(el: PollElement, html: string): Promise<void> {
  assertConfigured(el)
  if (!html.trim()) return
  const send = () => presenterFetch(`${pollHost(el)}/api/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: el.code, html }),
  })
  let r: Response
  try {
    r = await send()
    // This one fires on entering the slide, not on a press — but an activity
    // that never publishes is a room full of "not ready yet", so it is worth
    // the one interruption rather than a silent dead end.
    if (isLocked(r) && askForLecturerKey()) r = await send()
  } catch (e) {
    throw netError(e)
  }
  if (!r.ok) throw new Error(await readError(r))
}

/**
 * Register the deck's join code with the service WITHOUT touching what the
 * room is on. A minted code (`s…`) is recognisable on sight; a name the
 * lecturer chose is a session only once the service has heard of it — so this
 * runs when the name is set and at the top of every show. `existed` tells the
 * panel the name was already in use (this deck earlier, or someone else's).
 * `force` is a deliberate press: it may prompt for the key and it throws.
 */
export async function claimSession(
  code: string,
  opts: { force?: boolean; el?: Pick<PollElement, 'service'> } = {},
): Promise<{ ok: boolean; existed?: boolean }> {
  const host = pollHost(opts.el)
  if (!host) {
    if (opts.force) throw new Error(t('This deck has no poll service yet.'))
    return { ok: false }
  }
  try {
    const send = () => presenterFetch(`${host}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ s: code, claim: true }),
    })
    let r = await send()
    if (isLocked(r) && opts.force && askForLecturerKey()) r = await send()
    if (!r.ok) throw new Error(await readError(r))
    const d = await r.json() as { existed?: boolean }
    return { ok: true, existed: !!d.existed }
  } catch (e) {
    if (opts.force) throw netError(e)
    return { ok: false }
  }
}

/** Signature of the last publish that landed, so a talk's forty non-question
 *  slides don't send forty identical "nothing is being asked" requests. */
let lastPublished = ''

/**
 * Point the session at a question — or, with `active` null, at nothing (the
 * speaker has moved on to an ordinary slide, and the room should be told to
 * look up rather than left staring at a question that is no longer on screen).
 *
 * Best-effort and silent by design: this runs on every slide change of a live
 * talk, and a failed publish must never interrupt the show. The slide's own
 * count keeps ticking from `fetchPoll`, which surfaces network trouble already.
 */
export async function publishActive(
  doc: TesseraDoc,
  el: PollElement | null,
  opts: { service?: string; force?: boolean } = {},
): Promise<boolean> {
  const session = doc.poll?.session
  if (!session) return false
  const active = el ? activeQuestionOf(el) : null
  // Every slide change calls this, and most slides of a talk are not questions.
  // Publishing "nothing" forty times in a row is forty requests that change
  // nothing, so only actual transitions go out.
  const sig = `${session}:${JSON.stringify(active)}`
  if (!opts.force && sig === lastPublished) return true
  lastPublished = sig
  const host = pollHost(el ?? (opts.service ? { service: opts.service } : undefined))
  if (!host) {
    lastPublished = ''
    if (opts.force) throw new Error(t('This deck has no poll service yet.'))
    return false
  }
  try {
    const send = () => presenterFetch(`${host}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // keepalive: the last publish of a talk fires as the overlay tears down,
      // and an in-flight fetch from a page that is navigating away is dropped.
      keepalive: true,
      body: JSON.stringify({ s: session, active }),
    })
    let r = await send()
    // Only a deliberate press may interrupt with a prompt. Mid-talk this runs
    // on EVERY slide change, and a dialog per slide would be unusable — the
    // presenter is told once, when they press something, and after that the
    // stored key makes the rest of the talk work.
    if (isLocked(r) && opts.force && askForLecturerKey()) r = await send()
    if (!r.ok) throw new Error(await readError(r))
    return true
  } catch (e) {
    // A publish that never landed must be retried on the next slide change
    // rather than deduped away as "already sent".
    lastPublished = ''
    // Mid-talk this is silent — the show goes on, and the slide's own counter
    // already reports network trouble. A deliberate press says so out loud.
    if (opts.force) throw netError(e)
    return false
  }
}

// --- spreadsheet export -------------------------------------------------------

/** Every poll in the deck, in slide order, with the slide number it sits on. */
export function pollsOf(doc: TesseraDoc): Array<{ el: PollElement; slide: number }> {
  const out: Array<{ el: PollElement; slide: number }> = []
  doc.slides.forEach((slide, i) => {
    for (const el of slide.elements as SlideElement[]) {
      if (el.type === 'poll') out.push({ el, slide: i + 1 })
    }
  })
  return out
}

const KIND_LABEL = {
  open: 'Open text', choice: 'Multiple choice', rating: 'Rating',
  quiz: 'Quiz', activity: 'Activity',
} as const

/**
 * Download every question's responses as one workbook: an overview sheet with
 * the tallies, then one sheet per question with the individual answers.
 *
 * Fetches answers live rather than using whatever the slide last showed — an
 * export is a record, and a record built from a three-second-old cache of one
 * slide is a record of the wrong thing. Questions that fail to load are
 * reported rather than silently skipped, because a missing sheet in a
 * spreadsheet someone is about to grade from is the worst outcome here.
 */
export async function exportPollsXlsx(
  doc: TesseraDoc,
  opts: { onlyCode?: string } = {},
): Promise<{ questions: number; answers: number; failed: string[]; withheld: string[] }> {
  const polls = pollsOf(doc).filter((p) => !opts.onlyCode || p.el.code === opts.onlyCode)
  if (!polls.length) throw new Error(t('This deck has no audience questions.'))

  const failed: string[] = []
  const loaded = await Promise.all(polls.map(async (p) => {
    try {
      return { ...p, state: await fetchPoll(p.el) }
    } catch {
      failed.push(p.el.code)
      return { ...p, state: null as PollState | null }
    }
  }))

  // Buckets the service would not let us read. Reported SEPARATELY from
  // `failed` and never silently: the export is the one place a named quiz's
  // roster is meant to arrive, and a spreadsheet that is empty because of a
  // missing key looks exactly like a spreadsheet that is empty because nobody
  // answered. A presenter must not be allowed to conclude the second.
  const withheld = loaded.filter((p) => p.state?.answersWithheld).map((p) => p.el.code)

  const anyNames = loaded.some((p) => p.state?.answers.some((a) => a.name))

  const overview: Sheet = {
    name: 'Overview',
    widths: [8, 60, 16, 12, 12, 14, 40],
    rows: [['Slide', 'Question', 'Type', 'Code', 'Responses', 'Average', 'Result']],
  }

  const sheets: Sheet[] = [overview]

  loaded.forEach((p, i) => {
    const kind = p.el.kind ?? 'open'
    const answers = p.state?.answers ?? []
    let average: number | null = null
    let result = ''

    if (kind === 'choice') {
      const { rows, other, total } = tallyChoices(p.el, answers)
      result = rows
        .map((r) => `${r.label}: ${r.count}${total ? ` (${Math.round((r.count / total) * 100)}%)` : ''}`)
        .concat(other ? [`${t('Other')}: ${other}`] : [])
        .join('; ')
    } else if (kind === 'rating') {
      const stats = ratingStats(p.el, answers)
      average = stats.count ? Math.round(stats.average * 100) / 100 : null
      result = stats.rows.map((r) => `${r.value}: ${r.count}`).join('; ')
    } else if (kind === 'quiz') {
      const stats = quizStats(p.el, answers)
      average = stats.count ? Math.round(stats.average * 100) / 100 : null
      result = stats.rows.map((r) => `${r.score}/${stats.total}: ${r.count}`).join('; ')
    } else if (p.el.summary) {
      result = p.el.summary
    }

    overview.rows.push([
      p.slide,
      p.el.question ?? '',
      t(KIND_LABEL[kind]),
      p.el.code,
      answers.length,
      average,
      p.state ? result : t('could not be loaded'),
    ])

    // One sheet per question. The question text sits above the table rather
    // than in a column: it is the same for every row, and it is the first
    // thing anyone opening the tab needs to read.
    const header: Array<string> = ['#', 'Time']
    if (anyNames) header.push('Name')
    header.push('Answer')
    if (kind === 'rating') header.push('Value')
    // A quiz's raw answer is a JSON pick list nobody wants to read; the mark
    // is the point, so it gets its own column.
    if (kind === 'quiz') header.push('Score')

    const rows: Sheet['rows'] = [
      [`${t('Q{n}', { n: i + 1 })} · ${p.el.question ?? ''}`],
      [t('Join code'), p.el.code, t('Responses'), answers.length],
      [],
      header.map((h) => t(h)),
    ]
    answers.forEach((a, n) => {
      const row: Sheet['rows'][number] = [n + 1, a.at ?? '']
      if (anyNames) row.push(a.name ?? '')
      row.push(a.text ?? '')
      if (kind === 'quiz') row.push(quizScoreOf(p.el, a.text ?? ''))
      if (kind === 'rating') {
        // Same guard as ratingStats: Number('') is 0, and a blank answer is
        // not a rating of zero — it must leave the cell empty.
        const raw = String(a.text ?? '').trim().replace(',', '.')
        const v = Number(raw)
        row.push(raw && Number.isFinite(v) ? v : null)
      }
      rows.push(row)
    })

    sheets.push({
      name: `Q${i + 1} ${(p.el.question ?? '').replace(/\s+/g, ' ').slice(0, 24)}`.trim(),
      rows,
      widths: anyNames ? [5, 22, 22, 70, 10] : [5, 22, 70, 10],
    })
  })

  const answersTotal = loaded.reduce((n, p) => n + (p.state?.answers.length ?? 0), 0)
  const stamp = new Date().toISOString().slice(0, 10)
  const base = (doc.title || 'deck').replace(/[^\w\- ]+/g, '').trim() || 'deck'
  downloadXlsx(buildXlsx(sheets), `${base} — responses ${stamp}.xlsx`)

  return { questions: polls.length, answers: answersTotal, failed, withheld }
}
