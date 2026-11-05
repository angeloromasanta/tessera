#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// The .xlsx writer is a hand-rolled ZIP, which means a single wrong byte offset
// produces a file that downloads fine and then refuses to open — the worst kind
// of failure, because it happens on someone else's machine after the talk.
//
// So: build a workbook, then verify the container with a reader that is not
// ours (python's zipfile, which is what Excel's parser agrees with about
// offsets, CRCs and the central directory). Run: `node scripts/test-xlsx.ts`

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildXlsx, columnName } from '../slides/src/xlsx.ts'

let checks = 0
let failed = 0
function ok(cond: boolean, what: string) {
  checks++
  if (!cond) { failed++; console.error(`  FAIL: ${what}`) }
}
function group(name: string) { console.log(name) }

group('columnName: A1 notation past Z…')
{
  ok(columnName(0) === 'A', '0 → A')
  ok(columnName(25) === 'Z', '25 → Z')
  ok(columnName(26) === 'AA', '26 → AA')
  ok(columnName(51) === 'AZ', '51 → AZ')
  ok(columnName(52) === 'BA', '52 → BA')
  ok(columnName(701) === 'ZZ', '701 → ZZ')
  ok(columnName(702) === 'AAA', '702 → AAA')
}

group('buildXlsx: a container a real reader accepts…')
const dir = mkdtempSync(join(tmpdir(), 'tessera-xlsx-'))
const file = join(dir, 'test.xlsx')
try {
  const blob = buildXlsx([
    {
      name: 'Overview',
      widths: [8, 40],
      rows: [
        ['Slide', 'Question', 'Responses'],
        [1, 'What did you make of it?', 12],
        // The characters that break naive XML writers, all in one cell.
        [2, 'Ampersand & <angle> "quoted" — café 日本語', 3],
      ],
    },
    // A tab name Excel would reject verbatim, and a duplicate of it.
    { name: 'Q1: what/now?[2026]', rows: [['a'], [1.5], [null], ['']] },
    { name: 'Q1: what/now?[2026]', rows: [] },
  ])

  ok(blob.type.includes('spreadsheetml.sheet'), 'the blob announces itself as a workbook')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  ok(bytes[0] === 0x50 && bytes[1] === 0x4b, 'it starts with the ZIP magic (PK)')
  writeFileSync(file, bytes)

  // python's zipfile checks every CRC and every offset — the two things a
  // hand-written archive gets wrong.
  const py = `
import zipfile, sys, xml.etree.ElementTree as ET
z = zipfile.ZipFile(${JSON.stringify(file)})
bad = z.testzip()
assert bad is None, 'corrupt entry: %s' % bad
names = set(z.namelist())
for required in ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
                 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']:
    assert required in names, 'missing %s' % required
# every part must be well-formed XML
for n in names:
    ET.fromstring(z.read(n))
wb = ET.fromstring(z.read('xl/workbook.xml'))
ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
tabs = [s.get('name') for s in wb.iter(ns + 'sheet')]
assert len(tabs) == 3, tabs
assert tabs[0] == 'Overview', tabs
assert all(len(t) <= 31 for t in tabs), tabs
assert not any(c in t for t in tabs for c in '\\\\/?*[]:'), tabs
assert len(set(t.lower() for t in tabs)) == 3, 'duplicate tab names: %s' % tabs
s1 = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
assert 'Ampersand &amp; &lt;angle&gt;' in s1, 'XML escaping'
assert 'caf\\u00e9 \\u65e5\\u672c\\u8a9e' in s1, 'unicode round-trip'
assert '<v>12</v>' in s1, 'numbers are numeric cells'
assert '<c r="C2"' in s1, 'cell references follow the column'
s2 = z.read('xl/worksheets/sheet2.xml').decode('utf-8')
assert '<v>1.5</v>' in s2, 'fractional numbers survive'
assert '<row r="3"></row>' in s2 or '<row r="3"/>' in s2, 'a null cell leaves a gap, not a zero'
print('OK ' + ','.join(tabs))
`
  // python3 on macOS/Linux; on Windows the interpreter is usually `python`
  const run = (exe: string) => execFileSync(exe, ['-c', py], { encoding: 'utf-8' }).trim()
  let out: string
  try { out = run('python3') } catch { out = run('python') }
  ok(out.startsWith('OK '), `an independent reader opens it (${out})`)
} catch (e) {
  failed++
  console.error(`  FAIL: ${(e as Error).message}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed
  ? `\n${failed} FAILED of ${checks} checks`
  : `\nALL PASS (${checks} checks)`)
process.exit(failed ? 1 : 0)
