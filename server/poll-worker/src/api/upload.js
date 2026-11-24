// POST /api/upload  { code, dataUrl }  → { url, id, bytes, mime }
//
// The route that lets a picture (or a document: PDF, HTML, markdown, text,
// for a peer review) come back from a phone. An answer is one
// string, so an image can never travel inside one however high the character
// ceiling goes: the phone posts the bytes here, gets a URL, and puts THAT in
// its answer. A display slide later reads the answers and renders the URLs.
//
// Open to the audience, exactly like /api/answer — the join code is the
// capability, and a room that can answer can obviously also submit the drawing
// it was asked for. The ceilings below are what stands in for authentication:
// a real image type and 600 kB (a listed document type and 1.8 MB), and the
// same 500-per-bucket cap answers have.
//
// The returned URL is public and unguessable, and dies with the bucket:
// DELETE /api/poll?c=CODE clears images along with answers.

import {
  preflight, json, body, badCode,
  MAX_UPLOAD_BYTES, UPLOAD_TYPES, MAX_DOC_BYTES, DOC_TYPES, MAX_ANSWERS,
  putBlob, listBlobIds, getPoll,
} from './_lib.js'

/** `data:image/jpeg;base64,…` — the shape canvas.toDataURL() produces, which
 *  is what a phone that just downscaled a photo already has in hand. */
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const b = body(req)
  const code = String(b.code ?? '').trim().toLowerCase()
  if (badCode(code)) return json(res, 400, { error: 'bad code' })

  const m = DATA_URL.exec(String(b.dataUrl ?? '').trim())
  if (!m) return json(res, 400, { error: 'expected a base64 data URL' })

  const mime = m[1].toLowerCase()
  const isDoc = DOC_TYPES.includes(mime)
  if (!isDoc && !UPLOAD_TYPES.includes(mime)) {
    return json(res, 415, { error: `unsupported type ${mime} (allowed: ${[...UPLOAD_TYPES, ...DOC_TYPES].join(', ')})` })
  }
  const max = isDoc ? MAX_DOC_BYTES : MAX_UPLOAD_BYTES
  const what = isDoc ? 'file' : 'image'

  // Check the DECODED length before allocating: base64 is 4 characters per 3
  // bytes, so this rejects an oversized payload without materialising it.
  const b64 = m[2].replace(/\s+/g, '')
  const approx = Math.floor((b64.length * 3) / 4)
  if (approx > max) {
    return json(res, 413, {
      error: isDoc
        ? `file too large (${Math.round(approx / 1024)} kB, max ${Math.round(max / 1024)} kB)`
        : `image too large (${Math.round(approx / 1024)} kB, max ${Math.round(max / 1024)} kB) — downscale it on the phone first`,
    })
  }

  let bytes
  try {
    bytes = Buffer.from(b64, 'base64')
  } catch {
    return json(res, 400, { error: `could not decode the ${what}` })
  }
  if (!bytes.length) return json(res, 400, { error: `empty ${what}` })
  if (bytes.length > max) {
    return json(res, 413, { error: `${what} too large` })
  }

  try {
    // Closed like /api/answer: no pictures into a bucket whose talk is over.
    if ((await getPoll(code))?.closed) return json(res, 403, { error: 'This question is closed.', closed: true })
    // Same backstop as answers: the write path is open to anyone holding the
    // code, so a bucket has to have a bottom.
    const existing = await listBlobIds(code)
    if (existing.length >= MAX_ANSWERS) {
      return json(res, 429, { error: 'this poll is full' })
    }

    const id = await putBlob(code, bytes, mime)
    // Absolute, because the answer carrying it is read by a slide on some other
    // origin — a relative path would resolve against whatever opened the deck.
    const origin = originOf(req)
    return json(res, 200, {
      id,
      bytes: bytes.length,
      mime,
      url: `${origin}/api/blob?c=${encodeURIComponent(code)}&id=${encodeURIComponent(id)}`,
    })
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
}

/** Where this deployment answers. Behind Vercel the original host is in
 *  x-forwarded-*; PUBLIC_ORIGIN overrides for a custom domain. */
function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '')
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()
  return host ? `${proto}://${host}` : ''
}
