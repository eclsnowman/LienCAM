// WO-2500: Extrude and Revolve make light cages. A straight side of the profile
// is one cage span between its creased corners; curves get as many points as
// keep the skin within the chord tolerance; an extrude is two spans tall. The
// finished body keeps the shape it had with the old dense cages (the "before"
// figures below were measured on main at 80efa0b79 with this file's body()).

import { describe, expect, it } from 'vitest'
import type { Cage } from '../../form/cage'
import { edgeKey } from '../../form/cage'
import type { SketchEntity } from '../../lib/sketch/types'
import type { PlaneFrame, SketchPath } from '../../form/pipe'
import { extrudeProfileCage, revolveAxis, revolveProfileCage, sketchProfile } from '../../form/profile'
import { validateCage } from '../../form/halfEdge'
import { tessellateForm } from '../../form/finish'

const line = (id: string, a: [number, number], b: [number, number]) =>
  ({ id, kind: 'line', construction: false, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } }) as unknown as SketchEntity
const arc = (id: string, c: [number, number], r: number, a0: number, a1: number) =>
  ({ id, kind: 'arc', construction: false, center: { x: c[0], y: c[1] }, radius: r, startAngle: a0, endAngle: a1 }) as unknown as SketchEntity
const circle = (id: string, c: [number, number], r: number) =>
  ({ id, kind: 'circle', construction: false, center: { x: c[0], y: c[1] }, radius: r }) as unknown as SketchEntity
const polygon = (pts: Array<[number, number]>) => pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % pts.length]))
const XY: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
const XZ: PlaneFrame = { ...XY, normal: { x: 0, y: -1, z: 0 } }
const H = Math.PI / 2

// the profiles useFormSession falls back to with no sketch selected
const noSketchCircle: SketchPath = { points: Array.from({ length: 48 }, (_, i) => [20 * Math.cos((i * Math.PI) / 24), 20 * Math.sin((i * Math.PI) / 24), 0]), closed: true }
const noSketchSquare: SketchPath = { points: [[10, 0, 0], [20, 0, 0], [20, 10, 0], [10, 10, 0]], closed: true }
const rectangle = () => sketchProfile(polygon([[0, 0], [50, 0], [50, 30], [0, 30]]))!
const plate = () => {
  const hw = 25, hh = 15, r = 8
  return sketchProfile([
    line('b', [-hw + r, -hh], [hw - r, -hh]), arc('a1', [hw - r, -hh + r], r, -H, 0), line('r', [hw, -hh + r], [hw, hh - r]), arc('a2', [hw - r, hh - r], r, 0, H),
    line('t', [hw - r, hh], [-hw + r, hh]), arc('a3', [-hw + r, hh - r], r, H, 2 * H), line('l', [-hw, hh - r], [-hw, -hh + r]), arc('a4', [-hw + r, -hh + r], r, 2 * H, 3 * H),
  ])!
}
// an open vase outline from the axis: a filleted foot, a straight wall, a rounded shoulder, a neck
const vase = () => sketchProfile([line('a', [0, 0], [12, 0]), arc('b', [12, 8], 8, -H, 0), line('c', [20, 8], [20, 30]), arc('d', [10, 30], 10, 0, H), line('e', [10, 40], [10, 50])])!

/** the finished body (the skin at the default 0.01 mm chord): its volume and bounding box */
function body(cage: Cage) {
  const t = tessellateForm(cage, 0.01)
  const P = t.positions
  let v = 0
  for (let i = 0; i < t.indices.length; i += 3) {
    const [x, y, z] = [t.indices[i] * 3, t.indices[i + 1] * 3, t.indices[i + 2] * 3]
    v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]) }
  return { volume: v, lo, hi, P }
}

describe('WO-2500 Extrude makes a light cage', () => {
  it('a 4-line 50 x 30 rectangle: 12 points (was 336), corners and rims creased, flat caps, the exact slab', () => {
    const r = extrudeProfileCage(rectangle(), XY, 20)
    expect(r.cage.positions).toHaveLength(12)
    expect(r.around).toBe(4)
    expect(r.corners).toBe(4)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const P = r.cage.positions
    const at = (x: number, y: number, z: number) => P.findIndex((p) => Math.hypot(p[0] - x, p[1] - y, p[2] - z) < 1e-9)
    const creased = new Set(r.cage.creases)
    const corners: Array<[number, number]> = [[0, 0], [50, 0], [50, 30], [0, 30]]
    // all four vertical edges, both spans of each
    for (const [x, y] of corners) for (const [z0, z1] of [[0, 10], [10, 20]]) expect(creased.has(edgeKey(at(x, y, z0), at(x, y, z1)))).toBe(true)
    // both rims
    for (const z of [0, 20]) corners.forEach(([x, y], i) => { const [u, v] = corners[(i + 1) % 4]; expect(creased.has(edgeKey(at(x, y, z), at(u, v, z)))).toBe(true) })
    // the caps are one flat quad each
    const caps = r.cage.faces.filter((f) => f.every((i) => P[i][2] === P[f[0]][2]))
    expect(caps).toHaveLength(2)
    expect(caps.every((f) => f.length === 4)).toBe(true)
    const b = body(r.cage)
    expect(b.volume).toBeCloseTo(30000, 3)
    for (let k = 0; k < 3; k++) {
      expect(b.lo[k]).toBeCloseTo(0, 9)
      expect(b.hi[k]).toBeCloseTo([50, 30, 20][k], 9)
    }
  })

  it('a circle sketch is still round: about a dozen points round, its skin within the 0.01 mm chord of the circle', () => {
    const r = extrudeProfileCage(sketchProfile([circle('c', [0, 0], 20)])!, XY, 20)
    expect(r.around).toBeGreaterThanOrEqual(8)
    expect(r.around).toBeLessThanOrEqual(16)
    expect(r.cage.positions).toHaveLength(3 * r.around)
    const b = body(r.cage)
    let worst = 0
    // the side, between the caps
    for (let i = 0; i < b.P.length; i += 3) if (b.P[i + 2] > 1e-6 && b.P[i + 2] < 20 - 1e-6) worst = Math.max(worst, Math.abs(Math.hypot(b.P[i], b.P[i + 1]) - 20))
    expect(worst).toBeLessThan(0.01)
    // before: 25128.2351 mm3; the change stays within 0.01 mm over the side's 2513 mm2
    expect(Math.abs(b.volume - 25128.2351)).toBeLessThan(0.01 * 2 * Math.PI * 20 * 20)
    expect(b.hi[2]).toBeCloseTo(20, 9)
  })

  it('with no sketch: the 40 mm circle is 36 points (was 432)', () => {
    const r = extrudeProfileCage(noSketchCircle, XY, 20)
    expect(r.cage.positions).toHaveLength(36)
    expect(validateCage(r.cage, true).problems).toEqual([])
  })

  it('lines joined to arcs by tangent keep the old spacing: the plate\'s ripple no worse than before (0.0425 mm), the same body', () => {
    const r = extrudeProfileCage(plate(), XY, 12)
    const b = body(r.cage)
    let worst = 0
    for (let i = 0; i < b.P.length; i += 3) {
      const [x, y, z] = [b.P[i], b.P[i + 1], b.P[i + 2]]
      if (z < 1 || z > 11) continue
      worst = Math.max(worst, Math.abs(Math.hypot(Math.max(Math.abs(x) - 17, 0), Math.max(Math.abs(y) - 7, 0)) - 8))
    }
    expect(worst).toBeLessThan(0.0426)
    expect(b.volume).toBeCloseTo(17332.8623, 2)
  })
})

describe('WO-2500 Revolve makes a light cage', () => {
  it('with no sketch: the 10 x 10 square ring is 4 points along x 16 round = 64 (was 768), the same ring', () => {
    const r = revolveProfileCage(noSketchSquare, XZ, revolveAxis([], noSketchSquare), 16, 48)
    expect(r.around).toBe(4)
    expect(r.cage.positions).toHaveLength(64)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(body(r.cage).volume).toBeCloseTo(9420.3481, 2)
  })

  it('the palette\'s Revolve segments still set the spans round; a straight run of the profile is one span', () => {
    for (const seg of [3, 8, 24, 64]) {
      const r = revolveProfileCage(noSketchSquare, XZ, revolveAxis([], noSketchSquare), seg, 48)
      expect(r.cage.positions).toHaveLength(4 * seg)
    }
    const part = revolveProfileCage(noSketchSquare, XZ, revolveAxis([], noSketchSquare), 8, 48, 90)
    expect(part.cage.positions).toHaveLength(4 * 9)
    expect(validateCage(part.cage, true).problems).toEqual([])
  })

  it('a vase outline: lighter, the same body (before 44140.789 mm3, 769 points)', () => {
    const r = revolveProfileCage(vase(), XZ, revolveAxis([], vase()), 16, 48)
    expect(r.cage.positions.length).toBeLessThan(769)
    expect(validateCage(r.cage, false).problems).toEqual([])
    const b = body(r.cage)
    expect(b.volume).toBeCloseTo(44140.789, 1)
    expect(b.hi[2]).toBeCloseTo(50, 6)
  })
})
