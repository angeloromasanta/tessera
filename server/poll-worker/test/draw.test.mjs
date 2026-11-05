// node test/draw.test.mjs  — the prompt game's rules, with the model faked.
import assert from 'node:assert/strict'
import { step, parse, findSlip, SLIPS, askModel, syntaxError } from '../src/api/draw.js'

const CLEAN = 'function draw(ctx, t) { ctx.fillRect(0, 0, 9, 9) }'
const says = (problem) => async ({ prev }) => {
  assert.equal(findSlip(prev), -1, 'the model must never see a planted line')
  return { problem, js: CLEAN }
}
const runs = (js) => { try { new Function(js + ';return draw')()({ fillRect() {} }, 0); return true } catch { return false } }

// One planted error in the whole game, on turn 2 or 3.
for (const coin of [0.1, 0.9]) {
  const rnd = () => coin
  let r = { js: '', state: '' }
  const turns = []
  const send = async (problem) => {
    r = await step({ prompt: 'x', prev: r.js, state: r.state }, says(problem), rnd)
    turns.push((r.broken ? 'B' : r.fixed ? 'F' : '.'))
    assert.equal(runs(r.js), !r.broken)
    return r
  }
  const first = coin < 0.5 ? 2 : 3
  for (let i = 1; i < first; i++) assert.equal((await send(false)).broken, false)
  assert.equal((await send(false)).broken, true)          // the planted error
  assert.equal(r.turn, first)
  const slip1 = findSlip(r.js)
  assert.equal((await send(false)).broken, true)          // a repeated description does not fix it
  assert.equal(findSlip(r.js), slip1)                     // and it is the same error
  assert.equal((await send(true)).fixed, true)            // naming the error does
  for (let i = 0; i < 12; i++) assert.equal((await send(false)).broken, false)   // never a second one
  console.log('coin', coin, turns.join(''))
}

// A repair (the model's own error) is not a turn and never plants.
{
  const rnd = () => 0.1                                  // slip due on turn 2
  let r = await step({ prompt: 'x', prev: '', state: '' }, says(false), rnd)
  assert.equal(r.turn, 1)
  const seen = []
  const model = async (input) => { seen.push(input.repair || ''); return { problem: false, js: CLEAN } }
  r = await step({ prompt: 'x', prev: r.js, state: r.state, repair: 'TypeError: ctx.foo is not a function' }, model, rnd)
  assert.equal(r.turn, 1); assert.equal(r.broken, false)
  assert.equal(seen[0], 'TypeError: ctx.foo is not a function')
  r = await step({ prompt: 'x', prev: r.js, state: r.state }, says(false), rnd)
  assert.equal(r.turn, 2); assert.equal(r.broken, true) // the slip still comes on turn 2
  // a repair while the slip is on keeps it (the phone never asks, but if it does)
  r = await step({ prompt: 'x', prev: r.js, state: r.state, repair: 'too long' }, says(false), rnd)
  assert.equal(r.broken, true); assert.equal(r.turn, 2)
}

// The model call is asked again: an empty reply, a failed call, code that does not compile.
{
  const replies = [
    () => ({ problem: false, js: '' }),
    () => { throw new Error('the model call failed: HTTP 502') },
    () => ({ problem: true, js: 'function draw(ctx, t) { ctx.fillStyle = "x; }' }),
  ]
  let k = 0
  const notes = []
  const call = async (input, retry) => { notes.push(retry); return replies[k++]() }
  const last = await askModel({ prompt: 'x' }, call)    // three bad tries: the code that at least parsed to a function
  assert.equal(k, 3); assert.match(last.js, /fillStyle/)
  await assert.rejects(() => askModel({ prompt: 'x' }, async () => ({ problem: false, js: '' })))   // never a function: an error
  assert.match(notes[1], /no function/)

  k = 0
  const good = [() => ({ problem: false, js: 'function draw(ctx, t) { ctx.fillStyle = "x; }' }), () => ({ problem: false, js: CLEAN })]
  const out = await askModel({ prompt: 'x' }, async (i, retry) => { notes.push(retry); return good[k++]() })
  assert.equal(out.js, CLEAN)
  assert.match(notes.at(-1), /did not compile/)

  // code that never compiles still comes back (the phone repairs it) rather than an error
  const bad = 'function draw(ctx, t) { ctx.fillStyle = "x; }'
  assert.equal((await askModel({ prompt: 'x' }, async () => ({ problem: false, js: bad }))).js, bad)

  // a key problem is not retried
  let n = 0
  await assert.rejects(() => askModel({ prompt: 'x' }, async () => { n++; throw Object.assign(new Error('401'), { final: true }) }))
  assert.equal(n, 1)
}

assert.equal(syntaxError(CLEAN), '')
assert.notEqual(syntaxError('function draw(ctx, t) { ctx.fillStyle = "x; }'), '')
assert.deepEqual(parse('PROBLEM: yes\nfunction draw(ctx,t){}'), { problem: true, js: 'function draw(ctx,t){}' })
assert.deepEqual(parse('PROBLEM: no\n```js\nfunction draw(ctx,t){}\n```'), { problem: false, js: 'function draw(ctx,t){}' })
assert.equal(parse('function draw(ctx,t){ /* PROBLEM: yes */ }').problem, false)
assert.equal(SLIPS.length, 4)
console.log('ok')
