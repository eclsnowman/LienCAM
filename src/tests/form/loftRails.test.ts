// Form: Loft rails - open sketch curves from the first profile to the last that the loft's sides follow.

import { describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import type { PlaneFrame, SketchPath } from '../../form/pipe'
import { loftCage, railOf } from '../../form/loft'
import { validateCage } from '../../form/halfEdge'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from '../../form/subdivide'

const XYat = (z: number): PlaneFrame => ({ origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } })
// the XZ plane: sketch (u, v) is model (u, 0, v)
const XZ: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }
const circle = (r: number): SketchPath => ({ points: Array.from({ length: 64 }, (_, i) => { const a = (2 * Math.PI * i) / 64; return [r * Math.cos(a), r * Math.sin(a), 0] as Vec3 }), closed: true })
/** an open curve in the XZ plane from (x0, 0) up to (x0, 40), bulging out to x0 + bulge at z = 20 */
const bow = (x0: number, bulge: number, reversed = false): SketchPath => {
  const pts = Array.from({ length: 41 }, (_, i) => { const z = i; return [x0 + bulge * Math.sin((Math.PI * z) / 40), z, 0] as Vec3 })
  return { points: reversed ? pts.reverse() : pts, closed: false }
}
function limitOf(cage: Cage): Float64Array {
  let level: Level = levelFromCage(cage)
  let P = cagePositionArray(cage)
  for (let k = 0; k < 5; k++) { const r = refine(level); P = applyRows(r.rows, P); level = r.level }
  return applyRows(limitRows(level), P)
}
const profiles = [{ path: circle(10), frame: XYat(0) }, { path: circle(10), frame: XYat(40) }]
const n = 32
type Lofted = { cage: Cage; rings: number; railed: number }
/** the limit point of ring k, column i */
const limitAt = (L: Float64Array, k: number, i: number): Vec3 => { const j = k * n + i; return [L[j * 3], L[j * 3 + 1], L[j * 3 + 2]] }
/** how far a point is from the bow curve x = x0 + bulge sin(pi z / 40), y = 0 (sampled finely) */
const offBow = (p: Vec3, x0: number, bulge: number) => {
  let d = Infinity
  for (let z = 0; z <= 40; z += 0.05) d = Math.min(d, Math.hypot(p[0] - (x0 + bulge * Math.sin((Math.PI * z) / 40)), p[1], p[2] - z))
  return d
}

describe('loft rails', () => {
  it('without a rail, two equal circles loft straight: a cylinder of radius 10 (the control)', () => {
    const r = loftCage(profiles) as Lofted
    expect(r.railed).toBe(0)
    const L = limitOf(r.cage)
    const mid = limitAt(L, Math.floor(r.rings / 2), 0)
    // (a smooth skin sits a little inside its cage between the profiles)
    expect(Math.abs(Math.hypot(mid[0], mid[1]) - 10)).toBeLessThan(0.2)
  })

  it('one rail bowing out to x = 18: the side it ties runs along it, the loft swells to about 18 at the middle, still one valid closed form', () => {
    const r = loftCage(profiles, 32, [{ path: bow(10, 8), frame: XZ }]) as Lofted
    expect(r.railed).toBe(1)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const L = limitOf(r.cage)
    for (let k = 0; k < r.rings; k++) expect(offBow(limitAt(L, k, 0), 10, 8)).toBeLessThan(0.1)
    const mid = limitAt(L, Math.floor(r.rings / 2), 0)
    expect(mid[0]).toBeGreaterThan(17)
    // one rail scales the whole ring: the opposite side swells too
    const opposite = limitAt(L, Math.floor(r.rings / 2), n / 2)
    expect(opposite[0]).toBeLessThan(-15)
  })

  it('drawn top to bottom it is the same rail', () => {
    const a = loftCage(profiles, 32, [{ path: bow(10, 8), frame: XZ }]) as Lofted
    const b = loftCage(profiles, 32, [{ path: bow(10, 8, true), frame: XZ }]) as Lofted
    const La = limitOf(a.cage), Lb = limitOf(b.cage)
    for (let k = 0; k < a.rings; k++) for (let c = 0; c < 3; c++) expect(limitAt(Lb, k, 0)[c]).toBeCloseTo(limitAt(La, k, 0)[c], 6)
  })

  it('a rail that crosses sideways (from (10, 0, 0) up to (-10, 0, 40)) ties the point at its start whichever way it was drawn', () => {
    const line = (rev: boolean): SketchPath => { const pts = Array.from({ length: 21 }, (_, i) => [10 - i, 2 * i, 0] as Vec3); return { points: rev ? pts.reverse() : pts, closed: false } }
    const a = loftCage(profiles, 32, [{ path: line(false), frame: XZ }]) as Lofted
    const b = loftCage(profiles, 32, [{ path: line(true), frame: XZ }]) as Lofted
    expect(railOf(profiles, { path: line(true), frame: XZ })).toBe(true)
    const La = limitOf(a.cage), Lb = limitOf(b.cage)
    for (let k = 0; k < a.rings; k++) for (let c = 0; c < 3; c++) expect(limitAt(Lb, k, 0)[c]).toBeCloseTo(limitAt(La, k, 0)[c], 6)
  })

  it('two rails, one bowing out on +X and one straight on -X: both sides follow their own rail (the loft leans, it does not just swell)', () => {
    const r = loftCage(profiles, 32, [{ path: bow(10, 8), frame: XZ }, { path: bow(-10, 0), frame: XZ }]) as Lofted
    expect(r.railed).toBe(2)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const L = limitOf(r.cage)
    for (let k = 0; k < r.rings; k++) {
      expect(offBow(limitAt(L, k, 0), 10, 8)).toBeLessThan(0.1)
      expect(offBow(limitAt(L, k, n / 2), -10, 0)).toBeLessThan(0.1)
    }
    // the whole ring moves with them: at the middle it spans x = -10 to 18, so its +Y side sits near (4, 14)
    const side = limitAt(L, Math.floor(r.rings / 2), n / 4)
    expect(Math.abs(side[0] - 4)).toBeLessThan(0.6)
    expect(Math.abs(side[1] - 14)).toBeLessThan(0.6)
  })

  it('railOf: an open curve from the first profile to the last is a rail; a curve that misses an end, a closed one, or a loft of one profile is not', () => {
    expect(railOf(profiles, { path: bow(10, 8), frame: XZ })).toBe(true)
    expect(railOf(profiles, { path: bow(10, 8, true), frame: XZ })).toBe(true)
    expect(railOf(profiles, { path: bow(25, 3), frame: XZ })).toBe(false)
    expect(railOf(profiles, { path: { ...bow(10, 8), closed: true }, frame: XZ })).toBe(false)
    expect(railOf(profiles.slice(0, 1), { path: bow(10, 8), frame: XZ })).toBe(false)
    expect(railOf(profiles, { path: circle(10), frame: XYat(20) })).toBe(false)
  })

  it('a profile added past the end of a rail: the rail no longer shapes the loft, which lofts exactly as it would without it (no rings folded back)', () => {
    const three = [...profiles, { path: circle(10), frame: XYat(80) }]
    const plain = loftCage(three, n) as Lofted
    const r = loftCage(three, n, [{ path: bow(10, 8), frame: XZ }]) as Lofted
    expect(r.railed).toBe(0)
    expect(r.rings).toBe(plain.rings)
    const a = cagePositionArray(r.cage), b = cagePositionArray(plain.cage)
    expect(a.length).toBe(b.length)
    let worst = 0
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
    expect(worst).toBeLessThan(1e-9)
  })
})
