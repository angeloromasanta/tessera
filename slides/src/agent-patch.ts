// Pure, compare-and-set document patches. IDs, never array offsets, address nodes.
export type Segment = string | { id: string }
export type Patch = { path: Segment[]; before?: unknown; value?: unknown; order?: true }
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const own = (v: object, k: string) => Object.prototype.hasOwnProperty.call(v, k)
export const clone = <T>(v: T): T => v === undefined ? v : JSON.parse(JSON.stringify(v))
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a), bk = Object.keys(b)
  return ak.length === bk.length && ak.every(k => own(b, k) && equal((a as any)[k], (b as any)[k]))
}
const ids = (v: any): v is { id: string }[] => Array.isArray(v) && v.every(x => x && typeof x.id === 'string')
function key(v: any, s: Segment): string | number {
  if (typeof s === 'string') {
    if (forbidden.has(s) || Array.isArray(v)) throw Error('invalid path')
    return s
  }
  if (!s || typeof s.id !== 'string' || !Array.isArray(v)) throw Error('invalid ID path')
  return v.findIndex(x => x?.id === s.id)
}
export function applyPatches<T>(source: T, patches: Patch[]): T {
  return applyPatchesInPlace(clone(source), patches)
}

/** applyPatches on `result` itself. A single patch either applies whole or
 *  throws before touching anything; a failing patch in a batch leaves the
 *  earlier ones applied (applyPatches' copy is what makes a batch atomic). */
export function applyPatchesInPlace<T>(result: T, patches: Patch[]): T {
  for (const p of patches) {
    if (!Array.isArray(p.path) || !p.path.length) throw Error('invalid path')
    let parent: any = result
    for (const s of p.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object') throw Error('missing parent')
      const k = key(parent, s)
      if (!own(parent, String(k))) throw Error('missing parent')
      parent = parent[k]
    }
    if (!parent || typeof parent !== 'object') throw Error('missing parent')
    const last = p.path[p.path.length - 1], k = key(parent, last)
    const actual = own(parent, String(k)) ? parent[k] : undefined
    if (p.order) {
      if (!ids(actual) || !equal(actual.map(x => x.id), p.before)) throw Error('order conflict')
      if (!Array.isArray(p.value) || new Set(p.value).size !== actual.length || p.value.length !== actual.length) throw Error('invalid order')
      const map = new Map(actual.map(x => [x.id, x]))
      if (!p.value.every(id => map.has(id))) throw Error('invalid order')
      parent[k] = p.value.map(id => map.get(id))
    } else {
      if (!equal(actual, p.before)) throw Error('value conflict')
      if (typeof last !== 'string') {
        if (p.value !== undefined && (p.value as any)?.id !== last.id) throw Error('ID mismatch')
        if (k === -1) {
          if (p.value !== undefined) parent.push(clone(p.value))
        } else if (p.value === undefined) parent.splice(k, 1)
        else parent[k] = clone(p.value)
      } else if (p.value === undefined) delete parent[k]
      else parent[k] = clone(p.value)
    }
  }
  return result
}

/** ID-aware differences are also conditional inverses for undo/redo. */
export function diff(before: any, value: any, path: Segment[] = []): Patch[] {
  if (equal(before, value)) return []
  if (ids(before) && ids(value)) {
    const out: Patch[] = []
    const a = new Map(before.map(x => [x.id, x])), b = new Map(value.map(x => [x.id, x]))
    for (const id of new Set([...a.keys(), ...b.keys()])) out.push(...diff(a.get(id), b.get(id), [...path, { id }]))
    const intermediate = [...before.filter(x => b.has(x.id)), ...value.filter(x => !a.has(x.id))].map(x => x.id)
    const target = value.map(x => x.id)
    if (!equal(intermediate, target)) out.push({ path, order: true, before: intermediate, value: target })
    return out
  }
  if (before && value && typeof before === 'object' && typeof value === 'object' && !Array.isArray(before) && !Array.isArray(value)) {
    return [...new Set([...Object.keys(before), ...Object.keys(value)])]
      .filter(k => !(path.length === 0 && (k === 'modified' || (k === 'collab' && before.docId === value.docId))))
      .flatMap(k => diff(before[k], value[k], [...path, k]))
  }
  return [{ path, before: clone(before), value: clone(value) }]
}
