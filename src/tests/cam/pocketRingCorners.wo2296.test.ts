// WO-2296: Pocket's clearing rings take their corners as arcs - the geometry.
//
// Y-up throughout: a counterclockwise ring has positive signed area and turns
// left at its convex corners; a clockwise ring (an island's winding, or a ring
// cut conventional) turns right. Each arc must be tangent to both edges and turn
// the way its ring turns. Coverage is checked on an independent 0.05 mm grid:
// every cell the sharp rings sweep (within one tool radius of a cut path) must be
// swept by the rounded rings too.
import { describe, expect, it } from 'vitest'
import { offsetLoop, ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import {
  RING_CORNER_ARC_STEP_DEG, RING_CORNER_MIN_TURN_DEG, cornerArc, ringCorners, roundPocketRingCorners, roundRing,
} from '../../lib/cam/pocketRingCorners'

await ensureClipperReady()

type Pt = { x: number; y: number }
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const area = (r: readonly Pt[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p.x * q.y - q.x * p.y }, 0) / 2

/** Pocket's rings: the wall ring one tool radius in, then one stepover at a time. */
function rings(outer: Pt[], R: number, s: number): Pt[][][] {
  const gens: Pt[][][] = []
  let cur = offsetLoop(outer, -R)
  while (cur.length > 0 && gens.length < 200) {
    gens.push(cur)
    cur = cur.flatMap(l => offsetLoop(l, -s))
  }
  return gens
}

function pointIn(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Cells within R of the cut paths (closed rings), skipping stretches inside a keep-out. */
function sweep(paths: Pt[][], R: number, h: number, box: { x0: number; y0: number; nx: number; ny: number }, keepOuts: Pt[][] = []): Uint8Array {
  const grid = new Uint8Array(box.nx * box.ny)
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const a0 = path[i], b0 = path[(i + 1) % path.length]
      const parts = keepOuts.length > 0 ? Math.max(1, Math.ceil(Math.hypot(b0.x - a0.x, b0.y - a0.y) / 0.25)) : 1
      for (let k = 0; k < parts; k++) {
        const a = { x: a0.x + (b0.x - a0.x) * k / parts, y: a0.y + (b0.y - a0.y) * k / parts }
        const b = { x: a0.x + (b0.x - a0.x) * (k + 1) / parts, y: a0.y + (b0.y - a0.y) * (k + 1) / parts }
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        if (keepOuts.some(isl => pointIn(a, isl) || pointIn(b, isl) || pointIn(mid, isl))) continue
        const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy
        const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R - box.x0) / h))
        const ix1 = Math.min(box.nx - 1, Math.ceil((Math.max(a.x, b.x) + R - box.x0) / h))
        const iy0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - R - box.y0) / h))
        const iy1 = Math.min(box.ny - 1, Math.ceil((Math.max(a.y, b.y) + R - box.y0) / h))
        for (let iy = iy0; iy <= iy1; iy++) {
          const y = box.y0 + iy * h
          for (let ix = ix0; ix <= ix1; ix++) {
            const x = box.x0 + ix * h
            let t = lenSq < 1e-18 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / lenSq
            t = t < 0 ? 0 : t > 1 ? 1 : t
            if (Math.hypot(a.x + t * dx - x, a.y + t * dy - y) <= R) grid[iy * box.nx + ix] = 1
          }
        }
      }
    }
  }
  return grid
}

/** Cells the sharp rings sweep that the rounded rings do not (island contours cut either way). */
function uncovered(sharp: Pt[][][], rounded: Pt[][][], R: number, keepOuts: Pt[][] = [], h = 0.05): number {
  const all = sharp.flat(2)
  const x0 = Math.min(...all.map(p => p.x)) - R - h, y0 = Math.min(...all.map(p => p.y)) - R - h
  const nx = Math.ceil((Math.max(...all.map(p => p.x)) + R + h - x0) / h) + 1
  const ny = Math.ceil((Math.max(...all.map(p => p.y)) + R + h - y0) / h) + 1
  const box = { x0, y0, nx, ny }
  const a = sweep(sharp.flat(), R, h, box, keepOuts)
  const b = sweep(rounded.flat(), R, h, box, keepOuts)
  // Pocket cuts every island's keep-out contour in full at every level, both ways.
  const contours = sweep(keepOuts, R, h, box)
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] && !b[i] && !contours[i]) n++
  return n
}

function turnDeg(a: Pt, b: Pt, c: Pt): { deg: number; left: boolean } {
  const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y
  const cr = ax * by - ay * bx
  return { deg: Math.atan2(Math.abs(cr), ax * bx + ay * by) * 180 / Math.PI, left: cr > 0 }
}

describe('WO-2296: a corner arc is tangent to both edges and turns the ring\'s way (Y-up)', () => {
  const ccw = rect(0, 0, 30, 20)
  const cw = [...ccw].reverse()

  it('a counterclockwise ring turns left at its four corners, and every arc turns left', () => {
    expect(area(ccw)).toBeGreaterThan(0)
    const corners = ringCorners(ccw)
    expect(corners.map(c => c.index)).toEqual([0, 1, 2, 3])
    for (const corner of corners) {
      expect(corner.left).toBe(true)
      const arc = cornerArc(ccw, corner, 3)
      expectTangent(ccw, arc)
      for (let k = 1; k + 1 < arc.points.length; k++) {
        const t = turnDeg(arc.points[k - 1], arc.points[k], arc.points[k + 1])
        expect(t.left).toBe(true)
        expect(t.deg).toBeLessThanOrEqual(RING_CORNER_ARC_STEP_DEG + 1e-9)
      }
    }
  })

  it('a clockwise (island-wound) ring turns right at its corners, and every arc turns right', () => {
    expect(area(cw)).toBeLessThan(0)
    const corners = ringCorners(cw)
    expect(corners).toHaveLength(4)
    for (const corner of corners) {
      expect(corner.left).toBe(false)
      const arc = cornerArc(cw, corner, 3)
      expectTangent(cw, arc)
      for (let k = 1; k + 1 < arc.points.length; k++) expect(turnDeg(arc.points[k - 1], arc.points[k], arc.points[k + 1]).left).toBe(false)
    }
  })

  it('a reflex vertex (turning against the ring) is never rounded - its arc would bulge toward the wall', () => {
    // An L: counterclockwise, one reflex vertex at (10, 10).
    const ell = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }]
    const corners = ringCorners(ell)
    expect(corners.map(c => c.index)).toEqual([0, 1, 2, 4, 5])
    const islandWound = [...ell].reverse()
    expect(ringCorners(islandWound).map(c => islandWound[c.index]))
      .not.toContainEqual({ x: 10, y: 10 })
  })

  it('a rounded ring has no vertex turning more than a curve sample (corner arcs at the requested radius)', () => {
    const corners = ringCorners(ccw)
    const rounded = roundRing(ccw, corners, corners.map(() => 3))
    for (let i = 0; i < rounded.length; i++) {
      const t = turnDeg(rounded[(i - 1 + rounded.length) % rounded.length], rounded[i], rounded[(i + 1) % rounded.length])
      expect(t.deg).toBeLessThanOrEqual(RING_CORNER_MIN_TURN_DEG)
    }
    // Nothing to round: the very same array comes back.
    expect(roundRing(ccw, corners, corners.map(() => 0))).toBe(ccw)
  })
})

function expectTangent(ring: Pt[], arc: ReturnType<typeof cornerArc>): void {
  const n = ring.length, i = arc.corner.index
  const prev = ring[(i - 1 + n) % n], v = ring[i], next = ring[(i + 1) % n]
  const uIn = { x: v.x - prev.x, y: v.y - prev.y }, uOut = { x: next.x - v.x, y: next.y - v.y }
  // Both tangent points sit on their edges' lines, one radius from the centre,
  // with the radius perpendicular to the edge there.
  for (const [p, u, a] of [[arc.entry, uIn, prev], [arc.exit, uOut, v]] as const) {
    expect(Math.abs((p.x - a.x) * u.y - (p.y - a.y) * u.x) / Math.hypot(u.x, u.y)).toBeLessThan(1e-9)
    expect(Math.hypot(p.x - arc.centre.x, p.y - arc.centre.y)).toBeCloseTo(arc.radius, 9)
    expect(((p.x - arc.centre.x) * u.x + (p.y - arc.centre.y) * u.y) / Math.hypot(u.x, u.y)).toBeCloseTo(0, 9)
  }
  for (const p of arc.points) expect(Math.hypot(p.x - arc.centre.x, p.y - arc.centre.y)).toBeCloseTo(arc.radius, 9)
  // The centre is on the side the ring turns toward.
  const side = uIn.x * (arc.centre.y - arc.entry.y) - uIn.y * (arc.centre.x - arc.entry.x)
  expect(side > 0).toBe(arc.corner.left)
}

describe('WO-2296: the rounded rings sweep everything the sharp rings sweep (0.05 mm grid)', () => {
  const R = 3

  it('60 x 40 pocket, 6 mm cutter, 40% stepover: interior rings rounded, nothing uncovered', () => {
    const sharp = rings(rect(0, 0, 60, 40), R, 2.4)
    const rounded = roundPocketRingCorners(sharp, { toolRadius: R })
    // The wall ring keeps its corners; every interior ring with room for an arc is rounded.
    expect(rounded[0][0]).toBe(sharp[0][0])
    const roundedRings = rounded.flat().filter((r, k) => r !== sharp.flat()[k])
    expect(roundedRings.length).toBeGreaterThanOrEqual(5)
    expect(uncovered(sharp, rounded, R)).toBe(0)
  })

  it('a rounded WALL ring would leave its corners uncut - which is why the proof keeps it sharp', () => {
    const sharp = rings(rect(0, 0, 60, 40), R, 2.4)
    const wall = sharp[0][0]
    const corners = ringCorners(wall)
    const forced = sharp.map((gen, g) => g === 0 ? [roundRing(wall, corners, corners.map(() => R))] : gen)
    expect(uncovered(sharp, forced, R)).toBeGreaterThan(100)
  })

  it('a stepover near the tool diameter shrinks the arcs until the coverage holds', () => {
    const sharp = rings(rect(0, 0, 60, 40), R, 5.4)
    const rounded = roundPocketRingCorners(sharp, { toolRadius: R })
    expect(uncovered(sharp, rounded, R)).toBe(0)
  })

  it('a triangle (acute corners) and a pocket with a square island: nothing uncovered', () => {
    const tri = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 20, y: 45 }]
    const triSharp = rings(tri, R, 2.4)
    const triRounded = roundPocketRingCorners(triSharp, { toolRadius: R })
    expect(triRounded.flat().some((r, k) => r !== triSharp.flat()[k])).toBe(true)
    expect(uncovered(triSharp, triRounded, R)).toBe(0)

    const island = offsetLoop(rect(24, 14, 38, 26), R)
    const sharp = rings(rect(0, 0, 62, 40), R, 2.4)
    const rounded = roundPocketRingCorners(sharp, { toolRadius: R, islands: island })
    expect(rounded.flat().some((r, k) => r !== sharp.flat()[k])).toBe(true)
    expect(uncovered(sharp, rounded, R, island)).toBe(0)
  })
})
