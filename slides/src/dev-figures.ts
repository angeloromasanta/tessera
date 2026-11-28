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
//
// The poster follows too. A live frame cannot be rasterized, so thumbnails,
// print and the still slide show `poster`; the live server shoots the page's
// last state after each save settles (live.py v3), and this module makes that
// shot the poster, under the figure's own key (`img-NAME-poster`), so the
// thumbnail shows the figure as it is now and never a template's or an
// earlier version's picture.

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

/** A figure's own poster key: never a template's or another slide's picture. */
function posterKey(url: URL): string {
  const name = (url.pathname.split('/').pop() ?? 'figure').replace(/\.html?$/i, '').replace(/[^\w-]+/g, '-') || 'figure'
  return `img-${name}-poster`
}

function freshKey(doc: TesseraDoc, url: URL): string {
  const name = (url.pathname.split('/').pop() ?? 'figure').replace(/\.html?$/i, '').replace(/[^\w-]+/g, '-') || 'figure'
  let key = `page-${name}`
  for (let n = 2; doc.assets?.[key] !== undefined; n++) key = `page-${name}-${n}`
  return key
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** The figure's freshest poster from the live server, or null if none is new. */
async function fetchPoster(at: string, path: string, seen: Map<string, string>, href: string): Promise<string | null> {
  try {
    const head = await fetch(`${at}ps=${path}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) })
    if (!head.ok) return null // a server from before posters
    const sig = await head.text()
    if (!sig || seen.get(href) === sig) return null
    const body = await fetch(`${at}poster=${path}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    if (!body.ok) return null
    const uri = await blobToDataUrl(await body.blob())
    seen.set(href, sig)
    return uri.startsWith('data:image/') ? uri : null
  } catch {
    return null
  }
}

export function watchDevFigures(store: Store, flush: () => void): void {
  if (store.doc.readonly || location.protocol !== 'file:') return
  /** source URL → the signature its asset was last written from */
  const seen = new Map<string, string>()
  /** source URL → the signature of the poster last written from it */
  const seenPoster = new Map<string, string>()
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
        let sig: string, page: string | null = null
        try {
          // `ed=1`: the editor is watching this page, so the server keeps its poster current
          const head = await fetch(`${at}p=${path}&ed=1`, { cache: 'no-store', signal: AbortSignal.timeout(1500) })
          if (!head.ok) continue
          sig = await head.text()
          if (seen.get(href) !== sig) {
            const body = await fetch(`${at}src=${path}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
            if (!body.ok) continue // a server from before `src=` — restart it
            page = await body.text()
          }
        } catch {
          continue // no server: the bundled page is what the file has
        }
        const poster = await fetchPoster(at, path, seenPoster, href)
        if (page === null && poster === null) continue
        const doc = store.doc
        if (page !== null) page = inlineFont(page, doc)
        let changed = false
        for (const el of devEmbeds(doc)) {
          if ((el.devSrc || el.src) !== href) continue
          doc.assets = doc.assets ?? {}
          if (poster !== null) {
            const key = posterKey(url)
            if (doc.assets[key] !== poster) {
              doc.assets[key] = poster
              changed = true
            }
            if (el.poster !== `asset:${key}`) {
              el.poster = `asset:${key}`
              changed = true
            }
          }
          if (page === null) continue
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
        if (page !== null) seen.set(href, sig)
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
