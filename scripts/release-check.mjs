#!/usr/bin/env node
// Release lint: the public tree must carry no personal or brand material and no
// old product name outside the files that exist to read old decks.
//
//   node scripts/release-check.mjs            lint the tracked tree (git ls-files)
//   node scripts/release-check.mjs --all      also untracked files that git does not ignore
//
// Exit 1 on any finding. Extend PATTERNS from a workspace with RELEASE_CHECK_EXTRA
// (a regex source) to add the names of your own people, courses or brand.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const all = process.argv.includes('--all');
const files = execFileSync('git', ['ls-files', '-z', ...(all ? ['--others', '--cached', '--exclude-standard'] : [])],
  { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);

const base = ['esade', 'romasanta', String.raw`\bangelo`, 'iteratewithai', 'onedrive', String.raw`[A-Z]:[\\/](Users|Projects)`,
  'bootcamp', String.raw`\bbbai\b`, String.raw`\bpaibs\b`, String.raw`\bi4bw\b`, 'vercel\\.app', 'bento'];
const extra = process.env.RELEASE_CHECK_EXTRA ? [process.env.RELEASE_CHECK_EXTRA] : [];
const RE = new RegExp(`(${[...base, ...extra].join('|')})`, 'i');

// Files whose job is to name the old product, and lines that must name it.
const ALLOW_FILE = /(^|\/)legacy[\w.-]*\.(ts|js|mjs|py|json|md)$|(^|\/)legacy\.test\.mjs$|^scripts\/release-check\.mjs$/;
const ALLOW_LINE = [
  /Copyright \(c\) \d{4} The Bento authors|Copyright \(c\) \d{4} Angelo Romasanta and the Tessera contributors/,           // MIT notice (LICENSE, the shell's NOTICE)
  /nyblnet\/bento|bento\.page/,                      // the README / OVERVIEW credit
  /github\.com\/angeloromasanta\/tessera/,           // the project's own URL
  /OLD_LECTURER_HEADER\s*=\s*'x-bento-lecturer'/,    // kit pages talking to an old service
];
// Binary or bundled payloads are checked by name only.
const SKIP = /\.(png|jpe?g|gif|webp|woff2?|ttf|otf|ico|pdf|pptx|zip)$/i;

let bad = 0;
for (const f of files) {
  if (ALLOW_FILE.test(f)) continue;
  if (RE.test(f)) { console.log(`${f}: file name`); bad++; continue; }
  if (SKIP.test(f)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RE.test(line) || ALLOW_LINE.some(a => a.test(line))) continue;
    const m = line.match(RE);
    const at = Math.max(0, m.index - 40);
    console.log(`${f}:${i + 1}: ${line.length > 200 ? '…' + line.slice(at, at + 120) + '…' : line.trim()}`);
    if (++bad > 400) { console.log('… stopping after 400 findings'); process.exit(1); }
  }
}

// Embedded fonts: no commercial licence may ship (Python fontTools does the reading).
try {
  const out = execFileSync('python', ['-I', 'scripts/release-fonts.py', ...files.filter(f => /\.(html|woff2?|ttf|otf)$/i.test(f))],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (out.trim()) { console.log(out.trim()); bad++; }
} catch (e) {
  console.log(`font check failed: ${(e.stdout || e.message || '').toString().trim()}`); bad++;
}

console.log(bad ? `\n${bad} finding(s)` : 'release check: clean');
process.exit(bad ? 1 : 0);
