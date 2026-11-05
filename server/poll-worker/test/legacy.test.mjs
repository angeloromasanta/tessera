// node test/legacy.test.mjs — decks written before the rename use these names:
// the old request headers and the old model-task tag still work (src/legacy.js).
import assert from 'node:assert/strict'
import { runHandler } from '../src/adapter.js'
import { CORS, vary } from '../src/api/_lib.js'
import lecturer from '../src/api/lecturer.js'
import { aiTasks } from '../src/api/ai.js'
import { adoptLegacyHeaders } from '../src/legacy.js'

// --- headers: the old names reach the handlers under the new ones -----------------
assert.deepEqual(adoptLegacyHeaders({ 'x-bento-player': 'p1' }), { 'x-bento-player': 'p1', 'x-tessera-player': 'p1' })
assert.deepEqual(adoptLegacyHeaders({ 'x-bento-lecturer': 'old', 'x-tessera-lecturer': 'new' })['x-tessera-lecturer'], 'new')   // the new name wins

process.env.LECTURER_PASSWORD = 'test-key-123'
const ask = async (headers) => (await (await runHandler(lecturer, new Request('http://x/api/lecturer', { headers }))).json()).ok
assert.equal(await ask({ 'x-tessera-lecturer': 'test-key-123' }), true)
assert.equal(await ask({ 'x-bento-lecturer': 'test-key-123' }), true)       // a deck from before the rename
assert.equal(await ask({ 'x-bento-lecturer': 'wrong' }), false)
assert.equal(await ask({}), false)
delete process.env.LECTURER_PASSWORD

let seen
await runHandler((req, res) => { seen = req.headers['x-tessera-player']; res.end('') }, new Request('http://x/', { headers: { 'x-bento-player': 'tok12345' } }))
assert.equal(seen, 'tok12345')

// --- CORS and vary list both names ------------------------------------------------
for (const h of ['x-tessera-lecturer', 'x-tessera-player', 'x-bento-lecturer', 'x-bento-player']) {
  assert.match(CORS['access-control-allow-headers'], new RegExp(`\\b${h}\\b`))
}
assert.equal(vary('x-tessera-lecturer'), 'x-tessera-lecturer, x-bento-lecturer')
assert.equal(vary('x-tessera-lecturer', 'x-tessera-player'), 'x-tessera-lecturer, x-tessera-player, x-bento-lecturer, x-bento-player')

// --- the model-task tag under its old id ------------------------------------------
assert.deepEqual(aiTasks('<script type="application/json" id="bento-ai">{"tasks":{"judge":{}}}</script>'), { judge: {} })
assert.deepEqual(aiTasks('<script type="application/json" id="tessera-ai">{"tasks":{"judge":{}}}</script>'), { judge: {} })

console.log('legacy: ok')
