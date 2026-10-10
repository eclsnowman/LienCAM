import { beforeAll, describe, expect, it } from 'vitest'

import { hemisphereOnSlab } from '../../cam3d/fixtures'
import { ensureGeom2dReady } from '../../cam3d/geom2d'
import { irFingerprint, type ToolpathIR } from '../../cam3d/ir/types'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { CutterSpec } from '../../cam3d/kernel/types'
import { buildPartHeightField, frameOf, planLevels } from '../../cam3d/rough'
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry'
import { forEachLinearSweep, replayMovesIntoStock } from '../../cam3d/rough/replayStock'
import { adaptiveRough } from '../../cam3d/strategies/adaptiveRough'
import { parallelFinish } from '../../cam3d/strategies/parallel'
import { ZDexelField, type Box3 } from '../../cam3d/stock'

const RADIUS = 12
const SLAB_TOP_Z = 10
const STOCK: Box3 = { minX: -5, minY: -5, minZ: 0, maxX: 45, maxY: 45, maxZ: 29 }
const CELL = 9.52 / 12
const ROUGH_CUTTER: CutterSpec = { kind: 'flat', diameter: 9.52 }
const MAX_STEPDOWN = 3
const STEPOVER_FRACTION = 0.4
const CUT_FEED_MM_MIN = 1500
const PLUNGE_FEED_MM_MIN = 500

type BandReading = {
  upperZ: number
  lowerZ: number
  intermediateZ: number
  wedgeVolumeMm3: number
  removableVolumeMm3: number
  maxDeviationBeforeMm: number
  maxDeviationAfterMm: number
  coveragePathLowerBoundMm: number
  radialEngagementPct: number
  chipThicknessPct: number
  feedMultiplierForChipLoad: number
}

function cuttingTimeSeconds(ir: ToolpathIR): number {
  let previous: { x: number; y: number; z: number } | undefined
  let seconds = 0
  for (const move of ir.moves) {
    if (previous !== undefined && move.t !== 'rapid') {
      const feed = move.role === 'plunge' || move.role === 'ramp'
        ? PLUNGE_FEED_MM_MIN
        : CUT_FEED_MM_MIN
      forEachLinearSweep(previous, move, CELL / 4, sweep => {
        seconds += Math.hypot(
          sweep.x1 - sweep.x0,
          sweep.y1 - sweep.y0,
          sweep.z1 - sweep.z0,
        ) / feed * 60
      })
    }
    previous = { x: move.x, y: move.y, z: move.z }
  }
  return seconds
}

function radialEngagementAt(upperZ: number, intermediateZ: number): number {
  const radiusAt = (z: number): number => {
    const h = z - SLAB_TOP_Z
    if (h >= RADIUS) return 0
    if (h <= 0) return RADIUS
    return Math.sqrt(RADIUS * RADIUS - h * h)
  }
  return Math.max(0, radiusAt(intermediateZ) - radiusAt(upperZ))
}

function domeRadiusAt(z: number): number {
  const h = z - SLAB_TOP_Z
  if (h >= RADIUS) return 0
  if (h <= 0) return RADIUS
  return Math.sqrt(RADIUS * RADIUS - h * h)
}

function chipReading(radialEngagement: number): { chipPct: number; feedMultiplier: number } {
  const fraction = Math.min(1, radialEngagement / ROUGH_CUTTER.diameter)
  if (fraction >= 0.5) return { chipPct: 100, feedMultiplier: 1 }
  const chipPct = Math.sqrt(Math.max(0, 1 - (1 - 2 * fraction) ** 2)) * 100
  return { chipPct, feedMultiplier: chipPct > 0 ? 100 / chipPct : Number.POSITIVE_INFINITY }
}

function measureBands(
  finalStock: ZDexelField,
  part: ZDexelField,
  levels: readonly number[],
): BandReading[] {
  const readings: BandReading[] = []
  const cellArea = finalStock.cell * finalStock.cell
  const coverageWidth = ROUGH_CUTTER.diameter * STEPOVER_FRACTION

  for (let i = 0; i + 1 < levels.length; i++) {
    const upperZ = levels[i]
    const lowerZ = levels[i + 1]
    const intermediateZ = (upperZ + lowerZ) / 2
    // Above the dome apex there is no retained part section. Inserting a pass
    // there makes a full-area level, the exact behavior the WO forbids.
    if (intermediateZ >= SLAB_TOP_Z + RADIUS) continue
    let wedgeVolumeMm3 = 0
    let removableVolumeMm3 = 0
    let maxDeviationBeforeMm = 0
    let maxDeviationAfterMm = 0
    let removableAreaMm2 = 0

    for (let c = 0; c < finalStock.top.length; c++) {
      const targetZ = part.top[c]
      if (!(targetZ > lowerZ && targetZ <= upperZ)) continue
      const before = Math.max(0, finalStock.top[c] - targetZ)
      const afterTop = targetZ <= intermediateZ
        ? Math.min(finalStock.top[c], intermediateZ)
        : finalStock.top[c]
      const after = Math.max(0, afterTop - targetZ)
      wedgeVolumeMm3 += before * cellArea
      removableVolumeMm3 += Math.max(0, finalStock.top[c] - afterTop) * cellArea
      if (afterTop < finalStock.top[c] - 1e-9) removableAreaMm2 += cellArea
      maxDeviationBeforeMm = Math.max(maxDeviationBeforeMm, before)
      maxDeviationAfterMm = Math.max(maxDeviationAfterMm, after)
    }

    if (wedgeVolumeMm3 <= 1e-9) continue
    const radialEngagement = radialEngagementAt(upperZ, intermediateZ)
    const chip = chipReading(radialEngagement)
    readings.push({
      upperZ,
      lowerZ,
      intermediateZ,
      wedgeVolumeMm3,
      removableVolumeMm3,
      maxDeviationBeforeMm,
      maxDeviationAfterMm,
      // A legal pass must at least make one circuit around the retained dome.
      // Area / commanded stepover can be larger for a wide wedge. Both omit
      // entries, links, cleanup laps, acceleration and rapid travel.
      coveragePathLowerBoundMm: Math.max(
        removableAreaMm2 / coverageWidth,
        2 * Math.PI * (domeRadiusAt(intermediateZ) + ROUGH_CUTTER.diameter / 2),
      ),
      radialEngagementPct: radialEngagement / ROUGH_CUTTER.diameter * 100,
      chipThicknessPct: chip.chipPct,
      feedMultiplierForChipLoad: chip.feedMultiplier,
    })
  }
  return readings
}

describe('WO-1361 intermediate-stepdown spike', () => {
  beforeAll(async () => {
    await ensureGeom2dReady()
    await ensureEngineClipperReady()
  })

  it('measures the dome wedges and rejects a feature that can only add total time', { timeout: 180_000 }, async () => {
    const kernel = new BvhKernel()
    const partMesh = hemisphereOnSlab(RADIUS, { x: 40, y: 40, t: SLAB_TOP_Z })
    const mesh = kernel.uploadMesh(partMesh)
    try {
      const rough = await adaptiveRough(kernel, {
        mesh,
        cutter: ROUGH_CUTTER,
        stockBounds: STOCK,
        stockBoundsAreRealStock: true,
        cellSize: CELL,
        maxStepdown: MAX_STEPDOWN,
        stepover: STEPOVER_FRACTION,
        // WO-1896: the material-left stream this spike was measured on, which the rule
        // now names conventional (climb keeps material on the cutter's right).
        millingDirection: 'conventional',
        tolerance: 0.05,
        helixDiameter: 3,
        sideEntry: true,
        reachStockEdgeBy: ROUGH_CUTTER.diameter,
        materialTopZ: STOCK.maxZ,
        floorZ: SLAB_TOP_Z,
        heights: { clearanceZ: 44, retractZ: 34, feedZ: 34 },
      })

      const finalStock = ZDexelField.fromBox(STOCK, CELL)
      replayMovesIntoStock(finalStock, ROUGH_CUTTER, rough.moves, null)
      const part = await buildPartHeightField(kernel, mesh, frameOf(finalStock), {
        zSeed: STOCK.minZ - 1,
      })
      const levels = planLevels(STOCK.maxZ, SLAB_TOP_Z, MAX_STEPDOWN)
      const bands = measureBands(finalStock, part, levels)
      const wedgeVolumeMm3 = bands.reduce((sum, band) => sum + band.wedgeVolumeMm3, 0)
      const removableVolumeMm3 = bands.reduce((sum, band) => sum + band.removableVolumeMm3, 0)
      const maxDeviationBeforeMm = Math.max(...bands.map(band => band.maxDeviationBeforeMm))
      const maxDeviationAfterMm = Math.max(...bands.map(band => band.maxDeviationAfterMm))
      const addedCoveragePathMm = bands.reduce((sum, band) => sum + band.coveragePathLowerBoundMm, 0)
      const addedCutTimeLowerBoundSec = addedCoveragePathMm / CUT_FEED_MM_MIN * 60

      const finishInput = {
        mesh,
        cutter: { kind: 'ball', diameter: 6 } as const,
        stepover: 1,
        angleDeg: 0,
        tolerance: 0.05,
        xyBounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
        heights: { clearanceZ: 30, retractZ: 24, feedZ: 24 },
        zSeed: STOCK.minZ - 1,
      }
      const finishBefore = await parallelFinish(kernel, finishInput)
      // Parallel finishing has no stock input. The proposed carve therefore
      // cannot shorten its production path; this second run is the measured
      // after case for the same part, cutter and finish settings.
      const finishAfter = await parallelFinish(kernel, finishInput)
      const finishTimeBeforeSec = cuttingTimeSeconds(finishBefore)
      const finishTimeAfterSec = cuttingTimeSeconds(finishAfter)
      const finishTimeSavedSec = finishTimeBeforeSec - finishTimeAfterSec

      const evidence = {
        fixture: { radiusMm: RADIUS, slabTopZ: SLAB_TOP_Z, stock: STOCK },
        rough: {
          cutterDiameterMm: ROUGH_CUTTER.diameter,
          maxStepdownMm: MAX_STEPDOWN,
          stepoverFraction: STEPOVER_FRACTION,
          levels,
          productionMoves: rough.moves.length,
          cuttingTimeSec: cuttingTimeSeconds(rough),
        },
        midpointRule: 'halfway between consecutive full levels; only target-at-or-below-midpoint cells',
        bands,
        totals: {
          wedgeVolumeMm3,
          removableVolumeMm3,
          maxDeviationBeforeMm,
          maxDeviationAfterMm,
          addedCoveragePathMm,
          addedCutTimeLowerBoundSec,
          finishMoves: finishBefore.moves.length,
          finishTimeBeforeSec,
          finishTimeAfterSec,
          finishTimeSavedSec,
          totalTimeChangeLowerBoundSec: addedCutTimeLowerBoundSec - finishTimeSavedSec,
          totalTimeIncreaseLowerBoundPct:
            addedCutTimeLowerBoundSec / (cuttingTimeSeconds(rough) + finishTimeBeforeSec) * 100,
        },
      }
      console.log(`WO-1361 SPIKE ${JSON.stringify(evidence)}`)

      expect(bands.length).toBeGreaterThan(0)
      expect(removableVolumeMm3).toBeGreaterThan(150)
      expect(maxDeviationBeforeMm).toBeGreaterThan(2.5)
      expect(maxDeviationAfterMm).toBeLessThan(1.5)
      expect(irFingerprint(finishAfter)).toBe(irFingerprint(finishBefore))
      expect(finishTimeSavedSec).toBe(0)
      expect(addedCutTimeLowerBoundSec).toBeGreaterThan(0)
    } finally {
      kernel.releaseMesh(mesh)
    }
  })
})
