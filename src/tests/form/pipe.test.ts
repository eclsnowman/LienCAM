// Form: Pipe - a tube cage along a sketch curve.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'
import { pathLength, pipeCage, sketchPaths, straightPath, type SketchPath } from '../../form/pipe'
import { validateCage } from '../../form/halfEdge'
import { tessellateForm } from '../../form/finish'
import { formStep } from '../../form/exactStep'
import { GeomEngine } from '../../geom/worker/geom-engine'

const XY = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
const line = (id: string, a: [number, number], b: [number, number], construction = false) =>
  ({ id, kind: 'line', start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, ...(construction ? { construction: true } : {}) }) as unknown as SketchEntity
const arc = (id: string, c: [number, number], r: number, a0: number, a1: number) =>
  ({ id, kind: 'arc', center: { x: c[0], y: c[1] }, radius: r, startAngle: a0, endAngle: a1 }) as unknown as SketchEntity
const circle = (id: string, c: [number, number], r: number) => ({ id, kind: 'circle', center: { x: c[0], y: c[1] }, radius: r }) as unknown as SketchEntity

function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}

describe('Pipe: sketch curves as paths', () => {
  it('joins pieces meeting end to end into one chain in running order, whatever order and direction they were drawn in', () => {
    // an L with a rounded corner: line (0,0)-(20,0), arc centre (20,10) r 10 from -90 to 0 deg, line (30,10)-(30,30);
    // drawn out of order, the last line backwards, plus a construction line that is not part of the path
    const paths = sketchPaths([
      arc('a', [20, 10], 10, -Math.PI / 2, 0), line('l2', [30, 30], [30, 10]), line('l1', [0, 0], [20, 0]), line('c', [-5, -5], [50, 50], true),
    ], XY)
    expect(paths).toHaveLength(1)
    const p = paths[0]
    expect(p.closed).toBe(false)
    const ends = [p.points[0], p.points[p.points.length - 1]].map((q) => `${Math.round(q[0])},${Math.round(q[1])}`).sort()
    expect(ends).toEqual(['0,0', '30,30'])
    expect(pathLength(p)).toBeCloseTo(20 + (Math.PI * 10) / 2 + 20, 1)
    // every step is short: the chain runs along the curve, never jumping across it
    for (let i = 1; i < p.points.length; i++) expect(Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1])).toBeLessThan(20.001)
  })

  it('a circle is a closed path; the sketch plane places the path in the model', () => {
    const lifted = { origin: { x: 0, y: 0, z: 12 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const [p] = sketchPaths([circle('c', [0, 0], 25)], lifted)
    expect(p.closed).toBe(true)
    expect(pathLength(p)).toBeCloseTo(2 * Math.PI * 25, 0)
    for (const q of p.points) expect(q[2]).toBeCloseTo(12, 12)
  })
})

describe('Pipe: the tube cage', () => {
  const check = (path: SketchPath, r: number) => {
    const cage = pipeCage(path, { radius: r })
    expect(validateCage(cage, true).problems).toEqual([])
    const t = tessellateForm(cage, 0.01)
    return { cage, t, volume: meshVolume(t.positions, t.indices) }
  }

  it('a straight pipe: a closed, outward cage whose smooth skin is a cylinder of the radius asked for, with flat ends', () => {
    const { t, volume } = check(straightPath(60), 5)
    // skin points away from the flat ends lie at the radius from the axis
    let worst = 0
    for (let i = 0; i < t.positions.length; i += 3) {
      if (Math.abs(t.positions[i]) > 20) continue
      worst = Math.max(worst, Math.abs(Math.hypot(t.positions[i + 1], t.positions[i + 2]) - 5))
    }
    expect(worst).toBeLessThan(0.05)
    expect(volume).toBeGreaterThan(0)
    expect(Math.abs(volume - Math.PI * 25 * 60) / (Math.PI * 25 * 60)).toBeLessThan(0.02)
  })

  it('a pipe round a circle closes into a ring: no seam twist, the volume of a torus', () => {
    const { cage, volume } = check(sketchPaths([circle('c', [0, 0], 30)], XY)[0], 4)
    expect(cage.creases).toEqual([])
    const torus = 2 * Math.PI * Math.PI * 30 * 16
    expect(Math.abs(volume - torus) / torus).toBeLessThan(0.02)
  })

  it('a thick pipe round a circle - few rings round it - still has the torus volume: the skin does not cut inside the bend', () => {
    const path = sketchPaths([circle('c', [0, 0], 30)], XY)[0]
    const { cage, volume } = check(path, 10)
    expect(cage.positions.length / 8).toBeLessThanOrEqual(13)
    const torus = 2 * Math.PI * Math.PI * 30 * 100
    expect(Math.abs(volume - torus) / torus).toBeLessThan(0.02)
  })

  it('a pipe along the rounded L follows it: skin points stay the radius from the curve', () => {
    const path = sketchPaths([line('l1', [0, 0], [20, 0]), arc('a', [20, 10], 10, -Math.PI / 2, 0), line('l2', [30, 10], [30, 30])], XY)[0]
    const { t } = check(path, 2)
    const distToCurve = (x: number, y: number, z: number) => {
      const d1 = x < 0 ? Math.hypot(x, y) : x <= 20 ? Math.abs(y) : Infinity
      const d2 = y > 10 ? (x - 30) ** 2 + (y - 30 > 0 ? (y - 30) ** 2 : 0) : Infinity
      const ang = Math.atan2(y - 10, x - 20)
      const d3 = ang >= -Math.PI / 2 && ang <= 0 ? Math.abs(Math.hypot(x - 20, y - 10) - 10) : Infinity
      return Math.hypot(Math.min(d1, Math.sqrt(d2), d3), z)
    }
    let worst = 0
    let tube = 0
    for (let i = 0; i < t.positions.length; i += 3) {
      const [x, y, z] = [t.positions[i], t.positions[i + 1], t.positions[i + 2]]
      if (x < 1e-6 || y > 30 - 1e-6) continue // the flat end discs
      tube++
      worst = Math.max(worst, Math.abs(distToCurve(x, y, z) - 2))
    }
    expect(tube).toBeGreaterThan(1000)
    // the skin rounds the path a little where the line meets the arc; it stays well within the radius
    expect(worst).toBeLessThan(0.25)
  })
})

describe('Pipe: an exact solid (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('a straight pipe finishes into one closed solid with two flat end faces', async () => {
    const step = formStep(pipeCage(straightPath(60), { radius: 5 }), 'Pipe', 3)
    expect(step.planarFaces).toBe(2)
    const res = await engine.importStep(new TextEncoder().encode(step.text).buffer as ArrayBuffer, 'FRM1')
    expect(res.bodies).toHaveLength(1)
    const v = (await engine.measure(res.bodies[0].handle, 'volume')).value
    expect(Math.abs(v - Math.PI * 25 * 60) / (Math.PI * 25 * 60)).toBeLessThan(0.02)
  }, 180_000)
})
