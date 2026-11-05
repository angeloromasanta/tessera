// node test/game.e2e.test.mjs  — the game layer (/api/game, docs/game.md) and
// the live channels against a local `wrangler dev`. Same harness as
// e2e.test.mjs: a free port, the throwaway lecturer key from .dev.vars.
import assert from 'node:assert/strict'
import { devLecturerKey } from './_devvars.mjs'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PORT = 8890 + Math.floor(Math.random() * 100)
const BASE = `http://127.0.0.1:${PORT}`
const KEY = devLecturerKey()
const run = Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, 'x')
const code = (tag) => ('g' + run + tag).slice(0, 12)

const wr = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
wr.stdout.on('data', (d) => { log += d })
wr.stderr.on('data', (d) => { log += d })
const stop = () => { try { process.platform === 'win32' ? spawn('taskkill', ['/pid', String(wr.pid), '/T', '/F']) : wr.kill() } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function up() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/lecturer')).ok) return } catch {}
    await sleep(500)
  }
  throw new Error('wrangler dev did not start:\n' + log.slice(-2000))
}

/** A device token as the join page makes it: 24 url-safe chars. */
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url')
const headers = (who) => ({
  'content-type': 'application/json',
  ...(who === 'key' ? { 'x-tessera-lecturer': KEY } : who ? { 'x-tessera-player': who } : {}),
})
/** GET /api/game as nobody, a player (its token) or 'key'. */
async function read(c, who, q = '') {
  const r = await fetch(`${BASE}/api/game?c=${c}${q}`, { headers: headers(who) })
  assert.equal(r.status, 200)
  return r.json()
}
/** POST /api/game; resolves {status, ...body}. */
async function op(c, who, b) {
  const r = await fetch(`${BASE}/api/game?c=${c}`, { method: 'POST', headers: headers(who), body: JSON.stringify({ code: c, ...b }) })
  return { status: r.status, ...(await r.json()) }
}
const join = (c, t, name) => op(c, t, { op: 'join', name })
const move = (c, t, k, data, extra = {}) => op(c, t, { op: 'move', k, data, ...extra })
const setState = (c, b) => op(c, 'key', { op: 'state', ...b })

function socket(q) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/live?' + q)
  const msgs = []
  ws.onmessage = (e) => msgs.push(String(e.data))
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const changed = () => msgs.filter((m) => m.includes('changed')).length
  return { ws, msgs, opened, changed, waitFor: async (pred, ms = 3000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (msgs.some(pred)) return true; await sleep(50) }
    return false
  } }
}

try {
  await up()

  // --- join: a pid per (code, device), stable, never the token ---------------------
  const C = code('a'), C2 = code('b')
  const A = token(), B = token()
  let r = await join(C, A, '  Ada   Lovelace ')
  assert.equal(r.status, 200)
  const pa = r.pid
  assert.match(pa, /^[a-z2-7]{12}$/)
  assert.equal(r.name, 'Ada Lovelace')
  assert.equal(typeof r.epoch, 'string')
  assert.equal((await join(C, A)).pid, pa, 'a reload is the same player')
  assert.equal((await join(C, A)).name, 'Ada Lovelace', 'a join without a name keeps it')
  assert.notEqual((await join(C2, A, 'Ada')).pid, pa, 'another game, another pid')
  const pb = (await join(C, B, 'Bob')).pid
  assert.notEqual(pb, pa)
  assert.equal((await join(C, 'x'.repeat(200), 'Long')).status, 400, 'a malformed token')
  assert.equal((await op(C, undefined, { op: 'join', name: 'nobody' })).status, 400, 'no token')
  assert.equal((await join(C, token(), 'N'.repeat(100))).name.length, 60, 'names are capped')

  // --- reads: everyone, a player, the lecturer -------------------------------------
  let d = await read(C)
  for (const f of ['code', 'v', 'epoch', 'state', 'accept', 'now', 'count']) assert.ok(f in d, f)
  assert.equal(d.count, 3); assert.equal(d.me, undefined); assert.equal(d.players, undefined); assert.equal(d.moves, undefined)
  assert.ok(Math.abs(d.now - Date.now()) < 60_000)
  d = await read(C, A)
  assert.deepEqual(d.me, { pid: pa, name: 'Ada Lovelace', joined: true, kicked: false, private: null, moves: {} })
  assert.equal(d.players, undefined)
  d = await read(C, token())
  assert.equal(d.me.joined, false)

  // --- moves: last replaces (new seq), me.moves only its own ----------------------
  r = await move(C, A, 'r1', { pick: 1 })
  assert.equal(r.status, 200); assert.equal(r.ok, true)
  const s1 = r.seq
  r = await move(C, A, 'r1', { pick: 2 })
  assert.ok(r.seq > s1, 'a replaced move gets a new seq')
  await move(C, B, 'r1', 'bob')
  d = await read(C, A)
  assert.deepEqual(Object.keys(d.me.moves), ['r1'])
  assert.deepEqual(d.me.moves.r1.data, { pick: 2 })
  d = await read(C, B)
  assert.equal(d.me.moves.r1.data, 'bob')
  d = await read(C, 'key')
  assert.equal(d.players.length, 3)
  assert.deepEqual(d.moves.map((m) => [m.pid, m.k, m.data]), [[pa, 'r1', { pick: 2 }], [pb, 'r1', 'bob']])
  const seqNow = d.seq
  assert.equal(seqNow, d.moves.at(-1).seq)
  assert.equal((await move(C, token(), 'r1', 1)).status, 403, 'not joined')
  assert.equal((await move(C, A, 'bad key!', 1)).status, 400)
  assert.equal((await move(C, A, 'r1', 1, { mode: 'sometimes' })).status, 400)

  // --- since: the screen reads only what is new -------------------------------------
  await move(C, B, 'r2', 7)
  d = await read(C, 'key', `&since=${seqNow}`)
  assert.equal(d.moves.length, 1); assert.equal(d.moves[0].k, 'r2'); assert.equal(d.seq, d.moves[0].seq)
  d = await read(C, 'key', `&since=${d.seq}`)
  assert.equal(d.moves.length, 0)

  // --- first: a burst of 20 buzzers, exactly one wins --------------------------------
  const CB = code('c')
  const phones = Array.from({ length: 20 }, token)
  const pids = (await Promise.all(phones.map((t, i) => join(CB, t, 'P' + i)))).map((x) => x.pid)
  const burst = await Promise.all(phones.map((t, i) => move(CB, t, 'buzz', i, { mode: 'first', slot: 'buzzer' })))
  const won = burst.filter((x) => x.status === 200)
  assert.equal(won.length, 1, 'exactly one first move')
  const lost = burst.filter((x) => x.status === 409)
  assert.equal(lost.length, 19)
  const winner = pids[burst.findIndex((x) => x.status === 200)]
  assert.ok(lost.every((x) => x.error === 'taken' && x.by === winner && typeof x.at === 'number'))
  d = await read(CB, 'key')
  assert.equal(d.moves.length, 1); assert.equal(d.moves[0].pid, winner); assert.equal(d.moves[0].slot, 'buzzer')
  // first without a slot: per player
  assert.equal((await move(CB, phones[3], 'q1', 'a', { mode: 'first' })).status, 200)
  assert.equal((await move(CB, phones[3], 'q1', 'b', { mode: 'first' })).status, 409)
  assert.equal((await move(CB, phones[4], 'q1', 'b', { mode: 'first' })).status, 200)

  // --- a slot shared by two teammates --------------------------------------------------
  assert.equal((await move(C, A, 'pick', 'red', { slot: 'team:acme', mode: 'first' })).status, 200)
  r = await move(C, B, 'pick', 'blue', { slot: 'team:acme', mode: 'first' })
  assert.equal(r.status, 409); assert.equal(r.by, pa)
  await move(C, A, 'vote', 1, { slot: 'team:acme' })
  await move(C, B, 'vote', 2, { slot: 'team:acme' })          // last: the teammate's replaces it
  d = await read(C, 'key')
  const votes = d.moves.filter((m) => m.k === 'vote')
  assert.equal(votes.length, 1); assert.equal(votes[0].pid, pb); assert.equal(votes[0].data, 2); assert.equal(votes[0].slot, 'team:acme')
  assert.equal((await read(C, A)).me.moves.vote, undefined, 'me.moves holds only the moves this pid made')
  assert.equal((await read(C, B)).me.moves.vote.slot, 'team:acme')

  // --- accept: the server's rules for which moves count -----------------------------
  const CA = code('d')
  const P = token(), Q = token()
  await join(CA, P, 'P')
  assert.equal((await setState(CA, { accept: { moves: ['r1'] } })).status, 200)
  assert.equal((await read(CA)).accept.moves[0], 'r1')
  assert.equal((await move(CA, P, 'r1', 1)).status, 200)
  r = await move(CA, P, 'r2', 1)
  assert.equal(r.status, 403); assert.equal(r.closed, true)
  await setState(CA, { accept: { moves: ['r*'] } })
  assert.equal((await move(CA, P, 'r5', 1)).status, 200)
  assert.equal((await move(CA, P, 'q1', 1)).status, 403)
  await setState(CA, { accept: { moves: [] } })
  assert.equal((await move(CA, P, 'r1', 1)).status, 403, 'moves: [] takes none')
  await setState(CA, { accept: { until: Date.now() - 1000 } })
  assert.equal((await move(CA, P, 'r1', 1)).status, 403, 'past until')
  await setState(CA, { accept: { until: Date.now() + 60_000 } })
  assert.equal((await move(CA, P, 'r1', 1)).status, 200, 'before until')
  await setState(CA, { accept: { join: false } })
  r = await join(CA, Q, 'late')
  assert.equal(r.status, 403); assert.equal(r.closed, true)
  assert.equal((await join(CA, P)).status, 200, 'join:false still lets a joined player rejoin')
  assert.equal((await move(CA, P, 'any', 1)).status, 200, 'join:false alone takes every move')
  await setState(CA, { accept: null })
  assert.equal((await read(CA)).accept, null)
  assert.equal((await join(CA, Q, 'late')).status, 200)
  assert.equal((await setState(CA, { accept: { moves: ['bad key!'] } })).status, 400)
  assert.equal((await setState(CA, { accept: 'open' })).status, 400)

  // --- state: versioned, compare-and-set ------------------------------------------------
  let v = (await read(CA)).v
  r = await setState(CA, { state: { round: 1, board: [1, 2, 3] }, ifV: v })
  assert.equal(r.status, 200); assert.equal(r.v, v + 1)
  r = await setState(CA, { state: { round: 2 }, ifV: v })
  assert.equal(r.status, 409); assert.equal(r.error, 'stale'); assert.equal(r.v, v + 1); assert.deepEqual(r.state, { round: 1, board: [1, 2, 3] })
  assert.deepEqual((await read(CA, P)).state, { round: 1, board: [1, 2, 3] })
  assert.equal((await setState(CA, { state: { round: 2 } })).v, v + 2, 'no ifV: always written')
  assert.equal((await op(CA, P, { op: 'state', state: { hacked: true } })).status, 401, 'a phone cannot publish')

  // --- private: only its pid sees it --------------------------------------------------------
  const pp = (await join(CA, P)).pid, pq = (await join(CA, Q)).pid
  assert.equal((await setState(CA, { private: { [pp]: { card: 'ace' } } })).status, 200)
  assert.deepEqual((await read(CA, P)).me.private, { card: 'ace' })
  assert.equal((await read(CA, Q)).me.private, null)
  assert.ok(!JSON.stringify(await read(CA)).includes('ace'), 'not in the open read')
  assert.ok(!JSON.stringify(await read(CA, Q)).includes('ace'), 'not in another player\'s read')
  await setState(CA, { private: { [pp]: null, [pq]: 5 } })
  assert.equal((await read(CA, P)).me.private, null)
  assert.equal((await read(CA, Q)).me.private, 5)
  assert.equal((await setState(CA, { private: { NOTAPID: 1 } })).status, 400)

  // --- kick -------------------------------------------------------------------------------
  assert.equal((await op(CA, P, { op: 'kick', pid: pq })).status, 401)
  assert.equal((await op(CA, 'key', { op: 'kick', pid: pq })).status, 200)
  r = await move(CA, Q, 'r1', 1)
  assert.equal(r.status, 403); assert.equal(r.kicked, true)
  d = await read(CA, 'key')
  assert.equal(d.players.find((p) => p.pid === pq).kicked, true)
  assert.equal(d.count, 1)
  assert.equal((await read(CA, Q)).me.kicked, true)
  assert.equal((await op(CA, 'key', { op: 'kick', pid: 'aaaaaaaaaaaa' })).status, 404)
  assert.equal((await join(CA, Q)).status, 200, 'join clears kicked')
  assert.equal((await read(CA)).count, 2)

  // --- reset --------------------------------------------------------------------------------
  const before = await read(CA, 'key')
  r = await op(CA, 'key', { op: 'reset' })
  assert.equal(r.status, 200); assert.notEqual(r.epoch, before.epoch); assert.equal(r.v, before.v + 1)
  d = await read(CA, 'key')
  assert.equal(d.epoch, r.epoch); assert.deepEqual(d.state, {}); assert.equal(d.accept, null)
  assert.equal(d.count, 0); assert.deepEqual(d.players, []); assert.deepEqual(d.moves, [])
  d = await read(CA, P)
  assert.equal(d.me.joined, false); assert.equal(d.me.private, null); assert.deepEqual(d.me.moves, {})
  r = await join(CA, P)
  assert.equal(r.pid, pp, 'same pid after a reset'); assert.equal(r.epoch, d.epoch)
  r = await move(CA, P, 'r1', 'again')
  assert.ok(r.seq > before.seq, 'seq keeps counting across a reset')

  // --- DELETE /api/poll (Clear responses) resets the game too ----------------------------------
  const ep = (await read(C)).epoch
  r = await fetch(`${BASE}/api/poll?c=${C}`, { method: 'DELETE', headers: headers('key') })
  assert.equal(r.status, 200)
  d = await read(C, 'key')
  assert.notEqual(d.epoch, ep); assert.equal(d.count, 0); assert.deepEqual(d.moves, [])

  // --- live channels: a phone's ch=state socket sleeps through joins and moves -------------
  const CL = code('e')
  const phone = socket(`c=${CL}&ch=state`), screen = socket(`c=${CL}`)
  await Promise.all([phone.opened, screen.opened])
  assert.ok(await phone.waitFor((m) => m.includes('hello')) && await screen.waitFor((m) => m.includes('hello')))
  await sleep(500)
  const L = token()
  await join(CL, L, 'L')
  await move(CL, L, 'r1', 1)
  assert.ok(await screen.waitFor((m) => m.includes('changed'), 2000), 'the screen hears a move')
  await sleep(1000)
  assert.equal(phone.changed(), 0, 'the phone does not hear a join or a move')
  const heard = screen.changed()
  await setState(CL, { state: { round: 2 } })
  assert.ok(await phone.waitFor((m) => m.includes('changed'), 2000), 'the phone hears state')
  const t0 = Date.now()
  while (screen.changed() === heard && Date.now() - t0 < 2000) await sleep(50)
  assert.ok(screen.changed() > heard, 'the screen hears state too')
  assert.ok(phone.msgs.some((m) => JSON.parse(m).ch === 'state'))
  // kick and reset reach the phone as well
  for (const b of [{ op: 'kick', pid: (await join(CL, L)).pid }, { op: 'reset' }]) {
    await sleep(500)
    const n = phone.changed()
    await op(CL, 'key', b)
    const t1 = Date.now()
    while (phone.changed() === n && Date.now() - t1 < 2000) await sleep(50)
    assert.ok(phone.changed() > n, b.op + ' reaches a ch=state socket')
  }
  phone.ws.close(); screen.ws.close()

  // --- limits ----------------------------------------------------------------------------------
  const CX = code('f')
  const X = token()
  await join(CX, X, 'X')
  r = await move(CX, X, 'big', 'x'.repeat(4001))
  assert.equal(r.status, 413)
  assert.equal((await move(CX, X, 'ok', 'x'.repeat(3990))).status, 200)
  assert.equal((await setState(CX, { state: { s: 'x'.repeat(100_001) } })).status, 413)
  assert.equal((await setState(CX, { private: { [(await join(CX, X)).pid]: 'x'.repeat(4001) } })).status, 413)
  assert.equal((await op(CX, X, { op: 'dance' })).status, 400)

  // --- CORS: the player header is allowed ---------------------------------------------------------
  r = await fetch(`${BASE}/api/game?c=${CX}`, { method: 'OPTIONS' })
  assert.equal(r.status, 204)
  assert.match(r.headers.get('access-control-allow-headers'), /x-tessera-player/)

  console.log('game e2e: ok')
} catch (e) {
  console.error(e)
  console.error('--- wrangler log tail ---\n' + log.slice(-3000))
  process.exitCode = 1
} finally {
  stop()
}
