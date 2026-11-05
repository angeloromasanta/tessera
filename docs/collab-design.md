# tessera-sync — the CRDT behind tab-to-tab sync

*Status, 2026-10-22: upstream built this for live collaboration over an
end-to-end-encrypted relay (upstream, v0.8–v1.0). The relay, Share,
signed writes, read-only viewers, invites and Offline mode were removed from
Tessera on 2026-10-22 (`DECISIONS.md`, "Upstream surface removed"). What
remains is the engine and its BroadcastChannel transport: tabs or files with
one `docId`, open in the same browser profile, merge their edits. The full
relay design and threat model are in git history
(`git log -- docs/collab-design.md`).*

Code: `slides/src/sync/crdt.ts` (engine), `slides/src/sync/session.ts` (store
bridge and BroadcastChannel), `scripts/test-sync.ts` (convergence rig — run it
after ANY change to `crdt.ts`).

## Why in-house

Yjs was the alternative. It would have needed the whole store mirrored into Y
types, moved undo to Y.UndoManager, and given the file a second, binary
representation opaque to agents. The document is unusually CRDT-friendly —
every slide and element already has a unique id, properties are scalars or
small JSON, and order is solved by fractional indexing — so a per-property LWW
engine of a few KB does the job with plain-JSON ops. LWW per property is also
the right semantic for slides: two people dragging one box resolve by recency,
not into a diagonal. Registers merging by max((lamport, actorId)) are
commutative, associative and idempotent; the risk is implementation
discipline, which the rig exists for.

## The document model as a CRDT

**Identity.** Each session instance gets a fresh random `actorId` (a reloaded
tab is a new replica; the engine skips its own ops on apply). Each op carries a
Lamport timestamp, bumped on every local op and raised to `max(local, seen)+1`
on every received one. `(lamport, actorId)` is the total order for all
conflict resolution. Wall-clock never decides anything.

**Node identity (v2).** Slides key by their id; element nodes key by the
**composite `slideId U+001F elementId`** (`elKey`). A bare element id is
deliberately not unique across slides — same id on many slides is the morph
idiom — so v1's bare-id keying collapsed those copies and replicas diverged.
An element node is pinned to one slide for life: a cross-slide move diffs as
`del(oldKey)+ins(newKey)`. The wire and saved sync state are versioned
(`SYNC_V = 2`); pre-v2 state is discarded on sight.

**Ops** (plain JSON):

```jsonc
{ "a": "actor", "l": 41, "op": "set", "sl": "slide-id", "el": "el-id", "k": "x", "v": 640 }
{ "a": "actor", "l": 42, "op": "ins", "kind": "element", "sl": "slide-id", "id": "el-new",
  "ord": "a0V", "node": { /* full element JSON */ } }
{ "a": "actor", "l": 43, "op": "del", "kind": "element", "id": "el-old" }
{ "a": "actor", "l": 44, "op": "ord", "id": "slide-2", "ord": "a1" }
```

- `set` — per-(node, key) LWW register: geometry, style, fx, notes, chart
  options, slide and doc-level props.
- `ins` — create with the full node payload and a fractional-index `ord`.
- `del` — tombstone; delete beats concurrent edits, un-delete is a fresh
  insert. Tombstones live in sync state, never in the document JSON.
- `ord` — LWW on a node's fractional index (slide order, element z-order).

**Order.** Fractional-index keys (short base-62 strings, jittered). The saved
arrays stay plain arrays sorted by them; the keys live in sync metadata, not
the format.

**Text.** `element.html` is a token RGA with deterministic content-hash seeds;
a generation duels plain `set`s as a unit. Table `rows` stays a whole-value
register.

## The differ is the bridge

No mutation site is instrumented. Every store mutation already flows through
`store.commit / touch`, so the session hooks that seam:

```
commit(mutate) → snapshot before/after → structural diff by id
              → ops (set/ins/del/ord) → BroadcastChannel
remote op     → surgical apply by id → store.emit(...) → existing listeners
```

Compare slides by id (skip identical ones), then elements by id, then
properties shallowly. The editor, canvas, comments and agent patches keep
mutating plain JSON. Remote batches replay without a flush unless a local edit
is pending (OVERVIEW.md gotcha 12).

## Limits

- **LWW surprises**: two tabs restyling one property at once → one wins
  silently. Different properties of one element both survive.
- **Same machine only**: BroadcastChannel spans one browser profile. Copies on
  another machine or browser do not meet.
- **The file is the source of truth**: the saved JSON is always the merged
  state and opens with no sync state at all. Plaintext `#tessera-doc`, the splice
  contract, ids-as-identity and pure-data documents are untouched — ops are
  data too.
