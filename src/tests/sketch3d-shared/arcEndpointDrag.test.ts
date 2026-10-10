// WO SKC-12 (5b/5c): the mutation-proof regression for the exact bug documented in
// docs/3d/SKETCH-CONVERGENCE-PLAN.md Section 2 -- SolidsWorkbenchPage.tsx's old private
// `withPointAt` silently flipped a major arc's sweep on a ZERO-DISTANCE end-site drag (a raw
// Math.atan2 overwrite losing the out-of-range major-arc encoding) and relocated the far endpoint
// on a start-site drag (an independent radius-recompute bug). Both are gone now that
// sketch3d-shared/draftEntities.ts's withPointAt/withArcPointAt is the ONE place this math lives,
// reused by both draw and drag via canonicalArcFromThreePoints. This test drives that SAME shared
// primitive SolidsWorkbenchPage.tsx now imports (not a page-level re-derivation), per this WO's
// "mutation-proof fails-if" rule: break the fix, watch this fail, revert, record.
import { describe, expect, it } from 'vitest'
import { makeArcEntity, withPointAt } from '../../components/sketch3d-shared/draftEntities'
import { pointPositionOf } from '../../components/sketch3d-shared/picking'
import type { Sketch3dArcEntity } from '../../sketch3d'

const TWO_PI = Math.PI * 2

function sweepDeg(arc: Pick<Sketch3dArcEntity, 'startAngle' | 'endAngle'>): number {
  return ((((arc.endAngle - arc.startAngle) % TWO_PI) + TWO_PI) % TWO_PI) * (180 / Math.PI)
}

function sweptMidpoint(arc: Sketch3dArcEntity): { x: number; y: number } {
  const sweep = ((((arc.endAngle - arc.startAngle) % TWO_PI) + TWO_PI) % TWO_PI)
  const mid = arc.startAngle + sweep / 2
  return { x: arc.center.x + arc.radius * Math.cos(mid), y: arc.center.y + arc.radius * Math.sin(mid) }
}

// Same construction as regions.test.ts's "SKC-8-R1 Blocker 3" fixture: start=0deg, end=90deg on a
// r=10 circle at the origin, through=200deg forces the MAJOR (270deg) arc.
function buildMajorArc(): Sketch3dArcEntity {
  const start = { x: 10, y: 0 }
  const end = { x: 0, y: 10 }
  const through = { x: 10 * Math.cos((200 * Math.PI) / 180), y: 10 * Math.sin((200 * Math.PI) / 180) }
  return makeArcEntity('majorArc', start, end, through)
}

describe('SKC-12 5b: major-arc endpoint drag stays major', () => {
  it('zero-distance end-site drag reproduces the identical arc (the plan doc\'s exact measured bug)', () => {
    const arc = buildMajorArc()
    expect(sweepDeg(arc)).toBeCloseTo(270, 6)
    const beforeMid = sweptMidpoint(arc)
    const beforeFar = pointPositionOf(arc, 'start')

    const currentEnd = pointPositionOf(arc, 'end')
    const next = withPointAt(arc, 'end', currentEnd) as Sketch3dArcEntity

    // FAILS-IF: a Math.atan2 principal-value overwrite flips this to the complementary ~90deg arc
    // (the plan doc's measured "-270deg -> +90deg" jump).
    expect(sweepDeg(next)).toBeCloseTo(270, 6)
    const afterMid = sweptMidpoint(next)
    expect(afterMid.x).toBeCloseTo(beforeMid.x, 6)
    expect(afterMid.y).toBeCloseTo(beforeMid.y, 6)
    // The far (start) endpoint never moved either.
    const afterFar = pointPositionOf(next, 'start')
    expect(afterFar.x).toBeCloseTo(beforeFar.x, 9)
    expect(afterFar.y).toBeCloseTo(beforeFar.y, 9)
  })

  it('a real (small, non-flipping) end-site drag preserves majorness -- sweep and midpoint side', () => {
    const arc = buildMajorArc()
    const currentEnd = pointPositionOf(arc, 'end')
    // A modest nudge along the tangent direction at the end site -- large enough to be a genuine
    // drag, small enough not to cross the 180/360deg ambiguity boundary.
    const nudged = { x: currentEnd.x - 0.6, y: currentEnd.y + 0.4 }
    const next = withPointAt(arc, 'end', nudged) as Sketch3dArcEntity

    expect(sweepDeg(next)).toBeGreaterThan(180)
    // Continuity: the sweep should be close to (not equal to, since the endpoint genuinely moved)
    // the original 270deg -- a flip to the complementary arc would land near 90deg instead.
    expect(sweepDeg(next)).toBeGreaterThan(240)
    // The dragged site really did move to the requested position.
    const draggedEnd = pointPositionOf(next, 'end')
    expect(draggedEnd.x).toBeCloseTo(nudged.x, 9)
    expect(draggedEnd.y).toBeCloseTo(nudged.y, 9)
  })
})

describe('SKC-12 5c: start-site drag preserves the far (end-site) endpoint', () => {
  it('dragging the start site by a real delta leaves the end site\'s Cartesian position untouched', () => {
    const arc = buildMajorArc()
    const beforeFar = pointPositionOf(arc, 'end')

    const currentStart = pointPositionOf(arc, 'start')
    const dragged = { x: currentStart.x + 1.5, y: currentStart.y - 0.8 }
    const next = withPointAt(arc, 'start', dragged) as Sketch3dArcEntity

    // FAILS-IF: a radius recompute (the old withPointAt's start-site branch) silently relocates
    // the far endpoint because the shared circle's radius changed under it.
    const afterFar = pointPositionOf(next, 'end')
    expect(afterFar.x).toBeCloseTo(beforeFar.x, 9)
    expect(afterFar.y).toBeCloseTo(beforeFar.y, 9)

    // The dragged site really did move to the requested position.
    const afterStart = pointPositionOf(next, 'start')
    expect(afterStart.x).toBeCloseTo(dragged.x, 9)
    expect(afterStart.y).toBeCloseTo(dragged.y, 9)
  })

  it('zero-distance start-site drag reproduces the identical arc', () => {
    const arc = buildMajorArc()
    const currentStart = pointPositionOf(arc, 'start')
    const next = withPointAt(arc, 'start', currentStart) as Sketch3dArcEntity
    expect(next.center.x).toBeCloseTo(arc.center.x, 6)
    expect(next.center.y).toBeCloseTo(arc.center.y, 6)
    expect(next.radius).toBeCloseTo(arc.radius, 6)
    expect(sweepDeg(next)).toBeCloseTo(sweepDeg(arc), 6)
  })
})
