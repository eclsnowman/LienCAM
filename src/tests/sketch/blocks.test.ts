// SKC-BLOCKS Stage 1 gates: rigid group/explode a block.
//
// Covers the plan's Stage 1 gate set:
//   (i)   solver inertness -- a block contributes EXACTLY 2 DoF regardless of
//         member count; a fixed block reads dof 0 (fully-defined-by-construction).
//   (ii)  ADR-0019 -- baked loop CONTENT ids are identical across loose ->
//         grouped -> exploded (CAM selections survive group/explode).
//   (iii) group refusals -- cross-boundary (named) + nested (named) + empty.
//   (iv)  explode round-trip -- lossless for geometry, member ids preserved.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import {
  groupIntoBlock, explodeBlock, blockMemberWorldEntities, centroidOfEntities,
  setBlockScale, setBlockRotationDeg,
  beginBlockEdit, finishBlockEdit, worldEntityToLocalByFrame, transformEntityByFrame,
  type BlockFrame,
} from '../../lib/sketch/blocks'
import { bakeSketch } from '../../lib/sketch/bake'
import { computeLoopContentId } from '../../lib/geometry/loopId'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchDimension,
  SketchBlockEntity, PointRef,
} from '../../lib/sketch/types'

// ---- builders --------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function sketch(
  entities: SketchEntity[], constraints: SketchConstraint[] = [], dimensions: SketchDimension[] = [],
): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints, dimensions, solveStatus: null }
}

// A closed 40x30 rectangle: 4 independent lines chained by coincident corners,
// bottom/top horizontal, left/right vertical. All refs are internal to the four
// lines, so grouping absorbs every constraint.
function rectEntities(): SketchLineEntity[] {
  return [
    line('l1', 0, 0, 40, 0),   // bottom
    line('l2', 40, 0, 40, 30), // right
    line('l3', 40, 30, 0, 30), // top
    line('l4', 0, 30, 0, 0),   // left
  ]
}
function rectConstraints(): SketchConstraint[] {
  return [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
    { id: 'h1', kind: 'horizontal', line: 'l1' },
    { id: 'h3', kind: 'horizontal', line: 'l3' },
    { id: 'v2', kind: 'vertical', line: 'l2' },
    { id: 'v4', kind: 'vertical', line: 'l4' },
  ]
}
function rectSketch(): Sketch {
  return sketch(rectEntities(), rectConstraints())
}

let seq = 0
const detId = () => `blk-${++seq}`

// ---- 1. Group basics -------------------------------------------------------

describe('SKC-BLOCKS group', () => {
  it('collapses the selection into ONE block, absorbing internal constraints', () => {
    const r = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // One entity remains: the block. All 4 lines are gone from the top level.
    expect(r.sketch.entities.length).toBe(1)
    const block = r.sketch.entities[0] as SketchBlockEntity
    expect(block.kind).toBe('block')
    expect(block.members.entities.length).toBe(4)
    // Every constraint was wholly internal -> absorbed; none left on the sketch.
    expect(r.sketch.constraints.length).toBe(0)
    expect(block.members.constraints.length).toBe(8)
    // Origin = centroid of the members (the 8 endpoints average to the center).
    expect(block.origin.x).toBeCloseTo(20, 9)
    expect(block.origin.y).toBeCloseTo(15, 9)
    expect(block.rotation).toBe(0)
    expect(block.scale).toBe(1)
  })

  it('keeps WHOLLY-external constraints on the sketch, blocks only the selected', () => {
    // Add a 5th loose line that shares nothing with the rectangle, plus a fix
    // on it (external). Group only the rectangle.
    const sk = sketch(
      [...rectEntities(), line('l5', 100, 100, 120, 100)],
      [...rectConstraints(), { id: 'fx5', kind: 'fix', entityId: 'l5' }],
    )
    const r = groupIntoBlock(sk, ['l1', 'l2', 'l3', 'l4'], detId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Remaining top-level: the block + l5. External fix stays.
    const ids = r.sketch.entities.map((e) => e.id).sort()
    expect(ids).toContain('l5')
    expect(r.sketch.entities.filter((e) => e.kind === 'block').length).toBe(1)
    expect(r.sketch.constraints.map((c) => c.id)).toEqual(['fx5'])
  })

  it('refuses an empty selection by name', () => {
    const r = groupIntoBlock(rectSketch(), [], detId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('empty')
  })

  it('refuses a CROSS-BOUNDARY constraint by name (ADR-0003, never severed)', () => {
    // A coincident constraint links l4 (would-be member) to l5 (non-member).
    const sk = sketch(
      [...rectEntities(), line('l5', 0, 0, -10, 0)],
      [...rectConstraints(), { id: 'cross', kind: 'coincident', a: ref('l4', 'end'), b: ref('l5', 'start') }],
    )
    const r = groupIntoBlock(sk, ['l1', 'l2', 'l3', 'l4'], detId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('cross-boundary')
    expect(r.message).toMatch(/coincident constraint/)
    expect(r.message).toMatch(/outside the selection/)
  })

  it('refuses NESTED blocks by name (v1)', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    // Add a loose circle alongside the block, then try to group both.
    const sk = { ...grouped.sketch, entities: [...grouped.sketch.entities,
      { id: 'c9', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 } as SketchEntity] }
    const r = groupIntoBlock(sk, [grouped.blockId, 'c9'], detId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('nested')
    expect(r.message).toMatch(/block/i)
  })
})

// ---- 2. World transform + explode round-trip -------------------------------

describe('SKC-BLOCKS explode round-trip', () => {
  it('world = origin + local, and explode restores the exact loose geometry', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const block = grouped.sketch.entities[0] as SketchBlockEntity

    // Members carried in LOCAL frame (shifted by -origin); world places them back.
    const world = blockMemberWorldEntities(block)
    const worldL1 = world.find((e) => e.id === 'l1') as SketchLineEntity
    expect(worldL1.start.x).toBeCloseTo(0, 9)
    expect(worldL1.start.y).toBeCloseTo(0, 9)
    expect(worldL1.end.x).toBeCloseTo(40, 9)

    // Explode -> ordinary entities at their original world coords, ids preserved,
    // internal constraints restored to the sketch.
    const ex = explodeBlock(grouped.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return
    expect(ex.memberIds.sort()).toEqual(['l1', 'l2', 'l3', 'l4'])
    expect(ex.sketch.entities.every((e) => e.kind === 'line')).toBe(true)
    expect(ex.sketch.constraints.length).toBe(8)

    const orig = rectEntities()
    for (const o of orig) {
      const back = ex.sketch.entities.find((e) => e.id === o.id) as SketchLineEntity
      expect(back.start.x).toBeCloseTo(o.start.x, 9)
      expect(back.start.y).toBeCloseTo(o.start.y, 9)
      expect(back.end.x).toBeCloseTo(o.end.x, 9)
      expect(back.end.y).toBeCloseTo(o.end.y, 9)
    }
  })

  it('centroidOfEntities averages characteristic points', () => {
    const c = centroidOfEntities(rectEntities())
    expect(c.x).toBeCloseTo(20, 9)
    expect(c.y).toBeCloseTo(15, 9)
  })
})

// ---- 3. ADR-0019 stable baked-loop ids across group/explode ----------------

describe('SKC-BLOCKS ADR-0019 stable loop ids', () => {
  it('baked loop CONTENT ids are identical loose -> grouped -> exploded', () => {
    const loose = rectSketch()
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const ex = explodeBlock(grouped.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return

    const contentIds = (s: Sketch): string[] => {
      const { loops } = bakeSketch(s)
      return loops.map((lp) => computeLoopContentId(lp.layerId, lp.points)).sort()
    }
    const looseIds = contentIds(loose)
    // The rectangle bakes to exactly one closed loop.
    expect(looseIds.length).toBe(1)
    expect(contentIds(grouped.sketch)).toEqual(looseIds)
    expect(contentIds(ex.sketch)).toEqual(looseIds)
  })
})

// ---- 4. Solver inertness (2 DoF regardless of member count) ----------------

describe('SKC-BLOCKS solver inertness', () => {
  it('a block contributes EXACTLY 2 DoF (the free translation of the whole rigid body)', async () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return

    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, grouped.sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) { gcs.destroy_gcs_module(); return }
    // The loose rectangle had 8 points (16 params) -> 2 DoF. Grouped, the same
    // rigid body is ONE origin point -> still 2 DoF, from 2 params not 16.
    expect(out.status.dof).toBe(2)
    expect(out.status.conflicting).toEqual([])
    // The block's origin was carried through the solve.
    const block = out.entities.find((e) => e.kind === 'block') as SketchBlockEntity
    expect(block).toBeTruthy()
    gcs.destroy_gcs_module()
  })

  it('a FIXED block reads dof 0 (fully-defined-by-construction)', async () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const blockId = grouped.blockId
    const fixed: Sketch = {
      ...grouped.sketch,
      constraints: [...grouped.sketch.constraints, { id: 'fixb', kind: 'fix', entityId: blockId }],
    }
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, fixed)
    expect(out.ok).toBe(true)
    if (!out.ok) { gcs.destroy_gcs_module(); return }
    expect(out.status.dof).toBe(0)
    expect(out.status.conflicting).toEqual([])
    gcs.destroy_gcs_module()
  })

  it('moving the origin via a coincident dim rigidly re-places every member', async () => {
    // Pin the block origin to a fixed reference point at (100, 50).
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const blockId = grouped.blockId
    const sk: Sketch = {
      ...grouped.sketch,
      entities: [...grouped.sketch.entities,
        { id: 'anchor', kind: 'point', construction: false, at: { x: 100, y: 50 } }],
      constraints: [...grouped.sketch.constraints,
        { id: 'fixa', kind: 'fix', entityId: 'anchor' },
        { id: 'coin', kind: 'coincident', a: ref(blockId, 'origin'), b: ref('anchor', 'self') }],
    }
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) { gcs.destroy_gcs_module(); return }
    expect(out.status.dof).toBe(0)
    const block = out.entities.find((e) => e.kind === 'block') as SketchBlockEntity
    // Origin moved from (20,15) to (100,50); members carried verbatim (local
    // frame), so their WORLD placement shifts by the same (+80,+35).
    expect(block.origin.x).toBeCloseTo(100, 6)
    expect(block.origin.y).toBeCloseTo(50, 6)
    const world = blockMemberWorldEntities(block)
    const l1 = world.find((e) => e.id === 'l1') as SketchLineEntity
    expect(l1.start.x).toBeCloseTo(80, 6)  // was 0 -> +80
    expect(l1.start.y).toBeCloseTo(35, 6)  // was 0 -> +35
    gcs.destroy_gcs_module()
  })
})

// ---- 5. Stage 2: direct-edit inert SCALE / ROTATION ------------------------
//
// scale/rotation are plain fields on SketchBlockEntity; setBlockScale/
// setBlockRotationDeg rewrite them directly (ADR-0033 inert pattern, no gcs
// constraint). blockMemberWorldEntities already implements the general
// (rotation, scale) transform (Stage 1 built it for this exact rider), so
// these tests exercise correctness ABOUT THE ANCHOR, refusal-by-name, no-op
// short-circuiting, ADR-0019 determinism after a transform, explode-after-
// transform, and plain-serializable round-trip.

describe('SKC-BLOCKS Stage 2: setBlockScale', () => {
  it('doubles every member world coordinate about the anchor; origin unchanged', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const r = setBlockScale(grouped.sketch, grouped.blockId, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const block = r.sketch.entities.find((e) => e.id === grouped.blockId) as SketchBlockEntity
    expect(block.scale).toBe(2)
    expect(block.rotation).toBe(0)
    // Anchor (origin, the centroid at 20,15) is unmoved by scale.
    expect(block.origin.x).toBeCloseTo(20, 9)
    expect(block.origin.y).toBeCloseTo(15, 9)
    // Every member's world position is now TWICE its offset from the anchor.
    const world = blockMemberWorldEntities(block)
    const l1 = world.find((e) => e.id === 'l1') as SketchLineEntity
    // Local l1.start was (0,0) - origin(20,15) = (-20,-15); scaled x2 -> (-40,-30);
    // + origin(20,15) -> (-20,-15).
    expect(l1.start.x).toBeCloseTo(-20, 9)
    expect(l1.start.y).toBeCloseTo(-15, 9)
    // Local l1.end was (40,0) - origin(20,15) = (20,-15); scaled x2 -> (40,-30);
    // + origin(20,15) -> (60,-15).
    expect(l1.end.x).toBeCloseTo(60, 9)
    expect(l1.end.y).toBeCloseTo(-15, 9)
  })

  it('refuses a non-positive or non-finite scale BY NAME, leaving the block untouched', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const r = setBlockScale(grouped.sketch, grouped.blockId, bad)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.reason).toBe('invalid-value')
      expect(r.message).toMatch(/positive/i)
    }
  })

  it('refuses an id that is not a block BY NAME', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const r = setBlockScale(grouped.sketch, 'not-a-real-id', 2)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not-a-block')
  })

  it('is a no-op (same sketch reference) when the value is unchanged', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const r = setBlockScale(grouped.sketch, grouped.blockId, 1) // already 1
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sketch).toBe(grouped.sketch)
  })
})

describe('SKC-BLOCKS Stage 2: setBlockRotationDeg', () => {
  it('rotates every member about the anchor by the given degrees CCW', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const r = setBlockRotationDeg(grouped.sketch, grouped.blockId, 90)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const block = r.sketch.entities.find((e) => e.id === grouped.blockId) as SketchBlockEntity
    expect(block.rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(block.scale).toBe(1)
    const world = blockMemberWorldEntities(block)
    const l1 = world.find((e) => e.id === 'l1') as SketchLineEntity
    // Local l1.start = (-20,-15) relative to origin. A +90deg CCW rotation
    // maps (x,y) -> (-y,x): (-20,-15) -> (15,-20); + origin(20,15) -> (35,-5).
    expect(l1.start.x).toBeCloseTo(35, 9)
    expect(l1.start.y).toBeCloseTo(-5, 9)
  })

  it('normalizes into [0, 2*PI): -45deg and 315deg store the SAME rotation', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const neg = setBlockRotationDeg(grouped.sketch, grouped.blockId, -45)
    const pos = setBlockRotationDeg(grouped.sketch, grouped.blockId, 315)
    expect(neg.ok && pos.ok).toBe(true)
    if (!neg.ok || !pos.ok) return
    const negBlock = neg.sketch.entities.find((e) => e.id === grouped.blockId) as SketchBlockEntity
    const posBlock = pos.sketch.entities.find((e) => e.id === grouped.blockId) as SketchBlockEntity
    expect(negBlock.rotation).toBeCloseTo(posBlock.rotation, 9)
    expect(negBlock.rotation).toBeGreaterThanOrEqual(0)
    expect(negBlock.rotation).toBeLessThan(Math.PI * 2)
  })

  it('refuses a non-finite degree value BY NAME', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const r = setBlockRotationDeg(grouped.sketch, grouped.blockId, NaN)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid-value')
  })

  it('is a no-op (same sketch reference) when the normalized value is unchanged', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const r = setBlockRotationDeg(grouped.sketch, grouped.blockId, 0) // already 0
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sketch).toBe(grouped.sketch)
  })
})

describe('SKC-BLOCKS Stage 2: inertness + DoF unaffected by scale/rotation', () => {
  it('a scaled+rotated block still contributes EXACTLY 2 DoF', async () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 2.5)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return
    const rotated = setBlockRotationDeg(scaled.sketch, grouped.blockId, 30)
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return

    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, rotated.sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) { gcs.destroy_gcs_module(); return }
    expect(out.status.dof).toBe(2) // unchanged: still just the origin's 2 DoF
    expect(out.status.conflicting).toEqual([])
    const block = out.entities.find((e) => e.kind === 'block') as SketchBlockEntity
    expect(block.scale).toBeCloseTo(2.5, 9)
    expect(block.rotation).toBeCloseTo((30 * Math.PI) / 180, 9)
    gcs.destroy_gcs_module()
  })
})

describe('SKC-BLOCKS Stage 2: ADR-0019 stable ids + explode-after-transform', () => {
  it('baking the SAME scale/rotation twice yields the SAME deterministic loop id', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const bakeIds = (s: Sketch): string[] => {
      const { loops } = bakeSketch(s)
      return loops.map((lp) => computeLoopContentId(lp.layerId, lp.points)).sort()
    }
    const transformOnce = (): Sketch => {
      const s1 = setBlockScale(grouped.sketch, grouped.blockId, 2)
      if (!s1.ok) throw new Error('setBlockScale refused')
      const s2 = setBlockRotationDeg(s1.sketch, grouped.blockId, 45)
      if (!s2.ok) throw new Error('setBlockRotationDeg refused')
      return s2.sketch
    }
    const idsA = bakeIds(transformOnce())
    const idsB = bakeIds(transformOnce())
    expect(idsA.length).toBe(1)
    expect(idsA).toEqual(idsB) // deterministic: same transform -> same content id
    // And DIFFERENT from the untransformed bake (real geometry actually moved).
    expect(idsA).not.toEqual(bakeIds(grouped.sketch))
  })

  it('explode after scale/rotation restores members at their TRANSFORMED world positions', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 2)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return

    const ex = explodeBlock(scaled.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return
    const l1 = ex.sketch.entities.find((e) => e.id === 'l1') as SketchLineEntity
    // Matches the doubled-world-coord expectation from the setBlockScale test above.
    expect(l1.start.x).toBeCloseTo(-20, 9)
    expect(l1.start.y).toBeCloseTo(-15, 9)
    expect(l1.end.x).toBeCloseTo(60, 9)
    expect(l1.end.y).toBeCloseTo(-15, 9)
  })
})

describe('SKC-BLOCKS Stage 2: explode rescales absorbed LENGTH dimensions (fix found by headed capture)', () => {
  // A block whose members carry an ABSORBED driving length dimension (a real
  // scenario: any member entity dimensioned before grouping keeps that
  // dimension internal). If explode restored the dimension's stored value
  // VERBATIM after a scale edit, the just-restored value would name the
  // PRE-scale length while the just-restored geometry is the POST-scale
  // length -- a driving dimension inconsistent with its own geometry, which
  // the next solve "corrects" by silently snapping the geometry back down
  // (exactly what the headed capture caught). This suite regression-pins the
  // fix: explode rescales the dimension's value by the block's current scale.
  function rectWithLengthDim(): Sketch {
    return sketch(rectEntities(), rectConstraints(), [{
      id: 'dlen', kind: 'distance', driving: true, value: 40,
      a: ref('l1', 'start'), b: ref('l1', 'end'),
      labelAnchor: { x: 20, y: -10 },
    }])
  }

  it('a scale=2 block restores its absorbed distance dimension at 2x its pre-group value', () => {
    const grouped = groupIntoBlock(rectWithLengthDim(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const block = grouped.sketch.entities.find((e) => e.id === grouped.blockId) as SketchBlockEntity
    expect(block.members.dimensions.map((d) => d.id)).toEqual(['dlen'])
    expect(block.members.dimensions[0].value).toBe(40) // absorbed verbatim at group time

    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 2)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return

    const ex = explodeBlock(scaled.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return
    const restored = ex.sketch.dimensions.find((d) => d.id === 'dlen')!
    expect(restored.value).toBe(80) // 40 * scale(2) -- matches the restored geometry
    const l1 = ex.sketch.entities.find((e) => e.id === 'l1') as SketchLineEntity
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(80, 9)
  })

  it('a re-solve after explode does NOT snap the scaled geometry back down (the actual bug)', async () => {
    const grouped = groupIntoBlock(rectWithLengthDim(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 2)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return
    const ex = explodeBlock(scaled.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return

    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, ex.sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) { gcs.destroy_gcs_module(); return }
    const l1 = out.entities.find((e) => e.id === 'l1') as SketchLineEntity
    // Must stay at the SCALED length (80), not snap back to the pre-scale 40.
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(80, 6)
    gcs.destroy_gcs_module()
  })

  it('scale=1 (never scaled) round-trips the dimension value byte-identically -- no Stage 1 regression', () => {
    const grouped = groupIntoBlock(rectWithLengthDim(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const ex = explodeBlock(grouped.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return
    const restored = ex.sketch.dimensions.find((d) => d.id === 'dlen')!
    expect(restored.value).toBe(40) // unchanged: scale was 1
  })

  it('an ANGLE dimension is left unchanged by scale/rotation (rotation-invariant relative angle)', () => {
    const sk = sketch(
      [
        { id: 'a1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } } as SketchLineEntity,
        { id: 'a2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } } as SketchLineEntity,
      ],
      [],
      [{ id: 'dang', kind: 'angle', driving: true, value: Math.PI / 4, a: 'a1', b: 'a2' }],
    )
    const grouped = groupIntoBlock(sk, ['a1', 'a2'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 3)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return
    const rotated = setBlockRotationDeg(scaled.sketch, grouped.blockId, 30)
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    const ex = explodeBlock(rotated.sketch, grouped.blockId)
    expect(ex.ok).toBe(true)
    if (!ex.ok) return
    const restored = ex.sketch.dimensions.find((d) => d.id === 'dang')!
    expect(restored.value).toBe(Math.PI / 4) // unchanged: angle is scale/rotation-invariant
  })
})

describe('SKC-BLOCKS Stage 2: plain-serializable round-trip', () => {
  it('a scaled+rotated block survives JSON.stringify/parse byte-for-byte', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 2)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return
    const rotated = setBlockRotationDeg(scaled.sketch, grouped.blockId, 45)
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return

    const roundTripped = JSON.parse(JSON.stringify(rotated.sketch)) as Sketch
    expect(roundTripped).toEqual(rotated.sketch)
    const block = roundTripped.entities.find((e) => e.id === grouped.blockId) as SketchBlockEntity
    expect(block.scale).toBe(2)
    expect(block.rotation).toBeCloseTo((45 * Math.PI) / 180, 9)
  })
})

// ---- Stage 4: edit a block IN PLACE ---------------------------------------
//
// Gate set for edit-in-place (plan Stage 4):
//   - worldEntityToLocalByFrame is the EXACT inverse of transformEntityByFrame.
//   - beginBlockEdit detaches the block into world members (reusing explode),
//     capturing the frame + outerIds; refuses a non-block by name.
//   - finishBlockEdit re-freezes with the SAME id + SAME frame (no jump, no id
//     churn), folding world->local; a begin->finish with NO edit is a perfect
//     identity round-trip (member local coords, internal constraints, AND the
//     ADR-0019 baked loop ids all unchanged) -- for scale=1 AND scaled+rotated.
//   - an edit to a member (or a NEW member drawn in the session) is reflected.
//   - a LOCKED block round-trips locked (fix dropped at begin, re-added at finish).
//   - cross-boundary refusal by name; delete-all-members deletes the block.

function block4(sk: Sketch): SketchBlockEntity {
  const b = sk.entities.find((e) => e.kind === 'block')
  if (!b || b.kind !== 'block') throw new Error('no block in sketch')
  return b
}

describe('SKC-BLOCKS Stage 4 - worldEntityToLocalByFrame inverse', () => {
  it('is the exact inverse of transformEntityByFrame for every entity kind', () => {
    const frame: BlockFrame = { origin: { x: 12, y: -7 }, rotation: 0.6, scale: 1.75 }
    const samples: SketchEntity[] = [
      { id: 'p', kind: 'point', construction: false, at: { x: 3, y: 4 } },
      line('ln', -2, 5, 9, -1),
      { id: 'ci', kind: 'circle', construction: false, center: { x: 1, y: 2 }, radius: 6 },
      { id: 'ar', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: 5, startAngle: 0.2, endAngle: 1.9 },
      { id: 'el', kind: 'ellipse', construction: false, center: { x: 2, y: 2 }, majorRadius: 8, minorRadius: 3, rotation: 0.4 },
      { id: 'sp', kind: 'spline', construction: false, closed: false, points: [{ x: 0, y: 0 }, { x: 3, y: 5 }, { x: 7, y: 1 }] },
      { id: 'tx', kind: 'text', construction: false, at: { x: 4, y: 4 }, text: 'Hi', height: 5, fontStyle: 'single-line', rotation: 0.3 },
    ]
    for (const e of samples) {
      const back = worldEntityToLocalByFrame(transformEntityByFrame(e, frame), frame)
      // Deep-equal to floating-point round-off. Compare via JSON with rounding.
      const round = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (_k, v) =>
        typeof v === 'number' ? Number(v.toFixed(9)) : v))
      expect(round(back)).toEqual(round(e))
    }
  })
})

describe('SKC-BLOCKS Stage 4 - begin/finish edit-in-place', () => {
  const loopIds = (s: Sketch): string[] => {
    const { loops } = bakeSketch(s)
    return loops.map((lp) => computeLoopContentId(lp.layerId, lp.points)).sort()
  }

  it('refuses beginBlockEdit on a non-block by name', () => {
    const r = beginBlockEdit(rectSketch(), 'l1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not-a-block')
  })

  it('begin detaches the block into WORLD members; finish re-freezes with the SAME id + frame (identity round-trip)', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const original = block4(grouped.sketch)

    const begun = beginBlockEdit(grouped.sketch, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    // The block is gone; its 4 members are loose at WORLD coords, ids preserved.
    expect(begun.sketch.entities.some((e) => e.kind === 'block')).toBe(false)
    expect(begun.sketch.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2', 'l3', 'l4'])
    expect(begun.meta.blockId).toBe(grouped.blockId)
    expect(begun.meta.frame.origin).toEqual(original.origin)
    expect(begun.meta.outerIds).toEqual([]) // nothing outside the block

    // No edit -> finish reproduces the block byte-for-byte (member local coords,
    // internal constraints, frame, id).
    const done = finishBlockEdit(begun.sketch, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.deleted).toBe(false)
    const rebuilt = block4(done.sketch)
    expect(rebuilt.id).toBe(grouped.blockId)
    expect(rebuilt.origin).toEqual(original.origin)
    expect(rebuilt.rotation).toBe(original.rotation)
    expect(rebuilt.scale).toBe(original.scale)
    // Member local geometry identical to floating-point round-off.
    const round = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (_k, v) =>
      typeof v === 'number' ? Number(v.toFixed(9)) : v))
    expect(round(rebuilt.members.entities)).toEqual(round(original.members.entities))
    expect(rebuilt.members.constraints.map((c) => c.id).sort())
      .toEqual(original.members.constraints.map((c) => c.id).sort())
    // ADR-0019: baked loop ids survive an edit-in-place round-trip unchanged.
    expect(loopIds(done.sketch)).toEqual(loopIds(grouped.sketch))
  })

  it('identity round-trip holds for a SCALED + ROTATED block (frame preserved, no member rewrite)', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const scaled = setBlockScale(grouped.sketch, grouped.blockId, 2)
    expect(scaled.ok).toBe(true)
    if (!scaled.ok) return
    const rotated = setBlockRotationDeg(scaled.sketch, grouped.blockId, 30)
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    const original = block4(rotated.sketch)

    const begun = beginBlockEdit(rotated.sketch, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    expect(begun.meta.frame.scale).toBe(2)
    const done = finishBlockEdit(begun.sketch, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const rebuilt = block4(done.sketch)
    expect(rebuilt.scale).toBe(2)
    expect(rebuilt.rotation).toBeCloseTo((30 * Math.PI) / 180, 9)
    const round = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (_k, v) =>
      typeof v === 'number' ? Number(v.toFixed(9)) : v))
    // Member LOCAL geometry never changed (scale/rotation are frame-only).
    expect(round(rebuilt.members.entities)).toEqual(round(original.members.entities))
    // World geometry (what the user sees) is identical too -> stable loop ids.
    expect(loopIds(done.sketch)).toEqual(loopIds(rotated.sketch))
  })

  it('reflects an in-place member edit WITHOUT jumping the block origin', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const original = block4(grouped.sketch)

    const begun = beginBlockEdit(grouped.sketch, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    // Move l1's end from world (40,0) to (50,0) -- a real member edit in place.
    const edited: Sketch = {
      ...begun.sketch,
      entities: begun.sketch.entities.map((e) =>
        e.id === 'l1' && e.kind === 'line' ? { ...e, end: { x: 50, y: 0 } } : e),
    }
    const done = finishBlockEdit(edited, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const rebuilt = block4(done.sketch)
    // Origin/frame unchanged -> the block did NOT jump.
    expect(rebuilt.origin).toEqual(original.origin)
    // The edit is captured: l1's world end is now (50,0).
    const worldL1 = blockMemberWorldEntities(rebuilt).find((e) => e.id === 'l1')
    expect(worldL1 && worldL1.kind === 'line' && worldL1.end.x).toBeCloseTo(50, 9)
  })

  it('absorbs a NEW member drawn during the session', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const begun = beginBlockEdit(grouped.sketch, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    // Draw a new diagonal line at world coords inside the session.
    const withNew: Sketch = {
      ...begun.sketch,
      entities: [...begun.sketch.entities, line('lnew', 0, 0, 40, 30)],
    }
    const done = finishBlockEdit(withNew, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const rebuilt = block4(done.sketch)
    // The block now has 5 members incl the new line, and no loose top-level line.
    expect(rebuilt.members.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'lnew'])
    expect(done.sketch.entities.filter((e) => e.kind !== 'block').length).toBe(0)
  })

  it('a LOCKED block round-trips LOCKED (origin fix dropped at begin, re-added at finish)', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const locked: Sketch = {
      ...grouped.sketch,
      constraints: [...grouped.sketch.constraints,
        { id: 'lockfix', kind: 'fix', point: { entityId: grouped.blockId, site: 'origin' } }],
    }
    const begun = beginBlockEdit(locked, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    expect(begun.meta.locked).toBe(true)
    // During the session the origin fix is gone (block is detached).
    expect(begun.sketch.constraints.some((c) => c.kind === 'fix' && c.point?.site === 'origin')).toBe(false)
    const done = finishBlockEdit(begun.sketch, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    // The origin fix is re-added, pinning the SAME block id.
    const fix = done.sketch.constraints.find(
      (c) => c.kind === 'fix' && c.point?.entityId === grouped.blockId && c.point?.site === 'origin')
    expect(fix).toBeTruthy()
  })

  it('refuses finish by name when a member is constrained to an OUTER entity (cross-boundary)', () => {
    // A block plus a loose outer anchor point.
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const withOuter: Sketch = {
      ...grouped.sketch,
      entities: [...grouped.sketch.entities,
        { id: 'outer', kind: 'point', construction: false, at: { x: 200, y: 200 } }],
    }
    const begun = beginBlockEdit(withOuter, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    expect(begun.meta.outerIds).toEqual(['outer'])
    // The user coincident-links a member endpoint to the outer point.
    const edited: Sketch = {
      ...begun.sketch,
      constraints: [...begun.sketch.constraints,
        { id: 'cross', kind: 'coincident', a: ref('l1', 'start'), b: ref('outer', 'self') }],
    }
    const done = finishBlockEdit(edited, begun.meta)
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.reason).toBe('cross-boundary')
  })

  it('deletes the block entirely when every member was deleted in the session', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const begun = beginBlockEdit(grouped.sketch, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    // Delete all members (and their now-loose internal constraints).
    const emptied: Sketch = { ...begun.sketch, entities: [], constraints: [], dimensions: [] }
    const done = finishBlockEdit(emptied, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.deleted).toBe(true)
    expect(done.sketch.entities.length).toBe(0)
  })

  it('leaves OUTER entities untouched across the session', () => {
    const grouped = groupIntoBlock(rectSketch(), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const outerLine = line('lout', 100, 100, 140, 100)
    const withOuter: Sketch = { ...grouped.sketch, entities: [...grouped.sketch.entities, outerLine] }
    const begun = beginBlockEdit(withOuter, grouped.blockId)
    expect(begun.ok).toBe(true)
    if (!begun.ok) return
    const done = finishBlockEdit(begun.sketch, begun.meta)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const rebuiltOuter = done.sketch.entities.find((e) => e.id === 'lout')
    expect(rebuiltOuter).toEqual(outerLine)
  })
})
