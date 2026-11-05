// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// A minimal .xlsx writer — a few hundred bytes of XML in a ZIP, no dependency.
//
// Why not CSV: "export to Excel" means a file that opens with its columns,
// types and multiple sheets intact. CSV loses the sheet-per-question split, and
// it mangles the two things audience answers are full of — commas and line
// breaks — differently in every locale Excel is configured for.
//
// Why not a library: the shell is ~560KB total and the app deleted a 630KB chart
// dependency to get there (see charts.ts). SheetJS is larger than everything
// this file needs by two orders of magnitude, and what it needs is genuinely
// small: xlsx is an OPC package, an OPC package is a ZIP, and a ZIP with every
// entry STORED (no compression) is a header, the bytes, and a directory.
//
// Deliberately narrow: strings and numbers, one row per record, no styling
// beyond a bold header row and column widths. If a later app needs
// formulas or formats, this is the file to grow — the writer is the shape a
// spreadsheet app would want, not a poll-shaped helper.

export type CellValue = string | number | null | undefined

export interface Sheet {
  /** tab name; sanitized and de-duplicated to Excel's rules */
  name: string
  /** row-major cells; the first row is styled as a header */
  rows: CellValue[][]
  /** optional per-column widths, in Excel's "characters" unit */
  widths?: number[]
}

// --- XML ----------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Excel rejects the whole file over a control character an audience member
    // can absolutely paste in from a phone keyboard. Strip, don't fail.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/** 0 → A, 25 → Z, 26 → AA … */
export function columnName(i: number): string {
  let n = i + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Excel forbids these in a tab name, caps it at 31 chars, and refuses a
 *  workbook with two tabs that differ only in case. */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>()
  return sheets.map((s, i) => {
    const base = (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`
    let name = base
    let n = 2
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${n++})`
      name = base.slice(0, 31 - suffix.length) + suffix
    }
    used.add(name.toLowerCase())
    return name
  })
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows.map((cells, r) => {
    const parts = cells.map((v, c) => {
      if (v === null || v === undefined || v === '') return ''
      const ref = `${columnName(c)}${r + 1}`
      const style = r === 0 ? ' s="1"' : ''
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `<c r="${ref}"${style}><v>${v}</v></c>`
      }
      // inlineStr keeps the whole workbook to one pass — no shared-strings
      // table to build, dedupe and index.
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`
    })
    return `<row r="${r + 1}">${parts.join('')}</row>`
  })

  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`
}

/** Two fonts (regular, bold) and two cellXfs — index 1 is the header style. */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>\
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>\
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>\
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>\
</styleSheet>`

// --- ZIP (stored entries only) -------------------------------------------------

let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Entry { name: string; data: Uint8Array; crc: number }

/**
 * Build a ZIP with every entry stored uncompressed. XML compresses well, so
 * this trades file size for having no deflate implementation at all — an
 * export of 500 answers is still tens of kilobytes, and DecompressionStream
 * (which the shell already relies on) has no compression twin everywhere.
 */
function zip(files: Array<{ name: string; text: string }>): Blob {
  const enc = new TextEncoder()
  const entries: Entry[] = files.map((f) => {
    const data = enc.encode(f.text)
    return { name: f.name, data, crc: crc32(data) }
  })

  const chunks: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0

  // MS-DOS timestamps have no timezone and 2-second granularity; a fixed
  // 1980-01-01 keeps the output byte-identical for identical content, which
  // makes "did the answers change?" a diff rather than a guess.
  const dosTime = 0
  const dosDate = 33 // (1980-1980)<<9 | 1<<5 | 1

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)      // version needed
    lv.setUint16(6, 0x0800, true)  // UTF-8 names
    lv.setUint16(8, 0, true)       // method: stored
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, e.crc, true)
    lv.setUint32(18, e.data.length, true)
    lv.setUint32(22, e.data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    chunks.push(local, e.data)

    const dir = new Uint8Array(46 + nameBytes.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(4, 20, true)      // version made by
    dv.setUint16(6, 20, true)      // version needed
    dv.setUint16(8, 0x0800, true)
    dv.setUint16(10, 0, true)
    dv.setUint16(12, dosTime, true)
    dv.setUint16(14, dosDate, true)
    dv.setUint32(16, e.crc, true)
    dv.setUint32(20, e.data.length, true)
    dv.setUint32(24, e.data.length, true)
    dv.setUint16(28, nameBytes.length, true)
    dv.setUint32(42, offset, true)
    dir.set(nameBytes, 46)
    central.push(dir)

    offset += local.length + e.data.length
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  chunks.push(...central, end)
  return new Blob(chunks, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

// --- workbook ------------------------------------------------------------------

/** A workbook, ready to download. At least one sheet; empty sheets are legal
 *  (a question nobody answered is a fact worth exporting). */
export function buildXlsx(sheets: Sheet[]): Blob {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]
  const names = sheetNames(list)

  const files: Array<{ name: string; text: string }> = [
    {
      name: '[Content_Types].xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
<Default Extension="xml" ContentType="application/xml"/>\
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}\
</Types>`,
    },
    {
      name: '_rels/.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" \
xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>\
${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}\
</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}\
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\
</Relationships>`,
    },
    { name: 'xl/styles.xml', text: STYLES_XML },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s) })),
  ]

  return zip(files)
}

/** Save a workbook the way the rest of the app saves files: a blob URL and a
 *  synthetic click (kernel/src/save.ts downloadFile, for HTML). */
export function downloadXlsx(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
