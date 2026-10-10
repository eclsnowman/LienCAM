import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { createOclWaterlineSlicer, type OclWaterlineModule } from '../../cam3d/kernel/oclWaterline'
import { samplePath } from '../benchmark/metrics'
import { WHOLE_PART, type BenchmarkChain } from '../benchmark/registry'
import { productionScene } from '../helpers/productionScene'

const OUT = 'src/tests/evidence/WO-2460'
const require = createRequire(import.meta.url)
const chain = (type: 'pencil_3d' | 'waterline_3d'): BenchmarkChain => ({
  id: `wo2460-${type}`, partId: 'engagement-pocket', setupLabel: 'shape-probe', tiers: [],
  steps: [{ id: type, type, toolId: 'bm-bull-6', scope: WHOLE_PART,
    params: { tolerance: 0.1, stockToLeave: 0, useStockBoundary: false, direction: 'climb',
      stepdown: 1, minSlopeDeg: 0, flatAreaDetection: false },
    stockToLeaveMm: 0, gougeToleranceMm: 0.1, lateralAllowanceMm: 0 }],
})

// Same AABB as the benchmark's scene, with a V trough along y. Its contact
// is analytic, independent of every production drop routine: for slope m,
// bull tip at the valley = 4 + (R-r)*m + r*(sqrt(1+m*m)-1).
function trough() {
  const b = new MeshBuilder()
  const row = (y: number) => [b.vertex(0, y, 16), b.vertex(45, y, 4), b.vertex(90, y, 16)]
  const a = row(0), c = row(60)
  b.quad(a[0], a[1], c[1], c[0])
  b.quad(a[1], a[2], c[2], c[1])
  const base = [b.vertex(0, 0, 0), b.vertex(90, 0, 0), b.vertex(90, 60, 0), b.vertex(0, 60, 0)]
  b.quad(base[0], base[3], base[2], base[1])
  // End caps follow the valley, rather than bridging across its opening.
  b.tri(base[0], base[1], a[1])
  b.tri(base[0], a[1], a[0])
  b.tri(base[1], a[2], a[1])
  b.tri(base[3], c[1], base[2])
  b.tri(base[3], c[0], c[1])
  b.tri(base[2], c[1], c[2])
  b.quad(base[0], a[0], c[0], base[3])
  b.quad(base[1], base[2], c[2], a[2])
  return b.build()
}

describe('WO-2460 real cutter shapes through computeOperationToolpath', () => {
  it('pencil uses the bull torus on a sloped trough, not a flat or ball substitute', async () => {
    const op = await productionScene(chain('pencil_3d'), input => { input.mesh = trough() })
    expect(op.status, op.errorMessage).toBe('ready')
    const moves = op.toolpathMoves ?? []
    const m = 12 / 45
    const lift = 2 * m + Math.sqrt(1 + m * m) - 1
    const samples = samplePath(moves, 0.1).filter(p => p.cutting && p.y > 4 && p.y < 56 && Math.abs(p.x - 45) < 0.15)
    const margins = samples.map(p => p.z - (4 + m * Math.abs(p.x - 45) + lift))
    const minMarginMm = Math.min(...margins), maxMarginMm = Math.max(...margins)
    const measured = { samples: samples.length, minMarginMm, maxMarginMm, bullLiftMm: lift,
      ballLiftMm: 3 * (Math.sqrt(1 + m * m) - 1), flatLiftMm: 3 * m }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(`${OUT}/bull-trough.json`, JSON.stringify({ measured, moves: moves.map(p => [p.x, p.y, p.z, p.role]) }))
    console.log('WO-2460 bull-trough:', JSON.stringify(measured))
    expect(samples.length).toBeGreaterThan(100)
    expect(minMarginMm).toBeGreaterThanOrEqual(-0.1)
    expect(maxMarginMm).toBeLessThan(0.1)
    expect(lift - measured.ballLiftMm).toBeGreaterThan(0.4)
    expect(measured.flatLiftMm - lift).toBeGreaterThan(0.2)
    expect(Math.min(...margins.map(v => v - 0.2))).toBeLessThan(-0.1)
  })

  it('exposes the real V-bit waterline limitation rather than promoting a fake slicer result', async () => {
    // Node resolves the package root to an unshipped native addon; load the
    // exact browser wasm build instead, as waterlineOclAdapter does. Nothing
    // about cutter mapping, slicing, strategy, or operation publication is fake.
    vi.stubGlobal('window', globalThis)
    const mod = require('@opencamlib/opencamlib/lib/emscripten/index.js') as OclWaterlineModule
    vi.unstubAllGlobals()
    const slicer = createOclWaterlineSlicer({ load: async () => mod })
    const op = await productionScene(chain('waterline_3d'), input => {
      input.tools[0] = { ...input.tools[0], type: 'v_bit', angleFromAxisDeg: 45 }
    }, slicer)
    mkdirSync(OUT, { recursive: true })
    writeFileSync(`${OUT}/vbit-production.json`, JSON.stringify({ status: op.status, error: op.errorMessage,
      moves: op.toolpathMoves?.length ?? 0, slicer: slicer.name }, null, 2))
    console.log('WO-2460 V-bit production:', op.status, op.errorMessage)
    expect(op.status).toBe('error')
    expect(op.errorMessage).toMatch(/V-bit has no waterline cutter model in the library/)
    expect(op.toolpathMoves?.length ?? 0).toBe(0)
  })

  it('reproduces the historical production refusal with the bull model absent', async () => {
    // Adversarial negative control at the worker seam, reproducing
    // b065d282b^ without editing any product source. The normal shape check
    // above requires ready + actual torus contact, and cannot pass this state.
    const makeCutter = BvhKernel.prototype.makeCutter
    const spy = vi.spyOn(BvhKernel.prototype, 'makeCutter').mockImplementation(function (this: BvhKernel, spec) {
      if (spec.kind === 'bull') throw new Error('BvhKernel: bull/vbit not implemented; see DECISIONS.md D-010')
      return makeCutter.call(this, spec)
    })
    try {
      const op = await productionScene(chain('pencil_3d'), input => { input.mesh = trough() })
      console.log('WO-2460 absent-bull negative control:', op.status, op.errorMessage)
      writeFileSync(`${OUT}/absent-bull-control.json`, JSON.stringify({ status: op.status, error: op.errorMessage,
        moves: op.toolpathMoves?.length ?? 0 }, null, 2))
      expect(op.status).toBe('error')
      expect(op.errorMessage).toMatch(/bull-nose drop is unavailable in the active geometry kernel/)
      expect(op.toolpathMoves?.length ?? 0).toBe(0)
    } finally { spy.mockRestore() }
  })
})
