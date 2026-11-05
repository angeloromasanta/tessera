// POST /api/answer  { code, text, question?, name? }  → { ok: true, count }
//
// Called by the audience join page. `question` is optional and only used to seed
// the poll document the first time somebody answers, so a reopened join page can
// show the question even if the presenter never pre-registered it.
//
// One wire shape for all three question kinds: a multiple-choice pick sends the
// option's own text and a rating sends the number as digits. The tallying lives
// in the deck (slides/src/model.ts), so a question whose options were edited
// after somebody answered still has every answer it collected.

import {
  preflight, json, body, badCode,
  MAX_ANSWER_CHARS, MAX_ANSWERS, MAX_NAME_CHARS,
  getPoll, setPoll, addAnswer, listAnswers,
} from './_lib.js'

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const b = body(req)
  const code = String(b.code ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })

  const text = String(b.text ?? '').trim()
  if (!text) return json(res, 400, { error: 'empty answer' })
  if (text.length > MAX_ANSWER_CHARS) {
    return json(res, 413, { error: `answer too long (max ${MAX_ANSWER_CHARS} characters)` })
  }

  // Optional: only questions with "Ask for a name" turned on send one, and an
  // empty one is stored as no name at all rather than as a blank column.
  const name = String(b.name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_CHARS)

  try {
    // A closed bucket (poll doc `closed: true`) keeps its answers readable but
    // takes no more: set it once a talk is over, so a QR or join link that
    // outlives the room (a deck shared on Moodle) cannot add to the record.
    const poll = await getPoll(code)
    if (poll?.closed) return json(res, 403, { error: 'This question is closed.', closed: true })
    const existing = await listAnswers(code)
    if (existing.length >= MAX_ANSWERS) {
      return json(res, 429, { error: 'this poll is full' })
    }
    await addAnswer(code, text, name || undefined)

    // Seed question/createdAt only when the poll doc is new — never overwrite a
    // question the presenter set from the editor.
    if (!poll?.question && b.question) {
      await setPoll(code, { question: String(b.question).slice(0, 2000), createdAt: new Date().toISOString() })
    } else if (!poll) {
      await setPoll(code, { createdAt: new Date().toISOString() })
    }

    return json(res, 200, { ok: true, count: existing.length + 1 })
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}
