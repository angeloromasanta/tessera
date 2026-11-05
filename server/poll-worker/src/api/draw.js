// POST /api/draw  { code, prompt, prev?, state?, repair? }  → { js, state, broken, fixed, turn }
//
// The prompt game: an activity page on a phone sends what the student typed,
// and gets back the source of ONE function, `draw(ctx, t)`, that the page runs
// on a 320x180 canvas. The student never sees the code; they look at what came
// back and say what to fix. The model key stays here, as for /api/summarize.
//
// This is the only AUDIENCE route that spends money at the provider, so it is
// gated three ways instead of by the lecturer key (a phone has none):
//
//   · it answers only for a bucket whose activity page was published in the
//     last DRAW_OPEN_HOURS. Publishing (POST /api/poll) is presenter-only and
//     happens when the slide is entered in present mode, so the route is open
//     only while someone with the key is presenting that slide;
//   · a ceiling of DRAW_MAX_PER_DAY calls per bucket per day;
//   · the system prompt is fixed here and the reply is capped, so the route is
//     a poor general-purpose model proxy.
//
// ONE reply is broken ON PURPOSE (the point of the exercise is that you fix
// things by telling the AI what you see):
//
//   · the second or the third reply, at random, gets one bad line added after
//     the model wrote it: a call that does not exist, or a string that is not
//     closed. It is the only planted error of the whole game;
//   · the bad line STAYS until the student says that something is broken. The
//     model never sees it: it is taken out before the call and put back after,
//     unless the model judged that the student's message says what the error
//     is, at least roughly (first line of its reply, `PROBLEM: yes`; it is
//     told the message the phone shows, not the line). "There is an error"
//     alone is not enough. So repeating the description,
//     or asking for something else, changes the drawing but not the error;
//
// Every OTHER error is the model's own, and the student should never have to
// deal with it:
//
//   · a failed or empty model call is retried (up to MAX_TRIES, within
//     DEADLINE_MS), and a reply whose code does not compile goes back to the
//     model with the parser's message before the phone sees it;
//   · `repair` is the phone saying the code it got throws when it runs (or is
//     too long): the model fixes that, the turn does not count, and nothing is
//     planted on it.
//
// The route keeps no memory. What it needs between turns travels in `state`,
// an opaque string the phone hands back unchanged.

import { preflight, json, body, badCode, getPoll, setPoll, appHeaders } from './_lib.js'

const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5'
const OPEN_HOURS = () => Number(process.env.DRAW_OPEN_HOURS) || 3
const MAX_PER_DAY = () => Number(process.env.DRAW_MAX_PER_DAY) || 2000
const MAX_PROMPT = 600
const MAX_PREV = 4000
const MAX_REPAIR = 300
const MAX_TRIES = 3
const DEADLINE_MS = 40_000

const SYSTEM = `You write one JavaScript function for a classroom exercise. A student describes an animation in words; you draw it. On later turns the student tells you what is wrong and you change the code.

Your reply has exactly two parts and nothing else.

Part 1, one line: "PROBLEM: yes" or "PROBLEM: no".
Sometimes a note tells you which error message the student's screen is showing. Say yes only if the student's message identifies THAT error at least roughly: it quotes the message or a part of it, names the thing the message is about, or says what kind of error it is in their own words (for example "it says something is not a function", "drawCircle does not exist", "a syntax error", "unexpected token", "a quote is not closed"). Exact wording is not needed. Say no if they only say that there is an error, that it is broken, that it does not work or that nothing shows, without anything about what the error is. Say no for a first description, a repeated description, or a request to change how the animation looks or moves. With no note, say no.
The error in the note is handled outside your code and is not in the code you are given: never add, remove or change anything because of it. Use the note only for Part 1.

Part 2, the source of one function, no markdown fences, no comments, no explanation:

function draw(ctx, t) { ... }

Rules for the function:
- ctx is a 2D canvas context of 320 by 180 pixels, already cleared to white before every call.
- t goes from 0 to 1 over 6 seconds and then starts again, so the animation must loop cleanly.
- Use only ctx and Math. No DOM, no images, no fonts, no timers, no globals, no state between calls.
- No loops that could run long. Keep the whole function under 1,700 characters.
- Follow the student's description as literally as you can. Where they did not say something, choose something simple.
- If the student reports something that looks wrong, fix exactly that and keep the rest.`

/** Split the model's reply into its verdict and the function. */
export function parse(text) {
  let s = String(text ?? '').trim()
  const at0 = s.indexOf('function draw')
  const head = at0 < 0 ? s : s.slice(0, at0)
  const problem = /PROBLEM:\s*yes/i.test(head)
  const fence = s.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const at = s.indexOf('function draw')
  return { problem, js: at < 0 ? '' : s.slice(at).trim() }
}

/** The planted slips: each is one line that is wrong as CODE, not as a drawing.
 *  The first two fail when the function runs ("... is not a function"), the
 *  last two stop it from being read at all (a SyntaxError). */
export const SLIPS = [
  'ctx.drawCircle(160, 90, 40);',
  'ctx.setColor("navy");',
  'ctx.fillStyle = "#214A9F;',
  "ctx.strokeStyle = 'it's blue';",
]

/** What the phone shows for each slip, in the words of the common browsers,
 *  for the model to compare the student's message with. */
export const SHOWN = [
  'TypeError: ctx.drawCircle is not a function (a command that does not exist: drawCircle)',
  'TypeError: ctx.setColor is not a function (a command that does not exist: setColor)',
  'SyntaxError: Invalid or unexpected token, in some browsers "Unexpected EOF" (a syntax error: a string whose quote is never closed)',
  'SyntaxError: Unexpected identifier "s" (a syntax error: a quote inside a string that was not escaped)',
]

/** Add one slip as the first line of the function body. */
export function breakIt(js, pick) {
  const open = js.indexOf('{')
  if (open < 0) return js
  return js.slice(0, open + 1) + '\n  ' + SLIPS[pick % SLIPS.length] + js.slice(open + 1)
}

/** Which slip a piece of code carries (-1: none), and the code without it. */
export function findSlip(js) {
  return SLIPS.findIndex((s) => String(js).includes(s))
}
export function unbreak(js, pick) {
  const s = SLIPS[pick]
  return String(js).split('\n  ' + s).join('').split(s).join('')
}

// --- the state the phone carries ----------------------------------------------
//
//   n       turns answered so far
//   a       the turn that gets the slip (2 or 3)
//   p1      which slip was used (-1: not yet)
//   solved  1 once the student has got it fixed

export function readState(s, rnd = Math.random) {
  try {
    const o = JSON.parse(Buffer.from(String(s || ''), 'base64').toString('utf8'))
    if (o && Number.isInteger(o.n) && o.n >= 0 && o.n < 500) {
      return { n: o.n, a: o.a === 3 ? 3 : 2, p1: Number.isInteger(o.p1) ? o.p1 : -1, solved: o.solved | 0 }
    }
  } catch { /* a fresh game */ }
  return { n: 0, a: rnd() < 0.5 ? 2 : 3, p1: -1, solved: 0 }
}
export const writeState = (st) => Buffer.from(JSON.stringify(st), 'utf8').toString('base64')

/**
 * One turn, with the model passed in so the rules can be tested without it.
 * `model({prompt, prev})` resolves to `{problem, js}`.
 */
export async function step({ prompt, prev, state, repair }, model, rnd = Math.random) {
  const st = readState(state, rnd)
  const had = findSlip(prev)
  const clean = had >= 0 ? unbreak(prev, had) : prev
  if (repair) {                                  // the model's own error: fixed, no turn, no slip
    const out = await model({ prompt, prev: clean, repair })
    const js = had >= 0 ? breakIt(out.js, had) : out.js
    return { js, state: writeState(st), broken: had >= 0, fixed: false, turn: st.n }
  }
  const turn = st.n + 1
  const out = await model({ prompt, prev: clean, shown: had >= 0 ? SHOWN[had] : '' })
  let js = out.js
  let broken = false
  let fixed = false
  if (had >= 0) {
    if (out.problem) {
      fixed = true
      st.solved += 1
    } else {
      js = breakIt(js, had)
      broken = true
    }
  } else if (st.p1 < 0 && turn >= st.a) {
    st.p1 = Math.floor(rnd() * SLIPS.length) % SLIPS.length
    js = breakIt(js, st.p1)
    broken = true
  }
  st.n = turn
  return { js, state: writeState(st), broken, fixed, turn }
}

/** The parser's complaint about a piece of code, or '' when it compiles.
 *  Where the runtime forbids compiling strings (Workers), nothing is said. */
export function syntaxError(js) {
  try { new Function(js + '\n;return typeof draw') } catch (e) {
    return e instanceof SyntaxError ? String(e.message || e) : ''
  }
  return ''
}

function userMessage({ prompt, prev, shown, repair }, retry) {
  let user
  if (repair) {
    user = `The current code:\n\n${prev}\n\nIt does not work: ${repair}\n\nFix exactly that so the function runs without errors, keep the drawing the same, and keep it under 1,700 characters. Part 1 is "PROBLEM: no".`
  } else {
    user = (prev
      ? `The current code:\n\n${prev}\n\nThe student now says:\n\n${prompt}`
      : `The student describes the animation:\n\n${prompt}`)
      + (shown ? `\n\nNote: the student's screen is showing this error message: ${shown}` : '')
  }
  return retry ? `${user}\n\n${retry}` : user
}

async function callOnce(input, retry) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is not set'), { final: true })
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...appHeaders('prompt game'),
    },
    body: JSON.stringify({
      model: process.env.DRAW_MODEL || DEFAULT_MODEL,
      // A room is waiting on a phone: short thinking. The cap leaves room for
      // the thinking AND the function (thinking could eat a 1,400 cap whole).
      reasoning: { effort: 'low' },
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMessage(input, retry) },
      ],
    }),
  })
  const payload = await r.json().catch(() => null)
  if (!r.ok) {
    const e = new Error(`the model call failed: ${payload?.error?.message ?? `HTTP ${r.status}`}`)
    if (r.status === 401 || r.status === 402 || r.status === 403) e.final = true
    throw e
  }
  return parse(payload?.choices?.[0]?.message?.content)
}

/** One drawing from the model, asked again until it is a function that compiles. */
export async function askModel(input, call = callOnce, now = Date.now) {
  const t0 = now()
  let retry = '', last = null, fallback = null
  for (let k = 0; k < MAX_TRIES; k++) {
    if (k && now() - t0 > DEADLINE_MS) break
    try {
      const out = await call(input, retry)
      if (!out.js) {
        retry = 'Your last reply had no function. Reply with the PROBLEM line, then the function, starting exactly with: function draw(ctx, t) {'
        last = new Error('the model returned no drawing')
        continue
      }
      const bad = syntaxError(out.js)
      if (!bad) return out
      fallback = fallback || out
      retry = `Your last function did not compile (${bad}). Write it again as valid JavaScript.`
      last = new Error('the model wrote code that does not compile')
    } catch (e) {
      if (e.final) throw e
      last = e
    }
  }
  if (fallback) return fallback                  // the phone repairs what is left
  throw last || new Error('the model returned no drawing')
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const b = body(req)
  const code = String(b.code ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })
  const prompt = String(b.prompt ?? '').trim().slice(0, MAX_PROMPT)
  if (!prompt) return json(res, 400, { error: 'Type what you want to see first.' })
  const prev = String(b.prev ?? '').slice(0, MAX_PREV)
  const state = String(b.state ?? '').slice(0, 400)
  const repair = String(b.repair ?? '').trim().slice(0, MAX_REPAIR)

  try {
    const poll = await getPoll(code)
    const opened = poll?.htmlAt ? Date.parse(poll.htmlAt) : 0
    if (!poll?.html || !(Date.now() - opened < OPEN_HOURS() * 3600_000)) {
      return json(res, 403, { error: 'This game is not open right now. It opens when the slide is on screen.' })
    }

    // Not a transaction: two phones can read the same count. The ceiling is a
    // backstop against a drained key, so being a few calls out does not matter.
    const day = new Date().toISOString().slice(0, 10)
    const used = poll.drawDay === day ? Number(poll.drawCount) || 0 : 0
    if (used >= MAX_PER_DAY()) {
      return json(res, 429, { error: 'The game has drawn enough for today. Ask the lecturer.' })
    }
    await setPoll(code, { drawDay: day, drawCount: used + 1 })

    return json(res, 200, await step({ prompt, prev, state, repair }, askModel))
  } catch (e) {
    return json(res, 502, { error: String(e?.message ?? e) })
  }
}
