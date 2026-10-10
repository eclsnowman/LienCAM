import { beforeAll, describe, expect, it } from 'vitest'

import {
  bossInOpenStock,
  draftDomePocket,
  hemisphereOnSlab,
} from '../../cam3d/fixtures'
import { ensureGeom2dReady } from '../../cam3d/geom2d'
import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
  type Adaptive3dParams,
} from '../../cam3d/integration/adaptive3dOperation'
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../cam3d/kernel/types'
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry'
import {
  forEachLinearSweep,
  replaySagittaFor,
} from '../../cam3d/rough/replayStock'
import { removeSweep, ZDexelField, type Box3 } from '../../cam3d/stock'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import type { OperationDiagnostics, Tool } from '../../types'
import { makeTool } from '../post/helpers'

const EPS = 1e-6

type Generated = {
  input: Parameters<Cam3dClient['generateAdaptiveRough']>[0]
  ir: ToolpathIR
  diagnostics?: OperationDiagnostics
}

type TerraceMeasurement = {
  z: number
  firstMoveIndex: number
  lastMoveIndex: number
  lowerFullZ: number | null
  lowerComponentOrders: number[]
  lowerExposureMoveIndex: number | null
  deferredInterveningTravelMm: number | null
  finishTravelMm: number
  removedVolumeMm3: number
  freshRemovedCrossSectionMm2: number
  changedColumns: number
  changedAreaMm2: number
  maximumTopReductionMm: number
}

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {
      // The in-process diagnostic owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  return new Cam3dClient(fakeWorker)
}

function tool(diameter: number): Tool {
  return makeTool({
    id: `wo1812-flat-${diameter}`,
    name: `WO-1812 flat ${diameter}mm`,
    type: 'flat_end_mill',
    diameter,
    toolNumber: 1812,
  })
}

function sameZ(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS
}

function moveLength(from: IrMove | undefined, move: IrMove, sagitta: number): number {
  if (from === undefined) return 0
  let length = 0
  forEachLinearSweep(from, move, sagitta, sweep => {
    length += Math.hypot(
      sweep.x1 - sweep.x0,
      sweep.y1 - sweep.y0,
      sweep.z1 - sweep.z0,
    )
  })
  return length
}

function scheduleOf(generated: Generated): Array<{
  order: number
  levelIndex: number
  componentIndex: number
  z: number
}> {
  return generated.diagnostics?.adaptiveRough?.componentSchedule ?? []
}

function measureTerraces(generated: Generated): {
  fullLevelZs: number[]
  schedule: ReturnType<typeof scheduleOf>
  phaseRuns: Array<{ kind: 'bulk' | 'terrace'; z: number; firstMoveIndex: number; lastMoveIndex: number }>
  terraces: TerraceMeasurement[]
  firstTerraceMoveIndex: number | null
  lastBulkCutMoveIndex: number | null
  topInterval: {
    upperBoundaryZ: number
    firstFullZ: number | null
    midpointZ: number | null
    emitted: boolean
  }
} {
  const schedule = scheduleOf(generated)
  const fullLevelZs = [...new Set(schedule.map(item => item.z))].sort((a, b) => b - a)
  const isFullLevel = (z: number): boolean => fullLevelZs.some(level => sameZ(level, z))
  const groups = new Map<string, {
    z: number
    firstMoveIndex: number
    lastMoveIndex: number
  }>()
  for (let index = 0; index < generated.ir.moves.length; index++) {
    const move = generated.ir.moves[index]
    if (move.role !== 'finish' || isFullLevel(move.z)) continue
    const key = move.z.toFixed(6)
    const group = groups.get(key)
    if (group) group.lastMoveIndex = index
    else groups.set(key, { z: move.z, firstMoveIndex: index, lastMoveIndex: index })
  }
  const orderedGroups = [...groups.values()].sort((a, b) => a.firstMoveIndex - b.firstMoveIndex)
  const terraceAt = (move: IrMove): boolean =>
    move.role === 'finish' && orderedGroups.some(group => sameZ(group.z, move.z))

  const phaseRuns: Array<{
    kind: 'bulk' | 'terrace'
    z: number
    firstMoveIndex: number
    lastMoveIndex: number
  }> = []
  for (let index = 0; index < generated.ir.moves.length; index++) {
    const move = generated.ir.moves[index]
    const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role })
    if (!isStockCuttingRole(role)) continue
    const kind = terraceAt(move) ? 'terrace' as const : 'bulk' as const
    // Helix/ramp samples cross many transient Z values. The order question is
    // about the target full and terrace planes, so keep the raw move indexes
    // but omit those entry-only samples from this compact phase timeline.
    if (kind === 'bulk' && !isFullLevel(move.z)) continue
    const prior = phaseRuns.at(-1)
    if (prior && prior.kind === kind && sameZ(prior.z, move.z)) {
      prior.lastMoveIndex = index
    } else {
      phaseRuns.push({ kind, z: move.z, firstMoveIndex: index, lastMoveIndex: index })
    }
  }

  const stock = ZDexelField.fromBox(generated.input.stockBounds, generated.input.cellSize)
  const sagitta = replaySagittaFor(stock)
  const lengths = generated.ir.moves.map((move, index) =>
    moveLength(index > 0 ? generated.ir.moves[index - 1] : undefined, move, sagitta))
  const measurements = new Map<string, TerraceMeasurement & { beforeTop?: Float32Array }>()
  for (const group of orderedGroups) {
    const lowerFullZ = fullLevelZs.find(level => level < group.z - EPS) ?? null
    const lowerComponentOrders = lowerFullZ === null
      ? []
      : schedule.filter(item => sameZ(item.z, lowerFullZ)).map(item => item.order)
    let lowerExposureMoveIndex: number | null = null
    if (lowerFullZ !== null) {
      for (let index = 0; index < group.firstMoveIndex; index++) {
        const move = generated.ir.moves[index]
        const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role })
        if (isStockCuttingRole(role) && sameZ(move.z, lowerFullZ)) lowerExposureMoveIndex = index
      }
    }
    measurements.set(group.z.toFixed(6), {
      ...group,
      lowerFullZ,
      lowerComponentOrders,
      lowerExposureMoveIndex,
      deferredInterveningTravelMm: lowerExposureMoveIndex === null
        ? null
        : lengths.slice(lowerExposureMoveIndex + 1, group.firstMoveIndex + 1)
          .reduce((sum, value) => sum + value, 0),
      finishTravelMm: 0,
      removedVolumeMm3: 0,
      freshRemovedCrossSectionMm2: 0,
      changedColumns: 0,
      changedAreaMm2: 0,
      maximumTopReductionMm: 0,
    })
  }

  let tip: { x: number; y: number; z: number } | undefined
  for (let index = 0; index < generated.ir.moves.length; index++) {
    const move = generated.ir.moves[index]
    const measurement = measurements.get(move.z.toFixed(6))
    if (measurement && index === measurement.firstMoveIndex) {
      measurement.beforeTop = stock.top.slice()
    }
    const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role })
    if (tip !== undefined && isStockCuttingRole(role)) {
      forEachLinearSweep(tip, move, sagitta, sweep => {
        const length = Math.hypot(
          sweep.x1 - sweep.x0,
          sweep.y1 - sweep.y0,
          sweep.z1 - sweep.z0,
        )
        const removed = removeSweep(stock, sweep, generated.input.cutter)
        if (measurement && move.role === 'finish') {
          measurement.finishTravelMm += length
          measurement.removedVolumeMm3 += removed.removedVolumeMm3
        }
      })
    }
    tip = { x: move.x, y: move.y, z: move.z }
    if (measurement && index === measurement.lastMoveIndex && measurement.beforeTop) {
      for (let column = 0; column < stock.top.length; column++) {
        const reduction = measurement.beforeTop[column] - stock.top[column]
        if (reduction <= 1e-9) continue
        measurement.changedColumns++
        measurement.maximumTopReductionMm = Math.max(measurement.maximumTopReductionMm, reduction)
      }
      measurement.changedAreaMm2 = measurement.changedColumns * stock.cell * stock.cell
      measurement.freshRemovedCrossSectionMm2 = measurement.removedVolumeMm3
        / Math.max(measurement.finishTravelMm, Number.EPSILON)
      delete measurement.beforeTop
    }
  }

  const firstTerraceMoveIndex = orderedGroups[0]?.firstMoveIndex ?? null
  let lastBulkCutMoveIndex: number | null = null
  if (firstTerraceMoveIndex !== null) {
    for (let index = 0; index < firstTerraceMoveIndex; index++) {
      const move = generated.ir.moves[index]
      const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role })
      if (isStockCuttingRole(role)) lastBulkCutMoveIndex = index
    }
  }
  const firstFullZ = fullLevelZs[0] ?? null
  const midpointZ = firstFullZ === null
    ? null
    : (generated.input.stockBounds.maxZ + firstFullZ) / 2

  return {
    fullLevelZs,
    schedule,
    phaseRuns,
    terraces: [...measurements.values()].map(({ beforeTop: _beforeTop, ...value }) => value),
    firstTerraceMoveIndex,
    lastBulkCutMoveIndex,
    topInterval: {
      upperBoundaryZ: generated.input.stockBounds.maxZ,
      firstFullZ,
      midpointZ,
      emitted: midpointZ !== null && orderedGroups.some(group => sameZ(group.z, midpointZ)),
    },
  }
}

async function generate(input: {
  name: string
  mesh: PartMesh
  stockBounds: Box3
  floorZ: number
  diameter: number
  cellSize: number
  sideEntry?: boolean
}): Promise<ReturnType<typeof measureTerraces>> {
  const realClient = makeClient()
  let generated: Generated | undefined
  const recordingClient = {
    generateAdaptiveRough: async (...args: Parameters<Cam3dClient['generateAdaptiveRough']>) => {
      const result = await realClient.generateAdaptiveRough(...args)
      generated = {
        input: args[0],
        ir: result.ir,
        diagnostics: result.diagnostics,
      }
      return result
    },
  } as unknown as Cam3dClient
  const params: Adaptive3dParams = {
    ...DEFAULT_ADAPTIVE3D_PARAMS,
    maxStepdown: 3,
    stepover: 0.4,
    intermediateStepdown: true,
    tolerance: 0.05,
    helixDiameter: Math.min(3, input.diameter / 2),
    cellSize: input.cellSize,
    useStockBoundary: true,
  }
  try {
    const result = await computeAdaptive3dMoves({
      partMesh: input.mesh,
      tool: tool(input.diameter),
      params,
      stockBounds: input.stockBounds,
      stockBoundsAreRealStock: true,
      resolvedHeights: {
        clearanceZ: input.stockBounds.maxZ + 15,
        retractZ: input.stockBounds.maxZ + 5,
        feedZ: input.stockBounds.maxZ + 5,
        topZ: input.stockBounds.maxZ,
        bottomZ: input.floorZ,
      },
      ...(input.sideEntry
        ? { sideEntry: true, reachStockEdgeBy: input.diameter }
        : {}),
      client: recordingClient,
    })
    expect(result.moves.length).toBeGreaterThan(0)
    expect(generated).toBeDefined()
    const measured = measureTerraces(generated!)
    console.log(`WO-1812 ${input.name} ${JSON.stringify(measured)}`)
    return measured
  } finally {
    await realClient.dispose()
  }
}

describe('WO-1812/WO-1814 adaptive intermediate-terrace scheduling measurements', () => {
  beforeAll(async () => {
    await ensureGeom2dReady()
    await ensureEngineClipperReady()
  })

  it('records productive dome terraces interleaved after their lower exposure', { timeout: 600_000 }, async () => {
    const measured = await generate({
      name: 'dome',
      mesh: hemisphereOnSlab(12, { x: 40, y: 40, t: 10 }),
      stockBounds: { minX: -5, minY: -5, minZ: 0, maxX: 45, maxY: 45, maxZ: 29 },
      floorZ: 10,
      diameter: 9.52,
      cellSize: 9.52 / 12,
      sideEntry: true,
    })
    expect(measured.terraces.length).toBeGreaterThan(0)
    expect(measured.phaseRuns.some((run, index) =>
      run.kind === 'terrace' && measured.phaseRuns.slice(index + 1).some(later => later.kind === 'bulk')))
      .toBe(true)
    const productive = measured.terraces.filter(terrace => terrace.removedVolumeMm3 > 0)
    expect(productive.length).toBeGreaterThan(0)
    expect(productive.every(terrace =>
      terrace.lowerExposureMoveIndex !== null
      && terrace.lowerExposureMoveIndex < terrace.firstMoveIndex))
      .toBe(true)
  })

  it('omits vertical-wall laps that remove no fresh stock', { timeout: 600_000 }, async () => {
    const measured = await generate({
      name: 'vertical-boss',
      mesh: bossInOpenStock({ x: 40, y: 40 }, { x: 20, y: 20, z: 12 }),
      stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 15 },
      floorZ: 0,
      diameter: 6,
      cellSize: 0.5,
      sideEntry: true,
    })
    expect(measured.terraces).toEqual([])
  })

  it('records dependency candidates on a mixed pocket, island, draft, and dome', { timeout: 600_000 }, async () => {
    const measured = await generate({
      name: 'mixed-pocket',
      mesh: draftDomePocket(91, 61),
      // Keep the retained surface off the sampled-stock frame edge. With an
      // exact 0..90 x 0..60 box, the cutter-contact offset legitimately reaches
      // outside the field and the retained-model gate rejects that synthetic
      // fixture before scheduling can be measured.
      stockBounds: { minX: -5, minY: -5, minZ: 4, maxX: 95, maxY: 65, maxZ: 16 },
      // Stop above the open heightfield's analytic Z4 floor. At Z4 its coarse
      // synthetic tessellation asks the exact retained-model gate for another
      // 0.02mm, which is unrelated to terrace timing and prevents evidence.
      floorZ: 7,
      diameter: 6,
      cellSize: 0.75,
      sideEntry: true,
    })
    expect(measured.schedule.length).toBeGreaterThan(0)
    expect(measured.topInterval.emitted).toBe(true)
    expect(measured.phaseRuns.some((run, index) =>
      run.kind === 'terrace' && measured.phaseRuns.slice(index + 1).some(later => later.kind === 'bulk')))
      .toBe(true)
  })
})
