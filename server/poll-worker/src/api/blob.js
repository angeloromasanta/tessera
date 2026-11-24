// GET /api/blob?c=CODE&id=ID  → the image (or document) bytes
//
// Serves what /api/upload stored. Open, like every other read here: the id is
// 120 random bits and the code is on a projector anyway (README, "The trust
// model"). Uploaded images are public — say so to a room before asking for one.
//
// An id names one immutable object, so this is the one route in the service
// that is worth caching hard. A wall of thirty tiles then costs thirty function
// invocations once and nothing on every later slide change.

import { preflight, json, badCode, getBlob } from './_lib.js'

const SANDBOX = 'sandbox allow-scripts allow-popups allow-modals allow-forms'
const DOC_SERVE = {
  'text/html': { type: 'text/html; charset=utf-8', csp: SANDBOX },
  'text/markdown': { type: 'text/plain; charset=utf-8', csp: SANDBOX },
  'text/plain': { type: 'text/plain; charset=utf-8', csp: SANDBOX },
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method not allowed' })
  }

  const code = String(req.query.c ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })
  const id = String(req.query.id ?? '').trim()
  if (!id) return json(res, 400, { error: 'id required' })

  try {
    const blob = await getBlob(code, id)
    // A cleared bucket takes its images with it, so a URL in an old export is
    // expected to 404 eventually. The display page draws its own placeholder.
    if (!blob) return json(res, 404, { error: 'not found' })

    // A handed-in document is someone's page, served from this service's
    // origin: HTML runs only in a CSP sandbox (an opaque origin: no storage, no
    // cookies of this host), markdown and text show as text. A PDF goes to the
    // browser's viewer, which a sandbox would block.
    const doc = DOC_SERVE[blob.mime]
    res.setHeader('content-type', doc ? doc.type : blob.mime)
    if (doc?.csp) res.setHeader('content-security-policy', doc.csp)
    res.setHeader('content-length', String(blob.body.length))
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    // User-supplied: refuse to let a browser sniff it into something else.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-disposition', 'inline')
    res.status(200)
    if (req.method === 'HEAD') return res.end()
    return res.end(blob.body)
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}
