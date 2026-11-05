// GET    /api/poll?c=CODE  → { code, question, count, answers[{id,text,at,name?}], answersWithheld?, summary, summaryAt, html }
// POST   /api/poll  { code, html }  → { ok: true }
// DELETE /api/poll?c=CODE  → { cleared: n, images: n }   (also resets the code's game, /api/game)
//
// The presenter's slide calls GET every few seconds while the poll slide is on
// screen; the audience join page calls it once to show the question. Returning
// the answers alongside the count is deliberate — the slide's hide/show toggle
// needs them, and one call per tick beats two.
//
// POST exists for exactly one thing: a `kind:'activity'` poll's self-contained
// HTML page, pushed once by the presenting deck when that slide first shows
// (see slides/src/poll.ts publishActivityHtml). It rides on the same document
// as the question/summary — `setPoll`'s field mask keeps this write from
// touching them — so an activity's answers, like every other kind, live under
// its own `code` and are untouched by summarize/export/clear.
//
// GET is open to anyone with the code — that is what lets the join page show
// the question and an activity page fetch its HTML. But `answers[]` inside that
// open response is NOT: it needs the lecturer key when one is configured, and
// comes back `[]` with `answersWithheld:true` otherwise. Everyone in the room
// holds the question code (/api/session hands it to every phone), so an
// ungated answers[] means every participant can read every response verbatim,
// names and all. `count` stays public — participation is not a disclosure.
//
// POST and DELETE need the key outright: they replace what a room is running,
// and destroy what it produced.

import { preflight, json, body, badCode, denyLecturer, hasLecturer, getPoll, setPoll, listAnswersCached, deleteAnswers, deleteBlobs, gameReset, MAX_ACTIVITY_HTML_CHARS, vary } from './_lib.js'

export default async function handler(req, res) {
  if (preflight(req, res)) return

  try {
    if (req.method === 'POST') {
      // Presenter-only: this replaces the page every phone in the room is
      // running. GET below stays open — the join page has to fetch it.
      if (denyLecturer(req, res)) return
      const b = body(req)
      const code = String(b.code ?? '').trim().toLowerCase()
      if (badCode(code)) return json(res, 400, { error: 'bad code' })
      const html = String(b.html ?? '')
      if (!html.trim()) return json(res, 400, { error: 'empty html' })
      if (html.length > MAX_ACTIVITY_HTML_CHARS) {
        return json(res, 413, { error: `activity page too large (max ${MAX_ACTIVITY_HTML_CHARS} characters)` })
      }
      // `htmlAt` is what opens /api/draw: publishing happens when the slide is
      // entered in present mode, so it says a presenter is on that slide now.
      await setPoll(code, { html, htmlAt: new Date().toISOString() })
      return json(res, 200, { ok: true })
    }

    const code = String(req.query.c ?? '').trim().toLowerCase()
    if (badCode(code)) return json(res, 400, { error: 'bad code' })

    if (req.method === 'DELETE') {
      // Presenter-only, and the one irreversible route in the service.
      if (denyLecturer(req, res)) return
      // Images go with the answers that referenced them: a "Clear responses"
      // that left the pictures behind would be a privacy surprise, and their
      // URLs are public.
      const [cleared, images] = [await deleteAnswers(code), await deleteBlobs(code)]
      await setPoll(code, { clusterJson: '', scoreJson: '', remixJson: '' })   // the saved clustering, scores and remixed slide came from those answers
      await gameReset(code)   // and a game on this code starts over (docs/game.md)
      return json(res, 200, { cleared, images })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' })
    }

    // A poll nobody has written to yet simply has no document. That is not an
    // error — answer with an empty poll so the slide shows its join info and
    // the join page still renders. The answers come from listAnswersCached:
    // this route is polled, and a full list on every tick is what Firestore
    // bills by the document (see _lib.js, "the read path's cache").
    const [poll, answers] = await Promise.all([getPoll(code), listAnswersCached(code)])
    // No caching: the whole point of this route is freshness.
    res.setHeader('cache-control', 'no-store')
    // Who may read the RESPONSES, as opposed to the question. Everyone in the
    // room learns the question code — /api/session hands it to every phone so
    // the join page can follow along — so without this check any participant
    // could pull the whole bucket, verbatim, names included. For a `quiz` with
    // requireName that is a roster of who answered what; for an opinion poll it
    // is everyone's words next to their name.
    //
    // `count` stays public on purpose: the join page and the phones show
    // participation ("42 answers so far"), and a number is not a disclosure.
    // Vary tells caches the body depends on the header — belt and braces next
    // to no-store, because this response is public for one caller and private
    // for another.
    const mayReadAnswers = hasLecturer(req)
    res.setHeader('vary', vary('x-tessera-lecturer'))
    return json(res, 200, {
      code,
      question: poll?.question ?? '',
      count: answers.length,
      answers: mayReadAnswers
        ? answers.map((a) => (a.name ? { id: a.id, text: a.text, at: a.at, name: a.name } : { id: a.id, text: a.text, at: a.at }))
        : [],
      // Say WHY the array is empty, so a client can tell "nobody answered yet"
      // from "you are not allowed to see this" and show the right thing.
      answersWithheld: mayReadAnswers ? undefined : true,
      summary: poll?.summary ?? '',
      summaryAt: poll?.summaryAt ?? '',
      html: poll?.html ?? '',
    })
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}
