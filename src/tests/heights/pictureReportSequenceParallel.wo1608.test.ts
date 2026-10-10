// WO-1608 picture 9: the closed-box rough, then Parallel 3D - starts right and
// its links now stay low over the material the rough already removed (SH-6,
// fixed by WO-1620's link lowering + WO-1641 folding it into the ordinary,
// no-opt-in finish path). In its own file - see pictureHelpers.ts's header for
// why each solid-scenario picture is split one per file.

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
  DIR, TOL, HOLDER, toolSolid, toPath, interiorRapids, stockObstacle, TABLE_REF, BOX_FIXED_STOCK, ROUGH_LEFT_TOP, roughOp,
} from './pictureHelpers'

installRealToolpathWorker()

describe('WO-1608 picture 9: the same rough, then Parallel 3D [SH-6 fixed]', () => {
  it('draws the finish starting correctly at the box top, with its links now staying low over material the rough already removed', async () => {
    const [, second] = await runSolidScenario({
      part: 'closed_box', z: 0, stock: BOX_FIXED_STOCK,
      operations: [roughOp(), { kind: 'parallel_3d', toolDiameter: 6 }],
    })
    expect(second.status, second.errorMessage).toBe('ready')
    expect(second.highestCuttingZ).toBeLessThanOrEqual(ROUGH_LEFT_TOP + TOL)
    const links = interiorRapids(second.moves)
    // The raster does cross a corridor between regions and does produce links
    // to measure - this is not "no links at all" masking the finding away.
    expect(links.length, 'links between raster regions, to measure').toBeGreaterThan(0)
    const climbingLinks = links.filter(m => m.z > 5 + TOL)
    expect(
      climbingLinks.length,
      'links that climb above the Setup retract (5) - SH-6, fixed by WO-1620 (link lowering) + WO-1641 (folded into the always-on finish path)',
    ).toBe(0)

    const bands = toolBands(toolSolid('Ball6', 6, 'ball_end_mill'), HOLDER)
    const highestLink = links.reduce((a, b) => (b.z > a.z ? b : a))
    writeSideView({
      dir: DIR, name: 'parallel-3d-after-rough-links', title: 'Rough, then Parallel 3D: links now stay low over material the rough already removed [SH-6 fixed]',
      subtitle: `WO-1606 case 81, fixed by WO-1620/WO-1641. Expected: links stay at or below retract 5. Measured: highest link reaches ${highestLink.z.toFixed(1)}.`,
      obstacles: [
        stockObstacle(second),
        {
          columns: [[second.stockXY.minX + 10, second.stockXY.maxX - 10, second.partBottomWcs, second.partTopWcs]] as const,
          yRange: [second.stockXY.minY + 10, second.stockXY.maxY - 10] as const, colour: '#16a085', label: 'box', showLabel: false,
        },
      ],
      path: toPath(second.moves), bands, placements: [{ x: highestLink.x, tipZ: highestLink.z }],
      referenceLines: [
        TABLE_REF(second.wcsOriginMachineZ),
        { z: 5, label: 'Setup retract 5 - where the link stays' },
        { z: highestLink.z, label: `the highest link reaches ${highestLink.z.toFixed(1)}` },
      ],
      captions: [
        `Expected: cutting starts at ${ROUGH_LEFT_TOP} (the box top left by the rough), links between raster regions at or below retract 5 (WO-1606 case 81).`,
        `Measured: highest cut ${second.highestCuttingZ.toFixed(2)} (correct - the finish does start at the box top), ` +
          `and all ${links.length} link(s) stay at or below retract 5, reaching no higher than ${highestLink.z.toFixed(1)}. SH-6 fixed.`,
        'WO-1620/WO-1641: Parallel 3D replays what the earlier, enabled operations of the setup actually left (the same replay the reach trim uses) and keeps a link low whenever that remaining material proves the corridor already clear, instead of always climbing to its own Retract/Clearance (SH-3, read from the model top).',
      ],
    })
  }, 180_000)
})
