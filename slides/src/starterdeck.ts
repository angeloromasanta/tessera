// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// The starter deck — what a shell opens with when it carries no document (a
// fresh build, or an empty #tessera-doc). Real decks start from template.html, so
// this only has to be a clean, neutral page to build on.

import { defaultText, emptySlide, newDoc, type TesseraDoc } from './model'

export function starterDoc(): TesseraDoc {
  const doc = newDoc()
  doc.title = 'Untitled deck'
  const { width, height } = doc.size
  const margin = 96
  doc.slides = [
    emptySlide({
      elements: [
        defaultText({
          id: 'starter-title', html: 'Untitled deck', fontSize: 64, fontWeight: 700,
          x: margin, y: height / 2 - 100, w: width - margin * 2, h: 110,
        }),
        defaultText({
          id: 'starter-sub', html: 'Ask the agent below the slide to build it.', fontSize: 26, color: '#5A6678',
          x: margin, y: height / 2 + 20, w: width - margin * 2, h: 60,
        }),
      ],
    }),
    emptySlide({
      elements: [
        defaultText({
          id: 'starter-title', html: 'A slide title', fontSize: 44, fontWeight: 700, align: 'left', valign: 'top',
          x: margin, y: 72, w: width - margin * 2, h: 80,
        }),
        defaultText({
          html: 'Double-click any text to edit it.', fontSize: 26, align: 'left', valign: 'top',
          x: margin, y: 180, w: width - margin * 2, h: 300,
        }),
      ],
    }),
  ]
  return doc
}
