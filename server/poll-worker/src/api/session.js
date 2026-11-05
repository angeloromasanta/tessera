// GET  /api/session?s=CODE  → { session, active|null, at }
// POST /api/session  { s, active|null }  → { ok: true }
//
// One join code for a whole talk. The presenting deck POSTs the question that
// is on screen; the audience's phones GET this every couple of seconds and
// re-draw. That is the whole "follow the speaker" mechanism — deliberately a
// pointer and a poll (in the HTTP sense), not a socket: a lecture hall of
// phones on hotel wifi reconnecting to a WebSocket is a worse failure mode
// than a request that quietly retries two seconds later.
//
// WHO MAY WRITE: the presenter. This is the one route where a griefer's effect
// is visible to everyone at once — it decides what every phone in the room is
// looking at — so when LECTURER_PASSWORD is configured, POST needs it. GET
// stays open: the phones poll it constantly and have no key.
//
// It is capped hard regardless: a small payload, a known shape, nothing stored
// that is not echoed straight back.

import { preflight, json, body, badCode, badSession, denyLecturer, getPoll, getSession, getSessionCached, setSession } from './_lib.js'

/** Options a phone can reasonably render as buttons. Beyond this it is a list
 *  nobody reads from row 12 of a lecture hall. */
const MAX_OPTIONS = 10
/** Questions in one quiz. A quiz is answered in a single sitting while a room
 *  waits, so this is a generous ceiling, not a target. */
const MAX_QUESTIONS = 20

/** Keep only the fields a join page draws, at sizes it can draw. Everything
 *  else the deck might send (prompts, model slugs, service URLs) is dropped —
 *  the session is a display instruction, not a copy of the element. */
function clean(active) {
  if (!active || typeof active !== 'object') return null
  const code = String(active.code ?? '').trim().toLowerCase()
  if (badCode(code)) return null

  const kind = ['open', 'choice', 'rating', 'quiz', 'activity'].includes(active.kind) ? active.kind : 'open'
  const out = {
    code,
    kind,
    question: String(active.question ?? '').slice(0, 2000),
    requireName: !!active.requireName,
  }

  if (kind === 'choice') {
    out.options = (Array.isArray(active.options) ? active.options : [])
      .map((o) => String(o ?? '').slice(0, 200))
      .filter((o) => o.trim())
      .slice(0, MAX_OPTIONS)
  }
  // A quiz arrives WITHOUT its right answers — the deck keeps those and marks
  // the picks itself (slides/src/model.ts quizStats). Nothing here knows, or
  // needs to know, which option was correct, so nothing here can leak it.
  if (kind === 'quiz') {
    out.questions = (Array.isArray(active.questions) ? active.questions : [])
      .slice(0, MAX_QUESTIONS)
      .map((q) => ({
        q: String(q?.q ?? '').slice(0, 2000),
        options: (Array.isArray(q?.options) ? q.options : [])
          .map((o) => String(o ?? '').slice(0, 200))
          .filter((o) => o.trim())
          .slice(0, MAX_OPTIONS),
      }))
      .filter((q) => q.q.trim() && q.options.length)
  }
  if (kind === 'rating') {
    const min = Number.isFinite(Number(active.min)) ? Math.round(Number(active.min)) : 1
    const max = Number.isFinite(Number(active.max)) ? Math.round(Number(active.max)) : 5
    out.min = min
    // A scale has to fit on a phone and has to run upwards; 11 steps covers
    // 0–10 (NPS) which is the widest anyone actually asks for.
    out.max = max > min ? Math.min(max, min + 10) : min + 4
    if (active.minLabel) out.minLabel = String(active.minLabel).slice(0, 120)
    if (active.maxLabel) out.maxLabel = String(active.maxLabel).slice(0, 120)
  }
  return out
}

export default async function handler(req, res) {
  if (preflight(req, res)) return

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const session = String(req.query.s ?? '').trim().toLowerCase()
      if (badSession(session)) return json(res, 400, { error: 'bad code' })
      // Cached for 2 s per instance: every phone in the room polls this, and
      // they all want the same answer (see _lib.js getSessionCached).
      const state = await getSessionCached(session)
      // No HTTP caching: this route exists to be fresh, and it is polled.
      res.setHeader('cache-control', 'no-store')
      // A session nobody has published to yet is not an error — it is the
      // normal state of a room that arrived before the speaker started.
      // `exists`: a join code no longer has to start with `s`, so the join
      // page asks whether the code it was handed is a session at all.
      return json(res, 200, { session, exists: !!state, active: state?.active ?? null, at: state?.at ?? '' })
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (denyLecturer(req, res)) return

    const b = body(req)
    const session = String(b.s ?? '').trim().toLowerCase()
    if (badSession(session)) return json(res, 400, { error: 'bad code' })

    // `claim`: the deck registers its join code — when the lecturer names it,
    // and at the top of a show — without touching what the room is on. It is
    // what makes a hand-picked name a session before anything is asked.
    if (b.claim) {
      const state = await getSession(session)
      if (state) return json(res, 200, { ok: true, existed: true })
      // A name that is already an answer bucket would send the room to that
      // one question for ever.
      if (!badCode(session) && await getPoll(session)) {
        return json(res, 409, { error: 'That name is already the code of a question. Pick another.' })
      }
      await setSession(session, null)
      return json(res, 200, { ok: true, existed: false })
    }

    // Anti-abuse ceiling only — `clean` is what actually bounds every field.
    // Roomy enough for a whole quiz's questions and options.
    if (JSON.stringify(b.active ?? null).length > 64_000) {
      return json(res, 413, { error: 'question payload too large' })
    }

    const active = clean(b.active)
    await setSession(session, active)
    return json(res, 200, { ok: true, active })
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}
