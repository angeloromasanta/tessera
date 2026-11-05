// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Path-anchor helpers for the line/curve editor (lineedit.ts): read a path's
// anchors, sample a curve into editable anchors, and write anchors back as a
// smooth path. The visual motion-path editor that used to live here was
// reachable only from the properties panel and went with it.

const SVG_NS = 'http://www.w3.org/2000/svg'

type Pt = { x: number; y: number }

/** Anchor points out of a path string: the M point plus each segment end. */
export function parseAnchors(d: string): Pt[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const pts: Pt[] = []
  let i = 0
  let cmd = ''
  const arity: Record<string, number> = { M: 2, L: 2, T: 2, Q: 4, S: 4, C: 6 }
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t.toUpperCase()
      i++
      continue
    }
    const n = arity[cmd] ?? 2
    const nums = tokens.slice(i, i + n).map(Number)
    if (nums.length === n && nums.every((v) => !Number.isNaN(v))) {
      pts.push({ x: nums[n - 2], y: nums[n - 1] })
    }
    i += n
  }
  return pts
}

/** Smooth path through anchors (Catmull-Rom converted to cubic beziers). */
export function anchorsToPath(pts: Pt[]): string {
  if (!pts.length) return ''
  if (pts.length === 1) return `M ${r(pts[0].x)} ${r(pts[0].y)}`
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const c1x = P(i).x + (P(i + 1).x - P(i - 1).x) / 6
    const c1y = P(i).y + (P(i + 1).y - P(i - 1).y) / 6
    const c2x = P(i + 1).x - (P(i + 2).x - P(i).x) / 6
    const c2y = P(i + 1).y - (P(i + 2).y - P(i).y) / 6
    d += ` C ${r(c1x)} ${r(c1y)} ${r(c2x)} ${r(c2y)} ${r(P(i + 1).x)} ${r(P(i + 1).y)}`
  }
  return d
}

const r = (v: number) => Math.round(v * 100) / 100

/**
 * Anchors that PRESERVE the curve's shape: the path is sampled through the
 * browser (so beziers, arcs, relative commands and H/V/Z all work) and the
 * samples are reduced with Ramer–Douglas–Peucker. A hand-written single-C
 * curve like "M 0 0 C 122 0 133 140 255 140" yields interior anchors that
 * reproduce the S-bend — parseAnchors alone would flatten it to a line.
 */
export function samplePathAnchors(d: string): Pt[] {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  document.body.appendChild(svg)
  try {
    const total = path.getTotalLength()
    if (!Number.isFinite(total) || total < 1) return parseAnchors(d)
    const n = Math.min(256, Math.max(24, Math.ceil(total / 4)))
    const samples: Pt[] = []
    for (let i = 0; i <= n; i++) {
      const p = path.getPointAtLength((total * i) / n)
      samples.push({ x: p.x, y: p.y })
    }
    // Loosen tolerance until the anchor count is comfortable to edit.
    let eps = 0.75
    let pts = rdp(samples, eps)
    while (pts.length > 12) {
      eps *= 1.7
      pts = rdp(samples, eps)
    }
    return pts
  } catch {
    return parseAnchors(d)
  } finally {
    svg.remove()
  }
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice()
  const a = pts[0]
  const b = pts[pts.length - 1]
  let maxD = -1
  let idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b)
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= eps) return [a, b]
  const left = rdp(pts.slice(0, idx + 1), eps)
  const right = rdp(pts.slice(idx), eps)
  return left.slice(0, -1).concat(right)
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (!len) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len
}
