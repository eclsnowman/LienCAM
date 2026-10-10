// Polygon + straight slot tools (Stage 6) — headless commit coverage,
// driven through the SAME machine-level click path the viewport uses
// (toolClick), so the tests pin the user-visible behavior, not helpers.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  toolPreview,
  escapeTool,
  type ToolState,
  type ToolClickCtx,
} from '../../lib/sketch/tools/toolMachine'
import type {
  CoincidentConstraint,
  EqualConstraint,
  SketchArcEntity,
  SketchCircleEntity,
  SketchEntity,
  SketchLineEntity,
  SketchPointEntity,
  TangentConstraint,
  Vec2,
} from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

/** CUT geometry of a commit (C2 appends construction defining geometry —
 *  a reference circle, or cap-center points + a centerline — which must never
 *  pollute the cut-side / cut-cap assertions). */
const cutLines = (commit: { entities: readonly SketchEntity[] }): SketchLineEntity[] =>
  commit.entities.filter(
    (e): e is SketchLineEntity => e.kind === 'line' && !e.construction,
  )
const cutArcs = (commit: { entities: readonly SketchEntity[] }): SketchArcEntity[] =>
  commit.entities.filter(
    (e): e is SketchArcEntity => e.kind === 'arc' && !e.construction,
  )

/** Location-exact within eps (eps = 0 asserts EXACT coordinates). */
const near = (a: Vec2, b: Vec2, eps = 1e-9) => {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(eps)
}

// ---- Polygon ---------------------------------------------------------------

describe('polygon tool (machine-level)', () => {
  const ctx = (
    sides: number,
    polygonMode: 'inscribed' | 'circumscribed' = 'inscribed',
  ): ToolClickCtx => ({ entities: [], polygonSides: sides, polygonMode })

  it('first click anchors the center; no commit', () => {
    const r = toolClick(armed('polygon'), { x: 10, y: 5 }, TOL, idFactory(), ctx(6))
    expect(r.commit).toBeNull()
    expect(r.state.chain).toEqual({ kind: 'polygon', center: { x: 10, y: 5 } })
  })

  it('hexagon: second click commits 6 lines with vertex 0 AT the cursor', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId, ctx(6))
    const r2 = toolClick(r1.state, { x: 10, y: 0 }, TOL, newId, ctx(6))
    const lines = cutLines(r2.commit!)
    expect(lines).toHaveLength(6)
    expect(lines.every((l) => l.kind === 'line' && !l.construction)).toBe(true)

    // Inscribed hexagon, R = 10, rotation 0: vertices every 60 deg CCW.
    const R = 10
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3
      near(lines[k].start, { x: R * Math.cos(a), y: R * Math.sin(a) }, 1e-9)
      const a1 = ((k + 1) % 6 * Math.PI) / 3
      near(lines[k].end, { x: R * Math.cos(a1), y: R * Math.sin(a1) }, 1e-9)
    }
    // All sides equal length R (regular hexagon property).
    for (const l of lines) {
      expect(Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)).toBeCloseTo(R, 9)
    }
    // Chain closes exactly: last end == first start.
    near(lines[5].end, lines[0].start, 0)
    // Tool stays armed for the next polygon.
    expect(r2.state).toEqual({ tool: 'polygon', chain: null })
  })

  it('hexagon constraints: 6 coincident closing the chain + 5 equal', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId, ctx(6))
    const r2 = toolClick(r1.state, { x: 10, y: 0 }, TOL, newId, ctx(6))
    const lines = cutLines(r2.commit!)
    const cs = r2.commit!.constraints
    expect(cs).toHaveLength(17) // 6 closing + 5 equal + 6 vertices on reference circle

    const coincident = cs.filter((c) => c.kind === 'coincident')
    expect(coincident).toHaveLength(6)
    coincident.forEach((c, i) => {
      expect(c).toMatchObject({
        a: { entityId: lines[i].id, site: 'end' },
        b: { entityId: lines[(i + 1) % 6].id, site: 'start' },
      })
    })

    const equal = cs.filter((c) => c.kind === 'equal')
    expect(equal).toHaveLength(5) // consecutive pairs; the 6th would be redundant
    equal.forEach((c, i) => {
      expect(c).toMatchObject({ a: lines[i].id, b: lines[i + 1].id })
    })
    expect(cs.filter((c) => c.kind === 'point_on_object')).toHaveLength(6)
  })

  it('respects the sides input (triangle) and clamps below 3', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId, ctx(3))
    const r2 = toolClick(r1.state, { x: 0, y: 5 }, TOL, newId, ctx(3))
    expect(cutLines(r2.commit!)).toHaveLength(3)
    expect(r2.commit!.constraints).toHaveLength(8) // 3 coincident + 2 equal + 3 on circle

    const newId2 = idFactory()
    const q1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId2, ctx(1))
    const q2 = toolClick(q1.state, { x: 0, y: 5 }, TOL, newId2, ctx(1))
    expect(cutLines(q2.commit!)).toHaveLength(3) // clamped to the minimum
  })

  it('rotation follows the cursor: vertex 0 lands exactly on the click', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 2, y: 3 }, TOL, newId, ctx(5))
    const cursor = { x: 5, y: 9 }
    const r2 = toolClick(r1.state, cursor, TOL, newId, ctx(5))
    const lines = r2.commit!.entities as SketchLineEntity[]
    near(lines[0].start, cursor, 1e-12)
  })

  it('degenerate radius click (on the center) is ignored', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId, ctx(6))
    const r2 = toolClick(r1.state, { x: 0.2, y: 0.2 }, TOL, newId, ctx(6))
    expect(r2.commit).toBeNull()
    expect(r2.state).toEqual(r1.state)
  })

  it('preview outline matches the polygon the next click commits', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId, ctx(6))
    const preview = toolPreview(r1.state, { x: 10, y: 0 }, { polygonSides: 6 })!
    expect(preview).toHaveLength(7) // closed outline
    const lines = cutLines(toolClick(r1.state, { x: 10, y: 0 }, TOL, newId, ctx(6)).commit!)
    lines.forEach((l, i) => {
      near(l.start, preview[i], 0)
      near(l.end, preview[i + 1], 0)
    })
  })

  it('Esc cancels the in-progress polygon; tool stays armed', () => {
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, idFactory(), ctx(6))
    const esc = escapeTool(r1.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'polygon', chain: null })
  })

  it('keeps a dimensionable construction circle tied to every inscribed vertex', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 3, y: 4 }, TOL, newId, ctx(5))
    const r2 = toolClick(r1.state, { x: 13, y: 4 }, TOL, newId, ctx(5))
    const circles = r2.commit!.entities.filter(
      (e): e is SketchCircleEntity => e.kind === 'circle',
    )
    expect(circles).toHaveLength(1)
    expect(circles[0]).toMatchObject({
      construction: true,
      center: { x: 3, y: 4 },
      radius: 10,
    })
    expect(cutLines(r2.commit!)).toHaveLength(5)
    expect(r2.commit!.constraints.filter((c) => c.kind === 'point_on_object')).toHaveLength(5)
  })

  it('circumscribed mode treats the cursor as a side midpoint and ties every side tangent', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('polygon'), { x: 0, y: 0 }, TOL, newId, ctx(4, 'circumscribed'))
    const r2 = toolClick(r1.state, { x: 10, y: 0 }, TOL, newId, ctx(4, 'circumscribed'))
    const lines = cutLines(r2.commit!)
    near(lines[0].start, { x: 10, y: -10 }, 1e-9)
    near(lines[0].end, { x: 10, y: 10 }, 1e-9)
    const circle = r2.commit!.entities.find(
      (entity): entity is SketchCircleEntity => entity.kind === 'circle',
    )
    expect(circle?.radius).toBeCloseTo(10, 9)
    expect(r2.commit!.constraints.filter((constraint) => constraint.kind === 'tangent')).toHaveLength(4)
  })
})

// ---- Slot ------------------------------------------------------------------

/** Three clicks: cap A, cap B, width point. */
function drawSlot(a: Vec2, b: Vec2, w: Vec2) {
  const newId = idFactory()
  const ctx: ToolClickCtx = { entities: [] }
  const r1 = toolClick(armed('slot'), a, TOL, newId, ctx)
  const r2 = toolClick(r1.state, b, TOL, newId, ctx)
  return toolClick(r2.state, w, TOL, newId, ctx)
}

/** Point on an arc at a given angle. */
function arcPointAt(arc: SketchArcEntity, angle: number): Vec2 {
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  }
}

describe('slot tool (machine-level)', () => {
  it('axis clicks chain without committing', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('slot'), { x: 0, y: 0 }, TOL, newId)
    expect(r1.commit).toBeNull()
    expect(r1.state.chain).toEqual({ kind: 'slot', a: { x: 0, y: 0 }, b: null })
    const r2 = toolClick(r1.state, { x: 20, y: 0 }, TOL, newId)
    expect(r2.commit).toBeNull()
    expect(r2.state.chain).toEqual({
      kind: 'slot', a: { x: 0, y: 0 }, b: { x: 20, y: 0 },
    })
  })

  it('commits 2 parallel lines + 2 semicircle caps at the clicked width', () => {
    const r = drawSlot({ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 3 })
    const lines = cutLines(r.commit!)
    const arcs = cutArcs(r.commit!)
    expect(lines).toHaveLength(2)
    expect(arcs).toHaveLength(2)

    // Axis along +X, width click 3 above the axis -> cap radius 3.
    near(lines[0].start, { x: 0, y: 3 }, 1e-9)   // top: A-side -> B-side
    near(lines[0].end,   { x: 20, y: 3 }, 1e-9)
    near(lines[1].start, { x: 20, y: -3 }, 1e-9) // bottom: B-side -> A-side
    near(lines[1].end,   { x: 0, y: -3 }, 1e-9)
    // Parallel (both horizontal here).
    expect(lines[0].start.y).toBeCloseTo(lines[0].end.y, 12)
    expect(lines[1].start.y).toBeCloseTo(lines[1].end.y, 12)

    // Caps: semicircles centered ON the cap centers at radius 3.
    const [arcB, arcA] = arcs
    near(arcB.center, { x: 20, y: 0 }, 0)
    near(arcA.center, { x: 0, y: 0 }, 0)
    expect(arcB.radius).toBeCloseTo(3, 12)
    expect(arcA.radius).toBeCloseTo(3, 12)
    expect(arcB.endAngle - arcB.startAngle).toBeCloseTo(Math.PI, 12)
    expect(arcA.endAngle - arcA.startAngle).toBeCloseTo(Math.PI, 12)

    // The slot ends, tool stays armed.
    expect(r.state).toEqual({ tool: 'slot', chain: null })
  })

  it('caps are tangent to both sides (analytic: radius perpendicular to line at the shared point)', () => {
    // Slanted axis so nothing is axis-aligned by accident.
    const r = drawSlot({ x: 1, y: 2 }, { x: 13, y: 11 }, { x: 7, y: 9 })
    const lines = cutLines(r.commit!)
    const arcs = cutArcs(r.commit!)
    const cs = r.commit!.constraints

    // Every coincident joint is location-exact: resolve each constraint's
    // sites to coordinates and compare.
    const sitePoint = (entityId: string, site: string): Vec2 => {
      const line = lines.find((l) => l.id === entityId)
      if (line) return site === 'start' ? line.start : line.end
      const arc = arcs.find((a) => a.id === entityId)!
      return arcPointAt(arc, site === 'start' ? arc.startAngle : arc.endAngle)
    }
    // The four SLOT-BODY joints (both refs are a cut line/arc start/end). C2's
    // centerline ties (cap point <-> arc center, line <-> cap point) reference
    // construction points / 'center' sites and are validated separately.
    const cutLineIds = new Set(lines.map((l) => l.id))
    const cutArcIds = new Set(arcs.map((a) => a.id))
    const isBodySite = (ref: { entityId: string; site: string }) =>
      (cutLineIds.has(ref.entityId) || cutArcIds.has(ref.entityId)) &&
      (ref.site === 'start' || ref.site === 'end')
    const coincident = cs.filter(
      (c): c is CoincidentConstraint =>
        c.kind === 'coincident' && isBodySite(c.a) && isBodySite(c.b),
    )
    expect(coincident).toHaveLength(4)
    for (const c of coincident) {
      const pa = sitePoint(c.a.entityId, c.a.site)
      const pb = sitePoint(c.b.entityId, c.b.site)
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeLessThan(1e-9)
    }

    // Tangency, analytically: for each tangent constraint the line's
    // direction must be perpendicular to (cap center -> nearest line
    // endpoint), i.e. the dot product vanishes; and the cap center's
    // distance to the infinite line equals the cap radius.
    const tangent = cs.filter((c) => c.kind === 'tangent') as TangentConstraint[]
    expect(tangent).toHaveLength(4)
    for (const t of tangent) {
      const line = lines.find((l) => l.id === t.a) ?? lines.find((l) => l.id === t.b)!
      const arc = arcs.find((a) => a.id === t.a) ?? arcs.find((a) => a.id === t.b)!
      const d = { x: line.end.x - line.start.x, y: line.end.y - line.start.y }
      const dl = Math.hypot(d.x, d.y)
      // Perpendicular distance center -> infinite line == radius.
      const dist = Math.abs(
        (d.x * (line.start.y - arc.center.y) - (line.start.x - arc.center.x) * d.y) / dl
      )
      expect(dist).toBeCloseTo(arc.radius, 9)
      // Contact point (nearest endpoint) radius vector perpendicular to d.
      const ends = [line.start, line.end]
      const contact = ends.reduce((best, p) =>
        Math.hypot(p.x - arc.center.x, p.y - arc.center.y) <
        Math.hypot(best.x - arc.center.x, best.y - arc.center.y) ? p : best)
      const rad = { x: contact.x - arc.center.x, y: contact.y - arc.center.y }
      expect(Math.abs(d.x * rad.x + d.y * rad.y) / dl).toBeLessThan(1e-9)
    }

    // Both caps tangent to BOTH sides: 2 tangents per arc, 2 per line.
    for (const arc of arcs) {
      expect(tangent.filter((t) => t.a === arc.id || t.b === arc.id)).toHaveLength(2)
    }
    for (const line of lines) {
      expect(tangent.filter((t) => t.a === line.id || t.b === line.id)).toHaveLength(2)
    }
  })

  it('equal-radius constraint between exactly the two caps', () => {
    const r = drawSlot({ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 3 })
    const arcs = cutArcs(r.commit!)
    const equal = r.commit!.constraints.filter((c) => c.kind === 'equal') as EqualConstraint[]
    expect(equal).toHaveLength(1)
    const ids = [equal[0].a, equal[0].b].sort()
    expect(ids).toEqual(arcs.map((a) => a.id).sort())
    // Slot body: 4 coincident + 4 tangent + 1 equal = 9. C2 appends 4
    // coincident centerline ties (2 cap->center, 2 line->cap) = 13 total.
    expect(r.commit!.constraints).toHaveLength(13)
  })

  it('degenerate clicks are ignored: zero-length axis, zero width', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('slot'), { x: 0, y: 0 }, TOL, newId)
    const sameSpot = toolClick(r1.state, { x: 0.2, y: 0 }, TOL, newId)
    expect(sameSpot.commit).toBeNull()
    expect(sameSpot.state).toEqual(r1.state)

    const r2 = toolClick(r1.state, { x: 20, y: 0 }, TOL, newId)
    const onAxis = toolClick(r2.state, { x: 10, y: 0.2 }, TOL, newId)
    expect(onAxis.commit).toBeNull()
    expect(onAxis.state).toEqual(r2.state)
  })

  it('preview outline passes through the four joint points the commit creates', () => {
    const newId = idFactory()
    const a = { x: 0, y: 0 }, b = { x: 20, y: 0 }, w = { x: 10, y: 3 }
    const r1 = toolClick(armed('slot'), a, TOL, newId)
    const r2 = toolClick(r1.state, b, TOL, newId)
    const preview = toolPreview(r2.state, w)!
    const commit = toolClick(r2.state, w, TOL, newId).commit!
    const lines = cutLines(commit)
    for (const p of [lines[0].start, lines[0].end, lines[1].start, lines[1].end]) {
      const hit = preview.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9)
      expect(hit).toBe(true)
    }
  })

  it('C2: keeps a construction centerline (2 cap-center points + a line)', () => {
    const r = drawSlot({ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 3 })
    const points = r.commit!.entities.filter(
      (e): e is SketchPointEntity => e.kind === 'point',
    )
    const constructionLines = r.commit!.entities.filter(
      (e): e is SketchLineEntity => e.kind === 'line' && e.construction,
    )
    expect(points).toHaveLength(2)
    expect(points.every((p) => p.construction)).toBe(true)
    expect(constructionLines).toHaveLength(1)
    // Cap-center points sit on the two cap arc centers (a and b).
    const caps = cutArcs(r.commit!).map((a) => a.center)
    for (const cap of caps) {
      expect(points.some((p) => Math.hypot(p.at.x - cap.x, p.at.y - cap.y) < 1e-9)).toBe(true)
    }
  })
})
