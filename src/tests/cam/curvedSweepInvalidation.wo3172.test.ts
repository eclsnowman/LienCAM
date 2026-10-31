// @vitest-environment jsdom
//
// WO-3231 (WO-3172 Draft D): a curved-path Sweep's path is an input of its
// body. Editing the path changes the body and outdates every CAM consumer of
// it; deleting the path removes the body (never an old shape kept as current)
// and undo brings the same body back on the same binding.
//
// Route: the document is edited through its own CommandHistory, the body is
// rebuilt by the production background replay (modelBodyHoleRecognition.ts ->
// headlessFeatureReplay.ts -> the WO-3228 resolver -> makeSweep), tessellated
// the way the store's own headless replay publishes a body
// (store/headlessModelBodyReplay.ts: progressiveTessellate + GeometryCache +
// modelBodyDisplayFromCached), and handed to the store's real syncModelBodies,
// whose existing rules decide what goes out of date.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))

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
const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { CommandHistory } = await import('../../doc')
const { finalizeSeedArchive, newSeededModelDag } = await import('../../doc/seedModelArchive')
const {
  __setModelBodyHeadlessClientFactoryForTests,
  resolveModelReferencesHeadless,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { BASE_PLANE_XY_NODE_ID, BASE_PLANE_YZ_NODE_ID } = await import('../../doc/genesis')
const { EditFeaturePayloadCommand } = await import('../../components/model3d/dialogs/EditFeaturePayloadCommand')
const { GeometryCache } = await import('../../viewport3d')
const { progressiveTessellate } = await import('../../viewport3d/progressiveTessellate')
const { modelBodyDisplayFromCached } = await import('../../viewport3d/modelBodyDisplay')
const { modelBodyGeometryFingerprint } = await import('../../lib/cam/modelBodyFingerprint')

import type { GeomClient } from '../../geom'
import type { OpResult, SweepRequest } from '../../geom/geom-service'
import type { FeatureDag } from '../../doc'
import type { DerivedModelBody } from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry, Operation } from '../../types'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const QUARTER_TUBE_MM3 = 394.7841760435743
const BODY = 'F1'
const PATH_SKETCH = 'sketch3d:P1'
const PROFILE_SKETCH = 'sketch3d:S1'

const arc = (id: string, [cx, cy]: number[], radius: number, startAngle: number, endAngle: number): SketchEntity =>
  ({ id, kind: 'arc', construction: false, center: { x: cx, y: cy }, radius, startAngle, endAngle }) as SketchEntity
const sketchOf = (id: string, entities: SketchEntity[]): Sketch =>
  ({ id, layerId: 'L1', constraints: [], dimensions: [], solveStatus: null, entities }) as unknown as Sketch

/** Quarter arc on XY from the origin heading +X; radius 20 unless edited. */
const quarter = (radius: number): SketchEntity => arc('pa0', [0, radius], radius, -Math.PI / 2, 0)

function curvedSweepDag(): FeatureDag {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: PROFILE_SKETCH, kind: 'sketch', consumes: [BASE_PLANE_YZ_NODE_ID], refs: [],
    payload: {
      sketch: sketchOf('S1', [{ id: 'S1c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 2 } as SketchEntity]),
      planeNodeId: BASE_PLANE_YZ_NODE_ID,
    },
  })
  dag.insertNode({
    id: PATH_SKETCH, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: { sketch: sketchOf('P1', [quarter(20)]), planeNodeId: BASE_PLANE_XY_NODE_ID },
  })
  dag.insertNode({
    id: BODY, kind: 'feature', consumes: [PROFILE_SKETCH, PATH_SKETCH], refs: [],
    payload: {
      opType: 'sweep', sketchId: PROFILE_SKETCH, profileSelector: { kind: 'whole-sketch' },
      axis: 'z', length: 12, orientation: 'frenet', name: 'Sweep F1',
      path: { kind: 'sketch-chain', sketchId: PATH_SKETCH, steps: [{ entityId: 'pa0', forward: true }] },
    },
  })
  return dag
}

/** The path sketch with its curves replaced, as a sketch edit records it. */
function editPath(dag: FeatureDag, entities: SketchEntity[]): InstanceType<typeof EditFeaturePayloadCommand> {
  const node = dag.getNode(PATH_SKETCH)!
  return new EditFeaturePayloadCommand(PATH_SKETCH, { ...node.payload, sketch: sketchOf('P1', entities) })
}

/** What the last background replay built for the sweep, tessellated before its kernel goes away. */
let lastBuilt: { volume: number; derived: DerivedModelBody } | null = null
let sweepCalls = 0
function publishingHeadlessClient(): GeomClient {
  const client = createLocalGeomService()
  const makeSweep = client.makeSweep.bind(client)
  client.makeSweep = async (req: SweepRequest): Promise<OpResult> => {
    sweepCalls++
    const r = await makeSweep(req)
    if (r.ok && r.body !== undefined && req.featureId === BODY) {
      const cache = new GeometryCache()
      try {
        await progressiveTessellate(client, cache, BODY, r.body)
        const cached = cache.get(BODY)!
        lastBuilt = {
          volume: (await client.measure(r.body, 'volume')).value,
          derived: { bodyId: BODY, version: cached.version, stableIds: [...cached.faceIds, ...cached.edgeIds], display: modelBodyDisplayFromCached(cached) },
        }
      } finally {
        cache.disposeAll()
      }
    }
    return r
  }
  return client
}

/** Rebuild the held document in the background and publish the result to the
 *  store: the body when it rebuilt, nothing (the body is gone) when it did not. */
async function rebuildAndSync(dag: FeatureDag): Promise<{ rebuilt: boolean; reason?: string }> {
  stashLoadedDocument(finalizeSeedArchive(dag))
  lastBuilt = null
  let reason: string | undefined
  try {
    await resolveModelReferencesHeadless('legacy', new Map([[BODY, []]]))
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  const rebuilt = reason === undefined && lastBuilt !== null
  useCamStore.getState().syncModelBodies({
    live: rebuilt ? [{ bodyId: BODY, name: 'Tube' }] : [],
    derived: rebuilt ? [lastBuilt!.derived] : [],
  })
  return { rebuilt, reason }
}

function op(id: string, geometryId: string, extra: Record<string, unknown> = {}): Operation {
  return {
    id, name: id, type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: {
      clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    params: { geometryId, loopIds: [] },
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }],
    ...extra,
  } as unknown as Operation
}

const modelRow = (): ImportedGeometry | undefined => useCamStore.getState().project.geometry.find((g) => g.modelBody?.ref.bodyId === BODY)
const opById = (id: string): Operation => useCamStore.getState().project.setups.flatMap((s) => s.operations).find((o) => o.id === id)!

/** Bind the three kinds of consumer to the body's row: a whole-body operation,
 *  a face-picked operation, and a tracked section on the row. */
function bindConsumers(sideFace: string): string {
  const row = modelRow()!
  const ref = row.modelBody!.ref
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: s.project.geometry.map((g) => g.id !== row.id ? g : {
        ...g,
        layers2d: [{
          id: 'section-1', name: 'Section z=0', color: '#ff8c00', visible: true, derived: true,
          sectionSource: { bodyId: ref.bodyId, lineageId: ref.lineageId, geometryFingerprint: modelBodyGeometryFingerprint(row.modelBody!.display!) },
        }],
      } as ImportedGeometry),
      setups: [{
        id: 'setup-1', name: 'Setup 1',
        operations: [
          op('op-whole', row.id),
          op('op-face', row.id, { modelReferences: [{ bodyId: BODY, stableIds: [sideFace], role: 'machining-boundary' }] }),
        ],
        wcs: {
          id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        },
        stock: null, notes: '',
      } as never],
      activeSetupId: 'setup-1',
    },
  }))
  return row.id
}

const sectionStale = (): boolean | undefined => modelRow()?.layers2d?.find((l) => l.id === 'section-1')?.sectionStale

beforeEach(() => {
  mem.clear()
  lastBuilt = null
  sweepCalls = 0
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
  __setModelBodyHeadlessClientFactoryForTests(publishingHeadlessClient)
})

afterEach(() => {
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
})

describe('WO-3231: path edits outdate the curved sweep body and its consumers', () => {
  it('path edit invalidates body face section and whole-body operation consumers', async () => {
    const dag = curvedSweepDag()
    const history = new CommandHistory(dag)
    const first = await rebuildAndSync(dag)
    expect(first.reason, 'the curved sweep rebuilds').toBeUndefined()
    expect(lastBuilt!.volume).toBeCloseTo(QUARTER_TUBE_MM3, 6)
    const sideFace = lastBuilt!.derived.stableIds.find((id) => id.endsWith('S1cxpa0:side'))
    expect(sideFace, `the side face is named by profile x path entity (${lastBuilt!.derived.stableIds.join(', ')})`).toBeDefined()
    const rowId = bindConsumers(sideFace!)
    const versionBefore = modelRow()!.modelBody!.ref.version

    // An unchanged replay leaves every consumer as it was.
    await rebuildAndSync(dag)
    expect(opById('op-whole').status).toBe('ready')
    expect(opById('op-face').status).toBe('ready')
    expect(sectionStale() ?? false).toBe(false)

    // Edit the path: the arc grows to R 30.
    history.execute(editPath(dag, [quarter(30)]))
    const edited = await rebuildAndSync(dag)
    expect(edited.reason, 'the edited path rebuilds').toBeUndefined()
    expect(lastBuilt!.volume, 'the body follows the edited path').toBeCloseTo(Math.PI * 4 * (Math.PI * 30 / 2), 6)
    const row = modelRow()!
    expect(row.id, 'same row, same binding').toBe(rowId)
    expect(row.modelBody!.ref.version, 'the body changed').toBeGreaterThan(versionBefore)
    expect(row.modelBody!.ref.stableIds, 'the side face keeps its name across the edit').toContain(sideFace)
    expect(opById('op-whole').status, 'whole-body operation').toBe('outdated')
    expect(opById('op-face').status, 'face-picked operation').toBe('outdated')
    expect(sectionStale(), 'tracked section').toBe(true)
    // Retained toolpaths stay available under the existing rules.
    expect(opById('op-whole').toolpathMoves).toHaveLength(1)
    expect(opById('op-face').toolpathMoves).toHaveLength(1)
  }, 120_000)

  it('path deletion and undo remove and restore the same body binding without silent replacement', async () => {
    const dag = curvedSweepDag()
    const history = new CommandHistory(dag)
    const first = await rebuildAndSync(dag)
    expect(first.reason, 'the curved sweep rebuilds').toBeUndefined()
    expect(lastBuilt, 'the background replay built the sweep').not.toBeNull()
    const before = lastBuilt!
    const sideFace = before.derived.stableIds.find((id) => id.endsWith('S1cxpa0:side'))!
    const rowId = bindConsumers(sideFace)

    // Delete the path's curve (another, unrelated line stays in the sketch):
    // the sweep cannot follow a deleted curve and builds nothing.
    history.execute(editPath(dag, [{ id: 'px', kind: 'line', construction: false, start: { x: 50, y: 0 }, end: { x: 60, y: 0 } } as SketchEntity]))
    const callsBefore = sweepCalls
    const deleted = await rebuildAndSync(dag)
    expect(deleted.rebuilt, 'no body without its path').toBe(false)
    expect(sweepCalls, 'nothing is swept along the stored axis instead').toBe(callsBefore)
    expect(deleted.reason).toMatch(/sweep path \(missing-entity\)/)
    expect(modelRow(), 'the old shape is not kept as a current body').toBeUndefined()
    expect(useCamStore.getState().project.geometry.some((g) => g.format === 'model'), 'no other body takes its place').toBe(false)
    for (const id of ['op-whole', 'op-face']) {
      expect(opById(id).params.geometryId, `${id} is not rebound to anything else`).toBe(rowId)
      expect(opById(id).status, `${id} after the path is deleted`).not.toBe('ready')
    }

    // Undo: the same body comes back on the same row, under the same names.
    history.undo()
    const restored = await rebuildAndSync(dag)
    expect(restored.reason).toBeUndefined()
    expect(lastBuilt!.volume).toBeCloseTo(QUARTER_TUBE_MM3, 6)
    expect(lastBuilt!.derived.stableIds).toEqual(before.derived.stableIds)
    const row = modelRow()
    expect(row?.id, 'the restored body is the row the operations bind').toBe(rowId)
    expect(row!.modelBody!.ref.stableIds).toContain(sideFace)
    for (const id of ['op-whole', 'op-face']) expect(opById(id).params.geometryId).toBe(rowId)
  }, 120_000)
})
