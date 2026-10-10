// WO-1178 BORE PROBE (underscore = not CI): the uploaded-bore fixture through adaptiveRough,
// printing every lift-landing decision and the moves near the right-hand boss so the
// adaptive3dUploadedBoreRegression expectation can be read against what the engine now does.
//
// Run: npx vitest run src/tests/adaptive-clearing/engine/_wo1178-bore-probe.test.ts

import { readFileSync } from 'node:fs'
import { beforeAll, describe, it, vi } from 'vitest'
import { ensureGeom2dReady } from '../../../cam3d/geom2d'
import { BvhKernel } from '../../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../../cam3d/kernel/types'
import { ensureEngineClipperReady } from '../../../cam3d/rough/engineEntry'
import { adaptiveRough } from '../../../cam3d/strategies/adaptiveRough'
import type { OperationDiagnostics } from '../../../types'

const FIXTURE = 'src/tests/fixtures/adaptive3d-uploaded-bore.json'
const STOCK_BOUNDS = { minX: -48.809749603271484, minY: -24.470998764038086, minZ: 0, maxX: 48.809749603271484, maxY: 24.470998764038086, maxZ: 35 }
const TOOL_DIAMETER = 9.52

describe('WO-1178 bore probe', () => {
  beforeAll(async () => { await ensureGeom2dReady(); await ensureEngineClipperReady() })
  it('prints the landing decisions and the boss-box moves', async () => {
    const display = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const mesh: PartMesh = { positions: Float32Array.from(display.positions), indices: Uint32Array.from(display.indices), bounds: display.bounds, source: 'fixture' }
    const kernel = new BvhKernel()
    const handle = kernel.uploadMesh(mesh)
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
    let diagnostics: OperationDiagnostics | undefined
    try {
      const ir = await adaptiveRough(kernel, {
        mesh: handle, cutter: { kind: 'flat', diameter: TOOL_DIAMETER }, stockBounds: STOCK_BOUNDS,
        cellSize: TOOL_DIAMETER / 12, maxStepdown: 3, stepover: 0.4, millingDirection: 'climb', spindleRotation: 'cw',
        tolerance: 0.05, helixDiameter: 3, helixAngleDeg: 5, floorZ: 15.5, radialStockToLeave: 0.25, axialStockToLeave: 0.5,
        reachStockEdgeBy: TOOL_DIAMETER, sideEntry: true, heights: { clearanceZ: 50, retractZ: 40, feedZ: 40 },
        materialTopZ: 35, stockBoundsAreRealStock: true,
      }, { onDiagnostics: (value) => { diagnostics = value } })
      console.log(`[bore] moves ${ir.moves.length} diagnostics ${JSON.stringify(diagnostics?.adaptiveRough)}`)
      const landing = warnings.filter(w => w.includes('[lift-landing]') || w.includes('[side-entry]') || w.includes('HELIX'))
      console.log(`[bore] ${landing.length} landing lines`)
      for (const w of landing.slice(0, 40)) console.log(`[bore]   ${w.slice(0, 260)}`)
      const roles: Record<string, number> = {}
      for (const m of ir.moves) { const role = m.role ?? 'none'; roles[role] = (roles[role] ?? 0) + 1 }
      console.log(`[bore] roles ${JSON.stringify(roles)}`)
      const box = ir.moves.map((m, i) => ({ i, m, prev: ir.moves[i - 1] })).filter(({ m }) => m.x >= 8 && m.x <= 16 && m.y >= -13 && m.y <= -8)
      console.log(`[bore] ${box.length} moves in the boss box; role transitions:`)
      let last = ''
      for (const { i, m, prev } of box) {
        const key = `${prev?.role}->${m.role}`
        if (key !== last) { console.log(`[bore]   ${i} ${key} z ${prev?.z?.toFixed(2)}->${m.z.toFixed(2)} at (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`); last = key }
      }
    } finally { warn.mockRestore(); kernel.releaseMesh(handle) }
  }, 180_000)
})
