// Sketch fillet tool (Stage 6 chunk 1): tangent arc inserted at the
// corner of two lines, lines trimmed back to the exact tangency points,
// tangent + coincident constraints on BOTH joints (hard rule: every
// joint location-exact AND 100 percent tangent — verified analytically
// via D1 directions, not finite differences); a radius that does not fit
// is rejected with the computed max usable radius.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  filletLines, filletClick, filletChainPreview, filletApplyAll,
  filletSeedFromSelection, filletMaxUsableRadius, filletChainMaxRadius,
  __filletPreviewComputeCount, __resetFilletChainPreviewMemo,
  reconcileCurveFillets,
  type FilletChainState, type FilletCornerPick,
} from '../../lib/sketch/tools/filletTool'
import { measureDimension, planDimension, dimToolClick } from '../../lib/sketch/tools/dimTool'
import { resolveFilletCornerSite } from '../../lib/sketch/tools/theoreticalCorner'
import { ellipseDerivativeAt, ellipseParamFromPoint } from '../../lib/sketch/ellipse'
import { nearestParamOnSpline, splineDerivativeAt } from '../../lib/sketch/spline'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type {
  Vec2, SketchEntity, SketchConstraint,
  SketchArcEntity, SketchLineEntity, SketchDimension,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `f-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
): SketchEntity {
  return {
    id, kind: 'line', construction: false,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function arc(
  id: string, cx: number, cy: number, radius: number,
  startAngle: number, endAngle: number,
): SketchEntity {
  return {
    id, kind: 'arc', construction: false,
    center: { x: cx, y: cy }, radius, startAngle, endAngle,
  }
}

function circle(id: string, cx: number, cy: number, radius: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius }
}

function doc(
  entities: SketchEntity[], constraints: SketchConstraint[] = [],
): SketchDoc {
  return { entities, constraints, dimensions: [] }
}

/** Arc point at an angle. */
function arcPt(a: SketchArcEntity, angle: number): Vec2 {
  return {
    x: a.center.x + a.radius * Math.cos(angle),
    y: a.center.y + a.radius * Math.sin(angle),
  }
}

/** Analytic D1 direction of a CCW arc at an angle: (-sin, cos). */
function arcD1(angle: number): Vec2 {
  return { x: -Math.sin(angle), y: Math.cos(angle) }
}

function unit(v: Vec2): Vec2 {
  const l = Math.hypot(v.x, v.y)
  return { x: v.x / l, y: v.y / l }
}

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

/** Assert the arc joint at `site` is location-exact on the line endpoint
 *  AND analytically tangent to the line (|cross of D1 directions| ~ 0). */
function assertTangentJoint(
  arc: SketchArcEntity, site: 'start' | 'end', l: SketchLineEntity, lineSite: 'start' | 'end',
) {
  const angle = site === 'start' ? arc.startAngle : arc.endAngle
  const joint = arcPt(arc, angle)
  const lineEnd = lineSite === 'start' ? l.start : l.end
  // 1-for-1 location-exact.
  expect(Math.hypot(joint.x - lineEnd.x, joint.y - lineEnd.y)).toBeLessThan(1e-9)
  // 100 percent tangent: arc D1 parallel to the line direction.
  const lineDir = unit({ x: l.end.x - l.start.x, y: l.end.y - l.start.y })
  expect(Math.abs(cross(arcD1(angle), lineDir))).toBeLessThan(1e-12)
}

describe('filletLines - perpendicular corner, R2', () => {
  // Rectangle-style corner at (10,0): A runs (0,0)->(10,0), B runs
  // (10,0)->(10,10), joined by the corner coincident constraint.
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = () => doc(
    [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    [corner],
  )

  it('inserts a tangent R2 arc and trims both lines to the tangency points', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const t = r.transform
    const a = t.entities.find((e) => e.id === 'A') as SketchLineEntity
    const b = t.entities.find((e) => e.id === 'B') as SketchLineEntity
    const arc = t.entities.find((e) => e.id === r.arcId) as SketchArcEntity
    // 90 deg corner, R2: tangency points 2mm back from the corner.
    expect(a.end.x).toBeCloseTo(8, 9)
    expect(a.end.y).toBeCloseTo(0, 9)
    expect(b.start.x).toBeCloseTo(10, 9)
    expect(b.start.y).toBeCloseTo(2, 9)
    // Center equidistant (R) from both infinite lines: O = (8,2).
    expect(arc.center.x).toBeCloseTo(8, 9)
    expect(arc.center.y).toBeCloseTo(2, 9)
    expect(arc.radius).toBe(2)
    // Sweep = pi - theta = 90 deg.
    const sweep = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    expect(sweep).toBeCloseTo(Math.PI / 2, 9)
    // BOTH joints analytically tangent + location-exact (D1, not
    // finite-diff). Which arc end touches which line comes from the
    // coincident constraints the fillet created.
    const coincs = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincs).toHaveLength(2)
    for (const c of coincs) {
      if (c.kind !== 'coincident') continue
      const arcSite = c.a.site as 'start' | 'end'
      const lineEnt = (c.b.entityId === 'A' ? a : b)
      assertTangentJoint(arc, arcSite, lineEnt, c.b.site as 'start' | 'end')
    }
  })

  it('adds tangent + coincident on both sides and consumes the corner coincident', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const t = r.transform
    // The old corner coincident is gone.
    expect(t.constraints.map((c) => c.id)).not.toContain('c-corner')
    // Two coincidents (arc end <-> line corner site) + two tangents.
    const coincs = t.constraints.filter((c) => c.kind === 'coincident')
    const tangents = t.constraints.filter((c) => c.kind === 'tangent')
    expect(coincs).toHaveLength(2)
    expect(tangents).toHaveLength(2)
    const tangentTargets = tangents
      .map((c) => (c.kind === 'tangent' ? c.b : ''))
      .sort()
    expect(tangentTargets).toEqual(['A', 'B'])
    for (const c of tangents) {
      if (c.kind === 'tangent') expect(c.a).toBe(r.arcId)
    }
    // Coincidents land on the MOVED corner sites: A/end and B/start.
    const lineSites = coincs
      .map((c) => (c.kind === 'coincident' ? `${c.b.entityId}/${c.b.site}` : ''))
      .sort()
    expect(lineSites).toEqual(['A/end', 'B/start'])
  })

  it('rejects an oversize radius and names the computed max', () => {
    // 90 deg corner with 10mm legs: max usable R = tan(45 deg)*10 = 10.
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 15, newId)
    expect(typeof r).toBe('string')
    expect(r).toMatch(/does not fit/)
    expect(r).toContain('10.00')
  })

  it('rejects parallel lines with a named reason', () => {
    const d = doc([line('A', 0, 0, 10, 0), line('B', 0, 5, 10, 5)])
    const r = filletLines(d, 'A', 'B', { x: 5, y: 0 }, { x: 5, y: 5 }, 2, newId)
    expect(r).toMatch(/parallel/)
  })

  it('non-perpendicular corner: tangency still analytic-exact', () => {
    // 60 deg opening at the origin.
    const d = doc([
      line('A', 10, 0, 0, 0),
      line('B', 0, 0, 10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3)),
    ])
    const r = filletLines(d, 'A', 'B', { x: 10, y: 0 },
      { x: 10 * Math.cos(Math.PI / 3), y: 10 * Math.sin(Math.PI / 3) }, 1.5, newId)
    if (typeof r === 'string') throw new Error(r)
    const t = r.transform
    const arc = t.entities.find((e) => e.id === r.arcId) as SketchArcEntity
    const a = t.entities.find((e) => e.id === 'A') as SketchLineEntity
    const b = t.entities.find((e) => e.id === 'B') as SketchLineEntity
    const coincs = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincs).toHaveLength(2)
    for (const c of coincs) {
      if (c.kind !== 'coincident') continue
      assertTangentJoint(
        arc, c.a.site as 'start' | 'end',
        c.b.entityId === 'A' ? a : b, c.b.site as 'start' | 'end',
      )
    }
    // Sweep = pi - 60 deg = 120 deg.
    const sweep = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    expect(sweep).toBeCloseTo((2 * Math.PI) / 3, 9)
  })

  it('shared theoretical-corner extraction preserves legacy ID and array ordering', () => {
    let id = 0
    const orderedId = () => `legacy-${id++}`
    const r = filletLines(
      base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, orderedId,
    )
    if (typeof r === 'string') throw new Error(r)

    expect({
      arcId: r.arcId,
      phantomPointId: r.phantomPointId,
      radiusDimId: r.radiusDimId,
    }).toEqual({
      arcId: 'legacy-0',
      phantomPointId: 'legacy-1',
      radiusDimId: 'legacy-8',
    })
    expect(r.transform.entities.map((entity) => entity.id))
      .toEqual(['A', 'B', 'legacy-1', 'legacy-0'])
    expect(r.transform.constraints.map((constraint) => constraint.id))
      .toEqual(['legacy-2', 'legacy-3', 'legacy-4', 'legacy-5', 'legacy-6', 'legacy-7'])
    expect(r.transform.dimensions.map((dimension) => dimension.id)).toEqual(['legacy-8'])
  })
})

// WO UI-26-R1 finding 3: the audit found no committed test constructs a
// THIRD real line coincident to a moved corner (only an in-memory probe did,
// against the bundled production filletLines). This promotes that probe's
// topology into the suite -- a real (non-construction) coincident propagates
// with the trim, while a construction anchor (the D9/A4 case, exercised via
// the real solver in d9-fillet-grows-box.test.ts) stays put at the
// theoretical corner through the fillet's phantom point.
describe('filletLines - real-point propagation vs construction anchors (finding 3)', () => {
  // Same perpendicular corner as above: A (0,0)->(10,0), B (10,0)->(10,10),
  // corner at B.start = (10,0). A THIRD entity shares that exact point via
  // its OWN coincident constraint (distinct from the corner's A/B one,
  // which the fillet consumes).
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }

  it('a third REAL line coincident to the trimmed corner site follows the trim to the tangent point', () => {
    // C: an ordinary (construction: false) third line through the same
    // corner point -- e.g. an internal spoke -- structural profile geometry
    // that must track the trim, not a dimension/anchor reference.
    const thirdLineCoincident: SketchConstraint = {
      id: 'c-third', kind: 'coincident',
      a: { entityId: 'C', site: 'start' }, b: { entityId: 'B', site: 'start' },
    }
    const d = doc(
      [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10), line('C', 10, 0, 20, 5)],
      [corner, thirdLineCoincident],
    )
    const r = filletLines(d, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const t = r.transform
    const b = t.entities.find((e) => e.id === 'B') as SketchLineEntity
    const c = t.entities.find((e) => e.id === 'C') as SketchLineEntity
    // B's trimmed corner site moved to the tangency point (90 deg corner,
    // R2: 2mm back from (10,0)).
    expect(b.start.x).toBeCloseTo(10, 9)
    expect(b.start.y).toBeCloseTo(2, 9)
    // C, a REAL line, followed it exactly -- the two stay coincident.
    expect(c.start.x).toBeCloseTo(b.start.x, 9)
    expect(c.start.y).toBeCloseTo(b.start.y, 9)
    // The surviving third-line coincident is still present; only the
    // corner's own consumed A/B coincident is gone.
    expect(t.constraints.some((cc) => cc.id === 'c-third')).toBe(true)
    expect(t.constraints.some((cc) => cc.id === 'c-corner')).toBe(false)
  })

  it('creates a dimensionable phantom at the theoretical intersect and retargets a construction anchor to it', () => {
    const constructionPoint: SketchEntity = {
      id: 'K', kind: 'point', construction: true, at: { x: 10, y: 0 },
    }
    const anchorCoincident: SketchConstraint = {
      id: 'c-anchor', kind: 'coincident',
      a: { entityId: 'K', site: 'self' }, b: { entityId: 'B', site: 'start' },
    }
    const d = doc(
      [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10), constructionPoint],
      [corner, anchorCoincident],
    )
    const r = filletLines(d, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const t = r.transform
    const k = t.entities.find((e) => e.id === 'K') as Extract<SketchEntity, { kind: 'point' }>
    const phantom = t.entities.find((e) => e.id === r.phantomPointId)
    expect(phantom).toMatchObject({
      id: r.phantomPointId, kind: 'point', construction: true,
      at: { x: 10, y: 0 },
    })
    const phantomPins = t.constraints.filter(
      (cc) => cc.kind === 'point_on_object' && cc.point.entityId === r.phantomPointId)
    expect(phantomPins).toHaveLength(2)
    expect(phantomPins.map((cc) => cc.kind === 'point_on_object' ? cc.object : '').sort())
      .toEqual(['A', 'B'])
    expect(t.constraints.some((cc) => cc.kind === 'fix' &&
      (cc.point?.entityId === r.phantomPointId || cc.entityId === r.phantomPointId))).toBe(false)
    // Stays at the THEORETICAL corner C = (10,0), not the fillet's tangent
    // point (10,2) -- Operator's A4 verdict (construction anchors don't drag).
    expect(k.at.x).toBeCloseTo(10, 9)
    expect(k.at.y).toBeCloseTo(0, 9)
    // Its stale coincident keeps both its ID and construction endpoint, but
    // the moved profile endpoint is retargeted to the phantom. The consumed
    // A/B corner tie remains gone, so this cannot restore the grow bug.
    expect(t.constraints.find((cc) => cc.id === 'c-anchor')).toEqual({
      id: 'c-anchor', kind: 'coincident',
      a: { entityId: 'K', site: 'self' },
      b: { entityId: r.phantomPointId, site: 'self' },
    })
    expect(t.constraints.some((cc) => cc.id === 'c-corner')).toBe(false)

    // A bare point entity participates in the real dimension planner. Build
    // a reference dimension from that plan and prove it resolves from the
    // phantom's actual intersect coordinate to A/start at (0,0).
    const planned = planDimension(t.entities, [r.phantomPointId, { entityId: 'A', site: 'start' }])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan).toMatchObject({
      kind: 'distance',
      a: { entityId: r.phantomPointId, site: 'self' },
      b: { entityId: 'A', site: 'start' },
      value: 10,
    })
    const reference: SketchDimension = {
      id: 'd-phantom-reference', driving: false, ...planned.plan,
    }
    expect(measureDimension(t.entities, reference)).toBeCloseTo(10, 9)
  })
})

describe('filletClick - accumulate gestures', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = () => doc(
    [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    [corner],
  )

  it('clicking the shared corner point STAGES the corner (no commit)', () => {
    const r = filletClick(null, base(), { x: 10, y: 0 }, 0.5)
    expect(r.notice).toBeNull()
    expect(r.chain?.corners).toHaveLength(1)
    expect(r.chain!.corners[0].at).toEqual({ x: 10, y: 0 })
    // Clicking the same corner again removes it (toggle).
    const r2 = filletClick(r.chain, base(), { x: 10, y: 0 }, 0.5)
    expect(r2.chain?.corners).toHaveLength(0)
  })

  it('line-pair flow: first line pends, second line stages the corner', () => {
    const first = filletClick(null, base(), { x: 5, y: 0 }, 0.5)
    expect(first.chain).toEqual({
      kind: 'fillet', corners: [], pendingLineId: 'A', pendingClick: { x: 5, y: 0 },
    })
    const second = filletClick(first.chain, base(), { x: 10, y: 5 }, 0.5)
    expect(second.notice).toBeNull()
    expect(second.chain!.pendingLineId).toBeNull()
    expect(second.chain!.corners).toHaveLength(1)
    const c = second.chain!.corners[0]
    expect([c.aId, c.bId].sort()).toEqual(['A', 'B'])
    expect(c.at.x).toBeCloseTo(10, 9)
    expect(c.at.y).toBeCloseTo(0, 9)
  })

  it('re-clicking the pending line unpicks it', () => {
    const first = filletClick(null, base(), { x: 5, y: 0 }, 0.5)
    const undo = filletClick(first.chain, base(), { x: 5, y: 0 }, 0.5)
    expect(undo.chain!.pendingLineId).toBeNull()
    expect(undo.chain!.corners).toHaveLength(0)
  })

  it('empty idle click is quiet; empty click with state explains itself', () => {
    const idle = filletClick(null, base(), { x: 50, y: 50 }, 0.5)
    expect(idle.chain).toBeNull()
    expect(idle.notice).toBeNull()
    const first = filletClick(null, base(), { x: 5, y: 0 }, 0.5)
    const miss = filletClick(first.chain, base(), { x: 50, y: 50 }, 0.5)
    expect(miss.notice).toMatch(/second line/)
    expect(miss.chain).toEqual(first.chain)
  })

  it('parallel second line is rejected with a notice, pending kept', () => {
    const d = doc([line('A', 0, 0, 10, 0), line('P', 0, 5, 10, 5)])
    const first = filletClick(null, d, { x: 5, y: 0 }, 0.5)
    const r = filletClick(first.chain, d, { x: 5, y: 5 }, 0.5)
    expect(r.notice).toMatch(/parallel/)
    expect(r.chain).toEqual(first.chain)
  })

  // Operator's verdict on 3dac35e: re-clicking a staged corner UNSELECTS it
  // (toggle), and Apply then commits only what is still staged.
  it('two staged corners, re-clicking the FIRST leaves only the second; apply commits only it', () => {
    // Open rectangle: corners at (10,0) and (10,10).
    const d = doc([
      line('l1', 0, 0, 10, 0),
      line('l2', 10, 0, 10, 10),
      line('l3', 10, 10, 0, 10),
    ])
    const c1 = filletClick(null, d, { x: 10, y: 0 }, 0.5)
    const c2 = filletClick(c1.chain, d, { x: 10, y: 10 }, 0.5)
    expect(c2.chain!.corners).toHaveLength(2)
    // Re-click the FIRST staged corner: it is removed, the second stays.
    const r = filletClick(c2.chain, d, { x: 10, y: 0 }, 0.5)
    expect(r.chain!.corners).toHaveLength(1)
    expect(r.chain!.corners[0].at.x).toBeCloseTo(10, 9)
    expect(r.chain!.corners[0].at.y).toBeCloseTo(10, 9)
    // Enter/Apply semantics: only the REMAINING corner commits.
    const applied = filletApplyAll(d, r.chain!.corners, 2, newId)
    expect(applied.applied).toBe(1)
    expect(applied.skipped).toHaveLength(0)
    const arcs = applied.transform!.entities.filter((e) => e.kind === 'arc')
    expect(arcs).toHaveLength(1)
  })

  it('duplicate-click TOLERANCE: a different line pair resolving to the same corner point unselects it', () => {
    // Three lines through (10,0): A horizontal, B vertical, C diagonal.
    const d = doc([
      line('A', 0, 0, 10, 0),
      line('B', 10, 0, 10, 10),
      line('C', 10, 0, 20, 10),
    ])
    // Stage the (A,B) corner via the line-pair gesture (clicks far from
    // the shared endpoint so the corner gesture does not fire).
    const p1 = filletClick(null, d, { x: 5, y: 0 }, 0.5)
    const p2 = filletClick(p1.chain, d, { x: 10, y: 5 }, 0.5)
    expect(p2.chain!.corners).toHaveLength(1)
    // Now pick (A,C) — a DIFFERENT pair whose intersection is the same
    // point (10,0): matches by at-tolerance and unselects the corner.
    const p3 = filletClick(p2.chain, d, { x: 2, y: 0 }, 0.5)
    const p4 = filletClick(p3.chain, d, { x: 16, y: 6 }, 0.5)
    expect(p4.chain!.corners).toHaveLength(0)
  })
})

describe('fillet preview + batch apply (confirm overlay)', () => {
  // An open rectangle: three lines with two corners at (10,0) and (10,10).
  const rectDoc = () => doc([
    line('l1', 0, 0, 10, 0),
    line('l2', 10, 0, 10, 10),
    line('l3', 10, 10, 0, 10),
  ])
  const chainOf = (d: SketchDoc): FilletChainState => ({
    kind: 'fillet',
    corners: filletSeedFromSelection(d.entities, ['l1', 'l2', 'l3']),
    pendingLineId: null,
    pendingClick: null,
  })

  it('preview-equals-commit: ghost arcs match the applied arcs', () => {
    const d = rectDoc()
    const chain = chainOf(d)
    expect(chain.corners).toHaveLength(2)
    const pv = filletChainPreview(chain, d, 2)
    expect(pv.fits).toBe(2)
    expect(pv.misfits).toBe(0)
    // Staged-corner MARKERS: one per staged corner, at the corner point
    // (the viewport draws a selection ring there — Operator's verdict on
    // 3dac35e: selected fillets need a clear visual element).
    expect(pv.corners).toHaveLength(2)
    const markerKeys = pv.corners
      .map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort()
    expect(markerKeys).toEqual(
      chain.corners.map((c) => `${c.at.x.toFixed(6)},${c.at.y.toFixed(6)}`).sort())
    const r = filletApplyAll(d, chain.corners, 2, newId)
    expect(r.applied).toBe(2)
    expect(r.skipped).toHaveLength(0)
    const arcs = r.transform!.entities.filter(
      (e): e is SketchArcEntity => e.kind === 'arc')
    expect(arcs).toHaveLength(2)
    // Every ghost point lies on one of the committed arcs (radius 2
    // about its center) — the preview arc IS the committed arc.
    for (const ghost of pv.arcs) {
      for (const p of ghost) {
        const onSome = arcs.some((a) =>
          Math.abs(Math.hypot(p.x - a.center.x, p.y - a.center.y) - a.radius) < 1e-9)
        expect(onSome).toBe(true)
      }
    }
  })

  it('selection-derived apply creates one host-line phantom for every corner, including all four at once', () => {
    const d = doc([
      line('l1', 0, 0, 10, 0),
      line('l2', 10, 0, 10, 10),
      line('l3', 10, 10, 0, 10),
      line('l4', 0, 10, 0, 0),
    ])
    const selectedLineIds = d.entities.map((e) => e.id)
    const corners = filletSeedFromSelection(d.entities, selectedLineIds)
    expect(corners).toHaveLength(4)

    const r = filletApplyAll(d, corners, 1, newId)
    expect(r.applied).toBe(corners.length)
    expect(r.skipped).toHaveLength(0)
    const t = r.transform!
    const phantoms = t.entities.filter(
      (e): e is Extract<SketchEntity, { kind: 'point' }> => e.kind === 'point' && e.construction)
    expect(phantoms).toHaveLength(corners.length)
    const expectedCorners = corners
      .map((c) => `${c.at.x.toFixed(6)},${c.at.y.toFixed(6)}`).sort()
    expect(phantoms.map((p) => `${p.at.x.toFixed(6)},${p.at.y.toFixed(6)}`).sort())
      .toEqual(expectedCorners)
    for (const phantom of phantoms) {
      const pins = t.constraints.filter(
        (c) => c.kind === 'point_on_object' && c.point.entityId === phantom.id)
      expect(pins).toHaveLength(2)
    }
  })

  it('a radius that does not fit shows a warning and is SKIPPED on apply', () => {
    const d = doc([
      line('s1', 0, 0, 3, 0),     // short legs: max usable radius 3
      line('s2', 3, 0, 3, 3),
      line('l1', 3, 3, 23, 3),    // long corner elsewhere
      line('l2', 23, 3, 23, 23),
    ])
    const chain: FilletChainState = {
      kind: 'fillet',
      corners: filletSeedFromSelection(d.entities, ['s1', 's2', 'l1', 'l2']),
      pendingLineId: null,
      pendingClick: null,
    }
    expect(chain.corners).toHaveLength(3) // s1/s2, s2/l1, l1/l2
    const pv = filletChainPreview(chain, d, 5)
    expect(pv.misfits).toBeGreaterThan(0)
    expect(pv.warnings.length).toBe(pv.misfits)
    // Every staged corner gets a marker — fit or not (misfits carry BOTH
    // a warning triangle and the staged-selection ring).
    expect(pv.corners).toHaveLength(3)
    const r = filletApplyAll(d, chain.corners, 5, newId)
    expect(r.applied).toBe(pv.fits)
    expect(r.skipped.length).toBe(pv.misfits)
    expect(r.skipped[0].reason).toMatch(/does not fit/)
  })

  it('nothing fits: apply returns no transform (store explains, no undo step)', () => {
    const d = doc([line('s1', 0, 0, 1, 0), line('s2', 1, 0, 1, 1)])
    const chain = filletSeedFromSelection(d.entities, ['s1', 's2'])
    const r = filletApplyAll(d, chain, 50, newId)
    expect(r.transform).toBeNull()
    expect(r.applied).toBe(0)
    expect(r.skipped).toHaveLength(1)
  })

  it('filletSeedFromSelection finds only shared-endpoint line pairs', () => {
    const d = rectDoc()
    expect(filletSeedFromSelection(d.entities, ['l1', 'l3'])).toHaveLength(0)
    expect(filletSeedFromSelection(d.entities, ['l1', 'l2'])).toHaveLength(1)
  })
})

describe('fillet auto radius dimension + equal-radius batch link', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = () => doc(
    [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    [corner],
  )

  it('filletLines adds exactly one DRIVING radius dim on the new arc', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.radiusDimId).not.toBeNull()
    const dims = r.transform.dimensions
    expect(dims).toHaveLength(1)
    const d = dims[0] as Extract<SketchDimension, { kind: 'radius' }>
    expect(d.id).toBe(r.radiusDimId)
    expect(d.kind).toBe('radius')
    expect(d.driving).toBe(true)
    expect(d.value).toBe(2)
    expect(d.entityId).toBe(r.arcId)
    // The label sits on the arc (distance R from the center).
    expect(Math.hypot(
      d.labelAnchor!.x - (r.transform.entities.find(
        (e) => e.id === r.arcId) as SketchArcEntity).center.x,
      d.labelAnchor!.y - (r.transform.entities.find(
        (e) => e.id === r.arcId) as SketchArcEntity).center.y,
    )).toBeCloseTo(2, 9)
  })

  it('opts.radiusDim=false adds no dimension (batch follower path)', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId,
      { radiusDim: false })
    if (typeof r === 'string') throw new Error(r)
    expect(r.radiusDimId).toBeNull()
    expect(r.transform.dimensions).toHaveLength(0)
  })

  it('batch apply: ONE driving radius dim on the lead, equal-radius links the rest', () => {
    // Open rectangle, two corners.
    const d = doc([
      line('l1', 0, 0, 10, 0),
      line('l2', 10, 0, 10, 10),
      line('l3', 10, 10, 0, 10),
    ])
    const corners = filletSeedFromSelection(d.entities, ['l1', 'l2', 'l3'])
    expect(corners).toHaveLength(2)
    const r = filletApplyAll(d, corners, 2, newId)
    expect(r.applied).toBe(2)
    const t = r.transform!
    // Exactly one driving radius dimension for the whole batch.
    const radDims = t.dimensions.filter(
      (dm): dm is Extract<SketchDimension, { kind: 'radius' }> => dm.kind === 'radius')
    expect(radDims).toHaveLength(1)
    expect(radDims[0].driving).toBe(true)
    expect(radDims[0].value).toBe(2)
    const leadArcId = radDims[0].entityId
    // The two new arcs.
    const arcs = t.entities.filter((e): e is SketchArcEntity => e.kind === 'arc')
    expect(arcs).toHaveLength(2)
    // One equal-radius constraint links the follower arc to the lead arc.
    const equals = t.constraints.filter(
      (c): c is Extract<SketchConstraint, { kind: 'equal' }> => c.kind === 'equal')
    expect(equals).toHaveLength(1)
    const followerArcId = arcs.find((a) => a.id !== leadArcId)!.id
    expect([equals[0].a, equals[0].b].sort())
      .toEqual([followerArcId, leadArcId].sort())
  })

  it('single-corner apply still gets a driving radius dim, no equal link', () => {
    const r = filletApplyAll(base(), [{
      aId: 'A', bId: 'B',
      hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 },
    }], 2, newId)
    expect(r.applied).toBe(1)
    const t = r.transform!
    expect(t.dimensions.filter((dm) => dm.kind === 'radius')).toHaveLength(1)
    expect(t.constraints.filter((c) => c.kind === 'equal')).toHaveLength(0)
  })
})

// ---- SKC-46: max-usable radius (default-derivation clamp) --------------------------------------

describe('filletMaxUsableRadius / filletChainMaxRadius (SKC-46)', () => {
  // A right-angle corner, both legs length 10: max usable radius = tan(45deg) * 10 = 10.
  const corner = { id: 'k', kind: 'coincident', a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' } } as SketchConstraint
  const rightAngle = () => doc([line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)], [corner])

  it('SKC-46-R1 BLOCKER 1: is a STRICT ceiling filletLines accepts AT the returned value -- not the bare geometric max', () => {
    const max = filletMaxUsableRadius(rightAngle(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 })
    expect(max).not.toBeNull()
    // The bare geometric max is tan(45deg)*10 = 10 exactly. The auditor's evidence was that
    // SEEDING exactly this value staged an impossible preview (filletLines requires strictly
    // LESS, by EPS_LEN) -- so the ceiling this function reports must sit strictly under 10, with
    // enough margin to survive the radius->tDist float round trip filletLines itself performs.
    expect(max).toBeLessThan(10)
    expect(max).toBeCloseTo(10, 5)
    // The real regression proof: filletLines FITS the returned ceiling AS-IS (this is exactly the
    // value seedStagedSize would stage -- no "-0.01 slack" fudge).
    const fitsAtCeiling = filletLines(rightAngle(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, max!, newId)
    expect(typeof fitsAtCeiling).not.toBe('string')
    // ...and the bare geometric max (10) is REJECTED -- the auditor's reproduced failure, kept red
    // if the margin is ever accidentally removed.
    const rejectsAtGeometricMax = filletLines(rightAngle(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 10, newId)
    expect(typeof rejectsAtGeometricMax).toBe('string')
  })

  it('BLOCKER 1 property sweep: the ceiling is accepted by the real fit function across many leg lengths', () => {
    // Kills the "exact-max float identity" regression across a spread of scales, not just one
    // fixture: at every leg length the ceiling filletMaxUsableRadius reports must be a radius
    // filletLines itself actually accepts.
    const legLengths = [0.02, 0.05, 0.1, 0.5, 1, 2, 4, 7.3, 10, 25, 100, 1000]
    for (const leg of legLengths) {
      const d = doc([line('A', 0, 0, leg, 0), line('B', leg, 0, leg, leg)])
      const max = filletMaxUsableRadius(d, 'A', 'B', { x: 0, y: 0 }, { x: leg, y: leg })
      expect(max, `leg=${leg}`).not.toBeNull()
      expect(Number.isFinite(max), `leg=${leg}`).toBe(true)
      if (max === null || max < 0.01) continue // sub-floor corners refuse instead (tested elsewhere)
      const r = filletLines(d, 'A', 'B', { x: 0, y: 0 }, { x: leg, y: leg }, max, newId)
      expect(typeof r, `leg=${leg} max=${max}`).not.toBe('string')
    }
  })

  it('returns null for a non-resolvable pick (missing line / parallel / collinear)', () => {
    expect(filletMaxUsableRadius(rightAngle(), 'A', 'ghost', { x: 0, y: 0 }, { x: 10, y: 10 })).toBeNull()
    const parallel = doc([line('A', 0, 0, 10, 0), line('B', 0, 1, 10, 1)])
    expect(filletMaxUsableRadius(parallel, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 1 })).toBeNull()
  })

  // ---- SKC-46-R3 MAJOR 3: the derived refusal-construction census (R2 contract requirement 2,
  // constructions (b)/(d)/(e)) -- named separately from the missing/parallel pick above, which only
  // exercised (missing entity) and (denom-guard parallel). Each test below isolates exactly ONE
  // guard by construction, so a regression that only breaks ONE of these guards fails ONE named test.

  it('R2 2(b): a near-collinear pair whose intersection falls beyond a kept leg refuses (trimSide avail <= EPS_LEN)', () => {
    // A's infinite-line intersection with B lands at C=(-10,0) -- well PAST A's own (0,0)-(3,0)
    // segment. hintA picks the kept side toward A.start (away from C), so `avail` (measured from C
    // to A.start along the kept direction) comes out NEGATIVE: the corner is geometrically beyond
    // where A's kept leg reaches. B is a normal, well-resolved second line (its own trimSide
    // succeeds with plenty of avail) so this isolates A's guard specifically.
    const d = doc([
      line('A', 0, 0, 3, 0),
      line('B', 0, 1e-9, 10, 2e-9), // near-parallel to A (tilted ~1e-10 rad): denom stays >> 1e-12
    ])
    expect(filletMaxUsableRadius(d, 'A', 'B', { x: -15, y: 0 }, { x: 0, y: 1e-9 })).toBeNull()
  })

  it('R2 2(d): a near-collinear (non-parallel-flagged) corner refuses on the angle guard, not the intersection guard', () => {
    // Same near-parallel construction as 2(b) but with hints chosen so BOTH trimSide calls succeed
    // (generous avail on the natural sides) -- the corner opening angle theta collapses to ~0,
    // strictly under EPS_ANG (1e-9 rad), while `lineLineIntersection`'s OWN denom guard (1e-12) does
    // NOT fire (these lines are not flagged as parallel). This isolates the theta<=EPS_ANG /
    // PI-theta<=EPS_ANG guard specifically.
    const d = doc([
      line('A', 0, 0, 10, 0),
      line('B', 0, 1e-9, 10, 2e-9),
    ])
    expect(filletMaxUsableRadius(d, 'A', 'B', { x: 0, y: 0 }, { x: 0, y: 1e-9 })).toBeNull()
  })

  it('R2 2(e): an existing entity that is not a line refuses (distinct from a MISSING entity)', () => {
    const withCircle = doc([
      line('A', 0, 0, 10, 0),
      { id: 'circleB', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 2 } as SketchEntity,
    ])
    expect(filletMaxUsableRadius(withCircle, 'A', 'circleB', { x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull()
  })

  it('filletChainMaxRadius is the MIN across every staged corner (the tighter corner governs)', () => {
    const shortB = doc(
      [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 4), line('C', 100, 0, 110, 0), line('D', 110, 0, 110, 10)],
    )
    const chain: FilletChainState = {
      kind: 'fillet',
      corners: [
        { aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 4 }, at: { x: 10, y: 0 } },
        { aId: 'C', bId: 'D', hintA: { x: 100, y: 0 }, hintB: { x: 110, y: 10 }, at: { x: 110, y: 0 } },
      ],
      pendingLineId: null, pendingClick: null,
    }
    // Corner 1 max = tan(45)*4 = 4; corner 2 max = tan(45)*10 = 10 (each minus the R1 CEILING_MARGIN
    // safety margin, ~2e-6mm -- precision 5 comfortably covers it). The batch ceiling is the min.
    const result = filletChainMaxRadius(chain, shortB)
    expect(result.kind).toBe('finite-legal')
    if (result.kind === 'finite-legal') expect(result.value).toBeCloseTo(4, 5)
  })

  it('filletChainMaxRadius skips unresolvable corners rather than nulling the whole batch', () => {
    const chain: FilletChainState = {
      kind: 'fillet',
      corners: [
        { aId: 'A', bId: 'ghost', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } },
        { aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } },
      ],
      pendingLineId: null, pendingClick: null,
    }
    const result = filletChainMaxRadius(chain, rightAngle())
    expect(result.kind).toBe('finite-legal')
    if (result.kind === 'finite-legal') expect(result.value).toBeCloseTo(10, 5)
  })

  it('filletChainMaxRadius returns "unresolvable" (SKC-46-R2) when NO staged corner resolves', () => {
    const chain: FilletChainState = {
      kind: 'fillet',
      corners: [{ aId: 'A', bId: 'ghost', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } }],
      pendingLineId: null, pendingClick: null,
    }
    expect(filletChainMaxRadius(chain, rightAngle())).toEqual({ kind: 'unresolvable' })
  })

  it('filletChainMaxRadius returns "no-corner" (SKC-46-R2) for an empty chain -- distinct from unresolvable', () => {
    const chain: FilletChainState = { kind: 'fillet', corners: [], pendingLineId: null, pendingClick: null }
    expect(filletChainMaxRadius(chain, rightAngle())).toEqual({ kind: 'no-corner' })
  })
})

// ---- BK-136: filletChainPreview memoizes one computation per (chain, doc, radius) --------------

describe('filletChainPreview memoization (BK-136, SKC-46)', () => {
  const corner = { id: 'k', kind: 'coincident', a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' } } as SketchConstraint
  const rightAngle = () => doc([line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)], [corner])
  const chain: FilletChainState = {
    kind: 'fillet',
    corners: [{ aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } }],
    pendingLineId: null, pendingClick: null,
  }

  beforeEach(() => {
    __resetFilletChainPreviewMemo()
  })

  it('two calls with the SAME chain reference, shallow-equal doc arrays, and radius compute ONCE', () => {
    const d = rightAngle()
    filletChainPreview(chain, d, 2)
    // A caller that rebuilds a fresh { entities: [...], ... } wrapper (exactly what toolOverlay's
    // docOf() does every render) around the SAME array elements must still hit the cache.
    filletChainPreview(chain, { entities: [...d.entities], constraints: [...d.constraints], dimensions: [...d.dimensions] }, 2)
    expect(__filletPreviewComputeCount()).toBe(1)
  })

  it('a different radius is a cache miss (recomputes)', () => {
    const d = rightAngle()
    filletChainPreview(chain, d, 2)
    filletChainPreview(chain, d, 3)
    expect(__filletPreviewComputeCount()).toBe(2)
  })

  it('a different chain reference is a cache miss even with identical corner content', () => {
    const d = rightAngle()
    filletChainPreview(chain, d, 2)
    filletChainPreview({ ...chain, corners: [...chain.corners] }, d, 2)
    expect(__filletPreviewComputeCount()).toBe(2)
  })

  it('a document mutation (new entity array) is a cache miss', () => {
    const d = rightAngle()
    filletChainPreview(chain, d, 2)
    const mutated = { ...d, entities: [...d.entities] } // same elements, but a real doc write would differ
    filletChainPreview(chain, mutated, 2)
    // Same elements => still a hit (this is the point: reference-identical elements, new wrapper).
    expect(__filletPreviewComputeCount()).toBe(1)
  })

  it('the cached result is the exact same object (not a deep-equal copy) on a hit', () => {
    const d = rightAngle()
    const first = filletChainPreview(chain, d, 2)
    const second = filletChainPreview(chain, { entities: [...d.entities], constraints: [...d.constraints], dimensions: [...d.dimensions] }, 2)
    expect(second).toBe(first)
  })
})

// ---- SKC-75 (Operator, from the road, chrome_6EtNqzI0jj.png): fillet dimension
// re-anchoring to the theoretical (untrimmed) corner --------------------------
//
// Repro: a rectangle side carries a length dimension anchored at its OWN
// endpoint. Filleting BOTH corners that side touches used to leave the
// dimension resolving to the NEW (trimmed) endpoint, so driving it back to
// its original value dragged the corner OUTWARD, growing the whole rectangle
// by (fillet radius) per re-driven side -- "forces the rectangle to grow in
// size by 2X the fillet". The fix re-anchors any dimension endpoint sitting
// exactly on a site the fillet is about to trim onto the theoretical
// corner's construction phantom point (buildTheoreticalCorner's existing
// UI-50C rig, already used by chamfer's d1xd2), which tracks the ORIGINAL
// corner-to-corner span through the trim.

describe('reanchorDimensionsToTheoreticalCorner / fillet re-anchor on APPLY (SKC-75, Bug B case 1)', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const lengthDim: SketchDimension = {
    id: 'dimA', kind: 'distance', driving: true, value: 10,
    a: { entityId: 'A', site: 'start' }, b: { entityId: 'A', site: 'end' },
    labelAnchor: { x: 5, y: -5 },
  }
  const base = (): SketchDoc => ({
    entities: [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    constraints: [corner],
    dimensions: [lengthDim],
  })

  it('re-anchors the trimmed endpoint (b) onto the phantom; the untrimmed endpoint (a) is untouched', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const dim = r.transform.dimensions.find((d) => d.id === 'dimA')
    if (!dim || dim.kind !== 'distance') throw new Error('expected the distance dim to survive')
    expect(dim.a).toEqual({ entityId: 'A', site: 'start' }) // A's start was never trimmed
    expect(dim.b).toEqual({ entityId: r.phantomPointId, site: 'self' }) // A's end WAS trimmed -> phantom
  })

  it('MUTATION PROOF: measuring the re-anchored dim reports the ORIGINAL corner-to-corner span (10), not the trimmed straight segment (8)', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const dim = r.transform.dimensions.find((d) => d.id === 'dimA')
    if (!dim) throw new Error('dim missing')
    const measured = measureDimension(r.transform.entities, dim)
    expect(measured).toBeCloseTo(10, 9) // the theoretical corner (10,0), same as before the fillet
    expect(measured).not.toBeCloseTo(8, 1) // the trimmed segment's own new endpoint (8,0) -- the bug
  })

  it('a REFERENCE (non-driving) dimension re-anchors identically', () => {
    const refDoc: SketchDoc = {
      ...base(),
      dimensions: [{ ...lengthDim, driving: false }],
    }
    const r = filletLines(refDoc, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const dim = r.transform.dimensions.find((d) => d.id === 'dimA')
    if (!dim || dim.kind !== 'distance') throw new Error('expected the distance dim to survive')
    expect(dim.b).toEqual({ entityId: r.phantomPointId, site: 'self' })
  })

  it('a dimension NOT touching either trimmed site is byte-identical (unchanged reference)', () => {
    // B/start IS a trimmed site here (the corner under test) -- use a
    // dimension anchored on a genuinely UNRELATED, untrimmed pair instead.
    const untouched2: SketchDimension = {
      id: 'dimC', kind: 'distanceX', driving: true, value: 0,
      a: { entityId: 'A', site: 'start' }, b: { entityId: 'A', site: 'start' },
      labelAnchor: { x: 0, y: -3 },
    }
    const withExtra: SketchDoc = { ...base(), dimensions: [...base().dimensions, untouched2] }
    const r = filletLines(withExtra, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const dim = r.transform.dimensions.find((d) => d.id === 'dimC')
    expect(dim).toBe(untouched2) // same object reference: never touched
  })

  it('BOTH corners of one side re-anchor across sequential filletApplyAll calls (the exact rectangle-with-2-fillets repro)', () => {
    // Rectangle: A (top, 0,0->10,0), B (right, 10,0->10,10), C (bottom,
    // 10,10->0,10), D (left, 0,10->0,0) -- A's own length dim spans BOTH of
    // its corners (A/start with D, A/end with B). Filleting BOTH corners
    // must re-anchor a AND b onto their respective phantoms.
    const cornerAB: SketchConstraint = {
      id: 'c-ab', kind: 'coincident',
      a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
    }
    const cornerDA: SketchConstraint = {
      id: 'c-da', kind: 'coincident',
      a: { entityId: 'D', site: 'end' }, b: { entityId: 'A', site: 'start' },
    }
    const topLenDim: SketchDimension = {
      id: 'dimTop', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'A', site: 'start' }, b: { entityId: 'A', site: 'end' },
      labelAnchor: { x: 5, y: -5 },
    }
    const rect: SketchDoc = {
      entities: [
        line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10),
        line('C', 10, 10, 0, 10), line('D', 0, 10, 0, 0),
      ],
      constraints: [cornerAB, cornerDA],
      dimensions: [topLenDim],
    }
    const r = filletApplyAll(
      rect,
      [
        { aId: 'A', bId: 'B', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } },
        { aId: 'D', bId: 'A', hintA: { x: 0, y: 10 }, hintB: { x: 10, y: 0 }, at: { x: 0, y: 0 } },
      ],
      2, newId,
    )
    expect(r.applied).toBe(2)
    if (!r.transform) throw new Error('expected a transform')
    const dim = r.transform.dimensions.find((d) => d.id === 'dimTop')
    if (!dim || dim.kind !== 'distance') throw new Error('expected the distance dim to survive')
    // Neither endpoint still points at A's own (now-trimmed) start/end.
    expect(dim.a).not.toEqual({ entityId: 'A', site: 'start' })
    expect(dim.b).not.toEqual({ entityId: 'A', site: 'end' })
    // Measuring reports the ORIGINAL 10mm corner-to-corner span, not the
    // twice-trimmed remaining straight segment (10 - 2*2 = 6).
    const measured = measureDimension(r.transform.entities, dim)
    expect(measured).toBeCloseTo(10, 9)
    expect(measured).not.toBeCloseTo(6, 1)
  })
})

describe('resolveFilletCornerSite (SKC-75, Bug B case 2 building block)', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = (): SketchDoc => ({
    entities: [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    constraints: [corner],
    dimensions: [],
  })

  it('detected=false for an ORDINARY (non-filleted) line endpoint', () => {
    const d = resolveFilletCornerSite(base().entities, base().constraints, 'A', 'start')
    expect(d.detected).toBe(false)
  })

  it('detected=true, ok=true for a genuinely filleted corner; resolves the phantom position', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const d = resolveFilletCornerSite(r.transform.entities, r.transform.constraints, 'A', 'end')
    expect(d.detected).toBe(true)
    if (!d.detected || !d.ok) throw new Error('expected ok=true')
    expect(d.corner.phantomRef).toEqual({ entityId: r.phantomPointId, site: 'self' })
    expect(d.corner.phantom.x).toBeCloseTo(10, 9)
    expect(d.corner.phantom.y).toBeCloseTo(0, 9)
    // Symmetric from the OTHER leg's site.
    const d2 = resolveFilletCornerSite(r.transform.entities, r.transform.constraints, 'B', 'start')
    expect(d2.detected).toBe(true)
    if (!d2.detected || !d2.ok) throw new Error('expected ok=true')
    expect(d2.corner.phantomRef).toEqual({ entityId: r.phantomPointId, site: 'self' })
  })

  it('FAIL-LOUD: detected=true, ok=false when the phantom pin rig is broken (ADR-0003 -- never silently keeps the trimmed site)', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    // Simulate a corrupted/hand-edited document: strip the point_on_object
    // pins so the phantom can no longer be resolved from the tangent+arc
    // evidence (which is STILL present -- this must not silently fall back
    // to "not detected").
    const brokenConstraints = r.transform.constraints.filter((c) => c.kind !== 'point_on_object')
    const d = resolveFilletCornerSite(r.transform.entities, brokenConstraints, 'A', 'end')
    expect(d.detected).toBe(true)
    if (!d.detected) throw new Error('expected detected=true')
    expect(d.ok).toBe(false)
    if (d.ok) throw new Error('expected ok=false')
    expect(d.reason).toBe('no-theoretical-corner')
  })
})

describe('dimToolClick: explicit vertex pick on a filleted corner snaps to the theoretical corner (SKC-75, Bug B case 2)', () => {
  const corner: SketchConstraint = {
    id: 'c-corner', kind: 'coincident',
    a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' },
  }
  const base = (): SketchDoc => ({
    entities: [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    constraints: [corner],
    dimensions: [],
  })

  it('an explicit snap on the TRIMMED end of a filleted line redirects the operand to the phantom', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const aAfter = r.transform.entities.find((e) => e.id === 'A') as SketchLineEntity
    // Snap explicitly on A's (trimmed) end at (8,0).
    const out = dimToolClick(
      null, aAfter.end, 0.5, r.transform.entities, newId,
      { point: aAfter.end, ref: { entityId: 'A', site: 'end' } },
      r.transform.constraints,
    )
    expect(out.notice).toBeNull()
    if (out.chain?.kind !== 'dim') throw new Error('expected an in-progress dim chain')
    expect(out.chain.operandIds).toEqual([{ entityId: r.phantomPointId, site: 'self' }])
  })

  it('an explicit snap on an ORDINARY (non-filleted) line endpoint is unaffected', () => {
    const d = base()
    const out = dimToolClick(
      null, { x: 0, y: 0 }, 0.5, d.entities, newId,
      { point: { x: 0, y: 0 }, ref: { entityId: 'A', site: 'start' } },
      d.constraints,
    )
    expect(out.notice).toBeNull()
    if (out.chain?.kind !== 'dim') throw new Error('expected an in-progress dim chain')
    expect(out.chain.operandIds).toEqual([{ entityId: 'A', site: 'start' }])
  })

  it('FAIL-LOUD: a broken theoretical-corner rig refuses the pick by name instead of silently using the trimmed site', () => {
    const r = filletLines(base(), 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, newId)
    if (typeof r === 'string') throw new Error(r)
    const aAfter = r.transform.entities.find((e) => e.id === 'A') as SketchLineEntity
    const brokenConstraints = r.transform.constraints.filter((c) => c.kind !== 'point_on_object')
    const out = dimToolClick(
      null, aAfter.end, 0.5, r.transform.entities, newId,
      { point: aAfter.end, ref: { entityId: 'A', site: 'end' } },
      brokenConstraints,
    )
    expect(out.chain).toBeNull()
    expect(out.dimension).toBeNull()
    expect(out.notice).toMatch(/fillet theoretical corner unresolved/)
  })
})

describe('WO-206 circular-curve fillet pairs', () => {
  function applyPair(
    d: SketchDoc, aId: string, bId: string, hintA: Vec2, hintB: Vec2, radius = 1,
  ) {
    const result = filletLines(d, aId, bId, hintA, hintB, radius, newId)
    if (typeof result === 'string') throw new Error(result)
    const fillet = result.transform.entities.find((e) => e.id === result.arcId)
    if (!fillet || fillet.kind !== 'arc') throw new Error('fillet arc missing')
    return { result, fillet }
  }

  function expectFilletContract(result: ReturnType<typeof applyPair>['result']) {
    const joints = result.transform.constraints.filter((constraint) =>
      constraint.kind === 'coincident' &&
      (constraint.a.entityId === result.arcId || constraint.b.entityId === result.arcId))
    const tangencies = result.transform.constraints.filter((constraint) =>
      constraint.kind === 'tangent' &&
      (constraint.a === result.arcId || constraint.b === result.arcId))
    expect(joints).toHaveLength(2)
    expect(tangencies).toHaveLength(2)
    expect(result.transform.dimensions).toContainEqual(expect.objectContaining({
      kind: 'radius', driving: true, entityId: result.arcId,
    }))
    const fillet = result.transform.entities.find((entity) => entity.id === result.arcId)
    if (!fillet || fillet.kind !== 'arc') throw new Error('fillet arc missing')
    for (const joint of joints) {
      if (joint.kind !== 'coincident') continue
      const filletRef = joint.a.entityId === result.arcId ? joint.a : joint.b
      const hostRef = joint.a.entityId === result.arcId ? joint.b : joint.a
      const host = result.transform.entities.find((entity) => entity.id === hostRef.entityId)
      if (!host || (hostRef.site !== 'start' && hostRef.site !== 'end') ||
          (filletRef.site !== 'start' && filletRef.site !== 'end')) {
        throw new Error('invalid fillet joint references')
      }
      const filletAngle = filletRef.site === 'start' ? fillet.startAngle : fillet.endAngle
      const point = arcPt(fillet, filletAngle)
      if (host.kind === 'line') {
        const hostPoint = host[hostRef.site]
        expect(Math.hypot(point.x - hostPoint.x, point.y - hostPoint.y)).toBeLessThan(1e-8)
        expect(Math.abs(cross(
          arcD1(filletAngle),
          unit({ x: host.end.x - host.start.x, y: host.end.y - host.start.y }),
        ))).toBeLessThan(1e-8)
      } else if (host.kind === 'arc') {
        const hostAngle = hostRef.site === 'start' ? host.startAngle : host.endAngle
        const hostPoint = arcPt(host, hostAngle)
        expect(Math.hypot(point.x - hostPoint.x, point.y - hostPoint.y)).toBeLessThan(1e-8)
        expect(Math.abs(cross(
          { x: point.x - fillet.center.x, y: point.y - fillet.center.y },
          { x: point.x - host.center.x, y: point.y - host.center.y },
        ))).toBeLessThan(1e-7)
      } else {
        throw new Error(`fillet host ${host.id} was not trimmed to line/arc`)
      }
    }
  }

  it('recreates the shared line/arc endpoint workflow with native arc trimming', () => {
    const corner: SketchConstraint = {
      id: 'joint', kind: 'coincident',
      a: { entityId: 'line', site: 'end' }, b: { entityId: 'arc', site: 'start' },
    }
    const length: SketchDimension = {
      id: 'length', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'line', site: 'start' }, b: { entityId: 'line', site: 'end' },
    }
    const source: SketchDoc = {
      entities: [
        line('line', -10, 0, 0, 0),
        arc('arc', -5, 0, 5, 0, Math.PI / 2),
      ],
      constraints: [corner],
      dimensions: [length],
    }
    const { result } = applyPair(
      source, 'line', 'arc', { x: -8, y: 0 }, { x: -5, y: 5 }, 1,
    )
    expectFilletContract(result)
    const hostArc = result.transform.entities.find((e) => e.id === 'arc')
    expect(hostArc?.kind).toBe('arc')
    if (!hostArc || hostArc.kind !== 'arc') return
    expect(hostArc.startAngle).toBeGreaterThan(0)
    const phantom = result.transform.entities.find((e) => e.id === result.phantomPointId)
    expect(phantom).toEqual(expect.objectContaining({ kind: 'point', construction: true }))
    if (!phantom || phantom.kind !== 'point') return
    expect(phantom.at.x).toBeCloseTo(0, 9)
    expect(phantom.at.y).toBeCloseTo(0, 9)
    expect(result.transform.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'point_on_object', object: 'line' }),
      expect.objectContaining({ kind: 'point_on_object', object: 'arc' }),
    ]))
    const afterLength = result.transform.dimensions.find((dimension) => dimension.id === 'length')
    expect(afterLength).toEqual(expect.objectContaining({
      b: { entityId: result.phantomPointId, site: 'self' },
    }))
    expect(measureDimension(result.transform.entities, afterLength!)).toBeCloseTo(10, 9)
  })

  it.each([
    ['line-circle',
      [line('a', -10, 0, 10, 0), circle('b', 0, 0, 5)],
      { x: 9, y: 0 }, { x: 0, y: 5 }],
    ['arc-arc',
      [arc('a', -5, 0, 5, 0, Math.PI / 2), arc('b', 0, 5, 5, -Math.PI / 2, 0)],
      { x: -5, y: 5 }, { x: 5, y: 5 }],
    ['arc-circle',
      [arc('a', -5, 0, 5, 0, Math.PI / 2), circle('b', 0, 5, 5)],
      { x: -1.464466, y: 3.535534 }, { x: 5, y: 5 }],
    ['circle-circle',
      [circle('a', -3, 0, 5), circle('b', 3, 0, 5)],
      { x: -3, y: 5 }, { x: 3, y: 5 }],
  ] as const)('%s inserts one constrained fillet and keeps stable host ids', (_name, entities, hintA, hintB) => {
    const { result } = applyPair(doc([...entities]), 'a', 'b', hintA, hintB, 0.5)
    expectFilletContract(result)
    expect(result.transform.entities.filter((entity) => entity.id === 'a')).toHaveLength(1)
    expect(result.transform.entities.filter((entity) => entity.id === 'b')).toHaveLength(1)
    for (const id of ['a', 'b']) {
      const original = entities.find((entity) => entity.id === id)!
      const after = result.transform.entities.find((entity) => entity.id === id)!
      if (original.kind === 'circle') expect(after.kind).toBe('arc')
    }
  })

  it('uses the line-side hint to select external versus internal circle tangency', () => {
    const source = doc([line('line', -10, 0, 10, 0), circle('circle', 0, 0, 5)])
    const external = applyPair(
      source, 'line', 'circle', { x: 9, y: 0 }, { x: 0, y: 5 }, 1,
    ).fillet
    const internal = applyPair(
      source, 'line', 'circle', { x: 2, y: 0 }, { x: 0, y: 5 }, 1,
    ).fillet
    expect(Math.hypot(external.center.x, external.center.y)).toBeCloseTo(6, 8)
    expect(Math.hypot(internal.center.x, internal.center.y)).toBeCloseTo(4, 8)
  })

  it('two body picks stage and preview a circular pair through the normal tool flow', () => {
    const source = doc([line('line', -10, 0, 10, 0), circle('circle', 0, 0, 5)])
    const first = filletClick(null, source, { x: 9, y: 0 }, 0.25)
    expect(first.chain?.pendingLineId).toBe('line')
    const second = filletClick(first.chain, source, { x: 0, y: 5 }, 0.25)
    expect(second.notice).toBeNull()
    expect(second.chain?.corners).toHaveLength(1)
    expect(filletChainPreview(second.chain!, source, 1).fits).toBe(1)
    expect(filletMaxUsableRadius(
      source, 'line', 'circle', { x: 9, y: 0 }, { x: 0, y: 5 },
    )).toBeGreaterThan(0)
  })

  it('reports a finite max radius for a staged line/arc pair (controller sanitize path)', () => {
    const source = doc([
      line('line', -60, 0, 0, 0),
      arc('arc', -30, 30, Math.hypot(30, 30), -Math.PI / 4, Math.PI / 4),
    ])
    expect(filletMaxUsableRadius(
      source, 'line', 'arc', { x: -48, y: 0 }, { x: 10, y: 43 },
    )).toBeGreaterThan(0)
  })

  it('keeps a field-sized fillet stageable on a huge-radius short-span arc', () => {
    const hostRadius = 1_000_000
    const source = doc([
      line('line', 0, -1, 0, 0),
      arc('arc', 0, -hostRadius, hostRadius, Math.PI / 2, Math.PI / 2 + 1e-7),
    ])
    const hintLine = { x: 0, y: -0.8 }
    const hintArc = { x: -0.08, y: 0 }
    const direct = filletLines(
      source, 'line', 'arc', hintLine, hintArc, 0.01, newId,
    )
    expect(typeof direct).not.toBe('string')

    const chain: FilletChainState = {
      kind: 'fillet',
      corners: [{
        aId: 'line', bId: 'arc', hintA: hintLine, hintB: hintArc, at: { x: 0, y: 0 },
      }],
      pendingLineId: null,
      pendingClick: null,
    }
    const max = filletMaxUsableRadius(source, 'line', 'arc', hintLine, hintArc)
    expect(max).not.toBeNull()
    expect(max).toBeGreaterThanOrEqual(0.01)
    expect(filletChainMaxRadius(chain, source)).toEqual({ kind: 'finite-legal', value: max })
    expect(filletChainPreview(chain, source, max!)).toEqual(expect.objectContaining({
      fits: 1,
      misfits: 0,
    }))
    expect(filletChainPreview(chain, source, 0.01)).toEqual(expect.objectContaining({
      fits: 1,
      misfits: 0,
    }))
  })

  it.each([
    ['tangent without room', doc([line('a', -10, 5, 10, 5), circle('b', 0, 0, 5)]),
      { x: 8, y: 5 }, { x: 0, y: 5 }, /tangent.*no room/i],
    ['disjoint', doc([line('a', -10, 6, 10, 6), circle('b', 0, 0, 5)]),
      { x: 8, y: 6 }, { x: 0, y: 5 }, /disjoint/i],
    ['concentric', doc([circle('a', 0, 0, 5), circle('b', 0, 0, 3)]),
      { x: 5, y: 0 }, { x: 3, y: 0 }, /concentric/i],
    ['ambiguous', doc([line('a', -10, 0, 10, 0), circle('b', 0, 0, 5)]),
      { x: 0, y: 0 }, { x: 0, y: 5 }, /ambiguous/i],
    ['no fit', doc([
      line('a', -10, 0, 0, 0), arc('b', -5, 0, 5, 0, Math.PI / 2),
    ]), { x: -8, y: 0 }, { x: -5, y: 5 }, /no fit/i],
  ] as const)('named refusal: %s leaves the document untouched', (_name, source, hintA, hintB, reason) => {
    const result = filletLines(source, 'a', 'b', hintA, hintB, 100, newId)
    expect(result).toEqual(expect.stringMatching(reason))
    expect(source.entities).toHaveLength(2)
    expect(source.constraints).toHaveLength(0)
    expect(source.dimensions).toHaveLength(0)
  })
})

describe('WO-207 native ellipse/spline fillet hosts', () => {
  const doc = (entities: SketchEntity[]): SketchDoc => ({ entities, constraints: [], dimensions: [] })

  it('constructs line/ellipse and preserves the ellipse as a native elliptical arc', () => {
    const entities: SketchEntity[] = [
      line('line', 0, 5, 0, 15),
      { id: 'ellipse', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 10, minorRadius: 5, rotation: 0 },
    ]
    const result = filletLines(doc(entities), 'line', 'ellipse', { x: 0, y: 10 }, { x: 6, y: 4 }, 1, newId)
    expect(result).not.toBeTypeOf('string')
    if (typeof result === 'string') return
    expect(result.transform.entities.find((e) => e.id === 'ellipse')?.kind).toBe('elliptical-arc')
    const fillet = result.transform.entities.find((e) => e.id === result.arcId)
    expect(fillet?.kind).toBe('arc')
    if (fillet?.kind === 'arc') expect(fillet.curveFillet?.hostBId).toBe('ellipse')
    expect(result.transform.constraints.filter((c) => c.kind === 'tangent')).toHaveLength(2)
  })

  it('constructs line/spline without converting the spline to a polyline', () => {
    const entities: SketchEntity[] = [
      line('line', 0, 0, 0, 10),
      { id: 'spline', kind: 'spline', construction: false, closed: false,
        points: [{ x: -8, y: 0 }, { x: 0, y: 0 }, { x: 8, y: 0 }] },
    ]
    const result = filletLines(doc(entities), 'line', 'spline', { x: 0, y: 6 }, { x: 6, y: 0 }, 1, newId)
    expect(result).not.toBeTypeOf('string')
    if (typeof result === 'string') return
    const spline = result.transform.entities.find((e) => e.id === 'spline')
    expect(spline?.kind).toBe('spline')
    if (spline?.kind === 'spline') expect(spline.filletSourcePoints).toEqual(entities[1].kind === 'spline' ? entities[1].points : [])
  })

  it.each([
    ['arc/ellipse',
      { id: 'a', kind: 'arc', construction: false, center: { x: 0, y: 8 }, radius: 5,
        startAngle: Math.PI, endAngle: Math.PI * 2 } as SketchEntity,
      { id: 'b', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 10, minorRadius: 5, rotation: 0 } as SketchEntity,
      { x: 4, y: 5 }, { x: 7, y: 3 }],
    ['ellipse/ellipse',
      { id: 'a', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 10, minorRadius: 6, rotation: 0 } as SketchEntity,
      { id: 'b', kind: 'ellipse', construction: false, center: { x: 8, y: 0 },
        majorRadius: 7, minorRadius: 4, rotation: 0 } as SketchEntity,
      { x: 6, y: 5 }, { x: 4, y: 3 }],
    ['arc/spline',
      { id: 'a', kind: 'arc', construction: false, center: { x: 2, y: 3 }, radius: 5,
        startAngle: Math.PI, endAngle: Math.PI * 2 } as SketchEntity,
      { id: 'b', kind: 'spline', construction: false, closed: false,
        points: [{ x: -8, y: 0 }, { x: 0, y: 0 }, { x: 8, y: 0 }] } as SketchEntity,
      { x: -1, y: 6 }, { x: 5, y: 0 }],
    ['ellipse/spline',
      { id: 'a', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 10, minorRadius: 5, rotation: 0 } as SketchEntity,
      { id: 'b', kind: 'spline', construction: false, closed: false,
        points: [{ x: -15, y: 0 }, { x: 0, y: 0 }, { x: 15, y: 0 }] } as SketchEntity,
      { x: 8, y: 3 }, { x: 5, y: 0 }],
    ['spline/spline',
      { id: 'a', kind: 'spline', construction: false, closed: false,
        points: [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }] } as SketchEntity,
      { id: 'b', kind: 'spline', construction: false, closed: false,
        points: [{ x: 0, y: -10 }, { x: 0, y: 0 }, { x: 0, y: 10 }] } as SketchEntity,
      { x: 6, y: 0 }, { x: 0, y: 6 }],
  ] as const)('%s produces one native, constrained fillet', (_name, a, b, hintA, hintB) => {
    const result = filletLines(doc([a, b]), 'a', 'b', hintA, hintB, 0.75, newId)
    expect(result).not.toBeTypeOf('string')
    if (typeof result === 'string') return
    expect(result.transform.entities.filter((e) => e.id === result.arcId && e.kind === 'arc')).toHaveLength(1)
    expect(result.transform.constraints.filter((c) => c.kind === 'tangent')).toHaveLength(2)
    expect(result.transform.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(2)
  })

  it('refuses a closed spline by name with no partial mutation', () => {
    const source: SketchEntity[] = [
      line('line', 0, 0, 0, 10),
      { id: 'spline', kind: 'spline', construction: false, closed: true,
        points: [{ x: -5, y: 0 }, { x: 0, y: -5 }, { x: 5, y: 0 }, { x: 0, y: 5 }] },
    ]
    expect(filletLines(doc(source), 'line', 'spline', { x: 0, y: 6 }, { x: 4, y: 0 }, 1, newId))
      .toMatch(/closed spline ambiguity/)
    expect(source[1]).toEqual(expect.objectContaining({ kind: 'spline', closed: true }))
  })

  it('survives JSON replay, retains theoretical point-on-curve pins, and follows a host edit', () => {
    const entities: SketchEntity[] = [
      line('line', 0, 5, 0, 15),
      { id: 'ellipse', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 10, minorRadius: 5, rotation: 0 },
    ]
    const result = filletLines(doc(entities), 'line', 'ellipse', { x: 0, y: 10 }, { x: 6, y: 4 }, 1, newId)
    expect(result).not.toBeTypeOf('string')
    if (typeof result === 'string') return
    const replay = JSON.parse(JSON.stringify(result.transform)) as SketchDoc
    expect(replay.constraints.filter((c) => c.kind === 'point_on_object' &&
      (c.object === 'line' || c.object === 'ellipse'))).toHaveLength(2)
    const originalPhantom = replay.entities.find((e) => e.id === result.phantomPointId)
    expect(originalPhantom?.kind).toBe('point')
    const moved = replay.entities.map((e) => e.id === 'ellipse' && e.kind === 'elliptical-arc'
      ? { ...e, center: { x: e.center.x + 0.4, y: e.center.y } }
      : e)
    const rebuilt = reconcileCurveFillets(moved)
    const fillet = rebuilt.find((e) => e.id === result.arcId)
    const ellipse = rebuilt.find((e) => e.id === 'ellipse')
    const hostLine = rebuilt.find((e) => e.id === 'line')
    const phantom = rebuilt.find((e) => e.id === result.phantomPointId)
    expect(fillet?.kind).toBe('arc')
    expect(ellipse?.kind).toBe('elliptical-arc')
    expect(hostLine?.kind).toBe('line')
    expect(phantom?.kind).toBe('point')
    if (fillet?.kind !== 'arc' || ellipse?.kind !== 'elliptical-arc' ||
        hostLine?.kind !== 'line' || phantom?.kind !== 'point') return
    const jointAngle = fillet.curveFillet?.arcAAtStart ? fillet.endAngle : fillet.startAngle
    const p = { x: fillet.center.x + fillet.radius * Math.cos(jointAngle),
      y: fillet.center.y + fillet.radius * Math.sin(jointAngle) }
    const d = ellipseDerivativeAt(ellipse, ellipseParamFromPoint(ellipse, p))
    expect(Math.abs(d.x * (p.x - fillet.center.x) + d.y * (p.y - fillet.center.y))).toBeLessThan(1e-4)
    const lineDx = hostLine.end.x - hostLine.start.x, lineDy = hostLine.end.y - hostLine.start.y
    const lineResidual = Math.abs((phantom.at.x - hostLine.start.x) * lineDy -
      (phantom.at.y - hostLine.start.y) * lineDx) / Math.hypot(lineDx, lineDy)
    const cos = Math.cos(ellipse.rotation), sin = Math.sin(ellipse.rotation)
    const dx = phantom.at.x - ellipse.center.x, dy = phantom.at.y - ellipse.center.y
    const localX = dx * cos + dy * sin, localY = -dx * sin + dy * cos
    const ellipseResidual = Math.abs((localX / ellipse.majorRadius) ** 2 +
      (localY / ellipse.minorRadius) ** 2 - 1)
    expect(lineResidual).toBeLessThan(1e-6)
    expect(ellipseResidual).toBeLessThan(1e-6)
    if (originalPhantom?.kind === 'point') {
      expect(Math.hypot(phantom.at.x - originalPhantom.at.x,
        phantom.at.y - originalPhantom.at.y)).toBeGreaterThan(1e-4)
    }
  })

  it('moves the theoretical phantom with the audit ellipse-center edit', () => {
    const entities: SketchEntity[] = [
      line('line', 0, 5, 0, 15),
      { id: 'ellipse', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 10, minorRadius: 5, rotation: 0 },
    ]
    const result = filletLines(doc(entities), 'line', 'ellipse', { x: 0, y: 10 }, { x: 6, y: 4 }, 1, newId)
    expect(result).not.toBeTypeOf('string')
    if (typeof result === 'string') return
    const moved = result.transform.entities.map((e) => e.id === 'ellipse' && e.kind === 'elliptical-arc'
      ? { ...e, center: { x: e.center.x, y: e.center.y + 1 } }
      : e)
    const rebuilt = reconcileCurveFillets(moved)
    const ellipse = rebuilt.find((e) => e.id === 'ellipse')
    const hostLine = rebuilt.find((e) => e.id === 'line')
    const phantom = rebuilt.find((e) => e.id === result.phantomPointId)
    expect(ellipse?.kind).toBe('elliptical-arc')
    expect(hostLine?.kind).toBe('line')
    expect(phantom?.kind).toBe('point')
    if (ellipse?.kind !== 'elliptical-arc' || hostLine?.kind !== 'line' || phantom?.kind !== 'point') return
    const lineDx = hostLine.end.x - hostLine.start.x, lineDy = hostLine.end.y - hostLine.start.y
    const lineResidual = Math.abs((phantom.at.x - hostLine.start.x) * lineDy -
      (phantom.at.y - hostLine.start.y) * lineDx) / Math.hypot(lineDx, lineDy)
    const dx = phantom.at.x - ellipse.center.x, dy = phantom.at.y - ellipse.center.y
    const ellipseResidual = Math.abs((dx / ellipse.majorRadius) ** 2 +
      (dy / ellipse.minorRadius) ** 2 - 1)
    expect(lineResidual).toBeLessThan(1e-6)
    expect(ellipseResidual).toBeLessThan(1e-6)
    expect(phantom.at).toEqual(expect.objectContaining({ x: expect.closeTo(0, 6), y: expect.closeTo(6, 6) }))
  })

  it('composes opposite R1 trims on one native spline through apply, reconcile, edit, and replay', () => {
    const source = doc([
      line('left', -5, 0, -5, 8),
      line('right', 5, 0, 5, 8),
      { id: 'spline', kind: 'spline', construction: false, closed: false,
        points: [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }] },
    ])
    const corners: FilletCornerPick[] = [
      { aId: 'left', bId: 'spline', hintA: { x: -5, y: 6 },
        hintB: { x: 0, y: 0 }, at: { x: -5, y: 0 } },
      { aId: 'right', bId: 'spline', hintA: { x: 5, y: 6 },
        hintB: { x: 0, y: 0 }, at: { x: 5, y: 0 } },
    ]

    const assertFilletResiduals = (entities: SketchEntity[], constraints: SketchConstraint[]) => {
      const byId = new Map(entities.map((entity) => [entity.id, entity]))
      const pointAt = (ref: { entityId: string; site: string }): Vec2 => {
        const entity = byId.get(ref.entityId)
        if (entity?.kind === 'line' && (ref.site === 'start' || ref.site === 'end')) return entity[ref.site]
        if (entity?.kind === 'arc' && (ref.site === 'start' || ref.site === 'end')) {
          const angle = ref.site === 'start' ? entity.startAngle : entity.endAngle
          return { x: entity.center.x + entity.radius * Math.cos(angle),
            y: entity.center.y + entity.radius * Math.sin(angle) }
        }
        if (entity?.kind === 'spline' && (ref.site === 'start' || ref.site === 'end')) {
          return entity.points[ref.site === 'start' ? 0 : entity.points.length - 1]
        }
        throw new Error(`unsupported point ${ref.entityId}/${ref.site}`)
      }
      const filletIds = new Set(entities.filter((entity) => entity.kind === 'arc' && entity.curveFillet)
        .map((entity) => entity.id))
      const joints = constraints.filter((constraint) => constraint.kind === 'coincident' &&
        (filletIds.has(constraint.a.entityId) || filletIds.has(constraint.b.entityId)))
      expect(joints).toHaveLength(4)
      for (const joint of joints) {
        if (joint.kind !== 'coincident') continue
        const a = pointAt(joint.a), b = pointAt(joint.b)
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6)
      }
      const tangencies = constraints.filter((constraint) => constraint.kind === 'tangent' &&
        (filletIds.has(constraint.a) || filletIds.has(constraint.b)))
      expect(tangencies).toHaveLength(4)
      for (const tangent of tangencies) {
        if (tangent.kind !== 'tangent') continue
        const arc = byId.get(filletIds.has(tangent.a) ? tangent.a : tangent.b)
        const host = byId.get(filletIds.has(tangent.a) ? tangent.b : tangent.a)
        if (arc?.kind !== 'arc' || !host) throw new Error('missing fillet tangent hosts')
        const joint = joints.find((constraint) => constraint.kind === 'coincident' &&
          ((constraint.a.entityId === arc.id && constraint.b.entityId === host.id) ||
            (constraint.b.entityId === arc.id && constraint.a.entityId === host.id)))
        if (!joint || joint.kind !== 'coincident') throw new Error('missing fillet joint')
        const at = pointAt(joint.a.entityId === arc.id ? joint.a : joint.b)
        const radial = { x: at.x - arc.center.x, y: at.y - arc.center.y }
        const direction = host.kind === 'line'
          ? { x: host.end.x - host.start.x, y: host.end.y - host.start.y }
          : host.kind === 'spline'
            ? splineDerivativeAt(host.filletSourcePoints ?? host.points, false,
                nearestParamOnSpline(host.filletSourcePoints ?? host.points, false, at))
            : null
        if (!direction) throw new Error(`unsupported tangent host ${host.kind}`)
        expect(Math.abs(radial.x * direction.x + radial.y * direction.y) /
          (Math.hypot(radial.x, radial.y) * Math.hypot(direction.x, direction.y))).toBeLessThan(1e-5)
      }
    }

    let id = 0
    const applied = filletApplyAll(source, corners, 1, () => `double-${id++}`)
    expect(applied.applied).toBe(2)
    expect(applied.skipped).toEqual([])
    expect(applied.transform).not.toBeNull()
    if (!applied.transform) return
    assertFilletResiduals(applied.transform.entities, applied.transform.constraints)
    const splineAfterApply = applied.transform.entities.find((entity) => entity.id === 'spline')
    expect(splineAfterApply?.kind).toBe('spline')
    if (splineAfterApply?.kind === 'spline') {
      expect(splineAfterApply.points[0].x).toBeCloseTo(-4, 5)
      expect(splineAfterApply.points[splineAfterApply.points.length - 1].x).toBeCloseTo(4, 5)
    }

    let reverseId = 0
    const reverse = filletApplyAll(source, [...corners].reverse(), 1, () => `reverse-${reverseId++}`)
    expect(reverse.applied).toBe(2)
    expect(reverse.skipped).toEqual([])
    expect(reverse.transform).not.toBeNull()
    if (reverse.transform) {
      assertFilletResiduals(reverse.transform.entities, reverse.transform.constraints)
      const reverseSpline = reverse.transform.entities.find((entity) => entity.id === 'spline')
      expect(reverseSpline?.kind).toBe('spline')
      if (splineAfterApply?.kind === 'spline' && reverseSpline?.kind === 'spline') {
        expect(reverseSpline.points).toHaveLength(splineAfterApply.points.length)
        reverseSpline.points.forEach((point, index) => {
          expect(point.x).toBeCloseTo(splineAfterApply.points[index].x, 6)
          expect(point.y).toBeCloseTo(splineAfterApply.points[index].y, 6)
        })
      }
    }

    const reconciled = reconcileCurveFillets(applied.transform.entities)
    assertFilletResiduals(reconciled, applied.transform.constraints)

    const replay = JSON.parse(JSON.stringify({ ...applied.transform, entities: reconciled })) as SketchDoc
    const edited = replay.entities.map((entity) => {
      if (entity.kind !== 'line') return entity
      const dx = entity.id === 'left' ? -1 : entity.id === 'right' ? 1 : 0
      return { ...entity, start: { ...entity.start, x: entity.start.x + dx },
        end: { ...entity.end, x: entity.end.x + dx } }
    })
    const replayed = reconcileCurveFillets(edited)
    assertFilletResiduals(replayed, replay.constraints)
    const replayedSpline = replayed.find((entity) => entity.id === 'spline')
    expect(replayedSpline?.kind).toBe('spline')
    if (replayedSpline?.kind === 'spline') {
      expect(replayedSpline.points[0].x).toBeCloseTo(-5, 5)
      expect(replayedSpline.points[replayedSpline.points.length - 1].x).toBeCloseTo(5, 5)
    }
  })

  it('refuses an incompatible same-end spline batch by name without partial mutation', () => {
    const source = doc([
      line('left-a', -5, 0, -5, 8),
      line('left-b', -3, 0, -3, 8),
      { id: 'spline', kind: 'spline', construction: false, closed: false,
        points: [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }] },
    ])
    const before = JSON.parse(JSON.stringify(source))
    let id = 0
    const applied = filletApplyAll(source, [
      { aId: 'left-a', bId: 'spline', hintA: { x: -5, y: 6 },
        hintB: { x: 0, y: 0 }, at: { x: -5, y: 0 } },
      { aId: 'left-b', bId: 'spline', hintA: { x: -3, y: 6 },
        hintB: { x: 0, y: 0 }, at: { x: -3, y: 0 } },
    ], 1, () => `conflict-${id++}`)
    expect(applied.transform).toBeNull()
    expect(applied.applied).toBe(0)
    expect(applied.skipped[0]?.reason).toMatch(/spline endpoint trims cannot coexist/i)
    expect(source).toEqual(before)
  })

  it('rolls back a same-end spline batch when the inner trim is requested first', () => {
    const source = doc([
      line('left-a', -5, 0, -5, 8),
      line('left-b', -3, 0, -3, 8),
      { id: 'spline', kind: 'spline', construction: false, closed: false,
        points: [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }] },
    ])
    const before = JSON.parse(JSON.stringify(source))
    let id = 0
    const applied = filletApplyAll(source, [
      { aId: 'left-b', bId: 'spline', hintA: { x: -3, y: 6 },
        hintB: { x: 0, y: 0 }, at: { x: -3, y: 0 } },
      { aId: 'left-a', bId: 'spline', hintA: { x: -5, y: 6 },
        hintB: { x: 0, y: 0 }, at: { x: -5, y: 0 } },
    ], 1, () => `reverse-conflict-${id++}`)
    expect(applied.transform).toBeNull()
    expect(applied.applied).toBe(0)
    expect(applied.skipped).toHaveLength(1)
    expect(applied.skipped[0]?.reason).toMatch(/spline endpoint trims cannot coexist/i)
    expect(source).toEqual(before)
  })
})
