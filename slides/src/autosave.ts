// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Facade: the IndexedDB auto-save/version store lives in the shared kernel now
// (kernel/src/autosave.ts). This path stays alive so slides code keeps
// importing './autosave' unchanged — see docs/PLATFORM.md §9.
//
// docContentKey stays HERE (not in the kernel): "what counts as content" is a
// per-app model question — it reads slides-specific fields the kernel must
// never see. Spaces/dash define their own beside their models.

import type { TesseraDoc } from './model'

export * from '../../kernel/src/autosave.ts'

/** The content that actually matters for "did this change" — excludes volatile
 *  fields (modified timestamp, collab sync state) that churn without a real edit. */
export function docContentKey(doc: TesseraDoc): string {
  return JSON.stringify([doc.title, doc.size, doc.theme, doc.slides, doc.layouts ?? null, doc.fonts ?? null, doc.assets ?? null, doc.requests ?? null])
}

/** Save completion must include identity and metadata too. Only timestamps and
 *  the derived CRDT checkpoint may churn without requiring another write. */
export function fileContentKey(doc: TesseraDoc): string {
  return JSON.stringify({ ...doc, modified: undefined,
    collab: doc.collab ? { ...doc.collab, sync: undefined } : undefined })
}
