/* Low-level 2D geometry helpers for the orbiting-method NFP.
 *
 * PORTED from the vendored SVGnest geometry core
 * (vendored/svgnest-geometryutil.reference.js.txt, pinned commit
 * 1248dc21efd3f90d1aa52ba5785e27e5217ed2c9, MIT). The algorithm math is kept
 * faithful to the original to reduce port risk; only the surface is adapted:
 *
 *  - Points are the project Vec2 ({ x, y }). The orbiting search needs a per-
 *    vertex `marked` flag, so the NFP layer uses NfpPoint (Vec2 + optional
 *    marked); these plain helpers accept any { x, y }.
 *  - SVGnest stashed sliding offsets on the array object (`A.offsetx`). That is
 *    a mutable-shared-state foot-gun; here the offset is an EXPLICIT parameter
 *    (offA / offB) threaded through, defaulting to {0,0}. Behaviour is identical.
 *  - Deterministic by construction: no Math.random, Date, or iteration-order
 *    nondeterminism (NESTING-P1-ENGINE-PLAN.md - determinism is the #1 port risk).
 *
 * Why NOT reuse src/lib/cam/geometry/index.ts: that module's pointInPolygon
 * returns a plain boolean, but the NFP touching/intersection logic REQUIRES the
 * SVGnest tri-state (true inside / false outside / null exactly-on-boundary).
 * Reusing the boolean version would silently break the orbit. So the SVGnest
 * versions are ported verbatim here.
 */

import type { Vec2 } from '../../../types/index'

/** Floating-point comparison tolerance (SVGnest: 10^-9). */
export const TOL = Math.pow(10, -9)

/** A 2D offset applied to a polygon's vertices on the fly. */
export interface Offset {
  x: number
  y: number
}

const ZERO: Offset = { x: 0, y: 0 }

export function almostEqual(a: number, b: number, tolerance: number = TOL): boolean {
  return Math.abs(a - b) < tolerance
}

/** True if p1 and p2 are within `distance` of each other. */
export function withinDistance(p1: Vec2, p2: Vec2, distance: number): boolean {
  const dx = p1.x - p2.x
  const dy = p1.y - p2.y
  return dx * dx + dy * dy < distance * distance
}

/** Normalize v to a unit vector (returns v unchanged if already unit). */
export function normalizeVector(v: Vec2): Vec2 {
  if (almostEqual(v.x * v.x + v.y * v.y, 1)) {
    return v
  }
  const len = Math.sqrt(v.x * v.x + v.y * v.y)
  const inverse = 1 / len
  return { x: v.x * inverse, y: v.y * inverse }
}

/** True if p lies strictly on segment AB (excluding the endpoints). */
export function onSegment(A: Vec2, B: Vec2, p: Vec2): boolean {
  // vertical line
  if (almostEqual(A.x, B.x) && almostEqual(p.x, A.x)) {
    if (!almostEqual(p.y, B.y) && !almostEqual(p.y, A.y) && p.y < Math.max(B.y, A.y) && p.y > Math.min(B.y, A.y)) {
      return true
    }
    return false
  }

  // horizontal line
  if (almostEqual(A.y, B.y) && almostEqual(p.y, A.y)) {
    if (!almostEqual(p.x, B.x) && !almostEqual(p.x, A.x) && p.x < Math.max(B.x, A.x) && p.x > Math.min(B.x, A.x)) {
      return true
    }
    return false
  }

  // range check
  if (
    (p.x < A.x && p.x < B.x) ||
    (p.x > A.x && p.x > B.x) ||
    (p.y < A.y && p.y < B.y) ||
    (p.y > A.y && p.y > B.y)
  ) {
    return false
  }

  // exclude end points
  if ((almostEqual(p.x, A.x) && almostEqual(p.y, A.y)) || (almostEqual(p.x, B.x) && almostEqual(p.y, B.y))) {
    return false
  }

  const cross = (p.y - A.y) * (B.x - A.x) - (p.x - A.x) * (B.y - A.y)
  if (Math.abs(cross) > TOL) {
    return false
  }

  const dot = (p.x - A.x) * (B.x - A.x) + (p.y - A.y) * (B.y - A.y)
  if (dot < 0 || almostEqual(dot, 0)) {
    return false
  }

  const len2 = (B.x - A.x) * (B.x - A.x) + (B.y - A.y) * (B.y - A.y)
  if (dot > len2 || almostEqual(dot, len2)) {
    return false
  }

  return true
}

/**
 * Intersection of segment AB and EF, or null when there is none (or numerical
 * error). When `infinite` is true, AB and EF are treated as infinite lines.
 */
export function lineIntersect(A: Vec2, B: Vec2, E: Vec2, F: Vec2, infinite = false): Vec2 | null {
  const a1 = B.y - A.y
  const b1 = A.x - B.x
  const c1 = B.x * A.y - A.x * B.y
  const a2 = F.y - E.y
  const b2 = E.x - F.x
  const c2 = F.x * E.y - E.x * F.y

  const denom = a1 * b2 - a2 * b1

  const x = (b1 * c2 - b2 * c1) / denom
  const y = (a2 * c1 - a1 * c2) / denom

  if (!isFinite(x) || !isFinite(y)) {
    return null
  }

  if (!infinite) {
    // coincident points do not count as intersecting
    if (Math.abs(A.x - B.x) > TOL && (A.x < B.x ? x < A.x || x > B.x : x > A.x || x < B.x)) return null
    if (Math.abs(A.y - B.y) > TOL && (A.y < B.y ? y < A.y || y > B.y : y > A.y || y < B.y)) return null
    if (Math.abs(E.x - F.x) > TOL && (E.x < F.x ? x < E.x || x > F.x : x > E.x || x < F.x)) return null
    if (Math.abs(E.y - F.y) > TOL && (E.y < F.y ? y < E.y || y > F.y : y > E.y || y < F.y)) return null
  }

  return { x, y }
}

/**
 * Point-in-polygon (SVGnest tri-state): true if inside, false if outside, null
 * if the point lies exactly on a vertex or edge. `off` shifts every polygon
 * vertex (replaces SVGnest's polygon.offsetx/offsety).
 */
export function pointInPolygon(point: Vec2, polygon: Vec2[], off: Offset = ZERO): boolean | null {
  if (!polygon || polygon.length < 3) {
    return null
  }

  let inside = false
  const offsetx = off.x
  const offsety = off.y

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x + offsetx
    const yi = polygon[i].y + offsety
    const xj = polygon[j].x + offsetx
    const yj = polygon[j].y + offsety

    if (almostEqual(xi, point.x) && almostEqual(yi, point.y)) {
      return null // on a vertex
    }

    if (onSegment({ x: xi, y: yi }, { x: xj, y: yj }, point)) {
      return null // on an edge
    }

    if (almostEqual(xi, xj) && almostEqual(yi, yj)) {
      continue // ignore zero-length edges
    }

    const intersect =
      yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }

  return inside
}

/** Axis-aligned bounds of a polygon (SVGnest getPolygonBounds: x/y/width/height). */
export interface PolygonBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Axis-aligned bounding box of a polygon. Faithful to SVGnest getPolygonBounds
 *  (used by the placement worker's gravity rule and the GA's fit pre-filter). */
export function getPolygonBounds(polygon: Vec2[]): PolygonBounds {
  let xmin = polygon[0].x
  let xmax = polygon[0].x
  let ymin = polygon[0].y
  let ymax = polygon[0].y
  for (let i = 1; i < polygon.length; i++) {
    if (polygon[i].x > xmax) xmax = polygon[i].x
    else if (polygon[i].x < xmin) xmin = polygon[i].x
    if (polygon[i].y > ymax) ymax = polygon[i].y
    else if (polygon[i].y < ymin) ymin = polygon[i].y
  }
  return { x: xmin, y: ymin, width: xmax - xmin, height: ymax - ymin }
}

/** Rotate a polygon CCW by `degrees` about the origin. Faithful port of SVGnest
 *  rotatePolygon (placementworker.js). Deterministic; no shared state. */
export function rotatePolygon(polygon: Vec2[], degrees: number): Vec2[] {
  const angle = (degrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotated: Vec2[] = new Array(polygon.length)
  for (let i = 0; i < polygon.length; i++) {
    const x = polygon[i].x
    const y = polygon[i].y
    rotated[i] = { x: x * cos - y * sin, y: x * sin + y * cos }
  }
  return rotated
}

/**
 * Signed polygon area (SVGnest convention: NEGATIVE area = counter-clockwise
 * winding). Distinct from project signedArea() which uses the opposite sign;
 * kept here to stay faithful to any SVGnest caller that relies on the sign.
 */
export function polygonArea(polygon: Vec2[]): number {
  let area = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y)
  }
  return 0.5 * area
}

/**
 * True if any edge of polygon A intersects any edge of polygon B. Endpoint /
 * on-edge contact is disambiguated via the tri-state pointInPolygon of the
 * neighbouring vertices (a mere touch is not an intersection). offA / offB
 * replace SVGnest's A.offsetx / B.offsetx.
 */
export function intersect(Ain: Vec2[], Bin: Vec2[], offA: Offset = ZERO, offB: Offset = ZERO): boolean {
  const Aoffsetx = offA.x
  const Aoffsety = offA.y
  const Boffsetx = offB.x
  const Boffsety = offB.y

  const A = Ain.slice(0)
  const B = Bin.slice(0)

  for (let i = 0; i < A.length - 1; i++) {
    for (let j = 0; j < B.length - 1; j++) {
      const a1 = { x: A[i].x + Aoffsetx, y: A[i].y + Aoffsety }
      const a2 = { x: A[i + 1].x + Aoffsetx, y: A[i + 1].y + Aoffsety }
      const b1 = { x: B[j].x + Boffsetx, y: B[j].y + Boffsety }
      const b2 = { x: B[j + 1].x + Boffsetx, y: B[j + 1].y + Boffsety }

      let prevbindex = j === 0 ? B.length - 1 : j - 1
      let prevaindex = i === 0 ? A.length - 1 : i - 1
      let nextbindex = j + 1 === B.length - 1 ? 0 : j + 2
      let nextaindex = i + 1 === A.length - 1 ? 0 : i + 2

      // go even further back if we happen to hit on a loop end point
      if (B[prevbindex] === B[j] || (almostEqual(B[prevbindex].x, B[j].x) && almostEqual(B[prevbindex].y, B[j].y))) {
        prevbindex = prevbindex === 0 ? B.length - 1 : prevbindex - 1
      }
      if (A[prevaindex] === A[i] || (almostEqual(A[prevaindex].x, A[i].x) && almostEqual(A[prevaindex].y, A[i].y))) {
        prevaindex = prevaindex === 0 ? A.length - 1 : prevaindex - 1
      }

      // go even further forward if we happen to hit on a loop end point
      if (
        B[nextbindex] === B[j + 1] ||
        (almostEqual(B[nextbindex].x, B[j + 1].x) && almostEqual(B[nextbindex].y, B[j + 1].y))
      ) {
        nextbindex = nextbindex === B.length - 1 ? 0 : nextbindex + 1
      }
      if (
        A[nextaindex] === A[i + 1] ||
        (almostEqual(A[nextaindex].x, A[i + 1].x) && almostEqual(A[nextaindex].y, A[i + 1].y))
      ) {
        nextaindex = nextaindex === A.length - 1 ? 0 : nextaindex + 1
      }

      const a0 = { x: A[prevaindex].x + Aoffsetx, y: A[prevaindex].y + Aoffsety }
      const b0 = { x: B[prevbindex].x + Boffsetx, y: B[prevbindex].y + Boffsety }
      const a3 = { x: A[nextaindex].x + Aoffsetx, y: A[nextaindex].y + Aoffsety }
      const b3 = { x: B[nextbindex].x + Boffsetx, y: B[nextbindex].y + Boffsety }

      if (onSegment(a1, a2, b1) || (almostEqual(a1.x, b1.x) && almostEqual(a1.y, b1.y))) {
        const b0in = pointInPolygon(b0, A, offA)
        const b2in = pointInPolygon(b2, A, offA)
        if ((b0in === true && b2in === false) || (b0in === false && b2in === true)) {
          return true
        }
        continue
      }

      if (onSegment(a1, a2, b2) || (almostEqual(a2.x, b2.x) && almostEqual(a2.y, b2.y))) {
        const b1in = pointInPolygon(b1, A, offA)
        const b3in = pointInPolygon(b3, A, offA)
        if ((b1in === true && b3in === false) || (b1in === false && b3in === true)) {
          return true
        }
        continue
      }

      if (onSegment(b1, b2, a1) || (almostEqual(a1.x, b2.x) && almostEqual(a1.y, b2.y))) {
        const a0in = pointInPolygon(a0, B, offB)
        const a2in = pointInPolygon(a2, B, offB)
        if ((a0in === true && a2in === false) || (a0in === false && a2in === true)) {
          return true
        }
        continue
      }

      if (onSegment(b1, b2, a2) || (almostEqual(a2.x, b1.x) && almostEqual(a2.y, b1.y))) {
        const a1in = pointInPolygon(a1, B, offB)
        const a3in = pointInPolygon(a3, B, offB)
        if ((a1in === true && a3in === false) || (a1in === false && a3in === true)) {
          return true
        }
        continue
      }

      const p = lineIntersect(b1, b2, a1, a2)
      if (p !== null) {
        return true
      }
    }
  }

  return false
}

/**
 * Normal distance from p to the segment s1-s2 along the given normal direction,
 * or null when p doesn't project onto the segment. s1inclusive / s2inclusive
 * include the respective endpoint. Faithful port of SVGnest pointDistance.
 */
export function pointDistance(
  p: Vec2,
  s1: Vec2,
  s2: Vec2,
  normalIn: Vec2,
  infinite = false
): number | null {
  const normal = normalizeVector(normalIn)
  const dir = { x: normal.y, y: -normal.x }

  const pdot = p.x * dir.x + p.y * dir.y
  const s1dot = s1.x * dir.x + s1.y * dir.y
  const s2dot = s2.x * dir.x + s2.y * dir.y

  const pdotnorm = p.x * normal.x + p.y * normal.y
  const s1dotnorm = s1.x * normal.x + s1.y * normal.y
  const s2dotnorm = s2.x * normal.x + s2.y * normal.y

  if (!infinite) {
    if (
      ((pdot < s1dot || almostEqual(pdot, s1dot)) && (pdot < s2dot || almostEqual(pdot, s2dot))) ||
      ((pdot > s1dot || almostEqual(pdot, s1dot)) && (pdot > s2dot || almostEqual(pdot, s2dot)))
    ) {
      return null // doesn't collide with the segment, or lies on a vertex
    }
    if (almostEqual(pdot, s1dot) && almostEqual(pdot, s2dot) && pdotnorm > s1dotnorm && pdotnorm > s2dotnorm) {
      return Math.min(pdotnorm - s1dotnorm, pdotnorm - s2dotnorm)
    }
    if (almostEqual(pdot, s1dot) && almostEqual(pdot, s2dot) && pdotnorm < s1dotnorm && pdotnorm < s2dotnorm) {
      return -Math.min(s1dotnorm - pdotnorm, s2dotnorm - pdotnorm)
    }
  }

  return -(pdotnorm - s1dotnorm + ((s1dotnorm - s2dotnorm) * (s1dot - pdot)) / (s1dot - s2dot))
}

/**
 * Distance segment AB can slide along `direction` before it would touch EF, or
 * null when they never meet on that slide. Faithful port of SVGnest
 * segmentDistance (used by polygonSlideDistance).
 */
export function segmentDistance(A: Vec2, B: Vec2, E: Vec2, F: Vec2, direction: Vec2): number | null {
  const normal = { x: direction.y, y: -direction.x }
  const reverse = { x: -direction.x, y: -direction.y }

  const dotA = A.x * normal.x + A.y * normal.y
  const dotB = B.x * normal.x + B.y * normal.y
  const dotE = E.x * normal.x + E.y * normal.y
  const dotF = F.x * normal.x + F.y * normal.y

  const crossA = A.x * direction.x + A.y * direction.y
  const crossB = B.x * direction.x + B.y * direction.y
  const crossE = E.x * direction.x + E.y * direction.y
  const crossF = F.x * direction.x + F.y * direction.y

  const ABmin = Math.min(dotA, dotB)
  const ABmax = Math.max(dotA, dotB)
  const EFmax = Math.max(dotE, dotF)
  const EFmin = Math.min(dotE, dotF)

  // segments that will merely touch at one point
  if (almostEqual(ABmax, EFmin, TOL) || almostEqual(ABmin, EFmax, TOL)) {
    return null
  }
  // segments miss each other completely
  if (ABmax < EFmin || ABmin > EFmax) {
    return null
  }

  let overlap: number
  if ((ABmax > EFmax && ABmin < EFmin) || (EFmax > ABmax && EFmin < ABmin)) {
    overlap = 1
  } else {
    const minMax = Math.min(ABmax, EFmax)
    const maxMin = Math.max(ABmin, EFmin)
    const maxMax = Math.max(ABmax, EFmax)
    const minMin = Math.min(ABmin, EFmin)
    overlap = (minMax - maxMin) / (maxMax - minMin)
  }

  const crossABE = (E.y - A.y) * (B.x - A.x) - (E.x - A.x) * (B.y - A.y)
  const crossABF = (F.y - A.y) * (B.x - A.x) - (F.x - A.x) * (B.y - A.y)

  // lines are colinear
  if (almostEqual(crossABE, 0) && almostEqual(crossABF, 0)) {
    const ABnorm = { x: B.y - A.y, y: A.x - B.x }
    const EFnorm = { x: F.y - E.y, y: E.x - F.x }

    const ABnormlength = Math.sqrt(ABnorm.x * ABnorm.x + ABnorm.y * ABnorm.y)
    ABnorm.x /= ABnormlength
    ABnorm.y /= ABnormlength

    const EFnormlength = Math.sqrt(EFnorm.x * EFnorm.x + EFnorm.y * EFnorm.y)
    EFnorm.x /= EFnormlength
    EFnorm.y /= EFnormlength

    // segment normals must point in opposite directions
    if (
      Math.abs(ABnorm.y * EFnorm.x - ABnorm.x * EFnorm.y) < TOL &&
      ABnorm.y * EFnorm.y + ABnorm.x * EFnorm.x < 0
    ) {
      // normal of AB must point in same direction as the slide direction
      const normdot = ABnorm.y * direction.y + ABnorm.x * direction.x
      if (almostEqual(normdot, 0, TOL)) {
        return null
      }
      if (normdot < 0) {
        return 0
      }
    }
    return null
  }

  const distances: number[] = []

  // coincident points
  if (almostEqual(dotA, dotE)) {
    distances.push(crossA - crossE)
  } else if (almostEqual(dotA, dotF)) {
    distances.push(crossA - crossF)
  } else if (dotA > EFmin && dotA < EFmax) {
    let d = pointDistance(A, E, F, reverse)
    if (d !== null && almostEqual(d, 0)) {
      const dB = pointDistance(B, E, F, reverse, true)
      if (dB! < 0 || almostEqual(dB! * overlap, 0)) {
        d = null
      }
    }
    if (d !== null) {
      distances.push(d)
    }
  }

  if (almostEqual(dotB, dotE)) {
    distances.push(crossB - crossE)
  } else if (almostEqual(dotB, dotF)) {
    distances.push(crossB - crossF)
  } else if (dotB > EFmin && dotB < EFmax) {
    let d = pointDistance(B, E, F, reverse)
    if (d !== null && almostEqual(d, 0)) {
      const dA = pointDistance(A, E, F, reverse, true)
      if (dA! < 0 || almostEqual(dA! * overlap, 0)) {
        d = null
      }
    }
    if (d !== null) {
      distances.push(d)
    }
  }

  if (dotE > ABmin && dotE < ABmax) {
    let d = pointDistance(E, A, B, direction)
    if (d !== null && almostEqual(d, 0)) {
      const dF = pointDistance(F, A, B, direction, true)
      if (dF! < 0 || almostEqual(dF! * overlap, 0)) {
        d = null
      }
    }
    if (d !== null) {
      distances.push(d)
    }
  }

  if (dotF > ABmin && dotF < ABmax) {
    let d = pointDistance(F, A, B, direction)
    if (d !== null && almostEqual(d, 0)) {
      const dE = pointDistance(E, A, B, direction, true)
      if (dE! < 0 || almostEqual(dE! * overlap, 0)) {
        d = null
      }
    }
    if (d !== null) {
      distances.push(d)
    }
  }

  if (distances.length === 0) {
    return null
  }

  return Math.min(...distances)
}

/**
 * Distance polygon B can slide along `direction` before it first touches A.
 * offA / offB replace SVGnest's A.offsetx / B.offsetx. ignoreNegative drops
 * negative (overlapping) slide distances. Faithful port.
 */
export function polygonSlideDistance(
  Ain: Vec2[],
  Bin: Vec2[],
  direction: Vec2,
  ignoreNegative: boolean,
  offA: Offset = ZERO,
  offB: Offset = ZERO
): number | null {
  const Aoffsetx = offA.x
  const Aoffsety = offA.y
  const Boffsetx = offB.x
  const Boffsety = offB.y

  const A = Ain.slice(0)
  const B = Bin.slice(0)

  // close the loop for polygons
  if (A[0] !== A[A.length - 1]) {
    A.push(A[0])
  }
  if (B[0] !== B[B.length - 1]) {
    B.push(B[0])
  }

  const edgeA = A
  const edgeB = B

  let distance: number | null = null

  const dir = normalizeVector(direction)

  for (let i = 0; i < edgeB.length - 1; i++) {
    for (let j = 0; j < edgeA.length - 1; j++) {
      const A1 = { x: edgeA[j].x + Aoffsetx, y: edgeA[j].y + Aoffsety }
      const A2 = { x: edgeA[j + 1].x + Aoffsetx, y: edgeA[j + 1].y + Aoffsety }
      const B1 = { x: edgeB[i].x + Boffsetx, y: edgeB[i].y + Boffsety }
      const B2 = { x: edgeB[i + 1].x + Boffsetx, y: edgeB[i + 1].y + Boffsety }

      if (
        (almostEqual(A1.x, A2.x) && almostEqual(A1.y, A2.y)) ||
        (almostEqual(B1.x, B2.x) && almostEqual(B1.y, B2.y))
      ) {
        continue // ignore extremely small lines
      }

      const d = segmentDistance(A1, A2, B1, B2, dir)

      if (d !== null && (distance === null || d < distance)) {
        if (!ignoreNegative || d > 0 || almostEqual(d, 0)) {
          distance = d
        }
      }
    }
  }
  return distance
}

/**
 * Project each vertex of B onto A along `direction` and return the maximum of
 * the per-vertex minimum projections. offA / offB replace SVGnest's offsets.
 * Faithful port; used by searchStartPoint.
 */
export function polygonProjectionDistance(
  Ain: Vec2[],
  Bin: Vec2[],
  direction: Vec2,
  offA: Offset = ZERO,
  offB: Offset = ZERO
): number | null {
  const Aoffsetx = offA.x
  const Aoffsety = offA.y
  const Boffsetx = offB.x
  const Boffsety = offB.y

  const A = Ain.slice(0)
  const B = Bin.slice(0)

  // close the loop for polygons
  if (A[0] !== A[A.length - 1]) {
    A.push(A[0])
  }
  if (B[0] !== B[B.length - 1]) {
    B.push(B[0])
  }

  const edgeA = A
  const edgeB = B

  let distance: number | null = null

  for (let i = 0; i < edgeB.length; i++) {
    // the shortest/most negative projection of B onto A
    let minprojection: number | null = null
    for (let j = 0; j < edgeA.length - 1; j++) {
      const p = { x: edgeB[i].x + Boffsetx, y: edgeB[i].y + Boffsety }
      const s1 = { x: edgeA[j].x + Aoffsetx, y: edgeA[j].y + Aoffsety }
      const s2 = { x: edgeA[j + 1].x + Aoffsetx, y: edgeA[j + 1].y + Aoffsety }

      if (Math.abs((s2.y - s1.y) * direction.x - (s2.x - s1.x) * direction.y) < TOL) {
        continue
      }

      // project point, ignore edge boundaries
      const d = pointDistance(p, s1, s2, direction)

      if (d !== null && (minprojection === null || d < minprojection)) {
        minprojection = d
      }
    }
    if (minprojection !== null && (distance === null || minprojection > distance)) {
      distance = minprojection
    }
  }

  return distance
}
