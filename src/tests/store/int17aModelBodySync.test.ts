// INT-17A Stage 1 gates G1 + G4 (store action + persistence + identity law).
//
// Drives the REAL useCamStore.syncModelBodies action (the CAM-side seam the Model
// tab's regen hook calls) and the REAL save/reload path (saveProjectToFile ->
// loadProjectFromFile), because that wiring IS the deliverable. Covers:
//  - add / update (version bump, stable id) / delete / rename through the store
//  - the IDENTITY LAW can-fail probe: a full add/update/delete/regen cycle of the
//    adapter invokes ZERO occt-model import calls (importBrepGeometry / readStep /
//    cacheStep / setBrepPayload), proven by spies, with a non-vacuous control
//  - persistPartialize STRIPS the heavy display from localStorage (keeps the ref)
//  - the .camproject FILE round-trip keeps the full display (G4a: draws from
//    persisted data alone, Part tab never visited)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project, ImportedGeometry, ModelBodyDisplay, Operation } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
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

const { useCamStore, persistPartialize, persistMerge } = await import('../../store')
const { modelBodyGeometryFingerprint } = await import('../../lib/cam/modelBodyFingerprint')
const stepCache = await import('../../lib/stepCache')
const modelClient = await import('../../lib/cam/geometry/occt/model/modelClient')
const { resetDocumentHolder, stashLoadedDocument } = await import('../../doc/documentHolder')
const { createDocumentArchive } = await import('../../doc/persist')
const { FeatureDag } = await import('../../doc/dag')
const { arrayBufferToBase64 } = await import('../../lib/projectBinaries')
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')
const restoreScene = await import('../../lib/viewport/restoreScene')

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
const derived = (bodyId: string, version = 1, tag = 0, lineageId?: string): DerivedModelBody =>
  ({ bodyId, lineageId, version, stableIds: [`${bodyId}:F0`, `${bodyId}:E0`], display: display(tag) })
const live = (bodyId: string, name: string, lineageId?: string): LiveModelBody => ({ bodyId, lineageId, name })

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'Model Bodies', version: '1.0.0',
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000, maxSpindleRpm: 24000,
      minSpindleRpm: 8000, spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
    ...over,
  } as Project
}

const modelEntries = (): ImportedGeometry[] =>
  useCamStore.getState().project.geometry.filter((g) => g.format === 'model')

let savedBlobs: Blob[]
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.clearAllMocks()
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:int17a' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.setState({ project: makeProject() })
})

describe('INT-17A syncModelBodies - real store action', () => {
  it('ADD then UPDATE keeps a STABLE entry id and bumps the version', () => {
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)] })
    expect(modelEntries()).toHaveLength(1)
    const id = modelEntries()[0].id
    expect(modelEntries()[0].modelBody?.ref.version).toBe(1)

    // Edit the body (regen bumps version, fresh display).
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 5)] })
    expect(modelEntries()).toHaveLength(1)
    expect(modelEntries()[0].id).toBe(id)            // no churn across an edit
    expect(modelEntries()[0].modelBody?.ref.version).toBe(2)
    expect(modelEntries()[0].modelBody?.display?.positions[0]).toBe(5)
  })

  it('DELETE removes the entry when the body leaves the live set', () => {
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1'), derived('b2')],
    })
    expect(modelEntries()).toHaveLength(2)
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'A')], derived: [] })
    expect(modelEntries().map((g) => g.modelBody?.ref.bodyId)).toEqual(['b1'])
  })

  it('RENAME updates the name without re-deriving, same id', () => {
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'Old')], derived: [derived('b1')] })
    const id = modelEntries()[0].id
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'New')], derived: [] })
    expect(modelEntries()[0].id).toBe(id)
    expect(modelEntries()[0].name).toBe('New')
  })

  it('a model-body sync creates NO undo history (it reflects the model, not a CAM edit)', () => {
    const before = useCamStore.getState().projectHistory.length
    const canUndoBefore = useCamStore.getState().canUndo
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'A')], derived: [derived('b1')] })
    expect(useCamStore.getState().projectHistory.length).toBe(before)
    expect(useCamStore.getState().canUndo).toBe(canUndoBefore)
  })

  it('a live body with no display payload is reported LOUDLY, never silently dropped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'A')], derived: [] })
    expect(modelEntries()).toHaveLength(0)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('b1'))
    err.mockRestore()
  })
})

describe('SECTION-STALENESS-MARK: model section snapshots', () => {
  it('survives refresh without a false warning, then stales on a real geometry change', () => {
    const originalDisplay = display(0)
    const originalFingerprint = modelBodyGeometryFingerprint(originalDisplay)
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'Bracket')],
      derived: [derived('b1', 1, 0)],
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((geo) => geo.format === 'model'
          ? {
              ...geo,
              layers2d: [{
                id: 'section-1',
                name: 'Section z=0',
                color: '#ff8c00',
                visible: true,
                derived: true,
                sectionSource: {
                  bodyId: 'b1',
                  geometryFingerprint: originalFingerprint,
                },
              }],
              loops: [{
                id: 'section-loop-1',
                layerId: 'section-1',
                closed: true,
                type: 'contour',
                area: 0.5,
                points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
              }],
              loopsVersion: 1,
            }
          : geo),
      },
    }))

    const persisted = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    const rehydrated = persistMerge(persisted, useCamStore.getState())
    const loadedSection = rehydrated.project.geometry[0].layers2d?.[0]
    expect(rehydrated.project.geometry[0].modelBody?.display).toBeUndefined()
    expect(loadedSection?.sectionSource?.geometryFingerprint).toBe(originalFingerprint)
    expect(loadedSection?.sectionStale).not.toBe(true)

    useCamStore.setState({ project: rehydrated.project })
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'Bracket')],
      derived: [derived('b1', 1, 0)],
    })
    const unchanged = modelEntries()[0]
    expect(unchanged.layers2d).toHaveLength(1)
    expect(unchanged.loops).toHaveLength(1)
    expect(unchanged.layers2d?.[0].sectionStale).toBe(false)

    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'Bracket')],
      derived: [derived('b1', 2, 5)],
    })
    const changed = modelEntries()[0]
    expect(changed.layers2d).toHaveLength(1)
    expect(changed.loops).toHaveLength(1)
    expect(changed.layers2d?.[0].sectionStale).toBe(true)
  })

  it('fingerprint ignores triangle winding and order within a triangle', () => {
    const reordered: ModelBodyDisplay = {
      ...display(0),
      indices: [2, 0, 1],
    }
    expect(modelBodyGeometryFingerprint(reordered))
      .toBe(modelBodyGeometryFingerprint(display(0)))
  })
})

describe('GEO-UNIFY Stage 2: folderId seed on a scope\'s first body', () => {
  it('the newly-added row inherits the item\'s own folderId when this is its FIRST body ever', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A', folderId: 'fld-1' }] },
    }))
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'Bracket')], derived: [derived('b1')],
    })
    expect(modelEntries()[0].folderId).toBe('fld-1')
  })

  it('no folderId to seed (item never dragged into a folder) leaves the new row at the root, unchanged', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
    }))
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'Bracket')], derived: [derived('b1')],
    })
    expect(modelEntries()[0].folderId).toBeUndefined()
  })

  it('a LATER regen of the SAME body never re-seeds or overwrites a folder the user since moved it to', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A', folderId: 'fld-1' }] },
    }))
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'Bracket')], derived: [derived('b1')],
    })
    const id = modelEntries()[0].id
    useCamStore.getState().setGeometryFolderId(id, 'fld-2')
    // Regen (version bump) — the row already exists, so this is an UPDATE, not
    // an ADD; the seed condition must not re-fire and clobber the user's move.
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 5)],
    })
    expect(modelEntries()[0].folderId).toBe('fld-2')
  })

  it('a SECOND body added later (item already has a resolvable placement) is NOT seeded (only the true first body seeds)', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A', folderId: 'fld-1' }] },
    }))
    // First body: seeded, then dragged elsewhere by the user.
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'A')], derived: [derived('b1')],
    })
    useCamStore.getState().setGeometryFolderId(modelEntries()[0].id, 'fld-2')
    // Second body, same scope: the "first body ever" placement-existence gate
    // has already fired once for this item, so this row seeds nothing.
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1'), derived('b2')],
    })
    const b2 = modelEntries().find((g) => g.modelBody?.ref.bodyId === 'b2')!
    expect(b2.folderId).toBeUndefined()
  })

  it('the seeded folderId round-trips through save/reload', async () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{
          id: 'item-a',
          name: 'Item A',
          folderId: 'fld-1',
          documentState: 'authored',
        }],
      },
    }))
    stashLoadedDocument(
      createDocumentArchive({ dag: new FeatureDag(), elementMapDeltas: [] }),
      'item-a',
    )
    useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a', live: [live('b1', 'Bracket')], derived: [derived('b1')],
    })
    expect(modelEntries()[0].folderId).toBe('fld-1')
    const json = await saveAndCaptureFile()
    useCamStore.setState({ project: makeProject() })
    await useCamStore.getState().loadProjectFromFile(json)
    expect(modelEntries()[0].folderId).toBe('fld-1')
  })
})

describe('INT-17A identity law (G1 amendment) - occt path is UNREACHABLE from the adapter', () => {
  it('a full add/update/delete/regen cycle invokes ZERO occt-model import calls', () => {
    const readStepSpy = vi.spyOn(modelClient, 'readStep')
    const setBrepPayloadSpy = vi.spyOn(modelClient, 'setBrepPayload')
    const importSpy = vi.fn(async () => {})
    useCamStore.setState({ importBrepGeometry: importSpy })

    const s = useCamStore.getState()
    s.syncModelBodies({ live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1'), derived('b2')] }) // add
    s.syncModelBodies({ live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1', 2, 3)] })          // update b1
    s.syncModelBodies({ live: [live('b1', 'A')], derived: [] })                                              // delete b2
    s.syncModelBodies({ live: [live('b1', 'A')], derived: [derived('b1', 3, 4)] })                           // regen b1

    // Proven by the adapter's own call graph, not assumed from the type system:
    // a modeled body NEVER rides importBrepGeometry / readStep / cacheStep /
    // setBrepPayload (those are the occt-model STEP path, ruling 1).
    expect(readStepSpy).not.toHaveBeenCalled()
    expect(setBrepPayloadSpy).not.toHaveBeenCalled()
    expect(stepCache.cacheStep).not.toHaveBeenCalled()
    expect(importSpy).not.toHaveBeenCalled()

    readStepSpy.mockRestore()
    setBrepPayloadSpy.mockRestore()
  })

  it('CONTROL: the probe is non-vacuous - the spies DO observe a real occt call', async () => {
    // Prove the assertions above can FAIL: a direct occt call is seen by the spy.
    await stepCache.cacheStep('control', new ArrayBuffer(8))
    expect(stepCache.cacheStep).toHaveBeenCalledTimes(1)
  })
})

describe('INT-17A persistence', () => {
  it('persistPartialize STRIPS the heavy display from localStorage (keeps the ref)', () => {
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'A')], derived: [derived('b1')] })
    const persisted = persistPartialize(useCamStore.getState())
    const modelGeo = persisted.project.geometry.find((g) => g.format === 'model')!
    expect(modelGeo.modelBody?.ref.bodyId).toBe('b1')      // lightweight handle kept
    expect(modelGeo.modelBody?.display).toBeUndefined()    // heavy payload dropped
  })

  it('G4a: the .camproject FILE keeps full display, and reload draws from it alone (Part tab never visited)', async () => {
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1'), derived('b2')],
    })
    const idsBefore = modelEntries().map((g) => g.id)

    // Save through the REAL path, then reload into a FRESH store (a new session).
    const json = await saveAndCaptureFile()
    const parsed = JSON.parse(json)
    expect(parsed.geometry.filter((g: ImportedGeometry) => g.format === 'model')).toHaveLength(2)
    // Full display rides in the file (this is the B2a persistence axis).
    const fileModel = parsed.geometry.find((g: ImportedGeometry) => g.format === 'model')
    expect(fileModel.modelBody.display.positions.length).toBeGreaterThan(0)

    useCamStore.setState({ project: makeProject() })       // wipe -> fresh session
    await useCamStore.getState().loadProjectFromFile(json)
    // Entries reappear with the SAME stable ids and their display.
    expect(modelEntries().map((g) => g.id)).toEqual(idsBefore)
    expect(modelEntries()[0].modelBody?.display?.positions.length).toBeGreaterThan(0)

    // And they DRAW from that persisted payload with no Part tab, no kernel: the
    // reload scene-restore calls addModelBody for each (CAN-FAIL if the restore
    // branch or B2a persistence were missing).
    const drawn: string[] = []
    const vp = {
      addSTL: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
      setSTLVisible: () => {}, setPartLoopsOnFacePlane: () => {}, setPartProjectedLoops: () => {},
      addBrepModel: () => {}, add2DGeometry: () => {},
      addModelBody: (id: string) => { drawn.push(id) },
    }
    await restoreScene.restoreGeometryToViewport(vp, useCamStore.getState().project.geometry, {
      patchGeometry: () => {}, setBrepImportError: () => {},
    })
    expect(drawn.sort()).toEqual(idsBefore.slice().sort())
  })

  it('G4b: reload THEN visit the Part tab keeps the same entry ids and picks up the live regen', async () => {
    // Seed a prior save with two model bodies, then reload into a fresh session.
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1', 1, 0), derived('b2', 1, 0)],
    })
    const json = await saveAndCaptureFile()
    useCamStore.setState({ project: makeProject() })
    await useCamStore.getState().loadProjectFromFile(json)
    const idsAfterReload = modelEntries().map((g) => g.id).sort()
    expect(idsAfterReload).toEqual(['modelbody:b1', 'modelbody:b2'])

    // NOW the user visits the Part tab: the seed/regen fires syncModelBodies over
    // the SAME body ids (deterministic entry id keyed on bodyId), refreshing the
    // display in place. Entry ids must be byte-stable (no churn) and versions bump.
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'A'), live('b2', 'B')], derived: [derived('b1', 2, 7), derived('b2', 2, 7)],
    })
    expect(modelEntries().map((g) => g.id).sort()).toEqual(idsAfterReload)   // SAME ids
    expect(modelEntries().every((g) => g.modelBody?.ref.version === 2)).toBe(true)
    expect(modelEntries().every((g) => g.modelBody?.display?.positions[0] === 7)).toBe(true)
    expect(modelEntries()).toHaveLength(2)   // no duplicates spawned by the regen
  })

  it('repairs a saved Adaptive binding from an old leaf to the surviving lineage row', async () => {
    const itemId = '74fcd5dc-bf1a-4062-aae2-b35167c0c5d0'
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: {} })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', name: 'Extrude F1' } })
    dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F1'], payload: { opType: 'pushPull', name: 'Push/Pull F4' } })
    dag.insertNode({ id: 'F8', kind: 'feature', consumes: ['F4'], payload: { opType: 'fillet', name: 'Fillet F8' } })
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })

    useCamStore.setState({
      project: makeProject({
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        modelItems: [{ id: itemId, name: 'Model Item 1', documentState: 'authored' }],
      }),
    })
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId,
      live: [live('F8', 'Extrude F1', 'F1')],
      derived: [derived('F8', 8, 0, 'F1')],
    })

    const staleGeometryId = `modelbody:${itemId}:F4`
    const currentGeometryId = `modelbody:${itemId}:F8`
    const operation = {
      id: 'adaptive-1', name: 'Adaptive Clearing', type: 'adaptive_clearing_2d',
      enabled: true, status: 'error', toolId: 'tool-1', geometrySelections: [],
      heights: {
        clearanceHeight: 15, clearanceHeightMode: 'absolute',
        retractHeight: 5, feedHeight: 2, topHeight: 0, topHeightMode: 'absolute',
        bottomHeight: -5, bottomHeightMode: 'absolute',
      },
      passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
        retractType: 'full', transitionType: 'safe_height',
      },
      params: {
        geometryId: staleGeometryId, loopIds: [], boundarySource: 'geometry',
        targetEngagement: 0.4, maxEngagement: 0.7, stepDistance: 0.4,
        thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
      },
      errorMessage: `Cannot resolve a coordinate frame: geometry "${staleGeometryId}" was not found.`,
      generationFingerprint: 'stale-claim',
      toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }],
    } as unknown as Operation

    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        geometry: state.project.geometry.map((geo) => geo.format === 'model'
          ? {
              ...geo,
              // Simulate the pre-fix saved row: id keyed by CURRENT leaf and no
              // persisted lineage, while the op still points at historical F4.
              id: currentGeometryId,
              modelBody: {
                ...geo.modelBody!,
                ref: {
                  bodyId: 'F8',
                  stableIds: geo.modelBody!.ref.stableIds,
                  version: geo.modelBody!.ref.version,
                },
              },
            }
          : geo),
        setups: [{
          id: 'setup-1', name: 'Setup 1', operations: [operation],
          wcs: {
            id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          stock: {
            type: 'rectangular', offsetX: 0, offsetY: 0,
            offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
          },
          notes: '',
        } as never],
        activeSetupId: 'setup-1',
      },
    }))

    const fileProject = {
      ...useCamStore.getState().project,
      modelItemDocuments: {
        [itemId]: arrayBufferToBase64(new Uint8Array(archive).buffer),
      },
    }
    useCamStore.setState({ project: makeProject() })
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(fileProject))

    const row = modelEntries()[0]
    const repaired = useCamStore.getState().project.setups[0].operations[0]
    expect(row.id).toBe(currentGeometryId)
    expect(row.modelBody?.ref).toMatchObject({ bodyId: 'F8', lineageId: 'F1' })
    expect(repaired.params.geometryId).toBe(currentGeometryId)
    expect(repaired.status).toBe('outdated')
    expect(repaired.errorMessage).toBeUndefined()
    expect(repaired.generationFingerprint).toBeUndefined()
    expect(repaired.toolpathMoves).toHaveLength(1)
    expect(repaired.modelReferenceNote).toMatch(/binding was repaired/i)
  })
})
