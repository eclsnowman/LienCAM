import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { buildSetupSheet, buildSetupSheetData } from '../../lib/post/setupSheet'
import { buildSetupSheetPdf, setupSheetOperationPlot, setupSheetPdfFilenameFor } from '../../lib/post/setupSheetPdf'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { parseGcode } from '../../lib/gcode/parse'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { stockWorldBounds } from '../../store/stockAssignment'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type { Project, Setup } from '../../types'

export function fixture(fullSuite = false) {
  if (fullSuite) {
    const project = JSON.parse(gunzipSync(readFileSync('src/tests/evidence/WO-2293/generated-project.json.gz')).toString('utf8')) as Project
    const setup = project.setups[0]
    for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find(t => t.id === op.toolId)!)
    const posted = postProject(project, [setup], UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
    expect(posted.ok).toBe(true)
    return { project, setup, result: posted.combined! }
  }
  const tools = [makeTool(), makeTool({ id: 't2', toolNumber: 2 })]
  const setup: Setup = {
    id: 's1', name: 'Front', wcs: makeWcs(), stock: makeStock(), notes: '',
    operations: [
      makeOp({ id: 'op1', toolId: tools[0].id, toolpathMoves: [move({ type: 'rapid', x: 20, y: 30, z: 5 }), move({ x: 40, y: 50, z: -1 })] }),
      makeOp({ id: 'op2', name: 'Finish (a) \\ b', toolId: tools[1].id, toolpathMoves: [move({ type: 'rapid', x: 120, y: 130, z: 5 }), move({ x: 140, y: 150, z: -1 })] }),
    ],
  }
  const project = { id: 'p', name: 'PDF test', machine: makeMachine(), toolLibrary: tools, geometry: [], setups: [setup], stocks: [], activeSetupId: setup.id, activeOperationId: null, notes: '' } as unknown as Project
  setup.operations.forEach(op => stampGenerationCurrent(project, setup, op, tools.find(t => t.id === op.toolId)!))
  const posted = postProject(project, [setup], UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
  expect(posted.ok).toBe(true)
  return { project, setup, result: posted.combined! }
}

// A focused reader for the writer's uncompressed PDF text. It reads ActualText
// (PDF's standard logical-text mechanism) rather than the input row model.
export function pdfText(bytes: Uint8Array): string[] {
  const source = new TextDecoder().decode(bytes)
  return Array.from(source.matchAll(/\/ActualText <feff([0-9a-f]*)>/g), m => {
    return Array.from(m[1].matchAll(/.{4}/g), c => String.fromCharCode(parseInt(c[0], 16))).join('')
  }).filter(Boolean)
}

describe('WO-2293 setup-sheet PDF', () => {
  it('indents wrapped Full Suite tool rows while preserving their exact logical text', async () => {
    const { project, setup, result } = fixture(true)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const bytes = buildSetupSheetPdf(model, result.gcode)
    const source = new TextDecoder().decode(bytes)
    let row = ''
    const wrapped: number[] = []
    for (const m of source.matchAll(/\/ActualText <feff([0-9a-f]*)> >> BDC\nBT \/F1 9 Tf 1 0 0 1 ([\d.]+) [\d.]+ Tm/g)) {
      if (m[1]) row = Array.from(m[1].matchAll(/.{4}/g), c => String.fromCharCode(parseInt(c[0], 16))).join('')
      else if (row.startsWith('   Tool:')) wrapped.push(Number(m[2]))
    }
    expect(wrapped).toHaveLength(3)
    for (const x of wrapped) expect(x).toBeCloseTo(36 + 3 * 9 * 0.6, 5)
    expect(pdfText(bytes)).toEqual(model.lines.filter(Boolean))
  })
  it('labels solid feeds with the same shallow-to-deep color ramp used by the cut', async () => {
    const { project, setup, result } = fixture()
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const svg = setupSheetOperationPlot(parseGcode(result.gcode), model.operations[0])
    expect(svg).toContain('>feed depth</text>')
    const legend = Array.from(svg.matchAll(/<line[^>]*y1="266"[^>]*stroke="(rgb\([^"]+\))"/g), m => m[1])
    expect(legend).toEqual(['rgb(40,120,180)', 'rgb(130,90,110)', 'rgb(220,60,40)'])
  })
  it('frames Full Suite Pocket 2 on its cutting moves and clips incoming rapids to that frame', async () => {
    const { project, setup, result } = fixture(true)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const op = model.operations[1]
    const points = buildPreviewModel(result.gcode).moves.filter(s => s.kind !== 'rapid' && op.spans.some(span => s.line >= span.startLine && s.line <= span.endLine)).flatMap(s => [s.from, s.to])
    const svg = setupSheetOperationPlot(parseGcode(result.gcode), op)
    expect(svg).toContain(`X ${Math.min(...points.map(p => p.x)).toFixed(1)} .. ${Math.max(...points.map(p => p.x)).toFixed(1)} mm`)
    expect(svg).toContain(`Y ${Math.min(...points.map(p => p.y)).toFixed(1)} .. ${Math.max(...points.map(p => p.y)).toFixed(1)} mm`)
    const rapid = svg.match(/<path d="([^"]+)"[^>]*stroke-dasharray="4 3"/)![1]
    for (const m of rapid.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(34)
      expect(Number(m[1])).toBeLessThanOrEqual(366)
      expect(Number(m[2])).toBeGreaterThanOrEqual(34)
      expect(Number(m[2])).toBeLessThanOrEqual(246)
    }
  })
  it('draws Full Suite Bore 3 feeds across its posted cutting extents, including circular arcs', async () => {
    const { project, setup, result } = fixture(true)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const bore = model.operations[2]
    const svg = setupSheetOperationPlot(parseGcode(result.gcode), bore)
    expect(svg).toContain('stroke-width="3.2" stroke-linecap="round"')
    expect(svg).toMatch(/<circle[^>]*fill="none" stroke="#111"/)
    const posted = buildPreviewModel(result.gcode)
    expect(posted.refusal).toBeNull()
    const cutting = posted.moves.filter(s => s.kind !== 'rapid' && bore.spans.some(span => s.line >= span.startLine && s.line <= span.endLine))
    const points = cutting.flatMap(s => [s.from, s.to])
    const drawn = Array.from(svg.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)" stroke="rgb\([^"]+\)"/g)).filter(m => m[2] !== '266').flatMap(m => [[Number(m[1]), Number(m[2])], [Number(m[3]), Number(m[4])]])
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBe(cutting.length * 2)
    const pdf = new TextDecoder().decode(buildSetupSheetPdf(model, result.gcode))
    const forms = Array.from(pdf.matchAll(/\/Subtype \/Form[^]*?stream\n([^]*?)\nendstream/g), m => m[1])
    const pdfFeeds = Array.from(forms[2].matchAll(/3\.2 w\n1 J\n\[\] 0 d\n([\d.-]+) ([\d.-]+) m ([\d.-]+) ([\d.-]+) l S/g)).flatMap(m => [[Number(m[1]), 280 - Number(m[2])], [Number(m[3]), 280 - Number(m[4])]])
    // Inspect the PDF form itself, including its solid feed operators; an SVG
    // alone cannot prove that the translation actually prints those cuts.
    expect(pdfFeeds.length).toBe(cutting.length * 2)
    expect(Math.max(...pdfFeeds.map(p => p[0])) - Math.min(...pdfFeeds.map(p => p[0]))).toBeCloseTo(Math.max(...drawn.map(p => p[0])) - Math.min(...drawn.map(p => p[0])), 2)
    expect(Math.max(...pdfFeeds.map(p => p[1])) - Math.min(...pdfFeeds.map(p => p[1]))).toBeCloseTo(Math.max(...drawn.map(p => p[1])) - Math.min(...drawn.map(p => p[1])), 2)
    const spanX = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))
    const spanY = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))
    // Recover the current fit independently from its labelled world-coordinate frame.
    const x = svg.match(/X ([\d.-]+) \.\. ([\d.-]+) mm/)!
    const y = svg.match(/Y ([\d.-]+) \.\. ([\d.-]+) mm/)!
    const scale = Math.min(332 / (Number(x[2]) - Number(x[1])), 212 / (Number(y[2]) - Number(y[1])))
    expect((Math.max(...drawn.map(p => p[0])) - Math.min(...drawn.map(p => p[0]))) / scale).toBeCloseTo(spanX, 1)
    expect((Math.max(...drawn.map(p => p[1])) - Math.min(...drawn.map(p => p[1]))) / scale).toBeCloseTo(spanY, 1)
  })
  it.each(['Letter', 'A4'] as const)('%s parses, contains every original row, and one vector picture per operation', async paper => {
    const { project, setup, result } = fixture()
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const bytes = buildSetupSheetPdf(model, result.gcode, paper)
    const source = new TextDecoder().decode(bytes)
    expect(pdfText(bytes)).toEqual((await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)).split('\n').filter(Boolean))
    expect(source.match(/\/Subtype \/Form/g)).toHaveLength(2)
    expect(source.match(/\/Plot\d+ Do/g)).toHaveLength(2)
    expect(source).toContain(paper === 'A4' ? '/MediaBox [0 0 595.28 841.89]' : '/MediaBox [0 0 612 792]')
    const xref = Number(source.match(/startxref\n(\d+)/)![1])
    expect(source.slice(xref, xref + 4)).toBe('xref')
    const entries = source.slice(xref).split('\n').slice(3).filter(l => /^\d{10} 00000 n/.test(l))
    entries.forEach((entry, i) => expect(source.slice(Number(entry.slice(0, 10)))).toMatch(new RegExp(`^${i + 1} 0 obj`)))
    // Every displayed baseline sits inside the printable area.
    for (const m of source.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0)
      expect(Number(m[2])).toBeGreaterThanOrEqual(0)
    }
  })

  it.each([false, true])('uses each operation own NC range and posted X/Y extents (Full Suite: %s)', async fullSuite => {
    const { project, setup, result } = fixture(fullSuite)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const program = parseGcode(result.gcode)
    const preview = buildPreviewModel(result.gcode)
    expect(preview.refusal).toBeNull()
    model.operations.forEach(op => {
      const svg = setupSheetOperationPlot(program, op)
      const segments = preview.moves.filter(s => op.spans.some(span => s.line >= span.startLine && s.line <= span.endLine))
      const points = segments.filter(s => s.kind !== 'rapid').flatMap(s => [s.from, s.to])
      const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x))
      const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y))
      expect(svg).toContain(`X ${minX.toFixed(1)} .. ${maxX.toFixed(1)} mm`)
      expect(svg).toContain(`Y ${minY.toFixed(1)} .. ${maxY.toFixed(1)} mm`)
      const scale = Math.min(332 / Math.max(maxX - minX, 1e-6), 212 / Math.max(maxY - minY, 1e-6))
      const paths = [...svg.matchAll(/<(?:line|path)\b[^>]*stroke="(?:rgb\([^"]+\)|#d95f02)"[^>]*>/g)].map(m => m[0]).filter(tag => !tag.includes('y1="266"'))
      const coords = paths.flatMap(tag => tag.startsWith('<path')
        ? Array.from(tag.matchAll(/[ML] ([\d.]+) ([\d.]+)/g), m => [Number(m[1]), Number(m[2])])
        : [[Number(tag.match(/x1="([\d.]+)"/)![1]), Number(tag.match(/y1="([\d.]+)"/)![1])], [Number(tag.match(/x2="([\d.]+)"/)![1]), Number(tag.match(/y2="([\d.]+)"/)![1])]])
      expect((Math.max(...coords.map(p => p[0])) - Math.min(...coords.map(p => p[0]))) / scale).toBeCloseTo(maxX - minX, 1)
      expect((Math.max(...coords.map(p => p[1])) - Math.min(...coords.map(p => p[1]))) / scale).toBeCloseTo(maxY - minY, 1)
      expect(svg).toContain('stroke-dasharray="4 3"')
      expect(svg).toContain('>start</text>')
      expect(svg).toContain('stroke="rgb(')
    })
    const span = model.operations[1].spans[0]
    const inherited = program.segments.find(s => s.line >= span.startLine)!
    expect(inherited.from.x).toBeGreaterThan(0)
  })

  it('keeps selected-op sheets and their pictures in agreement', async () => {
    const { project, setup } = fixture()
    const selected = { [setup.id]: [setup.operations[1].id] }
    const posted = postProject(project, [setup], UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc', selectedOpIds: selected })
    expect(posted.ok).toBe(true)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, posted.combined!, 'part.nc', stockWorldBounds, selected)
    expect(model.operations).toHaveLength(1)
    expect(new TextDecoder().decode(buildSetupSheetPdf(model, posted.combined!.gcode)).match(/\/Subtype \/Form/g)).toHaveLength(1)
  })

  it('retains Unicode and long row values across wrapped, paginated text', async () => {
    const { project, setup, result } = fixture()
    setup.operations[0].name = '\u5207\u524a' + ' long name'.repeat(160)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const pdf = buildSetupSheetPdf(model, result.gcode)
    expect(pdfText(pdf)).toEqual(model.lines.filter(Boolean))
    expect(new TextDecoder().decode(pdf).match(/\/Type \/Page /g)!.length).toBeGreaterThan(1)
  })

  it('uses the same inch rounding and original strings as the text sheet', async () => {
    const { project, setup } = fixture()
    const config = { ...UCCNC_CONFIG, format: { ...UCCNC_CONFIG.format, units: 'inch' as const } }
    const posted = postProject(project, [setup], config, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
    expect(posted.ok).toBe(true)
    const model = await buildSetupSheetData(project, [setup], config, posted.combined!, 'part.nc', stockWorldBounds)
    expect(pdfText(buildSetupSheetPdf(model, posted.combined!.gcode))).toEqual(model.lines.filter(Boolean))
    expect(setupSheetOperationPlot(parseGcode(posted.combined!.gcode), model.operations[0], 'inch')).toContain(' in</text>')
  })

  it('writes every colour operator with three operands, short #rgb colours included', async () => {
    const { project, setup, result } = fixture(true)
    const model = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const source = new TextDecoder().decode(buildSetupSheetPdf(model, result.gcode))
    const ops = Array.from(source.matchAll(/^((?:[\d.]+ )+)(rg|RG)$/gm), m => m[1].trim().split(' ').length)
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.filter(n => n !== 3)).toEqual([])
  })

  it('derives matching PDF names', () => {
    expect(setupSheetPdfFilenameFor('part-G54.nc')).toBe('part-G54.setup.pdf')
    expect(setupSheetPdfFilenameFor('part')).toBe('part.setup.pdf')
  })
})
