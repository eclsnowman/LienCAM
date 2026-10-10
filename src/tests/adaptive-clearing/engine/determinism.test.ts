// Determinism regression gate. CAM toolpaths must be reproducible: identical inputs must
// emit byte-identical pass streams. The engine's only randomness source was Math.random in
// the steering probe angles (interpolation.ts randInRange); it is now a fixed-seed
// mulberry32 per interpolator instance. clipper2-wasm itself is deterministic. If this test
// ever fails, someone reintroduced an unseeded randomness (or other run-order-dependent
// state) into the engine -- find it, do not loosen this assertion.

import { describe, it, beforeAll, expect } from 'vitest'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

function circle(cx: number, cy: number, r: number, n = 120): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}

// Same square+island fixture the integral-wall-follow gate uses: big enough to exercise
// helix entry, engagement-limited fill, island wrap, and inter-pass links.
const square: Loop = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }]
const params: ProcessParams = { toolRadius: 2, stepOver: 0.5, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0.5 }

function runOnce(): string {
  const island = circle(30, 30, 8)
  const res = processFeature({ boundary: square, holes: [island] }, params)
  return JSON.stringify(res.passes)
}

describe('engine determinism', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('two in-process runs on the same fixture emit byte-identical pass streams', () => {
    const r1 = runOnce()
    const r2 = runOnce()
    // Compare a boolean, not the strings, so a failure does not dump megabytes of JSON.
    expect(r1 === r2, 'pass streams differ between two identical runs').toBe(true)
  }, 120_000)
})
