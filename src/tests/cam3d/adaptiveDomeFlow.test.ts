import { describe, expect, it } from 'vitest'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { hemisphereOnSlab } from '../../cam3d/fixtures'
import { adaptiveRough } from '../../cam3d/strategies/adaptiveRough'
import { forEachLinearSweep, type ToolTipPosition } from '../../cam3d/rough/replayStock'

describe('3D dome-to-square adaptive flow', () => {
  it('keeps perimeter links forward without duplicate base laps', async () => {
    const kernel = new BvhKernel()
    const mesh = kernel.uploadMesh(hemisphereOnSlab(12, { x: 40, y: 40, t: 10 }))
    try {
      const ir = await adaptiveRough(kernel, {
        mesh, cutter: { kind: 'flat', diameter: 9.52 },
        stockBounds: { minX: -5, minY: -5, minZ: 0, maxX: 45, maxY: 45, maxZ: 29 },
        cellSize: 9.52 / 12, maxStepdown: 3, stepover: 0.4, tolerance: 0.05,
        helixDiameter: 3, sideEntry: true, reachStockEdgeBy: 9.52,
        // WO-1896: the material-left stream this flow was tuned on (labelled climb before
        // climb was fixed to keep material on the cutter's right). CCW about the dome.
        millingDirection: 'conventional', materialTopZ: 29,
        heights: { clearanceZ: 44, retractZ: 34, feedZ: 34 },
      })
      let tip: ToolTipPosition | undefined
      let reverseStepover = 0
      const baseLength = new Map<number, number>()
      for (const move of ir.moves) {
        if (tip) forEachLinearSweep(tip, move, 0.0025, s => {
          if (Math.abs(s.z1 - s.z0) > 1e-7) return
          const length = Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
          if (move.role === 'stepover') {
            const delta = Math.atan2(s.y1 - 20, s.x1 - 20) - Math.atan2(s.y0 - 20, s.x0 - 20)
            if (Math.atan2(Math.sin(delta), Math.cos(delta)) < -1e-7) reverseStepover += length
          }
          if (s.z1 < 10 && (move.role === 'cut' || move.role === 'finish')) {
            baseLength.set(s.z1, (baseLength.get(s.z1) ?? 0) + length)
          }
        })
        tip = { x: move.x, y: move.y, z: move.z }
      }
      expect(reverseStepover).toBeLessThan(0.001)
      expect(baseLength.has(0)).toBe(true)
      expect(baseLength.size).toBeGreaterThanOrEqual(4)
      // Two productive circuits of a ~190 mm cutter-center perimeter fit;
      // the old repeated rough/cleanup/finish circuits (~975 mm) cannot.
      for (const [z, length] of baseLength) {
        console.log(`dome square-base travel z=${z.toFixed(1)}: ${length.toFixed(2)} mm`)
        expect(length).toBeGreaterThan(300)
        expect(length).toBeLessThan(500)
        // WO-2752: the material-side-correct tangent changes the entry seam by
      // 0.424 mm; preserve the path-length pin and all coverage/direction guards.
      // WO-3067 RE-PIN (435.10 -> 390.11 mm at every level, a length): steering smoothing ships
      // ON (owner 2026-10-22 "Turn it on (recommended)"); still two circuits, inside 300..500.
      expect(length).toBeCloseTo(390.11, 1)
      }
      expect(ir.meta?.params?.smoothingSafetyFallback).toBe(false)
      expect(ir.meta?.params?.wallCleanupSafetyFallback).toBe(false)
    } finally {
      kernel.releaseMesh(mesh)
    }
  }, 120000)
})
