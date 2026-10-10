// WO-2293: dependency-free PDF presentation of the shared setup-sheet rows.
// The backplot owns geometry, fitting, depth colours, rapids and start marks.
// This writer only translates its small SVG vocabulary into PDF vector graphics.
import { backplotSvg } from '../gcode/backplot'
import { parseGcode } from '../gcode/parse'
import { buildPreviewModel } from '../machine/previewGeometry'
import type { GcodeProgram } from '../gcode/parse'
import type { SetupSheetData, SetupSheetOperation } from './setupSheet'

const sampledPrograms = new WeakMap<GcodeProgram, { segments: GcodeProgram['segments']; canonicalMm: boolean }>()

export function setupSheetPdfFilenameFor(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return `${dot > 0 ? filename.slice(0, dot) : filename}.setup.pdf`
}

/** Parse the WHOLE file first: a span inherits modal position/feed/motion from
 * preceding operations. Parsing sliced NC text would invent an origin move. */
export function setupSheetOperationPlot(program: GcodeProgram, operation: SetupSheetOperation, units: 'mm' | 'inch' = 'mm'): string {
  let sampled = sampledPrograms.get(program)
  if (!sampled) {
    const lines: string[] = []
    for (const line of program.lines) lines[line.number - 1] = line.raw
    // The shared Control preview already resolves modal state, arcs (including
    // full circles/helices), planes and canned cycles. Do not draw arc chords
    // directly from parseGcode: a closed circle would become a zero-length line.
    const preview = buildPreviewModel(lines.join('\n'))
    const segments = preview.refusal === null ? preview.moves.map(move => ({
      kind: move.kind, from: move.from, to: move.to, line: move.line,
    })) : program.segments
    sampled = { segments, canonicalMm: preview.refusal === null }
    sampledPrograms.set(program, sampled)
  }
  const scale = sampled.canonicalMm && units === 'inch' ? 25.4 : 1
  const point = (p: { x: number; y: number; z: number }) => ({ x: p.x / scale, y: p.y / scale, z: p.z / scale })
  const segments = sampled.segments.filter(s => operation.spans.some(
    span => s.line >= span.startLine && s.line <= span.endLine,
  )).map(s => ({ ...s, from: point(s.from), to: point(s.to) }))
  return backplotSvg({ ...program, segments }, {
    width: 400, height: 280, margin: 34, title: 'Posted moves', colorByDepth: true, units, fitToCuttingMoves: true, feedStrokeWidth: 3.2,
  })
}

// All PDF syntax stays ASCII, so byte offsets equal string offsets. Names use
// WinAnsi where available; other glyphs display as explicit Unicode escapes.
// ActualText retains the original value for copying/extraction, including wraps.
function displayText(text: string): string {
  return Array.from(text, ch => {
    const n = ch.codePointAt(0)!
    return n >= 32 && n <= 255 ? ch : `\\u{${n.toString(16)}}`
  }).join('')
}
function literal(text: string): string {
  return '(' + text.replace(/[\\()\x80-\xff]/g, ch => {
    return ch.charCodeAt(0) >= 128 ? `\\${ch.charCodeAt(0).toString(8).padStart(3, '0')}` : `\\${ch}`
  }) + ')'
}
function utf16(text: string): string {
  return 'feff' + Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16).padStart(4, '0')).join('')
}
function textAt(text: string, x: number, y: number, size: number): string {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm ${literal(displayText(text))} Tj ET\n`
}
function rgb(value: string): string {
  // backplotSvg uses both #rrggbb and the short #rgb form (#666): rg/RG need three operands.
  const hex = value.startsWith('#') ? value.slice(1) : ''
  const full = hex.length === 3 ? hex.replace(/./g, c => c + c) : hex
  const bytes = hex
    ? full.match(/../g)!.map(v => parseInt(v, 16))
    : value.match(/[\d.]+/g)!.map(Number)
  return bytes.map(v => (v / 255).toFixed(4)).join(' ')
}

/** Translate only backplotSvg's fixed, trusted drawing vocabulary. No geometry
 * reconstruction here: even the fitted coordinates come from the backplot. */
function svgDrawing(svg: string): string {
  const output: string[] = []
  let inherited: Record<string, string> = {}
  for (const match of svg.matchAll(/<(g|line|rect|path|circle|text)\b([^>]*?)(?:\/>|>([^<]*)<\/text>|>)/g)) {
    const attrs = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), m => [m[1], m[2]]))
    if (match[1] === 'g') { inherited = attrs; continue }
    const a = { ...inherited, ...attrs }
    const n = (key: string) => Number(a[key] ?? 0)
    output.push('q')
    if (a.stroke && a.stroke !== 'none') output.push(`${rgb(a.stroke)} RG`)
    if (a.fill && a.fill !== 'none') output.push(`${rgb(a.fill)} rg`)
    output.push(`${a['stroke-width'] ?? 1} w`, a['stroke-linecap'] === 'round' ? '1 J' : '0 J')
    output.push(a['stroke-dasharray'] ? `[${a['stroke-dasharray']}] 0 d` : '[] 0 d')
    switch (match[1]) {
      case 'line':
        output.push(`${n('x1')} ${280 - n('y1')} m ${n('x2')} ${280 - n('y2')} l S`)
        break
      case 'rect':
        output.push(`${n('x')} ${280 - n('y') - n('height')} ${n('width')} ${n('height')} re ${a.fill === 'none' ? 'S' : 'f'}`)
        break
      case 'path': {
        const words = a.d.trim().split(/\s+/)
        const path: string[] = []
        for (let i = 0; i < words.length; i += 3) {
          path.push(`${words[i + 1]} ${280 - Number(words[i + 2])} ${words[i] === 'M' ? 'm' : 'l'}`)
        }
        output.push(path.join(' ') + ' S')
        break
      }
      case 'circle': {
        const x = n('cx'), y = 280 - n('cy'), r = n('r'), c = r * 0.55228475
        output.push(`${x + r} ${y} m ${x + r} ${y + c} ${x + c} ${y + r} ${x} ${y + r} c ` +
          `${x - c} ${y + r} ${x - r} ${y + c} ${x - r} ${y} c ` +
          `${x - r} ${y - c} ${x - c} ${y - r} ${x} ${y - r} c ` +
          `${x + c} ${y - r} ${x + r} ${y - c} ${x + r} ${y} c ${a.fill === 'none' ? 'S' : 'f'}`)
        break
      }
      case 'text':
        output.push(textAt((match[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), n('x'), 280 - n('y'), n('font-size')))
        break
    }
    output.push('Q')
  }
  return output.join('\n')
}

/** Letter by default; A4 uses the same safe margins and operation cards. */
export function buildSetupSheetPdf(sheet: SetupSheetData, gcode: string, paper: 'Letter' | 'A4' = 'Letter'): Uint8Array<ArrayBuffer> {
  const [width, height] = paper === 'A4' ? [595.28, 841.89] : [612, 792]
  const margin = 36
  const objects: string[] = ['', ''] // catalog and page tree, populated last
  const add = (body: string) => { objects.push(body); return objects.length }
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')
  const stream = (body: string, extra = '') => add(`<< /Length ${body.length} ${extra} >>\nstream\n${body}\nendstream`)
  const pages: number[] = []
  let content = ''
  let y = height - margin
  let pageNo = 0
  const forms: Record<string, number> = {}
  const flush = () => {
    if (!content) return
    content += textAt(`Page ${++pageNo}`, width - margin - 55, 22, 8)
    const contents = stream(content)
    pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> /XObject << ${Object.entries(forms).map(([name, id]) => `/${name} ${id} 0 R`).join(' ')} >> >> /Contents ${contents} 0 R >>`))
    content = ''
    y = height - margin
  }
  const wrappedRow = (value: string, available: number, size: number) => {
    const shown = displayText(value)
    const maxChars = Math.floor(available / (size * 0.6))
    const indent = value.match(/^ */)![0].length
    const chunks = [shown.slice(0, maxChars)]
    for (let start = maxChars; start < shown.length; start += Math.max(1, maxChars - indent)) {
      chunks.push(shown.slice(start, start + Math.max(1, maxChars - indent)))
    }
    return { chunks, indent }
  }
  const line = (value: string, available = width - 2 * margin) => {
    const size = value === 'LienCAM Setup Sheet' ? 16 : 9
    const { chunks, indent } = wrappedRow(value, available, size)
    // Keep each original row's value together for copy/extraction even when
    // an unusually long name wraps across physical lines or pages.
    for (let i = 0; i < chunks.length; i++) {
      if (y < margin + size + 2) flush()
      // ActualText on the first chunk holds the complete source row. The
      // remaining visible chunks are marked empty to avoid duplicated text.
      content += `/Span << /ActualText <${utf16(i === 0 ? value : '')}> >> BDC\n`
      content += textAt(chunks[i], margin + (i === 0 ? 0 : indent * size * 0.6), y - size, size) + 'EMC\n'
      y -= size + 5
    }
  }
  const program = parseGcode(gcode)
  const byRow = new Map(sheet.operations.map((op, i) => [op.rowStart, { op, i }]))
  for (let row = 0; row < sheet.lines.length;) {
    const entry = byRow.get(row)
    if (!entry) { line(sheet.lines[row++]); continue }
    const pictureWidth = 190
    const pictureHeight = pictureWidth * 280 / 400
    const textWidth = width - 2 * margin - pictureWidth - 12
    const rows = sheet.lines.slice(entry.op.rowStart, entry.op.rowEnd)
    const rowHeight = rows.reduce((sum, value) => sum + wrappedRow(value, textWidth, 9).chunks.length * 14, 0)
    const cardHeight = Math.max(rowHeight, pictureHeight) + 14
    if (y - Math.min(cardHeight, height - 2 * margin) < margin) flush()
    const top = y
    const svg = setupSheetOperationPlot(program, entry.op, sheet.lines[2] === 'Units: in' ? 'inch' : 'mm')
    const name = `Plot${entry.i + 1}`
    forms[name] = stream(svgDrawing(svg), `/Type /XObject /Subtype /Form /BBox [0 0 400 280] /Resources << /Font << /F1 ${font} 0 R >> >>`)
    content += `q ${pictureWidth / 400} 0 0 ${pictureWidth / 400} ${width - margin - pictureWidth} ${top - pictureHeight} cm /${name} Do Q\n`
    for (const value of rows) line(value, textWidth)
    // A pathological name can span pages; the picture stays on its first page.
    if (y <= top && top - y < height - 2 * margin) y = Math.min(y, top - pictureHeight)
    y -= 14
    row = entry.op.rowEnd
  }
  flush()
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${pages.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  // The binary comment also prevents Git's text checkout conversion from
  // rewriting newlines and invalidating PDF stream lengths/xref offsets.
  let pdf = '%PDF-1.4\n%binary\0\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
