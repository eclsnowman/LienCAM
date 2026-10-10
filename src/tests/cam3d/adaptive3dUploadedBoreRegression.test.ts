import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { ensureGeom2dReady, netArea } from '../../cam3d/geom2d'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../cam3d/kernel/types'
import { ensureEngineClipperReady, processFeature } from '../../cam3d/rough/engineEntry'
import {
  buildPartHeightField,
  cutRegionAt,
  decomposeToComponents,
  featureFromComponent,
  frameOf,
} from '../../cam3d/rough'
import { remainingAbove, ZDexelField } from '../../cam3d/stock'
import { adaptiveRough } from '../../cam3d/strategies/adaptiveRough'
import { buildSideEntrySeed } from '../../cam3d/rough/sideSeed'
import { irToToolpathMoves } from '../../cam3d/ir/toToolpathMoves'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import type { OperationDiagnostics } from '../../types'
import type { Cam3dProgressDetail } from '../../cam3d/progress'

const FIXTURE = 'src/tests/fixtures/adaptive3d-uploaded-bore.json'
const STOCK_BOUNDS = {
  minX: -48.809749603271484,
  minY: -24.470998764038086,
  minZ: 0,
  maxX: 48.809749603271484,
  maxY: 24.470998764038086,
  maxZ: 35,
}
const TOOL_DIAMETER = 9.52
const BORE_CENTER = { x: -24.8950636886, y: 0 }
const BORE_RADIUS = 7.5

function pointSegmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq))
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

describe('uploaded Adaptive 3D bore diagnostic', () => {
  beforeAll(async () => {
    await ensureGeom2dReady()
    await ensureEngineClipperReady()
  })

  it('fully clears the future bore landing disk at the deck level', async () => {
    const display = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const mesh: PartMesh = {
      positions: Float32Array.from(display.positions),
      indices: Uint32Array.from(display.indices),
      bounds: display.bounds,
      source: 'fixture',
    }
    const toolRadius = TOOL_DIAMETER / 2
    const cell = TOOL_DIAMETER / 12
    const kernel = new BvhKernel()
    const handle = kernel.uploadMesh(mesh)
    let carvedStock: ZDexelField | undefined
    let diagnostics: OperationDiagnostics | undefined
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    try {
      const ir = await adaptiveRough(kernel, {
        mesh: handle,
        cutter: { kind: 'flat', diameter: TOOL_DIAMETER },
        stockBounds: STOCK_BOUNDS,
        cellSize: cell,
        maxStepdown: 3,
        stepover: 0.4,
        millingDirection: 'climb',
        spindleRotation: 'cw',
        tolerance: 0.05,
        helixDiameter: 3,
        helixAngleDeg: 5,
        floorZ: 15.5,
        radialStockToLeave: 0.25,
        axialStockToLeave: 0.5,
        reachStockEdgeBy: toolRadius * 2,
        sideEntry: true,
        heights: { clearanceZ: 50, retractZ: 40, feedZ: 40 },
        materialTopZ: 35,
        stockBoundsAreRealStock: true,
      }, {
        onCarvedStock: (value) => { carvedStock = value },
        onDiagnostics: (value) => { diagnostics = value },
      })

      // The op's own final lift to clearance (its last move) is not a return
      // BETWEEN stepdowns, so it is left out of this check.
      const fullClearanceReturns = ir.moves.slice(1, -1).flatMap((move, index) => {
        const previous = ir.moves[index]
        if (move.role !== 'rapid' || move.z < 50 - 1e-6 || previous.z >= 50 - 1e-6) return []
        return [{ index: index + 1, from: previous, to: move }]
      })
      expect(
        fullClearanceReturns,
        'a stock-proven depth branch must not return to full clearance between stepdowns',
      ).toEqual([])
      expect(ir.meta.params?.traverseRerouted).toBe(0)

      expect(carvedStock).toBeDefined()
      expect(diagnostics?.adaptiveRough?.skippedRegions).toBe(0)
      const standing: Array<{ x: number; y: number; top: number }> = []
      for (let j = 0; j < carvedStock!.ny; j++) {
        for (let i = 0; i < carvedStock!.nx; i++) {
          const x = carvedStock!.originX + (i + 0.5) * carvedStock!.cell
          const y = carvedStock!.originY + (j + 0.5) * carvedStock!.cell
          if (Math.hypot(x - BORE_CENTER.x, y - BORE_CENTER.y) > toolRadius) continue
          const top = carvedStock!.top[j * carvedStock!.nx + i]
          if (top > 15.5 + 1e-3) {
            standing.push({ x, y, top })
          }
        }
      }
      expect(standing, `deck cleanup left stock in the future bore landing disk: ${JSON.stringify(standing)}`)
        .toEqual([])

      // The original failure left this exact full-height cell standing. Its
      // cleanup must come from a same-level lateral cut, not a new vertical
      // helix/plunge onto the residual island.
      const formerSpire = { x: -21.4397496033, y: 2.899001236 }
      const sampled = sampleArcMovesForLinearConsumers(
        irToToolpathMoves(ir),
        { maxChordMm: 0.05, maxAngleDeg: 1 },
      )
      const cleanupSegment = sampled.slice(1).map((move, index) => ({
        previous: sampled[index],
        move,
      })).find(({ previous, move }) =>
        Math.abs(previous.z - 15.5) <= 1e-6
        && Math.abs(move.z - 15.5) <= 1e-6
        && pointSegmentDistance(formerSpire, previous, move) <= toolRadius,
      )
      expect(cleanupSegment, 'former spire must be removed by an at-depth lateral segment')
        .toBeDefined()
      expect(['ramp', 'plunge']).not.toContain(cleanupSegment!.move.role)

      // Repositions beside the right-hand boss previously opened two new helixes even though
      // prior cutter motion had already established vertical shafts nearby. WO-1178 re-pin:
      // there is no reposition beside the boss any more -- the pass rides the boss wall and
      // the walker plants its next start ahead of the stock, so nothing lifts there. What is
      // still pinned: no helix is ever drilled beside the boss, and any lead that does land
      // there descends on a proven shaft at the same Z (the loop below), never on a ramp.
      const bossHelixWarnings = warnings.filter((message) => {
        const match = message.match(/descending via HELIX at \(([-\d.]+), ([-\d.]+)\)/)
        if (!match) return false
        const x = Number(match[1])
        const y = Number(match[2])
        return x >= 8 && x <= 16 && y >= -13 && y <= -8
      })
      expect(bossHelixWarnings).toEqual([])
      const localLeadStarts = ir.moves.slice(1).flatMap((move, index) => {
        const previous = ir.moves[index]
        if (move.role !== 'lead_in' || previous.role === 'lead_in') return []
        if (move.x < 8 || move.x > 16 || move.y < -13 || move.y > -8) return []
        if (Math.abs(previous.z - move.z) > 1e-6) return []
        if (previous.role !== 'rapid' && previous.role !== 'plunge') return []
        return [{ previous, move }]
      })
      expect(localLeadStarts.length).toBeGreaterThanOrEqual(0)
      for (const { previous, move } of localLeadStarts) {
        expect(Math.abs(previous.z - move.z)).toBeLessThanOrEqual(1e-6)
        expect(['rapid', 'plunge']).toContain(previous.role)
      }
      expect(ir.moves.filter((move) =>
        move.role === 'ramp'
        && move.x >= 8 && move.x <= 16
        && move.y >= -13 && move.y <= -8,
      )).toEqual([])
    } finally {
      warn.mockRestore()
      kernel.releaseMesh(handle)
    }
  }, 120_000)

  it('clears the cutter-accessible through-bore without entering the retained model', async () => {
    // Reduced from the user's failing .camproject: exact selected model-body
    // triangles and bounds, with project stock/tool dimensions pinned above.
    const display = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const mesh: PartMesh = {
      positions: Float32Array.from(display.positions),
      indices: Uint32Array.from(display.indices),
      bounds: display.bounds,
      source: 'fixture',
    }
    const toolRadius = TOOL_DIAMETER / 2
    const cell = TOOL_DIAMETER / 12
    const stock = ZDexelField.fromBox(STOCK_BOUNDS, cell)
    const kernel = new BvhKernel()
    const handle = kernel.uploadMesh(mesh)
    try {
      const part = await buildPartHeightField(kernel, handle, frameOf(stock), { zSeed: -1 })
      const region = await cutRegionAt(stock, part, 14, { reachStockEdgeBy: toolRadius })
      const components = decomposeToComponents(region)
      const sideSeed = buildSideEntrySeed(remainingAbove(stock, 14), toolRadius)
      const componentResults = components.map((component) => processFeature(
        featureFromComponent(component),
        {
          toolRadius,
          stepOver: 0.4,
          tolerance: 0.05,
          helixDiameter: 3,
          stockToLeave: 0,
          arcTol: 0.0125,
          millingDirection: 'climb',
          clearedSeed: sideSeed,
          integralWallFollow: true,
          integralWallFollowLengthFactor: 2,
          landingUncutCap: 0.08,
          skipOuterBoundaryCleanup: component.holes.length > 0,
        },
      ))
      for (const [componentIndex, componentResult] of componentResults.entries()) {
        if (componentResult.passes.length === 0) continue
        expect(
          componentResult.passes[0]?.type === 'entry'
            || (componentResult.passes[0]?.type === 'link'
              && componentResult.passes[1]?.type === 'entry'),
          `uploaded full-clear component ${componentIndex} must own its safe approach`,
        ).toBe(true)
      }
      const bore = components.find((component) => {
        const xs = Array.from(component.boundary).filter((_, index) => index % 2 === 0)
        const ys = Array.from(component.boundary).filter((_, index) => index % 2 === 1)
        return Math.min(...xs) < BORE_CENTER.x && Math.max(...xs) > BORE_CENTER.x
          && Math.min(...ys) < BORE_CENTER.y && Math.max(...ys) > BORE_CENTER.y
          && netArea([component.boundary, ...component.holes]) < 300
      })
      expect(bore, 'uploaded through-bore must survive stock-minus-part classification').toBeDefined()

      const result = processFeature(featureFromComponent(bore!), {
        toolRadius,
        stepOver: 0.4,
        tolerance: 0.05,
        helixDiameter: 3,
        stockToLeave: 0,
        arcTol: 0.0125,
      })

      expect(result.stats.aborted).toBeUndefined()
      expect(result.entries.length).toBeGreaterThan(0)
      expect(result.passes.some((pass) => pass.type === 'cut')).toBe(true)
      expect(
        result.passes[0]?.type === 'entry'
          || (result.passes[0]?.type === 'link' && result.passes[1]?.type === 'entry'),
        'every nonempty component pass block must own its safe approach',
      ).toBe(true)

      const boundaryValues = Array.from(bore!.boundary)
      const boundaryPoints = Array.from({ length: boundaryValues.length / 2 }, (_, index) => ({
        x: boundaryValues[index * 2],
        y: boundaryValues[index * 2 + 1],
      }))

      const warnings: string[] = []
      let diagnostics: OperationDiagnostics | undefined
      let carvedStock: ZDexelField | undefined
      const progress: Array<{ fraction: number; detail?: Cam3dProgressDetail }> = []
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      })
      let ir: Awaited<ReturnType<typeof adaptiveRough>>
      try {
        ir = await adaptiveRough(kernel, {
          mesh: handle,
          cutter: { kind: 'flat', diameter: TOOL_DIAMETER },
          stockBounds: STOCK_BOUNDS,
          cellSize: cell,
          maxStepdown: 3,
          stepover: 0.4,
          millingDirection: 'climb',
          tolerance: 0.05,
          helixDiameter: 3,
          helixAngleDeg: 10,
          // One exact 3D level is sufficient here: multi-level rest/feed-height
          // behavior is covered by its own focused regressions.
          floorZ: 32,
          radialStockToLeave: 0,
          axialStockToLeave: 0,
          reachStockEdgeBy: toolRadius,
          sideEntry: true,
          heights: { clearanceZ: 45, retractZ: 40, feedZ: 35.5 },
          materialTopZ: 35,
          stockBoundsAreRealStock: true,
        }, {
          onProgress: (fraction, detail) => { progress.push({ fraction, detail }) },
          onDiagnostics: (value) => { diagnostics = value },
          onCarvedStock: (value) => { carvedStock = value },
        })
      } finally {
        warn.mockRestore()
      }
      expect(warnings.some((message) => message.includes('UNSAFE'))).toBe(false)
      expect(progress.length).toBeGreaterThan(5)
      expect(progress.at(-1)?.fraction).toBe(1)
      expect(progress.every((item, index) =>
        index === 0 || item.fraction >= progress[index - 1].fraction)).toBe(true)
      expect(Array.from(new Set(progress.flatMap((item) => item.detail?.phase ?? [])))).toEqual(
        expect.arrayContaining([
          'Sampling model surface',
          'Planning adaptive toolpath',
          'Validating retained-model clearance',
          'Complete',
        ]),
      )
      expect(progress.at(-1)?.detail?.longestPhase).toBeDefined()
      expect(progress.flatMap((item) => item.detail?.phase ?? [])).not.toContain(
        'Refining retained-model safety',
      )
      expect(progress.at(-1)?.detail?.attempt).toBe(1)
      expect(diagnostics?.adaptiveRough).toMatchObject({
        plannedRegions: 1,
        machinedRegions: 1,
        skippedRegions: 0,
        partialRegions: 0,
      })

      expect(ir.moves.some((move) =>
        move.role === 'cut'
        && Math.hypot(move.x - BORE_CENTER.x, move.y - BORE_CENTER.y) <= BORE_RADIUS - toolRadius + 0.05
        && Math.abs(move.z - 32) <= 1e-6)).toBe(true)
      const sampledMoves = sampleArcMovesForLinearConsumers(
        irToToolpathMoves(ir),
        { maxChordMm: 0.05, maxAngleDeg: 1 },
      )
      const boreCutSegments = sampledMoves.slice(1).flatMap((move, index) => {
        const previous = sampledMoves[index]
        if (!(['cut', 'finish'] as const).includes(move.role as 'cut' | 'finish')
          || Math.abs(previous.z - 32) > 1e-6
          || Math.abs(move.z - 32) > 1e-6
          || Math.hypot(move.x - BORE_CENTER.x, move.y - BORE_CENTER.y) > BORE_RADIUS + toolRadius) return []
        return [[previous, move] as const]
      })
      const boundaryClearances = boundaryPoints.map((point) => {
        let closest = { clearance: Number.POSITIVE_INFINITY, segment: boreCutSegments[0] }
        for (const segment of boreCutSegments) {
          const clearance = pointSegmentDistance(point, segment[0], segment[1])
          if (clearance < closest.clearance) closest = { clearance, segment }
        }
        return { point, ...closest }
      })
      const wallContactCellSize = Number(ir.meta.params?.wallContactCellSize)
      expect(Math.max(...boundaryClearances.map(({ clearance }) => clearance)),
        'zero radial allowance must clean the complete bore wall',
      ).toBeLessThanOrEqual(toolRadius + wallContactCellSize + 0.05)
      expect(Number(ir.meta.params?.smoothingArcCount)).toBeGreaterThan(0)
      expect(wallContactCellSize).toBeLessThan(cell / 2)
      // With no authored wall leads, the adaptive planner owns the final wall
      // band. The clearance samples above prove that band is cut while the
      // retained-model assertions below prove it is not crossed.
      expect(Number(ir.meta.params?.wallCleanupContours)).toBe(0)
      expect(ir.meta.params?.millingDirection).toBe('climb')
      expect(ir.meta.params?.outsideEntry).toBe(true)
      expect(Number(ir.meta.params?.outsideEntryCount)).toBeGreaterThan(0)

      // Clear All Stock is an open external region. It must side-enter and
      // adaptively consume the stock ring on every side; an interior helix in
      // that ring is wasted air motion and recreates the one-side-only failure.
      const outerBounds = display.bounds as { min: number[]; max: number[] }
      const externalCut = ir.moves.filter((move) =>
        move.role === 'cut'
        && Math.abs(move.z - 32) <= 1e-6
        && (move.x < outerBounds.min[0] || move.x > outerBounds.max[0]
          || move.y < outerBounds.min[1] || move.y > outerBounds.max[1]))
      expect(externalCut.some((move) => move.x < outerBounds.min[0]), 'left stock must be cleared').toBe(true)
      expect(externalCut.some((move) => move.x > outerBounds.max[0]), 'right stock must be cleared').toBe(true)
      expect(externalCut.some((move) => move.y < outerBounds.min[1]), 'bottom stock must be cleared').toBe(true)
      expect(externalCut.some((move) => move.y > outerBounds.max[1]), 'top stock must be cleared').toBe(true)
      expect(ir.moves.some((move) =>
        move.role === 'ramp'
        && (move.x < outerBounds.min[0] || move.x > outerBounds.max[0]
          || move.y < outerBounds.min[1] || move.y > outerBounds.max[1])),
      'external stock cleanup must not helix').toBe(false)
      // A top-height carved-stock comparison cannot detect a lateral nick in
      // a retained vertical wall. Independently drop the real cutter against
      // the exact selected mesh at every commanded endpoint. Any commanded Z
      // below the kernel's non-gouging Z is a real cutter/model intersection,
      // regardless of what the stock-removal renderer displays.
      const cutterHandle = kernel.makeCutter({ kind: 'flat', diameter: TOOL_DIAMETER })
      try {
        const xy = Float64Array.from(sampledMoves.flatMap((move) => [move.x, move.y]))
        const safeTipZ = await kernel.dropPoints(handle, cutterHandle, xy, -1)
        let worst = { index: -1, clearance: Number.POSITIVE_INFINITY, safeZ: 0 }
        for (let index = 0; index < sampledMoves.length; index++) {
          const clearance = sampledMoves[index].z - safeTipZ[index]
          if (clearance < worst.clearance) {
            worst = { index, clearance, safeZ: safeTipZ[index] }
          }
        }
        expect(worst.clearance, `worst cutter/model clearance: ${JSON.stringify({
          ...worst,
          move: sampledMoves[worst.index],
        })}`).toBeGreaterThanOrEqual(-1e-4)
      } finally {
        kernel.releaseCutter(cutterHandle)
      }

      expect(carvedStock).toBeDefined()
      let maxGouge = Number.NEGATIVE_INFINITY
      for (let column = 0; column < part.top.length; column++) {
        maxGouge = Math.max(maxGouge, part.top[column] - carvedStock!.top[column])
      }
      expect(maxGouge).toBeLessThanOrEqual(0.05)
    } finally {
      kernel.releaseMesh(handle)
    }
  }, 120_000)
})
