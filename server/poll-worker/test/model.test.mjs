// The shared model call (src/api/_model.js): thinking never eats the reply's
// budget, and an empty or cut-off reply is asked again with reasoning off.
// No network: fetch is stubbed. Run: node test/model.test.mjs
import assert from 'node:assert/strict'
import { chatText, REASONING_HEADROOM } from '../src/api/_model.js'

process.env.OPENROUTER_API_KEY = 'test-key'
const realFetch = globalThis.fetch
let sent = []
const stub = (replies) => {
  sent = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body))
    const r = replies[sent.length - 1]
    return new Response(JSON.stringify(r.body ?? { choices: [{ message: { content: r.content }, finish_reason: r.finish ?? 'stop' }] }),
      { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
}
const ask = () => chatText({ model: 'm', messages: [{ role: 'user', content: 'x' }], max: 1200, feature: 'test' })

// 1. thinking ate the budget (what failed in class): retried without reasoning
stub([{ content: '', finish: 'length' }, { content: '{"trends":[]}' }])
assert.equal(await ask(), '{"trends":[]}')
assert.equal(sent.length, 2)
assert.deepEqual(sent[0].reasoning, { effort: 'low' })
assert.equal(sent[0].max_tokens, 1200 + REASONING_HEADROOM, 'thinking gets headroom over the reply budget')
assert.deepEqual(sent[1].reasoning, { enabled: false })
assert.equal(sent[1].max_tokens, 1200)

// 2. a normal reply: one call
stub([{ content: 'ok' }])
assert.equal(await ask(), 'ok')
assert.equal(sent.length, 1)

// 3. cut off mid-reply: the retry's answer wins when it has text, else the first is kept
stub([{ content: '{"a":', finish: 'length' }, { content: '{"a":1}' }])
assert.equal(await ask(), '{"a":1}')
stub([{ content: '{"a":', finish: 'length' }, { content: '' }])
assert.equal(await ask(), '{"a":')

// 4. empty both times: a clear error; an HTTP failure carries its status
stub([{ content: '' }, { content: '' }])
await assert.rejects(ask(), /returned nothing/)
stub([{ status: 402, body: { error: { message: 'no credits' } } }])
await assert.rejects(ask(), (e) => e.status === 402 && /call failed: no credits/.test(e.message))

globalThis.fetch = realFetch
console.log('model: ok')
