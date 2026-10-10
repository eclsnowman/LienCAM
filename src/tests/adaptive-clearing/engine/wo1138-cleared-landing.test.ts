// WO-1138: when the current at-depth position reaches a tight-corner landing through
// whole-cutter-clear stock, route through that stock instead of drilling a second helix.
//
// This is Operator's exact alternate-settings Bar project, driven through the app entry point.
// WO-1134 proved its corner rejects every tangent lead while exposing 24 clear-air centres;
// the permanent assertion below pins the emitted motion, not an internal planner flag.

import { beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import type { ACWorkerPayload } from '../../../lib/cam/types'
import type { Tool, ToolpathMove } from '../../../types'

const PROJECT = 'Example Projects/Corner Helix Bar.camproject'

interface Ring { x: number; y: number }

function helixRings(moves: ToolpathMove[]): Ring[] {
  const rings: Ring[] = []
  let samples: ToolpathMove[] = []
  const finish = (): void => {
    if (samples.length === 0) return
    rings.push({
      x: samples.reduce((sum, move) => sum + move.x, 0) / samples.length,
      y: samples.reduce((sum, move) => sum + move.y, 0) / samples.length,
    })
    samples = []
  }
  for (const move of moves) {
    if (move.role === 'helix') samples.push(move)
    else finish()
  }
  finish()
  return rings
}

describe('WO-1138: tight-corner landing routes through cleared stock', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('keeps the accepted seed helix and emits no corner helix after tangent leads fail', async () => {
    const project = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
    const setup = project.setups[0]
    const operation = setup.operations.find((candidate: { type: string }) => candidate.type === 'adaptive_clearing_2d')
    const geometry = project.geometry.find((candidate: { id: string }) => candidate.id === operation.params.geometryId)
    const tool = (project.toolLibrary as Tool[]).find(candidate => candidate.id === operation.toolId)
    expect(geometry).toBeDefined()
    expect(tool).toBeDefined()

    const payload = {
      opId: operation.id,
      setupId: setup.id,
      params: operation.params,
      heights: operation.heights,
      passes: operation.passes,
      linking: operation.linking,
      tool,
      loops: geometry.loops,
      wcsOrigin: setup.wcsOrigin ?? setup.origin ?? { x: 0, y: 0, z: 0 },
    } as unknown as ACWorkerPayload

    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    let moves: ToolpathMove[]
    try { moves = await buildAdaptiveClearingToolpath(payload) } finally { console.warn = warn }

    // WO-1178 re-pin. The corner that needed the routed landing no longer needs any landing:
    // a ring that reaches a wall rides it into the corner, so the walk never has to lift and
    // come back to the corner seam. The rung itself is unchanged and stays in planGatedLanding
    // for the corner that does lift; what this case guards is the outcome Operator asked for --
    // one helix on this part, and no corner helix drilled by any path.
    expect(warnings.filter(message => message.includes('descending via HELIX')),
      'no landing on this part drills a helix').toEqual([])
    const routed = warnings.find(message => message.includes('no legal tangent lead') && message.includes('WO-1138'))
    if (routed) expect(routed, 'when the routed rung is used it traverses cleared stock').toContain('whole-cutter-clear stock')

    const rings = helixRings(moves)
    expect(rings, 'only WO-1103\'s accepted end-biased channel seed remains').toHaveLength(1)
    expect(rings[0].x).toBeCloseTo(132.68, 1)
    // WO-1896: the helix now winds the other way (climb keeps material right), which moves
    // the sample-average of its partial turn; the seed centre is unchanged.
    expect(rings[0].y).toBeCloseTo(-20.23, 1)
  }, 240_000)
})
