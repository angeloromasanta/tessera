// GET /api/qr?c=CODE[&fg=RRGGBB]  → an SVG QR code for the audience join URL.
//
// Rendered here rather than in the deck so that NOTHING is added to the shell:
// The engine dropped a 630KB chart library for size, and a runtime QR encoder is not
// the thing to spend that budget back on. The join line printed beside the QR is
// the fallback when this is unreachable.

import QRCode from 'qrcode'
import { preflight, badSession, cors } from './_lib.js'

const HEX_RE = /^[0-9a-f]{6}$/

export default async function handler(req, res) {
  if (preflight(req, res)) return

  const code = String(req.query.c ?? '').trim().toLowerCase()
  if (badSession(code)) {
    res.status(400).setHeader('content-type', 'text/plain')
    return res.end('bad code')
  }

  // The caller passes its own ink colour. An SVG loaded through <img> is an
  // isolated document — it inherits nothing from the page, so `currentColor`
  // would resolve to black and vanish on a dark deck. Hence an explicit param.
  const fg = String(req.query.fg ?? '').trim().toLowerCase().replace(/^#/, '')
  const dark = HEX_RE.test(fg) ? `#${fg}` : '#1e2a3a'

  // Prefer the request's own host so a preview deployment, a custom domain and
  // `vercel dev` each produce a QR that points back at themselves.
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0]
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]
  const url = `${proto}://${host}/${code}`

  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      // Transparent quiet zone so the slide's own background shows through.
      color: { dark, light: '#00000000' },
    })
    cors(res)
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
    // A given code+colour always renders the same bytes.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.status(200).end(svg)
  } catch (e) {
    res.status(500).setHeader('content-type', 'text/plain')
    res.end(String(e?.message ?? e))
  }
}
