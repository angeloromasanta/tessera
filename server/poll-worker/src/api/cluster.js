// POST /api/cluster 🔒  — group a poll's open answers into labelled themes, on
// a map, for a slide that shows them as a honeycomb.
//
//   { code, op: "cluster", ids? }  → cluster these answers (default: all).
//       → { k, clusters:[{id,label,count}], answers:[{id,q,r,c,s}], threshold,
//           labelsBy: "llm"|"keywords", embedModel, labelModel, at }
//   { code, op: "assign", ids }    → place answers that arrived after the last
//       clustering: nearest theme (c = -1 "not yet sorted" when none is close),
//       on the free cell nearest their most similar answers. The saved themes
//       never change here — only a new "cluster" call regroups.
//       → { answers:[{id,q,r,c,s}] }
//   { code, op: "score", axes:[{neg,pos,negDef?,posDef?}] (1 or 2), ids? }
//       → place answers on the presenter's own axes: an LLM rates each answer
//       -3..+3 per axis (null = no stance), and each gets its projection onto
//       the embedding direction pos − neg (to order answers sharing a score).
//       Scores are cached on the poll as `scoreJson` for these exact axes, so
//       each answer is rated once; new axes re-rate everything.
//       → { axes, by: "llm"|"embeddings", answers:[{id, s:[..], e:[..]}] }
//
// The maths is in _cluster.js. Each answer is embedded once (OpenRouter,
// EMBED_MODEL) and the vector cached on its answer document; labels come from
// one chat call (LABEL_MODEL), with a keyword fallback so a failed model call
// still yields a usable slide. The last clustering is saved on the poll
// document as `clusterJson`, so "assign" and the next "cluster" (which keeps
// the map from spinning and the colours from shuffling) can build on it.
//
// Presenter-only: it spends money at the provider on every call.

import { preflight, json, body, badCode, denyLecturer, getPoll, setPoll, listAnswers, listVectors, putVectors } from './_lib.js'
import {
  embed, encodeVec, decodeVec, clusterVectors, tsne, alignTo, snap, cellXY, nearestFree,
  matchIds, centroid, cosine, llmLabels, keywordLabels, EMBED_MODEL, LABEL_MODEL, llmScores, poleText,
} from './_cluster.js'

async function vectorsFor(code, answers) {
  const cached = await listVectors(code)
  const missing = answers.filter((a) => !cached[a.id])
  if (missing.length) {
    const vs = await embed(missing.map((a) => a.text))
    const fresh = {}
    missing.forEach((a, i) => { fresh[a.id] = encodeVec(vs[i]) })
    await putVectors(code, fresh)
    Object.assign(cached, fresh)
  }
  const out = {}
  for (const [id, v] of Object.entries(cached)) out[id] = decodeVec(v)
  return out
}

const loadState = (poll) => { try { return JSON.parse(poll?.clusterJson || 'null') } catch { return null } }

/** Theme centres from a saved state: the mean vector of each theme's members. */
function centresOf(state, V) {
  const groups = {}
  for (const [id, [, , c]] of Object.entries(state?.cells ?? {})) if (c >= 0 && V[id]) (groups[c] ??= []).push(V[id])
  return Object.fromEntries(Object.entries(groups).map(([c, vs]) => [c, centroid(vs)]))
}

async function doCluster(code, poll, answers, all) {
  // embed the whole bucket, not just the answers on screen: the ones still to be
  // shown are then placed by "assign" without another embeddings round-trip
  const V = await vectorsFor(code, all)
  const X = answers.map((a) => V[a.id])
  const prev = loadState(poll)
  const { lab, C, k, Dm } = clusterVectors(X)
  const ids = matchIds(C, centresOf(prev, V))
  const theme = lab.map((l) => ids[l])
  const sim = X.map((x, i) => cosine(x, C[lab[i]]))
  // "close to a theme" = at least as typical as the least-typical 5% of members
  const sorted = [...sim].sort((a, b) => a - b)
  const threshold = sorted[Math.floor(sorted.length * .05)] ?? 0

  let Y = tsne(Dm)
  if (prev?.cells) Y = alignTo(Y, answers.map((a) => (prev.cells[a.id] ? cellXY(prev.cells[a.id][0], prev.cells[a.id][1]) : null)))
  const cells = snap(Y)

  const groups = {}
  answers.map((a, i) => i).sort((i, j) => sim[j] - sim[i]).forEach((i) => { (groups[theme[i]] ??= []).push(answers[i].text) })
  let labels, labelsBy = 'llm'
  try { labels = await llmLabels(poll?.question ?? '', groups) }
  catch { labels = keywordLabels(groups); labelsBy = 'keywords' }

  const state = {
    at: new Date().toISOString(), threshold, labels, labelsBy,
    cells: Object.fromEntries(answers.map((a, i) => [a.id, [cells[i][0], cells[i][1], theme[i], +sim[i].toFixed(3)]])),
  }
  await setPoll(code, { clusterJson: JSON.stringify(state) })
  const count = {}
  theme.forEach((t) => { count[t] = (count[t] || 0) + 1 })
  return {
    k, threshold: +threshold.toFixed(3), labelsBy, embedModel: EMBED_MODEL(), labelModel: labelsBy === 'llm' ? LABEL_MODEL() : null, at: state.at,
    clusters: Object.keys(groups).map(Number).sort((a, b) => a - b).map((id) => ({ id, label: labels[id], count: count[id] })),
    answers: answers.map((a, i) => ({ id: a.id, q: cells[i][0], r: cells[i][1], c: theme[i], s: +sim[i].toFixed(3) })),
  }
}

async function doAssign(code, poll, answers) {
  const state = loadState(poll)
  if (!state?.cells) return { error: 'nothing clustered yet' }
  const fresh = answers.filter((a) => !state.cells[a.id])
  const out = answers.filter((a) => state.cells[a.id]).map((a) => {
    const [q, r, c, s] = state.cells[a.id]; return { id: a.id, q, r, c, s }
  })
  if (fresh.length) {
    const V = await vectorsFor(code, fresh)
    const centres = centresOf(state, V)
    const taken = new Set(Object.values(state.cells).map(([q, r]) => `${q},${r}`))
    const placed = Object.keys(state.cells).filter((id) => V[id])
    for (const a of fresh) {
      const v = V[a.id]
      let c = -1, s = -1
      for (const [id, ctr] of Object.entries(centres)) { const x = cosine(v, ctr); if (x > s) { s = x; c = Number(id) } }
      if (s < state.threshold) c = -1
      // where it belongs: the mean cell of its 5 most similar placed answers
      const near = placed.map((id) => [id, cosine(v, V[id])]).sort((p, q) => q[1] - p[1]).slice(0, 5)
      let x = 0, y = 0
      for (const [id] of near) { const [cx, cy] = cellXY(state.cells[id][0], state.cells[id][1]); x += cx; y += cy }
      const [q, r] = nearestFree(x / (near.length || 1), y / (near.length || 1), taken)
      taken.add(`${q},${r}`); placed.push(a.id)
      state.cells[a.id] = [q, r, c, +s.toFixed(3)]
      out.push({ id: a.id, q, r, c, s: +s.toFixed(3) })
    }
    await setPoll(code, { clusterJson: JSON.stringify(state) })
  }
  return { answers: out }
}

/** Axes from the request, cleaned: 1 or 2 of {neg, pos, negDef, posDef}. */
function cleanAxes(raw) {
  if (!Array.isArray(raw)) return null
  const t = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const axes = raw.slice(0, 2).map((a) => ({ neg: t(a?.neg, 40), pos: t(a?.pos, 40), negDef: t(a?.negDef, 200), posDef: t(a?.posDef, 200) }))
  return axes.length && axes.every((a) => a.neg && a.pos) ? axes : null
}

async function doScore(code, poll, answers, axes) {
  const sig = JSON.stringify(axes)
  let state = null
  try { state = JSON.parse(poll?.scoreJson || 'null') } catch {}
  if (state?.sig !== sig) state = { sig, by: 'llm', scores: {} }
  const fresh = answers.filter((a) => !state.scores[a.id])
  if (fresh.length) {
    // The room is waiting on this, so nothing queues behind anything else: the
    // two embedding calls and every rating call leave together, and the wait is
    // the slowest of them rather than their sum.
    // Batches of 20: half the wait of 40, and still enough answers in view for
    // the model to use the scale evenly (at 12 the scores drifted). Ten at a
    // time covers 200 answers in one round.
    const S = {}
    const batches = []
    for (let i = 0; i < fresh.length; i += 20) batches.push(fresh.slice(i, i + 20))
    let failed = false
    const rate = async () => {
      for (let i = 0; i < batches.length; i += 10) {
        const got = await Promise.all(batches.slice(i, i + 10).map((b) => llmScores(poll?.question ?? '', axes, b).catch(() => null)))
        got.forEach((g) => { if (g) Object.assign(S, g); else failed = true })
      }
    }
    const [V, poles] = await Promise.all([
      vectorsFor(code, fresh),
      embed(axes.flatMap((a) => [poleText(a.neg, a.negDef), poleText(a.pos, a.posDef)])),
      rate(),
    ])
    const dirs = axes.map((_, k) => poles[2 * k + 1].map((x, j) => x - poles[2 * k][j]))
    const proj = Object.fromEntries(fresh.map((a) => [a.id, dirs.map((d) => +cosine(V[a.id], d).toFixed(4))]))
    // an answer the LLM could not rate is binned from its projection instead
    // (z-scored over every projection known for these axes)
    const all = [...Object.values(state.scores).map((v) => v.e), ...Object.values(proj)]
    const stat = axes.map((_, k) => {
      const xs = all.map((e) => e[k]), m = xs.reduce((s, x) => s + x, 0) / xs.length
      return [m, Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) || 1]
    })
    for (const a of fresh) {
      const e = proj[a.id]
      const s = S[a.id] ?? e.map((x, k) => Math.max(-3, Math.min(3, Math.round((x - stat[k][0]) / stat[k][1] * 1.3))))
      state.scores[a.id] = { s, e }
    }
    if (failed) state.by = 'embeddings'
    await setPoll(code, { scoreJson: JSON.stringify(state) })
  }
  return { axes, by: state.by, answers: answers.map((a) => ({ id: a.id, ...state.scores[a.id] })) }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  if (denyLecturer(req, res)) return
  const b = body(req)
  const code = String(b.code ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })
  const op = ['assign', 'score'].includes(b.op) ? b.op : 'cluster'
  const axes = op === 'score' ? cleanAxes(b.axes) : null
  if (op === 'score' && !axes) return json(res, 400, { error: 'axes: 1 or 2 of {neg, pos}' })
  try {
    const [poll, all] = await Promise.all([getPoll(code), listAnswers(code)])
    const want = Array.isArray(b.ids) ? new Set(b.ids.map(String)) : null
    const answers = all.filter((a) => a.text.trim() && (!want || want.has(a.id)))
    if (op === 'cluster' && answers.length < 3) return json(res, 400, { error: 'need at least 3 answers to cluster' })
    if (!answers.length) return json(res, 200, { answers: [] })
    const out = op === 'cluster' ? await doCluster(code, poll, answers, all.filter((a) => a.text.trim()))
      : op === 'score' ? await doScore(code, poll, answers, axes) : await doAssign(code, poll, answers)
    if (out.error) return json(res, 409, out)
    return json(res, 200, out)
  } catch (e) {
    return json(res, 502, { error: String(e?.message ?? e) })
  }
}
