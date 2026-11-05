// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Figures under construction: keep the page IN THE FILE current.
//
// While a figure is being built its embed carries `devSrc`, the loopback URL
// of the source page on the skills' live server, and the edit canvas runs
// that. The page of record is still `assets[el.asset]` — what the show, a
// player file, a copy of the slide and a published deck all load. This module
// closes the gap between the two: it watches each source and copies every
// save into the asset, so a slide is never a pointer to a file on one machine.
//
// A slide written before `devSrc` existed has only a loopback `src`. It is
// adopted the first time its server answers: the page moves into an asset and
// the address becomes `devSrc`.

import type { TesseraDoc, EmbedElement } from './model'
import { isLoopbackUrl } from './model'
import type { Store } from './store'

const POLL_MS = 2000

/** `url(MANROPE)` in a figure source stands for the deck's own text font. */
function inlineFont(page: string, doc: TesseraDoc): string {
  if (!page.includes('url(MANROPE)')) return page
  const fonts = (doc.fonts ?? []).filter((f) => f.family === 'Manrope')
  fonts.sort((a, b) => Number(a.asset.includes('latin-ext')) - Number(b.asset.includes('latin-ext')))
  const uri = fonts.length ? doc.assets?.[fonts[0].asset] : ''
  return uri ? page.split('url(MANROPE)').join(`url(${uri})`) : page
}

function devEmbeds(doc: TesseraDoc): EmbedElement[] {
  const out: EmbedElement[] = []
  for (const slide of doc.slides) {
    for (const el of slide.elements) {
      if (el.type !== 'embed') continue
      if (isLoopbackUrl(el.devSrc) || (!el.asset && !el.html && isLoopbackUrl(el.src))) out.push(el)
    }
  }
  return out
}

function freshKey(doc: TesseraDoc, url: URL): string {
  const name = (url.pathname.split('/').pop() ?? 'figure').replace(/\.html?$/i, '').replace(/[^\w-]+/g, '-') || 'figure'
  let key = `page-${name}`
  for (let n = 2; doc.assets?.[key] !== undefined; n++) key = `page-${name}-${n}`
  return key
}

export function watchDevFigures(store: Store, flush: () => void): void {
  if (store.doc.readonly || location.protocol !== 'file:') return
  /** source URL → the signature its asset was last written from */
  const seen = new Map<string, string>()
  let running = false

  const pass = async () => {
    if (running || store.readOnly) return
    const urls = new Set(devEmbeds(store.doc).map((el) => el.devSrc || el.src!))
    if (!urls.size) return
    running = true
    try {
      for (const href of urls) {
        const url = new URL(href)
        const at = `${url.origin}/__live?`
        const path = encodeURIComponent(url.pathname)
        let sig: string, page: string
        try {
          const head = await fetch(`${at}p=${path}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) })
          if (!head.ok) continue
          sig = await head.text()
          if (seen.get(href) === sig) continue
          const body = await fetch(`${at}src=${path}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
          if (!body.ok) continue // a server from before `src=` — restart it
          page = await body.text()
        } catch {
          continue // no server: the bundled page is what the file has
        }
        const doc = store.doc
        page = inlineFont(page, doc)
        let changed = false
        for (const el of devEmbeds(doc)) {
          if ((el.devSrc || el.src) !== href) continue
          doc.assets = doc.assets ?? {}
          if (!el.asset) {
            el.asset = freshKey(doc, url)
            changed = true
          }
          if (!el.devSrc) {
            el.devSrc = el.src
            delete el.src
            changed = true
          }
          if (doc.assets[el.asset] !== page) {
            doc.assets[el.asset] = page
            changed = true
          }
        }
        seen.set(href, sig)
        if (changed) {
          // not a gesture of the author's: keep it out of undo
          store.sealHistory()
          store.touch()
          flush()
        }
      }
    } finally {
      running = false
    }
  }
  window.setInterval(() => { void pass() }, POLL_MS)
}
