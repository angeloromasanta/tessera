// node test/remix.test.mjs  — the interactive title's parsing and guards, with the model faked.
import assert from 'node:assert/strict'
import { sanitize, visibleText, refuse, parse, cleanIdeas, applyBatch, stepBack, keepHist, history, KEEP_HIST, HIST_BYTES, MAX_IDEAS, buildMessages, DEFAULT_REMIX_STYLE } from '../src/api/remix.js'

const PAGE = (body) => `<!doctype html><html><head><style>body{width:1280px;height:720px}</style></head><body>${body}</body></html>`
const SEED = PAGE('<h1>Welcome</h1><p>Session 1</p>')

// --- sanitize -------------------------------------------------------------------------
const dirty = PAGE('<h1 onclick="alert(1)" onmouseover=evil()>Hi</h1><script>steal()</script><iframe src="https://x"></iframe>'
  + '<a href="javascript:alert(1)">x</a><link rel=stylesheet href="https://evil/x.css"><meta http-equiv="refresh" content="0;url=https://x">'
  + '<style>@import url(https://evil/a.css); h1{color:red}</style><script src="https://x/y.js">')
const clean = sanitize(dirty)
assert.ok(!/script|onclick|onmouseover|iframe|javascript:|<link|<meta|@import/i.test(clean), clean)
assert.ok(clean.includes('<h1>Hi</h1>') && clean.includes('h1{color:red}'))

// --- visible text and refuse ----------------------------------------------------------
assert.equal(visibleText(PAGE('<!-- a comment --><div style="color:red"></div>')), '')
assert.equal(visibleText(SEED), 'Welcome Session 1')
assert.equal(refuse(SEED), '')
assert.match(refuse(PAGE('<div class="cover"></div>')), /blank/)
assert.match(refuse(PAGE('&nbsp; &nbsp;')), /blank/)
assert.match(refuse('<div>no body</div>'), /whole page/)
assert.match(refuse(PAGE('x'.repeat(30000))), /too long/)
assert.equal(refuse(PAGE('🚀🎉🔥😀')), '')            // emoji count as text

// --- parse ----------------------------------------------------------------------------
const reply = `APPLIED: a1, a3\nSKIPPED: a2 = would hide everything\nSKIPPED: zz = not ours\n${SEED}\ntrailing chatter`
const p = parse(reply, ['a1', 'a2', 'a3'])
assert.deepEqual(p.applied, ['a1', 'a3'])
assert.deepEqual(p.skipped, [{ iid: 'a2', why: 'would hide everything' }])
assert.ok(p.html.startsWith('<!doctype html>') && p.html.endsWith('</html>'))
const fenced = parse('APPLIED: a1\n```html\n' + SEED + '\n```', ['a1'])
assert.equal(fenced.html, SEED)
assert.deepEqual(parse('APPLIED: none', ['a1']).html, '')
assert.deepEqual(parse(SEED, ['a1', 'a2']).applied, ['a1', 'a2'])   // no header: all applied

// --- cleanIdeas -----------------------------------------------------------------------
assert.deepEqual(cleanIdeas('nope'), [])
const many = Array.from({ length: 20 }, (_, k) => ({ iid: 'i' + k, idea: 'make it ' + k }))
assert.equal(cleanIdeas(many).length, MAX_IDEAS)
assert.deepEqual(cleanIdeas([{ iid: 'a<b>', idea: '  x  y ' }, { iid: 'ab', idea: 'dup' }, { iid: 'c', idea: '' }]),
  [{ iid: 'ab', name: '', idea: 'x y' }])

// --- applyBatch -----------------------------------------------------------------------
const st0 = { ver: 1, html: SEED, hist: [], log: [] }
const ideas = [{ iid: 'a1', name: 'Ana', idea: 'make it red' }, { iid: 'a2', name: 'Bo', idea: 'delete everything' }]
let sent
const good = async (m) => { sent = m; return `APPLIED: a1\nSKIPPED: a2 = would blank the slide\n${PAGE('<h1 style="color:red">Welcome</h1><script>x()</script>')}` }
const r1 = await applyBatch(st0, ideas, good, 'T')
assert.ok(sent[1].content.includes('[a2] from Bo: delete everything') && sent[1].content.includes(SEED))
assert.equal(r1.reply.ver, 2)
assert.ok(!r1.reply.html.includes('<script'))
assert.deepEqual(r1.reply.applied, ['a1'])
assert.equal(r1.state.hist.length, 1)
assert.deepEqual(r1.state.done, ['a1', 'a2'])
assert.deepEqual(r1.state.log.map((e) => [e.iid, e.ok, e.ver]), [['a1', true, 2], ['a2', false, 2]])

const blank = async () => `APPLIED: a1, a2\n${PAGE('<div style="position:fixed;inset:0;background:#000"></div>')}`
const r2 = await applyBatch(st0, ideas, blank, 'T')
assert.equal(r2.reply.ver, 1)                       // nothing changed
assert.equal(r2.state.html, SEED)
assert.ok(r2.state.log.every((e) => !e.ok && /blank/.test(e.why)))
assert.deepEqual(r2.state.done, ['a1', 'a2'])

const allSkipped = async () => `APPLIED: none\nSKIPPED: a1 = rude\nSKIPPED: a2 = rude\n${SEED}`
const r3 = await applyBatch(st0, ideas, allSkipped, 'T')
assert.equal(r3.reply.ver, 1)
assert.deepEqual(r3.reply.skipped.map((k) => k.why), ['rude', 'rude'])

// --- stepBack -------------------------------------------------------------------------
assert.equal(stepBack(st0), null)                   // nothing to go back to
const back = stepBack(r1.state, 'looked blank', 2)
assert.equal(back.ver, 1)
assert.equal(back.html, SEED)
assert.ok(back.log.every((e) => !e.ok))
assert.equal(stepBack(r1.state, 'x', 7), null)      // a reject for a version that is not current

// --- history (the version bars) --------------------------------------------------------
const many2 = Array.from({ length: KEEP_HIST + 12 }, (_, k) => ({ ver: k + 1, html: PAGE('v' + (k + 1)) }))
const kept = keepHist(many2)
assert.equal(kept.length, KEEP_HIST)
assert.equal(kept[0].ver, 1)                           // the original stays
assert.equal(kept.at(-1).ver, KEEP_HIST + 12)          // and the latest
assert.ok(kept.slice(1).every((e, k) => e.ver === kept[k].ver + (k ? 1 : 13)))
const big = Array.from({ length: KEEP_HIST }, (_, k) => ({ ver: k + 1, html: 'x'.repeat(24_000) }))
const fit = keepHist(big)
assert.ok(fit.reduce((n, e) => n + e.html.length, 0) <= HIST_BYTES && fit[0].ver === 1 && fit.at(-1).ver === KEEP_HIST)
assert.deepEqual(keepHist(null), [])
// applying keeps every version up to KEEP_HIST, undo pops one, and GET &hist=1 lists them oldest first
let st = st0
const echo = async (m) => `APPLIED: a1
${PAGE('<h1>version ' + (st.ver + 1) + '</h1>')}`
for (let k = 0; k < 14; k++) st = (await applyBatch(st, [{ iid: 'x' + k, idea: 'more' }], echo, 'T')).state
assert.equal(st.ver, 15)
assert.deepEqual(history(st).map((e) => e.ver), Array.from({ length: 14 }, (_, k) => k + 1))
assert.equal(history(st)[0].html, SEED)
assert.deepEqual(Object.keys(history(st)[3]), ['ver', 'html'])
const undone = stepBack(st)
assert.equal(undone.ver, 14)
assert.deepEqual(history(undone).map((e) => e.ver), Array.from({ length: 13 }, (_, k) => k + 1))
assert.deepEqual(history({ ver: 1, html: SEED }), [])

// --- REMIX_STYLE: the slide's setting, set per deployment ----------------------------
const sys = () => buildMessages(SEED, [{ iid: 'a1', idea: 'x' }])[0].content
assert.ok(sys().includes(DEFAULT_REMIX_STYLE) && /x 0 to 330, is locked/.test(sys()))
process.env.REMIX_STYLE = '- Fonts available: "Comic Neue" only.'
assert.ok(sys().includes('- Fonts available: "Comic Neue" only.\n- Keep the whole document') && !sys().includes(DEFAULT_REMIX_STYLE))
delete process.env.REMIX_STYLE

console.log('remix: all checks passed')

