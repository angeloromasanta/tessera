// The Worker: a router in front of the Durable Objects.
//
//   /                       the join page (public/, served without running this)
//   /api/qr, /api/lecturer  answered here: no storage
//   /api/live               a WebSocket to the poll or join code's object
//   /api/<route>            forwarded to the object its code names, which runs
//                           the handler (src/space.js)
//
// Which object: `?c=CODE` (a poll) or `?s=CODE` (a join code) in the URL, else
// `code` / `s` in a JSON body. Pages served by this service put the code in the
// URL (public/live.js does it for activity pages), so a large body — a photo
// for the lab helper, an upload — is never parsed here: a Worker request gets
// 10 ms of CPU on the Free plan, the object 30 s.

import { runHandler } from './adapter.js'
import { CORS, badCode, badSession } from './api/_lib.js'
import qr from './api/qr.js'
import lecturer from './api/lecturer.js'
import { ROUTES } from './space.js'

export { Space } from './space.js'

/** Bodies the router may parse to find their code. Larger ones must say it in the URL. */
const MAX_ROUTED_BODY = 256 * 1024

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const m = /^\/api\/([a-z]+)$/.exec(url.pathname)
    if (!m) return env.ASSETS.fetch(request)
    const route = m[1]
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (route === 'qr') return runHandler(qr, request, { url })
    if (route === 'lecturer') return runHandler(lecturer, request, { url })
    if (route !== 'live' && !ROUTES[route]) return json(404, { error: 'not found' })

    const isSession = route === 'session' || (route === 'live' && url.searchParams.has('s'))
    let code = String(url.searchParams.get(isSession ? 's' : 'c') ?? '').trim().toLowerCase()
    let bodyText
    if (!code && request.method === 'POST') {
      const len = Number(request.headers.get('content-length') ?? 0)
      if (len > MAX_ROUTED_BODY) return json(413, { error: `put the code in the URL (?${isSession ? 's' : 'c'}=CODE) for a body this large` })
      bodyText = await request.text()
      if (bodyText.length > MAX_ROUTED_BODY) return json(413, { error: `put the code in the URL (?${isSession ? 's' : 'c'}=CODE) for a body this large` })
      try {
        const b = JSON.parse(bodyText)
        code = String((isSession ? b?.s : b?.code) ?? '').trim().toLowerCase()
      } catch { /* the handler reports the bad body */ }
    }
    if (isSession ? badSession(code) : badCode(code)) return json(400, { error: 'bad code' })

    const key = (isSession ? 's:' : 'c:') + code
    const headers = new Headers(request.headers)
    headers.set('x-space', key)
    const init = { method: request.method, headers }
    if (bodyText !== undefined) {
      headers.set('x-body-read', '1')
      init.body = bodyText
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body
    }
    return env.SPACE.get(env.SPACE.idFromName(key)).fetch(request.url, init)
  },
}
