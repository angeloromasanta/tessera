// Run a Vercel-style handler — handler(req, res) with req.query, req.body,
// req.headers and res.status/setHeader/end — against a Workers Request, and
// return a Response.
//
// The route handlers in ./api/ were written for Vercel and are kept as they
// were: everything they knew about Firestore lived in _lib.js, so swapping
// that file and this adapter is the whole port. A handler that diverges from
// its Vercel twin says so at the top.

import { adoptLegacyHeaders } from './legacy.js'

export async function runHandler(handler, request, { url, bodyText } = {}) {
  url ??= new URL(request.url)
  const headers = {}
  request.headers.forEach((v, k) => { headers[k] = v })
  // Handlers read the current header names; a deck from before the rename
  // sends the old ones (src/legacy.js).
  adoptLegacyHeaders(headers)
  // What upload.js and qr.js read to build absolute URLs back to this service.
  headers['x-forwarded-proto'] ??= url.protocol.replace(':', '')
  headers['x-forwarded-host'] ??= url.host

  if (bodyText === undefined && request.method !== 'GET' && request.method !== 'HEAD') {
    bodyText = await request.text()
  }
  // Vercel parses JSON bodies only for a JSON content-type and hands anything
  // else over as a string; _lib.body() accepts either.
  let body
  if (bodyText) {
    if ((headers['content-type'] ?? '').includes('application/json')) {
      try { body = JSON.parse(bodyText) } catch { body = bodyText }
    } else body = bodyText
  }

  const req = { method: request.method, headers, query: Object.fromEntries(url.searchParams), body, url: url.pathname + url.search }
  let status = 200
  let payload = null
  const out = new Headers()
  const res = {
    status(code) { status = code; return res },
    setHeader(k, v) { out.set(k, String(v)); return res },
    getHeader(k) { return out.get(k) },
    end(b) { payload = b ?? null; return res },
  }
  await handler(req, res)
  const empty = request.method === 'HEAD' || status === 204 || status === 304
  return new Response(empty ? null : payload, { status, headers: out })
}
