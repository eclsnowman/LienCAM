import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { acquirePartMesh, computeParallel3dMoves } from '../../cam3d/integration/parallel3dOperation'
import type { ToolpathMove } from '../../types'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import { GRBL_CONFIG, UCCNC_CONFIG, postProgram } from '../../lib/post'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import type { PostInput, PostOperation } from '../../lib/post/types'
import { makeMachine, makeOp, makeTool, makeWcs } from './helpers'

const STL = fileURLToPath(new URL('../evidence/SHAKEDOWN-2026-09-07/wo1267-baseline/shakedown-wave.stl', import.meta.url))

function client(): Cam3dClient {
  const kernel = new BvhKernel()
  const worker: WorkerLike = { onmessage: null, onerror: null, postMessage(message: unknown) { dispatcher.handle(message as Cam3dRequest) }, terminate() {} }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => worker.onmessage?.({ data: message } as MessageEvent))
  return new Cam3dClient(worker)
}

function motionLines(gcode: string): string[] {
  let motion: string | undefined
  return gcode.split(/\r?\n/).flatMap((raw) => {
    const line = raw.replace(/\([^)]*\)/g, '').trim()
    const word = /\bG([0123])\b/.exec(line)
    if (word) motion = word[1]
    return motion !== undefined && /[XYZIJ]/.test(line) ? [line] : []
  })
}

async function regenerate(): Promise<ToolpathMove[]> {
  const bytes = readFileSync(STL)
  const mesh = await acquirePartMesh({ format: 'stl', bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, 0.05)
  // Normalize this count fixture's local mesh to its highest surface. The
  // captured setup's stock-corner placement is count-equivalent; the explicit
  // no-overrun setting below preserves its historical toolpath contract.
  const top = mesh.bounds.max[2]
  for (let i = 2; i < mesh.positions.length; i += 3) mesh.positions[i] -= top
  mesh.bounds.min[2] -= top
  mesh.bounds.max[2] = 0
  const tool = makeTool({ id: 't92', name: 'Test Long Tool', type: 'flat_end_mill', diameter: 9.52, toolNumber: 92 })
  const heights = { clearanceZ: 15, retractZ: 15, feedZ: 0, topZ: 0, bottomZ: mesh.bounds.min[2], stockTopZ: 0 }
  const run = async (angleDeg: number): Promise<ToolpathMove[]> => {
    const c = client()
    try { return (await computeParallel3dMoves({ partMesh: mesh, tool, feedrateOverride: undefined, params: { stepover: 3, angleDeg, tolerance: 0.05, useStockBoundary: false, stockEdgeOvershoot: 0 }, resolvedHeights: heights, client: c })).moves }
    finally { await c.dispose() }
  }
  return [...await run(0), ...await run(90)]
}

function input(moves: ToolpathMove[]): PostInput {
  const machine = makeMachine({ rapidRate: 5000 })
  const tool = makeTool({ id: 't92', name: 'Test Long Tool', type: 'flat_end_mill', diameter: 9.52, toolNumber: 92 })
  const op = makeOp({ id: 'crosshatch', name: '3D Finish', type: 'parallel_3d', toolId: tool.id, toolpathMoves: moves })
  const operation: PostOperation = { op, tool, moves, feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }
  return { machine, setup: { wcs: makeWcs(), operations: [operation] } }
}

describe('WO-1274 regenerated crosshatch count meanings', () => {
  it('pins the geometry route and both dialect renderings', { timeout: 60_000 }, async () => {
    const moves = await regenerate()
    expect(buildStraightLineProgram(moves, makeWcs(), 5000, { opId: 'crosshatch', setupId: 'setup-1' })).toMatchObject({ ok: true, motionCount: 6_240 }) // WO-2209 (9d05b10c8): the lead-in ends on each re-entered pass start, +15 moves (was 6_225; WO-1615 was 4_865)
    const uccnc = postProgram(input(moves), UCCNC_CONFIG)
    const grbl = postProgram(input(moves), { ...GRBL_CONFIG, capabilities: { ...GRBL_CONFIG.capabilities, arcs: false } })
    expect(uccnc.ok).toBe(true)
    expect(grbl.ok).toBe(true)
    expect(motionLines(uccnc.gcode)).toHaveLength(6_230) // WO-2209: +15 lead-in moves (was 6_215; WO-2023 added the Z-only lift before the first XY travel)
    expect(motionLines(grbl.gcode)).toHaveLength(6_242) // WO-2209: +15 lead-in moves (was 6_227; WO-2023 added the Z-only lift)
  })
})
