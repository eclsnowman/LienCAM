// WO-1608 picture 8: the closed-box rough, then a second Adaptive 3D Current
// material pass - which refuses outright (SH-5). In its own file - see
// pictureHelpers.ts's header for why each solid-scenario picture is split one
// per file.

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
  DIR, HOLDER, toolSolid, toPath, deepestPlacement, stockObstacle, TABLE_REF, BOX_FIXED_STOCK, BOX_FIXED_BOTTOM,
  ROUGH_LEFT_TOP, roughOp,
} from './pictureHelpers'

installRealToolpathWorker()

describe('WO-1608 picture 8: the same rough, then Adaptive 3D Current material again (SH-5, closed by WO-1619)', () => {
  it('draws the rough and the second pass that now runs from the material the rough left', async () => {
    const [rough, second] = await runSolidScenario({
      part: 'closed_box', z: 0, stock: BOX_FIXED_STOCK,
      operations: [roughOp(), { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0, params: { useStockBoundary: true } }],
    })
    expect(rough.status, rough.errorMessage).toBe('ready')
    expect(second.status, second.errorMessage).toBe('ready')
    expect(second.moves.length, 'the second pass makes a toolpath').toBeGreaterThan(0)
    expect(second.highestCuttingZ, 'no cutting move above the material the rough left').toBeLessThanOrEqual(ROUGH_LEFT_TOP + 0.01)

    const bands = toolBands(toolSolid('EM6', 6, 'flat_end_mill'), HOLDER)
    writeSideView({
      dir: DIR, name: 'adaptive-3d-second-pass-refused', title: 'Rough, then a second Adaptive 3D Current material pass (SH-5 closed by WO-1619)',
      subtitle: `WO-1606 case 78. Expected: the second pass starts at WCS ${ROUGH_LEFT_TOP}, reaches ${BOX_FIXED_BOTTOM}. Measured: highest cut ${second.highestCuttingZ.toFixed(2)}, deepest ${second.deepestCutZ.toFixed(2)}.`,
      obstacles: [
        stockObstacle(rough),
        {
          columns: [[rough.stockXY.minX + 10, rough.stockXY.maxX - 10, rough.partBottomWcs, rough.partTopWcs]] as const,
          yRange: [rough.stockXY.minY + 10, rough.stockXY.maxY - 10] as const, colour: '#16a085', label: 'box', showLabel: false,
        },
      ],
      path: toPath(second.moves), bands, placements: [deepestPlacement(second.moves)],
      referenceLines: [TABLE_REF(rough.wcsOriginMachineZ), { z: ROUGH_LEFT_TOP, label: `material left by the rough (${ROUGH_LEFT_TOP})` }],
      captions: [
        `The path drawn is the SECOND pass (${second.moves.length} moves); the rough is picture 7.`,
        `Before WO-1619 this pass refused outright (engagement cap charged for stock the rough had already removed) - finding SH-5.`,
      ],
    })
  }, 180_000)
})
