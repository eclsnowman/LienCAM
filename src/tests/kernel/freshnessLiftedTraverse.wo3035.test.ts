// WO-3035 (alpha.3 A3-23, step 1): G-15 characterisation on engine `current`.
// A Parallel 3D finish with a low operator Clearance over a proven stock top:
// the path builder lifts its traverse plane to max(Clearance, stock top + 1)
// (cam3d/pathbuild, WO-127), so the saved rapids sit ABOVE the snapshot's
// Clearance. The saved-toolpath height check (generationFingerprint.ts,
// savedToolpathMatchesHeightSnapshot) bounded every move by that Clearance and
// wanted a rapid AT it, so the op was outdated straight after its own compute.
// WO-3039 (operator ruling 2026-10-21) bounds and anchors rapids at the resolved traverse
// plane instead; the lifted case now pins that fixed verdict. The no-lift
// control shows the verdict is caused by the lift, not by the scenario.
//
// Production route, as parallelConnectorFloor.wo2405: the store's
// computeOperationToolpath on the plate-with-holes STEP part through the real
// worker, the real Save into a fresh store and the real Open.
// WO3035_EVIDENCE=1 writes src/tests/evidence/WO-3035/lifted-traverse.json.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
  // Open re-caches the file's STEP bytes; there is no IndexedDB under node.
  cacheStep: async () => {},
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

import * as scenarioModule from '../helpers/heightScenario'
import { installRealToolpathWorker, isRapid, runSolidScenario } from '../helpers/heightScenario'
import { useCamStore } from '../../store'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { operationSafetyHeightIntent, setupDefaultHeightIntent } from '../../lib/cam/heightIntent'
import { buildParallel3dSmartIntent } from '../../lib/cam/smartHeights'
import type { Operation } from '../../types'

installRealToolpathWorker()

const EPS = 1e-6
const FINISH_DEPTH = 1.5
// Stock 3 mm above the part, so the operator can set Clearance between the
// stock top and stock top + 1 while Feed stays above the part (Material Start).
const STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
const LOW_CLEARANCE_WCS = 0.5

let savedProjectText = ''
const evidence: Record<string, unknown> = {}
beforeEach(() => {
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-3035.camproject'
    },
  })
})
afterEach(() => { vi.unstubAllGlobals() })
afterAll(async () => {
  if (process.env.WO3035_EVIDENCE !== '1') return
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  mkdirSync('src/tests/evidence/WO-3035', { recursive: true })
  writeFileSync('src/tests/evidence/WO-3035/lifted-traverse.json', JSON.stringify({
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    command: 'WO3035_EVIDENCE=1 npx vitest run src/tests/kernel/freshnessLiftedTraverse.wo3035.test.ts',
    entry: 'computeOperationToolpath -> real toolpathWorker / in-process cam3d -> saveProjectToFile -> loadProjectFromFile',
    engine: 'current',
    gap: 'G-15 (GAP-040 a)',
    cases: evidence,
  }, null, 2) + '\n')
})

interface Observed {
  status: string
  traversePlaneMachineZ: number
  clearanceMachineZ: number
  stockTopMachineZ: number
  liveCurrentAfterCompute: boolean
  reopenedStatus: string
  reopenedErrorMessage: string | undefined
  reopenedCurrent: boolean
}

async function computeSaveReopen(
  edit?: (setupId: string, op: Operation) => Partial<Operation>,
): Promise<Observed> {
  const [reading] = await runSolidScenario({
    part: 'plate_holes', z: 0, stock: STOCK,
    operations: [{ kind: 'parallel_3d', toolDiameter: 6, params: { finishDepth: FINISH_DEPTH } }],
  })
  expect(reading.status, reading.errorMessage).toBe('ready')
  if (edit) {
    const setup = useCamStore.getState().project.setups[0]
    useCamStore.getState().updateOperation(setup.id, setup.operations[0].id, edit(setup.id, setup.operations[0]))
    await useCamStore.getState().computeOperationToolpath(setup.id, setup.operations[0].id)
  }
  const live = () => ({ ...useCamStore.getState().project, toolLibrary: useCamStore.getState().toolLibrary })
  const computedProject = live()
  const setup = computedProject.setups[0]
  const op = setup.operations[0]
  const moves = op.toolpathMoves ?? []
  const traversePlaneMachineZ = moves.filter(isRapid).reduce((z, m) => Math.max(z, m.z), -Infinity)
  const liveCurrentAfterCompute = operationGenerationIsCurrent(computedProject, setup, op)

  await useCamStore.getState().saveProjectToFile()
  expect(savedProjectText).not.toBe('')
  useCamStore.setState(useCamStore.getInitialState(), true)
  await useCamStore.getState().loadProjectFromFile(savedProjectText)
  const reopenedProject = live()
  const reopened = reopenedProject.setups[0].operations[0]
  return {
    status: op.status,
    traversePlaneMachineZ,
    clearanceMachineZ: op.resolvedHeights!.machine.clearance,
    stockTopMachineZ: reading.stockTopMachineZ,
    liveCurrentAfterCompute,
    reopenedStatus: reopened.status,
    reopenedErrorMessage: reopened.errorMessage,
    reopenedCurrent: operationGenerationIsCurrent(reopenedProject, reopenedProject.setups[0], reopened),
  }
}

describe('WO-3035 G-15: lifted-traverse 3D finish, reconciled on load (current engine, characterisation)', () => {
  it('control: Clearance above stock top + 1, no lift - current after compute and after reopen', async () => {
    const observed = await computeSaveReopen()
    evidence.control = observed
    expect(observed.status).toBe('ready')
    // Setup default Clearance (Retract + 10, Retract = stock top + 5) is far above the lift floor.
    expect(observed.clearanceMachineZ).toBeGreaterThan(observed.stockTopMachineZ + 1 + EPS)
    expect(observed.traversePlaneMachineZ).toBeCloseTo(observed.clearanceMachineZ, 9)
    expect({
      liveCurrentAfterCompute: observed.liveCurrentAfterCompute,
      reopenedStatus: observed.reopenedStatus,
      reopenedCurrent: observed.reopenedCurrent,
    }).toEqual({ liveCurrentAfterCompute: true, reopenedStatus: 'ready', reopenedCurrent: true })
  }, 300_000)

  it('lifted: operator Clearance 0.5 mm above the proven stock top - current after compute and after reopen (WO-3039)', async () => {
    const observed = await computeSaveReopen((setupId, op) => {
      // The operation dialog's Clearance/Retract/Feed rows, set by the operator.
      const intent = setupDefaultHeightIntent(useCamStore.getState().project.setups[0])
      intent.clearance = { reference: 'wcs_plane', offset: LOW_CLEARANCE_WCS, provenance: 'user' }
      intent.retract = { reference: 'wcs_plane', offset: LOW_CLEARANCE_WCS, provenance: 'user' }
      intent.feed = { reference: 'wcs_plane', offset: 0.25, provenance: 'user' }
      const safetyIntent = operationSafetyHeightIntent(intent, new Set(['clearance', 'retract', 'feed'] as const))
      return { smartHeight: { kind: 'smart_v2', intent: buildParallel3dSmartIntent({
        setupId, geometryIds: op.geometrySelections, safetyIntent, finishDepthMm: FINISH_DEPTH,
      }) } } as Partial<Operation>
    })
    evidence.lifted = observed
    // The scenario is real: the compute succeeded and the traverse plane WAS
    // lifted to stock top + 1 (WCS origin is the stock top), above Clearance.
    expect(observed.status).toBe('ready')
    expect(observed.clearanceMachineZ).toBeCloseTo(observed.stockTopMachineZ + LOW_CLEARANCE_WCS, 9)
    expect(observed.traversePlaneMachineZ).toBeCloseTo(observed.stockTopMachineZ + 1, 9)
    expect(observed.traversePlaneMachineZ).toBeGreaterThan(observed.clearanceMachineZ + EPS)
    // WO-3039 verdict: the lifted rapids sit on the resolved traverse plane,
    // so the operation is current after its own compute and after reopen -
    // nothing recomputes. (Before WO-3039: not current after compute, and
    // 'outdated' with "Saved toolpath inputs cannot be verified" on reopen.)
    expect({
      liveCurrentAfterCompute: observed.liveCurrentAfterCompute,
      reopenedStatus: observed.reopenedStatus,
      reopenedErrorMessage: observed.reopenedErrorMessage,
      reopenedCurrent: observed.reopenedCurrent,
    }).toEqual({
      liveCurrentAfterCompute: true,
      reopenedStatus: 'ready',
      reopenedErrorMessage: undefined,
      reopenedCurrent: true,
    })
  }, 300_000)
})
