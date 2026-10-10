import type { Loop2D, LoopSegment, Vec2 } from '../../types'

export interface OptimizerOptions {
  tolerance: number            // mm — applies to both arc and line fitting
  minArcPoints?: number        // minimum consecutive points to form an arc (default 4)
  resampleStep?: number        // mm arc-length between display sample points (default 0.5)
  projectionTolerance?: number // original DP tolerance used when creating the points (for density check)
}

// ── Circle math ───────────────────────────────────────────────────────────────

function circumcircle(p1: Vec2, p2: Vec2, p3: Vec2): { cx: number; cy: number; r: number } | null {
  const ax = p2.x - p1.x, ay = p2.y - p1.y
  const bx = p3.x - p1.x, by = p3.y - p1.y
  const D = 2 * (ax * by - ay * bx)
  if (Math.abs(D) < 1e-10) return null
  const ux = (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / D
  const uy = (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / D
  return { cx: p1.x + ux, cy: p1.y + uy, r: Math.hypot(ux, uy) }
}

function circleMaxErr(pts: Vec2[], cx: number, cy: number, r: number): number {
  let max = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)
    if (d > max) max = d
  }
  return max
}

// Max distance between a chord (the straight edge pts[k]→pts[k+1]) and the
// circle it subtends. circleMaxErr() only inspects the CORNERS; every point
// BETWEEN two on-circle corners sags inward by r - sqrt(r^2 - c^2/4) for a
// chord of length c. A vertex-only test accepted an R10 octagon (sag 0.76 mm)
// and turned it into a true circle 0.76 mm off its edges (WO-1899). With
// closed=true the closing edge pts[n-1]→pts[0] is checked too. A fit is only
// valid when both circleMaxErr and this stay within tolerance.
function edgeSagMax(pts: Vec2[], closed: boolean, cx: number, cy: number, r: number): number {
  const n = pts.length
  if (n < 2) return 0
  let max = 0
  const edgeCount = closed ? n : n - 1
  for (let k = 0; k < edgeCount; k++) {
    const a = pts[k], b = pts[(k + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-20 ? 0 : Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / len2))
    const fx = a.x + t * dx, fy = a.y + t * dy
    const d = Math.abs(Math.hypot(cx - fx, cy - fy) - r)
    if (d > max) max = d
  }
  return max
}

// Unwrap angle sequence to remove 2π discontinuities
function unwrapAngles(raw: number[]): number[] {
  const out = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    let d = raw[i] - out[i - 1]
    while (d > Math.PI)  d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    out.push(out[i - 1] + d)
  }
  return out
}

// Check monotonicity and return arc direction (null = not a valid arc traversal)
function arcDirection(pts: Vec2[], cx: number, cy: number): { clockwise: boolean; sweep: number } | null {
  const raw = pts.map(p => Math.atan2(p.y - cy, p.x - cx))
  const uw = unwrapAngles(raw)
  const sweep = uw[uw.length - 1] - uw[0]
  if (Math.abs(sweep) < 1e-4) return null
  const cw = sweep < 0
  const noiseThresh = 8 * Math.PI / 180  // allow 8° noise per step
  for (let i = 1; i < uw.length; i++) {
    const d = uw[i] - uw[i - 1]
    if (cw ? d > noiseThresh : d < -noiseThresh) return null
  }
  return { clockwise: cw, sweep }
}

// Sample a circular arc as dense display points. Signed sweep: positive =
// CCW, negative = CW. Returns points AFTER the start angle (the caller
// pushes the start point itself). Exported for reuse by the sketch bake
// (Loop2D.points densification at the same 0.5 mm step as DXF import).
export function sampleArc(cx: number, cy: number, r: number, startAngle: number, sweep: number, stepMm: number): Vec2[] {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) * r / stepMm))
  const pts: Vec2[] = []
  for (let i = 1; i <= n; i++) {
    const a = startAngle + sweep * (i / n)
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

// Perpendicular distance from point p to segment a→b
function perpDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-20) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

function signedArea(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

// ── Core optimizer ────────────────────────────────────────────────────────────

function optimizePoints(
  pts: Vec2[],
  closed: boolean,
  tol: number,
  minArcPts: number,
  resampleStep: number,
  projTol: number,
): { points: Vec2[]; segments: LoopSegment[] } {
  const n = pts.length
  if (n < 3) {
    return { points: pts, segments: pts.slice(1).map(to => ({ type: 'line' as const, to })) }
  }

  // ── Full-circle detection (closed loops only) ────────────────────────────
  if (closed && n >= 8) {
    const i1 = Math.floor(n / 3), i2 = Math.floor(2 * n / 3)
    const cc = circumcircle(pts[0], pts[i1], pts[i2])
    if (cc && cc.r > 0.01 && circleMaxErr(pts, cc.cx, cc.cy, cc.r) <= tol
        && edgeSagMax(pts, true, cc.cx, cc.cy, cc.r) <= tol) {
      const cw = signedArea(pts) < 0
      const startAngle = Math.atan2(pts[0].y - cc.cy, pts[0].x - cc.cx)
      const sweep = cw ? -2 * Math.PI : 2 * Math.PI
      const sampled = sampleArc(cc.cx, cc.cy, cc.r, startAngle, sweep, resampleStep)
      const seg: LoopSegment = {
        type: 'arc', to: pts[0],
        center: { x: cc.cx, y: cc.cy }, radius: cc.r, clockwise: cw,
      }
      return { points: [pts[0], ...sampled], segments: [seg] }
    }
  }

  // ── Greedy arc/line segmentation ─────────────────────────────────────────
  const segs: LoopSegment[] = []
  const newPts: Vec2[] = [pts[0]]
  let i = 0

  while (i < n - 1) {
    let handled = false

    // Try arc: need at least minArcPts points
    if (i + minArcPts <= n - 1) {
      const endMin = i + minArcPts - 1
      const midMin = i + Math.floor(minArcPts / 2)
      const cc = circumcircle(pts[i], pts[midMin], pts[endMin])

      if (cc && cc.r > 0.01 && cc.r < 100000) {
        const initErr = circleMaxErr(pts.slice(i, endMin + 1), cc.cx, cc.cy, cc.r)
        const initSag = edgeSagMax(pts.slice(i, endMin + 1), false, cc.cx, cc.cy, cc.r)

        if (initErr <= tol && initSag <= tol) {
          const initDir = arcDirection(pts.slice(i, endMin + 1), cc.cx, cc.cy)

          if (initDir) {
            // Extend arc window while new points fit the SAME circle
            let j = endMin
            while (j + 1 < n) {
              const np = pts[j + 1]
              if (Math.abs(Math.hypot(np.x - cc.cx, np.y - cc.cy) - cc.r) > tol) break
              // The new chord must stay on the circle too, not only its far endpoint.
              if (edgeSagMax([pts[j], np], false, cc.cx, cc.cy, cc.r) > tol) break
              const dir = arcDirection(pts.slice(i, j + 2), cc.cx, cc.cy)
              if (!dir) break
              j++
            }

            const dir = arcDirection(pts.slice(i, j + 1), cc.cx, cc.cy)!
            const startAngle = Math.atan2(pts[i].y - cc.cy, pts[i].x - cc.cx)

            // Density check: after DP simplification at projTol, consecutive points on a
            // smooth arc are ~sqrt(8·r·projTol) mm apart. Piecewise-linear chamfers
            // accidentally coincide with a large circumcircle but have far fewer points
            // than a genuine smooth arc would. Reject when actual interval count falls
            // below half the geometric expectation.
            const interpointDist = Math.sqrt(8 * cc.r * projTol)
            const expectedIntervals = (cc.r * Math.abs(dir.sweep)) / interpointDist
            const actualIntervals = j - i
            if (actualIntervals >= 0.5 * Math.max(minArcPts - 1, expectedIntervals)) {
              segs.push({
                type: 'arc', to: pts[j],
                center: { x: cc.cx, y: cc.cy }, radius: cc.r, clockwise: dir.clockwise,
              })
              newPts.push(...sampleArc(cc.cx, cc.cy, cc.r, startAngle, dir.sweep, resampleStep))
              i = j
              handled = true
            }
            // else: fall through to line detection
          }
        }
      }
    }

    // Fall back to line: greedily merge collinear points
    if (!handled) {
      let j = i + 1
      while (j + 1 < n) {
        // Check if all pts[i+1..j] lie on line pts[i]→pts[j+1]
        const a = pts[i], b = pts[j + 1]
        let maxErr = 0
        for (let k = i + 1; k <= j; k++) {
          const e = perpDist(pts[k], a, b)
          if (e > maxErr) maxErr = e
        }
        if (maxErr > tol) break
        j++
      }
      segs.push({ type: 'line', to: pts[j] })
      newPts.push(pts[j])
      i = j
    }
  }

  return { points: newPts, segments: segs }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function optimizeLoops(loops: Loop2D[], options: OptimizerOptions): Loop2D[] {
  const tol       = options.tolerance
  const minArcPts = options.minArcPoints       ?? 4
  const resample  = options.resampleStep       ?? 0.5
  const projTol   = options.projectionTolerance ?? tol * 2

  return loops.map(loop => {
    if (loop.points.length < 4) return loop
    const { points, segments } = optimizePoints(
      loop.points, loop.closed, tol, minArcPts, resample, projTol
    )
    const area = Math.abs(signedArea(points))
    return { ...loop, points, segments, area }
  })
}
