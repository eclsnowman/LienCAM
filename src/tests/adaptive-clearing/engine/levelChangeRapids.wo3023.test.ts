// WO-3023 (WO-3019 item 1): a 2D adaptive rapid never enters standing stock.
//
// At every level change, and at every new region entry, the engine used to push ONE rapid from
// the end of the last pass (below the stock top) straight to the next entry at Clearance: a
// diagonal through the wall between the H-pocket's chambers (default row: 5 rapids, worst 5 mm,
// e.g. (53.03, 13.03, Z14) -> (25.57, 32.63, Z31)). The entries now leave where the tool stands
// VERTICALLY first, the rule engine/emit.ts already states for the wall-finish approach.
//
// Judged on the measuring stick's own production route (planChain -> the store) and its own
// stock replay (the field, sweep and intrusion functions metrics.alpha3.ts M-SAFE-2 uses), on
// the H-pocket default row and the same part with the island typed as an island ('hole').
import { describe, expect, it } from 'vitest'
import type { ToolpathMove } from '../../../types'
import { chainScene, planChain } from '../../benchmark/chainRunner'
import { alpha3Chains, partById, toolById } from '../../benchmark/registry'
import { inventoryTools } from '../../benchmark/alpha3Registry'
import { toIrMoves } from '../../benchmark/metrics'
import type { BenchmarkChain } from '../../benchmark/registry'
import { toolToCutterSpec } from '../../../cam3d/integration/cutterSpec'
import { ZDexelField, removeSweep } from '../../../cam3d/stock'
import { maxTraverseIntrusion } from '../../../cam3d/stock/traverseClearance'
import { forEachLinearSweep, replaySagittaFor } from '../../../cam3d/rough/replayStock'
import { effectiveMoveRole, isStockCuttingRole } from '../../../lib/cam/stockCuttingRoles'

const ROW = 'engagement-pocket-adaptive_clearing_2d-default'

function rowChain(islandAsHole: boolean): BenchmarkChain {
  const base = alpha3Chains().find(c => c.id === ROW)!
  if (!islandAsHole) return base
  return { ...base, alpha3: { ...base.alpha3!, planarPicks: base.alpha3!.planarPicks!.map(loop =>
    loop.id.endsWith('~island') ? { ...loop, type: 'hole' as const } : loop) } }
}

interface RapidHit { index: number; from: number[]; to: number[]; intrusionMm: number }

/** Replay the row's moves into the stick's stock field; return every RAPID that meets standing
 *  stock (intrusion > 1e-3 mm, M-SAFE-2's own bound) and the count of rapids judged. */
async function rapidsIntoStock(chain: BenchmarkChain): Promise<{ moves: ToolpathMove[]; rapids: number; hits: RapidHit[] }> {
  const planned = await planChain(chain)
  const step = planned.steps[0]
  expect(step.status).toBe('ready')
  const { box } = await chainScene(chain)
  const bstep = chain.steps.find(s => s.id === step.stepId)!
  const cutter = toolToCutterSpec(inventoryTools([toolById(bstep.toolId).libraryTool!])[0])
  const field = ZDexelField.fromBox(box, partById(chain.partId).coverageCell)
  const moves = step.moves, ir = toIrMoves(moves)
  const hits: RapidHit[] = []
  let rapids = 0
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i], from = moves[i - 1]
    const cuts = isStockCuttingRole(effectiveMoveRole(m))
    let hit = -Infinity
    forEachLinearSweep(from, ir[i], replaySagittaFor(field), sweep => {
      hit = Math.max(hit, maxTraverseIntrusion(field, sweep, cutter).intrusionMm)
      if (cuts) removeSweep(field, sweep, cutter)
    })
    if (m.type !== 'rapid') continue
    rapids++
    if (hit > 1e-3) hits.push({ index: i, from: [from.x, from.y, from.z], to: [m.x, m.y, m.z], intrusionMm: hit })
  }
  return { moves, rapids, hits }
}

describe('WO-3023 2D adaptive level-change rapids', () => {
  for (const [label, islandAsHole] of [['default row', false], ['island typed as an island', true]] as const) {
    it(`no rapid enters standing stock on the H-pocket ${label}`, async () => {
      const { moves, rapids, hits } = await rapidsIntoStock(rowChain(islandAsHole))
      expect(moves.length).toBeGreaterThan(1000)
      expect(rapids).toBeGreaterThan(0)
      // The assertion the order names: no rapid enters standing stock.
      expect(hits, `rapids into standing stock: ${JSON.stringify(hits.slice(0, 5))}`).toEqual([])

      // Every rapid that leaves a pass below Clearance for an entry rises straight up first:
      // a rapid that ends at Clearance starts either at Clearance or directly below its end.
      const clearanceZ = Math.max(...moves.map(m => m.z))
      for (let i = 1; i < moves.length; i++) {
        const m = moves[i], from = moves[i - 1]
        if (m.type !== 'rapid' || m.z !== clearanceZ || from.z >= clearanceZ - 1e-9) continue
        expect(Math.hypot(m.x - from.x, m.y - from.y), `move ${i} rises diagonally to Clearance`).toBeLessThan(1e-9)
      }
    }, 600_000)
  }
})
