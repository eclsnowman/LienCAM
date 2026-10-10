// CAM-14 Phase C — standing no-violation gate for the D-shape corner gouge/facet
// defect (Operator's T-SKC48-DSHAPE finding, coordination/work-orders/CAM-14.md).
// CAN-FAIL, stays forever: RED on the pre-fix clipperOffset.ts tolerances, GREEN
// on the fix (see the mutation proof under coordination/evidence/CAM-14/).
//
// Reference profile: ANALYTIC (ellipse/circle sampled at 0.01mm chord + the exact
// chord line), NEVER the baked polyline — a baked-polyline reference is a PROXY
// that would mask exactly the defect class this gate exists to catch (WORKER
// CHARTER rule 3; CAM-14 Phase A measured the baked polyline's own deviation at
// ~0.0009mm, two orders of magnitude below the corner defect — it cannot see it).
//
// Curve-general proof (C2, WO premise P4): C1 (ellipse) and C2 (circle) share the
// SAME reference-curve math (a circle is an ellipse with majorRadius===minorRadius)
// and the SAME assertNoViolation() gate function — nothing here is ellipse-special-
// cased, proving the production fix (src/lib/cam/face2d/clipperOffset.ts) isn't
// either.

import { describe, it, expect } from 'vitest'
import { bakeSketch } from '../../lib/sketch/bake'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { pointInPolygon } from '../../lib/cam/geometry'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

await ensureClipperReady()

type Pt = { x: number; y: number }

// ── D-shape fixture builders (curve-general: ellipse OR circle via a===b) ──────
function sketch(entities: SketchEntity[]): Sketch {
  return { id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}
const lineEntity = (id: string, ax: number, ay: number, bx: number, by: number): SketchEntity => ({
  id, kind: 'line', construction: false, start: { x: ax, y: ay }, end: { x: bx, y: by },
})
const ellipticalArcEntity = (id: string, a: number, b: number, s: number, e: number): SketchEntity => ({
  id, kind: 'elliptical-arc', construction: false,
  center: { x: 0, y: 0 }, majorRadius: a, minorRadius: b, rotation: 0, startParam: s, endParam: e,
})
const circularArcEntity = (id: string, r: number, s: number, e: number): SketchEntity => ({
  id, kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: r, startAngle: s, endAngle: e,
})
function ellipsePt(a: number, b: number, t: number): Pt { return { x: a * Math.cos(t), y: b * Math.sin(t) } }

function dShapeLoops(a: number, b: number, kind: 'ellipse' | 'circle'): LoopData[] {
  const start = ellipsePt(a, b, 0)
  const end = ellipsePt(a, b, Math.PI)
  const arc = kind === 'ellipse' ? ellipticalArcEntity('ea', a, b, 0, Math.PI) : circularArcEntity('ca', a, 0, Math.PI)
  return bakeSketch(sketch([arc, lineEntity('chord', end.x, end.y, start.x, start.y)])).loops as unknown as LoopData[]
}

// ── Analytic TRUE PROFILE (0.01mm chord ellipse/circle arc + exact chord line) ──
// Mirrors CAM-14 Phase A (coordination/evidence/CAM-14/phase-a-measure.ts) exactly.
function ellipsePerimeterApprox(a: number, b: number): number {
  const h = ((a - b) ** 2) / ((a + b) ** 2)
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}
function trueProfile(a: number, b: number): { profile: Pt[]; start: Pt; end: Pt } {
  const FINE_STEP_MM = 0.01
  const halfPerimeter = ellipsePerimeterApprox(a, b) / 2 // arc t:0..PI is exactly half the perimeter (point-symmetry)
  const n = Math.max(64, Math.ceil(halfPerimeter / FINE_STEP_MM))
  const profile: Pt[] = []
  for (let i = 0; i <= n; i++) profile.push(ellipsePt(a, b, (Math.PI * i) / n))
  return { profile, start: ellipsePt(a, b, 0), end: ellipsePt(a, b, Math.PI) }
}
function nearestOnProfile(p: Pt, profile: Pt[]): { dist: number; at: Pt } {
  const n = profile.length
  let minDist = Infinity
  let at: Pt = profile[0]
  for (let i = 0; i < n; i++) {
    const a = profile[i], b = profile[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = lenSq < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    const qx = a.x + t * dx, qy = a.y + t * dy
    const d = Math.hypot(qx - p.x, qy - p.y)
    if (d < minDist) { minDist = d; at = { x: qx, y: qy } }
  }
  return { dist: minDist, at }
}
// Signed clearance of a tool-center point from the true profile, minus toolRadius:
// negative = the tool gouges into material at this point. WO-defined equivalent of
// point-to-ideal-offset-curve distance (holds through the D-shape's two CONVEX
// corners — every point on the ideal round-join fillet sits exactly toolRadius from
// the corner vertex, which IS the true profile's nearest point there).
function clearance(p: Pt, profile: Pt[], toolRadius: number): number {
  const { dist } = nearestOnProfile(p, profile)
  return (pointInPolygon(p, profile) ? -dist : dist) - toolRadius
}
function nearestCornerArcDist(p: Pt, profile: Pt[], start: Pt, end: Pt): number {
  const { at } = nearestOnProfile(p, profile)
  return Math.min(Math.hypot(at.x - start.x, at.y - start.y), Math.hypot(at.x - end.x, at.y - end.y))
}
function segmentMidpoints(pts: Pt[]): Pt[] {
  const mids: Pt[] = []
  for (let i = 0; i + 1 < pts.length; i++) mids.push({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 })
  return mids
}

// ── Shared toolpath fixture plumbing (mirrors loop-consumer-census.test.ts) ────
// CAM-14-R1: tool diameter is a PARAMETER, not a fixed constant — the audit's
// blocker finding was that a gate hard-coded to one 6mm tool cannot catch a
// tolerance that only breaks at small radii (the R0 fix passed at 6mm and
// gouged -0.0198mm at 0.5mm). C1/C2 below run at BOTH the original 6mm case
// and the auditor's constructed 0.5mm adversarial case.
function makeTool(diameterMm: number): Tool {
  return {
    id: 't1', name: `O${diameterMm} flat`, type: 'flat_end_mill',
    diameter: diameterMm, fluteLength: 20, shankDiameter: Math.min(diameterMm, 6), overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
  } as Tool
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
function contourPayload(loops: LoopData[], toolDiameterMm: number): ContourWorkerPayload {
  return {
    opId: 'op', setupId: 's',
    params: { geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs: false } as ContourParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: makeTool(toolDiameterMm), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

// C1/C2: every vertex AND every segment midpoint of the finish cutting pass clears
// the analytic true profile by >= minClearanceMm. CAM-14-R1 measured the shared
// clipperOffset.ts fidelity fix's post-fix worst case at -0.003691mm (6mm tool)
// down to -0.0025mm (radii <=1mm) across a tool-diameter sweep from 6mm to
// 0.25mm (coordination/evidence/CAM-14/r1/RADIUS-SWEEP.md) — comfortably inside
// the WO-stated -0.005mm gate with no hairline-flake risk, so -0.005mm is
// asserted LITERALLY, not loosened with slush (WORKER CHARTER / WO R1.2).
function assertNoViolation(a: number, b: number, kind: 'ellipse' | 'circle', toolDiameterMm: number, minClearanceMm: number) {
  const { profile } = trueProfile(a, b)
  const toolRadius = toolDiameterMm / 2
  const moves = buildContourToolpath(contourPayload(dShapeLoops(a, b, kind), toolDiameterMm))
  const cutPts = moves.filter(m => m.role === 'cut').map(m => ({ x: m.x, y: m.y }))
  expect(cutPts.length, 'no cutting moves emitted').toBeGreaterThan(0)
  let worst = Infinity
  let worstAt: Pt = cutPts[0]
  for (const p of [...cutPts, ...segmentMidpoints(cutPts)]) {
    const c = clearance(p, profile, toolRadius)
    if (c < worst) { worst = c; worstAt = p }
  }
  expect(worst, `worst signed clearance ${worst.toFixed(4)}mm at (${worstAt.x.toFixed(3)}, ${worstAt.y.toFixed(3)}), tool diameter ${toolDiameterMm}mm`)
    .toBeGreaterThanOrEqual(minClearanceMm)
}

describe('Contour no-violation gate (CAM-14) — C1 elliptical D-shape', () => {
  it('exterior finish contour never gouges into material at the arc/chord corner (6mm tool)', () => {
    assertNoViolation(20, 10, 'ellipse', 6, -0.005)
  })
  // CAM-14-R1: the auditor's constructed adversarial case — a 0.5mm tool (the
  // R0 fix's own claimed minimum-radius floor, MIN_ROUND_JOIN_RADIUS_MM=0.25mm
  // corner radius) gouged -0.0198mm on R0's min-spacing decimator despite the
  // 6mm case passing. The sagitta-bounded decimate() this WO adds is radius-
  // independent by construction, so this MUST pass at the same -0.005mm gate.
  it('exterior finish contour never gouges into material at the arc/chord corner (0.5mm tool, small-radius adversarial case)', () => {
    assertNoViolation(20, 10, 'ellipse', 0.5, -0.005)
  })
})

describe('Contour no-violation gate (CAM-14) — C2 circular-arc D-shape (curve-general proof)', () => {
  it('the SAME gate on a circular-arc + line corner also passes (not ellipse-specific) (6mm tool)', () => {
    assertNoViolation(15, 15, 'circle', 6, -0.005)
  })
  it('the SAME gate on a circular-arc + line corner also passes (0.5mm tool, small-radius adversarial case)', () => {
    assertNoViolation(15, 15, 'circle', 0.5, -0.005)
  })
})

describe('Contour no-violation gate (CAM-14) — C3 facet bound near the corner', () => {
  it('max sagitta of finish-path segments near the corner stays within the fix\'s fidelity bound', () => {
    const a = 20, b = 10
    const toolDiameterMm = 6
    const { profile, start, end } = trueProfile(a, b)
    const moves = buildContourToolpath(contourPayload(dShapeLoops(a, b, 'ellipse'), toolDiameterMm))
    const cutPts = moves.filter(m => m.role === 'cut').map(m => ({ x: m.x, y: m.y }))
    let maxSagitta = -Infinity
    let maxAt: Pt = cutPts[0]
    for (let i = 0; i + 1 < cutPts.length; i++) {
      const p1 = cutPts[i], p2 = cutPts[i + 1]
      const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      // Within 5mm of a corner (along the boundary, not raw Euclidean — see CAM-14
      // Phase A for why): the round-join fillet region where Operator's screenshot shows
      // both the visible facets AND the violation ("cutting these corners causes the
      // violation into the part" — the two symptoms are the SAME underlying chord-vs-
      // curve deviation, not separate defects).
      if (nearestCornerArcDist(m, profile, start, end) <= 5) {
        const sag = Math.max(0, -clearance(m, profile, toolDiameterMm / 2))
        if (sag > maxSagitta) { maxSagitta = sag; maxAt = m }
      }
    }
    expect(maxSagitta, 'no corner-adjacent segments found to measure').toBeGreaterThan(-Infinity)
    // CAM-14-R1: bound tied to the fix's own CORNER_FIDELITY_MM=0.005mm design
    // ceiling (clipperOffset.ts), asserted literally per the WO's no-slush rule —
    // facet sagitta and -clearance at a chord midpoint are the same underlying
    // quantity (C1/C2's docstring), so this is the same -0.005mm bound as C1/C2's
    // gate, not an independently chosen number. Fails hard on the pre-fix
    // ~0.0999mm and on R0's fixed-but-still-broken ~0.0198mm (0.5mm tool).
    expect(maxSagitta, `max corner-adjacent facet sagitta ${maxSagitta.toFixed(4)}mm at (${maxAt.x.toFixed(3)}, ${maxAt.y.toFixed(3)})`)
      .toBeLessThanOrEqual(0.005)
  })
})
