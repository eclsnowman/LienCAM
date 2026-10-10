// Exact per-entity definition state (Stage 4 chunk 1).
//
// Replaces the documented v1 whole-sketch approximation: an entity is
// FULLY DEFINED iff ALL of its solver parameters are determined, measured
// by the fix-probe diagnosis in gcsMapping (planegcs 1.1.7 exposes no
// per-parameter freedom API — see diagnoseDefinedEntities). These tests
// pin:
//   (a) one fixed corner -> ONLY transitively determined entities are
//       defined (the Stage 2 observation: edges rendered near-white off
//       the fix approximation even though their far ends were free),
//   (b) the demo-seed scenario colors correctly per entity,
//   (c) drag solves CARRY definition state (temp pins tag -1 are excluded
//       from the diagnosis -> no white flash mid-drag),
//   (d) conflicts map to the right entities (red), carried definition
//       states survive a conflicting solve.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import {
  entityDefinitionColor, referencedEntityIds, SKETCH_COLORS,
} from '../../lib/sketch/sketcher/sketchLayer'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint,
  SketchDimension, PointRef, SolveStatus,
} from '../../lib/sketch/types'

// demoSeed imports the store at module top; stub its environment exactly
// like the store suites do, then import dynamically.
class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let buildDemoSketch: typeof import('../../lib/sketch/demoSeed').buildDemoSketch

beforeAll(async () => {
  ;({ buildDemoSketch } = await import('../../lib/sketch/demoSeed'))
})

// ---- builders ------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

/** Rectangle (4 lines, coincident corners, H/V) + a point entity riding the
 *  bottom-left corner. fix grounds that corner; dims (optional) make the
 *  rectangle rigid. Without dims the width/height stay FREE, so no line is
 *  fully defined — only the point (transitively determined) is. */
function cornerSketch(opts: { dims?: boolean } = {}): Sketch {
  const entities: SketchEntity[] = [
    line('l1', 0, 0, 40, 0),
    line('l2', 40, 0, 40, 30),
    line('l3', 40, 30, 0, 30),
    line('l4', 0, 30, 0, 0),
    { id: 'p', kind: 'point', construction: false, at: { x: 0, y: 0 } },
  ]
  const constraints: SketchConstraint[] = [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'),   b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'),   b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'),   b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'),   b: ref('l1', 'start') },
    { id: 'h1',  kind: 'horizontal', line: 'l1' },
    { id: 'h3',  kind: 'horizontal', line: 'l3' },
    { id: 'v2',  kind: 'vertical',   line: 'l2' },
    { id: 'v4',  kind: 'vertical',   line: 'l4' },
    { id: 'cp',  kind: 'coincident', a: ref('p', 'self'),   b: ref('l1', 'start') },
    { id: 'fx',  kind: 'fix', point: ref('l1', 'start') },
  ]
  const dimensions: SketchDimension[] = opts.dims ? [
    { id: 'dw', kind: 'distance', driving: true, value: 40,
      a: ref('l1', 'start'), b: ref('l1', 'end') },
    { id: 'dh', kind: 'distance', driving: true, value: 30,
      a: ref('l2', 'start'), b: ref('l2', 'end') },
  ] : []
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions,
    solveStatus: null,
  }
}

function freeCircle(id: string): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: 90, y: 15 }, radius: 8 }
}

/** Render-layer definition sets for a sketch+status (mirrors the private
 *  computeDefinitionSets bookkeeping). */
function colorSets(sk: Sketch, st: SolveStatus | null) {
  const conflicting = new Set(st?.conflicting ?? [])
  const conflict = new Set<string>()
  const fixed = new Set<string>()
  for (const c of sk.constraints) {
    if (c.kind === 'fix') {
      if (c.point) fixed.add(c.point.entityId)
      if (c.entityId) fixed.add(c.entityId)
    }
    if (conflicting.has(c.id)) referencedEntityIds(c).forEach((id) => conflict.add(id))
  }
  for (const d of sk.dimensions) {
    if (conflicting.has(d.id)) referencedEntityIds(d).forEach((id) => conflict.add(id))
  }
  const defined = st?.fullyDefinedEntities !== undefined
    ? new Set(st.fullyDefinedEntities) : null
  return { conflict, defined, fixed }
}

// ---- (a) one fixed corner: only transitively determined entities -----------

describe('exact per-entity definition state', () => {
  it('fixed corner WITHOUT dims: only the corner point is defined, no line', async () => {
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, cornerSketch())
    expect(out.ok).toBe(true)
    // Width and height are free -> 2 DoF; every line owns at least one
    // free parameter, so NONE is fully defined. The point entity riding
    // the grounded corner is transitively determined.
    expect(out.status.dof).toBe(2)
    expect(out.status.fullyDefinedEntities).toEqual(['p'])

    // The old approximation rendered l1 near-white because the fix
    // referenced it; the exact state renders it blue.
    const sets = colorSets(cornerSketch(), out.status)
    expect(entityDefinitionColor(out.status, 'l1', sets)).toBe(SKETCH_COLORS.underDefined)
    expect(entityDefinitionColor(out.status, 'p', sets)).toBe(SKETCH_COLORS.fullyDefined)
    gcs.destroy_gcs_module()
  })

  it('fixed corner WITH dims + a free circle: rectangle defined, circle not', async () => {
    const gcs = await createGcsWrapper()
    const sk = cornerSketch({ dims: true })
    sk.entities.push(freeCircle('c'))
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    expect(out.status.dof).toBe(3) // the circle's center + radius
    expect(new Set(out.status.fullyDefinedEntities)).toEqual(
      new Set(['l1', 'l2', 'l3', 'l4', 'p'])
    )
    gcs.destroy_gcs_module()
  })

  it('dof === 0 short-circuit: every entity is in the defined list', async () => {
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, cornerSketch({ dims: true }))
    expect(out.ok).toBe(true)
    expect(out.status.dof).toBe(0)
    expect(new Set(out.status.fullyDefinedEntities)).toEqual(
      new Set(['l1', 'l2', 'l3', 'l4', 'p'])
    )
    gcs.destroy_gcs_module()
  })
})

// ---- (b) the demo-seed scenario (Stage 2 observation) -----------------------

describe('demo-seed scenario colors correctly', () => {
  it('all four rectangle edges defined (white); circle/arc/line/point blue', async () => {
    const gcs = await createGcsWrapper()
    const sk = buildDemoSketch()
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    expect(out.status.dof).toBeGreaterThan(0) // the under-defined remainder

    // The rect subsystem (fix corner + H/V + width/height dims) is rigid:
    // exactly its four edges are fully defined — including rect-top and
    // rect-left, which the approximation rendered BLUE while rect-bottom
    // (the fix reference) rendered white.
    expect(new Set(out.status.fullyDefinedEntities)).toEqual(new Set([
      'demo-rect-bottom', 'demo-rect-right', 'demo-rect-top', 'demo-rect-left',
    ]))

    const sets = colorSets(sk, out.status)
    for (const id of ['demo-rect-bottom', 'demo-rect-right', 'demo-rect-top', 'demo-rect-left']) {
      expect(entityDefinitionColor(out.status, id, sets)).toBe(SKETCH_COLORS.fullyDefined)
    }
    for (const id of ['demo-circle', 'demo-tangent-line', 'demo-arc', 'demo-construction', 'demo-point']) {
      expect(entityDefinitionColor(out.status, id, sets)).toBe(SKETCH_COLORS.underDefined)
    }
    gcs.destroy_gcs_module()
  })
})

// ---- (c) drag does not change definition states ------------------------------

describe('drag solves carry definition state (no white flash)', () => {
  it('dragging the free circle keeps dof and per-entity states unchanged', async () => {
    const gcs = await createGcsWrapper()
    const base = cornerSketch({ dims: true })
    base.entities.push(freeCircle('c'))
    const settled = solveSketchOnWrapper(gcs, base)
    expect(settled.ok).toBe(true)
    if (!settled.ok) return

    // The store always drags a document whose solveStatus is the last
    // good solve — replicate that.
    const sk: Sketch = { ...base, entities: settled.entities, solveStatus: settled.status }

    const dragged = solveSketchOnWrapper(gcs, sk, {
      targets: [{ point: ref('c', 'center'), to: { x: 70, y: 25 } }],
    })
    expect(dragged.ok).toBe(true)
    // The two temp pins would consume the circle's 2 translation DoF
    // (3 -> 1) if they leaked into the diagnosis. Carried instead:
    expect(dragged.status.dof).toBe(settled.status.dof)
    expect(dragged.status.fullyDefinedEntities)
      .toEqual(settled.status.fullyDefinedEntities)
    gcs.destroy_gcs_module()
  })
})

// ---- (d) conflicts map to the right entities ---------------------------------

describe('conflicts map to entities; definition states survive', () => {
  it('conflicting width dim -> its entities red, carried defined list intact', async () => {
    const gcs = await createGcsWrapper()
    const base = cornerSketch({ dims: true })
    base.entities.push(freeCircle('c'))
    const good = solveSketchOnWrapper(gcs, base)
    expect(good.ok).toBe(true)
    if (!good.ok) return

    const over: Sketch = {
      ...base,
      entities: good.entities,
      solveStatus: good.status,
      dimensions: [
        ...base.dimensions,
        { id: 'dconflict', kind: 'distance', driving: true, value: 45,
          a: ref('l1', 'start'), b: ref('l1', 'end') },
      ],
    }
    const out = solveSketchOnWrapper(gcs, over)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.conflicting).toContain('dconflict')

    // Geometry stays at the last good solve, so the carried definition
    // states still describe what is on screen.
    expect(out.status.fullyDefinedEntities).toEqual(good.status.fullyDefinedEntities)

    // The conflicting dimension references l1 -> l1 renders red; the free
    // circle is untouched by the conflict and stays blue.
    const sets = colorSets(over, out.status)
    expect(sets.conflict.has('l1')).toBe(true)
    expect(entityDefinitionColor(out.status, 'l1', sets)).toBe(SKETCH_COLORS.conflict)
    expect(entityDefinitionColor(out.status, 'c', sets)).toBe(SKETCH_COLORS.underDefined)
    gcs.destroy_gcs_module()
  })
})
