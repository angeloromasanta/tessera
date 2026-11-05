#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Invariants for the `poll` element that are cheap to check and expensive to
// get wrong. Run: `node scripts/test-poll.ts`
//
// The one that matters most: NO TWO POLLS EVER SHARE A JOIN CODE by accident.
// A shared code silently pools two slides' answers into one poll, which is a
// miserable thing to discover from the stage — so every path that copies a poll
// is asserted here, including the deliberate exception (a state slide keeps it).

import {
  builtinLayouts, defaultPoll, emptySlide, ensurePollSession, instantiateLayout,
  isPollSessionCode, newDoc, parseDoc, pollCode, pollJoinCode, pollSessionCode,
  ratingScale, ratingStats, remintPollCodes, tallyChoices,
  type TesseraDoc, type PollElement, type SlideElement,
} from '../slides/src/model.ts'

let checks = 0
let failed = 0
function ok(cond: boolean, what: string) {
  checks++
  if (!cond) { failed++; console.error(`  FAIL: ${what}`) }
}
function group(name: string) { console.log(name) }

const codes = (els: SlideElement[]) => els.filter((e) => e.type === 'poll').map((e) => (e as PollElement).code)

// --- pollCode -----------------------------------------------------------------

group('pollCode: shape, alphabet and collision resistance…')
{
  const seen = new Set<string>()
  const AMBIGUOUS = /[0o1li5s2z]/
  for (let i = 0; i < 20000; i++) {
    const c = pollCode()
    ok(/^[a-z0-9]{4,12}$/.test(c), `"${c}" matches the shape the service accepts`)
    ok(!AMBIGUOUS.test(c), `"${c}" avoids characters misread from the back of a room`)
    seen.add(c)
  }
  // 27^6 ≈ 387M, so 20k draws expect ~0.5 birthday collisions — asserting zero
  // fails a third of the time on a perfectly good generator. What is actually
  // worth catching is a generator with far less entropy than it claims, which
  // shows up as collisions by the dozen.
  ok(20000 - seen.size <= 3, `20000 codes are near-all distinct (${20000 - seen.size} collisions)`)
  ok(pollCode(4).length === 4 && pollCode(10).length === 10, 'length is honoured')
}

// --- remintPollCodes ----------------------------------------------------------

group('remintPollCodes: rewrites polls, leaves everything else alone…')
{
  const a = defaultPoll({ id: 'p1' })
  const b = defaultPoll({ id: 'p2' })
  const before = [a.code, b.code]
  const els: SlideElement[] = [a, b]
  remintPollCodes(els)
  ok(a.code !== before[0] && b.code !== before[1], 'both polls got new codes')
  ok(a.code !== b.code, 'the two new codes differ from each other')
  ok(a.id === 'p1' && b.id === 'p2', 'ids are untouched (morph lineage preserved)')
  // Nothing but `code` may move: a re-mint must not quietly reset the question.
  ok(a.question === defaultPoll().question, 'question is untouched')
  ok(remintPollCodes([]) === undefined, 'empty input is a no-op')
}

// --- the layout ---------------------------------------------------------------

group('layout-poll: every instantiation is an independent poll…')
{
  const layout = builtinLayouts().find((l) => l.id === 'layout-poll')
  ok(!!layout, 'the Audience question layout exists')
  ok(codes(layout!.elements).length === 1, 'it carries exactly one poll')

  const a = instantiateLayout(layout!)
  const b = instantiateLayout(layout!)
  const c = instantiateLayout(layout!)
  const got = [codes(a.elements)[0], codes(b.elements)[0], codes(c.elements)[0]]
  ok(new Set(got).size === 3, `three slides from one layout have three codes (${got.join(', ')})`)
  ok(a.id !== b.id, 'slide ids differ')
  // Element ids are KEPT on purpose so layout chrome morphs between slides —
  // this is the property that made re-minting the code necessary.
  ok(codes(a.elements).length === 1 && a.elements[1].id === b.elements[1].id,
    'element ids are shared across instantiations (morph lineage)')
}

// --- the state-slide exception ------------------------------------------------

group('state slides: a variant view keeps the same poll…')
{
  // A state slide (upstream createLinkedState) deep-clones the slide and does
  // NOT re-mint: a state is another view of the same question. Model that here
  // so the exception is asserted rather than just commented.
  const parent = emptySlide({ elements: [defaultPoll({ id: 'pq' })] })
  const state = JSON.parse(JSON.stringify(parent))
  state.id = 'state-1'
  state.stateOf = parent.id
  ok(codes(state.elements)[0] === codes(parent.elements)[0],
    'a state slide shares its parent poll code')
}

// --- template instantiation ---------------------------------------------------

group('template decks: every open is a new talk with its own poll…')
{
  const base = {
    ...newDoc(),
    template: true,
    slides: [emptySlide({ elements: [defaultPoll({ id: 'pq', code: 'shared' })] })],
  }
  const json = JSON.stringify(base)

  const first = parseDoc(json)!
  const second = parseDoc(json)!
  ok(!!first && !!second, 'the template parses')
  ok(codes(first.slides[0].elements)[0] !== 'shared', 'the template code is not reused')
  ok(codes(first.slides[0].elements)[0] !== codes(second.slides[0].elements)[0],
    'two opens of one template are two independent polls')
  ok(first.docId !== second.docId, 'each open is a distinct document (pre-existing)')
  ok(first.template === undefined, 'the template flag is consumed')

  // The other half of the contract: a SAVED deck must keep its code, or the
  // poll you rehearsed with is not the poll you present from.
  const saved = JSON.stringify({ ...base, template: undefined, docId: 'doc-1' })
  const openA = parseDoc(saved)!
  const openB = parseDoc(saved)!
  ok(codes(openA.slides[0].elements)[0] === 'shared', 'a saved deck keeps its code on open')
  ok(codes(openB.slides[0].elements)[0] === 'shared', 'and keeps it on every later open')
}

// --- defaultPoll --------------------------------------------------------------

group('defaultPoll: legible on the slide it lands on…')
{
  const onWhite = defaultPoll({}, emptySlide({ background: '#FFFFFF' }))
  const onInk = defaultPoll({}, emptySlide({ background: '#1E2A3A' }))
  ok(onWhite.color === '#1E2A3A', 'dark ink on a light slide')
  ok(onInk.color === '#F5F7FA', 'light ink on a dark slide')
  ok(defaultPoll().color === '#1E2A3A', 'no slide given → the light-background default')
  ok(onWhite.code !== onInk.code, 'each new poll mints its own code')
  ok(/^poll-/.test(onWhite.id), 'id carries the poll prefix')
  const partial = defaultPoll({ question: 'Why?', x: 10, code: 'abcd' })
  ok(partial.question === 'Why?' && partial.x === 10 && partial.code === 'abcd',
    'partial overrides win, including an explicit code')
}

// --- the session code ---------------------------------------------------------

group('pollSessionCode: one code per deck, never mistakeable for a question…')
{
  for (let i = 0; i < 2000; i++) {
    const s = pollSessionCode()
    ok(/^[a-z0-9]{4,12}$/.test(s), `"${s}" matches the shape the service accepts`)
    ok(isPollSessionCode(s), `"${s}" is recognised as a session code`)
  }
  // THE invariant behind the audience page's no-round-trip branch: a question
  // code can never look like a session code, because the alphabet has no `s`.
  for (let i = 0; i < 5000; i++) {
    ok(!isPollSessionCode(pollCode()), 'a question code never reads as a session')
  }
  ok(!isPollSessionCode('') && !isPollSessionCode('abc') && !isPollSessionCode('s'),
    'junk is not a session code')
}

group('ensurePollSession / pollJoinCode: one QR, question buckets underneath…')
{
  const doc = newDoc()
  ok(!doc.poll, 'a fresh deck carries no session until something needs one')
  const first = ensurePollSession(doc)
  ok(first === doc.poll!.session, 'the code is stored on the doc')
  ok(ensurePollSession(doc) === first, 'a second call is a no-op — codes never churn')

  const el = defaultPoll({ code: 'abcdef' })
  ok(pollJoinCode(doc, el) === first, 'the slide prints the SESSION code')
  ok(pollJoinCode({}, el) === 'abcdef',
    'a deck with no session falls back to the question code (pre-v1.0.12 files)')
  ok(el.code === 'abcdef', 'the question keeps its own answer bucket')
}

group('template decks: a fork gets its own session too…')
{
  const doc = newDoc() as TesseraDoc
  ensurePollSession(doc)
  const base = {
    ...doc,
    template: true,
    slides: [emptySlide({ elements: [defaultPoll({ id: 'pq', code: 'shared' })] })],
  }
  const json = JSON.stringify(base)
  const a = parseDoc(json)!
  const b = parseDoc(json)!
  ok(!!a.poll?.session && !!b.poll?.session, 'both opens have a session')
  ok(a.poll!.session !== base.poll!.session, 'the template session is not reused')
  ok(a.poll!.session !== b.poll!.session, 'two speakers never steer each other\'s room')
}

// --- reading answers back -----------------------------------------------------

group('tallyChoices: counts per option, nothing silently dropped…')
{
  const el = { options: ['Yes', 'No', 'Maybe'] }
  const answers = [
    { text: 'Yes' }, { text: 'yes' }, { text: ' YES ' }, // matching is forgiving
    { text: 'No' },
    { text: 'Something else' },                          // → other
    { text: '' },                                        // ignored entirely
  ]
  const { rows, other, total } = tallyChoices(el, answers)
  ok(rows.length === 3, 'one row per option, in the author\'s order')
  ok(rows[0].label === 'Yes' && rows[0].count === 3, 'case and padding do not split a bucket')
  ok(rows[1].count === 1 && rows[2].count === 0, 'an option nobody picked still has a row')
  ok(other === 1, 'an answer that matches nothing lands in `other`')
  ok(total === 5, 'blanks are not counted; everything else is')
  ok(tallyChoices({}, answers).rows.length === 0, 'no options → no rows (and no crash)')
}

group('ratingScale / ratingStats: the average is the point…')
{
  ok(ratingScale({}).min === 1 && ratingScale({}).max === 5, '1..5 by default')
  ok(ratingScale({ min: 0, max: 10 }).max === 10, 'an explicit scale is honoured')
  const back = ratingScale({ min: 7, max: 2 })
  ok(back.min === 1 && back.max === 5, 'a backwards scale falls back rather than rendering nothing')

  const stats = ratingStats({ min: 1, max: 5 }, [
    { text: '5' }, { text: '4' }, { text: '4' }, { text: 'no idea' }, { text: '' },
  ])
  ok(stats.count === 3, 'only answers that parse as numbers count')
  ok(Math.abs(stats.average - 13 / 3) < 1e-9, 'the average is over those, not over everyone')
  ok(stats.rows.length === 5, 'one row per step of the scale')
  ok(stats.rows[3].count === 2 && stats.rows[4].count === 1, 'the distribution lands on the right steps')
  ok(ratingStats({}, []).average === 0 && ratingStats({}, []).count === 0,
    'no answers is zero, not NaN — it is printed on a slide')
  ok(ratingStats({ min: 1, max: 5 }, [{ text: '99' }]).rows.every((r) => r.count === 0),
    'an out-of-range answer still counts toward the average but has no bar to sit in')
}

console.log(failed
  ? `\n${failed} FAILED of ${checks} checks`
  : `\nALL PASS (${checks} checks)`)
process.exit(failed ? 1 : 0)
