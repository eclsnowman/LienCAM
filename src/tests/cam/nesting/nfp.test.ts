/* Tests for the orbiting-method NFP port (src/lib/cam/nesting/nfp.ts).
 *
 * Fixtures are tiny and hand-verifiable; each expected value is justified in a
 * comment from the Minkowski-sum definition of the NFP (the outer NFP of A and
 * B is the boundary of A (+) (-B), the set of B-reference offsets where B
 * touches A without overlapping).
 */

import { describe, it, expect } from 'vitest'
import type { Vec2 } from '../../../types/index'
import { noFitPolygon, noFitPolygonRectangle } from '../../../lib/cam/nesting/nfp'
import { intersect, pointInPolygon } from '../../../lib/cam/nesting/geometry'

// ── helpers ────────────────────────────────────────────────────────────────

function signedArea(p: Vec2[]): number {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += (p[j].x + p[i].x) * (p[j].y - p[i].y)
  }
  return 0.5 * a
}

function bbox(p: Vec2[]) {
  let minX = p[0].x
  let minY = p[0].y
  let maxX = p[0].x
  let maxY = p[0].y
  for (const v of p) {
    if (v.x < minX) minX = v.x
    if (v.x > maxX) maxX = v.x
    if (v.y < minY) minY = v.y
    if (v.y > maxY) maxY = v.y
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

/** Translate a polygon by (dx, dy). */
function translate(p: Vec2[], dx: number, dy: number): Vec2[] {
  return p.map((v) => ({ x: v.x + dx, y: v.y + dy }))
}

/**
 * True if convex polygons P and Q overlap on a positive area. The NFP boundary
 * places B in pure contact (no area overlap), so when B is positioned at an NFP
 * vertex this must report false. We detect overlap as: any edge crossing, OR a
 * vertex of one polygon strictly interior to the other.
 */
function overlaps(P: Vec2[], Q: Vec2[]): boolean {
  // close the loops for the edge-based intersect()
  const Pc = P[0] === P[P.length - 1] ? P : [...P, P[0]]
  const Qc = Q[0] === Q[Q.length - 1] ? Q : [...Q, Q[0]]
  if (intersect(Pc, Qc)) return true
  for (const v of P) {
    if (pointInPolygon(v, Q) === true) return true
  }
  for (const v of Q) {
    if (pointInPolygon(v, P) === true) return true
  }
  return false
}

const UNIT_SQUARE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

// ── tests ────────────────────────────────────────────────────────────────

describe('noFitPolygon - two axis-aligned unit squares', () => {
  it('produces the known 2x2 square locus', () => {
    const A = UNIT_SQUARE
    const B = UNIT_SQUARE.map((p) => ({ ...p }))
    const nfp = noFitPolygon(A, B, false, false)

    expect(nfp).not.toBeNull()
    expect(nfp!.length).toBe(1)

    // The outer NFP of two unit squares is the Minkowski sum of the square with
    // its own negation: a 2x2 square centred on the origin, spanning
    // (-1,-1)..(1,1). |area| = 4. (The orbit also emits the collinear
    // edge-midpoints, e.g. (-1,0), which lie ON the boundary and do not change
    // the locus.)
    const loop = nfp![0]
    const bb = bbox(loop)
    expect(bb.minX).toBeCloseTo(-1, 9)
    expect(bb.minY).toBeCloseTo(-1, 9)
    expect(bb.maxX).toBeCloseTo(1, 9)
    expect(bb.maxY).toBeCloseTo(1, 9)
    expect(Math.abs(signedArea(loop))).toBeCloseTo(4, 9)

    // Every distinct corner of the 2x2 locus is present as a vertex.
    const corners = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ]
    for (const c of corners) {
      expect(loop.some((v) => Math.abs(v.x - c.x) < 1e-9 && Math.abs(v.y - c.y) < 1e-9)).toBe(true)
    }
  })

  it('placing B at NFP vertices yields contact but no overlap', () => {
    const A = UNIT_SQUARE
    const B = UNIT_SQUARE.map((p) => ({ ...p }))
    const nfp = noFitPolygon(A, B, false, false)!
    // The NFP reference point tracks B[0] (here (0,0)); an NFP vertex therefore
    // IS the (dx,dy) to apply to B. At every such offset B may touch A but must
    // not overlap it on positive area.
    for (const v of nfp[0]) {
      const placed = translate(B, v.x, v.y)
      expect(overlaps(A, placed)).toBe(false)
    }
  })
})

describe('noFitPolygon - concave L-shape vs square', () => {
  // L-shape: a 2x2 square with the top-right 1x1 quadrant removed (concave,
  // 6 vertices).
  const L: Vec2[] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: 2 },
    { x: 0, y: 2 },
  ]

  it('has the expected vertex count and bounding box', () => {
    const nfp = noFitPolygon(L, UNIT_SQUARE.map((p) => ({ ...p })), false, false)
    expect(nfp).not.toBeNull()
    expect(nfp!.length).toBe(1)

    const loop = nfp![0]
    // Sliding a unit square around the L traces a staircase loop. Observed and
    // verified: 10 vertices, bounding box (-1,-1)..(2,2) - the L footprint
    // grown by 1 in every outward direction.
    expect(loop.length).toBe(10)
    const bb = bbox(loop)
    expect(bb.minX).toBeCloseTo(-1, 9)
    expect(bb.minY).toBeCloseTo(-1, 9)
    expect(bb.maxX).toBeCloseTo(2, 9)
    expect(bb.maxY).toBeCloseTo(2, 9)
  })

  it('placing the square at NFP vertices yields no overlap with the L', () => {
    const B = UNIT_SQUARE.map((p) => ({ ...p }))
    const nfp = noFitPolygon(L, B, false, false)!
    for (const v of nfp[0]) {
      const placed = translate(B, v.x, v.y)
      // L is concave; overlaps() detects edge crossings and interior vertices,
      // which is sufficient for this axis-aligned fixture.
      expect(overlaps(L, placed)).toBe(false)
    }
  })
})

describe('noFitPolygonRectangle - inner-fit region', () => {
  it('shrinks the sheet by the part extents', () => {
    const sheet: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
      { x: 0, y: 6 },
    ]
    const part: Vec2[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 3 },
      { x: 0, y: 3 },
    ]
    const ifp = noFitPolygonRectangle(sheet, part)
    expect(ifp).not.toBeNull()
    expect(ifp!.length).toBe(1)

    // Part is 2 wide x 3 tall; sheet is 10 x 6. The reference point B[0]=(0,0)
    // (the part's lower-left) may range over (10-2) x (6-3) = 8 x 3, anchored
    // at the origin: rectangle (0,0)..(8,3).
    expect(ifp![0]).toEqual([
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 3 },
      { x: 0, y: 3 },
    ])
  })

  it('returns null when the part is too large for the sheet', () => {
    const sheet: Vec2[] = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
    ]
    const part: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 0, y: 1 },
    ]
    expect(noFitPolygonRectangle(sheet, part)).toBeNull()
  })
})

describe('noFitPolygon - determinism', () => {
  it('returns byte-identical results across two runs on identical input', () => {
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ]
    const r1 = noFitPolygon(
      L.map((p) => ({ ...p })),
      UNIT_SQUARE.map((p) => ({ ...p })),
      false,
      true
    )
    const r2 = noFitPolygon(
      L.map((p) => ({ ...p })),
      UNIT_SQUARE.map((p) => ({ ...p })),
      false,
      true
    )
    expect(r1).toEqual(r2)
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2))
  })

  it('does not mutate the caller input arrays', () => {
    const A = UNIT_SQUARE.map((p) => ({ ...p }))
    const B = UNIT_SQUARE.map((p) => ({ ...p }))
    const Asnap = JSON.stringify(A)
    const Bsnap = JSON.stringify(B)
    noFitPolygon(A, B, false, true)
    expect(JSON.stringify(A)).toBe(Asnap)
    expect(JSON.stringify(B)).toBe(Bsnap)
  })
})
