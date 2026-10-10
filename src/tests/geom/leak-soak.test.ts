// GEO-2-R1.2 + R1.3 JOINT ACCEPTANCE (binary, fails-if) — kernel-handle leak
// soak test. Real occt-wasm kernel in Node (same pattern as GEO-1's
// geom-engine.integration.test.ts).
//
// R1.2: getLabelInfo's XCAF LEAF shapeHandle (occt-wasm's own doc comment:
// "the caller owns it and must release it") was collected by
// #collectXCAFLeaves and never released once its solids were minted as
// bodies in importStep -- +1 leaked kernel shape per component per import.
//
// R1.3: getSubShapes('face'/'edge') mints one caller-owned handle PER
// SUB-SHAPE; #faceProbes, tessellate, and #edgeIdsFor (via measure()) never
// released theirs -- ~1 leaked kernel shape per face/edge probed or meshed,
// unbounded across a session (a STEP Vault Viewer imports many files).
//
// JOINT ACCEPTANCE: run >=5 cycles of importStep(committed STEP fixture) +
// makeBox + applyBoolean cut + tessellate + disposeAll and assert
// engine.debugKernelShapeCount() returns to the SAME baseline after EVERY
// cycle (delta 0 per cycle) -- proving neither leak source survives a full
// realistic op sequence.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function loadFixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('kernel-handle leak soak (GEO-2-R1.2 + R1.3 joint acceptance)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('debugKernelShapeCount() returns to the SAME baseline after EVERY cycle (delta 0)', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    const baseline = engine.debugKernelShapeCount()

    for (let cycle = 0; cycle < 5; cycle++) {
      // importStep: exercises the R1.2 XCAF-leaf release AND the R1.3
      // #faceProbes release (once per solid, inside importStep's loop).
      const { bodies, diagnostics } = await engine.importStep(bytes, `SOAK${cycle}`)
      expect(diagnostics.some((d) => d.severity === 'error')).toBe(false)
      expect(bodies.length).toBeGreaterThanOrEqual(1)

      // makeBox + applyBoolean cut: exercises the R1.3 #faceProbes release on
      // the makeBox and applyBoolean(cut) call sites too.
      const box = await engine.makeBox(`SOAKBOX${cycle}`, { x: 40, y: 20, z: 10 })
      expect(box.ok).toBe(true)
      const tool = await engine.makeBox(`SOAKTOOL${cycle}`, { x: 10, y: 10, z: 20 })
      expect(tool.ok).toBe(true)
      const cut = await engine.applyBoolean({
        featureId: `SOAKCUT${cycle}`,
        op: 'cut',
        target: box.body!,
        tools: [tool.body!],
      })
      expect(cut.ok).toBe(true)

      // tessellate: exercises the R1.3 face+edge handle release in
      // tessellate() itself, for every imported body AND the cut result.
      for (const b of bodies) {
        const tess = await engine.tessellate(b.handle, { deflection: 0.5 })
        expect(tess.faceIds.length).toBeGreaterThan(0)
      }
      const cutTess = await engine.tessellate(cut.body!, { deflection: 0.5 })
      expect(cutTess.faceIds.length).toBeGreaterThan(0)

      // measure('length', ids): exercises the R1.3 #edgeIdsFor handle release
      // in measure() (the third of the three named leak sites).
      const someEdgeIds = cutTess.edgeIds.slice(0, 2)
      if (someEdgeIds.length > 0) {
        await engine.measure(cut.body!, 'length', someEdgeIds)
      }

      await engine.disposeAll()

      expect(engine.debugKernelShapeCount()).toBe(baseline)
    }
  }, 120_000)
})
