// @vitest-environment jsdom
//
// WO-1413 (BUG-465 family K2): a model body's saved Section/projection snapshot
// (layers2d/loops/loopsVersion) must survive delete-then-undo of the feature
// that produced its body -- and ONLY that. A body arriving under the same
// feature id for any other reason starts plain.
//
// THE DEFECT (verified on main). syncModelBodies drops a model-body CAM row the
// instant its body stops being live, through a plain set() that never calls
// pushHistory (a model-body sync reflects the Model document, it is not a CAM
// user edit -- store/index.ts's own comment on that writer). The Model
// workbench's Undo restores the deleted DAG feature through its OWN
// CommandHistory, entirely separate from CAM's undo stacks, so by the time the
// body regenerates project.geometry has no row left for it and
// reconcileModelBodies' ADD path builds a blank one.
//
// WHY THE IDENTITY GATE IS THE HISTORY AND NOTHING ELSE (two audit FAILs,
// 2026-09-15). `nextId` re-mints the LOWEST FREE feature id, a root feature's
// lineage id IS its feature id, and stable ids are DERIVED NAMES built from
// feature id + operation + sketch entity (src/doc/stable-id.ts) rather than
// shape fingerprints. So a new feature created after a delete can reproduce the
// deleted body's lineage id AND its entire stable-id set. These tests therefore
// give the re-created bodies the SAME sketch, the SAME operation and the SAME
// derived ids as the deleted one -- a gate that reads any of them hands over the
// deleted body's Section and turns this file red.
//
// Driven through the REAL store action (syncModelBodies) against a REAL
// FeatureDag + CommandHistory + InsertNodeCommand/RemoveNodeCommand + nextId,
// with the live document reachable exactly as production reaches it
// (window.__solidsWorkbenchHooks, installed by SolidsWorkbenchPage on mount).
// Tier 2 desk, per the WO's own evidence tier.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Project, ImportedGeometry, ModelBodyDisplay } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
import { CommandHistory, FeatureDag, InsertNodeCommand, RemoveNodeCommand } from '../../doc'
import {
  bodyFeatureIds,
  featureLabel,
  liveBodyFeatureIds,
  projectBodyLineages,
} from '../../components/model3d/bodyLineage'
import { nextId } from '../../components/model3d/dialogs/nextId'
import { typedMock } from '../support/typedMock'

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

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

function display(tag = 0): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}

function makeProject(): Project {
  return {
    id: 'p1', name: 'WO-1413 Undo Section Survival', version: '1.0.0',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000, maxSpindleRpm: 24000,
      minSpindleRpm: 8000, spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
  } as Project
}

const modelRow = (): ImportedGeometry | undefined =>
  useCamStore.getState().project.geometry.find((g) => g.format === 'model')

// ---------------------------------------------------------------------------
// A live Model document, driven the way the workbench drives it.
// ---------------------------------------------------------------------------

let dag: FeatureDag
let history: CommandHistory
let tessVersion = 0

/** Install the live document on the production seam the store reads (the same
 *  one modelBodyHoleRecognition.ts reads the live kernel through). */
function mountWorkbench(): void {
  dag = new FeatureDag()
  history = new CommandHistory(dag)
  ;(window as unknown as Record<string, unknown>).__solidsWorkbenchHooks = { dag, history }
}

/** Stable ids as the kernel really names them: feature id + operation + sketch
 *  entity (`F1:XTR:S1-e0:side`). Deliberately reproducible by a re-created
 *  feature that reuses the id and the sketch -- that is the audited hazard. */
function stableIdsFor(bodyId: string, sketchId: string): string[] {
  return [`${bodyId}:XTR:${sketchId}:capStart`, `${bodyId}:XTR:${sketchId}-e0:side`]
}

/** Create an extrude feature through history, minting its id with nextId --
 *  which hands out the LOWEST FREE id, so this reuses a deleted feature's id. */
function createExtrude(sketchId: string, name: string): string {
  if (!dag.has(sketchId)) dag.insertNode({ id: sketchId, kind: 'sketch', payload: {} })
  const id = nextId(dag, 'F')
  history.execute(new InsertNodeCommand({
    id,
    kind: 'feature',
    consumes: [sketchId],
    payload: { opType: 'extrude', name, sketchId },
  }))
  return id
}

function deleteFeature(id: string): void {
  history.execute(new RemoveNodeCommand(id))
}

/** The workbench's own regen -> CAM sync, lifted from syncCamModelBodies:
 *  the full live body set drives reconciliation, every live body is re-derived. */
function syncToCam(): void {
  const bodyIds = bodyFeatureIds(dag)
  const liveIds = liveBodyFeatureIds(dag, () => true)
  const live: LiveModelBody[] = projectBodyLineages(dag, bodyIds, liveIds).map(({ bodyId, lineageId }) => ({
    bodyId,
    lineageId,
    name: featureLabel(dag, lineageId),
  }))
  tessVersion += 1
  const derived: DerivedModelBody[] = live.map(({ bodyId, lineageId }) => ({
    bodyId,
    lineageId,
    version: tessVersion,
    stableIds: stableIdsFor(bodyId, String(dag.getNode(bodyId)?.payload.sketchId ?? 'S?')),
    display: display(tessVersion),
  }))
  useCamStore.getState().syncModelBodies({ live, derived })
}

/** Hand-attach a saved Section + the operator's own row state (hidden, stock
 *  lock), mirroring int17aModelBodySync/sectionProvenance.wo1400's precedent for
 *  a tracked section without driving the full mesh-slice derive. */
function attachSectionAndRowState(): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: s.project.geometry.map((g) =>
        g.format === 'model'
          ? {
              ...g,
              layers2d: [{
                id: 'section-1', name: 'Section z=0', color: '#ff8c00', visible: true, sourceType: 'import',
              }],
              loops: [{
                id: 'section-loop-1', layerId: 'section-1', closed: true, type: 'contour', area: 0.5,
                points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
              }],
              loopsVersion: 3,
              hidden: true,
              color: '#123456',
              stockId: 'stock-1',
              stockIdLocked: true,
            }
          : g,
      ),
    },
  }))
}

beforeEach(() => {
  resetDocumentHolder()
  vi.clearAllMocks()
  tessVersion = 0
  useCamStore.setState({ project: makeProject() })
  // A fresh project: nothing retained from a previous test may leak in.
  useCamStore.getState().newProject()
  useCamStore.setState({ project: makeProject() })
  mountWorkbench()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
})

describe('WO-1413: a deleted body\'s saved Section comes back with undo, and with nothing else', () => {
  it('acceptance 1: layers2d/loops survive delete-then-undo, byte-identical', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()

    const before = modelRow()
    expect(before).toBeDefined()
    const layersBefore = before!.layers2d
    const loopsBefore = before!.loops
    expect(layersBefore).toBeDefined()
    expect(loopsBefore).toBeDefined()

    deleteFeature(box)
    syncToCam()
    expect(modelRow()).toBeUndefined() // the row is genuinely gone mid-sequence

    history.undo()
    syncToCam()

    const after = modelRow()
    expect(after).toBeDefined()
    expect(after!.layers2d).toEqual(layersBefore)
    expect(after!.loops).toEqual(loopsBefore)
    expect(after!.loopsVersion).toBe(3)
    // The operator's own row state rides back with it.
    expect(after!.hidden).toBe(true)
    expect(after!.color).toBe('#123456')
    expect(after!.stockIdLocked).toBe(true)
  })

  it('acceptance 1b: the row id an edge-bound CAM operation resolves through survives the undo', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()
    const rowIdBefore = modelRow()!.id
    const bodyIdBefore = modelRow()!.modelBody?.ref.bodyId

    deleteFeature(box)
    syncToCam()
    history.undo()
    syncToCam()

    const after = modelRow()
    expect(after).toBeDefined()
    // An operation's params.geometryId / modelReferences.bodyId bound before the
    // delete still resolves to this row afterwards.
    expect(after!.id).toBe(rowIdBefore)
    expect(after!.modelBody?.ref.bodyId).toBe(bodyIdBefore)
    expect(
      useCamStore.getState().project.geometry.find((g) => g.id === rowIdBefore),
    ).toBeDefined()
  })

  it('acceptance 2: a NEW feature re-minted the freed id -- same sketch, same operation -- starts plain', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()
    expect(modelRow()!.layers2d).toBeDefined()

    deleteFeature(box)
    syncToCam()

    // Not undone: "F1" is free, and nextId hands it straight back out. Same
    // sketch and same operation, so lineage id AND stable ids are byte-identical
    // to the deleted body's -- only the history can tell these apart.
    const remade = createExtrude('S1', 'Box again')
    expect(remade).toBe(box)
    syncToCam()

    const row = modelRow()
    expect(row).toBeDefined()
    expect(row!.name).toBe('Box again')
    expect(row!.layers2d).toBeUndefined()
    expect(row!.loops).toBeUndefined()
    expect(row!.loopsVersion).toBeUndefined()
    expect(row!.hidden).toBeUndefined()
    expect(row!.color).toBeUndefined()
    expect(row!.stockId).toBeUndefined()
    expect(row!.stockIdLocked).toBeUndefined()
  })

  it('acceptance 3: delete -> new feature on the freed id -> undo it -> undo the delete restores the ORIGINAL row', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()
    const boxLayers = modelRow()!.layers2d

    deleteFeature(box)
    syncToCam()

    const cylinder = createExtrude('S2', 'Cylinder')
    expect(cylinder).toBe(box) // re-minted the freed id
    syncToCam()
    expect(modelRow()!.layers2d).toBeUndefined() // plain, as acceptance 2 pins

    history.undo() // undo the Cylinder
    syncToCam()
    expect(modelRow()).toBeUndefined()

    history.undo() // undo the delete
    syncToCam()

    const restored = modelRow()
    expect(restored).toBeDefined()
    expect(restored!.name).toBe('Box')
    expect(restored!.layers2d).toEqual(boxLayers)
    expect(restored!.hidden).toBe(true)
    expect(restored!.stockIdLocked).toBe(true)
  })

  it('acceptance 4: restored every time the delete is undone, across undo -> redo -> undo', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()
    const layers = modelRow()!.layers2d

    deleteFeature(box)
    syncToCam()
    expect(modelRow()).toBeUndefined()

    history.undo()
    syncToCam()
    expect(modelRow()!.layers2d).toEqual(layers)

    history.redo()
    syncToCam()
    expect(modelRow()).toBeUndefined()

    history.undo()
    syncToCam()
    expect(modelRow()!.layers2d).toEqual(layers)
    expect(modelRow()!.hidden).toBe(true)
  })

  it('acceptance 5: after New Project, a body under the same id in the new project is plain', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()
    deleteFeature(box)
    syncToCam()

    useCamStore.getState().newProject()
    useCamStore.setState({ project: makeProject() })
    // A new project brings its own document, history and feature-id namespace.
    mountWorkbench()

    const fresh = createExtrude('S1', 'Box')
    expect(fresh).toBe(box) // same id string in the new project's namespace
    syncToCam()

    const row = modelRow()
    expect(row).toBeDefined()
    expect(row!.layers2d).toBeUndefined()
    expect(row!.loops).toBeUndefined()
    expect(row!.hidden).toBeUndefined()
  })

  it('a different lineage appearing after a delete never inherits the deleted row', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()
    deleteFeature(box)
    syncToCam()

    // A second feature exists first, so the new body is minted a DIFFERENT id.
    const keeper = createExtrude('S9', 'Keeper')
    syncToCam()
    expect(keeper).toBe(box)
    const other = createExtrude('S2', 'Other')
    expect(other).not.toBe(box)
    syncToCam()

    const otherRow = useCamStore.getState().project.geometry
      .find((g) => g.format === 'model' && g.modelBody?.ref.bodyId === other)
    expect(otherRow).toBeDefined()
    expect(otherRow!.layers2d).toBeUndefined()
    expect(otherRow!.loops).toBeUndefined()
  })

  it('with no live Model document, nothing is recovered and nothing is invented', () => {
    const box = createExtrude('S1', 'Box')
    syncToCam()
    attachSectionAndRowState()

    deleteFeature(box)
    syncToCam()

    // The workbench unmounts (its hooks go with it). A remount rebuilds the
    // document with an empty history, so the delete is no longer undoable at
    // all -- the row must not come back off a bare id match.
    delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
    history.undo()
    syncToCam()

    const row = modelRow()
    expect(row).toBeDefined()
    expect(row!.layers2d).toBeUndefined()
    expect(row!.loops).toBeUndefined()
  })
})
