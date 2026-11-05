// Folding a changed deck file into the open editor.
//
// The editor saves through the local bridge against the file version it last
// loaded or saved. When the file changed since (slide.py wrote it while this
// tab was not counted live, a recompile, another tab of the deck), the bridge
// refuses the save and hands back the file's document. Nothing is overwritten:
// the file's changes are replayed onto the editor's document as compare-and-set
// patches (agent-patch.ts) computed against the shared base. A change lands
// where the editor still holds the base value; where the editor changed the
// same thing, the editor's version is kept and the path is reported.

import type { TesseraDoc } from './model'
import { FORMAT } from './model'
import { LEGACY_SLIDES_FORMAT } from '../../kernel/src/legacy.ts'
import { applyPatchesInPlace, clone, diff, equal, type Patch, type Segment } from './agent-patch'

/** Identity and bookkeeping never come from the file: the tab keeps its own. */
const SKIP_ROOT = new Set(['docId', 'modified', 'collab', 'template'])

export interface Fold {
  doc: TesseraDoc
  /** file changes applied to the editor's document */
  applied: number
  /** paths where the file and the editor both changed: the editor's kept */
  kept: string[]
}

export class OtherDeckError extends Error {}

function valueAt(doc: unknown, path: Segment[]): { found: boolean; value?: unknown } {
  let node: any = doc
  for (const s of path) {
    if (!node || typeof node !== 'object') return { found: false }
    if (typeof s === 'string') {
      if (Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, s)) return { found: false }
      node = node[s]
    } else {
      if (!Array.isArray(node)) return { found: false }
      const i = node.findIndex((x) => x?.id === s.id)
      if (i < 0) return { found: false }
      node = node[i]
    }
  }
  return { found: true, value: node }
}

const fmt = (path: Segment[]) => path.map((s) => (typeof s === 'string' ? s : `#${s.id}`)).join('/')

/** The file's changes since `baseJson`, as patches. */
export function diskChanges(baseJson: string, diskJson: string): Patch[] {
  const base = JSON.parse(baseJson), disk = JSON.parse(diskJson)
  return diff(base, disk).filter((p) => !(typeof p.path[0] === 'string' && SKIP_ROOT.has(p.path[0])))
}

/**
 * `current` with the file's changes since `baseJson` folded in. Throws
 * OtherDeckError when the file now holds a different deck (another docId than
 * both the base and the editor), which must never be merged.
 */
export function foldDiskChanges(current: TesseraDoc, baseJson: string, diskJson: string): Fold {
  const disk = JSON.parse(diskJson)
  if (!disk || (disk.format !== FORMAT && disk.format !== LEGACY_SLIDES_FORMAT) || !Array.isArray(disk.slides)) throw new OtherDeckError('the file no longer holds a readable deck')
  const baseId = JSON.parse(baseJson)?.docId
  if (typeof disk.docId === 'string' && disk.docId && disk.docId !== current.docId && disk.docId !== baseId) {
    throw new OtherDeckError('the file on disk is now another deck (different docId)')
  }
  const theirs = diskChanges(baseJson, diskJson)
  const working = clone(current)
  let applied = 0
  const kept: string[] = []
  for (const p of theirs) {
    const at = valueAt(working, p.path)
    // Already there (this tab made the same change, or got it from another tab)
    if (p.order) {
      if (at.found && Array.isArray(at.value) && equal(at.value.map((x: any) => x?.id), p.value)) continue
    } else if (p.value === undefined ? !at.found : at.found && equal(at.value, p.value)) continue
    try {
      applyPatchesInPlace(working, [p])
      applied++
    } catch {
      kept.push(fmt(p.path))
    }
  }
  return { doc: working, applied, kept }
}
