import { describe, expect, it } from 'vitest'

import { computeParallel3dMoves, DEFAULT_PARALLEL3D_PARAMS } from '../../cam3d/integration/parallel3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { Cam3dClient } from '../../cam3d/worker/client'
import type { FeedrateOverride } from '../../types'
import { buildFrames } from '../../components/simulation/SimulationPanel'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import {
  MACHINE_RAPID_RATE,
  TOOL_CUT_RATE,
  OVERRIDE_CUT_RATE,
  hierarchyTool,
  operationOverride,
} from './feedHierarchyFixtures'

// SIM-7 (BK-138) twin of feedHierarchy.sim4.test.ts: the SIM-4 fixture proved
// the Machine -> Tool -> Operation Override feed hierarchy reaches simulation
// frames for adaptive_3d end-to-end; parallel3dOperation's identical
// resolveFeedrates + irToToolpathMoves wiring was proven by inspection only.
// Same hierarchy cases, derived from the SAME shared fixture module (not
// hand-copied), just routed through computeParallel3dMoves instead.

const mesh: PartMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [100, 100, 10] },
  source: 'fixture',
}

function roleOnlyParallelClient(): Cam3dClient {
  return {
    generateParallelFinish: async () => ({
      moves: [
        { t: 'rapid' as const, x: 0, y: 0, z: 10, role: 'rapid' as const },
        { t: 'feed' as const, x: 100, y: 0, z: 10, role: 'cut' as const },
      ],
      meta: { strategyId: 'parallel_finish', cutterId: 'feed-hierarchy-tool' },
    }),
  } as unknown as Cam3dClient
}

async function generateFixtureMoves(feedrateOverride?: FeedrateOverride) {
  const tool = hierarchyTool()
  const args = {
    partMesh: mesh,
    tool,
    params: { ...DEFAULT_PARALLEL3D_PARAMS },
    resolvedHeights: {
      clearanceZ: 20,
      retractZ: 12,
      feedZ: 12,
      topZ: 10,
      bottomZ: 0,
    },
    client: roleOnlyParallelClient(),
    feedrateOverride,
  }
  return computeParallel3dMoves(args)
}

describe('SIM-7 3D operation feed hierarchy reaches simulation frames (parallel_3d twin of SIM-4)', () => {
  it('carries machine, tool, and operation rates from parallel_3d into frames', async () => {
    const tool = hierarchyTool()
    const toolRates = resolveFeedrates(tool, undefined, MACHINE_RAPID_RATE)
    const overrideRates = resolveFeedrates(tool, operationOverride, MACHINE_RAPID_RATE)

    expect(toolRates.feedRate).toBe(TOOL_CUT_RATE)
    expect(overrideRates.feedRate).toBe(OVERRIDE_CUT_RATE)

    const toolResult = await generateFixtureMoves()
    const overrideResult = await generateFixtureMoves(operationOverride)

    expect(toolResult.moves[1].feed).toBe(toolRates.feedRate)
    expect(overrideResult.moves[1].feed).toBe(overrideRates.feedRate)

    const toolFrames = buildFrames(toolResult.moves, MACHINE_RAPID_RATE).frames
    const overrideFrames = buildFrames(overrideResult.moves, MACHINE_RAPID_RATE).frames

    expect(toolFrames.map(frame => frame.speedMmPerMin)).toEqual([TOOL_CUT_RATE])
    expect(overrideFrames.map(frame => frame.speedMmPerMin)).toEqual([OVERRIDE_CUT_RATE])
    expect(toolFrames[0].durationMs).toBeCloseTo(7500, 9)
    expect(overrideFrames[0].durationMs).toBeCloseTo(6666.666666666667, 9)
  })
})
