import type { Vec2 } from '../../../types'

// ── Tool geometry ──────────────────────────────────────────────────────────────

/**
 * Convert a tool's angleFromAxisDeg to the per-side half-angle in radians.
 *
 * IMPORTANT: Tool.angleFromAxisDeg is ALREADY the half-angle measured from the tool
 * axis (per side). A 90deg V-bit is stored as 45. Cutting/depth math needs this
 * value in radians, so this helper just converts deg->rad in ONE place (NO halving).
 * Route ALL tip-angle slope math (engrave depth, chamfer xyOffset, sim profiles)
 * through this so the convention can never drift again. Default 59 = the from-axis
 * half of a 118deg included drill point.
 */
export function toolHalfAngleRad(angleFromAxisDeg: number | undefined): number {
  return (angleFromAxisDeg ?? 59) * Math.PI / 180
}

// ── Private helpers ────────────────────────────────────────────────────────────

function norm(dx: number, dy: number): Vec2 {
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1e-10) return { x: 0, y: 0 }
  return { x: dx / len, y: dy / len }
}

// ── Polygon winding and offset (from offset2d.ts) ─────────────────────────────

export function signedArea(pts: Vec2[]): number {
  let sum = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return sum / 2
}

/** Ensure the polygon is CCW (returns reversed copy if needed). */
export function ensureCCW(pts: Vec2[]): Vec2[] {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts
}

/** Ensure the polygon is CW (returns reversed copy if needed). */
export function ensureCW(pts: Vec2[]): Vec2[] {
  return signedArea(pts) > 0 ? [...pts].reverse() : pts
}

/**
 * Offset a closed polygon by `dist` mm.
 *
 * Returns the offset polygon, or undefined if the input is degenerate.
 * miterLimit caps spike length at very sharp angles (multiple of |dist|).
 */
export function offsetPolygon(
  pts: Vec2[],
  dist: number,
  miterLimit = 4
): Vec2[] | undefined {
  const n = pts.length
  if (n < 3) return undefined

  // Normalise to CCW so the outward-normal formula is consistent
  const area = signedArea(pts)
  if (Math.abs(area) < 1e-10) return undefined
  const poly = area < 0 ? [...pts].reverse() : pts

  const result: Vec2[] = []

  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n]
    const curr = poly[i]
    const next = poly[(i + 1) % n]

    // Normalised directions of incoming and outgoing edges
    const e1 = norm(curr.x - prev.x, curr.y - prev.y)
    const e2 = norm(next.x - curr.x, next.y - curr.y)

    // Outward normal of each edge for a CCW polygon = rotate edge direction -90°
    // (right-hand side of the travel direction points outside)
    const n1 = { x: e1.y, y: -e1.x }
    const n2 = { x: e2.y, y: -e2.x }

    // Turn sign: positive = left turn = convex vertex for CCW polygon
    const cross = e1.x * e2.y - e1.y * e2.x

    // Bisector of the two adjacent outward normals
    const bx = n1.x + n2.x
    const by = n1.y + n2.y
    const bLen = Math.sqrt(bx * bx + by * by)

    if (bLen < 1e-10) {
      // 180° U-turn in edge direction — bisector is degenerate, use n1 directly
      result.push({ x: curr.x + n1.x * dist, y: curr.y + n1.y * dist })
      continue
    }

    const bUnit = { x: bx / bLen, y: by / bLen }

    // Miter offset length = dist / cos(angle_between_bisector_and_edge_normal)
    const cosAngle = bUnit.x * n1.x + bUnit.y * n1.y
    if (Math.abs(cosAngle) < 1e-10) {
      // Bisector perpendicular to normal (exact 90° corner) — use bevel
      result.push({ x: curr.x + n1.x * dist, y: curr.y + n1.y * dist })
      result.push({ x: curr.x + n2.x * dist, y: curr.y + n2.y * dist })
      continue
    }

    const miterLen = dist / cosAngle
    const cap = Math.abs(dist) * miterLimit

    if (Math.abs(miterLen) > cap) {
      // Sharp corner exceeds miter limit.
      // For inward offset (dist < 0) at a convex corner (cross > 0): the miter spike points
      // toward the polygon centre. Use bevel (two points on adjacent edge normals) instead —
      // this prevents self-intersecting rings and star artifacts at the pocket centre.
      if (dist < 0 && cross > 0) {
        result.push({ x: curr.x + n1.x * dist, y: curr.y + n1.y * dist })
        result.push({ x: curr.x + n2.x * dist, y: curr.y + n2.y * dist })
      } else {
        // Concave corner or outward offset: clamp to miterLimit (correct for concave geometry)
        const clamped = Math.sign(miterLen) * cap
        result.push({ x: curr.x + bUnit.x * clamped, y: curr.y + bUnit.y * clamped })
      }
    } else {
      result.push({
        x: curr.x + bUnit.x * miterLen,
        y: curr.y + bUnit.y * miterLen,
      })
    }
  }

  return result
}

// ── Self-intersection splitter (lifted from pocket2d.ts) ──────────────────────
//
// When offsetPolygon produces a figure-8 (non-convex offsets), this splits it
// into valid CCW sub-polygons. Finds the first proper segment crossing, splits
// the loop into two sub-loops at the intersection point, and recurses, keeping
// only sub-loops with positive signed area.
//
// BYTE-STABILITY: when the input has NO self-intersection, this returns exactly
// [poly] — the same array reference, identical point values — so callers that
// offset a simple (non-self-intersecting) polygon are a true no-op.

export function splitSelfIntersections(poly: Vec2[], depth = 0): Vec2[][] {
  if (depth > 64 || poly.length < 3) return []
  const n = poly.length
  let found: { i: number; j: number; pt: Vec2 } | null = null
  outer: for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const c = poly[j], d = poly[(j + 1) % n]
      const r = segSegIntersect(a, b, c, d)
      if (r) {
        found = { i, j, pt: { x: a.x + r.t1 * (b.x - a.x), y: a.y + r.t1 * (b.y - a.y) } }
        break outer
      }
    }
  }
  if (!found) return [poly]
  const { i: i1, j: j1, pt: X } = found
  const loopA = [...poly.slice(0, i1 + 1), X, ...poly.slice(j1 + 1)]
  const loopB = [X, ...poly.slice(i1 + 1, j1 + 1)]
  const results: Vec2[][] = []
  for (const loop of [loopA, loopB]) {
    if (loop.length >= 3 && signedArea(loop) > 0)
      results.push(...splitSelfIntersections(loop, depth + 1))
  }
  return results
}

// Keep only sub-loops whose area is >= 10 % of the largest sibling.
// Eliminates spike artifacts from miter-clamped self-intersections while
// preserving all legitimate sub-regions (e.g. both arms of an L-pocket).
export function filterSubLoopsByArea(subs: Vec2[][]): Vec2[][] {
  if (subs.length <= 1) return subs
  const maxArea = subs.reduce((m, l) => Math.max(m, Math.abs(signedArea(l))), 0)
  return subs.filter(l => Math.abs(signedArea(l)) >= maxArea * 0.1)
}

/**
 * Offset an OPEN polyline perpendicular by `dist` mm.
 *
 * Endpoints are single-edge offsets (no periodic wraparound). Interior vertices
 * use the same miter / bevel / clamp math as offsetPolygon, with the right-side
 * normal (rotate edge -90°) so the sign convention matches: positive `dist`
 * offsets to the right of travel; negative `dist` to the left.
 *
 * Self-intersections introduced by concave corners tighter than `dist` are NOT
 * removed here — feed the result through pruneSelfIntersections.
 *
 * Returns an empty array if the input has fewer than 2 vertices.
 */
export function offsetOpenChain(
  pts: Vec2[],
  dist: number,
  miterLimit = 4
): Vec2[] {
  const n = pts.length
  if (n < 2) return []

  const result: Vec2[] = []

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      const e = norm(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      const nrm = { x: e.y, y: -e.x }
      result.push({ x: pts[0].x + nrm.x * dist, y: pts[0].y + nrm.y * dist })
      continue
    }
    if (i === n - 1) {
      const e = norm(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y)
      const nrm = { x: e.y, y: -e.x }
      result.push({ x: pts[n - 1].x + nrm.x * dist, y: pts[n - 1].y + nrm.y * dist })
      continue
    }

    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1]
    const e1 = norm(curr.x - prev.x, curr.y - prev.y)
    const e2 = norm(next.x - curr.x, next.y - curr.y)
    const n1 = { x: e1.y, y: -e1.x }
    const n2 = { x: e2.y, y: -e2.x }
    const cross = e1.x * e2.y - e1.y * e2.x
    const bx = n1.x + n2.x, by = n1.y + n2.y
    const bLen = Math.sqrt(bx * bx + by * by)

    if (bLen < 1e-10) {
      // 180° U-turn — bisector degenerate, use first normal
      result.push({ x: curr.x + n1.x * dist, y: curr.y + n1.y * dist })
      continue
    }

    const bUnit = { x: bx / bLen, y: by / bLen }
    const cosAngle = bUnit.x * n1.x + bUnit.y * n1.y

    if (Math.abs(cosAngle) < 1e-10) {
      result.push({ x: curr.x + n1.x * dist, y: curr.y + n1.y * dist })
      result.push({ x: curr.x + n2.x * dist, y: curr.y + n2.y * dist })
      continue
    }

    const miterLen = dist / cosAngle
    const cap = Math.abs(dist) * miterLimit

    if (Math.abs(miterLen) > cap) {
      if (dist < 0 && cross > 0) {
        // Same heuristic as offsetPolygon: bevel the convex side for inward-style offsets.
        result.push({ x: curr.x + n1.x * dist, y: curr.y + n1.y * dist })
        result.push({ x: curr.x + n2.x * dist, y: curr.y + n2.y * dist })
      } else {
        const clamped = Math.sign(miterLen) * cap
        result.push({ x: curr.x + bUnit.x * clamped, y: curr.y + bUnit.y * clamped })
      }
    } else {
      result.push({
        x: curr.x + bUnit.x * miterLen,
        y: curr.y + bUnit.y * miterLen,
      })
    }
  }

  return result
}

/**
 * Remove self-intersections ("folds") from a polyline.
 *
 * Walks segments in order; whenever segment (i, i+1) strictly crosses a later
 * segment (j, j+1) with j > i+1, the spanned vertices i+1..j are replaced
 * with the intersection point. Single forward pass; one fold collapses per
 * step. Uses segSegIntersect (strict interior crossings — endpoint contact
 * does not count as a fold).
 *
 * Returns a fresh array; may be shorter than the input. A fully collapsed
 * offset yields a 1- or 2-point result — caller treats this as "no curve".
 */
export function pruneSelfIntersections(chain: Vec2[]): Vec2[] {
  const n = chain.length
  if (n < 4) return chain.map(p => ({ x: p.x, y: p.y }))

  const result: Vec2[] = [{ x: chain[0].x, y: chain[0].y }]
  let prev: Vec2 = chain[0]
  let i = 0

  while (i < n - 1) {
    const a = prev
    const b = chain[i + 1]
    let hitJ = -1, hitT = 0

    for (let j = i + 2; j < n - 1; j++) {
      const c = chain[j], d = chain[j + 1]
      const isect = segSegIntersect(a, b, c, d)
      if (isect !== null) { hitJ = j; hitT = isect.t1; break }
    }

    if (hitJ >= 0) {
      const ipt = {
        x: a.x + hitT * (b.x - a.x),
        y: a.y + hitT * (b.y - a.y),
      }
      result.push(ipt)
      prev = ipt
      i = hitJ + 1
    } else {
      result.push({ x: b.x, y: b.y })
      prev = b
      i += 1
    }
  }

  return result
}

// ── Point-in-polygon and bounding (from adaptiveGeometry.ts) ──────────────────

export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    if (((yi > pt.y) !== (yj > pt.y)) &&
        pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

export function polygonArea(pts: Vec2[]): number {
  return Math.abs(signedArea(pts))
}

/** Bounding box of a polygon. */
export function polyBBox(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Signed distance from point to nearest edge of polygon (negative = inside). */
export function distToPolyBoundary(pt: Vec2, poly: Vec2[]): number {
  const n = poly.length
  let minDist = Infinity
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = lenSq < 1e-12 ? 0 : ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    const nx = a.x + t * dx - pt.x, ny = a.y + t * dy - pt.y
    const d = Math.sqrt(nx * nx + ny * ny)
    if (d < minDist) minDist = d
  }
  return pointInPolygon(pt, poly) ? -minDist : minDist
}

// ── Centroid and loop utilities ────────────────────────────────────────────────

// centroid: expects non-empty pts; returns { x: NaN, y: NaN } for
// empty array. All call sites validate non-empty upstream.
export function centroid(pts: Vec2[]): Vec2 {
  let sx = 0, sy = 0
  for (const p of pts) { sx += p.x; sy += p.y }
  return { x: sx / pts.length, y: sy / pts.length }
}

export interface CircleFit {
  center: Vec2
  radius: number
  /** Max absolute deviation of any sample from the fitted circle (input units). */
  residual: number
}

/**
 * Algebraic (Kasa) least-squares circle fit: minimizes sum((x-cx)^2+(y-cy)^2-r^2)^2,
 * a closed-form proxy for the true geometric fit. Unlike centroid(), the result
 * is independent of how densely each part of the loop was sampled - use this
 * (not centroid()) whenever "the center of this circular loop" is wanted.
 * Degenerate input (fewer than 3 points, collinear points, or a non-positive
 * fitted radius) returns residual: Infinity so callers can refuse on that.
 */
export function fitCircle(pts: Vec2[]): CircleFit {
  const n = pts.length
  if (n < 3) {
    return { center: n > 0 ? centroid(pts) : { x: NaN, y: NaN }, radius: NaN, residual: Infinity }
  }

  // Fit in centroid-relative coordinates: the normal equations below square
  // the coordinates, so fitting at an absolute WCS offset far from the origin
  // would badly condition the linear solve. Centering keeps accuracy uniform
  // regardless of where the loop sits in the machine coordinate system.
  const mean = centroid(pts)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0
  for (const p of pts) {
    const x = p.x - mean.x, y = p.y - mean.y, z = x * x + y * y
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
    sxz += x * z; syz += y * z; sz += z
  }

  const det3 = (
    a11: number, a12: number, a13: number,
    a21: number, a22: number, a23: number,
    a31: number, a32: number, a33: number,
  ): number =>
    a11 * (a22 * a33 - a23 * a32) -
    a12 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * a32 - a22 * a31)

  // Solve x^2+y^2+Dx+Ey+F=0's normal equations for [D,E,F] via Cramer's rule:
  //   [sxx sxy sx] [D]   [-sxz]
  //   [sxy syy sy] [E] = [-syz]
  //   [sx  sy  n ] [F]   [-sz ]
  const det = det3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n)
  if (!(Math.abs(det) > 1e-9)) {
    return { center: mean, radius: NaN, residual: Infinity }
  }

  const D = det3(-sxz, sxy, sx, -syz, syy, sy, -sz, sy, n) / det
  const E = det3(sxx, -sxz, sx, sxy, -syz, sy, sx, -sz, n) / det
  const F = det3(sxx, sxy, -sxz, sxy, syy, -syz, sx, sy, -sz) / det

  const cxRel = -D / 2, cyRel = -E / 2
  const radiusSq = cxRel * cxRel + cyRel * cyRel - F
  const center = { x: mean.x + cxRel, y: mean.y + cyRel }
  if (!(radiusSq > 0)) {
    return { center, radius: NaN, residual: Infinity }
  }
  const radius = Math.sqrt(radiusSq)

  let residual = 0
  for (const p of pts) {
    const d = Math.hypot(p.x - center.x, p.y - center.y)
    residual = Math.max(residual, Math.abs(d - radius))
  }

  return { center, radius, residual }
}

export function largestLoop(loops: Vec2[][]): Vec2[] {
  return loops.reduce((best, l) =>
    Math.abs(signedArea(l)) > Math.abs(signedArea(best)) ? l : best, loops[0])
}

export function minRadiusFrom(ring: Vec2[], pt: Vec2): number {
  return ring.reduce((best, p) => Math.min(best, Math.hypot(p.x - pt.x, p.y - pt.y)), Infinity)
}

export function minSqDistToLoop(pt: Vec2, loop: Vec2[]): number {
  return loop.reduce((best, p) => Math.min(best, (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2), Infinity)
}

// ── Segment intersection (from pocket2d.ts inline) ────────────────────────────

export function segSegIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t1: number } | null {
  const dx1 = b.x - a.x, dy1 = b.y - a.y
  const dx2 = d.x - c.x, dy2 = d.y - c.y
  const denom = dx1 * dy2 - dy1 * dx2
  if (Math.abs(denom) < 1e-10) return null
  const t1 = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom
  const t2 = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom
  if (t1 <= 1e-9 || t1 >= 1 - 1e-9 || t2 <= 1e-9 || t2 >= 1 - 1e-9) return null
  return { t1 }
}

// ── Closed-loop boundary trimming (real-geometry intersection) ────────────────
//
// Trim a near-closed analytic polyline against a CCW outer boundary and any
// CCW/CW island polygons, returning the in-region runs as open polylines. Each
// returned fragment lies entirely INSIDE the outer boundary and OUTSIDE every
// island; its endpoints — when they are not original loop vertices — are real
// segment intersection points with polygon edges (no grid quantization, no
// wall-clamping). For an analytic next-revolution loop on the L-shape with the
// seed in the convex corner, this returns roughly one fragment per uncut
// region (three on the L-shape) because the loop weaves in and out of the
// three alleys between the spiral and the outer walls.
//
// The trim treats the input as an OPEN polyline (loop.length - 1 segments).
// The wrap chord from loop[N-1] → loop[0] is a stepover-length radial that
// bridges the spiral gap; it is not real cutting geometry and is skipped.
//
// Numerical notes:
//   • Uses a private inclusive segment-segment intersection (segSegIntersect
//     above is strict — it excludes endpoints — and is unsuitable for trimming
//     where a polyline vertex may sit exactly on a polygon edge).
//   • Deduplicates intersections within ~1e-9 along the segment so a polyline
//     passing through a polygon vertex (two edges share the hit point) is
//     counted once.
//   • Anchors the walk at the first OUTSIDE vertex when one exists, so the
//     algorithm never needs a wrap-around fragment merge.

function trimSegSegT(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const dx1 = b.x - a.x, dy1 = b.y - a.y
  const dx2 = d.x - c.x, dy2 = d.y - c.y
  const denom = dx1 * dy2 - dy1 * dx2
  if (Math.abs(denom) < 1e-12) return null
  const t1 = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom
  const t2 = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom
  if (t1 < -1e-9 || t1 > 1 + 1e-9) return null
  if (t2 < -1e-9 || t2 > 1 + 1e-9) return null
  return Math.max(0, Math.min(1, t1))
}

export function trimLoopToBoundary(
  loop: Vec2[],
  boundary: Vec2[],
  islands: Vec2[][],
): Vec2[][] {
  if (loop.length < 2) return []
  const allPolys = [boundary, ...islands]

  const inRegion = (p: Vec2): boolean => {
    if (!pointInPolygon(p, boundary)) return false
    for (const isl of islands) if (pointInPolygon(p, isl)) return false
    return true
  }

  const N = loop.length

  // Anchor the walk at the first outside vertex to avoid wrap-merge.
  let startIdx = -1
  for (let k = 0; k < N; k++) {
    if (!inRegion(loop[k])) { startIdx = k; break }
  }
  if (startIdx < 0) {
    // Entire loop is interior — return a single fragment (rare; means the
    // analytic next revolution never exits the region).
    return [loop.map(p => ({ x: p.x, y: p.y }))]
  }

  const fragments: Vec2[][] = []
  let current: Vec2[] = []
  let prevInside = false  // anchored on an outside vertex

  // (N - 1) segments — skip the wrap chord (loop[N-1] → loop[0]) since the
  // analytic next-revolution loop is geometrically open (radius advances by
  // stepover over one revolution; the wrap chord is the stepover gap, not
  // real cutting geometry).
  for (let i = 1; i < N; i++) {
    const a = loop[(startIdx + i - 1) % N]
    const b = loop[(startIdx + i)     % N]

    const ts: number[] = []
    for (const poly of allPolys) {
      const m = poly.length
      for (let j = 0; j < m; j++) {
        const c = poly[j], d = poly[(j + 1) % m]
        const t = trimSegSegT(a, b, c, d)
        if (t !== null) ts.push(t)
      }
    }
    ts.sort((x, y) => x - y)
    const dedup: number[] = []
    for (const t of ts) {
      if (dedup.length === 0 || t - dedup[dedup.length - 1] > 1e-9) dedup.push(t)
    }

    for (const t of dedup) {
      const ipt = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
      if (prevInside) {
        current.push(ipt)
        if (current.length >= 2) fragments.push(current)
        current = []
      } else {
        current = [ipt]
      }
      prevInside = !prevInside
    }

    // Append vertex b only if we end the segment in-region AND b is not the
    // wrap-around back to loop[startIdx]. Skip the final wrap (i == N - 1 is
    // the last real segment because we anchored at startIdx; loop is N points
    // and we processed N - 1 segments).
    if (prevInside) current.push({ x: b.x, y: b.y })
  }

  if (current.length >= 2) fragments.push(current)
  return fragments
}

// ── Loop containment (renamed from pocket2d.ts findIslandContaining) ──────────

export function findContainingLoop(pt: Vec2, loops: Vec2[][]): number {
  for (let i = 0; i < loops.length; i++)
    if (pointInPolygon(pt, loops[i])) return i
  return -1
}

// ── Arc sampling ──────────────────────────────────────────────────────────────

export function sampleArc(
  center: Vec2,
  radius: number,
  startAngle: number,
  endAngle: number,
  direction: 'CCW' | 'CW',
  chordTolerance: number
): Vec2[] {
  const cosVal = Math.max(-1, Math.min(1, 1 - chordTolerance / radius))
  const maxStep = 2 * Math.acos(cosVal)
  let span = direction === 'CCW' ? endAngle - startAngle : startAngle - endAngle
  if (span <= 0) span += 2 * Math.PI
  const n = Math.max(1, Math.ceil(span / maxStep))
  const step = (span / n) * (direction === 'CCW' ? 1 : -1)
  const pts: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = startAngle + i * step
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
  }
  return pts
}
