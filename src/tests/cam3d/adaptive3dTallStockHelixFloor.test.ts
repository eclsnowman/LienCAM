import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

import { ensureGeom2dReady } from '../../cam3d/geom2d'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../cam3d/kernel/types'
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry'
import { ZDexelField } from '../../cam3d/stock'
import { adaptiveRough } from '../../cam3d/strategies/adaptiveRough'
import { irToToolpathMoves } from '../../cam3d/ir/toToolpathMoves'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'

// Reduced from Operator's uploaded `Untitled_Project (38).camproject`: the exact
// selected model body plus the project's stock box, tool, heights and Adaptive
// parameters. The one thing that separates it from the earlier uploaded-bore
// fixture is that the stock stands 5 mm PROUD of the part (Z 0..40 over a
// 0..35 part), which pushes the ladder onto a Z=12 level whose bore entry is a
// short interior helix.
//
// That job used to die with
//   "emitLevelPasses: refusing a straight plunge through remaining stock at
//    (-24.896, 0.008) from 12.813 to 12.000"
// The refused XY was the entry helix's own centre. The 2D planner has no Z: it
// credits a helix with the full disk it opens (radius helixR + toolRadius) and
// then offers points inside that disk -- the centre included -- as proven-clear
// descent shafts. A descending helix only reaches the level floor at ONE
// angular point, so the disk was still a spiral ramp standing up to one turn's
// depth proud, and the live stock replay rightly refused the descent.
//
// Every helix now finishes with one full turn at the level floor, which makes
// the planner's flat-disk model physically true.
const FIXTURE = 'src/tests/fixtures/adaptive3d-uploaded-tall-stock.json'
const STOCK_BOUNDS = {
  minX: -48.80974894918,
  minY: -24.470999512980004,
  minZ: 0,
  maxX: 48.809748949188,
  maxY: 24.470999512982004,
  maxZ: 40,
}
const TOOL_DIAMETER = 9.52
const TOOL_RADIUS = TOOL_DIAMETER / 2
const CELL = TOOL_DIAMETER / 12
const BORE_CENTER = { x: -24.8950636886, y: 0 }

function loadMesh(): PartMesh {
  const display = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  return {
    positions: Float32Array.from(display.positions),
    indices: Uint32Array.from(display.indices),
    bounds: display.bounds,
    source: 'fixture',
  }
}

describe('uploaded Adaptive 3D job whose stock stands proud of the part', () => {
  beforeAll(async () => {
    await ensureGeom2dReady()
    await ensureEngineClipperReady()
  })

  it('completes, and leaves no helix ramp standing above any level floor', async () => {
    const mesh = loadMesh()
    const kernel = new BvhKernel()
    const handle = kernel.uploadMesh(mesh)
    let carvedStock: ZDexelField | undefined
    try {
      const ir = await adaptiveRough(kernel, {
        mesh: handle,
        cutter: { kind: 'flat', diameter: TOOL_DIAMETER },
        stockBounds: STOCK_BOUNDS,
        cellSize: CELL,
        maxStepdown: 3,
        stepover: 0.4,
        millingDirection: 'climb',
        spindleRotation: 'cw',
        wallLeadInRadius: 0,
        wallLeadOutRadius: 0,
        loopbackFilletPct: 25,
        integralWallFollow: true,
        integralWallFollowLengthFactor: 2,
        tolerance: 0.05,
        helixDiameter: 3,
        helixAngleDeg: 10,
        radialStockToLeave: 0,
        axialStockToLeave: 0,
        floorZ: 0,
        reachStockEdgeBy: TOOL_RADIUS * 2,
        sideEntry: true,
        heights: { clearanceZ: 55, retractZ: 45, feedZ: 45 },
        materialTopZ: 40,
        stockBoundsAreRealStock: true,
      }, {
        onCarvedStock: (value) => { carvedStock = value },
      })

      expect(ir.moves.length).toBeGreaterThan(0)
      // Stock top 40 down to floor 0 at 3 mm, with the part's two flat decks
      // (Z 35 and Z 15) pinned as critical depths.
      expect(ir.meta.params?.levelCount).toBe(14)

      // Every ramp move belongs to a helix that ends with a full at-depth turn,
      // so each helix footprint reaches its own level floor. Group ramp runs and
      // check the last turn is flat.
      const ramps: number[][] = []
      let run: number[] = []
      for (const move of ir.moves) {
        if (move.role === 'ramp') {
          run.push(move.z)
        } else if (run.length > 0) {
          ramps.push(run)
          run = []
        }
      }
      if (run.length > 0) ramps.push(run)
      expect(ramps.length).toBeGreaterThan(0)
      for (const zs of ramps) {
        const floor = Math.min(...zs)
        const flatTail = zs.slice(-24).every((z) => Math.abs(z - floor) <= 1e-9)
        expect(flatTail, `a helix ended sloped at ${floor}: ${zs.slice(-26).join(', ')}`).toBe(true)
      }

      // The bore is the region that used to refuse its own helix centre. Nothing
      // may stand above the finished floor inside it.
      expect(carvedStock).toBeDefined()
      const standing: Array<{ x: number; y: number; top: number }> = []
      for (let j = 0; j < carvedStock!.ny; j++) {
        for (let i = 0; i < carvedStock!.nx; i++) {
          const x = carvedStock!.originX + (i + 0.5) * carvedStock!.cell
          const y = carvedStock!.originY + (j + 0.5) * carvedStock!.cell
          if (Math.hypot(x - BORE_CENTER.x, y - BORE_CENTER.y) > TOOL_RADIUS) continue
          const top = carvedStock!.top[j * carvedStock!.nx + i]
          if (top > 1e-3) standing.push({ x, y, top })
        }
      }
      expect(standing, `bore left standing stock: ${JSON.stringify(standing.slice(0, 8))}`)
        .toEqual([])

      // The exact retained model must still be untouched: drop the real cutter
      // against the mesh at every sampled endpoint.
      const sampled = sampleArcMovesForLinearConsumers(
        irToToolpathMoves(ir),
        { maxChordMm: 0.05, maxAngleDeg: 1 },
      )
      const cutterHandle = kernel.makeCutter({ kind: 'flat', diameter: TOOL_DIAMETER })
      try {
        const xy = Float64Array.from(sampled.flatMap((move) => [move.x, move.y]))
        const safeTipZ = await kernel.dropPoints(handle, cutterHandle, xy, -1)
        let worst = { index: -1, clearance: Number.POSITIVE_INFINITY }
        for (let index = 0; index < sampled.length; index++) {
          const clearance = sampled[index].z - safeTipZ[index]
          if (clearance < worst.clearance) worst = { index, clearance }
        }
        expect(
          worst.clearance,
          `worst cutter/model clearance: ${JSON.stringify({
            ...worst,
            move: sampled[worst.index],
          })}`,
        ).toBeGreaterThanOrEqual(-1e-4)
      } finally {
        kernel.releaseCutter(cutterHandle)
      }
    } finally {
      kernel.releaseMesh(handle)
    }
  }, 300_000)
})
