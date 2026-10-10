// SKC-BLOCKS Stage 3 gates: an imported DXF/SVG layer ARRIVES as ONE locked
// block. These are the PURE, solver-level gates (the store-level integration --
// openSketchForLayer / promoteSketchLayerToModel wrapping the lift -- is pinned
// in liftEdit.test.ts and promoteSketchToModel.geoUnifyStage3.test.ts).
//
// Covers the plan's Stage 3 gate set + the lane's required assertions:
//   - wrapLiftedAsBlock collapses a fresh lift into ONE born-locked block.
//   - born locked: the wrapped sketch solves at dof 0 (origin fix), members
//     carried verbatim (fully-defined by construction, not the blue sea).
//   - O(1) SOLVER SIZE: regardless of member count the solver sees exactly ONE
//     entity + ONE constraint -> the fixed-16MB-heap OOM (the 340-entity BMG.dxf
//     single-connected-component case) cannot happen.
//   - explode-unlocks: the origin fix is dropped (no dangling ref), members
//     become loose editable lines, and the exploded sketch still solves.
//   - ADR-0019: baked loop CONTENT ids are identical across loose-lift ->
//     block -> explode (CAM op selections survive import-as-block).

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { liftLoops } from '../../lib/sketch/lift'
import { wrapLiftedAsBlock, explodeBlock } from '../../lib/sketch/blocks'
import { bakeSketch } from '../../lib/sketch/bake'
import { computeLoopContentId } from '../../lib/geometry/loopId'
import type { Sketch, SketchEntity, SketchConstraint } from '../../lib/sketch/types'
import type { Loop2D } from '../../types'

let seq = 0
const detId = () => `wrap-${++seq}`

/** A closed WxH rectangle as a bare polyline (the common DXF import shape):
 *  lifts to 4 line entities chained by 4 coincident joints. */
function rectLoop(id: string, x: number, y: number, w = 10, h = 10): Loop2D {
  return {
    id, layerId: 'L', closed: true, type: 'contour', area: w * h,
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  }
}

/** A single closed N-gon polyline -> N CONNECTED line entities on lift. This is
 *  the shape of the OOM case: one large connected component (loose, this is what
 *  aborts the fixed 16MB planegcs heap past ~210 entities). */
function polygonLoop(id: string, n: number, r = 50): Loop2D {
  const points = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: r * Math.cos(a), y: r * Math.sin(a) }
  })
  return { id, layerId: 'L', closed: true, type: 'contour', area: Math.PI * r * r, points }
}

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return { id: 'sk', layerId: 'L', entities: [...entities], constraints: [...constraints], dimensions: [], solveStatus: null }
}

// ---- 1. wrap a fresh lift into ONE born-locked block -----------------------

describe('SKC-BLOCKS Stage 3: wrapLiftedAsBlock', () => {
  it('collapses a fresh lift into ONE block whose origin is FIX-anchored', () => {
    const lifted = liftLoops([rectLoop('r', 0, 0)])
    expect(lifted.entities).toHaveLength(4) // 4 loose lines, the "sea"
    expect(lifted.constraints).toHaveLength(4) // 4 coincident joints (closed)

    const w = wrapLiftedAsBlock(lifted.entities, lifted.constraints, { name: 'Layer 0', newId: detId })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(w.block.kind).toBe('block')
    expect(w.block.name).toBe('Layer 0')
    // Every lifted line is a MEMBER; every coincident joint is absorbed internal.
    expect(w.block.members.entities).toHaveLength(4)
    expect(w.block.members.entities.every((e) => e.kind === 'line')).toBe(true)
    expect(w.block.members.constraints).toHaveLength(4)
    // Born LOCKED: the returned fix pins the block's origin.
    expect(w.fix.kind).toBe('fix')
    expect(w.fix.point?.entityId).toBe(w.blockId)
    expect(w.fix.point?.site).toBe('origin')
  })

  it('born locked: the wrapped sketch solves at dof 0 (fully-defined by construction)', async () => {
    const lifted = liftLoops([rectLoop('r', 0, 0)])
    const w = wrapLiftedAsBlock(lifted.entities, lifted.constraints, { newId: detId })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sketchOf([w.block], [w.fix]))
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.status.dof).toBe(0) // origin pinned -> nothing free
      expect(out.status.conflicting).toEqual([])
    }
    gcs.destroy_gcs_module()
  })
})

// ---- 2. O(1) solver size (the OOM relief) ----------------------------------

describe('SKC-BLOCKS Stage 3: O(1) solver size in member count', () => {
  it('60 disconnected rects (240 lines) enter the solver as ONE entity + ONE constraint, dof 0', async () => {
    const loops = Array.from({ length: 60 }, (_, i) => rectLoop(`r${i}`, i * 20, 0))
    const lifted = liftLoops(loops)
    expect(lifted.entities).toHaveLength(240) // loose: 240 entities the solver would see

    const w = wrapLiftedAsBlock(lifted.entities, lifted.constraints, { newId: detId })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const sk = sketchOf([w.block], [w.fix])
    // The whole import is ONE top-level entity + ONE fix, REGARDLESS of 240 members.
    expect(sk.entities).toHaveLength(1)
    expect(sk.constraints).toHaveLength(1)
    expect(w.block.members.entities).toHaveLength(240)

    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.status.dof).toBe(0)
    gcs.destroy_gcs_module()
  })

  it('a single 300-entity CONNECTED component (the OOM shape) solves as ONE fixed point', async () => {
    const lifted = liftLoops([polygonLoop('big', 300)])
    expect(lifted.entities).toHaveLength(300) // one connected 300-line loop -- the fixed-heap OOM shape

    const w = wrapLiftedAsBlock(lifted.entities, lifted.constraints, { newId: detId })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    // The solver sees ONE point for the entire import; the 300 members never
    // enter the constraint network, so the 16MB-heap OOM cannot be reached.
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sketchOf([w.block], [w.fix]))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.status.dof).toBe(0)
    gcs.destroy_gcs_module()
  })
})

// ---- 3. explode-unlocks ----------------------------------------------------

describe('SKC-BLOCKS Stage 3: explode unlocks the import', () => {
  it('drops the origin fix (no dangling ref) and returns loose, editable lines that still solve', async () => {
    const lifted = liftLoops([rectLoop('r', 0, 0)])
    const w = wrapLiftedAsBlock(lifted.entities, lifted.constraints, { newId: detId })
    expect(w.ok).toBe(true)
    if (!w.ok) return

    const ex = explodeBlock(sketchOf([w.block], [w.fix]), w.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return
    // The origin fix is GONE -- it referenced the now-exploded block and must
    // not dangle into the solver (ADR-0025 explode drops the placement link).
    expect(ex.sketch.constraints.some((c) => c.kind === 'fix' && c.point?.entityId === w.blockId)).toBe(false)
    // Members are ordinary loose lines at their world coords; internal joints back.
    expect(ex.sketch.entities).toHaveLength(4)
    expect(ex.sketch.entities.every((e) => e.kind === 'line')).toBe(true)
    expect(ex.sketch.constraints).toHaveLength(4)
    // The now-loose (under-defined) sketch solves WITHOUT a dangling-fix mapping
    // error -- the whole point of dropping the fix.
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, ex.sketch)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.status.dof).toBeGreaterThan(0) // loose lines are free again
    gcs.destroy_gcs_module()
  })
})

// ---- 4. ADR-0019 stable-id through import -> block -> explode -> bake -------

describe('SKC-BLOCKS Stage 3: ADR-0019 stable loop ids through import-as-block', () => {
  it('baked loop CONTENT ids are identical across loose-lift -> block -> exploded', () => {
    const lifted = liftLoops([rectLoop('r', 0, 0)])
    const looseSketch = sketchOf(lifted.entities, lifted.constraints)
    const w = wrapLiftedAsBlock(lifted.entities, lifted.constraints, { newId: detId })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const blockSketch = sketchOf([w.block], [w.fix])
    const ex = explodeBlock(blockSketch, w.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return

    const ids = (s: Sketch): string[] =>
      bakeSketch(s).loops.map((lp) => computeLoopContentId(lp.layerId, lp.points)).sort()
    const looseIds = ids(looseSketch)
    expect(looseIds).toHaveLength(1) // the rectangle bakes to one closed loop
    // The import-as-block round trip is byte-for-byte the same baked geometry,
    // so a CAM op selecting this loop survives import -> block -> explode.
    expect(ids(blockSketch)).toEqual(looseIds)
    expect(ids(ex.sketch)).toEqual(looseIds)
  })
})
