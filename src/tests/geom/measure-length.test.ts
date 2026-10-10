// GEO-2 BK-10b — measure('length', ids) uses the kernel's exact analytic
// curve length for edge-scoped queries, not a deflection-dependent polyline
// sum. Verified against an analytically-known fixture: a cylinder's rim is a
// circle of radius r, exact length 2*pi*r. Real occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

describe('measure exact edge-scoped length (BK-10b)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('circle edge (cylinder rim, radius r) measures 2*pi*r within 1e-6 relative', async () => {
    const radius = 7.5
    const height = 20
    const cyl = await engine.debugMakeCylinder('DBG1', radius, height)
    expect(cyl.ok).toBe(true)

    const tess = await engine.tessellate(cyl.body!, { deflection: 0.1 })
    // A cylinder has exactly 2 circular rim edges (top+bottom) + 1 seam edge
    // along the side wall (occt-wasm's makeCylinder is a single non-periodic
    // face with a seam). Find a rim edge: it is adjacent to exactly one named
    // face segment more than once is fine -- we just need ANY edge whose
    // exact length matches the analytic circle circumference.
    const expected = 2 * Math.PI * radius
    let bestRelErr = Infinity
    for (const id of tess.edgeIds) {
      const m = await engine.measure(cyl.body!, 'length', [id])
      const relErr = Math.abs(m.value - expected) / expected
      if (relErr < bestRelErr) bestRelErr = relErr
    }
    expect(bestRelErr).toBeLessThan(1e-6)
    await engine.dispose(cyl.body!)
  }, 60_000)

  it('id-scoped length sums multiple edges and reports unresolved count for unknown ids', async () => {
    const radius = 5
    const cyl = await engine.debugMakeCylinder('DBG2', radius, 10)
    const tess = await engine.tessellate(cyl.body!, { deflection: 0.1 })
    const [id0, id1] = tess.edgeIds
    const single = await engine.measure(cyl.body!, 'length', [id0])
    const pair = await engine.measure(cyl.body!, 'length', [id0, id1])
    expect(pair.value).toBeCloseTo(single.value + (await engine.measure(cyl.body!, 'length', [id1])).value, 6)

    const mixed = await engine.measure(cyl.body!, 'length', [id0, 'NOPE:not-an-edge'])
    expect(mixed.value).toBeCloseTo(single.value, 6)
    expect(mixed.aux?.unresolvedCount).toBe(1)

    await expect(engine.measure(cyl.body!, 'length', ['NOPE:not-an-edge'])).rejects.toThrow()
    await engine.dispose(cyl.body!)
  }, 60_000)

  it('axis probe: cylinder wall face axis is ~[0,0,1] (occt-wasm makeCylinder is Z-axis)', async () => {
    const cyl = await engine.debugMakeCylinder('DBG3', 6, 15)
    const snaps = engine.snapshotsFor(cyl.body!)
    const wall = Object.values(snaps).find((s) => s.type === 'cylinder')
    expect(wall).toBeDefined()
    expect(wall!.axis).toBeDefined()
    const [ax, ay, az] = wall!.axis!
    expect(Math.abs(az)).toBeGreaterThan(0.999) // parallel to Z, sign not canonical
    expect(Math.abs(ax)).toBeLessThan(0.05)
    expect(Math.abs(ay)).toBeLessThan(0.05)
    await engine.dispose(cyl.body!)
  }, 60_000)

  it('whole-body volume/area exact checks stay green', async () => {
    const box = (await engine.makeBox('MV1', { x: 40, y: 20, z: 10 })).body!
    const vol = await engine.measure(box, 'volume')
    expect(vol.value).toBeCloseTo(40 * 20 * 10, 6)
    const area = await engine.measure(box, 'area')
    expect(area.value).toBeCloseTo(2 * (40 * 20 + 40 * 10 + 20 * 10), 6)
    await engine.dispose(box)
  }, 60_000)
})
