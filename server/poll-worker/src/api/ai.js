// POST /api/ai  {code, task, input, image?, json?, max?}            → {text, json?}   (a phone or a screen)
//               {code, system?, model?, input, image?, json?, max?}  with the lecturer key
//
// One model route for any game (docs/game.md, "/api/ai"): a judge, a hint, a
// generated scenario. The model key stays here, as for /api/help.
//
// What the model is told never comes from a phone. An audience call names a
// `task`, and the task is declared in the activity page the deck published for
// this code (POST /api/poll, presenter-only), in
//   <script type="application/json" id="tessera-ai">{"tasks": {"judge": {"system": "...", "model": "...", "max": 600, "json": false}}}</script>
// So a phone cannot rewrite the brief, and a page with no such tag gets nothing.
// Like /api/help it answers only while that page was published in the last
// AI_OPEN_HOURS (publishing happens when the slide is presented). The lecturer
// key may instead send its own `system` and `model`, with no window.
//
// Both: `input` and the reply are capped, `image` is passed to the model and
// dropped (never stored), and AI_MAX_PER_DAY calls per code per day.

import {
  preflight, json, body, badCode, hasLecturer, getPoll, setPoll,
  GAME_KEY_RE, MAX_AI_INPUT, MAX_AI_SYSTEM, MAX_AI_TOKENS, MAX_AI_IMAGE, appHeaders,
} from './_lib.js'
import { LEGACY_AI_TAG_ID } from '../legacy.js'

export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5'
const DEFAULT_MAX = 600
const MAX_REPLY_CHARS = 20_000
const OPEN_HOURS = () => Number(process.env.AI_OPEN_HOURS) || 3
const MAX_PER_DAY = () => Number(process.env.AI_MAX_PER_DAY) || 2000
const MODEL_RE = /^[A-Za-z0-9._/:-]{1,100}$/
const IMAGE_PREFIX = /^data:image\/(jpeg|png|webp);base64,/
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/
const JSON_RULE = 'Reply with JSON only: no prose before or after it, and no code fence.'

export const CLOSED = 'The AI opens when this activity is on screen.'

const AI_TAG = new RegExp(
  String.raw`<script\b[^>]*\bid\s*=\s*["']?(?:tessera-ai|${LEGACY_AI_TAG_ID})["']?[^>]*>([\s\S]*?)<\/script\s*>`, 'i')

/** The `tasks` object of `<script type="application/json" id="tessera-ai">` (or
 *  the tag's old id, src/legacy.js) in a published activity page, or null. A `<` escaped as < comes back. */
export function aiTasks(html) {
  const m = String(html ?? '').match(AI_TAG)
  if (!m) return null
  try {
    const o = JSON.parse(m[1])
    const t = o?.tasks
    return t && typeof t === 'object' && !Array.isArray(t) ? t : null
  } catch {
    return null
  }
}

/** The reply as JSON, best effort: a code fence or prose around it is dropped.
 *  undefined when nothing in it parses. */
export function parseJson(text) {
  let s = String(text ?? '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  try { return JSON.parse(s) } catch { /* look inside */ }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = s.indexOf(open)
    const z = s.lastIndexOf(close)
    if (a >= 0 && z > a) { try { return JSON.parse(s.slice(a, z + 1)) } catch { /* next */ } }
  }
  return undefined
}

/** The real provider call. `{model, messages, max}` in, the reply's text out. */
export async function openRouterChat({ model, messages, max }) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...appHeaders('game'),
    },
    body: JSON.stringify({ model, reasoning: { effort: 'low' }, max_tokens: max, messages }),
  })
  const payload = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`the model call failed: ${payload?.error?.message ?? `HTTP ${r.status}`}`)
  const content = payload?.choices?.[0]?.message?.content
  const text = Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : String(content ?? '')
  if (!text.trim()) throw new Error('the model returned nothing')
  return text
}

const fail = (status, error, extra) => ({ status, body: { error, ...extra } })
const posInt = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.trunc(Number(v)) : undefined)

/**
 * The whole route without storage or network, so it can be tested:
 * `poll` is the code's poll document (getPoll), `save(patch)` writes the daily
 * counter, `chat({model, messages, max})` resolves to the reply's text.
 * Returns {status, body}.
 */
export async function serve(b, { poll, lecturer = false, now = Date.now(), chat = openRouterChat, save = async () => {} } = {}) {
  // --- what the model is told -------------------------------------------------
  let def = null
  const task = b?.task === undefined || b?.task === null || b?.task === '' ? '' : String(b.task)
  if (task && !GAME_KEY_RE.test(task)) return fail(400, 'bad task name')
  if (!lecturer) {
    if (!task) return fail(400, 'task is required')
    const opened = poll?.htmlAt ? Date.parse(poll.htmlAt) : 0
    const tasks = poll?.html ? aiTasks(poll.html) : null
    if (!tasks || !(now - opened < OPEN_HOURS() * 3600_000)) return fail(403, CLOSED, { closed: true })
    def = tasks[task]
    if (!def || typeof def !== 'object') return fail(400, `this activity declares no AI task "${task}"`)
  } else if (task) {
    const tasks = poll?.html ? aiTasks(poll.html) : null
    def = tasks?.[task] && typeof tasks[task] === 'object' ? tasks[task] : null
    if (!def && b.system == null) return fail(400, `this activity declares no AI task "${task}"`)
  }

  let system = typeof def?.system === 'string' ? def.system.slice(0, MAX_AI_SYSTEM) : ''
  let model = typeof def?.model === 'string' && MODEL_RE.test(def.model) ? def.model : DEFAULT_MODEL
  if (lecturer) {
    if (b.system != null) {
      if (typeof b.system !== 'string') return fail(400, 'system must be text')
      if (b.system.length > MAX_AI_SYSTEM) return fail(413, `system too long (max ${MAX_AI_SYSTEM} characters)`)
      system = b.system
    }
    if (b.model != null) {
      if (typeof b.model !== 'string' || !MODEL_RE.test(b.model)) return fail(400, 'bad model')
      model = b.model
    }
  }

  // --- input --------------------------------------------------------------------
  if (b.input != null && typeof b.input !== 'string') return fail(400, 'input must be text')
  const input = String(b.input ?? '')
  if (input.length > MAX_AI_INPUT) return fail(413, `input too long (max ${MAX_AI_INPUT} characters)`)
  let image = ''
  if (b.image != null && b.image !== '') {
    if (typeof b.image !== 'string' || !IMAGE_PREFIX.test(b.image)) return fail(400, 'The image must be a JPEG, PNG or WebP data URL.')
    if (b.image.length > MAX_AI_IMAGE) return fail(413, 'The image is too large.')
    if (!IMAGE_RE.test(b.image)) return fail(400, 'The image must be a JPEG, PNG or WebP data URL.')
    image = b.image
  }
  if (!input.trim() && !image) return fail(400, 'input is empty')

  const cap = lecturer ? MAX_AI_TOKENS : Math.min(MAX_AI_TOKENS, posInt(def?.max) ?? DEFAULT_MAX)
  const max = Math.min(cap, posInt(b.max) ?? (lecturer ? posInt(def?.max) ?? DEFAULT_MAX : cap))
  const wantJson = !!(b.json ?? def?.json)

  // --- the daily ceiling (not a transaction: a backstop, as in /api/help) --------
  const day = new Date(now).toISOString().slice(0, 10)
  const used = poll?.aiDay === day ? Number(poll.aiCount) || 0 : 0
  if (used >= MAX_PER_DAY()) return fail(429, 'The AI has answered enough for today.')
  await save({ aiDay: day, aiCount: used + 1 })

  // --- the call ---------------------------------------------------------------------
  const sys = [system.trim(), wantJson ? JSON_RULE : ''].filter(Boolean).join('\n\n')
  const content = [{ type: 'text', text: input || '(see the image)' }]
  if (image) content.push({ type: 'image_url', image_url: { url: image } })
  const messages = [...(sys ? [{ role: 'system', content: sys }] : []), { role: 'user', content }]
  let text
  try {
    text = String(await chat({ model, messages, max })).trim().slice(0, MAX_REPLY_CHARS)
  } catch (e) {
    console.error('ai:', e)
    return fail(502, 'The AI could not answer just now. Try again in a moment.')
  }
  const out = { text }
  if (wantJson) {
    const j = parseJson(text)
    if (j !== undefined) out.json = j
  }
  return { status: 200, body: out }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const b = body(req)
  const code = String(b.code ?? req.query.c ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })
  try {
    const r = await serve(b, {
      poll: await getPoll(code),
      lecturer: hasLecturer(req),
      save: (patch) => setPoll(code, patch),
    })
    return json(res, r.status, r.body)
  } catch (e) {
    console.error('ai:', e)
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}
