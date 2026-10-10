// WO-1608 picture 7: Adaptive 3D roughs the closed box (Current material). In
// its own file - see pictureHelpers.ts's header for why each solid-scenario
// picture is split one per file.

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
import { installRealToolpathWorker, runSolidScenario } from '../helpers/heightScenario'
import { writeSideView, toolBands } from '../helpers/sideViewEvidence'
import {
  DIR, TOL, HOLDER, toolSolid, toPath, deepestPlacement, stockObstacle, TABLE_REF, pass,
  BOX_FIXED_STOCK, BOX_FIXED_BOTTOM, roughOp,
} from './pictureHelpers'

installRealToolpathWorker()

describe('WO-1608 picture 7: Adaptive 3D roughs the closed box (Current material)', () => {
  it('draws the rough that every "then a second operation" case in the campaign starts from', async () => {
    const [rough] = await runSolidScenario({ part: 'closed_box', z: 0, stock: BOX_FIXED_STOCK, operations: [roughOp()] })
    expect(rough.status, rough.errorMessage).toBe('ready')
    expect(rough.deepestCutZ).toBeCloseTo(BOX_FIXED_BOTTOM + 0.5, 2)
    expect(rough.highestCuttingZ).toBeLessThanOrEqual(0 + TOL)

    const bands = toolBands(toolSolid('EM6', 6, 'flat_end_mill'), HOLDER)
    writeSideView({
      dir: DIR, name: 'adaptive-3d-rough-current-material', title: 'Adaptive 3D rough, closed box, Current material (fixed stock)',
      subtitle: `WO-1606 case 48. Expected top 0, deepest ${(BOX_FIXED_BOTTOM + 0.5).toFixed(1)}. Measured matches. ${pass()}.`,
      obstacles: [
        stockObstacle(rough),
        {
          columns: [[rough.stockXY.minX + 10, rough.stockXY.maxX - 10, rough.partBottomWcs, rough.partTopWcs]] as const,
          yRange: [rough.stockXY.minY + 10, rough.stockXY.maxY - 10] as const, colour: '#16a085', label: 'box', showLabel: false,
        },
      ],
      path: toPath(rough.moves), bands, placements: [deepestPlacement(rough.moves)],
      referenceLines: [TABLE_REF(rough.wcsOriginMachineZ)],
      captions: [
        `Expected: top 0, deepest cut = box bottom (${BOX_FIXED_BOTTOM}) + 0.5 mm axial stock to leave = ${(BOX_FIXED_BOTTOM + 0.5).toFixed(1)} (WO-1606 case 48).`,
        `Measured: highest cut ${rough.highestCuttingZ.toFixed(2)}, deepest cut ${rough.deepestCutZ.toFixed(2)}. ${pass()}.`,
        'What this rough leaves standing: the box plus 0.5 mm on top (WCS -4.5) - the material pictures 8 and 9 start from.',
      ],
    })
  }, 180_000)
})
