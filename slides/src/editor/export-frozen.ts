// SPDX-License-Identifier: MIT
// Export → a frozen copy for the audience: every poll shows the results it
// collected and can no longer be answered, and the copy opens straight into
// the show with no editor. In-app counterpart of the skills' `publish.py
// students` (freeze_polls + build_students), minus the deck-specific options.

import type { Store } from '../store'
import { lecturerKey, newDocId, pollHost, setLecturerKey, type TesseraDoc, type PollElement, type Slide } from '../model'
import { fetchPoll } from '../poll'
import { serializeAuto, writeUpdatedFileAs } from '../save'
import { t } from '../i18n'
import { OFFLINE_OK_META } from '../legacy'

/** A page that calls the poll service cannot run in a copy without one,
 *  unless it says it can (`<meta name="tessera-offline-ok">`, the lab cards). */
const READS_SERVICE = /\/api\/(poll|cluster)/
const OFFLINE_OK = OFFLINE_OK_META

function pageText(v: unknown): string {
  if (typeof v !== 'string') return ''
  if (!v.startsWith('data:')) return v
  const [head, body = ''] = v.split(',', 2)
  try { return head.includes('base64') ? atob(body) : decodeURIComponent(body) } catch { return '' }
}

const readsService = (s: Slide, assets: Record<string, string>) =>
  s.elements.some((e) => {
    if (e.type !== 'embed') return false
    const page = pageText(assets[(e as any).asset])
    return READS_SERVICE.test(page) && !OFFLINE_OK.test(page)
  })

async function freezePolls(doc: TesseraDoc): Promise<number> {
  const at = new Date().toISOString()
  let n = 0
  for (const s of doc.slides) {
    for (const e of s.elements) {
      if (e.type !== 'poll' || e.frozen) continue
      const el = e as PollElement
      const kind = el.kind ?? 'open'
      if (!pollHost(el)) throw new Error(t('A poll on slide {n} has no poll service to read.', { n: doc.slides.indexOf(s) + 1 }))
      const st = await fetchPoll(el)
      if (st.answersWithheld && st.count && kind !== 'open') {
        throw new Error(t('The poll service withholds the answers — enter the lecturer key and export again.'))
      }
      el.frozen = { at, count: st.count }
      if (kind !== 'open') el.frozen.answers = st.answers.map((a: any) => String(a?.text ?? a ?? ''))
      else if (!el.summary && st.summary) el.summary = st.summary
      delete (el as any).service
      delete (el as any).requireName
      n++
    }
  }
  return n
}

/** The frozen document — a deep copy; the open deck is never touched. */
export async function frozenDoc(source: TesseraDoc): Promise<TesseraDoc> {
  const doc = JSON.parse(JSON.stringify(source)) as TesseraDoc
  const assets = (doc.assets ??= {}) as Record<string, string>
  const drop = new Set(doc.slides.filter((s) => (s as any).hidden || s.stateOf).map((s) => s.id))
  for (const s of doc.slides) if (!drop.has(s.id) && readsService(s, assets)) drop.add(s.id)
  for (const s of doc.slides) if (s.stateOf && drop.has(s.stateOf)) drop.add(s.id)
  doc.slides = doc.slides.filter((s) => !drop.has(s.id))
  if (!doc.slides.length) throw new Error(t('Nothing left to export: every slide is hidden or reads the poll service.'))
  for (const s of doc.slides) {
    s.elements = s.elements.filter((e) => !(e.link && drop.has(e.link)))
    delete s.comments // review notes and agent requests are not for the audience
  }
  await freezePolls(doc)
  // pages that run without the service learn they are in a frozen copy
  for (const s of doc.slides) for (const e of s.elements) {
    const key = e.type === 'embed' ? (e as any).asset : undefined
    const page = key && assets[key]
    if (page && !page.startsWith('data:') && OFFLINE_OK.test(page) && !/<html[^>]*data-offline/.test(page)) {
      assets[key] = page.replace(/<html\b/, '<html data-offline')
    }
  }
  for (const k of ['poll', 'collab', 'agentNotes', 'template'] as const) delete (doc as any)[k]
  doc.readonly = true
  doc.docId = newDocId()
  return doc
}

export async function exportFrozenCopy(store: Store, toast: (m: string) => void) {
  const hasPolls = store.doc.slides.some((s) => s.elements.some((e) => e.type === 'poll' && !(e as PollElement).frozen))
  // Asked before the picker, synchronously, so the click still counts as the
  // user's gesture. Empty is fine: an ungated service needs no key.
  if (hasPolls && !lecturerKey()) {
    const k = window.prompt(t('Lecturer key for this deck’s poll service (leave empty if it has none). It stays on this computer.'), '')
    if (k === null) return
    setLecturerKey(k)
  }
  try {
    const ok = await writeUpdatedFileAs(async () => serializeAuto(await frozenDoc(store.doc)), store.doc, { suffix: 'frozen' })
    if (ok) toast(t('Frozen copy saved — it opens straight into the show, with every poll showing its results'))
  } catch (err) {
    toast(String((err as Error)?.message ?? err))
  }
}
