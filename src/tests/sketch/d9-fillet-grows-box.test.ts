// D9 (Operator): applying a FILLET to a real rectangle corner must ROUND the
// corner WITHOUT growing the bounding box or moving the rest of the box.
//
// This differs from the existing T10 test (filletRadiusDim.solver.test.ts):
//   - T10 exercises the RADIUS-EDIT path on a hand-built `underConstrainedBox`
//     that does NOT carry the D1 construction diagonal + center.
//   - D9 (here) exercises the CREATION path on a REAL rectangle produced by
//     buildRectCommit, which since commit e01909c ties the center to the box
//     via a CONSTRUCTION DIAGONAL between corners[0] (ids[0]:start) and
//     corners[2] (ids[2]:start), each endpoint coincident to that corner.
//
// The reproduction asserts that after filleting a corner the box's OTHER
// corners / extents do NOT move beyond tolerance while the fillet arc appears
// at the requested radius. It filets a PLAIN corner (corner1/corner3) and a
// DIAGONAL-ENDPOINT corner (corner2) to see whether the D1 diagonal changes
// the outcome.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { buildRectCommit } from '../../lib/sketch/tools/rectTools'
import { filletLines } from '../../lib/sketch/tools/filletTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type {
  Sketch, SketchEntity, SketchArcEntity, SketchConstraint, PointRef, Vec2,
} from '../../lib/sketch/types'
import type { GcsWrapper } from '@salusoft89/planegcs'

let wrapperP: Promise<GcsWrapper> | null = null
const getWrapper = () => (wrapperP ??= createGcsWrapper())

function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }

/** A real 20x20 rectangle at the origin, exactly as the rect tool builds it
 *  (4 lines + auto H/V + corner coincidents + D1 construction diagonal +
 *  center), with corner0 (ids[0]:start, at origin) FIXED so translation is
 *  removed and any corner motion / box growth is measurable. Still
 *  under-defined: width + height are free DoF (no size dimension). */
function realRect(): { sk: Sketch; ids: string[] } {
  let n = 0
  const commit = buildRectCommit({ x: 0, y: 0 }, { x: 20, y: 20 }, false, () => `r${n++}`)
  const lineIds = commit.entities.filter((e) => e.kind === 'line' && !e.construction).map((e) => e.id)
  // The four rectangle sides are the first four entities the builder pushes.
  const ids = commit.entities.slice(0, 4).map((e) => e.id)
  expect(ids).toEqual(lineIds) // sanity: first four are the (non-construction) sides
  const sk: Sketch = {
    id: 'sk', layerId: 'layer',
    entities: commit.entities,
    constraints: [
      ...commit.constraints,
      { id: 'fix0', kind: 'fix', point: ref(ids[0], 'start') } as SketchConstraint,
    ],
    dimensions: [],
    solveStatus: null,
  }
  return { sk, ids }
}

/** Extents of the four rectangle SIDES' endpoints (ignores the construction
 *  diagonal so its own endpoints cannot mask box growth). */
function bbox(entities: SketchEntity[], sideIds: string[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const e of entities) {
    if (e.kind !== 'line' || !sideIds.includes(e.id)) continue
    for (const p of [e.start, e.end]) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

function apply(sk: Sketch, t: { entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDoc['dimensions'] }): Sketch {
  return { ...sk, entities: t.entities, constraints: t.constraints, dimensions: t.dimensions, solveStatus: null }
}

/** Fillet the corner where lines a and b meet, hints toward each line's far
 *  end (the shared-corner gesture), solve, and return the box + arc. */
async function filletCornerAndSolve(
  sk: Sketch, aId: string, bId: string, hintA: Vec2, hintB: Vec2, radius: number,
) {
  const wrapper = await getWrapper()
  let n = 0
  const r = filletLines(sk as unknown as SketchDoc, aId, bId, hintA, hintB, radius, () => `f${n++}`)
  if (typeof r === 'string') throw new Error(`fillet rejected: ${r}`)
  const filleted = apply(sk, r.transform)
  const out = solveSketchOnWrapper(wrapper, filleted)
  return { out, arcId: r.arcId, phantomPointId: r.phantomPointId, radius }
}

describe('D9: filleting a real rectangle corner must not grow / move the box', () => {
  it('PLAIN corner1 (no diagonal endpoint): box stays 20x20, fillet appears', async () => {
    const { sk, ids } = realRect()
    // corner1 = (20,0) = ids[0]:end / ids[1]:start. Far ends: (0,0) and (20,20).
    const { out, arcId, radius } = await filletCornerAndSolve(
      sk, ids[0], ids[1], { x: 0, y: 0 }, { x: 20, y: 20 }, 2)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const bb = bbox(out.entities, ids)
    expect(bb.minX).toBeCloseTo(0, 4)
    expect(bb.minY).toBeCloseTo(0, 4)
    expect(bb.maxX).toBeCloseTo(20, 4)
    expect(bb.maxY).toBeCloseTo(20, 4)
    const arc = out.entities.find((e): e is SketchArcEntity => e.id === arcId && e.kind === 'arc')!
    expect(arc.radius).toBeCloseTo(radius, 4)
  })

  it('PLAIN corner3 (no diagonal endpoint): box stays 20x20, fillet appears', async () => {
    const { sk, ids } = realRect()
    // corner3 = (0,20) = ids[2]:end / ids[3]:start. Far ends: (20,20) and (0,0).
    const { out, arcId, radius } = await filletCornerAndSolve(
      sk, ids[2], ids[3], { x: 20, y: 20 }, { x: 0, y: 0 }, 2)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const bb = bbox(out.entities, ids)
    expect(bb.minX).toBeCloseTo(0, 4)
    expect(bb.minY).toBeCloseTo(0, 4)
    expect(bb.maxX).toBeCloseTo(20, 4)
    expect(bb.maxY).toBeCloseTo(20, 4)
    const arc = out.entities.find((e): e is SketchArcEntity => e.id === arcId && e.kind === 'arc')!
    expect(arc.radius).toBeCloseTo(radius, 4)
  })

  it('DIAGONAL-ENDPOINT corner2: box stays 20x20, fillet appears', async () => {
    const { sk, ids } = realRect()
    // corner2 = (20,20) = ids[1]:end / ids[2]:start, AND diagonal:end. Far
    // ends: (20,0) and (0,20).
    const { out, arcId, radius } = await filletCornerAndSolve(
      sk, ids[1], ids[2], { x: 20, y: 0 }, { x: 0, y: 20 }, 2)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const bb = bbox(out.entities, ids)
    expect(bb.minX).toBeCloseTo(0, 4)
    expect(bb.minY).toBeCloseTo(0, 4)
    expect(bb.maxX).toBeCloseTo(20, 4)
    expect(bb.maxY).toBeCloseTo(20, 4)
    const arc = out.entities.find((e): e is SketchArcEntity => e.id === arcId && e.kind === 'arc')!
    expect(arc.radius).toBeCloseTo(radius, 4)
  })

  it('phantom corner tracks the recomputed host-line intersection through a solver resize', async () => {
    const { sk, ids } = realRect()
    let n = 0
    const r = filletLines(
      sk as unknown as SketchDoc,
      ids[1], ids[2], { x: 20, y: 0 }, { x: 0, y: 20 }, 2,
      () => `resize-f${n++}`,
    )
    if (typeof r === 'string') throw new Error(`fillet rejected: ${r}`)
    const filleted = apply(sk, r.transform)
    const diagonal = filleted.entities.find(
      (e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line' && e.construction)
    expect(diagonal).toBeDefined()
    expect(filleted.constraints.some((c) => c.kind === 'coincident' &&
      ((c.a.entityId === diagonal?.id && c.b.entityId === r.phantomPointId) ||
       (c.b.entityId === diagonal?.id && c.a.entityId === r.phantomPointId)))).toBe(true)
    const resized: Sketch = {
      ...filleted,
      dimensions: [
        ...filleted.dimensions,
        {
          id: 'resize-width', kind: 'distanceX', driving: true, value: 30,
          a: ref(ids[0], 'start'), b: ref(r.phantomPointId, 'self'),
        },
        {
          id: 'resize-height', kind: 'distanceY', driving: true, value: 25,
          a: ref(ids[0], 'start'), b: ref(r.phantomPointId, 'self'),
        },
      ],
    }
    const out = solveSketchOnWrapper(await getWrapper(), resized)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const phantom = out.entities.find(
      (e): e is Extract<SketchEntity, { kind: 'point' }> =>
        e.id === r.phantomPointId && e.kind === 'point')!
    const verticalHost = out.entities.find(
      (e): e is Extract<SketchEntity, { kind: 'line' }> => e.id === ids[1] && e.kind === 'line')!
    const horizontalHost = out.entities.find(
      (e): e is Extract<SketchEntity, { kind: 'line' }> => e.id === ids[2] && e.kind === 'line')!
    expect(phantom.at.x).toBeCloseTo(30, 4)
    expect(phantom.at.y).toBeCloseTo(25, 4)
    expect(phantom.at.x).toBeCloseTo(verticalHost.start.x, 4)
    expect(phantom.at.y).toBeCloseTo(horizontalHost.start.y, 4)
    const bb = bbox(out.entities, ids)
    expect(bb.minX).toBeCloseTo(0, 4)
    expect(bb.minY).toBeCloseTo(0, 4)
    expect(bb.maxX).toBeCloseTo(30, 4)
    expect(bb.maxY).toBeCloseTo(25, 4)
  })
})
