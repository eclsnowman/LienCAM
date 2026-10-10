// WO-2460: WO-1968 (b065d282b) added the physical bull-nose cutter to BVH.
// Keep this historical probe, but pin production output and the r1 underside.
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { planChain } from './chainRunner'
import { WHOLE_PART, type BenchmarkChain } from './registry'
import { engagementPocket } from '../../cam3d/fixtures'
import { measureBullPencil } from '../helpers/prismaticContact'

describe('WO-1218 / WO-2460 bull-nose pencil through production compute', () => {
  it('computes bm-bull-6 without gouging and contacts its real r1 profile', async () => {
    const chain: BenchmarkChain = {
      id: 'wo1218-pencil-bull-nose-refusal',
      partId: 'engagement-pocket',
      setupLabel: 'refusal-probe',
      tiers: [],
      steps: [
        {
          id: 'pencil-bull-refusal',
          type: 'pencil_3d',
          toolId: 'bm-bull-6',
          scope: WHOLE_PART,
          params: { tolerance: 0.05, stockToLeave: 0, useStockBoundary: false, direction: 'climb' },
          stockToLeaveMm: 0,
          gougeToleranceMm: 0.4,
          lateralAllowanceMm: 0.2,
        },
      ],
    }
    const planned = await planChain(chain)
    const moves = planned.steps[0].moves
    const measured = measureBullPencil(engagementPocket(), moves)
    mkdirSync('src/tests/evidence/WO-2460', { recursive: true })
    writeFileSync('src/tests/evidence/WO-2460/bull-pencil.json', JSON.stringify({ measured,
      moves: moves.map(m => [m.x, m.y, m.z, m.role]) }))
    console.log('WO-2460 bull-pencil:', JSON.stringify(measured))
    expect(measured.cutSamples).toBeGreaterThan(100)
    expect(measured.minMarginMm).toBeGreaterThanOrEqual(-0.05)
    expect(measured.contactSamples / measured.cutSamples).toBeGreaterThan(0.9)
    expect(measured.differsFromBall).toBeGreaterThan(100)
    // These vertical walls put the top under the bull's flat disk. The
    // sloped-trough production check in WO-2460 distinguishes corner radii.
    expect(measured.differsFromFlat).toBe(0)
    // Negative control: the oracle catches a path that is lowered into the model.
    const lowered = moves.map(m => ({ ...m, z: m.z - 0.2 }))
    expect(measureBullPencil(engagementPocket(), lowered).minMarginMm).toBeLessThan(-0.1)
  })
})
