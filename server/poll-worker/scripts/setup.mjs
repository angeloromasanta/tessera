#!/usr/bin/env node
// npm run setup — deploy your own poll service on a free Cloudflare account and
// connect your decks to it, in one go. docs/server-setup.md is the guide.
//
//   1. wrangler login, if you are not logged in yet
//   2. the lecturer key: one you type, one already saved, or a strong new one
//   3. .dev.vars (gitignored): the same key for the local tests
//   4. npm run deploy: sync, the local end-to-end tests, wrangler deploy
//   5. wrangler secret put LECTURER_PASSWORD (and OPENROUTER_API_KEY if you give one),
//      piped through stdin, never echoed
//   6. .env: TESSERA_POLL_SERVICE, TESSERA_LECTURER_KEY, TESSERA_CF_SUBDOMAIN
//
// No dependencies beyond Node 20 and the wrangler in devDependencies. Secret
// values are never printed. Run with --help for the options.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')   // server/poll-worker
const DEV_VARS = join(HERE, '.dev.vars')
const WORKER = (/"name"\s*:\s*"([^"]+)"/.exec(readFileSync(join(HERE, 'wrangler.jsonc'), 'utf8')) || [])[1] || 'join'

const HELP = `npm run setup [-- options]     (or: node scripts/setup.mjs [options])

Deploys the poll service to your Cloudflare account (Workers Free) and writes
its address and your lecturer key to .env, where the deck tools find them.

Options
  --dry-run           show what would happen and run \`wrangler deploy --dry-run\`;
                      writes nothing, sets no secret, deploys nothing
  --existing          the service is already deployed: only write the .env lines
                      (needs --url; the lecturer key comes from .env, else .dev.vars,
                      else you are asked). Deploys nothing
  --url <URL>         the service's address (with --existing; or to override the
                      address read from wrangler's output)
  --generate-key      make a new lecturer key without asking
  --skip-ai           do not ask for an OpenRouter key (AI features stay off
                      until you set OPENROUTER_API_KEY)
  --env-file <path>   write this .env instead of the one found by walking up from
                      the current folder (also: TESSERA_ENV_FILE=<path>)
  -h, --help          this text

The .env: the first one found walking up from the current folder, then from
this folder; if there is none, a new one at the repository root.`

// --- arguments ---------------------------------------------------------------------

function parseArgs(argv) {
  const o = { dryRun: false, existing: false, url: '', generateKey: false, skipAi: false, envFile: process.env.TESSERA_ENV_FILE || '', help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`)
      return v
    }
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--existing') o.existing = true
    else if (a === '--url') o.url = val()
    else if (a.startsWith('--url=')) o.url = a.slice(6)
    else if (a === '--generate-key') o.generateKey = true
    else if (a === '--skip-ai') o.skipAi = true
    else if (a === '--env-file') o.envFile = val()
    else if (a.startsWith('--env-file=')) o.envFile = a.slice(11)
    else if (a === '-h' || a === '--help') o.help = true
    else fail(`unknown option ${a} (see --help)`)
  }
  return o
}

function fail(msg) {
  console.error(`setup: ${msg}`)
  process.exit(1)
}

// --- dotenv files: read, and update in place -----------------------------------------

/** KEY → value of a dotenv text (`export KEY=...`, quotes and comments handled). */
export function parseDotenv(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let v = m[2]
    const q = /^(["'])(.*)\1$/.exec(v)
    if (q) v = q[2]
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

const quote = (v) => (/^[A-Za-z0-9_./:@+-]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)

/** The dotenv text with each key in `values` set: an existing line is replaced
 *  where it stands (the first one; `export ` kept), a missing key appended at
 *  the end. Every other line, comment and line ending is left as it was. */
export function updateDotenv(text, values) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n'
  const lines = text === '' ? [] : String(text).split(/\r?\n/)
  const trailing = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailing) lines.pop()
  const done = new Set()
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(lines[i])
    if (!m || !(m[2] in values) || done.has(m[2])) continue
    lines[i] = `${m[1]}${m[2]}=${quote(values[m[2]])}`
    done.add(m[2])
  }
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) lines.push(`${k}=${quote(v)}`)
  return lines.join(nl) + nl
}

function readText(f) {
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

/** The .env to use: --env-file, else the first found walking up from the
 *  current folder, then from this one; else a new one at the repository root. */
function findEnvFile(explicit) {
  if (explicit) return { file: resolve(explicit), found: existsSync(resolve(explicit)) }
  for (const start of [process.cwd(), HERE]) {
    for (let d = resolve(start); ; d = dirname(d)) {
      if (existsSync(join(d, '.env'))) return { file: join(d, '.env'), found: true }
      if (dirname(d) === d) break
    }
  }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' })
  const root = git.status === 0 && git.stdout.trim() ? resolve(git.stdout.trim()) : resolve(HERE, '..', '..')
  return { file: join(root, '.env'), found: false }
}

/** Warn when a .env would be committed. */
function checkIgnored(file) {
  const r = spawnSync('git', ['check-ignore', '-q', file], { cwd: dirname(file) })
  if (r.status === 1) console.warn(`  warning: git does not ignore ${file}; add .env to .gitignore before committing.`)
}

// --- processes ---------------------------------------------------------------------

/** Run a command, streaming its output, and resolve {code, out} with what it printed. */
function run(cmd, args, { input, capture = true, interactive = false } = {}) {
  return new Promise((done) => {
    const p = spawn(cmd, args, {
      cwd: HERE, shell: true,
      stdio: interactive ? 'inherit' : [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    })
    let out = ''
    if (!interactive && capture) {
      p.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
      p.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    }
    if (input !== undefined) { p.stdin.write(input); p.stdin.end() }
    p.on('close', (code) => done({ code: code ?? 1, out }))
    p.on('error', (e) => done({ code: 1, out: String(e) }))
  })
}

/** Run quietly and return what it printed (for whoami). */
function quiet(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: HERE, shell: true, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }
}

// --- prompts -----------------------------------------------------------------------

let rl = null
let lineQueue = null
/** One line from stdin. With `hidden` on a terminal, what is typed is not shown. */
function ask(question, { hidden = false } = {}) {
  if (hidden && process.stdin.isTTY) return askHidden(question)
  if (!rl) {
    rl = createInterface({ input: process.stdin, terminal: false })
    lineQueue = []
    rl.on('line', (l) => { const w = lineQueue.shift(); if (w) w(l) })
    rl.on('close', () => { while (lineQueue.length) lineQueue.shift()('') })
  }
  process.stdout.write(question)
  process.stdin.resume()   // a hidden prompt before this one paused it
  return new Promise((r) => lineQueue.push((l) => r(l.trim())))
}

function askHidden(question) {
  return new Promise((done) => {
    process.stdout.write(question)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData)
          process.stdout.write('\n')
          return done(value.trim())
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b') } continue }
        value += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

async function yes(question, dflt = true) {
  const a = (await ask(`${question} ${dflt ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
  return a ? a.startsWith('y') : dflt
}

const newKey = () => randomBytes(18).toString('base64url')       // 24 url-safe characters, 144 bits
const hiddenNote = (v) => `<hidden, ${v.length} characters>`

// --- steps -------------------------------------------------------------------------

/** The service's address and workers.dev subdomain from a URL. */
function fromUrl(url) {
  let u
  try { u = new URL(url) } catch { fail(`not a URL: ${url}`) }
  if (!/^https?:$/.test(u.protocol)) fail(`not an http(s) URL: ${url}`)
  const service = `${u.protocol}//${u.host}`
  const m = /^[^.]+\.([a-z0-9-]+)\.workers\.dev$/i.exec(u.host)
  return { service, subdomain: m ? m[1] : '' }
}

/** The deployed address in wrangler's deploy output. */
function urlFromOutput(out) {
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
  const hits = [...plain.matchAll(/https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev\b/gi)]
  const mine = hits.find((h) => h[1].toLowerCase() === WORKER.toLowerCase()) || hits[0]
  return mine ? mine[0] : ''
}

function envValues(service, subdomain, key) {
  const v = { TESSERA_POLL_SERVICE: service }
  if (key) v.TESSERA_LECTURER_KEY = key
  if (subdomain) v.TESSERA_CF_SUBDOMAIN = subdomain
  return v
}

function writeEnv(envFile, values) {
  writeFileSync(envFile.file, updateDotenv(readText(envFile.file), values))
  console.log(`  ${envFile.found ? 'updated' : 'created'} ${envFile.file}: ${Object.keys(values).join(', ')}`)
  checkIgnored(envFile.file)
}

function showEnv(envFile, values) {
  console.log(`  would ${envFile.found ? 'update' : 'create'} ${envFile.file}:`)
  for (const [k, v] of Object.entries(values)) console.log(`    ${k}=${k === 'TESSERA_LECTURER_KEY' ? hiddenNote(v) : v}`)
}

async function existing(o, envFile) {
  if (!o.url) fail('--existing needs --url <the service address>, e.g. --url https://join.<subdomain>.workers.dev')
  const { service, subdomain } = fromUrl(o.url)
  const env = parseDotenv(readText(envFile.file))
  let key = ''
  let from = ''
  if (env.TESSERA_LECTURER_KEY) { from = 'kept from .env' }
  else if (env.LECTURER_KEY) { key = env.LECTURER_KEY; from = 'LECTURER_KEY in .env' }
  else if (parseDotenv(readText(DEV_VARS)).LECTURER_PASSWORD) { key = parseDotenv(readText(DEV_VARS)).LECTURER_PASSWORD; from = '.dev.vars' }
  else if (!o.dryRun) {
    key = await ask('The lecturer key set on that service (Enter to leave it out): ', { hidden: true })
    from = key ? 'typed' : ''
  }
  const values = envValues(service, subdomain, key)
  console.log(`Connecting decks to ${service}${from ? ` (lecturer key: ${from})` : ' (no lecturer key: add TESSERA_LECTURER_KEY to .env yourself)'}`)
  if (from === '.dev.vars') console.log('  note: that is the local test key; if the deployed service uses another one, put that in TESSERA_LECTURER_KEY.')
  if (o.dryRun) showEnv(envFile, values)
  else writeEnv(envFile, values)
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) { console.log(HELP); return }
  const envFile = findEnvFile(o.envFile)
  if (o.existing) return existing(o, envFile)

  const dry = o.dryRun
  const say = (s) => console.log(`\n${dry ? '[dry run] ' : ''}${s}`)

  // 1. logged in?
  say('1/6 Cloudflare login')
  const who = quiet('npx', ['wrangler', 'whoami'])
  const loggedIn = who.code === 0 && !/not authenticated|not logged in/i.test(who.out)
  if (loggedIn) console.log('  logged in')
  else if (dry) console.log('  not logged in: would run `npx wrangler login` (opens the browser)')
  else {
    console.log('  not logged in: opening the browser for `wrangler login`')
    if ((await run('npx', ['wrangler', 'login'], { interactive: true })).code !== 0) fail('wrangler login failed')
  }

  // 2. the lecturer key
  say('2/6 The lecturer key (what a presenter types into the deck once; it unlocks results and controls)')
  const env = parseDotenv(readText(envFile.file))
  const saved = env.TESSERA_LECTURER_KEY ? ['.env', env.TESSERA_LECTURER_KEY] : parseDotenv(readText(DEV_VARS)).LECTURER_PASSWORD ? ['.dev.vars', parseDotenv(readText(DEV_VARS)).LECTURER_PASSWORD] : null
  let key = ''
  if (dry) {
    console.log(saved ? `  would offer the key already in ${saved[0]}, or a new one` : '  would ask for a key, or generate a strong one')
    key = saved ? saved[1] : newKey()
  } else if (o.generateKey) {
    key = newKey(); console.log('  generated a new key')
  } else {
    if (saved && await yes(`  Use the lecturer key already in ${saved[0]}?`)) key = saved[1]
    if (!key) key = await ask('  Type a lecturer key, or press Enter to generate a strong one: ', { hidden: true })
    if (!key) { key = newKey(); console.log('  generated a new key') }
    else if (key.length < 12) console.log('  note: a key under 12 characters is easy to guess; anyone with it controls your polls.')
  }

  // 3. .dev.vars
  say('3/6 .dev.vars (gitignored; the same key for the local tests)')
  if (dry) console.log(`  would set LECTURER_PASSWORD in ${DEV_VARS}`)
  else {
    const had = existsSync(DEV_VARS)
    writeFileSync(DEV_VARS, updateDotenv(readText(DEV_VARS), { LECTURER_PASSWORD: key }))
    console.log(`  ${had ? 'updated' : 'created'} ${DEV_VARS}`)
  }

  // 4. deploy
  say(`4/6 Deploy (worker "${WORKER}")`)
  let url = o.url ? fromUrl(o.url).service : ''
  if (dry) {
    console.log('  would run `npm run deploy` (sync, local end-to-end tests, wrangler deploy); now: npx wrangler deploy --dry-run')
    const r = await run('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', join('dist', 'setup-dry-run')])
    if (r.code !== 0) fail('wrangler deploy --dry-run failed (see above)')
  } else {
    const r = await run('npm', ['run', 'deploy'])
    if (r.code !== 0) {
      if (/workers\.dev subdomain/i.test(r.out)) {
        fail('your account has no workers.dev subdomain yet. Pick one in the Cloudflare dashboard (Workers & Pages), or run `npx wrangler deploy` here once and accept its offer, then run `npm run setup` again.')
      }
      fail('npm run deploy failed (see above). Nothing was written to .env.')
    }
    url ||= urlFromOutput(r.out)
    if (!url) {
      fail(`deployed, but the address was not in wrangler's output. Find it in the Cloudflare dashboard (Workers & Pages → ${WORKER}) and run: npm run setup -- --existing --url https://${WORKER}.<subdomain>.workers.dev`)
    }
    console.log(`  deployed: ${url}`)
  }

  // 5. secrets
  say('5/6 Secrets on the deployed service')
  const putSecret = async (name, value) => {
    if (dry) { console.log(`  would run: npx wrangler secret put ${name}  (value through stdin)`); return }
    const r = await run('npx', ['wrangler', 'secret', 'put', name], { input: value, capture: false })
    if (r.code !== 0) fail(`wrangler secret put ${name} failed (see above)`)
  }
  await putSecret('LECTURER_PASSWORD', key)
  if (o.skipAi) console.log('  OpenRouter key skipped (--skip-ai); AI features stay off until you set OPENROUTER_API_KEY')
  else if (dry) console.log('  would ask for an OpenRouter key (optional; Enter skips) and put it as OPENROUTER_API_KEY')
  else {
    let ai = ''
    if (env.OPENROUTER_API_KEY && await yes('  Use OPENROUTER_API_KEY from .env for the AI features?')) ai = env.OPENROUTER_API_KEY
    if (!ai) ai = await ask('  OpenRouter API key for the AI features (summaries, clusters, helper, games), or Enter to skip: ', { hidden: true })
    if (ai) await putSecret('OPENROUTER_API_KEY', ai)
    else console.log('  skipped; set it later with `npx wrangler secret put OPENROUTER_API_KEY`')
  }

  // 6. .env
  say('6/6 .env (where the deck tools find the service)')
  const { service, subdomain } = fromUrl(url || `https://${WORKER}.your-subdomain.workers.dev`)
  const values = envValues(service, dry && !url ? '' : subdomain, key)
  if (dry) showEnv(envFile, values)
  else writeEnv(envFile, values)

  console.log(dry
    ? '\nDry run done: nothing was written, set or deployed.'
    : `\nDone. Decks created from now on use ${service}.\nYour lecturer key is TESSERA_LECTURER_KEY in ${envFile.file}: type it into a deck's poll panel once when you present.`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(() => { rl?.close() }, (e) => { rl?.close(); fail(e?.message || String(e)) })
}
