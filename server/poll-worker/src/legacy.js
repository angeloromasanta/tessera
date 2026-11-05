// Decks written before the rename use these names.
//
// The only place the old names live on the server. Everything else reads the
// new ones: requests are rewritten here, on the way in (src/adapter.js), and
// the readers that look inside a published page accept both.

/** Old request header → the header the handlers read. */
export const LEGACY_HEADERS = {
  'x-bento-lecturer': 'x-tessera-lecturer',
  'x-bento-player': 'x-tessera-player',
}

/** The old names, for CORS allow-headers and `vary`: a deck from before the
 *  rename still sends them, and a preflight that does not list them drops the
 *  request unsent. */
export const LEGACY_HEADER_NAMES = Object.keys(LEGACY_HEADERS)

/** Copy an old header to its new name when the new one is absent. `headers` is
 *  the plain lower-cased object the adapter builds; changed in place. */
export function adoptLegacyHeaders(headers) {
  for (const [old, now] of Object.entries(LEGACY_HEADERS)) {
    if (headers[old] !== undefined && headers[now] === undefined) headers[now] = headers[old]
  }
  return headers
}

/** The old id of an activity page's model-task tag (src/api/ai.js). */
export const LEGACY_AI_TAG_ID = 'bento-ai'
