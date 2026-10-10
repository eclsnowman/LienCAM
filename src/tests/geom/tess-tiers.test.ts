// GEO-2 acceptance #6 — named tessellation-quality tiers (coarse/medium/fine),
// computed from body bbox diagonal (relative deflection), exported from the
// facade (src/geom/index.ts). Measures the coarse tier against the largest
// real STEP fixture available in this environment.
//
// ENVIRONMENT GAP: the WO's literal acceptance target is `Sample Parts/
// Tray.step` (696 faces) — coarse tier < 1500 ms and < 150k triangles. That
// file does not exist in this worktree (see step-import.test.ts's header for
// the confirmed-missing note). This test measures the same tier system
// against `Sample Parts/Step Test With Holes.step` (87 faces, the largest
// real part actually available) and records the ACTUAL numbers, per the WO's
// own "the measurement CAN move" allowance — the tier system itself is
// generic (deflection scales with bbox diagonal, not hardcoded to any file)
// so it is expected to carry over once Tray.step is supplied.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { tessQualityForTier } from '../../geom/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadFixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(HERE, 'fixtures', name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('tessellation quality tiers', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('tessQualityForTier scales deflection with bbox diagonal and coarse > medium > fine', () => {
    const diag = 100
    const coarse = tessQualityForTier(diag, 'coarse')
    const medium = tessQualityForTier(diag, 'medium')
    const fine = tessQualityForTier(diag, 'fine')
    expect(coarse.deflection).toBeGreaterThan(medium.deflection)
    expect(medium.deflection).toBeGreaterThan(fine.deflection)
    // relative: a 10x bigger body gets a 10x bigger coarse deflection.
    const bigger = tessQualityForTier(diag * 10, 'coarse')
    expect(bigger.deflection).toBeCloseTo(coarse.deflection * 10, 6)
  })

  it('coarse tier tessellates a real STEP body fast, measured and recorded', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    const { bodies } = await engine.importStep(bytes, 'TT1')
    expect(bodies.length).toBeGreaterThanOrEqual(1)
    const handle = bodies[0].handle
    const diag = engine.bboxDiagonal(handle)
    expect(diag).toBeGreaterThan(0)

    const q = tessQualityForTier(diag, 'coarse')
    const t0 = performance.now()
    const tess = await engine.tessellate(handle, q)
    const elapsedMs = performance.now() - t0
    const triCount = tess.index.length / 3

    console.log(`[GEO-2 tess-tier bench] coarse: ${elapsedMs.toFixed(1)} ms, ${triCount} triangles, deflection=${q.deflection.toFixed(4)} (bbox diag=${diag.toFixed(2)}), source=Step Test With Holes.step (87 faces, Tray.step substitute)`)

    expect(elapsedMs).toBeLessThan(1500)
    expect(triCount).toBeLessThan(150_000)
    await engine.disposeAll()
  }, 60_000)

  it('fine tier produces at least as many triangles as coarse (measure-grade stays available)', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    const { bodies } = await engine.importStep(bytes, 'TT2')
    const handle = bodies[0].handle
    const diag = engine.bboxDiagonal(handle)
    const coarseTess = await engine.tessellate(handle, tessQualityForTier(diag, 'coarse'))
    const fineTess = await engine.tessellate(handle, tessQualityForTier(diag, 'fine'))
    expect(fineTess.index.length).toBeGreaterThanOrEqual(coarseTess.index.length)
    await engine.disposeAll()
  }, 60_000)
})
