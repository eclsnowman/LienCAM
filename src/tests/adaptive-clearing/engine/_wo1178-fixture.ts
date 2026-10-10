// WO-1178 shared fixture loader: one GOOD-corpus operation at the project's own settings,
// mapped exactly as engine/index.ts maps them (the persisted `climb` bit is the legacy
// inverse: false resolves to climb). A plain module, not a test file, so importing it never
// registers another file's tests.

import * as fs from 'fs'
import type { Loop, Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import type { ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const PROJECT = 'Example Projects/Adaptive Clearing Shapes.camproject'

export interface ProjectFixtureOptions {
  direction?: 'climb' | 'conventional'
  /** The canonical tripwire bank instead of the project's (0.2D, wall finish off). */
  canonical?: boolean
}

export function projectFixture(name: string, opts: ProjectFixtureOptions = {}): { boundary: Loop; holes: Loop[]; params: ProcessParams } {
  const project = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
  const operation = project.setups[0].operations.find((c: { name: string }) => c.name === `Adaptive Clearing - ${name}`)
  const geometry = project.geometry.find((c: { id: string }) => c.id === operation.params.geometryId)
  const tool = project.toolLibrary.find((c: { id: string }) => c.id === operation.toolId)
  const loops: Loop[] = geometry.loops.map((l: { points: Pt[] }) => l.points.map((p: Pt) => ({ x: p.x, y: p.y })))
  return {
    boundary: loops[0],
    holes: loops.slice(1),
    params: {
      toolRadius: tool.diameter / 2,
      stepOver: operation.passes.stepover / tool.diameter,
      tolerance: operation.params.tolerance,
      helixDiameter: tool.diameter * operation.params.helixDiameter / 100,
      millingDirection: opts.direction ?? (operation.params.climb === false ? 'climb' : 'conventional'),
      stockToLeave: operation.passes.stockToLeave,
      integralWallFollow: operation.params.integralWallFollow,
      integralWallFollowLengthFactor: operation.params.integralWallFollowLengthFactor,
      wallCleanupAsWeGo: operation.params.wallCleanupAsWeGo,
      loopbackFilletPct: operation.params.loopbackFilletPct,
      wallFinish: operation.params.wallFinish,
      ...(opts.canonical ? { stepOver: 0.2, wallFinish: false } : {}),
    },
  }
}

