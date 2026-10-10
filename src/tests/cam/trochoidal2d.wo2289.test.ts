// WO-2289: the trochoidal orbit sampler, on Y-up guides (CCW and CW).
//
// The contract is measured on EMITTED CHORDS, never on a step count: every chord
// sits within 0.0022 D of the true trochoid; the tool centre reaches exactly
// toolRadius + S + 0.01 D toward the wall on both cut sides; a whole number of
// orbits closes the seam; and the orbit turns the way climb / conventional ask.

import { describe, expect, it } from 'vitest'
import {
  ORBIT_SAGITTA_FRACTION, TROCHOIDAL_ALLOWANCE_FRACTION, buildTrochoid, orbitSenseFor,
  resolveTrochoidalGeometry, trochoidalGuideOffset, type Trochoid,
} from '../../lib/cam/trochoidal2d'
import type { Vec2 } from '../../types'

const D = 6
const S = 0.5

function rect(x0: number, y0: number, x1: number, y1: number, cw = false): Vec2[] {
  const ccw = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  return cw ? [ccw[0], ccw[3], ccw[2], ccw[1]] : ccw
}

/** Outer offset of rect [0,w]x[0,h] by g, round corners, CCW from (0,-g). */
function roundedOffset(w: number, h: number, g: number): Vec2[] {
  const pts: Vec2[] = []
  const corners = [
    { c: { x: w, y: 0 }, a0: -Math.PI / 2 },
    { c: { x: w, y: h }, a0: 0 },
    { c: { x: 0, y: h }, a0: Math.PI / 2 },
    { c: { x: 0, y: 0 }, a0: Math.PI },
  ]
  pts.push({ x: 0, y: -g })
  for (const { c, a0 } of corners) {
    for (let k = 0; k <= 180; k++) {
      const a = a0 + (Math.PI / 2) * (k / 180)
      pts.push({ x: c.x + g * Math.cos(a), y: c.y + g * Math.sin(a) })
    }
  }
  pts.pop() // (0,-g) closes the loop
  return pts
}

function distPointSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

/** Distance from chord ab to the polygon's edges (0 if it crosses one). */
function chordToPolygon(a: Vec2, b: Vec2, poly: Vec2[]): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    if (segmentsCross(a, b, p, q)) return 0
    best = Math.min(best, distPointSeg(a, p, q), distPointSeg(b, p, q), distPointSeg(p, a, b), distPointSeg(q, a, b))
  }
  return best
}

function chordReach(t: Trochoid, wall: Vec2[]): { min: number } {
  let min = Infinity
  for (let i = 1; i < t.points.length; i++) min = Math.min(min, chordToPolygon(t.points[i - 1], t.points[i], wall))
  return { min }
}

const RATIOS = [1.15, 1.5, 2, 2.5]

describe('WO-2289 trochoidal sampler: geometry resolution', () => {
  it('an unset channel follows the tool: 1.5 D wide, 0.1 D advance, R = (W - D) / 2', () => {
    const g = resolveTrochoidalGeometry(D)
    expect(g.width).toBe(9)
    expect(g.advance).toBeCloseTo(0.6, 12)
    expect(g.orbitRadius).toBe(1.5)
  })
  it('a set value is kept, and one outside 1.15..2.5 D (width) or 0.01..0.5 D (advance) snaps to the limit', () => {
    expect(resolveTrochoidalGeometry(D, 12, 1).width).toBe(12)
    expect(resolveTrochoidalGeometry(D, 12, 1).advance).toBe(1)
    const low = resolveTrochoidalGeometry(D, 3, 0.001)
    expect(low.width).toBeCloseTo(1.15 * D, 12)
    expect(low.advance).toBeCloseTo(0.01 * D, 12)
    expect(low.orbitRadius).toBeCloseTo(0.075 * D, 12)
    expect(resolveTrochoidalGeometry(D, 40, 10)).toEqual({ width: 15, advance: 3, orbitRadius: 4.5 })
  })
  it('guideOffset = S + W/2 + 0.01 D', () => {
    expect(trochoidalGuideOffset(D, 9, S)).toBeCloseTo(0.5 + 4.5 + 0.06, 12)
  })
})

describe('WO-2289 trochoidal sampler: emitted chords within 0.0022 D of the true trochoid', () => {
  for (const cw of [false, true]) {
    for (const sense of [1, -1] as const) {
      for (const ratio of RATIOS) {
        it(`${cw ? 'CW' : 'CCW'} guide, ${sense > 0 ? 'CCW' : 'CW'} orbit, W = ${ratio} D`, () => {
          const geo = resolveTrochoidalGeometry(D, ratio * D)
          const guide = rect(0, 0, 80, 50, cw)
          const t = buildTrochoid(guide, { orbitRadius: geo.orbitRadius, advance: geo.advance, toolDiameter: D, sense })!
          expect(t).not.toBeNull()
          const tol = ORBIT_SAGITTA_FRACTION * D
          const R = geo.orbitRadius
          const n = t.stepsPerLoop
          const moving = t.loopCount * n
          const c0 = guide[0]
          const u = { x: guide[1].x - guide[0].x, y: guide[1].y - guide[0].y }
          const side = Math.hypot(u.x, u.y)
          u.x /= side; u.y /= side
          // The closed-form trochoid while the centre runs the first straight side.
          const trueAt = (k: number): Vec2 => {
            const d = t.guideLength * k / moving
            const ph = sense * 2 * Math.PI * k / n
            return { x: c0.x + u.x * d + R * Math.cos(ph), y: c0.y + u.y * d + R * Math.sin(ph) }
          }
          let worst = 0
          let checked = 0
          // Stationary orbit: chords against the circle round c0.
          for (let i = 1; i <= n; i++) {
            for (let f = 0; f <= 20; f++) {
              const ph = sense * 2 * Math.PI * (i - 1 + f / 20) / n
              const p = { x: c0.x + R * Math.cos(ph), y: c0.y + R * Math.sin(ph) }
              worst = Math.max(worst, distPointSeg(p, t.points[i - 1], t.points[i]))
            }
            checked++
          }
          // Advancing orbit along the first side.
          for (let i = n + 1; i < t.points.length; i++) {
            const k = i - n
            if (t.centreDistance[i] > side - 1e-9) break
            for (let f = 0; f <= 20; f++) worst = Math.max(worst, distPointSeg(trueAt(k - 1 + f / 20), t.points[i - 1], t.points[i]))
            checked++
          }
          expect(checked).toBeGreaterThan(5 * n)
          expect(worst).toBeLessThanOrEqual(tol)
        })
      }
    }
  }
})

describe('WO-2289 trochoidal sampler: tool-centre reach toward the wall = toolRadius + S + 0.01 D', () => {
  const want = D / 2 + S + TROCHOIDAL_ALLOWANCE_FRACTION * D
  for (const ratio of RATIOS) {
    it(`outside a 100 x 60 part, W = ${ratio} D`, () => {
      const geo = resolveTrochoidalGeometry(D, ratio * D)
      const g = trochoidalGuideOffset(D, geo.width, S)
      const t = buildTrochoid(roundedOffset(100, 60, g), {
        orbitRadius: geo.orbitRadius, advance: geo.advance, toolDiameter: D, sense: 1,
      })!
      const { min } = chordReach(t, rect(0, 0, 100, 60))
      // This test's own guide polygon sits up to 5e-5 mm inside its round corners.
      expect(min).toBeGreaterThanOrEqual(want - 1e-4)
      expect(min).toBeLessThanOrEqual(want + ORBIT_SAGITTA_FRACTION * D)
    })
    it(`inside a 40 x 40 hole, W = ${ratio} D`, () => {
      const geo = resolveTrochoidalGeometry(D, ratio * D)
      const g = trochoidalGuideOffset(D, geo.width, S)
      const t = buildTrochoid(rect(g, g, 40 - g, 40 - g, true), {
        orbitRadius: geo.orbitRadius, advance: geo.advance, toolDiameter: D, sense: -1,
      })!
      const { min } = chordReach(t, rect(0, 0, 40, 40))
      expect(min).toBeGreaterThanOrEqual(want - 1e-6)
      expect(min).toBeLessThanOrEqual(want + ORBIT_SAGITTA_FRACTION * D)
    })
  }
})

describe('WO-2289 trochoidal sampler: the seam closes', () => {
  it('a whole number of orbits: the last point is the first, and the advance is within 1% of the request', () => {
    const geo = resolveTrochoidalGeometry(D)
    const guide = roundedOffset(100, 60, trochoidalGuideOffset(D, geo.width, S))
    const t = buildTrochoid(guide, { orbitRadius: geo.orbitRadius, advance: geo.advance, toolDiameter: D, sense: 1 })!
    expect(Number.isInteger(t.loopCount)).toBe(true)
    expect(t.points[t.points.length - 1]).toEqual(t.points[0])
    expect(t.actualAdvance * t.loopCount).toBeCloseTo(t.guideLength, 9)
    expect(Math.abs(t.actualAdvance - geo.advance) / geo.advance).toBeLessThan(0.01)
    // Centre distance between successive orbits is the advance, every orbit.
    for (let k = 1; k <= t.loopCount; k++) {
      const i = t.stepsPerLoop * (k + 1)
      expect(t.centreDistance[i] - t.centreDistance[i - t.stepsPerLoop]).toBeCloseTo(t.actualAdvance, 9)
    }
  })
})

describe('WO-2289 trochoidal sampler: orbit sense (Y-up)', () => {
  const signedArea = (pts: Vec2[]) =>
    pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y }, 0) / 2

  it('climb orbits counter-clockwise, conventional clockwise', () => {
    expect(orbitSenseFor('climb')).toBe(1)
    expect(orbitSenseFor('conventional')).toBe(-1)
  })

  for (const cw of [false, true]) {
    for (const direction of ['climb', 'conventional'] as const) {
      it(`${direction} on a ${cw ? 'CW' : 'CCW'} guide: the orbit turns its own way and the material ahead is on the cutter's ${direction === 'climb' ? 'right' : 'left'}`, () => {
        const geo = resolveTrochoidalGeometry(D)
        const guide = rect(0, 0, 80, 50, cw)
        const t = buildTrochoid(guide, { orbitRadius: geo.orbitRadius, advance: geo.advance, toolDiameter: D, sense: orbitSenseFor(direction) })!
        const stationary = t.points.slice(0, t.stepsPerLoop)
        expect(Math.sign(signedArea(stationary))).toBe(direction === 'climb' ? 1 : -1)
        // At the orbit's leading point (furthest along the advance), the cutter's motion
        // has the uncut material ahead of it on its right for climb, left for conventional.
        const u = { x: guide[1].x - guide[0].x, y: guide[1].y - guide[0].y }
        const L = Math.hypot(u.x, u.y)
        u.x /= L; u.y /= L
        let lead = t.stepsPerLoop + 1
        const end = t.stepsPerLoop * 4
        for (let i = lead; i < end; i++) {
          const p = t.points[i]
          const c = t.points[lead]
          if (p.x * u.x + p.y * u.y > c.x * u.x + c.y * u.y) lead = i
        }
        const a = t.points[lead]
        const b = t.points[lead + 1]
        const motion = { x: b.x - a.x, y: b.y - a.y }
        const cross = motion.x * u.y - motion.y * u.x
        // cross < 0: u (the material ahead) is to the right of the motion.
        expect(Math.sign(cross)).toBe(direction === 'climb' ? -1 : 1)
      })
    }
  }
})
