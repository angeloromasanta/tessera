// POST /api/summarize  { code, question?, prompt?, model? }  → { summary, count, at }
//
// This route exists so the model API key never has to. A deck file is a public,
// shareable artefact — anything the deck can read, anyone it is sent to can read.
// So the deck sends a join code and gets prose back; the key stays here.

import {
  preflight, json, body, badCode, denyLecturer, SUMMARIZE_COOLDOWN_MS,
  getPoll, setPoll, listAnswers, appHeaders,
} from './_lib.js'

/** Default summarizer. Overridable per request (the slide's panel exposes it)
 *  and per deployment (SUMMARY_MODEL), so switching models never means
 *  rebuilding and redistributing the deck. */
const DEFAULT_MODEL = 'anthropic/claude-opus-5'

const SYSTEM = `You summarize live audience responses for a speaker who is on stage right now and will read your output aloud off a slide.

Write for the projector:
- Open with one sentence naming the overall shape of the responses.
- Then 3 to 6 themes, each on its own line as "**Theme** — one sentence, and roughly how many people said it."
- Give at most one short verbatim quote where a participant said something better than a paraphrase would.
- Note any single striking outlier in a final line, if there is one.

Be faithful above all: report what people actually said, including disagreement and things the speaker may not want to hear. Do not invent themes to round the list out, do not smooth over a split opinion into a false consensus, and if the responses are too few or too scattered to have themes, say that plainly instead of manufacturing structure. No preamble, no closing summary, no markdown headings.`

/** Exported so it can be exercised without Firestore in the loop — the model
 *  call and the storage layer fail for completely different reasons and are
 *  much easier to diagnose apart. */
export async function summarize({ question, answers, extra, model }) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')

  // Accept `{text}` records or bare strings, and drop blanks. The failure this
  // guards against is silent and expensive: a mis-shaped list stringifies to
  // "undefined" per line, and the model is then asked to find themes in nothing.
  const texts = answers
    .map((a) => String(typeof a === 'string' ? a : (a?.text ?? '')).trim())
    .filter(Boolean)
  if (!texts.length) throw new Error('no answer text to summarize')

  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const user = [
    question ? `The speaker asked the audience:\n\n${question}` : 'The audience was asked an open question.',
    `\n${texts.length} people responded:\n\n${numbered}`,
    extra ? `\nAdditional instruction from the speaker: ${extra}` : '',
  ].join('\n')

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      // OpenRouter attributes traffic by these; harmless but good manners.
      ...appHeaders('audience polls'),
    },
    body: JSON.stringify({
      model: model || process.env.SUMMARY_MODEL || DEFAULT_MODEL,
      // The speaker is standing in front of a room waiting for this, so cap
      // reasoning depth: theme extraction from short texts does not need deep
      // deliberation, and every extra second is dead air on stage.
      reasoning: { effort: 'low' },
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  })

  const payload = await r.json().catch(() => null)
  if (!r.ok) {
    const detail = payload?.error?.message ?? `HTTP ${r.status}`
    throw new Error(`summarizer failed: ${detail}`)
  }
  const text = payload?.choices?.[0]?.message?.content
  if (!text || !String(text).trim()) throw new Error('summarizer returned nothing')
  return String(text).trim()
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  // Presenter-only: this is the one route that spends money at the provider on
  // every call, so it is the one an open endpoint can be used to drain.
  if (denyLecturer(req, res)) return

  const b = body(req)
  const code = String(b.code ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })

  try {
    const poll = await getPoll(code)

    // Cooldown: a double-clicked button must not spend twice at the provider.
    // Firestore holds the timestamp, so this survives across lambda instances.
    const last = poll?.summarizedAt ? Date.parse(poll.summarizedAt) : 0
    const wait = last + SUMMARIZE_COOLDOWN_MS - Date.now()
    if (wait > 0) {
      return json(res, 429, {
        error: `just summarized — try again in ${Math.ceil(wait / 1000)}s`,
        summary: poll?.summary ?? '',
      })
    }

    const answers = await listAnswers(code)
    if (!answers.length) return json(res, 400, { error: 'no responses yet' })

    const question = String(b.question ?? poll?.question ?? '').slice(0, 2000)
    // Claim the cooldown BEFORE the model call, not after: the call is the slow
    // part, and that window is exactly when an impatient second click lands.
    await setPoll(code, { summarizedAt: new Date().toISOString() })

    const summary = await summarize({
      question,
      answers,
      extra: b.prompt ? String(b.prompt).slice(0, 1000) : '',
      model: b.model ? String(b.model).slice(0, 120) : '',
    })

    const at = new Date().toISOString()
    await setPoll(code, { summary, summaryAt: at, question: question || undefined })
    return json(res, 200, { summary, count: answers.length, at })
  } catch (e) {
    return json(res, 502, { error: String(e?.message ?? e) })
  }
}
