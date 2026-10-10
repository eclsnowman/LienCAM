// WO-2169: the clear-all-stock rough WO-2145 gave a part in its own box stock runs
// along the stock edge without the sub-5-degree wobble and without the extra retracts,
// and keeps WO-2145's cut-time gain.
//
// Through the production toolpath entry: the benchmark's own chain runner plans each
// rough with computeOperationToolpath in a real scene (src/tests/benchmark/chainRunner.ts),
// and the numbers are the benchmark's own collector (pathMetrics). Pre-WO-2145 values
// (baseline.full.json, around-part route) and main 5847cf8f6 values are quoted per row.
import { describe, expect, it } from 'vitest'

import { planChain, type PlannedStep } from '../benchmark/chainRunner'
import { pathMetrics } from '../benchmark/metrics'
import { CHAINS } from '../benchmark/registry'

/** Plan only the first (rough) step of a benchmark chain. */
async function planRough(chainId: string): Promise<PlannedStep> {
  const chain = CHAINS.find((candidate) => candidate.id === chainId)
  if (!chain) throw new Error(`no benchmark chain ${chainId}`)
  const planned = await planChain({ ...chain, steps: chain.steps.slice(0, 1) })
  return planned.steps[0]
}

/** Direction flips that turn by less than 5 degrees: the stock-edge wobble. */
function smallFlips(step: PlannedStep): number {
  let count = 0
  let run: { x: number; y: number }[] = []
  let prevSign = 0
  let prev: PlannedStep['moves'][number] | undefined
  for (const move of step.moves) {
    const lateral = move.type !== 'rapid' && move.role === 'cut' && prev !== undefined && Math.abs(move.z - prev.z) < 1e-6
    if (!lateral) {
      run = [{ x: move.x, y: move.y }]
      prevSign = 0
      prev = move
      continue
    }
    run.push({ x: move.x, y: move.y })
    if (run.length >= 3) {
      const [p, a, b] = run.slice(-3)
      const angle = Math.atan2((a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x),
        (a.x - p.x) * (b.x - a.x) + (a.y - p.y) * (b.y - a.y))
      if (Math.abs(angle) > 1e-12) {
        const sign = Math.sign(angle)
        if (prevSign !== 0 && sign !== prevSign && Math.abs(angle) < (5 * Math.PI) / 180) count++
        prevSign = sign
      }
    }
    prev = move
  }
  return count
}

describe('WO-2169 full-clear rough rides the stock edge straight', () => {
  it('stepped-boss: the stock-edge wobble is gone (main 22.4% flips, 53 under 5 deg), cut time gain kept', async () => {
    const rough = await planRough('stepped-boss-rough-finish')
    const m = pathMetrics(rough.moves)
    console.log(`[WO-2169] stepped-boss flipRatePct ${m.flipRatePct.toFixed(2)} flips ${m.flips} small ${smallFlips(rough)} ` +
      `retracts ${m.retracts} cutTimeMs ${rough.cutTimeMs}`)
    expect(m.flipRatePct).toBeLessThanOrEqual(8) // pre-WO-2145 6.6%
    expect(smallFlips(rough)).toBeLessThanOrEqual(15) // main: 53 of its 61 flips
    expect(m.retracts).toBeLessThanOrEqual(6) // pre-WO-2145: 6
    expect(rough.cutTimeMs).toBeLessThan(79209 * 0.8) // pre-WO-2145 79209 ms; WO-2145 56565 ms
  }, 300_000)

  it('boss-taper-step: the stock-edge wobble is gone (main 29.5% flips, 267 under 5 deg), cut time gain kept', async () => {
    const rough = await planRough('boss-taper-step-rough-finish')
    const m = pathMetrics(rough.moves)
    console.log(`[WO-2169] boss-taper flipRatePct ${m.flipRatePct.toFixed(2)} flips ${m.flips} small ${smallFlips(rough)} ` +
      `retracts ${m.retracts} cutTimeMs ${rough.cutTimeMs}`)
    expect(m.flipRatePct).toBeLessThanOrEqual(10) // pre-WO-2145 2.4%
    expect(smallFlips(rough)).toBeLessThanOrEqual(40) // main: 267 of its 311 flips
    expect(m.retracts).toBeLessThanOrEqual(4) // pre-WO-2145: 4
    expect(rough.cutTimeMs).toBeLessThan(391739 * 0.7) // pre-WO-2145 391739 ms; WO-2145 230658 ms
  }, 300_000)

  it('feature-block mesh and STEP twins: no air lap and its retract on the pocket levels (main 14 / 12 retracts), cut time gain kept', async () => {
    for (const [chainId, before] of [['feature-block-mesh-rough-finish', 375375], ['feature-block-step-rough-finish', 376142]] as const) {
      const rough = await planRough(chainId)
      const m = pathMetrics(rough.moves)
      console.log(`[WO-2169] ${chainId} flipRatePct ${m.flipRatePct.toFixed(2)} flips ${m.flips} small ${smallFlips(rough)} ` +
        `retracts ${m.retracts} cutTimeMs ${rough.cutTimeMs}`)
      // WO-2707: 10 + 1 for WO-2693 (eecc6e40a, owner 10-09 "spindle should be at a
      // raised height"): the rough now ends with one lift to its clearance plane.
      // Lift disabled -> mesh 10 / STEP 8 again (src/tests/evidence/WO-2707/).
      expect(m.retracts, chainId).toBeLessThanOrEqual(11) // pre-WO-2145 6
      expect(smallFlips(rough), chainId).toBeLessThanOrEqual(75) // main: 150 (mesh)
      expect(rough.cutTimeMs, chainId).toBeLessThan(before) // WO-2145: 365205 / 362309 ms
    }
  }, 300_000)
})
