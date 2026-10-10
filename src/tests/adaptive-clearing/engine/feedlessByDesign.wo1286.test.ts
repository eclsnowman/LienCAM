// WO-1286: the adaptive engine emits fast_traverse and finish moves WITHOUT a
// baked feed, BY DESIGN (ADR-0001: geometry and speed are separate; the worker
// has no machine to clamp a traverse against). The consumer that knows the
// machine resolves them by role: the runtime estimate, the simulation, the
// feed panel, and, since WO-1286, the geometry door. This pin exists so nobody
// "fixes" the geometry route's refusal by baking a number in here: a traverse
// given the cutting feed would turn a loud refusal into a slow cut, and a
// traverse given a number the engine invented would not be the machine's.

import { describe, expect, it } from 'vitest'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import type { ACParams, ACWorkerPayload, LoopData } from '../../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool } from '../../../types'

const TOOL: Tool = {
  id: 't1', name: 'O6 flat', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 5, stepover: 1.2, stockToLeave: 0.5, finishPasses: 0, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1,
  retractType: 'full', transitionType: 'safe_height',
}
function rect(x0: number, y0: number, w: number, h: number): LoopData {
  return { id: 'rect', closed: true, type: 'contour', points: [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }] }
}
export function adaptivePayload(wallFinish: boolean): ACWorkerPayload {
  return {
    opId: 'op1', setupId: 'setup1',
    params: {
      geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
      stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
      helixDiameter: 5, tolerance: 0.02, wallFinish,
    } as ACParams,
    heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: TOOL,
    loops: [rect(100, 100, 40, 30)], wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

describe('WO-1286: the adaptive engine leaves the traverse and finish feeds to the machine', () => {
  for (const wallFinish of [false, true]) {
    it(`closed 40 x 30 pocket, wall finish ${wallFinish ? 'on' : 'off'}: every fast_traverse${wallFinish ? ' and finish' : ''} move carries NO feed, every other feed move carries one`, async () => {
      await ensureEngineClipperReady()
      const moves = await buildAdaptiveClearingToolpath(adaptivePayload(wallFinish))
      const traverses = moves.filter((m) => m.role === 'fast_traverse')
      const finish = moves.filter((m) => m.role === 'finish')
      const others = moves.filter((m) => m.type !== 'rapid' && m.role !== 'fast_traverse' && m.role !== 'finish')
      expect(traverses.length).toBeGreaterThan(0)
      expect(finish.length > 0).toBe(wallFinish)
      expect(others.length).toBeGreaterThan(100)
      for (const m of traverses) expect(m.type, 'a fast_traverse is a FEED move at depth, never a rapid').toBe('feed')
      for (const m of [...traverses, ...finish]) expect(m.feed).toBeUndefined()
      for (const m of others) expect(m.feed, `${m.role} carries its own feed`).toBeGreaterThan(0)
    }, 120_000)
  }
})
