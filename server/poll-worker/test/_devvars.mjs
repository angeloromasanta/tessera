// The throwaway lecturer key the local tests run `wrangler dev` with, from
// .dev.vars (gitignored; `npm run setup` writes it). Without it a test stops
// with one line saying so, instead of a stack trace.
import { readFileSync, existsSync } from 'node:fs'

export function devLecturerKey() {
  const file = new URL('../.dev.vars', import.meta.url)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const key = /^\s*LECTURER_PASSWORD\s*=\s*(.*)$/m.exec(text)?.[1].trim().replace(/^(["'])(.*)\1$/, '$2')
  if (key) return key
  console.error(`${existsSync(file) ? '.dev.vars has no LECTURER_PASSWORD' : 'No .dev.vars'}: run \`npm run setup\` first (or write LECTURER_PASSWORD=<any throwaway key> to server/poll-worker/.dev.vars).`)
  process.exit(1)
}
