// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Two FILES with one docId are one deck: the same tab-to-tab channel, live
// room and recovery slot, so opening `v2.html` beside `v3.html` quietly merges
// them. The id survives every way a file is usually copied (Explorer, "Save a
// copy…", a mail attachment), and nothing on screen showed it. This tells the
// author the moment it happens; the fix is "Make this file independent".
//
// Its own channel, not the sync one: sync frames are CRDT state and must not
// grow a field for chrome. Two tabs of the SAME file say the same address and
// stay silent — that is ordinary multi-window editing.

import type { Store } from './store'

interface Hello { file: string; name: string; reply?: boolean }

export function watchIdentity(store: Store, onClash: (otherName: string) => void): void {
  if (store.doc.readonly || typeof BroadcastChannel === 'undefined') return
  const file = location.href.split('#')[0]
  let name = file
  try { name = decodeURIComponent(location.pathname.split('/').pop() || file) } catch { /* keep the address */ }
  let docId = ''
  let ch: BroadcastChannel | null = null
  const told = new Set<string>()
  const join = () => {
    if (store.doc.docId === docId) return
    docId = store.doc.docId
    ch?.close()
    told.clear()
    ch = new BroadcastChannel(`tessera-ident-${docId}`)
    ch.onmessage = (ev) => {
      const hello = ev.data as Hello
      if (!hello || typeof hello.file !== 'string' || hello.file === file) return
      if (!hello.reply) ch?.postMessage({ file, name, reply: true } satisfies Hello)
      if (told.has(hello.file)) return
      told.add(hello.file)
      onClash(String(hello.name || hello.file))
    }
    ch.postMessage({ file, name } satisfies Hello)
  }
  join()
  store.on('doc', join)
}
