// WO-1139 PHASE-1 DIAGNOSTIC: count what the Toolpath viewport actually draws.
//
// The older corpus counter grouped consecutive raw `role === 'helix'` moves. The viewport
// does not consume those groups: it assigns every drawn segment to its destination move's
// role through buildToolpathRoleSegmentsIndexed(). It also renders `helix` and `ramp` in the
// same orange. This probe uses that production segment builder, reports every role per part,
// and calls out both orange roles separately.
//
// Run:
//   WO1139_TRUTH=1 npx vitest run \
//     src/tests/adaptive-clearing/engine/_wo1139-viewport-helix-truth.test.ts

import { beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import type { ACWorkerPayload } from '../../../lib/cam/types'
import {
  buildToolpathRoleSegmentsIndexed,
  type RoleSegmentData,
} from '../../../lib/viewport/toolpathSegments'
import type { Tool, ToolpathMove } from '../../../types'

const PROJECT = 'Example Projects/Adaptive Clearing Shapes.camproject'
const ORANGE_ROLES = new Set(['helix', 'ramp'])

interface DrawnRun {
  firstMove: number
  lastMove: number
  segments: number
  center: { x: number; y: number }
}

/** Consecutive segments in one role buffer are one visually continuous role run. */
function drawnRuns(data: RoleSegmentData): DrawnRun[] {
  const runs: DrawnRun[] = []
  let start = 0
  for (let i = 1; i <= data.segRawIndex.length; i++) {
    if (i < data.segRawIndex.length && data.segRawIndex[i] === data.segRawIndex[i - 1] + 1) continue
    const xy: number[] = []
    for (let s = start; s < i; s++) {
      const o = s * 6
      if (s === start) xy.push(data.positions[o], data.positions[o + 1])
      xy.push(data.positions[o + 3], data.positions[o + 4])
    }
    const xs = xy.filter((_, n) => n % 2 === 0)
    const ys = xy.filter((_, n) => n % 2 === 1)
    runs.push({
      firstMove: data.segRawIndex[start],
      lastMove: data.segRawIndex[i - 1],
      segments: i - start,
      center: {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      },
    })
    start = i
  }
  return runs
}

describe('WO-1139: GOOD corpus viewport helix truth', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it.skipIf(!process.env.WO1139_TRUTH)('reports the exact drawn runs per part and role', async () => {
    const project = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
    const tools: Tool[] = project.toolLibrary
    const report: Record<string, unknown> = {}

    for (const setup of project.setups) {
      const wcsOrigin = setup.wcsOrigin ?? setup.origin ?? { x: 0, y: 0, z: 0 }
      for (const operation of setup.operations) {
        if (operation.type !== 'adaptive_clearing_2d') continue
        const geometry = project.geometry.find((g: { id: string }) => g.id === operation.params.geometryId)
        const tool = tools.find(t => t.id === operation.toolId)
        if (!geometry || !tool) throw new Error(`missing geometry/tool for ${operation.name}`)
        const payload = {
          opId: operation.id, setupId: setup.id,
          params: operation.params, heights: operation.heights, passes: operation.passes,
          linking: operation.linking, tool, loops: geometry.loops, wcsOrigin,
        } as unknown as ACWorkerPayload

        const warn = console.warn
        console.warn = () => {}
        let moves: ToolpathMove[]
        try { moves = await buildAdaptiveClearingToolpath(payload) } finally { console.warn = warn }

        const roles: Record<string, { segments: number; runs: DrawnRun[] }> = {}
        for (const [role, data] of buildToolpathRoleSegmentsIndexed(moves)) {
          roles[role] = { segments: data.positions.length / 6, runs: drawnRuns(data) }
        }
        const orange = Object.entries(roles)
          .filter(([role]) => ORANGE_ROLES.has(role))
          .flatMap(([role, value]) => value.runs.map(run => ({
            role, x: Number(run.center.x.toFixed(2)), y: Number(run.center.y.toFixed(2)),
            segments: run.segments, firstMove: run.firstMove, lastMove: run.lastMove,
          })))
        report[operation.name] = { moveCount: moves.length, roles, orange }
        console.log(`${operation.name}: ${orange.length} orange ring run(s) -> ${orange.map(r => `${r.role}@(${r.x.toFixed(2)},${r.y.toFixed(2)})`).join(' ')}`)
      }
    }

    if (process.env.WO1139_TRUTH_OUT) {
      fs.mkdirSync('src/tests/evidence/WO-1139', { recursive: true })
      fs.writeFileSync(process.env.WO1139_TRUTH_OUT, JSON.stringify(report, null, 2) + '\n')
    }
    expect(Object.keys(report)).toHaveLength(9)
  }, 3_000_000)
})
