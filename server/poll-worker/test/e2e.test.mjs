// node test/e2e.test.mjs  — the whole service against a local `wrangler dev`.
// Starts wrangler on a free port, runs every storage route and the live
// signals, then stops it. Reads the throwaway lecturer key from .dev.vars.
import assert from 'node:assert/strict'
import { devLecturerKey } from './_devvars.mjs'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const PORT = 8790 + Math.floor(Math.random() * 100)
const BASE = `http://127.0.0.1:${PORT}`
const KEY = devLecturerKey()
const run = Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, 'x')
const C = ('t' + run + 'a').slice(0, 8)      // a poll code
const S = ('s' + run + 'b').slice(0, 8)      // a join code

const wr = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
wr.stdout.on('data', (d) => { log += d })
wr.stderr.on('data', (d) => { log += d })
const stop = () => { try { process.platform === 'win32' ? spawn('taskkill', ['/pid', String(wr.pid), '/T', '/F']) : wr.kill() } catch {} }

async function up() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/lecturer')).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev did not start:\n' + log.slice(-2000))
}
const get = (p, key) => fetch(BASE + p, { headers: key ? { 'x-tessera-lecturer': KEY } : {} })
const post = (p, body, key, method = 'POST') => fetch(BASE + p, {
  method, headers: { 'content-type': 'application/json', ...(key ? { 'x-tessera-lecturer': KEY } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
})
function socket(q) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/live?' + q)
  const msgs = []
  ws.onmessage = (e) => msgs.push(String(e.data))
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  return { ws, msgs, opened, waitFor: async (pred, ms = 3000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (msgs.some(pred)) return true; await new Promise((r) => setTimeout(r, 50)) }
    return false
  } }
}

try {
  await up()

  // --- lecturer key ---
  assert.deepEqual(await (await get('/api/lecturer', true)).json(), { required: true, ok: true })
  assert.deepEqual(await (await get('/api/lecturer')).json(), { required: true, ok: false })

  // --- an empty poll is not an error ---
  let d = await (await get(`/api/poll?c=${C}`)).json()
  assert.equal(d.count, 0)

  // --- live: a page hears about the answer ---
  const live = socket('c=' + C)
  await live.opened
  assert.ok(await live.waitFor((m) => m.includes('hello')), 'hello')

  let r = await post('/api/answer', { code: C, text: 'first', question: 'What?' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).count, 1)
  assert.ok(await live.waitFor((m) => m.includes('changed')), 'changed after an answer')

  // --- answers[] needs the key; count and question do not ---
  d = await (await get(`/api/poll?c=${C}`)).json()
  assert.equal(d.count, 1); assert.equal(d.answersWithheld, true); assert.deepEqual(d.answers, []); assert.equal(d.question, 'What?')
  d = await (await get(`/api/poll?c=${C}`, true)).json()
  assert.equal(d.answers[0].text, 'first')

  // --- a burst: 40 phones at once ---
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => post(`/api/answer?c=${C}`, { code: C, text: 'a' + i, name: 'N' + i })))
  assert.ok(burst.every((x) => x.status === 200))
  d = await (await get(`/api/poll?c=${C}`, true)).json()
  assert.equal(d.count, 41)
  assert.equal(new Set(d.answers.map((a) => a.id)).size, 41)
  assert.equal(d.answers[0].text, 'first')                       // oldest first
  assert.ok(d.answers.some((a) => a.name === 'N7'))

  // --- an image: upload, serve, count against the bucket ---
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  r = await post(`/api/upload?c=${C}`, { code: C, dataUrl: png })
  assert.equal(r.status, 200)
  const up1 = await r.json()
  assert.ok(up1.url.startsWith(BASE + '/api/blob?c=' + C), up1.url)
  r = await fetch(up1.url)
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'))

  // --- documents (a peer-review hand-in): PDF as is, HTML sandboxed, markdown as text ---
  const b64 = (s) => Buffer.from(s).toString('base64')
  const docs = [
    ['application/pdf', '%PDF-1.4\n%%EOF\n', 'application/pdf', false],
    ['text/html', '<h1>mine</h1><script>1</script>', 'text/html; charset=utf-8', true],
    ['text/markdown', '# Title\n\nbody', 'text/plain; charset=utf-8', true],
  ]
  for (const [mime, text, served, sandboxed] of docs) {
    r = await post(`/api/upload?c=${C}`, { code: C, dataUrl: `data:${mime};base64,${b64(text)}` })
    assert.equal(r.status, 200, mime)
    const u = await r.json()
    assert.equal(u.mime, mime)
    r = await fetch(u.url)
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), served)
    assert.equal(/sandbox/.test(r.headers.get('content-security-policy') || ''), sandboxed, mime)
    assert.equal(await r.text(), text)
  }
  assert.equal((await post(`/api/upload?c=${C}`, { code: C, dataUrl: `data:application/zip;base64,${b64('PK')}` })).status, 415)
  const big = 'data:application/pdf;base64,' + Buffer.alloc(1800 * 1024 + 10).toString('base64')
  assert.equal((await post(`/api/upload?c=${C}`, { code: C, dataUrl: big })).status, 413)
  const bigImg = 'data:image/png;base64,' + Buffer.alloc(600 * 1024 + 10).toString('base64')
  assert.equal((await post(`/api/upload?c=${C}`, { code: C, dataUrl: bigImg })).status, 413)   // images keep 600 kB

  // --- an activity page: published by the deck, read by the join page ---
  assert.equal((await post('/api/poll', { code: C, html: '<p>game</p>' })).status, 401)
  assert.equal((await post('/api/poll', { code: C, html: '<p>game</p>' }, true)).status, 200)
  d = await (await get(`/api/poll?c=${C}`)).json()
  assert.equal(d.html, '<p>game</p>'); assert.equal(d.question, 'What?')   // the field mask kept the question

  // --- sessions: the room follows the speaker ---
  const room = socket('s=' + S)
  await room.opened
  d = await (await get(`/api/session?s=${S}`)).json()
  assert.equal(d.exists, false); assert.equal(d.active, null)
  assert.equal((await post('/api/session', { s: S, active: { code: C, kind: 'choice', question: 'Pick', options: ['A', 'B'] } })).status, 401)
  r = await post('/api/session', { s: S, active: { code: C, kind: 'choice', question: 'Pick', options: ['A', 'B'], secret: 'dropped' } }, true)
  assert.equal(r.status, 200)
  assert.ok(await room.waitFor((m) => m.includes('changed')), 'changed after the speaker moved')
  d = await (await get(`/api/session?s=${S}`)).json()
  assert.equal(d.exists, true); assert.equal(d.active.code, C); assert.deepEqual(d.active.options, ['A', 'B']); assert.equal(d.active.secret, undefined)
  // a chosen name; one that is already a poll's code is refused
  assert.equal((await (await post('/api/session', { s: 'grp-' + run, claim: true }, true)).json()).existed, false)
  assert.equal((await post('/api/session', { s: C, claim: true }, true)).status, 409)

  // --- QR and the join page ---
  r = await get(`/api/qr?c=${S}&fg=1a4c9c`)
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /svg/)
  assert.match(await r.text(), /<svg[\s\S]*#1a4c9c/i)
  r = await fetch(`${BASE}/${S}`)
  assert.equal(r.status, 200); assert.match(await r.text(), /<html/i)
  // the live link the join page loads is the engine's, byte for byte
  r = await fetch(`${BASE}/live.js`)
  assert.equal(r.status, 200)
  assert.equal(await r.text(), readFileSync(new URL('../../../slides/src/live-shim.js', import.meta.url), 'utf8'), 'public/live.js is stale: npm run sync')
  // and so is the game SDK, once the engine has one
  const sdk = new URL('../../../slides/src/game-sdk.js', import.meta.url)
  if (existsSync(sdk)) {
    r = await fetch(`${BASE}/game.js`)
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/)
    assert.equal(await r.text(), readFileSync(sdk, 'utf8'), 'public/game.js is stale: npm run sync')
  }
  // and the old-names aliases every activity page gets first
  const names = new URL('../../../slides/src/legacy-names.js', import.meta.url)
  if (existsSync(names)) {
    r = await fetch(`${BASE}/legacy-names.js`)
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/)
    assert.equal(await r.text(), readFileSync(names, 'utf8'), 'public/legacy-names.js is stale: npm run sync')
  }
  // the vendored libraries
  for (const lib of ['confetti', 'matter', 'd3', 'chart']) {
    r = await fetch(`${BASE}/lib/${lib}.js`)
    assert.equal(r.status, 200, lib); assert.match(r.headers.get('content-type'), /javascript/, lib)
    assert.ok((await r.text()).length > 10_000, lib)
  }

  // --- clear: answers and images go, the question stays ---
  assert.equal((await post(`/api/poll?c=${C}`, undefined, false, 'DELETE')).status, 401)
  d = await (await post(`/api/poll?c=${C}`, undefined, true, 'DELETE')).json()
  assert.deepEqual(d, { cleared: 41, images: 4 })   // the picture and three documents
  d = await (await get(`/api/poll?c=${C}`, true)).json()
  assert.equal(d.count, 0); assert.equal(d.question, 'What?')
  assert.equal((await fetch(up1.url)).status, 404)

  // --- bad input ---
  assert.equal((await post('/api/answer', { code: 'BAD CODE', text: 'x' })).status, 400)
  assert.equal((await post('/api/answer', { code: C, text: '' })).status, 400)
  assert.equal((await get('/api/nothing')).status, 404)
  assert.equal((await fetch(BASE + '/api/poll?c=' + C, { method: 'OPTIONS' })).status, 204)

  live.ws.close(); room.ws.close()
  console.log('e2e: ok')
} catch (e) {
  console.error(e)
  console.error('--- wrangler log tail ---\n' + log.slice(-3000))
  process.exitCode = 1
} finally {
  stop()
}
