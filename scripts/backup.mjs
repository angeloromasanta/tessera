// Copy a deck file aside before a script rewrites it: <deck folder>/build/backups/<name>.bak,
// rotating to .bak1, .bak2 (TESSERA_BACKUPS copies, default 3; 0 turns them off). Same
// place and rotation as tools/deckio.py backup(). Returns the copy's path, or null.
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function backup(file) {
  const keep = Number.parseInt(process.env.TESSERA_BACKUPS ?? '3', 10)
  if (!(keep > 0) || !existsSync(file)) return null
  const dir = join(dirname(file), 'build', 'backups')
  mkdirSync(dir, { recursive: true })
  const baks = Array.from({ length: keep }, (_, i) => join(dir, basename(file) + (i ? `.bak${i}` : '.bak')))
  for (let i = keep - 1; i > 0; i--) if (existsSync(baks[i - 1])) renameSync(baks[i - 1], baks[i])
  copyFileSync(file, baks[0])
  return baks[0]
}
