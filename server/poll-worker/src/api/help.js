// POST /api/help  { code, mode, question?, image?, history? }
//   mode "ask"  → { answer }                      a fix for where the student is stuck
//   mode "next" → { ideas: [{title, why, prompt}] x3 }   stretch ideas once they finished
//
// The lab helper: on a hands-on lab slide, each phone carries an AI teaching
// assistant. A student who is stuck types what they see (or photographs the
// screen) and gets one concrete next step; a student who tapped Finished gets
// three ideas that extend the same lab. The model key stays here, as for
// /api/draw and /api/summarize.
//
// What the lab is about never comes from the phone. The published activity
// page (POST /api/poll, presenter-only) carries it in a
// `<script type="application/json" id="lab-context">` tag that make_lab.py
// writes; this route reads it from the stored html. So a phone cannot rewrite
// the helper's brief, and a bucket whose page has no such tag (a quiz, the
// prompt game) gets nothing from this route.
//
// Like /api/draw this is an AUDIENCE route that spends money at the provider,
// so it is gated three ways instead of by the lecturer key (a phone has none):
//
//   · it answers only for a bucket whose activity page was published in the
//     last HELP_OPEN_HOURS AND carries the lab-context tag. Publishing is
//     presenter-only and happens when the slide is entered in present mode, so
//     the route is open only while someone with the key is presenting a lab;
//   · a ceiling of HELP_MAX_PER_DAY calls per bucket per day;
//   · the system prompt is fixed here, the input is capped (question, photo,
//     six turns of history) and so is the reply, so the route is a poor
//     general-purpose model proxy.
//
// The photo is passed to the model and dropped: it is never stored. The route
// keeps no memory; the phone sends the last few turns back as `history`.

import { preflight, json, body, badCode, getPoll, setPoll, appHeaders } from './_lib.js'

const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5'
const OPEN_HOURS = () => Number(process.env.HELP_OPEN_HOURS) || 3
const MAX_PER_DAY = () => Number(process.env.HELP_MAX_PER_DAY) || 3000
export const MAX_QUESTION = 800
export const MAX_IMAGE = 1_600_000
export const MAX_TURNS = 6
export const MAX_TURN_CHARS = 1500
const MAX_ANSWER_CHARS = 2500
const IMAGE_PREFIX = /^data:image\/(jpeg|png|webp);base64,/
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/

export const CLOSED = 'The helper opens when the lab slide is on screen.'

/** Who the helper is and who it talks to: HELP_CONTEXT on the deployment
 *  (name the school, the programme), else this neutral line. */
export const DEFAULT_HELP_CONTEXT = 'You are a patient lab TA for a hands-on AI class. The students are not programmers.'
const helpContext = () => String(process.env.HELP_CONTEXT ?? '').trim() || DEFAULT_HELP_CONTEXT

const SYSTEM = () => `${helpContext()} Right now each of them is working through a lab with an agentic AI tool (Claude Code, Codex, Kiro, Antigravity or something similar) that works in a folder on their own laptop. They reach you from their phone.

The lab they are doing is described below under THE LAB. Use it: the instructions they were given, the prompts they were told to type, and the notes for you about the goal, what success looks like and the usual problems.

Rules that always apply:
- Answer in the language the student writes in.
- Never ask for, repeat or accept a password, an API key or a token. If a photo shows one, tell them first to rotate (replace) that key, because it has been exposed.
- If the problem needs a person (broken hardware, account or licence access, the network or wifi), say: "Raise your hand: a TA will come".
- Stay on the lab and the tool. If they ask for something unrelated, politely decline in one line and bring them back to the lab.`

const ASK = `The student is stuck or has a question.
- Lead with the most likely fix as ONE concrete next step they can do now. Mention a second possibility only if it is quick.
- At most 120 words. Plain words, no jargon they would not know. No headings.
- If a photo is attached, start with one short line saying what you see on the screen, then the fix.
- Put anything they should type (a prompt for their AI tool, a command for the terminal) in a fenced code block, so they can copy it.`

const NEXT = `The student has finished the lab. Suggest three stretch ideas that extend THIS lab:
- each one doable in 5 to 10 minutes with the same tool and the same folder;
- in increasing order of ambition (the first easy, the third the boldest);
- "title": at most 8 words; "why": one sentence on what they would learn or gain; "prompt": exactly what to type into their AI tool, ready to paste, in the student's language.
Reply ONLY with JSON, no prose and no code fence, in this shape:
{"ideas":[{"title":"...","why":"...","prompt":"..."},{"title":"...","why":"...","prompt":"..."},{"title":"...","why":"...","prompt":"..."}]}`

// --- the lab context ------------------------------------------------------------

/** The JSON object inside `<script type="application/json" id="lab-context">`
 *  in a published activity page, or null when there is none (or it does not
 *  parse). make_lab.py escapes every `<` as `<`; JSON.parse undoes that. */
export function labContext(html) {
  const m = String(html ?? '').match(
    /<script\b[^>]*\bid\s*=\s*["']?lab-context["']?[^>]*>([\s\S]*?)<\/script\s*>/i,
  )
  if (!m) return null
  try {
    const o = JSON.parse(m[1])
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** THE LAB, as text for the system prompt. Only the fields the helper needs,
 *  each capped: the page is the presenter's, but the prompt should stay small. */
export function labBrief(lab) {
  const lines = []
  const heading = str(lab?.heading, 80)
  const title = str(lab?.title, 200)
  if (heading || title) lines.push(`Lab: ${[heading, title].filter(Boolean).join(' — ')}`)
  const doIt = str(lab?.do, 600)
  if (doIt) lines.push(`Instruction on screen: ${doIt}`)
  const types = Array.isArray(lab?.types) ? lab.types.slice(0, 3) : []
  for (const t of types) {
    const label = str(Array.isArray(t) ? t[0] : t?.label, 80)
    const prompt = str(Array.isArray(t) ? t[1] : t?.prompt, 1500)
    if (prompt) lines.push(`${label || 'Type this'} (what students were told to type; [..] are placeholders): ${prompt}`)
  }
  const tip = str(lab?.tip, 400)
  if (tip) lines.push(`Closing tip on screen: ${tip}`)
  const minutes = Number(lab?.minutes)
  if (minutes > 0 && minutes < 600) lines.push(`Time allowed: ${Math.round(minutes)} minutes`)
  const ctx = str(lab?.context, 4000)
  if (ctx) lines.push(`Notes for you (never shown to students): ${ctx}`)
  return lines.length ? lines.join('\n') : '(no details were given for this lab)'
}

// --- input ------------------------------------------------------------------------

/** The sanitized request, or `{error}` with a message the phone can show. */
export function clean(b) {
  const mode = b?.mode
  if (mode !== 'ask' && mode !== 'next') return { error: 'Unknown request.' }

  const raw = typeof b.question === 'string' ? b.question.trim() : ''
  if (raw.length > MAX_QUESTION) return { error: `Keep the question under ${MAX_QUESTION} characters.` }

  let image = ''
  if (mode === 'ask' && b.image != null && b.image !== '') {
    const notImage = { error: 'The photo must be a JPEG, PNG or WebP image.' }
    if (typeof b.image !== 'string' || !IMAGE_PREFIX.test(b.image)) return notImage
    if (b.image.length > MAX_IMAGE) return { error: 'The photo is too large. Try again with a smaller one.' }
    if (!IMAGE_RE.test(b.image)) return notImage
    image = b.image
  }
  if (mode === 'ask' && !raw && !image) return { error: 'Type your question or add a photo first.' }

  let history = []
  if (b.history != null) {
    if (!Array.isArray(b.history)) return { error: 'Bad history.' }
    for (const t of b.history.slice(-MAX_TURNS)) {
      if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.text !== 'string') {
        return { error: 'Bad history.' }
      }
      const text = t.text.trim().slice(0, MAX_TURN_CHARS)
      if (text) history.push({ role: t.role, text })
    }
    // A conversation sent to the model starts with the student.
    while (history.length && history[0].role !== 'user') history.shift()
  }

  return { mode, question: raw, image, history }
}

// --- the model's reply --------------------------------------------------------------

/** Exactly three `{title, why, prompt}` from the model's text, which may be
 *  wrapped in a code fence or in prose. Throws when there are fewer than three
 *  well-formed ideas; extra ones are dropped. */
export function parseIdeas(text) {
  let s = String(text ?? '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('{')
  const z = s.lastIndexOf('}')
  if (a < 0 || z <= a) throw new Error('the model returned no ideas')
  let o
  try { o = JSON.parse(s.slice(a, z + 1)) } catch { throw new Error('the model returned ideas that do not parse') }
  const list = Array.isArray(o) ? o : o?.ideas
  if (!Array.isArray(list)) throw new Error('the model returned no ideas')
  const ideas = list
    .map((i) => ({ title: str(i?.title, 120), why: str(i?.why, 400), prompt: str(i?.prompt, 1500) }))
    .filter((i) => i.title && i.why && i.prompt)
  if (ideas.length < 3) throw new Error(`the model returned ${ideas.length} usable ideas, not 3`)
  return ideas.slice(0, 3)
}

// --- the model call -------------------------------------------------------------------

/** OpenRouter chat messages: system (rules + mode + THE LAB), the earlier
 *  turns as text, then the current turn with the photo as an image part. */
export function buildMessages({ mode, question, image, history }, lab) {
  const system = `${SYSTEM()}\n\n${mode === 'next' ? NEXT : ASK}\n\nTHE LAB\n${labBrief(lab)}`
  const messages = [{ role: 'system', content: system }]
  for (const t of history ?? []) messages.push({ role: t.role, content: t.text })

  let text
  if (mode === 'next') {
    text = 'I have finished the lab. What could I try next?'
      + (question ? `\n\nA note from me: ${question}` : '')
  } else {
    text = question || '(No question typed: the photo shows my screen.)'
  }
  const content = [{ type: 'text', text }]
  if (image) content.push({ type: 'image_url', image_url: { url: image } })
  messages.push({ role: 'user', content })
  return messages
}

/** The real provider call: messages in, the reply's text out. */
export async function openRouter(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...appHeaders('lab helper'),
    },
    body: JSON.stringify({
      model: process.env.HELP_MODEL || DEFAULT_MODEL,
      // A student is waiting on a phone: short thinking, short reply.
      reasoning: { effort: 'low' },
      max_tokens: 900,
      messages,
    }),
  })
  const payload = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`the model call failed: ${payload?.error?.message ?? `HTTP ${r.status}`}`)
  const content = payload?.choices?.[0]?.message?.content
  const text = Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : String(content ?? '')
  if (!text.trim()) throw new Error('the model returned nothing')
  return text
}

/**
 * One helper call, with the model passed in so the route can be tested
 * without the network. `chat(messages)` resolves to the reply's text.
 */
export async function askModel(req, lab, chat = openRouter) {
  const text = await chat(buildMessages(req, lab))
  if (req.mode === 'next') return { ideas: parseIdeas(text) }
  return { answer: text.trim().slice(0, MAX_ANSWER_CHARS) }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const b = body(req)
  const code = String(b.code ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })
  const input = clean(b)
  if (input.error) return json(res, 400, { error: input.error })

  try {
    const poll = await getPoll(code)
    const opened = poll?.htmlAt ? Date.parse(poll.htmlAt) : 0
    const lab = poll?.html ? labContext(poll.html) : null
    if (!lab || !(Date.now() - opened < OPEN_HOURS() * 3600_000)) {
      return json(res, 403, { error: CLOSED })
    }

    // Not a transaction: two phones can read the same count. The ceiling is a
    // backstop against a drained key, so being a few calls out does not matter.
    const day = new Date().toISOString().slice(0, 10)
    const used = poll.helpDay === day ? Number(poll.helpCount) || 0 : 0
    if (used >= MAX_PER_DAY()) {
      return json(res, 429, { error: 'The helper has answered enough for today. Raise your hand: a TA will come.' })
    }
    await setPoll(code, { helpDay: day, helpCount: used + 1 })

    return json(res, 200, await askModel(input, lab))
  } catch (e) {
    // The phone shows `error` as is, so it gets a sentence; the detail goes to the log.
    console.error('help:', e)
    return json(res, 502, { error: 'The helper could not answer just now. Try again in a moment, or raise your hand.' })
  }
}
