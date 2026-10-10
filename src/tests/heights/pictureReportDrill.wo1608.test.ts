// WO-1608 picture 4: Drill through a raised plate (SH-8; the harness, not the app - WO-1624,
// drawn as a pass). In its own file, deliberately: run right after a
// runHeightScenario sketch scenario in the SAME file/store instance, Detect
// Holes on this plate read back short (deepest cut -13 instead of -14.502)
// even though this exact scenario, run alone, is exact - and even though
// solids3d.wo1606.test.ts's own case 88b (also alone in its file) is exact.
// A cross-scenario store-state hazard in the shared harness, not a product
// defect; traced as far as this order's owned paths reach (store internals are
// out of scope) and worked around by giving each picture its own vitest file,
// which is the one thing that reliably avoids it (see pictureHelpers.ts).

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) =>
  typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
    deriveHoles: async (geoId: string) =>
      (await import('../helpers/heightScenario')).deriveHolesInProcess(geoId),
  }))

import * as scenarioModule from '../helpers/heightScenario'
import {
  installRealToolpathWorker, runSolidScenario, type ScenarioStock, type ScenarioWorkholding,
} from '../helpers/heightScenario'
import { writeSideView, toolBands } from '../helpers/sideViewEvidence'
import { DIR, RAISE, HOLDER, toolSolid, toPath, deepestPlacement, stockObstacle, workholdingObstacle, TABLE_REF, pass } from './pictureHelpers'

installRealToolpathWorker()

const PLATE_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 38, y: 0, z: 0 }, max: { x: 44, y: 60, z: RAISE } }
const PLATE_STOCK: ScenarioStock = { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
const DRILL_POINT = 2.5 / Math.tan((59 * Math.PI) / 180)

describe('WO-1608 picture 4: Drill through a raised plate', () => {
  it('draws the full-diameter tip reaching the through-depth, past the plate bottom by the drill point', async () => {
    const [r] = await runSolidScenario({
      part: 'plate_holes', z: RAISE, stock: PLATE_STOCK, workholding: PLATE_VISE,
      operations: [{ kind: 'drill', toolDiameter: 5, holeDiameters: [6, 10] }],
    })
    expect(r.status, r.errorMessage).toBe('ready')
    const expectedBottom = -13 - DRILL_POINT
    expect(r.deepestCutZ).toBeCloseTo(expectedBottom, 2)
    expect(r.heightsRow.bottom).toBeCloseTo(expectedBottom, 2)

    const bands = toolBands(toolSolid('Drill 5', 5, 'drill'), HOLDER)
    writeSideView({
      dir: DIR, name: 'drill-through-raised-plate', title: 'Drill through a raised plate: the full point clears the hole',
      subtitle: `WO-1606 case 88b, SH-8 (the product is right; see note). Expected tip ${expectedBottom.toFixed(3)}. Measured matches. ${pass()}.`,
      obstacles: [
        stockObstacle(r), workholdingObstacle(r.workholdingWcs!),
        {
          columns: [[r.stockXY.minX + 5, r.stockXY.maxX - 5, r.partBottomWcs, r.partTopWcs]] as const,
          yRange: [r.stockXY.minY + 5, r.stockXY.maxY - 5] as const, colour: '#16a085', label: 'plate', showLabel: false,
        },
      ],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves, 'drill')],
      referenceLines: [TABLE_REF(r.wcsOriginMachineZ), { z: -13, label: 'plate bottom -13 (hole floor)' }],
      captions: [
        `Expected: tip at hole bottom (-13) - 2.5 / tan(59°) = ${expectedBottom.toFixed(3)} (WO-1606 case 88b).`,
        `Measured: deepest cut ${r.deepestCutZ.toFixed(3)}, Heights row Bottom ${r.heightsRow.bottom?.toFixed(3)}. ${pass()}.`,
        'SH-8: the app puts the tip here. The campaign read "tip at -13" because its test harness kept an earlier ' +
          'scenario 6 mm end mill under the same tool id, so the drill was computed as an end mill (no point). ' +
          'WO-1624 fixes the harness; this picture runs alone, with the real drill.',
      ],
    })
  }, 120_000)
})
