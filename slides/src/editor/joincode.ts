// SPDX-License-Identifier: MIT
// The top bar's join-code button: the one code the room types for the whole
// deck (doc.poll.session). Same rules as the poll panel's field it replaces —
// the service is told first, because a name is a session only once it knows it.

import type { Store } from '../store'
import { isJoinCode, pollHost, pollSessionCode, remintPollCodes, toJoinCode, type PollElement } from '../model'
import { claimSession } from '../poll'
import { t } from '../i18n'

export function openJoinCodePop(store: Store, anchor: HTMLElement, toast: (m: string) => void) {
  document.querySelector('.ed-join-pop')?.remove()
  const doc = store.doc
  const firstPoll = doc.slides.flatMap((s) => s.elements).find((e) => e.type === 'poll') as PollElement | undefined
  const pop = document.createElement('div')
  pop.className = 'ed-menu ed-join-pop'
  const host = pollHost(firstPoll).replace(/^https?:\/\//, '')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = host
    ? t('The audience opens {host} and types this code. One code for the whole deck.', { host })
    : t('This deck has no poll service yet.')
  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.maxLength = 40
  input.value = doc.poll?.session ?? ''
  input.placeholder = t('e.g. my-class')
  const freshRow = document.createElement('label')
  freshRow.className = 'ed-join-fresh'
  const fresh = document.createElement('input')
  fresh.type = 'checkbox'
  freshRow.append(fresh, document.createTextNode(' ' + t('Start every question with an empty bucket')))
  const actions = document.createElement('div')
  actions.className = 'ed-join-actions'
  const random = document.createElement('button')
  random.className = 'ed-btn'
  random.textContent = t('New random code')
  random.addEventListener('click', () => { input.value = pollSessionCode() })
  const set = document.createElement('button')
  set.className = 'ed-btn ed-btn-primary'
  set.textContent = t('Set code')
  actions.append(random, set)
  pop.append(hint, input, freshRow, actions)

  const apply = async () => {
    const next = toJoinCode(input.value)
    input.value = next
    if (!isJoinCode(next)) { toast(t('A join code is 3 to 24 letters, digits or hyphens.')); return }
    const same = next === store.doc.poll?.session
    if (same && !fresh.checked) { pop.remove(); return }
    set.disabled = true
    try {
      const claimed = same ? { existed: false } : await claimSession(next, { force: true, el: firstPoll })
      store.commit(() => {
        ;(store.doc.poll ??= {}).session = next
        if (fresh.checked) for (const s of store.doc.slides) remintPollCodes(s.elements)
      })
      toast(claimed.existed
        ? t('Join code set. That name was already in use — a room still on it will follow this deck.')
        : fresh.checked ? t('Join code set, and every question starts empty.') : t('Join code set — the room joins with it from now on.'))
      pop.remove()
    } catch (err) {
      toast(String((err as Error)?.message ?? err))
    } finally {
      set.disabled = false
    }
  }
  set.addEventListener('click', () => void apply())
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Enter') void apply()
    if (ev.key === 'Escape') pop.remove()
  })

  const r = anchor.getBoundingClientRect()
  pop.style.position = 'fixed'
  pop.style.top = `${r.bottom + 6}px`
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`
  document.body.appendChild(pop)
  input.focus()
  input.select()
  const close = (ev: PointerEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      pop.remove()
      document.removeEventListener('pointerdown', close, true)
    }
  }
  setTimeout(() => document.addEventListener('pointerdown', close, true))
}
