// B23 regression: an UNDER-DEFINED parametric sketch must NOT drift from
// where the user drew it on finish/open/edit solves.
//
// Bug (docs/planning/POST-MERGE-WORKPLAN.md "Operator review notes 2026-06-16"):
// an under-defined sketch has a null-space (the free DoF). A plain DogLeg
// least-squares solve satisfied the constraints by walking the FREE DoF off
// the as-drawn location, so geometry moved on "Finish sketch" and moved more
// on reopen (it re-solves), accumulating over bake/relift/resolve cycles.
//
// FIX (gcsMapping.ts freeDofPinPrimitives, wired into solveSystem's non-drag
// push): SOFT-pin every free point at its as-drawn coordinate with
// coordinate_x/y `temporary: true` (planegcs tag -1). Tag -1 is LOWER
// priority than real constraints, so the null-space parks where drawn (no
// drift) while hard constraints/dimensions STILL win and move geometry as
// needed (minimal-movement, like FreeCAD/other CAD editors).
//
// This test exercises the SAME pure entry point the store/worker fires on
// finish/reopen: solveSketchOnWrapper -> solveSystem. It asserts:
//   (a) NO-DRIFT: an under-defined sketch drawn EXACTLY on its constraints
//       stays put after finish AND after a reopen re-solve (the B23 bug).
//   (b) STILL-MOVES: applying a real constraint to an under-defined sketch
//       DOES move geometry (proves the soft pins did not over-pin / freeze
//       the sketch).
// Deterministic: planegcs DogLeg is deterministic and these inputs have a
// unique minimal-movement solution.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchDimension, PointRef,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }

function sketch(
  entities: SketchEntity[], constraints: SketchConstraint[], dimensions: SketchDimension[],
): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions,
    solveStatus: null, // null = never solved, exactly how a fresh lift is born.
  }
}

/** All point sites of an entity, as flat {key, x, y} for delta measurement. */
function pointsOf(e: SketchEntity): { key: string; x: number; y: number }[] {
  switch (e.kind) {
    case 'point':  return [{ key: e.id, x: e.at.x, y: e.at.y }]
    case 'line':   return [
      { key: `${e.id}:start`, x: e.start.x, y: e.start.y },
      { key: `${e.id}:end`,   x: e.end.x,   y: e.end.y },
    ]
    case 'circle': return [{ key: `${e.id}:center`, x: e.center.x, y: e.center.y }]
    case 'arc':    return [
      { key: `${e.id}:center`, x: e.center.x, y: e.center.y },
      { key: `${e.id}:start`,  x: e.center.x + e.radius * Math.cos(e.startAngle),
                               y: e.center.y + e.radius * Math.sin(e.startAngle) },
      { key: `${e.id}:end`,    x: e.center.x + e.radius * Math.cos(e.endAngle),
                               y: e.center.y + e.radius * Math.sin(e.endAngle) },
    ]
    case 'ellipse':
    case 'elliptical-arc':
      return [{ key: `${e.id}:center`, x: e.center.x, y: e.center.y }]
    case 'spline':
      return [{ key: `${e.id}:start`, x: e.points[0].x, y: e.points[0].y }]
    case 'text':
      return [{ key: `${e.id}:start`, x: e.at.x, y: e.at.y }]
    case 'block':
      return [{ key: `${e.id}:origin`, x: e.origin.x, y: e.origin.y }]
  }
}

function maxDrift(before: SketchEntity[], after: SketchEntity[]): { max: number; where: string } {
  const a = new Map<string, { x: number; y: number }>()
  for (const e of after) for (const p of pointsOf(e)) a.set(p.key, { x: p.x, y: p.y })
  let max = 0, where = '(none)'
  for (const e of before) for (const p of pointsOf(e)) {
    const q = a.get(p.key)
    if (!q) throw new Error(`FAIL LOUD: point '${p.key}' missing after solve (mapping/solve desync)`)
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d > max) { max = d; where = p.key }
  }
  return { max, where }
}

// An UNDER-DEFINED open polyline drawn far from the origin: three chained
// lines (an open "Z"), only joints coincident — NO H/V, NO dimensions, NO
// fix. Many free DoF, drawn cleanly (joints meet exactly), so the system is
// ALREADY satisfied as drawn: a correct solver must not move anything.
function underDefinedChain(): Sketch {
  return sketch(
    [
      line('a', 100, 200, 140, 200),
      line('b', 140, 200, 100, 240),
      line('c', 100, 240, 140, 240),
    ],
    [
      { id: 'cab', kind: 'coincident', a: ref('a', 'end'), b: ref('b', 'start') },
      { id: 'cbc', kind: 'coincident', a: ref('b', 'end'), b: ref('c', 'start') },
    ],
    [],
  )
}

// An under-defined rectangle drawn EXACTLY at (50,60)-(90,90): closed, H/V +
// driving W=40/H=30, but NO fix -> 2 free DoF (rigid translation). Drawn
// exactly on its constraints, so a correct solver leaves it where drawn.
function underDefinedRect(): Sketch {
  return sketch(
    [
      line('l1', 50, 60, 90, 60),
      line('l2', 90, 60, 90, 90),
      line('l3', 90, 90, 50, 90),
      line('l4', 50, 90, 50, 60),
    ],
    [
      { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
      { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
      { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
      { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
      { id: 'h1',  kind: 'horizontal', line: 'l1' },
      { id: 'h3',  kind: 'horizontal', line: 'l3' },
      { id: 'v2',  kind: 'vertical',   line: 'l2' },
      { id: 'v4',  kind: 'vertical',   line: 'l4' },
    ],
    [
      { id: 'dw', kind: 'distance', driving: true, value: 40, a: ref('l1', 'start'), b: ref('l1', 'end') },
      { id: 'dh', kind: 'distance', driving: true, value: 30, a: ref('l2', 'start'), b: ref('l2', 'end') },
    ],
  )
}

describe('B23 under-defined sketch drift', () => {
  // (a) THE BUG: under-defined geometry drawn exactly on its constraints must
  //     not drift on finish, and must not drift on a reopen re-solve.
  it('open under-defined chain stays put on finish AND reopen', async () => {
    const gcs = await createGcsWrapper()
    try {
      const drawn = underDefinedChain()
      const drawnEntities = JSON.parse(JSON.stringify(drawn.entities)) as SketchEntity[]

      const finish = solveSketchOnWrapper(gcs, drawn)
      expect(finish.ok).toBe(true)
      if (!finish.ok) return
      expect(finish.status.dof).toBeGreaterThan(0) // genuinely under-defined
      expect(maxDrift(drawnEntities, finish.entities).max).toBeLessThan(1e-6)

      // Reopen: store applies solved entities, a SECOND open-solve runs.
      const reopened: Sketch = { ...drawn, entities: finish.entities, solveStatus: finish.status }
      const reopen = solveSketchOnWrapper(gcs, reopened)
      expect(reopen.ok).toBe(true)
      if (!reopen.ok) return
      // Cumulative drift from the ORIGINAL as-drawn coords stays ~0.
      expect(maxDrift(drawnEntities, reopen.entities).max).toBeLessThan(1e-6)
    } finally {
      gcs.destroy_gcs_module()
    }
  })

  it('closed under-defined rectangle (2 free DoF) stays put on finish AND reopen', async () => {
    const gcs = await createGcsWrapper()
    try {
      const drawn = underDefinedRect()
      const drawnEntities = JSON.parse(JSON.stringify(drawn.entities)) as SketchEntity[]

      const finish = solveSketchOnWrapper(gcs, drawn)
      expect(finish.ok).toBe(true)
      if (!finish.ok) return
      expect(finish.status.dof).toBe(2) // rigid translation null-space
      expect(maxDrift(drawnEntities, finish.entities).max).toBeLessThan(1e-6)

      const reopened: Sketch = { ...drawn, entities: finish.entities, solveStatus: finish.status }
      const reopen = solveSketchOnWrapper(gcs, reopened)
      expect(reopen.ok).toBe(true)
      if (!reopen.ok) return
      expect(maxDrift(drawnEntities, reopen.entities).max).toBeLessThan(1e-6)
    } finally {
      gcs.destroy_gcs_module()
    }
  })

  // (b) NO OVER-PINNING: applying a real constraint to an under-defined sketch
  //     MUST still move geometry. The soft pins are tag -1, so the hard
  //     constraint wins. Here the chain's middle line 'b' is diagonal; adding
  //     a horizontal constraint to it MUST rotate it flat (its free endpoint
  //     moves well off the as-drawn location).
  it('a newly applied constraint STILL moves geometry (soft pins do not freeze the sketch)', async () => {
    const gcs = await createGcsWrapper()
    try {
      const drawn = underDefinedChain()
      const drawnEntities = JSON.parse(JSON.stringify(drawn.entities)) as SketchEntity[]

      // User applies "horizontal" to the diagonal middle line 'b'. The system
      // is no longer satisfied as drawn; the solver MUST move 'b' (and the
      // chained joints) to make it horizontal.
      const withConstraint: Sketch = {
        ...drawn,
        constraints: [
          ...drawn.constraints,
          { id: 'hb', kind: 'horizontal', line: 'b' },
        ],
      }
      const solved = solveSketchOnWrapper(gcs, withConstraint)
      expect(solved.ok).toBe(true)
      if (!solved.ok) return

      // Geometry MUST have moved (the constraint was not silently ignored).
      const moved = maxDrift(drawnEntities, solved.entities)
      expect(moved.max).toBeGreaterThan(1) // mm; the diagonal had a 40mm rise

      // And the constraint is actually satisfied: line 'b' is now horizontal.
      const b = solved.entities.find((e) => e.id === 'b')
      expect(b && b.kind === 'line').toBe(true)
      if (b && b.kind === 'line') {
        expect(Math.abs(b.start.y - b.end.y)).toBeLessThan(1e-6)
      }
    } finally {
      gcs.destroy_gcs_module()
    }
  })
})
