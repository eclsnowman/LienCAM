// WO-1858 (BK-140): a chamfer's two setbacks can be DRIVEN, not just read.
//
// The behavioural proof runs against the REAL planegcs solver, not a
// hand-inspected primitive list: type a value into either half of a D1 x D2
// dimension and the chamfer line has to move to that setback and stay there
// through a re-solve, with both legs still on their original infinite lines.
//
// FIXTURE (the acceptance's "rectangle corner"). Leg A runs (0,0)->(10,0) and
// leg B runs (10,0)->(10,10); the corner at (10,0) is chamfered 3 x 5. The
// chamfer tool's OWN two driving setback dimensions are then removed -- they
// pin exactly the pair this order teaches the D1 x D2 dimension to pin, so
// leaving them in would make the new dimension redundant rather than
// load-bearing, and there would be nothing for it to prove. What stays is the
// rig itself (the theoretical-corner phantom pinned to both legs, both joint
// coincidents) plus four constraints that hold each leg's INFINITE line where
// it was drawn: A's start fixed + A horizontal, B's end fixed + B vertical.
// That leaves exactly two freedoms -- how far along each leg the cut lands --
// which is what a driving setback pair is worth.

import { describe, it, expect } from 'vitest'
import { chamferLinesTwoDistance } from '../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import {
  measureChamferSetbacks, resolveChamferCorner,
} from '../../lib/sketch/tools/theoreticalCorner'
import {
  sketchToGcsPrimitives, solveSketchOnWrapper,
} from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { remeasureReferenceDimensions } from '../../lib/sketch/tools/dimTool'
import type {
  Sketch, SketchConstraint, SketchDimension, SketchEntity, SketchLineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `wo1858-${n++}`

interface Fixture {
  sketch: Sketch
  lineId: string
  /** The D1 x D2 dimension id the tests edit. */
  dimId: string
}

/** The rectangle corner described in this file's header, carrying a D1 x D2
 *  dimension in the requested state. `d1`/`d2` are the values STORED on that
 *  dimension (a driving pair asks the solver for them; a reference pair only
 *  reports, so they are seeded at the as-built 3 x 5). */
function rectangleCorner(
  { driving, d1 = 3, d2 = 5 }: { driving: boolean; d1?: number; d2?: number },
): Fixture {
  const doc: SketchDoc = {
    entities: [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ],
    constraints: [
      { id: 'c-corner', kind: 'coincident',
        a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' } },
    ],
    dimensions: [],
  }
  const r = chamferLinesTwoDistance(doc, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 3, 5, newId)
  if (typeof r === 'string') throw new Error(r)

  const legHolders: SketchConstraint[] = [
    { id: newId(), kind: 'fix', point: { entityId: 'A', site: 'start' } },
    { id: newId(), kind: 'horizontal', line: 'A' },
    { id: newId(), kind: 'fix', point: { entityId: 'B', site: 'end' } },
    { id: newId(), kind: 'vertical', line: 'B' },
  ]
  const dimId = newId()
  const setbackPair: SketchDimension = {
    id: dimId, kind: 'd1xd2', entityId: r.lineId, driving, value: d1, d2,
  }
  return {
    lineId: r.lineId,
    dimId,
    sketch: {
      id: 'wo1858-rect',
      layerId: 'layer',
      entities: r.transform.entities,
      constraints: [...r.transform.constraints, ...legHolders],
      // The chamfer tool's own two setback dims are dropped -- see the header.
      dimensions: [setbackPair],
      solveStatus: null,
    },
  }
}

function lineOf(entities: readonly SketchEntity[], id: string): SketchLineEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`expected line '${id}'`)
  return e
}

async function withWrapper<T>(fn: (w: Awaited<ReturnType<typeof createGcsWrapper>>) => T | Promise<T>): Promise<T> {
  const wrapper = await createGcsWrapper()
  try {
    return await fn(wrapper)
  } finally {
    wrapper.destroy_gcs_module()
  }
}

describe('WO-1858: the compound mapping a driving D1 x D2 pushes', () => {
  it('pushes TWO p2p_distance primitives, corner phantom -> each chamfer-line endpoint', () => {
    const f = rectangleCorner({ driving: true, d1: 4, d2: 5 })
    const corner = resolveChamferCorner(f.sketch.entities, f.sketch.constraints, f.lineId)
    expect(corner.ok).toBe(true)
    if (!corner.ok) return

    const prims = sketchToGcsPrimitives(f.sketch)
    const pair = prims.filter((p) => p.id === `${f.dimId}:d1` || p.id === `${f.dimId}:d2`)
    expect(pair.map((p) => p.id)).toEqual([`${f.dimId}:d1`, `${f.dimId}:d2`])
    expect(pair.every((p) => p.type === 'p2p_distance')).toBe(true)
    expect(pair).toMatchObject([
      { p1_id: corner.corner.phantomRef.entityId, p2_id: `${f.lineId}:start`, distance: 4, driving: true },
      { p1_id: corner.corner.phantomRef.entityId, p2_id: `${f.lineId}:end`, distance: 5, driving: true },
    ])
  })

  it('pushes NOTHING for a REFERENCE pair (unchanged: a readout constrains no geometry)', () => {
    const f = rectangleCorner({ driving: false })
    const prims = sketchToGcsPrimitives(f.sketch)
    expect(prims.some((p) => p.id.startsWith(f.dimId))).toBe(false)
  })

  it('a DRIVING pair whose corner cannot be resolved says so in one console line and pushes nothing', () => {
    const f = rectangleCorner({ driving: true })
    // Re-solve B parallel to A: the rig is structurally intact, the corner is
    // not. Same document state resolveChamferCorner already refuses by name.
    const parallel: Sketch = {
      ...f.sketch,
      entities: f.sketch.entities.map((e) =>
        e.id === 'B' ? { ...(e as SketchLineEntity), start: { x: 0, y: 5 }, end: { x: 10, y: 5 } } : e),
    }
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      const prims = sketchToGcsPrimitives(parallel)
      expect(prims.some((p) => p.id.startsWith(f.dimId))).toBe(false)
    } finally {
      console.warn = realWarn
    }
    const mine = warnings.filter((w) => w.includes(f.dimId))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('parallel-legs')
    expect(mine[0]).toContain(f.lineId)
  })
})

describe('WO-1858: typing into either half moves the chamfer and it stays', () => {
  it('D1 := 4 moves the cut to 4 mm from the theoretical corner, D2 stays 5, both legs hold their lines', async () => {
    const f = rectangleCorner({ driving: true, d1: 4, d2: 5 })
    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, f.sketch)
      expect(out.ok).toBe(true)
      if (!out.ok) return

      const m = measureChamferSetbacks(out.entities, f.sketch.constraints, f.lineId)
      expect(m).not.toBeNull()
      expect(m!.d1).toBeCloseTo(4, 6)
      // The NEGATIVE CONTROL for the compound mapping: drop the second
      // p2p_distance from mapDimension and d2 relaxes off 5 here, because
      // nothing else in this document holds the B-side cut.
      expect(m!.d2).toBeCloseTo(5, 6)

      // Both legs still lie on the infinite lines they were drawn on.
      const a = lineOf(out.entities, 'A')
      const b = lineOf(out.entities, 'B')
      expect(a.start).toMatchObject({ x: 0, y: 0 })
      expect(a.end.y).toBeCloseTo(0, 6)
      expect(b.end).toMatchObject({ x: 10, y: 10 })
      expect(b.start.x).toBeCloseTo(10, 6)

      // The corner itself never moved: it is the legs' intersection.
      const corner = resolveChamferCorner(out.entities, f.sketch.constraints, f.lineId)
      expect(corner.ok).toBe(true)
      if (corner.ok) {
        expect(corner.corner.phantom.x).toBeCloseTo(10, 6)
        expect(corner.corner.phantom.y).toBeCloseTo(0, 6)
      }
    })
  })

  it('D2 := 7 is the mirror of that', async () => {
    const f = rectangleCorner({ driving: true, d1: 3, d2: 7 })
    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, f.sketch)
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const m = measureChamferSetbacks(out.entities, f.sketch.constraints, f.lineId)
      expect(m!.d1).toBeCloseTo(3, 6)
      expect(m!.d2).toBeCloseTo(7, 6)
      const b = lineOf(out.entities, 'B')
      expect(b.start.x).toBeCloseTo(10, 6)
      expect(b.start.y).toBeCloseTo(7, 6)
    })
  })

  it('the value SURVIVES a re-solve: solving the solved sketch again leaves 4 x 5 in place', async () => {
    const f = rectangleCorner({ driving: true, d1: 4, d2: 5 })
    await withWrapper((w) => {
      const first = solveSketchOnWrapper(w, f.sketch)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const resolved: Sketch = { ...f.sketch, entities: first.entities }

      // The post-solve remeasure both hosts run must NOT overwrite a DRIVING
      // pair's values (the pre-WO-1858 behaviour forced it back to a readout).
      const remeasured = remeasureReferenceDimensions(
        first.entities, resolved.dimensions, resolved.constraints)
      expect(remeasured).toBe(resolved.dimensions) // byte-stable: nothing to remeasure
      expect(remeasured[0]).toMatchObject({ driving: true, value: 4, d2: 5 })

      const second = solveSketchOnWrapper(w, { ...resolved, dimensions: remeasured })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      const m = measureChamferSetbacks(second.entities, resolved.constraints, f.lineId)
      expect(m!.d1).toBeCloseTo(4, 6)
      expect(m!.d2).toBeCloseTo(5, 6)
    })
  })

  it('a REFERENCE pair re-measures both halves after a solve and drives nothing', async () => {
    const f = rectangleCorner({ driving: false, d1: 999, d2: 888 })
    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, f.sketch)
      expect(out.ok).toBe(true)
      if (!out.ok) return
      // 999 x 888 asked the solver for nothing: the geometry is still as built.
      const remeasured = remeasureReferenceDimensions(
        out.entities, f.sketch.dimensions, f.sketch.constraints)
      expect(remeasured[0]).toMatchObject({ driving: false })
      const r0 = remeasured[0]
      if (r0.kind !== 'd1xd2') throw new Error(`expected d1xd2, got ${r0.kind}`)
      expect(r0.value).toBeCloseTo(3, 6)
      expect(r0.d2).toBeCloseTo(5, 6)
    })
  })
})

describe('WO-1858: driving the pair removes exactly two degrees of freedom', () => {
  it('reference -> dof 2; driving -> dof 0', async () => {
    const asReference = rectangleCorner({ driving: false })
    const asDriving = rectangleCorner({ driving: true, d1: 3, d2: 5 })
    await withWrapper((w) => {
      const ref = solveSketchOnWrapper(w, asReference.sketch)
      expect(ref.ok).toBe(true)
      if (!ref.ok) return
      expect(ref.status.dof).toBe(2)

      const drv = solveSketchOnWrapper(w, asDriving.sketch)
      expect(drv.ok).toBe(true)
      if (!drv.ok) return
      expect(drv.status.dof).toBe(0)
      expect(drv.status.conflicting).toEqual([])
    })
  })
})
