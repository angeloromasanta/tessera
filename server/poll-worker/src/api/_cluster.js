// The maths behind POST /api/cluster — pure functions, no I/O except the two
// OpenRouter calls at the bottom (embeddings, labels). Kept apart from the
// handler so each piece can be exercised on its own.
//
// Pipeline for one press of the slide's Cluster button:
//   embed (cached per answer) → k-means on cosine, k by silhouette → t-SNE map
//   → rotate onto the previous map → round onto a honeycomb (one answer per
//   cell, optimal assignment) → match theme ids to the previous run so colours
//   persist → LLM labels (keyword fallback).
// Units of the map: one hex-cell radius. Axial cell (q, r) sits at
// x = √3·(q + r/2), y = 1.5·r — the slide multiplies by its own cell size.

import { chatText } from './_model.js'

const SQ3 = Math.sqrt(3)

export function rng(seed) {
  let s = seed >>> 0 || 1
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
export function normalize(v) {
  let n = 0; for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

// A vector is stored on its answer document as base64 float32 — 6 KB for 1536
// dimensions, and read back only by this route (never by the 3-second poll).
export function encodeVec(v) { return Buffer.from(new Float32Array(v).buffer).toString('base64') }
export function decodeVec(s) {
  const u = new Uint8Array(Buffer.from(s, 'base64'))
  return Array.from(new Float32Array(u.buffer, 0, u.byteLength >> 2))
}

// ---- k-means (spherical: unit vectors, cosine) -------------------------------------
function kmeansOnce(X, k, r) {
  const n = X.length, d = X[0].length
  const C = [X[Math.floor(r() * n)]], D = new Float64Array(n).fill(Infinity)
  while (C.length < k) {                                   // k-means++ seeding
    let sum = 0
    for (let i = 0; i < n; i++) {
      D[i] = Math.min(D[i], Math.max(0, 1 - dot(X[i], C[C.length - 1])))
      sum += D[i] * D[i]
    }
    let t = r() * sum, j = 0
    for (; j < n - 1; j++) { t -= D[j] * D[j]; if (t <= 0) break }
    C.push(X[j])
  }
  const lab = new Int32Array(n).fill(-1)
  for (let it = 0; it < 60; it++) {
    let moved = 0
    for (let i = 0; i < n; i++) {
      let b = 0, bs = -2
      for (let c = 0; c < k; c++) { const s = dot(X[i], C[c]); if (s > bs) { bs = s; b = c } }
      if (lab[i] !== b) { lab[i] = b; moved++ }
    }
    const S = Array.from({ length: k }, () => new Float64Array(d)), cnt = new Int32Array(k)
    for (let i = 0; i < n; i++) { cnt[lab[i]]++; const s = S[lab[i]], x = X[i]; for (let j = 0; j < d; j++) s[j] += x[j] }
    for (let c = 0; c < k; c++) C[c] = cnt[c] ? normalize(S[c]) : X[Math.floor(r() * n)]
    if (!moved) break
  }
  let inertia = 0
  for (let i = 0; i < n; i++) inertia += 1 - dot(X[i], C[lab[i]])
  return { lab: Array.from(lab), C, inertia }
}

function silhouette(Dm, lab, k) {
  const n = lab.length
  let total = 0
  for (let i = 0; i < n; i++) {
    const sum = new Float64Array(k), cnt = new Int32Array(k)
    for (let j = 0; j < n; j++) if (j !== i) { sum[lab[j]] += Dm[i][j]; cnt[lab[j]]++ }
    const a = cnt[lab[i]] ? sum[lab[i]] / cnt[lab[i]] : 0
    let b = Infinity
    for (let c = 0; c < k; c++) if (c !== lab[i] && cnt[c]) b = Math.min(b, sum[c] / cnt[c])
    if (cnt[lab[i]] && b < Infinity) total += (b - a) / Math.max(a, b)
  }
  return total / n
}

/** k from 4..8 (fewer for few answers), the one with the best silhouette. */
export function clusterVectors(X, seed = 7) {
  const n = X.length
  const Dm = X.map((a) => X.map((b) => 1 - dot(a, b)))
  const kmax = Math.max(2, Math.min(8, Math.floor(n / 5)))
  const kmin = Math.min(n >= 20 ? 4 : 2, kmax)
  let best = null
  for (let k = kmin; k <= kmax; k++) {
    const r = rng(seed + k)
    let run = null
    for (let t = 0; t < 8; t++) { const x = kmeansOnce(X, k, r); if (!run || x.inertia < run.inertia) run = x }
    const s = silhouette(Dm, run.lab, k)
    if (!best || s > best.score) best = { ...run, k, score: s }
  }
  return { ...best, Dm }
}

// ---- t-SNE (exact; fine for the few hundred answers a room produces) ---------------
export function tsne(Dm, seed = 3, { perplexity = 15, iters = 750 } = {}) {
  const n = Dm.length
  if (n < 3) return Dm.map((_, i) => [i * 2, 0])
  const perp = Math.min(perplexity, (n - 1) / 3)
  const D2 = Dm.map((row) => row.map((d) => 2 * d))      // unit vectors: |a-b|² = 2(1-cos)
  const P = Array.from({ length: n }, () => new Float64Array(n))
  const target = Math.log(perp)
  for (let i = 0; i < n; i++) {                           // binary search each row's beta
    let lo = 0, hi = Infinity, beta = 1
    for (let t = 0; t < 60; t++) {
      let sum = 0, H = 0
      for (let j = 0; j < n; j++) if (j !== i) { const p = Math.exp(-D2[i][j] * beta); P[i][j] = p; sum += p }
      sum = sum || 1e-12
      for (let j = 0; j < n; j++) if (j !== i) { P[i][j] /= sum; if (P[i][j] > 1e-12) H -= P[i][j] * Math.log(P[i][j]) }
      if (Math.abs(H - target) < 1e-5) break
      if (H > target) { lo = beta; beta = hi === Infinity ? beta * 2 : (beta + hi) / 2 }
      else { hi = beta; beta = (beta + lo) / 2 }
    }
  }
  const Pj = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => Math.max((P[i][j] + P[j][i]) / (2 * n), 1e-12)))
  const r = rng(seed)
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())
  const Y = Array.from({ length: n }, () => [gauss() * 1e-2, gauss() * 1e-2])
  const V = Y.map(() => [0, 0]), G = Y.map(() => [1, 1])
  const lr = Math.max(n / 12 / 4, 50)
  const Q = Array.from({ length: n }, () => new Float64Array(n))
  for (let it = 0; it < iters; it++) {
    const ex = it < 250 ? 12 : 1, mom = it < 250 ? .5 : .8
    let qsum = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = Y[i][0] - Y[j][0], dy = Y[i][1] - Y[j][1], q = 1 / (1 + dx * dx + dy * dy)
      Q[i][j] = Q[j][i] = q; qsum += 2 * q
    }
    for (let i = 0; i < n; i++) {
      let gx = 0, gy = 0
      for (let j = 0; j < n; j++) if (j !== i) {
        const q = Q[i][j], m = (ex * Pj[i][j] - q / qsum) * q
        gx += m * (Y[i][0] - Y[j][0]); gy += m * (Y[i][1] - Y[j][1])
      }
      gx *= 4; gy *= 4
      for (const [d, g] of [[0, gx], [1, gy]]) {
        G[i][d] = Math.sign(g) === Math.sign(V[i][d]) ? G[i][d] * .8 : G[i][d] + .2
        if (G[i][d] < .01) G[i][d] = .01
        V[i][d] = mom * V[i][d] - lr * G[i][d] * g
      }
    }
    for (let i = 0; i < n; i++) { Y[i][0] += V[i][0]; Y[i][1] += V[i][1] }
    let mx = 0, my = 0; for (const y of Y) { mx += y[0]; my += y[1] }
    for (const y of Y) { y[0] -= mx / n; y[1] -= my / n }
  }
  return Y
}

/** Rotate (and if it fits better, mirror) Y so the answers it shares with the
 *  previous map land where they were — the plot must not spin on a re-cluster. */
export function alignTo(Y, prev) {
  const common = Y.map((y, i) => [y, prev[i]]).filter(([, p]) => p)
  if (common.length < 3) return Y
  const fit = (flip) => {
    let a = 0, b = 0
    for (const [[x, y], [px, py]] of common) { const fx = flip ? -x : x; a += fx * px + y * py; b += fx * py - y * px }
    const th = Math.atan2(b, a), c = Math.cos(th), s = Math.sin(th)
    const T = ([x, y]) => { const fx = flip ? -x : x; return [fx * c - y * s, fx * s + y * c] }
    let err = 0
    for (const [y, p] of common) { const t = T(y); err += (t[0] - p[0]) ** 2 + (t[1] - p[1]) ** 2 }
    return { T, err }
  }
  const A = fit(false), B = fit(true)
  return Y.map((A.err <= B.err ? A : B).T)
}

// ---- the honeycomb ----------------------------------------------------------------
export const cellXY = (q, r) => [SQ3 * (q + r / 2), 1.5 * r]
function lattice(P, pad = 3) {
  const ys = P.map((p) => p[1]), xs = P.map((p) => p[0])
  const r0 = Math.floor(Math.min(...ys) / 1.5) - pad, r1 = Math.ceil(Math.max(...ys) / 1.5) + pad
  const cells = []
  for (let r = r0; r <= r1; r++) {
    const q0 = Math.floor(Math.min(...xs) / SQ3 - r / 2) - pad, q1 = Math.ceil(Math.max(...xs) / SQ3 - r / 2) + pad
    for (let q = q0; q <= q1; q++) cells.push([q, r])
  }
  return cells
}
/** Optimal assignment (Hungarian, n ≤ m), cost(i, j) → column per row. */
function hungarian(cost, n, m) {
  const INF = 1e18, u = new Float64Array(n + 1), v = new Float64Array(m + 1)
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0
    const minv = new Float64Array(m + 1).fill(INF), used = new Uint8Array(m + 1)
    do {
      used[j0] = 1; const i0 = p[j0]; let delta = INF, j1 = 0
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta } else minv[j] -= delta }
      j0 = j1
    } while (p[j0] !== 0)
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1 } while (j0)
  }
  const out = new Int32Array(n)
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1
  return Array.from(out)
}
/** Scale a projection to comb size (with room between clouds) and round every
 *  point onto its own honeycomb cell. */
export function snap(Y, spread = 1.25) {
  const n = Y.length
  let ms = 0; for (const [x, y] of Y) ms += x * x + y * y
  const k = spread * Math.sqrt(n * 1.5 * SQ3 / (2 * Math.PI)) / (Math.sqrt(ms / n) || 1)
  const P = Y.map(([x, y]) => [x * k, y * k])
  const cells = lattice(P), XY = cells.map(([q, r]) => cellXY(q, r))
  const col = hungarian((i, j) => (P[i][0] - XY[j][0]) ** 2 + (P[i][1] - XY[j][1]) ** 2, n, cells.length)
  return col.map((j) => cells[j])
}
/** The free cell nearest a point (spiral search outward). */
export function nearestFree(x, y, taken) {
  const r0 = Math.round(y / 1.5), q0 = Math.round(x / SQ3 - r0 / 2)
  let best = null, bd = Infinity
  for (let rad = 0; rad < 40 && (!best || rad < 3 + Math.sqrt(bd)); rad++) {
    for (let r = r0 - rad; r <= r0 + rad; r++) for (let q = q0 - rad; q <= q0 + rad; q++) {
      if (taken.has(`${q},${r}`)) continue
      const [cx, cy] = cellXY(q, r), d = (cx - x) ** 2 + (cy - y) ** 2
      if (d < bd) { bd = d; best = [q, r] }
    }
  }
  return best
}

/** New theme ids take the previous run's id whose centre means the most similar
 *  thing, so a theme keeps its colour; unmatched themes get the lowest free ids. */
export function matchIds(C, prevC) {
  const k = C.length, ids = new Array(k).fill(-1)
  const prevIds = Object.keys(prevC).map(Number)
  if (prevIds.length) {
    const m = Math.max(k, prevIds.length)
    const col = hungarian((i, j) => (j < prevIds.length ? 1 - dot(C[i], prevC[prevIds[j]]) : 1), k, m)
    col.forEach((j, i) => { if (j < prevIds.length && dot(C[i], prevC[prevIds[j]]) > .3) ids[i] = prevIds[j] })
  }
  const used = new Set(ids.filter((x) => x >= 0))
  let next = 0
  for (let i = 0; i < k; i++) if (ids[i] < 0) { while (used.has(next)) next++; ids[i] = next; used.add(next) }
  return ids
}

export const centroid = (vs) => {
  const s = new Float64Array(vs[0].length)
  for (const v of vs) for (let j = 0; j < v.length; j++) s[j] += v[j]
  return normalize(s)
}
export const cosine = dot

// ---- OpenRouter -------------------------------------------------------------------
const OR = 'https://openrouter.ai/api/v1'
const headers = () => {
  const k = process.env.OPENROUTER_API_KEY
  if (!k) throw new Error('OPENROUTER_API_KEY is not set')
  const h = { authorization: `Bearer ${k}`, 'content-type': 'application/json', 'x-title': 'tessera audience polls' }
  if (process.env.PUBLIC_ORIGIN) h['http-referer'] = process.env.PUBLIC_ORIGIN.replace(/\/+$/, '')
  return h
}
export const EMBED_MODEL = () => process.env.EMBED_MODEL || 'openai/text-embedding-3-small'
export const LABEL_MODEL = () => process.env.LABEL_MODEL || 'anthropic/claude-sonnet-5'

export async function embed(texts) {
  const r = await fetch(`${OR}/embeddings`, { method: 'POST', headers: headers(),
    body: JSON.stringify({ model: EMBED_MODEL(), input: texts }) })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j?.data) throw new Error(`embeddings failed: ${j?.error?.message ?? r.status}`)
  return j.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding))
}

const STOP = new Set(('a an the and or of to in on for with by at from as is are be been being it its this that these those i me my we our you your ' +
  'he she they them their what which who how when where why can could would should will shall may might must do does did done have has had ' +
  'not no so than then too very just also more most much many some any all each every about into over under up down out off again ' +
  'want able like get getting use using used learn learning know better good make making way ways thing things one end').split(' '))
/** Fallback when the LLM is unavailable: each theme's most distinctive words. */
export function keywordLabels(groups) {
  const tok = (t) => t.toLowerCase().match(/[a-z][a-z'+-]{1,}/g)?.filter((w) => !STOP.has(w)) ?? []
  const df = new Map(), tf = {}
  for (const [id, texts] of Object.entries(groups)) {
    tf[id] = new Map()
    for (const w of new Set(texts.flatMap(tok))) df.set(w, (df.get(w) || 0) + 1)
    for (const w of texts.flatMap(tok)) tf[id].set(w, (tf[id].get(w) || 0) + 1)
  }
  const K = Object.keys(groups).length, out = {}
  for (const id of Object.keys(groups)) {
    const top = [...tf[id]].map(([w, f]) => [w, f * Math.log(1 + K / df.get(w))]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w)
    out[id] = top.join(' · ') || 'misc'
  }
  return out
}

/** groups: {themeId: [texts, most typical first]} → {themeId: label}. */
export async function llmLabels(question, groups) {
  const body = Object.entries(groups).map(([id, t]) =>
    `THEME ${id} (${t.length} answers)\n` + t.slice(0, 30).map((x) => `- ${x.slice(0, 160)}`).join('\n')).join('\n\n')
  const prompt = `${question ? `An audience answered the open question: "${question}"` : 'An audience answered an open question.'}\n\n` +
    'A clustering algorithm grouped the answers into the themes below (most typical answers first). Name each theme.\n' +
    'Rules: at most 4 words, sentence case (only the first word capitalised), plain and specific, in the respondents\' own terms; ' +
    'no generic words like "Various", "Miscellaneous" or "General"; every label clearly different from the others.\n' +
    'Reply with ONLY a JSON object mapping theme number to label, e.g. {"0": "Build AI agents"}.\n\n' + body
  const txt = await chatText({ model: LABEL_MODEL(), max: 400, temperature: .2, feature: 'audience polls', label: 'labels',
    messages: [{ role: 'user', content: prompt }] })
  const out = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  for (const id of Object.keys(groups)) if (!out[id]) throw new Error(`no label for theme ${id}`)
  return Object.fromEntries(Object.keys(groups).map((id) => [id, String(out[id]).slice(0, 60)]))
}

// ---- axes: place answers on the presenter's own axes (op "score") -----------------
// Each axis is {neg, pos, negDef?, posDef?}: two pole labels, optional one-line
// definitions. The LLM rates each answer -3..+3 per axis against that rubric, or
// null when the answer takes no stance on it; the slide then ranks answers that
// share a score by their embedding projection onto (pos pole − neg pole).

/** One pole as text for the embedding direction. */
export const poleText = (label, def) => (def ? `${label}: ${def}` : label)

/** The model that rates answers on the axes: LABEL_MODEL unless SCORE_MODEL says
 *  otherwise. Test before switching to a smaller one: claude-haiku-5.5 started
 *  thinking on this prompt, ran out of tokens and left half the room unrated
 *  (2026-10-08). */
export const SCORE_MODEL = () => process.env.SCORE_MODEL || LABEL_MODEL()

/** answers [{id,text}] → {id: [s0, s1?]} (integers -3..3 or null). One chat call.
 *  Answers are numbered in the prompt and the reply is keyed by that number: the
 *  wait is the model writing its reply, and echoing a 20-character id per answer
 *  made that reply several times longer than the scores in it. */
export async function llmScores(question, axes, answers) {
  const rubric = axes.map((a, k) =>
    `AXIS ${k} — ${a.neg} ↔ ${a.pos}\n  -3 = strongly ${a.neg}${a.negDef ? `: ${a.negDef}` : ''}\n  +3 = strongly ${a.pos}${a.posDef ? `: ${a.posDef}` : ''}\n` +
    '  0 = both equally.  null = no hint either way (e.g. only a tool name, "everything").').join('\n\n')
  const shape = axes.length === 1 ? '[s]' : '[s0, s1]'
  const prompt = `${question ? `An audience answered the open question: "${question}"` : 'An audience answered an open question.'}\n\n` +
    'Place every answer on each axis below. Judge what the respondent wants, not the words they happen to use. ' +
    'Read each pole as this audience would, in the context of the question. Use the whole scale; reserve ±3 for answers ' +
    'that are clearly and only one pole. Give a score whenever the answer leans either way, even slightly (±1); ' +
    'null only when it gives no hint at all, such as a bare tool name.\n\n' + rubric +
    `\n\nReply with ONLY a compact JSON object mapping answer number to ${shape}, each an integer -3..3 or null, e.g. {"1":${axes.length === 1 ? '[-2]' : '[-2,null]'}}.\n\nANSWERS\n` +
    answers.map((a, i) => `${i + 1}: ${a.text.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')
  // thinking gets its own headroom over this budget (_model.js)
  const txt = await chatText({ model: SCORE_MODEL(), max: 60 + answers.length * 24, temperature: 0, feature: 'audience polls', label: 'scores',
    messages: [{ role: 'user', content: prompt }] })
  const out = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  const ok = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(-3, Math.min(3, Math.round(+v))) : null)
  return Object.fromEntries(answers.map((a, i) => {
    const got = out[i + 1]
    const v = Array.isArray(got) ? got : [got]
    return [a.id, axes.map((_, k) => ok(v[k]))]
  }))
}
