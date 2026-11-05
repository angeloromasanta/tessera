// GET  /api/game?c=CODE[&since=SEQ]   → {code, v, epoch, state, accept, now, count, me?, players?, seq?, moves?}
// POST /api/game {code, op, ...}      op: join | move (a phone) · state | kick | reset (the lecturer)
//
// The game layer of an activity poll: one versioned `state` the screen
// publishes, the `moves` phones make under keys, a `private` value per player,
// and server-side rules (`accept`) for which moves count. The contract, wire
// shape included, is tessera/docs/game.md; this file implements it.
//
// Identity: a phone sends its device token (`tessera-device`, kept by the join
// page) as `x-tessera-player`; the player id is derived from it here (playerId in
// _lib.js), so nobody can act as another player without their token, and the
// token itself never leaves the phone that holds it. The lecturer key
// (`x-tessera-lecturer`) unlocks the roster, every move, and the screen's ops.
//
// Every check-and-write runs as one synchronous method on the poll's Durable
// Object (src/space.js, "the game layer"), so `first` moves and `ifV`
// compare-and-set are atomic. Joins and moves wake only the default live
// sockets; state, kick and reset also wake the phones' `&ch=state` sockets.

import {
  preflight, json, body, badCode, hasLecturer, denyLecturer, playerId,
  gameRead, gameJoin, gameMove, gameState, gameKick, gameReset,
  MAX_NAME_CHARS, MAX_MOVE_CHARS, MAX_STATE_CHARS, MAX_PRIVATE_CHARS, MAX_GAME_PLAYERS,
  GAME_KEY_RE, PLAYER_TOKEN_RE, PID_RE, vary,
} from './_lib.js'

/** The caller's pid, null when it sent no token, or {error} for a malformed one. */
function player(req, code) {
  const t = req.headers['x-tessera-player']
  if (t === undefined || t === '') return null
  if (!PLAYER_TOKEN_RE.test(String(t))) return { error: 'bad player token' }
  return { pid: playerId(code, String(t)) }
}

/** JSON text of `v`, or {error, status} when it cannot be stored. */
function serialize(v, max, what) {
  let text
  try { text = JSON.stringify(v === undefined ? null : v) } catch { return { status: 400, error: `${what} is not JSON` } }
  if (text.length > max) return { status: 413, error: `${what} too large (max ${max} characters)` }
  return { text }
}

/** `accept` as the server keeps it: null, or {join?, moves?, until?}. */
function cleanAccept(a) {
  if (a === null) return { value: null }
  if (typeof a !== 'object' || Array.isArray(a)) return { error: 'accept must be null or an object' }
  const out = {}
  if (a.join !== undefined) {
    if (typeof a.join !== 'boolean') return { error: 'accept.join must be true or false' }
    out.join = a.join
  }
  if (a.moves !== undefined && a.moves !== null) {
    if (!Array.isArray(a.moves) || a.moves.length > 200) return { error: 'accept.moves must be a list of keys' }
    for (const p of a.moves) {
      if (typeof p !== 'string' || !(p === '*' || GAME_KEY_RE.test(p.endsWith('*') ? p.slice(0, -1) : p))) {
        return { error: `bad key pattern in accept.moves: ${JSON.stringify(p)}` }
      }
    }
    out.moves = a.moves
  } else if (a.moves === null) out.moves = null
  if (a.until !== undefined && a.until !== null) {
    if (typeof a.until !== 'number' || !Number.isFinite(a.until)) return { error: 'accept.until must be a time in ms' }
    out.until = Math.trunc(a.until)
  }
  return { value: out }
}

const send = (res, r) => json(res, r.status, r.body)

export default async function handler(req, res) {
  if (preflight(req, res)) return
  res.setHeader('cache-control', 'no-store')
  res.setHeader('vary', vary('x-tessera-lecturer', 'x-tessera-player'))

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const code = String(req.query.c ?? '').trim().toLowerCase()
      if (badCode(code)) return json(res, 400, { error: 'bad code' })
      const p = player(req, code)
      if (p?.error) return json(res, 400, { error: p.error })
      const lecturer = hasLecturer(req)
      const d = await gameRead(code, { pid: p?.pid, lecturer, since: req.query.since })
      return json(res, 200, { code, ...d, now: Date.now() })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

    const b = body(req)
    const code = String(b.code ?? req.query.c ?? '').trim().toLowerCase()
    if (badCode(code)) return json(res, 400, { error: 'bad code' })
    const op = b.op

    if (op === 'join' || op === 'move') {
      const p = player(req, code)
      if (!p) return json(res, 400, { error: 'x-tessera-player (the device token) is required' })
      if (p.error) return json(res, 400, { error: p.error })

      if (op === 'join') {
        const name = b.name === undefined || b.name === null
          ? undefined
          : String(b.name).trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_CHARS)
        return send(res, await gameJoin(code, p.pid, name))
      }

      const k = String(b.k ?? '')
      if (!GAME_KEY_RE.test(k)) return json(res, 400, { error: 'bad move key k' })
      const slot = b.slot === undefined || b.slot === null || b.slot === '' ? undefined : String(b.slot)
      if (slot !== undefined && !GAME_KEY_RE.test(slot)) return json(res, 400, { error: 'bad slot' })
      const mode = b.mode ?? 'last'
      if (mode !== 'last' && mode !== 'first') return json(res, 400, { error: 'mode must be last or first' })
      const data = serialize(b.data, MAX_MOVE_CHARS, 'move data')
      if (data.error) return json(res, data.status, { error: data.error })
      return send(res, await gameMove(code, { pid: p.pid, k, slot, data: data.text, mode }))
    }

    if (op === 'state' || op === 'kick' || op === 'reset') {
      if (denyLecturer(req, res)) return

      if (op === 'reset') return send(res, await gameReset(code))

      if (op === 'kick') {
        const pid = String(b.pid ?? '')
        if (!PID_RE.test(pid)) return json(res, 400, { error: 'bad pid' })
        return send(res, await gameKick(code, pid))
      }

      const patch = {}
      if (b.state !== undefined) {
        const s = serialize(b.state, MAX_STATE_CHARS, 'state')
        if (s.error) return json(res, s.status, { error: s.error })
        patch.state = s.text
      }
      if (b.accept !== undefined) {
        const a = cleanAccept(b.accept)
        if (a.error) return json(res, 400, { error: a.error })
        patch.accept = a.value
      }
      if (b.private !== undefined && b.private !== null) {
        if (typeof b.private !== 'object' || Array.isArray(b.private)) return json(res, 400, { error: 'private must be {pid: value}' })
        const entries = Object.entries(b.private)
        if (entries.length > MAX_GAME_PLAYERS) return json(res, 413, { error: `at most ${MAX_GAME_PLAYERS} private values` })
        patch.privates = {}
        for (const [pid, v] of entries) {
          if (!PID_RE.test(pid)) return json(res, 400, { error: `bad pid in private: ${JSON.stringify(pid)}` })
          if (v === null) { patch.privates[pid] = null; continue }
          const s = serialize(v, MAX_PRIVATE_CHARS, `private value for ${pid}`)
          if (s.error) return json(res, s.status, { error: s.error })
          patch.privates[pid] = s.text
        }
      }
      if (b.ifV !== undefined && b.ifV !== null) {
        if (!Number.isInteger(b.ifV)) return json(res, 400, { error: 'ifV must be an integer' })
        patch.ifV = b.ifV
      }
      return send(res, await gameState(code, patch))
    }

    return json(res, 400, { error: 'op must be join, move, state, kick or reset' })
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}
