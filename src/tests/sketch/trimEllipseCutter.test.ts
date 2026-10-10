// SKC-53 regression gate: trimming a line/arc/circle against an ELLIPSE or
// ELLIPTICAL-ARC cutter used to break the sketch solve (Operator's N-29 note:
// "Fails to solve a trim to ellipse" -- CAM workspace, one ellipse plus a
// vertical line crossing its left end, Trim armed, click the LINE span ->
// red "Solve failed" badge).
//
// ROOT CAUSE (file:line as of 045044fa23d6a1613c9ba5b504b362e16114c090, the
// commit this WO's contract was cut from): collectCuts (trimTool.ts:
// 198-210) accepts ANY non-construction entity as a cutter, including
// ellipse/elliptical-arc -- entityIntersections (snap.ts:402-412) happily
// computes real line/arc/circle-vs-ellipse crossings. planLineTrim
// (:352-392), planArcTrim (:394-431) and planCircleTrim (:433-467) all push
// `cutPoints` carrying `object: cutterId` with NO guard on the cutter's
// kind. trimEntityAt's final loop (pre-fix :939-942) converted EVERY
// cutPoint into a `point_on_object` constraint unconditionally. But
// gcsMapping.ts's `point_on_object` case (:300-301) calls
// `expectKind(index, c.object, ['line', 'circle', 'arc'], where)`, which
// THROWS a SketchMappingError when `c.object` is an ellipse or
// elliptical-arc -- planegcs has no point-on-curve primitive for either
// (the file's own SOLVER-INERT doctrine at gcsMapping.ts:119-122 covers the
// ellipse-AS-TARGET case; the ellipse-AS-CUTTER path was left unguarded).
// solveSystem (gcsMapping.ts:1018-1043) caught that throw and returned
// `{ ok: false, status: { solveFailed: true, ... } }` -- Operator's red badge.
//
// FIX (trimTool.ts fixPointConstraint + trimEntityAt's cutPoints loop):
// a single choke point in trimEntityAt now checks the CUTTER's kind before
// choosing the constraint. line/circle/arc cutters still get the original
// point_on_object (unchanged). ellipse/elliptical-arc cutters get a `fix`
// constraint on the cut point instead -- ANTI-SILENT-DROP: this is a named,
// pinned substitute policy (not a bare skip), it is surfaced through
// TrimOutcome.notice ("cutter is solver-inert..."), and it references only
// the cut point's OWN entity (never a deleted id). One choke point covers
// every target kind (line/arc/circle) and both dispatch legs (click +
// swipe -- toolMachine.ts:619 and sketcher/toolController.ts:876/885 both
// funnel into the same trimEntityAt) without touching each planner.
//
// Every claim below is proved through a REAL planegcs solve
// (solveSketchOnWrapper against a live wrapper -- no browser needed to
// prove the solve-status claim programmatically), for every target kind
// the trim tool supports, plus the negative controls that must stay green.
//
// UNDO-AFTER-FAIL: pre-fix, trimAtPoint/trimSwipe still returned a
// non-null transform (the geometry mutation itself succeeded; only the
// FOLLOWING solve failed). The trim was therefore already exactly ONE undo
// step, per this module's own "the store applies them as one undo step"
// contract (header comment at the top of trimTool.ts) -- no additional
// store-level undo-stack change was needed (store/index.ts is outside this
// WO's ownership manifest).

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { trimAtPoint, trimSwipe, type SketchDoc } from '../../lib/sketch/tools/trimTool'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, SketchLineEntity,
  SketchArcEntity, SketchEllipseEntity, SketchEllipticalArcEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `new-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number, construction = false,
): SketchLineEntity {
  return { id, kind: 'line', construction, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

// center (0,0), majorRadius 10, minorRadius 5, rotation 0 -- same shape as
// the existing ellipse-target fixture in trimTool.test.ts.
function bigEllipse(id: string, construction = false): SketchEllipseEntity {
  return {
    id, kind: 'ellipse', construction,
    center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
  }
}

function doc(
  entities: SketchEntity[], constraints: SketchConstraint[] = [], dimensions: SketchDimension[] = [],
): SketchDoc {
  return { entities, constraints, dimensions }
}

function assertNoDangling(d: { entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[] }) {
  const live = new Set(d.entities.map((e) => e.id))
  for (const c of d.constraints) {
    for (const ref of constraintRefIds(c)) expect(live.has(ref), `constraint ${c.id} dangles on ${ref}`).toBe(true)
  }
  for (const dim of d.dimensions) {
    for (const ref of dimensionRefIds(dim)) expect(live.has(ref), `dimension ${dim.id} dangles on ${ref}`).toBe(true)
  }
}

/** Assert the ANTI-SILENT-DROP substitute policy: no point_on_object
 *  against a solver-inert cutter, a `fix` constraint on each cut point
 *  instead (referencing a LIVE entity, never the cutter), and the notice
 *  channel names the downgrade. */
function assertSolverInertCutPolicy(
  t: { entities: SketchEntity[]; constraints: SketchConstraint[] },
  notice: string | null,
  expectedFixCount: number,
) {
  expect(t.constraints.filter((c) => c.kind === 'point_on_object')).toHaveLength(0)
  const fixes = t.constraints.filter((c): c is Extract<SketchConstraint, { kind: 'fix' }> => c.kind === 'fix' && !!c.point)
  expect(fixes).toHaveLength(expectedFixCount)
  const liveIds = new Set(t.entities.map((e) => e.id))
  for (const c of fixes) expect(liveIds.has(c.point!.entityId)).toBe(true)
  expect(notice).toContain('cutter is solver-inert')
}

/** Run the trimmed document through a REAL planegcs solve (no browser) --
 *  this is what proves/disproves the "Solve failed" badge programmatically. */
async function solve(t: { entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[] }) {
  const gcs = await createGcsWrapper()
  const sketch: Sketch = {
    id: 'sk', layerId: 'L', entities: t.entities, constraints: t.constraints, dimensions: t.dimensions,
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
  const out = solveSketchOnWrapper(gcs, sketch)
  gcs.destroy_gcs_module()
  return out
}

describe('SKC-53 fix -- ellipse/elliptical-arc CUTTER no longer breaks the solve (Operator N-29)', () => {
  it("Operator's exact scene: ellipse + vertical line crossing its left end, trim the LINE span", async () => {
    // Vertical cutter x=-6 crosses the ellipse (a=10,b=5) at (-6, +/-4).
    const d = doc([bigEllipse('E'), line('L', -6, -20, -6, 20)])
    const r = trimAtPoint(d, { x: -6, y: 0 }, 0.5, newId)
    expect(r.transform).not.toBeNull() // undo-after-fail: the mutation still lands as one step
    const t = r.transform!
    assertSolverInertCutPolicy(t, r.notice, 2) // two line pieces, each cut against the ellipse
    assertNoDangling(t)

    const out = await solve(t)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
    // Trimmed correctly: two line pieces, the clicked middle span (y in
    // (-4,4)) is gone -- each surviving piece lies outside it.
    const pieces = out.entities.filter((e): e is SketchLineEntity => e.kind === 'line')
    expect(pieces).toHaveLength(2)
    for (const p of pieces) {
      const lo = Math.min(p.start.y, p.end.y), hi = Math.max(p.start.y, p.end.y)
      expect(lo >= 4 - 1e-6 || hi <= -4 + 1e-6).toBe(true)
    }
  })

  it('one-crossing leg: click the END span beyond the last ellipse crossing (ONE cutPoint)', async () => {
    const d = doc([bigEllipse('E'), line('L', -6, -20, -6, 20)])
    const r = trimAtPoint(d, { x: -6, y: 10 }, 0.5, newId) // beyond the y=4 crossing
    const t = r.transform!
    assertSolverInertCutPolicy(t, r.notice, 1)
    const out = await solve(t)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
  })

  it('arc target vs ellipse cutter (two crossings inside the arc span)', async () => {
    // Upper semicircle r=5. Cutter ellipse (a=8,b=3) crosses the r=5
    // supporting circle at angles ~0.529 and ~2.613 rad, both strictly
    // inside (0, pi).
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    const cutter: SketchEllipseEntity = {
      id: 'E', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 8, minorRadius: 3, rotation: 0,
    }
    const r = trimAtPoint(doc([arc, cutter]), { x: 0, y: 5 }, 0.5, newId)
    const t = r.transform!
    assertSolverInertCutPolicy(t, r.notice, 2)
    const out = await solve(t)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
  })

  it('circle target vs ellipse cutter', async () => {
    // Circle r=5 and ellipse (a=5,b=3), both centered at the origin, meet
    // at exactly (5,0) and (-5,0): x^2+y^2=25 and x^2/25+y^2/9=1 force
    // y^2*(1-25/9) = 0 -> y=0.
    const circle: SketchEntity = {
      id: 'C', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5,
    }
    const cutter: SketchEllipseEntity = {
      id: 'E', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 5, minorRadius: 3, rotation: 0,
    }
    const r = trimAtPoint(doc([circle, cutter]), { x: 0, y: 5 }, 0.5, newId)
    const t = r.transform!
    assertSolverInertCutPolicy(t, r.notice, 2)
    const out = await solve(t)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
  })

  it('elliptical-arc (not a full ellipse) as cutter', async () => {
    const cutter: SketchEllipticalArcEntity = {
      id: 'EA', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0.1, endParam: 2 * Math.PI - 0.1, // covers both +/-4 crossings near x=-6
    }
    const d = doc([cutter, line('L', -6, -20, -6, 20)])
    const r = trimAtPoint(d, { x: -6, y: 0 }, 0.5, newId)
    const t = r.transform!
    assertSolverInertCutPolicy(t, r.notice, 2)
    const out = await solve(t)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
  })

  it('SWIPE trim (drag-swipe dispatch leg) is fixed too', async () => {
    const d = doc([bigEllipse('E'), line('L', -6, -20, -6, 20)])
    // The swipe segment stays well inside the ellipse's own boundary
    // (x in [-8,-4], nowhere near the +/-10 major vertices) so it crosses
    // ONLY the line L, at (-6, 0) -- the same middle span leg 1 clicks.
    const r = trimSwipe(d, [{ x: -8, y: 0 }, { x: -4, y: 0 }], newId)
    expect(r.transform).not.toBeNull()
    const t = r.transform!
    assertSolverInertCutPolicy(t, r.notice, 2)
    const out = await solve(t)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
  })
})

describe('SKC-53 -- negative controls (already correct, must stay correct)', () => {
  it('ellipse AS TARGET vs line cutter solves fine end-to-end (no point_on_object emitted)', async () => {
    const cutVert = line('L', 6, -20, 6, 20)
    const r = trimAtPoint(doc([bigEllipse('E'), cutVert]), { x: 9.5, y: 0 }, 1, newId)
    const t = r.transform!
    expect(t.constraints.filter((c) => c.kind === 'point_on_object')).toHaveLength(0)
    expect(t.constraints.filter((c) => c.kind === 'fix')).toHaveLength(0)
    assertNoDangling(t)
    const out = await solve(t)
    expect(out.ok).toBe(true)
  })

  it('a CONSTRUCTION ellipse is excluded as a cutter -- the crossing line is wholly deleted', async () => {
    const d = doc([bigEllipse('E', true), line('L', -6, -20, -6, 20)])
    const r = trimAtPoint(d, { x: -6, y: 0 }, 0.5, newId)
    const t = r.transform!
    expect(t.entities.some((e) => e.id === 'L')).toBe(false)
    expect(t.entities.some((e) => e.id === 'E')).toBe(true) // the construction ellipse itself is untouched
    assertNoDangling(t)
  })

  it('trim-again: the removed (construction) span from an ellipse trim stays excluded as a cutter', async () => {
    // First trim: ellipse E cut by L1 (x=6), clicking the +x vertex side ->
    // kept big arc (id E, not construction) + the short +x-side span
    // re-emitted as CONSTRUCTION (trimTool.ts :515-518, proven by the
    // existing trimTool.test.ts ellipse-target suite).
    const l1 = line('L1', 6, -20, 6, 20)
    const t1 = trimAtPoint(doc([bigEllipse('E'), l1]), { x: 9.5, y: 0 }, 1, newId).transform!
    // L2 (x=8) crosses the ellipse boundary only where (8/10)^2+(y/5)^2=1,
    // i.e. y=+/-3 -- atan2(3/5, 8/10) ~= 36.87deg, strictly inside the
    // removed span's +/-53.13deg range, so L2 only ever touches the now-
    // CONSTRUCTION remainder, never the kept (still-cuttable) big arc.
    const l2 = line('L2', 8, -20, 8, 20)
    const d2 = doc([...t1.entities, l2], t1.constraints, t1.dimensions)
    const r2 = trimAtPoint(d2, { x: 8, y: 0 }, 0.5, newId)
    const t2 = r2.transform!
    // L2 crossed nothing live (its only nearby boundary is the excluded
    // construction remainder) -> whole-entity delete, same as the plain
    // construction-cutter negative control above.
    expect(t2.entities.some((e) => e.id === 'L2')).toBe(false)
    assertNoDangling(t2)
  })
})
