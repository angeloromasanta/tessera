import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// base './' so builds open from file:// or any static host.
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the deck document format.
export default defineConfig({
  base: './',
  define: {
    // The poll service a deck falls back to when it doesn't name one itself.
    // EMPTY by default on purpose: a poll host is somebody's deployment, not a
    // property of the app, and baking one into the source makes every shell
    // built from this repo point at it. Decks carry their own (doc.poll.service,
    // set by the template generators); this is only the floor under decks that
    // don't. Set POLL_HOST at build time to put one back:
    //   POLL_HOST=https://join.<subdomain>.workers.dev npm run build:single
    __POLL_HOST__: JSON.stringify(process.env.POLL_HOST ?? ''),
  },
  plugins: [...(process.env.SINGLEFILE ? [viteSingleFile()] : [])],
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a deck file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
