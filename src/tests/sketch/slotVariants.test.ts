// Arc-slot + 3-point-slot variants (Tier 2c). Headless coverage driven
// through the SAME machine-level click path the viewport uses (toolClick),
// plus the pure builders, plus the bake boundary (closed Loop2D), so the
// tests pin user-visible behavior and CAM consumability — not helpers.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  toolPreview,
  escapeTool,
  type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import {
  arcSlotGeometry,
  buildArcSlotCommit,
} from '../../lib/sketch/tools/polygonSlotTools'
import { bakeSketch } from '../../lib/sketch/bake'
import type {
  Sketch,
  SketchArcEntity,
  SketchEntity,
  SketchPointEntity,
  Vec2,
} from '../../lib/sketch/types'

const TOL = 0.5
const LAYER = 'slot-variant-layer'

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

/** The CUT outline arcs (C2 appends a construction centerline arc + cap-center
 *  points that must never pollute the four-outline-arc assertions). */
const cutArcs = (commit: { entities: readonly SketchEntity[] }): SketchArcEntity[] =>
  commit.entities.filter(
    (e): e is SketchArcEntity => e.kind === 'arc' && !e.construction,
  )

const near = (a: Vec2, b: Vec2, eps = 1e-9) => {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(eps)
}

/** Point on an arc entity at a given angle. */
function arcPointAt(arc: SketchArcEntity, angle: number): Vec2 {
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  }
}

function sketchOf(entities: Sketch['entities'], constraints: Sketch['constraints']): Sketch {
  return {
    id: 'sk', layerId: LAYER, entities, constraints, dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

// ---- Arc slot: pure geometry ----------------------------------------------

describe('arcSlotGeometry (pure)', () => {
  // A clean quarter-ish centerline: center the unit circle * 10 at origin,
  // start at +X (angle 0), through the +Y/+X bisector, end at +Y (angle 90).
  const start = { x: 10, y: 0 }
  const thru = { x: Math.SQRT1_2 * 10, y: Math.SQRT1_2 * 10 } // 45 deg, R=10
  const end = { x: 0, y: 10 }

  it('produces concentric inner/outer arcs at centerRadius -/+ halfWidth', () => {
    const g = arcSlotGeometry(start, end, thru, 2, TOL)!
    expect(g).not.toBeNull()
    near(g.center, { x: 0, y: 0 }, 1e-9)
    expect(g.centerRadius).toBeCloseTo(10, 9)
    expect(g.outer.radius).toBeCloseTo(12, 9)
    expect(g.inner.radius).toBeCloseTo(8, 9)
    // Both body arcs share the centerline center (concentric).
    near(g.outer.center, g.inner.center, 0)
    near(g.outer.center, g.center, 0)
    // Centerline sweep is the 90 deg minor arc through `thru`.
    expect(g.sweep).toBeCloseTo(Math.PI / 2, 9)
  })

  it('cap centers sit on the centerline endpoints; caps are semicircles of halfWidth', () => {
    const g = arcSlotGeometry(start, end, thru, 2, TOL)!
    // Cap centers are the centerline END points (R = 10).
    near(g.capStart.center, { x: 10, y: 0 }, 1e-9)
    near(g.capEnd.center, { x: 0, y: 10 }, 1e-9)
    expect(g.capStart.radius).toBeCloseTo(2, 9)
    expect(g.capEnd.radius).toBeCloseTo(2, 9)
    // Each cap is a half circle.
    expect(g.capStart.endAngle - g.capStart.startAngle).toBeCloseTo(Math.PI, 9)
    expect(g.capEnd.endAngle - g.capEnd.startAngle).toBeCloseTo(Math.PI, 9)
  })

  it('outline endpoints close into one loop (cap ends meet body-arc ends)', () => {
    const g = arcSlotGeometry(start, end, thru, 2, TOL)!
    const at = (s: typeof g.outer, which: 'startAngle' | 'endAngle') =>
      arcPointAt(s as unknown as SketchArcEntity, s[which])
    // outer.end == capEnd.start
    near(at(g.outer, 'endAngle'), at(g.capEnd, 'startAngle'), 1e-9)
    // capEnd.end == inner.end
    near(at(g.capEnd, 'endAngle'), at(g.inner, 'endAngle'), 1e-9)
    // inner.start == capStart.start
    near(at(g.inner, 'startAngle'), at(g.capStart, 'startAngle'), 1e-9)
    // capStart.end == outer.start
    near(at(g.capStart, 'endAngle'), at(g.outer, 'startAngle'), 1e-9)
  })

  it('rejects degenerate inputs: collinear centerline, zero width, over-wide', () => {
    // Collinear three points -> no arc.
    expect(arcSlotGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, 2, TOL)).toBeNull()
    // Zero / negative half-width.
    expect(arcSlotGeometry(start, end, thru, 0, TOL)).toBeNull()
    expect(arcSlotGeometry(start, end, thru, -1, TOL)).toBeNull()
    // Half-width >= centerline radius would invert the inner arc.
    expect(arcSlotGeometry(start, end, thru, 10, TOL)).toBeNull()
    expect(arcSlotGeometry(start, end, thru, 11, TOL)).toBeNull()
  })
})

describe('buildArcSlotCommit (pure)', () => {
  const start = { x: 10, y: 0 }
  const thru = { x: Math.SQRT1_2 * 10, y: Math.SQRT1_2 * 10 }
  const end = { x: 0, y: 10 }

  it('emits 4 cut arcs + the honest constraint set, plus the C2 centerline', () => {
    const commit = buildArcSlotCommit(start, end, thru, 2, TOL, false, idFactory())!
    expect(commit).not.toBeNull()
    const arcs = cutArcs(commit)
    expect(arcs).toHaveLength(4)
    expect(arcs.every((a) => !a.construction)).toBe(true)
    // C2 appends one construction centerline arc + 2 cap-center points.
    expect(commit.entities.filter((e) => e.kind === 'arc' && e.construction)).toHaveLength(1)
    expect(commit.entities.filter((e) => e.kind === 'point')).toHaveLength(2)

    const cs = commit.constraints
    // Slot body: 4 coincident, 1 concentric, 1 equal, 4 tangent (WO-1465
    // boundary tangency) = 10. C2 adds 2 coincident (cap point -> cap arc
    // center) + 1 concentric (centerline -> outer) + 2 coincident (WO-1465
    // half-width line -> outer/inner start) + 1 midpoint (centerline start
    // -> half-width line) = 16.
    expect(cs.filter((c) => c.kind === 'coincident')).toHaveLength(8)
    expect(cs.filter((c) => c.kind === 'concentric')).toHaveLength(2)
    expect(cs.filter((c) => c.kind === 'equal')).toHaveLength(1)
    expect(cs.filter((c) => c.kind === 'tangent')).toHaveLength(4)
    expect(cs.filter((c) => c.kind === 'midpoint')).toHaveLength(1)
    expect(cs).toHaveLength(16)
  })

  it('every outline coincident joint is location-exact', () => {
    const commit = buildArcSlotCommit(start, end, thru, 2, TOL, false, idFactory())!
    const arcs = cutArcs(commit)
    const cutArcIds = new Set(arcs.map((a) => a.id))
    const sitePoint = (entityId: string, site: string): Vec2 => {
      const a = arcs.find((x) => x.id === entityId)!
      return arcPointAt(a, site === 'start' ? a.startAngle : a.endAngle)
    }
    // The 4 OUTLINE joints (both refs are a cut arc start/end). C2's cap-point
    // ties reference construction points / 'center' sites, validated elsewhere.
    const isOutlineSite = (ref: { entityId: string; site: string }) =>
      cutArcIds.has(ref.entityId) && (ref.site === 'start' || ref.site === 'end')
    const coincident = commit.constraints.filter(
      (c) => c.kind === 'coincident' && isOutlineSite(c.a) && isOutlineSite(c.b),
    )
    expect(coincident).toHaveLength(4)
    for (const c of coincident) {
      if (c.kind !== 'coincident') continue
      near(sitePoint(c.a.entityId, c.a.site), sitePoint(c.b.entityId, c.b.site), 1e-9)
    }
  })

  it('honors the construction flag', () => {
    const commit = buildArcSlotCommit(start, end, thru, 2, TOL, true, idFactory())!
    expect(commit.entities.every((e) => e.construction)).toBe(true)
  })

  it('returns null on the same degenerate inputs the geometry rejects', () => {
    expect(buildArcSlotCommit(start, end, thru, 0, TOL, false, idFactory())).toBeNull()
    expect(buildArcSlotCommit({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }, 1, TOL, false, idFactory())).toBeNull()
  })
})

// ---- Arc slot: machine-level draw flow ------------------------------------

/** Four clicks: centerline start, end, through point, width point. */
function drawArcSlot(start: Vec2, end: Vec2, thru: Vec2, width: Vec2) {
  const newId = idFactory()
  const r1 = toolClick(armed('slot-arc'), start, TOL, newId)
  const r2 = toolClick(r1.state, end, TOL, newId)
  const r3 = toolClick(r2.state, thru, TOL, newId)
  const r4 = toolClick(r3.state, width, TOL, newId)
  return { r1, r2, r3, r4 }
}

describe('arc-slot tool (machine-level)', () => {
  const start = { x: 10, y: 0 }
  const thru = { x: Math.SQRT1_2 * 10, y: Math.SQRT1_2 * 10 }
  const end = { x: 0, y: 10 }
  const width = { x: 11, y: 0 } // distance 11 from center -> halfWidth 1

  it('three setup clicks chain without committing; the fourth commits', () => {
    const { r1, r2, r3, r4 } = drawArcSlot(start, end, thru, width)
    expect(r1.commit).toBeNull()
    expect(r1.state.chain).toEqual({ kind: 'slotArc', start, end: null, thru: null })
    expect(r2.commit).toBeNull()
    expect(r3.commit).toBeNull()
    expect(r3.state.chain).toEqual({ kind: 'slotArc', start, end, thru })
    expect(r4.commit).not.toBeNull()
    expect(cutArcs(r4.commit!)).toHaveLength(4)
    // Tool stays armed for the next slot.
    expect(r4.state).toEqual({ tool: 'slot-arc', chain: null })
  })

  it('width = perpendicular distance to the centerline (cap radius)', () => {
    const { r4 } = drawArcSlot(start, end, thru, width)
    const arcs = cutArcs(r4.commit!)
    const radii = arcs.map((a) => a.radius).sort((x, y) => x - y)
    // caps r=1, inner=9, outer=11 for centerRadius 10, halfWidth 1.
    expect(radii[0]).toBeCloseTo(1, 9) // cap
    expect(radii[1]).toBeCloseTo(1, 9) // cap
    expect(radii[2]).toBeCloseTo(9, 9) // inner
    expect(radii[3]).toBeCloseTo(11, 9) // outer
  })

  it('preview outline equals the committed outline (preview === commit)', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('slot-arc'), start, TOL, newId)
    const r2 = toolClick(r1.state, end, TOL, newId)
    const r3 = toolClick(r2.state, thru, TOL, newId)
    const preview = toolPreview(r3.state, width)!
    expect(preview.length).toBeGreaterThan(8)
    const commit = toolClick(r3.state, width, TOL, newId).commit!
    const arcs = cutArcs(commit)
    // Each arc's start AND end points must lie on the preview polyline.
    for (const a of arcs) {
      for (const ang of [a.startAngle, a.endAngle]) {
        const p = arcPointAt(a, ang)
        const hit = preview.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)
        expect(hit).toBe(true)
      }
    }
  })

  it('collinear through-click and zero-width click are ignored (fail-loud)', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('slot-arc'), start, TOL, newId)
    const r2 = toolClick(r1.state, end, TOL, newId)
    // A through point ON the chord (collinear) forms no arc -> ignored.
    const bad = toolClick(r2.state, { x: 5, y: 5 }, TOL, newId)
    expect(bad.commit).toBeNull()
    // (5,5) is on the chord between (10,0) and (0,10): chain unchanged.
    expect(bad.state.chain).toEqual(r2.state.chain)
    // Good through point advances; then a width click ON the centerline
    // (zero width) is ignored.
    const r3 = toolClick(r2.state, thru, TOL, newId)
    const onCenterline = toolClick(r3.state, { x: 10, y: 0 }, TOL, newId)
    expect(onCenterline.commit).toBeNull()
    expect(onCenterline.state.chain).toEqual(r3.state.chain)
  })

  it('Esc cancels the in-progress arc slot; tool stays armed', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('slot-arc'), start, TOL, newId)
    const esc = escapeTool(r1.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'slot-arc', chain: null })
  })

  it('bakes to a single CLOSED Loop2D (CAM-consumable)', () => {
    const { r4 } = drawArcSlot(start, end, thru, width)
    const result = bakeSketch(sketchOf(r4.commit!.entities, r4.commit!.constraints))
    expect(result.bakedEntities).toBe(4)
    expect(result.loops).toHaveLength(1)
    expect(result.loops[0].closed).toBe(true)
    // Closed loop = one segment per arc entity (4).
    const segs = result.loops[0].segments ?? []
    expect(segs).toHaveLength(4)
    expect(segs.every((s) => s.type === 'arc')).toBe(true)
  })

  it('C2: keeps a construction centerline arc (radius/diameter-dimensionable) + cap points', () => {
    const { r4 } = drawArcSlot(start, end, thru, width)
    const centerlineArcs = r4.commit!.entities.filter(
      (e): e is SketchArcEntity => e.kind === 'arc' && e.construction,
    )
    const points = r4.commit!.entities.filter(
      (e): e is SketchPointEntity => e.kind === 'point',
    )
    expect(centerlineArcs).toHaveLength(1)
    expect(points).toHaveLength(2)
    expect(points.every((p) => p.construction)).toBe(true)
    // Centerline arc sits at the centerline radius (10) so a radius/diameter
    // dim reads the true slot arc radius.
    expect(centerlineArcs[0].radius).toBeCloseTo(10, 9)
    expect(centerlineArcs[0].construction).toBe(true)
    // Bake still excludes everything construction/point: only the 4 cut arcs.
    expect(bakeSketch(sketchOf(r4.commit!.entities, r4.commit!.constraints)).bakedEntities).toBe(4)
  })
})
