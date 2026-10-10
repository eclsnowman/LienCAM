// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import { tessellateSpline } from '../../lib/sketch/spline'
import { bakeSketch } from '../../lib/sketch/bake'
import type { SketchEntity, SketchSplineEntity } from '../../lib/sketch/types'
import type { Vec2 } from '../../types'
import * as controller from '../../lib/sketch/sketcher/toolController'

class StubWorker { postMessage() {} terminate() {} }
vi.stubGlobal('Worker', StubWorker)
let store: typeof import('../../store').useCamStore
const saved = vi.fn(async (_name: string, _data: string | Uint8Array): Promise<string | null> => 'download')
beforeAll(async () => { store = (await import('../../store')).useCamStore })
beforeEach(() => {
  saved.mockClear()
  vi.stubGlobal('liencamHost', { saveFile: saved })
  store.setState((s) => ({ activeSketch: null, sketchNotice: null, project: { ...s.project, geometry: [] }, sketchHistory: [] }))
  store.getState().startNewSketch()
})
afterEach(() => { vi.unstubAllGlobals(); controller.bindSketcherDocument(null) })

// Independent tagged-DXF reader: no writer/bake helpers. The product importer
// separately checks geometry, units, unsupported records and empty documents.
function readDxf(text: string) {
  const lines = text.trimEnd().split(/\r?\n/)
  expect(lines.length % 2).toBe(0)
  const pairs: Array<[number, string]> = []
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i]), lines[i + 1]])
  expect(pairs.at(-1)).toEqual([0, 'EOF'])
  const header = new Map<string, string>()
  const entities: Array<{ kind: string; tags: Array<[number, string]> }> = []
  let section = '', current: typeof entities[number] | undefined
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i]
    if (code === 0 && value === 'SECTION') section = pairs[++i][1]
    else if (code === 0 && value === 'ENDSEC') { section = ''; current = undefined }
    else if (section === 'HEADER' && code === 9) header.set(value, pairs[++i][1])
    else if (section === 'ENTITIES') {
      if (code === 0) { current = { kind: value, tags: [] }; entities.push(current) }
      else current?.tags.push([code, value])
    }
  }
  return { header, entities }
}
type RecordEntity = ReturnType<typeof readDxf>['entities'][number]
const values = (e: RecordEntity, code: number) => e.tags.filter(([c]) => c === code).map(([, v]) => Number(v))
const value = (e: RecordEntity, code: number) => values(e, code)[0]
const vertices = (e: RecordEntity): Vec2[] => values(e, 10).map((x, i) => ({ x, y: values(e, 20)[i] }))
function near(a: Vec2, b: Vec2) { expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(1e-6) }
async function exportEntities(entities: SketchEntity[], name = 'Sketch') {
  // Real store sink and the exact shared action used by SketchToolbox.
  controller.bindSketcherDocument((await import('../../store')).camSketchDocumentPort)
  for (const e of entities) store.getState().addEntity(e)
  expect(controller.sketcherTools, 'the export button has a production DXF action').toHaveProperty('exportSketchDxf')
  await controller.sketcherTools.exportSketchDxf(name)
  expect(saved).toHaveBeenCalledOnce()
  const text = saved.mock.calls[0][1] as string
  expect(text).not.toMatch(/[\x80-\uffff]/)
  const parsed = readDxf(text)
  expect(parsed.header.get('$ACADVER')).toBe('AC1015')
  expect(parsed.header.get('$INSUNITS')).toBe('4')
  const imported = importDXF(text, { keepOrigin: true })
  expect(imported.unitScale).toBe(1)
  expect(imported.report.skipped).toEqual([])
  return { ...parsed, imported }
}
const spline: SketchSplineEntity = { id: 'spline', kind: 'spline', construction: false, closed: false,
  points: [{ x: 100, y: -20 }, { x: 110, y: -10 }, { x: 120, y: -20 }, { x: 130, y: -10 }] }
describe('WO-2410 sketch store -> button action -> independently read DXF', () => {
  it('exports exact lines, major arcs, circles and every spline vertex at drawing origin in mm', async () => {
    const line: SketchEntity = { id: 'line', kind: 'line', construction: false, start: { x: -30.123456789, y: -20 }, end: { x: -10, y: -5 } }
    const arc: SketchEntity = { id: 'arc', kind: 'arc', construction: false, center: { x: 20, y: -30 }, radius: 7.123456789, startAngle: 350 * Math.PI / 180, endAngle: 260 * Math.PI / 180 }
    const circle: SketchEntity = { id: 'circle', kind: 'circle', construction: false, center: { x: 60, y: -20 }, radius: 8.123456789 }
    const { entities, imported } = await exportEntities([line, arc, circle, spline,
      { ...line, id: 'construction', construction: true, start: { x: 999, y: 999 } }], 'Fit: stock')
    expect(saved.mock.calls[0][0]).toBe('Fit_ stock.dxf')
    expect(entities.map((e) => e.kind).sort()).toEqual(['ARC', 'CIRCLE', 'LINE', 'LWPOLYLINE'])
    expect(imported.loops).toHaveLength(4)
    const l = entities.find((e) => e.kind === 'LINE')!
    near(vertices(l)[0], line.start); near({ x: value(l, 11), y: value(l, 21) }, line.end)
    const a = entities.find((e) => e.kind === 'ARC')!
    near(vertices(a)[0], arc.center); expect(value(a, 40)).toBe(arc.radius)
    expect(value(a, 50)).toBeCloseTo(350, 9); expect(value(a, 51)).toBeCloseTo(260, 9)
    const c = entities.find((e) => e.kind === 'CIRCLE')!
    near(vertices(c)[0], circle.center); expect(value(c, 40)).toBe(circle.radius)
    const p = entities.find((e) => e.kind === 'LWPOLYLINE')!
    const expected = tessellateSpline(spline.points, false)
    expect(value(p, 90)).toBe(expected.length)
    vertices(p).forEach((v, i) => near(v, expected[i]))
    expect(store.getState().sketchNotice).toContain('Exported "Fit_ stock.dxf"')
  })
  it.each(['fit', 'control', 'bezier', 'conic'] as const)('preserves %s spline bake vertices', async (form) => {
    const s = { ...spline, form }
    const { entities } = await exportEntities([s])
    expect(entities).toHaveLength(1)
    expect(entities[0].kind).toBe('LWPOLYLINE')
    const expected = tessellateSpline(s.points, s.closed, undefined, form)
    expect(vertices(entities[0])).toHaveLength(expected.length)
    vertices(entities[0]).forEach((v, i) => near(v, expected[i]))
  })
  it.each(['single-line', 'outline'] as const)('exports rotated %s text as baked strokes/outlines', async (fontStyle) => {
    const { entities } = await exportEntities([{ id: 'text', kind: 'text', construction: false,
      at: { x: -40, y: 20 }, height: 10, rotation: Math.PI / 6, text: 'O', fontStyle }])
    const loops = bakeSketch(store.getState().activeSketch!).loops
    expect(entities).toHaveLength(loops.length)
    expect(entities.length).toBeGreaterThan(0)
    entities.forEach((e, i) => {
      expect(e.kind).toBe('LWPOLYLINE')
      expect(value(e, 70)).toBe(loops[i].closed ? 1 : 0)
      expect(vertices(e)).toHaveLength(loops[i].points.length)
      vertices(e).forEach((v, j) => near(v, loops[i].points[j]))
    })
  })
  it('keeps clockwise hole arcs CCW in DXF without changing their locus', async () => {
    const { entities } = await exportEntities([
      { id: 'outer', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 30 },
      { id: 'arc', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI },
      { id: 'chord', kind: 'line', construction: false, start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
    ])
    expect(bakeSketch(store.getState().activeSketch!).loops.some((l) => l.type === 'hole' && l.segments?.some((s) => s.type === 'arc' && s.clockwise))).toBe(true)
    const arc = entities.find((e) => e.kind === 'ARC')!
    expect(value(arc, 50)).toBeCloseTo(0, 9); expect(value(arc, 51)).toBeCloseTo(180, 9)
  })
  it.each([false, true])('reads an empty DXF (construction-only=%s)', async (construction) => {
    const { entities, imported } = await exportEntities(construction ? [{ ...spline, construction: true }] : [])
    expect(entities).toHaveLength(0); expect(imported.loops).toHaveLength(0)
  })
  it('does not report export success when the save dialog is cancelled', async () => {
    saved.mockResolvedValueOnce(null)
    await exportEntities([spline])
    expect(store.getState().sketchNotice).toBeNull()
  })
})
