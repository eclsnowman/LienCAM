// WO-2853 (the operator 2026-10-15): "clicking the model here did not actually open the
// model. it just flashed the page." A curved STL picked in the Model chooser (or
// the tree's Edit as model) on a project with 2+ model items went down the
// WO-1935 mesh route, whose enterModelWorkspace call - with 2+ items and none
// active - reopened the same chooser. Driven through the REAL store actions with
// the IndexedDB STL cache mocked to an in-memory map; the converter runs for real
// on the operator's kind of part (a CAD-exported plate with round bores).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))

import { useCamStore } from '../../store'
import { resetDocumentHolder, takePendingDocumentSeed } from '../../doc/documentHolder'
import { textFor } from '../../i18n'
import type { ImportedGeometry, ModelItemRecord } from '../../types'

const state = () => useCamStore.getState()
const itemIds = () => (state().project.modelItems ?? []).map((m) => m.id)

function plateBytes(): ArrayBuffer {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function plateRow(): ImportedGeometry {
  return {
    id: 'plate', name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 10 }, size: { x: 100, y: 100, z: 10 }, center: { x: 50, y: 50, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

function seed(models: ModelItemRecord[], activeModelItemId: string | null = null): void {
  useCamStore.setState((s) => ({
    project: { ...s.project, geometry: [plateRow()], modelItems: models, modelItemPlacements: [], modelItemDocuments: undefined },
    workspace: 'cam', activeModal: null, activeModelItemId, modelStlGeoId: null, brepImportError: null,
    consoleEvents: [],
  }))
}

const twoModels = (): ModelItemRecord[] => [
  { id: 'item-a', name: 'Modeled Part Test1', documentState: 'empty' },
  { id: 'item-b', name: 'Model Item 1', documentState: 'empty' },
]

beforeEach(() => {
  resetDocumentHolder()
  cache.clear()
  cache.set('plate', plateBytes())
  state().newProject()
})

async function expectStlOpen(existing: string[]): Promise<string> {
  const rowBefore = JSON.stringify(state().project.geometry)
  const res = await state().wrapImportedGeometryAsModelItem('plate')
  expect(res).toEqual({ ok: true })
  expect(state().activeModal).not.toBe('model-entry')
  expect(state().workspace).toBe('part')
  expect(state().modelStlGeoId).toBe('plate')
  // View state only: the row stays an STL with no adoption marker.
  expect(JSON.stringify(state().project.geometry)).toBe(rowBefore)
  // The host is an empty scratch record, never one of the user's models (whose
  // bodies would be drawn over the STL), and nothing is seeded from the STL.
  const host = state().activeModelItemId!
  expect(host).toBeTruthy()
  expect(existing).not.toContain(host)
  expect(state().project.modelItems?.find((m) => m.id === host)?.documentState).toBe('empty')
  expect(takePendingDocumentSeed(host)).toBeNull()
  return host
}

describe('WO-2853: a curved STL opens in the Model screen whatever the number of models', () => {
  it('2 models, none active: Open from the chooser / Edit as model lands in Model on the STL, no chooser', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
  })

  it('3 models including a Project Model: still opens, hosted on a scratch record of its own', async () => {
    seed([...twoModels(), { id: 'legacy', name: 'Project Model', documentState: 'empty' }])
    await expectStlOpen(['item-a', 'item-b', 'legacy'])
  })

  it('Finish leaves the user\'s models exactly as they were (the scratch host goes)', async () => {
    seed(twoModels())
    const before = state().project.modelItems
    await expectStlOpen(['item-a', 'item-b'])
    await state().finishModelItem()
    expect(state().workspace).toBe('cam')
    expect(state().modelStlGeoId).toBeNull()
    expect(state().project.modelItems).toEqual(before)
    expect(state().activeModelItemId).toBeNull()
    expect(state().project.geometry.map((g) => [g.id, g.format])).toEqual([['plate', 'stl']])
  })

  it('opens the same way a second time', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    await state().finishModelItem()
    await expectStlOpen(['item-a', 'item-b'])
    await state().finishModelItem()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })

  it('0 models -> a scratch host for the visit, released on Finish', async () => {
    seed([])
    await expectStlOpen([])
    await state().finishModelItem()
    expect(itemIds()).toEqual([])
  })

  // The operator 10-15 9:40 PM: "opening plate model opened two models" - the STL was
  // hosted INSIDE the open (or only) model and drawn with its bodies.
  it('1 model: the STL opens alone on a scratch host; the model stays after Finish', async () => {
    seed([{ id: 'item-a', name: 'Model Item 1', documentState: 'empty' }])
    await expectStlOpen(['item-a'])
    await state().finishModelItem()
    expect(itemIds()).toEqual(['item-a'])
  })

  it('2 models with one active: the STL opens alone, not inside the active model', async () => {
    seed(twoModels(), 'item-b')
    await expectStlOpen(['item-a', 'item-b'])
    await state().finishModelItem()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })

  it('negative control: the programmatic 2-model entry with no STL still asks (WO-2700)', async () => {
    seed(twoModels())
    await state().enterModelWorkspace()
    expect(state().activeModal).toBe('model-entry')
    expect(state().workspace).toBe('cam')
    expect(state().modelStlGeoId).toBeNull()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })
})

// FIX ROUND 2 (the operator 10-15 ~10:10 PM): "New model in the modal opens a new
// document with the plate in it." The visit flag (modelStlGeoId) outlived the
// visit, so the next model opened or created drew the plate. A visit ends with
// every route that leaves it.
describe('WO-2853 round 2: an STL visit belongs to that one visit', () => {
  function expectVisitOver(): void {
    expect(state().modelStlGeoId).toBeNull()
  }

  it('(a) open Plate -> Create Model from the New Model window: the new model starts empty', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    state().openModal('new-model')
    state().closeModal()
    const created = state().addModelItem()
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(created)
    expectVisitOver()
    expect(state().project.modelItems?.find((m) => m.id === created)?.documentState).toBe('empty')
    expect(takePendingDocumentSeed(created)).toBeNull()
    // The scratch host went with the visit; the user's models plus the new one remain.
    expect(itemIds()).toEqual(['item-a', 'item-b', created])
    // Opening the Plate again later shows it alone again.
    await expectStlOpen(['item-a', 'item-b', created])
  })

  it('(b) open Plate -> Setup tab -> Model tab -> pick another model: no Plate', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    state().setWorkspace('cam')
    expectVisitOver()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
    state().openModal('new-model')
    state().closeModal()
    await state().openModelItem('item-a')
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-a')
    expectVisitOver()
  })

  it('(c) open Plate -> open another model from the chooser: no Plate', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    await state().openModelItem('item-b')
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-b')
    expectVisitOver()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })

  it('the Control tab also ends the visit', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    state().setWorkspace('control')
    expectVisitOver()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })

  it('0 models: Create Model after the visit starts empty and the scratch host goes', async () => {
    seed([])
    await expectStlOpen([])
    const created = state().addModelItem()
    expectVisitOver()
    expect(itemIds()).toEqual([created])
  })
})

// FIX ROUND 3 (architect picture review, 10-15 ~10:35 PM, inside the operator's words
// "opening the Plate shows the Plate ALONE - no other model's ... tree/name in
// the header" and "a new model starts EMPTY"): the header read "PROJECT MODEL"
// while the Plate was open, and after Create Model the console strip still said
// the Plate "is open as a mesh".
describe('WO-2853 round 3: the visit is named for the STL and its open line ends with it', () => {
  const workbenchText = textFor('sketch-and-model-workbench')
  // The line the Model screen writes when it has drawn the STL
  // (SolidsWorkbenchPage, WO-1935); the screen is not mounted in a store test.
  function screenSaysOpen(): void {
    state().addConsoleEvent({
      severity: 'info', source: 'workbench',
      message: workbenchText('SolidsWorkbenchPage.isOpenAsAMeshKeptAsAnSTL', { name: 'Plate', length: '29' }) +
        workbenchText('SolidsWorkbenchPage.acrossFacetsInMs', { facetCount: '1420', value2: '1597' }) +
        workbenchText('SolidsWorkbenchPage.clickAFeatureToSelectItWhole'),
    })
  }
  const openLines = () => state().consoleEvents.filter((e) => e.message.includes('is open as a mesh'))
  const headerName = () => state().project.modelItems?.find((m) => m.id === state().activeModelItemId)?.name

  it.each([
    ['0 models', [] as ModelItemRecord[]],
    ['1 model', [{ id: 'item-a', name: 'Model Item 1', documentState: 'empty' as const }]],
    ['2 models', twoModels()],
    ['3 models including a Project Model', [...twoModels(), { id: 'legacy', name: 'Project Model', documentState: 'empty' as const }]],
  ])('%s: the header and its switcher read the STL\'s name while it is open', async (_label, models) => {
    seed(models)
    await expectStlOpen(models.map((m) => m.id))
    expect(headerName()).toBe('Plate')
    // The user's models keep their own names.
    expect(state().project.modelItems?.filter((m) => m.id !== state().activeModelItemId)).toEqual(models)
  })

  it('opening the Plate again later reads "Plate" again', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    state().addModelItem()
    await expectStlOpen(itemIds())
    expect(headerName()).toBe('Plate')
  })

  it('Create Model: the "is open as a mesh" line goes, other lines stay', async () => {
    seed(twoModels())
    state().addConsoleEvent({ severity: 'info', source: 'project', message: 'Imported Plate' })
    await expectStlOpen(['item-a', 'item-b'])
    screenSaysOpen()
    expect(openLines()).toHaveLength(1)
    state().addModelItem()
    expect(openLines()).toEqual([])
    expect(state().consoleEvents.map((e) => e.message)).toContain('Imported Plate')
    expect(state().consoleEvents.at(-1)?.message ?? '').not.toContain('is open as a mesh')
  })

  it.each([
    ['the Setup tab', () => { state().setWorkspace('cam') }],
    ['opening another model', () => state().openModelItem('item-a')],
    ['Finish', () => state().finishModelItem()],
    ['removing the STL from the Model screen', () => { state().closeStlInModelScreen() }],
    ['undo back to CAM', () => { state().undo() }],
  ])('%s: the "is open as a mesh" line goes', async (_label, leave) => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    screenSaysOpen()
    await leave()
    expect(state().modelStlGeoId).toBeNull()
    expect(openLines()).toEqual([])
  })

  it('negative control: while the visit lasts the line stays', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    screenSaysOpen()
    await state().openModelItem(state().activeModelItemId!)
    expect(state().modelStlGeoId).toBe('plate')
    expect(openLines()).toHaveLength(1)
  })
})

// Round 4 (astra audit 10-16): openStlInModelScreen -> undo -> redo ended in an
// empty "Plate" model with modelStlGeoId null - the redo restored the visit's
// host record but not the STL it shows. Redo of an STL open restores the visit
// exactly as the open made it; undo still leaves no stray Plate model.
describe('WO-2853 round 4: undo and redo of an STL open', () => {
  it.each([
    ['0 models', [] as ModelItemRecord[]],
    ['1 model', [{ id: 'item-a', name: 'Model Item 1', documentState: 'empty' as const }]],
    ['2 models', twoModels()],
    ['3 models including a Project Model', [...twoModels(), { id: 'legacy', name: 'Project Model', documentState: 'empty' as const }]],
  ])('%s: undo leaves no Plate model, redo reopens the Plate on the same host', async (_label, models) => {
    seed(models)
    await state().openStlInModelScreen('plate')
    expect(state().modelStlGeoId).toBe('plate')
    const host = state().activeModelItemId!
    const opened = state().project.modelItems

    state().undo()
    expect(state().workspace).toBe('cam')
    expect(state().modelStlGeoId).toBeNull()
    expect(state().activeModelItemId).toBeNull()
    expect(state().project.modelItems).toEqual(models)

    state().redo()
    expect(state().workspace).toBe('part')
    expect(state().modelStlGeoId).toBe('plate')
    expect(state().activeModelItemId).toBe(host)
    expect(state().project.modelItems).toEqual(opened)
    expect(state().project.modelItems?.find((m) => m.id === host)?.name).toBe('Plate')
    expect(state().project.geometry.map((g) => [g.id, g.format])).toEqual([['plate', 'stl']])

    // The redone visit is the visit: Finish releases its host as before.
    await state().finishModelItem()
    expect(state().workspace).toBe('cam')
    expect(state().modelStlGeoId).toBeNull()
    expect(state().project.modelItems).toEqual(models)
  })

  it('through the chooser route too: undo, redo, undo again leaves no Plate model', async () => {
    seed(twoModels())
    const host = await expectStlOpen(['item-a', 'item-b'])
    state().undo()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
    state().redo()
    expect(state().modelStlGeoId).toBe('plate')
    expect(state().activeModelItemId).toBe(host)
    state().undo()
    expect(state().workspace).toBe('cam')
    expect(state().modelStlGeoId).toBeNull()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })

  it('a redone visit is claimed again: Finish releases its host even if the claim was dropped between', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    state().undo()
    // Setup tab while already in CAM ends whatever visit is recorded.
    state().setWorkspace('cam')
    state().redo()
    expect(state().modelStlGeoId).toBe('plate')
    await state().finishModelItem()
    expect(itemIds()).toEqual(['item-a', 'item-b'])
  })

  it('negative control: redo of Create Model still opens the new, empty model without the Plate', async () => {
    seed(twoModels())
    await expectStlOpen(['item-a', 'item-b'])
    state().setWorkspace('cam')
    state().addModelItem()
    const created = state().activeModelItemId!
    state().undo()
    state().redo()
    expect(state().activeModelItemId).toBe(created)
    expect(state().modelStlGeoId).toBeNull()
  })
})
