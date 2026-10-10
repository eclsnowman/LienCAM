/* Orbiting-method No-Fit Polygon (NFP) - the geometry workhorse for nesting.
 *
 * PORTED from the vendored SVGnest geometry core
 * (vendored/svgnest-geometryutil.reference.js.txt, pinned commit
 * 1248dc21efd3f90d1aa52ba5785e27e5217ed2c9, MIT). The algorithm math is kept
 * faithful to the original; only the surface is adapted to the project.
 *
 * Two public functions (NESTING-P1-ENGINE-PLAN.md, sub-stage P1.1):
 *  - noFitPolygon(A, B, inside, searchEdges): part-vs-part NFP. B orbits A
 *    maintaining contact without overlap; the traced reference path is the NFP.
 *  - noFitPolygonRectangle(A, B): inner-fit region for placing part B inside an
 *    axis-aligned rectangle A (innerFitPolygon for the rectangular-sheet case).
 *
 * Adaptation notes:
 *  - Points are the project Vec2. The orbit marks visited A vertices; SVGnest
 *    set a `marked` flag on the live input objects. Here A/B are cloned into
 *    NfpPoint[] (Vec2 + optional marked) so the CALLER'S input is never mutated.
 *  - SVGnest stashed the current slide offset on the array object (B.offsetx).
 *    Here the offset is an explicit { x, y } threaded into the helpers.
 *  - Deterministic by construction: no Math.random / Date / Set-iteration order
 *    (NESTING-P1-ENGINE-PLAN.md - determinism is the #1 port risk). The orbit is
 *    a fixed walk; searchStartPoint iterates fixed index ranges. Verified by a
 *    twice-run deep-equal test.
 */

import type { Vec2 } from '../../../types/index'
import {
  almostEqual,
  intersect,
  onSegment,
  pointInPolygon,
  polygonProjectionDistance,
  polygonSlideDistance,
  type Offset,
} from './geometry'

/** Internal mutable vertex: a point plus the orbit's visited flag. */
interface NfpPoint {
  x: number
  y: number
  marked?: boolean
}

/** Deep-clone an input ring into mutable NfpPoints (caller input untouched). */
function clone(poly: Vec2[]): NfpPoint[] {
  return poly.map((p) => ({ x: p.x, y: p.y }))
}

/** True if point p already appears in any ring of the given NFP list. */
function inNfp(p: Vec2, nfp: Vec2[][] | null): boolean {
  if (!nfp || nfp.length === 0) {
    return false
  }
  for (let i = 0; i < nfp.length; i++) {
    for (let j = 0; j < nfp[i].length; j++) {
      if (almostEqual(p.x, nfp[i][j].x) && almostEqual(p.y, nfp[i][j].y)) {
        return true
      }
    }
  }
  return false
}

/**
 * Search for an offset of B (relative to A) that is a valid, not-yet-traversed
 * orbit start point. `inside` selects whether B is sought inside A. NFP is the
 * list of already-found loops whose vertices must be avoided as start points.
 * Returns the start offset, or null when none remains. Faithful port of
 * SVGnest searchStartPoint (operates on the pre-cloned A/B; sets `marked`).
 */
function searchStartPoint(
  Ain: NfpPoint[],
  Bin: NfpPoint[],
  inside: boolean,
  NFP: Vec2[][] | null
): Offset | null {
  // close the loop for polygons (clone so we don't append to the orbit arrays)
  const A = Ain.slice(0)
  const B = Bin.slice(0)
  if (A[0] !== A[A.length - 1]) {
    A.push(A[0])
  }
  if (B[0] !== B[B.length - 1]) {
    B.push(B[0])
  }

  for (let i = 0; i < A.length - 1; i++) {
    if (!A[i].marked) {
      A[i].marked = true
      for (let j = 0; j < B.length; j++) {
        let off: Offset = { x: A[i].x - B[j].x, y: A[i].y - B[j].y }

        let Binside: boolean | null = null
        for (let k = 0; k < B.length; k++) {
          const inpoly = pointInPolygon({ x: B[k].x + off.x, y: B[k].y + off.y }, A)
          if (inpoly !== null) {
            Binside = inpoly
            break
          }
        }

        if (Binside === null) {
          // A and B are the same
          return null
        }

        let startPoint: Offset = { x: off.x, y: off.y }
        if (
          ((Binside && inside) || (!Binside && !inside)) &&
          !intersect(A, B, { x: 0, y: 0 }, off) &&
          !inNfp(startPoint, NFP)
        ) {
          return startPoint
        }

        // slide B along the A edge vector
        let vx = A[i + 1].x - A[i].x
        let vy = A[i + 1].y - A[i].y

        const d1 = polygonProjectionDistance(A, B, { x: vx, y: vy }, { x: 0, y: 0 }, off)
        const d2 = polygonProjectionDistance(B, A, { x: -vx, y: -vy }, off, { x: 0, y: 0 })

        let d: number | null = null
        if (d1 === null && d2 === null) {
          // nothing
        } else if (d1 === null) {
          d = d2
        } else if (d2 === null) {
          d = d1
        } else {
          d = Math.min(d1, d2)
        }

        // only slide until no longer negative
        if (d !== null && !almostEqual(d, 0) && d > 0) {
          // continue below
        } else {
          continue
        }

        const vd2 = vx * vx + vy * vy
        if (d * d < vd2 && !almostEqual(d * d, vd2)) {
          const vd = Math.sqrt(vx * vx + vy * vy)
          vx *= d / vd
          vy *= d / vd
        }

        off = { x: off.x + vx, y: off.y + vy }

        Binside = null
        for (let k = 0; k < B.length; k++) {
          const inpoly = pointInPolygon({ x: B[k].x + off.x, y: B[k].y + off.y }, A)
          if (inpoly !== null) {
            Binside = inpoly
            break
          }
        }
        startPoint = { x: off.x, y: off.y }
        if (
          ((Binside && inside) || (!Binside && !inside)) &&
          !intersect(A, B, { x: 0, y: 0 }, off) &&
          !inNfp(startPoint, NFP)
        ) {
          return startPoint
        }
      }
    }
  }

  return null
}

/** A translation vector candidate produced during the orbit. */
interface TVector {
  x: number
  y: number
  start: NfpPoint
  end: NfpPoint
}

/**
 * Compute the no-fit polygon of movable polygon B about static polygon A by the
 * orbiting method. When `inside` is set, B orbits the interior of A. When
 * `searchEdges` is set, all start points are explored (the NFP may have
 * multiple loops); otherwise only the first/outer loop is returned.
 *
 * Returns a list of NFP loops, or null for degenerate input. Faithful port of
 * SVGnest noFitPolygon. The caller's A/B arrays are never mutated.
 */
export function noFitPolygon(
  Asrc: Vec2[],
  Bsrc: Vec2[],
  inside: boolean,
  searchEdges: boolean
): Vec2[][] | null {
  if (!Asrc || Asrc.length < 3 || !Bsrc || Bsrc.length < 3) {
    return null
  }

  const A = clone(Asrc)
  const B = clone(Bsrc)

  let minA = A[0].y
  let minAindex = 0
  let maxB = B[0].y
  let maxBindex = 0

  for (let i = 1; i < A.length; i++) {
    A[i].marked = false
    if (A[i].y < minA) {
      minA = A[i].y
      minAindex = i
    }
  }
  for (let i = 1; i < B.length; i++) {
    B[i].marked = false
    if (B[i].y > maxB) {
      maxB = B[i].y
      maxBindex = i
    }
  }

  let startpoint: Offset | null
  if (!inside) {
    // shift B so its bottom-most point sits at A's top-most point: guarantees
    // an initial placement with no intersections
    startpoint = {
      x: A[minAindex].x - B[maxBindex].x,
      y: A[minAindex].y - B[maxBindex].y,
    }
  } else {
    // no reliable heuristic for inside
    startpoint = searchStartPoint(A, B, true, null)
  }

  const NFPlist: Vec2[][] = []

  while (startpoint !== null) {
    const off: Offset = { x: startpoint.x, y: startpoint.y }

    let prevvector: TVector | null = null
    let NFP: Vec2[] | null = [{ x: B[0].x + off.x, y: B[0].y + off.y }]

    let referencex = B[0].x + off.x
    let referencey = B[0].y + off.y
    const startx = referencex
    const starty = referencey
    let counter = 0

    while (counter < 10 * (A.length + B.length)) {
      // sanity check, prevent infinite loop
      const touching: { type: number; A: number; B: number }[] = []

      // find touching vertices/edges
      for (let i = 0; i < A.length; i++) {
        const nexti = i === A.length - 1 ? 0 : i + 1
        for (let j = 0; j < B.length; j++) {
          const nextj = j === B.length - 1 ? 0 : j + 1
          if (almostEqual(A[i].x, B[j].x + off.x) && almostEqual(A[i].y, B[j].y + off.y)) {
            touching.push({ type: 0, A: i, B: j })
          } else if (onSegment(A[i], A[nexti], { x: B[j].x + off.x, y: B[j].y + off.y })) {
            touching.push({ type: 1, A: nexti, B: j })
          } else if (
            onSegment(
              { x: B[j].x + off.x, y: B[j].y + off.y },
              { x: B[nextj].x + off.x, y: B[nextj].y + off.y },
              A[i]
            )
          ) {
            touching.push({ type: 2, A: i, B: nextj })
          }
        }
      }

      // generate translation vectors from touching vertices/edges
      const vectors: TVector[] = []
      for (let i = 0; i < touching.length; i++) {
        const vertexA = A[touching[i].A]
        vertexA.marked = true

        // adjacent A vertices
        let prevAindex = touching[i].A - 1
        let nextAindex = touching[i].A + 1
        prevAindex = prevAindex < 0 ? A.length - 1 : prevAindex
        nextAindex = nextAindex >= A.length ? 0 : nextAindex
        const prevA = A[prevAindex]
        const nextA = A[nextAindex]

        // adjacent B vertices
        const vertexB = B[touching[i].B]
        let prevBindex = touching[i].B - 1
        let nextBindex = touching[i].B + 1
        prevBindex = prevBindex < 0 ? B.length - 1 : prevBindex
        nextBindex = nextBindex >= B.length ? 0 : nextBindex
        const prevB = B[prevBindex]
        const nextB = B[nextBindex]

        if (touching[i].type === 0) {
          const vA1: TVector = { x: prevA.x - vertexA.x, y: prevA.y - vertexA.y, start: vertexA, end: prevA }
          const vA2: TVector = { x: nextA.x - vertexA.x, y: nextA.y - vertexA.y, start: vertexA, end: nextA }
          // B vectors need to be inverted
          const vB1: TVector = { x: vertexB.x - prevB.x, y: vertexB.y - prevB.y, start: prevB, end: vertexB }
          const vB2: TVector = { x: vertexB.x - nextB.x, y: vertexB.y - nextB.y, start: nextB, end: vertexB }
          vectors.push(vA1, vA2, vB1, vB2)
        } else if (touching[i].type === 1) {
          vectors.push({
            x: vertexA.x - (vertexB.x + off.x),
            y: vertexA.y - (vertexB.y + off.y),
            start: prevA,
            end: vertexA,
          })
          vectors.push({
            x: prevA.x - (vertexB.x + off.x),
            y: prevA.y - (vertexB.y + off.y),
            start: vertexA,
            end: prevA,
          })
        } else if (touching[i].type === 2) {
          vectors.push({
            x: vertexA.x - (vertexB.x + off.x),
            y: vertexA.y - (vertexB.y + off.y),
            start: prevB,
            end: vertexB,
          })
          vectors.push({
            x: vertexA.x - (prevB.x + off.x),
            y: vertexA.y - (prevB.y + off.y),
            start: vertexB,
            end: prevB,
          })
        }
      }

      // find the vector that lets us slide the furthest without intersecting
      let translate: TVector | null = null
      let maxd = 0

      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i].x === 0 && vectors[i].y === 0) {
          continue
        }

        // if this vector points back where we came from, ignore it
        // (cross product ~= 0, dot product < 0)
        if (prevvector && vectors[i].y * prevvector.y + vectors[i].x * prevvector.x < 0) {
          const vectorlength = Math.sqrt(vectors[i].x * vectors[i].x + vectors[i].y * vectors[i].y)
          const unitv = { x: vectors[i].x / vectorlength, y: vectors[i].y / vectorlength }

          const prevlength = Math.sqrt(prevvector.x * prevvector.x + prevvector.y * prevvector.y)
          const prevunit = { x: prevvector.x / prevlength, y: prevvector.y / prevlength }

          if (Math.abs(unitv.y * prevunit.x - unitv.x * prevunit.y) < 0.0001) {
            continue
          }
        }

        let d = polygonSlideDistance(A, B, vectors[i], true, { x: 0, y: 0 }, off)
        const vecd2 = vectors[i].x * vectors[i].x + vectors[i].y * vectors[i].y

        if (d === null || d * d > vecd2) {
          const vecd = Math.sqrt(vectors[i].x * vectors[i].x + vectors[i].y * vectors[i].y)
          d = vecd
        }

        if (d !== null && d > maxd) {
          maxd = d
          translate = vectors[i]
        }
      }

      if (translate === null || almostEqual(maxd, 0)) {
        // didn't close the loop, something went wrong
        NFP = null
        break
      }

      translate.start.marked = true
      translate.end.marked = true

      prevvector = translate

      // trim the translation to maxd
      const vlength2 = translate.x * translate.x + translate.y * translate.y
      if (maxd * maxd < vlength2 && !almostEqual(maxd * maxd, vlength2)) {
        const scale = Math.sqrt((maxd * maxd) / vlength2)
        translate.x *= scale
        translate.y *= scale
      }

      referencex += translate.x
      referencey += translate.y

      if (almostEqual(referencex, startx) && almostEqual(referencey, starty)) {
        // full loop
        break
      }

      // if A and B start on a touching horizontal line, the end point may not
      // be the start point
      let looped = false
      if (NFP.length > 0) {
        for (let i = 0; i < NFP.length - 1; i++) {
          if (almostEqual(referencex, NFP[i].x) && almostEqual(referencey, NFP[i].y)) {
            looped = true
          }
        }
      }
      if (looped) {
        // full loop
        break
      }

      NFP.push({ x: referencex, y: referencey })

      off.x += translate.x
      off.y += translate.y

      counter++
    }

    if (NFP && NFP.length > 0) {
      NFPlist.push(NFP)
    }

    if (!searchEdges) {
      // only the outer NFP (or first inner NFP)
      break
    }

    startpoint = searchStartPoint(A, B, inside, NFPlist)
  }

  return NFPlist
}

/**
 * Interior NFP for the special case where A is an axis-aligned RECTANGLE: the
 * locus of B's reference point (B[0]) such that B fits fully inside A. This is
 * the innerFitPolygon for placing a part inside a rectangular sheet. Returns
 * null when B does not fit. Faithful port of SVGnest noFitPolygonRectangle.
 */
export function noFitPolygonRectangle(A: Vec2[], B: Vec2[]): Vec2[][] | null {
  let minAx = A[0].x
  let minAy = A[0].y
  let maxAx = A[0].x
  let maxAy = A[0].y
  for (let i = 1; i < A.length; i++) {
    if (A[i].x < minAx) minAx = A[i].x
    if (A[i].y < minAy) minAy = A[i].y
    if (A[i].x > maxAx) maxAx = A[i].x
    if (A[i].y > maxAy) maxAy = A[i].y
  }

  let minBx = B[0].x
  let minBy = B[0].y
  let maxBx = B[0].x
  let maxBy = B[0].y
  for (let i = 1; i < B.length; i++) {
    if (B[i].x < minBx) minBx = B[i].x
    if (B[i].y < minBy) minBy = B[i].y
    if (B[i].x > maxBx) maxBx = B[i].x
    if (B[i].y > maxBy) maxBy = B[i].y
  }

  if (maxBx - minBx > maxAx - minAx) {
    return null
  }
  if (maxBy - minBy > maxAy - minAy) {
    return null
  }

  return [
    [
      { x: minAx - minBx + B[0].x, y: minAy - minBy + B[0].y },
      { x: maxAx - maxBx + B[0].x, y: minAy - minBy + B[0].y },
      { x: maxAx - maxBx + B[0].x, y: maxAy - maxBy + B[0].y },
      { x: minAx - minBx + B[0].x, y: maxAy - maxBy + B[0].y },
    ],
  ]
}
