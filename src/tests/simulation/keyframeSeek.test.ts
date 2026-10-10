import { describe, it, expect } from 'vitest'
import { VoxelSimulator, type VoxelSimTool } from '../../lib/simulation/VoxelSimulator'
import type { StockBounds } from '../../lib/simulation/voxel/VoxelField'

// Carve-equivalence proof for the SimulationPanel keyframe scrub cache.
//
// The panel seeks by restoring the nearest keyframe (an earlier field snapshot)
// <= the target frame and carving the REMAINING moves, instead of always
// re-carving from frame 0. Because carveSweep is deterministic, that must be
// byte-for-byte identical to carving 0..target from the baseline. This drives the
// VoxelSimulator directly (no React) and asserts ZERO differing field cells for
// several target frames: forward, exact-keyframe, and backward-after-forward.

const BIG_BUDGET = 1_000_000
const KEYFRAME_INTERVAL = 50
const MOVE_COUNT = 400

const bounds = (
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): StockBounds => ({ x0, y0, z0, x1, y1, z1 })

const TOOL: VoxelSimTool = { type: 'flat_end_mill', diameter: 4 }

// A deterministic serpentine raster of points; move `fi` is pts[fi-1] -> pts[fi].
// z held at a real cutting depth so every move removes material from the solid.
const PTS: { x: number; y: number; z: number }[] = (() => {
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 0; i <= MOVE_COUNT; i++) {
    const row = Math.floor(i / 20)
    const col = i % 20
    const x = 2 + (row % 2 === 0 ? col : 19 - col) * 1.8 // 2..36.2
    const y = 2 + row * 1.0                              // 2..22
    out.push({ x, y, z: 5 })
  }
  return out
})()

const newSim = () => new VoxelSimulator(bounds(0, 0, 0, 40, 40, 10), 1, BIG_BUDGET)
const applyMove = (sim: VoxelSimulator, fi: number) => sim.sweepMove(PTS[fi - 1], PTS[fi], TOOL)

// Reference path: carve moves 1..target from a fresh solid baseline.
function carveFromBaseline(target: number): Float32Array {
  const sim = newSim()
  for (let fi = 1; fi <= target; fi++) applyMove(sim, fi)
  return sim.snapshot()
}

// Build the keyframe ring exactly as the panel does: carve forward once, snapshot
// every KEYFRAME_INTERVAL moves (idx 0 = baseline). Returns the live sim (now at
// `maxIdx`) and the ascending ring.
function buildRingCarvingForward(maxIdx: number, interval: number) {
  const sim = newSim()
  const ring: { idx: number; snap: Float32Array }[] = [{ idx: 0, snap: sim.snapshot() }]
  for (let fi = 1; fi <= maxIdx; fi++) {
    applyMove(sim, fi)
    if (fi % interval === 0) ring.push({ idx: fi, snap: sim.snapshot() })
  }
  return { sim, ring }
}

const nearestKeyframe = (
  ring: { idx: number; snap: Float32Array }[], target: number,
) => {
  let s = ring[0]
  for (let k = ring.length - 1; k >= 0; k--) {
    if (ring[k].idx <= target) { s = ring[k]; break }
  }
  return s
}

function countDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length)
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

describe('keyframe scrub cache — carve equivalence', () => {
  it('the synthetic raster actually removes material (test is not vacuous)', () => {
    const baseline = newSim().snapshot()
    const carved = carveFromBaseline(200)
    expect(countDiff(baseline, carved)).toBeGreaterThan(0)
  })

  it('restore(nearest keyframe) + carve == carve-from-baseline, byte-identical', () => {
    // Build the ring on a fresh sim (mirrors a forward play/scrub to MOVE_COUNT).
    const { ring } = buildRingCarvingForward(MOVE_COUNT, KEYFRAME_INTERVAL)

    // Forward (non-keyframe), exact-keyframe, and an early target.
    for (const target of [60, 100, 175, 200, 333, 400]) {
      const kf = nearestKeyframe(ring, target)
      // Seek via the cache on a FRESH field: restore the keyframe, carve the rest.
      const simB = newSim()
      simB.restore(kf.snap)
      for (let fi = kf.idx + 1; fi <= target; fi++) applyMove(simB, fi)

      const fieldA = carveFromBaseline(target)
      const fieldB = simB.snapshot()
      expect(countDiff(fieldA, fieldB), `target ${target} (kf ${kf.idx})`).toBe(0)
    }
  })

  it('backward-after-forward on the SAME sim is byte-identical (panel reuse path)', () => {
    // Carve forward to 380 building the ring, then seek BACKWARD to 120 by
    // restoring the nearest keyframe (idx 100) and carving 101..120 on the same
    // instance — exactly the panel's reused-VoxelSimulator backward seek.
    const { sim, ring } = buildRingCarvingForward(380, KEYFRAME_INTERVAL)
    const kf = nearestKeyframe(ring, 120)
    expect(kf.idx).toBe(100)
    sim.restore(kf.snap)
    for (let fi = kf.idx + 1; fi <= 120; fi++) applyMove(sim, fi)

    const fieldA = carveFromBaseline(120)
    const fieldB = sim.snapshot()
    expect(countDiff(fieldA, fieldB)).toBe(0)
  })
})
