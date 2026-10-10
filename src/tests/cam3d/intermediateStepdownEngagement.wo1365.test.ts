import { beforeAll, describe, expect, it } from 'vitest'

import { hemisphereOnSlab } from '../../cam3d/fixtures'
import { ensureGeom2dReady } from '../../cam3d/geom2d'
import { irFingerprint, type IrMove, type ToolpathIR } from '../../cam3d/ir/types'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { CutterSpec, MeshHandle } from '../../cam3d/kernel/types'
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry'
import { replayMovesIntoStock } from '../../cam3d/rough/replayStock'
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough'
import { parallelFinish } from '../../cam3d/strategies/parallel'
import { engagementAt, removeSweep, ZDexelField, type Box3 } from '../../cam3d/stock'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'

const RADIUS = 12
const SLAB_TOP_Z = 10
const STOCK: Box3 = { minX: -5, minY: -5, minZ: 0, maxX: 45, maxY: 45, maxZ: 29 }
const ROUGH_CELL = 9.52 / 12
const FINISH_REPLAY_CELL = 0.5
const ROUGH_CUTTER: CutterSpec = { kind: 'flat', diameter: 9.52 }
const FINISH_CUTTER: CutterSpec = { kind: 'ball', diameter: 6 }
const SUSTAINED_WINDOW_MM = 2

type EngagementDistribution = {
  moves: number
  positiveMoves: number
  meanMm2: number
  standardDeviationMm2: number
  p50Mm2: number
  p90Mm2: number
  p95Mm2: number
  maximumMm2: number
  worstSustainedMm2: number
  maxMoveToMoveSwingMm2: number
  p95MoveToMoveSwingMm2: number
}

type TerraceMask = {
  columns: Uint8Array
  changedColumns: number
  removedVolumeMm3: number
  maximumTopReductionMm: number
}

function roughInput(mesh: MeshHandle, intermediateStepdown?: boolean): AdaptiveRoughInput {
  return {
    mesh,
    cutter: ROUGH_CUTTER,
    stockBounds: STOCK,
    stockBoundsAreRealStock: true,
    cellSize: ROUGH_CELL,
    maxStepdown: 3,
    stepover: 0.4,
    millingDirection: 'climb',
    tolerance: 0.05,
    helixDiameter: 3,
    sideEntry: true,
    reachStockEdgeBy: ROUGH_CUTTER.diameter,
    materialTopZ: STOCK.maxZ,
    floorZ: SLAB_TOP_Z,
    heights: { clearanceZ: 44, retractZ: 34, feedZ: 34 },
    ...(intermediateStepdown !== undefined ? { intermediateStepdown } : {}),
  }
}

async function runRough(
  kernel: BvhKernel,
  mesh: MeshHandle,
  intermediateStepdown?: boolean,
): Promise<ToolpathIR> {
  return adaptiveRough(kernel, roughInput(mesh, intermediateStepdown))
}

function replayRough(rough: ToolpathIR): ZDexelField {
  const stock = ZDexelField.fromBox(STOCK, FINISH_REPLAY_CELL)
  replayMovesIntoStock(stock, ROUGH_CUTTER, rough.moves, null)
  return stock
}

function terraceMask(before: ZDexelField, after: ZDexelField): TerraceMask {
  expect(after.nx).toBe(before.nx)
  expect(after.ny).toBe(before.ny)
  expect(after.cell).toBe(before.cell)
  const columns = new Uint8Array(before.top.length)
  let changedColumns = 0
  let removedVolumeMm3 = 0
  let maximumTopReductionMm = 0
  for (let column = 0; column < columns.length; column++) {
    const reduction = before.top[column] - after.top[column]
    if (reduction <= 1e-9) continue
    columns[column] = 1
    changedColumns++
    removedVolumeMm3 += reduction * before.cell * before.cell
    maximumTopReductionMm = Math.max(maximumTopReductionMm, reduction)
  }
  return { columns, changedColumns, removedVolumeMm3, maximumTopReductionMm }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function distanceToSweepXY(
  x: number,
  y: number,
  sweep: { x0: number; y0: number; x1: number; y1: number },
): number {
  const dx = sweep.x1 - sweep.x0
  const dy = sweep.y1 - sweep.y0
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((x - sweep.x0) * dx + (y - sweep.y0) * dy) / lengthSquared))
    : 0
  return Math.hypot(x - (sweep.x0 + t * dx), y - (sweep.y0 + t * dy))
}

/**
 * Select finish motion whose cutter footprint crosses stock that the
 * intermediate pass actually lowered. The mask comes from published rough
 * replay at the finish measurement resolution, rather than an analytic dome.
 */
function crossesTerrace(
  field: ZDexelField,
  mask: Uint8Array,
  sweep: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  const radius = FINISH_CUTTER.diameter / 2
  const minI = Math.max(0, Math.floor((Math.min(sweep.x0, sweep.x1) - radius - field.originX) / field.cell))
  const maxI = Math.min(field.nx - 1, Math.floor((Math.max(sweep.x0, sweep.x1) + radius - field.originX) / field.cell))
  const minJ = Math.max(0, Math.floor((Math.min(sweep.y0, sweep.y1) - radius - field.originY) / field.cell))
  const maxJ = Math.min(field.ny - 1, Math.floor((Math.max(sweep.y0, sweep.y1) + radius - field.originY) / field.cell))
  for (let j = minJ; j <= maxJ; j++) {
    const y = field.originY + (j + 0.5) * field.cell
    for (let i = minI; i <= maxI; i++) {
      if (mask[field.colIndex(i, j)] === 0) continue
      const x = field.originX + (i + 0.5) * field.cell
      if (distanceToSweepXY(x, y, sweep) <= radius + field.cell / Math.SQRT2) return true
    }
  }
  return false
}

function worstSustained(runs: readonly (readonly { lengthMm: number; engagementMm2: number }[])[]): number {
  let worst = 0
  for (const run of runs) {
    for (let start = 0; start < run.length; start++) {
      let length = 0
      let volume = 0
      for (let end = start; end < run.length && length < SUSTAINED_WINDOW_MM; end++) {
        length += run[end].lengthMm
        volume += run[end].engagementMm2 * run[end].lengthMm
      }
      worst = Math.max(worst, volume / Math.max(length, SUSTAINED_WINDOW_MM))
    }
  }
  return worst
}

/**
 * Replay the identical geometry-driven finish into one rough result. Each
 * reading is fresh removed volume divided by 3D travel, in mm2. That direct
 * cross-section remains meaningful on continuously varying Z, where the
 * roughing helper's discrete axial-slab percentage does not.
 */
function engagementDistribution(
  moves: readonly IrMove[],
  startingStock: ZDexelField,
  mask: Uint8Array,
): EngagementDistribution {
  const field = startingStock.clone()
  const runs: Array<Array<{ lengthMm: number; engagementMm2: number }>> = []
  let run: Array<{ lengthMm: number; engagementMm2: number }> = []
  const finishRun = (): void => {
    if (run.length > 0) runs.push(run)
    run = []
  }

  let previous: { x: number; y: number; z: number } | undefined
  for (const move of moves) {
    let measuredLength = 0
    let freshVolumeMm3 = 0
    const measuredRole = move.role === 'cut'
    if (previous !== undefined) {
      const effectiveRole = effectiveMoveRole({
        type: move.t === 'rapid' ? 'rapid' : 'feed',
        role: move.role,
      })
      const sweep = {
        x0: previous.x,
        y0: previous.y,
        z0: previous.z,
        x1: move.x,
        y1: move.y,
        z1: move.z,
      }
      const length3d = Math.hypot(
        sweep.x1 - sweep.x0,
        sweep.y1 - sweep.y0,
        sweep.z1 - sweep.z0,
      )
      if (measuredRole && length3d > 1e-9 && crossesTerrace(startingStock, mask, sweep)) {
        measuredLength = length3d
        freshVolumeMm3 = engagementAt(field, sweep, FINISH_CUTTER) * length3d
      }
      if (isStockCuttingRole(effectiveRole)) removeSweep(field, sweep, FINISH_CUTTER)
    }
    if (measuredLength > 1e-9) {
      run.push({ lengthMm: measuredLength, engagementMm2: freshVolumeMm3 / measuredLength })
    } else {
      finishRun()
    }
    previous = { x: move.x, y: move.y, z: move.z }
  }
  finishRun()

  const values = runs.flat().map(sample => sample.engagementMm2)
  const swings = runs.flatMap(samples =>
    samples.slice(1).map((sample, index) => Math.abs(sample.engagementMm2 - samples[index].engagementMm2)),
  )
  const sorted = [...values].sort((a, b) => a - b)
  const sortedSwings = [...swings].sort((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
  const standardDeviation = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1),
  )
  return {
    moves: values.length,
    positiveMoves: values.filter(value => value > 1e-9).length,
    meanMm2: mean,
    standardDeviationMm2: standardDeviation,
    p50Mm2: percentile(sorted, 0.5),
    p90Mm2: percentile(sorted, 0.9),
    p95Mm2: percentile(sorted, 0.95),
    maximumMm2: sorted.at(-1) ?? 0,
    worstSustainedMm2: worstSustained(runs),
    maxMoveToMoveSwingMm2: sortedSwings.at(-1) ?? 0,
    p95MoveToMoveSwingMm2: percentile(sortedSwings, 0.95),
  }
}

describe('WO-1367 finish engagement after intermediate stepdown', () => {
  beforeAll(async () => {
    await ensureGeom2dReady()
    await ensureEngineClipperReady()
  })

  it('measures parallel-finish engagement on the changed dome terraces', { timeout: 600_000 }, async () => {
    const kernel = new BvhKernel()
    const partMesh = hemisphereOnSlab(RADIUS, { x: 40, y: 40, t: SLAB_TOP_Z })
    const mesh = kernel.uploadMesh(partMesh)
    try {
      const legacyUndefined = await runRough(kernel, mesh)
      const disabled = await runRough(kernel, mesh, false)
      const enabled = await runRough(kernel, mesh, true)
      expect(irFingerprint(legacyUndefined)).toBe(irFingerprint(disabled))
      expect(JSON.stringify(legacyUndefined)).toBe(JSON.stringify(disabled))

      const finishInput = {
        mesh,
        cutter: FINISH_CUTTER,
        stepover: 1,
        angleDeg: 0,
        tolerance: 0.05,
        xyBounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
        heights: { clearanceZ: 30, retractZ: 24, feedZ: 24 },
        zSeed: STOCK.minZ - 1,
      }
      const finishBefore = await parallelFinish(kernel, finishInput)
      const finishAfter = await parallelFinish(kernel, finishInput)
      // Parallel Finish publishes a dense 3D polyline, so each emitted move
      // can be measured as its own linear sweep without further subdivision.
      expect(finishBefore.moves.every(move => move.t !== 'arc')).toBe(true)
      expect(irFingerprint(finishAfter)).toBe(irFingerprint(finishBefore))
      expect(JSON.stringify(finishAfter.moves)).toBe(JSON.stringify(finishBefore.moves))

      const stockBefore = replayRough(disabled)
      const stockAfter = replayRough(enabled)
      const terraces = terraceMask(stockBefore, stockAfter)
      const before = engagementDistribution(finishBefore.moves, stockBefore, terraces.columns)
      const after = engagementDistribution(finishAfter.moves, stockAfter, terraces.columns)
      const evidence = {
        fixture: {
          domeRadiusMm: RADIUS,
          slabTopZ: SLAB_TOP_Z,
          stock: STOCK,
          roughCutter: ROUGH_CUTTER,
          roughPlanningCellMm: ROUGH_CELL,
          finishCutter: FINISH_CUTTER,
          finishStepoverMm: finishInput.stepover,
          finishReplayCellMm: FINISH_REPLAY_CELL,
          sustainedWindowMm: SUSTAINED_WINDOW_MM,
          engagementUnit: 'mm2 fresh removed cross-section per mm of 3D travel',
          region: 'finish cutter footprint crosses a replay column lowered by the intermediate pass',
        },
        toggle: {
          disabledFingerprint: irFingerprint(disabled),
          enabledFingerprint: irFingerprint(enabled),
          insertedIntermediateLevels: enabled.meta.params?.intermediateLevelCount,
        },
        identicalFinishPath: {
          asserted: true,
          fingerprintBefore: irFingerprint(finishBefore),
          fingerprintAfter: irFingerprint(finishAfter),
          movesBefore: finishBefore.moves.length,
          movesAfter: finishAfter.moves.length,
        },
        terracedRegion: {
          changedColumns: terraces.changedColumns,
          removedVolumeMm3: terraces.removedVolumeMm3,
          maximumTopReductionMm: terraces.maximumTopReductionMm,
        },
        engagement: { before, after },
      }
      console.log(`WO-1367 EVIDENCE ${JSON.stringify(evidence)}`)

      expect(enabled.meta.params?.intermediateStepdown).toBe(true)
      expect(enabled.meta.params?.intermediateLevelCount).toBeGreaterThan(0)
      expect(terraces.changedColumns).toBeGreaterThan(0)
      expect(terraces.removedVolumeMm3).toBeGreaterThan(0)
      expect(before.moves).toBeGreaterThan(0)
      expect(after.moves).toBe(before.moves)
      expect(before.positiveMoves).toBeGreaterThan(0)
      expect(after.positiveMoves).toBeGreaterThan(0)
      expect(before.worstSustainedMm2).toBeGreaterThan(0)
      expect(after.worstSustainedMm2).toBeGreaterThan(0)
    } finally {
      kernel.releaseMesh(mesh)
    }
  })
})
