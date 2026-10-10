// WO-1617 (finding SH-8): a detected THROUGH hole is drilled so the full
// diameter reaches the bottom - the tip goes one drill-point length below the
// hole bottom. A blind hole stops with the tip at its floor (WO-2678, machine session
// 2026-10-08: "Tip stops at the floor").
//
// Production compute path: the store authors the Drill op from "Detect holes"
// and computeOperationToolpath resolves Smart Heights and runs the worker.
// Only browser transports are replaced (see heightScenario.ts, "WO-1606").

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
import { installRealToolpathWorker, runSolidScenario, type ScenarioWorkholding } from '../helpers/heightScenario'
import { toWork } from '../../lib/program/coords'
import { buildDrillBoreAuthoringIntent } from '../../lib/cam/smartHeights/drillBoreAuthoring'
import { operationSafetyHeightIntent, setupDefaultHeightIntent } from '../../lib/cam/heightIntent'
import type { Operation } from '../../types'
import { useCamStore } from '../../store'

installRealToolpathWorker()

const RAISE = 50
const TOL = 0.01
const DRILL_POINT = 2.5 / Math.tan(59 * Math.PI / 180)
const PLATE_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 38, y: 0, z: 0 }, max: { x: 44, y: 60, z: RAISE } }

describe('WO-1617: Drill Smart on detected through holes reaches full diameter', () => {
  for (const placement of ['table', 'raised'] as const) {
    it(`${placement}: plate-holes through holes, 5 mm 118 deg drill -> tip -14.502`, async () => {
      const [r] = await runSolidScenario({
        part: 'plate_holes', z: placement === 'raised' ? RAISE : 0,
        stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
        ...(placement === 'raised' ? { workholding: PLATE_VISE } : {}),
        operations: [{ kind: 'drill', toolDiameter: 5, holeDiameters: [6, 10] }],
      })
      expect(r.authoringError).toBeUndefined()
      expect(r.status, r.errorMessage).toBe('ready')
      expect(r.holes!.every(h => h.through)).toBe(true)
      const expected = -13 - DRILL_POINT
      expect(expected).toBeCloseTo(-14.502, 3)
      const plunges = r.moves.filter(m => m.role === 'plunge')
      expect(plunges.length).toBe(5)
      for (const plunge of plunges) expect(Math.abs(plunge.z - expected), `tip ${plunge.z}`).toBeLessThanOrEqual(TOL)
      expect(r.heightsRow.bottom, 'Heights row: Bottom').toBeCloseTo(expected, 2)
      for (const endpoint of r.plan!.machining.featureEndpoints!) {
        expect(endpoint.physicalTarget!.wcsMm).toBeCloseTo(-13, 2)
        expect(endpoint.cutterCenterEnd.wcsMm).toBeCloseTo(expected, 2)
      }
    }, 120_000)
  }

  it('a blind hole (WO-2678): the tip stops at its detected floor, no drill point below it', async () => {
    const [through] = await runSolidScenario({
      part: 'plate_holes', z: 0,
      stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
      operations: [{ kind: 'drill', toolDiameter: 5, holeDiameters: [6, 10] }],
    })
    expect(through.status, through.errorMessage).toBe('ready')
    // The same detected holes, made blind 5 mm above the plate bottom (floor WCS -8).
    useCamStore.setState(state => ({
      project: {
        ...state.project,
        geometry: state.project.geometry.map(geo => ({
          ...geo,
          layers2d: (geo.layers2d ?? []).map(layer => ({
            ...layer,
            holes: layer.holes?.map(hole => ({ ...hole, through: false, bottomZ: hole.bottomZ + 5 })),
          })),
        })),
      },
    }))
    // The operator re-opens the operation on the changed geometry: the dialog
    // authors the Drill intent again from the detected features.
    const setup = useCamStore.getState().project.setups[0]
    const drill = setup.operations.find(o => o.id === 'op-1')!
    const loopIds = (drill.params as unknown as { loopIds: string[] }).loopIds
    useCamStore.getState().updateOperation(setup.id, 'op-1', {
      smartHeight: {
        kind: 'smart_v2',
        intent: buildDrillBoreAuthoringIntent({
          operationType: 'drill', setupId: setup.id,
          safetyIntent: operationSafetyHeightIntent(setupDefaultHeightIntent(setup), new Set()),
          geometries: useCamStore.getState().project.geometry, selectedLoopIds: loopIds,
          draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
        }),
      },
    } as Partial<Operation>)
    await useCamStore.getState().computeOperationToolpath(setup.id, 'op-1')
    const op = useCamStore.getState().project.setups[0].operations.find(o => o.id === 'op-1')!
    expect(op.status, op.errorMessage).toBe('ready')
    const plan = op.resolvedHeightPlan?.version === 2 ? op.resolvedHeightPlan : undefined
    const expected = -8
    for (const endpoint of plan!.machining.featureEndpoints!) {
      expect(endpoint.physicalTarget!.wcsMm).toBeCloseTo(-8, 2)
      expect(endpoint.cutterCenterEnd.wcsMm).toBeCloseTo(expected, 2)
    }
    const plunges = (op.toolpathMoves ?? []).map(m => ({ ...m, ...toWork(m, setup.wcs) })).filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(5)
    for (const plunge of plunges) expect(Math.abs(plunge.z - expected), `tip ${plunge.z}`).toBeLessThanOrEqual(TOL)
  }, 120_000)
})
