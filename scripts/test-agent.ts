import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { LEGACY_DOC_ID } from '../kernel/src/legacy.ts'
import { Store } from '../slides/src/store'
import { AgentEditor } from '../slides/src/agent-editor'
import { applyPatches, clone, diff } from '../slides/src/agent-patch'
import { SyncState } from '../slides/src/sync/crdt'
import { fileContentKey } from '../slides/src/autosave'
import type { TesseraDoc } from '../slides/src/model'

const base = (): TesseraDoc => ({
  format: 'tessera/slides', version: 1, docId: 'test', title: 'Test', modified: 'before',
  size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#000', accent: '#00f', fontFamily: 'Arial' },
  assets: {}, collab: { room: 'private', key: 'secret' },
  slides: ['a', 'b'].map(id => ({ id, background: '#fff', transition: 'fade', notes: '', elements: [
    { id: 'text', type: 'text', x: 0, y: 0, w: 100, h: 100, html: 'before', fontSize: 20 },
  ] })),
} as TesseraDoc)
const textPath = (id = 'a') => ['slides', { id }, 'elements', { id: 'text' }, 'html']
let checks = 0
function test(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
function setup() {
  const store = new Store(base()); let busy = false, flushes = 0
  const agent = new AgentEditor(store, () => busy, () => { flushes++ })
  let count = 0
  const request = (patches: any[]) => ({ id: `r${++count}`, docId: 'test', agent: 'Agent A', patches })
  return { store, agent, request, busy: (b: boolean) => { busy = b }, flushes: () => flushes }
}
test('CAS transaction merges independent human edits and redacts credentials', () => {
  const { store, agent, request, flushes } = setup()
  store.commit(() => { store.doc.slides[1].notes = 'human' })
  const r = request([{ path: textPath(), before: 'before', value: 'agent' }])
  assert.equal(agent.apply(r).status, 'applied')
  assert.equal(store.doc.slides[1].notes, 'human')
  assert.equal(agent.read().doc.collab, undefined)
  assert.equal(store.doc.collab?.key, 'secret')
  assert.equal(flushes(), 1)
  assert.equal(agent.apply(r).status, 'applied')
  assert.equal(flushes(), 1)
  assert.equal(agent.apply({ ...r, agent: 'changed' }).status, 'invalid')
})
test('an edit names the slides it touched and leaves the others in place', () => {
  const { store, agent, request } = setup()
  const untouched = store.doc.slides[1], theme = store.doc.theme
  const seen: (string[] | null)[] = []
  store.on('doc', () => seen.push(store.scope && [...store.scope]))
  agent.apply(request([{ path: textPath(), before: 'before', value: 'agent' }]))
  assert.deepEqual(seen, [['a']])
  assert.equal(store.doc.slides[1], untouched)
  assert.equal(store.doc.theme, theme)
  assert.equal(store.scope, null)
  // Wider changes redraw everything: theme, slide order, a replaced asset in use.
  agent.apply(request([{ path: ['theme', 'accent'], before: '#00f', value: '#f00' }]))
  agent.apply(request([{ path: ['slides'], order: true, before: ['a', 'b'], value: ['b', 'a'] }]))
  agent.apply(request([{ path: ['assets', 'pic'], value: 'one' }]))
  agent.apply(request([{ path: ['slides', { id: 'b' }, 'background'], before: '#fff', value: 'asset:pic' }]))
  agent.apply(request([{ path: ['assets', 'pic'], before: 'one', value: 'two' }]))
  assert.deepEqual(seen.slice(1), [null, null, [], ['b'], ['b']])
})
test('conflicting multi-operation batch changes nothing', () => {
  const { store, agent, request } = setup(), before = clone(store.doc)
  assert.equal(agent.apply(request([
    { path: ['title'], before: 'Test', value: 'partial' },
    { path: textPath(), before: 'stale', value: 'lost' },
  ])).status, 'conflict')
  assert.deepEqual(store.doc, before)
})
test('busy retries, readonly and document identity', () => {
  const { store, agent, request, busy } = setup()
  const r = request([{ path: textPath(), before: 'before', value: 'after' }])
  busy(true); assert.equal(agent.apply(r).status, 'busy')
  busy(false); assert.equal(agent.apply(r).status, 'applied')
  store.readOnly = true
  assert.equal(agent.apply(request([{ path: ['title'], before: 'Test', value: 'x' }])).status, 'readonly')
  store.readOnly = false
  assert.equal(agent.apply({ ...r, id: 'new', docId: 'other' }).status, 'invalid')
})
test('insert, reorder and remove preserve selection and current slide', () => {
  const { store, agent, request } = setup()
  store.goTo(1); store.select(['text'])
  const c = { ...clone(store.doc.slides[0]), id: 'c' }
  assert.equal(agent.apply(request([
    { path: ['slides', { id: 'c' }], value: c },
    { path: ['slides'], order: true, before: ['a', 'b', 'c'], value: ['c', 'a', 'b'] },
  ])).status, 'applied')
  assert.equal(store.slide.id, 'b'); assert.deepEqual(store.selection, ['text'])
  assert.equal(agent.apply(request([{ path: ['slides', { id: 'c' }], before: c }])).status, 'applied')
  assert.equal(store.slide.id, 'b')
  const original = clone(store.doc.slides[0]); store.doc.slides[0].notes = 'human'
  assert.equal(agent.apply(request([{ path: ['slides', { id: 'a' }], before: original }])).status, 'conflict')
})
test('undo and redo preserve unrelated remote changes', () => {
  const { store, agent, request } = setup()
  agent.apply(request([{ path: textPath(), before: 'before', value: 'agent' }]))
  store.sealHistory(); store.doc.slides[1].notes = 'remote'
  store.undo()
  assert.equal((store.doc.slides[0].elements[0] as any).html, 'before')
  assert.equal(store.doc.slides[1].notes, 'remote')
  store.redo()
  assert.equal((store.doc.slides[0].elements[0] as any).html, 'agent')
  assert.equal(store.doc.slides[1].notes, 'remote')
})
test('conflicting undo is atomic and explicit', () => {
  const { store, agent, request } = setup(); let conflicts = 0
  store.on('historyConflict', () => { conflicts++ })
  agent.apply(request([{ path: textPath(), before: 'before', value: 'agent' }]))
  ;(store.doc.slides[0].elements[0] as any).html = 'remote'
  const before = clone(store.doc)
  store.undo(); assert.deepEqual(store.doc, before); assert.equal(conflicts, 1)
})
test('human continuous-input history excludes later agent edits', () => {
  const { store, agent, request } = setup()
  store.checkpoint(); store.doc.slides[0].notes = 'typing'; store.touch()
  store.doc.slides[0].notes = 'typed'; store.touch()
  agent.apply(request([{ path: textPath('b'), before: 'before', value: 'agent' }]))
  store.undo(); store.undo()
  assert.equal(store.doc.slides[0].notes, '')
  store.redo(); store.redo()
  assert.equal(store.doc.slides[0].notes, 'typed')
  assert.equal((store.doc.slides[1].elements[0] as any).html, 'agent')
})
test('invalid geometry, duplicate IDs, protected properties and prototype paths', () => {
  const { store, agent, request } = setup(), before = clone(store.doc)
  assert.equal(agent.apply(request([{ path: ['collab', 'key'], before: 'secret', value: 'bad' }])).status, 'invalid')
  assert.equal(agent.apply(request([{ path: ['slides'], before: store.doc.slides, value: [] }])).status, 'invalid')
  assert.equal(agent.apply(request([{ path: ['slides', { id: 'a' }, 'elements', { id: 'text' }, 'w'], before: 100, value: 'bad' }])).status, 'invalid')
  assert.equal(agent.apply(request([{ path: ['assets', '__proto__'], value: { polluted: true } }])).status, 'conflict')
  assert.deepEqual(store.doc, before)
  assert.equal(({} as any).polluted, undefined)
})
test('conditional diff roundtrips structure, assets and fields', () => {
  const before = base(), after = clone(before)
  after.slides.reverse(); after.slides[0].notes = 'changed'; after.assets!.picture = 'data:image/png;base64,AA=='
  after.slides.push({ ...clone(after.slides[0]), id: 'c' })
  assert.deepEqual(applyPatches(before, diff(before, after)), after)
  assert.deepEqual(applyPatches(after, diff(after, before)), before)
})
test('accepted agent edits synchronize through the existing CRDT', () => {
  const { store, agent, request } = setup()
  const before = clone(store.doc), peer = clone(before)
  const sender = new SyncState('sender'), receiver = new SyncState('receiver')
  sender.adopt(before); receiver.adopt(peer)
  agent.apply(request([{ path: textPath(), before: 'before', value: 'agent' }]))
  receiver.apply(peer, sender.diff(before, store.doc))
  assert.deepEqual(peer.slides, store.doc.slides)
})
test('existing template document validates without changing its content or identity', () => {
  // the repo's template when there is one, else a small fixture deck; either
  // block name (a template not yet re-hosted carries the old one)
  const file = existsSync('template.html') ? 'template.html' : 'scripts/fixtures/deck.html'
  const html = readFileSync(file, 'utf8')
  const block = new RegExp(`id="(?:tessera-doc|${LEGACY_DOC_ID})">([\\s\\S]*?)<\\/script>`)
  const doc = JSON.parse(html.match(block)![1])
  const store = new Store(doc), original = clone(doc)
  const agent = new AgentEditor(store, () => false, () => {})
  const result = agent.apply({ id: 'template', docId: doc.docId, agent: 'test', patches: [{ path: ['title'], before: doc.title, value: 'Test edit' }] })
  assert.equal(result.status, 'applied', result.message)
  assert.deepEqual(store.doc.slides, original.slides)
  assert.equal(store.doc.docId, original.docId)
})
test('notification failures preserve delivery deduplication', () => {
  const store = new Store(base())
  const agent = new AgentEditor(store, () => false, () => { throw Error('test flush failure') })
  const request = { id: 'notify', docId: 'test', agent: 'test', patches: [{ path: ['title'], before: 'Test', value: 'Edited' }] }
  assert.equal(agent.apply(request).status, 'applied')
  assert.match(agent.apply(request).message!, /notification failed/)
  store.undo(); assert.equal(store.doc.title, 'Test')
})
test('save completion detects concurrent metadata and identity edits', () => {
  const before = base(), after = clone(before)
  after.modified = 'later'
  assert.equal(fileContentKey(before), fileContentKey(after))
  after.meta = { author: 'Human' }
  assert.notEqual(fileContentKey(before), fileContentKey(after))
  delete after.meta; after.docId = 'another-document'
  assert.notEqual(fileContentKey(before), fileContentKey(after))
})
console.log(`${checks} agent tests passed`)
