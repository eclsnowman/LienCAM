// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp getEngagePoint/
// _getEngagePoint), Copyright (c) 2018 Kresimir Tusek. This file remains under
// LGPL-2.1-or-later; the LienCAM project as a whole is distributed under
// GPL-3.0-or-later (see /LICENSE).
//
// getEngagePoint: FreeCAD's outside-in "roll-in" engage-point search, in the
// FIRST-REGION (no prevPos) simplification. Given the already-cleared region (for the
// outside-in / "side entry" mode this is the OPEN STOCK EXTERIOR air), it places the
// tool CENTRE out in that cleared air just past the material edge, grazing into fresh
// material by a tiny PROTRUSION sized to the optimal cutting load. The first bite is
// therefore bounded BY CONSTRUCTION (no helix, no slot); the engine's own bite-limiting
// stepper then carries the pass inward. Returns null when no bounded engage point
// exists, so the caller can fall back to the interior helix entry (ADR-0003 named
// fallback -- never a silent no-op).
//
// PURE + DETERMINISTIC (D-006): no globals, no RNG, no time; fixed iteration order over
// the offset ring, so identical inputs give byte-identical output.

import type { AdaptiveMillingDirection } from '../../types'
import { materialSideFor } from '../../millingDirection'
import { type Pt, type Loops, offsetClosed } from './clipperEngine'
import type { ToolGeometry } from './toolGeometry'

/** Even-odd (XOR ray-cast) membership across a loop set: true iff `pt` lies in the
 *  region the loops bound (inside an outer contour and outside its holes). */
function insideLoops(pt: Pt, loops: Loops): boolean {
  let inside = false
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j]
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

/**
 * Find an outside-in roll-in engage point over the pre-cleared region `cleared`.
 *
 * @param cleared       the already-cleared region (side entry: the open stock exterior).
 * @param tool          tool geometry (cutArea / disk model).
 * @param toolRadius    mm.
 * @param optimalCutAreaPerDist  the steering setpoint (tool.optimalCutAreaPerDist,
 *                      toolGeometry.ts:63 == stepOver * fullSlotAreaPerDist).
 * @param tolerance     mm (drives the minimum sampling / trial step, MIN_STEP_CLIPPER).
 * @param stepOver      radial fraction of a FULL SLOT (the SAME meaning encoded in
 *                      optimalCutAreaPerDist above; NOT a fraction of radius).
 * @param boundLoops    the feature FOOTPRINT loops (feat boundary + holes). The engage
 *                      centre is always in AIR (outside every solid region), so the
 *                      machining-bound test dilates these by toolRadius = the locus of
 *                      centres whose tool disk can reach the footprint. This keeps the
 *                      inner ring (poking into the footprint) and rejects the outer ring
 *                      (poking into unmodelled air beyond the seed box).
 * @param arcTol        offset arc tolerance, mm.
 * @returns { pt (bounded engage centre), clearPoint (whole cutter in air),
 *            dir (initial heading) } or null.
 */
export function getEngagePoint(
  cleared: Loops,
  tool: ToolGeometry,
  toolRadius: number,
  optimalCutAreaPerDist: number,
  tolerance: number,
  stepOver: number,
  boundLoops: Loops,
  arcTol: number,
  millingDirection: AdaptiveMillingDirection = 'climb',
  // WO-1178: the caller's veto on the engage CENTRE (the tool-centre region check every other
  // tool position takes). A vetoed sample is skipped and the scan continues to the next
  // legal one, instead of the first-hit centre being refused after the fact and the whole
  // roll-in falling back to a helix. Absent, the scan is exactly the FreeCAD first-hit port.
  accept?: (pt: Pt) => boolean,
): { pt: Pt; clearPoint: Pt; dir: Pt } | null {
  if (cleared.length === 0 || boundLoops.length === 0 || !(toolRadius > 0)) return null

  const toolDiameter = 2 * toolRadius
  // stepOver is the radial fraction of a FULL SLOT (the meaning encoded in
  // optimalCutAreaPerDist = stepOver * fullSlotAreaPerDist, toolGeometry.ts:63).
  const stepOverFactor = stepOver
  const minStep = tolerance * Math.min(1, stepOverFactor * toolDiameter)
  if (!(minStep > 0)) return null

  // Sagitta model: a tangential bite of area targetArea over a half-angle theta/2 pokes
  // the tool edge in by protrusion = R*(1 - cos(theta/2)), theta = cbrt(12*A/R^2).
  const targetArea = optimalCutAreaPerDist * minStep
  const theta = Math.cbrt((12 * targetArea) / (toolRadius * toolRadius))
  const protrusion = toolRadius * (1 - Math.cos(theta / 2))
  const stepOverDistance = toolDiameter * stepOver
  // FINISHING_THICKNESS_SCALE = 0.1: keep the first poke very shallow.
  const engageProtrusion = Math.min(protrusion, stepOverDistance * 0.1)
  if (!(engageProtrusion > 0)) return null

  // Preserve the established engage ring exactly. Cross-engine stock-trace clearance
  // is added only to the separately returned clearPoint below; putting that margin in
  // this offset pair changes polygon sampling and can select a different cutting path.
  const buffer = 0

  // Tool-centre ring. Erode `cleared` so the tool fits fully inside (centre >= R from the
  // cleared boundary), then dilate back by (buffer + engageProtrusion) so the ring pokes
  // engageProtrusion into fresh material. Net: the ring sits (R - engageProtrusion)
  // OUTSIDE the material edge -- tool centre in air, tool edge grazing in.
  const preEngage = offsetClosed(cleared, -(toolRadius + buffer), arcTol)
  if (preEngage.length === 0) return null
  const engagePaths = offsetClosed(preEngage, buffer + engageProtrusion, arcTol)
  if (engagePaths.length === 0) return null

  // The engage ring is an inward dilation of preEngage. Project the selected engage
  // centre back to that original ring so callers retain both geometrically distinct
  // points: descend with the whole cutter disk clear, then consume engageProtrusion
  // laterally with the cutter side.
  const clearPointFor = (pt: Pt): Pt | null => {
    let best: Pt | null = null
    let bestD2 = Infinity
    for (const loop of preEngage) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length]
        const dx = b.x - a.x, dy = b.y - a.y
        const l2 = dx * dx + dy * dy
        const t = l2 > 1e-12
          ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2))
          : 0
        const q = { x: a.x + t * dx, y: a.y + t * dy }
        const d2 = (pt.x - q.x) ** 2 + (pt.y - q.y) ** 2
        if (d2 < bestD2) {
          best = q
          bestD2 = d2
        }
      }
    }
    if (!best) return null
    const outwardX = best.x - pt.x
    const outwardY = best.y - pt.y
    const outwardLength = Math.hypot(outwardX, outwardY)
    if (outwardLength <= 1e-12) return best
    const clearanceMargin = 2 * arcTol
    return {
      x: best.x + clearanceMargin * outwardX / outwardLength,
      y: best.y + clearanceMargin * outwardY / outwardLength,
    }
  }

  // Machining reach: the footprint dilated by toolRadius (see boundLoops doc above).
  const reach = offsetClosed(boundLoops, toolRadius, arcTol)
  if (reach.length === 0) return null

  const rejectArea = 2 * targetArea // FreeCAD safety reject: area > 2*optimal*minStep

  const materialNormalAt = (pt: Pt): Pt => {
    let best = { x: 0, y: 0, d2: Infinity }
    for (const loop of boundLoops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length]
        const dx = b.x - a.x, dy = b.y - a.y
        const l2 = dx * dx + dy * dy
        const t = l2 > 1e-12
          ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2))
          : 0
        const qx = a.x + t * dx, qy = a.y + t * dy
        const nx = qx - pt.x, ny = qy - pt.y
        const d2 = nx * nx + ny * ny
        if (d2 < best.d2) best = { x: nx, y: ny, d2 }
      }
    }
    const m = Math.hypot(best.x, best.y) || 1
    return { x: best.x / m, y: best.y / m }
  }

  // initToolDir: trial the edge tangent and its 3 cardinal rotations; among the
  // non-rejected CUTTING directions keep the one whose load is closest to optimal.
  const bestDirAt = (pt: Pt, tx: number, ty: number): Pt | null => {
    const cands: Pt[] = [
      { x: tx, y: ty },
      { x: -ty, y: tx },
      { x: -tx, y: -ty },
      { x: ty, y: -tx },
    ]
    const materialNormal = materialNormalAt(pt)
    const materialLeft = materialSideFor(millingDirection) === 'left'
    let best: { dir: Pt; err: number } | null = null
    for (const d of cands) {
      // CW-spindle rule (./millingDirection, WO-1896): climb keeps material right,
      // conventional keeps it left. cross > 0 = the material normal is on the left.
      const cross = d.x * materialNormal.y - d.y * materialNormal.x
      // Reject cross == 0 as well: that heads straight into/out of material and begins
      // as a slot, so it has no honest climb/conventional side.
      if (materialLeft ? cross <= 1e-9 : cross >= -1e-9) continue
      const to = { x: pt.x + d.x * minStep, y: pt.y + d.y * minStep }
      const { area, areaPerDist } = tool.cutArea(pt, to, cleared)
      if (!(area > 0) || area > rejectArea) continue // no cut, or the safety reject
      const err = Math.abs(areaPerDist - optimalCutAreaPerDist)
      if (best === null || err < best.err) best = { dir: d, err }
    }
    return best ? best.dir : null
  }

  // Dense-sample every ring loop at <= minStep spacing, INCLUDING each edge start vertex.
  // Return the FIRST in-bound sample that yields a valid direction (FreeCAD first-hit).
  for (const loop of engagePaths) {
    const n = loop.length
    if (n < 2) continue
    for (let i = 0; i < n; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % n]
      const ex = b.x - a.x, ey = b.y - a.y
      const L = Math.hypot(ex, ey)
      if (L < 1e-12) continue
      const tx = ex / L, ty = ey / L
      const steps = Math.max(1, Math.ceil(L / minStep))
      for (let s = 0; s < steps; s++) {
        const f = s / steps // s=0 covers the start vertex; the next edge covers b
        const pt = { x: a.x + ex * f, y: a.y + ey * f }
        if (!insideLoops(pt, reach)) continue
        if (accept && !accept(pt)) continue
        const dir = bestDirAt(pt, tx, ty)
        if (dir) {
          const clearPoint = clearPointFor(pt)
          if (clearPoint) return { pt, clearPoint, dir }
        }
      }
    }
  }
  return null
}
