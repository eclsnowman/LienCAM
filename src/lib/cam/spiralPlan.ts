// spiralPlan — the inward spiral's XY geometry, shared by every spiral consumer.
//
// planInwardSpiral plans ONE continuous outside-to-centre chain over a closed
// cutter-centre region: ordered XY samples, each with its cut/stepover role and
// an explicit topology marker. It knows nothing about Z, rapids, entries,
// feeds, the store, the worker or the post: Face (face2d) emits it at constant
// Z, and a surface consumer may drop the same samples onto a model.
//
// Offset contours are REFERENCES, never completed laps. During each revolution
// the path blends continuously from one contour into its successor. Equal
// perimeter phase preserves ordering; inserting both contours' vertex phases
// preserves corners. A topology split is explicitly a retrace of actual cut
// history to the next child's attachment, not a claimed continuation of the
// inward spiral. A plan that cannot be produced whole throws; no partial or
// substitute path is ever returned.

import { ensureCCW, polyBBox, centroid, pointInPolygon } from './geometry'
import { offsetLoop } from './face2d/clipperOffset'

type Pt = { x: number; y: number }

// Same runaway guard as Face's MAX_PASSES: the planner never returns more points.
const MAX_POINTS = 100_000

// What a sample is doing in the plan's topology:
//   entry   - the first sample (the cutter-centre start on the outer contour)
//   lap     - the explicit perimeter coverage lap of an inset region
//   band    - the blend from one offset contour into the next (the spiral proper)
//   leaf    - the trace of a leaf's last thin contour, ending at its centre
//   retrace - a return along already-cut history (between split children)
//   attach  - the hop from cut history onto a split child's outer contour
export type SpiralTopology = 'entry' | 'lap' | 'band' | 'leaf' | 'retrace' | 'attach'
export type SpiralPlanPoint = Pt & { role: 'cut' | 'stepover'; topology: SpiralTopology }

/**
 * Plan the inward spiral over `region` (a closed cutter-centre loop).
 *
 * - `pitch`: requested radial spacing; clamped to half the tool radius.
 * - `tolerance`: total fidelity budget. clipperOffset's two sagitta stages own
 *   0.005 mm of it; the spiral interpolant gets the remainder.
 * - `entryPhase`: angle (radians, about the outer contour's centroid) of the start.
 * - `direction`: 'climb' runs the outer contour CCW, 'conventional' CW.
 * - `perimeterLap`: cut one explicit perimeter coverage lap before the spiral
 *   (needed when the region is inset from the stock edge).
 *
 * Returns the ordered samples; the first is the entry point.
 */
export function planInwardSpiral(
  region: Pt[], pitch: number, toolRadius: number, tolerance: number,
  entryPhase: number, direction: 'climb' | 'conventional', perimeterLap: boolean,
): SpiralPlanPoint[] {
  const climb = direction === 'climb'
  // clipperOffset's two sagitta stages total 0.005 mm (CAM-14-R1).
  // Allocate only the REMAINDER to the spiral interpolant's chord error.
  // This capability bound is Spiral-only; existing Face routes are unchanged.
  const chordTolerance = tolerance - 0.005
  if (!Number.isFinite(chordTolerance) || chordTolerance <= 0)
    throw new Error('Face: Inward spiral needs tolerance above the offset reference fidelity of 0.005 mm; nothing was generated.')
  // Half-radius pitch leaves overlap for polygon corners and the continuously
  // changing contour phase. No R+sampling allowance is a coverage guarantee.
  const step = Math.min(pitch, toolRadius / 2)
  const budget = { n: 5000 }
  const root = buildRegionTree(region, step, 0, budget)
  if (budget.n <= 0)
    throw new Error('Face: Inward spiral exceeds the contour budget; no partial path was generated.')
  const outer = orientedRing(root.rings[0], climb)
  const entry = nearestAngleIdx(outer, centroid(outer), entryPhase)
  const start = outer[entry]
  const path: SpiralPlanPoint[] = [{ ...start, role: 'cut', topology: 'entry' }]
  const append = (point: Pt, topology: SpiralTopology, role: 'cut' | 'stepover' = 'cut') => {
    const last = path[path.length - 1]
    if (Math.hypot(point.x - last.x, point.y - last.y) < 1e-8) return
    // Partition at EVERY edge crossing; five point samples cannot establish
    // containment across a narrow notch (the withdrawn diagram's failure).
    if (!spiralSegmentInside(last, point, region))
      throw new Error('Face: Inward spiral contour correspondence crosses the cutter-centre boundary; no substitute path was generated.')
    path.push({ x: point.x, y: point.y, role, topology })
    if (path.length > MAX_POINTS)
      throw new Error('Face: Inward spiral exceeds the path point budget; no partial path was generated.')
  }
  // An inset centre domain leaves edge stock reachable ONLY from its boundary
  // (a tangent R disc cannot reach it after blending inward). Cut ONE explicit
  // perimeter coverage lap before the spiral, without widening that domain.
  // This is a boundary pass, not a concentric-ring substitute for the spiral.
  // Non-inset/default Outside paths retain their original no-closed-lap geometry.
  if (perimeterLap) {
    const perimeter = spiralContour(root.rings[0], start, climb)
    for (const point of perimeter.points.slice(1)) append(point, 'lap')
  }
  const visit = (node: RegionNode): void => {
    let previous = spiralContour(node.rings[0], path[path.length - 1], climb)
    for (let ri = 1; ri < node.rings.length; ri++) {
      const next = spiralContour(node.rings[ri], previous.points[0], climb)
      // Linear phase gives an Archimedean pitch on circles, instead of a
      // constant-radius full lap followed by a radial link. The union of phase
      // knots avoids replacing a polygon corner with an uncontrolled chord.
      const phases = new Set([0, 1, ...previous.phases, ...next.phases])
      const count = Math.max(16, Math.ceil(Math.max(previous.length, next.length) / 0.5))
      for (let k = 1; k < count; k++) phases.add(k / count)
      const ordered = [...phases].sort((a, b) => a - b).filter(t => t > 0)
      const interpolate = (nearest: boolean): Pt[] => {
        let innerPhase = 0
        const knots = [{ t: 0, u: 0 }, ...ordered.map(t => {
          const a = contourAt(previous, t)
          innerPhase = nearest && t < 1
            ? spiralCorrespondence(a, next, innerPhase, Math.min(1, t + 0.1), previous.points)
            : t
          return { t, u: innerPhase }
        })]
        const result: Pt[] = []
        for (let i = 1; i < knots.length; i++) {
          const from = knots[i - 1], to = knots[i]
          // Also split wherever the INNER correspondence crosses a vertex.
          // Between these knots BOTH references are affine, so their blend
          // is quadratic. Its maximum chord deviation occurs at the midpoint.
          const phases = [from.t, ...next.phases.filter(u => u > from.u && u < to.u)
            .map(u => from.t + (to.t - from.t) * (u - from.u) / (to.u - from.u)), to.t]
          const evaluate = (t: number): Pt => {
            const u = from.u + (to.u - from.u) * (t - from.t) / (to.t - from.t)
            const a = contourAt(previous, t), b = contourAt(next, u)
            return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          }
          const refine = (lo: number, hi: number, a: Pt, b: Pt): void => {
            const mid = (lo + hi) / 2, p = evaluate(mid)
            const deviation = Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2)
            if (deviation > chordTolerance) {
              if (mid === lo || mid === hi)
                throw new Error('Face: Inward spiral chord tolerance exceeds numeric precision; nothing was generated.')
              refine(lo, mid, a, p); refine(mid, hi, p, b)
            } else {
              result.push(b)
              if (result.length > MAX_POINTS)
                throw new Error('Face: Inward spiral exceeds the path point budget; no partial path was generated.')
            }
          }
          for (let k = 1; k < phases.length; k++)
            refine(phases[k - 1], phases[k], evaluate(phases[k - 1]), evaluate(phases[k]))
        }
        return result
      }
      // On convex wavefronts, nearest-normal correspondence avoids the
      // outward corner excursions caused by equal-perimeter phase (WO-2954).
      // Concave runs retain equal phase unless a certified neck needs matching.
      const convex = previous.points.every((b, i, pts) => {
        const a = pts[(i + pts.length - 1) % pts.length], c = pts[(i + 1) % pts.length]
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        return climb ? cross >= -1e-6 : cross <= 1e-6
      })
      let band = interpolate(convex)
      if (band.some((p, i) => !spiralSegmentInside(i ? band[i - 1] : path[path.length - 1], p, region)))
        band = interpolate(true)
      for (const point of band) append(point, 'band')
      previous = next
    }
    if (node.children.length === 0) {
      // The offset wavefront can collapse to a LONG ridge, not a disc. Trace
      // the last thin contour with an open end gap < R/4, then the centre when
      // visible. Collapsing the whole last lap to its centroid misses ridge ends.
      const endPhase = Math.max(0, 1 - toolRadius / (4 * previous.length))
      const count = Math.max(1, Math.ceil(previous.length * endPhase / 0.5))
      const phases = new Set([endPhase, ...previous.phases.filter(t => t <= endPhase)])
      for (let k = 1; k < count; k++) phases.add(endPhase * k / count)
      for (const t of [...phases].sort((a, b) => a - b)) if (t > 0) append(contourAt(previous, t), 'leaf')
      const centre = centroid(node.rings[node.rings.length - 1])
      if (spiralSegmentInside(path[path.length - 1], centre, node.rings[node.rings.length - 1])) append(centre, 'leaf')
      return
    }
    // Each child's attachment must be within one cutter radius of ACTUAL cut
    // history, with its entire link inside the final parent contour. Visiting
    // siblings retraces this history verbatim, so a concave divider cannot be
    // crossed by an invented straight link. These moves are marked 'stepover'.
    const parentEnd = path.length - 1
    const parent = node.rings[Math.max(0, node.rings.length - 2)]
    const children = [...node.children].sort((a, b) => {
      const aa = polyBBox(a.rings[0]), bb = polyBBox(b.rings[0])
      return aa.minX - bb.minX || aa.minY - bb.minY
    })
    for (const child of children) {
      let best: { index: number; point: Pt; distance: number } | undefined
      for (const point of child.rings[0]) for (let index = 0; index <= parentEnd; index++) {
        const from = path[index]
        const distance = Math.hypot(point.x - from.x, point.y - from.y)
        if (distance > toolRadius || (best && distance >= best.distance)) continue
        if (spiralSegmentInside(from, point, parent)) best = { index, point, distance }
      }
      if (!best)
        throw new Error('Face: Inward spiral split has no contained attachment within the previously swept cutter band; no substitute path was generated.')
      const history = path.slice(best.index, parentEnd + 1)
      // Return from the preceding child along its own emitted moves to parent.
      if (path.length - 1 > parentEnd) {
        const childHistory = path.slice(parentEnd)
        for (let k = childHistory.length - 2; k >= 0; k--) append(childHistory[k], 'retrace', 'stepover')
      }
      for (let k = history.length - 2; k >= 0; k--) append(history[k], 'retrace', 'stepover')
      append(best.point, 'attach', 'stepover')
      visit(child)
    }
  }
  visit(root)
  return path
}

// ── Contour-parallel offset tree (handles concave / branched regions) ──────────
// A node is a RUN of nested rings that do NOT split, then `children` where the run
// pinches into sub-regions under inward offset. Built with clipper2 (offsetInward),
// which returns MULTIPLE disjoint loops when a concave region splits — so a slot/
// notch becomes two child sub-regions instead of one self-crossing ring. This is
// the recursive offset-tree that replaces the single-region ring generator.
export type RegionNode = { rings: Pt[][]; children: RegionNode[] }

// Build the offset tree from one outer loop. Iterative along each non-splitting
// run (so recursion depth = number of splits, not ring count); `budget` caps the
// total ring count across the whole tree.
export function buildRegionTree(loop: Pt[], step: number, minArea: number, budget: { n: number }): RegionNode {
  const rings: Pt[][] = [ensureCCW([...loop]) as Pt[]]
  let current = rings[0]
  while (budget.n-- > 0) {
    const inner = offsetLoop(current, -step, minArea).map(l => ensureCCW(l) as Pt[])
    if (inner.length === 0) return { rings, children: [] }
    if (inner.length === 1) { rings.push(inner[0]); current = inner[0]; continue }
    return { rings, children: inner.map(l => buildRegionTree(l, step, minArea, budget)) }
  }
  return { rings, children: [] }
}

function orientedRing(ring: Pt[], climb: boolean): Pt[] {
  const ccw = ensureCCW([...ring]) as Pt[]
  return climb ? ccw : [...ccw].reverse() as Pt[]
}

type SpiralContour = { points: Pt[]; phases: number[]; length: number }
function spiralContour(loop: Pt[], anchor: Pt, climb: boolean): SpiralContour {
  const ring = orientedRing(loop, climb)
  // Put the seam on the nearest EDGE projection, not a vertex that jumps as
  // offsets gain/lose round-join vertices. This also makes consecutive laps meet.
  let best = Infinity, edge = 0, seam = ring[0]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((anchor.x - a.x) * dx + (anchor.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const p = { x: a.x + t * dx, y: a.y + t * dy }
    const distance = Math.hypot(anchor.x - p.x, anchor.y - p.y)
    if (distance < best) { best = distance; edge = i; seam = p }
  }
  const points = [seam, ...ring.slice(edge + 1), ...ring.slice(0, edge + 1), seam]
  const phases = [0]
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    phases.push(length)
  }
  return { points, phases: phases.map(s => s / length), length }
}
function spiralCorrespondence(point: Pt, contour: SpiralContour, minimum: number, maximum: number, parent: Pt[]): number {
  let best = Infinity, phase = minimum
  for (let i = 1; i < contour.points.length; i++) {
    if (contour.phases[i] < minimum || contour.phases[i - 1] > maximum) continue
    const a = contour.points[i - 1], b = contour.points[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const low = Math.max(0, (minimum - contour.phases[i - 1]) / (contour.phases[i] - contour.phases[i - 1] || 1))
    const high = Math.min(1, (maximum - contour.phases[i - 1]) / (contour.phases[i] - contour.phases[i - 1] || 1))
    const t = Math.max(low, Math.min(high, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const candidate = { x: a.x + t * dx, y: a.y + t * dy }
    const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
    if (distance < best && spiralSegmentInside(point, candidate, parent)) {
      best = distance
      phase = contour.phases[i - 1] + t * (contour.phases[i] - contour.phases[i - 1])
    }
  }
  if (!Number.isFinite(best))
    throw new Error('Face: Inward spiral has no ordered visible contour correspondence at this neck; no substitute path was generated.')
  return phase
}

function contourAt(contour: SpiralContour, phase: number): Pt {
  const { points, phases } = contour
  let i = 1
  while (i < phases.length - 1 && phases[i] < phase) i++
  const t = (phase - phases[i - 1]) / (phases[i] - phases[i - 1] || 1)
  return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
    y: points[i - 1].y + (points[i].y - points[i - 1].y) * t }
}

function spiralSegmentInside(a: Pt, b: Pt, loop: Pt[]): boolean {
  const inside = (p: Pt) => pointInPolygon(p, loop) || distanceToLoop(p, loop) <= BOUNDARY_TOL_MM
  if (!inside(a) || !inside(b)) return false
  const dx = b.x - a.x, dy = b.y - a.y
  const ts = [0, 1]
  for (let i = 0; i < loop.length; i++) {
    const c = loop[i], d = loop[(i + 1) % loop.length]
    const ex = d.x - c.x, ey = d.y - c.y
    const cross = dx * ey - dy * ex
    if (Math.abs(cross) < 1e-12) continue
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t)
  }
  ts.sort((x, y) => x - y)
  for (let i = 1; i < ts.length; i++) {
    const t = (ts[i - 1] + ts[i]) / 2
    if (!inside({ x: a.x + t * dx, y: a.y + t * dy })) return false
  }
  return true
}

// Shortest distance from `p` to the closed polyline `loop` (sign-free).
export const BOUNDARY_TOL_MM = 1e-6
export function distanceToLoop(p: Pt, loop: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    const qx = a.x + t * dx, qy = a.y + t * dy
    const d = Math.hypot(p.x - qx, p.y - qy)
    if (d < best) best = d
  }
  return best
}

export function nearestAngleIdx(ring: Pt[], c: Pt, ang: number): number {
  let best = 0, bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = Math.atan2(ring[i].y - c.y, ring[i].x - c.x)
    let d = Math.abs(a - ang) % (2 * Math.PI)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}
