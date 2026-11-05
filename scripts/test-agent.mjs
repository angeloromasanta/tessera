import { build } from '../slides/node_modules/esbuild/lib/main.js'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(new URL('../testing/', import.meta.url), { recursive: true })
await build({ entryPoints: [root + 'scripts/test-agent.ts'], outfile: root + 'testing/test-agent.mjs', bundle: true, platform: 'node', format: 'esm' })
const result = spawnSync(process.execPath, [root + 'testing/test-agent.mjs'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
