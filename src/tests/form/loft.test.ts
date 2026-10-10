// Form: Loft - a form through two or more sketch profiles.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import type { PlaneFrame, SketchPath } from '../../form/pipe'
import { loftCage } from '../../form/loft'
import { validateCage } from '../../form/halfEdge'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from '../../form/subdivide'
import { tessellateForm } from '../../form/finish'
import { formStep } from '../../form/exactStep'
import { GeomEngine } from '../../geom/worker/geom-engine'

const XYat = (z: number): PlaneFrame => ({ origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } })
const circle = (r: number, start = 0, ccw = true): SketchPath => ({ points: Array.from({ length: 64 }, (_, i) => { const a = start + (ccw ? 1 : -1) * (2 * Math.PI * i) / 64; return [r * Math.cos(a), r * Math.sin(a), 0] as Vec3 }), closed: true })
const square = (h: number, startCorner = 0): SketchPath => {
  const c: Vec3[] = [[h, h, 0], [-h, h, 0], [-h, -h, 0], [h, -h, 0]]
  const pts: Vec3[] = []
  for (let k = 0; k < 4; k++) { const a = c[(k + startCorner) % 4], b = c[(k + startCorner + 1) % 4]; for (let j = 0; j < 8; j++) { const f = j / 8; pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0]) } }
  return { points: pts, closed: true }
}
/** the limit point each cage point names, independently: five refinements, then the limit mask */
function limitOf(cage: Cage): Float64Array {
  let level: Level = levelFromCage(cage)
  let P = cagePositionArray(cage)
  for (let k = 0; k < 5; k++) { const r = refine(level); P = applyRows(r.rows, P); level = r.level }
  return applyRows(limitRows(level), P)
}
const volume = (c: Cage, tol = 0.05) => {
  const t = tessellateForm(c, tol, 400_000)
  const P = t.positions, I = t.indices
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const x = I[i] * 3, y = I[i + 1] * 3, z = I[i + 2] * 3
    v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
  }
  return v
}

describe('loftCage', () => {
  it('a circle up to a square: a closed, valid, outward form whose skin runs through both profiles (flat creased ends)', () => {
    const r = loftCage([{ path: circle(20), frame: XYat(0) }, { path: square(15), frame: XYat(40) }]) as { cage: Cage; rings: number }
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(volume(r.cage)).toBeGreaterThan(0)
    const L = limitOf(r.cage)
    // the bottom ring's surface points on the circle, the top ring's on the square
    const n = 32
    for (let i = 0; i < n; i++) {
      const b: Vec3 = [L[i * 3], L[i * 3 + 1], L[i * 3 + 2]]
      expect(Math.abs(Math.hypot(b[0], b[1]) - 20)).toBeLessThan(0.05)
      expect(Math.abs(b[2])).toBeLessThan(1e-6)
      const j = (r.rings - 1) * n + i
      const t: Vec3 = [L[j * 3], L[j * 3 + 1], L[j * 3 + 2]]
      expect(Math.abs(Math.max(Math.abs(t[0]), Math.abs(t[1])) - 15)).toBeLessThan(0.05)
      expect(Math.abs(t[2] - 40)).toBeLessThan(1e-6)
    }
  })

  it('three profiles, a waist in the middle: the skin passes through the small middle circle too', () => {
    const r = loftCage([{ path: circle(20), frame: XYat(0) }, { path: circle(8), frame: XYat(20) }, { path: circle(20), frame: XYat(40) }]) as { cage: Cage }
    expect(validateCage(r.cage, true).problems).toEqual([])
    const L = limitOf(r.cage)
    const waist = r.cage.positions.map((_, i) => i).filter((i) => Math.abs(L[i * 3 + 2] - 20) < 1e-3)
    expect(waist.length).toBeGreaterThanOrEqual(32)
    for (const i of waist) expect(Math.abs(Math.hypot(L[i * 3], L[i * 3 + 1]) - 8)).toBeLessThan(0.05)
  })

  it('the rings line up however each profile starts or runs: two squares one above the other give straight sides', () => {
    for (const top of [square(15, 0), square(15, 2), { ...square(15, 1), points: [...square(15, 1).points].reverse() }]) {
      const r = loftCage([{ path: square(15, 0), frame: XYat(0) }, { path: top, frame: XYat(30) }]) as { cage: Cage }
      const n = 32
      // every point of the first in-between ring sits straight above its bottom-ring partner
      for (let i = 0; i < n; i++) {
        const a = r.cage.positions[i], b = r.cage.positions[n + i]
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(2)
      }
      expect(validateCage(r.cage, true).problems).toEqual([])
    }
  })

  it('open profiles make an open sheet (no caps, no creases); a mix, one profile, or profiles in one place are refused with why', () => {
    const line = (x: number): SketchPath => ({ points: [[x, -10, 0], [x, 10, 0]], closed: false })
    const sheet = loftCage([{ path: line(0), frame: XYat(0) }, { path: line(5), frame: XYat(20) }]) as { cage: Cage }
    expect(sheet.cage.creases).toEqual([])
    expect(validateCage(sheet.cage, false).problems).toEqual([])
    // the second line drawn the other way: it is taken reversed, so the sheet does not cross itself
    const flipped = loftCage([{ path: line(0), frame: XYat(0) }, { path: { points: [...line(5).points].reverse(), closed: false }, frame: XYat(20) }]) as { cage: Cage; rings: number }
    const n = 32, mid = Math.floor(flipped.rings / 2)
    // crossed, the middle ring would collapse to a point; lined up it is as wide as the lines (20 mm)
    const ys = Array.from({ length: n }, (_, i) => flipped.cage.positions[mid * n + i][1])
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(15)
    expect(loftCage([{ path: circle(10), frame: XYat(0) }, { path: line(0), frame: XYat(10) }])).toEqual({ reason: 'Loft joins profiles that are all closed or all open, not a mix' })
    expect(loftCage([{ path: circle(10), frame: XYat(0) }])).toEqual({ reason: 'Loft needs two or more profiles' })
    expect(loftCage([{ path: circle(10), frame: XYat(0) }, { path: circle(10), frame: XYat(0) }])).toMatchObject({ reason: expect.stringMatching(/all in one place/) })
  })
})

describe('a loft in the kernel (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('circle to square finishes into ONE closed exact solid with the limit surface\'s volume', async () => {
    const r = loftCage([{ path: circle(20), frame: XYat(0) }, { path: square(15), frame: XYat(40) }]) as { cage: Cage }
    const res = await engine.importStep(new TextEncoder().encode(formStep(r.cage, 'L', 3).text).buffer as ArrayBuffer, 'FRM1')
    expect(res.bodies).toHaveLength(1)
    const v = (await engine.measure(res.bodies[0].handle, 'volume')).value
    const e = volume(r.cage, 0.002)
    expect(Math.abs(v - e) / e).toBeLessThan(5e-4)
  }, 300_000)
})
