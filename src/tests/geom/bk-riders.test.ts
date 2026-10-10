// GEO-3 backlog riders — acceptance #5 (BK-18: tessellate CSR trailing
// sentinel) and #6 (BK-20: id-scoped measure('area')). REAL occt-wasm in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
// READ-ONLY import of the UI-lane validator (out of this WO's touch scope) to
// prove the emitter now satisfies the exact CSR contract it enforces — so the
// progressiveTessellate normalizeEdgeOffsets workaround can retire.
import { validateTessBuffers } from '../../viewport3d/tessGeometry.ts'

const V = { x: 40, y: 20, z: 10 }

describe('BK-18: tessellate() emits the CSR trailing sentinel', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#5 edgeOffsets.length === edgeIds.length + 1 on a multi-edge body (fails against the pre-fix emitter)', async () => {
    const box = (await engine.makeBox('F1', V)).body! // 12 edges — genuinely multi-edge
    const t = await engine.tessellate(box, { deflection: 0.1 })
    expect(t.edgeIds.length).toBeGreaterThan(1)
    // THE PIN: full CSR table with a trailing sentinel. The pre-fix emitter
    // pushed exactly one start-index per edge (length === edgeIds.length) and
    // this assertion caught it one short.
    expect(t.edgeOffsets.length).toBe(t.edgeIds.length + 1)
    // sentinel equals the total edge-point count.
    expect(t.edgeOffsets[t.edgeOffsets.length - 1]).toBe(t.edgePositions.length / 3)
    // monotonic non-decreasing offsets.
    for (let i = 1; i < t.edgeOffsets.length; i++) {
      expect(t.edgeOffsets[i]).toBeGreaterThanOrEqual(t.edgeOffsets[i - 1])
    }
    // and the real UI-lane validator accepts it with NO normalize workaround.
    expect(() => validateTessBuffers(t)).not.toThrow()
    await engine.dispose(box)
  }, 60_000)
})

describe('BK-20: measure(area, [faceId]) is id-scoped', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#6 returns that FACE\'s analytic area; whole-body call unchanged', async () => {
    // Asymmetric box: face areas differ (xMax=20*10=200, yMax=40*10=400,
    // zMax=40*20=800), so a single face area != total/faceCount (2800/6).
    const box = (await engine.makeBox('B1', V)).body!
    const zMax = await engine.measure(box, 'area', ['B1:BOX:zMax'])
    expect(Math.abs(zMax.value - 800) / 800).toBeLessThan(1e-6)
    const yMax = await engine.measure(box, 'area', ['B1:BOX:yMax'])
    expect(Math.abs(yMax.value - 400) / 400).toBeLessThan(1e-6)
    // proves it is NOT whole-body/faceCount: 2800/6 = 466.7 != 800.
    expect(Math.abs(zMax.value - 2800 / 6)).toBeGreaterThan(1)

    // multi-id sum, and a mixed known/unknown list reports unresolvedCount.
    const both = await engine.measure(box, 'area', ['B1:BOX:zMax', 'B1:BOX:yMax'])
    expect(Math.abs(both.value - 1200) / 1200).toBeLessThan(1e-6)
    const mixed = await engine.measure(box, 'area', ['B1:BOX:zMax', 'NOPE:face'])
    expect(mixed.aux?.unresolvedCount).toBe(1)

    // whole-body area (no ids) unchanged: total surface = 2800.
    const whole = await engine.measure(box, 'area')
    expect(Math.abs(whole.value - 2800) / 2800).toBeLessThan(1e-6)

    // all-unknown ids fail loud (never silently returns 0).
    await expect(engine.measure(box, 'area', ['NOPE:face'])).rejects.toThrow()
    await engine.dispose(box)
  }, 60_000)
})
