// One Durable Object per poll ("c:CODE") or join code ("s:CODE").
//
// It replaces Firestore: the poll document, its answers and its images live in
// this object's SQLite, and the route handlers run INSIDE it (src/index.js
// forwards the request here). Running here rather than in the Worker matters on
// the Free plan: a Worker request gets 10 ms of CPU, a Durable Object request
// 30 s, which is what clustering, a 1.6 MB help photo or a 600 kB upload need.
//
// It also replaces polling. Pages keep a WebSocket to GET /api/live, and every
// write here sends one small {"t":"changed"} to each of them; a page re-reads
// over HTTP only after that (see public/live.js). The socket uses the
// hibernation API, so an idle room costs nothing between changes, and
// "ping" is answered without waking the object.
//
// It also holds the game layer of an activity poll (docs/game.md): tables
// `players`, `moves`, `privates` and the kv fields gameState / gameV /
// gameEpoch / gameAccept / gameSeq. Live sockets have a channel: one opened with
// `&ch=state` (a phone) hears only state-channel writes (game state, private,
// kick, reset); a default one (a screen, a figure) hears every write.

import { DurableObject } from 'cloudflare:workers'
import { current } from './context.js'
import { runHandler } from './adapter.js'
import poll from './api/poll.js'
import answer from './api/answer.js'
import upload from './api/upload.js'
import blob from './api/blob.js'
import summarize from './api/summarize.js'
import cluster from './api/cluster.js'
import draw from './api/draw.js'
import help from './api/help.js'
import remix from './api/remix.js'
import session from './api/session.js'
import game from './api/game.js'
import ai from './api/ai.js'
import { MAX_GAME_PLAYERS, MAX_GAME_MOVES, MAX_GAME_MOVES_PER_READ } from './api/_lib.js'

export const ROUTES = { poll, answer, upload, blob, summarize, cluster, draw, help, remix, session, game, ai }

/** Socket tags (hibernation API): the channel a page listens on. */
const CHANNELS = ['all', 'state']

/** Broadcasts are coalesced: a burst of answers is one signal per window. */
const SIGNAL_EVERY_MS = 400

export class Space extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.key = ''
    this.ans = null            // answers cache: [{id, text, at, name}] oldest first, or null
    this.signals = { all: { last: 0, timer: 0 }, state: { last: 0, timer: 0 } }   // per channel
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, name TEXT, v TEXT)`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, at TEXT NOT NULL)`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
      // The game layer. `owner` is the slot when the move named one, else the pid.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL, kicked INTEGER NOT NULL DEFAULT 0)`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS moves (seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, k TEXT NOT NULL, pid TEXT NOT NULL, slot TEXT, data TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (owner, k))`)
      this.sql.exec(`CREATE INDEX IF NOT EXISTS moves_pid ON moves (pid)`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS privates (pid TEXT PRIMARY KEY, v TEXT NOT NULL)`)
      this.key = this.sql.exec(`SELECT v FROM meta WHERE k = 'key'`).toArray()[0]?.v ?? ''
    })
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // --- HTTP -----------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url)
    const key = request.headers.get('x-space') ?? ''
    if (key && key !== this.key) {
      this.key = key
      this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('key', ?)`, key)
    }
    const route = url.pathname.replace(/^\/api\//, '')
    if (route === 'live') return this.live(request)
    const handler = ROUTES[route]
    if (!handler) return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    const bodyText = request.headers.get('x-body-read') === '1' ? await request.text() : undefined
    return current.run({ self: this }, () => runHandler(handler, request, { url, bodyText }))
  }

  live(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('{"error":"expected a WebSocket"}', { status: 426, headers: { 'content-type': 'application/json' } })
    }
    const [client, server] = Object.values(new WebSocketPair())
    const ch = new URL(request.url).searchParams.get('ch') === 'state' ? 'state' : 'all'
    this.ctx.acceptWebSocket(server, [ch])
    server.send('{"t":"hello"}')
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage() {}   // pages send only "ping", which the auto-response answers
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code) } catch {} }
  webSocketError(ws) { try { ws.close(1011) } catch {} }

  /** Tell the open pages that something here changed. Every write wakes the
   *  default ('all') sockets; a state-channel write (`ch = 'state'`: game state,
   *  private, kick, reset) also wakes the `&ch=state` ones. */
  changed(ch = 'all') {
    this.signal('all')
    if (ch === 'state') this.signal('state')
  }

  /** One coalesced {"t":"changed"} per channel per SIGNAL_EVERY_MS. */
  signal(tag) {
    if (!CHANNELS.includes(tag)) return
    const s = this.signals[tag]
    const msg = tag === 'state' ? '{"t":"changed","ch":"state"}' : '{"t":"changed"}'
    const send = () => {
      s.timer = 0
      s.last = Date.now()
      for (const ws of this.ctx.getWebSockets(tag)) { try { ws.send(msg) } catch {} }
    }
    const now = Date.now()
    if (now - s.last >= SIGNAL_EVERY_MS) send()
    else if (!s.timer) s.timer = setTimeout(send, SIGNAL_EVERY_MS - (now - s.last))
  }

  // --- the poll document (Firestore polls/{code}) ------------------------------

  pollGet() {
    const rows = this.sql.exec(`SELECT k, v FROM kv`).toArray()
    if (!rows.length) return null
    const out = {}
    for (const r of rows) out[r.k] = JSON.parse(r.v)
    return out
  }

  /** Upsert the named fields only, like a Firestore PATCH with an updateMask.
   *  Values are coerced as _lib's old toFields did: integers, booleans, else
   *  strings; undefined and null are skipped. */
  pollSet(patch) {
    let n = 0
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v === undefined || v === null) continue
      const val = typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? v : String(v)
      this.sql.exec(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`, k, JSON.stringify(val))
      n++
    }
    if (n) this.changed()
  }

  // --- answers (polls/{code}/answers) ------------------------------------------

  answersList() {
    if (!this.ans) {
      this.ans = this.sql.exec(`SELECT id, text, at, name FROM answers ORDER BY at, seq`).toArray()
        .map((r) => ({ id: r.id, text: r.text, at: r.at, name: r.name ?? '' }))
    }
    // A copy: a handler that lists, then adds, must not see its list grow
    // (answer.js counts `existing.length + 1`, as it did on Firestore).
    return this.ans.slice()
  }

  answersCount() { return this.ans ? this.ans.length : this.answersList().length }

  answerAdd(text, name) {
    const id = autoId()
    const at = new Date().toISOString()
    const seq = (this.sql.exec(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM answers`).one()).n
    this.sql.exec(`INSERT INTO answers (id, seq, text, at, name) VALUES (?, ?, ?, ?, ?)`, id, seq, text, at, name || null)
    if (this.ans) this.ans.push({ id, text, at, name: name || '' })
    this.changed()
    return this.answersCount()
  }

  answersDelete() {
    const n = this.answersCount()
    this.sql.exec(`DELETE FROM answers`)
    this.ans = []
    this.changed()
    return n
  }

  vectorsList() {
    const out = {}
    for (const r of this.sql.exec(`SELECT id, v FROM answers WHERE v IS NOT NULL`)) out[r.id] = r.v
    return out
  }

  vectorsPut(byId) {
    for (const [id, v] of Object.entries(byId ?? {})) this.sql.exec(`UPDATE answers SET v = ? WHERE id = ?`, String(v), id)
  }

  // --- images (polls/{code}/blobs) ---------------------------------------------

  blobPut(id, bytes, mime) {
    this.sql.exec(`INSERT INTO blobs (id, bytes, mime, size, at) VALUES (?, ?, ?, ?, ?)`, id, bytes, mime, bytes.byteLength, new Date().toISOString())
    this.changed()
    return id
  }

  blobGet(id) {
    const r = this.sql.exec(`SELECT bytes, mime FROM blobs WHERE id = ?`, id).toArray()[0]
    return r ? { body: new Uint8Array(r.bytes), mime: r.mime || 'image/jpeg' } : null
  }

  blobIds() { return this.sql.exec(`SELECT id FROM blobs ORDER BY at`).toArray().map((r) => r.id) }

  blobsDelete() {
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM blobs`).one().n
    this.sql.exec(`DELETE FROM blobs`)
    this.changed()
    return n
  }

  // --- the session (sessions/{code}) ---------------------------------------------

  sessionGet() {
    const p = this.pollGet()
    if (!p || p.activeJson === undefined) return null
    let active = null
    if (p.activeJson) { try { active = JSON.parse(p.activeJson) } catch { active = null } }
    return { active, at: p.at ?? '' }
  }

  sessionSet(active) {
    const at = new Date().toISOString()
    this.sql.exec(`INSERT OR REPLACE INTO kv (k, v) VALUES ('activeJson', ?)`, JSON.stringify(active ? JSON.stringify(active) : ''))
    this.sql.exec(`INSERT OR REPLACE INTO kv (k, v) VALUES ('at', ?)`, JSON.stringify(at))
    this.changed()
    return { active: active ?? null, at }
  }

  // --- the game layer (docs/game.md) ---------------------------------------------
  //
  // Each op is ONE synchronous method: nothing else runs on this object between
  // its check and its write, so a `first` move and a compare-and-set are atomic.
  // Ops return {status, body} for the handler (src/api/game.js) to send.

  kvGet(k) {
    const r = this.sql.exec(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0]
    return r ? JSON.parse(r.v) : undefined
  }

  /** `text` is already JSON (serialized and size-checked by the handler). */
  kvPutJson(k, text) { this.sql.exec(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`, k, text) }

  gameMeta() {
    let epoch = this.kvGet('gameEpoch')
    if (!epoch) { epoch = newEpoch(); this.kvPutJson('gameEpoch', JSON.stringify(epoch)) }
    return { v: this.kvGet('gameV') ?? 0, epoch, accept: this.kvGet('gameAccept') ?? null, seq: this.kvGet('gameSeq') ?? 0 }
  }

  gamePlayer(pid) { return this.sql.exec(`SELECT pid, name, at, kicked FROM players WHERE pid = ?`, pid).toArray()[0] ?? null }

  gameMe(pid) {
    const p = this.gamePlayer(pid)
    const priv = this.sql.exec(`SELECT v FROM privates WHERE pid = ?`, pid).toArray()[0]
    const moves = {}
    for (const r of this.sql.exec(`SELECT seq, k, slot, data, at FROM moves WHERE pid = ? ORDER BY seq`, pid)) {
      moves[r.k] = { data: JSON.parse(r.data), at: r.at, seq: r.seq, ...(r.slot ? { slot: r.slot } : {}) }
    }
    return { pid, name: p?.name ?? '', joined: !!p, kicked: !!p?.kicked, private: priv ? JSON.parse(priv.v) : null, moves }
  }

  /** GET /api/game. `pid`: a phone's own view; `lecturer`: the roster and the moves after `since`. */
  gameRead({ pid, lecturer, since } = {}) {
    const m = this.gameMeta()
    const out = {
      v: m.v, epoch: m.epoch, state: this.kvGet('gameState') ?? {}, accept: m.accept,
      count: this.sql.exec(`SELECT COUNT(*) AS n FROM players WHERE kicked = 0`).one().n,
    }
    if (pid) out.me = this.gameMe(pid)
    if (lecturer) {
      out.players = this.sql.exec(`SELECT pid, name, at, kicked FROM players ORDER BY at, pid`).toArray()
        .map((r) => ({ pid: r.pid, name: r.name, at: r.at, kicked: !!r.kicked }))
      const rows = this.sql.exec(`SELECT seq, pid, k, slot, data, at FROM moves WHERE seq > ? ORDER BY seq LIMIT ?`,
        Math.max(0, Math.trunc(Number(since) || 0)), MAX_GAME_MOVES_PER_READ + 1).toArray()
      const more = rows.length > MAX_GAME_MOVES_PER_READ
      if (more) rows.length = MAX_GAME_MOVES_PER_READ
      out.moves = rows.map((r) => ({ seq: r.seq, pid: r.pid, k: r.k, ...(r.slot ? { slot: r.slot } : {}), data: JSON.parse(r.data), at: r.at }))
      // The highest seq handed out; when the read was paged, the last one returned.
      out.seq = more ? rows.at(-1).seq : m.seq
      if (more) out.more = true
    }
    return out
  }

  gameJoin(pid, name) {
    const m = this.gameMeta()
    const p = this.gamePlayer(pid)
    if (!p) {
      if (m.accept && m.accept.join === false) return { status: 403, body: { error: 'Joining is closed.', closed: true } }
      if (this.sql.exec(`SELECT COUNT(*) AS n FROM players`).one().n >= MAX_GAME_PLAYERS) {
        return { status: 429, body: { error: 'This game is full.' } }
      }
      this.sql.exec(`INSERT INTO players (pid, name, at, kicked) VALUES (?, ?, ?, 0)`, pid, name ?? '', Date.now())
    } else {
      this.sql.exec(`UPDATE players SET kicked = 0, name = ? WHERE pid = ?`, name ?? p.name, pid)
    }
    this.changed()
    return { status: 200, body: { pid, epoch: m.epoch, name: name ?? p?.name ?? '' } }
  }

  /** {pid, k, slot?, data (JSON text), mode: 'last' | 'first'} */
  gameMove({ pid, k, slot, data, mode }) {
    const at = Date.now()
    const p = this.gamePlayer(pid)
    if (!p) return { status: 403, body: { error: 'Join the game first.', joined: false } }
    if (p.kicked) return { status: 403, body: { error: 'You were removed from this game.', kicked: true } }
    const m = this.gameMeta()
    if (!accepts(m.accept, k, at)) return { status: 403, body: { error: 'This round is closed.', closed: true } }
    const owner = slot || pid
    const prev = this.sql.exec(`SELECT seq, pid, at FROM moves WHERE owner = ? AND k = ?`, owner, k).toArray()[0]
    if (prev && mode === 'first') return { status: 409, body: { error: 'taken', by: prev.pid, at: prev.at } }
    if (!prev && this.sql.exec(`SELECT COUNT(*) AS n FROM moves`).one().n >= MAX_GAME_MOVES) {
      return { status: 429, body: { error: 'This game has taken all the moves it can.' } }
    }
    const seq = m.seq + 1
    this.kvPutJson('gameSeq', String(seq))
    if (prev) this.sql.exec(`DELETE FROM moves WHERE seq = ?`, prev.seq)
    this.sql.exec(`INSERT INTO moves (seq, owner, k, pid, slot, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)`, seq, owner, k, pid, slot || null, data, at)
    this.changed()
    return { status: 200, body: { ok: true, seq, at } }
  }

  /** {state? (JSON text), accept? (undefined keeps, null clears), privates? {pid: JSON text | null}, ifV?} */
  gameState({ state, accept, privates, ifV }) {
    const m = this.gameMeta()
    if (ifV !== undefined && ifV !== m.v) {
      return { status: 409, body: { error: 'stale', v: m.v, state: this.kvGet('gameState') ?? {} } }
    }
    if (privates) {
      const adding = Object.entries(privates).filter(([pid, t]) => t !== null
        && !this.sql.exec(`SELECT 1 FROM privates WHERE pid = ?`, pid).toArray().length).length
      const have = this.sql.exec(`SELECT COUNT(*) AS n FROM privates`).one().n
      if (have + adding > MAX_GAME_PLAYERS) return { status: 429, body: { error: `at most ${MAX_GAME_PLAYERS} private values per game` } }
    }
    if (state !== undefined) this.kvPutJson('gameState', state)
    if (accept !== undefined) this.kvPutJson('gameAccept', JSON.stringify(accept))
    for (const [pid, t] of Object.entries(privates ?? {})) {
      if (t === null) this.sql.exec(`DELETE FROM privates WHERE pid = ?`, pid)
      else this.sql.exec(`INSERT OR REPLACE INTO privates (pid, v) VALUES (?, ?)`, pid, t)
    }
    const v = m.v + 1
    this.kvPutJson('gameV', String(v))
    this.changed('state')
    return { status: 200, body: { v } }
  }

  gameKick(pid) {
    if (!this.gamePlayer(pid)) return { status: 404, body: { error: 'no such player' } }
    this.sql.exec(`UPDATE players SET kicked = 1 WHERE pid = ?`, pid)
    this.changed('state')
    return { status: 200, body: { ok: true } }
  }

  /** Players, moves and private values go; state {}, accept null, a new epoch.
   *  `gameSeq` keeps counting, so a reader's old `since` never hides a new move. */
  gameReset() {
    const m = this.gameMeta()
    this.sql.exec(`DELETE FROM players`)
    this.sql.exec(`DELETE FROM moves`)
    this.sql.exec(`DELETE FROM privates`)
    const v = m.v + 1
    const epoch = newEpoch()
    this.kvPutJson('gameState', '{}')
    this.kvPutJson('gameAccept', 'null')
    this.kvPutJson('gameEpoch', JSON.stringify(epoch))
    this.kvPutJson('gameV', String(v))
    this.changed('state')
    return { status: 200, body: { v, epoch } }
  }
}

/** Does `accept` (docs/game.md, "Accept") take a move under key `k` at server time `now`? */
export function accepts(accept, k, now) {
  if (!accept) return true
  if (typeof accept.until === 'number' && now > accept.until) return false
  if (!Array.isArray(accept.moves)) return true
  return accept.moves.some((p) => (p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : p === k))
}

/** A game's epoch: new on every reset, so phones know to join again. */
function newEpoch() {
  const A = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (const x of crypto.getRandomValues(new Uint8Array(8))) s += A[x & 31]
  return s
}

/** Firestore-style auto id: 20 characters, URL-safe. */
function autoId() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const b = crypto.getRandomValues(new Uint8Array(20))
  let s = ''
  for (const x of b) s += A[x % A.length]
  return s
}
