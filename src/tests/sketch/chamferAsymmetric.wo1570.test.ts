// WO-1570: chamfer with two distances, or a distance and an angle.
//
// chamferLinesTwoDistance and chamferLinesDistanceAngle sit beside
// chamferLines (chamferTool.ts's own comment names where they slot in).
// Mode/d2/angle/swap ride on each staged ChamferCornerPick so
// chamferChainPreview / chamferApplyAll dispatch per corner without a new
// store scalar. Fixture: a 50x30 rectangle corner at (50,0) — A runs
// (0,0)->(50,0) (the first-picked leg), B runs (50,0)->(50,30).

import { describe, it, expect } from 'vitest'
import {
  chamferLines, chamferLinesTwoDistance, chamferLinesDistanceAngle,
  chamferClick, chamferChainPreview, chamferApplyAll,
  chamferSetMode, chamferSetD2, chamferSetAngleDeg, chamferToggleSwap,
  type ChamferChainState, type ChamferCornerPick,
} from '../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type { Sketch, SketchEntity, SketchConstraint, SketchLineEntity } from '../../lib/sketch/types'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'

let n = 0
const newId = () => `w-${n++}`

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function doc(entities: SketchEntity[], constraints: SketchConstraint[] = []): SketchDoc {
  return { entities, constraints, dimensions: [] }
}

// 50x30 rectangle corner at (50,0): A = (0,0)->(50,0), B = (50,0)->(50,30).
const corner: SketchConstraint = {
  id: 'c-corner', kind: 'coincident',
  a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
}
const rect = () => doc([line('A', 0, 0, 50, 0), line('B', 50, 0, 50, 30)], [corner])

describe('chamferLinesTwoDistance (WO-1570)', () => {
  it('shortens the first-picked leg by d1 and the second by d2', () => {
    const r = chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 5, newId)
    if (typeof r === 'string') throw new Error(r)
    const a = r.transform.entities.find((e) => e.id === 'A') as SketchLineEntity
    const b = r.transform.entities.find((e) => e.id === 'B') as SketchLineEntity
    const ch = r.transform.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    expect(a.end).toEqual({ x: 40, y: 0 })   // trimmed back 10mm from (50,0)
    expect(b.start).toEqual({ x: 50, y: 5 }) // trimmed back 5mm from (50,0)
    expect(ch.start).toEqual({ x: 40, y: 0 })
    expect(ch.end).toEqual({ x: 50, y: 5 })
  })

  it('swap (bId/aId exchanged) flips which leg gets which distance: 5/10', () => {
    const r = chamferLinesTwoDistance(rect(), 'B', 'A', { x: 50, y: 30 }, { x: 0, y: 0 }, 5, 10, newId)
    if (typeof r === 'string') throw new Error(r)
    const a = r.transform.entities.find((e) => e.id === 'A') as SketchLineEntity
    const b = r.transform.entities.find((e) => e.id === 'B') as SketchLineEntity
    expect(b.start).toEqual({ x: 50, y: 5 })
    expect(a.end).toEqual({ x: 40, y: 0 })
  })

  it('creates two DRIVING distance dimensions carrying d1 and d2 exactly', () => {
    const r = chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 5, newId)
    if (typeof r === 'string') throw new Error(r)
    const dims = r.transform.dimensions.filter(
      (d) => d.id === r.setbackDimAId || d.id === r.setbackDimBId)
    expect(dims).toHaveLength(2)
    expect(dims.every((d) => d.kind === 'distance' && d.driving)).toBe(true)
    const values = dims.map((d) => d.value).sort((x, y) => x - y)
    expect(values).toEqual([5, 10])
  })

  it('a d1 larger than its leg is refused, naming the max usable d1', () => {
    const r = chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 60, 5, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit the first leg/)
    expect(r).toContain('50.00')
  })

  it('a d2 larger than its leg is refused, naming the max usable d2', () => {
    const r = chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 40, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit the second leg/)
    expect(r).toContain('30.00')
  })

  it('rejects non-positive d1/d2', () => {
    expect(chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 0, 5, newId))
      .toMatch(/d1 must be positive/)
    expect(chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 5, 0, newId))
      .toMatch(/d2 must be positive/)
  })

  it('equal d1/d2 reproduces the same geometry as chamferLines', () => {
    const equal = chamferLines(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 7, newId)
    const two = chamferLinesTwoDistance(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 7, 7, newId)
    if (typeof equal === 'string' || typeof two === 'string') throw new Error('unexpected reject')
    const chEqual = equal.transform.entities.find((e) => e.id === equal.lineId) as SketchLineEntity
    const chTwo = two.transform.entities.find((e) => e.id === two.lineId) as SketchLineEntity
    expect(chTwo.start).toEqual(chEqual.start)
    expect(chTwo.end).toEqual(chEqual.end)
  })
})

describe('chamferLinesDistanceAngle (WO-1570)', () => {
  it('10mm at 30deg: the chamfer line leaves the first leg 10mm from the corner at 30deg to it', () => {
    const r = chamferLinesDistanceAngle(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 30, newId)
    if (typeof r === 'string') throw new Error(r)
    const ch = r.transform.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    // A's kept direction is +x; the trim point sits at (40,0), 10mm from the corner (50,0).
    expect(ch.start.x).toBeCloseTo(40, 9)
    expect(ch.start.y).toBeCloseTo(0, 9)
    // The chamfer line's own direction makes exactly 30deg with A, measured
    // at the trim point between the leg (toward the corner) and the chamfer
    // (shop-drawing convention -- see chamferTool.ts's own comment).
    const chamferDir = { x: ch.end.x - ch.start.x, y: ch.end.y - ch.start.y }
    const legTowardCorner = { x: 1, y: 0 } // A's trim point -> corner (50,0)
    const len = Math.hypot(chamferDir.x, chamferDir.y)
    const cos = (chamferDir.x * legTowardCorner.x + chamferDir.y * legTowardCorner.y) / len
    expect(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toBeCloseTo(30, 6)
    // The far end lands on B's infinite line (x=50), within B's 30mm leg.
    expect(ch.end.x).toBeCloseTo(50, 6)
    expect(ch.end.y).toBeGreaterThan(0)
    expect(ch.end.y).toBeLessThan(30)
  })

  it('creates ONE distance dimension and ONE angle dimension (not two distances)', () => {
    const r = chamferLinesDistanceAngle(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 30, newId)
    if (typeof r === 'string') throw new Error(r)
    const dimA = r.transform.dimensions.find((d) => d.id === r.setbackDimAId)
    const dimB = r.transform.dimensions.find((d) => d.id === r.setbackDimBId)
    expect(dimA?.kind).toBe('distance')
    expect(dimA?.value).toBe(10)
    expect(dimB?.kind).toBe('angle')
    expect(dimB && dimB.driving).toBe(true)
  })

  it('rejects a distance that does not fit the first leg, naming the max', () => {
    const r = chamferLinesDistanceAngle(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 60, 30, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit the first leg/)
    expect(r).toContain('50.00')
  })

  it('rejects an angle outside (0, 180)', () => {
    expect(chamferLinesDistanceAngle(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 0, newId))
      .toMatch(/angle must be between/)
    expect(chamferLinesDistanceAngle(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 10, 180, newId))
      .toMatch(/angle must be between/)
  })

  it('an angle whose intersection overshoots the second leg is refused, naming a usable distance', () => {
    // A steep angle close to the corner's own opening pushes the far
    // intersection well past B's 30mm leg for a large first-leg distance.
    const r = chamferLinesDistanceAngle(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 45, 85, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit the second leg/)
  })
})

describe('chamfer mode/swap edits on a staged batch (WO-1570)', () => {
  const chainOf = (pick: Partial<ChamferCornerPick> = {}): ChamferChainState => ({
    kind: 'chamfer',
    corners: [{
      aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 50, y: 30 }, at: { x: 50, y: 0 },
      ...pick,
    }],
    pendingLineId: null, pendingClick: null,
  })

  it('chamferSetMode/D2/AngleDeg/ToggleSwap write onto every staged corner', () => {
    const chain = chainOf()
    const withMode = chamferSetMode(chain, 'two-distance')
    expect(withMode.corners[0].mode).toBe('two-distance')
    const withD2 = chamferSetD2(withMode, 5)
    expect(withD2.corners[0].d2).toBe(5)
    const withAngle = chamferSetAngleDeg(chainOf(), 30)
    expect(withAngle.corners[0].angleDeg).toBe(30)
    const swapped = chamferToggleSwap(chainOf())
    expect(swapped.corners[0].swapped).toBe(true)
    expect(chamferToggleSwap(swapped).corners[0].swapped).toBe(false)
  })

  it('chamferChainPreview dispatches two-distance mode per staged corner', () => {
    const chain = chamferSetD2(chamferSetMode(chainOf(), 'two-distance'), 5)
    const pv = chamferChainPreview(chain, rect(), 10) // setback param is d1
    expect(pv.fits).toBe(1)
    expect(pv.misfits).toBe(0)
    expect(pv.lines[0][0]).toEqual({ x: 40, y: 0 })
    expect(pv.lines[0][1]).toEqual({ x: 50, y: 5 })
  })

  it('chamferChainPreview dispatches distance-angle mode per staged corner', () => {
    const chain = chamferSetAngleDeg(chamferSetMode(chainOf(), 'distance-angle'), 30)
    const pv = chamferChainPreview(chain, rect(), 10)
    expect(pv.fits).toBe(1)
    expect(pv.lines[0][0].x).toBeCloseTo(40, 9)
    expect(pv.lines[0][0].y).toBeCloseTo(0, 9)
  })

  it('chamferChainPreview dispatches swap: 10/5 becomes 5/10 without re-picking', () => {
    const base = chamferSetD2(chamferSetMode(chainOf(), 'two-distance'), 5)
    const swapped = chamferToggleSwap(base)
    const pv = chamferChainPreview(swapped, rect(), 10)
    expect(pv.fits).toBe(1)
    // Swapped: B (now "first") gets d1=10 -> (50,10); A (now "second") gets d2=5 -> (45,0).
    const pts = pv.lines[0].map((p) => `${p.x},${p.y}`).sort()
    expect(pts).toEqual(['45,0', '50,10'])
  })

  it('chamferApplyAll (the confirm-overlay Apply path) respects per-corner mode/d2/swap', () => {
    const chain = chamferSetD2(chamferSetMode(chainOf(), 'two-distance'), 5)
    const r = chamferApplyAll(rect(), chain.corners, 10, newId)
    expect(r.applied).toBe(1)
    expect(r.skipped).toHaveLength(0)
    const a = r.transform!.entities.find((e) => e.id === 'A') as SketchLineEntity
    const b = r.transform!.entities.find((e) => e.id === 'B') as SketchLineEntity
    expect(a.end).toEqual({ x: 40, y: 0 })
    expect(b.start).toEqual({ x: 50, y: 5 })
  })

  it('chamferApplyAll dispatches distance-angle mode and commits a chamfer through the second leg', () => {
    const chain = chamferSetAngleDeg(chamferSetMode(chainOf(), 'distance-angle'), 30)
    const r = chamferApplyAll(rect(), chain.corners, 10, newId)
    expect(r.applied).toBe(1)
    const ch = r.transform!.entities.find(
      (e) => e.kind === 'line' && e.id !== 'A' && e.id !== 'B') as SketchLineEntity
    expect(ch.start.x).toBeCloseTo(40, 9)
    expect(ch.end.x).toBeCloseTo(50, 6)
  })

  it('an equal-distance corner (mode unset) still applies byte-identically to chamferLines directly', () => {
    const chain = chainOf() // no mode set -> defaults to equal
    const r = chamferApplyAll(rect(), chain.corners, 8, newId)
    const direct = chamferLines(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 8, newId)
    if (typeof direct === 'string') throw new Error(direct)
    const ch = r.transform!.entities.find(
      (e) => e.kind === 'line' && e.id !== 'A' && e.id !== 'B') as SketchLineEntity
    const directLine = direct.transform.entities.find((e) => e.id === direct.lineId) as SketchLineEntity
    expect(ch.start).toEqual(directLine.start)
    expect(ch.end).toEqual(directLine.end)
  })
})

describe('chamferClick mode inheritance across a chained batch (WO-1570)', () => {
  it('a second corner picked mid-batch inherits the first corner\'s mode/d2/angle/swap', () => {
    // Two independent corners so the second pick is a FRESH corner, not a
    // re-toggle of the first (samePair would otherwise remove it).
    const d = doc([
      line('A', 0, 0, 50, 0), line('B', 50, 0, 50, 30),
      line('C', 100, 0, 150, 0), line('D', 150, 0, 150, 30),
    ], [
      corner,
      { id: 'c-corner-2', kind: 'coincident', a: { entityId: 'C', site: 'end' }, b: { entityId: 'D', site: 'start' } },
    ])
    const first = chamferClick(null, d, { x: 50, y: 0 }, 0.5)
    expect(first.chain?.corners).toHaveLength(1)
    const staged = chamferSetD2(chamferSetMode(first.chain!, 'two-distance'), 5)
    const second = chamferClick(staged, d, { x: 150, y: 0 }, 0.5)
    expect(second.chain?.corners).toHaveLength(2)
    for (const c of second.chain!.corners) {
      expect(c.mode).toBe('two-distance')
      expect(c.d2).toBe(5)
    }
  })
})

describe('every existing equal-distance chamfer keeps working (WO-1570 non-regression)', () => {
  it('chamferLines with no mode info is unaffected by the refactor', () => {
    const r = chamferLines(rect(), 'A', 'B', { x: 0, y: 0 }, { x: 50, y: 30 }, 6, newId)
    if (typeof r === 'string') throw new Error(r)
    const ch = r.transform.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    expect(ch.start).toEqual({ x: 44, y: 0 })
    expect(ch.end).toEqual({ x: 50, y: 6 })
    const dims = r.transform.dimensions.filter(
      (dd) => dd.id === r.setbackDimAId || dd.id === r.setbackDimBId)
    expect(dims.every((dd) => dd.kind === 'distance' && dd.value === 6)).toBe(true)
  })
})

// WO-1570 AUDIT FIX (attempt 1 FAIL): the distance-angle chamfer's angle
// dimension is created with operands (host leg A -> the new chamfer line)
// and no reverseB, so gcsMapping's 'angle' case consumes its `value` as the
// SIGNED directed angle l2l_angle_ll constrains (atan2(cross, dot) from A's
// start->end to the chamfer line's start->end -- dimTool.lineAngle's own
// convention, the same one skc58AngleDimNoMotion.test.ts pins for the
// smart-dimension tool). The FAILED attempt stored an UNSIGNED acos
// magnitude instead, which only happens to match the directed angle for ONE
// of the two draw directions of the first-picked host leg -- for the other
// direction the driving dimension is self-contradicted at commit time and
// the very next solve drags the just-built chamfer off its leg (SKC-58B
// no-motion class). This drives the REAL planegcs solver on both draw
// directions of the host leg -- the mirrored fixture the audit named --
// against the document `chamferLinesDistanceAngle` itself builds (no extra
// `fix` constraints beyond what the tool commits), so a self-contradicted
// driving angle shows up as real motion, exactly as the audit's repro found.
describe('distance-angle chamfer angle dimension is solver-consistent (WO-1570 audit FAIL fix)', () => {
  /** planegcs l2l_angle convention (dimTool.lineAngle / l2l_angle_ll): the
   *  signed directed angle from l1's start->end to l2's start->end. */
  function directedAngle(l1: SketchLineEntity, l2: SketchLineEntity): number {
    const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
    const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
  }

  /** Corner at the origin: leg A drawn either INTO the corner ((50,0)->(0,0))
   *  or AWAY from it ((0,0)->(50,0)) -- the two draw directions the audit
   *  found split the old acos-based value into "matches" / "self-contradicts".
   *  Leg B always runs (0,0)->(0,30). d=10 at 30deg reproduces the audit's
   *  own numbers (TA=(10,0), TB=(0, 5.7735...)). */
  async function buildAndSolve(aDrawnIntoCorner: boolean) {
    const entities: SketchEntity[] = aDrawnIntoCorner
      ? [line('A', 50, 0, 0, 0), line('B', 0, 0, 0, 30)]
      : [line('A', 0, 0, 50, 0), line('B', 0, 0, 0, 30)]
    const r = chamferLinesDistanceAngle(doc(entities), 'A', 'B', { x: 10, y: 0 }, { x: 0, y: 10 }, 10, 30, newId)
    if (typeof r === 'string') throw new Error(r)

    const angleDim = r.transform.dimensions.find((d) => d.id === r.setbackDimBId)
    if (!angleDim || angleDim.kind !== 'angle') throw new Error('expected an angle dimension')
    const hostA = r.transform.entities.find((e) => e.id === 'A') as SketchLineEntity
    const chamferLine = r.transform.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    // The committed value must be EXACTLY the directed angle the solver's
    // near-sector l2l_angle_ll will constrain (no reverseB on this dim) --
    // the audit's actual falsified claim.
    expect(angleDim.value).toBeCloseTo(directedAngle(hostA, chamferLine), 9)

    // Leg B's KEPT side runs toward its end (0,30) -- trimSide resolves
    // movedSite='start' for hintB=(0,10) here, so B.start IS the trim point
    // TB the audit found dragged off the leg; B.end carries no constraint at
    // all in this minimal document and is not a meaningful probe.
    const before = r.transform.entities.find(
      (e): e is SketchLineEntity => e.id === 'B' && e.kind === 'line')!
    const sketch: Sketch = {
      id: 'sk', layerId: 'layer',
      entities: r.transform.entities, constraints: r.transform.constraints,
      dimensions: r.transform.dimensions, solveStatus: null,
    }
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('solve failed')
    const after = out.entities.find((e): e is SketchLineEntity => e.id === 'B' && e.kind === 'line')!
    return Math.hypot(after.start.x - before.start.x, after.start.y - before.start.y)
  }

  it('leg A drawn INTO the corner (the audit repro): committing the angle dim does NOT drag the chamfer off leg B', async () => {
    const moved = await buildAndSolve(true)
    expect(moved).toBeLessThan(1e-6)
  })

  it('leg A drawn AWAY from the corner (winding-matched control): still no motion', async () => {
    const moved = await buildAndSolve(false)
    expect(moved).toBeLessThan(1e-6)
  })
})
