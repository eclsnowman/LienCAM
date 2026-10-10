// GEO-3 acceptance #2 (revolve): full 360 circle-profile revolve -> torus
// topology; partial-angle (90deg) rectangle revolve -> exact volume vs
// analytic. Plus constructed-lineage sanity (REV surf/cap grammar). REAL
// occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { ProfileRegion, RevolveRequest } from '../../geom/geom-service.ts'
import { rectLoop, xzPlane } from './fixtures/profiles.ts'

const Z_AXIS = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }

describe('makeRevolve (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#2 full 360 circle revolve -> torus-topology body, exact volume', async () => {
    const majorR = 20, minorR = 5
    const profile: ProfileRegion = {
      sketchId: 'SC',
      plane: xzPlane(),
      loops: [[{ kind: 'arc', c: [majorR, 0], r: minorR, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'SC.c0' }]],
    }
    const req: RevolveRequest = { featureId: 'RV1', profile, axis: Z_AXIS, angleDeg: 360, op: 'newBody' }
    const r = await engine.makeRevolve(req)
    expect(r.ok).toBe(true)

    // torus topology: at least one face is classified as a torus surface.
    const dm = r.elementMap!
    const hasTorus = Object.values(dm.geometry!).some((s) => s.surfaceType === 'torus')
    expect(hasTorus).toBe(true)
    // the toroidal surface carries the circle's constructed lineage.
    expect(dm.generated.some((id) => id.startsWith('RV1:REV:SC.c0:surf'))).toBe(true)
    // full revolve has no caps.
    expect(dm.generated.some((id) => id.includes(':cap'))).toBe(false)

    // volume exact vs analytic torus: 2*pi^2*R*r^2.
    const vol = await engine.measure(r.body!, 'volume')
    const expected = 2 * Math.PI * Math.PI * majorR * minorR * minorR
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)
    await engine.dispose(r.body!)
  }, 60_000)

  it('#2 partial 90deg rectangle revolve -> exact volume, start/end caps', async () => {
    const rIn = 10, rOut = 20, height = 5
    const profile: ProfileRegion = {
      sketchId: 'SR',
      plane: xzPlane(),
      loops: [rectLoop('SR', rIn, 0, rOut, height)],
    }
    const req: RevolveRequest = { featureId: 'RV2', profile, axis: Z_AXIS, angleDeg: 90, op: 'newBody' }
    const r = await engine.makeRevolve(req)
    expect(r.ok).toBe(true)

    // volume: quarter of the annular ring solid pi*(rOut^2 - rIn^2)*height.
    const vol = await engine.measure(r.body!, 'volume')
    const expected = (Math.PI * (rOut * rOut - rIn * rIn) * height) * (90 / 360)
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)

    // partial revolve produces two planar caps (start + end) carrying region tags.
    const dm = r.elementMap!
    expect(dm.generated).toContain('RV2:REV:SR:capStart')
    expect(dm.generated).toContain('RV2:REV:SR:capEnd')

    // GEO-3 R1: capStart/capEnd must be assigned by GEOMETRY, not kernel face
    // enumeration order. The START cap is the profile at theta=0 (in the XZ
    // plane, so centroid.y == 0, x in [rIn,rOut]); the END cap is that profile
    // rotated 90deg about Z (into the YZ plane, so centroid.x == 0, |y| in
    // [rIn,rOut] — sign depends on the kernel's revolve direction, which this
    // assertion is deliberately agnostic to). Asserting the cap GEOMETRY (not
    // just ID presence) is what the pre-R1 code could not guarantee: its azimuth
    // reference collapsed to zero for this on-axis plane origin, tying both cap
    // scores and letting kernel enumeration decide — so a kernel that enumerated
    // the end cap first would have mislabeled them.
    const capStart = dm.geometry!['RV2:REV:SR:capStart']
    const capEnd = dm.geometry!['RV2:REV:SR:capEnd']
    expect(capStart.centroid.y).toBeCloseTo(0, 5)
    expect(capStart.centroid.x).toBeGreaterThan(rIn - 1e-6)
    expect(capStart.centroid.x).toBeLessThan(rOut + 1e-6)
    expect(capEnd.centroid.x).toBeCloseTo(0, 5)
    expect(Math.abs(capEnd.centroid.y)).toBeGreaterThan(rIn - 1e-6)
    expect(Math.abs(capEnd.centroid.y)).toBeLessThan(rOut + 1e-6)

    // and surf faces from the profile edges.
    expect(dm.generated.some((id) => id.startsWith('RV2:REV:SR.') && id.endsWith(':surf'))).toBe(true)
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    await engine.dispose(r.body!)
  }, 60_000)

  it('#2 determinism: two runs of the partial revolve produce identical ID sets', async () => {
    const profile: ProfileRegion = { sketchId: 'SR', plane: xzPlane(), loops: [rectLoop('SR', 10, 0, 20, 5)] }
    const mk = (): Promise<import('../../geom/geom-service.ts').OpResult> =>
      engine.makeRevolve({ featureId: 'RV2', profile, axis: Z_AXIS, angleDeg: 90, op: 'newBody' })
    const a = await mk()
    const b = await mk()
    expect([...a.elementMap!.generated].sort()).toEqual([...b.elementMap!.generated].sort())
    await engine.disposeAll()
  }, 60_000)
})
