// @vitest-environment jsdom
// Hand-written DXFs, exercised through both real product import routes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'
import { importDXF } from '../../lib/import/dxfImporter'
import { signedArea } from '../../lib/geometry/path2d'
import type { Vec2, ImportedGeometry } from '../../types'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import type { Sketch } from '../../lib/sketch/types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  removeItem: (key: string) => { mem.delete(key) },
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
} })
vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))
const { useCamStore } = await import('../../store')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')
const { bindSketcherDocument, sketcherTools } = await import('../../lib/sketch/sketcher/toolController')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')

function fixture(name: string) {
  return readFileSync(resolve('src/tests/import/fixtures/wo2288', `${name}.dxf`), 'utf8').replace(/\r\n/g, '\n')
}
function bbox(points: Vec2[]) {
  return [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)),
    Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y))]
}
function expectBox(actual: number[], expected: number[]) {
  expected.forEach((n, i) => expect(actual[i]).toBeCloseTo(n, 7))
}
const cases = [
  { name: 'single', boxes: [[20, 30, 24, 32]], signs: [1] },
  { name: 'copies', boxes: [[16, 30, 20, 38], [36, 50, 40, 52]], signs: [1, -1] },
  { name: 'nested', boxes: [[64, 200, 88, 204]], signs: [1] },
  { name: 'array', boxes: [[14, 30, 20, 38], [14, 45, 20, 53], [2, 30, 8, 38],
    [2, 45, 8, 53], [-10, 30, -4, 38], [-10, 45, -4, 53]], signs: [1, 1, 1, 1, 1, 1] },
  { name: 'extrusion', boxes: [[-20, 30, -16, 38]], signs: [-1] },
  { name: 'paper', boxes: [[20, 30, 24, 32]], signs: [1] },
  { name: 'inches', boxes: [[508, 762, 609.6, 812.8]], signs: [1] },
  { name: 'annotations', boxes: [[20, 30, 24, 32]], signs: [1] },
]

function sketchHarness() {
  let sketch: Sketch = createBlankSketch('insert-import')
  const notice = vi.fn()
  const port: SketchDocumentPort = {
    getSketch: () => sketch, ensureSketch: () => sketch,
    getDisplayUnits: () => 'mm', getGridSpacing: () => 1, getProjectCandidates: () => [],
    getSelection: () => [], setSelection: () => {}, getLastStagedSize: () => null,
    setLastStagedSize: () => {}, notice, beginStep: () => {},
    append: (commit, inferred) => { sketch = { ...sketch,
      entities: [...sketch.entities, ...commit.entities],
      constraints: [...sketch.constraints, ...commit.constraints, ...inferred],
      dimensions: [...sketch.dimensions, ...(commit.dimensions ?? [])],
    } },
    replace: () => {}, toggleSelectionConstruction: () => false, deleteSelection: () => {},
    dragBegin: () => false, dragMove: () => {}, dragEnd: () => {}, moveDimLabel: () => {},
    openDimEditor: () => {}, getTextEditId: () => null, getPickPathForTextId: () => null,
    editText: () => {}, commitTextEdit: () => {}, cancelTextEdit: () => {},
    cancelPickTextPath: () => {}, placeText: () => {}, bindTextPath: () => {},
  }
  bindSketcherDocument(port)
  return { getSketch: () => sketch, notice }
}
beforeEach(() => {
  bindSketcherDocument(null)
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})

describe('WO-2288 block placement in Y-up drawing coordinates', () => {
  for (const { name, boxes, signs } of cases) {
    it(`${name}: importer preserves placed boxes and winding`, () => {
      const result = importDXF(fixture(name), { keepOrigin: true })
      expect(result.loops).toHaveLength(boxes.length)
      result.loops.forEach((loop, i) => {
        expect(loop.closed).toBe(true)
        expectBox(bbox(loop.points), boxes[i])
        expect(Math.sign(signedArea(loop.points))).toBe(signs[i])
        expect(loop.layerId).toBe('Cut')
      })
      expect(result.report.skipped.some(e => e.type.startsWith('INSERT'))).toBe(false)
    })

    it(`${name}: CAM and sketch production entry points import every copy`, async () => {
      const file = new File([fixture(name)], `${name}.dxf`)
      const deps = { importBrepGeometry: vi.fn(), addGeometry: vi.fn() }
      await importGeometryFile(file, deps, { keepOrigin: true })
      const geometry = deps.addGeometry.mock.calls[0][0] as ImportedGeometry
      expect(geometry.loops).toHaveLength(boxes.length)
      geometry.loops!.forEach((loop, i) => expectBox(bbox(loop.points), boxes[i]))
      expect(useCamStore.getState().consoleEvents.map(e => e.message).join('\n')).not.toMatch(/INSERT.*not imported/)
      const sketch = sketchHarness()
      await sketcherTools.importFileIntoSketch(file, { keepOrigin: true })
      const lines = sketch.getSketch().entities.filter(e => e.kind === 'line' && !e.id.startsWith('__'))
      expect(lines).toHaveLength(4 * boxes.length)
      // Check each placed loop, rather than only the combined extents.
      boxes.forEach((box, i) => {
        const points = lines.slice(i * 4, i * 4 + 4).flatMap(e => e.kind === 'line' ? [e.start, e.end] : [])
        expectBox(bbox(points), box)
      })
      expect(sketch.notice.mock.calls.at(-1)?.[0]).toContain(`${boxes.length} loop`)
      expect(sketch.notice.mock.calls.at(-1)?.[0]).not.toMatch(/INSERT.*not imported/)
    })
  }

  it('inherits layer 0 while keeping explicitly named child layers', () => {
    const result = importDXF(fixture('named-layers'), { keepOrigin: true })
    expect(result.loops.map(l => l.layerId)).toEqual(['Placed', 'Detail'])
    expect(result.layers.map(l => l.id)).toEqual(['Placed', 'Detail'])
    expectBox(bbox(result.loops[1].points), [20, 31, 24, 31])
  })

  it('bounds self-references and names the definition in the existing skip note', () => {
    const result = importDXF(fixture('recursive'))
    expect(result.loops).toHaveLength(0)
    expect(result.report.skipped).toEqual([{ type: 'INSERT Loop', count: 1 }])
  })

  it('keeps the existing centering policy after expanding all copies', () => {
    const result = importDXF(fixture('copies'))
    expectBox(bbox(result.loops.flatMap(l => l.points)), [-12, -11, 12, 11])
  })

  const samplers = {
    LINE: [[10, 1], [20, 2], [11, 8], [21, 4]],
    ARC: [[10, 1], [20, 2], [40, 3], [50, 0], [51, 180]],
    CIRCLE: [[10, 1], [20, 2], [40, 3]],
    LWPOLYLINE: [[70, 0], [10, 1], [20, 2], [42, 1], [10, 8], [20, 2]],
    POLYLINE: [[70, 0], [0, 'VERTEX'], [10, 1], [20, 2], [42, 1],
      [0, 'VERTEX'], [10, 8], [20, 2], [0, 'SEQEND']],
    SPLINE: [[70, 0], [71, 2], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1],
      [10, 1], [20, 2], [10, 3], [20, 8], [10, 8], [20, 2]],
    ELLIPSE: [[10, 1], [20, 2], [11, 3], [21, 0], [40, 0.5], [41, 0], [42, Math.PI]],
  }
  for (const [type, pairs] of Object.entries(samplers)) {
    it(`reuses ${type} sampling inside an unused-base, mirrored, rotated block`, () => {
      const entity = [[0, type], [8, '0'], ...pairs]
      const encode = (data: (string | number)[][]) => data.map(p => p.join('\n')).join('\n') + '\n'
      const plain = importDXF(encode([[0, 'SECTION'], [2, 'ENTITIES'], ...entity,
        [0, 'ENDSEC'], [0, 'EOF']]), { keepOrigin: true })
      const inserted = importDXF(encode([[0, 'SECTION'], [2, 'BLOCKS'],
        [0, 'BLOCK'], [2, 'ENTITIES'], [10, 1], [20, 2], ...entity, [0, 'ENDBLK'], [0, 'ENDSEC'],
        [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [2, 'entities'], [8, 'Cut'],
        [10, 20], [20, 30], [41, -2], [42, 3], [50, 90],
        [0, 'ENDSEC'], [0, 'EOF']]), { keepOrigin: true })
      expect(plain.loops).toHaveLength(1)
      expect(inserted.loops).toHaveLength(1)
      // For R(90) * S(-2,3) * T(-1,-2), x'=20-3(y-2), y'=30-2(x-1).
      const expected = plain.loops[0].points.map(p => ({ x: 20 - 3 * (p.y - 2), y: 30 - 2 * (p.x - 1) }))
      const actual = inserted.loops[0].points
      expect(actual).toHaveLength(expected.length)
      expected.forEach((p, i) => expectBox([actual[i].x, actual[i].y], [p.x, p.y]))
      expect(inserted.loops[0].layerId).toBe('Cut')
      expect(inserted.report.skipped).toEqual([])
    })
  }

  it('does not import unused block geometry or let INSERT attributes leak into a following LINE', () => {
    const text = fixture('single').replace('0\nENDSEC\n0\nEOF',
      '0\nATTRIB\n10\n500\n20\n600\n1\nLabel\n0\nSEQEND\n0\nLINE\n8\nCut\n10\n80\n20\n90\n11\n84\n21\n90\n0\nENDSEC\n0\nEOF')
    const result = importDXF(text, { keepOrigin: true })
    expect(result.loops).toHaveLength(2)
    expectBox(bbox(result.loops[0].points), [20, 30, 24, 32])
    expectBox(bbox(result.loops[1].points), [80, 90, 84, 90])
    expect(result.report.skipped).toEqual([{ type: 'ATTRIB', count: 1 }])
    const unused = importDXF(fixture('single').replace('0\nINSERT', '0\nTEXT'))
    expect(unused.loops).toHaveLength(0)
  })
})

it('WO-2288 leaves existing production fixture geometry byte-identical to main', () => {
  const paths = [
    'Sample Parts/Leadscrew_Stepper_Mount.DXF',
    'src/tests/evidence/WO-1841/bracket-with-spline.dxf',
    'src/tests/evidence/WO-1860/fixture.dxf',
    'src/tests/evidence/WO-1904/fixture-100-50.dxf',
    'src/tests/evidence/WO-2130/fixtures/Leadscrew_Stepper_Mount.dxf',
  ]
  const hashes = Object.fromEntries(paths.map(path => {
    const result = importDXF(readFileSync(resolve(path), 'utf8'))
    return [path, createHash('sha256').update(JSON.stringify(result)).digest('hex')]
  }))
  const baseline = resolve('src/tests/evidence/WO-2288/main-fixture-hashes.json')
  if (process.env.WO2288_RECORD_BASELINE === '1') writeFileSync(baseline, JSON.stringify(hashes, null, 2) + '\n')
  expect(hashes).toEqual(JSON.parse(readFileSync(baseline, 'utf8')))
})
