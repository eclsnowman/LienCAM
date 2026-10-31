// @vitest-environment jsdom
//
// WO-3234: CAM uses the real Thin body. Switching an extrude to Thin changes
// the body CAM sees -- a new geometry fingerprint, every bound operation and
// tracked section outdated, the wall faces available as targets under their
// thin names -- while a name-only edit of the same feature changes nothing
// CAM depends on. Undo brings the solid back on the same row.
//
// Route (same as WO-3231's sweep test): the document is edited through its
// own CommandHistory, rebuilt by the production background replay
// (modelBodyHoleRecognition.ts -> headlessFeatureReplay.ts -> makeExtrude),
// tessellated the way the store's headless replay publishes a body, and handed
// to the store's real syncModelBodies, whose existing rules decide what goes
// out of date.

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
const { BASE_PLANE_XY_NODE_ID } = await import('../../doc/genesis')
const { EditFeaturePayloadCommand } = await import('../../components/model3d/dialogs/EditFeaturePayloadCommand')
const { GeometryCache } = await import('../../viewport3d')
const { progressiveTessellate } = await import('../../viewport3d/progressiveTessellate')
const { modelBodyDisplayFromCached } = await import('../../viewport3d/modelBodyDisplay')
const { modelBodyGeometryFingerprint } = await import('../../lib/cam/modelBodyFingerprint')

import type { GeomClient } from '../../geom'
import type { ExtrudeRequest, OpResult } from '../../geom/geom-service'
import type { FeatureDag } from '../../doc'
import type { DerivedModelBody } from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry, Operation } from '../../types'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const BODY = 'F1'
const SKETCH = 'sketch3d:S1'

const sketchOf = (entities: SketchEntity[]): Sketch =>
  ({ id: 'S1', layerId: 'L1', constraints: [], dimensions: [], solveStatus: null, entities }) as unknown as Sketch

const RECT: SketchEntity[] = [
  { id: 'r0', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
  { id: 'r1', kind: 'line', construction: false, start: { x: 40, y: 0 }, end: { x: 40, y: 20 } },
  { id: 'r2', kind: 'line', construction: false, start: { x: 40, y: 20 }, end: { x: 0, y: 20 } },
  { id: 'r3', kind: 'line', construction: false, start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
] as SketchEntity[]

function solidDag(): FeatureDag {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: SKETCH, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: { sketch: sketchOf(RECT), planeNodeId: BASE_PLANE_XY_NODE_ID },
  })
  dag.insertNode({
    id: BODY, kind: 'feature', consumes: [SKETCH], refs: [],
    payload: {
      opType: 'extrude', sketchId: SKETCH, profileSelector: { kind: 'whole-sketch' },
      distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', wallMode: 'solid', name: 'Extrude F1',
    },
  })
  return dag
}

/** The dialog's edit Apply: one EditFeaturePayloadCommand over the node's payload. */
function edit(dag: FeatureDag, fields: Record<string, unknown>): InstanceType<typeof EditFeaturePayloadCommand> {
  const node = dag.getNode(BODY)!
  return new EditFeaturePayloadCommand(BODY, { ...node.payload, ...fields }, node.consumes)
}

/** What the last background replay built for the extrude, tessellated before its kernel goes away. */
let lastBuilt: { volume: number; thin: ExtrudeRequest['thin']; derived: DerivedModelBody } | null = null
function publishingHeadlessClient(): GeomClient {
  const client = createLocalGeomService()
  const makeExtrude = client.makeExtrude.bind(client)
  client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
    const r = await makeExtrude(req)
    if (r.ok && r.body !== undefined && req.featureId === BODY) {
      const cache = new GeometryCache()
      try {
        await progressiveTessellate(client, cache, BODY, r.body)
        const cached = cache.get(BODY)!
        lastBuilt = {
          volume: (await client.measure(r.body, 'volume')).value,
          thin: req.thin,
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
    live: rebuilt ? [{ bodyId: BODY, name: 'Plate' }] : [],
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
const fingerprint = (): string => modelBodyGeometryFingerprint(modelRow()!.modelBody!.display!)

beforeEach(() => {
  mem.clear()
  lastBuilt = null
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
  __setModelBodyHeadlessClientFactoryForTests(publishingHeadlessClient)
})

afterEach(() => {
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
})

describe('WO-3234: CAM derives from the real Thin body', () => {
  it('a name-only edit leaves CAM current; switching to Thin outdates it and exposes the thin walls', async () => {
    const dag = solidDag()
    const history = new CommandHistory(dag)
    expect((await rebuildAndSync(dag)).reason).toBeUndefined()
    expect(lastBuilt!.volume).toBeCloseTo(6400, 6)
    expect(lastBuilt!.thin).toBeUndefined()
    const sideFace = lastBuilt!.derived.stableIds.find((id) => id === `${BODY}:XTR:r0:side`)
    expect(sideFace, `the r0 side face of the solid (${lastBuilt!.derived.stableIds.join(', ')})`).toBeDefined()
    const rowId = bindConsumers(sideFace!)
    const solidPrint = fingerprint()

    // Rename only: the same geometry, nothing outdated.
    history.execute(edit(dag, { name: 'Plate frame' }))
    expect((await rebuildAndSync(dag)).reason).toBeUndefined()
    expect(fingerprint()).toBe(solidPrint)
    expect(opById('op-whole').status).toBe('ready')
    expect(opById('op-face').status).toBe('ready')
    expect(sectionStale() ?? false).toBe(false)

    // Thin, inside, 2 mm: the exact wall, a new fingerprint, every consumer outdated.
    history.execute(edit(dag, { wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }))
    expect((await rebuildAndSync(dag)).reason).toBeUndefined()
    expect(lastBuilt!.thin).toEqual({ thickness: 2, side: 'inside' })
    expect(lastBuilt!.volume, 'the body CAM sees is the thin wall').toBeCloseTo(1792, 6)
    const row = modelRow()!
    expect(row.id, 'same row, same binding').toBe(rowId)
    expect(fingerprint()).not.toBe(solidPrint)
    expect(opById('op-whole').status, 'whole-body operation').toBe('outdated')
    expect(opById('op-face').status, 'face-picked operation').toBe('outdated')
    expect(sectionStale(), 'tracked section').toBe(true)
    // A CAM target on the thin body: the r0 wall's two faces under their thin names.
    expect(row.modelBody!.ref.stableIds).toContain(`${BODY}:XTR:r0:thinIn`)
    expect(row.modelBody!.ref.stableIds).toContain(`${BODY}:XTR:r0:thinOut`)
    expect(row.modelBody!.ref.stableIds).not.toContain(sideFace)

    // Undo the Thin edit: the solid comes back on the same row with its fingerprint.
    history.undo()
    expect((await rebuildAndSync(dag)).reason).toBeUndefined()
    expect(lastBuilt!.volume).toBeCloseTo(6400, 6)
    expect(modelRow()!.id).toBe(rowId)
    expect(fingerprint()).toBe(solidPrint)
    expect(modelRow()!.modelBody!.ref.stableIds).toContain(sideFace)
  }, 120_000)

  it('changing only the side of a Thin wall changes the body CAM sees', async () => {
    const dag = solidDag()
    const history = new CommandHistory(dag)
    history.execute(edit(dag, { wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }))
    expect((await rebuildAndSync(dag)).reason).toBeUndefined()
    const inside = fingerprint()
    history.execute(edit(dag, { wallSide: 'outside' }))
    expect((await rebuildAndSync(dag)).reason).toBeUndefined()
    expect(lastBuilt!.volume).toBeCloseTo(2048, 6)
    expect(fingerprint()).not.toBe(inside)
  }, 120_000)
})
