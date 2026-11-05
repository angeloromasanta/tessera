// Copy the engine's browser scripts (their canonical home is slides/src)
// into public/, which the join page and its activity pages load:
//   live-shim.js → public/live.js   the live link (every page)
//   game-sdk.js  → public/game.js   the game SDK (pages with <meta name="tessera-game">)
//   legacy-names.js → public/legacy-names.js   the old globals as aliases (first in every activity page)
// Run before every deploy; test/e2e.test.mjs fails when a copy differs.
// game-sdk.js and legacy-names.js are optional until they exist: skipped, not an error.
import { copyFileSync, existsSync } from 'node:fs'

const FILES = [
  ['live-shim.js', 'live.js', true],
  ['game-sdk.js', 'game.js', false],
  ['legacy-names.js', 'legacy-names.js', false],
]
for (const [src, dst, required] of FILES) {
  const from = new URL(`../../../slides/src/${src}`, import.meta.url)
  const to = new URL(`../public/${dst}`, import.meta.url)
  if (!existsSync(from)) {
    if (required) throw new Error(`missing slides/src/${src}`)
    console.log(`${dst}: slides/src/${src} does not exist yet, skipped`)
    continue
  }
  copyFileSync(from, to)
  console.log(`${dst} synced from slides/src/${src}`)
}
