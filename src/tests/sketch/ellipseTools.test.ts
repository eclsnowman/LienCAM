// Ellipse draw tool + bake + solver-inert mapping (Tier 2a). Headless.

import { describe, it, expect } from 'vitest'
import {
  toolClick, toolPreview, type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import { ellipseFromClicks } from '../../lib/sketch/tools/ellipseTools'
import { bakeSketch } from '../../lib/sketch/bake'
import {
  sketchToGcsPrimitives, entitiesFromSolved,
  solveSketchOnWrapper, applyInertEllipseDims,
} from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import type {
  Sketch, SketchEntity, SketchDimension,
  SketchEllipseEntity, SketchEllipticalArcEntity,
} from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}
function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

describe('ellipse tool (3-click flow)', () => {
  it('click 1 anchors center; no commit', () => {
    const r = toolClick(armed('ellipse'), { x: 2, y: 3 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    expect(r.state.chain).toEqual({ kind: 'ellipse', center: { x: 2, y: 3 }, major: null })
  })

  it('click 2 sets the major axis; click 3 commits an ellipse', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major axis +X, a=10
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 0, y: 4 }, TOL, newId)  // minor = 4
    const e = r.commit!.entities[0] as SketchEllipseEntity
    expect(e.kind).toBe('ellipse')
    expect(close(e.majorRadius, 10)).toBe(true)
    expect(close(e.minorRadius, 4)).toBe(true)
    expect(close(e.rotation, 0)).toBe(true)
    expect(r.commit!.constraints).toEqual([])
    expect(r.state.chain).toBeNull() // tool stays armed for the next ellipse
  })

  it('rotation comes from the major-axis direction', () => {
    const shape = ellipseFromClicks({ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 3, y: 0 })
    expect(close(shape.majorRadius, 6)).toBe(true)
    expect(close(shape.rotation, Math.PI / 2)).toBe(true)
    expect(close(shape.minorRadius, 3)).toBe(true)
  })

  it('zero-length major (click 2 on center) is ignored', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 0.1, y: 0 }, TOL, newId) // within TOL of center
    expect((r.state.chain as { major: unknown }).major).toBeNull()
  })

  it('preview equals the committed ellipse outline (same minor point)', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const minorPt = { x: 0, y: 4 }
    const preview = toolPreview(r.state, minorPt)!
    const committed = toolClick(r.state, minorPt, TOL, newId).commit!.entities[0] as SketchEllipseEntity
    // Preview's widest extent along Y equals the committed minor radius.
    const maxY = Math.max(...preview.map((p) => p.y))
    expect(close(maxY, committed.minorRadius, 1e-3)).toBe(true)
  })
})

describe('ellipse bake -> Loop2D', () => {
  const layerId = 'L'
  function sketchOf(entities: SketchEntity[]): Sketch {
    return {
      id: 'sk', layerId, entities, constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
  }

  it('a full ellipse bakes to ONE closed polyline loop', () => {
    const e: SketchEllipseEntity = {
      id: 'e1', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    }
    const { loops, bakedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(bakedEntities).toBe(1)
    expect(loops.length).toBe(1)
    const loop = loops[0]
    expect(loop.closed).toBe(true)
    expect(loop.type).toBe('contour')
    expect(loop.points.length).toBeGreaterThan(8)
    // Closed Loop2D convention: no duplicate first point.
    const first = loop.points[0]
    const last = loop.points[loop.points.length - 1]
    expect(close(first.x, last.x) && close(first.y, last.y)).toBe(false)
    // Segment count == point count (each point + the closing segment).
    expect(loop.segments!.length).toBe(loop.points.length)
    expect(loop.segments!.every((s) => s.type === 'line')).toBe(true)
    // Area roughly matches pi*a*b.
    expect(Math.abs(loop.area - Math.PI * 10 * 5)).toBeLessThan(Math.PI * 10 * 5 * 0.02)
  })

  it('an elliptical arc bakes to an OPEN polyline loop', () => {
    const e: SketchEllipticalArcEntity = {
      id: 'a1', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 8, minorRadius: 4, rotation: 0,
      startParam: 0, endParam: Math.PI / 2,
    }
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(1)
    expect(loops[0].closed).toBe(false)
    expect(loops[0].type).toBe('open')
    expect(loops[0].segments!.every((s) => s.type === 'line')).toBe(true)
  })

  it('construction ellipses never bake', () => {
    const e: SketchEllipseEntity = {
      id: 'e2', kind: 'ellipse', construction: true,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    }
    const { loops, excludedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(0)
    expect(excludedEntities).toBe(1)
  })
})

describe('ellipse solver mapping (SOLVER-INERT)', () => {
  const ellipse: SketchEllipseEntity = {
    id: 'e1', kind: 'ellipse', construction: false,
    center: { x: 1, y: 2 }, majorRadius: 10, minorRadius: 5, rotation: 0.3,
  }
  const sketch: Sketch = {
    id: 'sk', layerId: 'L', entities: [ellipse], constraints: [], dimensions: [],
    solveStatus: null,
  }

  it('pushes the center as a point but NO ellipse primitive', () => {
    const prims = sketchToGcsPrimitives(sketch)
    const center = prims.find((p) => p.id === 'e1:center')
    expect(center?.type).toBe('point')
    expect(prims.some((p) => p.id === 'e1')).toBe(false) // no shape primitive
    expect(prims.some((p) => p.type === 'ellipse')).toBe(false)
  })

  it('rebuild pulls the moved center but keeps the shape verbatim', () => {
    // Fake a solve that moved the center to (4, 9).
    const lookup = (id: string) =>
      id === 'e1:center'
        ? ({ id, type: 'point', x: 4, y: 9, fixed: false } as never)
        : undefined
    const [out] = entitiesFromSolved(sketch, lookup) as [SketchEllipseEntity]
    expect(out.center).toEqual({ x: 4, y: 9 })
    expect(out.majorRadius).toBe(10)
    expect(out.minorRadius).toBe(5)
    expect(out.rotation).toBe(0.3)
  })
})

// Ellipse major/minor radius DIMENSIONS resize the (solver-inert) ellipse via
// direct edit: a DRIVING dim's value rewrites the entity before the solve; a
// reference dim / no dim leaves the shape byte-identical.
describe('ellipse major/minor radius dims (inert direct-edit)', () => {
  const base: SketchEllipseEntity = {
    id: 'e1', kind: 'ellipse', construction: false,
    center: { x: 1, y: 2 }, majorRadius: 10, minorRadius: 5, rotation: 0.3,
  }
  const mk = (dims: SketchDimension[]): Sketch => ({
    id: 'sk', layerId: 'L', entities: [structuredClone(base)],
    constraints: [], dimensions: dims, solveStatus: null,
  })

  it('applyInertEllipseDims: a DRIVING major/minor dim rewrites the radii', () => {
    const sk = mk([
      { id: 'dM', kind: 'majorRadius', driving: true, value: 20, entityId: 'e1' },
      { id: 'dm', kind: 'minorRadius', driving: true, value: 8, entityId: 'e1' },
    ])
    const out = applyInertEllipseDims(sk).entities[0] as SketchEllipseEntity
    expect(out.majorRadius).toBe(20)
    expect(out.minorRadius).toBe(8)
    expect(out.center).toEqual({ x: 1, y: 2 }) // untouched
    expect(out.rotation).toBe(0.3)
  })

  it('applyInertEllipseDims: a REFERENCE dim does NOT resize (report-only)', () => {
    const sk = mk([
      { id: 'dM', kind: 'majorRadius', driving: false, value: 99, entityId: 'e1' },
    ])
    expect((applyInertEllipseDims(sk).entities[0] as SketchEllipseEntity).majorRadius).toBe(10)
  })

  it('applyInertEllipseDims: no ellipse dim -> SAME sketch object (byte-identical fast path)', () => {
    const sk = mk([])
    expect(applyInertEllipseDims(sk)).toBe(sk) // reference-equal: nothing rebuilt
  })

  it('applyInertEllipseDims: a non-positive value is ignored (kept)', () => {
    const sk = mk([
      { id: 'dM', kind: 'majorRadius', driving: true, value: 0, entityId: 'e1' },
    ])
    expect((applyInertEllipseDims(sk).entities[0] as SketchEllipseEntity).majorRadius).toBe(10)
  })

  it('through the solver: editing a driving major/minor dim resizes the ellipse', async () => {
    const gcs = await createGcsWrapper()
    const sk = mk([
      { id: 'dM', kind: 'majorRadius', driving: true, value: 20, entityId: 'e1' },
      { id: 'dm', kind: 'minorRadius', driving: true, value: 8, entityId: 'e1' },
    ])
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const e = out.entities[0] as SketchEllipseEntity
      expect(e.majorRadius).toBe(20)
      expect(e.minorRadius).toBe(8)
      expect(e.center).toEqual({ x: 1, y: 2 })
      expect(e.rotation).toBe(0.3)
    }
  })

  it('through the solver: an UN-DIMENSIONED ellipse is byte-identical', async () => {
    const gcs = await createGcsWrapper()
    const sk = mk([])
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.entities[0]).toEqual(base) // shape carried verbatim, unchanged
    }
  })
})

// Focus-to-focus (2c) DIMENSION: a DIRECT-EDIT that redefines the ellipse by
// resizing the FOCI-BEARING (longer) semi-axis to a = sqrt((2c/2)^2 + b^2),
// keeping the shorter axis + rotation + center fixed. Two axis orderings +
// the degenerate 2c<=0 guard are enumerated (trap 1 + trap 2).
describe('ellipse focus-to-focus dim (inert direct-edit)', () => {
  // a=5 on +X, b=3 on +Y (rotation 0) -> c=4, foci at (+-4, 0), 2c=8.
  const mkEllipse = (major: number, minor: number, rot = 0): SketchEllipseEntity => ({
    id: 'e1', kind: 'ellipse', construction: false,
    center: { x: 0, y: 0 }, majorRadius: major, minorRadius: minor, rotation: rot,
  })
  const mk = (ellipse: SketchEllipseEntity, dims: SketchDimension[]): Sketch => ({
    id: 'sk', layerId: 'L', entities: [structuredClone(ellipse)],
    constraints: [], dimensions: dims, solveStatus: null,
  })
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

  it('normal case: editing 2c rewrites the MAJOR (foci-bearing) axis, minor/rot/center fixed', () => {
    // major=5, minor=3 -> foci on major (+X). Edit 2c=10 -> c=5, b=3 -> a=sqrt(34).
    const sk = mk(mkEllipse(5, 3), [
      { id: 'dF', kind: 'focusDistance', driving: true, value: 10, entityId: 'e1' },
    ])
    const out = applyInertEllipseDims(sk).entities[0] as SketchEllipseEntity
    expect(close(out.majorRadius, Math.sqrt(34))).toBe(true) // sqrt(5^2 + 3^2)
    expect(out.minorRadius).toBe(3)      // shorter axis untouched
    expect(out.center).toEqual({ x: 0, y: 0 })
    expect(out.rotation).toBe(0)
  })

  it('axis-swap case: major<minor (foci on the minor-labeled axis) -> editing 2c rewrites the MINOR (longer) axis', () => {
    // majorRadius=3, minorRadius=5 -> the LONG axis is the minor-labeled one.
    // Edit 2c=10 -> c=5, short axis b=major=3 -> new minor = sqrt(34).
    const sk = mk(mkEllipse(3, 5), [
      { id: 'dF', kind: 'focusDistance', driving: true, value: 10, entityId: 'e1' },
    ])
    const out = applyInertEllipseDims(sk).entities[0] as SketchEllipseEntity
    expect(out.majorRadius).toBe(3)       // shorter axis untouched
    expect(close(out.minorRadius, Math.sqrt(34))).toBe(true)
    expect(out.center).toEqual({ x: 0, y: 0 })
  })

  it('degenerate: a non-positive 2c is IGNORED here (kept); the store surfaces the loud reject', () => {
    const zero = applyInertEllipseDims(mk(mkEllipse(5, 3), [
      { id: 'dF', kind: 'focusDistance', driving: true, value: 0, entityId: 'e1' },
    ])).entities[0] as SketchEllipseEntity
    expect(zero.majorRadius).toBe(5)
    expect(zero.minorRadius).toBe(3)
    const neg = applyInertEllipseDims(mk(mkEllipse(5, 3), [
      { id: 'dF', kind: 'focusDistance', driving: true, value: -4, entityId: 'e1' },
    ])).entities[0] as SketchEllipseEntity
    expect(neg.majorRadius).toBe(5)
    expect(neg.minorRadius).toBe(3)
  })

  it('a REFERENCE focusDistance dim does NOT resize (report-only)', () => {
    const out = applyInertEllipseDims(mk(mkEllipse(5, 3), [
      { id: 'dF', kind: 'focusDistance', driving: false, value: 99, entityId: 'e1' },
    ])).entities[0] as SketchEllipseEntity
    expect(out.majorRadius).toBe(5)
    expect(out.minorRadius).toBe(3)
  })

  it('through the solver: editing a driving 2c resizes the ellipse', async () => {
    const gcs = await createGcsWrapper()
    const sk = mk(mkEllipse(5, 3), [
      { id: 'dF', kind: 'focusDistance', driving: true, value: 10, entityId: 'e1' },
    ])
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const e = out.entities[0] as SketchEllipseEntity
      expect(close(e.majorRadius, Math.sqrt(34))).toBe(true)
      expect(e.minorRadius).toBe(3)
      expect(e.center).toEqual({ x: 0, y: 0 })
    }
  })
})
