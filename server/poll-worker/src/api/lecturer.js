// GET /api/lecturer  → { required, ok }
//
// "Does this deployment want a lecturer key, and is the one I hold good?"
//
// Every other gated route answers that question too — by refusing to do its
// job. That is a bad way to ask it. The deck needs the answer BEFORE a talk
// starts, so a presenter finds out in the panel with time to fix it, rather
// than from a dialog on stage or (worse) from a slide that silently never
// updates. The two callers are the poll panel's key field and present mode's
// preflight (slides/src/poll.ts checkLecturerKey / ensureLecturerKey).
//
// On the oracle this creates: it tells an attacker whether a guess is right
// without a side effect. That is not new — `POST /api/session` with any code
// is already exactly that oracle, and cheaper to script than the destructive
// or billable routes. What this route adds is convenience, not capability. The
// real mitigation was always the password itself: LECTURER_PASSWORD is a
// shared per-deployment secret, so make it long and random (a passphrase, not
// a course code) and rotate it between cohorts. See RULES.md.
//
// It deliberately reports NOTHING about the password itself — not its length,
// not a hint, not whether one was supplied. `required` is a property of the
// deployment, `ok` is a yes/no about the key presented, and that is all.

import { preflight, json, hasLecturer, lecturerRequired, vary } from './_lib.js'

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method not allowed' })
  }
  // No caching: a key entered a second ago must change this answer, and an
  // intermediary must never hand one presenter's verdict to another.
  res.setHeader('cache-control', 'no-store')
  res.setHeader('vary', vary('x-tessera-lecturer'))
  // hasLecturer returns true for everyone when no password is set, which is
  // the right answer for `ok` in that case: nothing is gated, so the key you
  // hold (none) works fine.
  return json(res, 200, { required: lecturerRequired(), ok: hasLecturer(req) })
}
