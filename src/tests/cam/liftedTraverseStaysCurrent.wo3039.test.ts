// WO-3039: a stock-aware lifted 3D finish stays current - no recompute.
// the operator 2026-10-21: "knowledge of a local clearance at that stock aware state
// should allow us to not need to recompute ... complex parts recompute times
// can take minute(s)". The Parallel finish lifts its traverse plane to
// max(Clearance, proven stock top + 1) (cam3d/pathbuild, WO-127). The saved
// toolpath height check (generationFingerprint.ts) now accepts rapids up to
// that same plane, read from the proven stock the fingerprint already hashes,
// so the operation is current after its own compute and after every reopen.
// The fingerprint's hashed inputs and contract version are unchanged: a
// project saved BEFORE this fix (fixture, written on the starter) opens with
// every operation current. A rapid above the plane, a raised stock top or an
// edited operation still goes outdated.
//
// Production route, as freshnessLiftedTraverse.wo3035: the store's
// computeOperationToolpath on the plate-with-holes STEP part through the real
// worker, the real Save into a fresh store and the real Open.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
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
import type { Operation, Project, ToolpathMove } from '../../types'

installRealToolpathWorker()

const EPS = 1e-6
const FINISH_DEPTH = 1.5
// Stock 3 mm above the part (WO-3035's fixture): Clearance can sit between
// the stock top and stock top + 1 while Feed stays above the part.
const STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
const LOW_CLEARANCE_WCS = 0.5
const FIXTURE = 'src/tests/evidence/WO-3039/saved-before-fix.liencam'
const FIXTURE_UNREADABLE = 'Saved toolpath inputs cannot be verified; regenerate this operation.'

let savedProjectText = ''
beforeEach(() => {
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-3039.camproject'
    },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

const live = (): Project => ({ ...useCamStore.getState().project, toolLibrary: useCamStore.getState().toolLibrary })

/** The operation dialog's Clearance/Retract/Feed rows, set by the operator. */
function lowClearance(setupId: string, op: Operation): Partial<Operation> {
  const intent = setupDefaultHeightIntent(useCamStore.getState().project.setups[0])
  intent.clearance = { reference: 'wcs_plane', offset: LOW_CLEARANCE_WCS, provenance: 'user' }
  intent.retract = { reference: 'wcs_plane', offset: LOW_CLEARANCE_WCS, provenance: 'user' }
  intent.feed = { reference: 'wcs_plane', offset: 0.25, provenance: 'user' }
  const safetyIntent = operationSafetyHeightIntent(intent, new Set(['clearance', 'retract', 'feed'] as const))
  return { smartHeight: { kind: 'smart_v2', intent: buildParallel3dSmartIntent({
    setupId, geometryIds: op.geometrySelections, safetyIntent, finishDepthMm: FINISH_DEPTH,
  }) } } as Partial<Operation>
}

/** Two Parallel finishes on one setup: op-1 at the Setup default Clearance
 * (control, no lift), op-2 with Clearance 0.5 mm above the proven stock top. */
async function computeControlAndLifted(): Promise<{ stockTopMachineZ: number }> {
  const [reading] = await runSolidScenario({
    part: 'plate_holes', z: 0, stock: STOCK,
    operations: [
      { kind: 'parallel_3d', toolDiameter: 6, params: { finishDepth: FINISH_DEPTH } },
      { kind: 'parallel_3d', toolDiameter: 6, params: { finishDepth: FINISH_DEPTH } },
    ],
  })
  expect(reading.status, reading.errorMessage).toBe('ready')
  const setup = useCamStore.getState().project.setups[0]
  const lifted = setup.operations[1]
  useCamStore.getState().updateOperation(setup.id, lifted.id, lowClearance(setup.id, lifted))
  await useCamStore.getState().computeOperationToolpath(setup.id, lifted.id)
  return { stockTopMachineZ: reading.stockTopMachineZ }
}

const maxRapidZ = (moves: readonly ToolpathMove[]) =>
  moves.filter(isRapid).reduce((z, m) => Math.max(z, m.z), -Infinity)

async function saveAndReopen(): Promise<Project> {
  await useCamStore.getState().saveProjectToFile()
  expect(savedProjectText).not.toBe('')
  return reopen(savedProjectText)
}

async function reopen(text: string): Promise<Project> {
  useCamStore.setState(useCamStore.getInitialState(), true)
  await useCamStore.getState().loadProjectFromFile(text)
  return live()
}

function verdicts(project: Project) {
  const setup = project.setups[0]
  return setup.operations.map(op => ({
    id: op.id, status: op.status, errorMessage: op.errorMessage,
    current: operationGenerationIsCurrent(project, setup, op),
  }))
}

describe('WO-3039: a stock-aware lifted 3D finish stays current (no recompute)', () => {
  it('lifted finish is current after its own compute and after save + reopen; control unchanged', async () => {
    const { stockTopMachineZ } = await computeControlAndLifted()
    const computed = live()
    const [control, lifted] = computed.setups[0].operations
    // The scenario is real: op-2's traverse plane WAS lifted above its Clearance
    // to stock top + 1; op-1 travels at its own (higher) Clearance.
    expect(lifted.status).toBe('ready')
    expect(lifted.resolvedHeights!.machine.clearance).toBeCloseTo(stockTopMachineZ + LOW_CLEARANCE_WCS, 9)
    expect(maxRapidZ(lifted.toolpathMoves ?? [])).toBeCloseTo(stockTopMachineZ + 1, 9)
    expect(maxRapidZ(control.toolpathMoves ?? [])).toBeCloseTo(control.resolvedHeights!.machine.clearance, 9)
    expect(control.resolvedHeights!.machine.clearance).toBeGreaterThan(stockTopMachineZ + 1 + EPS)

    if (process.env.WO3039_WRITE_PREFIX_FIXTURE === '1') {
      await useCamStore.getState().saveProjectToFile()
      writeFileSync(FIXTURE, savedProjectText)
    }

    const liveVerdicts = verdicts(computed)
    const reopened = await saveAndReopen()
    expect({ afterCompute: liveVerdicts, afterReopen: verdicts(reopened) }).toEqual({
      afterCompute: [
        { id: control.id, status: 'ready', errorMessage: undefined, current: true },
        { id: lifted.id, status: 'ready', errorMessage: undefined, current: true },
      ],
      afterReopen: [
        { id: control.id, status: 'ready', errorMessage: undefined, current: true },
        { id: lifted.id, status: 'ready', errorMessage: undefined, current: true },
      ],
    })
    // Nothing recomputed and nothing changed: the reopened moves are the saved ones.
    expect(reopened.setups[0].operations[1].toolpathMoves).toEqual(lifted.toolpathMoves)
    expect(reopened.setups[0].operations[1].generationFingerprint).toBe(lifted.generationFingerprint)
  }, 300_000)

  it('a project saved before this fix opens with every operation current - nothing recomputes', async () => {
    // The scenario registers the plate's STEP bytes for Open's geometry restore.
    await computeControlAndLifted()
    const fixture = readFileSync(FIXTURE, 'utf8')
    const saved = JSON.parse(fixture) as { project?: Project } & Project
    const savedOps = (saved.project ?? saved).setups[0].operations
    expect(savedOps.map(op => op.status)).toEqual(['ready', 'ready'])
    const reopened = await reopen(fixture)
    expect(verdicts(reopened)).toEqual(savedOps.map(op => ({
      id: op.id, status: 'ready', errorMessage: undefined, current: true,
    })))
    reopened.setups[0].operations.forEach((op, index) => {
      expect(op.generationFingerprint).toBe(savedOps[index].generationFingerprint)
      expect(op.toolpathMoves).toEqual(savedOps[index].toolpathMoves)
    })
  }, 300_000)

  it('a rapid above the resolved traverse plane still marks the lifted finish outdated on reopen', async () => {
    const { stockTopMachineZ } = await computeControlAndLifted()
    await useCamStore.getState().saveProjectToFile()
    const saved = JSON.parse(savedProjectText) as { project?: Project } & Project
    const savedLifted = (saved.project ?? saved).setups[0].operations[1]
    const plane = stockTopMachineZ + 1
    const index = savedLifted.toolpathMoves!.findIndex(m => isRapid(m) && Math.abs(m.z - plane) < EPS)
    expect(index).toBeGreaterThanOrEqual(0)
    savedLifted.toolpathMoves![index] = { ...savedLifted.toolpathMoves![index], z: plane + 0.5 }
    const reopened = await reopen(JSON.stringify(saved))
    expect(verdicts(reopened)[1]).toEqual({
      id: savedLifted.id, status: 'outdated', errorMessage: FIXTURE_UNREADABLE, current: false,
    })
    expect(verdicts(reopened)[0].current).toBe(true)
  }, 300_000)

  it('lifted rapids that miss the resolved plane (a translated path) are not current', async () => {
    await computeControlAndLifted()
    const project = live()
    const setup = project.setups[0]
    const lifted = setup.operations[1]
    // The lifted rapids dropped 0.3 mm (the CAM-17 class): still above
    // Clearance and inside the range, but no longer AT the traverse plane.
    const clearance = lifted.resolvedHeights!.machine.clearance
    const translated = {
      ...lifted,
      toolpathMoves: lifted.toolpathMoves!.map(m => (isRapid(m) && m.z > clearance + EPS ? { ...m, z: m.z - 0.3 } : m)),
    }
    expect(translated.toolpathMoves.some(m => isRapid(m) && m.z > clearance + EPS)).toBe(true)
    expect(operationGenerationIsCurrent(project, setup, lifted)).toBe(true)
    expect(operationGenerationIsCurrent(project, setup, translated)).toBe(false)
  }, 300_000)

  it('a raised stock top or an edited operation still goes outdated', async () => {
    await computeControlAndLifted()
    const before = live()
    const setup = before.setups[0]
    const lifted = setup.operations[1]
    expect(operationGenerationIsCurrent(before, setup, lifted)).toBe(true)

    useCamStore.getState().updateOperation(setup.id, lifted.id, {
      params: { ...lifted.params, stepover: (lifted.params as { stepover?: number }).stepover! + 0.1 },
    } as Partial<Operation>)
    const edited = live()
    expect(operationGenerationIsCurrent(edited, edited.setups[0], edited.setups[0].operations[1])).toBe(false)

    useCamStore.setState({ project: before })
    // The part's own stock (the Stock row's Top offset), raised 2 mm.
    const stockId = before.geometry.find(g => g.id === lifted.geometrySelections[0])!.stockId!
    useCamStore.getState().updateAutoStock(stockId, { autoOffsetZTop: STOCK.offsetZTop + 2 })
    const raised = live()
    const raisedStock = raised.stocks!.find(stock => stock.id === stockId) as { bounds?: { max: { z: number } } }
    expect(raisedStock.bounds!.max.z).toBeCloseTo(lifted.resolvedHeights!.machine.clearance - LOW_CLEARANCE_WCS + 2, 9)
    expect(raised.setups[0].operations[1].status === 'ready'
      && operationGenerationIsCurrent(raised, raised.setups[0], raised.setups[0].operations[1])).toBe(false)
  }, 300_000)
})
