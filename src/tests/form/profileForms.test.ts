// Form: a form from a sketch profile - Extrude and Revolve (stage 15).

import { describe, expect, it } from 'vitest'
import type { Cage } from '../../form/cage'
import type { SketchEntity } from '../../lib/sketch/types'
import type { PlaneFrame } from '../../form/pipe'
import { extrudeProfileCage, revolveAxis, revolveProfileCage, sketchProfile } from '../../form/profile'
import { validateCage } from '../../form/halfEdge'
import { tessellateForm } from '../../form/finish'

const line = (id: string, a: [number, number], b: [number, number], construction = false) =>
  ({ id, kind: 'line', construction, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } }) as unknown as SketchEntity
const arc = (id: string, c: [number, number], r: number, a0: number, a1: number) =>
  ({ id, kind: 'arc', construction: false, center: { x: c[0], y: c[1] }, radius: r, startAngle: a0, endAngle: a1 }) as unknown as SketchEntity
const circle = (id: string, c: [number, number], r: number) =>
  ({ id, kind: 'circle', construction: false, center: { x: c[0], y: c[1] }, radius: r }) as unknown as SketchEntity
const polygon = (pts: Array<[number, number]>) => pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % pts.length]))

const XY: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
// the XZ plane: sketch x -> model X, sketch y -> model -Z? (normal -Y, so y = n x x = +Z)
const XZ: PlaneFrame = { origin: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }

/** the smooth skin at a fine level: its enclosed volume and its points */
function skin(cage: Cage) {
  const t = tessellateForm(cage, 0.02)
  const P = t.positions
  let v = 0
  for (let i = 0; i < t.indices.length; i += 3) {
    const [x, y, z] = [t.indices[i] * 3, t.indices[i + 1] * 3, t.indices[i + 2] * 3]
    v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
  }
  const pts: Array<[number, number, number]> = []
  for (let i = 0; i < P.length; i += 3) pts.push([P[i], P[i + 1], P[i + 2]])
  return { volume: v, pts }
}

describe('Extrude a sketch profile', () => {
  it('a circle becomes a closed cylinder whose skin lands on the circle, with flat creased ends', () => {
    const path = sketchProfile([circle('c', [0, 0], 20)])!
    const { cage } = extrudeProfileCage(path, XY, 30)
    expect(validateCage(cage, true).problems).toEqual([])
    const s = skin(cage)
    expect(s.volume / (Math.PI * 400 * 30)).toBeCloseTo(1, 2)
    // mid-height skin points sit on the 20 mm circle
    const mid = s.pts.filter((p) => Math.abs(p[2] - 15) < 2)
    expect(mid.length).toBeGreaterThan(20)
    for (const p of mid) expect(Math.abs(Math.hypot(p[0], p[1]) - 20)).toBeLessThan(0.05)
    expect(Math.min(...s.pts.map((p) => p[2]))).toBeCloseTo(0, 6)
    expect(Math.max(...s.pts.map((p) => p[2]))).toBeCloseTo(30, 6)
  })

  it('a rectangle keeps its corners (creased) and its size', () => {
    const path = sketchProfile(polygon([[-20, -10], [20, -10], [20, 10], [-20, 10]]))!
    const r = extrudeProfileCage(path, XY, 10)
    expect(r.corners).toBe(4)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const s = skin(r.cage)
    expect(s.volume / 8000).toBeCloseTo(1, 3)
    expect(Math.max(...s.pts.map((p) => p[0]))).toBeCloseTo(20, 6)
    expect(Math.min(...s.pts.map((p) => p[1]))).toBeCloseTo(-10, 6)
  })

  it('a rounded plate (lines joined to arcs by tangent) stays within 0.05 mm of its profile, flat sides included', () => {
    const hw = 25, hh = 15, r = 8, H = Math.PI / 2
    const plate = [
      line('b', [-hw + r, -hh], [hw - r, -hh]), arc('a1', [hw - r, -hh + r], r, -H, 0), line('r', [hw, -hh + r], [hw, hh - r]), arc('a2', [hw - r, hh - r], r, 0, H),
      line('t', [hw - r, hh], [-hw + r, hh]), arc('a3', [-hw + r, hh - r], r, H, 2 * H), line('l', [-hw, hh - r], [-hw, -hh + r]), arc('a4', [-hw + r, -hh + r], r, 2 * H, 3 * H),
    ]
    const r0 = extrudeProfileCage(sketchProfile(plate)!, XY, 12)
    expect(r0.corners).toBe(0)
    const s = skin(r0.cage)
    let worst = 0
    for (const [x, y, z] of s.pts) {
      if (z < 1 || z > 11) continue
      worst = Math.max(worst, Math.abs(Math.hypot(Math.max(Math.abs(x) - (hw - r), 0), Math.max(Math.abs(y) - (hh - r), 0)) - r))
    }
    expect(worst).toBeLessThan(0.05)
  })

  it('a U shape (its centroid outside it) gets triangulated caps and still closes outward at the right volume', () => {
    // area: 30 x 30 minus a 10 x 20 notch = 700
    const path = sketchProfile(polygon([[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]]))!
    const r = extrudeProfileCage(path, XY, 5)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.cage.faces.some((f) => f.length === 3)).toBe(true)
    expect(skin(r.cage).volume / 3500).toBeCloseTo(1, 3)
  })

  it('goes along the sketch normal on any plane, and a negative height goes the other way, still outward', () => {
    const path = sketchProfile(polygon([[0, 0], [10, 0], [10, 10], [0, 10]]))!
    const up = skin(extrudeProfileCage(path, XZ, 8).cage)
    const down = skin(extrudeProfileCage(path, XZ, -8).cage)
    expect(up.volume / 800).toBeCloseTo(1, 3)
    expect(down.volume / 800).toBeCloseTo(1, 3)
    // normal -Y: up runs Y 0 -> -8, down Y 0 -> 8; sketch y is model +Z from 5
    expect(Math.min(...up.pts.map((p) => p[1]))).toBeCloseTo(-8, 6)
    expect(Math.max(...down.pts.map((p) => p[1]))).toBeCloseTo(8, 6)
    expect(Math.max(...up.pts.map((p) => p[2]))).toBeCloseTo(15, 6)
  })

  it('an open curve makes an open sheet', () => {
    const path = sketchProfile([arc('a', [0, 0], 20, 0, Math.PI)])!
    const { cage } = extrudeProfileCage(path, XY, 10)
    expect(validateCage(cage, false).problems).toEqual([])
    expect(cage.faces.every((f) => f.length === 4)).toBe(true)
  })
})

describe('Revolve a sketch profile', () => {
  it('a half disc on the Y axis closes into a sphere with two poles', () => {
    const path = sketchProfile([arc('a', [0, 0], 20, -Math.PI / 2, Math.PI / 2), line('l', [0, 20], [0, -20])])!
    const ax = revolveAxis([], path)
    expect(ax.label).toBe('the sketch Y axis')
    const r = revolveProfileCage(path, XY, ax)
    expect(r.poles).toBe(2)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const s = skin(r.cage)
    expect(s.volume / ((4 / 3) * Math.PI * 8000)).toBeGreaterThan(0.97)
    expect(s.volume / ((4 / 3) * Math.PI * 8000)).toBeLessThan(1.01)
    // on the equator the skin is on the 20 mm circle
    const eq = s.pts.filter((p) => Math.abs(p[1]) < 0.5)
    for (const p of eq) expect(Math.abs(Math.hypot(p[0], p[2]) - 20)).toBeLessThan(0.1)
  })

  it('a rectangle away from the axis makes a washer: corners creased, radii and volume right', () => {
    const path = sketchProfile(polygon([[10, 0], [20, 0], [20, 10], [10, 10]]))!
    const r = revolveProfileCage(path, XY, revolveAxis([], path))
    expect(r.poles).toBe(0)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const s = skin(r.cage)
    expect(s.volume / (Math.PI * 300 * 10)).toBeCloseTo(1, 2)
    const radii = s.pts.map((p) => Math.hypot(p[0], p[2]))
    expect(Math.max(...radii)).toBeLessThan(20.1)
    expect(Math.min(...radii)).toBeGreaterThan(9.9)
  })

  it('turns round a construction line when the sketch has one; otherwise an axis the profile does not cross', () => {
    const square = polygon([[-5, -5], [5, -5], [5, 5], [-5, 5]])
    const p = sketchProfile(square)!
    // crosses both sketch axes: falls back to a line at its left edge
    expect(revolveAxis(square, p).label).toMatch(/left edge/)
    const withAxis = [...square, line('ax', [10, -20], [10, 20], true)]
    const ax = revolveAxis(withAxis, sketchProfile(withAxis)!)
    expect(ax.label).toBe('the construction line')
    const r = revolveProfileCage(sketchProfile(withAxis)!, XY, ax)
    expect(validateCage(r.cage, true).problems).toEqual([])
    // a 10 x 10 square 10 mm from the axis at its centre: Pappus, 2 pi 10 x 100
    expect(skin(r.cage).volume / (2 * Math.PI * 10 * 100)).toBeCloseTo(1, 2)
  })
})
