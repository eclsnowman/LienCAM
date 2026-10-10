// WO-2287: corner relief geometry - dogbone, T-bone and longest edge.
//
// Two coverage models prove the touch-the-corner rule:
//   - the exact one (a capsule of cutter radius around every fed move) over the whole
//     corner wedge within r of the corner, at every corner angle 30-150 deg;
//   - the app's own heightmap simulator (src/lib/simulation) at the corner point.
// Ending the excursion at r clears the corner; the same pass ended at 1.2r leaves
// material (the negative test, ported from PureCutCNC's cornerRelief.test.ts). Every loop
// here is Y-up: a CCW loop encloses its interior on its left.
import { describe, expect, it } from 'vitest'
import {
  appendCornerRelief,
  findReliefCorners,
  placeReliefCorners,
  reliefExcursionEnd,
  type ReliefCornerGeometry,
  type ReliefLoop,
  type ReliefStyle,
} from '../../lib/cam/cornerRelief2d'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import type { ToolpathMove, Vec2 } from '../../types'

const R = 3
const ANGLES = [30, 45, 60, 75, 90, 105, 120, 135, 150]
const STYLES: ReliefStyle[] = ['dogbone', 't_bone', 'longest_edge']
const Z = -2

const deg = (a: number) => (a * Math.PI) / 180
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)

/** A cleared triangle (CCW, cleared inside) whose corner at the origin has interior
 *  angle `angle`, opening about +X, edges `len` long. The far edge is moved off so the
 *  two far corners never interfere with the one under test. */
function wedgeLoop(angle: number, lenA = 40, lenB = 40): ReliefLoop {
  const h = deg(angle) / 2
  return {
    clearedInside: true,
    points: [
      { x: 0, y: 0 },
      { x: lenA * Math.cos(-h), y: lenA * Math.sin(-h) },
      { x: lenB * Math.cos(h), y: lenB * Math.sin(h) },
    ],
  }
}

function cornerAtOrigin(loop: ReliefLoop): ReliefCornerGeometry {
  const found = findReliefCorners([loop], R).filter(c => Math.hypot(c.corner.x, c.corner.y) < 1e-9)
  expect(found).toHaveLength(1)
  return found[0]
}

/** The main path's wall pass near the corner: the tool centre runs along both offset
 *  walls into the apex P = C + b r / sin(theta/2) and out again, at depth Z. */
function wallPass(g: ReliefCornerGeometry, reach = 25): ToolpathMove[] {
  const p = descendPoint(g)
  const a = { x: p.x + g.edgeA.x * reach, y: p.y + g.edgeA.y * reach }
  const b = { x: p.x + g.edgeB.x * reach, y: p.y + g.edgeB.y * reach }
  return [
    { type: 'rapid', x: a.x, y: a.y, z: 5, role: 'rapid' },
    { type: 'feed', x: a.x, y: a.y, z: Z, role: 'plunge', feed: 300 },
    { type: 'feed', x: p.x, y: p.y, z: Z, role: 'cut', feed: 1000 },
    { type: 'feed', x: b.x, y: b.y, z: Z, role: 'cut', feed: 1000 },
    { type: 'rapid', x: b.x, y: b.y, z: 5, role: 'rapid' },
  ]
}

function descendPoint(g: ReliefCornerGeometry): Vec2 {
  const t = R / Math.sin(g.interiorAngle / 2)
  return { x: g.corner.x + g.bisector.x * t, y: g.corner.y + g.bisector.y * t }
}

function excursion(g: ReliefCornerGeometry, end: Vec2): ToolpathMove[] {
  const p = descendPoint(g)
  return [
    { type: 'feed', x: p.x, y: p.y, z: Z, role: 'plunge', feed: 300 },
    { type: 'feed', x: end.x, y: end.y, z: Z, role: 'cut', feed: 1000 },
    { type: 'feed', x: p.x, y: p.y, z: Z, role: 'cut', feed: 1000 },
  ]
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** Exact coverage: some fed move at or below Z passes within r of `p`. */
function covered(p: Vec2, moves: ToolpathMove[]): boolean {
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid' || a.z > Z + 1e-9 || b.z > Z + 1e-9) continue
    if (segDist(p, a, b) <= R * (1 + 1e-9)) return true
  }
  return false
}

/** The corner wedge: every point strictly between the two walls within r of the corner -
 *  what a mating square part needs removed and what an unrelieved cutter leaves. */
function wedgeSamples(g: ReliefCornerGeometry): Vec2[] {
  const base = Math.atan2(g.edgeA.y, g.edgeA.x)
  const toward = Math.sign(g.edgeA.x * g.bisector.y - g.edgeA.y * g.bisector.x) || 1
  const out: Vec2[] = []
  for (let f = 0.02; f <= 0.98; f += 0.06) {
    const a = base + toward * g.interiorAngle * f
    for (let d = 0.1; d <= 1.0001; d += 0.1) {
      out.push({ x: g.corner.x + Math.cos(a) * R * d, y: g.corner.y + Math.sin(a) * R * d })
    }
  }
  return out
}

/** The app's heightmap simulator over the corner region, every move swept. */
function heightmapAfter(moves: ToolpathMove[], corner: Vec2): HeightmapSimulator {
  const sim = new HeightmapSimulator(corner.x - 6, corner.y - 6, 12, 12, 0, -10, 0.04)
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    sim.sweepMove(a.x, a.y, a.z, b.x, b.y, b.z, R)
  }
  return sim
}

function heightAt(sim: HeightmapSimulator, p: Vec2): number {
  const ix = Math.floor((p.x - sim.x0) / sim.cellSize)
  const iy = Math.floor((p.y - sim.y0) / sim.cellSize)
  return sim.heights[iy * sim.nx + ix]
}

/** A point just inside the corner, on its bisector: the material a fillet leaves. */
const cornerPoint = (g: ReliefCornerGeometry): Vec2 =>
  ({ x: g.corner.x + g.bisector.x * 0.1, y: g.corner.y + g.bisector.y * 0.1 })

describe('WO-2287 corner relief: the touch-the-corner rule', () => {
  for (const style of STYLES) {
    it(`${style}: the excursion ends exactly r from the corner along its direction, at 30-150 deg`, () => {
      for (const angle of ANGLES) {
        const g = cornerAtOrigin(wedgeLoop(angle))
        expect(g.interiorAngle).toBeCloseTo(deg(angle), 9)
        const end = reliefExcursionEnd(g, style, R)
        expect(dist(end, g.corner)).toBeCloseTo(R, 9)
        const dir = { x: end.x / R, y: end.y / R }
        if (style === 'dogbone') {
          // Bisector of a wedge opening about +X.
          expect(dir.x).toBeCloseTo(1, 9)
          expect(dir.y).toBeCloseTo(0, 9)
        } else {
          // Along one adjacent edge.
          const onA = Math.hypot(dir.x - g.edgeA.x, dir.y - g.edgeA.y) < 1e-9
          const onB = Math.hypot(dir.x - g.edgeB.x, dir.y - g.edgeB.y) < 1e-9
          expect(onA || onB).toBe(true)
        }
      }
    })

    it(`${style}: ending at r clears the whole corner wedge at every angle (exact sweep)`, () => {
      for (const angle of ANGLES) {
        const g = cornerAtOrigin(wedgeLoop(angle))
        const moves = [...wallPass(g), ...excursion(g, reliefExcursionEnd(g, style, R))]
        const uncut = wedgeSamples(g).filter(p => !covered(p, moves))
        expect(uncut, `${style} at ${angle} deg`).toEqual([])
      }
    })

    it(`${style}: the heightmap simulator shows no material at the corner point at every angle`, () => {
      for (const angle of ANGLES) {
        const g = cornerAtOrigin(wedgeLoop(angle))
        const moves = [...wallPass(g, 8), ...excursion(g, reliefExcursionEnd(g, style, R))]
        expect(heightAt(heightmapAfter(moves, g.corner), cornerPoint(g)), `${style} at ${angle} deg`).toBe(Z)
      }
    })
  }

  // Ending short is the failure direction, and r is a limit, not a margin. A T-bone ends
  // on a wall, so past about 105 deg its capsule body crosses the corner whatever the
  // end distance; the short probe bites at the angles where a T-bone is worth cutting.
  for (const style of STYLES) {
    const angles = style === 'dogbone' ? ANGLES : ANGLES.filter(a => a <= 90)
    it(`${style}: the same pass ended at 1.2r leaves material in the corner (${angles.join(', ')} deg)`, () => {
      for (const angle of angles) {
        const g = cornerAtOrigin(wedgeLoop(angle))
        const moves = [...wallPass(g), ...excursion(g, reliefExcursionEnd(g, style, 1.2 * R))]
        expect(wedgeSamples(g).some(p => !covered(p, moves)), `${style} at ${angle} deg`).toBe(true)
        const short = [...wallPass(g, 8), ...excursion(g, reliefExcursionEnd(g, style, 1.2 * R))]
        expect(heightAt(heightmapAfter(short, g.corner), cornerPoint(g)), `${style} at ${angle} deg`).toBe(0)
      }
    })
  }

  it('without relief the wall pass alone leaves the corner uncut at every angle', () => {
    for (const angle of ANGLES) {
      const g = cornerAtOrigin(wedgeLoop(angle))
      expect(wedgeSamples(g).some(p => !covered(p, wallPass(g)))).toBe(true)
      expect(heightAt(heightmapAfter(wallPass(g, 8), g.corner), cornerPoint(g))).toBe(0)
    }
  })
})

describe('WO-2287 corner relief: which corners qualify', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
    [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  // L-shaped island, CCW in Y-up. Its one reflex corner is (28, 20).
  const L: Vec2[] = [
    { x: 20, y: 12 }, { x: 40, y: 12 }, { x: 40, y: 20 }, { x: 28, y: 20 }, { x: 28, y: 28 }, { x: 20, y: 28 },
  ]

  it('a pocket boundary (cleared inside) has its four corners relieved, whichever way it winds', () => {
    for (const pts of [rect(0, 0, 60, 40), [...rect(0, 0, 60, 40)].reverse()]) {
      const found = findReliefCorners([{ points: pts, clearedInside: true }], R)
      expect(found.map(c => `${c.corner.x},${c.corner.y}`).sort()).toEqual(['0,0', '0,40', '60,0', '60,40'])
      for (const c of found) {
        expect(c.interiorAngle).toBeCloseTo(Math.PI / 2, 9)
        // The bisector points into the pocket.
        expect(c.corner.x + c.bisector.x).toBeGreaterThan(0)
        expect(c.corner.x + c.bisector.x).toBeLessThan(60)
        expect(c.corner.y + c.bisector.y).toBeGreaterThan(0)
        expect(c.corner.y + c.bisector.y).toBeLessThan(40)
      }
    }
  })

  it('convex corners of the material get no excursion: a square island, a part routed outside', () => {
    const square = rect(20, 12, 40, 28)
    expect(findReliefCorners([{ points: square, clearedInside: false }], R)).toEqual([])
    expect(findReliefCorners([{ points: [...square].reverse(), clearedInside: false }], R)).toEqual([])
  })

  it("an L-shaped island's reflex corner is relieved and only that one, whichever way it winds", () => {
    for (const pts of [L, [...L].reverse()]) {
      const found = findReliefCorners([{ points: pts, clearedInside: false }], R)
      expect(found).toHaveLength(1)
      expect(found[0].corner).toEqual({ x: 28, y: 20 })
      // Into the notch of the L, which is the cleared side.
      expect(found[0].bisector.x).toBeCloseTo(Math.SQRT1_2, 9)
      expect(found[0].bisector.y).toBeCloseTo(Math.SQRT1_2, 9)
    }
  })

  it('an edge drawn in collinear pieces, with repeated points and a closing point, counts as one edge', () => {
    // 60 x 40 pocket whose edges are split every 2 mm (shorter than 2r) with a repeated
    // vertex and the start point repeated at the end, as DXF and sketch loops can be.
    const pts: Vec2[] = []
    const ring = rect(0, 0, 60, 40)
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4]
      const n = Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 2)
      for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
      pts.push({ ...pts[pts.length - 1] })
    }
    pts.push({ ...pts[0] })
    const found = findReliefCorners([{ points: pts, clearedInside: true }], R)
    expect(found.map(c => `${c.corner.x},${c.corner.y}`).sort()).toEqual(['0,0', '0,40', '60,0', '60,40'])
    expect(found.every(c => Math.min(c.lengthA, c.lengthB) >= 40 - 1e-9)).toBe(true)
  })

  it('very shallow inside corners and edges shorter than 2r are not relieved', () => {
    // A 170 deg inside corner: the notch would be under 0.004 r.
    const shallow = wedgeLoop(170)
    expect(findReliefCorners([shallow], R).filter(c => Math.hypot(c.corner.x, c.corner.y) < 1e-9)).toEqual([])
    // A 90 deg corner whose one edge is 5 mm < 2r.
    const short = wedgeLoop(90, 5, 40)
    expect(findReliefCorners([short], R).filter(c => Math.hypot(c.corner.x, c.corner.y) < 1e-9)).toEqual([])
  })

  it('T-bone runs along the edge nearer parallel to X; Longest edge along the longer edge (Y-up)', () => {
    const wide = findReliefCorners([{ points: rect(0, 0, 60, 40), clearedInside: true }], R)
      .find(c => c.corner.x === 0 && c.corner.y === 0)!
    expect(reliefExcursionEnd(wide, 't_bone', R)).toEqual({ x: 3, y: 0 })
    expect(reliefExcursionEnd(wide, 'longest_edge', R)).toEqual({ x: 3, y: 0 })
    const tall = findReliefCorners([{ points: rect(0, 0, 40, 60), clearedInside: true }], R)
      .find(c => c.corner.x === 0 && c.corner.y === 0)!
    expect(reliefExcursionEnd(tall, 't_bone', R)).toEqual({ x: 3, y: 0 })
    expect(reliefExcursionEnd(tall, 'longest_edge', R)).toEqual({ x: 0, y: 3 })
    const top = findReliefCorners([{ points: rect(0, 0, 40, 60), clearedInside: true }], R)
      .find(c => c.corner.x === 40 && c.corner.y === 60)!
    expect(reliefExcursionEnd(top, 't_bone', R)).toEqual({ x: 37, y: 60 })
    expect(reliefExcursionEnd(top, 'longest_edge', R)).toEqual({ x: 40, y: 57 })
  })
})

describe('WO-2287 corner relief: it descends only where the main path already cut', () => {
  const g = () => cornerAtOrigin(wedgeLoop(90))
  const levels = [-1, -2]

  it('relieves every level the wall pass reached, descending at the wall-pass apex', () => {
    const placed = placeReliefCorners([g()], 'dogbone', R, [0], levels, wallPass(g()))
    expect(placed).toHaveLength(1)
    expect(dist(placed[0].descend, descendPoint(g()))).toBeLessThan(1e-9)
    expect(placed[0].levels).toEqual([-1, -2])
  })

  it('a corner the main path never reached is simply not relieved', () => {
    expect(placeReliefCorners([g()], 'dogbone', R, [0], levels, [])).toEqual([])
  })

  it('a corner the main path reached only higher up (a holding tab) is relieved only above it', () => {
    const lifted = wallPass(g()).map(m => (m.z === Z ? { ...m, z: -1 } : m))
    const placed = placeReliefCorners([g()], 'dogbone', R, [0], levels, lifted)
    expect(placed[0].levels).toEqual([-1])
  })

  it('a roughing-only wall left at stock is relieved to the corner of that wall, not the drawn one', () => {
    const stock = 0.5
    const corner = g()
    const roughApex = R + stock
    const sin = Math.sin(corner.interiorAngle / 2)
    const p = { x: roughApex / sin, y: 0 }
    const path: ToolpathMove[] = [
      { type: 'feed', x: p.x + corner.edgeA.x * 20, y: p.y + corner.edgeA.y * 20, z: Z, role: 'cut' },
      { type: 'feed', x: p.x, y: p.y, z: Z, role: 'cut' },
      { type: 'feed', x: p.x + corner.edgeB.x * 20, y: p.y + corner.edgeB.y * 20, z: Z, role: 'cut' },
    ]
    const placed = placeReliefCorners([corner], 'dogbone', R, [0, stock], [Z], path)
    expect(placed).toHaveLength(1)
    // The wall's corner sits stock / sin(theta/2) out the bisector; the cutter ends r beyond it.
    expect(placed[0].end.x).toBeCloseTo(stock / sin + R, 9)
  })

  it('None (or absent) appends nothing', () => {
    const moves = wallPass(g())
    const before = JSON.stringify(moves)
    const opts = { feedZ: 1, retractZ: 5, clearanceZ: 10, feedRate: 1000, plungeRate: 300 }
    appendCornerRelief(moves, 'none', R, 0, [{ loops: [wedgeLoop(90)], levels }], opts)
    appendCornerRelief(moves, undefined, R, 0, [{ loops: [wedgeLoop(90)], levels }], opts)
    expect(JSON.stringify(moves)).toBe(before)
  })
})
