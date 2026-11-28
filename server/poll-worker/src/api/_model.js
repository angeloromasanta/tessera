// The one text call to the model provider (OpenRouter), shared by every route.
//
// Thinking tokens count against `max_tokens`, and a model thinks as long as it
// likes even at effort "low": a 400-token label call (2026-10), a scores call
// (2026-10-08) and a 1,200-token clustering of 47 answers (2026-11-28) all spent
// the whole budget thinking and came back empty, in front of a room. So:
//   - `max` is the budget of the REPLY; the thinking gets REASONING_HEADROOM on
//     top of it, never a share of it;
//   - a reply still empty or cut off (finish "length") is asked once more with
//     reasoning off, which answers in a couple of seconds.
// A caller never passes `reasoning` or `max_tokens` itself: use this.

import { appHeaders } from './_lib.js'

export const REASONING_HEADROOM = 2000
const URL = 'https://openrouter.ai/api/v1/chat/completions'

/** The reply's text: a string or an array of parts. */
const textOf = (content) => (Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : String(content ?? ''))

/**
 * `{model, messages, max, feature, temperature?, label?}` → the reply's text.
 * `feature` names the caller in OpenRouter's attribution headers; `label`
 * starts the error messages ("the model call failed: …", "… returned nothing").
 * A failed HTTP call throws an Error carrying `status`.
 */
export async function chatText({ model, messages, max, feature, temperature, label = 'the model' }) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is not set'), { status: 0 })
  const once = async (think) => {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...appHeaders(feature) },
      body: JSON.stringify({
        model, messages,
        ...(temperature != null ? { temperature } : {}),
        reasoning: think ? { effort: 'low' } : { enabled: false },
        max_tokens: think ? max + REASONING_HEADROOM : max,
      }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok) {
      throw Object.assign(new Error(`${label} call failed: ${payload?.error?.message ?? `HTTP ${r.status}`}`), { status: r.status })
    }
    const choice = payload?.choices?.[0]
    return { text: textOf(choice?.message?.content), cut: choice?.finish_reason === 'length' }
  }
  let reply = await once(true)
  if (!reply.text.trim() || reply.cut) {
    console.warn(`${feature}: reply ${reply.text.trim() ? 'cut off' : 'empty'} with thinking on; asking again without it`)
    const again = await once(false)
    if (again.text.trim()) reply = again
  }
  if (!reply.text.trim()) throw new Error(`${label} returned nothing`)
  return reply.text
}
