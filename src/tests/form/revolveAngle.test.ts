// Form: Revolve by an angle, with the segments round set (the gap list's "revolve angle; segments").

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cage } from '../../form/cage'
import type { SketchEntity } from '../../lib/sketch/types'
import type { PlaneFrame } from '../../form/pipe'
import { revolveAxis, revolveProfileCage, sketchProfile } from '../../form/profile'
import { validateCage } from '../../form/halfEdge'
import { tessellateForm } from '../../form/finish'
import { formStep } from '../../form/exactStep'
import { useFormStore } from '../../form/formStore'
import { GeomEngine } from '../../geom/worker/geom-engine'

const line = (id: string, a: [number, number], b: [number, number]) =>
  ({ id, kind: 'line', construction: false, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } }) as unknown as SketchEntity
const polygon = (pts: Array<[number, number]>) => pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % pts.length]))
const XZ: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }

/** a 10 x 10 square 10 mm off the sketch Y axis: a ring when turned */
const square = () => sketchProfile(polygon([[10, 0], [20, 0], [20, 10], [10, 10]]))!
/** a half disc's outline with its straight side on the Y axis: a ball when turned */
const halfDisc = () => {
  const pts: Array<[number, number]> = [[0, -15]]
  for (let k = 1; k < 12; k++) { const a = -Math.PI / 2 + (Math.PI * k) / 12; pts.push([15 * Math.cos(a), 15 * Math.sin(a)]) }
  pts.push([0, 15])
  return sketchProfile(polygon(pts))!
}
const volumeOf = (cage: Cage) => {
  const t = tessellateForm(cage, 0.02)
  const P = t.positions
  let v = 0
  for (let i = 0; i < t.indices.length; i += 3) {
    const [x, y, z] = [t.indices[i] * 3, t.indices[i + 1] * 3, t.indices[i + 2] * 3]
    v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
  }
  return v
}

describe('Revolve by an angle', () => {
  it('a full turn is the revolve it was: the same cage for 360 degrees as for the default call', () => {
    const path = square(), axis = revolveAxis([], path)
    expect(revolveProfileCage(path, XZ, axis, 16, 48, 360)).toEqual(revolveProfileCage(path, XZ, axis))
  })

  it('half a turn of a closed profile: a closed, valid cage with two flat capped ends, creased at the rims, about half the ring\'s volume', () => {
    const path = square(), axis = revolveAxis([], path)
    const half = revolveProfileCage(path, XZ, axis, 16, 48, 180)
    expect(validateCage(half.cage, true).problems).toEqual([])
    const full = revolveProfileCage(path, XZ, axis, 16, 48, 360)
    const ratio = volumeOf(half.cage) / volumeOf(full.cage)
    // measured 0.4998 (and 0.2500 / 0.7488 for 90 / 270 degrees)
    expect(ratio).toBeGreaterThan(0.495)
    expect(ratio).toBeLessThan(0.505)
    // both end rims are creases: 2 x the profile's point count, plus the profile's corners along the turn
    const rims = half.cage.creases.length - 16 * half.corners
    expect(rims).toBe(2 * half.around)
    // the ends are flat: every point of each end ring on one plane through the axis
    const P = half.cage.positions
    const ends = P.filter((p) => Math.abs(p[1]) < 1e-9)
    expect(ends.length).toBe(2 * half.around)    // and the skin at each end is the profile itself: on the end plane it stays inside the 10 x 10 square
    // (radius 10..20 from the axis, height 0..10), not padded out the way the rings round the turn are
    const t = tessellateForm(half.cage, 0.02)
    let onEnd = 0
    for (let i = 0; i < t.positions.length; i += 3) {
      const [x, y, z] = [t.positions[i], t.positions[i + 1], t.positions[i + 2]]
      if (Math.abs(y) > 1e-6) continue
      onEnd++
      expect(Math.abs(x)).toBeLessThan(20 + 1e-6)
      expect(Math.abs(x)).toBeGreaterThan(10 - 1e-6)
      expect(z).toBeLessThan(10 + 1e-6)
    }
    expect(onEnd).toBeGreaterThan(20)
  })

  it('a quarter turn of a half disc on its axis: a closed wedge of a ball, its axis points welded into poles', () => {
    const path = halfDisc(), axis = revolveAxis([], path)
    const r = revolveProfileCage(path, XZ, axis, 8, 48, 90)
    expect(r.poles).toBeGreaterThanOrEqual(2)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const ball = (4 / 3) * Math.PI * 15 ** 3
    const v = volumeOf(r.cage)
    expect(v).toBeGreaterThan(ball / 4 * 0.8)
    expect(v).toBeLessThan(ball / 4 * 1.05)
  })

  it('part of a turn of an open profile: an open sheet (no caps, no creased rims)', () => {
    const path = sketchProfile([line('a', [10, 0], [20, 10])])!
    const r = revolveProfileCage(path, XZ, revolveAxis([], path), 6, 48, 120)
    expect(r.cage.creases).toEqual([])
    expect(r.cage.faces.every((f) => f.length === 4)).toBe(true)
    // (rings) x (points along the profile), no wrap
    expect(r.cage.positions.length).toBe(7 * r.around)
  })

  it('segments set the points round: 24 round a full turn, 25 rings over part of one', () => {
    const path = square(), axis = revolveAxis([], path)
    expect(revolveProfileCage(path, XZ, axis, 24).cage.positions.length).toBe(24 * revolveProfileCage(path, XZ, axis, 24).around)
    const part = revolveProfileCage(path, XZ, axis, 24, 48, 200)
    expect(part.cage.positions.length).toBe(25 * part.around)
  })

  it('the store keeps the angle in 1..360 and the segments in 3..64', () => {
    const st = useFormStore.getState()
    st.setRevolveAngle(500); expect(useFormStore.getState().revolveAngle).toBe(360)
    st.setRevolveAngle(0); expect(useFormStore.getState().revolveAngle).toBe(1)
    st.setRevolveAngle(135); expect(useFormStore.getState().revolveAngle).toBe(135)
    st.setRevolveSegments(2.4); expect(useFormStore.getState().revolveSegments).toBe(3)
    st.setRevolveSegments(200); expect(useFormStore.getState().revolveSegments).toBe(64)
    st.setRevolveSegments(16)
    st.setRevolveAngle(360)
  })
})

describe('a part revolve in the kernel (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('half a ring and a wedge of a ball each finish into ONE closed exact solid with the limit surface\'s volume', async () => {
    for (const [path, seg, angle] of [[square(), 16, 180], [halfDisc(), 8, 90]] as const) {
      const cage = revolveProfileCage(path, XZ, revolveAxis([], path), seg, 48, angle).cage
      const res = await engine.importStep(new TextEncoder().encode(formStep(cage, 'R', 3).text).buffer as ArrayBuffer, 'FRM1')
      expect(res.bodies).toHaveLength(1)
      const v = (await engine.measure(res.bodies[0].handle, 'volume')).value
      const t = tessellateForm(cage, 0.002, 400_000)
      const P = t.positions, I = t.indices
      let e = 0
      for (let i = 0; i < I.length; i += 3) {
        const x = I[i] * 3, y = I[i + 1] * 3, z = I[i + 2] * 3
        e += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
      }
      expect(Math.abs(v - e) / e).toBeLessThan(5e-4)
    }
  }, 300_000)
})
