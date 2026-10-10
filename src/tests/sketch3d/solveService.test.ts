import { afterEach, describe, expect, it } from 'vitest'
import {
  Sketch3dSolveService,
  createSketch3dGcsWrapper,
  createSketch3dSolveService,
} from '../../sketch3d'
// SKC-6D: the retired direct mapping (sketch3dToPlanegcsPrimitives) was deleted.
// These primitive-shape tests now exercise the SURVIVING path - the 2D-superset
// bridge (sketch3dToPrimitives -> gcsMapping.ts) - proving it reproduces the same
// planegcs primitive id push-order and constraint->primitive-type vocabulary.
import { sketch3dToPrimitives } from '../../sketch3d/solveBridge'
import type {
  Sketch3dConstraint,
  Sketch3dDocument,
  Sketch3dEntity,
  Sketch3dLineEntity,
  Sketch3dPointRef,
  Sketch3dSolveResult,
} from '../../sketch3d'

const openServices: { dispose: () => void }[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver() {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

function ref(entityId: string, site: Sketch3dPointRef['site']): Sketch3dPointRef {
  return { entityId, site }
}

function point(id: string, x: number, y: number): Sketch3dEntity {
  return { id, kind: 'point', at: { x, y } }
}

function line(id: string, x1: number, y1: number, x2: number, y2: number): Sketch3dLineEntity {
  return { id, kind: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function circle(id: string, x: number, y: number, radius: number): Sketch3dEntity {
  return { id, kind: 'circle', center: { x, y }, radius }
}

function arc(
  id: string,
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): Sketch3dEntity {
  return { id, kind: 'arc', center: { x, y }, radius, startAngle, endAngle }
}

function sketch(entities: Sketch3dEntity[], constraints: Sketch3dConstraint[]): Sketch3dDocument {
  return { id: 'sketch', entities, constraints }
}

function rectangleSketch(fixCorner: boolean): Sketch3dDocument {
  const entities: Sketch3dEntity[] = [
    line('l1', 0.2, -0.3, 39.6, 0.4),
    line('l2', 40.3, 0.2, 39.7, 29.6),
    line('l3', 40.4, 30.2, 0.3, 29.7),
    line('l4', -0.2, 30.3, 0.4, 0.3),
  ]
  if (fixCorner) {
    const l1 = entities[0] as Sketch3dLineEntity
    const l4 = entities[3] as Sketch3dLineEntity
    l1.start = { x: 0, y: 0 }
    l4.end = { x: 0, y: 0 }
  }
  const constraints: Sketch3dConstraint[] = [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
    { id: 'h1', kind: 'horizontal', line: 'l1' },
    { id: 'h3', kind: 'horizontal', line: 'l3' },
    { id: 'v2', kind: 'vertical', line: 'l2' },
    { id: 'v4', kind: 'vertical', line: 'l4' },
    { id: 'dw', kind: 'distance', a: ref('l1', 'start'), b: ref('l1', 'end'), value: 40 },
    { id: 'dh', kind: 'distance', a: ref('l2', 'start'), b: ref('l2', 'end'), value: 30 },
  ]
  if (fixCorner) constraints.push({ id: 'fix0', kind: 'fixed', point: ref('l1', 'start') })
  return sketch(entities, constraints)
}

function solvedLine(result: Sketch3dSolveResult, id: string): Sketch3dLineEntity {
  const entity = result.entities.find((candidate) => candidate.id === id)
  if (!entity || entity.kind !== 'line') throw new Error('missing solved line ' + id)
  return entity
}

function lengthOf(lineEntity: Sketch3dLineEntity): number {
  return Math.hypot(lineEntity.end.x - lineEntity.start.x, lineEntity.end.y - lineEntity.start.y)
}

function roundedPositions(result: Sketch3dSolveResult): unknown[] {
  return result.updatedPositions.map((position) => JSON.parse(JSON.stringify(position, (_key, value: unknown) => (
    typeof value === 'number' ? Number(value.toFixed(6)) : value
  ))))
}

describe('sketch3d planegcs mapping', () => {
  it('maps point, line, circle, and arc entities to stable planegcs handles in dependency order', () => {
    const { primitives } = sketch3dToPrimitives(sketch([
      point('p', 1, 2),
      line('l', 0, 0, 10, 0),
      circle('c', 5, 5, 3),
      arc('a', 0, 0, 4, 0, Math.PI / 2),
    ], []))

    expect(primitives.map((primitive) => primitive.id)).toEqual([
      'p',
      'l:start', 'l:end',
      'c:center',
      'a:center', 'a:start', 'a:end',
      'l', 'c', 'a',
      'a:rules',
    ])
    expect(primitives.map((primitive) => primitive.type)).toEqual([
      'point',
      'point', 'point',
      'point',
      'point', 'point', 'point',
      'line', 'circle', 'arc',
      'arc_rules',
    ])
  })

  it('maps the required constraint vocabulary to planegcs primitive types', () => {
    const { primitives } = sketch3dToPrimitives(sketch([
      point('p1', 0, 0),
      point('p2', 5, 0),
      line('l1', 0, 0, 10, 0),
      line('l2', 10, 0, 10, 10),
      line('l3', 0, 10, 10, 10),
      circle('c1', 20, 5, 4),
      circle('c2', 35, 5, 7),
      arc('a1', 50, 5, 4, 0, Math.PI),
      arc('a2', 65, 5, 6, 0, Math.PI),
    ], [
      { id: 'co', kind: 'coincident', a: ref('p1', 'self'), b: ref('l1', 'start') },
      { id: 'hline', kind: 'horizontal', line: 'l1' },
      { id: 'hpoints', kind: 'horizontal', points: [ref('p1', 'self'), ref('p2', 'self')] },
      { id: 'vline', kind: 'vertical', line: 'l2' },
      { id: 'vpoints', kind: 'vertical', points: [ref('l1', 'start'), ref('l2', 'start')] },
      { id: 'par', kind: 'parallel', a: 'l1', b: 'l3' },
      { id: 'perp', kind: 'perpendicular', a: 'l1', b: 'l2' },
      { id: 'tan-lc', kind: 'tangent', a: 'l1', b: 'c1' },
      { id: 'tan-la', kind: 'tangent', a: 'l2', b: 'a1' },
      { id: 'tan-cc', kind: 'tangent', a: 'c1', b: 'c2' },
      { id: 'tan-aa', kind: 'tangent', a: 'a1', b: 'a2' },
      { id: 'tan-ca', kind: 'tangent', a: 'c2', b: 'a1' },
      { id: 'eq-line', kind: 'equal', a: 'l1', b: 'l3' },
      { id: 'eq-cc', kind: 'equal', a: 'c1', b: 'c2' },
      { id: 'eq-ca', kind: 'equal', a: 'c1', b: 'a1' },
      { id: 'eq-aa', kind: 'equal', a: 'a1', b: 'a2' },
      { id: 'dist', kind: 'distance', a: ref('p1', 'self'), b: ref('p2', 'self'), value: 5 },
      { id: 'angle', kind: 'angle', a: 'l1', b: 'l2', value: Math.PI / 2 },
      { id: 'rad-c', kind: 'radius', entityId: 'c1', value: 4 },
      { id: 'rad-a', kind: 'radius', entityId: 'a1', value: 4 },
      { id: 'dia-c', kind: 'diameter', entityId: 'c2', value: 14 },
      { id: 'dia-a', kind: 'diameter', entityId: 'a2', value: 12 },
    ]))

    const typeById = new Map(primitives.map((primitive) => [primitive.id, primitive.type]))
    expect(typeById.get('co')).toBe('p2p_coincident')
    expect(typeById.get('hline')).toBe('horizontal_l')
    expect(typeById.get('hpoints')).toBe('horizontal_pp')
    expect(typeById.get('vline')).toBe('vertical_l')
    expect(typeById.get('vpoints')).toBe('vertical_pp')
    expect(typeById.get('par')).toBe('parallel')
    expect(typeById.get('perp')).toBe('perpendicular_ll')
    expect(typeById.get('tan-lc')).toBe('tangent_lc')
    expect(typeById.get('tan-la')).toBe('tangent_la')
    expect(typeById.get('tan-cc')).toBe('tangent_cc')
    expect(typeById.get('tan-aa')).toBe('tangent_aa')
    expect(typeById.get('tan-ca')).toBe('tangent_ca')
    expect(typeById.get('eq-line')).toBe('equal_length')
    expect(typeById.get('eq-cc')).toBe('equal_radius_cc')
    expect(typeById.get('eq-ca')).toBe('equal_radius_ca')
    expect(typeById.get('eq-aa')).toBe('equal_radius_aa')
    expect(typeById.get('dist')).toBe('p2p_distance')
    expect(typeById.get('angle')).toBe('l2l_angle_ll')
    expect(typeById.get('rad-c')).toBe('circle_radius')
    expect(typeById.get('rad-a')).toBe('arc_radius')
    expect(typeById.get('dia-c')).toBe('circle_diameter')
    expect(typeById.get('dia-a')).toBe('arc_diameter')
  })
})

describe('sketch3d solve service', () => {
  it('reports under-constrained and fully-constrained DOF counts', async () => {
    const service = await solver()

    const under = service.solve(rectangleSketch(false))
    expect(under.status).toBe('success')
    expect(under.dof).toBe(2)
    expect(under.conflicting).toEqual([])

    const full = service.solve(rectangleSketch(true))
    expect(full.status).toBe('success')
    expect(full.dof).toBe(0)
    expect(full.conflicting).toEqual([])
    expect(full.redundant).toEqual([])

    const l1 = solvedLine(full, 'l1')
    const l2 = solvedLine(full, 'l2')
    const l3 = solvedLine(full, 'l3')
    expect(l1.start.x).toBeCloseTo(0, 6)
    expect(l1.start.y).toBeCloseTo(0, 6)
    expect(l1.end.x).toBeCloseTo(40, 6)
    expect(l1.end.y).toBeCloseTo(0, 6)
    expect(l3.start.x).toBeCloseTo(40, 6)
    expect(l3.start.y).toBeCloseTo(30, 6)
    expect(l3.end.x).toBeCloseTo(0, 6)
    expect(l3.end.y).toBeCloseTo(30, 6)
    expect(lengthOf(l1)).toBeCloseTo(40, 6)
    expect(lengthOf(l2)).toBeCloseTo(30, 6)
  })

  it('returns an identifiable conflicting set without throwing raw wasm errors', async () => {
    const service = await solver()
    const doc = rectangleSketch(true)
    doc.constraints.push({
      id: 'dconflict',
      kind: 'distance',
      a: ref('l1', 'start'),
      b: ref('l1', 'end'),
      value: 45,
    })

    const result = service.solve(doc)
    expect(result.status).toBe('conflicting')
    expect(result.conflicting).toContain('dconflict')
    expect(result.error).toContain('conflicting constraints')
  })

  it('updates circle and arc driving radius and diameter values', async () => {
    const service = await solver()
    const result = service.solve(sketch([
      circle('c', 0, 0, 2),
      arc('a', 10, 0, 2, 0, Math.PI / 2),
    ], [
      { id: 'rc', kind: 'radius', entityId: 'c', value: 5 },
      { id: 'da', kind: 'diameter', entityId: 'a', value: 14 },
    ]))

    expect(result.status).toBe('success')
    const c = result.entities.find((entity) => entity.id === 'c')
    const a = result.entities.find((entity) => entity.id === 'a')
    expect(c?.kind).toBe('circle')
    expect(a?.kind).toBe('arc')
    if (c?.kind !== 'circle' || a?.kind !== 'arc') throw new Error('missing circle or arc')
    expect(c.radius).toBeCloseTo(5, 6)
    expect(a.radius).toBeCloseTo(7, 6)
  })

  it('is deterministic for the same headless input across solver instances', async () => {
    const firstService = await solver()
    const secondService = await solver()

    const first = firstService.solve(rectangleSketch(true))
    const second = secondService.solve(rectangleSketch(true))

    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    expect(roundedPositions(first)).toEqual(roundedPositions(second))
  })

  it('returns typed invalid-sketch failures at the service boundary', async () => {
    const service = await solver()
    const result = service.solve(sketch([
      line('l', 0, 0, 10, 0),
      circle('c', 0, 0, 5),
    ], [
      { id: 'bad', kind: 'parallel', a: 'l', b: 'c' },
    ]))

    expect(result.status).toBe('invalid_sketch')
    expect(result.rawStatus).toBeNull()
    expect(result.error).toContain('expected line')
  })

  it('rejects a distance constraint that sets both b and line (must fail loud, not silently drop b)', async () => {
    const service = await solver()
    const result = service.solve(sketch([
      line('l', 0, 0, 10, 0),
      point('p', 5, 5),
    ], [
      { id: 'bad', kind: 'distance', a: ref('p', 'self'), b: ref('l', 'start'), line: 'l', value: 5 },
    ]))

    expect(result.status).toBe('invalid_sketch')
    expect(result.rawStatus).toBeNull()
    expect(result.error).toContain('set either b or line, not both')
  })

  // DISPOSE CONTRACT (criterion 7, redesigned by Architect ruling - see DECISIONS.md
  // 2026-07-07 "SKC-1 two-bounce root cause"): a quantitative wasm-heap metric is not
  // implementable against this planegcs build (capacity is pinned at 16 MB and there is
  // no _malloc to probe). The leak guard is therefore (a) this contract test - the
  // native GcsSystem's delete() is invoked EXACTLY once per service lifecycle - plus
  // (b) the OOM-calibrated soak test in disposalSoak.test.ts.
  it('dispose() deletes the native GcsSystem exactly once, idempotently, and solve-after-dispose never touches wasm', async () => {
    const wrapper = await createSketch3dGcsWrapper()
    let deleteCalls = 0
    const realDelete = wrapper.gcs.delete.bind(wrapper.gcs)
    wrapper.gcs.delete = () => { deleteCalls++; realDelete() }

    const service = await Sketch3dSolveService.create(wrapper)
    const solved = service.solve(rectangleSketch(true))
    expect(solved.status).toBe('success')
    expect(deleteCalls).toBe(0)

    service.dispose()
    expect(deleteCalls).toBe(1)

    service.dispose() // idempotent - must not double-delete the native object
    expect(deleteCalls).toBe(1)

    const afterDispose = service.solve(rectangleSketch(true))
    expect(afterDispose.status).toBe('failed')
    expect(afterDispose.error).toContain('disposed')
    expect(deleteCalls).toBe(1)
  })
})
