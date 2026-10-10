// WO INT-17C Stage C1 CLOSURE, gap 1: a NON-legacy Model Item's own modeling
// document (and its own scoped CAM geometry) round-trips through
// saveProjectToFile/loadProjectFromFile. Before this closure, the "New Model
// Item" command (INT-17C.md Stage C1 step 6, commit 2b7b82846) was already
// user-visible on main, but only the LEGACY item's document rode inside the
// .camproject file (`Project.document`) -- a second, real Model Item's
// content was never collected on save and never rehydrated on load, so
// create item B -> work in it -> save -> reload silently dropped item B
// (the exact scenario docs/planning/POST-MERGE-WORKPLAN.md's INT-17C entry
// disclosed as an open gap, not hidden).
//
// Same discipline int17cC1FixtureBaseline.test.ts and int14ProjectDocument.test.ts
// already established: drive the REAL store actions (addModelItem,
// registerLiveDocument, syncModelBodies, saveProjectToFile,
// loadProjectFromFile) -- never a hand-authored archive or JSON literal for
// the parts this closure is proving.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project, ModelBodyDisplay } from '../../types'
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

const { useCamStore } = await import('../../store')
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')
const { FeatureDag } = await import('../../doc/dag')
const {
  registerLiveDocument, resetDocumentHolder, takePendingDocumentSeed, LEGACY_MODEL_ITEM_ID,
} = await import('../../doc/documentHolder')
const { arrayBufferToBase64 } = await import('../../lib/projectBinaries')

// -- fixtures -----------------------------------------------------------------

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p-closure', name: 'Closure Fixture', version: '1.0.0',
    createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
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

/** A genuinely modeled part, distinguishable per tag so two items' documents
 *  can never be mistaken for one another. */
function buildDag(tag: string): InstanceType<typeof FeatureDag> {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: `${tag} Sketch` } })
  dag.insertNode({
    id: 'F1', kind: 'feature', consumes: ['SK1'],
    payload: { opType: 'extrude', sketchId: 'SK1', distance: 5, direction: 'up', boolMode: 'newBody', name: `${tag} Body` },
  })
  return dag
}

function display(tag: number): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}
const derivedBody = (bodyId: string, tag: number): DerivedModelBody =>
  ({ bodyId, version: 1, stableIds: [`${bodyId}:F0`], display: display(tag) })
const liveBody = (bodyId: string, name: string): LiveModelBody => ({ bodyId, name })

// -- the real save path -------------------------------------------------------

let savedBlobs: Blob[] = []
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:int17c-closure' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.setState({ project: makeProject() })
})

describe('INT-17C Stage C1 CLOSURE gap 1: non-legacy Model Item content round-trips save/reload', () => {
  it('create item B via addModelItem, register+sync real content, save, reload: item B round-trips and the legacy item is untouched', async () => {
    // The ordinary, pre-existing legacy flow: a document + a synced CAM row,
    // with NO "New Model Item" ever used for it -- exactly how every
    // pre-C1 project's model still works today.
    const legacyDag = buildDag('Legacy')
    registerLiveDocument(() => ({ dag: legacyDag, elementMapDeltas: [] }))
    useCamStore.getState().syncModelBodies({
      live: [liveBody('leg1', 'Legacy Body')],
      derived: [derivedBody('leg1', 0)],
    })

    // The NEW multi-item flow: a real "New Model Item" command mints item B,
    // gets its own live document and its own synced CAM row.
    const itemBId = useCamStore.getState().addModelItem()
    expect(useCamStore.getState().project.modelItems).toHaveLength(1)
    const itemBDag = buildDag('ItemB')
    registerLiveDocument(() => ({ dag: itemBDag, elementMapDeltas: [] }), itemBId)
    useCamStore.getState().syncModelBodies({
      live: [liveBody('bBody1', 'B Body')],
      derived: [derivedBody('bBody1', 5)],
      modelItemId: itemBId,
    })

    const fileText = await saveAndCaptureFile()
    const parsed = JSON.parse(fileText) as Project
    expect(parsed.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    // Structural: the file actually carries item B's archive, under its OWN
    // id, alongside the legacy `document` field (unchanged mechanism).
    expect(typeof parsed.document).toBe('string')
    expect(typeof parsed.modelItemDocuments?.[itemBId]).toBe('string')
    expect(parsed.modelItemDocuments![itemBId].length).toBeGreaterThan(0)

    // A fresh session -- nothing inherited from the one that saved.
    resetDocumentHolder()
    useCamStore.setState({ project: makeProject({ id: 'reload-target' }) })
    await useCamStore.getState().loadProjectFromFile(fileText)

    const loaded = useCamStore.getState().project
    expect(loaded.id).toBe('p-closure') // proves the load actually happened, not a no-op

    // Item B exists, tree-visible, alongside its own CAM row.
    const itemB = loaded.modelItems?.find((m) => m.id === itemBId)
    expect(itemB).toBeDefined()
    expect(itemB!.name).toBe('Model Item 1')
    const bRows = loaded.geometry.filter((g) => g.modelItemId === itemBId)
    expect(bRows).toHaveLength(1)
    expect(bRows[0].modelBody?.ref.bodyId).toBe('bBody1')

    // Item B's ACTUAL modeling document round-tripped byte-identical (not
    // merely "a document exists somewhere" -- the real feature graph).
    const bSeed = takePendingDocumentSeed(itemBId)
    expect(bSeed).not.toBeNull()
    expect(bSeed!.dag.serialize()).toBe(buildDag('ItemB').serialize())

    // The legacy item's own document AND CAM row content are untouched: same
    // mechanism (`document`), same content, and its row was never disturbed
    // by item B's own creation/sync (CLOSURE gap 2's own isolation guarantee,
    // proven again here end-to-end through the real save/load boundary).
    const legacySeed = takePendingDocumentSeed(LEGACY_MODEL_ITEM_ID)
    expect(legacySeed).not.toBeNull()
    expect(legacySeed!.dag.serialize()).toBe(buildDag('Legacy').serialize())
    const legacyRows = loaded.geometry.filter((g) => g.modelBody?.ref.bodyId === 'leg1')
    expect(legacyRows).toHaveLength(1)
    // INT-MODEL-UNIFY revision: this USED to assert `modelItemId` stayed
    // `undefined` forever -- that was the reported bug itself (a real
    // modeled body with no visible/deletable Model Item row), not a
    // deliberate isolation guarantee. migrateProjectData's unconditional
    // load-boundary catch-up (projectMigrations.ts) now claims the legacy
    // slot into project.modelItems on every load that carries a document,
    // exactly as a live post-fix session already does on first Model-tab
    // entry (enterModelWorkspace, store/index.ts) -- so the legacy row is
    // now claimed and tree-visible too, alongside item B, not instead of it.
    expect(legacyRows[0].modelItemId).toBe(LEGACY_MODEL_ITEM_ID)
    const legacyItem = loaded.modelItems?.find((m) => m.id === LEGACY_MODEL_ITEM_ID)
    expect(legacyItem).toBeDefined()
    expect(legacyItem!.name).toBe('Project Model')
    // Item B's own row/record are still the SEPARATE, distinct entries they
    // always were -- claiming the legacy slot does not fold it into item B.
    expect(loaded.modelItems).toHaveLength(2)

    // `document`/`modelItemDocuments` are FILE fields, never live session
    // state -- stripped on the way in, same discipline `document` already had.
    expect((loaded as Project).document).toBeUndefined()
    expect((loaded as Project).modelItemDocuments).toBeUndefined()
  })
})

describe('INT-17C Stage C1 CLOSURE gap 1: refusal -- a corrupt non-legacy item archive aborts the WHOLE open', () => {
  it('refuses a corrupted modelItemDocuments entry by name, installs nothing, and leaves the current project untouched', () => {
    useCamStore.setState({ project: makeProject({ name: 'Still Mine' }) })

    const fileText = JSON.stringify(
      makeProject({
        name: 'Damaged Item',
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        modelItems: [{ id: 'item-x', name: 'Item X' }],
        modelItemDocuments: {
          'item-x': arrayBufferToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer),
        },
      }),
    )

    useCamStore.getState().loadProjectFromFile(fileText)

    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'project',
      message: expect.stringContaining('damaged or incomplete'),
    })
    expect(useCamStore.getState().sketchNotice).toContain('damaged or incomplete')
    // No partial install: the project already in the store is untouched.
    expect(useCamStore.getState().project.name).toBe('Still Mine')
    expect(useCamStore.getState().project.modelItems ?? []).toHaveLength(0)
    expect(takePendingDocumentSeed('item-x')).toBeNull()
  })

  it('a modelItems entry with NO matching archive is NOT an error -- it is a legitimately empty item (never modeled, or not live at save time)', () => {
    useCamStore.setState({ project: makeProject({ name: 'Still Mine' }) })

    const fileText = JSON.stringify(
      makeProject({
        name: 'Item With No Content Yet',
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        modelItems: [{ id: 'item-empty', name: 'Item Empty' }],
        // No modelItemDocuments field at all -- the item was created but
        // never modeled, mirroring how `document`'s own absence has always
        // meant "no model" rather than "an error".
      }),
    )

    useCamStore.getState().loadProjectFromFile(fileText)

    const loaded = useCamStore.getState().project
    expect(loaded.name).toBe('Item With No Content Yet')
    expect(loaded.modelItems).toHaveLength(1)
    expect(loaded.modelItems![0].id).toBe('item-empty')
    expect(takePendingDocumentSeed('item-empty')).toBeNull()
  })
})
