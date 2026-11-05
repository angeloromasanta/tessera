// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Font utilities: the curated system-stack choices offered in the editor,
// and @font-face injection for fonts embedded in the document's asset table.

import type { TesseraDoc } from './model'

/**
 * (Re)register @font-face rules for every embedded font in the document.
 * Idempotent — call at boot and again whenever a font is added.
 */
export function injectFonts(doc: TesseraDoc) {
  const css = (doc.fonts ?? [])
    .map((f) => {
      const src = doc.assets?.[f.asset]
      if (!src) return ''
      // `weight` goes through verbatim, so it takes a RANGE ("200 800") as
      // well as a number — that is how one variable-font file covers every
      // weight in the deck. `unicodeRange` lets a family be split across
      // subset files (latin, latin-ext, …), which is what keeps an embedded
      // typeface to tens of KB instead of hundreds.
      return `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(src)});` +
        `font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'};` +
        (f.unicodeRange ? `unicode-range:${f.unicodeRange};` : '') +
        'font-display:swap}'
    })
    .join('\n')
  let style = document.getElementById('tessera-fonts') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'tessera-fonts'
    document.head.appendChild(style)
  }
  style.textContent = css
}
