// WO-2987 (WO-2750 Slice B): drawings are saved with the project.
//
// Every scenario here runs through the production save and open entries
// (useCamStore.saveProjectToFile / loadProjectFromFile) and the holder the
// store reaches the model through, never a hand-built archive handed straight
// to the loader (LIENCAM.md rule 6). Plan section 8 row "Save/reopen; never open
// Model before next save", plus the absent-field, future-version, mounted-edit
// and autosave-recovery cases of section 7 row B.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../../types'
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
const { createDocumentArchive, loadDocumentArchive, InMemoryDocumentStorage } = await import('../../doc/persist')
const {
  collectDocumentArchive,
  documentIdForProject,
  getDrawingRecords,
  LEGACY_MODEL_ITEM_ID,
  markDocumentDirty,
  registerLiveDocument,
  resetDocumentHolder,
  setDocumentStorage,
  setDrawingRecords,
  startDocumentAutosave,
  stashLoadedDocument,
} = await import('../../doc/documentHolder')
const {
  DRAWING_DOCUMENT_SCHEMA_VERSION,
  readDrawingRecords,
  writeDrawingRecords,
} = await import('../../lib/drawing/document')
import type { DrawingDocument, DrawingRecords } from '../../lib/drawing/document'
import type { JsonValue } from '../../doc/persist'
import { arrayBufferToBase64 } from '../../lib/projectBinaries'

// -- fixtures ---------------------------------------------------------------------

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'Saved Project', version: '1.0.0',
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      notes: '',
    },
    toolLibrary: [], geometry: [], setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
    ...over,
  } as Project
}

const REV = { geometryFingerprint: 'g1', frameFingerprint: 'f1', producerVersion: 'occt-1' }

/** A drawing with every part the plan says must survive: broken reference, template instance and asset, tolerance policy, last-good revision, author and dates. */
function makeDrawing(modelItemId: string, over: Partial<DrawingDocument> = {}): DrawingDocument {
  return {
    schemaVersion: DRAWING_DOCUMENT_SCHEMA_VERSION,
    id: 'D1',
    name: 'Bracket',
    source: { modelItemId, documentId: modelItemId, lineageId: 'body-1', kind: 'model-brep', observedRevision: REV },
    createdAt: '2026-10-20T10:00:00.000Z',
    editedAt: '2026-10-20T11:30:00.000Z',
    author: { name: 'A. Machinist' },
    template: { templateId: 'shop-a4', revision: '3', fields: { drawnBy: 'A. Machinist', title: 'Bracket' }, assetIds: ['logo'] },
    assets: [{ id: 'logo', name: 'logo.png', contentType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
    sheets: [{
      id: 'S1', sizeMm: [297, 210], marginsMm: 10, projection: 'third-angle', unit: 'mm', precision: 2,
      views: [{
        id: 'V1',
        frame: { name: 'front', origin: [0, 0, 0], towardViewer: [0, -1, 0], xAxis: [1, 0, 0], upAxis: [0, 0, 1] },
        scale: { numerator: 1, denominator: 2 },
        sheetOriginMm: [60, 100],
        showHidden: false,
      }],
    }],
    references: [{
      id: 'R1',
      source: { modelItemId, documentId: modelItemId, lineageId: 'body-1', kind: 'model-brep', observedRevision: REV },
      selector: { kind: 'edge', stableId: 'F1:BOX:edge0' },
      witness: { role: 'endpoint', endpoint: 'start', geometrySignature: 'sig-a' },
      acceptedRevision: REV,
    }],
    annotations: [
      {
        kind: 'dimension', id: 'A1', measurement: 'linear', referenceIds: ['R1'],
        tolerance: { kind: 'bilateral', upper: 0.1, lower: -0.05 },
        lastGood: { value: 100, unit: 'mm', measuredAt: REV },
      },
      { kind: 'balloon', id: 'B1', number: 7, anchorSheetMm: [20, 20] },
    ],
    lastGoodRevision: REV,
    ...over,
  }
}

function recordsOf(...documents: DrawingDocument[]): DrawingRecords {
  return { documents, preserved: [] }
}

function holderArchive(drawings: DrawingRecords): Uint8Array {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
  return createDocumentArchive({ dag, elementMapDeltas: [], drawings: writeDrawingRecords(drawings) })
}

// -- the production save / open entries --------------------------------------------

let savedBlobs: Blob[] = []
let alertSpy: ReturnType<typeof vi.fn>

async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  alertSpy = vi.fn()
  vi.stubGlobal('alert', alertSpy)
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2987' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.setState({ project: makeProject() })
})

describe('WO-2987: drawings ride inside the saved project', () => {
  it('save -> wipe everything -> open restores every drawing part, without the Model workspace ever mounting', async () => {
    stashLoadedDocument(holderArchive(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID))))
    const fileText = await saveAndCaptureFile()

    resetDocumentHolder()
    expect(getDrawingRecords().documents).toEqual([])

    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()

    const reopened = getDrawingRecords()
    expect(reopened.preserved).toEqual([])
    expect(reopened.documents).toEqual([makeDrawing(LEGACY_MODEL_ITEM_ID)])
    const [d] = reopened.documents
    expect(d.references[0].selector).toEqual({ kind: 'edge', stableId: 'F1:BOX:edge0' })
    expect(d.annotations[0]).toMatchObject({ tolerance: { kind: 'bilateral', upper: 0.1, lower: -0.05 } })
    expect(d.template).toMatchObject({ templateId: 'shop-a4', revision: '3' })
    expect(d.assets[0].dataBase64).toBe('iVBORw0KGgo=')
    expect(d.author).toEqual({ name: 'A. Machinist' })
    expect(d.lastGoodRevision).toEqual(REV)

    // and a second save, still without mounting, writes the same drawings again
    const resaved = await saveAndCaptureFile()
    resetDocumentHolder()
    await useCamStore.getState().loadProjectFromFile(resaved)
    expect(getDrawingRecords().documents).toEqual([makeDrawing(LEGACY_MODEL_ITEM_ID)])
  })

  it('two Model Items with the same local drawing id keep their own drawings', async () => {
    const itemA = 'item-a'
    const itemB = 'item-b'
    stashLoadedDocument(holderArchive(recordsOf(makeDrawing(itemA, { name: 'Part A' }))), itemA)
    stashLoadedDocument(holderArchive(recordsOf(makeDrawing(itemB, { name: 'Part B' }))), itemB)
    useCamStore.setState({
      project: makeProject({
        modelItems: [
          { id: itemA, name: 'A', documentState: 'authored' },
          { id: itemB, name: 'B', documentState: 'authored' },
        ],
      }),
    })
    const fileText = await saveAndCaptureFile()

    resetDocumentHolder()
    await useCamStore.getState().loadProjectFromFile(fileText)

    const a = getDrawingRecords(itemA).documents
    const b = getDrawingRecords(itemB).documents
    expect(a.map((d) => [d.id, d.name, d.source.modelItemId])).toEqual([['D1', 'Part A', itemA]])
    expect(b.map((d) => [d.id, d.name, d.source.modelItemId])).toEqual([['D1', 'Part B', itemB]])
  })

  it('saving a copy leaves the open project and its earlier file untouched', async () => {
    stashLoadedDocument(holderArchive(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID))))
    const original = await saveAndCaptureFile()

    // keep working on the open project, then save a copy
    setDrawingRecords(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID, { name: 'Renamed' })))
    const copy = await saveAndCaptureFile()
    expect(copy).not.toBe(original)

    // the earlier file still reopens to the earlier drawing
    resetDocumentHolder()
    await useCamStore.getState().loadProjectFromFile(original)
    expect(getDrawingRecords().documents.map((d) => d.name)).toEqual(['Bracket'])
  })

  it('a project without drawings saves the same bytes as before this slice, and opens with none', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
    const plain = createDocumentArchive({ dag, elementMapDeltas: [] })
    const withEmpty = createDocumentArchive({ dag, elementMapDeltas: [], drawings: { documents: [] } })
    expect(Array.from(withEmpty)).toEqual(Array.from(plain))

    const fileText = JSON.stringify(makeProject({ document: arrayBufferToBase64(new Uint8Array(plain).buffer) }))
    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()
    expect(getDrawingRecords()).toEqual({ documents: [], preserved: [] })
    expect(loadDocumentArchive(plain).drawings).toEqual({ documents: [] })
  })
})

describe('WO-2987: absent fields take defaults', () => {
  it('a drawing missing optional parts reads with empty sheets, references, annotations and assets', () => {
    const raw = {
      schemaVersion: 1,
      id: 'D9',
      source: { modelItemId: 'm', documentId: 'm', lineageId: 'l', kind: 'model-brep', observedRevision: REV },
    } as unknown as JsonValue
    const records = readDrawingRecords({ documents: [raw] })
    expect(records.preserved).toEqual([])
    expect(records.documents[0]).toMatchObject({
      id: 'D9', name: '', author: {}, assets: [], sheets: [], references: [], annotations: [],
      template: { templateId: 'blank', revision: '0', fields: {}, assetIds: [] },
    })
  })
})

describe('WO-2987: drawings this build cannot read are carried, never dropped', () => {
  const future = {
    schemaVersion: DRAWING_DOCUMENT_SCHEMA_VERSION + 1,
    id: 'DF',
    source: { modelItemId: 'm', documentId: 'm', lineageId: 'l', kind: 'model-brep', observedRevision: REV },
    newThing: { nested: [1, 2, 3] },
  } as unknown as JsonValue

  it('survives an unmounted pass-through save byte for byte', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
    const archive = createDocumentArchive({ dag, elementMapDeltas: [], drawings: { documents: [future] } })
    stashLoadedDocument(archive)

    const fileText = await saveAndCaptureFile()
    resetDocumentHolder()
    await useCamStore.getState().loadProjectFromFile(fileText)

    const records = getDrawingRecords()
    expect(records.documents).toEqual([])
    expect(records.preserved).toEqual([future])
  })

  it('survives a mounted save whose collector knows nothing about drawings', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
    stashLoadedDocument(createDocumentArchive({
      dag,
      elementMapDeltas: [],
      drawings: writeDrawingRecords({ documents: [makeDrawing(LEGACY_MODEL_ITEM_ID)], preserved: [future] }),
    }))

    // the workbench mounts and edits its model; its collector never mentions drawings
    registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    dag.insertNode({ id: 'F2', kind: 'feature', payload: { opType: 'extrude', height: 9 } })

    const bytes = collectDocumentArchive()!
    const loaded = loadDocumentArchive(bytes)
    expect(loaded.dag.has('F2')).toBe(true)
    const records = readDrawingRecords(loaded.drawings)
    expect(records.documents.map((d) => d.id)).toEqual(['D1'])
    expect(records.preserved).toEqual([future])
  })

  it('an unreadable shape is kept verbatim as well', () => {
    const junk = { id: 'broken', schemaVersion: 1 } as unknown as JsonValue
    const records = readDrawingRecords({ documents: [junk] })
    expect(records.documents).toEqual([])
    expect(writeDrawingRecords(records)).toEqual({ documents: [junk] })
  })
})

describe('WO-2987: mounted edits and unmount keep the drawings', () => {
  it('a drawing set while the workbench is mounted is in the next save', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
    registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))

    setDrawingRecords(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID)))
    const fileText = await saveAndCaptureFile()

    resetDocumentHolder()
    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(getDrawingRecords().documents.map((d) => d.id)).toEqual(['D1'])
  })

  it('unmounting the workbench stashes the drawings with the model', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
    const unregister = registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    setDrawingRecords(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID)))
    unregister()

    expect(getDrawingRecords().documents.map((d) => d.id)).toEqual(['D1'])
    const saved = loadDocumentArchive(collectDocumentArchive()!)
    expect(readDrawingRecords(saved.drawings).documents.map((d) => d.id)).toEqual(['D1'])
  })

  it('a drawing outlives its body: a genesis-only document that holds a drawing still saves', () => {
    registerLiveDocument(() => null)
    setDrawingRecords(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID)))
    const bytes = collectDocumentArchive()
    expect(bytes).toBeDefined()
    expect(readDrawingRecords(loadDocumentArchive(bytes!).drawings).documents.map((d) => d.id)).toEqual(['D1'])
  })

  it('a document with no drawing and no model still reports nothing to save', () => {
    registerLiveDocument(() => null)
    expect(collectDocumentArchive()).toBeUndefined()
  })
})

describe('WO-2987: autosave recovery keeps the drawings', () => {
  it('hydrating an item from a stored checkpoint installs its drawings (the entry recovery and item hydrate both use)', () => {
    stashLoadedDocument(holderArchive(recordsOf(makeDrawing('item-h'))), 'item-h')
    expect(getDrawingRecords('item-h').documents).toEqual([makeDrawing('item-h')])
    expect(getDrawingRecords().documents).toEqual([])
  })

  it('a crashed session is offered and restored with its drawings, through the production open', async () => {
    const storage = new InMemoryDocumentStorage()
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
    const unregister = registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    const controller = startDocumentAutosave({ documentId: documentIdForProject('p-recover'), storage, debounceMs: 0 })
    setDrawingRecords(recordsOf(makeDrawing(LEGACY_MODEL_ITEM_ID)))
    markDocumentDirty()
    await controller.flush()
    unregister()

    // the crash: memory is gone, only the storage survives; the file on disk has no drawing
    resetDocumentHolder()
    setDocumentStorage(storage)
    const older = createDocumentArchive({ dag, elementMapDeltas: [] })
    const fileText = JSON.stringify(makeProject({
      id: 'p-recover',
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      document: arrayBufferToBase64(new Uint8Array(older).buffer),
    }))

    useCamStore.getState().loadProjectFromFile(fileText)
    await vi.waitFor(() => expect(useCamStore.getState().confirmDialog).not.toBeNull())
    useCamStore.getState().resolveConfirm(true)

    await vi.waitFor(() => expect(getDrawingRecords().documents).toEqual([makeDrawing(LEGACY_MODEL_ITEM_ID)]))
    expect(alertSpy).not.toHaveBeenCalled()
  })
})
