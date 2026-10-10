// SKC-ROTATION-SOLVABLE gates: a block's ROTATION as a solver-owned angle.
//
// A block is typed-inert by default (only its origin enters the solve -> exactly
// 2 DoF, the SKC-BLOCKS pins in blocks.test.ts). When a constraint/dimension
// references the block AS A LINE OPERAND (angle dim, parallel, perpendicular,
// horizontal, vertical), its orientation is PROMOTED to a solver-owned angle:
// a refpoint at a fixed radius (radius pinned by one p2p_distance, angle free =
// +1 DoF) and a synthetic origin->refpoint orient LINE the constraint solves.
// entitiesFromSolved re-derives block.rotation from the solved orient vector.
//
// These gates prove:
//   (i)   a driving angle dimension DRIVES the block's rotation (solver owns it),
//   (ii)  a parallel / horizontal constraint DRIVES it likewise,
//   (iii) the rotation is a REAL, CONSTRAINABLE DoF: a reference-only angle dim
//         leaves it free (dof +1); making it driving consumes it (dof 0),
//   (iv)  over-constraining the angle refuses BY NAME (conflicting set reported),
//   (v)   definedness: an angle-constrained block reads FULLY DEFINED; a block
//         whose rotation is still free does NOT,
//   (vi)  an UN-referenced block stays byte-identically 2 DoF (no regression).

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { groupIntoBlock } from '../../lib/sketch/blocks'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchDimension,
  SketchBlockEntity, PointRef,
} from '../../lib/sketch/types'

// ---- builders (mirrors blocks.test.ts) -------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function mkSketch(
  entities: SketchEntity[], constraints: SketchConstraint[] = [], dimensions: SketchDimension[] = [],
): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints, dimensions, solveStatus: null }
}
function rectEntities(): SketchLineEntity[] {
  return [
    line('l1', 0, 0, 40, 0), line('l2', 40, 0, 40, 30),
    line('l3', 40, 30, 0, 30), line('l4', 0, 30, 0, 0),
  ]
}
function rectConstraints(): SketchConstraint[] {
  return [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
    { id: 'h1', kind: 'horizontal', line: 'l1' }, { id: 'h3', kind: 'horizontal', line: 'l3' },
    { id: 'v2', kind: 'vertical', line: 'l2' }, { id: 'v4', kind: 'vertical', line: 'l4' },
  ]
}
let seq = 0
const detId = () => `blk-${++seq}`

/** A grouped rectangle block whose origin is pinned, plus a fully-fixed
 *  reference line at `refAngleDeg` degrees from +X (through the world origin,
 *  length 20). Returns the block id and the base sketch to add angle refs to. */
function blockWithRefLine(refAngleDeg: number): { base: Sketch; blockId: string } {
  const grouped = groupIntoBlock(mkSketch(rectEntities(), rectConstraints()), ['l1', 'l2', 'l3', 'l4'], detId)
  if (!grouped.ok) throw new Error('group refused')
  const blockId = grouped.blockId
  const a = (refAngleDeg * Math.PI) / 180
  const lref = line('lref', 0, 0, 20 * Math.cos(a), 20 * Math.sin(a))
  const base: Sketch = {
    ...grouped.sketch,
    entities: [...grouped.sketch.entities, lref],
    constraints: [
      ...grouped.sketch.constraints,
      { id: 'fixblk', kind: 'fix', entityId: blockId }, // pins the origin (2 DoF)
      { id: 'fixref', kind: 'fix', entityId: 'lref' },  // pins the reference line fully
    ],
  }
  return { base, blockId }
}

/** Directed angle (rad) of a block's solved orientation, from +X. */
function blockDir(block: SketchBlockEntity): number {
  return block.rotation
}
/** Smallest absolute difference between two angles, mod PI (direction, ignoring
 *  the 180deg flip a line has). */
function angleDiffModPi(a: number, b: number): number {
  let d = (a - b) % Math.PI
  if (d > Math.PI / 2) d -= Math.PI
  if (d < -Math.PI / 2) d += Math.PI
  return Math.abs(d)
}

async function solve(sk: Sketch) {
  const gcs = await createGcsWrapper()
  try {
    return solveSketchOnWrapper(gcs, sk)
  } finally {
    gcs.destroy_gcs_module()
  }
}

// ---- (i) angle dimension drives rotation -----------------------------------

describe('SKC-ROTATION-SOLVABLE: angle dimension drives a block rotation', () => {
  it('a DRIVING angle dim between the block and a fixed line makes the solver own the rotation (dof 0)', async () => {
    const { base, blockId } = blockWithRefLine(0) // reference line along +X
    // Directed angle from the block orientation (l1) to the reference line (l2).
    // Pick a target of -35deg: with lref at 0deg this drives the block to ~35deg.
    const value = (-35 * Math.PI) / 180
    const dim: SketchDimension = { id: 'ang', kind: 'angle', a: blockId, b: 'lref', value, driving: true }
    const out = await solve({ ...base, dimensions: [dim] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.dof).toBe(0)               // origin(2) + angle(1) all consumed
    expect(out.status.conflicting).toEqual([])
    const block = out.entities.find((e): e is SketchBlockEntity => e.kind === 'block')!
    // The solver drove the block's stored rotation to satisfy the dimension:
    // directed(orient -> lref) = value, lref is at 0, so orient dir = -value.
    expect(angleDiffModPi(blockDir(block), -value)).toBeLessThan(1e-4)
  })

  it('re-solving with a DIFFERENT driving angle value re-drives the rotation (solver, not the typed field, owns it)', async () => {
    const { base, blockId } = blockWithRefLine(0)
    const mk = (deg: number): SketchDimension =>
      ({ id: 'ang', kind: 'angle', a: blockId, b: 'lref', value: (deg * Math.PI) / 180, driving: true })
    const out10 = await solve({ ...base, dimensions: [mk(-10)] })
    const out70 = await solve({ ...base, dimensions: [mk(-70)] })
    expect(out10.ok && out70.ok).toBe(true)
    if (!out10.ok || !out70.ok) return
    const r10 = (out10.entities.find((e): e is SketchBlockEntity => e.kind === 'block')!).rotation
    const r70 = (out70.entities.find((e): e is SketchBlockEntity => e.kind === 'block')!).rotation
    expect(angleDiffModPi(r10, (10 * Math.PI) / 180)).toBeLessThan(1e-4)
    expect(angleDiffModPi(r70, (70 * Math.PI) / 180)).toBeLessThan(1e-4)
  })
})

// ---- (ii) parallel / horizontal drive rotation -----------------------------

describe('SKC-ROTATION-SOLVABLE: constraints drive a block rotation', () => {
  it('PARALLEL to a fixed 40deg line aligns the block orientation to 40deg (dof 0)', async () => {
    const { base, blockId } = blockWithRefLine(40)
    const c: SketchConstraint = { id: 'par', kind: 'parallel', a: blockId, b: 'lref' }
    const out = await solve({ ...base, constraints: [...base.constraints, c] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.dof).toBe(0)
    const block = out.entities.find((e): e is SketchBlockEntity => e.kind === 'block')!
    expect(angleDiffModPi(block.rotation, (40 * Math.PI) / 180)).toBeLessThan(1e-4)
  })

  it('HORIZONTAL on the block orientation pins its rotation to 0/180 (dof 0)', async () => {
    const { base, blockId } = blockWithRefLine(0)
    // Seed the block off-axis so the constraint has to move it.
    const seeded = base.entities.map((e) =>
      e.id === blockId ? { ...(e as SketchBlockEntity), rotation: (25 * Math.PI) / 180 } : e)
    const c: SketchConstraint = { id: 'hor', kind: 'horizontal', line: blockId }
    const out = await solve({ ...base, entities: seeded, constraints: [...base.constraints, c] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.dof).toBe(0)
    const block = out.entities.find((e): e is SketchBlockEntity => e.kind === 'block')!
    expect(angleDiffModPi(block.rotation, 0)).toBeLessThan(1e-4)
  })
})

// ---- (iii) rotation is a real, constrainable DoF ---------------------------

describe('SKC-ROTATION-SOLVABLE: rotation is a real constrainable DoF', () => {
  it('a REFERENCE-only angle dim leaves the rotation FREE (dof 1); making it DRIVING consumes it (dof 0)', async () => {
    const { base, blockId } = blockWithRefLine(0)
    const refDim: SketchDimension = { id: 'ang', kind: 'angle', a: blockId, b: 'lref', value: 0, driving: false }
    const outRef = await solve({ ...base, dimensions: [refDim] })
    expect(outRef.ok).toBe(true)
    if (!outRef.ok) return
    // Origin pinned (2 DoF gone); the refpoint materializes for measurement but
    // the ANGLE is unconstrained -> exactly one free rotational DoF remains.
    expect(outRef.status.dof).toBe(1)

    const drivingDim: SketchDimension = { ...refDim, value: (-20 * Math.PI) / 180, driving: true }
    const outDrive = await solve({ ...base, dimensions: [drivingDim] })
    expect(outDrive.ok).toBe(true)
    if (!outDrive.ok) return
    expect(outDrive.status.dof).toBe(0)
  })
})

// ---- (iv) over-constraint refuses by name ----------------------------------

describe('SKC-ROTATION-SOLVABLE: conflicting angle constraints refuse by name', () => {
  it('two DRIVING angle dims fixing the rotation to different values report a conflict (never a silent wrong angle)', async () => {
    const { base, blockId } = blockWithRefLine(0)
    const d1: SketchDimension = { id: 'ang1', kind: 'angle', a: blockId, b: 'lref', value: (-30 * Math.PI) / 180, driving: true }
    const d2: SketchDimension = { id: 'ang2', kind: 'angle', a: blockId, b: 'lref', value: (-60 * Math.PI) / 180, driving: true }
    const out = await solve({ ...base, dimensions: [d1, d2] })
    // Either a typed conflicting failure, or a solved-but-flagged conflicting set:
    // in both cases the conflicting angle dims must be NAMED, never silently one-wins.
    const conflicting = out.status.conflicting ?? []
    expect(conflicting.length).toBeGreaterThan(0)
    expect(conflicting.some((id) => id === 'ang1' || id === 'ang2')).toBe(true)
  })
})

// ---- (v) definedness coloring ----------------------------------------------

describe('SKC-ROTATION-SOLVABLE: definedness follows the solved angle', () => {
  it('an angle-DRIVEN block reads FULLY DEFINED; a rotation-FREE block does not', async () => {
    const { base, blockId } = blockWithRefLine(0)
    const driven: SketchDimension = { id: 'ang', kind: 'angle', a: blockId, b: 'lref', value: (-15 * Math.PI) / 180, driving: true }
    const outDriven = await solve({ ...base, dimensions: [driven] })
    expect(outDriven.ok).toBe(true)
    if (!outDriven.ok) return
    expect(outDriven.status.fullyDefinedEntities ?? []).toContain(blockId)

    const free: SketchDimension = { ...driven, driving: false }
    const outFree = await solve({ ...base, dimensions: [free] })
    expect(outFree.ok).toBe(true)
    if (!outFree.ok) return
    expect(outFree.status.fullyDefinedEntities ?? []).not.toContain(blockId)
  })
})

// ---- (vi) no regression: an un-referenced block stays 2 DoF ----------------

describe('SKC-ROTATION-SOLVABLE: an un-referenced block is byte-identically 2 DoF', () => {
  it('a grouped block with NO orientation reference contributes exactly 2 DoF (no refpoint materialized)', async () => {
    const grouped = groupIntoBlock(mkSketch(rectEntities(), rectConstraints()), ['l1', 'l2', 'l3', 'l4'], detId)
    expect(grouped.ok).toBe(true)
    if (!grouped.ok) return
    const out = await solve(grouped.sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.dof).toBe(2) // origin only; rotation stays typed-inert
    expect(out.status.conflicting).toEqual([])
  })
})
