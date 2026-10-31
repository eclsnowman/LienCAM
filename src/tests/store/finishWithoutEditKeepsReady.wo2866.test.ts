// @vitest-environment jsdom
//
// WO-2866 (the operator's sweep H6, 2026-10-16): open a project whose operations are
// ready, open its model, press Finish without changing anything - the
// operations turned Outdated. Opening the model replays its whole history, so
// the Model workbench's regen writer (syncModelBodies) receives every body
// re-derived with a fresh version, and every re-derived body counted as
// "changed": each operation cutting it went amber. Nothing changed, so nothing
// is outdated; a real edit still outdates exactly the operations on that body.
//
// Driven through the production store: syncModelBodies with the payload the
// workbench's syncCamModelBodies builds (same tessellation, fresh version - what
// a replay of an unedited document produces), saveProjectToFile ->
// loadProjectFromFile, enterModelWorkspace and finishModelItem.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's localStorage is broken under vitest's node launch flags; the store's
// persist() writes on every set() (same shim as setupOriginStaysOnModelFinish.wo2271).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage, registerLiveDocument } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { FeatureDag } = await import('../../doc/dag')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')
const { operationGenerationIsCurrent, projectOperationFingerprint } = await import('../../lib/cam/generationFingerprint')
const { buildPostInput } = await import('../../lib/post/buildPostInput')
const { validateOpsCurrent } = await import('../../lib/post/validate')
const { setModelBodyHoleRecognizer } = await import('../../lib/cam/modelBodyHoleRecognition')

import type { ModelBodyDisplay, Operation, Setup, Tool } from '../../types'

const state = () => useCamStore.getState()

/** A closed 40 x 30 box tessellation, `h` tall - the shape an extrude regenerates. */
function boxDisplay(h: number): ModelBodyDisplay {
  const positions = [
    0, 0, 0, 40, 0, 0, 40, 30, 0, 0, 30, 0,
    0, 0, h, 40, 0, h, 40, 30, h, 0, 30, h,
  ]
  // Outward-wound: bottom, top, then the four sides.
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]
  return {
    positions,
    normals: positions.map((_, i) => (i % 3 === 2 ? 1 : 0)),
    indices,
    edgePositions: [0, 0, h, 40, 0, h, 40, 30, h, 0, 30, h],
    edgeOffsets: [0, 4],
    bbox: { min: [0, 0, 0], max: [40, 30, h] },
    faceIds: ['F1:XTR:bottom', 'F1:XTR:top', 'F1:XTR:side'],
    triFace: [0, 0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2],
    edgeIds: ['F1:XTR:top-edge'],
  }
}

/** What the mounted Model workbench holds for the item: one extrude F1, `h` tall. */
function mountModel(modelItemId: string, height: number): void {
  registerLiveDocument(() => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height } })
    return { dag, elementMapDeltas: [] }
  }, modelItemId)
}

let version = 0
/** The Model workbench's regen writer, exactly as a pass that re-executed F1 calls it. */
function regenModel(modelItemId: string, height: number): void {
  version += 1
  state().syncModelBodies({
    live: [{ bodyId: 'F1', lineageId: 'F1', name: 'Block' }],
    derived: [{
      bodyId: 'F1', lineageId: 'F1', version,
      stableIds: ['F1:XTR:bottom', 'F1:XTR:top', 'F1:XTR:side', 'F1:XTR:top-edge'],
      display: boxDisplay(height),
    }],
    modelItemId,
  })
}

const endmill: Tool = {
  id: 'wo2866-em-6', name: '6mm EM', type: 'flat_end_mill', diameter: 6, toolNumber: 1,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
} as Tool

const drillTool: Tool = {
  ...endmill, id: 'wo2866-drill-5', name: '5mm drill', type: 'drill', diameter: 5, toolNumber: 2,
} as Tool

/** The Model kernel's hole recognition for F1: one 5 mm blind hole in its top
 *  face (no kernel in jsdom; the drill compute's recognizer seam). */
const HOLE_VERDICTS = [{
  featureKey: 'hole:20:15:10:0:0:1:5', featureClass: 'blindHole', removable: true,
  effect: 'add', faceIds: ['F1:XTR:top'], neighbourIds: [],
  params: { diameter: 5, depth: 5, centerX: 20, centerY: 15, centerZ: 10, axisX: 0, axisY: 0, axisZ: 1 },
}]

function readyOp(id: string, type: 'contour_2d' | 'adaptive_clearing_2d' | 'drill', geometryId: string): Operation {
  return stampSmartHeightAuthority({
    id, name: id, type, enabled: true, status: 'pending',
    toolId: type === 'drill' ? drillTool.id : endmill.id, geometrySelections: [],
    ...(type === 'drill'
      ? { modelReferences: [{ bodyId: 'F1', stableIds: ['F1:XTR:top'], role: 'drill-targets' }] }
      : {}),
    heights: {
      clearanceHeight: 40, clearanceHeightMode: 'absolute',
      retractHeight: 30, feedHeight: 20, topHeight: 10, topHeightMode: 'absolute',
      bottomHeight: 0, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: type === 'contour_2d'
      ? { geometryId, loopIds: [] }
      : type === 'drill'
      ? {
          geometryId, loopIds: [], cycleType: 'simple', peckDepth: 2,
          chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
        }
      : {
          geometryId, loopIds: [], boundarySource: 'geometry',
          targetEngagement: 0.4, maxEngagement: 0.7, stepDistance: 0.4,
          thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
        },
  } as unknown as Operation, { geometryIds: [geometryId] })
}

const ops = (): Operation[] => state().project.setups.flatMap((s) => s.operations)
const opSnapshot = () => ops().map((o) => ({
  id: o.id, status: o.status, params: o.params, toolpathMoves: o.toolpathMoves,
  modelReferenceNote: o.modelReferenceNote,
}))

/** Model tab -> build F1 -> Finish, then three ready operations cutting the body.
 *  `beforeCompute` runs after the body exists and before the operations compute. */
async function buildProjectWithReadyOps(beforeCompute?: (itemId: string) => void): Promise<string> {
  await state().enterModelWorkspace()
  const itemId = state().activeModelItemId!
  expect(itemId).toBeTruthy()
  mountModel(itemId, 10)
  regenModel(itemId, 10)
  await state().finishModelItem()
  expect(state().workspace).toBe('cam')
  const row = state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')!
  expect(row).toBeDefined()
  useCamStore.setState((s) => ({
    toolLibrary: [endmill, drillTool, ...s.toolLibrary],
    project: {
      ...s.project,
      setups: [{
        id: 'setup-wo2866', name: 'Setup 1',
        wcs: {
          id: 'wcs-wo2866', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          stockId: DERIVED_STOCK_ID,
        },
        stock: {
          type: 'rectangular', width: 100, height: 100, depth: 12,
          offsetX: 2, offsetY: 2, offsetZTop: 5, offsetZBottom: 0, material: 'al',
        },
        notes: '',
        operations: [
          readyOp('op-contour', 'contour_2d', row.id),
          readyOp('op-adaptive', 'adaptive_clearing_2d', row.id),
          readyOp('op-drill', 'drill', row.id),
        ],
      } as unknown as Setup],
      activeSetupId: 'setup-wo2866',
    },
  }))
  beforeCompute?.(itemId)
  await state().computeAllToolpaths()
  expect(ops().map((o) => [o.status, o.errorMessage])).toEqual([['ready', undefined], ['ready', undefined], ['ready', undefined]])
  expectResultsCurrent()
  return itemId
}

/** What Post reads (buildPostInput -> operationGenerationIsCurrent ->
 *  validateOpsCurrent): every ready operation's saved generation stamp must
 *  still equal the fingerprint of the project as it now stands. */
function freshness() {
  const s = state()
  const project = { ...s.project, toolLibrary: s.toolLibrary }
  const setup = project.setups[0]
  return {
    ops: setup.operations.map((op) => ({
      id: op.id,
      current: operationGenerationIsCurrent(project, setup, op),
      stampMatches: op.resolvedHeights !== undefined &&
        op.generationFingerprint === projectOperationFingerprint(project, setup, op, op.resolvedHeights),
    })),
    postDiagnostics: validateOpsCurrent(buildPostInput(project, setup).setup.operations).map((d) => d.code),
  }
}

function expectResultsCurrent(): void {
  expect(freshness()).toEqual({
    ops: ['op-contour', 'op-adaptive', 'op-drill'].map((id) => ({ id, current: true, stampMatches: true })),
    postDiagnostics: [],
  })
}

const ITEM_B = 'wo2866-model-B'
const ROW_B = 'modelbody:wo2866-model-B:F1'

/** A second Model Item whose own body is also `F1` (body ids are local to an
 *  item), the same 40 x 30 x 10 block, at version 99. */
function addSecondItemWithSameBodyId(itemA: string): void {
  const rowA = state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')!
  const rowB = { ...structuredClone(rowA), id: ROW_B, modelItemId: ITEM_B }
  rowB.modelBody!.ref.version = 99
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      modelItems: [...(s.project.modelItems ?? []), { ...s.project.modelItems!.find((m) => m.id === itemA)!, id: ITEM_B }],
      modelItemPlacements: [
        ...(s.project.modelItemPlacements ?? []),
        { modelItemId: ITEM_B, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      ],
      geometry: [...s.project.geometry, rowB],
    },
  }))
}

const rowOf = (id: string) => state().project.geometry.find((g) => g.id === id)

const bodyVersion = () => state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')?.modelBody?.ref.version

/** The CAM viewport's own redraw key, lifted verbatim from Viewport.tsx (its
 *  model-body redraw effect depends on this key alone): a changed display whose
 *  key did not change is never pushed to the viewport. */
const modelBodiesKey: (s: unknown) => string = (() => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/viewport/Viewport.tsx'), 'utf8')
  const head = 'const modelBodiesKey = useCamStore(s => {'
  const start = src.indexOf(head)
  const end = src.indexOf('\n  })', start)
  if (start < 0 || end < 0) throw new Error('Viewport modelBodiesKey selector not found')
  return new Function('s', src.slice(start + head.length, end)) as (s: unknown) => string
})()

let savedProjectText = ''

/** Save, close and reopen through the production file path. */
async function saveCloseReopen(): Promise<void> {
  await state().saveProjectToFile()
  expect(savedProjectText).not.toBe('')
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.setState(useCamStore.getInitialState(), true)
  await state().loadProjectFromFile(savedProjectText)
}

// The toolpath worker answers every compute with a fixed two-move path: this
// order is about which statuses Finish leaves, not about the toolpath engine.
let originalWorker: typeof Worker | undefined
const MOVES = [
  { type: 'rapid', x: 0, y: 0, z: 40 },
  { type: 'feed', x: 40, y: 0, z: 5, feedRate: 800 },
]

beforeEach(() => {
  originalWorker = globalThis.Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage(data: { type: string; payload: { opId: string } } | { request: unknown }): void {
      // The off-page post-process worker (store/toolpathPostprocess.ts): report
      // "cannot start a module worker" so it runs its own in-page fallback.
      if ('request' in data) {
        queueMicrotask(() => this.onerror?.({ preventDefault() {} } as unknown as ErrorEvent))
        return
      }
      queueMicrotask(() => this.onmessage?.({
        data: { type: 'TOOLPATH_COMPLETE', opId: data.payload.opId, moves: MOVES, computeTimeMs: 1 },
      } as MessageEvent))
    }
    terminate(): void { /* no-op */ }
    addEventListener(): void { /* no-op */ }
    removeEventListener(): void { /* no-op */ }
  }
  setModelBodyHoleRecognizer(async () => HOLE_VERDICTS as never)
  mem.clear()
  version = 0
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  state().newProject()
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-2866.camproject'
    },
  })
})

afterEach(() => {
  setModelBodyHoleRecognizer(null)
  ;(globalThis as { Worker?: unknown }).Worker = originalWorker
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

describe('WO-2866: Finish without an edit leaves the operations ready', () => {
  it('reopened project: open the model, Finish with no edit - every operation stays ready with identical results', async () => {
    const itemId = await buildProjectWithReadyOps()
    await saveCloseReopen()
    expect(ops().map((o) => o.status)).toEqual(['ready', 'ready', 'ready'])
    expectResultsCurrent()
    const before = opSnapshot()
    const versionBefore = bodyVersion()

    await state().enterModelWorkspace()
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(itemId)
    // Opening the model replays every feature: F1 comes back re-derived, unchanged.
    mountModel(itemId, 10)
    regenModel(itemId, 10)
    await state().finishModelItem()
    expect(state().workspace).toBe('cam')

    expect(opSnapshot()).toEqual(before)
    expect(ops().map((o) => o.status)).toEqual(['ready', 'ready', 'ready'])
    // Nothing changed, so the results are still current: Post has nothing to recompute.
    expectResultsCurrent()
    expect(bodyVersion()).toBe(versionBefore)
  })

  it('same session: a second open + Finish with no edit keeps the operations ready', async () => {
    const itemId = await buildProjectWithReadyOps()
    const before = opSnapshot()
    const versionBefore = bodyVersion()

    await state().enterModelWorkspace()
    regenModel(itemId, 10)
    await state().finishModelItem()

    expect(opSnapshot()).toEqual(before)
    expectResultsCurrent()
    expect(bodyVersion()).toBe(versionBefore)
  })

  it('control: a real edit still outdates the operations that cut the edited body', async () => {
    const itemId = await buildProjectWithReadyOps()
    await saveCloseReopen()

    const versionBefore = bodyVersion()
    await state().enterModelWorkspace()
    mountModel(itemId, 10)
    regenModel(itemId, 10) // the replay on open: nothing changed
    mountModel(itemId, 14)
    regenModel(itemId, 14) // the operator extrudes F1 taller
    await state().finishModelItem()

    expect(bodyVersion()).toBeGreaterThan(versionBefore!)
    expect(ops().map((o) => o.status)).toEqual(['outdated', 'outdated', 'outdated'])
    for (const op of ops()) {
      expect(op.modelReferenceNote).toBeTruthy()
      expect(op.toolpathMoves).toHaveLength(2) // last-known toolpath kept (S5c ruling)
    }
    for (const op of ops().filter((o) => o.type !== 'drill')) {
      expect(op.modelReferenceNote).toMatch(/modeled part this operation cuts changed/i)
    }
    // The edited body's results are no longer current, and Post says so.
    const f = freshness()
    expect(f.ops.map((o) => [o.current, o.stampMatches])).toEqual([[false, false], [false, false], [false, false]])
    expect(f.postDiagnostics).toEqual(['OP_OUTDATED', 'OP_OUTDATED', 'OP_OUTDATED'])
  })

  // Fix round 2 (astra audit 2026-10-16): the unchanged-body decision was keyed
  // by the bare body id, so another item's identical F1 matched the edited
  // item's old shape - suppressing the real edit and overwriting that item's version.
  it('two items share body id F1: a real edit in item A outdates its operations and leaves item B untouched', async () => {
    const itemA = await buildProjectWithReadyOps(addSecondItemWithSameBodyId)
    const rowA = state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1' && g.id !== ROW_B)!
    const rowBBefore = structuredClone(rowOf(ROW_B))

    await state().enterModelWorkspace()
    expect(state().activeModelItemId).toBe(itemA)
    mountModel(itemA, 14)
    regenModel(itemA, 14) // the operator extrudes A's F1 taller
    await state().finishModelItem()

    expect(ops().map((o) => o.status)).toEqual(['outdated', 'outdated', 'outdated'])
    expect(rowOf(rowA.id)!.modelBody!.display!.bbox.max[2]).toBe(14)
    expect(rowOf(rowA.id)!.modelBody!.ref.version).toBeGreaterThan(rowA.modelBody!.ref.version)
    expect(rowOf(ROW_B)).toEqual(rowBBefore)
    expect(rowOf(ROW_B)!.modelBody!.ref.version).toBe(99)
  })

  it('two items share body id F1: Finish with no edit in item A keeps every operation ready and current', async () => {
    const itemA = await buildProjectWithReadyOps(addSecondItemWithSameBodyId)
    const before = opSnapshot()
    const versionA = rowOf(state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1' && g.id !== ROW_B)!.id)!.modelBody!.ref.version
    const rowBBefore = structuredClone(rowOf(ROW_B))

    await state().enterModelWorkspace()
    expect(state().activeModelItemId).toBe(itemA)
    mountModel(itemA, 10)
    regenModel(itemA, 10)
    await state().finishModelItem()

    expect(opSnapshot()).toEqual(before)
    expectResultsCurrent()
    expect(state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1' && g.id !== ROW_B)!.modelBody!.ref.version).toBe(versionA)
    expect(rowOf(ROW_B)).toEqual(rowBBefore)
  })

  // Fix round 3 (astra audit 2026-10-16): a reopened document gets a fresh
  // geometry cache whose version counter restarts at 1. Keeping the saved
  // version on the identical replay let the next real edit publish that same
  // version again, so the CAM viewport's redraw key did not change.
  it('reopen at saved version 4, identical replay, then a real edit: the published version and redraw key change', async () => {
    version = 3
    const itemId = await buildProjectWithReadyOps()
    expect(bodyVersion()).toBe(4)
    await saveCloseReopen()
    expect(bodyVersion()).toBe(4)

    await state().enterModelWorkspace()
    version = 0 // the reopened document's fresh cache
    mountModel(itemId, 10)
    regenModel(itemId, 10) // the replay on open: identical, cache version 1
    regenModel(itemId, 10) // progressive tessellation finishes: cache version 2
    expect(bodyVersion()).toBe(4)
    expectResultsCurrent()
    const before = modelBodiesKey(state())

    mountModel(itemId, 14)
    version = 3 // coarse + display tessellation advanced the cache twice
    regenModel(itemId, 14) // the operator's edit lands at cache version 4 - the saved row's version
    await state().finishModelItem()

    expect(state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')!.modelBody!.display!.bbox.max[2]).toBe(14)
    expect(modelBodiesKey(state())).not.toBe(before)
    expect(bodyVersion()).toBeGreaterThan(4)
    expect(ops().map((o) => o.status)).toEqual(['outdated', 'outdated', 'outdated'])
  })

  it('a changed body publishes a version no lower than its cache version', async () => {
    const itemId = await buildProjectWithReadyOps()
    const saved = bodyVersion()!
    await state().enterModelWorkspace()
    version = 40
    mountModel(itemId, 14)
    regenModel(itemId, 14)
    await state().finishModelItem()
    expect(saved).toBeLessThan(41)
    expect(bodyVersion()).toBe(41)
  })
})

// ---------------------------------------------------------------------------
// The mounted Model workbench's own invalidation route (audit 2026-10-16 9:43
// AM, PROOF-MISSING): every fullResync pass ends in reresolveCamModelRefs
// (SolidsWorkbenchPage.tsx), which re-resolves each operation's face/edge
// ModelReferences and, for a body the pass re-executed, used to answer
// "changed" unconditionally - so opening the model (a replay of every feature)
// turned a face-referenced operation Outdated before syncModelBodies ran.
// Driven through the real page, its executor and the fake kernel; the fake's
// tessellation follows the extrude's height, so a real edit is a real change.

const { render, screen, cleanup } = await import('@testing-library/react')
const { createElement } = await import('react')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFeatureCommand } = await import('../../components/model3d/dialogs/createFeatureCommand')
const { EditFeaturePayloadCommand } = await import('../../components/model3d/dialogs/EditFeaturePayloadCommand')
const { waitForLoadedModel3d } = await import('../model3d/loadTolerantWaitFor')
const { createFakeGeomClient } = await import('../model3d/fakeGeomClient')
const { fakeCreateSceneRuntime } = await import('../model3d/fakeSceneRuntime')
const { mintRectangleSketch } = await import('../model3d/mintRectangleSketch')
const { makeBoxTessBuffers } = await import('../../viewport3d/fixtures')
const { COARSE_TESS_QUALITY } = await import('../../viewport3d/tessQuality')

import type { SolidsWorkbenchHooks } from '../../components/model3d'

function workbench(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

const EXTRUDE_F1 = { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Block' }

/** Model tab -> the real page builds extrude F1 -> a contour bound to F1's top
 *  face and a drill on its top face, both computed ready. */
async function mountWithFaceReferencedOps(): Promise<{ itemId: string; setHeight: (h: number) => void }> {
  await state().enterModelWorkspace()
  const itemId = state().activeModelItemId!
  let height = 10
  const client = createFakeGeomClient()
  client.tessellate = async (_h, q) => makeBoxTessBuffers({
    featureId: q.deflection === COARSE_TESS_QUALITY.deflection ? 'FAKECOARSE' : 'FAKEDISPLAY',
    size: { x: 40, y: 20, z: height },
  })
  render(createElement(SolidsWorkbenchPage, { createClient: () => client, createSceneRuntime: fakeCreateSceneRuntime, modelItemId: itemId }))
  await waitForLoadedModel3d(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await mintRectangleSketch()
  await waitForLoadedModel3d(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  workbench().history.execute(createFeatureCommand(workbench().dag, { id: 'F1', kind: 'feature', consumes: ['SK1'], payload: EXTRUDE_F1 }))
  await workbench().fullResync(['F1'])
  await waitForLoadedModel3d(() => expect(state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')?.modelBody?.display).toBeDefined())
  const row = state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')!
  // The face whose every triangle lies at the body's top Z.
  const d = row.modelBody!.display!
  const top = d.bbox.max[2]
  const topFace = (d.faceIds ?? []).find((_, f) => {
    const tris = (d.triFace ?? []).flatMap((tf, t) => (tf === f ? [t] : []))
    return tris.length > 0 && tris.every((t) => [0, 1, 2].every((k) => d.positions[d.indices[t * 3 + k] * 3 + 2] === top))
  })!
  expect(topFace).toBeDefined()
  const contour = { ...readyOp('op-contour', 'contour_2d', row.id), modelReferences: [{ bodyId: 'F1', stableIds: [topFace], role: 'machining-boundary', modelItemId: itemId }] } as Operation
  const drill = { ...readyOp('op-drill', 'drill', row.id), modelReferences: [{ bodyId: 'F1', stableIds: [topFace], role: 'drill-targets', modelItemId: itemId }] } as Operation
  useCamStore.setState((s) => ({
    toolLibrary: [endmill, drillTool, ...s.toolLibrary],
    project: {
      ...s.project,
      setups: [{
        id: 'setup-wo2866', name: 'Setup 1',
        wcs: {
          id: 'wcs-wo2866', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          stockId: DERIVED_STOCK_ID,
        },
        stock: {
          type: 'rectangular', width: 100, height: 100, depth: 12,
          offsetX: 2, offsetY: 2, offsetZTop: 5, offsetZBottom: 0, material: 'al',
        },
        notes: '',
        operations: [contour, drill],
      } as unknown as Setup],
      activeSetupId: 'setup-wo2866',
    },
  }))
  await state().computeAllToolpaths()
  expect(ops().map((o) => [o.id, o.status, o.errorMessage])).toEqual([['op-contour', 'ready', undefined], ['op-drill', 'ready', undefined]])
  expectRefOpsCurrent()
  return { itemId, setHeight: (h) => { height = h } }
}

function expectRefOpsCurrent(): void {
  expect(freshness()).toEqual({
    ops: ['op-contour', 'op-drill'].map((id) => ({ id, current: true, stampMatches: true })),
    postDiagnostics: [],
  })
}

describe('WO-2866: the mounted Model workbench leaves face-referenced operations ready on an edit-free replay', () => {
  afterEach(cleanup)

  it('opening the model replays F1 unchanged, then Finish: the face-referenced operations stay ready, identical and current for Post', async () => {
    await mountWithFaceReferencedOps()
    const before = opSnapshot()

    await workbench().fullResync(['F1']) // opening the model replays every feature
    expect(opSnapshot()).toEqual(before)
    expectRefOpsCurrent()

    await state().finishModelItem()
    expect(state().workspace).toBe('cam')
    expect(opSnapshot()).toEqual(before)
    expectRefOpsCurrent()
  }, 60_000)

  it('control: a real edit of F1 outdates both face-referenced operations', async () => {
    const { setHeight } = await mountWithFaceReferencedOps()
    await workbench().fullResync(['F1'])
    expect(ops().map((o) => o.status)).toEqual(['ready', 'ready'])

    setHeight(20)
    workbench().history.execute(new EditFeaturePayloadCommand('F1', { ...EXTRUDE_F1, distance: 20 }))
    await workbench().fullResync(['F1'])
    await state().finishModelItem()
    expect(ops().map((o) => o.status)).toEqual(['outdated', 'outdated'])
  }, 60_000)
})
