// Shared helpers for the poll service: CORS, validation, the lecturer key, and
// storage — which on Cloudflare is the Durable Object behind each code (see the
// storage section at the end, and src/space.js).

import { createHash, timingSafeEqual } from 'node:crypto'
import { current } from '../context.js'
import { LEGACY_HEADERS, LEGACY_HEADER_NAMES } from '../legacy.js'

/** A deck file runs from file:// or from ANY origin someone serves it on, so
 *  every call from a deck is cross-origin. Without CORS the browser rejects the
 *  request before it is even sent. Allowing any origin is safe here: the join
 *  code is the only capability, and there are no cookies to ride along —
 *  same reasoning as the sync relay's blob routes (server/sync-worker). */
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  // `x-tessera-lecturer` must be listed: a presenting deck sends it on every
  // read once a key is stored, and a custom header means a preflight. Without
  // it the browser drops the request unsent and the slide reads "Offline".
  // `x-tessera-player` is a phone's device token on /api/game and /api/ai.
  // Older decks send the same two under their old names (src/legacy.js).
  'access-control-allow-headers': ['content-type', 'x-tessera-lecturer', 'x-tessera-player', ...LEGACY_HEADER_NAMES].join(', '),
  'access-control-max-age': '86400',
}

/** A `vary` value for a reply that depends on these request headers, with
 *  their old names too (a cache must not serve one caller's reply to another). */
export function vary(...names) {
  return [...names, ...LEGACY_HEADER_NAMES.filter((old) => names.includes(LEGACY_HEADERS[old]))].join(', ')
}

/** The attribution headers every OpenRouter call carries: `x-title` names the
 *  feature in the OpenRouter dashboard; `http-referer` is this deployment's
 *  public address when PUBLIC_ORIGIN is set (optional for OpenRouter). */
export function appHeaders(feature) {
  const h = { 'x-title': `tessera ${feature}` }
  if (process.env.PUBLIC_ORIGIN) h['http-referer'] = process.env.PUBLIC_ORIGIN.replace(/\/+$/, '')
  return h
}

export function cors(res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
}

/** Answer a preflight and report whether the real handler should be skipped. */
export function preflight(req, res) {
  cors(res)
  if (req.method !== 'OPTIONS') return false
  res.status(204).end()
  return true
}

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Vercel parses JSON bodies only when the request carries the right
 *  content-type. A hand-rolled curl often does not, so accept a raw string
 *  too rather than failing with a confusing "code required". */
export function body(req) {
  const b = req.body
  if (!b) return {}
  if (typeof b === 'string') {
    try { return JSON.parse(b) } catch { return {} }
  }
  return b
}

// --- validation ---------------------------------------------------------------

export const CODE_RE = /^[a-z0-9]{4,12}$/
/** A JOIN code: what the room types, and the name of a session. The lecturer
 *  may choose it (`my-class`), so it is roomier than an answer bucket's
 *  code and takes hyphens inside. Every CODE_RE string is also one of these —
 *  a deck without a session prints a question code as its join code. */
export const SESSION_RE = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/
/** Longest answer we store.
 *
 *  This was 600, which is a considered paragraph and nothing more. That turned
 *  out to be the binding constraint on `activity` polls, whose one string is
 *  often structured — a form with four fields, or JSON the deck reads back on
 *  a later slide — and 600 characters does not hold four sentences plus a URL.
 *
 *  The ceiling exists at all because the presenting slide GETs /api/poll every
 *  3 seconds and gets every answer back, so worst case is MAX_ANSWERS ×
 *  MAX_ANSWER_CHARS on the wire per tick. At 2000 that is a 1 MB ceiling for a
 *  completely full poll and ~50 kB for a realistic classroom one. Raising it
 *  much further would need the read route to paginate first. */
export const MAX_ANSWER_CHARS = 2000
/** Longest name. A name, not a biography — and it is printed on a slide. */
export const MAX_NAME_CHARS = 60
/** Hard ceiling per poll. The write path is open to anyone holding the code,
 *  so this is the backstop against someone filling the collection. */
export const MAX_ANSWERS = 500
/** Longest activity page (a self-contained quiz/game HTML, `kind:'activity'`).
 *  Generous for a compact single-file mini-app, far under the 2 MB row cap
 *  of a Durable Object's SQLite, and small enough that fetching it once per phone is cheap. */
export const MAX_ACTIVITY_HTML_CHARS = 60_000
/** Largest image a phone may upload (decoded bytes).
 *
 *  A picture can never travel inside an answer — an answer is text, and even a
 *  raised ceiling is three orders of magnitude short. /api/upload takes the
 *  bytes instead and the answer carries the URL.
 *
 *  600 kB is set by where the blob is kept: one SQLite row in the poll's Durable Object
 *  (2 MB cap), stored as raw bytes. That is far above what a
 *  phone-downscaled JPEG needs (100–250 kB at 1200px) and the client is told to
 *  downscale anyway. See putBlob for what moving to Cloud Storage would take. */
export const MAX_UPLOAD_BYTES = 600 * 1024
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
/** Documents a phone may hand in (a peer-review submission): a report, a page,
 *  notes. Same row as an image, so the ceiling is the row's 2 MB less headroom.
 *  /api/blob serves HTML in a CSP sandbox and markdown as plain text, so a
 *  student's page never runs with this service's origin. */
export const MAX_DOC_BYTES = 1800 * 1024
export const DOC_TYPES = ['application/pdf', 'text/html', 'text/markdown', 'text/plain']
/** Minimum gap between summarize calls for one poll. Each call spends real
 *  money at the model provider; a double-click must not spend it twice. */
export const SUMMARIZE_COOLDOWN_MS = 10_000

// --- the game layer (/api/game, docs/game.md) ----------------------------------
//
// A game lives on an activity poll's code. Its writes are open to any phone
// holding a device token, so these are the backstops, as MAX_ANSWERS is for
// answers. The lecturer reads every move, so MAX_GAME_MOVES_PER_READ pages that
// read (seq of the last move returned, `more: true`).

/** Players (rows) per game, kicked ones included. */
export const MAX_GAME_PLAYERS = 500
/** Moves (rows) per game. A `last` move that replaces an earlier one adds none. */
export const MAX_GAME_MOVES = 10_000
/** One move's `data`, serialized JSON. */
export const MAX_MOVE_CHARS = 4_000
/** The game `state`, serialized JSON. */
export const MAX_STATE_CHARS = 100_000
/** One player's `private` value, serialized JSON. */
export const MAX_PRIVATE_CHARS = 4_000
/** Moves returned by one lecturer read; the rest come with the next `since`. */
export const MAX_GAME_MOVES_PER_READ = 2_000
/** A move key `k` and a `slot`. */
export const GAME_KEY_RE = /^[A-Za-z0-9_.:-]{1,40}$/
/** A device token (`tessera-device`, 24 url-safe chars; anything 8–64 is taken). */
export const PLAYER_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/
/** A player id as the server derives it (12 chars of lower-case base32). */
export const PID_RE = /^[a-z2-7]{12}$/

// --- /api/ai (docs/game.md) -------------------------------------------------------

export const MAX_AI_INPUT = 4_000
export const MAX_AI_SYSTEM = 8_000
export const MAX_AI_TOKENS = 1_500
export const MAX_AI_IMAGE = 1_600_000

export function badCode(code) {
  return typeof code !== 'string' || !CODE_RE.test(code)
}

export function badSession(code) {
  return typeof code !== 'string' || !(SESSION_RE.test(code) || CODE_RE.test(code))
}

// --- the lecturer key ---------------------------------------------------------
//
// The audience routes (POST /api/answer, POST /api/upload, GET anything) are
// open, because the join code is printed on a projector and that IS the design.
// The PRESENTER routes are a different matter: clearing a bucket, pointing the
// whole room's phones at a different question, replacing a live activity page,
// and spending money at the model provider. Those are gated on a shared secret
// the presenter types into their deck once.
//
// It is a password, not an identity: there is one per deployment, it does not
// say who you are, and it protects the controls rather than the contents —
// anyone with the code can still read every answer. Keeping that honest matters
// more than the gate does.
//
// LECTURER_PASSWORD unset means the gate stays SHUT (unlike the Vercel service,
// where unset meant no gate, for decks older than the key). This deployment
// has no such decks, and failing closed means a fresh deploy is never open in
// the minutes before the secret is set.

/** Constant-time compare over fixed-width digests, so a wrong key cannot be
 *  narrowed down a character at a time by timing the response. */
function sameSecret(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

export function lecturerRequired() {
  return true
}

/**
 * Does this request carry the lecturer key? A SOFT check: it writes nothing
 * and never fails a request, so a route can vary its PAYLOAD by who is asking
 * rather than refusing outright.
 *
 * That is what `GET /api/poll` needs. The audience join page and the presenting
 * deck call the same route, and only one of them may see `answers[]` — but the
 * join page must still get its question, and an activity page must still get
 * its HTML. A 401 there would break the room to protect it.
 *
 * With no LECTURER_PASSWORD set this returns false for everyone: the gate
 * fails closed (see above).
 *
 * The key travels in a header so it never lands in a URL (and therefore never
 * in a proxy log or a browser history); `?pass=` is accepted as well because
 * DELETE from a terminal is how a bucket usually gets cleared.
 */
export function hasLecturer(req) {
  const want = process.env.LECTURER_PASSWORD
  if (!want) return false
  const got =
    req.headers['x-tessera-lecturer'] ??
    (typeof req.query?.pass === 'string' ? req.query.pass : '') ??
    ''
  return !!got && sameSecret(got, want)
}

/**
 * Guard a presenter-only route. Returns true when the request should stop —
 * the 401 has already been written.
 */
export function denyLecturer(req, res) {
  if (hasLecturer(req)) return false
  json(res, 401, {
    error: 'This needs the lecturer key. Enter it in the deck (poll panel) to use the presenter controls.',
    lecturer: true,
  })
  return true
}

// --- storage: Durable Objects ----------------------------------------------------
//
// Was Firestore over REST. Every poll is now its own Durable Object ("c:CODE")
// and every join code another ("s:CODE"); src/space.js holds the SQLite and
// the methods below call. When the code is the object already handling this
// request (the usual case: src/index.js routes each request to the object its
// code names) the call is a local SQLite read; otherwise it is an RPC.
//
// Names and return shapes are the ones the handlers were written against, so
// no handler changed.

function space(key) {
  const c = current.getStore()
  if (!c?.self) throw new Error('storage used outside a Durable Object')
  if (c.self.key === key) return c.self
  const ns = c.self.env.SPACE
  return ns.get(ns.idFromName(key))
}
const poll = (code) => space('c:' + code)
const room = (code) => space('s:' + code)

/** The poll document, or null when nobody has created it yet. */
export async function getPoll(code) { return await poll(code).pollGet() }

/** Upsert the named fields only; undefined and null are skipped. */
export async function setPoll(code, patch) { await poll(code).pollSet(patch) }

export async function addAnswer(code, text, name) { return await poll(code).answerAdd(text, name) }

/** Oldest first, so the presenter's list reads in the order people spoke. */
export async function listAnswers(code) { return await poll(code).answersList() }

/** Kept for the handlers that call it: answers are cached in the object's
 *  memory, so every read is already cheap. */
export const listAnswersCached = listAnswers
export function forgetAnswers() {}

export async function deleteAnswers(code) { return await poll(code).answersDelete() }

/** {answerId: base64 vector} for every answer that has one (/api/cluster). */
export async function listVectors(code) { return await poll(code).vectorsList() }
export async function putVectors(code, byId) { await poll(code).vectorsPut(byId) }

// --- sessions: one join code for a whole talk; a POINTER, never answers --------

export async function getSession(code) { return await room(code).sessionGet() }
export const getSessionCached = getSession

/** `active` null closes the session: the room is told to look up. */
export async function setSession(code, active) { await room(code).sessionSet(active ?? null) }

// --- uploaded images ------------------------------------------------------------
//
// The bytes live in the poll's own SQLite (a BLOB row, ≤ 2 MB on Cloudflare;
// MAX_UPLOAD_BYTES keeps them far under), so "Clear responses" takes them with
// the answers and nothing here needs R2, the one Cloudflare storage that bills.

export async function putBlob(code, bytes, mime) {
  return await poll(code).blobPut(randomId(), new Uint8Array(bytes), mime)
}

export async function getBlob(code, id) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(id))) return null
  return await poll(code).blobGet(String(id))
}

// --- the game layer: one synchronous method per op on the poll's object, so each
// check-and-write (a `first` move, a compare-and-set) is atomic ------------------

export async function gameRead(code, opts) { return await poll(code).gameRead(opts) }
export async function gameJoin(code, pid, name) { return await poll(code).gameJoin(pid, name) }
export async function gameMove(code, move) { return await poll(code).gameMove(move) }
export async function gameState(code, patch) { return await poll(code).gameState(patch) }
export async function gameKick(code, pid) { return await poll(code).gameKick(pid) }
export async function gameReset(code) { return await poll(code).gameReset() }

/** The public player id: 12 chars of base32(sha256("CODE:TOKEN")), lower case.
 *  Stable per phone and game, different across games, never the token. */
export function playerId(code, token) {
  const h = createHash('sha256').update(`${code}:${token}`).digest()
  const A = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = '', bits = 0, acc = 0
  for (const byte of h) {
    acc = ((acc << 8) | byte) & 0xfff; bits += 8
    while (bits >= 5 && out.length < 12) { out += A[(acc >>> (bits - 5)) & 31]; bits -= 5 }
    if (out.length >= 12) break
  }
  return out
}

export async function listBlobIds(code) { return await poll(code).blobIds() }
export async function deleteBlobs(code) { return await poll(code).blobsDelete() }

/** URL-safe, unguessable, and short enough to fit an answer alongside real
 *  text. 120 bits — these are effectively public capability URLs. */
function randomId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(15)))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
