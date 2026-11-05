#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
//
// `npm run build:single`, portable. The one-liner it replaces set SINGLEFILE=1
// inline and used `mv`, which cmd.exe (what npm spawns on Windows) does not
// understand — the vite build then ran WITHOUT the single-file plugin and
// upgrade-deck.mjs happily re-hosted every deck on the stale shell.
import { execSync } from 'node:child_process'
import { renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const slides = join(dirname(dirname(fileURLToPath(import.meta.url))), 'slides')
const run = (cmd) => execSync(cmd, { cwd: slides, stdio: 'inherit', env: { ...process.env, SINGLEFILE: '1' } })

run('npx tsc -b')
run('npx vite build --outDir dist-single')
renameSync(join(slides, 'dist-single/index.html'), join(slides, 'dist-single/tessera.html'))
run('node ../scripts/postbuild-compress.mjs dist-single/tessera.html')
