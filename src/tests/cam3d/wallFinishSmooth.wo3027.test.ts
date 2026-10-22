// WO-3027: 3D adaptive round walls are finished smoothly, not as a staircase
// (WO-3019 item 6, Mission Control card B; the operator 2026-10-21 "Build all four").
//
// The wall cleanup rings used to be the cell-edge trace of the wall-contact
// field: on the Form torus every finish turn flipped (0.058 / 0.117 mm X/Y
// steps, p95 flip 90 deg). With ADAPTIVE_WALL_FINISH_POLICY.smoothWallRings on,
// the ring crossings are located on the model and the ring is simplified within
// a tenth of the tolerance. This test runs the stick's form-torus default row
// through the production chain runner (store computeOperationToolpath) with the
// switch on and judges only the 'finish' passes:
//   - flip rate <= 10 % and p95 flip < 10 deg (stick targets, alpha3-17 M-PROG-2/3),
//   - no gouge: the 6 mm cutter shrunk by the operation tolerance never dips
//     into the part (the stick's own surfaceMetrics),
//   - no leftover beyond tolerance: at every ring point a cutter wider by the
//     tolerance on each side touches the wall,
//   - fewer, longer moves than the staircase's 4,930.
// The switch ships OFF; with it off the path is the pre-WO-3027 path (P0 parity
// in src/tests/evidence/WO-3027/).
import { afterAll, describe, expect, it } from 'vitest'

import { ADAPTIVE_WALL_FINISH_POLICY } from '../../cam3d/strategies/adaptiveRough'
import { simplifyClosedRing } from '../../cam3d/rough/wallCleanup'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { area } from '../../cam3d/geom2d'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains, alpha3Parts } from '../benchmark/alpha3Registry'
import { pathMetrics, samplePath, surfaceMetrics, type SamplePoint } from '../benchmark/metrics'
import type { ToolpathMove } from '../../types'

const TOOL_DIAMETER = 6

/** The 'finish' passes alone: every other move breaks the flip run. */
function finishOnly(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.map(move => (move.role === 'finish' ? move : { ...move, type: 'rapid' as const, role: 'rapid' as const }))
}

/** Tool-tip samples of the finish moves, each run anchored where the tool stood. */
function finishSamples(moves: readonly ToolpathMove[]): SamplePoint[] {
  const out: SamplePoint[] = []
  let run: ToolpathMove[] = []
  let anchor: ToolpathMove | undefined
  const flush = (): void => {
    if (run.length) out.push(...samplePath(run, 0.05, anchor).slice(anchor ? 1 : 0))
    run = []
  }
  moves.forEach((move, i) => {
    if (move.role === 'finish') {
      if (!run.length) anchor = moves[i - 1]
      run.push(move)
    } else flush()
  })
  flush()
  return out
}

describe('WO-3027 3D adaptive wall finish is smooth', () => {
  afterAll(() => { ADAPTIVE_WALL_FINISH_POLICY.smoothWallRings = false })

  it('ships with the switch off', () => {
    expect(ADAPTIVE_WALL_FINISH_POLICY.smoothWallRings).toBe(false)
  })

  it('simplifies a closed ring within epsilon and keeps its winding', () => {
    const n = 2000
    const ring = new Float64Array(n * 2)
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n
      ring[2 * i] = 20 * Math.cos(a)
      ring[2 * i + 1] = 20 * Math.sin(a)
    }
    const simple = simplifyClosedRing(ring, 0.005)
    expect(simple.length / 2).toBeLessThan(n / 5)
    expect(Math.sign(area(simple))).toBe(Math.sign(area(ring)))
    // Every dropped vertex is within epsilon of the simplified ring's chords.
    const m = simple.length / 2
    for (let i = 0; i < n; i++) {
      let best = Infinity
      for (let j = 0; j < m; j++) {
        const ax = simple[2 * j], ay = simple[2 * j + 1]
        const bx = simple[(2 * j + 2) % simple.length], by = simple[(2 * j + 3) % simple.length]
        const dx = bx - ax, dy = by - ay
        const t = Math.max(0, Math.min(1, ((ring[2 * i] - ax) * dx + (ring[2 * i + 1] - ay) * dy) / (dx * dx + dy * dy)))
        best = Math.min(best, Math.hypot(ring[2 * i] - ax - t * dx, ring[2 * i + 1] - ay - t * dy))
      }
      expect(best).toBeLessThanOrEqual(0.005 + 1e-9)
    }
  })

  it('form-torus default: finish passes do not flip, do not gouge, leave no more than tolerance', async () => {
    ADAPTIVE_WALL_FINISH_POLICY.smoothWallRings = true
    const chain = alpha3Chains().find(c => c.id === 'form-torus-default')!
    const planned = await planChain({ ...chain, steps: chain.steps.filter(step => step.type === 'adaptive_3d') })
    const step = planned.steps[0]
    expect(step.status).toBe('ready')
    const tolerance = Number((step.settings?.params as Record<string, unknown> | undefined)?.tolerance)
    expect(tolerance).toBeGreaterThan(0)
    const finish = step.moves.filter(move => move.role === 'finish')
    expect(finish.length).toBeGreaterThan(0)

    const flips = pathMetrics(finishOnly(step.moves))
    expect(flips.turns).toBeGreaterThan(0)
    expect(flips.flipRatePct).toBeLessThanOrEqual(10)
    expect(flips.p95FlipDeg).toBeLessThan(10)
    expect(finish.length).toBeLessThan(1000)

    const mesh = await alpha3Parts().find(part => part.id === 'form-torus')!.mesh()
    // A ring beside the wall has no part under its footprint, so the drop
    // misses everywhere; any sample that does land on the part must not dip.
    const samples = finishSamples(step.moves)
    expect(samples.length).toBeGreaterThan(finish.length)
    const gouge = await surfaceMetrics({
      mesh,
      cutter: { kind: 'flat', diameter: TOOL_DIAMETER },
      samples,
      shrinkMm: tolerance,
    })
    expect(gouge.maxGougeMm).toBe(0)

    // Leftover: a cutter wider by the tolerance on each side, dropped at every
    // ring point, must reach above the tool tip (the wall is within tolerance).
    const kernel = new BvhKernel()
    const meshHandle = kernel.uploadMesh(mesh)
    const wide = kernel.makeCutter({ kind: 'flat', diameter: TOOL_DIAMETER + 2 * tolerance })
    try {
      const xy = Float64Array.from(finish.flatMap(move => [move.x, move.y]))
      const contact = await kernel.dropPoints(meshHandle, wide, xy, mesh.bounds.min[2] - 1e4)
      const farFromWall = finish.filter((move, i) => !(contact[i] > move.z + 1e-6)).length
      expect(farFromWall).toBe(0)
    } finally {
      kernel.releaseCutter(wide)
      kernel.releaseMesh(meshHandle)
    }
  }, 1_800_000)
})
