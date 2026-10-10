// WO-1608 picture 10: Parallel 3D Smart on the closed box, no rough - the
// Retract/Clearance rows read from the Setup's stock-top default (SH-3,
// closed by WO-1616; before it they read from the model top). In its own file - see pictureHelpers.ts's header
// for why each solid-scenario picture is split one per file.

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
import { DIR, HOLDER, toolSolid, toPath, deepestPlacement, stockObstacle, TABLE_REF, BOX_AUTO_STOCK } from './pictureHelpers'

installRealToolpathWorker()

describe('WO-1608 picture 10: Parallel 3D Smart, no rough (SH-3, closed by WO-1616)', () => {
  it('draws the links riding at the Setup’s stock-top Retract/Clearance', async () => {
    const [r] = await runSolidScenario({
      part: 'closed_box', z: 0, stock: BOX_AUTO_STOCK, operations: [{ kind: 'parallel_3d', toolDiameter: 6 }],
    })
    expect(r.status, r.errorMessage).toBe('ready')
    // The box auto stock's model top is WCS -3 (docs/testing/SMART-HEIGHTS-CAMPAIGN.md, BOX_FRAME.auto):
    // Setup Retract 5 / Clearance 15 read from stock top (0) would be 5 / 15; from the model
    // top (-3) they were 2 / 12 - SH-3, closed by WO-1616.
    expect(r.heightsRow.retract).toBeCloseTo(5, 1)
    expect(r.heightsRow.clearance).toBeCloseTo(15, 1)

    const bands = toolBands(toolSolid('Ball6', 6, 'ball_end_mill'), HOLDER)
    writeSideView({
      dir: DIR, name: 'parallel-3d-model-top-retract', title: 'Parallel 3D Smart: Retract/Clearance from the stock top (SH-3 closed by WO-1616)',
      subtitle: `WO-1606 case 60. Expected retract 5, clearance 15 (Setup default). Measured retract ${r.heightsRow.retract?.toFixed(2)}, clearance ${r.heightsRow.clearance?.toFixed(2)}.`,
      obstacles: [
        stockObstacle(r),
        {
          columns: [[r.stockXY.minX + 5, r.stockXY.maxX - 5, r.partBottomWcs, r.partTopWcs]] as const,
          yRange: [r.stockXY.minY + 5, r.stockXY.maxY - 5] as const, colour: '#16a085', label: 'box', showLabel: false,
        },
      ],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves)],
      referenceLines: [
        TABLE_REF(r.wcsOriginMachineZ),
        { z: 5, label: 'Setup Retract 5 (stock top + 5) - expected' },
        { z: r.heightsRow.retract ?? 0, label: `measured Retract ${(r.heightsRow.retract ?? 0).toFixed(2)}` },
      ],
      captions: [
        'Expected: the Setup’s own Retract 5 / Clearance 15, measured from the stock top (WCS 0), as every 2D operation in this campaign uses.',
        `Measured: Retract ${r.heightsRow.retract?.toFixed(2)}, Clearance ${r.heightsRow.clearance?.toFixed(2)}. ` +
          'Before WO-1616 these read from the MODEL top (WCS -3), so the links ran at the uncut stock top (SH-3).',
      ],
    })
  }, 180_000)
})
