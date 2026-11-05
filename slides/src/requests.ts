// SPDX-License-Identifier: MIT
// Agent change requests (typed in the slide list). They are review threads
// (Slide.comments, or doc.requests for the whole deck) flagged `request: true`, so they save with the file,
// sync between tabs and reach agents through the same patches as any edit.
// Nothing here assumes a particular agent: the contract is the document shape.

import type { TesseraDoc, Comment, Slide } from './model'

export type RequestStatus = 'open' | 'working' | 'done' | 'stopped'

export const requestStatus = (c: Comment): RequestStatus =>
  c.status === 'stopped' ? 'stopped' : c.resolved ? 'done' : c.status === 'working' ? 'working' : c.status === 'done' ? 'done' : 'open'

/** Finished: done, or stopped by the person. */
export const requestClosed = (c: Comment) => { const s = requestStatus(c); return s === 'done' || s === 'stopped' }

export interface RequestItem {
  /** '' for a request about the whole deck (doc.requests) */
  slideId: string
  /** -1 for a request about the whole deck */
  slideIndex: number
  id: string
  text: string
  author: string
  at: string
  status: RequestStatus
  elementIds: string[]
  replies: Array<{ id: string; author: string; text: string; at: string }>
  /** how many times the person edited it after sending (0 = never) */
  rev: number
}

const item = (c: Comment, slideId: string, slideIndex: number): RequestItem => ({
  slideId,
  slideIndex,
  id: c.id,
  text: c.text,
  author: c.author,
  at: c.at,
  status: requestStatus(c),
  elementIds: c.elementIds ?? (c.elementId ? [c.elementId] : []),
  replies: c.replies ?? [],
  rev: c.rev ?? 0,
})

/** Every request thread: the whole-deck ones first (doc.requests), then the
 *  slides' in slide order. */
export function listRequests(doc: TesseraDoc, opts: { open?: boolean } = {}): RequestItem[] {
  const keep = (c: Comment) => !!c.request && (!opts.open || !requestClosed(c))
  return [
    ...(doc.requests ?? []).filter(keep).map((c) => item(c, '', -1)),
    ...doc.slides.flatMap((s, slideIndex) => (s.comments ?? []).filter(keep).map((c) => item(c, s.id, slideIndex))),
  ]
}

/** The thread with this id and the list that holds it (a slide's comments or
 *  doc.requests), or null. */
export function findRequest(doc: TesseraDoc, id: string): { thread: Comment; slide: Slide | null } | null {
  const deck = (doc.requests ?? []).find((c) => c.id === id && c.request)
  if (deck) return { thread: deck, slide: null }
  for (const s of doc.slides) {
    const c = s.comments?.find((x) => x.id === id && x.request)
    if (c) return { thread: c, slide: s }
  }
  return null
}

/** Requests nobody has picked up yet — what the bridge reports as `pending`. */
export const pendingRequests = (doc: TesseraDoc): number =>
  listRequests(doc).filter((r) => r.status === 'open').length

/** How long a stop keeps waking listeners, so an agent busy on the request hears it. */
const STOP_SIGNAL_MS = 10 * 60_000

/**
 * What the editor reports to the bridge as `pendingIds` (each id wakes a
 * listener once): every open request; a request edited after it was sent, as
 * `id@rev` (so an edit wakes the listener again, also while the agent works on
 * it); a request the person stopped in the last 10 minutes, as `id!stop`.
 */
export function signalIds(doc: TesseraDoc, now = Date.now()): string[] {
  const out: string[] = []
  const threads = [...(doc.requests ?? []), ...doc.slides.flatMap((s) => s.comments ?? [])]
  for (const c of threads) {
    if (!c.request) continue
    const st = requestStatus(c)
    const id = c.rev ? `${c.id}@${c.rev}` : c.id
    if (st === 'open' || (st === 'working' && c.rev)) out.push(id)
    else if (st === 'stopped' && c.stoppedAt && now - Date.parse(c.stoppedAt) < STOP_SIGNAL_MS) out.push(`${c.id}!stop`)
  }
  return out
}
